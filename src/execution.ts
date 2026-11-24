import type { BaseContextOptions } from "./context";
import { AppError, toAppError } from "./errors";
import type {
  ActionResponse,
  ClientActionReference,
  DeclaredErrors,
  InferInput,
  InferOutput,
  InputSchemaDef,
  ServerAction,
} from "./types";

/**
 * Validates and enforces standard response invariants:
 * - Never both data and error
 * - Never both error and success
 * - All three properties (data, error, success) are always present
 */
export function normalizeActionResponse<T>(
  response: Partial<ActionResponse<T>> & Record<string, unknown>,
): ActionResponse<T> {
  if (response.error) {
    const errorCode =
      typeof (response.error as any)?.code === "number"
        ? (response.error as any).code
        : 500;
    const errorMessage =
      typeof response.error === "string"
        ? response.error
        : typeof (response.error as any)?.message === "string"
          ? (response.error as any).message
          : typeof response.message === "string"
            ? response.message
            : "An error occurred";

    return {
      data: null,
      error: {
        code: errorCode,
        message: errorMessage,
        ...(typeof (response.error as any)?.type === "string"
          ? { type: (response.error as any).type }
          : {}),
        ...(errorCode < 500 && (response.error as any)?.details !== undefined
          ? { details: (response.error as any).details }
          : {}),
      },
      success: null,
      message: errorMessage,
    };
  }

  const successMessage =
    typeof response.success === "object" &&
    response.success !== null &&
    typeof (response.success as any).message === "string"
      ? (response.success as any).message
      : typeof response.message === "string"
        ? response.message
        : "Operation completed successfully";

  let dataPayload: T | null;
  if (response.data !== undefined) {
    dataPayload = response.data as T | null;
  } else {
    const { error: _err, success: _succ, message: _msg, data: _d, ...rest } = response;
    if (Object.keys(rest).length > 0) {
      dataPayload = rest as unknown as T;
    } else {
      dataPayload = null;
    }
  }

  return {
    data: dataPayload,
    error: null,
    success: {
      message: successMessage,
    },
    message: successMessage,
  };
}

/**
 * Normalizes an exception into a safe public error envelope without leaking sensitive details.
 */
export function normalizeErrorToResponse<T = unknown>(
  err: unknown,
  declaredErrors?: DeclaredErrors,
): ActionResponse<T> {
  // Check if error matches a declared error key
  if (declaredErrors) {
    const errKey =
      typeof err === "string"
        ? err
        : err instanceof Error
          ? err.message
          : (err as any)?.code;

    if (errKey && declaredErrors[errKey]) {
      const declared = declaredErrors[errKey];
      const message = declared.message;
      return {
        data: null,
        error: {
          code: declared.code ?? 400,
          message,
        },
        success: null,
        message,
      };
    }
  }

  // AppError instance (e.g. ValidationError, UnauthorizedError, NotFoundError, etc.)
  if (err instanceof AppError) {
    return {
      data: null,
      error: {
        code: err.status,
        message: err.message,
        type: err.code,
        // 5xx details can hold a stack trace in development.
        ...(err.status < 500 && err.details !== undefined ? { details: err.details } : {}),
      },
      success: null,
      message: err.message,
    };
  }

  const appErr = toAppError(err);
  if (appErr.status < 500) {
    return {
      data: null,
      error: {
        code: appErr.status,
        message: appErr.message,
      },
      success: null,
      message: appErr.message,
    };
  }

  // Unknown internal exception: log diagnostic server-side and mask public response
  if (typeof window === "undefined") {
    console.error("[Superaction Execution Exception]", err);
  }

  const message = "An internal server error occurred";
  return {
    data: null,
    error: {
      code: 500,
      message,
    },
    success: null,
    message,
  };
}

/**
 * Reusable safeCall utility for executing synchronous and asynchronous operations
 * and normalizing results or exceptions into standard ActionResponse envelopes.
 */
export async function safeCall<T>(
  fnOrPromise: (() => Promise<T> | T) | Promise<T>,
  options?: {
    defaultSuccessMessage?: string;
    declaredErrors?: DeclaredErrors;
  },
): Promise<ActionResponse<T>> {
  try {
    const result =
      typeof fnOrPromise === "function"
        ? await fnOrPromise()
        : await fnOrPromise;

    // Check if result is an explicit error return like { error: "..." } or { error: { code, message } }
    if (
      result &&
      typeof result === "object" &&
      "error" in result &&
      (result as any).error
    ) {
      const err = (result as any).error;
      const code = typeof err?.code === "number" ? err.code : 400;
      const msg =
        typeof err === "string"
          ? err
          : typeof err?.message === "string"
            ? err.message
            : "Operation failed";
      return {
        data: null,
        error: { code, message: msg },
        success: null,
        message: msg,
      };
    }

    // If result is already a complete ActionResponse envelope
    if (
      result &&
      typeof result === "object" &&
      "data" in result &&
      "error" in result &&
      "success" in result
    ) {
      return normalizeActionResponse<T>(result as Partial<ActionResponse<T>>);
    }

    const successMessage =
      options?.defaultSuccessMessage || "Operation completed successfully";

    return {
      data: (result !== undefined ? result : null) as T | null,
      error: null,
      success: {
        message: successMessage,
      },
      message: successMessage,
    };
  } catch (err: unknown) {
    if (
      (err as any)?.digest?.includes?.("NEXT_REDIRECT") ||
      (err as any)?.digest?.includes?.("NEXT_NOT_FOUND")
    ) {
      throw err;
    }
    return normalizeErrorToResponse<T>(err, options?.declaredErrors);
  }
}

