import type { WideEventBase, EventPartial } from '../index.js';

/**
 * Maximum number of stack trace lines to include in error logs
 */
const MAX_STACK_LINES = 10;

/**
 * Truncate a stack trace to MAX_STACK_LINES lines
 */
export function truncateStack(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  const lines = stack.split('\n');
  if (lines.length <= MAX_STACK_LINES) return stack;
  return lines.slice(0, MAX_STACK_LINES).join('\n') + '\n    ... truncated';
}

/**
 * Flatten a nested object to dot-notation keys.
 * Arrays use numeric indices: `partialName.0.subKey`
 * Stack traces are automatically truncated.
 */
export function flattenObject(
  obj: unknown,
  prefix = '',
  result: Record<string, unknown> = {},
): Record<string, unknown> {
  if (obj === null || obj === undefined) {
    if (prefix) {
      result[prefix] = obj;
    }
    return result;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      flattenObject(obj[i], prefix ? `${prefix}.${i}` : String(i), result);
    }
    return result;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      // Truncate stack traces
      if (key === 'stack' && typeof value === 'string') {
        result[newKey] = truncateStack(value);
      } else {
        flattenObject(value, newKey, result);
      }
    }
    return result;
  }

  if (prefix) {
    result[prefix] = obj;
  }
  return result;
}

/**
 * Options passed to collectors when flushing an event
 */
export interface FlushOptions {
  /**
   * If true, the event should always be sampled/collected regardless of sampling rules.
   * This is set when any partial with alwaysSample=true is attached to the event.
   */
  alwaysSample: boolean;
}

/**
 * Collectors
 * Adapts the log to some format and flushes to an external service.
 * Partials may be singular objects or arrays for repeatable partials.
 */
export interface LogCollectorClient {
  flush(
    event: WideEventBase,
    partials: Map<string, EventPartial<string> | EventPartial<string>[]>,
    options: FlushOptions,
  ): Promise<void>;
}

/** Type alias for partial values (singular or array) */
type PartialValue = EventPartial<string> | EventPartial<string>[];

/**
 * Options for StdioCollector
 */
export interface StdioCollectorOptions {
  /**
   * Prefix to prepend to each log line.
   * Default: "[wide-event]"
   */
  prefix?: string;
  /**
   * If true, pretty-print the JSON output with 2-space indentation.
   * Default: true
   */
  prettyPrint?: boolean;
}

/**
 * Simple collector to log the event to stdout/console
 */
export class StdioCollector implements LogCollectorClient {
  private prefix: string;
  private prettyPrint: boolean;

  constructor(options: StdioCollectorOptions = {}) {
    this.prefix = options.prefix ?? '[wide-event]';
    this.prettyPrint = options.prettyPrint ?? true;
  }

  async flush(
    eventBase: WideEventBase,
    partials: Map<string, PartialValue>,
    _options: FlushOptions,
  ): Promise<void> {
    const partialsObj: Record<string, PartialValue> = {};
    for (const [key, value] of partials) {
      partialsObj[key] = value;
    }
    const event = {
      ...eventBase,
      ...partialsObj,
    };
    const json = this.prettyPrint ? JSON.stringify(event, null, 2) : JSON.stringify(event);
    // eslint-disable-next-line no-console
    console.log(this.prefix, json);
  }
}

/**
 * Create a collector that logs events to stdout/console.
 */
export function stdioCollector(options: StdioCollectorOptions = {}): StdioCollector {
  return new StdioCollector(options);
}

/**
 * Composes multiple collectors together, flushing to all of them in parallel
 */
export class CompositeCollector implements LogCollectorClient {
  constructor(private collectors: LogCollectorClient[]) {}

  async flush(
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ): Promise<void> {
    await Promise.all(this.collectors.map((c) => c.flush(event, partials, options)));
  }
}

/**
 * Create a collector that flushes to multiple collectors in parallel.
 */
export function compositeCollector(collectors: LogCollectorClient[]): CompositeCollector {
  return new CompositeCollector(collectors);
}

/**
 * Filter function type for FilteredCollector
 */
export type EventFilter = (
  event: WideEventBase,
  partials: Map<string, PartialValue>,
  options: FlushOptions,
) => boolean;

/**
 * Wraps a collector and only flushes events that pass the filter function.
 * Note: Events with alwaysSample=true bypass the filter by default.
 */
export class FilteredCollector implements LogCollectorClient {
  constructor(
    private collector: LogCollectorClient,
    private filter: EventFilter,
  ) {}

  async flush(
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ): Promise<void> {
    // Always-sample events bypass the filter
    if (options.alwaysSample || this.filter(event, partials, options)) {
      await this.collector.flush(event, partials, options);
    }
  }
}

/**
 * Create a collector that filters events before flushing.
 */
export function filteredCollector(
  collector: LogCollectorClient,
  filter: EventFilter,
): FilteredCollector {
  return new FilteredCollector(collector, filter);
}

/**
 * Options for FileCollector
 */
export interface FileCollectorOptions {
  /** Number of events to buffer before flushing to disk (default: 10) */
  bufferSize?: number;
  /** Maximum time in ms to wait before flushing buffer (default: 5000) */
  flushIntervalMs?: number;
}

/**
 * Filesystem interface for FileCollector (allows injection for testing)
 */
export interface FileSystem {
  appendFile(path: string, data: string): Promise<void>;
}

/**
 * Collector that writes events to a file with buffering
 */
export class FileCollector implements LogCollectorClient {
  private buffer: string[] = [];
  private bufferSize: number;
  private flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private filePath: string,
    private fs: FileSystem,
    options: FileCollectorOptions = {},
  ) {
    this.bufferSize = options.bufferSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
  }

  async flush(
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    _options: FlushOptions,
  ): Promise<void> {
    const partialsObj: Record<string, PartialValue> = {};
    for (const [key, value] of partials) {
      partialsObj[key] = value;
    }
    const line =
      JSON.stringify({
        ...event,
        ...partialsObj,
      }) + '\n';

    this.buffer.push(line);

    // Start flush timer if not already running
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushBuffer(), this.flushIntervalMs);
    }

    // Flush immediately if buffer is full
    if (this.buffer.length >= this.bufferSize) {
      await this.flushBuffer();
    }
  }

  /**
   * Flush the buffer to disk
   */
  async flushBuffer(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const data = this.buffer.join('');
    this.buffer = [];
    await this.fs.appendFile(this.filePath, data);
  }

  /**
   * Force flush any remaining buffered events (call on shutdown)
   */
  async close(): Promise<void> {
    await this.flushBuffer();
  }
}

/**
 * Create a collector that writes events to a file with buffering.
 */
export function fileCollector(
  filePath: string,
  fs: FileSystem,
  options: FileCollectorOptions = {},
): FileCollector {
  return new FileCollector(filePath, fs, options);
}
