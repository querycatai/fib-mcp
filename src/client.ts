/**
 * fib-mcp: McpClient
 *
 * MCP client for fibjs. Extends @modelcontextprotocol/sdk Client directly,
 * adding transport-descriptor based connect calls.
 *
 * All standard MCP methods (listTools, callTool, listResources, readResource,
 * listPrompts, getPrompt, ping, complete, etc.) are inherited from the SDK
 * Client unchanged — same signatures, same return types.
 *
 * Usage:
 *   const client = new McpClient({ name: 'my-client', version: '1.0' });
 *
 *   // Connect via stdio (spawn an MCP server process)
 *   await client.connect({ transport: 'stdio', command: 'fibjs', args: ['server.ts'] });
 *
 *   // Or Streamable HTTP
 *   await client.connect({ transport: 'streamable-http', url: 'http://localhost:3000/mcp' });
 *
 *   // Or WebSocket (fibjs-native)
 *   await client.connect({ transport: 'ws', url: 'ws://localhost:3000/mcp' });
 *
 *   // Or SSE (fibjs-native) – messageUrl optional, auto-discovered via endpoint event
 *   await client.connect({ transport: 'sse', url: 'http://localhost:3000/mcp/sse' });
 *   await client.connect({ transport: 'sse', url: 'http://localhost:3000/mcp/sse', messageUrl: 'http://localhost:3000/mcp/message' });
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

export interface McpClientHttpConnectOptions {
    transport: 'streamable-http';
    url: string;
    options?: StreamableHTTPClientTransportOptions;
}

export interface McpClientWsConnectOptions {
    transport: 'ws' | 'websocket';
    url: string;
    options?: WebSocketClientOptions;
}

export interface McpClientSseConnectOptions {
    transport: 'sse';
    url: string;
    messageUrl?: string;
    options?: SseClientOptions;
}

export interface McpClientStdioConnectOptions {
    transport: 'stdio';
    command?: string;
    args?: string[];
    path?: string;
    options?: Omit<StdioServerParameters, 'command' | 'args'>;
}

export type McpClientConnectOptions =
    | McpClientHttpConnectOptions
    | McpClientWsConnectOptions
    | McpClientSseConnectOptions
    | McpClientStdioConnectOptions;

function createClientTransportFromConfig(config: McpClientConnectOptions): any {
    if (config.transport === 'streamable-http') {
        return new StreamableHTTPClientTransport(new URL(config.url), config.options);
    }

    if (config.transport === 'ws' || config.transport === 'websocket') {
        return new WebSocketClientTransport(config.url, config.options);
    }

    if (config.transport === 'sse') {
        return new SseClientTransport(config.url, config.messageUrl, config.options);
    }

    const command = config.command || process.execPath;
    const args = config.command
        ? (config.args || [])
        : [config.path || ''];

    if (!config.command && !config.path) {
        throw new Error('stdio connect requires either command or path');
    }

    return new SdkStdioClientTransport({ command, args, ...(config.options || {}) });
}


/**
 * MCP client for fibjs.
 *
 * Extends @modelcontextprotocol/sdk Client with transport descriptor based
 * connect overloads. Transport objects still pass through to the SDK unchanged.
 */
export class McpClient extends (Client as any) {
    constructor(info: { name: string; version: string }, options: any = {}) {
        super(info, options);
    }

    async connect(transport: any): Promise<void>;
    async connect(config: McpClientConnectOptions): Promise<void>;
    async connect(target: any): Promise<void> {
        if (typeof target === 'object' && target && typeof target.transport === 'string') {
            await super.connect(createClientTransportFromConfig(target));
            return;
        }

        if (target && typeof target === 'object') {
            await super.connect(target);
            return;
        }

        throw new Error('McpClient.connect requires a transport descriptor object or transport instance');
    }
}
