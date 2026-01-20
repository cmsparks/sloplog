/**
 * Wide Event Partial Definitions
 *
 * Define your event partials here using Zod schemas.
 * Run `mise run codegen` to generate TypeScript types, Python TypedDicts, and JSON Schema.
 *
 * Allowed types: z.string(), z.number(), z.boolean(), and their .array() / .optional() variants
 */

import { partial, registry, z } from "../js/index.js"

// User information partial
const user = partial("user", {
    userId: z.string(),
    subscriptionLevel: z.string(),
    dateJoined: z.number(),
})

// Session information partial
const session = partial("session", {
    sessionId: z.string(),
    messages: z.number(),
    startedAt: z.number(),
})

// Error information partial
const error = partial("error", {
    message: z.string(),
    stack: z.string().optional(),
    code: z.number().optional(),
})

// HTTP response partial
const response = partial("response", {
    statusCode: z.number(),
    durationMs: z.number(),
    contentLength: z.number().optional(),
})

// Database query partial
const dbQuery = partial("db_query", {
    query: z.string(),
    durationMs: z.number(),
    rowCount: z.number().optional(),
    error: z.string().optional(),
})

// Export the registry
export default registry([
    user,
    session,
    error,
    response,
    dbQuery,
])
