/**
 * fib-mcp: McpClient
 *
 * MCP client for fibjs. Extends @modelcontextprotocol/sdk Client directly,
 * adding fibjs-native transport convenience methods.
 *
 * All standard MCP methods (listTools, callTool, listResources, readResource,
 * listPrompts, getPrompt, ping, complete, etc.) are inherited from the SDK
 * Client unchanged — same signatures, same return types.
 *
 * Usage:
 *   const client = new McpClient({ name: 'my-client', version: '1.0' });
 *
 *   // Connect via stdio (spawn an MCP server process)
 *   await client.connectStdio('fibjs', ['server.ts']);
 *
 *   // Or Streamable HTTP
 *   await client.connectHttp('http://localhost:3000/mcp');
 *
 *   // Or WebSocket (fibjs-native)
 *   await client.connectWs('ws://localhost:3000/mcp');
 *
 *   // Or SSE (fibjs-native) – messageUrl optional, auto-discovered via endpoint event
 *   await client.connectSse('http://localhost:3000/mcp/sse');
 *   await client.connectSse('http://localhost:3000/mcp/sse', 'http://localhost:3000/mcp/message');
 *
 *   const { tools } = await client.listTools();
 *   const result = await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } });
 */

import { WebSocketClientTransport } from './ws';
import type { WebSocketClientOptions } from './ws';
import { SseClientTransport } from './sse';
import type { SseClientOptions } from './sse';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type { StdioServerParameters };
export type { StreamableHTTPClientTransportOptions };

/**
 * MCP client for fibjs.
 *
 * Extends @modelcontextprotocol/sdk Client with fibjs-native transport
 * convenience methods. All SDK methods are available directly on this class.
 */
export class McpClient extends (Client as any) {
    constructor(info: { name: string; version: string }, options: any = {}) {
        super(info, options);
    }

    // ── fibjs-native transport convenience methods ──────────────────────────

    /**
     * Spawn an MCP server process and communicate via stdin/stdout.
     */
    async connectStdio(command: string, args: string[] = [], options: Omit<StdioServerParameters, 'command' | 'args'> = {}): Promise<void> {
        const transport = new SdkStdioClientTransport({ command, args, ...options });
        await this.connect(transport);
    }

    /**
     * Connect to an MCP server via Streamable HTTP transport.
     */
    async connectHttp(url: string, options?: StreamableHTTPClientTransportOptions): Promise<void> {
        const transport = new StreamableHTTPClientTransport(new URL(url), options);
        await this.connect(transport);
    }

    /**
     * Connect to an MCP server via WebSocket (fibjs-native transport).
     */
    async connectWs(url: string, options?: WebSocketClientOptions): Promise<void> {
        const transport = new WebSocketClientTransport(url, options);
        await this.connect(transport);
    }

    /**
     * Connect to an MCP server via SSE + HTTP POST (fibjs-native transport).
     *
     * If `messageUrl` is omitted, the POST URL is discovered automatically
     * from the `endpoint` named SSE event (standard MCP SSE protocol).
     */
    async connectSse(sseUrl: string, messageUrl?: string, options?: SseClientOptions): Promise<void> {
        const transport = new SseClientTransport(sseUrl, messageUrl, options);
        await this.connect(transport);
    }
}
