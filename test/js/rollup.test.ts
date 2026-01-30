import { describe, it, expect } from 'vitest';
import {
  wideEvent,
  registry,
  partial,
  z,
  sum,
  min,
  max,
  count,
  histogram,
  flattenObject,
  stdioCollector,
  type Service,
  type HttpOriginator,
  type EventPartial,
  type LogCollectorClient,
  type SpanAggregation,
  type WideEventBase,
  type HistogramResult,
} from '../../js/index';
// Import agg directly from registry for testing custom aggregation functions
// Note: agg is not exported from main index to discourage custom agg fns in production
// (they wouldn't work in Python codegen)
import { agg } from '../../js/registry';
import { betterStackCollector } from '../../js/collectors/betterstack';
import { sentryCollector, type SentryLogger } from '../../js/collectors/sentry';

// Type-level tests: These should compile without errors
// The `agg` option only allows aggregation functions that match the field type

// This should work - durationMs is a number, sum/min/max/count take number[]
// Note: avg is intentionally NOT included because it doesn't compose in two-stage
// aggregation. Use sum + count and compute avg = sum/count at query time.
const _validNumericPartial = partial(
  'valid_numeric',
  { name: z.string(), durationMs: z.number() },
  { repeatable: true, agg: { durationMs: [sum, min, max, count] } },
);

// Custom string aggregation function - collects unique values
const uniqueValues = agg('unique', (values: string[]): string[] => [...new Set(values)]);

// This should work - endpoint is a string, uniqueValues takes string[]
const _validStringPartial = partial(
  'valid_string',
  { endpoint: z.string(), statusCode: z.number() },
  { repeatable: true, agg: { endpoint: [uniqueValues], statusCode: [sum] } },
);

// This should fail at compile time if uncommented (sum takes number[], not string[]):
// const _invalidPartial = partial(
//   'invalid',
//   { table: z.string(), durationMs: z.number() },
//   { repeatable: true, agg: { table: [sum] } },  // Error: sum expects number[], table is string
// );

describe('Span Rollups', () => {
  const testPartial = partial('test', { value: z.string() });
  const testRegistry = registry([testPartial]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  function createCollector() {
    let flushedPartials = new Map<string, EventPartial<string> | EventPartial<string>[]>();
    const collector: LogCollectorClient = {
      async flush(_base, partials) {
        flushedPartials = new Map(partials);
      },
    };
    return { collector, getPartials: () => flushedPartials };
  }

  it('should automatically compute span rollups on flush', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(testRegistry, service, originator, collector);

    // Create multiple spans with different names
    event.spanStart('db-query');
    event.spanEnd('db-query');

    event.spanStart('db-query');
    event.spanEnd('db-query');

    event.spanStart('api-call');
    event.spanEnd('api-call');

    await event.flush();

    const partials = getPartials();
    const spanAgg = partials.get('span.agg') as EventPartial<'span.agg'>;

    expect(spanAgg).toBeDefined();
    expect(spanAgg.type).toBe('span.agg');

    // Check db-query aggregation
    const dbQueryAgg = spanAgg['db-query'] as SpanAggregation;
    expect(dbQueryAgg).toBeDefined();
    expect(dbQueryAgg.count).toBe(2);
    expect(dbQueryAgg.duration.total).toBeGreaterThanOrEqual(0);
    expect(dbQueryAgg.duration.min).toBeGreaterThanOrEqual(0);
    expect(dbQueryAgg.duration.max).toBeGreaterThanOrEqual(0);

    // Check api-call aggregation
    const apiCallAgg = spanAgg['api-call'] as SpanAggregation;
    expect(apiCallAgg).toBeDefined();
    expect(apiCallAgg.count).toBe(1);
  });

  it('should compute correct aggregation statistics', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(testRegistry, service, originator, collector);

    // Create spans with known durations
    event.spanStart('timed-span');
    await new Promise((resolve) => setTimeout(resolve, 10));
    event.spanEnd('timed-span');

    event.spanStart('timed-span');
    await new Promise((resolve) => setTimeout(resolve, 20));
    event.spanEnd('timed-span');

    event.spanStart('timed-span');
    await new Promise((resolve) => setTimeout(resolve, 30));
    event.spanEnd('timed-span');

    await event.flush();

    const partials = getPartials();
    const spanAgg = partials.get('span.agg') as EventPartial<'span.agg'>;
    const timedSpanAgg = spanAgg['timed-span'] as SpanAggregation;

    expect(timedSpanAgg.count).toBe(3);
    expect(timedSpanAgg.duration.total).toBeGreaterThanOrEqual(60); // At least 10+20+30
    expect(timedSpanAgg.duration.min).toBeGreaterThanOrEqual(10);
    expect(timedSpanAgg.duration.max).toBeGreaterThanOrEqual(30);
  });

  it('should not create span.agg when no spans exist', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(testRegistry, service, originator, collector);

    event.partial(testPartial({ value: 'test' }));

    await event.flush();

    const partials = getPartials();
    expect(partials.has('span.agg')).toBe(false);
  });

  it('should preserve individual spans alongside rollups', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(testRegistry, service, originator, collector);

    event.spanStart('my-span');
    event.spanEnd('my-span');

    event.spanStart('my-span');
    event.spanEnd('my-span');

    await event.flush();

    const partials = getPartials();

    // Individual spans should still exist
    const spans = partials.get('span') as EventPartial<'span'>[];
    expect(spans).toHaveLength(2);

    // Rollup should also exist
    const spanAgg = partials.get('span.agg');
    expect(spanAgg).toBeDefined();
  });
});

