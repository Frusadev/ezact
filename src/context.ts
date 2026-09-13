export interface BaseContextOptions {
  request?: Request;
  requestId?: string;
  data?: Record<string, unknown>;
}

/**
 * Execution context carrying request metadata and progressively enriched domain state.
 */
export class ActionContext<TData extends object = Record<string, never>> {
  private readonly _data: TData;
  readonly request?: Request;
  readonly requestId: string;

  constructor(options: BaseContextOptions = {}) {
    this.request = options.request;
    this.requestId = options.requestId || crypto.randomUUID();
    this._data = (options.data ? { ...options.data } : {}) as TData;

    // Use a Proxy so properties in _data can be directly accessed on ctx (e.g. ctx.user)
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in target._data) {
          return (target._data as Record<string, unknown>)[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /**
   * Adds a new strongly typed property to the context.
   * Throws an error if the key already exists to prevent accidental silent overwriting.
   */
  add<K extends string, V>(
    key: K,
    value: V,
  ): TypedActionContext<TData & Record<K, V>> {
    if (key in this._data || key in this) {
      throw new Error(
        `Context key "${key}" already exists. Use ctx.replace("${key}", value) if you explicitly intend to overwrite it.`,
      );
    }
    const nextData = { ...this._data, [key]: value };
    return new ActionContext({
      request: this.request,
      requestId: this.requestId,
      data: nextData as Record<string, unknown>,
    }) as TypedActionContext<TData & Record<K, V>>;
  }

  /**
   * Replaces an existing property in the context.
   */
  replace<K extends string, V>(
    key: K,
    value: V,
  ): TypedActionContext<Omit<TData, K> & Record<K, V>> {
    const nextData = { ...this._data, [key]: value };
    return new ActionContext({
      request: this.request,
      requestId: this.requestId,
      data: nextData as Record<string, unknown>,
    }) as TypedActionContext<Omit<TData, K> & Record<K, V>>;
  }

  /**
   * Strongly typed getter for known context properties.
   */
  get<K extends keyof TData>(key: K): TData[K] {
    return this._data[key];
  }

  /**
   * Safe getter for arbitrary or optional context properties.
   */
  getOptional(key: string): unknown {
    return (this._data as Record<string, unknown>)[key];
  }

  /**
   * Checks if a key exists in context data.
   */
  has(key: string): boolean {
    return key in this._data;
  }

  /**
   * Returns a shallow copy of all custom context data.
   */
  toObject(): TData {
    return { ...this._data };
  }
}

/**
 * Composite type that gives autocomplete for ActionContext methods AND dynamic custom properties.
 */
export type TypedActionContext<TData extends object = Record<string, never>> =
  ActionContext<TData> & TData;

/**
 * Creates a base ActionContext instance.
 */
export function createBaseContext(
  options: BaseContextOptions = {},
): TypedActionContext<Record<string, never>> {
  return new ActionContext<Record<string, never>>(options) as TypedActionContext<
    Record<string, never>
  >;
}
