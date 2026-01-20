/**
 * Generate a nano ID for unique identifiers
 */
function nanoId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let result = ''
    for (let i = 0; i < 21; i++) {
        result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
}

/**
 * TYPES
 */

/**
 * An event partial is a structured bit of data added to a wide event.
 * Each partial has a type discriminator and arbitrary additional fields.
 */
export type EventPartial<K extends string = string> = {
    type: K;
} & Record<string, unknown>

/**
 * Validates that a registry maps keys to objects with matching type discriminators
 */
export type ValidRegistry<T> = {
    [K in keyof T]: K extends string ? { type: K } & Record<string, unknown> : never
}

/**
 * A registry of event partials - defines the shape of all partials that can be logged
 */
export type EventPartialRegistry<T extends ValidRegistry<T>> = {
    [K in keyof T]: T[K]
}

/**
 * Service information - where an event is emitted from
 */
export interface Service {
    name: string;
    version?: string;
    [key: string]: unknown;
}

/**
 * Base originator interface - an external thing that triggered your service
 * This is like a trace that can cross service boundaries
 */
export interface Originator {
    /** Unique identifier for this originator chain (propagates across services) */
    originatorId: string;
    /** Type discriminator for the originator */
    type: string;
    /** Timestamp when the originator was created (Unix ms) */
    timestamp: number;
    /** Parent originator ID if this is a child span */
    parentId?: string;
    [key: string]: unknown;
}

/** HTTP method types */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

/**
 * HTTP request originator
 */
export interface HttpOriginator extends Originator {
    type: "http";
    method: HttpMethod;
    path: string;
    /** Query string (without leading ?) */
    query?: string;
    /** Request headers */
    headers?: Record<string, string>;
    /** Client IP address */
    clientIp?: string;
    /** User agent string */
    userAgent?: string;
    /** Content type of the request */
    contentType?: string;
    /** Content length in bytes */
    contentLength?: number;
    /** HTTP protocol version (e.g., "1.1", "2") */
    httpVersion?: string;
    /** Host header value */
    host?: string;
}

/**
 * WebSocket message originator
 */
export interface WebSocketOriginator extends Originator {
    type: "websocket";
    /** WebSocket session/connection ID */
    sessionId: string;
    /** Message source identifier */
    source: string;
    /** Message type (e.g., "text", "binary") */
    messageType?: "text" | "binary";
    /** Size of the message in bytes */
    messageSize?: number;
}

/**
 * Cron/scheduled task originator
 */
export interface CronOriginator extends Originator {
    type: "cron";
    /** Cron expression (e.g., "0 0 * * *") */
    cron: string;
    /** Name of the scheduled job */
    jobName?: string;
    /** Scheduled execution time (Unix ms) */
    scheduledTime?: number;
}

/** Header name for propagating originator ID across services */
export const ORIGINATOR_HEADER = "x-wevt-originator";
/** Header name for propagating trace ID across services */
export const TRACE_ID_HEADER = "x-wevt-trace-id";

/**
 * Tracing context to propagate across services
 */
export interface TracingContext {
    /** The trace ID (stays constant across the entire distributed trace) */
    traceId: string;
    /** The originator ID of the calling service (becomes parentId in the callee) */
    originatorId: string;
}

/**
 * Create headers for propagating tracing context to downstream services
 */
export function createTracingHeaders(context: TracingContext): Record<string, string> {
    return {
        [TRACE_ID_HEADER]: context.traceId,
        [ORIGINATOR_HEADER]: context.originatorId,
    }
}

/**
 * Extract tracing context from incoming request headers
 * Returns null if no tracing headers are present
 */
export function extractTracingContext(headers: Record<string, string | string[] | undefined>): TracingContext | null {
    // Case-insensitive header lookup for trace ID
    let traceIdValue: string | undefined
    let originatorIdValue: string | undefined

    for (const [key, value] of Object.entries(headers)) {
        const lowerKey = key.toLowerCase()
        if (lowerKey === TRACE_ID_HEADER.toLowerCase()) {
            traceIdValue = Array.isArray(value) ? value[0] : value
        } else if (lowerKey === ORIGINATOR_HEADER.toLowerCase()) {
            originatorIdValue = Array.isArray(value) ? value[0] : value
        }
    }

    if (!traceIdValue || !originatorIdValue) {
        return null
    }

    return {
        traceId: traceIdValue,
        originatorId: originatorIdValue,
    }
}