describe('Partial Rollups', () => {
  const dbQuery = partial(
    'db_query',
    {
      table: z.string(),
      durationMs: z.number(),
      rowCount: z.number(),
    },
    {
      repeatable: true,
      agg: {
        // Note: avg is not included - it doesn't compose in two-stage aggregation
        // Use sum + count and compute avg = sum/count at query time
        durationMs: [sum, min, max, count],
        rowCount: [sum],
      },
    },
  );

  const apiCall = partial(
    'api_call',
    {
      endpoint: z.string(),
      statusCode: z.number(),
      latencyMs: z.number(),
    },
    {
      repeatable: true,
      agg: {
        // Use sum + count instead of avg for two-stage aggregation compatibility
        latencyMs: [sum, count, max],
      },
    },
  );

  const noRollupPartial = partial(
    'no_rollup',
    {
      value: z.number(),
    },
    {
      repeatable: true,
      // No agg config
    },
  );

  const rollupRegistry = registry([dbQuery, apiCall, noRollupPartial]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  function createCollector() {
    let flushedPartials = new Map<string, EventPartial<string> | EventPartial<string>[]>();
    const collector: LogCollectorClient = {
      async flush(_base, partials) {
        flushedPartials = new Map(partials);
      },
    };
    return { collector, getPartials: () => flushedPartials };
  }

  it('should compute opt-in partial rollups', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    event.partial(dbQuery({ table: 'users', durationMs: 10, rowCount: 100 }));
    event.partial(dbQuery({ table: 'orders', durationMs: 20, rowCount: 200 }));
    event.partial(dbQuery({ table: 'products', durationMs: 30, rowCount: 50 }));

    await event.flush();

    const partials = getPartials();
    const dbQueryAgg = partials.get('db_query.agg') as EventPartial<'db_query.agg'>;

    expect(dbQueryAgg).toBeDefined();
    expect(dbQueryAgg.type).toBe('db_query.agg');
    expect(dbQueryAgg.count).toBe(3);

    // Check durationMs aggregations
    // Note: avg is not computed - use sum/count to compute avg = sum/count at query time
    const durationAgg = dbQueryAgg.durationMs as Record<string, number>;
    expect(durationAgg.sum).toBe(60); // 10 + 20 + 30
    expect(durationAgg.count).toBe(3); // 3 partials
    expect(durationAgg.min).toBe(10);
    expect(durationAgg.max).toBe(30);

    // Check rowCount aggregations (only sum)
    const rowCountAgg = dbQueryAgg.rowCount as Record<string, number>;
    expect(rowCountAgg.sum).toBe(350); // 100 + 200 + 50
    expect(rowCountAgg.count).toBeUndefined();
    expect(rowCountAgg.min).toBeUndefined();
    expect(rowCountAgg.max).toBeUndefined();
  });

  it('should not create rollups for partials without rollup config', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    event.partial(noRollupPartial({ value: 10 }));
    event.partial(noRollupPartial({ value: 20 }));

    await event.flush();

    const partials = getPartials();

    // Individual partials should exist
    const noRollups = partials.get('no_rollup');
    expect(noRollups).toBeDefined();
    expect(Array.isArray(noRollups) && noRollups.length).toBe(2);

    // Rollup should NOT exist
    expect(partials.has('no_rollup.agg')).toBe(false);
  });

  it('should handle multiple partial types with different rollup configs', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    event.partial(dbQuery({ table: 'users', durationMs: 10, rowCount: 100 }));
    event.partial(apiCall({ endpoint: '/users', statusCode: 200, latencyMs: 50 }));
    event.partial(apiCall({ endpoint: '/orders', statusCode: 200, latencyMs: 100 }));

    await event.flush();

    const partials = getPartials();

    // db_query rollup
    const dbQueryAgg = partials.get('db_query.agg') as EventPartial<'db_query.agg'>;
    expect(dbQueryAgg).toBeDefined();
    expect(dbQueryAgg.count).toBe(1);

    // api_call rollup
    const apiCallAgg = partials.get('api_call.agg') as EventPartial<'api_call.agg'>;
    expect(apiCallAgg).toBeDefined();
    expect(apiCallAgg.count).toBe(2);
    const latencyAgg = apiCallAgg.latencyMs as Record<string, number>;
    expect(latencyAgg.sum).toBe(150); // 50 + 100
    expect(latencyAgg.count).toBe(2); // Can compute avg = sum/count = 75 at query time
    expect(latencyAgg.max).toBe(100);
    expect(latencyAgg.min).toBeUndefined(); // Not configured
  });

  it('should only compute configured aggregations', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    event.partial(apiCall({ endpoint: '/test', statusCode: 200, latencyMs: 100 }));

    await event.flush();

    const partials = getPartials();
    const apiCallAgg = partials.get('api_call.agg') as EventPartial<'api_call.agg'>;
    const latencyAgg = apiCallAgg.latencyMs as Record<string, number>;

    // Only sum, count, and max are configured
    expect(latencyAgg.sum).toBe(100);
    expect(latencyAgg.count).toBe(1);
    expect(latencyAgg.max).toBe(100);

    // These should not exist
    expect(latencyAgg.min).toBeUndefined();
  });

  it('should always include count in rollups', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    event.partial(dbQuery({ table: 'test', durationMs: 10, rowCount: 10 }));
    event.partial(dbQuery({ table: 'test', durationMs: 20, rowCount: 20 }));

    await event.flush();

    const partials = getPartials();
    const dbQueryAgg = partials.get('db_query.agg') as EventPartial<'db_query.agg'>;

    // Count should always be present at the top level
    expect(dbQueryAgg.count).toBe(2);
  });

  it('should handle empty partials array gracefully', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(rollupRegistry, service, originator, collector);

    // Don't add any partials

    await event.flush();

    const partials = getPartials();
    expect(partials.has('db_query.agg')).toBe(false);
    expect(partials.has('api_call.agg')).toBe(false);
  });
});

