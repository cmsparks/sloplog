import { z, type ZodObject, type ZodRawShape } from 'zod';

// Re-export z for schema definitions
export { z };

// Allowed primitive Zod types for partials
type AllowedZodPrimitive =
  | z.ZodString
  | z.ZodNumber
  | z.ZodBoolean
  | z.ZodEnum<Record<string, string>>;

// Allowed types: primitives, arrays of primitives, or optional versions
type AllowedZodType =
  | AllowedZodPrimitive
  | z.ZodArray<AllowedZodPrimitive>
  | z.ZodOptional<AllowedZodPrimitive>
  | z.ZodOptional<z.ZodArray<AllowedZodPrimitive>>;

// Constraint type to ensure schema only uses allowed types
type AllowedShape = {
  [key: string]: AllowedZodType;
};

/**
 * An aggregation function that takes an array of values and produces a single aggregated result.
 * The name property is used as the key in the output (e.g., 'sum', 'avg').
 *
 * @template V The input value type (from partial field)
 * @template A The output aggregation type
 */
export interface AggFn<V, A> {
  /** Name used as key in aggregation output */
  readonly name: string;
  /** Optional configuration (e.g., histogram buckets) for serialization */
  readonly config?: unknown;
  /** Compute aggregation from array of values */
  (values: V[]): A;
}

/**
 * Create a named aggregation function.
 * Use this to define custom aggregation functions.
 *
 * @param name - The key used in aggregation output (e.g., 'sum', 'unique', 'median')
 * @param fn - The aggregation function that takes an array of values and returns the aggregated result
 *
 * @example
 * ```ts
 * import { agg } from 'sloplog';
 *
 * // Custom string aggregation - collect unique values
 * const unique = agg('unique', (values: string[]) => [...new Set(values)]);
 *
 * // Custom numeric aggregation - compute median
 * const median = agg('median', (values: number[]) => {
 *   const sorted = [...values].sort((a, b) => a - b);
 *   const mid = Math.floor(sorted.length / 2);
 *   return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
 * });
 * ```
 */
export function agg<V, A>(name: string, fn: (values: V[]) => A): AggFn<V, A> {
  const aggFn = fn as AggFn<V, A>;
  Object.defineProperty(aggFn, 'name', { value: name, configurable: true, writable: false });
  return aggFn;
}

/**
 * Sum aggregation - computes the sum of all numeric values.
 */
export const sum: AggFn<number, number> = agg(
  'sum',
  (values: number[]): number => values.reduce((a, b) => a + b, 0),
);

/**
 * Minimum aggregation - finds the smallest numeric value.
 */
export const min: AggFn<number, number> = agg(
  'min',
  (values: number[]): number => (values.length === 0 ? 0 : Math.min(...values)),
);

/**
 * Maximum aggregation - finds the largest numeric value.
 */
export const max: AggFn<number, number> = agg(
  'max',
  (values: number[]): number => (values.length === 0 ? 0 : Math.max(...values)),
);

/**
 * Count aggregation - counts the number of values.
 */
export const count: AggFn<unknown, number> = agg(
  'count',
  (values: unknown[]): number => values.length,
);

/**
 * Default bucket boundaries for latency histograms (in milliseconds).
 * Based on Prometheus default buckets, suitable for HTTP request latencies.
 */
export const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Histogram bucket result type.
 * Each key is a bucket boundary (as string) with the cumulative count of values <= that boundary.
 * The 'inf' key contains the total count.
 */
export type HistogramResult = Record<string, number>;

