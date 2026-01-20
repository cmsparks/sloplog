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

/** Header name for propagating originator across services */
export const ORIGINATOR_HEADER = "x-wevt-originator";
/** Header name for propagating trace ID across services */
export const TRACE_ID_HEADER = "x-wevt-trace-id";

/**
 * Serializable originator data for cross-service propagation
 */
interface SerializedOriginator {
    v: 1;  // version
    id: string;
    t: string;  // type
    ts: number;  // timestamp
    pid?: string;  // parentId
    d?: Record<string, unknown>;  // additional data
}

/**
 * Serialize an originator to a base64 string for header propagation
 */
export function serializeOriginator(originator: Originator): string {
    const { originatorId, type, timestamp, parentId, ...rest } = originator
    const serialized: SerializedOriginator = {
        v: 1,
        id: originatorId,
        t: type,
        ts: timestamp,
        ...(parentId && { pid: parentId }),
        ...(Object.keys(rest).length > 0 && { d: rest }),
    }
    const json = JSON.stringify(serialized)
    // Use base64url encoding (URL-safe)
    if (typeof btoa === 'function') {
        return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    }
    // Node.js environment
    return Buffer.from(json).toString('base64url')
}

/**
 * Deserialize an originator from a base64 string
 */
export function deserializeOriginator(encoded: string): Originator | null {
    try {
        // Restore base64 padding if needed
        let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
        while (base64.length % 4) {
            base64 += '='
        }

        let json: string
        if (typeof atob === 'function') {
            json = atob(base64)
        } else {
            // Node.js environment
            json = Buffer.from(encoded, 'base64url').toString('utf-8')
        }

        const serialized: SerializedOriginator = JSON.parse(json)

        if (serialized.v !== 1) {
            return null
        }

        return {
            originatorId: serialized.id,
            type: serialized.t,
            timestamp: serialized.ts,
            ...(serialized.pid && { parentId: serialized.pid }),
            ...(serialized.d || {}),
        }
    } catch {
        return null
    }
}

/**
 * Create headers object with originator for outgoing requests
 * @deprecated Use createTracingHeaders instead for proper trace propagation
 */
export function createOriginatorHeaders(originator: Originator): Record<string, string> {
    return {
        [ORIGINATOR_HEADER]: serializeOriginator(originator),
    }
}

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
 * Extract originator from incoming request headers
 * Returns null if no originator header is present or if parsing fails
 */
export function extractOriginatorFromHeaders(headers: Record<string, string | string[] | undefined>): Originator | null {
    // Case-insensitive header lookup
    const headerKey = Object.keys(headers).find(
        key => key.toLowerCase() === ORIGINATOR_HEADER.toLowerCase()
    )
    if (!headerKey) {
        return null
    }
    const headerValue = headers[headerKey]
    if (!headerValue) {
        return null
    }
    const value = Array.isArray(headerValue) ? headerValue[0] : headerValue
    return deserializeOriginator(value)
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