/**
 * Options for creating an HTTP originator
 */
export interface CreateHttpOriginatorOptions {
    /** Override the originator ID (useful when continuing a trace) */
    originatorId?: string;
}

/**
 * Result of creating an originator from an incoming request
 * Contains both the originator and the extracted traceId (if any)
 */
export interface OriginatorFromRequestResult {
    /** The created HTTP originator */
    originator: HttpOriginator;
    /** The trace ID extracted from headers, or a newly generated one */
    traceId: string;
}

/** Placeholder for redacted values */
const REDACTED = "[REDACTED]"

/** Headers that should be redacted (case-insensitive) */
const SENSITIVE_HEADERS = new Set([
    "authorization",
    "x-api-key",
    "x-auth-token",
    "cookie",
    "set-cookie",
])

/** Query parameters that should be redacted (case-insensitive) */
const SENSITIVE_QUERY_PARAMS = new Set([
    "code",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "secret",
    "password",
])

/**
 * Redact sensitive headers from a headers object
 */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            redacted[key] = REDACTED
        } else {
            redacted[key] = value
        }
    }
    return redacted
}

/**
 * Redact sensitive query parameters from a query string
 */
function redactQueryString(query: string | undefined): string | undefined {
    if (!query) return query

    const params = new URLSearchParams(query)
    const redactedParams = new URLSearchParams()

    for (const [key, value] of params.entries()) {
        if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
            redactedParams.set(key, REDACTED)
        } else {
            redactedParams.set(key, value)
        }
    }

    const result = redactedParams.toString()
    return result || undefined
}

/**
 * Create an HTTP originator from a Web Fetch API Request
 * Extracts tracing context from headers if present:
 * - traceId: extracted from x-wevt-trace-id header, or generated if not present
 * - parentId: set to the incoming x-wevt-originator header value (the caller's originatorId)
 */
export function createOriginatorFromRequest(
    request: Request,
    options: CreateHttpOriginatorOptions = {}
): OriginatorFromRequestResult {
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
    })

    // Check for incoming tracing context
    const tracingContext = extractTracingContext(headers)

    // Redact sensitive data
    const redactedHeaders = redactHeaders(headers)
    const query = url.search ? url.search.slice(1) : undefined
    const redactedQuery = redactQueryString(query)

    const originator: HttpOriginator = {
        originatorId: options.originatorId || `orig_${nanoId()}`,
        type: "http",
        timestamp: Date.now(),
        // If we have incoming tracing context, the caller's originatorId becomes our parentId
        ...(tracingContext && { parentId: tracingContext.originatorId }),
        method: request.method.toUpperCase() as HttpMethod,
        path: url.pathname,
        query: redactedQuery,
        headers: redactedHeaders,
        host: url.host,
        userAgent: headers['user-agent'],
        contentType: headers['content-type'],
        contentLength: headers['content-length'] ? parseInt(headers['content-length'], 10) : undefined,
    }

    return {
        originator,
        // Use incoming traceId if present, otherwise generate a new one
        traceId: tracingContext?.traceId || `trace_${nanoId()}`,
    }
}

/**
 * Node.js IncomingMessage-like interface
 */
export interface NodeIncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    httpVersion?: string;
    socket?: {
        remoteAddress?: string;
    };
}

/**
 * Create an HTTP originator from a Node.js IncomingMessage (http/https/express)
 * Extracts tracing context from headers if present:
 * - traceId: extracted from x-wevt-trace-id header, or generated if not present
 * - parentId: set to the incoming x-wevt-originator header value (the caller's originatorId)
 */
