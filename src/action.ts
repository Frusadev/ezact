import type { z } from "zod";
import {
  type BaseContextOptions,
  createBaseContext,
  type TypedActionContext,
} from "./context";
import { AppError, toAppError } from "./errors";
import { runPipeline } from "./middleware";
import {
  defaultActionErrorHandler,
  handleActionError,
  isProduction,
  isSafeAppError,
} from "./middlewares/error-handler";

import { createRouteHandler, isPartitionedSchema } from "./route-adapter";
import type {
  ActionConfig,
  ActionErrorContext,
  ActionErrorHandler,
  ActionHandler,
  ClientActionReference,
  DeclaredErrors,
  ErrorHandlingConfig,
  HttpMethod,
  InferHandlerInput,
  InferInput,
  InferOutput,
  InferPartitionedHandlerInput,
  InputSchemaDef,
  Middleware,
  PartitionedInputSchema,
  PipelineContext,
  ServerAction,
  ServerActionMetadata,
} from "./types";


/**
 * Validates partitioned schemas against their respective input slices with strict typing.
 */
function validatePartitionedInput<TSchema extends PartitionedInputSchema>(
  schema: TSchema,
  rawInput: unknown,
): InferPartitionedHandlerInput<TSchema> {
  const rawObj =
    rawInput && typeof rawInput === "object"
      ? (rawInput as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = {};

  if (schema.params) {
    try {
      result.params = schema.params.parse(rawObj.params ?? {});
    } catch (err: unknown) {
      throw toAppError(err);
    }
  }

  if (schema.query) {
    try {
      result.query = schema.query.parse(rawObj.query ?? {});
    } catch (err: unknown) {
      throw toAppError(err);
    }
  }

  if (schema.body) {
    try {
      result.body = schema.body.parse(rawObj.body ?? {});
    } catch (err: unknown) {
      throw toAppError(err);
    }
  }

  if (schema.headers) {
    try {
      result.headers = schema.headers.parse(rawObj.headers ?? {});
    } catch (err: unknown) {
      throw toAppError(err);
    }
  }

  if (schema.formData) {
    try {
      result.formData = schema.formData.parse(rawObj.formData);
    } catch (err: unknown) {
      throw toAppError(err);
    }
  }

  return result as InferPartitionedHandlerInput<TSchema>;
}

/**
 * Creates a client-safe serializable action reference containing
 * only remote invocation metadata and inferred TypeScript types.
 */
export function createClientActionReference<TInput, TOutput>(metadata: {
  id?: string;
  path: string;
  method?: HttpMethod;
  version?: number;
  success?: string;
}): ClientActionReference<TInput, TOutput>;
export function createClientActionReference<TAction = unknown>(metadata: {
  id?: string;
  path: string;
  method?: HttpMethod;
  version?: number;
  success?: string;
}): ClientActionReference<
  TAction extends ServerAction<infer TIn, infer _TOut> ? TIn : unknown,
  TAction extends ServerAction<infer _TIn, infer TOut> ? TOut : unknown
>;
export function createClientActionReference(metadata: {
  id?: string;
  path: string;
  method?: HttpMethod;
  version?: number;
  success?: string;
}): ClientActionReference<any, any> {
  const method = (metadata.method || "POST").toUpperCase() as HttpMethod;
  const version = metadata.version || 1;
  const id = metadata.id || `${version}:${method}:${metadata.path}`;

  return {
    id,
    path: metadata.path,
    method,
    version,
    defaultSuccess: metadata.success,
  };
}

/**
 * Internal factory to create a callable ServerAction.
 */
function createActionInternal<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
  TErrors extends DeclaredErrors = DeclaredErrors,
  TOutput = unknown,
>(
  config: ActionConfig<
    TInputSchema,
    TOutputSchema,
    TMiddlewares,
    TErrors,
    TOutput
  >,
): ServerAction<
  TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
  TOutputSchema extends z.ZodTypeAny
    ? InferOutput<TOutputSchema>
    : Awaited<TOutput>,
  TErrors
> {
  type TActionInput = TInputSchema extends InputSchemaDef
    ? InferInput<TInputSchema>
    : void;
  type TActionOutput = TOutputSchema extends z.ZodTypeAny
    ? InferOutput<TOutputSchema>
    : Awaited<TOutput>;

  const effectiveSchema = config.input || config.schema;
  const method = (config.method || "POST").toUpperCase() as HttpMethod;
  const version = config.version || 1;
  const id =
    config.id ||
    (config.path ? `${version}:${method}:${config.path}` : undefined);
  const errors = (config.errors || {}) as TErrors;
  const middlewares = (config.middleware || []) as readonly Middleware<
    object,
    object
  >[];

  const fn = async (
    rawInput?: unknown,
    internalOptions?: BaseContextOptions,
  ): Promise<TActionOutput> => {
    const ctx = createBaseContext(internalOptions || {});

    // 1. Input validation
    let parsedInput: unknown = rawInput;

    if (effectiveSchema) {
      if (isPartitionedSchema(effectiveSchema)) {
        parsedInput = validatePartitionedInput(effectiveSchema, rawInput);
      } else {
        try {
          parsedInput = effectiveSchema.parse(rawInput);
        } catch (err: unknown) {
          throw toAppError(err);
        }
      }
    }

    // 2. Middleware & Handler execution — wrapped by the built-in global error handler.
    let result: unknown;
    try {
      result = await runPipeline(
        ctx,
        parsedInput,
        middlewares,
        async ({ input, ctx: currentCtx }) => {
          const handlerFn = config.handler;
          if (typeof handlerFn === "function" && handlerFn.length >= 2) {
            return await (handlerFn as any)(
              input,
              currentCtx as TypedActionContext<PipelineContext<TMiddlewares>>,
            );
          }
          return await (handlerFn as any)({
            input: input as TInputSchema extends InputSchemaDef
              ? InferHandlerInput<TInputSchema>
              : void,
            ctx: currentCtx as TypedActionContext<
              PipelineContext<TMiddlewares>
            >,
          });
        },
      );
    } catch (err: unknown) {
      // Build a structured context snapshot for the error handler.
      const errorCtx: ActionErrorContext = {
        actionName: config.path ?? id,
        requestId: ctx.requestId,
        userId: (ctx.getOptional?.("user") as any)?.id as string | undefined,
        organizationId: (ctx.getOptional?.("organization") as any)?.id as
          | string
          | undefined,
        declaredErrors: errors,
      };

      if (config.errorHandler) {
        try {
          await config.errorHandler(err, errorCtx);
        } catch (customErr) {
          // Action-specific customization cannot accidentally expose internal errors in production.
          if (isProduction() && !isSafeAppError(customErr)) {
            throw new AppError(
              "Something went wrong. Please try again.",
              "INTERNAL_ERROR",
              500,
            );
          }

          throw customErr;
        }
      }

      await handleActionError(err, errorCtx, config.errorHandling);
      throw err;
    }

    // 3. Output validation
    if (config.output) {
      try {
        result = config.output.parse(result);
      } catch (err: unknown) {
        throw toAppError(err);
      }
    }

    return result as TActionOutput;
  };



  const metadata: ServerActionMetadata<TActionInput, TActionOutput, TErrors> = {
    isServerAction: true,
    id,
    path: config.path,
    method,
    version,
    errors,
    success: config.success,
    schema: effectiveSchema,
    input: effectiveSchema,
    output: config.output,
    middlewares,
    handler: config.handler,
    toRouteHandler: () =>
      createRouteHandler(
        actionWithMetadata as ServerAction<unknown, unknown>,
        effectiveSchema,
      ),
    toClientRef: () => ({
      id: id || `${version}:${method}:${config.path || ""}`,
      path: config.path || "",
      method,
      version,
      defaultSuccess: config.success,
    }),
  };

  const actionWithMetadata = Object.assign(fn, metadata) as ServerAction<
    TActionInput,
    TActionOutput,
    TErrors
  >;

  return actionWithMetadata;
}

/**
 * Fluent builder class for progressively chaining schemas, middlewares, and handlers.
 */
export class ActionBuilder<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
  TErrors extends DeclaredErrors = DeclaredErrors,
> {
  private readonly _inputSchema?: TInputSchema;
  private readonly _outputSchema?: TOutputSchema;
  private readonly _middlewares: TMiddlewares;
  private readonly _metadata?: Record<string, unknown>;
  private readonly _path?: string;
  private readonly _method?: HttpMethod;
  private readonly _version?: number;
  private readonly _errors?: TErrors;
  private readonly _success?: string;
  private readonly _id?: string;
  private readonly _errorHandling?: ErrorHandlingConfig;
  private readonly _errorHandler?: ActionErrorHandler;

  constructor(options?: {
    input?: TInputSchema;
    output?: TOutputSchema;
    middlewares?: TMiddlewares;
    metadata?: Record<string, unknown>;
    path?: string;
    method?: HttpMethod;
    version?: number;
    errors?: TErrors;
    success?: string;
    id?: string;
    errorHandling?: ErrorHandlingConfig;
    errorHandler?: ActionErrorHandler;
  }) {
    this._inputSchema = options?.input;
    this._outputSchema = options?.output;
    this._middlewares = (options?.middlewares || []) as unknown as TMiddlewares;
    this._metadata = options?.metadata;
    this._path = options?.path;
    this._method = options?.method;
    this._version = options?.version;
    this._errors = options?.errors;
    this._success = options?.success;
    this._id = options?.id;
    this._errorHandling = options?.errorHandling;
    this._errorHandler = options?.errorHandler;
  }

  /**
   * Sets action metadata.
   */
  metadata(
    meta: Record<string, unknown>,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: { ...this._metadata, ...meta },
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }



  path(
    path: string,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  method(
    method: HttpMethod,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  version(
    version: number,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  errors<TNewErrors extends DeclaredErrors>(
    errors: TNewErrors,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TNewErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  success(
    message: string,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: message,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  /**
   * Sets input schema validation.
   */
  input<TNewInputSchema extends InputSchemaDef>(
    schema: TNewInputSchema,
  ): ActionBuilder<TNewInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: schema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  /**
   * Sets output schema validation.
   */
  output<TNewOutputSchema extends z.ZodTypeAny>(
    schema: TNewOutputSchema,
  ): ActionBuilder<TInputSchema, TNewOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: schema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  /**
   * Adds a middleware to the pipeline, progressively enriching context.
   */
  use<
    TCtxIn extends object,
    TCtxOut extends object,
    TMw extends Middleware<TCtxIn, TCtxOut>,
  >(
    middleware: TMw,
  ): ActionBuilder<
    TInputSchema,
    TOutputSchema,
    readonly [...TMiddlewares, TMw],
    TErrors
  > {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: [...this._middlewares, middleware] as const,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
    });
  }

  /**
   * Configures action-level error handling options (e.g. formatError mapping, onError telemetry).
   */
  errorHandling(
    config: ErrorHandlingConfig,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: config,
      errorHandler: this._errorHandler,
    });
  }

  /**
   * Registers a per-action error handler that replaces the default global error handler.
   *
   * The function **must always throw** (enforced by `never` return type).
   * Only `AppError` subclasses should be thrown back to the client.
   * All other errors must be sanitized before throwing.
   */
  onError(
    fn: ActionErrorHandler,
  ): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares, TErrors> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: fn,
    });
  }

  /**
   * Attaches the core handler function and returns a callable ServerAction.
   */
  handler<TOutput>(
    fn: ActionHandler<
      TInputSchema extends InputSchemaDef
        ? InferHandlerInput<TInputSchema>
        : void,
      PipelineContext<TMiddlewares>,
      TOutput
    >,
  ): ServerAction<
    TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
    TOutputSchema extends z.ZodTypeAny
      ? InferOutput<TOutputSchema>
      : Awaited<TOutput>,
    TErrors
  > {
    return createActionInternal<
      TInputSchema,
      TOutputSchema,
      TMiddlewares,
      TErrors,
      TOutput
    >({
      input: this._inputSchema,
      output: this._outputSchema,
      metadata: this._metadata,
      middleware: this._middlewares,
      path: this._path,
      method: this._method,
      version: this._version,
      errors: this._errors,
      success: this._success,
      id: this._id,
      errorHandling: this._errorHandling,
      errorHandler: this._errorHandler,
      handler: fn as any,
    });
  }
}


