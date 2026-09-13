import { ActionContext, type TypedActionContext } from "./context";
import type { Middleware } from "./types";

/**
 * Creates a strongly typed middleware function with explicit input and output context constraints.
 */
export function createMiddleware<
  TCtxIn extends object = object,
  TCtxOut extends object = object,
>(
  fn: (params: {
    ctx: TypedActionContext<TCtxIn>;
    input: unknown;
    next: (args?: {
      ctx?: TypedActionContext<TCtxOut>;
      input?: unknown;
    }) => Promise<unknown>;
  }) => Promise<unknown>,
): Middleware<TCtxIn, TCtxOut> {
  return fn as Middleware<TCtxIn, TCtxOut>;
}

/**
 * Executes an onion-model pipeline of middlewares, culminating in the action handler.
 */
export async function runPipeline(
  initialCtx: TypedActionContext<object>,
  initialInput: unknown,
  middlewares: readonly Middleware<object, object>[],
  handler: (params: {
    ctx: TypedActionContext<object>;
    input: unknown;
  }) => Promise<unknown>,
): Promise<unknown> {
  let index = -1;

  async function dispatch(
    step: number,
    currentCtx: TypedActionContext<object>,
    currentInput: unknown,
  ): Promise<unknown> {
    if (step <= index) {
      throw new Error("next() called multiple times within a single middleware");
    }
    index = step;

    if (step === middlewares.length) {
      return await handler({ ctx: currentCtx, input: currentInput });
    }

    const middleware = middlewares[step];
    let nextCalled = false;

    const res = await middleware({
      ctx: currentCtx,
      input: currentInput,
      next: async (args) => {
        nextCalled = true;
        const nextCtx = args?.ctx ?? currentCtx;
        const nextInput = args?.input !== undefined ? args.input : currentInput;
        return await dispatch(step + 1, nextCtx, nextInput);
      },
    });

    // If next() was not called directly:
    // 1. If an ActionContext was returned, advance to next middleware with that context
    // 2. If undefined was returned, advance with current context
    // 3. Otherwise, it is an intentional early short-circuit return (e.g. cached response)
    if (!nextCalled) {
      if (res instanceof ActionContext) {
        return await dispatch(step + 1, res as TypedActionContext<object>, currentInput);
      }
      if (res === undefined) {
        return await dispatch(step + 1, currentCtx, currentInput);
      }
      return res;
    }

    return res;
  }

  return await dispatch(0, initialCtx, initialInput);
}
