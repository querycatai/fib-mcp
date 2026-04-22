import { describe, it } from 'node:test';
import assert from 'assert';
import coroutine from 'coroutine';
import http from 'http';

import {
    BidirectionalSession,
    McpClient,
} from '../index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const basePort = coroutine.vmid * 10000 + 4100;
let portOffset = 0;

function nextPort(): number {
    portOffset += 1;
    return basePort + portOffset;
}

function createSession(name: string, clientName: string, extraOptions: any = {}): BidirectionalSession {
    return new BidirectionalSession({
        serverInfo: { name, version: '1.0.0' },
        clientInfo: { name: clientName, version: '1.0.0' },
        ...extraOptions,
    });
}

function extractFirstText(result: any): string {
    return result?.content?.[0]?.text ?? '';
}

function createTransportPair() {
    return InMemoryTransport.createLinkedPair();
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

describe('BidirectionalSession public APIs', () => {
    it('supports bidirectional MCP calls through handler and open', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client', {
            serverInfo: { name: 'peer-server', version: '1.0.0' },
        });
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.ping', {}, async (_args: any, _ctx: any) => ({
            content: [{ type: 'text', text: 'pong-from-accepted' }],
        }));

        accepted.tool('server.proxy', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.echo', arguments: {} }),
                3000,
                'accepted reverse call'
            );

            return {
                content: [{ type: 'text', text: `proxy:${extractFirstText(nested)}` }],
            };
        });

        peer.tool('peer.echo', {}, async (_args: any, _ctx: any) => ({
            content: [{ type: 'text', text: 'echo-from-peer' }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(
                peer.connectWs(`ws://127.0.0.1:${port}/mcp`),
                3000,
                'bidirectional open'
            );

            const [fromAccepted, fromPeer] = await Promise.all([
                withTimeout(connection.client.callTool({ name: 'server.ping', arguments: {} }), 3000, 'call accepted tool'),
                withTimeout(connection.client.callTool({ name: 'server.proxy', arguments: {} }), 3000, 'call peer through accepted tool'),
            ]);

            assert.equal(extractFirstText(fromAccepted), 'pong-from-accepted');
            assert.equal(extractFirstText(fromPeer), 'proxy:echo-from-peer');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('injects the accepted-side client into tool callbacks', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client', {
            serverInfo: { name: 'peer-server', version: '1.0.0' },
        });
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.has-client', {}, async (_args: any, ctx: any) => ({
            content: [{ type: 'text', text: String(ctx.client instanceof McpClient) }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(peer.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'bidirectional open');

            const result = await withTimeout(
                connection.client.callTool({ name: 'server.has-client', arguments: {} }),
                3000,
                'call has-client tool'
            );

            assert.equal(extractFirstText(result), 'true');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('supports reverse tool calls from injected accepted-side client', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client', {
            serverInfo: { name: 'peer-server', version: '1.0.0' },
        });
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.proxy', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.echo', arguments: {} }),
                3000,
                'accepted reverse call'
            );

            return {
                content: [{ type: 'text', text: `proxy:${extractFirstText(nested)}` }],
            };
        });

        peer.tool('peer.echo', {}, async (_args: any, _ctx: any) => ({
            content: [{ type: 'text', text: 'echo-from-peer' }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(peer.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'bidirectional open');

            const result = await withTimeout(
                connection.client.callTool({ name: 'server.proxy', arguments: {} }),
                3000,
                'public reverse call'
            );

            assert.equal(extractFirstText(result), 'proxy:echo-from-peer');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('enables reverse calls by default', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client', {
            serverInfo: { name: 'peer-server', version: '1.0.0' },
        });
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.proxy', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.echo', arguments: {} }),
                3000,
                'accepted reverse call by auto negotiation'
            );

            return {
                content: [{ type: 'text', text: `proxy:${extractFirstText(nested)}` }],
            };
        });

        peer.tool('peer.echo', {}, async () => ({
            content: [{ type: 'text', text: 'echo-from-peer' }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(peer.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'open with auto reverse negotiation');

            const result = await withTimeout(
                connection.client.callTool({ name: 'server.proxy', arguments: {} }),
                3000,
                'reverse call via auto negotiation'
            );

            assert.equal(extractFirstText(result), 'proxy:echo-from-peer');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('requires server info in constructor options', async () => {
        assert.throws(
            () => new BidirectionalSession({
                clientInfo: { name: 'peer-client', version: '1.0.0' },
            } as any),
            /requires serverInfo/
        );
    });

    it('routes each callback to the matching client connection', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peerOne = createSession('peer-one', 'peer-one-client', {
            serverInfo: { name: 'peer-one', version: '1.0.0' },
        });
        const peerTwo = createSession('peer-two', 'peer-two-client', {
            serverInfo: { name: 'peer-two', version: '1.0.0' },
        });
        let connectionOne: any = null;
        let connectionTwo: any = null;
        let host: any = null;

        accepted.tool('server.route-peer', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.identity', arguments: {} }),
                3000,
                'route peer identity'
            );

            return {
                content: [{ type: 'text', text: extractFirstText(nested) }],
            };
        });

        peerOne.tool('peer.identity', {}, async (_args: any, _ctx: any) => ({
            content: [{ type: 'text', text: 'peer-one' }],
        }));

        peerTwo.tool('peer.identity', {}, async (_args: any, _ctx: any) => ({
            content: [{ type: 'text', text: 'peer-two' }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            [connectionOne, connectionTwo] = await Promise.all([
                withTimeout(peerOne.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'open peer one'),
                withTimeout(peerTwo.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'open peer two'),
            ]);

            const [resultOne, resultTwo] = await Promise.all([
                withTimeout(connectionOne.client.callTool({ name: 'server.route-peer', arguments: {} }), 3000, 'route peer one'),
                withTimeout(connectionTwo.client.callTool({ name: 'server.route-peer', arguments: {} }), 3000, 'route peer two'),
            ]);

            assert.equal(extractFirstText(resultOne), 'peer-one');
            assert.equal(extractFirstText(resultTwo), 'peer-two');
        } finally {
            if (connectionOne) {
                try { await connectionOne.close(); } catch (_) {}
            }
            if (connectionTwo) {
                try { await connectionTwo.close(); } catch (_) {}
            }
            try { await peerOne.close(); } catch (_) {}
            try { await peerTwo.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('handles 20 concurrent clients with 20 parallel roundtrip calls each', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peers: BidirectionalSession[] = [];
        const connections: any[] = [];
        let host: any = null;

        accepted.tool('server.roundtrip', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.identity', arguments: {} }),
                5000,
                'concurrent peer identity'
            );

            return {
                content: [{ type: 'text', text: `server:${extractFirstText(nested)}` }],
            };
        });

        try {
            for (let index = 0; index < 20; index += 1) {
                const peerId = `peer-${index}`;
                const peer = createSession(peerId, `${peerId}-client`, {
                    serverInfo: { name: peerId, version: '1.0.0' },
                });

                peer.tool('peer.identity', {}, async () => ({
                    content: [{ type: 'text', text: peerId }],
                }));

                peers.push(peer);
            }

            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            const openedConnections = await withTimeout(
                Promise.all(
                    peers.map((peer) => peer.connectWs(`ws://127.0.0.1:${port}/mcp`))
                ),
                15000,
                'open 20 concurrent clients'
            );

            connections.push(...openedConnections);

            await withTimeout(
                Promise.all(
                    connections.map(async (connection: any, index: number) => {
                        const expected = `server:peer-${index}`;

                        const results = await Promise.all(
                            Array.from({ length: 20 }, (_, round) => (
                                withTimeout(
                                    connection.client.callTool({ name: 'server.roundtrip', arguments: {} }),
                                    5000,
                                    `client ${index} round ${round}`
                                )
                            ))
                        );

                        for (const result of results) {
                            assert.equal(extractFirstText(result), expected);
                        }
                    })
                ),
                30000,
                '20 concurrent clients x 20 rounds'
            );
        } finally {
            for (const connection of connections) {
                try { await connection.close(); } catch (_) {}
            }

            for (const peer of peers) {
                try { await peer.close(); } catch (_) {}
            }

            try { await accepted.close(); } catch (_) {}

            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('exposes the accepted-side sessionId in tool callback extra', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client');
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.sessionId', {}, async (_args: any, ctx: any) => {
            assert.ok(typeof ctx.extra?.sessionId === 'string');
            assert.ok(ctx.extra.sessionId.length > 0);

            return {
                content: [{ type: 'text', text: String(ctx.extra.sessionId) }],
            };
        });

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(peer.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'bidirectional open');

            const result = await withTimeout(
                connection.client.callTool({ name: 'server.sessionId', arguments: {} }),
                3000,
                'call server sessionId tool'
            );

            assert.ok(extractFirstText(result).length > 0);
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('delivers progress notifications to the peer client through public APIs', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client');
        let connection: any = null;
        let host: any = null;

        accepted.tool('server.notify', {}, async (_args: any, ctx: any) => {
            const progressToken = ctx.extra?._meta?.progressToken;

            if (progressToken !== undefined) {
                await ctx.extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress: 1,
                        total: 1,
                        message: 'accepted-progress',
                    },
                });
            }

            return {
                content: [{ type: 'text', text: 'notified' }],
            };
        });

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            connection = await withTimeout(peer.connectWs(`ws://127.0.0.1:${port}/mcp`), 3000, 'bidirectional open');

            const progressEvents: any[] = [];
            let resolveProgress: (() => void) | null = null;
            const progressReceived = new Promise<void>((resolve) => {
                resolveProgress = resolve;
            });

            const result = await withTimeout(
                connection.client.callTool(
                    { name: 'server.notify', arguments: {} },
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
                'call server notify tool'
            );

            assert.equal(extractFirstText(result), 'notified');
            await withTimeout(progressReceived, 3000, 'receive progress notification');
            assert.equal(progressEvents.length, 1);
            assert.equal(progressEvents[0]?.progress, 1);
            assert.equal(progressEvents[0]?.total, 1);
            assert.equal(progressEvents[0]?.message, 'accepted-progress');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('falls back to unidirectional mode when reverse is not negotiated', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = new McpClient({ name: 'plain-client', version: '1.0.0' });
        let host: any = null;

        accepted.tool('server.ping', {}, async () => ({
            content: [{ type: 'text', text: 'pong-from-accepted' }],
        }));

        accepted.tool('server.proxy-optional', {}, async (_args: any, ctx: any) => {
            try {
                await ctx.client.callTool({ name: 'peer.echo', arguments: {} });
                return { content: [{ type: 'text', text: 'unexpected-reverse-success' }] };
            } catch (error: any) {
                return { content: [{ type: 'text', text: `reverse-disabled:${String(error?.message || error)}` }] };
            }
        });

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            await withTimeout(
                peer.connectWs(`ws://127.0.0.1:${port}/mcp`),
                3000,
                'open without reverse negotiation'
            );

            const ping = await withTimeout(
                peer.callTool({ name: 'server.ping', arguments: {} }),
                3000,
                'normal forward call in unidirectional mode'
            );
            assert.equal(extractFirstText(ping), 'pong-from-accepted');

            const proxy = await withTimeout(
                peer.callTool({ name: 'server.proxy-optional', arguments: {} }),
                3000,
                'reverse call should be blocked without negotiation'
            );
            const proxyText = extractFirstText(proxy);
            assert.ok(proxyText.indexOf('reverse-disabled:') === 0, `proxyText=${proxyText}`);
        } finally {
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('supports forward calls from a normal MCP ws client', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const client = new McpClient({ name: 'plain-client', version: '1.0.0' });
        let host: any = null;

        accepted.tool('server.ping', {}, async () => ({
            content: [{ type: 'text', text: 'pong-from-accepted' }],
        }));

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            await withTimeout(
                client.connectWs(`ws://127.0.0.1:${port}/mcp`),
                3000,
                'normal ws client connect to bidirectional handler'
            );

            const result = await withTimeout(
                client.callTool({ name: 'server.ping', arguments: {} }),
                3000,
                'normal ws client forward call'
            );

            assert.equal(extractFirstText(result), 'pong-from-accepted');
        } finally {
            try { await client.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('blocks reverse calls when using a normal MCP ws client', async () => {
        const port = nextPort();
        const accepted = createSession('accepted-server', 'accepted-client');
        const client = new McpClient({ name: 'plain-client', version: '1.0.0' });
        let host: any = null;

        accepted.tool('server.proxy-plain', {}, async (_args: any, ctx: any) => {
            try {
                await ctx.client.callTool({ name: 'peer.echo', arguments: {} });
                return { content: [{ type: 'text', text: 'unexpected-reverse-success' }] };
            } catch (error: any) {
                return { content: [{ type: 'text', text: `reverse-disabled:${String(error?.message || error)}` }] };
            }
        });

        try {
            host = new http.Server(port, {
                '/mcp': accepted.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            await withTimeout(
                client.connectWs(`ws://127.0.0.1:${port}/mcp`),
                3000,
                'normal ws client connect for reverse blocked check'
            );

            const result = await withTimeout(
                client.callTool({ name: 'server.proxy-plain', arguments: {} }),
                3000,
                'normal ws client reverse should be blocked'
            );

            const resultText = extractFirstText(result);
            assert.ok(resultText.indexOf('reverse-disabled:') === 0, `resultText=${resultText}`);
        } finally {
            try { await client.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });

    it('supports the same bidirectional protocol over custom SDK transport', async () => {
        const accepted = createSession('accepted-server', 'accepted-client');
        const peer = createSession('peer-server', 'peer-client', {
            serverInfo: { name: 'peer-server', version: '1.0.0' },
        });
        let acceptedConnection: any = null;
        let peerConnection: any = null;

        accepted.tool('server.proxy', {}, async (_args: any, ctx: any) => {
            const nested = await withTimeout(
                ctx.client.callTool({ name: 'peer.echo', arguments: {} }),
                3000,
                'accepted reverse call over ndjson transport'
            );

            return {
                content: [{ type: 'text', text: `proxy:${extractFirstText(nested)}` }],
            };
        });

        peer.tool('peer.echo', {}, async () => ({
            content: [{ type: 'text', text: 'echo-from-peer' }],
        }));

        try {
            const [acceptedTransport, peerTransport] = createTransportPair();

            acceptedConnection = await withTimeout(
                accepted.accept(acceptedTransport),
                3000,
                'accepted attach ndjson transport'
            );

            peerConnection = await withTimeout(
                peer.connect(peerTransport),
                3000,
                'peer attach ndjson transport'
            );

            const result = await withTimeout(
                peerConnection.client.callTool({ name: 'server.proxy', arguments: {} }),
                3000,
                'forward call over ndjson transport'
            );

            assert.equal(extractFirstText(result), 'proxy:echo-from-peer');
        } finally {
            if (peerConnection) {
                try { await peerConnection.close(); } catch (_) {}
            }
            if (acceptedConnection) {
                try { await acceptedConnection.close(); } catch (_) {}
            }
            try { await peer.close(); } catch (_) {}
            try { await accepted.close(); } catch (_) {}
        }
    });
});

describe('BidirectionalSession stdio mode', () => {
    it('supports bidirectional MCP over stdio transport', async () => {
        const parentSession = new BidirectionalSession({
            serverInfo: { name: 'parent-server', version: '1.0.0' },
            clientInfo: { name: 'parent-client', version: '1.0.0' },
        });

        parentSession.tool('parent.greet', {}, async () => ({
            content: [{ type: 'text', text: 'hello-from-parent' }],
        }));

        let connection: any = null;
        try {
            connection = await withTimeout(
                parentSession.connectStdio('fibjs', ['test/fixtures/stdio_bidirectional_child.ts']),
                5000,
                'parent connect via stdio'
            );

            // Call child.echo directly from parent (forward call)
            const childEchoResult = await withTimeout(
                connection.client.callTool({ name: 'child.echo', arguments: {} }),
                3000,
                'call child echo'
            );
            assert.equal(extractFirstText(childEchoResult), 'echo-from-child');

            // Call child.proxy which makes a reverse call to parent.greet
            const reverseProxyResult = await withTimeout(
                connection.client.callTool({ name: 'child.proxy', arguments: {} }),
                3000,
                'call child proxy (reverse to parent)'
            );
            assert.equal(extractFirstText(reverseProxyResult), 'child-got:hello-from-parent');
        } finally {
            if (connection) {
                try { await connection.close(); } catch (_) {}
            }
            try { await parentSession.close(); } catch (_) {}
        }
    });

    it('supports forward calls from a normal MCP stdio client', async () => {
        const plainServer = new McpClient({ name: 'plain-client', version: '1.0.0' });

        try {
            await withTimeout(
                plainServer.connectStdio('fibjs', ['test/fixtures/stdio_plain_server.ts']),
                5000,
                'plain stdio client connect'
            );

            const result = await withTimeout(
                plainServer.callTool({ name: 'server.ping', arguments: {} }),
                3000,
                'plain stdio client forward call'
            );

            assert.equal(extractFirstText(result), 'pong-from-stdio-server');
        } finally {
            try { await plainServer.close(); } catch (_) {}
        }
    });

    it('blocks reverse calls when using a normal MCP stdio client', async () => {
        // Test: BidirectionalSession with reverse support, but plain HTTP client cannot use reverse
        const port = nextPort();
        const bidirectionalServer = new BidirectionalSession({
            serverInfo: { name: 'bidirectional-http-server', version: '1.0.0' },
            clientInfo: { name: 'bidirectional-http-client', version: '1.0.0' },
        });

        bidirectionalServer.tool('server.proxy-plain', {}, async (_args: any, ctx: any) => {
            try {
                await ctx.client.callTool({ name: 'peer.echo', arguments: {} });
                return { content: [{ type: 'text', text: 'unexpected-reverse-success' }] };
            } catch (error: any) {
                return { content: [{ type: 'text', text: `reverse-disabled:${String(error?.message || error)}` }] };
            }
        });

        const plainClient = new McpClient({ name: 'plain-http-client', version: '1.0.0' });
        let host: any = null;

        try {
            host = new http.Server(port, {
                '/mcp': bidirectionalServer.wsHandler(),
            });
            host.start();
            coroutine.sleep(50);

            await withTimeout(
                plainClient.connectWs(`ws://127.0.0.1:${port}/mcp`),
                3000,
                'plain http client connect to bidirectional handler'
            );

            const result = await withTimeout(
                plainClient.callTool({ name: 'server.proxy-plain', arguments: {} }),
                3000,
                'plain http client call reverse-enabled tool should be blocked'
            );

            const resultText = extractFirstText(result);
            assert.ok(resultText.indexOf('reverse-disabled:') === 0, `resultText=${resultText}`);
        } finally {
            try { await plainClient.close(); } catch (_) {}
            try { await bidirectionalServer.close(); } catch (_) {}
            if (host) {
                try { host.stop(); } catch (_) {}
            }
        }
    });
});