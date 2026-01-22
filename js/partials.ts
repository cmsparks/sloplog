import { extractPartialMetadata, partial, registry, z, type InferPartial } from './registry.js';

const error = partial(
  'error',
  {
    message: z.string(),
    stack: z.string().optional(),
    code: z.number().optional(),
  },
  {
    repeatable: true,
    alwaysSample: true,
    description: 'Error details captured during event processing.',
  },
);

const logMessageLevel = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .describe('Log severity level for a log_message partial.');

const logMessage = partial(
  'log_message',
  {
    message: z.string().describe('Human-readable log message.'),
    level: logMessageLevel,
    data: z.string().optional().describe('Optional stringified payload for the log.'),
  },
  {
    repeatable: true,
    description:
      'Lightweight log entry for ad-hoc logging. Prefer structured partials when possible.',
  },
);

const span = partial(
  'span',
  {
    name: z.string().describe('Span name.'),
    startedAt: z.number().describe('Span start time in milliseconds since epoch.'),
    endedAt: z.number().describe('Span end time in milliseconds since epoch.'),
    durationMs: z.number().describe('Span duration in milliseconds.'),
  },
  {
    repeatable: true,
    description: 'Timing span emitted by WideEvent span helpers.',
  },
);

const sloplogUsageError = partial(
  'sloplog_usage_error',
  {
    kind: z.string().describe('Usage error category.'),
    message: z.string().describe('Human-readable usage error message.'),
    partialType: z.string().optional().describe('Partial type involved in the error.'),
    spanName: z.string().optional().describe('Span name involved in the error.'),
    startedAt: z.number().optional().describe('Span start time in ms when relevant.'),
    count: z.number().optional().describe('Optional count related to the error.'),
  },
  {
    repeatable: true,
    description:
      'Internal usage errors emitted by sloplog (e.g. partial overwrites or span misuse).',
  },
);

/** Built-in partial definitions shipped with sloplog. */
export const builtInPartials = {
  error,
  log_message: logMessage,
  span,
  sloplog_usage_error: sloplogUsageError,
};

/** Registry of built-in partial definitions. */
export const builtInRegistry = registry([error, logMessage, span, sloplogUsageError]);
/** Runtime metadata for built-in partials (repeatable, alwaysSample). */
export const builtInPartialMetadata = extractPartialMetadata(builtInRegistry);

/** Error partial payload type. */
export type ErrorPartial = InferPartial<typeof error>;
/** log_message partial payload type. */
export type LogMessagePartial = InferPartial<typeof logMessage>;
/** span partial payload type. */
export type SpanPartial = InferPartial<typeof span>;
/** sloplog_usage_error partial payload type. */
export type SloplogUsageErrorPartial = InferPartial<typeof sloplogUsageError>;

/** Built-in partial registry shape. */
export type BuiltInRegistry = {
  error: ErrorPartial[];
  log_message: LogMessagePartial[];
  span: SpanPartial[];
  sloplog_usage_error: SloplogUsageErrorPartial[];
};

/** Union of built-in partial names. */
export type BuiltInPartialName = keyof BuiltInRegistry;