/**
 * Starts a fluent ActionBuilder chain: action().input(...).use(...).handler(...)
 */
export function action(): ActionBuilder<undefined, undefined, readonly [], {}>;

/**
 * Creates a ServerAction using object configuration syntax.
 */
export function action<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  const TMiddlewares extends readonly unknown[] = readonly [],
  TErrors extends DeclaredErrors = DeclaredErrors,
  TOutput = unknown,
>(
  config: ActionConfig<
    TInputSchema,
    TOutputSchema,
    TMiddlewares,
    TErrors,
    TOutput
  >,
): ServerAction<
  TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
  TOutputSchema extends z.ZodTypeAny
    ? InferOutput<TOutputSchema>
    : Awaited<TOutput>,
  TErrors
>;

/**
 * Main action entry point supporting both declarative configuration and fluent chaining.
 */
export function action<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  const TMiddlewares extends readonly unknown[] = readonly [],
  TErrors extends DeclaredErrors = DeclaredErrors,
  TOutput = unknown,
>(
  config?: ActionConfig<
    TInputSchema,
    TOutputSchema,
    TMiddlewares,
    TErrors,
    TOutput
  >,
):
  | ServerAction<
      TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
      TOutputSchema extends z.ZodTypeAny
        ? InferOutput<TOutputSchema>
        : Awaited<TOutput>,
      TErrors
    >
  | ActionBuilder<undefined, undefined, readonly [], {}> {
  if (config) {
    return createActionInternal(config);
  }
  return new ActionBuilder();
}

