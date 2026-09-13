import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { action, createMiddleware, type TypedActionContext } from "../src/index";

// Type-level assertion helpers
type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false;
type Extends<A, B> = A extends B ? true : false;
type NotExtends<A, B> = A extends B ? false : true;

describe("Nezt Type-Level Compilation Tests", () => {
  it("verifies progressive context enrichment across multiple middlewares", () => {
    interface UserContext {
      user: { id: string; email: string };
    }
    interface OrgContext {
      org: { id: string; name: string };
    }

    const authMw = createMiddleware<object, UserContext>(async ({ ctx, next }) => {
      const nextCtx = ctx.add("user", { id: "u_1", email: "user@example.com" });
      return await next({ ctx: nextCtx });
    });

    const orgMw = createMiddleware<object, OrgContext>(async ({ ctx, next }) => {
      const nextCtx = ctx.add("org", { id: "o_1", name: "Acme Corp" });
      return await next({ ctx: nextCtx });
    });

    const testAction = action({
      middleware: [authMw, orgMw],
      handler: async ({ ctx }) => {
        type _HasUser = Expect<Extends<typeof ctx.user.id, string>>;
        type _HasEmail = Expect<Extends<typeof ctx.user.email, string>>;
        type _HasOrgId = Expect<Extends<typeof ctx.org.id, string>>;
        type _HasOrgName = Expect<Extends<typeof ctx.org.name, string>>;

        return { userId: ctx.user.id, orgId: ctx.org.id };
      },
    });

    expect(typeof testAction).toBe("function");
  });

  it("verifies ActionBuilder fluent chaining accumulates context types", () => {
    interface TenantContext {
      tenantId: string;
    }

    const tenantMw = createMiddleware<object, TenantContext>(async ({ ctx, next }) => {
      return await next({ ctx: ctx.add("tenantId", "tenant_xyz") });
    });

    const builderAction = action()
      .use(tenantMw)
      .handler(async ({ ctx }) => {
        type _HasTenant = Expect<Extends<typeof ctx.tenantId, string>>;
        return { tenantId: ctx.tenantId };
      });

    expect(typeof builderAction).toBe("function");
  });

  it("verifies partitioned schema inputs are correctly inferred", () => {
    const partitionedAction = action({
      input: {
        params: z.object({ id: z.string() }),
        body: z.object({ title: z.string(), score: z.number().optional() }),
        query: z.object({ page: z.coerce.number().default(1) }),
      },
      handler: async ({ input }) => {
        type _CheckParams = Expect<Equal<typeof input.params, { id: string }>>;
        type _CheckBody = Expect<
          Equal<typeof input.body, { title: string; score?: number | undefined }>
        >;
        type _CheckQuery = Expect<Equal<typeof input.query, { page: number }>>;

        return { ok: true };
      },
    });

    expect(typeof partitionedAction).toBe("function");
  });

  it("verifies negative type-tests: unprovided properties do not exist on context", () => {
    interface SampleContext {
      foo: string;
    }

    const sampleMw = createMiddleware<object, SampleContext>(async ({ ctx, next }) => {
      return await next({ ctx: ctx.add("foo", "bar") });
    });

    action({
      middleware: [sampleMw],
      handler: async ({ ctx }) => {
        type _HasFoo = Expect<Extends<typeof ctx.foo, string>>;
        type _NoBar = Expect<NotExtends<typeof ctx, { bar: string }>>;
      },
    });

    action({
      handler: async ({ ctx }) => {
        type _Empty = Expect<NotExtends<typeof ctx, { user: unknown }>>;
      },
    });
  });
});
