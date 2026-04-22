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
console.log(result.content[0].text);

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

`BidirectionalSession` provides transport-agnostic bidirectional MCP over one connection:

- Forward calls: local side calls peer tools
- Reverse calls: peer calls local tools through `ctx.client`
- Session-scoped capability negotiation for reverse channel
- Backward compatible with plain MCP clients

### Constructor (New API)

`BidirectionalSession` now uses a single options object.

```ts
import { BidirectionalSession } from 'fib-mcp';

const session = new BidirectionalSession({
  serverInfo: { name: 'my-server', version: '1.0.0' },
  clientInfo: { name: 'my-client', version: '1.0.0' },
  clientOptions: {},
  serverOptions: {},
});
```

Options:

- `serverInfo` (required): local server identity
- `clientInfo` (optional): local client identity, default `bidirectional-client/1.0.0`
- `clientOptions` (optional): forwarded to internal `McpClient`
- `serverOptions` (optional): forwarded to internal `McpServer`

### Tool Callback Context

```ts
session.tool('server.proxy', {}, async (_args, ctx) => {
  const nested = await ctx.client.callTool({ name: 'peer.echo', arguments: {} });
  return {
    content: [{ type: 'text', text: nested.content[0].text }],
  };
});
```

Handler context:

- `ctx.client`: peer client bound to current session
- `ctx.extra`: MCP request metadata (includes `sessionId`)

### Connection APIs

WebSocket convenience:

- `wsHandler()` for server route mounting
- `connectWs(url, options?)` for active side over websocket

Stdio convenience:

- `connectStdio(command, args?, options?)` for active side stdio connection
- `listenStdio()` for passive side stdio accept

Generic transport:

- `connect(transport)` active side
- `accept(transport)` passive side

Both return `BidirectionalConnection`:

- `connection.client`
- `connection.sessionId`
- `connection.close()`

### WebSocket Example

```ts
import http from 'http';
import { BidirectionalSession } from 'fib-mcp';

const accepted = new BidirectionalSession({
  serverInfo: { name: 'accepted-server', version: '1.0.0' },
  clientInfo: { name: 'accepted-client', version: '1.0.0' },
});

accepted.tool('server.ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong-from-accepted' }],
}));

const host = new http.Server(3000, {
  '/mcp': accepted.wsHandler(),
});
host.start();

const peer = new BidirectionalSession({
  serverInfo: { name: 'peer-server', version: '1.0.0' },
  clientInfo: { name: 'peer-client', version: '1.0.0' },
});

const conn = await peer.connectWs('ws://127.0.0.1:3000/mcp');
const pong = await conn.client.callTool({ name: 'server.ping', arguments: {} });
console.log(pong.content[0].text);
```

### Stdio Example

```ts
import { BidirectionalSession } from 'fib-mcp';

const parent = new BidirectionalSession({
  serverInfo: { name: 'parent-server', version: '1.0.0' },
  clientInfo: { name: 'parent-client', version: '1.0.0' },
});

parent.tool('parent.greet', {}, async () => ({
  content: [{ type: 'text', text: 'hello-from-parent' }],
}));

const conn = await parent.connectStdio('fibjs', ['./child.ts']);
const echo = await conn.client.callTool({ name: 'child.echo', arguments: {} });
console.log(echo.content[0].text);
```

### In-Memory Example

```ts
import { BidirectionalSession } from 'fib-mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const left = new BidirectionalSession({
  serverInfo: { name: 'left-server', version: '1.0.0' },
  clientInfo: { name: 'left-client', version: '1.0.0' },
});

const right = new BidirectionalSession({
  serverInfo: { name: 'right-server', version: '1.0.0' },
  clientInfo: { name: 'right-client', version: '1.0.0' },
});

const [leftTransport, rightTransport] = InMemoryTransport.createLinkedPair();
const leftConn = await left.connect(leftTransport);
const rightConn = await right.accept(rightTransport);
```

### Backward Compatibility

Plain MCP clients are supported:

- Forward calls work as normal
- Reverse calls are blocked if peer does not advertise reverse capability
- Mixed plain and bidirectional clients can coexist on the same server

### Transport Contract

Custom transport should implement SDK `Transport` behavior:

- `start()`
- `send(message, options?)`
- `close()`
- `onmessage(message, extra?)`
- `onerror(error)`
- `onclose()`

## Notifications

Notification flow works on both normal MCP transports and `BidirectionalSession`.

## Testing

```bash
fibjs test/all.test.ts
fibjs --test test/integration_test.ts
fibjs --test test/edge_cases_test.ts
fibjs --test test/bidirectional_provider_test.ts
```
