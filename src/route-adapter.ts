import { z } from "zod";
import { AppError, BadRequestError, toAppError } from "./errors";
import type {
  InputSchemaDef,
  PartitionedInputSchema,
  RouteHandler,
  RouteHandlerContext,
  ServerAction,
} from "./types";
import type { BaseContextOptions } from "./context";

/**
 * Checks if a schema definition is partitioned across HTTP sources (params, query, body, etc.).
 */
export function isPartitionedSchema(
  schema: unknown,
): schema is PartitionedInputSchema {
  if (!schema || typeof schema !== "object") return false;
  if (schema instanceof z.ZodType) return false;
  const s = schema as Record<string, unknown>;
  return (
    "params" in s ||
    "query" in s ||
    "body" in s ||
    "headers" in s ||
    "formData" in s
  );
}

/**
 * Parses query parameters from URL into an object, properly handling duplicate keys as arrays.
 */
export function parseSearchParams(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

export type ActionCallable = (
  input?: unknown,
  options?: BaseContextOptions,
) => Promise<unknown>;

/**
 * Adapts a Server Action into a standard Next.js / Web Fetch API Route Handler.
 */
export function createRouteHandler<TInput, TOutput>(
  action: ServerAction<TInput, TOutput> | ActionCallable,
  actionSchema?: InputSchemaDef,
): RouteHandler {
  const schema: InputSchemaDef | undefined =
    actionSchema ||
    ("schema" in action
      ? (action.schema as InputSchemaDef | undefined)
      : undefined);

  return async function routeHandler(
    request: Request,
    context?: RouteHandlerContext,
  ): Promise<Response> {
    try {
      // 1. Resolve route params (handles Next.js 15 Promise-based params and Next.js 13/14 objects)
      let params: Record<string, string | string[]> = {};
      if (context?.params) {
        const resolvedParams =
          context.params instanceof Promise
            ? await context.params
            : await Promise.resolve(context.params);
        if (resolvedParams && typeof resolvedParams === "object") {
          params = resolvedParams as Record<string, string | string[]>;
        }
      }

      // 2. Resolve query parameters
      const url = new URL(request.url);
      const query = parseSearchParams(url);

      // 3. Resolve request headers
      const headersRecord: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headersRecord[key] = value;
      });

      // 4. Resolve request body (if HTTP method allows a payload)
      let body: unknown = undefined;
      let formData: FormData | undefined = undefined;
      const method = request.method.toUpperCase();

      if (method !== "GET" && method !== "HEAD") {
        const contentType = request.headers.get("content-type") || "";

        if (
          contentType.includes("multipart/form-data") ||
          contentType.includes("application/x-www-form-urlencoded")
        ) {
          try {
            formData = await request.formData();
            body = Object.fromEntries(formData.entries());
          } catch {
            // Ignore formData parsing error if empty
          }
        } else if (contentType.includes("application/json")) {
          try {
            const rawText = await request.text();
            if (rawText && rawText.trim().length > 0) {
              body = JSON.parse(rawText);
            }
          } catch {
            throw new BadRequestError("Invalid JSON in request body");
          }
        }
      }

      // 5. Construct input payload according to schema expectations
      let actionInput: unknown = undefined;

      if (isPartitionedSchema(schema)) {
        actionInput = {
          params,
          query,
          body,
          headers: headersRecord,
          formData,
        };
      } else if (schema) {
        if (method === "GET" || method === "DELETE") {
          actionInput =
            Object.keys(query).length > 0 || Object.keys(params).length > 0
              ? { ...query, ...params }
              : undefined;
        } else {
          actionInput =
            body !== undefined
              ? typeof body === "object" && body !== null && !Array.isArray(body)
                ? { ...query, ...params, ...(body as Record<string, unknown>) }
                : body
              : Object.keys(params).length > 0
              ? { ...params }
              : undefined;
        }
      } else {
        // No schema: provide all available sources merged
        if (body !== undefined) {
          actionInput =
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? { ...query, ...params, ...(body as Record<string, unknown>) }
              : body;
        } else if (
          Object.keys(query).length > 0 ||
          Object.keys(params).length > 0
        ) {
          actionInput = { ...query, ...params };
        }
      }

      // 6. Invoke the underlying action
      const actionFn = action as ActionCallable;
      const result = await actionFn(actionInput, {
        request,
        requestId:
          request.headers.get("x-request-id") || crypto.randomUUID(),
      });

      // 7. If the handler returned a raw Response (e.g. file stream, redirect, custom headers), return it directly
      if (result instanceof Response) {
        return result;
      }

      // 8. Otherwise, return standard JSON response
      return Response.json(result, { status: 200 });
    } catch (err: unknown) {
      const appError: AppError = toAppError(err);
      return Response.json(appError.toJSON(), { status: appError.status });
    }
  };
}
