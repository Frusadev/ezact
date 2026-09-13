import { z } from "zod";
import {
  createBaseContext,
  type BaseContextOptions,
  type TypedActionContext,
} from "./context";
import { toAppError } from "./errors";
import { runPipeline } from "./middleware";
import { createRouteHandler, isPartitionedSchema } from "./route-adapter";
import type {
  ActionConfig,
  ActionHandler,
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
 * Internal factory to create a callable ServerAction.
 */
function createActionInternal<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
  TOutput = unknown,
>(
  config: ActionConfig<TInputSchema, TOutputSchema, TMiddlewares, TOutput>,
): ServerAction<
  TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
  TOutputSchema extends z.ZodTypeAny ? InferOutput<TOutputSchema> : Awaited<TOutput>
> {
  type TActionInput = TInputSchema extends InputSchemaDef
    ? InferInput<TInputSchema>
    : void;
  type TActionOutput = TOutputSchema extends z.ZodTypeAny
    ? InferOutput<TOutputSchema>
    : Awaited<TOutput>;

  const effectiveSchema = config.input || config.schema;

  const fn = async function (
    rawInput?: unknown,
    internalOptions?: BaseContextOptions,
  ): Promise<TActionOutput> {
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

    // 2. Middleware & Handler execution
    let result: unknown;
    try {
      result = await runPipeline(
        ctx,
        parsedInput,
        (config.middleware || []) as readonly Middleware<object, object>[],
        async ({ input, ctx: currentCtx }) => {
          return await config.handler({
            input: input as (TInputSchema extends InputSchemaDef
              ? InferHandlerInput<TInputSchema>
              : void),
            ctx: currentCtx as TypedActionContext<PipelineContext<TMiddlewares>>,
          });
        },
      );
    } catch (err: unknown) {
      throw toAppError(err);
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

  const actionFn = fn as unknown as ServerAction<TActionInput, TActionOutput>;
  actionFn.schema = effectiveSchema;
  actionFn.metadata = config.metadata;
  actionFn.toRouteHandler = () =>
    createRouteHandler(actionFn as ServerAction<unknown, unknown>, effectiveSchema);

  return actionFn;
}

/**
 * Fluent builder class for progressively chaining schemas, middlewares, and handlers.
 */
export class ActionBuilder<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  TMiddlewares extends readonly unknown[] = readonly [],
> {
  private readonly _inputSchema?: TInputSchema;
  private readonly _outputSchema?: TOutputSchema;
  private readonly _middlewares: TMiddlewares;
  private readonly _metadata?: ServerActionMetadata;

  constructor(options?: {
    input?: TInputSchema;
    output?: TOutputSchema;
    middlewares?: TMiddlewares;
    metadata?: ServerActionMetadata;
  }) {
    this._inputSchema = options?.input;
    this._outputSchema = options?.output;
    this._middlewares = (options?.middlewares || []) as unknown as TMiddlewares;
    this._metadata = options?.metadata;
  }

  /**
   * Sets action metadata.
   */
  metadata(meta: ServerActionMetadata): ActionBuilder<TInputSchema, TOutputSchema, TMiddlewares> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: { ...this._metadata, ...meta },
    });
  }

  /**
   * Sets input schema validation.
   */
  input<TNewInputSchema extends InputSchemaDef>(
    schema: TNewInputSchema,
  ): ActionBuilder<TNewInputSchema, TOutputSchema, TMiddlewares> {
    return new ActionBuilder({
      input: schema,
      output: this._outputSchema,
      middlewares: this._middlewares,
      metadata: this._metadata,
    });
  }

  /**
   * Sets output schema validation.
   */
  output<TNewOutputSchema extends z.ZodTypeAny>(
    schema: TNewOutputSchema,
  ): ActionBuilder<TInputSchema, TNewOutputSchema, TMiddlewares> {
    return new ActionBuilder({
      input: this._inputSchema,
      output: schema,
      middlewares: this._middlewares,
      metadata: this._metadata,
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
    readonly [...TMiddlewares, TMw]
  > {
    return new ActionBuilder({
      input: this._inputSchema,
      output: this._outputSchema,
      middlewares: [...this._middlewares, middleware] as const,
      metadata: this._metadata,
    });
  }

  /**
   * Attaches the core handler function and returns a callable ServerAction.
   */
  handler<TOutput>(
    fn: ActionHandler<
      TInputSchema extends InputSchemaDef ? InferHandlerInput<TInputSchema> : void,
      PipelineContext<TMiddlewares>,
      TOutput
    >,
  ): ServerAction<
    TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
    TOutputSchema extends z.ZodTypeAny ? InferOutput<TOutputSchema> : Awaited<TOutput>
  > {
    return createActionInternal<TInputSchema, TOutputSchema, TMiddlewares, TOutput>({
      input: this._inputSchema,
      output: this._outputSchema,
      metadata: this._metadata,
      middleware: this._middlewares,
      handler: fn,
    });
  }
}

/**
 * Starts a fluent ActionBuilder chain: action().input(...).use(...).handler(...)
 */
export function action(): ActionBuilder<undefined, undefined, readonly []>;

/**
 * Creates a ServerAction using object configuration syntax.
 */
export function action<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  const TMiddlewares extends readonly unknown[] = readonly [],
  TOutput = unknown,
>(
  config: ActionConfig<TInputSchema, TOutputSchema, TMiddlewares, TOutput>,
): ServerAction<
  TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
  TOutputSchema extends z.ZodTypeAny ? InferOutput<TOutputSchema> : Awaited<TOutput>
>;

/**
 * Main action entry point supporting both declarative configuration and fluent chaining.
 */
export function action<
  TInputSchema extends InputSchemaDef | undefined = undefined,
  TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  const TMiddlewares extends readonly unknown[] = readonly [],
  TOutput = unknown,
>(
  config?: ActionConfig<TInputSchema, TOutputSchema, TMiddlewares, TOutput>,
):
  | ServerAction<
      TInputSchema extends InputSchemaDef ? InferInput<TInputSchema> : void,
      TOutputSchema extends z.ZodTypeAny ? InferOutput<TOutputSchema> : Awaited<TOutput>
    >
  | ActionBuilder<undefined, undefined, readonly []> {
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
  metadata?: ServerActionMetadata;
}) {
  const baseMiddlewares = (options?.middleware || []) as unknown as TBaseMiddlewares;

  return {
    use<
      TCtxIn extends object,
      TCtxOut extends object,
      TMw extends Middleware<TCtxIn, TCtxOut>,
    >(middleware: TMw) {
      return new ActionBuilder<undefined, undefined, readonly [...TBaseMiddlewares, TMw]>({
        middlewares: [...baseMiddlewares, middleware] as const,
        metadata: options?.metadata,
      });
    },
    input<TNewInputSchema extends InputSchemaDef>(schema: TNewInputSchema) {
      return new ActionBuilder<TNewInputSchema, undefined, TBaseMiddlewares>({
        input: schema,
        middlewares: baseMiddlewares,
        metadata: options?.metadata,
      });
    },
    action<
      TInputSchema extends InputSchemaDef | undefined = undefined,
      TOutputSchema extends z.ZodTypeAny | undefined = undefined,
      const TMiddlewares extends readonly unknown[] = readonly [],
      TOutput = unknown,
    >(
      config: ActionConfig<
        TInputSchema,
        TOutputSchema,
        readonly [...TBaseMiddlewares, ...TMiddlewares],
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
