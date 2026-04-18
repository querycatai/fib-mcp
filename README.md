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

For the special case where one WebSocket connection must carry bidirectional MCP calls,
use `BidirectionalSession`.

It internally creates the two logical MCP sides needed for one shared WebSocket,
without exposing that middle layer in the public API.

For most cases, you only need to prepare the local `McpServer`.
`BidirectionalSession.handler(server)` and `BidirectionalSession.open(url, server)` wrap the raw WebSocket setup for you.

Server side:

```ts
import http from 'http';
import { BidirectionalSession, McpServer } from 'fib-mcp';

const localServer = new McpServer({ name: 'local-server', version: '1.0.0' });

localServer.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

const httpServer = new http.Server(3000, {
  '/mcp': BidirectionalSession.handler(localServer, {
    clientInfo: { name: 'remote-client', version: '1.0.0' },
  }),
});

httpServer.start();
```

Client side:

```ts
import { BidirectionalSession, McpServer } from 'fib-mcp';

const peerServer = new McpServer({ name: 'peer-server', version: '1.0.0' });

peerServer.tool('echo', {}, async () => ({
  content: [{ type: 'text', text: 'echo-from-peer' }],
}));

const session = await BidirectionalSession.open('ws://127.0.0.1:3000/mcp', peerServer, {
  clientInfo: { name: 'peer-client', version: '1.0.0' },
});

const result = await session.client.callTool({ name: 'ping', arguments: {} });
console.log(result.content[0].text);

await session.close();
```

If you need lower-level control, `BidirectionalSession.connect(ws, server)` still accepts an already opened WebSocket object.

The `ws` object only needs to provide:

- `onmessage`
- `onerror`
- `onclose`
- `send(data: string)`
- `close()`

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

