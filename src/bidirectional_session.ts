import { Transport } from './base';
import type { JSONRPCMessage } from './base';
import { McpClient } from './client';

declare const WebSocket: any;

type ProviderSide = 'server' | 'client';

interface ClientInfo {
    name: string;
    version: string;
}

export interface BidirectionalWebSocket {
    onmessage?: ((message: any) => void) | null;
    onerror?: ((error: any) => void) | null;
    onclose?: (() => void) | null;
    send(data: string): void | Promise<void>;
    close(): void | Promise<void>;
}

interface ConnectableEndpoint {
    connect(transport: Transport): Promise<void>;
}

export interface BidirectionalConnectOptions {
    client?: ConnectableEndpoint | any;
    clientInfo?: ClientInfo;
    clientOptions?: any;
}

export interface BidirectionalSessionOpenOptions extends BidirectionalConnectOptions {
    protocols?: string | string[];
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function toRequestKey(id: any): string {
    return typeof id === 'string' ? id : JSON.stringify(id);
}

function isRequest(message: JSONRPCMessage): boolean {
    return hasOwn(message, 'method') && hasOwn(message, 'id');
}

function isNotification(message: JSONRPCMessage): boolean {
    return hasOwn(message, 'method') && !hasOwn(message, 'id');
}

function isResponse(message: JSONRPCMessage): boolean {
    return hasOwn(message, 'id') && (hasOwn(message, 'result') || hasOwn(message, 'error'));
}

function toError(error: any): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function decodeWebSocketMessage(message: any): JSONRPCMessage {
    if (message && typeof message.json === 'function') {
        return message.json();
    }

    if (message && typeof message.data === 'string') {
        return JSON.parse(message.data);
    }

    if (typeof message === 'string') {
        return JSON.parse(message);
    }

    return message as JSONRPCMessage;
}

class SideTransport extends Transport {
    private _closedByUser = false;
    readonly side: ProviderSide;
    private readonly _provider: BidirectionalProvider;

    constructor(provider: BidirectionalProvider, side: ProviderSide) {
        super();
        this._provider = provider;
        this.side = side;
    }

    async start(): Promise<void> {
        await this._provider.start();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this._closedByUser) {
            throw new Error(`BidirectionalSession ${this.side} side is closed`);
        }

        await this._provider._sendFromSide(this.side, message);
    }

    async close(): Promise<void> {
        if (this._closedByUser) return;
        this._closedByUser = true;
        this._closed();
        this._provider._onSideClosed(this.side);
    }

    _deliver(message: JSONRPCMessage): void {
        if (this._closedByUser) return;
        this._receive(message);
    }

    _fail(error: Error): void {
        if (this._closedByUser) return;
        this._error(error);
    }

    _shutdown(): void {
        if (this._closedByUser) return;
        this._closedByUser = true;
        this._closed();
    }
}

/**
 * Bidirectional MCP session over a shared WebSocket.
 */
export interface BidirectionalSession {
    readonly client: McpClient;
    close(): Promise<void>;
}

class BidirectionalProvider implements BidirectionalSession {
    private _client: McpClient | null = null;

    private readonly _serverTransport: SideTransport;
    private readonly _clientTransport: SideTransport;
    private readonly _pendingOwners: Map<string, ProviderSide> = new Map();
    private _started = false;
    private _closed = false;
    private readonly _ws: BidirectionalWebSocket;

    constructor(ws: BidirectionalWebSocket) {
        this._ws = ws;
        this._serverTransport = new SideTransport(this, 'server');
        this._clientTransport = new SideTransport(this, 'client');
    }

    get client(): McpClient {
        if (!this._client) {
            throw new Error('BidirectionalSession client is not connected');
        }

        return this._client;
    }

