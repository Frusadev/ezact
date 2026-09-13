import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export interface TimingContext {
  startTime: number;
}

/**
 * Middleware that tracks action execution duration in milliseconds.
 */
export function timing(): Middleware<object, TimingContext> {
  return createMiddleware<object, TimingContext>(async ({ ctx, next }) => {
    const startTime = Date.now();
    const nextCtx = ctx.add("startTime", startTime);
    return await next({ ctx: nextCtx });
  });
}
