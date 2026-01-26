import type { ZodRawShape } from 'zod';
import type { LogCollectorClient } from './collectors/index.js';
import { extractPartialMetadata } from './registry.js';

// Re-export collectors from main entry point for easier bundler compatibility
export * from './collectors/index.js';
export * from './collectors/sentry.js';
import type {
  PartialMetadata,
  PartialDefinition,
  PartialOptions,
  Registry,
  RegistryType,
} from './registry.js';

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

/** Current sloplog library version (propagated onto Service). */
export const SLOPLOG_VERSION = '0.0.6';
/** Default language marker when Service.sloplogLanguage is not set. */
const SLOPLOG_LANGUAGE = 'typescript';

/**
 * TYPES
 */

/**
 * An event partial is a structured bit of data added to a wide event.
 * Each partial has a type discriminator and arbitrary additional fields.
 */
export type EventPartial<K extends string = string> = {
  type: K;
} & Record<string, unknown>;

type RegistryEntry<K extends string> = { type: K } & Record<string, unknown>;

type RegistryShape = Record<string, EventPartial<string> | EventPartial<string>[]>;

/**
 * Validates that a registry maps keys to objects with matching type discriminators
 */
export type ValidRegistry<T> = {
  [K in keyof T]: K extends string
    ? T[K] extends RegistryEntry<K> | RegistryEntry<K>[]
      ? T[K]
      : never
    : never;
};

/**
 * A registry of event partials - defines the shape of all partials that can be logged
 */
export type EventPartialRegistry<T extends ValidRegistry<T>> = {
  [K in keyof T]: T[K];
};

type RegistryEntryValue<T> = T extends (infer U)[] ? U : T;

type RegistryEntries<R> = {
  [K in keyof R]: RegistryEntryValue<R[K]>;
}[keyof R];

type AnyRegistry = Registry<PartialDefinition<string, ZodRawShape, PartialOptions>[]>;

type OriginatorInput =
  | import('./originator/index.js').Originator
  | import('./originator/index.js').OriginatorFromRequestResult;

function isOriginatorResult(
  input: OriginatorInput,
): input is import('./originator/index.js').OriginatorFromRequestResult {
  return (
    typeof input === 'object' &&
    input !== null &&
    'originator' in input &&
    'traceId' in input &&
    typeof (input as { traceId?: unknown }).traceId === 'string'
  );
}

/**
 * Service information - where an event is emitted from
 */
export interface Service {
  /** Service name (required) */
  name: string;
  /** Service version, if available */
  version?: string;
  /** sloplog library version (auto-populated if omitted) */
  sloplogVersion?: string;
  /** sloplog language marker (auto-populated if omitted) */
  sloplogLanguage?: string;
  [key: string]: unknown;
}

/**
 * Create a Service payload with sloplog defaults applied.
 */
export function service(details: Service): Service {
  return {
    ...details,
    sloplogVersion: details.sloplogVersion ?? SLOPLOG_VERSION,
    sloplogLanguage: details.sloplogLanguage ?? SLOPLOG_LANGUAGE,
  };
}

/**
 * The base structure of a wide event
 */
export interface WideEventBase {
  /** Unique event identifier */
  eventId: string;
  /** Trace ID that stays constant across the entire distributed trace */
  traceId: string;
  /** Service metadata for the emitting service */
  service: Service;
  /** Originator metadata for the event */
  originator: import('./originator/index.js').Originator;
}

/**
 * The full wide event log structure including partials
 */
export type WideEventLog<R extends RegistryShape> = WideEventBase & Partial<R>;

/**
 * Allowed log levels for log_message partials and log() calls
 */
