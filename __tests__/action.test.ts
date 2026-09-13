import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  action,
  createActionClient,
  createBaseContext,
  createMiddleware,
  ForbiddenError,
  idempotency,
  logging,
  policy,
  rateLimit,
  RateLimitError,
  timing,
  UnauthorizedError,
  unauthorized,
  ValidationError,
} from "../src/index";

describe("Nezt Server Action & Execution Engine", () => {
  describe("Context Enrichment & Immutability", () => {
    it("should initialize base context with default requestId", () => {
      const ctx = createBaseContext();
      expect(ctx.requestId).toBeDefined();
      expect(typeof ctx.requestId).toBe("string");
      expect(ctx.requestId.length).toBeGreaterThan(0);
    });

    it("should support ctx.add and allow direct property access via Proxy", () => {
      const ctx = createBaseContext();
      const enriched = ctx.add("user", { id: "u_1", role: "admin" });

      expect(enriched.user).toEqual({ id: "u_1", role: "admin" });
      expect(enriched.get("user")).toEqual({ id: "u_1", role: "admin" });
      expect(enriched.has("user")).toBe(true);
    });

    it("should prevent accidental key collisions when using ctx.add", () => {
      const ctx = createBaseContext().add("token", "initial");

      expect(() => {
        ctx.add("token", "overwrite");
      }).toThrow();
    });

    it("should allow explicit overwriting via ctx.replace", () => {
      const ctx = createBaseContext().add("token", "initial");
      const updated = ctx.replace("token", "new_val");

      expect(updated.token).toBe("new_val");
    });
  });

  describe("Input & Output Validation", () => {
    it("should execute successfully with valid input", async () => {
      const testAction = action({
        input: z.object({ name: z.string(), age: z.number() }),
        handler: async ({ input }) => {
          return `Hello ${input.name}, age ${input.age}`;
        },
      });

      const result = await testAction({ name: "Alice", age: 30 });
      expect(result).toBe("Hello Alice, age 30");
    });

    it("should throw ValidationError when input schema fails", async () => {
      const testAction = action({
        input: z.object({ email: z.string().email() }),
        handler: async ({ input }) => input.email,
      });

      expect(async () => {
        // @ts-expect-error - testing runtime invalid input
        await testAction({ email: "invalid-email" });
      }).toThrow(ValidationError);
    });

    it("should validate output schema and enforce contracts", async () => {
      const testAction = action({
        output: z.object({ id: z.string(), ok: z.boolean() }),
        handler: async () => ({ id: "123", ok: true }),
      });

      const result = await testAction();
      expect(result).toEqual({ id: "123", ok: true });
    });

    it("should throw when handler returns data invalid against output schema", async () => {
      const testAction = action({
        output: z.object({ count: z.number() }),
        // @ts-expect-error - testing runtime invalid output
        handler: async () => ({ count: "not-a-number" }),
      });

      expect(async () => {
        await testAction();
      }).toThrow(ValidationError);
    });
  });

  describe("Middleware Pipeline", () => {
    it("should execute middlewares in onion order and accumulate context", async () => {
      const logs: string[] = [];

      const mw1 = createMiddleware<object, { step1: boolean }>(async ({ ctx, next }) => {
        logs.push("mw1 before");
        const nextCtx = ctx.add("step1", true);
        const res = await next({ ctx: nextCtx });
        logs.push("mw1 after");
        return res;
      });

      const mw2 = createMiddleware<object, { step2: string }>(async ({ ctx }) => {
        logs.push("mw2");
        return ctx.add("step2", "done");
      });

      const testAction = action({
        middleware: [mw1, mw2],
        handler: async ({ ctx }) => {
          logs.push("handler");
          return { step1: ctx.step1, step2: ctx.step2 };
        },
      });

      const result = await testAction();
      expect(result).toEqual({ step1: true, step2: "done" });
      expect(logs).toEqual(["mw1 before", "mw2", "handler", "mw1 after"]);
    });

    it("should halt pipeline and propagate error when a middleware throws", async () => {
      const mwAuth = createMiddleware(async () => {
        throw unauthorized("Session expired");
      });

      const testAction = action({
        middleware: [mwAuth],
        handler: async () => "should never run",
      });

      expect(async () => {
        await testAction();
      }).toThrow(UnauthorizedError);
    });
  });

  describe("Fluent ActionBuilder & ActionClient Chaining", () => {
    it("should support action().input(...).use(...).handler(...) syntax", async () => {
      const authMw = createMiddleware<object, { user: { id: string } }>(
        async ({ ctx }) => {
          return ctx.add("user", { id: "u_fluent" });
        },
      );

      const builtAction = action()
        .input(z.object({ title: z.string() }))
        .use(authMw)
        .handler(async ({ input, ctx }) => {
          return {
            title: input.title,
            userId: ctx.user.id,
          };
        });

      const res = await builtAction({ title: "Fluent Chain" });
      expect(res.title).toBe("Fluent Chain");
      expect(res.userId).toBe("u_fluent");
    });

    it("should support createActionClient for project-wide defaults", async () => {
      const timingMw = timing();
      const client = createActionClient({
        middleware: [timingMw],
      });

      const clientAction = client
        .input(z.object({ message: z.string() }))
        .handler(async ({ input, ctx }) => {
          return { echo: input.message, hasStartTime: ctx.has("startTime") };
        });

      const res = await clientAction({ message: "Hello Client" });
      expect(res.echo).toBe("Hello Client");
      expect(res.hasStartTime).toBe(true);
    });
  });

  describe("Built-in Middlewares", () => {
    it("should block requests exceeding rateLimit", async () => {
      const limitedAction = action({
        middleware: [
          rateLimit({
            windowMs: 5000,
            maxRequests: 2,
            keyGenerator: () => "test_client_key",
          }),
        ],
        handler: async () => "ok",
      });

      expect(await limitedAction()).toBe("ok");
      expect(await limitedAction()).toBe("ok");
      expect(async () => {
        await limitedAction();
      }).toThrow(RateLimitError);
    });

    it("should return cached result for duplicate idempotency key", async () => {
      let runCount = 0;

      const idempotentAction = action({
        input: z.object({ key: z.string() }),
        middleware: [
          idempotency({
            getKey: (_, input: { key: string }) => input.key,
          }),
        ],
        handler: async () => {
          runCount++;
          return { count: runCount };
        },
      });

      const res1 = await idempotentAction({ key: "idempotent_1" });
      expect(res1.count).toBe(1);

      const res2 = await idempotentAction({ key: "idempotent_1" });
      expect(res2.count).toBe(1);
      expect(runCount).toBe(1);

      const res3 = await idempotentAction({ key: "idempotent_2" });
      expect(res3.count).toBe(2);
      expect(runCount).toBe(2);
    });

    it("should enforce policy middleware rules", async () => {
      const userAction = action({
        input: z.object({ role: z.string() }),
        middleware: [
          policy(
            ({ input }: { input: { role: string } }) => input.role === "admin",
            "Admins only",
          ),
        ],
        handler: async () => "granted",
      });

      expect(async () => {
        await userAction({ role: "viewer" });
      }).toThrow(ForbiddenError);

      expect(await userAction({ role: "admin" })).toBe("granted");
    });

    it("should execute logging and timing middlewares without errors", async () => {
      const loggedMessages: string[] = [];
      const testLogger = {
        info: (msg: string) => loggedMessages.push(msg),
        error: (msg: string) => loggedMessages.push(msg),
      };

      const monitoredAction = action({
        middleware: [timing(), logging({ logger: testLogger })],
        handler: async ({ ctx }) => {
          return { started: ctx.startTime > 0 };
        },
      });

      const res = await monitoredAction();
      expect(res.started).toBe(true);
      expect(loggedMessages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Route Adapter (.toRouteHandler())", () => {
    it("should adapt action to a standard route handler returning JSON", async () => {
      const sampleAction = action({
        input: z.object({ queryParam: z.string() }),
        handler: async ({ input }) => ({ received: input.queryParam }),
      });

      const routeHandler = sampleAction.toRouteHandler();
      const request = new Request("http://localhost:3000/api/test?queryParam=hello");
      const response = await routeHandler(request);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ received: "hello" });
    });

    it("should format validation errors into 400 JSON response in route handler", async () => {
      const sampleAction = action({
        input: z.object({ count: z.number() }),
        handler: async ({ input }) => input,
      });

      const routeHandler = sampleAction.toRouteHandler();
      const request = new Request("http://localhost:3000/api/test?count=invalid");
      const response = await routeHandler(request);

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("should pass through raw Response objects returned by handlers", async () => {
      const rawResponseAction = action({
        handler: async () => {
          return new Response("binary file payload", {
            status: 202,
            headers: { "Content-Type": "application/octet-stream" },
          });
        },
      });

      const routeHandler = rawResponseAction.toRouteHandler();
      const request = new Request("http://localhost:3000/api/stream");
      const response = await routeHandler(request);

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("binary file payload");
    });

    it("should handle partitioned input schemas (params, query, body)", async () => {
      const partitionedAction = action({
        input: {
          params: z.object({ id: z.string() }),
          query: z.object({ tag: z.string().optional() }),
          body: z.object({ title: z.string() }),
        },
        handler: async ({ input }) => ({
          id: input.params.id,
          tag: input.query.tag,
          title: input.body.title,
        }),
      });

      const routeHandler = partitionedAction.toRouteHandler();
      const request = new Request("http://localhost:3000/api/items/456?tag=docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "My Document" }),
      });

      const response = await routeHandler(request, {
        params: Promise.resolve({ id: "456" }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({
        id: "456",
        tag: "docs",
        title: "My Document",
      });
    });
  });
});