export function createOriginatorFromNodeRequest(
    request: NodeIncomingMessage,
    options: CreateHttpOriginatorOptions = {}
): OriginatorFromRequestResult {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
        if (value) {
            headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
        }
    }

    // Parse URL
    const urlStr = request.url || '/'
    const host = headers['host'] || 'localhost'
    let path = urlStr
    let query: string | undefined

    const queryIndex = urlStr.indexOf('?')
    if (queryIndex !== -1) {
        path = urlStr.slice(0, queryIndex)
        query = urlStr.slice(queryIndex + 1)
    }

    // Check for incoming tracing context
    const tracingContext = extractTracingContext(headers)

    // Get client IP (check x-forwarded-for for proxied requests)
    const clientIp = headers['x-forwarded-for']?.split(',')[0].trim()
        || request.socket?.remoteAddress

    // Redact sensitive data
    const redactedHeaders = redactHeaders(headers)
    const redactedQuery = redactQueryString(query)

    const originator: HttpOriginator = {
        originatorId: options.originatorId || `orig_${nanoId()}`,
        type: "http",
        timestamp: Date.now(),
        // If we have incoming tracing context, the caller's originatorId becomes our parentId
        ...(tracingContext && { parentId: tracingContext.originatorId }),
        method: (request.method?.toUpperCase() || 'GET') as HttpMethod,
        path,
        query: redactedQuery,
        headers: redactedHeaders,
        host,
        clientIp,
        userAgent: headers['user-agent'],
        contentType: headers['content-type'],
        contentLength: headers['content-length'] ? parseInt(headers['content-length'], 10) : undefined,
        httpVersion: request.httpVersion,
    }

    return {
        originator,
        // Use incoming traceId if present, otherwise generate a new one
        traceId: tracingContext?.traceId || `trace_${nanoId()}`,
    }
}

/**
 * Create a child originator from a parent (for sub-spans/child operations)
 */
export function createChildOriginator(parent: Originator, type: string = parent.type): Originator {
    return {
        originatorId: `orig_${nanoId()}`,
        type,
        timestamp: Date.now(),
        parentId: parent.originatorId,
    }
}

/**
 * Create a cron originator for scheduled tasks
 */
export function createCronOriginator(cron: string, jobName?: string): CronOriginator {
    return {
        originatorId: `orig_${nanoId()}`,
        type: "cron",
        timestamp: Date.now(),
        cron,
        jobName,
        scheduledTime: Date.now(),
    }
}

/**
 * The base structure of a wide event
 */
export interface WideEventBase {
    eventId: string;
    /** Trace ID that stays constant across the entire distributed trace */
    traceId: string;
    service: Service;
    originator: Originator;
}

/**
 * The full wide event log structure including partials
 */
export type WideEventLog<R extends ValidRegistry<R>> = WideEventBase & Partial<R>

/**
 * Collectors
 * Adapts the log to some format and flushes to an external service
 */
export interface LogCollectorClient {
    flush(event: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void>;
}

/**
 * Simple collector to log the event to stdout/console
 */
export class StdioCollector implements LogCollectorClient {
    async flush(eventBase: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void> {
        const partialsObj: Record<string, EventPartial<string>> = {}
        for (const [key, value] of partials) {
            partialsObj[key] = value
        }
        console.log(JSON.stringify({
            ...eventBase,
            ...partialsObj
        }))
    }
}

/**
 * Composes multiple collectors together, flushing to all of them in parallel
 */
export class CompositeCollector implements LogCollectorClient {
    constructor(private collectors: LogCollectorClient[]) {}

    async flush(event: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void> {
        await Promise.all(this.collectors.map(c => c.flush(event, partials)))
    }
}

/**
 * Filter function type for FilteredCollector
 */
export type EventFilter = (event: WideEventBase, partials: Map<string, EventPartial<string>>) => boolean

/**
 * Wraps a collector and only flushes events that pass the filter function
 */
export class FilteredCollector implements LogCollectorClient {
    constructor(
        private collector: LogCollectorClient,
        private filter: EventFilter
    ) {}

    async flush(event: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void> {
        if (this.filter(event, partials)) {
            await this.collector.flush(event, partials)
        }
    }
}

/**
 * Options for FileCollector
 */
export interface FileCollectorOptions {
    /** Number of events to buffer before flushing to disk (default: 10) */
    bufferSize?: number
    /** Maximum time in ms to wait before flushing buffer (default: 5000) */
    flushIntervalMs?: number
}

/**
 * Filesystem interface for FileCollector (allows injection for testing)
 */
export interface FileSystem {
    appendFile(path: string, data: string): Promise<void>
}

/**
 * Collector that writes events to a file with buffering
 */
export class FileCollector implements LogCollectorClient {
    private buffer: string[] = []
    private bufferSize: number
    private flushIntervalMs: number
    private flushTimer: ReturnType<typeof setTimeout> | null = null

    constructor(
        private filePath: string,
        private fs: FileSystem,
        options: FileCollectorOptions = {}
    ) {
        this.bufferSize = options.bufferSize ?? 10
        this.flushIntervalMs = options.flushIntervalMs ?? 5000
    }

