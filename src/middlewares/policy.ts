import type { TypedActionContext } from "../context";
import { forbidden } from "../errors";
import { createMiddleware } from "../middleware";
import type { Middleware } from "../types";

export type PolicyEvaluator<TCtx extends object, TInput = unknown> = (params: {
  ctx: TypedActionContext<TCtx>;
  input: TInput;
}) => boolean | Promise<boolean>;

/**
 * Middleware that evaluates a declarative authorization policy or business rule.
 */
export function policy<TCtx extends object = object, TInput = unknown>(
  evaluator: PolicyEvaluator<TCtx, TInput>,
  errorMessage = "You do not have permission to perform this action",
): Middleware<TCtx, object> {
  return createMiddleware<TCtx, object>(async ({ ctx, input, next }) => {
    const allowed = await evaluator({ ctx, input: input as TInput });
    if (!allowed) {
      throw forbidden(errorMessage);
    }
    return await next();
  });
}
