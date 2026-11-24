import { AppError } from "../errors";
import type {
  ActionErrorContext,
  ActionErrorHandler,
  ErrorHandlingConfig,
} from "../types";

const ERROR_LOGGED_FLAG = Symbol.for("aupero.action.error.logged");

/**
 * Checks whether an error is an explicitly approved, safe user-facing application error.
 * Safe errors are AppError instances with HTTP status in the 4xx range
 * (e.g. ValidationError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError, RateLimitError).
 * 5xx errors or non-AppError exceptions represent unexpected server failures and must be sanitized.
 */
export function isSafeAppError(err: unknown): err is AppError {
  if (!err) return false;
  if (err instanceof AppError || (err as any).isAppError === true) {
    const status = (err as any).status;
    return typeof status === "number" && status >= 400 && status < 500;
  }
  return false;
}

/**
 * Detects whether the current execution runtime is configured as production.
 * Safe across all JS runtimes (Node, Bun, Workers, Edge) without requiring @types/node.
 */
export function isProduction(): boolean {
  return (globalThis as any).process?.env?.NODE_ENV === "production";
}

/**
 * Strips sensitive keys (passwords, tokens, credentials) from context metadata before logging.
 */
function sanitizeLogContext(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const sensitivePatterns =
    /password|token|secret|credential|auth|cookie|key|authorization/i;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) {
      if (sensitivePatterns.test(k)) {
        clean[k] = "[REDACTED]";
      } else {
        clean[k] = v;
      }
    }
  }
  return clean;
}

/**
 * Core error processor implementing the global action error-handling specification:
 * 1. Checks if error matches declared errors (e.g. throw "PROJECT_EXISTS")
 * 2. Invokes action-level formatError mapping if provided
 * 3. Invokes action-level onError telemetry hook if provided
 * 4. Structured server-side logging with action metadata (duplicate-log guarded)
 * 5. Passes safe 4xx AppErrors through with original codes and messages
 * 6. Sanitizes unexpected errors in production to "Something went wrong. Please try again." with "INTERNAL_ERROR"
 * 7. Preserves detailed message and stack traces in development
 */
export async function handleActionError(
  err: unknown,
  ctx: ActionErrorContext,
  config?: ErrorHandlingConfig,
): Promise<never> {
  let processedErr: unknown = err;

  // 1. Check if error is a string matching declared errors (e.g. throw "PROJECT_EXISTS")
  if (
    typeof err === "string" &&
    ctx.declaredErrors &&
    ctx.declaredErrors[err]
  ) {
    const declared = ctx.declaredErrors[err];
    processedErr = new AppError(
      declared.message,
      err,
      declared.code ?? 400,
    );
  }

  // 2. Action-specific formatError mapping (if configured)
  if (config?.formatError) {
    try {
      const formatted = await config.formatError(processedErr, ctx);
      if (formatted !== undefined) {
        processedErr = formatted;
      }
    } catch (formatErr) {
      // If formatError itself throws, treat that as the error to handle
      processedErr = formatErr;
    }
  }

  // 3. Action-specific onError hook (telemetry / Sentry)
  if (config?.onError) {
    try {
      await config.onError(processedErr, ctx);
    } catch {
      // Never let telemetry hook failure crash or bypass error handling
    }
  }

  // 4. Server-side logging before sanitization (prevent duplicate logs across layers)
  const isLogged =
    typeof processedErr === "object" &&
    processedErr !== null &&
    (processedErr as any)[ERROR_LOGGED_FLAG];

  if (!isLogged) {
    const rawMessage =
      processedErr instanceof Error
        ? processedErr.message
        : String(processedErr);
    const stack =
      processedErr instanceof Error ? processedErr.stack : undefined;
    const cause =
      processedErr instanceof Error
        ? (processedErr as any).cause
        : undefined;

    const logMeta = sanitizeLogContext({
      requestId: ctx.requestId,
      actionName: ctx.actionName,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      stack,
      cause,
    });

    if (config?.logger) {
      config.logger(`[Action:Error] ${rawMessage}`, logMeta);
    } else {
      console.error(`[Action:Error] ${rawMessage}`, logMeta);
    }

    if (typeof processedErr === "object" && processedErr !== null) {
      try {
        Object.defineProperty(processedErr, ERROR_LOGGED_FLAG, {
          value: true,
          enumerable: false,
          configurable: true,
        });
      } catch {
        // Ignore if frozen
      }
    }
  }

  // 5. If it's a safe application error (e.g. 4xx AppError: validation, auth, not found, etc.)
  if (isSafeAppError(processedErr)) {
    throw processedErr;
  }



  // 6. Production sanitization vs Development debugging
  if (isProduction()) {
    // In production, unexpected errors are strictly masked.
    // Even if an arbitrary Error or unexpected 500 error was returned by formatError,
    // it MUST NOT expose internal details.
    throw new AppError(
      "Something went wrong. Please try again.",
      "INTERNAL_ERROR",
      500,
    );
  }


  // In development, preserve full details (original message, stack, cause)
  const devMessage =
    processedErr instanceof Error
      ? processedErr.message
      : String(processedErr);
  const devError = new AppError(
    devMessage,
    "INTERNAL_ERROR",
    500,
    processedErr instanceof Error
      ? { stack: processedErr.stack, cause: (processedErr as any).cause }
      : { raw: processedErr },
  );
  if (processedErr instanceof Error && processedErr.stack) {
    devError.stack = processedErr.stack;
  }
  throw devError;
}

/**
 * Default global error handler automatically injected into every action.
 */
export const defaultActionErrorHandler: ActionErrorHandler = async (
  err: unknown,
  ctx: ActionErrorContext,
): Promise<never> => {
  return handleActionError(err, ctx);
};