/**
 * Create a histogram aggregation function with custom bucket boundaries.
 *
 * Histograms are useful for computing percentiles in two-stage aggregation scenarios.
 * Unlike raw values or exact percentiles, histogram bucket counts are additive across
 * multiple events, allowing accurate percentile estimation at query time.
 *
 * The histogram uses cumulative bucket counts (Prometheus-style), where each bucket
 * contains the count of all values less than or equal to that boundary.
 *
 * @param buckets - Array of numeric bucket boundaries (exclusive upper bounds).
 *                  Values will be counted into buckets where value <= boundary.
 *                  An implicit +Infinity bucket is always added.
 *
 * @example
 * ```ts
 * import { histogram, partial, z } from 'sloplog';
 *
 * // Create a histogram for API latencies
 * const latencyHistogram = histogram([10, 50, 100, 250, 500, 1000]);
 *
 * const apiCall = partial('api_call', {
 *   endpoint: z.string(),
 *   latencyMs: z.number(),
 * }, {
 *   repeatable: true,
 *   agg: {
 *     latencyMs: [sum, latencyHistogram],
 *   },
 * });
 *
 * // Produces output like:
 * // api_call.agg.latencyMs.histogram = {
 * //   "10": 2,    // 2 requests <= 10ms
 * //   "50": 5,    // 5 requests <= 50ms
 * //   "100": 8,   // 8 requests <= 100ms
 * //   ...
 * //   "inf": 10   // 10 total requests
 * // }
 * ```
 *
 * At query time, sum bucket counts across events and compute percentiles:
 * ```sql
 * SELECT
 *   SUM("api_call.agg.latencyMs.histogram.100") as le_100,
 *   SUM("api_call.agg.latencyMs.histogram.inf") as total
 * FROM events
 * -- Then interpolate to find p95, p99, etc.
 * ```
 */
export function histogram(buckets: number[] = DEFAULT_HISTOGRAM_BUCKETS): AggFn<number, HistogramResult> {
  // Sort buckets to ensure correct cumulative counting
  const sortedBuckets = [...buckets].sort((a, b) => a - b);

  const aggFn = agg('histogram', (values: number[]): HistogramResult => {
    const result: HistogramResult = {};

    // Cumulative counts (Prometheus style): count of values <= boundary
    for (const boundary of sortedBuckets) {
      result[String(boundary)] = values.filter(v => v <= boundary).length;
    }

    // Always include +Infinity bucket (total count)
    result['inf'] = values.length;

    return result;
  });

  // Store buckets in config for serialization (used by codegen)
  Object.defineProperty(aggFn, 'config', {
    value: { buckets: sortedBuckets },
    configurable: true,
    writable: false,
  });

  return aggFn;
}

/**
 * Aggregation function for numeric fields.
 */
export type NumericAggFn = AggFn<number, number>;

/**
 * Aggregation function for string fields.
 */
export type StringAggFn = AggFn<string, unknown>;

/**
 * Aggregation function for boolean fields.
 */
export type BooleanAggFn = AggFn<boolean, unknown>;

/**
 * Aggregation configuration for a repeatable partial.
 * Maps field names to arrays of aggregation functions.
 * The aggregation functions must accept the field's value type.
 * Count is always included automatically at the top level.
 *
 * @example
 * ```ts
 * import { sum, avg, max, partial } from 'sloplog';
 *
 * const dbQuery = partial('db_query', {
 *   table: z.string(),
 *   durationMs: z.number(),
 *   rowCount: z.number(),
 * }, {
 *   repeatable: true,
 *   agg: {
 *     durationMs: [sum, avg, max],  // Only numeric agg fns allowed
 *     rowCount: [sum],
 *   },
 * });
 * // Produces: db_query.agg.count, db_query.agg.durationMs.sum, db_query.agg.durationMs.avg, etc.
 * ```
 */
export type AggConfig<S extends ZodRawShape> = {
  [K in keyof S]?: AggFn<z.infer<S[K]>, unknown>[];
};

/**
 * Options for defining a partial
 */
export interface PartialOptions {
  /**
   * If true, multiple instances of this partial can be attached to a single wide event.
   * The partial will be stored as an array in the final log.
   * @default false
   */
  repeatable?: boolean;
  /**
   * If true, adding this partial to an event will mark the event to always be sampled.
   * Useful for error partials or other critical events that should never be dropped.
   * @default false
   */
  alwaysSample?: boolean;
  /**
   * Optional description used for generated docs and schemas.
   */
  description?: string;
}

/**
 * Options for defining a partial with aggregation support.
 * Extends PartialOptions with type-safe aggregation configuration.
 */
export interface PartialOptionsWithAgg<S extends ZodRawShape> extends PartialOptions {
  /**
   * Aggregation configuration for repeatable partials.
   * Maps field names to arrays of aggregation functions.
   * Only valid for repeatable partials with numeric fields.
   * Count is always included automatically when agg is enabled.
   *
   * @example
   * ```ts
   * agg: {
   *   durationMs: [sum, avg, max],
   *   rowCount: [sum],
   * }
   * ```
   */
  agg?: AggConfig<S>;
}