    async start(): Promise<void> {
        if (this._started) return;
        if (this._closed) throw new Error('BidirectionalSession is closed');

        this._ws.onmessage = (message) => {
            try {
                this._routeInboundMessage(decodeWebSocketMessage(message));
            } catch (error: any) {
                const normalized = toError(error);
                this._serverTransport._fail(normalized);
                this._clientTransport._fail(normalized);
            }
        };
        this._ws.onerror = (error) => {
            const normalized = toError(error);
            this._serverTransport._fail(normalized);
            this._clientTransport._fail(normalized);
        };
        this._ws.onclose = () => {
            this._closed = true;
            this._serverTransport._shutdown();
            this._clientTransport._shutdown();
        };

        this._started = true;
    }

    async connect(server: ConnectableEndpoint | any, options: BidirectionalConnectOptions = {}): Promise<McpClient> {
        await this._connectServer(server);

        const client = (options.client || this._client || new McpClient(
            options.clientInfo || { name: 'bidirectional-client', version: '1.0.0' },
            options.clientOptions || {}
        )) as McpClient;

        await this._connectClient(client);
        return client;
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this._pendingOwners.clear();
        this._serverTransport._shutdown();
        this._clientTransport._shutdown();
        await this._ws.close();
    }

    private async _connectServer(server: ConnectableEndpoint | any): Promise<void> {
        await this.start();
        await server.connect(this._serverTransport);
    }

    private async _connectClient(client: ConnectableEndpoint | any): Promise<void> {
        await this.start();
        await client.connect(this._clientTransport);
        this._client = client instanceof McpClient ? client : null;
    }

    async _sendFromSide(side: ProviderSide, message: JSONRPCMessage): Promise<void> {
        await this.start();

        if (isRequest(message)) {
            this._pendingOwners.set(toRequestKey((message as any).id), side);
        }

        await this._ws.send(JSON.stringify(message));
    }

    _onSideClosed(_side: ProviderSide): void {
        // Side shutdown does not automatically close the physical transport.
    }

    private _routeInboundMessage(message: JSONRPCMessage): void {
        if (isRequest(message)) {
            this._serverTransport._deliver(message);
            return;
        }

        if (isResponse(message)) {
            const key = toRequestKey((message as any).id);
            const owner = this._pendingOwners.get(key);
            if (owner) {
                this._pendingOwners.delete(key);
            }

            const target = owner === 'server' ? this._serverTransport : this._clientTransport;
            target._deliver(message);
            return;
        }

        if (isNotification(message)) {
            this._serverTransport._deliver(message);
            this._clientTransport._deliver(message);
            return;
        }

        const error = new Error(`BidirectionalSession: unknown JSON-RPC message: ${JSON.stringify(message)}`);
        this._serverTransport._fail(error);
        this._clientTransport._fail(error);
    }
}

export const BidirectionalSession = {
    async connect(ws: BidirectionalWebSocket, server: ConnectableEndpoint | any, options: BidirectionalConnectOptions = {}): Promise<BidirectionalSession> {
        const session = new BidirectionalProvider(ws);
        await session.connect(server, options);
        return session;
    },

    handler(server: ConnectableEndpoint | any, options: BidirectionalConnectOptions = {}): any {
        return WebSocket.upgrade(function (ws: any) {
            BidirectionalSession.connect(ws, server, options).catch(function (error: any) {
                const normalized = toError(error);
                try {
                    if (typeof ws.onerror === 'function') {
                        ws.onerror(normalized);
                    }
                } catch (_) {}
                try {
                    ws.close();
                } catch (_) {}
            });
        });
    },

    async open(url: string, server: ConnectableEndpoint | any, options: BidirectionalSessionOpenOptions = {}): Promise<BidirectionalSession> {
        return new Promise<BidirectionalSession>(function (resolve, reject) {
            const ws = new WebSocket(url, options.protocols || '');
            let settled = false;

            ws.onopen = async function () {
                if (settled) return;
                settled = true;

                try {
                    const session = await BidirectionalSession.connect(ws, server, options);
                    resolve(session);
                } catch (error: any) {
                    try { ws.close(); } catch (_) {}
                    reject(toError(error));
                }
            };

            ws.onerror = function (error: any) {
                if (settled) return;
                settled = true;
                reject(toError(error));
            };
        });
    },
};
