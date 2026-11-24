import type { TypedActionContext } from "../context";
import { rateLimitExceeded } from "../errors";
import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export interface RateLimitStore {
  increment: (
    key: string,
    windowMs: number,
  ) => Promise<{ count: number; resetAt: number }>;
}

/**
 * In-memory fixed window store. Per process, so use a shared store (Redis) when the app
 * runs on more than one instance. Expired windows are swept so the map can't grow forever.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(private readonly maxKeys = 10_000) {}

  private sweep(now: number) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    // Still full of live windows: drop the oldest, rather than grow without bound.
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }

  async increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    if (now >= this.nextSweep || this.hits.size >= this.maxKeys) {
      this.sweep(now);
      this.nextSweep = now + 60_000;
    }
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

/**
 * The client's address. X-Forwarded-For's first entry is whatever the client sent, so it's
 * never trusted: we take the edge's own header, or the entry the nearest proxy appended.
 */
export function clientIp(request: Request): string | null {
  const edge =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip");
  if (edge) return edge.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last || null;
}

let instances = 0;

const defaultStore = new MemoryRateLimitStore();

export interface RateLimitOptions<
  TCtx extends object = object,
  TInput = unknown,
> {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (
    ctx: TypedActionContext<TCtx>,
    input: TInput,
  ) => string | Promise<string>;
  store?: RateLimitStore;
  message?: string;
  /** Namespaces the keys. Defaults to one per rateLimit() call, so limits never share a count. */
  name?: string;
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
  const name = options.name ?? `limit${++instances}`;
  const message =
    options.message ?? "Too many requests. Please try again later.";

  return createMiddleware<TCtx, object>(async ({ ctx, input, next }) => {
    let key = "global";

    if (options.keyGenerator) {
      key = await options.keyGenerator(ctx, input as TInput);
    } else if (ctx.request) {
      key = clientIp(ctx.request) ?? "unknown";
    }

    const { count, resetAt } = await store.increment(`${name}:${key}`, windowMs);

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
