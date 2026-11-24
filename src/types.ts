import type { z } from "zod";
import type { TypedActionContext } from "./context";

/**
 * Converts a union type to an intersection type.
 */
export type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Supported HTTP methods for actions.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Unified response schema for all Superactions and supported API routes.
 */
export type ActionResponse<T> = {
  data: T | null;
  error: {
    code: number;
    message: string;
    type?: string;
    details?: unknown;
  } | null;
  success: {
    message: string;
  } | null;
  message: string | null;
};

/**
 * Declared application error definition.
 */
export type DeclaredErrorDefinition = {
  code?: number;
  message: string;
};

/**
 * Declared application errors mapping.
 */
export type DeclaredErrors = Record<string, DeclaredErrorDefinition>;

/**
 * Client-safe serializable reference containing only metadata needed for remote invocation.
 */
export interface ClientActionReference<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly version: number;
  readonly defaultSuccess?: string;
  readonly _input?: (input: TInput) => void;
  readonly _output?: () => TOutput;
}

/**
 * Partitioned schema defining distinct validation rules for different parts of an HTTP request.
 */
export interface PartitionedInputSchema {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  headers?: z.ZodTypeAny;
  formData?: z.ZodTypeAny;
}

/**
 * Accepted input schema definition (either a single Zod schema or a partitioned object).
 */
export type InputSchemaDef = z.ZodTypeAny | PartitionedInputSchema;

/**
 * Infers raw input type for callers of a partitioned schema.
 */
export type InferPartitionedInput<T extends PartitionedInputSchema> = {
  -readonly [K in keyof T as T[K] extends z.ZodTypeAny
    ? K
    : never]-?: NonNullable<T[K]> extends z.ZodTypeAny
    ? z.input<NonNullable<T[K]>>
    : never;
};

/**
 * Infers parsed input type received by handler from a partitioned schema.
 */
export type InferPartitionedHandlerInput<T extends PartitionedInputSchema> = {
  -readonly [K in keyof T as T[K] extends z.ZodTypeAny
    ? K
    : never]-?: NonNullable<T[K]> extends z.ZodTypeAny
    ? z.output<NonNullable<T[K]>>
    : never;
};

/**
 * Infers the input expected when calling the action directly.
 */
export type InferInput<T extends InputSchemaDef> =
  T extends PartitionedInputSchema
    ? InferPartitionedInput<T>
    : T extends z.ZodTypeAny
      ? z.input<T>
      : void;

/**
 * Infers the validated input received by the action handler.
 */
export type InferHandlerInput<T extends InputSchemaDef> =
  T extends PartitionedInputSchema
    ? InferPartitionedHandlerInput<T>
    : T extends z.ZodTypeAny
      ? z.output<T>
      : void;

/**
 * Infers the validated output type from a Zod schema.
 */
export type InferOutput<T extends z.ZodTypeAny> = z.output<T>;

/**
 * Callback passed to a middleware to proceed to the next step in the pipeline.
 */
export type MiddlewareNext<TCtxOut extends object = object> = (args?: {
  ctx?: TypedActionContext<TCtxOut>;
  input?: unknown;
}) => Promise<unknown>;

/**
 * Middleware function contract with progressive context enrichment.
 */
export type Middleware<
  TCtxIn extends object = object,
  TCtxOut extends object = object,
> = (params: {
  ctx: TypedActionContext<TCtxIn>;
  input: unknown;
  next: MiddlewareNext<TCtxOut>;
}) => Promise<unknown>;

/**
 * Extracts the output context of a middleware.
 */
export type MiddlewareOutputContext<T> =
  T extends Middleware<infer _TCtxIn, infer TCtxOut> ? TCtxOut : object;

/**
 * Derives accumulated context type produced by a tuple of middlewares.
 */
export type PipelineContext<TMiddlewares extends readonly unknown[]> =
  TMiddlewares extends readonly []
    ? object
    : TMiddlewares extends readonly [infer First, ...infer Rest]
      ? (MiddlewareOutputContext<First> extends object
          ? MiddlewareOutputContext<First>
          : object) &
          (PipelineContext<Rest> extends object
            ? PipelineContext<Rest>
            : object)
      : TMiddlewares extends readonly (infer M)[]
        ? UnionToIntersection<MiddlewareOutputContext<M>> extends object
          ? UnionToIntersection<MiddlewareOutputContext<M>>
          : object
        : object;

/**
 * The core business logic handler function for an action.
 */
export type ActionHandler<TInput, TCtx extends object, TOutput> = (options: {
  input: TInput;
  ctx: TypedActionContext<TCtx>;
}) => Promise<TOutput> | TOutput;

/**
 * Metadata attached to a ServerAction.
 */
export interface ServerActionMetadata<
  TInput = unknown,
  TOutput = unknown,
  TErrors extends DeclaredErrors = DeclaredErrors,
> {
  readonly isServerAction: true;
  readonly id?: string;
  readonly path?: string;
  readonly method: HttpMethod;
  readonly version: number;
  readonly errors: TErrors;
  readonly success?: string;
  readonly schema?: InputSchemaDef;
  readonly input?: InputSchemaDef;
  readonly output?: z.ZodTypeAny;
  readonly middlewares: readonly Middleware<object, object>[];
  readonly handler: Function;
  toRouteHandler: () => RouteHandler;
  toClientRef: () => ClientActionReference<TInput, TOutput>;
}

