# nezt

> **The type-safe Next.js Server Action & API Route engine with progressive context enrichment, onion middleware pipelines, and zero-compromise TypeScript DX.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20%26%20Zero%20any-3178c6.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-13%20%7C%2014%20%7C%2015-black.svg)](https://nextjs.org/)

---

## Overview

**nezt** is an open-source, lightweight, end-to-end type-safe framework for building Next.js Server Actions and API Route Handlers.

While Next.js Server Actions provide seamless client-server RPC, managing **input validation, authorization, rate-limiting, idempotency, context enrichment, and error serialization** across large applications often leads to repetitive boilerplate and fragile `any` type casts.

`nezt` solves this with:
- **Zero `any` Type System**: Compile-time safe from untrusted runtime boundaries (`unknown`) down into deeply nested handler contexts.
- **Progressive Context Enrichment**: Middlewares accumulate strongly-typed properties (`ctx.user`, `ctx.tenant`, `ctx.db`) without requiring call-site type assertions.
- **Dual Syntax**: Choose between declarative object configuration (`action({ ... })`) or a fluent builder (`action().input(...).use(...).handler(...)`).
- **One-Click Route Adaptation**: Turn any Server Action into a standard Next.js App Router Route Handler (`route.ts`) via `.toRouteHandler()`.
- **Partitioned Schemas**: Cleanly separate and validate `params`, `query`, and `body` for RESTful API endpoints.
- **Built-in Middlewares**: Out-of-the-box rate limiting, idempotency locks, declarative policy gates, timing metrics, and structured logging.

---

## Installation

```bash
# npm
npm install nezt zod

# pnpm
pnpm add nezt zod

# bun
bun add nezt zod
```

> **Peer Dependency**: `nezt` requires `zod` (`^3.23.0` or `^4.0.0`).

---

## Quick Start

### 1. Define a Server Action

```ts
// app/actions/users.ts
"use server";

import { z } from "zod";
import { action, badRequest } from "nezt";

export const createUser = action({
  input: z.object({
    email: z.string().email(),
    name: z.string().min(2),
  }),
  output: z.object({
    id: z.string(),
    email: z.string(),
  }),
  handler: async ({ input, ctx }) => {
    // input is strongly typed: { email: string; name: string }
    const user = await db.user.create({ data: input });
    return user;
  },
});
```

### 2. Call from Client Components

```tsx
// app/users/new-user-form.tsx
"use client";

import { useTransition } from "react";
import { createUser } from "@/app/actions/users";

export function NewUserForm() {
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        const user = await createUser({
          email: "alex@example.com",
          name: "Alex",
        });
        console.log("Created user:", user.id);
      } catch (err) {
        console.error("Action failed:", err);
      }
    });
  };

  return <form onSubmit={handleSubmit}>...</form>;
}
```

### 3. Expose as a Next.js API Route Handler

Any action created with `nezt` can be exported directly as a standard route handler with full error translation and JSON serialization:

```ts
// app/api/users/route.ts
import { createUser } from "@/app/actions/users";

export const POST = createUser.toRouteHandler();
```

---

## Core Concepts

### Declarative vs. Fluent Syntax

`nezt` supports two intuitive authoring styles with identical runtime behavior and type safety:

#### Object Configuration
```ts
export const updateProject = action({
  input: z.object({ id: z.string(), name: z.string() }),
  middleware: [requireAuth(), rateLimit()],
  handler: async ({ input, ctx }) => {
    return db.project.update({ where: { id: input.id }, data: { name: input.name } });
  },
});
```

#### Fluent Builder Chaining
```ts
export const updateProject = action()
  .input(z.object({ id: z.string(), name: z.string() }))
  .use(requireAuth())
  .use(rateLimit())
  .handler(async ({ input, ctx }) => {
    return db.project.update({ where: { id: input.id }, data: { name: input.name } });
  });
```

---

### Progressive Context Enrichment

Middlewares in `nezt` use an onion model. When a middleware adds a property via `ctx.add(key, value)`, TypeScript progressively infers that property on `ctx` for all downstream middlewares and the final handler:

```ts
import { createMiddleware, unauthorized } from "nezt";

interface AuthContext {
  user: {
    id: string;
    email: string;
    role: "admin" | "member";
  };
}

export const requireAuth = () =>
  createMiddleware<object, AuthContext>(async ({ ctx, next }) => {
    const session = await getSession(ctx.request);
    if (!session?.user) {
      throw unauthorized("Authentication required");
    }

    // Safely enrich context with typed user data
    const nextCtx = ctx.add("user", session.user);
    return await next({ ctx: nextCtx });
  });
```

Inside your action handler, `ctx.user` is immediately accessible with full autocomplete and type guarantees:

```ts
export const getProfile = action({
  middleware: [requireAuth()],
  handler: async ({ ctx }) => {
    // TypeScript knows ctx.user exists and has { id, email, role }!
    return { id: ctx.user.id, role: ctx.user.role };
  },
});
```

#### Context Immutability & Collision Safety
- `ctx.add(key, value)` creates an immutable child context. If `key` already exists, it throws a descriptive error to prevent subtle bugs where one middleware accidentally overwrites another's state.
- `ctx.replace(key, value)` allows explicit, intentional overwrites when desired.

---

### Project-Wide Action Clients (`createActionClient`)

Instead of repeating the same base middlewares on every action, configure a centralized action client for your app:

```ts
// lib/action-client.ts
import { createActionClient } from "nezt";
import { logging, timing } from "nezt/middlewares";
import { requireAuth } from "./auth-middleware";

// Base unauthenticated client with logging and timing
export const publicAction = createActionClient({
  middleware: [timing(), logging()],
});

// Authenticated client that enforces auth on all downstream actions
export const authedAction = publicAction.use(requireAuth());
```

Now define actions cleanly across your codebase:

```ts
// app/actions/billing.ts
"use server";

import { z } from "zod";
import { authedAction } from "@/lib/action-client";

export const cancelSubscription = authedAction
  .input(z.object({ subscriptionId: z.string() }))
  .handler(async ({ input, ctx }) => {
    // ctx.user and ctx.startTime are automatically present!
    return billingService.cancel(input.subscriptionId, ctx.user.id);
  });
```

---

### Partitioned Schemas for API Routes

When using actions as REST API route handlers, request data arrives from different places: URL dynamic parameters, search query strings, and request bodies. `nezt` lets you validate each partition independently:

```ts
// app/actions/documents.ts
export const getDocument = action({
  input: {
    params: z.object({ docId: z.string().uuid() }),
    query: z.object({ version: z.coerce.number().default(1) }),
  },
  handler: async ({ input }) => {
    // input.params.docId is string
    // input.query.version is number
    return fetchDocument(input.params.docId, input.query.version);
  },
});

// app/api/documents/[docId]/route.ts
export const GET = getDocument.toRouteHandler();
```

Supported partitions:
- `params`: Dynamic route parameters (Next.js 13/14 synchronous objects and Next.js 15+ Promises).
- `query`: URL query string parameters (with automatic array support for duplicates).
- `body`: Parsed JSON body or URL-encoded payload.
- `formData`: Multipart or standard FormData.
- `headers`: Incoming HTTP headers.

---

### Returning Custom Responses

If your handler returns a native Web `Response` object (e.g. streaming a file, generating a PDF, or issuing a redirect), `nezt` detects it and passes it through untouched:

```ts
export const exportInvoicePdf = action({
  input: z.object({ invoiceId: z.string() }),
  handler: async ({ input }) => {
    const pdfBuffer = await generatePdf(input.invoiceId);
    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${input.invoiceId}.pdf"`,
      },
    });
  },
});

