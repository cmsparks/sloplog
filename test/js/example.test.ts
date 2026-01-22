import { describe, it, expect } from 'vitest';
import {
  wideEvent,
  cronOriginator,
  httpOriginator,
  partial,
  registry,
  z,
  tracingHeaders,
  extractTracingContext,
  ORIGINATOR_HEADER,
  TRACE_ID_HEADER,
  type Service,
  type HttpOriginator,
  type WideEventBase,
  type EventPartial,
  type LogCollectorClient,
  type TracingContext,
} from '../../js/index';
import { stdioCollector } from '../../js/collectors/stdio';
import { compositeCollector } from '../../js/collectors/composite';
import { filteredCollector } from '../../js/collectors/filtered';
import { fileCollector, type FileSystem } from '../../js/collectors/file';

const user = partial('user', {
  id: z.string(),
  name: z.string(),
});

const requestLog = partial('request', {
  method: z.string(),
  duration: z.number(),
});

const testRegistry = registry([user, requestLog]);

describe('WideEvent', () => {
  it('should create a wide event with eventId', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_TESTSPAN',
      timestamp: Date.now(),
      method: 'GET',
      path: '/',
      headers: {},
    };

    const evt = wideEvent(testRegistry, service, originator, collector);

    expect(evt.eventId).toMatch(/^evt_/);
    expect(evt.eventId.length).toBeGreaterThan(4);
  });

  it('should log partials and retrieve them via toLog', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service', version: '1.0.0' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_TESTSPAN',
      timestamp: Date.now(),
      method: 'POST',
      path: '/api/users',
      headers: { 'Content-Type': 'application/json' },
    };

    const evt = wideEvent(testRegistry, service, originator, collector);

    evt.log(user({ id: '123', name: 'John' }));
    evt.log(requestLog({ method: 'POST', duration: 150 }));

    const log = evt.toLog();

    expect(log.service.name).toBe('my-service');
    expect(log.service.version).toBe('1.0.0');
    expect(log.originator.type).toBe('http');
    expect(log.originator.originatorId).toBe('orig_TESTSPAN');
    expect(log.user).toEqual({ type: 'user', id: '123', name: 'John' });
    expect(log.request).toEqual({ type: 'request', method: 'POST', duration: 150 });
  });

  it('should flush event to collector', async () => {
    const flushedEvents: { base: WideEventBase; partials: Map<string, EventPartial<string>> }[] =
      [];

    const testCollector: LogCollectorClient = {
      async flush(base, partials) {
        flushedEvents.push({ base, partials });
      },
    };

    const service: Service = { name: 'test-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    const evt = wideEvent(testRegistry, service, originator, testCollector);
    evt.log(user({ id: 'user_1', name: 'Test User' }));

    await evt.flush();

    expect(flushedEvents).toHaveLength(1);
    expect(flushedEvents[0].base.service.name).toBe('test-service');
    expect(flushedEvents[0].base.originator.originatorId).toBe('orig_123');
    expect(flushedEvents[0].partials.get('user')).toEqual({
      type: 'user',
      id: 'user_1',
      name: 'Test User',
    });
  });

  it('should allow overwriting partials of the same type', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_TESTSPAN',
      timestamp: Date.now(),
      method: 'GET',
      path: '/',
    };

    const evt = wideEvent(testRegistry, service, originator, collector);

    evt.log(user({ id: '123', name: 'John' }));
    evt.log(user({ id: '456', name: 'Jane' }));

    const log = evt.toLog();

    expect(log.user).toEqual({ type: 'user', id: '456', name: 'Jane' });
  });

  it('partial and log methods should work the same', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_TESTSPAN',
      timestamp: Date.now(),
      method: 'GET',
      path: '/',
    };

    const evt1 = wideEvent(testRegistry, service, originator, collector);
    const evt2 = wideEvent(testRegistry, service, originator, collector);

    evt1.log(user({ id: '123', name: 'John' }));
    evt2.partial(user({ id: '123', name: 'John' }));

    expect(evt1.toLog().user).toEqual(evt2.toLog().user);
  });
});

describe('stdioCollector', () => {
  it('should implement LogCollectorClient interface', async () => {
    const collector = stdioCollector();

    expect(typeof collector.flush).toBe('function');
  });
});