/**
 * Semantic alias for `action(...)`.
 */
export const createServerAction = action;

/**
 * Client factory to configure project-wide default middlewares and base actions.
 */
export function createActionClient<
  const TBaseMiddlewares extends readonly unknown[] = readonly [],
>(options?: {
  middleware?: TBaseMiddlewares;
  metadata?: Record<string, unknown>;
}) {
  const baseMiddlewares = (options?.middleware ||
    []) as unknown as TBaseMiddlewares;

  return {
    use<
      TCtxIn extends object,
      TCtxOut extends object,
      TMw extends Middleware<TCtxIn, TCtxOut>,
    >(middleware: TMw) {
      return new ActionBuilder<
        undefined,
        undefined,
        readonly [...TBaseMiddlewares, TMw],
        {}
      >({
        middlewares: [...baseMiddlewares, middleware] as const,
        metadata: options?.metadata,
      });
    },
    input<TNewInputSchema extends InputSchemaDef>(schema: TNewInputSchema) {
      return new ActionBuilder<
        TNewInputSchema,
        undefined,
        TBaseMiddlewares,
        {}
      >({
        input: schema,
        middlewares: baseMiddlewares,
        metadata: options?.metadata,
      });
    },
    action<
      TInputSchema extends InputSchemaDef | undefined = undefined,
      TOutputSchema extends z.ZodTypeAny | undefined = undefined,
      const TMiddlewares extends readonly unknown[] = readonly [],
      TErrors extends DeclaredErrors = DeclaredErrors,
      TOutput = unknown,
    >(
      config: ActionConfig<
        TInputSchema,
        TOutputSchema,
        readonly [...TBaseMiddlewares, ...TMiddlewares],
        TErrors,
        TOutput
      >,
    ) {
      const mergedMiddleware = [
        ...baseMiddlewares,
        ...(config.middleware || []),
      ] as unknown as readonly [...TBaseMiddlewares, ...TMiddlewares];

      return createActionInternal({
        ...config,
        middleware: mergedMiddleware,
      });
    },
  };
}
