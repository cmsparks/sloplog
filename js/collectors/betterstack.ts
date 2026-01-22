import type { WideEventBase, EventPartial } from '../index.js';
import type { LogCollectorClient, FlushOptions } from './index.js';

/** Type alias for partial values (singular or array) */
type PartialValue = EventPartial<string> | EventPartial<string>[];

/**
 * Options for BetterStackCollector
 */
export interface BetterStackCollectorOptions {
  /** BetterStack source token */
  sourceToken: string;
  /** Ingesting host (default: "in.logs.betterstack.com") */
  host?: string;
  /** Number of events to buffer before flushing (default: 10) */
  bufferSize?: number;
  /** Maximum time in ms to wait before flushing buffer (default: 5000) */
  flushIntervalMs?: number;
  /** Custom fetch implementation (for testing or custom environments) */
  fetch?: typeof fetch;
}

/**
 * Collector that sends events to BetterStack Logs via HTTP API
 * https://betterstack.com/docs/logs/ingesting-data/http/logs/
 */
export class BetterStackCollector implements LogCollectorClient {
  private buffer: object[] = [];
  private bufferSize: number;
  private flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceToken: string;
  private host: string;
  private fetchFn: typeof fetch;

  constructor(options: BetterStackCollectorOptions) {
    this.sourceToken = options.sourceToken;
    this.host = options.host ?? 'in.logs.betterstack.com';
    this.bufferSize = options.bufferSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.fetchFn = options.fetch ?? fetch;
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

    const logEntry = {
      dt: new Date().toISOString(),
      ...event,
      ...partialsObj,
    };

    this.buffer.push(logEntry);

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
   * Flush the buffer to BetterStack
   */
  async flushBuffer(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const batch = this.buffer;
    this.buffer = [];

    await this.fetchFn(`https://${this.host}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.sourceToken}`,
      },
      body: JSON.stringify(batch),
    });
  }

  /**
   * Force flush any remaining buffered events (call on shutdown)
   */
  async close(): Promise<void> {
    await this.flushBuffer();
  }
}

/**
 * Create a collector that sends events to BetterStack Logs.
 */
export function betterStackCollector(options: BetterStackCollectorOptions): BetterStackCollector {
  return new BetterStackCollector(options);
}