export type LogMessageLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// Re-export originator types and functions
export {
  // Types
  type Originator,
  type HttpOriginator,
  type HttpMethod,
  type WebSocketOriginator,
  type CronOriginator,
  type TracingContext,
  type HttpOriginatorOptions,
  type OriginatorFromRequestResult,
  type NodeIncomingMessage,
  type CronOriginatorOptions,
  // Constants
  ORIGINATOR_HEADER,
  TRACE_ID_HEADER,
  // Functions
  httpOriginator,
  nodeHttpOriginator,
  cronOriginator,
  tracingHeaders,
  extractTracingContext,
} from './originator/index.js';

// Re-export collectors from their module
export type { LogCollectorClient, FlushOptions } from './collectors/index.js';

// Collectors are exposed via subpath exports (sloplog/collectors/*).

// Re-export built-in partials registry and types
export { builtInPartials, builtInRegistry, builtInPartialMetadata } from './partials.js';
export type {
  BuiltInRegistry,
  BuiltInPartialName,
  ErrorPartial,
  LogMessagePartial,
  SpanPartial,
  SloplogUsageErrorPartial,
} from './partials.js';

/**
 * Options for creating a WideEvent
 */
export interface WideEventOptions {
  /** Trace ID to use (for continuing an existing trace). If not provided, a new one is generated. */
  traceId?: string;
  /**
   * Runtime metadata about partials. Required for proper handling of repeatable partials
   * and alwaysSample behavior. Defaults to metadata derived from the registry.
   */
  partialMetadata?: Map<string, PartialMetadata>;
}

/**
 * Zod-based DSL for defining wide event partials
 * Restricted to only allow specific primitive types for cross-language compatibility
 */
export { z, partial, registry, extractPartialMetadata } from './registry.js';
export type {
  PartialOptions,
  PartialDefinition,
  Registry,
  PartialMetadata,
  PartialFactory,
  InferPartial,
  RegistryType,
} from './registry.js';

// Codegen functions are NOT re-exported from main entry point to avoid bundling
// Node.js-specific code (pathToFileURL, node:fs) in React Native / browser environments.
// Import from 'sloplog/codegen' directly when you need codegen functionality.

/**
 * Core WideEvent class.
 * Create one WideEvent per request or unit of work and add partials as you go.
 * Use log() for structured partials or for lightweight log_message entries.
 * @param R pass in a valid Registry type, which defines the wide event partials you may pass in
 */
export class WideEvent<R extends RegistryShape> {
  readonly eventId: string;
  readonly traceId: string;
  private collector: LogCollectorClient;
  /** All partials - singular as objects, repeatable as arrays */
  private partials = new Map<string, EventPartial<string> | EventPartial<string>[]>();
  private service: Service;
  private originator: import('./originator/index.js').Originator;
  private openSpans = new Map<string, number[]>();
  /** Metadata about partials (repeatable, alwaysSample) */
  private partialMetadata: Map<string, PartialMetadata>;
  /** Whether this event should always be sampled */
  private _alwaysSample = false;

  /**
   * Create a wide event
   *
   * @param service Service that the wide event is being emitted on
   * @param originator Originator (i.e. request, schedule, etc) of the wide event
   * @param collector Location to collect/flush logs to
   * @param options Optional configuration including traceId and partialMetadata
   */
  constructor(
    service: Service,
    originator: import('./originator/index.js').Originator,
    collector: LogCollectorClient,
    options: WideEventOptions = {},
  ) {
    this.eventId = `evt_${nanoId()}`;
    this.traceId = options.traceId || `trace_${nanoId()}`;
    this.service = {
      ...service,
      sloplogVersion: service.sloplogVersion ?? SLOPLOG_VERSION,
      sloplogLanguage: service.sloplogLanguage ?? SLOPLOG_LANGUAGE,
    };
    this.originator = originator;
    this.collector = collector;
    this.partialMetadata = options.partialMetadata ?? new Map();
  }

  /**
   * Check if this event should always be sampled
   */
  get alwaysSample(): boolean {
    return this._alwaysSample;
  }

  /**
   * Manually mark this event to always be sampled
   */
  markAlwaysSample(): void {
    this._alwaysSample = true;
  }

