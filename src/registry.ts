import type {
  ClientActionReference,
  DeclaredErrors,
  HttpMethod,
  ServerAction,
} from "./types";

export type ResolveErrorReason =
  | "ACTION_NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_VERSION";

export interface ResolveError {
  status: number;
  reason: ResolveErrorReason;
  message: string;
}

export type ResolveResult<TInput = unknown, TOutput = unknown> =
  | { success: true; action: ServerAction<TInput, TOutput> }
  | { success: false; error: ResolveError };

export function normalizePath(path: string): string {
  let p = path.trim();
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  // Strip trailing slash unless root "/"
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Deterministic Superaction Registry.
 * Enforces single registration per (version, method, path),
 * detects duplicates, and resolves incoming HTTP requests.
 */
export class ActionRegistry {
  private readonly actions = new Map<string, ServerAction<any, any>>();
  private readonly paths = new Set<string>();
  private readonly pathMethods = new Map<string, Set<HttpMethod>>();
  private readonly pathVersions = new Map<string, Set<number>>();

  /**
   * Registers a single ServerAction deterministically.
   * Throws if an action is already registered with the same version, method, and path.
   */
  register<TInput, TOutput, TErrors extends DeclaredErrors>(
    action: ServerAction<TInput, TOutput, TErrors>,
  ): ServerAction<TInput, TOutput, TErrors> {
    if (!action.path) {
      throw new Error(
        `Cannot register action without an explicit 'path' metadata property.`,
      );
    }

    const version = action.version || 1;
    const method = (action.method || "POST").toUpperCase() as HttpMethod;
    const path = normalizePath(action.path);
    const key = `${version}:${method}:${path}`;

    if (this.actions.has(key)) {
      const existing = this.actions.get(key);
      if (existing === (action as ServerAction<any, any>)) {
        return action;
      }
      throw new Error(
        `Duplicate action registration detected: Version ${version}, Method ${method}, Path '${path}'.`,
      );
    }

    this.actions.set(key, action as ServerAction<any, any>);
    this.paths.add(path);

    if (!this.pathMethods.has(path)) {
      this.pathMethods.set(path, new Set());
    }
    this.pathMethods.get(path)!.add(method);

    if (!this.pathVersions.has(path)) {
      this.pathVersions.set(path, new Set());
    }
    this.pathVersions.get(path)!.add(version);

    return action;
  }

  /**
   * Registers multiple actions in batch.
   */
  registerAll(actions: readonly ServerAction<any, any>[]): void {
    for (const a of actions) {
      this.register(a);
    }
  }

  /**
   * Resolves a registered action by version, HTTP method, and path.
   */
  resolve(options: {
    version: number;
    method: string;
    path: string;
  }): ResolveResult {
    const version = options.version;
    const method = options.method.toUpperCase() as HttpMethod;
    const path = normalizePath(options.path);
    const key = `${version}:${method}:${path}`;

    const action = this.actions.get(key);
    if (action) {
      return { success: true, action };
    }

    // Path does not exist in any version or method
    if (!this.paths.has(path)) {
      return {
        success: false,
        error: {
          status: 404,
          reason: "ACTION_NOT_FOUND",
          message: `Action not found for path '${path}'.`,
        },
      };
    }

    // Path exists, check version
    const availableVersions = this.pathVersions.get(path);
    if (availableVersions && !availableVersions.has(version)) {
      return {
        success: false,
        error: {
          status: 400,
          reason: "UNSUPPORTED_VERSION",
          message: `Version 'v${version}' is not supported for action '${path}'. Available: ${Array.from(
            availableVersions,
          )
            .map((v) => `v${v}`)
            .join(", ")}.`,
        },
      };
    }

    // Path and version exist, but method does not match
    const availableMethods = this.pathMethods.get(path);
    return {
      success: false,
      error: {
        status: 405,
        reason: "METHOD_NOT_ALLOWED",
        message: `Method '${method}' is not allowed for '${path}'. Supported: ${
          availableMethods ? Array.from(availableMethods).join(", ") : "none"
        }.`,
      },
    };
  }

  /**
   * Returns all registered actions.
   */
  getAll(): readonly ServerAction<any, any>[] {
    return Array.from(this.actions.values());
  }

  /**
   * Generates serializable client action references for all registered actions.
   */
  getClientManifest(): ClientActionReference[] {
    return this.getAll().map((a) => a.toClientRef());
  }

  /**
   * Clears the registry (useful in test suites).
   */
  clear(): void {
    this.actions.clear();
    this.paths.clear();
    this.pathMethods.clear();
    this.pathVersions.clear();
  }
}

/**
 * Global singleton action registry.
 */
export const actionRegistry = new ActionRegistry();