describe('Histogram Aggregation', () => {
  const apiLatency = partial(
    'api_latency',
    {
      endpoint: z.string(),
      latencyMs: z.number(),
    },
    {
      repeatable: true,
      agg: {
        latencyMs: [sum, min, max, histogram([10, 50, 100, 250, 500, 1000])],
      },
    },
  );

  const histogramRegistry = registry([apiLatency]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  function createCollector() {
    let flushedPartials = new Map<string, EventPartial<string> | EventPartial<string>[]>();
    const collector: LogCollectorClient = {
      async flush(_base, partials) {
        flushedPartials = new Map(partials);
      },
    };
    return { collector, getPartials: () => flushedPartials };
  }

  it('should compute histogram buckets with cumulative counts', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(histogramRegistry, service, originator, collector);

    // Add API latencies: 5ms, 15ms, 75ms, 150ms, 600ms
    event.partial(apiLatency({ endpoint: '/fast', latencyMs: 5 }));
    event.partial(apiLatency({ endpoint: '/medium1', latencyMs: 15 }));
    event.partial(apiLatency({ endpoint: '/medium2', latencyMs: 75 }));
    event.partial(apiLatency({ endpoint: '/slow1', latencyMs: 150 }));
    event.partial(apiLatency({ endpoint: '/slow2', latencyMs: 600 }));

    await event.flush();

    const partials = getPartials();
    const agg = partials.get('api_latency.agg') as EventPartial<'api_latency.agg'>;

    expect(agg).toBeDefined();
    expect(agg.count).toBe(5);

    const latencyAgg = agg.latencyMs as {
      sum: number;
      min: number;
      max: number;
      histogram: HistogramResult;
    };

    // Check standard aggregations
    expect(latencyAgg.sum).toBe(5 + 15 + 75 + 150 + 600);
    expect(latencyAgg.min).toBe(5);
    expect(latencyAgg.max).toBe(600);

    // Check histogram buckets (cumulative)
    const hist = latencyAgg.histogram;
    expect(hist['10']).toBe(1); // 5ms <= 10
    expect(hist['50']).toBe(2); // 5ms, 15ms <= 50
    expect(hist['100']).toBe(3); // 5ms, 15ms, 75ms <= 100
    expect(hist['250']).toBe(4); // 5ms, 15ms, 75ms, 150ms <= 250
    expect(hist['500']).toBe(4); // same as above
    expect(hist['1000']).toBe(5); // all values <= 1000
    expect(hist['inf']).toBe(5); // total count
  });

  it('should handle empty values gracefully', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(histogramRegistry, service, originator, collector);

    // Don't add any partials

    await event.flush();

    const partials = getPartials();
    expect(partials.has('api_latency.agg')).toBe(false);
  });

  it('should produce flat keys when histogram is flattened', async () => {
    let flushedEvent: Record<string, unknown> = {};
    const collector: LogCollectorClient = {
      async flush(base, partials) {
        const partialsObj: Record<string, unknown> = {};
        for (const [key, value] of partials) {
          partialsObj[key] = value;
        }
        flushedEvent = { ...base, ...partialsObj };
      },
    };

    const event = wideEvent(histogramRegistry, service, originator, collector);

    event.partial(apiLatency({ endpoint: '/test', latencyMs: 25 }));
    event.partial(apiLatency({ endpoint: '/test', latencyMs: 75 }));

    await event.flush();

    const flattened = flattenObject(flushedEvent);

    // Histogram buckets should flatten to queryable keys
    expect(flattened['api_latency.agg.latencyMs.histogram.10']).toBe(0);
    expect(flattened['api_latency.agg.latencyMs.histogram.50']).toBe(1);
    expect(flattened['api_latency.agg.latencyMs.histogram.100']).toBe(2);
    expect(flattened['api_latency.agg.latencyMs.histogram.inf']).toBe(2);
  });

  it('should allow different bucket configurations for different partials', async () => {
    // Define a partial with different bucket boundaries
    const dbQuery = partial(
      'db_query',
      {
        query: z.string(),
        durationMs: z.number(),
      },
      {
        repeatable: true,
        agg: {
          // Tighter buckets for database queries
          durationMs: [histogram([1, 5, 10, 25, 50])],
        },
      },
    );

    const mixedRegistry = registry([apiLatency, dbQuery]);
    const { collector, getPartials } = createCollector();
    const event = wideEvent(mixedRegistry, service, originator, collector);

    event.partial(apiLatency({ endpoint: '/api', latencyMs: 100 }));
    event.partial(dbQuery({ query: 'SELECT *', durationMs: 3 }));

    await event.flush();

    const partials = getPartials();

    // API latency uses [10, 50, 100, 250, 500, 1000]
    const apiAgg = partials.get('api_latency.agg') as EventPartial<string>;
    const apiHist = (apiAgg.latencyMs as { histogram: HistogramResult }).histogram;
    expect(apiHist['100']).toBe(1);
    expect(apiHist['250']).toBe(1);

    // DB query uses [1, 5, 10, 25, 50]
    const dbAgg = partials.get('db_query.agg') as EventPartial<string>;
    const dbHist = (dbAgg.durationMs as { histogram: HistogramResult }).histogram;
    expect(dbHist['1']).toBe(0);
    expect(dbHist['5']).toBe(1);
    expect(dbHist['10']).toBe(1);
    expect(dbHist['inf']).toBe(1);
  });
});

