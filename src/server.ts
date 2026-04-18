/**
 * fib-mcp: McpServer
 *
 * MCP server for fibjs. Extends @modelcontextprotocol/sdk McpServer directly,
 * adding fibjs-native transport handler methods.
 *
 * All standard SDK methods (tool, resource, prompt, connect, close, etc.)
 * are inherited unchanged — same signatures, same return types.
 *
 * Usage:
 *   const server = new McpServer({ name: 'my-server', version: '1.0' });
 *
 *   server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
 *     content: [{ type: 'text', text: String(a + b) }]
 *   }));
 *
 *   // Stdio (when invoked by an MCP host via stdio)
 *   await server.listenStdio();
 *
 *   // Or mount into your own http.Server:
 *   const svr = new http.Server(3000, {
 *     '/mcp':         server.wsHandler(),
 *     '/mcp/sse':     server.sseHandlers().sse,
 *     '/mcp/message': server.sseHandlers().message,
 *     ...server.httpHandlers({ path: '/mcp' }),
 *   });
 */

import { WebSocketServerTransport } from './ws';
import { SseServerTransport } from './sse';
import { HttpServerTransport } from './http';
import type { HttpServerTransportOptions } from './http';

import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport as SdkStdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * MCP server for fibjs.
 *
 * Extends @modelcontextprotocol/sdk McpServer with fibjs-native transport
 * handler methods. All SDK methods are available directly on this class.
 */
export class McpServer extends (SdkMcpServer as any) {
    constructor(info: { name: string; version: string }, options: any = {}) {
        super(info, options);
    }

    // ── fibjs-native transport handler methods ──────────────────────────────

    /**
     * Communicate via the current process's stdin/stdout.
     * Typically used when the server is spawned by an MCP host.
     */
    async listenStdio(): Promise<void> {
        const transport = new SdkStdioServerTransport();
        await this.connect(transport);
    }

    /**
     * Returns a WebSocket upgrade handler for mounting into a fibjs route map.
     *
     * Example:
     *   const svr = new http.Server(3000, { '/mcp': server.wsHandler() });
     */
    wsHandler(): any {
        const self = this;
        const wst = new WebSocketServerTransport();
        return wst.handler(function (conn: WebSocketServerTransport) {
            self.connect(conn).catch(function (err: any) {
                if (conn.onerror) conn.onerror(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }

    /**
     * Returns SSE route handlers for mounting into a fibjs route map.
     *
     * Example:
     *   const { sse, message } = server.sseHandlers();
     *   const svr = new http.Server(3000, { '/mcp/sse': sse, '/mcp/message': message });
     */
    sseHandlers(): { sse: any; message: any } {
        const transport = new SseServerTransport();
        const handlers = transport.handlers();
        this.connect(transport).catch(function (err: any) {
            if (transport.onerror) {
                transport.onerror(err instanceof Error ? err : new Error(String(err)));
            }
        });
        return handlers;
    }

    /**
     * Returns HTTP route handlers for mounting into a fibjs route map.
     *
     * Example:
     *   const svr = new http.Server(3000, server.httpHandlers({ path: '/mcp' }));
     */
    httpHandlers(options: HttpServerTransportOptions = {}): Record<string, any> {
        const transport = new HttpServerTransport(options);
        const routes = transport.routes();
        this.connect(transport).catch(function (err: any) {
            if (transport.onerror) {
                transport.onerror(err instanceof Error ? err : new Error(String(err)));
            }
        });
        return routes;
    }
}

