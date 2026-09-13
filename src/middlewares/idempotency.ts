import type { TypedActionContext } from "../context";
import { conflict } from "../errors";
import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export interface IdempotencyRecord {
  status: "pending" | "resolved";
  response?: unknown;
  createdAt: number;
}

export interface IdempotencyStore {
  get: (key: string) => Promise<IdempotencyRecord | undefined>;
  set: (key: string, record: IdempotencyRecord, ttlMs: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.record;
  }

  async set(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    this.cache.set(key, {
      record,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }
}

const defaultIdempotencyStore = new MemoryIdempotencyStore();

export interface IdempotencyOptions<
  TCtx extends object = object,
  TInput = unknown,
> {
  getKey?: (
    ctx: TypedActionContext<TCtx>,
    input: TInput,
  ) => string | undefined | null | Promise<string | undefined | null>;
  ttlMs?: number;
  store?: IdempotencyStore;
}

/**
 * Middleware that guarantees idempotency for mutations by caching and returning previous responses.
 */
export function idempotency<TCtx extends object = object, TInput = unknown>(
  options: IdempotencyOptions<TCtx, TInput> = {},
): Middleware<TCtx, object> {
  const ttlMs = options.ttlMs ?? 300_000; // 5 minutes default
  const store = options.store ?? defaultIdempotencyStore;

  return createMiddleware<TCtx, object>(async ({ ctx, input, next }) => {
    let key: string | undefined | null;

    if (options.getKey) {
      key = await options.getKey(ctx, input as TInput);
    } else if (ctx.request) {
      key = ctx.request.headers.get("idempotency-key") || ctx.request.headers.get("x-idempotency-key");
    }

    // If no key is provided, proceed normally without caching
    if (!key) {
      return await next();
    }

    const cached = await store.get(key);
    if (cached) {
      if (cached.status === "pending") {
        throw conflict(
          "A request with this idempotency key is currently being processed. Please wait.",
        );
      }
      return cached.response;
    }

    // Mark as pending to prevent concurrent duplicate execution
    await store.set(key, { status: "pending", createdAt: Date.now() }, ttlMs);

    try {
      const response = await next();
      await store.set(
        key,
        { status: "resolved", response, createdAt: Date.now() },
        ttlMs,
      );
      return response;
    } catch (err: unknown) {
      // Remove failed attempts so retry can succeed
      await store.delete(key);
      throw err;
    }
  });
}