/**
 * Context provided to an action error handler, containing available request metadata.
 * All fields are optional because they may not be populated at the time an error occurs.
 */
export interface ActionErrorContext {
  /** The action path (e.g. "/projects") or ID, for log correlation. */
  actionName?: string;
  /** The per-request UUID created by ActionContext. */
  requestId?: string;
  /** The authenticated user's ID, if available in context. */
  userId?: string;
  /** The current organization's ID, if available in context. */
  organizationId?: string;
  /** Declared error definitions for this action, if any. */
  declaredErrors?: DeclaredErrors;
}

/**
 * Action-level error handling configuration options.
 */
export interface ErrorHandlingConfig {
  /**
   * Optional callback invoked when an error occurs, before sanitization.
   * Useful for external logging, telemetry, or Sentry reporting.
   */
  onError?: (err: unknown, ctx: ActionErrorContext) => void | Promise<void>;

  /**
   * Optional error mapper allowing actions to classify or convert domain errors into AppErrors.
   * If a safe AppError (e.g. BadRequestError, NotFoundError, or 4xx AppError) is returned,
   * it will be thrown and safely exposed.
   * If an arbitrary Error or unexpected 500 error is returned, production sanitization
   * will STILL apply, ensuring internal details are never leaked.
   */
  formatError?: (
    err: unknown,
    ctx: ActionErrorContext,
  ) => unknown | Promise<unknown>;

  /**
   * Optional custom error logger.
   */
  logger?: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Custom error handler for a single action.
 *
 * Receives the raw thrown error and lightweight context metadata, and **must always throw**.
 * Return type is `never` to enforce this at the type level.
 *
 * Only explicitly user-facing errors (i.e. `AppError` subclasses) should be thrown
 * directly back to the client. Arbitrary internal errors must be sanitized before throwing.
 *
 * @example
 * ```ts
 * const myErrorHandler: ActionErrorHandler = (err, ctx) => {
 *   if (err instanceof MyDomainError) {
 *     throw new BadRequestError(err.userMessage);
 *   }
 *   throw new InternalServerError("Something went wrong. Please try again.");
 * };
 * ```
 */
export type ActionErrorHandler = (
  err: unknown,
  ctx: ActionErrorContext,
) => never | Promise<never>;

/**
 * Configuration options for creating a ServerAction.
 */
export interface ActionConfig<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
  TErrors extends DeclaredErrors = DeclaredErrors,
  TOutput = unknown,
> {
  id?: string;
  path?: string;
  method?: HttpMethod;
  version?: number;
  errors?: TErrors;
  success?: string;
  input?: TInputSchema;
  schema?: TInputSchema; // Alias for input
  output?: TOutputSchema;
  metadata?: Record<string, unknown>;
  middleware?: TMiddlewares;
  /**
   * Per-action error handling configuration.
   */
  errorHandling?: ErrorHandlingConfig;
  /**
   * Optional per-action error handler that replaces the default global error handler.
   *
   * The function **must always throw** — it converts the raw error into a safe `AppError`
   * (or re-throws an existing one). Returning normally is a TypeScript error.
   *
   * Production sanitization must still be applied: do not forward arbitrary internal
   * error messages to the client. Only explicitly approved user-facing errors (i.e.
   * `AppError` subclasses) may be thrown through to the response.
   */
  errorHandler?: ActionErrorHandler;

  handler: ActionHandler<
    TInputSchema extends InputSchemaDef
      ? InferHandlerInput<TInputSchema>
      : void,
    NoInfer<PipelineContext<TMiddlewares>>,
    TOutputSchema extends z.ZodTypeAny ? InferOutput<TOutputSchema> : TOutput
  >;
}

/**
 * Context provided by Next.js App Router route handlers.
 */
export interface RouteHandlerContext {
  params?:
    | Promise<Record<string, string | string[]>>
    | Record<string, string | string[]>;
}

/**
 * Standard Next.js / Web Fetch route handler function type.
 */
export type RouteHandler = (
  request: Request,
  context?: RouteHandlerContext,
) => Promise<Response>;

export type ServerActionFn<TInput, TOutput> = [TInput] extends [void]
  ? (input?: unknown, ...rest: readonly unknown[]) => Promise<Awaited<TOutput>>
  : [undefined] extends [TInput]
    ? (input?: TInput, ...rest: readonly unknown[]) => Promise<Awaited<TOutput>>
    : (input: TInput) => Promise<Awaited<TOutput>>;

/**
 * Strongly typed Server Action callable returned by `action(...)`.
 * Can be directly invoked as an async function in Server Actions / UI,
 * or exported as a Route Handler using `.toRouteHandler()`.
 */
export type ServerAction<
  TInput,
  TOutput,
  TErrors extends DeclaredErrors = DeclaredErrors,
> = ServerActionFn<TInput, TOutput> &
  ServerActionMetadata<TInput, TOutput, TErrors>;
