/**
 * fib-mcp: MCP (Model Context Protocol) for fibjs
 *
 * High-level API:
 *   McpServer – MCP server, backed by @modelcontextprotocol/sdk Server
 *   McpClient – MCP client, backed by @modelcontextprotocol/sdk Client
 *
 * Both classes hide transport selection behind convenience methods:
 *
 *   Server:
 *     server.listenStdio()          – communicate via process stdin/stdout
 *     server.wsHandler()            – create a WebSocket route handler
 *     server.sseHandlers()          – create SSE + POST route handlers
 *     server.httpHandler()          – create an HTTP POST route handler
 *     server.httpHandlers()         – create a flat HTTP POST route map
 *     server.connect(transport)     – connect to any Transport
 *
 *   Client:
 *     client.connect(config)         – connect via transport descriptor
 *     client.connect(transport)      – connect to any Transport
 *
 * Low-level transport classes are re-exported for direct use.
 */

// ── Primary API ───────────────────────────────────────────────────────────────
export { McpServer } from './src/server';

export { McpClient } from './src/client';
export type {
	StdioServerParameters,
	StreamableHTTPClientTransportOptions,
	McpClientConnectOptions,
	McpClientHttpConnectOptions,
	McpClientWsConnectOptions,
	McpClientSseConnectOptions,
	McpClientStdioConnectOptions,
} from './src/client';

// ── Transport base ────────────────────────────────────────────────────────────
export { Transport }                                          from './src/base';
export type { JSONRPCMessage, MessageHandler, ErrorHandler, CloseHandler } from './src/base';

// ── Transport implementations (for advanced use) ──────────────────────────────
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
export { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

export { WebSocketServerTransport } from './src/ws';
export type { ConnectCallback }      from './src/ws';

export { SseServerTransport, SseClientTransport }            from './src/sse';
export type { SseClientOptions }                             from './src/sse';

export { HttpServerTransport }                               from './src/http';
export type { HttpServerTransportOptions }                   from './src/http';

export { BidirectionalSession }                              from './src/bidirectional_session';
export type {
	BidirectionalMessageTransport,
	BidirectionalSessionOptions,
	BidirectionalConnectOptions,
	BidirectionalWsConnectOptions,
	BidirectionalStdioConnectOptions,
	BidirectionalToolExtra,
	BidirectionalToolContext,
	BidirectionalToolCallback,
	BidirectionalConnection,
} from './src/bidirectional_session';
