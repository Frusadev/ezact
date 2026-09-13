import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export interface Logger {
  info: (message: string, data?: unknown) => void;
  error: (message: string, error?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
}

export interface LoggingOptions {
  logger?: Logger;
  logInput?: boolean;
}

/**
 * Middleware that logs the lifecycle and duration of an action.
 */
export function logging(options: LoggingOptions = {}): Middleware<object, object> {
  const logger = options.logger ?? console;
  const logInput = options.logInput ?? false;

  return createMiddleware<object, object>(async ({ ctx, input, next }) => {
    const start = Date.now();
    logger.info(`[Action:Start] requestId=${ctx.requestId}`, logInput ? { input } : undefined);

    try {
      const result = await next();
      const durationMs = Date.now() - start;
      logger.info(`[Action:Success] requestId=${ctx.requestId} durationMs=${durationMs}`);
      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      logger.error(`[Action:Error] requestId=${ctx.requestId} durationMs=${durationMs}`, err);
      throw err;
    }
  });
}