describe('Combined Span and Partial Rollups', () => {
  const dbQuery = partial(
    'db_query',
    {
      table: z.string(),
      durationMs: z.number(),
    },
    {
      repeatable: true,
      agg: {
        durationMs: [sum, count],
      },
    },
  );

  const combinedRegistry = registry([dbQuery]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  function createCollector() {
    let flushedPartials = new Map<string, EventPartial<string> | EventPartial<string>[]>();
    const collector: LogCollectorClient = {
      async flush(_base, partials) {
        flushedPartials = new Map(partials);
      },
    };
    return { collector, getPartials: () => flushedPartials };
  }

  it('should compute both span and partial rollups in same event', async () => {
    const { collector, getPartials } = createCollector();
    const event = wideEvent(combinedRegistry, service, originator, collector);

    // Add spans
    event.spanStart('request-handling');
    event.spanEnd('request-handling');

    event.spanStart('request-handling');
    event.spanEnd('request-handling');

    // Add db_query partials
    event.partial(dbQuery({ table: 'users', durationMs: 10 }));
    event.partial(dbQuery({ table: 'orders', durationMs: 20 }));

    await event.flush();

    const partials = getPartials();

    // Check span rollups
    const spanAgg = partials.get('span.agg') as EventPartial<'span.agg'>;
    expect(spanAgg).toBeDefined();
    expect((spanAgg['request-handling'] as SpanAggregation).count).toBe(2);

    // Check db_query rollups
    const dbQueryAgg = partials.get('db_query.agg') as EventPartial<'db_query.agg'>;
    expect(dbQueryAgg).toBeDefined();
    expect(dbQueryAgg.count).toBe(2);
    expect((dbQueryAgg.durationMs as Record<string, number>).sum).toBe(30);
    expect((dbQueryAgg.durationMs as Record<string, number>).count).toBe(2);
  });
});

describe('Flattening with Aggregations', () => {
  const dbQuery = partial(
    'db_query',
    {
      table: z.string(),
      durationMs: z.number(),
    },
    {
      repeatable: true,
      agg: {
        durationMs: [sum, count],
      },
    },
  );

  const flattenRegistry = registry([dbQuery]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  it('should flatten without key collisions between array indices and .agg keys', async () => {
    let flushedEvent: Record<string, unknown> = {};
    const collector: LogCollectorClient = {
      async flush(base, partials) {
        const partialsObj: Record<string, unknown> = {};
        for (const [key, value] of partials) {
          partialsObj[key] = value;
        }
        flushedEvent = { ...base, ...partialsObj };
      },
    };

    const event = wideEvent(flattenRegistry, service, originator, collector);

    // Add spans
    event.spanStart('db');
    event.spanEnd('db');
    event.spanStart('db');
    event.spanEnd('db');

    // Add db_query partials
    event.partial(dbQuery({ table: 'users', durationMs: 10 }));
    event.partial(dbQuery({ table: 'orders', durationMs: 20 }));

    await event.flush();

    // Verify raw structure before flattening
    expect(Array.isArray(flushedEvent.span)).toBe(true);
    expect(Array.isArray(flushedEvent.db_query)).toBe(true);
    expect(typeof flushedEvent['span.agg']).toBe('object');
    expect(typeof flushedEvent['db_query.agg']).toBe('object');

    // Now flatten and verify no collisions
    const flattened = flattenObject(flushedEvent);

    // Array items get numeric indices: span.0.name, span.1.name
    expect(flattened['span.0.name']).toBe('db');
    expect(flattened['span.1.name']).toBe('db');
    expect(flattened['span.0.durationMs']).toBeGreaterThanOrEqual(0);
    expect(flattened['span.1.durationMs']).toBeGreaterThanOrEqual(0);

    // Agg object uses dot notation: span.agg.db.count
    expect(flattened['span.agg.type']).toBe('span.agg');
    expect(flattened['span.agg.db.count']).toBe(2);
    expect(flattened['span.agg.db.duration.total']).toBeGreaterThanOrEqual(0);

    // db_query array: db_query.0.table, db_query.1.table
    expect(flattened['db_query.0.table']).toBe('users');
    expect(flattened['db_query.1.table']).toBe('orders');
    expect(flattened['db_query.0.durationMs']).toBe(10);
    expect(flattened['db_query.1.durationMs']).toBe(20);

    // db_query.agg: db_query.agg.count, db_query.agg.durationMs.sum
    expect(flattened['db_query.agg.type']).toBe('db_query.agg');
    expect(flattened['db_query.agg.count']).toBe(2);
    expect(flattened['db_query.agg.durationMs.sum']).toBe(30);
    expect(flattened['db_query.agg.durationMs.count']).toBe(2);

    // Verify NO collisions - span.0 vs span.agg are distinct
    // The key "span.agg" flattens to "span.agg.X" not "span.agg"
    // The key "span" (array) flattens to "span.0.X", "span.1.X"
    // These don't collide because:
    // - span.0, span.1 are numeric
    // - span.agg is the literal key from the partials map
  });
});

describe('Collector Integration with Aggregations', () => {
  const dbQuery = partial(
    'db_query',
    {
      table: z.string(),
      durationMs: z.number(),
    },
    {
      repeatable: true,
      agg: {
        durationMs: [sum, count],
      },
    },
  );

  const collectorRegistry = registry([dbQuery]);

  const service: Service = { name: 'test-service' };
  const originator: HttpOriginator = {
    type: 'http',
    originatorId: 'orig_test',
    timestamp: Date.now(),
    method: 'GET',
    path: '/test',
  };

  it('should work with stdioCollector (nested JSON)', async () => {
    // Capture console.log output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const collector = stdioCollector({ prettyPrint: false });
      const event = wideEvent(collectorRegistry, service, originator, collector);

      event.spanStart('query');
      event.spanEnd('query');
      event.partial(dbQuery({ table: 'users', durationMs: 10 }));

      await event.flush();

      expect(logs.length).toBe(1);
      const output = JSON.parse(logs[0].replace('[wide-event] ', ''));

      // Verify nested structure
      expect(Array.isArray(output.span)).toBe(true);
      expect(output.span[0].name).toBe('query');
      expect(output['span.agg']).toBeDefined();
      expect(output['span.agg'].query.count).toBe(1);

      expect(Array.isArray(output.db_query)).toBe(true);
      expect(output['db_query.agg']).toBeDefined();
      expect(output['db_query.agg'].count).toBe(1);
      expect(output['db_query.agg'].durationMs.sum).toBe(10);
    } finally {
      console.log = originalLog;
    }
  });

  it('should work with betterStackCollector (nested JSON batch)', async () => {
    const batches: object[][] = [];
    const mockFetch = async (_url: string, options: { body: string }) => {
      batches.push(JSON.parse(options.body));
      return new Response('ok');
    };

    const collector = betterStackCollector({
      sourceToken: 'test-token',
      bufferSize: 1, // Flush immediately
      fetch: mockFetch as typeof fetch,
    });

    const event = wideEvent(collectorRegistry, service, originator, collector);

    event.spanStart('api');
    event.spanEnd('api');
    event.partial(dbQuery({ table: 'orders', durationMs: 20 }));

    await event.flush();

    expect(batches.length).toBe(1);
    const batch = batches[0];
    expect(batch.length).toBe(1);

    const output = batch[0] as Record<string, unknown>;

    // Verify nested structure preserved
    expect(Array.isArray(output.span)).toBe(true);
    expect(output['span.agg']).toBeDefined();
    expect(Array.isArray(output.db_query)).toBe(true);
    expect(output['db_query.agg']).toBeDefined();
  });

  it('should work with sentryCollector (flattened attributes)', async () => {
    const loggedMessages: { level: string; message: string; attributes: Record<string, unknown> }[] =
      [];

    const mockLogger: SentryLogger = {
      info: (message: string, attributes?: Record<string, unknown>) => {
        loggedMessages.push({ level: 'info', message, attributes: attributes ?? {} });
      },
    };

    const collector = sentryCollector({
      logger: mockLogger,
      flattenAttributes: true,
    });

    const event = wideEvent(collectorRegistry, service, originator, collector);

    event.spanStart('render');
    event.spanEnd('render');
    event.partial(dbQuery({ table: 'products', durationMs: 15 }));

    await event.flush();

    expect(loggedMessages.length).toBe(1);
    const { attributes } = loggedMessages[0];

    // Verify flattened keys
    expect(attributes['span.0.name']).toBe('render');
    expect(attributes['span.agg.type']).toBe('span.agg');
    expect(attributes['span.agg.render.count']).toBe(1);

    expect(attributes['db_query.0.table']).toBe('products');
    expect(attributes['db_query.agg.type']).toBe('db_query.agg');
    expect(attributes['db_query.agg.count']).toBe(1);
    expect(attributes['db_query.agg.durationMs.sum']).toBe(15);
    expect(attributes['db_query.agg.durationMs.count']).toBe(1);
  });

  it('should work with sentryCollector without flattening', async () => {
    const loggedMessages: { level: string; message: string; attributes: Record<string, unknown> }[] =
      [];

    const mockLogger: SentryLogger = {
      info: (message: string, attributes?: Record<string, unknown>) => {
        loggedMessages.push({ level: 'info', message, attributes: attributes ?? {} });
      },
    };

    const collector = sentryCollector({
      logger: mockLogger,
      flattenAttributes: false,
    });

    const event = wideEvent(collectorRegistry, service, originator, collector);

    event.spanStart('compute');
    event.spanEnd('compute');
    event.partial(dbQuery({ table: 'cache', durationMs: 5 }));

    await event.flush();

    expect(loggedMessages.length).toBe(1);
    const { attributes } = loggedMessages[0];

    // Verify nested structure
    expect(Array.isArray(attributes.span)).toBe(true);
    expect((attributes.span as unknown[])[0]).toMatchObject({ name: 'compute' });
    expect(attributes['span.agg']).toBeDefined();

    expect(Array.isArray(attributes.db_query)).toBe(true);
    expect(attributes['db_query.agg']).toBeDefined();
  });
});
