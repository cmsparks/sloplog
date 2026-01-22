import * as slop from './js/index';
import { compositeCollector } from './js/collectors/composite';
import { fileCollector } from './js/collectors/file';
import { stdioCollector } from './js/collectors/stdio';
import * as fs from 'node:fs/promises';
import * as z from 'zod';

/**
 * DEFINING OUR SLOPLOG SCHEMAS
 */

// partials are bits of info that you can add to a wide event.
// these build schemas that are consistent across your services
const session = slop.partial('session', {
  id: z.string(),
  device: z.enum(['mobile', 'web']),
});

const user = slop.partial('user', {
  id: z.string(),
  subscription: z.enum(['free', 'pro']),
});

// they can be repeatable or single use
const dbQueries = slop.partial(
  'db_query',
  {
    queryName: z.string(),
    duration: z.number(),
  },
  { repeatable: true },
);

// a registry is a collection of partials that we're using
const registry = slop.registry([user, session, dbQueries]);

// then, output our codegenned types to json schema or python
// to allow us to stay consistent between languages
await slop.config({
  registry,
  outDir: '.',
  outputs: {
    python: 'python/sloplog/partials.py',
    jsonschema: 'generated/sloplog.json',
  },
});

/**
 * CREATING A WIDE EVENT
 */

// Each wide event needs:
// 1) a service associated with it. create this when starting your service
const service = slop.service({ name: 'test' });
// 2) place(s) to be output -- in this case we log to stdout and to a file
//    create this when starting your service
const collector = compositeCollector([fileCollector('./slop.log', fs), stdioCollector()]);
// 3) info on what triggered it -- an originator. create this upon
//    receiving an http request (includes traceId if present in headers)
const originator = slop.httpOriginator(new Request('example.com'));

// now, let's create a wide event!
const event = slop.wideEvent(registry, service, originator, collector);

// then, we can add data to our wide event, like our app specific user
event.partial(user({ id: crypto.randomUUID(), subscription: 'pro' }));

// There are built in partials, like .span(), which outputs a partial of the "span" type
event.span('someTrackedSpan', () => {
  'text to search'.search(new RegExp('text'));
});

// .log is aliased to partial()
event.log(session({ id: crypto.randomUUID(), device: 'web' }));

// but can also send more familiar "log_message" logs, but this is discouraged.
// consider schematizing your logs instead!
event.log('some string message', { withData: true });

// and flush!
await event.flush();