describe('compositeCollector', () => {
  it('should flush to all collectors in parallel', async () => {
    const flushed1: WideEventBase[] = [];
    const flushed2: WideEventBase[] = [];

    const collector1: LogCollectorClient = {
      async flush(event) {
        flushed1.push(event);
      },
    };
    const collector2: LogCollectorClient = {
      async flush(event) {
        flushed2.push(event);
      },
    };

    const composite = compositeCollector([collector1, collector2]);

    const service: Service = { name: 'test-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    const evt = wideEvent(testRegistry, service, originator, composite);
    await evt.flush();

    expect(flushed1).toHaveLength(1);
    expect(flushed2).toHaveLength(1);
    expect(flushed1[0].eventId).toBe(flushed2[0].eventId);
  });
});

describe('filteredCollector', () => {
  it('should only flush events that pass the filter', async () => {
    const flushedEvents: WideEventBase[] = [];

    const innerCollector: LogCollectorClient = {
      async flush(event) {
        flushedEvents.push(event);
      },
    };

    // Only allow events from "allowed-service"
    const filtered = filteredCollector(
      innerCollector,
      (event) => event.service.name === 'allowed-service',
    );

    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    // This should be filtered out
    const evt1 = wideEvent(testRegistry, { name: 'blocked-service' }, originator, filtered);
    await evt1.flush();

    // This should pass through
    const evt2 = wideEvent(testRegistry, { name: 'allowed-service' }, originator, filtered);
    await evt2.flush();

    expect(flushedEvents).toHaveLength(1);
    expect(flushedEvents[0].service.name).toBe('allowed-service');
  });

  it('should have access to partials in filter function', async () => {
    const flushedEvents: WideEventBase[] = [];

    const innerCollector: LogCollectorClient = {
      async flush(event) {
        flushedEvents.push(event);
      },
    };

    // Only allow events with "error" partial
    const filtered = filteredCollector(innerCollector, (_event, partials) => partials.has('error'));

    const service: Service = { name: 'test-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    // This should be filtered out (no error partial)
    const evt1 = wideEvent(testRegistry, service, originator, filtered);
    evt1.log(user({ id: '123', name: 'John' }));
    await evt1.flush();

    expect(flushedEvents).toHaveLength(0);
  });
});

describe('fileCollector', () => {
  it('should buffer events and flush when buffer is full', async () => {
    const writtenData: string[] = [];

    const mockFs: FileSystem = {
      async appendFile(_path: string, data: string) {
        writtenData.push(data);
      },
    };

    const collector = fileCollector('/tmp/test.log', mockFs, { bufferSize: 2 });

    const service: Service = { name: 'test-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    const evt1 = wideEvent(testRegistry, service, originator, collector);
    await evt1.flush();

    // Buffer not full yet, nothing written
    expect(writtenData).toHaveLength(0);

    const evt2 = wideEvent(testRegistry, service, originator, collector);
    await evt2.flush();

    // Buffer full, should have flushed
    expect(writtenData).toHaveLength(1);
    expect(writtenData[0]).toContain('test-service');
    expect(writtenData[0].split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('should flush remaining buffer on close', async () => {
    const writtenData: string[] = [];

    const mockFs: FileSystem = {
      async appendFile(_path: string, data: string) {
        writtenData.push(data);
      },
    };

    const collector = fileCollector('/tmp/test.log', mockFs, { bufferSize: 10 });

    const service: Service = { name: 'test-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_123',
      timestamp: Date.now(),
      method: 'GET',
      path: '/test',
    };

    const evt = wideEvent(testRegistry, service, originator, collector);
    await evt.flush();

    // Buffer not full yet
    expect(writtenData).toHaveLength(0);

    // Force flush
    await collector.close();

    expect(writtenData).toHaveLength(1);
  });
});

describe('Originator Functions', () => {
  it('should create a cron originator', () => {
    const cron = cronOriginator('*/5 * * * *', 'cleanup-job');

    expect(cron.originatorId).toMatch(/^orig_/);
    expect(cron.type).toBe('cron');
    expect(cron.cron).toBe('*/5 * * * *');
    expect(cron.jobName).toBe('cleanup-job');
    expect(cron.timestamp).toBeGreaterThan(0);
  });

  it('should create a cron originator with parentId', () => {
    const cron = cronOriginator('*/5 * * * *', 'cleanup-job', { parentId: 'orig_parent123' });

    expect(cron.originatorId).toMatch(/^orig_/);
    expect(cron.parentId).toBe('orig_parent123');
  });

  it('should create an http originator with explicit parentId', () => {
    const request = new Request('https://api.example.com/users', {
      method: 'GET',
    });

    const { originator } = httpOriginator(request, { parentId: 'orig_parent456' });

    expect(originator.originatorId).toMatch(/^orig_/);
    expect(originator.parentId).toBe('orig_parent456');
  });
});

describe('Sensitive Data Redaction', () => {
  it('should redact authorization header', () => {
    const request = new Request('https://api.example.com/users', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer secret-token-12345',
        'Content-Type': 'application/json',
      },
    });

    const { originator } = httpOriginator(request);

    expect(originator.headers?.['authorization']).toBe('[REDACTED]');
    expect(originator.headers?.['content-type']).toBe('application/json');
  });

  it('should redact sensitive query parameters', () => {
    const request = new Request(
      'https://api.example.com/callback?code=auth-code-123&state=abc&token=secret-token',
      {
        method: 'GET',
      },
    );

    const { originator } = httpOriginator(request);

    expect(originator.query).toContain('code=%5BREDACTED%5D');
    expect(originator.query).toContain('token=%5BREDACTED%5D');
    expect(originator.query).toContain('state=abc');
  });

  it('should redact multiple sensitive headers', () => {
    const request = new Request('https://api.example.com/users', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'X-Api-Key': 'api-key-secret',
        Cookie: 'session=abc123',
        'Content-Type': 'application/json',
      },
    });

    const { originator } = httpOriginator(request);

    expect(originator.headers?.['authorization']).toBe('[REDACTED]');
    expect(originator.headers?.['x-api-key']).toBe('[REDACTED]');
    expect(originator.headers?.['cookie']).toBe('[REDACTED]');
    expect(originator.headers?.['content-type']).toBe('application/json');
  });

  it('should redact access_token and refresh_token query params', () => {
    const request = new Request(
      'https://api.example.com/oauth?access_token=secret1&refresh_token=secret2&client_id=public',
      {
        method: 'GET',
      },
    );

    const { originator } = httpOriginator(request);

    expect(originator.query).toContain('access_token=%5BREDACTED%5D');
    expect(originator.query).toContain('refresh_token=%5BREDACTED%5D');
    expect(originator.query).toContain('client_id=public');
  });
});

describe('Tracing Context', () => {
  it('should generate traceId for new requests', () => {
    const request = new Request('https://api.example.com/users', {
      method: 'GET',
    });

    const { originator, traceId } = httpOriginator(request);

    expect(traceId).toMatch(/^trace_/);
    expect(originator.originatorId).toMatch(/^orig_/);
    expect(originator.parentId).toBeUndefined();
  });

  it('should propagate traceId and set parentId from incoming headers', () => {
    const incomingTraceId = 'trace_upstream123';
    const incomingOriginatorId = 'orig_caller456';

    const request = new Request('https://api.example.com/users', {
      method: 'GET',
      headers: {
        [TRACE_ID_HEADER]: incomingTraceId,
        [ORIGINATOR_HEADER]: incomingOriginatorId,
      },
    });

    const { originator, traceId } = httpOriginator(request);

    // traceId should be propagated from the incoming header
    expect(traceId).toBe(incomingTraceId);
    // originatorId should be newly generated
    expect(originator.originatorId).toMatch(/^orig_/);
    expect(originator.originatorId).not.toBe(incomingOriginatorId);
    // parentId should be the incoming originatorId
    expect(originator.parentId).toBe(incomingOriginatorId);
  });

  it('should allow explicit parentId to override tracing context', () => {
    const incomingOriginatorId = 'orig_from_header';
    const explicitParentId = 'orig_explicit_parent';

    const request = new Request('https://api.example.com/users', {
      method: 'GET',
      headers: {
        [TRACE_ID_HEADER]: 'trace_test',
        [ORIGINATOR_HEADER]: incomingOriginatorId,
      },
    });

    const { originator } = httpOriginator(request, { parentId: explicitParentId });

    // Explicit parentId should take precedence
    expect(originator.parentId).toBe(explicitParentId);
  });

  it('should create tracing headers for downstream requests', () => {
    const context: TracingContext = {
      traceId: 'trace_myservice123',
      originatorId: 'orig_myoriginator456',
    };

    const headers = tracingHeaders(context);

    expect(headers[TRACE_ID_HEADER]).toBe('trace_myservice123');
    expect(headers[ORIGINATOR_HEADER]).toBe('orig_myoriginator456');
  });

  it('should extract tracing context from headers', () => {
    const headers = {
      [TRACE_ID_HEADER]: 'trace_test123',
      [ORIGINATOR_HEADER]: 'orig_test456',
    };

    const context = extractTracingContext(headers);

    expect(context).not.toBeNull();
    expect(context?.traceId).toBe('trace_test123');
    expect(context?.originatorId).toBe('orig_test456');
  });

  it('should return null when tracing headers are incomplete', () => {
    // Missing originator header
    expect(extractTracingContext({ [TRACE_ID_HEADER]: 'trace_test' })).toBeNull();
    // Missing trace ID header
    expect(extractTracingContext({ [ORIGINATOR_HEADER]: 'orig_test' })).toBeNull();
    // Empty headers
    expect(extractTracingContext({})).toBeNull();
  });

  it('should accept originator results and use their traceId', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const request = new Request('https://api.example.com/users', {
      headers: {
        [TRACE_ID_HEADER]: 'trace_from_request',
        [ORIGINATOR_HEADER]: 'orig_parent',
      },
    });

    const originatorResult = httpOriginator(request);
    const evt = wideEvent(testRegistry, service, originatorResult, collector);

    expect(evt.traceId).toBe(originatorResult.traceId);
    expect(evt.toLog().originator.originatorId).toBe(originatorResult.originator.originatorId);
  });

  it('should include traceId in WideEvent', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_test',
      timestamp: Date.now(),
      method: 'GET',
      path: '/',
    };

    const evt = wideEvent(testRegistry, service, originator, collector, {
      traceId: 'trace_custom123',
    });

    expect(evt.traceId).toBe('trace_custom123');
    const log = evt.toLog();
    expect(log.traceId).toBe('trace_custom123');
  });

  it('should generate traceId if not provided', () => {
    const collector = stdioCollector();
    const service: Service = { name: 'my-service' };
    const originator: HttpOriginator = {
      type: 'http',
      originatorId: 'orig_test',
      timestamp: Date.now(),
      method: 'GET',
      path: '/',
    };

    const evt = wideEvent(testRegistry, service, originator, collector);

    expect(evt.traceId).toMatch(/^trace_/);
  });
});
