import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import coroutine from 'coroutine';
import path from 'path';
import http from 'http';
import { WebSocketClientTransport as SdkWebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { BidirectionalSession, McpServer, McpClient } from '../index';

const basePort = coroutine.vmid * 10000;
type CleanupFn = () => void | Promise<void>;
const cleanupStack: CleanupFn[] = [];

function trackCleanup(fn: CleanupFn): void {
    cleanupStack.push(fn);
}

async function runCleanupStack(): Promise<void> {
    while (cleanupStack.length > 0) {
        const fn = cleanupStack.pop();
        if (!fn) continue;
        try {
            await fn();
        } catch (_) {}
    }
}

function extractFirstText(result: any): string {
    return result?.content?.[0]?.text ?? '';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: any = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

describe('fib-mcp integration', () => {
    after(async () => {
        await runCleanupStack();
    });

    describe('object transport selection', () => {
        it('supports stdio script path descriptor', async () => {
            const client = new McpClient({ name: 'auto-stdio-client', version: '1.0.0' });
            trackCleanup(async () => {
                try { await client.close(); } catch (_) {}
            });

            const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'stdio_server.ts');

            await withTimeout(
                client.connect({
                    transport: 'stdio',
                    path: fixturePath,
                    options: { cwd: process.cwd() },
                }),
                5000,
                'auto stdio connect'
            );

            const result = await withTimeout(client.callTool({ name: 'ping', arguments: {} }), 3000, 'auto stdio callTool ping');
            assert.equal(extractFirstText(result), 'pong-stdio');
        });

        it('supports explicit descriptors for HTTP, WebSocket, and SSE', async () => {
            const httpPort = basePort + 3910;
            const wsPort = basePort + 3911;
            const ssePort = basePort + 3912;

            const httpMcp = new McpServer({ name: 'auto-http-server', version: '1.0.0' });
            const wsMcp = new McpServer({ name: 'auto-ws-server', version: '1.0.0' });
            const sseMcp = new McpServer({ name: 'auto-sse-server', version: '1.0.0' });
            trackCleanup(async () => {
                try { await httpMcp.close(); } catch (_) {}
                try { await wsMcp.close(); } catch (_) {}
                try { await sseMcp.close(); } catch (_) {}
            });

            httpMcp.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-auto-http' }],
            }));
            wsMcp.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-auto-ws' }],
            }));
            sseMcp.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-auto-sse' }],
            }));

            const httpHost = new http.Server(httpPort, { '/mcp': httpMcp.httpHandler() });
            const wsHost = new http.Server(wsPort, { '/mcp': wsMcp.wsHandler() });
            const sseHost = new http.Server(ssePort, { '/mcp': sseMcp.sseHandlers() });
            httpHost.start();
            wsHost.start();
            sseHost.start();
            trackCleanup(() => {
                try { httpHost.stop(); } catch (_) {}
                try { wsHost.stop(); } catch (_) {}
                try { sseHost.stop(); } catch (_) {}
            });

            coroutine.sleep(50);

            const httpClient = new McpClient({ name: 'auto-http-client', version: '1.0.0' });
            const wsClient = new McpClient({ name: 'auto-ws-client', version: '1.0.0' });
            const sseClient = new McpClient({ name: 'auto-sse-client', version: '1.0.0' });
            trackCleanup(async () => {
                try { await httpClient.close(); } catch (_) {}
                try { await wsClient.close(); } catch (_) {}
                try { await sseClient.close(); } catch (_) {}
            });

            await withTimeout(httpClient.connect({ transport: 'streamable-http', url: `http://127.0.0.1:${httpPort}/mcp` }), 3000, 'auto http connect');
            await withTimeout(wsClient.connect({ transport: 'ws', url: `ws://127.0.0.1:${wsPort}/mcp` }), 3000, 'auto ws connect');
            await withTimeout(
                sseClient.connect({ transport: 'sse', url: `http://127.0.0.1:${ssePort}/mcp/sse`, messageUrl: `http://127.0.0.1:${ssePort}/mcp/message` }),
                3000,
                'auto sse connect'
            );

            assert.equal(
                extractFirstText(await withTimeout(httpClient.callTool({ name: 'status', arguments: {} }), 3000, 'auto http callTool status')),
                'ok-auto-http'
            );
            assert.equal(
                extractFirstText(await withTimeout(wsClient.callTool({ name: 'status', arguments: {} }), 3000, 'auto ws callTool status')),
                'ok-auto-ws'
            );
            assert.equal(
                extractFirstText(await withTimeout(sseClient.callTool({ name: 'status', arguments: {} }), 3000, 'auto sse callTool status')),
                'ok-auto-sse'
            );
        });
    });

    describe('stdio transport', () => {
        let client: any = null;

        before(async () => {
            client = new McpClient({ name: 'stdio-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });

            const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'stdio_server.ts');

            await withTimeout(
                client.connect({
                    transport: 'stdio',
                    command: process.execPath,
                    args: [fixturePath],
                    options: { cwd: process.cwd() },
                }),
                5000,
                'stdio connect'
            );
        });

        it('can call a tool through stdio', async () => {
            const result = await withTimeout(client.callTool({ name: 'ping', arguments: {} }), 3000, 'stdio callTool ping');
            assert.equal(extractFirstText(result), 'pong-stdio');
        });
    });

    describe('HTTP transport', () => {
        const port = basePort + 3900;
        let server: any = null;
        let httpServer: any = null;
        let client: any = null;

        before(async () => {
            server = new McpServer({ name: 'http-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-http' }],
            }));

            httpServer = new http.Server(port, { '/mcp': server.httpHandler() });
            httpServer.start();
            trackCleanup(() => {
                if (!httpServer) return;
                try { httpServer.stop(); } catch (_) {}
                httpServer = null;
            });

            coroutine.sleep(50);

            client = new McpClient({ name: 'http-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });
            await withTimeout(client.connect({ transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` }), 3000, 'http connect');
        });

        it('can call a tool through HTTP POST', async () => {
            const result = await withTimeout(
                client.callTool({ name: 'status', arguments: {} }),
                3000,
                'http callTool status'
            );
            assert.equal(extractFirstText(result), 'ok-http');
        });
    });

    describe('WebSocket transport', () => {
        const port = basePort + 3901;
        let server: any = null;
        let httpServer: any = null;
        let client: any = null;

        before(async () => {
            server = new McpServer({ name: 'ws-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('ping', {}, async () => ({
                content: [{ type: 'text', text: 'pong' }],
            }));

            server.tool('hello', {}, async () => ({
                content: [{ type: 'text', text: 'world' }],
            }));

            httpServer = new http.Server(port, { '/mcp': server.wsHandler() });
            httpServer.start();
            trackCleanup(() => {
                if (!httpServer) return;
                try { httpServer.stop(); } catch (_) {}
                httpServer = null;
            });

            coroutine.sleep(50);

            client = new McpClient({ name: 'ws-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });
            await withTimeout(client.connect({ transport: 'ws', url: `ws://127.0.0.1:${port}/mcp` }), 3000, 'ws connect');
        });

        it('can list multiple registered tools', async () => {
            const tools = await withTimeout(client.listTools(), 3000, 'ws listTools');
            const names = (tools?.tools || []).map((x: any) => x.name);

            assert.ok(names.includes('ping'));
            assert.ok(names.includes('hello'));
        });

        it('uses the SDK websocket client transport for ws descriptors', async () => {
            assert.ok(client.transport instanceof SdkWebSocketClientTransport);
        });

        it('can call a tool', async () => {
            const result = await withTimeout(client.callTool({ name: 'ping', arguments: {} }), 3000, 'ws callTool ping');
            assert.equal(extractFirstText(result), 'pong');
        });

        it('supports notifications on the base provider path', async () => {
            const notified = new Promise<void>((resolve) => {
                client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
                    resolve();
                });
            });

            await withTimeout(server.sendToolListChanged(), 3000, 'ws sendToolListChanged');
            await withTimeout(notified, 3000, 'ws receive tool list changed notification');
        });
    });

    describe('SSE transport', () => {
        const port = basePort + 3902;
        const ssePath = '/mcp/sse';
        const msgPath = '/mcp/message';

        let server: any = null;
        let httpServer: any = null;
        let client: any = null;

        before(async () => {
            server = new McpServer({ name: 'sse-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok' }],
            }));

            httpServer = new http.Server(port, { '/mcp': server.sseHandlers() });
            httpServer.start();
            trackCleanup(() => {
                if (!httpServer) return;
                try { httpServer.stop(); } catch (_) {}
                httpServer = null;
            });

            coroutine.sleep(50);

            client = new McpClient({ name: 'sse-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });
            await withTimeout(
                client.connect({
                    transport: 'sse',
                    url: `http://127.0.0.1:${port}${ssePath}`,
                    messageUrl: `http://127.0.0.1:${port}${msgPath}`,
                }),
                3000,
                'sse connect'
            );
        });

        it('can call a tool through SSE + POST', async () => {
            const result = await withTimeout(
                client.callTool({ name: 'status', arguments: {} }),
                3000,
                'sse callTool status'
            );
            assert.equal(extractFirstText(result), 'ok');
        });
    });

    describe('handler mode', () => {
        it('supports HTTP handler mounting', async () => {
            const port = basePort + 3903;
            let server: any = new McpServer({ name: 'http-handler-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-http-handler' }],
            }));

            const routes = {
                '/mcp': server.httpHandler(),
            };
            let host = new http.Server(port, routes);
            host.start();
            trackCleanup(() => {
                if (!host) return;
                try { host.stop(); } catch (_) {}
                host = null;
            });

            coroutine.sleep(50);

            let client: any = new McpClient({ name: 'http-handler-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });

            await withTimeout(client.connect({ transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` }), 3000, 'http handler connect');
            const result = await withTimeout(client.callTool({ name: 'status', arguments: {} }), 3000, 'http handler callTool');
            assert.equal(extractFirstText(result), 'ok-http-handler');
        });

        it('supports SSE handler mounting', async () => {
            const port = basePort + 3904;
            let server: any = new McpServer({ name: 'sse-handler-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-sse-handler' }],
            }));

            const routes = {
                '/mcp': server.sseHandlers(),
            };
            let host = new http.Server(port, routes);
            host.start();
            trackCleanup(() => {
                if (!host) return;
                try { host.stop(); } catch (_) {}
                host = null;
            });

            coroutine.sleep(50);

            let client: any = new McpClient({ name: 'sse-handler-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });

            await withTimeout(
                client.connect({
                    transport: 'sse',
                    url: `http://127.0.0.1:${port}/mcp/sse`,
                    messageUrl: `http://127.0.0.1:${port}/mcp/message`,
                }),
                3000,
                'sse handler connect'
            );
            const result = await withTimeout(client.callTool({ name: 'status', arguments: {} }), 3000, 'sse handler callTool');
            assert.equal(extractFirstText(result), 'ok-sse-handler');
        });

        it('supports WS handler mounting', async () => {
            const port = basePort + 3905;
            let server: any = new McpServer({ name: 'ws-handler-server', version: '1.0.0' });
            trackCleanup(async () => {
                if (!server) return;
                try { await server.close(); } catch (_) {}
                server = null;
            });

            server.tool('status', {}, async () => ({
                content: [{ type: 'text', text: 'ok-ws-handler' }],
            }));

            const routes: Record<string, any> = {
                '/mcp': server.wsHandler(),
            };
            let host = new http.Server(port, routes);
            host.start();
            trackCleanup(() => {
                if (!host) return;
                try { host.stop(); } catch (_) {}
                host = null;
            });

            coroutine.sleep(50);

            let client: any = new McpClient({ name: 'ws-handler-client', version: '1.0.0' });
            trackCleanup(async () => {
                if (!client) return;
                try { await client.close(); } catch (_) {}
                client = null;
            });

            await withTimeout(client.connect({ transport: 'ws', url: `ws://127.0.0.1:${port}/mcp` }), 3000, 'ws handler connect');
            const result = await withTimeout(client.callTool({ name: 'status', arguments: {} }), 3000, 'ws handler callTool');
            assert.equal(extractFirstText(result), 'ok-ws-handler');
        });

    });
});
