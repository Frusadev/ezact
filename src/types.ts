import type { z } from "zod";
import type { ActionContext, TypedActionContext } from "./context";

/**
 * Converts a union type to an intersection type.
 */
export type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

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
  -readonly [K in keyof T as T[K] extends z.ZodTypeAny ? K : never]-?: NonNullable<
    T[K]
  > extends z.ZodTypeAny
    ? z.input<NonNullable<T[K]>>
    : never;
};

/**
 * Infers parsed input type received by handler from a partitioned schema.
 */
export type InferPartitionedHandlerInput<T extends PartitionedInputSchema> = {
  -readonly [K in keyof T as T[K] extends z.ZodTypeAny ? K : never]-?: NonNullable<
    T[K]
  > extends z.ZodTypeAny
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
export type MiddlewareOutputContext<T> = T extends Middleware<
  infer _TCtxIn,
  infer TCtxOut
>
  ? TCtxOut
  : object;

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
        (PipelineContext<Rest> extends object ? PipelineContext<Rest> : object)
    : TMiddlewares extends readonly (infer M)[]
    ? UnionToIntersection<MiddlewareOutputContext<M>> extends object
      ? UnionToIntersection<MiddlewareOutputContext<M>>
      : object
    : object;

/**
 * Handler function signature for server actions.
 */
export type ActionHandler<TInput, TCtx extends object, TOutput> = (params: {
  input: TInput;
  ctx: TypedActionContext<TCtx>;
}) => Promise<TOutput>;

/**
 * Metadata attached to a ServerAction.
 */
export interface ServerActionMetadata {
  name?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Configuration options for creating a ServerAction.
 */
export interface ActionConfig<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
  TOutput = unknown,
> {
  input?: TInputSchema;
  schema?: TInputSchema; // Alias for input
  output?: TOutputSchema;
  metadata?: ServerActionMetadata;
  middleware?: TMiddlewares;
  handler: (params: {
    input: TInputSchema extends InputSchemaDef
      ? InferHandlerInput<TInputSchema>
      : void;
    ctx: TypedActionContext<NoInfer<PipelineContext<TMiddlewares>>>;
  }) => Promise<TOutput>;
}

/**
 * Context provided by Next.js App Router route handlers.
 */
export interface RouteHandlerContext {
  params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]>;
}

/**
 * Standard Next.js / Web Fetch route handler function type.
 */
export type RouteHandler = (
  request: Request,
  context?: RouteHandlerContext,
) => Promise<Response>;

/**
 * Callable ServerAction interface with route adaptation capabilities.
 */
export interface ServerAction<TInput, TOutput> {
  (
    ...args: [TInput] extends [void] ? [input?: void] : [input: TInput]
  ): Promise<Awaited<TOutput>>;
  toRouteHandler: () => RouteHandler;
  schema?: InputSchemaDef;
  metadata?: ServerActionMetadata;
}
