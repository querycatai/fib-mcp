# fib-mcp

MCP (Model Context Protocol) SDK for the fibjs ecosystem.

`McpServer` and `McpClient` extend `@modelcontextprotocol/sdk` directly.
fib-mcp adds fibjs-native server transports (`sse`, `ws`, `http`),
fibjs-native client transports for `sse` and `ws`, and handler methods
for mounting server transports into your own `http.Server`.

TypeScript runs directly on fibjs; no compile step is required.

## Features

- `McpServer extends sdk.McpServer` — all SDK methods available as-is
- `McpClient extends sdk.Client` — all SDK methods available as-is
- fibjs-native server transports: `sse`, `ws`, `http`
- fibjs-native client transports: `sse`, `ws`
- HTTP client uses the SDK Streamable HTTP transport
- SSE automatic endpoint discovery (standard MCP SSE protocol)
- Designed to be mounted into user-managed `http.Server` routes

## Installation

```bash
fibjs --install fib-mcp
```

## Quick Start

### Server - HTTP

```ts
import http from 'http';
import { McpServer } from 'fib-mcp';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

const svr = new http.Server(3000, {
  '/mcp': server.httpHandler(),
});
svr.start();
```

### Client — HTTP

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });
await client.connectHttp('http://127.0.0.1:3000/mcp');

const { tools } = await client.listTools();
const result = await client.callTool({ name: 'ping', arguments: {} });

await client.close();
```

### Server — WebSocket

```ts
import http from 'http';
import { McpServer } from 'fib-mcp';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

const svr = new http.Server(3000, {
  '/mcp': server.wsHandler(),
});
svr.start();
```

### Client — WebSocket

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });
await client.connectWs('ws://127.0.0.1:3000/mcp');

const result = await client.callTool({ name: 'ping', arguments: {} });
await client.close();
```

### Server — SSE

```ts
import http from 'http';
import { McpServer } from 'fib-mcp';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

const svr = new http.Server(3000, {
  '/mcp': server.sseHandlers(),
});
svr.start();
```

### Client — SSE

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });

// messageUrl auto-discovered from server's `endpoint` event:
await client.connectSse('http://127.0.0.1:3000/mcp/sse');

// Or with an explicit messageUrl:
// await client.connectSse('http://127.0.0.1:3000/mcp/sse', 'http://127.0.0.1:3000/mcp/message');

const result = await client.callTool({ name: 'ping', arguments: {} });
await client.close();
```

### Server — stdio

```ts
import { McpServer } from 'fib-mcp';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

await server.listenStdio();
```

### Client — stdio

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });

// Spawn an MCP server process and connect via stdio:
await client.connectStdio('fibjs', ['my_mcp_server.ts']);

const result = await client.callTool({ name: 'ping', arguments: {} });
await client.close();
```

## API Reference

### McpServer

Extends `@modelcontextprotocol/sdk` `McpServer`. All SDK methods (`tool`, `resource`,
`prompt`, `registerTool`, `connect`, `close`, etc.) are inherited unchanged.

fib-mcp adds the following fibjs-native transport methods:

Note: a single `McpServer` instance should bind only one network transport (`ws`, `sse`, or `http`).
If you need multiple network protocols, create separate `McpServer` instances.

#### `listenStdio(): Promise<void>`
Connect to stdio. Used when the server is spawned by an MCP host.

#### `wsHandler(): Handler`
Returns a fibjs WebSocket upgrade handler for use in a route map.

```ts
const svr = new http.Server(3000, { '/mcp': server.wsHandler() });
```

#### `sseHandlers(): Record<string, Handler>`
Returns SSE route handlers for nested fibjs routing (SSE GET + POST message endpoint).

```ts
const svr = new http.Server(3000, { '/mcp': server.sseHandlers() });
```

The server automatically sends an `endpoint` event on connect, so clients can
discover the POST URL without it being pre-configured.

#### `httpHandler(options?): Handler`
Returns an HTTP POST handler for mounting at a route chosen by your outer router.

```ts
const svr = new http.Server(3000, { '/mcp': server.httpHandler() });
```

Options:
- `timeoutMs?`: request timeout in ms (default: `30000`)

#### `httpHandlers(options?): Record<string, Handler>`
Returns a flat fibjs route map for JSON-RPC over HTTP POST.

```ts
const svr = new http.Server(3000, server.httpHandlers({ path: '/mcp' }));
```

Options:
- `path?`: route path (default: `/mcp`)
- `timeoutMs?`: request timeout in ms (default: `30000`)

---

### McpClient

Extends `@modelcontextprotocol/sdk` `Client`. All SDK methods (`callTool`, `listTools`,
`readResource`, `listResources`, `getPrompt`, `listPrompts`, `listResourceTemplates`,
`ping`, `complete`, `connect`, `close`, etc.) are inherited unchanged with identical
signatures and return types.

fib-mcp adds the following transport connection methods:

#### `connectStdio(command, args?, options?): Promise<void>`
Spawn a process and connect via stdio (SDK transport).

