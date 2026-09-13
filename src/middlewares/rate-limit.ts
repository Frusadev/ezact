import type { TypedActionContext } from "../context";
import { rateLimitExceeded } from "../errors";
import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export interface RateLimitStore {
  increment: (key: string, windowMs: number) => Promise<{ count: number; resetAt: number }>;
}

/**
 * In-memory sliding window rate limiter store.
 */
class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowMs;
      this.hits.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    }

    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }
}

const defaultStore = new MemoryRateLimitStore();

export interface RateLimitOptions<TCtx extends object = object, TInput = unknown> {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (ctx: TypedActionContext<TCtx>, input: TInput) => string | Promise<string>;
  store?: RateLimitStore;
  message?: string;
}

/**
 * Middleware that limits execution frequency based on IP, user identity, or custom key.
 */
export function rateLimit<TCtx extends object = object, TInput = unknown>(
  options: RateLimitOptions<TCtx, TInput> = {},
): Middleware<TCtx, object> {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 60;
  const store = options.store ?? defaultStore;
  const message =
    options.message ?? "Too many requests. Please try again later.";

  return createMiddleware<TCtx, object>(async ({ ctx, input, next }) => {
    let key = "global";

    if (options.keyGenerator) {
      key = await options.keyGenerator(ctx, input as TInput);
    } else if (ctx.request) {
      const forwarded = ctx.request.headers.get("x-forwarded-for");
      key = forwarded ? forwarded.split(",")[0].trim() : "anonymous";
    }

    const { count, resetAt } = await store.increment(key, windowMs);

    if (count > maxRequests) {
      throw rateLimitExceeded(message, {
        retryAfterMs: Math.max(0, resetAt - Date.now()),
        limit: maxRequests,
        remaining: 0,
      });
    }

    return await next();
  });
}
