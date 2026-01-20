# wevt - A python and typescript library for constructing wide events

When constructing wide events for my services, I've found myself constructing essentially the same library again and again. I end up constructing a mediocre semi-structured wide event library. 

The core idea is taken from a wide array of prior art (see below) on wide events. We have structured logs which will eventually be queried. The structured logging part isn't particularly hard, but I've found that it's nice to have a single place where my log structure is defined.

## The structure of a wevt WideEvent

The core idea of this library is that we have two bits of information in our wide log.

1) WideEventBase: contains the service, eventId (unique per wide event), originator (thing that triggered the wide event, contains the spanId)
2) Any number of `WideEventPartial`s: structured bits of data which are added to our wide event. You can add partials to add application logic, performance logic, etc. This can be things like user information, session ids, function performance info.

We are opinionated in that we define the types of WideEventPartials and other bits of data upfront. Querying structured logs is useful only if:

1) you know which fields exist
2) fields are consistently defined (no simultaneous "user-id", "user.id", and "userId" fields)

Yes, most observability interfaces attempt to discover the schemas for you, but I've found that it's not perfect.

Here is an example wide event:

```ts
const evt: WideEventLog<Registry> = {
    // WideEventBase attributes
    service: {
        // base info
        name: "my-rest-service",
        version: "1.0.0"

        // additional user defined service info
        pod_id: "v8a4ad"
    },
    eventId: "evnt_V1StGXR8_Z5jdHi6B-myT",
    originator: {
        // ALWAYS contained on an originator
        type: "http",
        spanId: "span_V1StGXR8_Z5jdHi6B-myT",
        
        // HTTP specific originator data
        method: "POST";
        path: "/foo";
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0"
        };
    },

    // WideEventPartial: user
    user: {
        id: "user_V1StGXR8_Z5jdHi6B-myT",
        tier: "pro",
    }

    // WideEventPartial: chat
    chat: {
        chatId: "chat_V1StGXR8_Z5jdHi6B-myT",
        model: "opus",
        messages: 232,
        tokens: 45822,
    },

    // WideEventPartial: chat
    sandbox: {
        sandboxId: "sbox_V1StGXR8_Z5jdHi6B-myT",
        startedAt: 1768868366748,
        startDuration: 5021,
        liveDuration: 116748,
    }
}
```

## Collectors

Collectors flush wide event logs. The goal is that you can adapt the format and flush the logs wherever you want. We provide a few simple collectors, such as a StdioCollector or a FileCollector. It's generally trivial to implement a collector of your own. Just extend the collector interface and implement a flush function. When implementing your own collector, you most likely will want to implement tail sampling and event buffering here.

```ts
/**
 * Simple collector to log the event in the console
 */
class StdioCollector implements LogCollectorClient {
    async flush(eventBase: WideEventBase, partials: Map<string, EventPartial<string>>): Promise<void> {
        console.log({
            ...eventBase,
            ...partials
        })
    }
}
```

### WideEventBase

The WideEventBase type contains 3 fields:

1) `eventId`, which uniquely identifies your event
2) `originator` which is defined broadly as an external thing that triggered your service to do some action. These can include external HTTP requests, websocket messages, cron triggers, etc. Originators have an id and can cross service boundaries. You can think of this as the thing that connects your metrics across service boundaries, much like a traceId. The difference is that originators attach additional information, like HTTP request information
3) `service` is where an event is emitted from. Each service should emit one wide event per originator as defined above. A service has a unique name, and can be provided with additional user defined metadata

### WideEventPartial

These are partial bits that can be added to a WideEvent via the wevt.log() or wevt.partial() function. These are predefined in the registry type for the reasons mentioned above.

# prior art

* an open source example of my proto-logging library: https://github.com/cloudflare/mcp-server-cloudflare/tree/eb24e3bba8be7b682aa721d34918ff0954f1254a/packages/mcp-observability 
* https://boristane.com/blog/observability-wide-events-101/
* https://isburmistrov.substack.com/p/all-you-need-is-wide-events-not-metrics
* https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/
* https://charity.wtf/2024/08/07/is-it-time-to-version-observability-signs-point-to-yes/
* https://loggingsucks.com/