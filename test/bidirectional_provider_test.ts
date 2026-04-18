import { describe, it } from 'node:test';
import assert from 'assert';

import { BidirectionalSession, McpClient, McpServer } from '../index';
import type { BidirectionalWebSocket } from '../index';

class CaptureEndpoint {
    transport: any = null;

    async connect(transport: any): Promise<void> {
        this.transport = transport;
    }
}

class MemorySocket implements BidirectionalWebSocket {
    onmessage: ((message: any) => void) | null = null;
    onerror: ((error: any) => void) | null = null;
    onclose: (() => void) | null = null;

    private _peer: MemorySocket | null = null;
    private _isClosed = false;

    bindPeer(peer: MemorySocket): void {
        this._peer = peer;
    }

    async send(data: string): Promise<void> {
        if (this._isClosed) throw new Error('MemorySocket closed');
        if (!this._peer) throw new Error('MemorySocket peer missing');

        this._peer.onmessage?.(data);
    }

    emitDataMessage(data: string): void {
        this.onmessage?.({ data });
    }

    emitJsonMessage(message: any): void {
        this.onmessage?.({
            json() {
                return message;
            },
        });
    }

    emitError(error: Error): void {
        this.onerror?.(error);
    }

    async close(): Promise<void> {
        if (this._isClosed) return;
        this._isClosed = true;
        this.onclose?.();

        const peer = this._peer;
        if (peer && !peer._isClosed) {
            peer._isClosed = true;
            peer.onclose?.();
        }
    }
}

function createMemoryPair(): { left: MemorySocket; right: MemorySocket } {
    const left = new MemorySocket();
    const right = new MemorySocket();
    left.bindPeer(right);
    right.bindPeer(left);
    return { left, right };
}

