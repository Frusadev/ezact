import { callAction } from "./execution";
import type { ActionRegistry } from "./registry";
import type {
  ActionResponse,
  RouteHandler,
  RouteHandlerContext,
} from "./types";

export interface ActionDispatcherOptions {
  registry: ActionRegistry;
  defaultVersion?: number;
  maxBodySizeBytes?: number;
}

/**
 * Creates a centralized Next.js App Router catch-all route handler.
 * Resolves versioned action endpoints, enforces size limits and HTTP methods,
 * and executes actions returning standardized ActionResponse envelopes.
 */
export function createActionDispatcher(
  optionsOrRegistry: ActionRegistry | ActionDispatcherOptions,
): RouteHandler {
  const options: ActionDispatcherOptions =
    "register" in optionsOrRegistry
      ? { registry: optionsOrRegistry }
      : optionsOrRegistry;

  const registry = options.registry;
  const defaultVersion = options.defaultVersion || 1;
  const maxBodySizeBytes = options.maxBodySizeBytes || 2 * 1024 * 1024; // 2MB default limit

  return async function actionDispatcher(
    request: Request,
    context?: RouteHandlerContext,
  ): Promise<Response> {
    try {
      // 1. Resolve route segments
      let segments: string[] = [];
      if (context?.params) {
        const resolvedParams =
          context.params instanceof Promise
            ? await context.params
            : context.params;

        const pathVal = (resolvedParams as Record<string, unknown>)?.path;
        if (Array.isArray(pathVal)) {
          segments = pathVal.map(String);
        } else if (typeof pathVal === "string") {
          segments = [pathVal];
        }
      }

      // If no catch-all params provided, fallback to URL path parsing
      if (segments.length === 0) {
        const url = new URL(request.url);
        const prefix = "/api/actions/";
        const idx = url.pathname.indexOf(prefix);
        if (idx !== -1) {
          segments = url.pathname
            .slice(idx + prefix.length)
            .split("/")
            .filter(Boolean);
        }
      }

      if (segments.length === 0) {
        const errResponse: ActionResponse<null> = {
          data: null,
          error: {
            code: 400,
            message: "Missing action path in URL",
          },
          success: null,
          message: "Missing action path in URL",
        };
        return Response.json(errResponse, { status: 400 });
      }

      // 2. Resolve version and action path
      let version = defaultVersion;
      let actionPathSegments = segments;

      const firstSegment = segments[0] || "";
      const versionMatch = firstSegment.match(/^v(\d+)$/i);
      if (versionMatch) {
        version = parseInt(versionMatch[1], 10);
        actionPathSegments = segments.slice(1);
      } else {
        const headerVersion = request.headers.get("x-action-version");
        if (headerVersion) {
          const parsed = parseInt(headerVersion, 10);
          if (!isNaN(parsed)) {
            version = parsed;
          }
        }
      }

      const actionPath = `/${actionPathSegments.join("/")}`;
      const method = request.method.toUpperCase();

      // 3. Body size enforcement
      const contentLengthHeader = request.headers.get("content-length");
      if (contentLengthHeader) {
        const length = parseInt(contentLengthHeader, 10);
        if (!isNaN(length) && length > maxBodySizeBytes) {
          const msg = `Payload too large. Maximum allowed size is ${maxBodySizeBytes} bytes.`;
          const errResponse: ActionResponse<null> = {
            data: null,
            error: {
              code: 413,
              message: msg,
            },
            success: null,
            message: msg,
          };
          return Response.json(errResponse, { status: 413 });
        }
      }

      // 4. Resolve registered action
      const resolveResult = registry.resolve({
        version,
        method,
        path: actionPath,
      });

      if (!resolveResult.success) {
        const errResponse: ActionResponse<null> = {
          data: null,
          error: {
            code: resolveResult.error.status,
            message: resolveResult.error.message,
          },
          success: null,
          message: resolveResult.error.message,
        };
        return Response.json(errResponse, {
          status: resolveResult.error.status,
          headers:
            resolveResult.error.status === 405
              ? { Allow: "GET, POST, PUT, PATCH, DELETE" }
              : undefined,
        });
      }

      const action = resolveResult.action;

      // 5. Parse action input payload
      let actionInput: unknown;

      if (method === "GET" || method === "DELETE") {
        const url = new URL(request.url);
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

        const queryKeys = Object.keys(query);
        if (queryKeys.length > 0) {
          const parseQueryPrimitive = (val: string): unknown => {
            if (val === "true") return true;
            if (val === "false") return false;
            if (val === "null") return null;
            if (val === "undefined") return undefined;
            if (/^-?\d+(\.\d+)?$/.test(val)) {
              const num = Number(val);
              if (!isNaN(num) && Number.isFinite(num)) {
                return num;
              }
            }
            if (
              (val.startsWith("{") && val.endsWith("}")) ||
              (val.startsWith("[") && val.endsWith("]"))
            ) {
              try {
                return JSON.parse(val);
              } catch {
                return val;
              }
            }
            return val;
          };

          const parseQueryValue = (v: string | string[]): unknown => {
            if (Array.isArray(v)) {
              return v.map((item) => (typeof item === "string" ? parseQueryPrimitive(item) : item));
            }
            return typeof v === "string" ? parseQueryPrimitive(v) : v;
          };

          const coerced: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(query)) {
            coerced[k] = parseQueryValue(v);
          }

          const schema = action.input || action.schema;
          if (schema && typeof (schema as any).safeParse === "function") {
            // 1. Try coerced query object (parsed numbers, booleans, null, arrays, JSON)
            if ((schema as any).safeParse(coerced).success) {
              actionInput = coerced;
            } else if ((schema as any).safeParse(query).success) {
              // 2. Try raw query object as-is
              actionInput = query;
            } else {
              // 2b. Try wrapping single non-array values into arrays if schema expects arrays
              const arrayCoerced: Record<string, unknown> = { ...coerced };
              let hasArrayWrap = false;
              for (const [k, v] of Object.entries(coerced)) {
                if (!Array.isArray(v) && v !== undefined && v !== null) {
                  arrayCoerced[k] = [v];
                  hasArrayWrap = true;
                }
              }
              if (hasArrayWrap && (schema as any).safeParse(arrayCoerced).success) {
                actionInput = arrayCoerced;
              } else if (query.input !== undefined && queryKeys.length === 1) {
                // 3. Client explicitly passed primitive `input` param
                const raw = query.input;
                const parsed = typeof raw === "string" ? parseQueryValue(raw) : raw;
                if ((schema as any).safeParse(parsed).success) {
                  actionInput = parsed;
                } else if ((schema as any).safeParse(raw).success) {
                  actionInput = raw;
                } else {
                  // Try wrapping into single-property object if schema expects an object
                  let matched = false;
                  const shape =
                    (schema as any).shape ||
                    ((schema as any)._def && typeof (schema as any)._def.shape === "function"
                      ? (schema as any)._def.shape()
                      : undefined);
                  if (shape && typeof shape === "object") {
                    for (const key of Object.keys(shape)) {
                      const wrapped = { [key]: parsed };
                      if ((schema as any).safeParse(wrapped).success) {
                        actionInput = wrapped;
                        matched = true;
                        break;
                      }
                    }
                  }
                  if (!matched) {
                    actionInput = coerced;
                  }
                }
              } else if (queryKeys.length === 1) {
                // 4. Single parameter passed, try unwrapping it as primitive or matching shape
                const soleVal = query[queryKeys[0]];
                const parsed = typeof soleVal === "string" ? parseQueryValue(soleVal) : soleVal;
                if ((schema as any).safeParse(parsed).success) {
                  actionInput = parsed;
                } else if ((schema as any).safeParse(soleVal).success) {
                  actionInput = soleVal;
                } else {
                  let matched = false;
                  const shape =
                    (schema as any).shape ||
                    ((schema as any)._def && typeof (schema as any)._def.shape === "function"
                      ? (schema as any)._def.shape()
                      : undefined);
                  if (shape && typeof shape === "object") {
                    for (const key of Object.keys(shape)) {
                      const wrapped = { [key]: parsed };
                      if ((schema as any).safeParse(wrapped).success) {
                        actionInput = wrapped;
                        matched = true;
                        break;
                      }
                    }
                  }
                  if (!matched) {
                    actionInput = coerced;
                  }
                }
              } else {
                actionInput = coerced;
              }
            }
          } else {
            // No safeParse method available on schema: check if single "input" param was passed
            if (query.input !== undefined && queryKeys.length === 1) {
              const raw = query.input;
              actionInput = typeof raw === "string" ? parseQueryValue(raw) : raw;
            } else {
              const coerced: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(query)) {
                coerced[k] = parseQueryValue(v);
              }
              actionInput = coerced;
            }
          }
        }
      } else {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const rawText = await request.text();
          if (rawText && rawText.trim().length > 0) {
            try {
              actionInput = JSON.parse(rawText);
            } catch {
              const errResponse: ActionResponse<null> = {
                data: null,
                error: {
                  code: 400,
                  message: "Invalid JSON in request body",
                },
                success: null,
                message: "Invalid JSON in request body",
              };
              return Response.json(errResponse, { status: 400 });
            }
          }
        }
      }

      // 6. Execute action through callAction
      // The request goes along so middlewares can read its headers.
      const result = await callAction(action, actionInput, {
        request,
        requestId: request.headers.get("x-request-id") || undefined,
      });

      const status = result.error ? result.error.code : 200;
      return Response.json(result, {
        status,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "digest" in err &&
        typeof (err as any).digest === "string" &&
        ((err as any).digest.startsWith("NEXT_REDIRECT") ||
          (err as any).digest.startsWith("NEXT_NOT_FOUND"))
      ) {
        throw err;
      }
      console.error("[Action Dispatcher Unexpected Error]", err);
      const errResponse: ActionResponse<null> = {
        data: null,
        error: {
          code: 500,
          message: "Internal server error in action dispatcher",
        },
        success: null,
        message: "Internal server error in action dispatcher",
      };
      return Response.json(errResponse, { status: 500 });
    }
  };
}
