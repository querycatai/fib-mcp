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

### Server

```ts
import http from 'http';
import { McpServer } from 'fib-mcp';

const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));

// Mount transports into your own http.Server:
const { sse, message } = server.sseHandlers();
const svr = new http.Server(3000, {
  '/mcp':         server.wsHandler(),
  '/mcp/sse':     sse,
  '/mcp/message': message,
  ...server.httpHandlers({ path: '/mcp-http' }),
});
svr.start();

// Or stdio — when the server is spawned by an MCP host:
await server.listenStdio();
```

### Client — HTTP

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });
await client.connectHttp('http://127.0.0.1:3000/mcp-http');

const { tools } = await client.listTools();
const result = await client.callTool({ name: 'ping', arguments: {} });

await client.close();
```

### Client — WebSocket

```ts
import { McpClient } from 'fib-mcp';

const client = new McpClient({ name: 'demo-client', version: '1.0.0' });
await client.connectWs('ws://127.0.0.1:3000/mcp');

const result = await client.callTool({ name: 'ping', arguments: {} });
await client.close();
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

#### `listenStdio(): Promise<void>`
Connect to stdio. Used when the server is spawned by an MCP host.

#### `wsHandler(): Handler`
Returns a fibjs WebSocket upgrade handler for use in a route map.

```ts
const svr = new http.Server(3000, { '/mcp': server.wsHandler() });
```

#### `sseHandlers(): { sse: Handler; message: Handler }`
Returns SSE route handlers (SSE GET + POST message endpoint).

```ts
const { sse, message } = server.sseHandlers();
const svr = new http.Server(3000, { '/mcp/sse': sse, '/mcp/message': message });
```

The server automatically sends an `endpoint` event on connect, so clients can
discover the POST URL without it being pre-configured.

#### `httpHandlers(options?): Record<string, Handler>`
Returns a fibjs route map for JSON-RPC over HTTP POST.

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

---

## Transport Notes

| Transport | Side   | Implementation |
|-----------|--------|----------------|
| stdio     | client | SDK            |
| stdio     | server | SDK            |
| http      | client | SDK (StreamableHTTP) |
| http      | server | fibjs-native   |
| sse       | client | fibjs-native   |
| sse       | server | fibjs-native   |
| ws        | client | fibjs-native   |
| ws        | server | fibjs-native   |

## Testing

```bash
fibjs test/all.test.ts
fibjs --test test/integration_test.ts
fibjs --test test/edge_cases_test.ts
```

