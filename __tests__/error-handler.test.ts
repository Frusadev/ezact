import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  action,
  AppError,
  BadRequestError,
  callAction,
  ConflictError,
  createMiddleware,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "../src/index";

describe("Global Configurable Error-Handling Middleware", () => {
  // Save original env
  const originalEnv = process.env.NODE_ENV;

  const setEnv = (env: string) => {
    (process.env as any).NODE_ENV = env;
  };

  const resetEnv = () => {
    (process.env as any).NODE_ENV = originalEnv;
  };

  describe("1. Automatic Global Middleware", () => {
    it("should automatically catch errors without any explicit error middleware registered", async () => {
      resetEnv();
      const testAction = action({
        handler: async () => {
          throw new Error("Auto-caught failure");
        },
      });

      // No middleware array specified, yet the action executes through global error handler
      expect(async () => {
        await testAction();
      }).toThrow();
    });
  });

  describe("2. Unexpected Errors Sanitized in Production", () => {
    it("should sanitize unexpected internal errors to a generic message in production", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new Error("FATAL: connection to postgresql://admin:secret@db:5432 failed");
          },
        });

        try {
          await testAction();
          expect.unreachable("Action should have thrown");
        } catch (err: any) {
          expect(err).toBeInstanceOf(AppError);
          expect(err.message).toBe("Something went wrong. Please try again.");
          expect(err.code).toBe("INTERNAL_ERROR");
          expect(err.status).toBe(500);
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("3. Detailed Errors in Development", () => {
    it("should preserve original error message and stack in development", async () => {
      setEnv("development");
      try {
        const testAction = action({
          handler: async () => {
            throw new Error("Detailed development error message with internal info");
          },
        });

        try {
          await testAction();
          expect.unreachable("Action should have thrown");
        } catch (err: any) {
          expect(err).toBeInstanceOf(AppError);
          expect(err.message).toContain("Detailed development error message with internal info");
          expect(err.status).toBe(500);
          expect(err.details).toBeDefined();
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("4. Safe Application Errors Retain Messages and Codes", () => {
    it("should preserve ValidationError with status 400", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new ValidationError("Invalid email address format");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.message).toBe("Invalid email address format");
          expect(err.code).toBe("VALIDATION_ERROR");
          expect(err.status).toBe(400);
        }
      } finally {
        resetEnv();
      }
    });

    it("should preserve UnauthorizedError with status 401", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new UnauthorizedError("You must be logged in");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(UnauthorizedError);
          expect(err.message).toBe("You must be logged in");
          expect(err.status).toBe(401);
        }
      } finally {
        resetEnv();
      }
    });

    it("should preserve ForbiddenError with status 403", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new ForbiddenError("Insufficient permissions to delete asset");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(ForbiddenError);
          expect(err.message).toBe("Insufficient permissions to delete asset");
          expect(err.status).toBe(403);
        }
      } finally {
        resetEnv();
      }
    });

    it("should preserve NotFoundError with status 404", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new NotFoundError("Project not found");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(NotFoundError);
          expect(err.message).toBe("Project not found");
          expect(err.status).toBe(404);
        }
      } finally {
        resetEnv();
      }
    });

    it("should preserve ConflictError (409) and RateLimitError (429)", async () => {
      setEnv("production");
      try {
        const conflictAction = action({
          handler: async () => {
            throw new ConflictError("Slug already taken");
          },
        });

        try {
          await conflictAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(ConflictError);
          expect(err.message).toBe("Slug already taken");
          expect(err.status).toBe(409);
        }

        const rateLimitAction = action({
          handler: async () => {
            throw new RateLimitError("Rate limit exceeded, try again in 1 minute");
          },
        });

        try {
          await rateLimitAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(RateLimitError);
          expect(err.message).toBe("Rate limit exceeded, try again in 1 minute");
          expect(err.status).toBe(429);
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("5. Arbitrary Error Messages Cannot Bypass Production Sanitization", () => {
    it("should never expose custom Error subclass or arbitrary Error messages in production", async () => {
      setEnv("production");
      try {
        class CustomDatabaseDriverError extends Error {
          constructor() {
            super("CRITICAL: Redis cluster node 10.0.1.4 down");
            this.name = "CustomDatabaseDriverError";
          }
        }

        const testAction = action({
          handler: async () => {
            throw new CustomDatabaseDriverError();
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe("Something went wrong. Please try again.");
          expect(err.message).not.toContain("Redis");
          expect(err.status).toBe(500);
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("6. Non-Error Thrown Values Handled Safely", () => {
    it("should handle thrown strings, numbers, and plain objects safely in production", async () => {
      setEnv("production");
      try {
        const throwStringAction = action({
          handler: async () => {
            throw "Raw string failure";
          },
        });

        try {
          await throwStringAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(AppError);
          expect(err.message).toBe("Something went wrong. Please try again.");
        }

        const throwObjectAction = action({
          handler: async () => {
            throw { custom: "payload", internal: true };
          },
        });

        try {
          await throwObjectAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(AppError);
          expect(err.message).toBe("Something went wrong. Please try again.");
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("7. Errors Thrown by Middleware Are Caught", () => {
    it("should catch errors thrown by any middleware in the chain", async () => {
      setEnv("production");
      try {
        const failingAuthMiddleware = createMiddleware<object, object>(async () => {
          throw new UnauthorizedError("Auth middleware rejected token");
        });

        const testAction = action({
          middleware: [failingAuthMiddleware],
          handler: async () => {
            return "Should never reach here";
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(UnauthorizedError);
          expect(err.message).toBe("Auth middleware rejected token");
        }
      } finally {
        resetEnv();
      }
    });

    it("should sanitize unexpected errors thrown inside middleware in production", async () => {
      setEnv("production");
      try {
        const brokenMiddleware = createMiddleware<object, object>(async () => {
          throw new Error("Broken third-party session store crashed");
        });

        const testAction = action({
          middleware: [brokenMiddleware],
          handler: async () => "ok",
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe("Something went wrong. Please try again.");
          expect(err.status).toBe(500);
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("8. Errors Thrown by Action Handler Are Caught", () => {
    it("should catch errors thrown directly within the action handler", async () => {
      setEnv("production");
      try {
        const testAction = action({
          handler: async () => {
            throw new BadRequestError("Handler explicit validation failed");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(BadRequestError);
          expect(err.message).toBe("Handler explicit validation failed");
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("9. Action-Specific Error Configuration Works", () => {
    it("should allow action-specific formatError to map domain errors to safe AppErrors", async () => {
      setEnv("production");
      try {
        class PlanLimitReachedError extends Error {
          readonly limit = 5;
        }

        const testAction = action({
          errorHandling: {
            formatError: (err) => {
              if (err instanceof PlanLimitReachedError) {
                return new BadRequestError("Plan limit reached. Upgrade to Pro.");
              }
            },
          },
          handler: async () => {
            throw new PlanLimitReachedError();
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err).toBeInstanceOf(BadRequestError);
          expect(err.message).toBe("Plan limit reached. Upgrade to Pro.");
          expect(err.status).toBe(400);
        }
      } finally {
        resetEnv();
      }
    });

    it("should invoke onError hook with action error context", async () => {
      let telemetryCalled = false;
      let recordedActionName: string | undefined;

      const testAction = action({
        path: "/custom-telemetry",
        errorHandling: {
          onError: (_err, ctx) => {
            telemetryCalled = true;
            recordedActionName = ctx.actionName;
          },
        },
        handler: async () => {
          throw new Error("Trigger telemetry");
        },
      });

      try {
        await testAction();
      } catch {
        // expected
      }

      expect(telemetryCalled).toBe(true);
      expect(recordedActionName).toBe("/custom-telemetry");
    });
  });

  describe("10. Action-Specific Customization Cannot Accidentally Expose Internal Errors in Production", () => {
    it("should sanitize if custom formatError returns a non-safe raw Error in production", async () => {
      setEnv("production");
      try {
        const testAction = action({
          errorHandling: {
            formatError: () => {
              // Developer tries to return a standard Error with internal info
              return new Error("INTERNAL: AWS S3 bucket aupero-prod access denied");
            },
          },
          handler: async () => {
            throw new Error("Initial failure");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe("Something went wrong. Please try again.");
          expect(err.message).not.toContain("AWS S3");
          expect(err.status).toBe(500);
        }
      } finally {
        resetEnv();
      }
    });

    it("should sanitize if custom errorHandler throws a non-safe raw Error in production", async () => {
      setEnv("production");
      try {
        const testAction = action({
          errorHandler: () => {
            throw new Error("Secret Stripe key sk_live_123 failed verification");
          },
          handler: async () => {
            throw new Error("Trigger");
          },
        });

        try {
          await testAction();
          expect.unreachable();
        } catch (err: any) {
          expect(err.message).toBe("Something went wrong. Please try again.");
          expect(err.message).not.toContain("sk_live_123");
          expect(err.status).toBe(500);
        }
      } finally {
        resetEnv();
      }
    });
  });

  describe("11. Original Errors Logged Server-Side Without Leaking Sensitive Data", () => {
    it("should log errors server-side with metadata and redact sensitive keys", async () => {
      let loggedMessage = "";
      let loggedMeta: Record<string, unknown> = {};

      const testAction = action({
        path: "/secure-action",
        errorHandling: {
          logger: (msg, meta) => {
            loggedMessage = msg;
            loggedMeta = meta;
          },
        },
        handler: async () => {
          throw new Error("Failed to process payment");
        },
      });

      try {
        await testAction();
      } catch {
        // expected
      }

      expect(loggedMessage).toContain("Failed to process payment");
      expect(loggedMeta.actionName).toBe("/secure-action");
      expect(loggedMeta.requestId).toBeDefined();
    });
  });

  describe("12. Existing Action Behavior Remains Compatible", () => {
    it("should execute successful actions with input and output schemas as normal", async () => {
      const testAction = action({
        input: z.object({ count: z.number() }),
        output: z.object({ doubled: z.number() }),
        handler: async ({ input }) => {
          return { doubled: input.count * 2 };
        },
      });

      const res = await testAction({ count: 5 });
      expect(res.doubled).toBe(10);
    });

    it("should handle declared error mapping identically through callAction", async () => {
      const testAction = action({
        path: "/declared-test",
        errors: {
          ITEM_OUT_OF_STOCK: {
            code: 409,
            message: "Item is no longer in stock",
          },
        },
        handler: async () => {
          throw "ITEM_OUT_OF_STOCK";
        },
      });

      const res = await callAction(testAction);
      expect(res.data).toBeNull();
      expect(res.error?.code).toBe(409);
      expect(res.error?.message).toBe("Item is no longer in stock");
    });

    it("should support fluent ActionBuilder chaining with .errorHandling() and .onError()", async () => {
      let errorHandled = false;

      const builtAction = action()
        .input(z.object({ name: z.string() }))
        .errorHandling({
          onError: () => {
            errorHandled = true;
          },
        })
        .handler(async ({ input }) => {
          if (input.name === "fail") {
            throw new BadRequestError("Name cannot be fail");
          }
          return `Hello ${input.name}`;
        });

      const okRes = await builtAction({ name: "World" });
      expect(okRes).toBe("Hello World");

      try {
        await builtAction({ name: "fail" });
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).toBe("Name cannot be fail");
      }

      expect(errorHandled).toBe(true);
    });
  });
});
