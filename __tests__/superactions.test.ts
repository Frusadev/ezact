import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  ActionRegistry,
  action,
  callAction,
  callClientAction,
  createActionDispatcher,
  createClientActionReference,
  normalizeActionResponse,
  safeCall,
  ValidationError,
} from "../src/index";

describe("Superactions Architecture & Execution Engine", () => {
  describe("Single action() Definition as Source of Truth", () => {
    it("should create action with path, method, version, declared errors, and success message", async () => {
      const createProjectAction = action({
        path: "/projects",
        method: "POST",
        version: 1,
        errors: {
          PROJECT_EXISTS: {
            code: 409,
            message: "A project with this name already exists",
          },
          UNAUTHORIZED: {
            code: 401,
            message: "Authentication required",
          },
        },
        success: "Project created successfully",
        input: z.object({
          name: z.string().min(2),
        }),
        handler: async ({ input }) => {
          if (input.name === "Existing") {
            throw "PROJECT_EXISTS";
          }
          return { id: "proj_123", name: input.name };
        },
      });

      expect(createProjectAction.path).toBe("/projects");
      expect(createProjectAction.method).toBe("POST");
      expect(createProjectAction.version).toBe(1);
      expect(createProjectAction.success).toBe("Project created successfully");
      expect(createProjectAction.errors.PROJECT_EXISTS.code).toBe(409);

      // Direct server-side execution with callAction
      const res = await callAction(createProjectAction, { name: "Alpha" });
      expect(res.error).toBeNull();
      expect(res.data).toEqual({ id: "proj_123", name: "Alpha" });
      expect(res.success?.message).toBe("Project created successfully");

      // Declared error handling with callAction
      const errRes = await callAction(createProjectAction, {
        name: "Existing",
      });
      expect(errRes.data).toBeNull();
      expect(errRes.success).toBeNull();
      expect(errRes.error).toEqual({
        code: 409,
        message: "A project with this name already exists",
        type: "PROJECT_EXISTS",
      });
    });

    it("should support both ({ input, ctx }) and (input, ctx) handler signatures", async () => {
      const dualParamAction = action({
        path: "/test-params",
        method: "POST",
        input: z.string(),
        handler: async (name, ctx) => {
          return { greeting: `Hello ${name}`, hasCtx: !!ctx };
        },
      });

      const res = await callAction(dualParamAction, "World");
      expect(res.data).toEqual({ greeting: "Hello World", hasCtx: true });
    });
  });

  describe("Unified Response Schema & Invariants", () => {
    it("should guarantee all 4 properties are always present in success and error", () => {
      const successRes = normalizeActionResponse({ data: { test: 1 } });
      expect(Object.keys(successRes).sort()).toEqual(
        ["data", "error", "message", "success"].sort(),
      );
      expect(successRes.error).toBeNull();
      expect(successRes.success?.message).toBe(
        "Operation completed successfully",
      );
      expect(successRes.message).toBe("Operation completed successfully");

      const errorRes = normalizeActionResponse({
        error: { code: 404, message: "Not found" },
      });
      expect(Object.keys(errorRes).sort()).toEqual(
        ["data", "error", "message", "success"].sort(),
      );
      expect(errorRes.data).toBeNull();
      expect(errorRes.success).toBeNull();
      expect(errorRes.error?.code).toBe(404);
      expect(errorRes.message).toBe("Not found");
    });

    it("should not allow a response to have both data and error or success and error", () => {
      const conflicting = normalizeActionResponse({
        data: { value: 123 },
        error: { code: 400, message: "Failed" },
        success: { message: "Yay" },
      });
      expect(conflicting.data).toBeNull();
      expect(conflicting.success).toBeNull();
      expect(conflicting.error?.code).toBe(400);
    });
  });

  describe("safeCall() Error Handling", () => {
    it("should catch synchronous exceptions and return standard error response", async () => {
      const res = await safeCall(() => {
        throw new Error("Sync failure");
      });
      expect(res.data).toBeNull();
      expect(res.success).toBeNull();
      expect(res.error?.code).toBe(500);
      expect(res.error?.message).toBe("An internal server error occurred");
    });

    it("should catch rejected promises and return standard error response", async () => {
      const res = await safeCall(async () => {
        throw new Error("Async failure");
      });
      expect(res.data).toBeNull();
      expect(res.error?.code).toBe(500);
    });

    it("should map declared error identifiers to appropriate status codes", async () => {
      const declaredErrors = {
        NOT_ALLOWED: { code: 403, message: "Permission denied" },
      };
      const res = await safeCall(
        () => {
          throw new Error("NOT_ALLOWED");
        },
        { declaredErrors },
      );
      expect(res.error).toEqual({ code: 403, message: "Permission denied" });
    });

    it("should preserve AppError status codes", async () => {
      const res = await safeCall(() => {
        throw new ValidationError("Invalid field");
      });
      expect(res.error?.code).toBe(400);
      expect(res.error?.message).toBe("Invalid field");
    });
  });

  describe("ActionRegistry & Deterministic Registration", () => {
    it("should register actions and detect duplicate registrations", () => {
      const registry = new ActionRegistry();
      const actionA = action({
        path: "/users",
        method: "GET",
        version: 1,
        handler: async () => [],
      });

      registry.register(actionA);
      expect(registry.getAll().length).toBe(1);

      // Duplicate registration attempt
      const duplicateAction = action({
        path: "/users",
        method: "GET",
        version: 1,
        handler: async () => [],
      });

      expect(() => {
        registry.register(duplicateAction);
      }).toThrow(/Duplicate action registration detected/);
    });

    it("should resolve actions by version, method, and path", () => {
      const registry = new ActionRegistry();
      const getAction = action({
        path: "/items",
        method: "GET",
        version: 1,
        handler: async () => ["item1"],
      });
      const postAction = action({
        path: "/items",
        method: "POST",
        version: 1,
        handler: async () => "created",
      });

      registry.register(getAction);
      registry.register(postAction);

      const resolved = registry.resolve({
        version: 1,
        method: "GET",
        path: "/items",
      });
      expect(resolved.success).toBe(true);
      if (resolved.success) {
        expect(resolved.action.method).toBe("GET");
      }

      // Method not allowed error
      const wrongMethod = registry.resolve({
        version: 1,
        method: "DELETE",
        path: "/items",
      });
      expect(wrongMethod.success).toBe(false);
      if (!wrongMethod.success) {
        expect(wrongMethod.error.status).toBe(405);
      }

      // Unsupported version
      const wrongVersion = registry.resolve({
        version: 2,
        method: "GET",
        path: "/items",
      });
      expect(wrongVersion.success).toBe(false);
      if (!wrongVersion.success) {
        expect(wrongVersion.error.status).toBe(400);
      }

      // Not found
      const unknownPath = registry.resolve({
        version: 1,
        method: "GET",
        path: "/nonexistent",
      });
      expect(unknownPath.success).toBe(false);
      if (!unknownPath.success) {
        expect(unknownPath.error.status).toBe(404);
      }
    });
  });

  describe("Centralized Action Dispatcher (Next.js Route Handler)", () => {
    it("should dispatch HTTP requests to matching registered action", async () => {
      const registry = new ActionRegistry();
      const helloAction = action({
        path: "/greet",
        method: "POST",
        version: 1,
        input: z.object({ name: z.string() }),
        success: "Greeting generated",
        handler: async ({ input }) => ({ message: `Hello ${input.name}!` }),
      });
      registry.register(helloAction);

      const dispatcher = createActionDispatcher(registry);

      const req = new Request("http://localhost:3000/api/actions/v1/greet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      });

      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "greet"] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({ message: "Hello Alice!" });
      expect(json.error).toBeNull();
      expect(json.success?.message).toBe("Greeting generated");
    });

    it("should return 404 for unknown actions in dispatcher", async () => {
      const registry = new ActionRegistry();
      const dispatcher = createActionDispatcher(registry);

      const req = new Request("http://localhost:3000/api/actions/v1/missing", {
        method: "GET",
      });

      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "missing"] }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe(404);
    });

    it("should return 405 for unsupported method in dispatcher", async () => {
      const registry = new ActionRegistry();
      registry.register(
        action({
          path: "/read-only",
          method: "GET",
          version: 1,
          handler: async () => "ok",
        }),
      );

      const dispatcher = createActionDispatcher(registry);

      const req = new Request(
        "http://localhost:3000/api/actions/v1/read-only",
        {
          method: "POST",
        },
      );

      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "read-only"] }),
      });

      expect(res.status).toBe(405);
    });

    it("should enforce maximum payload size (413 Payload Too Large)", async () => {
      const registry = new ActionRegistry();
      registry.register(
        action({
          path: "/upload",
          method: "POST",
          version: 1,
          handler: async () => "ok",
        }),
      );

      const dispatcher = createActionDispatcher({
        registry,
        maxBodySizeBytes: 100, // Small limit for test
      });

      const req = new Request("http://localhost:3000/api/actions/v1/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "500",
        },
        body: JSON.stringify({ large: "x".repeat(300) }),
      });

      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "upload"] }),
      });

      expect(res.status).toBe(413);
    });

    it("should handle GET actions with primitive string inputs (e.g. slug check) via query params", async () => {
      const registry = new ActionRegistry();
      const checkSlug = action({
        path: "/leads/pipeline/check-slug-available",
        method: "GET",
        version: 1,
        input: z.union([
          z.string().min(1),
          z.object({ slug: z.string().min(1) }),
        ]),
        handler: async ({ input }) => {
          const slug = typeof input === "string" ? input : input.slug;
          return { available: slug !== "taken-slug" };
        },
      });
      registry.register(checkSlug);

      const dispatcher = createActionDispatcher(registry);

      // Case A: Dispatched with ?input=my-new-org (serialized primitive from callClientAction)
      const reqPrimitive = new Request(
        "http://localhost:3000/api/actions/v1/leads/pipeline/check-slug-available?input=my-new-org",
        { method: "GET" },
      );
      const resPrimitive = await dispatcher(reqPrimitive, {
        params: Promise.resolve({
          path: ["v1", "leads", "pipeline", "check-slug-available"],
        }),
      });
      expect(resPrimitive.status).toBe(200);
      const jsonPrimitive = await resPrimitive.json();
      expect(jsonPrimitive.data).toEqual({ available: true });

      // Case B: Dispatched with ?slug=taken-slug (named query parameter)
      const reqNamed = new Request(
        "http://localhost:3000/api/actions/v1/leads/pipeline/check-slug-available?slug=taken-slug",
        { method: "GET" },
      );
      const resNamed = await dispatcher(reqNamed, {
        params: Promise.resolve({
          path: ["v1", "leads", "pipeline", "check-slug-available"],
        }),
      });
      expect(resNamed.status).toBe(200);
      const jsonNamed = await resNamed.json();
      expect(jsonNamed.data).toEqual({ available: false });
    });

    it("should coerce numeric and boolean query parameters for GET actions", async () => {
      const registry = new ActionRegistry();
      const listAction = action({
        path: "/items",
        method: "GET",
        version: 1,
        input: z.object({
          limit: z.number(),
          active: z.boolean(),
        }),
        handler: async ({ input }) => {
          return {
            limit: input.limit,
            limitType: typeof input.limit,
            active: input.active,
            activeType: typeof input.active,
          };
        },
      });
      registry.register(listAction);

      const dispatcher = createActionDispatcher(registry);
      const req = new Request(
        "http://localhost:3000/api/actions/v1/items?limit=25&active=true",
        { method: "GET" },
      );
      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "items"] }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        limit: 25,
        limitType: "number",
        active: true,
        activeType: "boolean",
      });
    });

    it("should handle DELETE actions with primitive string identifiers", async () => {
      const registry = new ActionRegistry();
      const deleteAction = action({
        path: "/members/remove",
        method: "DELETE",
        version: 1,
        input: z.string().min(1),
        handler: async ({ input }) => ({ deletedId: input }),
      });
      registry.register(deleteAction);

      const dispatcher = createActionDispatcher(registry);
      const req = new Request(
        "http://localhost:3000/api/actions/v1/members/remove?input=mem_abc123",
        { method: "DELETE" },
      );
      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "members", "remove"] }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({ deletedId: "mem_abc123" });
    });

    it("should handle GET actions with nested object query parameters (e.g. listOrganizationAssets)", async () => {
      const registry = new ActionRegistry();
      const listAssetsAction = action({
        path: "/assets/files/list-organization-assets",
        method: "GET",
        version: 1,
        input: z.object({
          requestData: z
            .object({
              search: z.string().optional(),
              folderId: z.string().nullable().optional(),
              assetType: z.enum(["all", "file"]).optional(),
            })
            .optional(),
          limit: z.number().optional(),
          offset: z.number().optional(),
        }),
        handler: async ({ input }) => ({
          search: input.requestData?.search,
          folderId: input.requestData?.folderId,
          limit: input.limit,
          offset: input.offset,
        }),
      });
      registry.register(listAssetsAction);

      const dispatcher = createActionDispatcher(registry);
      // Simulate query params generated by callClientAction with nested JSON object
      const searchParams = new URLSearchParams();
      searchParams.append(
        "requestData",
        JSON.stringify({ search: "design", folderId: null, assetType: "file" }),
      );
      searchParams.append("limit", "50");
      searchParams.append("offset", "0");

      const req = new Request(
        `http://localhost:3000/api/actions/v1/assets/files/list-organization-assets?${searchParams.toString()}`,
        { method: "GET" },
      );
      const res = await dispatcher(req, {
        params: Promise.resolve({
          path: ["v1", "assets", "files", "list-organization-assets"],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        search: "design",
        folderId: null,
        limit: 50,
        offset: 0,
      });
    });

    it("should parse query param parentFolderId=null as literal null rather than string 'null'", async () => {
      const registry = new ActionRegistry();
      const listFoldersAction = action({
        path: "/assets/files/list-organization-folders",
        method: "GET",
        version: 1,
        input: z
          .object({
            projectId: z.string().nullable().optional(),
            parentFolderId: z.string().nullable().optional(),
          })
          .optional(),
        handler: async ({ input }) => ({
          parentFolderId: input?.parentFolderId,
          isNull: input?.parentFolderId === null,
        }),
      });
      registry.register(listFoldersAction);

      const dispatcher = createActionDispatcher(registry);
      const req = new Request(
        "http://localhost:3000/api/actions/v1/assets/files/list-organization-folders?parentFolderId=null",
        { method: "GET" },
      );
      const res = await dispatcher(req, {
        params: Promise.resolve({
          path: ["v1", "assets", "files", "list-organization-folders"],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({
        parentFolderId: null,
        isNull: true,
      });
    });

    it("should handle DELETE actions with array inputs (e.g. bulkDeleteOrganizationAssets)", async () => {
      const registry = new ActionRegistry();
      const bulkDeleteAction = action({
        path: "/assets/files/bulk-delete",
        method: "DELETE",
        version: 1,
        input: z.object({
          assetIds: z.array(z.string()),
        }),
        handler: async ({ input }) => ({ deletedCount: input.assetIds.length }),
      });
      registry.register(bulkDeleteAction);

      const dispatcher = createActionDispatcher(registry);

      // Subcase 1: JSON array serialized in query param
      const searchParamsJson = new URLSearchParams();
      searchParamsJson.append("assetIds", JSON.stringify(["asset-1"]));
      const reqJson = new Request(
        `http://localhost:3000/api/actions/v1/assets/files/bulk-delete?${searchParamsJson.toString()}`,
        { method: "DELETE" },
      );
      const resJson = await dispatcher(reqJson, {
        params: Promise.resolve({ path: ["v1", "assets", "files", "bulk-delete"] }),
      });
      expect(resJson.status).toBe(200);
      const json1 = await resJson.json();
      expect(json1.data).toEqual({ deletedCount: 1 });

      // Subcase 2: Single string coerced to single-element array
      const reqSingle = new Request(
        "http://localhost:3000/api/actions/v1/assets/files/bulk-delete?assetIds=asset-sole",
        { method: "DELETE" },
      );
      const resSingle = await dispatcher(reqSingle, {
        params: Promise.resolve({ path: ["v1", "assets", "files", "bulk-delete"] }),
      });
      expect(resSingle.status).toBe(200);
      const json2 = await resSingle.json();
      expect(json2.data).toEqual({ deletedCount: 1 });
    });

    it("should automatically bind single-key object schemas when primitive string is passed", async () => {
      const registry = new ActionRegistry();
      const deleteSingleAsset = action({
        path: "/assets/files/delete-asset",
        method: "DELETE",
        version: 1,
        input: z.object({
          assetId: z.string().min(1),
        }),
        handler: async ({ input }) => ({ deletedId: input.assetId }),
      });
      registry.register(deleteSingleAsset);

      const dispatcher = createActionDispatcher(registry);
      const req = new Request(
        "http://localhost:3000/api/actions/v1/assets/files/delete-asset?input=ast_999",
        { method: "DELETE" },
      );
      const res = await dispatcher(req, {
        params: Promise.resolve({ path: ["v1", "assets", "files", "delete-asset"] }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual({ deletedId: "ast_999" });
    });
  });

  describe("Client Action References & callClientAction()", () => {
    it("should serialize client reference without exposing server handlers", () => {
      const serverAction = action({
        path: "/secure/data",
        method: "POST",
        version: 1,
        success: "Retrieved securely",
        handler: async () => {
          // Sensitive server logic that must not leak
          return { secret: 42 };
        },
      });

      const clientRef = serverAction.toClientRef();
      expect(clientRef.path).toBe("/secure/data");
      expect(clientRef.method).toBe("POST");
      expect(clientRef.version).toBe(1);
      expect((clientRef as any).handler).toBeUndefined();
      expect(JSON.stringify(clientRef)).toBeDefined();
    });

    it("should allow createClientActionReference for explicit client imports", () => {
      const ref = createClientActionReference<{ name: string }>({
        path: "/clients/invite",
        method: "POST",
        version: 1,
        success: "Invitation sent",
      });

      expect(ref.path).toBe("/clients/invite");
      expect(ref.method).toBe("POST");
      expect(ref.version).toBe(1);
      expect(ref.defaultSuccess).toBe("Invitation sent");
    });
  });
});