export const GET = exportInvoicePdf.toRouteHandler();
```

---

## Built-in Middlewares

Import from `nezt/middlewares` or directly from `nezt`:

### 1. `rateLimit(options)`
Sliding-window in-memory rate limiter with custom key generator and optional distributed store adapter (Redis, Upstash, Memcached):

```ts
import { rateLimit } from "nezt";

export const sensitiveAction = action({
  middleware: [
    rateLimit({
      windowMs: 60_000, // 1 minute
      maxRequests: 5,   // max 5 requests per window
      keyGenerator: (ctx) => ctx.user?.id || "anonymous",
    }),
  ],
  handler: async () => { ... },
});
```

### 2. `idempotency(options)`
Prevents duplicate financial mutations or double-submissions by caching responses based on an idempotency key (from header `idempotency-key` or input payload):

```ts
import { idempotency } from "nezt";

export const chargeCard = action({
  input: z.object({ amount: z.number(), idempotencyKey: z.string() }),
  middleware: [
    idempotency({
      getKey: (_, input) => input.idempotencyKey,
      ttlMs: 10 * 60_000, // 10 minutes
    }),
  ],
  handler: async ({ input }) => { ... },
});
```

### 3. `policy(evaluator, errorMessage?)`
Declarative authorization check or permission evaluator:

```ts
import { policy } from "nezt";

