import { callClientAction, normalizeActionResponse } from "./execution";
import type { CallClientActionOptions } from "./execution";
import type {
  ActionResponse,
  ClientActionReference,
  HttpMethod,
  ServerAction,
} from "./types";

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
 * Invokes an action remotely via callClientAction and unwraps the result data,
 * throwing an Error if the action returned an error. Ideal for React Query / TanStack Query.
 */
export async function callClientActionOrThrow<TInput = unknown, TOutput = unknown>(
  actionRef:
    | ClientActionReference<TInput, TOutput>
    | ServerAction<TInput, TOutput, any>,
  input?: TInput,
  options?: CallClientActionOptions,
): Promise<Awaited<TOutput>> {
  const res = await callClientAction(actionRef, input, options);
  if (res.error) {
    throw new Error(res.error.message || "Action failed");
  }
  return res.data as Awaited<TOutput>;
}

export type InferClientActionInput<T> = T extends ClientActionReference<
  infer TIn,
  any
>
  ? TIn
  : T extends (input: infer TIn, ...args: any[]) => any
    ? TIn
    : unknown;

export type InferClientActionOutput<T> = T extends ClientActionReference<
  any,
  infer TOut
>
  ? TOut
  : T extends (...args: any[]) => Promise<infer TOut>
    ? TOut
    : unknown;

export {
  callClientAction,
  normalizeActionResponse,
  type CallClientActionOptions,
  type ActionResponse,
  type ClientActionReference,
  type HttpMethod,
};