describe('BidirectionalSession', () => {
    it('supports bidirectional MCP calls over one shared websocket', async () => {
        const { left, right } = createMemoryPair();

        const leftServer = new McpServer({ name: 'left-server', version: '1.0.0' });
        const rightServer = new McpServer({ name: 'right-server', version: '1.0.0' });

        leftServer.tool('ai.chat', {}, async () => ({
            content: [{ type: 'text', text: 'chat-from-left' }],
        }));

        rightServer.tool('order.query', {}, async () => ({
            content: [{ type: 'text', text: 'order-from-right' }],
        }));

        const [leftProvider, rightProvider] = await Promise.all([
            BidirectionalSession.connect(left, leftServer, { clientInfo: { name: 'left-client', version: '1.0.0' } }),
            BidirectionalSession.connect(right, rightServer, { clientInfo: { name: 'right-client', version: '1.0.0' } }),
        ]);

        const leftClient = leftProvider.client;
        const rightClient = rightProvider.client;

        const [leftResult, rightResult] = await Promise.all([
            leftClient.callTool({ name: 'order.query', arguments: {} }),
            rightClient.callTool({ name: 'ai.chat', arguments: {} }),
        ]);

        assert.equal(leftResult?.content?.[0]?.text, 'order-from-right');
        assert.equal(rightResult?.content?.[0]?.text, 'chat-from-left');

        await Promise.all([
            leftClient.close(),
            rightClient.close(),
            leftServer.close(),
            rightServer.close(),
            leftProvider.close(),
            rightProvider.close(),
        ]);
    });

    it('propagates websocket close to both logical sides', async () => {
        const { left, right } = createMemoryPair();
        const leftServer = new CaptureEndpoint();
        const leftClient = new CaptureEndpoint();
        const rightServer = new CaptureEndpoint();
        const rightClient = new CaptureEndpoint();

        const [leftSession, rightSession] = await Promise.all([
            BidirectionalSession.connect(left, leftServer, { client: leftClient }),
            BidirectionalSession.connect(right, rightServer, { client: rightClient }),
        ]);

        let leftServerClosed = 0;
        let leftClientClosed = 0;
        let rightServerClosed = 0;
        let rightClientClosed = 0;

        leftServer.transport.onclose = () => {
            leftServerClosed += 1;
        };
        leftClient.transport.onclose = () => {
            leftClientClosed += 1;
        };
        rightServer.transport.onclose = () => {
            rightServerClosed += 1;
        };
        rightClient.transport.onclose = () => {
            rightClientClosed += 1;
        };

        await leftSession.close();

        assert.equal(leftServerClosed, 1);
        assert.equal(leftClientClosed, 1);
        assert.equal(rightServerClosed, 1);
        assert.equal(rightClientClosed, 1);

        await rightSession.close();
    });

    it('accepts websocket event payload with data field', async () => {
        const socket = new MemorySocket();
        const server = new CaptureEndpoint();
        const client = new CaptureEndpoint();

        const session = await BidirectionalSession.connect(socket, server, { client });

        let received: any = null;
        server.transport.onmessage = (message: any) => {
            received = message;
        };

        socket.emitDataMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
        }));

        assert.equal(received?.method, 'tools/list');
        assert.equal(received?.id, 1);

        await session.close();
    });

    it('accepts websocket event payload with json method', async () => {
        const socket = new MemorySocket();
        const server = new CaptureEndpoint();
        const client = new CaptureEndpoint();

        const session = await BidirectionalSession.connect(socket, server, { client });

        let received: any = null;
        server.transport.onmessage = (message: any) => {
            received = message;
        };

        socket.emitJsonMessage({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
        });

        assert.equal(received?.method, 'tools/list');
        assert.equal(received?.id, 2);

        await session.close();
    });

    it('delivers notifications to both internal sides', async () => {
        const socket = new MemorySocket();
        const server = new CaptureEndpoint();
        const client = new CaptureEndpoint();

        const session = await BidirectionalSession.connect(socket, server, { client });

        let serverMessage: any = null;
        let clientMessage: any = null;

        server.transport.onmessage = (message: any) => {
            serverMessage = message;
        };
        client.transport.onmessage = (message: any) => {
            clientMessage = message;
        };

        socket.emitDataMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
        }));

        assert.equal(serverMessage?.method, 'notifications/initialized');
        assert.equal(clientMessage?.method, 'notifications/initialized');

        await session.close();
    });

    it('forwards notifications sent from the peer side to both local internal sides', async () => {
        const { left, right } = createMemoryPair();
        const leftServer = new CaptureEndpoint();
        const leftClient = new CaptureEndpoint();
        const rightServer = new CaptureEndpoint();
        const rightClient = new CaptureEndpoint();

        const [leftSession, rightSession] = await Promise.all([
            BidirectionalSession.connect(left, leftServer, { client: leftClient }),
            BidirectionalSession.connect(right, rightServer, { client: rightClient }),
        ]);

        const rightServerMessages: any[] = [];
        const rightClientMessages: any[] = [];

        rightServer.transport.onmessage = (message: any) => {
            rightServerMessages.push(message);
        };
        rightClient.transport.onmessage = (message: any) => {
            rightClientMessages.push(message);
        };

        await leftServer.transport.send({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: { from: 'server' },
        });

        await leftClient.transport.send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { from: 'client' },
        });

        assert.equal(rightServerMessages.length, 2);
        assert.equal(rightClientMessages.length, 2);
        assert.equal(rightServerMessages[0]?.method, 'notifications/initialized');
        assert.equal(rightServerMessages[1]?.method, 'notifications/progress');
        assert.equal(rightClientMessages[0]?.method, 'notifications/initialized');
        assert.equal(rightClientMessages[1]?.method, 'notifications/progress');

        await Promise.all([
            leftSession.close(),
            rightSession.close(),
        ]);
    });

    it('propagates websocket error to both logical sides', async () => {
        const socket = new MemorySocket();
        const server = new CaptureEndpoint();
        const client = new CaptureEndpoint();

        const session = await BidirectionalSession.connect(socket, server, { client });

        let serverError: Error | null = null;
        let clientError: Error | null = null;

        server.transport.onerror = (error: Error) => {
            serverError = error;
        };
        client.transport.onerror = (error: Error) => {
            clientError = error;
        };

        const expected = new Error('socket failed');
        socket.emitError(expected);

        assert.equal(serverError, expected);
        assert.equal(clientError, expected);

        await session.close();
    });

    it('can auto-create and retain the local client when connecting a server', async () => {
        const socket = new MemorySocket();
        const server = new McpServer({ name: 'server', version: '1.0.0' });

        const provider = await BidirectionalSession.connect(socket, server, {
            clientInfo: { name: 'client', version: '1.0.0' },
        });
        const client = provider.client;

        assert.ok(client instanceof McpClient);
        assert.equal(provider.client, client);

        await Promise.all([
            client.close(),
            server.close(),
            provider.close(),
        ]);
    });
});