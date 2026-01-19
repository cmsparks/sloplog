function nanoId(): string {
  return ""
}

// Base entry type - must have `type` field, can have additional fields
type EventPartial<K extends string = string> = {
  type: K;
  [key: string]: unknown;
}

// Resolved entries with enforced type field matching key
type ResolvedEntries<R extends Record<string, EventPartial<string>>> = {
  [K in keyof R]: Omit<R[K], "type"> & { type: K & string };
}

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

type HTTPRequest = {
  method: HTTPMethod;
  path: string;
  headers: Record<string, string>;
}

type WebSocketMessage = {
  type: string;
  sessionId: string;
  source: string;
}

type Originator = HTTPRequest | WebSocketMessage

type WideEventBase = {
  service: string;
  spanId: string;
  eventId: string;
  originator: HTTPRequest | WebSocketMessage;
}

// WideEventLog represents a single wide event sent to a collector
type WideEventLog<R extends Record<string, EventPartial<string>> = Record<never, never>> =
  WideEventBase & Partial<ResolvedEntries<R>>

interface LogCollectorClient<R extends Record<string, EventPartial<string>> = Record<never, never>> {
  flush(event: WideEventLog<R>): Promise<void>
}

class StubCollector<R extends Record<string, EventPartial<string>> = Record<never, never>> implements LogCollectorClient<R> {
  async flush(event: WideEventLog<R>): Promise<void> {
    console.log(event)
  }
}

class WideEvent<R extends Record<string, EventPartial<string>> = Record<never, never>> {
  spanId: string
  eventId: string;
  collector: LogCollectorClient<R>;
  props = new Map<string, EventPartial<string>>();

  constructor(private service: string, private originator: Originator, collector: LogCollectorClient<R>, spanId?: string) {
    this.spanId = spanId ?? `spn_${nanoId()}`
    this.eventId = `evt_${nanoId()}`
    this.collector = collector
  }

  log<K extends keyof R>(k: K, v: R[K]) {
    this.props.set(k as string, v as EventPartial<string>)
  }

  // flush/emit our wide log
  flush() {
    const evt = {
      service: this.service,
      spanId: this.spanId,
      eventId: this.eventId,
      originator: this.originator,
    } as WideEventLog<R>

    this.props.forEach((v, k) => {
      (evt as Record<string, EventPartial<string>>)[k] = v
    })

    this.collector.flush(evt)
  }
}

// ---- Consumer usage ----

// Define your event registry
type MyRegistry = {
  user: { type: "user"; id: string; name: string };
  request: { type: "request"; method: string; duration: number };
};

// Create a typed wide event
const collector = new StubCollector<MyRegistry>();
const evt = new WideEvent<MyRegistry>(
  "my-service",
  { method: "GET", path: "/", headers: {} },
  collector
);

// Type-safe: key must be in registry, value must match
evt.log("user", { type: "user", id: "123", name: "John" });
evt.log("request", { type: "request", method: "POST", duration: 150 });

// TypeScript enforces:
// - Only registered keys allowed
// - Value shape must match the registry definition
// - event.user?.type is "user" (literal type)
// - event.user?.id is string