// Partial definition with Zod schema
export interface PartialDefinition<
  T extends string,
  S extends ZodRawShape,
  O extends PartialOptions = PartialOptions,
> {
  /** Partial type discriminator */
  name: T;
  /** Zod schema for the partial payload */
  schema: ZodObject<S>;
  /** Repeatable and sampling behavior */
  options: O;
}

// Registry of all partials
export interface Registry<T extends PartialDefinition<string, ZodRawShape, PartialOptions>[]> {
  /** List of partial definitions that make up this registry */
  partials: T;
}

/**
 * Runtime aggregation config stored in metadata.
 * Maps field names to arrays of aggregation functions.
 */
export type RuntimeAggConfig = Record<string, AggFn<unknown, unknown>[]>;

/**
 * Runtime metadata about partials, extracted from the registry for use by WideEvent
 */
export interface PartialMetadata {
  /** Whether this partial may appear multiple times */
  repeatable: boolean;
  /** Whether this partial forces alwaysSample for the event */
  alwaysSample: boolean;
  /** Optional aggregation configuration for repeatable partials */
  agg?: RuntimeAggConfig;
}

/**
 * Callable partial definition that creates a partial payload from input data.
 */
export type PartialFactory<
  T extends string,
  S extends ZodRawShape,
  O extends PartialOptions = PartialOptions,
> = PartialDefinition<T, S, O> & {
  (data: z.input<ZodObject<S>>): z.infer<ZodObject<S>> & { type: T };
};

/**
 * Define a partial with a name and Zod schema
 * Only allows: z.string(), z.number(), z.boolean(), and their arrays/optionals
 *
 * @param name - The unique name/type discriminator for this partial
 * @param schema - Zod schema defining the partial's fields
 * @param options - Optional configuration for repeatable, alwaysSample, and aggregation
 */
export function partial<T extends string, S extends AllowedShape>(
  name: T,
  schema: S,
  options: PartialOptionsWithAgg<S> = {},
): PartialFactory<T, S, PartialOptionsWithAgg<S>> {
  const objectSchema = z.object(schema);
  const describedSchema = options.description
    ? objectSchema.describe(options.description)
    : objectSchema;

  const factory = ((data: z.input<ZodObject<S>>) => {
    const parsed = describedSchema.parse(data);
    return { type: name, ...parsed } as z.infer<ZodObject<S>> & { type: T };
  }) as PartialFactory<T, S, PartialOptionsWithAgg<S>>;

  Object.defineProperty(factory, 'name', { value: name, configurable: true });
  factory.schema = describedSchema;
  factory.options = options;

  return factory;
}

/**
 * Create a registry of partials
 */
export function registry<T extends PartialDefinition<string, ZodRawShape, PartialOptions>[]>(
  partials: T,
): Registry<T> {
  return { partials };
}

/**
 * Extract runtime metadata from a registry for use by WideEvent
 */
export function extractPartialMetadata(
  reg: Registry<PartialDefinition<string, ZodRawShape, PartialOptions>[]>,
): Map<string, PartialMetadata> {
  const metadata = new Map<string, PartialMetadata>();
  for (const partial of reg.partials) {
    const options = partial.options as PartialOptionsWithAgg<ZodRawShape>;
    metadata.set(partial.name, {
      repeatable: options.repeatable ?? false,
      alwaysSample: options.alwaysSample ?? false,
      agg: options.agg as RuntimeAggConfig | undefined,
    });
  }
  return metadata;
}

/**
 * Infer the TypeScript type from a partial definition
 */
export type InferPartial<T extends PartialDefinition<string, ZodRawShape>> = z.infer<
  T['schema']
> & { type: T['name'] };

type PartialValueFor<P extends PartialDefinition<string, ZodRawShape, PartialOptions>> =
  P['options'] extends { repeatable: true } ? InferPartial<P>[] : InferPartial<P>;

/**
 * Infer the registry log shape from a registry definition.
 */
export type RegistryType<
  T extends Registry<PartialDefinition<string, ZodRawShape, PartialOptions>[]>,
> = {
  [P in T['partials'][number] as P['name']]: PartialValueFor<P>;
};