export const deleteProject = action({
  middleware: [
    requireAuth(),
    policy(({ ctx }) => ctx.user.role === "admin", "Admin role required"),
  ],
  handler: async () => { ... },
});
```

### 4. `timing()`
Tracks action execution latency and records `startTime`:

```ts
import { timing } from "nezt";

export const myAction = action({
  middleware: [timing()],
  handler: async ({ ctx }) => {
    console.log("Started at:", ctx.startTime);
  },
});
```

### 5. `logging(options)`
Structured logger recording action lifecycle, request ID, duration, and errors:

```ts
import { logging } from "nezt";

export const myAction = action({
  middleware: [logging({ logInput: true })],
  handler: async () => { ... },
});
```

---

## Error Handling

`nezt` provides standard HTTP-aligned error classes and helpers. When thrown, they automatically serialize to standard JSON in API route handlers and propagate cleanly in Server Actions:

| Class | Status Code | Helper Function | Default Code |
|---|---|---|---|
| `ValidationError` | `400` | `validationError(msg, details)` | `VALIDATION_ERROR` |
| `BadRequestError` | `400` | `badRequest(msg, details)` | `BAD_REQUEST` |
| `UnauthorizedError` | `401` | `unauthorized(msg, details)` | `UNAUTHORIZED` |
| `ForbiddenError` | `403` | `forbidden(msg, details)` | `FORBIDDEN` |
| `NotFoundError` | `404` | `notFound(resource, details)` | `NOT_FOUND` |
| `ConflictError` | `409` | `conflict(msg, details)` | `CONFLICT` |
| `RateLimitError` | `429` | `rateLimitExceeded(msg, details)` | `RATE_LIMIT_EXCEEDED` |
| `InternalServerError` | `500` | `internalServerError(msg, details)` | `INTERNAL_SERVER_ERROR` |

```ts
import { notFound, forbidden } from "nezt";

export const getDocument = action({
  input: z.object({ id: z.string() }),
  middleware: [requireAuth()],
  handler: async ({ input, ctx }) => {
    const doc = await db.document.findUnique({ where: { id: input.id } });
    if (!doc) throw notFound("Document");
    if (doc.ownerId !== ctx.user.id) throw forbidden("Not your document");
    return doc;
  },
});
```

### Standardized JSON Error Response

Route handlers adapted with `.toRouteHandler()` return clean error payloads:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Document not found",
    "status": 404
  }
}
```

---

## Comparison

| Feature | `nezt` | `next-safe-action` | Raw Server Actions |
|---|:---:|:---:|:---:|
| **Type-Safe Input Validation** | ✅ Zod / Partitioned | ✅ Zod | ❌ Manual |
| **Progressive Context Enrichment** | ✅ Full inference | ⚠️ Partial | ❌ None |
| **Route Handler Adaptation** | ✅ `.toRouteHandler()` | ❌ None | ❌ None |
| **Partitioned Schemas (params/query/body)** | ✅ Native | ❌ Manual | ❌ Manual |
| **Zero `any` Guarantees** | ✅ Strict `unknown` | ⚠️ Internal `any` | ❌ Untyped |
| **Built-in Rate Limiting** | ✅ Included | ❌ External | ❌ None |
| **Built-in Idempotency** | ✅ Included | ❌ External | ❌ None |
| **Dual Syntax (Object & Builder)** | ✅ Supported | ⚠️ Builder only | ❌ N/A |
| **Dependencies** | 🪶 Zero (Only Zod) | 📦 Multiple | 🪶 None |

---

## Testing

Run the test suite with Bun:

```bash
bun test
```

Type-check without emitting:

```bash
bun x tsc --noEmit
```

---

## License

MIT © [Nezt Contributors](https://github.com/nezt)
