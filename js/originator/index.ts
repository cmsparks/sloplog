/**
 * Originator module - functions for creating originators from various sources
 */

/**
 * Generate a nano ID for unique identifiers
 */
function nanoId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 21; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/** HTTP method types */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

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

/**
 * HTTP request originator
 */
export interface HttpOriginator extends Originator {
  type: 'http';
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
  type: 'websocket';
  /** WebSocket session/connection ID */
  sessionId: string;
  /** Message source identifier */
  source: string;
  /** Message type (e.g., "text", "binary") */
  messageType?: 'text' | 'binary';
  /** Size of the message in bytes */
  messageSize?: number;
}

/**
 * Cron/scheduled task originator
 */
export interface CronOriginator extends Originator {
  type: 'cron';
  /** Cron expression (e.g., "0 0 * * *") */
  cron: string;
  /** Name of the scheduled job */
  jobName?: string;
  /** Scheduled execution time (Unix ms) */
  scheduledTime?: number;
}

/** Header name for propagating originator ID across services */
export const ORIGINATOR_HEADER = 'x-sloplog-originator';
/** Header name for propagating trace ID across services */
export const TRACE_ID_HEADER = 'x-sloplog-trace-id';

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
export function tracingHeaders(context: TracingContext): Record<string, string> {
  return {
    [TRACE_ID_HEADER]: context.traceId,
    [ORIGINATOR_HEADER]: context.originatorId,
  };
}

/**
 * Extract tracing context from incoming request headers
 * Returns null if no tracing headers are present
 */
export function extractTracingContext(
  headers: Record<string, string | string[] | undefined>,
): TracingContext | null {
  // Case-insensitive header lookup for trace ID
  let traceIdValue: string | undefined;
  let originatorIdValue: string | undefined;

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === TRACE_ID_HEADER.toLowerCase()) {
      traceIdValue = Array.isArray(value) ? value[0] : value;
    } else if (lowerKey === ORIGINATOR_HEADER.toLowerCase()) {
      originatorIdValue = Array.isArray(value) ? value[0] : value;
    }
  }

  if (!traceIdValue || !originatorIdValue) {
    return null;
  }

  return {
    traceId: traceIdValue,
    originatorId: originatorIdValue,
  };
}

/**
 * Options for creating an HTTP originator
 */
export interface HttpOriginatorOptions {
  /** Override the originator ID (useful when continuing a trace) */
  originatorId?: string;
  /** Parent originator ID (for child originators) */
  parentId?: string;
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
const REDACTED = '[REDACTED]';

/** Headers that should be redacted (case-insensitive) */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
]);

/** Query parameters that should be redacted (case-insensitive) */
const SENSITIVE_QUERY_PARAMS = new Set([
  'code',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'secret',
  'password',
]);

/**
 * Redact sensitive headers from a headers object
 */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      redacted[key] = REDACTED;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Redact sensitive query parameters from a query string
 */
function redactQueryString(query: string | undefined): string | undefined {
  if (!query) return query;

  const params = new URLSearchParams(query);
  const redactedParams = new URLSearchParams();

  for (const [key, value] of params.entries()) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      redactedParams.set(key, REDACTED);
    } else {
      redactedParams.set(key, value);
    }
  }

  const result = redactedParams.toString();
  return result || undefined;
}

/**
 * Create an HTTP originator from a Web Fetch API Request
 * Extracts tracing context from headers if present:
 * - traceId: extracted from x-sloplog-trace-id header, or generated if not present
 * - parentId: set to the incoming x-sloplog-originator header value (the caller's originatorId),
 *   or can be explicitly provided via options.parentId
 */
export function httpOriginator(
  request: Request,
  options: HttpOriginatorOptions = {},
): OriginatorFromRequestResult {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Check for incoming tracing context
  const tracingContext = extractTracingContext(headers);

  // Redact sensitive data
  const redactedHeaders = redactHeaders(headers);
  const query = url.search ? url.search.slice(1) : undefined;
  const redactedQuery = redactQueryString(query);

  // Determine parentId: explicit option > tracing context > undefined
  const parentId = options.parentId ?? tracingContext?.originatorId;

  const originator: HttpOriginator = {
    originatorId: options.originatorId || `orig_${nanoId()}`,
    type: 'http',
    timestamp: Date.now(),
    ...(parentId && { parentId }),
    method: request.method.toUpperCase() as HttpMethod,
    path: url.pathname,
    query: redactedQuery,
    headers: redactedHeaders,
    host: url.host,
    userAgent: headers['user-agent'],
    contentType: headers['content-type'],
    contentLength: headers['content-length'] ? parseInt(headers['content-length'], 10) : undefined,
  };

  return {
    originator,
    // Use incoming traceId if present, otherwise generate a new one
    traceId: tracingContext?.traceId || `trace_${nanoId()}`,
  };
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
 * - traceId: extracted from x-sloplog-trace-id header, or generated if not present
 * - parentId: set to the incoming x-sloplog-originator header value (the caller's originatorId),
 *   or can be explicitly provided via options.parentId
 */
export function nodeHttpOriginator(
  request: NodeIncomingMessage,
  options: HttpOriginatorOptions = {},
): OriginatorFromRequestResult {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
  }

  // Parse URL
  const urlStr = request.url || '/';
  const host = headers['host'] || 'localhost';
  let path = urlStr;
  let query: string | undefined;

  const queryIndex = urlStr.indexOf('?');
  if (queryIndex !== -1) {
    path = urlStr.slice(0, queryIndex);
    query = urlStr.slice(queryIndex + 1);
  }

  // Check for incoming tracing context
  const tracingContext = extractTracingContext(headers);

  // Get client IP (check x-forwarded-for for proxied requests)
  const clientIp =
    headers['x-forwarded-for']?.split(',')[0].trim() || request.socket?.remoteAddress;

  // Redact sensitive data
  const redactedHeaders = redactHeaders(headers);
  const redactedQuery = redactQueryString(query);

  // Determine parentId: explicit option > tracing context > undefined
  const parentId = options.parentId ?? tracingContext?.originatorId;

  const originator: HttpOriginator = {
    originatorId: options.originatorId || `orig_${nanoId()}`,
    type: 'http',
    timestamp: Date.now(),
    ...(parentId && { parentId }),
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
  };

  return {
    originator,
    // Use incoming traceId if present, otherwise generate a new one
    traceId: tracingContext?.traceId || `trace_${nanoId()}`,
  };
}

/**
 * Options for creating a cron originator
 */
export interface CronOriginatorOptions {
  /** Parent originator ID (for child originators) */
  parentId?: string;
}

/**
 * Create a cron originator for scheduled tasks
 */
export function cronOriginator(
  cron: string,
  jobName?: string,
  options: CronOriginatorOptions = {},
): CronOriginator {
  return {
    originatorId: `orig_${nanoId()}`,
    type: 'cron',
    timestamp: Date.now(),
    ...(options.parentId && { parentId: options.parentId }),
    cron,
    jobName,
    scheduledTime: Date.now(),
  };
}