    async flush(event: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void> {
        const partialsObj: Record<string, EventPartial<string>> = {}
        for (const [key, value] of partials) {
            partialsObj[key] = value
        }
        const line = JSON.stringify({
            ...event,
            ...partialsObj
        }) + '\n'

        this.buffer.push(line)

        // Start flush timer if not already running
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flushBuffer(), this.flushIntervalMs)
        }

        // Flush immediately if buffer is full
        if (this.buffer.length >= this.bufferSize) {
            await this.flushBuffer()
        }
    }

    /**
     * Flush the buffer to disk
     */
    async flushBuffer(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
            this.flushTimer = null
        }

        if (this.buffer.length === 0) {
            return
        }

        const data = this.buffer.join('')
        this.buffer = []
        await this.fs.appendFile(this.filePath, data)
    }

    /**
     * Force flush any remaining buffered events (call on shutdown)
     */
    async close(): Promise<void> {
        await this.flushBuffer()
    }
}

/**
 * Options for creating a WideEvent
 */
export interface WideEventOptions {
    /** Trace ID to use (for continuing an existing trace). If not provided, a new one is generated. */
    traceId?: string;
}

/**
 * Zod-based DSL for defining wide event partials
 * Restricted to only allow specific primitive types for cross-language compatibility
 */

import { z, type ZodTypeAny, type ZodObject, type ZodRawShape } from 'zod'

// Re-export z for schema definitions
export { z }

// Allowed primitive Zod types for partials
type AllowedZodPrimitive =
    | z.ZodString
    | z.ZodNumber
    | z.ZodBoolean

// Allowed types: primitives, arrays of primitives, or optional versions
type AllowedZodType =
    | AllowedZodPrimitive
    | z.ZodArray<AllowedZodPrimitive>
    | z.ZodOptional<AllowedZodPrimitive>
    | z.ZodOptional<z.ZodArray<AllowedZodPrimitive>>

// Constraint type to ensure schema only uses allowed types
type AllowedShape = {
    [key: string]: AllowedZodType
}

// Partial definition with Zod schema
export interface PartialDefinition<T extends string, S extends ZodRawShape> {
    name: T
    schema: ZodObject<S>
}

// Registry of all partials
export interface Registry<T extends PartialDefinition<string, ZodRawShape>[]> {
    partials: T
}

/**
 * Define a partial with a name and Zod schema
 * Only allows: z.string(), z.number(), z.boolean(), and their arrays/optionals
 */
export function partial<T extends string, S extends AllowedShape>(
    name: T,
    schema: S
): PartialDefinition<T, S> {
    return { name, schema: z.object(schema) }
}

/**
 * Create a registry of partials
 */
export function registry<T extends PartialDefinition<string, ZodRawShape>[]>(
    partials: T
): Registry<T> {
    return { partials }
}

/**
 * Infer the TypeScript type from a partial definition
 */
export type InferPartial<T extends PartialDefinition<string, ZodRawShape>> =
    z.infer<T['schema']> & { type: T['name'] }

// Helper to detect Zod type info
interface ZodFieldInfo {
    baseType: 'string' | 'number' | 'boolean'
    isArray: boolean
    isOptional: boolean
}

function getZodFieldInfo(zodType: ZodTypeAny): ZodFieldInfo {
    let current = zodType
    let isOptional = false
    let isArray = false

    // Zod v4 uses _def.type instead of _def.typeName
    const getDefType = (t: ZodTypeAny): string => t._def.type || t._def.typeName

    // Unwrap optional
    if (getDefType(current) === 'optional') {
        isOptional = true
        current = current._def.innerType
    }

    // Unwrap array
    if (getDefType(current) === 'array') {
        isArray = true
        current = current._def.element
    }

    // Get base type
    let baseType: 'string' | 'number' | 'boolean'
    const defType = getDefType(current)
    switch (defType) {
        case 'string':
            baseType = 'string'
            break
        case 'number':
            baseType = 'number'
            break
        case 'boolean':
            baseType = 'boolean'
            break
        default:
            throw new Error(`Unsupported Zod type: ${defType}`)
    }

    return { baseType, isArray, isOptional }
}

/**
 * Get the shape entries from a Zod schema, filtering out internal properties
 */
function getSchemaEntries(schema: ZodObject<ZodRawShape>): [string, ZodTypeAny][] {
    const shape = schema.shape
    return Object.entries(shape).filter(([key, value]) => {
        // Filter out non-Zod entries and internal properties
        return value && typeof value === 'object' && '_def' in value
    }) as [string, ZodTypeAny][]
}

/**
 * Convert a partial schema to JSON Schema
 */
function partialToJsonSchema(def: PartialDefinition<string, ZodRawShape>): object {
    const properties: Record<string, object> = {
        type: { const: def.name },
    }
    const required: string[] = ["type"]

    for (const [fieldName, zodType] of getSchemaEntries(def.schema)) {
        const { baseType, isArray, isOptional } = getZodFieldInfo(zodType)

        const jsonType = baseType === 'number' ? 'number' : baseType

        if (isArray) {
            properties[fieldName] = {
                type: "array",
                items: { type: jsonType },
            }
        } else {
            properties[fieldName] = { type: jsonType }
        }

        if (!isOptional) {
            required.push(fieldName)
        }
    }

    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    }
}

/**
 * Generate full JSON Schema for a registry
 */
export function generateJsonSchema(reg: Registry<PartialDefinition<string, ZodRawShape>[]>): object {
    const definitions: Record<string, object> = {}

    for (const partial of reg.partials) {
        definitions[partial.name] = partialToJsonSchema(partial)
    }

    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "wevt-partials",
        definitions,
    }
}

