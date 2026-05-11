import { describe, it } from 'node:test';
import assert from 'assert';
import coroutine from 'coroutine';
import http from 'http';

import {
    BidirectionalSession,
    ForwardingGateway,
    McpClient,
} from '../index';
import {
    CancelledNotificationSchema,
    McpError,
    NotificationSchema,
    ProgressNotificationSchema,
    RequestSchema,
    ResourceUpdatedNotificationSchema,
    ResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const basePort = coroutine.vmid * 10000 + 5100;
let portOffset = 0;

function nextPort(): number {
    portOffset += 1;
    return basePort + portOffset;
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

describe('ForwardingGateway', () => {
    it('terminates browser initialize locally and forwards requests through hooks', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientRequest: async (ctx, _next) => {
                if (!ctx.session.serverConnection) {
                    throw new Error('missing server connection');
                }

                if ((ctx.message as any).method === 'tools/list') {
                    return ctx.reply(await ctx.session.serverConnection.client.listTools((ctx.message as any).params));
                }

                if ((ctx.message as any).method === 'tools/call') {
                    return ctx.reply(await ctx.session.serverConnection.client.callTool((ctx.message as any).params));
                }

                const error: any = new Error(`method not supported: ${(ctx.message as any).method}`);
                error.code = -32601;
                throw error;
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.echo', {}, async () => ({
            content: [{ type: 'text', text: 'echo-from-agent' }],
        }));

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway'
            );

            const tools = await withTimeout(browser.listTools(), 3000, 'browser list tools through gateway');
            assert.ok(Array.isArray(tools.tools));
            assert.ok(tools.tools.some((tool: any) => tool.name === 'agent.echo'));

            const result = await withTimeout(
                browser.callTool({ name: 'agent.echo', arguments: {} }),
                3000,
                'browser call tool through gateway'
            );
            assert.equal(extractFirstText(result), 'echo-from-agent');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('defaults to forwarding common MCP requests and preserves reverse app tools for agent', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        gateway.tool('app.greet', {}, async () => ({
            content: [{ type: 'text', text: 'hello-from-app' }],
        }));

        agent.tool('agent.echo', {}, async () => ({
            content: [{ type: 'text', text: 'echo-from-agent' }],
        }));

        agent.tool('agent.proxy-app', {}, async (_args: any, ctx: any) => {
            const result = await ctx.client.callTool({ name: 'app.greet', arguments: {} });
            return {
                content: [{ type: 'text', text: `agent-got:${extractFirstText(result)}` }],
            };
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway with default forwarding'
            );

            const tools = await withTimeout(browser.listTools(), 3000, 'browser list tools through default gateway forwarding');
            assert.ok(Array.isArray(tools.tools));
            assert.ok(tools.tools.some((tool: any) => tool.name === 'agent.echo'));
            assert.ok(tools.tools.some((tool: any) => tool.name === 'agent.proxy-app'));
            assert.equal(tools.tools.some((tool: any) => tool.name === 'app.greet'), false);

            const proxyResult = await withTimeout(
                browser.callTool({ name: 'agent.proxy-app', arguments: {} }),
                3000,
                'browser call agent tool that reverses into app'
            );
            assert.equal(extractFirstText(proxyResult), 'agent-got:hello-from-app');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards agent progress notifications to browser by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.notify-progress', {}, async (_args: any, ctx: any) => {
            const progressToken = ctx.extra?._meta?.progressToken;

            if (progressToken !== undefined) {
                await ctx.extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress: 1,
                        total: 1,
                        message: 'agent-progress',
                    },
                });
            }

            return {
                content: [{ type: 'text', text: 'done' }],
            };
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for progress'
            );

            const progressEvents: any[] = [];
            let resolveProgress: (() => void) | null = null;
            const progressReceived = new Promise<void>((resolve) => {
                resolveProgress = resolve;
            });

            const result = await withTimeout(
                browser.callTool(
                    { name: 'agent.notify-progress', arguments: {} },
                    undefined,
                    {
                        onprogress(progress: any) {
                            progressEvents.push(progress);
                            if (resolveProgress) {
                                resolveProgress();
                                resolveProgress = null;
                            }
                        },
                    }
                ),
                3000,
                'browser call tool through gateway with progress'
            );

            assert.equal(extractFirstText(result), 'done');
            await withTimeout(progressReceived, 3000, 'receive forwarded progress notification');
            assert.equal(progressEvents.length, 1);
            assert.equal(progressEvents[0]?.progress, 1);
            assert.equal(progressEvents[0]?.total, 1);
            assert.equal(progressEvents[0]?.message, 'agent-progress');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards browser notifications to agent by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;
        let resolveCancelled: ((notification: any) => void) | null = null;
        const cancelledReceived = new Promise<any>((resolve) => {
            resolveCancelled = resolve;
        });

        agent.setNotificationHandler(CancelledNotificationSchema as any, async (notification: any) => {
            if (resolveCancelled) {
                resolveCancelled(notification);
                resolveCancelled = null;
            }
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for notification forwarding'
            );

            await withTimeout(
                browser.notification({
                    method: 'notifications/cancelled',
                    params: { requestId: 99, reason: 'browser-cancelled' },
                }),
                3000,
                'browser send cancelled notification through gateway'
            );

            const notification = await withTimeout(cancelledReceived, 3000, 'agent receive forwarded cancelled notification');
            assert.equal(notification?.params?.requestId, 99);
            assert.equal(notification?.params?.reason, 'browser-cancelled');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards browser progress notifications to agent by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;
        let resolveProgress: ((notification: any) => void) | null = null;
        const progressReceived = new Promise<any>((resolve) => {
            resolveProgress = resolve;
        });

        agent.setNotificationHandler(ProgressNotificationSchema as any, async (notification: any) => {
            if (resolveProgress) {
                resolveProgress(notification);
                resolveProgress = null;
            }
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for progress notification forwarding'
            );

            await withTimeout(
                browser.notification({
                    method: 'notifications/progress',
                    params: { progressToken: 'browser-progress', progress: 0.5, total: 1 },
                }),
                3000,
                'browser send progress notification through gateway'
            );

            const notification = await withTimeout(progressReceived, 3000, 'agent receive forwarded progress notification');
            assert.equal(notification?.params?.progressToken, 'browser-progress');
            assert.equal(notification?.params?.progress, 0.5);
            assert.equal(notification?.params?.total, 1);
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards custom browser JSON-RPC notifications to agent by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;
        let resolveNotification: ((notification: any) => void) | null = null;
        const notificationReceived = new Promise<any>((resolve) => {
            resolveNotification = resolve;
        });

        const BrowserCustomNotificationSchema = (NotificationSchema as any).extend({
            method: z.literal('browser/custom-event'),
        });

        agent.setNotificationHandler(BrowserCustomNotificationSchema, async (notification: any) => {
            if (resolveNotification) {
                resolveNotification(notification);
                resolveNotification = null;
            }
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for custom notification forwarding'
            );

            await withTimeout(
                browser.notification({
                    method: 'browser/custom-event',
                    params: { payload: 'custom-jsonrpc' },
                } as any),
                3000,
                'browser send custom notification through gateway'
            );

            const notification = await withTimeout(notificationReceived, 3000, 'agent receive forwarded custom notification');
            assert.equal(notification?.method, 'browser/custom-event');
            assert.equal(notification?.params?.payload, 'custom-jsonrpc');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards custom browser JSON-RPC requests to agent by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        const BrowserCustomRequestSchema = (RequestSchema as any).extend({
            method: z.literal('browser/custom-request'),
            params: z.object({
                payload: z.string(),
            }),
        });
        const BrowserCustomResultSchema = (ResultSchema as any).extend({
            echoed: z.string(),
        });

        agent.setRequestHandler(BrowserCustomRequestSchema, async (request: any) => ({
            echoed: `agent:${request.params.payload}`,
        }));

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for custom request forwarding'
            );

            const result = await withTimeout(
                browser.request({
                    method: 'browser/custom-request',
                    params: { payload: 'custom-request' },
                } as any, BrowserCustomResultSchema),
                3000,
                'browser send custom request through gateway'
            );

            assert.equal(result?.echoed, 'agent:custom-request');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('onClientRequest middleware: next() passes request through to server unchanged', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const intercepted: string[] = [];
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientRequest: async (ctx, next) => {
                intercepted.push((ctx.message as any).method);
                return next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.echo', {}, async () => ({
            content: [{ type: 'text', text: 'echo-via-next' }],
        }));

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            const result = await withTimeout(
                browser.callTool({ name: 'agent.echo', arguments: {} }),
                3000, 'call tool via next()'
            );
            assert.equal(extractFirstText(result), 'echo-via-next');
            assert.ok(intercepted.includes('tools/call'));
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientRequest middleware: next(modified) rewrites request before forwarding', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientRequest: async (ctx, next) => {
                const msg = ctx.message as any;
                if (msg.method === 'tools/call' && msg.params?.name === 'agent.echo') {
                    // Rewrite the tool name to the real one and inject an extra arg
                    return next({
                        ...ctx.message,
                        params: { ...msg.params, name: 'agent.echo-renamed' },
                    } as any);
                }
                return next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.echo-renamed', {}, async () => ({
            content: [{ type: 'text', text: 'rewritten-tool' }],
        }));

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            const result = await withTimeout(
                browser.callTool({ name: 'agent.echo', arguments: {} }),
                3000, 'call tool with rewritten name'
            );
            assert.equal(extractFirstText(result), 'rewritten-tool');
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientRequest middleware: ctx.reply() responds locally without forwarding', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        let agentCallCount = 0;
        agent.tool('agent.echo', {}, async () => {
            agentCallCount++;
            return { content: [{ type: 'text', text: 'from-agent' }] };
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientRequest: async (ctx, _next) => {
                if ((ctx.message as any).method === 'tools/call') {
                    return ctx.reply({
                        content: [{ type: 'text', text: 'local-reply' }],
                    });
                }
                return _next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            const result = await withTimeout(
                browser.callTool({ name: 'agent.echo', arguments: {} }),
                3000, 'call tool intercepted locally'
            );
            assert.equal(extractFirstText(result), 'local-reply');
            assert.equal(agentCallCount, 0);
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientRequest middleware: throw sends JSON-RPC error to client', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientRequest: async (_ctx, _next) => {
                const err: any = new Error('blocked by middleware');
                err.code = -32099;
                throw err;
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.echo', {}, async () => ({ content: [{ type: 'text', text: 'should-not-reach' }] }));

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            let caught: any = null;
            try {
                await withTimeout(
                    browser.callTool({ name: 'agent.echo', arguments: {} }),
                    3000, 'blocked call'
                );
            } catch (e: any) {
                caught = e;
            }

            assert.ok(caught instanceof Error);
            assert.equal(caught?.code, -32099);
            assert.ok(String(caught?.message).includes('blocked by middleware'));
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientNotification middleware: next() passes notification through to server', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const intercepted: string[] = [];
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientNotification: async (ctx, next) => {
                intercepted.push((ctx.message as any).method);
                return next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;
        let resolveCancelled: ((n: any) => void) | null = null;
        const cancelledReceived = new Promise<any>((resolve) => { resolveCancelled = resolve; });
        agent.setNotificationHandler(CancelledNotificationSchema as any, async (n: any) => {
            if (resolveCancelled) { resolveCancelled(n); resolveCancelled = null; }
        });

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            await withTimeout(
                browser.notification({ method: 'notifications/cancelled', params: { requestId: 42, reason: 'test' } }),
                3000, 'send notification'
            );

            const n = await withTimeout(cancelledReceived, 3000, 'server receive notification');
            assert.equal(n?.params?.requestId, 42);
            assert.ok(intercepted.includes('notifications/cancelled'));
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientNotification middleware: not calling next() suppresses forwarding', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        let agentReceivedCount = 0;
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientNotification: async (_ctx, _next) => {
                // intentionally suppress all notifications
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.setNotificationHandler(CancelledNotificationSchema as any, async (_n: any) => {
            agentReceivedCount++;
        });

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            await withTimeout(
                browser.notification({ method: 'notifications/cancelled', params: { requestId: 1, reason: 'suppressed' } }),
                3000, 'send suppressed notification'
            );

            coroutine.sleep(100);
            assert.equal(agentReceivedCount, 0);
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onServerNotification middleware: next() passes notification through to client', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const intercepted: string[] = [];
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onServerNotification: async (ctx, next) => {
                intercepted.push((ctx.message as any).method);
                return next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.send-progress', {}, async (_args: any, ctx: any) => {
            const progressToken = ctx.extra?._meta?.progressToken;
            if (progressToken !== undefined) {
                await ctx.extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress: 1, total: 1, message: 'done' },
                });
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            let resolveProgress: (() => void) | null = null;
            const progressReceived = new Promise<void>((r) => { resolveProgress = r; });
            const progressEvents: any[] = [];

            const result = await withTimeout(
                browser.callTool({ name: 'agent.send-progress', arguments: {} }, undefined, {
                    onprogress(p: any) {
                        progressEvents.push(p);
                        if (resolveProgress) { resolveProgress(); resolveProgress = null; }
                    },
                }),
                3000, 'call tool'
            );

            assert.equal(extractFirstText(result), 'ok');
            await withTimeout(progressReceived, 3000, 'receive progress via onServerNotification next()');
            assert.equal(progressEvents.length, 1);
            assert.ok(intercepted.includes('notifications/progress'));
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onServerNotification middleware: not calling next() suppresses forwarding to client', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onServerNotification: async (_ctx, _next) => {
                // suppress all server notifications
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.send-progress', {}, async (_args: any, ctx: any) => {
            const progressToken = ctx.extra?._meta?.progressToken;
            if (progressToken !== undefined) {
                await ctx.extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress: 1, total: 1, message: 'suppressed' },
                });
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            const progressEvents: any[] = [];
            const result = await withTimeout(
                browser.callTool({ name: 'agent.send-progress', arguments: {} }, undefined, {
                    onprogress(p: any) { progressEvents.push(p); },
                }),
                3000, 'call tool with suppressed notifications'
            );

            assert.equal(extractFirstText(result), 'done');
            coroutine.sleep(100);
            assert.equal(progressEvents.length, 0);
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onServerNotification middleware: next(modified) rewrites notification before forwarding to client', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onServerNotification: async (ctx, next) => {
                const msg = ctx.message as any;
                if (msg.method === 'notifications/progress') {
                    return next({
                        ...ctx.message,
                        params: { ...msg.params, message: 'rewritten-by-gateway' },
                    } as any);
                }
                return next();
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.tool('agent.send-progress', {}, async (_args: any, ctx: any) => {
            const progressToken = ctx.extra?._meta?.progressToken;
            if (progressToken !== undefined) {
                await ctx.extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken, progress: 1, total: 1, message: 'original' },
                });
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            let resolveProgress: (() => void) | null = null;
            const progressReceived = new Promise<void>((r) => { resolveProgress = r; });
            const progressEvents: any[] = [];

            await withTimeout(
                browser.callTool({ name: 'agent.send-progress', arguments: {} }, undefined, {
                    onprogress(p: any) {
                        progressEvents.push(p);
                        if (resolveProgress) { resolveProgress(); resolveProgress = null; }
                    },
                }),
                3000, 'call tool'
            );

            await withTimeout(progressReceived, 3000, 'receive rewritten progress notification');
            assert.equal(progressEvents.length, 1);
            assert.equal(progressEvents[0]?.message, 'rewritten-by-gateway');
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('onClientDisconnect is called when a client disconnects', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        let disconnectedSessionId: string | null = null;
        let resolveDisconnect: (() => void) | null = null;
        const disconnectReceived = new Promise<void>((r) => { resolveDisconnect = r; });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
            onClientDisconnect: (session) => {
                disconnectedSessionId = session.clientSessionId;
                if (resolveDisconnect) { resolveDisconnect(); resolveDisconnect = null; }
            },
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        try {
            agentHost = new http.Server(agentPort, { '/mcp': agent.wsHandler() });
            gatewayHost = new http.Server(gatewayPort, { '/mcp': gateway.wsHandler() });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000, 'connect'
            );

            await browser.close();
            browser = null;

            await withTimeout(disconnectReceived, 3000, 'receive onClientDisconnect callback');
            assert.ok(typeof disconnectedSessionId === 'string' && disconnectedSessionId.length > 0);
        } finally {
            if (browser) { try { await browser.close(); } catch (_) {} }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) { try { gatewayHost.stop(); } catch (_) {} }
            if (agentHost) { try { agentHost.stop(); } catch (_) {} }
        }
    });

    it('propagates custom agent JSON-RPC request errors to browser by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        const BrowserFailRequestSchema = (RequestSchema as any).extend({
            method: z.literal('browser/custom-fail'),
            params: z.object({
                reason: z.string().optional(),
            }).optional(),
        });
        const BrowserFailResultSchema = (ResultSchema as any).extend({
            ok: z.boolean(),
        });

        agent.setRequestHandler(BrowserFailRequestSchema, async (request: any) => {
            throw new McpError(-32077, `agent-failure:${request.params?.reason || 'unknown'}`, {
                source: 'agent',
            });
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({ name: 'browser-client', version: '1.0.0' });
            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for custom request error forwarding'
            );

            let caught: any = null;
            try {
                await withTimeout(
                    browser.request({
                        method: 'browser/custom-fail',
                        params: { reason: 'boom' },
                    } as any, BrowserFailResultSchema),
                    3000,
                    'browser send failing custom request through gateway'
                );
            } catch (error: any) {
                caught = error;
            }

            assert.ok(caught instanceof Error);
            assert.equal(caught?.code, -32077);
            assert.ok(String(caught?.message || '').indexOf('agent-failure:boom') >= 0);
            assert.equal(caught?.data?.source, 'agent');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });

    it('forwards agent resource updated notifications to browser by default', async () => {
        const agentPort = nextPort();
        const gatewayPort = nextPort();
        const agent = new BidirectionalSession({
            serverInfo: { name: 'agent-server', version: '1.0.0' },
            clientInfo: { name: 'agent-client', version: '1.0.0' },
        });
        const gateway = new ForwardingGateway({
            appInfo: { name: 'app-gateway', version: '1.0.0' },
            connectServer: async () => ({ transport: 'ws', url: `ws://127.0.0.1:${agentPort}/mcp` }),
        });
        let agentHost: any = null;
        let gatewayHost: any = null;
        let browser: McpClient | null = null;

        agent.registerCapabilities({
            resources: {
                subscribe: true,
            },
        });

        agent.tool('agent.notify-resource-updated', {}, async (_args: any, ctx: any) => {
            await ctx.extra.sendNotification({
                method: 'notifications/resources/updated',
                params: { uri: 'file:///docs/example.txt' },
            });

            return {
                content: [{ type: 'text', text: 'resource-updated-sent' }],
            };
        });

        try {
            agentHost = new http.Server(agentPort, {
                '/mcp': agent.wsHandler(),
            });
            gatewayHost = new http.Server(gatewayPort, {
                '/mcp': gateway.wsHandler(),
            });
            agentHost.start();
            gatewayHost.start();
            coroutine.sleep(50);

            browser = new McpClient({
                name: 'browser-client',
                version: '1.0.0',
            }, {
                capabilities: {
                    resources: {
                        subscribe: true,
                    },
                },
            } as any);

            let resolveUpdated: ((notification: any) => void) | null = null;
            const updatedReceived = new Promise<any>((resolve) => {
                resolveUpdated = resolve;
            });

            browser.setNotificationHandler(ResourceUpdatedNotificationSchema as any, async (notification: any) => {
                if (resolveUpdated) {
                    resolveUpdated(notification);
                    resolveUpdated = null;
                }
            });

            await withTimeout(
                browser.connect({ transport: 'ws', url: `ws://127.0.0.1:${gatewayPort}/mcp` }),
                3000,
                'browser connect forwarding gateway for resource updated notification'
            );

            const result = await withTimeout(
                browser.callTool({ name: 'agent.notify-resource-updated', arguments: {} }),
                3000,
                'browser call agent tool that emits resource updated notification'
            );

            assert.equal(extractFirstText(result), 'resource-updated-sent');

            const notification = await withTimeout(
                updatedReceived,
                3000,
                'browser receive forwarded resource updated notification'
            );

            assert.equal(notification?.params?.uri, 'file:///docs/example.txt');
        } finally {
            if (browser) {
                try { await browser.close(); } catch (_) {}
            }
            try { await gateway.close(); } catch (_) {}
            try { await agent.close(); } catch (_) {}
            if (gatewayHost) {
                try { gatewayHost.stop(); } catch (_) {}
            }
            if (agentHost) {
                try { agentHost.stop(); } catch (_) {}
            }
        }
    });
});