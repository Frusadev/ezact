export {
  action,
  createActionClient,
  ActionBuilder,
} from "./action";

export {
  ActionContext,
  createBaseContext,
  type TypedActionContext,
  type BaseContextOptions,
} from "./context";

export {
  createMiddleware,
  runPipeline,
} from "./middleware";

export {
  createRouteHandler,
  isPartitionedSchema,
  parseSearchParams,
} from "./route-adapter";

export {
  AppError,
  ValidationError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  rateLimitExceeded,
  internalServerError,
  validationError,
  toAppError,
  type SerializedAppError,
} from "./errors";

export type {
  ActionConfig,
  ActionHandler,
  InferHandlerInput,
  InferInput,
  InferOutput,
  InferPartitionedHandlerInput,
  InferPartitionedInput,
  InputSchemaDef,
  Middleware,
  MiddlewareNext,
  PartitionedInputSchema,
  PipelineContext,
  RouteHandler,
  RouteHandlerContext,
  ServerAction,
  ServerActionMetadata,
  UnionToIntersection,
} from "./types";

export * from "./middlewares";