/**
 * Direct server-side action execution function.
 * Enforces server-only execution, invokes the handler through the pipeline,
 * and formats the result to the unified response schema.
 */
export async function callAction<
  TInput,
  TOutput,
  TErrors extends DeclaredErrors = DeclaredErrors,
>(
  action: ServerAction<TInput, TOutput, TErrors>,
  input?: TInput,
  options?: BaseContextOptions,
): Promise<ActionResponse<Awaited<TOutput>>> {
  // Enforce server-only execution
  if (typeof window !== "undefined") {
    throw new Error(
      "callAction must only be executed in a server environment. Use callClientAction on the client.",
    );
  }

  return await safeCall<Awaited<TOutput>>(
    async () => {
      const res = await (action as any)(input, options);
      return res;
    },
    {
      defaultSuccessMessage: action.success,
      declaredErrors: action.errors,
    },
  );
}

/**
 * Configuration options for client action execution.
 */
export interface CallClientActionOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Client-side action execution function.
 * Makes an HTTP request to the registered centralized action dispatcher,
 * and normalizes transport, network, and server errors into ActionResponse envelopes.
 */
export async function callClientAction<TInput, TOutput>(
  actionRef:
    | ClientActionReference<TInput, TOutput>
    | ServerAction<TInput, TOutput, any>,
  input?: TInput,
  options?: CallClientActionOptions,
): Promise<ActionResponse<Awaited<TOutput>>> {
  const ref =
    typeof (actionRef as any)?.toClientRef === "function"
      ? (actionRef as any).toClientRef()
      : (actionRef as ClientActionReference<TInput, TOutput>);

  const version = ref.version || 1;
  const rawPath = ref.path || "";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const baseUrl = options?.baseUrl || "";
  const endpoint = `${baseUrl}/api/actions/v${version}${path}`;
  const method = (ref.method || "POST").toUpperCase();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options?.headers,
  };

  let url = endpoint;
  let body: string | undefined;

  if (method === "GET" || method === "DELETE") {
    if (input !== undefined && input !== null) {
      const searchParams = new URLSearchParams();
      if (typeof input === "object" && !Array.isArray(input)) {
        for (const [key, value] of Object.entries(
          input as Record<string, unknown>,
        )) {
          if (value !== undefined) {
            if (value === null) {
              searchParams.append(key, "null");
            } else if (typeof value === "object") {
              searchParams.append(key, JSON.stringify(value));
            } else {
              searchParams.append(key, String(value));
            }
          }
        }
      } else {
        const rawValue =
          typeof input === "string" ? input : JSON.stringify(input);
        searchParams.append("input", rawValue);
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes("?") ? "&" : "?") + qs;
      }
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(input !== undefined ? input : {});
  }

  try {
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeoutMs) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller?.abort(), options.timeoutMs);
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: options?.signal || controller?.signal,
    });

    if (timeoutId) clearTimeout(timeoutId);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await response.json();
      if (
        json &&
        typeof json === "object" &&
        ("data" in json || "error" in json || "success" in json)
      ) {
        return normalizeActionResponse<Awaited<TOutput>>(json);
      }
      if (!response.ok) {
        const msg =
          (json as any)?.message || response.statusText || "Request failed";
        return {
          data: null,
          error: {
            code: response.status,
            message: msg,
          },
          success: null,
          message: msg,
        };
      }
      const successMessage =
        ref.defaultSuccess || "Operation completed successfully";
      return {
        data: json,
        error: null,
        success: {
          message: successMessage,
        },
        message: successMessage,
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const msg = text || response.statusText || "Request failed";
      return {
        data: null,
        error: {
          code: response.status,
          message: msg,
        },
        success: null,
        message: msg,
      };
    }

    const text = await response.text();
    const successMessage =
      ref.defaultSuccess || "Operation completed successfully";
    return {
      data: text as unknown as Awaited<TOutput>,
      error: null,
      success: {
        message: successMessage,
      },
      message: successMessage,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        data: null,
        error: {
          code: 408,
          message: "Request timed out",
        },
        success: null,
        message: "Request timed out",
      };
    }

    const msg = err instanceof Error ? err.message : "Network error";
    return {
      data: null,
      error: {
        code: 0,
        message: msg,
      },
      success: null,
      message: msg,
    };
  }
}
