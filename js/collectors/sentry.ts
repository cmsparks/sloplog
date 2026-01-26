import type { WideEventBase, EventPartial } from '../index.js';
import type { LogCollectorClient, FlushOptions } from './index.js';
import { flattenObject } from './index.js';

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
   * Sentry logger instance (e.g. Sentry.logger).
   * Requires the Sentry logger integration to be configured during Sentry.init().
   */
  logger?: SentryLogger;
  /** Default log level for events (default: "info") */
  level?: SentryLogLevel;
  /** Optional function to derive log level per event */
  levelSelector?: (
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ) => SentryLogLevel;
  /**
   * If true, flatten nested attributes to dot-notation keys for better
   * queryability in Sentry (e.g., `error.message`, `spans.0.name`).
   * Default: true
   */
  flattenAttributes?: boolean;
}

/**
 * Build a summary message for a wide event.
 *
 * Format: [WideEvent] eventId: {id} service: {serviceName} originator: {originatorType} {httpDetails}
 */
function buildSummaryMessage(event: WideEventBase): string {
  const parts: string[] = ['[WideEvent]'];

  // Event ID (shortened)
  parts.push(`eventId:${event.eventId}`);

  // Service name
  if (event.service?.name) {
    parts.push(`service:${event.service.name}`);
  }

  // Originator type and details
  const originator = event.originator;
  if (originator) {
    parts.push(`originator:${originator.type}`);

    // For HTTP originators, include method and path
    if (originator.type === 'http') {
      const method = originator.method as string | undefined;
      const path = originator.path as string | undefined;
      if (method && path) {
        parts.push(`${method} ${path}`);
      }
    }
  }

  return parts.join(' ');
}

/**
 * Collector that sends events to Sentry Logs via the Sentry logger API.
 *
 * Generates a summary message with event ID, service name, and originator details.
 * For HTTP originators, includes method and path.
 *
 * Attributes are flattened to dot-notation keys for better queryability
 * in Sentry (e.g., `error.message`, `spans.0.name`).
 */
export class SentryCollector implements LogCollectorClient {
  private logger?: SentryLogger;
  private defaultLevel: SentryLogLevel;
  private levelSelector?: SentryCollectorOptions['levelSelector'];
  private flattenAttributes: boolean;

  constructor(options: SentryCollectorOptions) {
    this.logger = options.logger;
    this.defaultLevel = options.level ?? 'info';
    this.levelSelector = options.levelSelector;
    this.flattenAttributes = options.flattenAttributes ?? true;
  }

  async flush(
    event: WideEventBase,
    partials: Map<string, PartialValue>,
    options: FlushOptions,
  ): Promise<void> {
    const logger = this.logger;
    if (!logger) {
      return;
    }

    const partialsObj: Record<string, PartialValue> = {};
    for (const [key, value] of partials) {
      partialsObj[key] = value;
    }

    const combined = {
      ...event,
      ...partialsObj,
    };

    // Flatten nested attributes to dot-notation for better Sentry queryability
    const attributes = this.flattenAttributes
      ? flattenObject(combined)
      : (combined as Record<string, unknown>);

    const level = this.levelSelector
      ? this.levelSelector(event, partials, options)
      : this.defaultLevel;

    // Build summary message
    const message = buildSummaryMessage(event);

    const logFn = () => {
      const loggerMethod =
        (level === 'trace' && logger.trace) ||
        (level === 'debug' && logger.debug) ||
        (level === 'info' && logger.info) ||
        (level === 'warn' && logger.warn) ||
        (level === 'error' && logger.error) ||
        (level === 'fatal' && logger.fatal);

      if (loggerMethod) {
        loggerMethod(message, attributes);
        return;
      }

      logger.log?.(level, message, attributes);
    };

    logFn();
  }
}

/**
 * Create a collector that sends events via the Sentry logger.
 */
export function sentryCollector(options: SentryCollectorOptions): SentryCollector {
  return new SentryCollector(options);
}