  /**
   * Add a partial to a wide event.
   * For singular partials, this overwrites any existing partial of the same type.
   * For repeatable partials, this appends to the array.
   * If the partial has alwaysSample=true, the event will be marked to always be sampled.
   * Overwriting a singular partial records a sloplog_usage_error.
   *
   * @param partial wide event partial to add
   */
  partial(partial: RegistryEntries<R>): void {
    this.addPartialInternal(partial as EventPartial<string>);
  }

  /**
   * Add a partial or log message to a wide event.
   * log(partial) is an alias for partial(partial).
   * log(message, data, level) creates a log_message partial.
   * Partials are always preferred over log_message for structured data.
   * If data is provided, it is JSON stringified (string data is passed through).
   * If level is omitted, it defaults to "info".
   */
  log(partial: RegistryEntries<R>): void;
  log(message: string, data?: unknown, level?: LogMessageLevel): void;
  log(arg1: RegistryEntries<R> | string, arg2?: unknown, arg3?: LogMessageLevel): void {
    if (typeof arg1 !== 'string') {
      this.addPartialInternal(arg1 as EventPartial<string>);
      return;
    }

    let data: string | undefined;
    if (typeof arg2 === 'string') {
      data = arg2;
    } else if (arg2 !== undefined) {
      try {
        data = JSON.stringify(arg2);
      } catch {
        this.addUsageError('log_message_stringify_error', 'Failed to stringify log data');
      }
    }

    const level = arg3 ?? 'info';

    this.addPartialInternal({
      type: 'log_message',
      message: arg1,
      level,
      ...(data !== undefined ? { data } : {}),
    });
  }

