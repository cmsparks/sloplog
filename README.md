# sloplog - A python and typescript library for constructing wide events

When constructing wide events for my services, I've found myself constructing essentially the same library again and again. I end up constructing a mediocre semi-structured wide event library.

The core idea is taken from a wide array of prior art (see below) on wide events. We have structured logs which will eventually be queried. The structured logging part isn't particularly hard, but I've found that it's nice to have a single place where my log structure is defined.

## Quick start (TypeScript)

```ts
import { partial, registry, z, service, wideEvent, httpOriginator } from 'sloplog';
import { stdioCollector } from 'sloplog/collectors/stdio';

const user = partial('user', {
  id: z.string(),
  tier: z.enum(['free', 'pro']),
});

const request = partial('request', {
  method: z.string(),
  durationMs: z.number(),
});

const reg = registry([user, request]);

const collector = stdioCollector();
const originator = httpOriginator(new Request('https://example.com'));

const evt = wideEvent(reg, service({ name: 'my-service' }), originator, collector);

evt.partial(user({ id: 'user_123', tier: 'pro' }));
evt.log(request({ method: 'GET', durationMs: 120 }));
evt.log('cache miss', { key: 'user_123' }, 'warn');
evt.error(new Error('boom'));
await evt.flush();
```

## Quick start (Python)

```py
import asyncio
from sloplog import service, wideevent, cron_originator
from sloplog.collectors import stdio_collector

async def main() -> None:
    collector = stdio_collector()
    originator = cron_originator("*/5 * * * *", "cleanup-job")
    evt = wideevent(service({"name": "my-service"}), originator, collector)

    evt.log("cache miss", {"key": "user_123"}, "warn")
    evt.error(Exception("boom"))
    evt.span("refresh-cache", lambda: None)
    await evt.flush()

asyncio.run(main())
```

## The structure of a sloplog WideEvent

Each wide event includes:

1. WideEventBase: `eventId`, `traceId`, `service`, and `originator`
2. WideEventPartials: structured payloads keyed by partial type

Partials are defined up front to keep fields consistent across services. A wide event log
will look like:

```ts
const evt = {
  eventId: 'evt_...',
  traceId: 'trace_...',
  service: {
    name: 'my-rest-service',
    version: '1.0.0',
    sloplogVersion: '0.0.3',
    sloplogLanguage: 'typescript',
    pod_id: 'v8a4ad',
  },
  originator: {
    type: 'http',
    originatorId: 'orig_...',
    method: 'POST',
    path: '/foo',
  },
  user: { type: 'user', id: 'user_123', tier: 'pro' },
  request: { type: 'request', method: 'POST', durationMs: 120 },
};
```

## Collectors

Collectors flush wide event logs. The goal is that you can adapt the format and flush the logs wherever you want. Import collectors via subpaths, e.g.:

```ts
/**
 * Simple collector to log the event in the console
 */
import { stdioCollector } from 'sloplog/collectors/stdio';

const collector = stdioCollector();
```

Python:

```py
from sloplog.collectors import stdio_collector

collector = stdio_collector()
```

Included collectors: `stdio`, `file`, `composite`, `filtered`, `betterstack`, `sentry` (requires optional `@sentry/node` peer dependency).

### WideEventBase

The WideEventBase type contains:

1. `eventId`, which uniquely identifies your event
2. `traceId`, which stays constant across a distributed trace
3. `originator`, an external thing that triggered your service (HTTP request, cron trigger, etc)
4. `service`, where an event is emitted from (use `service()` to add sloplog defaults)

`httpOriginator()` returns `{ originator, traceId }`. You can pass that object directly to `wideEvent()` and the trace ID will be picked up automatically. In Python, `starlette_http_originator()` and `flask_http_originator()` return `{ originator, trace_id }` and can be passed directly to `wideevent()`.

### WideEventPartial

Partials are added to a WideEvent via:

- `event.partial(partial)` for structured partials
- `event.log(partial)` as an alias for `partial()`
- `event.log("message", data?, level?)` to emit `log_message` (level defaults to `info`, data is JSON-stringified)
- `event.error(error)` to emit an `error` partial
- `event.span(name, fn)` / `event.spanStart(name)` / `event.spanEnd(name)`

Partials are always preferred over `log_message` for structured data. Usage errors (partial overwrites or span misuse) are emitted as `sloplog_usage_error` on flush.

## Built-in partials (separate module)

sloplog ships a small set of built-in partials for convenience. These are intentionally separate from the core API and may change.

TypeScript:

```ts
import { builtInRegistry, builtInPartialMetadata } from 'sloplog/partials';
```

Python:

```py
from sloplog.partials import GeneratedRegistry, PARTIAL_METADATA
```

Built-in partial names: `error` (repeatable + always-sample), `log_message` (with `level`), `span`, `sloplog_usage_error`.

## Registry + codegen

Define your registry in a `sloplog.reg.ts` file (or any path you prefer):

```ts
import { partial, registry, z } from 'sloplog';

const user = partial('user', {
  userId: z.string(),
  subscriptionLevel: z.string(),
});

export default registry([user]);
```

Pass the registry as the first argument to `wideEvent()` to infer types and extract metadata:

```ts
const evt = wideEvent(registry, service({ name: 'my-service' }), originator, collector);
```

Generate Python + JSON Schema outputs with the `config()` helper:

```ts
import { config } from 'sloplog/codegen';

await config({
  registry: './sloplog.reg.ts',
  outDir: './generated',
  outputs: ['python', 'jsonschema'],
});
```

`registry` can be a registry object or a path to a module exporting one. Defaults write `./generated/sloplog.py` and `./generated/sloplog.json`. Disable or rename outputs via:

```ts
await config({
  registry: './sloplog.reg.ts',
  outputs: { python: 'types.py', jsonschema: false },
});
```

If your registry is a TypeScript file, run the script with a TS runtime like `tsx` or `ts-node`.

# prior art

- an open source example of my proto-logging library: https://github.com/cloudflare/mcp-server-cloudflare/tree/eb24e3bba8be7b682aa721d34918ff0954f1254a/packages/mcp-observability
- https://boristane.com/blog/observability-wide-events-101/
- https://isburmistrov.substack.com/p/all-you-need-is-wide-events-not-metrics
- https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/
- https://charity.wtf/2024/08/07/is-it-time-to-version-observability-signs-point-to-yes/
- https://loggingsucks.com/