/**
 * Convert string to PascalCase
 */
function pascalCase(str: string): string {
    return str
        .split(/[-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("")
}

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/**
 * Generate TypeScript types for a registry
 */
export function generateTypeScript(reg: Registry<PartialDefinition<string, ZodRawShape>[]>): string {
    const lines: string[] = [
        "// Auto-generated by wevt codegen - DO NOT EDIT",
        "// Source: schema/partials.ts",
        "",
        'import type { EventPartial } from "../index"',
        "",
    ]

    for (const partial of reg.partials) {
        const interfaceName = pascalCase(partial.name) + "Partial"
        lines.push(`export interface ${interfaceName} extends EventPartial<"${partial.name}"> {`)
        lines.push(`    type: "${partial.name}"`)

        for (const [fieldName, zodType] of getSchemaEntries(partial.schema)) {
            const { baseType, isArray, isOptional } = getZodFieldInfo(zodType)
            const fullType = isArray ? `${baseType}[]` : baseType
            const optionalMarker = isOptional ? "?" : ""
            lines.push(`    ${fieldName}${optionalMarker}: ${fullType}`)
        }

        lines.push("}")
        lines.push("")
    }

    // Generate the registry type
    lines.push("// Registry type combining all partials")
    lines.push("export type GeneratedRegistry = {")
    for (const partial of reg.partials) {
        const interfaceName = pascalCase(partial.name) + "Partial"
        lines.push(`    ${partial.name}: ${interfaceName}`)
    }
    lines.push("}")
    lines.push("")

    // Export partial names as a union
    const partialNames = reg.partials.map((p) => `"${p.name}"`).join(" | ")
    lines.push(`export type PartialName = ${partialNames}`)
    lines.push("")

    return lines.join("\n")
}

/**
 * Convert Zod type to Python type annotation
 */
function zodTypeToPython(zodType: ZodTypeAny): string {
    const { baseType, isArray } = getZodFieldInfo(zodType)

    let pyType: string
    switch (baseType) {
        case "string":
            pyType = "str"
            break
        case "number":
            pyType = "float"
            break
        case "boolean":
            pyType = "bool"
            break
    }

    return isArray ? `list[${pyType}]` : pyType
}

/**
 * Generate Python TypedDicts for a registry
 */
export function generatePython(reg: Registry<PartialDefinition<string, ZodRawShape>[]>): string {
    const lines: string[] = [
        "# Auto-generated by wevt codegen - DO NOT EDIT",
        "# Source: schema/partials.ts",
        "",
        "from typing import TypedDict, TypeVar, Union",
        "",
    ]

    for (const partial of reg.partials) {
        const className = pascalCase(partial.name) + "Partial"
        const entries = getSchemaEntries(partial.schema)

        const hasOptional = entries.some(([_, zodType]) =>
            getZodFieldInfo(zodType).isOptional
        )

        if (hasOptional) {
            const requiredFields = entries.filter(
                ([_, zodType]) => !getZodFieldInfo(zodType).isOptional
            )
            const optionalFields = entries.filter(
                ([_, zodType]) => getZodFieldInfo(zodType).isOptional
            )

            if (requiredFields.length > 0) {
                lines.push(`class _${className}Required(TypedDict):`)
                lines.push(`    """Required fields for ${partial.name} partial"""`)
                lines.push(`    type: str  # Literal["${partial.name}"]`)
                for (const [fieldName, zodType] of requiredFields) {
                    const pyType = zodTypeToPython(zodType)
                    lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`)
                }
                lines.push("")

                lines.push(`class ${className}(_${className}Required, total=False):`)
                lines.push(`    """${pascalCase(partial.name)} event partial"""`)
                for (const [fieldName, zodType] of optionalFields) {
                    const pyType = zodTypeToPython(zodType)
                    lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`)
                }
            } else {
                lines.push(`class ${className}(TypedDict, total=False):`)
                lines.push(`    """${pascalCase(partial.name)} event partial"""`)
                lines.push(`    type: str  # Literal["${partial.name}"] - required`)
                for (const [fieldName, zodType] of optionalFields) {
                    const pyType = zodTypeToPython(zodType)
                    lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`)
                }
            }
        } else {
            lines.push(`class ${className}(TypedDict):`)
            lines.push(`    """${pascalCase(partial.name)} event partial"""`)
            lines.push(`    type: str  # Literal["${partial.name}"]`)
            for (const [fieldName, zodType] of entries) {
                const pyType = zodTypeToPython(zodType)
                lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`)
            }
        }
        lines.push("")
    }

    // Generate union type for all partials
    const partialTypes = reg.partials.map((p) => pascalCase(p.name) + "Partial")
    lines.push("# Union of all partial types")
    lines.push(`GeneratedPartial = Union[${partialTypes.join(", ")}]`)
    lines.push("")

    // Generate registry type
    lines.push("# Registry mapping partial names to their types")
    lines.push("class GeneratedRegistry(TypedDict):")
    lines.push('    """Type-safe registry of all event partials"""')
    for (const partial of reg.partials) {
        const className = pascalCase(partial.name) + "Partial"
        lines.push(`    ${partial.name}: ${className}`)
    }
    lines.push("")

    // Export list
    lines.push("__all__ = [")
    for (const partial of reg.partials) {
        lines.push(`    "${pascalCase(partial.name)}Partial",`)
    }
    lines.push('    "GeneratedPartial",')
    lines.push('    "GeneratedRegistry",')
    lines.push("]")
    lines.push("")

    return lines.join("\n")
}

/**
 * Core WideEvent class
 * @param R pass in a valid Registry type, which defines the wide event partials you may pass in
 */
export class WideEvent<R extends ValidRegistry<R>> {
    readonly eventId: string;
    readonly traceId: string;
    private collector: LogCollectorClient;
    private partials = new Map<string, EventPartial<string>>();
    private service: Service;
    private originator: Originator;

    /**
     * Create a wide event
     *
     * @param service Service that the wide event is being emitted on
     * @param originator Originator (i.e. request, schedule, etc) of the wide event
     * @param collector Location to collect/flush logs to
     * @param options Optional configuration including traceId
     */
    constructor(service: Service, originator: Originator, collector: LogCollectorClient, options: WideEventOptions = {}) {
        this.eventId = `evt_${nanoId()}`
        this.traceId = options.traceId || `trace_${nanoId()}`
        this.service = service
        this.originator = originator
        this.collector = collector
    }

    /**
     * Add a partial to a wide event
     * @param partial wide event partial to add
     */
    partial<K extends keyof R & string>(partial: R[K]): void {
        this.partials.set(partial.type, partial)
    }

    /**
     * Add a partial to a wide event (alias for partial)
     * @param partial wide event partial to add
     */
    log<K extends keyof R & string>(partial: R[K]): void {
        this.partial(partial)
    }

    /**
     * Get the current state of the wide event as a log object
     */
    toLog(): WideEventLog<R> {
        const result: WideEventLog<R> = {
            eventId: this.eventId,
            traceId: this.traceId,
            service: this.service,
            originator: this.originator,
        } as WideEventLog<R>

        for (const [key, value] of this.partials) {
            (result as Record<string, unknown>)[key] = value
        }

        return result
    }

    /**
     * Emit the full wide log
     */
    async flush(): Promise<void> {
        await this.collector.flush({
            eventId: this.eventId,
            traceId: this.traceId,
            originator: this.originator,
            service: this.service,
        }, this.partials)
    }
}
