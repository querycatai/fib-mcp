import { Transport, createSessionId } from './base';
import type { JSONRPCMessage, TransportSendOptions } from './base';
import { McpClient } from './client';
import { McpServer } from './server';
import type { AnySchema, SchemaOutput, ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

declare const WebSocket: any;

type ProviderSide = 'server' | 'client';
type AnyToolHandler = (...args: any[]) => any;

interface ClientInfo {
    name: string;
    version: string;
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

export interface BidirectionalWebSocket {
    onopen?: (() => void) | null;
    onmessage?: ((message: any) => void) | null;
    onerror?: ((error: any) => void) | null;
    onclose?: (() => void) | null;
    send(data: string): void | Promise<void>;
    close(): void | Promise<void>;
}

export interface BidirectionalSessionOptions {
    clientInfo?: ClientInfo;
    clientOptions?: any;
    serverOptions?: any;
}

export interface BidirectionalSessionOpenOptions {
    protocols?: string | string[];
}

export type BidirectionalToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface BidirectionalToolContext<Extra extends BidirectionalToolExtra = BidirectionalToolExtra> {
    client: McpClient;
    extra: Extra;
}

type BaseBidirectionalToolCallback<
    SendResultT extends CallToolResult,
    Extra extends BidirectionalToolExtra,
    Args extends undefined | ZodRawShapeCompat | AnySchema,
> = Args extends ZodRawShapeCompat
    ? (args: ShapeOutput<Args>, context: BidirectionalToolContext<Extra>) => SendResultT | Promise<SendResultT>
    : Args extends AnySchema
        ? (args: SchemaOutput<Args>, context: BidirectionalToolContext<Extra>) => SendResultT | Promise<SendResultT>
        : (context: BidirectionalToolContext<Extra>) => SendResultT | Promise<SendResultT>;

export type BidirectionalToolCallback<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> =
    BaseBidirectionalToolCallback<CallToolResult, BidirectionalToolExtra, Args>;

export interface BidirectionalConnection {
    readonly sessionId: string;
    readonly client: McpClient;
    close(): Promise<void>;
}

class ConnectionClientTransport extends Transport {
    private _closedByUser = false;
    private readonly _connection: ConnectionBridge;

    constructor(connection: ConnectionBridge) {
        super();
        this._connection = connection;
    }

    async start(): Promise<void> {
        // no-op
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (this._closedByUser) {
            throw new Error('BidirectionalSession client side is closed');
        }

        await this._connection.sendFromClient(message);
    }

    async close(): Promise<void> {
        if (this._closedByUser) return;
        this._closedByUser = true;
        this._closed();
    }

    deliver(message: JSONRPCMessage): void {
        if (this._closedByUser) return;
        this._receive(message);
    }

    fail(error: Error): void {
        if (this._closedByUser) return;
        this._error(error);
    }

    shutdown(): void {
        if (this._closedByUser) return;
        this._closedByUser = true;
        this._closed();
    }
}

class SharedServerTransport extends Transport {
    private readonly _connections: Map<string, ConnectionBridge> = new Map();
    private readonly _incomingRequestSessions: Map<string, string> = new Map();
    private readonly _incomingExternalRequestIds: Map<string, string | number> = new Map();
    private readonly _serverRequestSessions: Map<string, string> = new Map();
    private _activeSessionId: string | null = null;

    get sessionId(): string {
        return this._activeSessionId || this._sessionId;
    }

    async start(): Promise<void> {
        // no-op
    }

    register(connection: ConnectionBridge): void {
        this._connections.set(connection.sessionId, connection);
    }

    unregister(sessionId: string): void {
        this._connections.delete(sessionId);

        for (const [key, value] of this._incomingRequestSessions.entries()) {
            if (value === sessionId) {
                this._incomingRequestSessions.delete(key);
                this._incomingExternalRequestIds.delete(key);
            }
        }

        for (const [key, value] of this._serverRequestSessions.entries()) {
            if (value === sessionId) this._serverRequestSessions.delete(key);
        }
    }

    async receiveFromConnection(sessionId: string, message: JSONRPCMessage): Promise<void> {
        let inboundMessage = message;

        if (isRequest(message)) {
            const externalId = (message as any).id;
            const internalId = `${sessionId}:${toRequestKey(externalId)}`;

            this._incomingRequestSessions.set(toRequestKey(internalId), sessionId);
            this._incomingExternalRequestIds.set(toRequestKey(internalId), externalId);
            inboundMessage = { ...message, id: internalId };
        }

        if (isResponse(message)) {
            this._serverRequestSessions.delete(toRequestKey((message as any).id));
        }

        const previous = this._activeSessionId;
        this._activeSessionId = sessionId;
        try {
            if (!this.onmessage) return;

            await this.onmessage(inboundMessage);
        } catch (error: any) {
            this._error(toError(error));
        } finally {
            this._activeSessionId = previous;
        }
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (isResponse(message)) {
            const key = toRequestKey((message as any).id);
            const sessionId = this._incomingRequestSessions.get(key);
            if (!sessionId) return;

            const externalId = this._incomingExternalRequestIds.get(key);
            this._incomingRequestSessions.delete(key);
            this._incomingExternalRequestIds.delete(key);

            await this._sendToConnection(
                sessionId,
                externalId === undefined ? message : { ...message, id: externalId }
            );
            return;
        }

        if (isRequest(message)) {
            const sessionId = this._resolveTargetSessionId(options);
            if (!sessionId) {
                throw new Error('BidirectionalSession server request requires a session context');
            }

            this._serverRequestSessions.set(toRequestKey((message as any).id), sessionId);
            await this._sendToConnection(sessionId, message);
            return;
        }

        if (isNotification(message)) {
            const sessionId = this._resolveTargetSessionId(options);
            if (sessionId) {
                await this._sendToConnection(sessionId, message);
                return;
            }

            for (const connection of this._connections.values()) {
                await connection.sendFromServer(message);
            }
        }
    }

    async close(): Promise<void> {
        this._incomingRequestSessions.clear();
        this._incomingExternalRequestIds.clear();
        this._serverRequestSessions.clear();
        this._connections.clear();
        this._closed();
    }

    private _resolveTargetSessionId(options?: TransportSendOptions): string | undefined {
        if (this._activeSessionId) {
            return this._activeSessionId;
        }

        if (options?.relatedRequestId !== undefined) {
            return this._incomingRequestSessions.get(toRequestKey(options.relatedRequestId));
        }

        return undefined;
    }

    private async _sendToConnection(sessionId: string, message: JSONRPCMessage): Promise<void> {
        const connection = this._connections.get(sessionId);
        if (!connection) {
            throw new Error(`BidirectionalSession connection not found for session ${sessionId}`);
        }

        await connection.sendFromServer(message);
    }
}

class ConnectionBridge implements BidirectionalConnection {
    readonly sessionId: string;
    readonly client: McpClient;

    private readonly _manager: BidirectionalSession;
    private readonly _ws: BidirectionalWebSocket;
    private readonly _clientTransport: ConnectionClientTransport;
    private readonly _pendingOwners: Map<string, ProviderSide> = new Map();
    private _closed = false;

    constructor(manager: BidirectionalSession, ws: BidirectionalWebSocket, client: McpClient) {
        this._manager = manager;
        this._ws = ws;
        this.client = client;
        this.sessionId = createSessionId();
        this._clientTransport = new ConnectionClientTransport(this);
    }

    async start(): Promise<void> {
        this._manager._registerConnection(this);

        this._ws.onmessage = (message) => {
            this._handleInboundMessage(decodeWebSocketMessage(message)).catch((error: any) => {
                this._clientTransport.fail(toError(error));
            });
        };
        this._ws.onerror = (error) => {
            this._clientTransport.fail(toError(error));
        };
        this._ws.onclose = () => {
            this._closed = true;
            this._manager._unregisterConnection(this.sessionId);
            this._clientTransport.shutdown();
        };

        await this.client.connect(this._clientTransport);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this._manager._unregisterConnection(this.sessionId);
        this._clientTransport.shutdown();
        try { await this.client.close(); } catch (_) {}
        await this._ws.close();
    }

    async sendFromClient(message: JSONRPCMessage): Promise<void> {
        await this.sendFromOwner('client', message);
    }

    async sendFromServer(message: JSONRPCMessage): Promise<void> {
        await this.sendFromOwner('server', message);
    }

    async sendFromOwner(owner: ProviderSide, message: JSONRPCMessage): Promise<void> {
        if (this._closed) {
            throw new Error('BidirectionalSession connection is closed');
        }

        if (isRequest(message)) {
            this._pendingOwners.set(toRequestKey((message as any).id), owner);
        }

        await this._ws.send(JSON.stringify(message));
    }

    private async _handleInboundMessage(message: JSONRPCMessage): Promise<void> {
        if (isRequest(message)) {
            await this._manager._receiveFromConnection(this.sessionId, message);
            return;
        }

        if (isResponse(message)) {
            const key = toRequestKey((message as any).id);
            const owner = this._pendingOwners.get(key) || 'client';
            this._pendingOwners.delete(key);

            if (owner === 'server') {
                await this._manager._receiveFromConnection(this.sessionId, message);
                return;
            }

            this._clientTransport.deliver(message);
            return;
        }

        if (isNotification(message)) {
            this._clientTransport.deliver(message);
            await this._manager._receiveFromConnection(this.sessionId, message);
        }
    }
}

export class BidirectionalSession {
    readonly server: McpServer;

    private readonly _serverTransport: SharedServerTransport;
    private readonly _connections: Map<string, ConnectionBridge> = new Map();
    private readonly _clientInfo: ClientInfo;
    private readonly _clientOptions: any;
    private _connected = false;

    constructor(info: ClientInfo, options: BidirectionalSessionOptions = {}) {
        this.server = new McpServer(info, options.serverOptions || {});
        this._serverTransport = new SharedServerTransport();
        this._clientInfo = options.clientInfo || { name: 'bidirectional-client', version: '1.0.0' };
        this._clientOptions = options.clientOptions || {};
    }

    tool(name: string, cb: BidirectionalToolCallback): RegisteredTool;
    tool(name: string, description: string, cb: BidirectionalToolCallback): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchemaOrAnnotations: Args | ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, description: string, paramsSchemaOrAnnotations: Args | ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchema: Args, annotations: ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, description: string, paramsSchema: Args, annotations: ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool(...args: any[]): RegisteredTool {
        const userHandler = args[args.length - 1] as AnyToolHandler;
        if (typeof userHandler !== 'function') {
            throw new Error('BidirectionalSession.tool requires a callback');
        }

        return this.server.tool(...args.slice(0, -1), this._wrapToolHandler(userHandler));
    }

    handler(): any {
        const self = this;
        return WebSocket.upgrade(function (ws: any) {
            self.connect(ws).catch(function (error: any) {
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
    }

    async open(url: string, options: BidirectionalSessionOpenOptions = {}): Promise<BidirectionalConnection> {
        return new Promise<BidirectionalConnection>((resolve, reject) => {
            const ws = new WebSocket(url, options.protocols || '');
            let settled = false;

            ws.onopen = async () => {
                if (settled) return;
                settled = true;

                try {
                    const connection = await this.connect(ws);
                    resolve(connection);
                } catch (error: any) {
                    try { ws.close(); } catch (_) {}
                    reject(toError(error));
                }
            };

            ws.onerror = (error: any) => {
                if (settled) return;
                settled = true;
                reject(toError(error));
            };
        });
    }

    async connect(ws: BidirectionalWebSocket): Promise<BidirectionalConnection> {
        await this._ensureServerConnected();

        const client = new McpClient(this._clientInfo, this._clientOptions);
        const connection = new ConnectionBridge(this, ws, client);
        await connection.start();
        return connection;
    }

    async close(): Promise<void> {
        const connections = Array.from(this._connections.values());
        for (const connection of connections) {
            try { await connection.close(); } catch (_) {}
        }

        this._connections.clear();

        if (this._connected) {
            this._connected = false;
            try { await this.server.close(); } catch (_) {}
            try { await this._serverTransport.close(); } catch (_) {}
        }
    }

    async _receiveFromConnection(sessionId: string, message: JSONRPCMessage): Promise<void> {
        await this._serverTransport.receiveFromConnection(sessionId, message);
    }

    _registerConnection(connection: ConnectionBridge): void {
        this._connections.set(connection.sessionId, connection);
        this._serverTransport.register(connection);
    }

    _unregisterConnection(sessionId: string): void {
        this._connections.delete(sessionId);
        this._serverTransport.unregister(sessionId);
    }

    private async _ensureServerConnected(): Promise<void> {
        if (this._connected) return;
        this._connected = true;
        await this.server.connect(this._serverTransport);
    }

    private _wrapToolHandler(userHandler: AnyToolHandler): AnyToolHandler {
        return async (...handlerArgs: any[]) => {
            let payload: any = undefined;
            let extra: BidirectionalToolExtra | undefined = undefined;

            if (handlerArgs.length === 1) {
                extra = handlerArgs[0];
            } else {
                payload = handlerArgs[0];
                extra = handlerArgs[1];
            }

            const client = this._clientForSession(extra?.sessionId);
            if (!client) {
                throw new Error(`BidirectionalSession client not found for session ${String(extra?.sessionId || '')}`);
            }

            const context: BidirectionalToolContext = { client, extra: extra as BidirectionalToolExtra };

            if (handlerArgs.length === 1) {
                return await userHandler(context);
            }

            return await userHandler(payload, context);
        };
    }

    private _clientForSession(sessionId?: string): McpClient | null {
        if (!sessionId) return null;
        return this._connections.get(String(sessionId))?.client || null;
    }
}