  /**
   * Add an error partial from an Error or message.
   */
  error(error: unknown, code?: number): void {
    if (typeof error === 'object' && error !== null) {
      const maybePartial = error as { type?: unknown; message?: unknown };
      if (maybePartial.type === 'error' && typeof maybePartial.message === 'string') {
        this.addPartialInternal(error as EventPartial<string>);
        return;
      }
    }

    const payload: { type: 'error'; message: string; stack?: string; code?: number } = {
      type: 'error',
      message: this.formatErrorMessage(error),
    };

    if (error instanceof Error && error.stack) {
      payload.stack = error.stack;
    } else if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { stack?: unknown }).stack === 'string'
    ) {
      payload.stack = (error as { stack: string }).stack;
    }

    const errorCode =
      typeof code === 'number'
        ? code
        : typeof error === 'object' &&
            error !== null &&
            typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : undefined;

    if (typeof errorCode === 'number') {
      payload.code = errorCode;
    }

    this.addPartialInternal(payload);
  }

  private formatErrorMessage(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }

    if (error instanceof Error) {
      return error.message || 'Unknown error';
    }

    if (typeof error === 'object' && error !== null) {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string') {
        return maybeMessage;
      }
      try {
        const serialized = JSON.stringify(error);
        return typeof serialized === 'string' ? serialized : 'Unknown error';
      } catch {
        return 'Unknown error';
      }
    }

    return String(error);
  }

  /**
   * Time a span around a callback and emit a span partial.
   * Unended spans are recorded as sloplog_usage_error on flush.
   */
  async span<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    this.spanStart(name);
    try {
      return await fn();
    } finally {
      this.spanEnd(name);
    }
  }

  /**
   * Start a span by name
   */
  spanStart(name: string): void {
    const startedAt = Date.now();
    const existing = this.openSpans.get(name);
    if (existing) {
      existing.push(startedAt);
    } else {
      this.openSpans.set(name, [startedAt]);
    }
  }

  /**
   * End a span by name
   * Ending a span that was never started records a sloplog_usage_error.
   */
  spanEnd(name: string): void {
    const existing = this.openSpans.get(name);
    if (!existing || existing.length === 0) {
      this.addUsageError('span_end_without_start', `Span "${name}" ended without start`, {
        spanName: name,
      });
      return;
    }

    const startedAt = existing.pop();
    if (startedAt === undefined) {
      return;
    }

    if (existing.length === 0) {
      this.openSpans.delete(name);
    }

    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    this.addPartialInternal({
      type: 'span',
      name,
      startedAt,
      endedAt,
      durationMs,
    });
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
    } as WideEventLog<R>;

    for (const [key, value] of this.partials) {
      (result as Record<string, unknown>)[key] = value;
    }

    return result;
  }

  /**
   * Emit the full wide log to the collector.
   * Any usage errors (e.g. unended spans, partial overwrites) are emitted
   * as sloplog_usage_error partials before flushing.
   */
  async flush(): Promise<void> {
    this.recordOpenSpans();
    await this.collector.flush(
      {
        eventId: this.eventId,
        traceId: this.traceId,
        originator: this.originator,
        service: this.service,
      },
      this.partials,
      { alwaysSample: this._alwaysSample },
    );
  }

  private addPartialInternal(partial: EventPartial<string>): void {
    const metadata = this.partialMetadata.get(partial.type);
    const isRepeatable = metadata?.repeatable ?? this.isRepeatableFallback(partial.type);

    if (metadata?.alwaysSample || this.isAlwaysSampleFallback(partial.type)) {
      this._alwaysSample = true;
    }

    if (isRepeatable) {
      this.appendRepeatablePartial(partial.type, partial);
      return;
    }

    if (this.partials.has(partial.type)) {
      this.addUsageError('partial_overwrite', `Partial "${partial.type}" was overwritten`, {
        partialType: partial.type,
      });
    }

    this.partials.set(partial.type, partial);
  }

  private appendRepeatablePartial(type: string, partial: EventPartial<string>): void {
    const existing = this.partials.get(type);
    if (Array.isArray(existing)) {
      existing.push(partial);
      return;
    }

    if (existing) {
      this.partials.set(type, [existing, partial]);
      return;
    }

    this.partials.set(type, [partial]);
  }

  private isRepeatableFallback(type: string): boolean {
    return (
      type === 'error' ||
      type === 'log_message' ||
      type === 'span' ||
      type === 'sloplog_usage_error'
    );
  }

  private isAlwaysSampleFallback(type: string): boolean {
    return type === 'error';
  }

  private addUsageError(
    kind: string,
    message: string,
    details: Partial<Record<'partialType' | 'spanName' | 'startedAt' | 'count', unknown>> = {},
  ): void {
    this.appendRepeatablePartial('sloplog_usage_error', {
      type: 'sloplog_usage_error',
      kind,
      message,
      ...details,
    });
  }

  private recordOpenSpans(): void {
    if (this.openSpans.size === 0) {
      return;
    }

    for (const [name, starts] of this.openSpans) {
      for (const startedAt of starts) {
        this.addUsageError('span_unended', `Span "${name}" was started but never ended`, {
          spanName: name,
          startedAt,
        });
      }
    }

    this.openSpans.clear();
  }
}

/**
 * Create a WideEvent instance. Prefer this factory over class construction.
 * Provide the registry first to infer partial types and repeatable metadata.
 * originator can be a raw Originator or the { originator, traceId } result from httpOriginator().
 */
export function wideEvent<T extends AnyRegistry>(
  registry: T,
  service: Service,
  originator: OriginatorInput,
  collector: LogCollectorClient,
  options: WideEventOptions = {},
): WideEvent<RegistryType<T>> {
  const resolvedOriginator = isOriginatorResult(originator) ? originator.originator : originator;
  const traceId =
    options.traceId ?? (isOriginatorResult(originator) ? originator.traceId : undefined);
  const partialMetadata = options.partialMetadata ?? extractPartialMetadata(registry);
  return new WideEvent(service, resolvedOriginator, collector, {
    traceId,
    partialMetadata,
  });
}
