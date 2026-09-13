import { z } from "zod";

/**
 * Standard serialized JSON format for application errors.
 */
export interface SerializedAppError {
  success: false;
  error: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
  };
}

/**
 * Base application error for type-safe actions and route handlers.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    message: string,
    code = "INTERNAL_SERVER_ERROR",
    status = 500,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedAppError {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, "VALIDATION_ERROR", 400, details);
    this.name = "ValidationError";
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(message, "BAD_REQUEST", 400, details);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: unknown) {
    super(message, "UNAUTHORIZED", 401, details);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: unknown) {
    super(message, "FORBIDDEN", 403, details);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource", details?: unknown) {
    super(
      resource.includes(" ") ? resource : `${resource} not found`,
      "NOT_FOUND",
      404,
      details,
    );
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(message, "CONFLICT", 409, details);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", details?: unknown) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, details);
    this.name = "RateLimitError";
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", details?: unknown) {
    super(message, "INTERNAL_SERVER_ERROR", 500, details);
    this.name = "InternalServerError";
  }
}

// Convenient factory helpers

export function badRequest(message?: string, details?: unknown): BadRequestError {
  return new BadRequestError(message, details);
}

export function unauthorized(
  message?: string,
  details?: unknown,
): UnauthorizedError {
  return new UnauthorizedError(message, details);
}

export function forbidden(message?: string, details?: unknown): ForbiddenError {
  return new ForbiddenError(message, details);
}

export function notFound(resource?: string, details?: unknown): NotFoundError {
  return new NotFoundError(resource, details);
}

export function conflict(message?: string, details?: unknown): ConflictError {
  return new ConflictError(message, details);
}

export function rateLimitExceeded(
  message?: string,
  details?: unknown,
): RateLimitError {
  return new RateLimitError(message, details);
}

export function internalServerError(
  message?: string,
  details?: unknown,
): InternalServerError {
  return new InternalServerError(message, details);
}

export function validationError(
  message?: string,
  details?: unknown,
): ValidationError {
  return new ValidationError(message, details);
}

/**
 * Normalizes any caught error into a standardized AppError.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof z.ZodError) {
    return new ValidationError("Invalid input parameters", err.flatten());
  }

  if (err instanceof Error) {
    const message = err.message || "An unexpected error occurred";

    // Infer status code from standard error message conventions
    if (
      message.toLowerCase().includes("unauthorized") ||
      message.toLowerCase().includes("not authenticated")
    ) {
      return new UnauthorizedError(message);
    }
    if (
      message.toLowerCase().includes("forbidden") ||
      message.toLowerCase().includes("permission denied")
    ) {
      return new ForbiddenError(message);
    }
    if (
      message.toLowerCase().includes("not found") ||
      message === "NOT_FOUND"
    ) {
      return new NotFoundError(message);
    }
    if (
      message.toLowerCase().includes("conflict") ||
      message.toLowerCase().includes("already exists")
    ) {
      return new ConflictError(message);
    }
    if (
      message.toLowerCase().includes("too many requests") ||
      message.toLowerCase().includes("rate limit")
    ) {
      return new RateLimitError(message);
    }

    return new AppError(message, "INTERNAL_SERVER_ERROR", 500);
  }

  return new AppError(String(err), "INTERNAL_SERVER_ERROR", 500);
}
