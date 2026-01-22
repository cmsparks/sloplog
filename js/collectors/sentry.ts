import type { WideEventBase, EventPartial } from '../index.js';
import type { LogCollectorClient, FlushOptions } from './index.js';

/** Type alias for partial values (singular or array) */
type PartialValue = EventPartial<string> | EventPartial<string>[];

export type SentryLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface SentryLogger {
  log?: (level: SentryLogLevel, message: string, attributes?: Record<string, unknown>) => void;
  trace?: (message: string, attributes?: Record<string, unknown>) => void;
  debug?: (message: string, attributes?: Record<string, unknown>) => void;
  info?: (message: string, attributes?: Record<string, unknown>) => void;
  warn?: (message: string, attributes?: Record<string, unknown>) => void;
  error?: (message: string, attributes?: Record<string, unknown>) => void;
  fatal?: (message: string, attributes?: Record<string, unknown>) => void;
}

/**
 * Options for SentryCollector
 */
export interface SentryCollectorOptions {
  /**
   * Sentry logger instance (e.g. Sentry.logger). Requires the Sentry logger
   * integration to be configured during Sentry.init().
   */
  logger: SentryLogger;
  /** Default log level for events (default: "info") */
  level?: SentryLogLevel;
  /** Optional function to derive log level per event */
  levelSelector?: (
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ) => SentryLogLevel;
  /** Log message to use (default: "wide-event") */
  message?: string;
}

/**
 * Collector that sends events to Sentry Logs via the Sentry logger API
 */
export class SentryCollector implements LogCollectorClient {
  private logger: SentryLogger;
  private defaultLevel: SentryLogLevel;
  private levelSelector?: SentryCollectorOptions['levelSelector'];
  private message: string;

  constructor(options: SentryCollectorOptions) {
    this.logger = options.logger;
    this.defaultLevel = options.level ?? 'info';
    this.levelSelector = options.levelSelector;
    this.message = options.message ?? 'wide-event';
  }

  async flush(
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ): Promise<void> {
    const partialsObj: Record<string, PartialValue> = {};
    for (const [key, value] of partials) {
      partialsObj[key] = value;
    }

    const attributes = {
      ...event,
      ...partialsObj,
    };

    const level = this.levelSelector
      ? this.levelSelector(event, partials, options)
      : this.defaultLevel;

    const loggerMethod =
      (level === 'trace' && this.logger.trace) ||
      (level === 'debug' && this.logger.debug) ||
      (level === 'info' && this.logger.info) ||
      (level === 'warn' && this.logger.warn) ||
      (level === 'error' && this.logger.error) ||
      (level === 'fatal' && this.logger.fatal);

    if (loggerMethod) {
      loggerMethod(this.message, attributes);
      return;
    }

    this.logger.log?.(level, this.message, attributes);
  }
}

/**
 * Create a collector that sends events via the Sentry logger.
 */
export function sentryCollector(options: SentryCollectorOptions): SentryCollector {
  return new SentryCollector(options);
}