#### `connectHttp(url, options?): Promise<void>`
Connect via the SDK Streamable HTTP transport.

#### `connectSse(sseUrl, messageUrl?, options?): Promise<void>`
Connect via fibjs SSE + HTTP POST transport.

If `messageUrl` is omitted, the client waits for the server's `endpoint` SSE event
and discovers the POST URL automatically (standard MCP SSE protocol).

Options:
- `headers?`: extra request headers
- `method?`: POST method override (default: `POST`)

#### `connectWs(url, options?): Promise<void>`
Connect via fibjs WebSocket transport.

Options:
- `protocols?`: WebSocket sub-protocols

## Transport Notes

| Transport | Client | Server |
|-----------|--------|--------|
| stdio     | SDK | SDK |
| http      | SDK Streamable HTTP | fibjs-native |
| sse       | fibjs-native | fibjs-native |
| ws        | fibjs-native | fibjs-native |

## Bidirectional Session

Use `BidirectionalSession` when one WebSocket connection needs to carry:

- normal forward MCP calls (`client -> server`)
- optional reverse MCP calls (`server -> client`) on the same socket

One `BidirectionalSession` owns one shared `McpServer` definition, and `handler()` accepts multiple
WebSocket connections for that definition.

### Constructor

```ts
const session = new BidirectionalSession(serverIdentity, {
  clientInfo,
  serverInfo,
  clientOptions,
  serverOptions,
});
```

Options:

- `clientInfo`: local client identity used by the internal `McpClient`
- `serverInfo`: remote server identity; also enables advertising reverse service capability on initialize
- `clientOptions`: passed to internal `McpClient`
- `serverOptions`: passed to internal `McpServer`

Constraint:

- Declaring `capabilities.extensions['fib-mcp'].reverseService = true` in `clientOptions` requires `serverInfo`.
- If `serverInfo` is omitted while declaring that capability, `BidirectionalSession` constructor throws an error.

Recommendation:

- keep both sides using the same option shape: `{ clientInfo, serverInfo }`

### Behavior Model

- Reverse availability is decided per session id from peer initialize capabilities.
- If peer initialize includes `capabilities.extensions['fib-mcp'].reverseService = true`, reverse is enabled for that session.
- If peer does not advertise that capability, reverse calls are blocked for that session.
- Providing `serverInfo` makes the local side advertise reverse service capability during initialize.
- Omitting `serverInfo` keeps local behavior as normal one-way MCP ws (forward works, reverse blocked by peers), and explicit reverse capability declaration is rejected.

### Server Example

```ts
import http from 'http';
import { BidirectionalSession } from 'fib-mcp';

const session = new BidirectionalSession(
  { name: 'local-server', version: '1.0.0' },
  {
    clientInfo: { name: 'local-client', version: '1.0.0' },
    serverInfo: { name: 'remote-server', version: '1.0.0' },
  }
);

session.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

session.tool('server.proxyEcho', {}, async (_args, ctx) => {
  const result = await ctx.client.callTool({ name: 'echo', arguments: {} });
  return { content: [{ type: 'text', text: result.content[0].text }] };
});

const httpServer = new http.Server(3000, {
  '/mcp': session.handler(),
});

httpServer.start();
```

### Peer Example

```ts
import { BidirectionalSession } from 'fib-mcp';

const session = new BidirectionalSession(
  { name: 'peer-server', version: '1.0.0' },
  {
    clientInfo: { name: 'peer-client', version: '1.0.0' },
    serverInfo: { name: 'local-server', version: '1.0.0' },
  }
);

session.tool('echo', {}, async () => ({
  content: [{ type: 'text', text: 'echo-from-peer' }],
}));

const connection = await session.open('ws://127.0.0.1:3000/mcp');

const ping = await connection.client.callTool({ name: 'ping', arguments: {} });
const proxied = await connection.client.callTool({ name: 'server.proxyEcho', arguments: {} });

console.log(ping.content[0].text);
console.log(proxied.content[0].text);

await session.close();
```

### Tool Callback Context

`session.tool(name, schema, handler)` callback parameters:

- first argument: parsed tool args
- second argument: `{ client, extra }`

Use `ctx.client` to call tools exposed by the peer on the same WebSocket session.

### Compatibility With Normal MCP ws Client

`handler()` is compatible with a plain `McpClient.connectWs(...)` client:

- normal forward calls are supported
- reverse calls are not available unless reverse channel is enabled for that connection

### Low-level APIs

- raw server instance: `session.server`
- route handler: `session.handler()`

## Notifications

Notification flow is supported both on normal MCP transports and on `BidirectionalSession`.

Current test coverage includes:

- base WebSocket MCP notification delivery
- internal notification routing in `BidirectionalSession`
- peer-to-peer notification forwarding across a shared bidirectional session

## Testing

```bash
fibjs test/all.test.ts
fibjs --test test/integration_test.ts
fibjs --test test/edge_cases_test.ts
fibjs --test test/bidirectional_provider_test.ts
```

