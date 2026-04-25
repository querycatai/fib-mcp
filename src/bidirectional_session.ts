import { Transport, createSessionId } from './base';
import type { JSONRPCMessage, TransportSendOptions } from './base';
import { McpClient } from './client';
import { McpServer } from './server';
import { WebSocketServerTransport } from './ws';
import { WebSocketClientTransport as SdkWebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AnySchema, SchemaOutput, ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport as SdkTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

declare const WebSocket: any;

type ProviderSide = 'server' | 'client';
type AnyToolHandler = (...args: any[]) => any;

const REVERSE_EXTENSION_NAMESPACE = 'fib-mcp';

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

function supportsReverseService(capabilities: any): boolean {
    return capabilities?.extensions?.[REVERSE_EXTENSION_NAMESPACE]?.reverseService === true;
}

function withReverseServiceCapability(options: any, enabled: boolean): any {
    const nextOptions = options ? { ...options } : {};
    if (!enabled) {
        return nextOptions;
    }

    const capabilities = nextOptions.capabilities ? { ...nextOptions.capabilities } : {};
    const extensions = capabilities.extensions ? { ...capabilities.extensions } : {};
    const reverseCapability = extensions[REVERSE_EXTENSION_NAMESPACE]
        ? { ...extensions[REVERSE_EXTENSION_NAMESPACE] }
        : {};

    reverseCapability.reverseService = true;
    extensions[REVERSE_EXTENSION_NAMESPACE] = reverseCapability;
    capabilities.extensions = extensions;
    nextOptions.capabilities = capabilities;

    return nextOptions;
}

export type BidirectionalMessageTransport = SdkTransport;

export interface BidirectionalSessionOptions {
    serverInfo: ClientInfo;
    clientInfo?: ClientInfo;
    clientOptions?: any;
    serverOptions?: any;
}

export interface BidirectionalWsConnectOptions {
    transport: 'ws' | 'websocket';
    url: string;
}

export interface BidirectionalStdioConnectOptions {
    transport: 'stdio';
    command?: string;
    args?: string[];
    path?: string;
    options?: Omit<StdioServerParameters, 'command' | 'args'>;
}

export type BidirectionalConnectOptions = BidirectionalWsConnectOptions | BidirectionalStdioConnectOptions;

function createBidirectionalClientTransportFromConfig(config: BidirectionalConnectOptions): BidirectionalMessageTransport {
    if (config.transport === 'ws' || config.transport === 'websocket') {
        return new SdkWebSocketClientTransport(config.url);
    }

    const command = config.command || process.execPath;
    const args = config.command
        ? (config.args || [])
        : [config.path || ''];

    if (!config.command && !config.path) {
        throw new Error('BidirectionalSession stdio connect requires either command or path');
    }

    return new SdkStdioClientTransport({ command, args, ...(config.options || {}) });
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
    private readonly _forceInitialize: boolean;

    constructor(connection: ConnectionBridge, forceInitialize: boolean) {
        super();
        this._connection = connection;
        this._forceInitialize = forceInitialize;
    }

    get sessionId(): string | undefined {
        return this._forceInitialize ? undefined : super.sessionId;
    }

    async start(): Promise<void> {
        // no-op
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (this._closedByUser) {
            throw new Error('BidirectionalSession client side is closed');
        }

        if (this._connection.requiresReverseNegotiation() && !this._connection.isReverseEnabled()) {
            throw new Error('BidirectionalSession reverse channel is not negotiated for this session');
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
    private readonly _isReverseEnabled: (sessionId: string) => boolean;
    private readonly _onPeerReverseSupported: (sessionId: string) => void;
    private _activeSessionId: string | null = null;

    constructor(
        isReverseEnabled: (sessionId: string) => boolean,
        onPeerReverseSupported: (sessionId: string) => void,
    ) {
        super();
        this._isReverseEnabled = isReverseEnabled;
        this._onPeerReverseSupported = onPeerReverseSupported;
    }

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
        if (isRequest(message) && (message as any).method === 'initialize') {
            this._capturePeerCapabilities(sessionId, message);
        }

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

            if (!this._isReverseEnabled(sessionId)) {
                throw new Error('BidirectionalSession reverse channel is not negotiated for this session');
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

    isSessionActive(sessionId: string): boolean {
        return this._activeSessionId === sessionId;
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

    private _capturePeerCapabilities(sessionId: string, message: JSONRPCMessage): void {
        const capabilities = (message as any)?.params?.capabilities;
        if (supportsReverseService(capabilities)) {
            this._onPeerReverseSupported(sessionId);
        }
    }
}

class ConnectionBridge implements BidirectionalConnection {
    readonly sessionId: string;
    readonly client: McpClient;

    private readonly _manager: BidirectionalSession;
    private readonly _transport: BidirectionalMessageTransport;
    private readonly _clientTransport: ConnectionClientTransport;
    private readonly _eagerClientConnect: boolean;
    private readonly _serverContextClient: McpClient;
    private readonly _pendingOwners: Map<string, ProviderSide> = new Map();
    private _clientConnectPromise: Promise<void> | null = null;
    private _clientConnected = false;
    private _closed = false;

    constructor(
        manager: BidirectionalSession,
        transport: BidirectionalMessageTransport,
        client: McpClient,
        forceInitialize: boolean,
        eagerClientConnect: boolean,
    ) {
        this._manager = manager;
        this._transport = transport;
        this.client = client;
        this.sessionId = createSessionId();
        this._clientTransport = new ConnectionClientTransport(this, forceInitialize);
        this._eagerClientConnect = eagerClientConnect;
        this._serverContextClient = this._createServerContextClient();
    }

    async start(): Promise<void> {
        this._manager._registerConnection(this);

        this._transport.onmessage = (message) => {
            this._handleInboundMessage(message).catch((error: any) => {
                this._clientTransport.fail(toError(error));
            });
        };
        this._transport.onerror = (error) => {
            this._clientTransport.fail(toError(error));
        };
        this._transport.onclose = () => {
            this._closed = true;
            this._manager._unregisterConnection(this.sessionId);
            this._clientTransport.shutdown();
        };

        if (this._eagerClientConnect) {
            await this._ensureClientConnected();
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this._manager._unregisterConnection(this.sessionId);
        this._clientTransport.shutdown();
        try { await this.client.close(); } catch (_) {}
        await this._transport.close();
    }

    isReverseEnabled(): boolean {
        return this._manager._canUseReverse(this.sessionId);
    }

    serverContextClient(): McpClient {
        return this._serverContextClient;
    }

    requiresReverseNegotiation(): boolean {
        return this._manager._isServerContextActive(this.sessionId);
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

        await this._transport.send(message);
    }

    private async _ensureClientConnected(): Promise<void> {
        if (this._clientConnected) return;
        if (this._clientConnectPromise) {
            await this._clientConnectPromise;
            return;
        }

        this._clientConnectPromise = this.client.connect(this._clientTransport)
            .then(() => {
                this._clientConnected = true;
            })
            .finally(() => {
                this._clientConnectPromise = null;
            });

        await this._clientConnectPromise;
    }

    private async _ensureReverseClientReady(): Promise<void> {
        if (!this._manager._canUseReverse(this.sessionId)) {
            throw new Error('BidirectionalSession reverse service is not declared by peer for this session');
        }

        await this._ensureClientConnected();
    }

    private _createServerContextClient(): McpClient {
        const self = this;
        const target = this.client as any;

        return new Proxy(target, {
            get(obj: any, prop: string | symbol, receiver: any) {
                const value = Reflect.get(obj, prop, receiver);
                if (typeof value !== 'function') {
                    return value;
                }

                return async function (...args: any[]) {
                    await self._ensureReverseClientReady();
                    return await value.apply(obj, args);
                };
            },
        }) as unknown as McpClient;
    }

    private async _handleInboundMessage(message: JSONRPCMessage): Promise<void> {
        if (isRequest(message)) {
            if ((message as any).method === 'initialize') {
                const capabilities = (message as any)?.params?.capabilities;
                if (supportsReverseService(capabilities)) {
                    this._manager._enableReverseForSession(this.sessionId);
                }
            }

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
    private readonly _reverseEnabledSessions: Set<string> = new Set();
    private readonly _clientInfo: ClientInfo;
    private readonly _clientOptions: any;
    private _connected = false;

    constructor(options: BidirectionalSessionOptions) {
        if (!options || !options.serverInfo) {
            throw new Error('BidirectionalSession requires serverInfo');
        }

        this.server = new McpServer(options.serverInfo, withReverseServiceCapability(options.serverOptions, true));
        this._serverTransport = new SharedServerTransport(
            (sessionId) => this._isReverseEnabled(sessionId),
            (sessionId) => this._onPeerReverseSupported(sessionId),
        );
        this._clientInfo = options.clientInfo || { name: 'bidirectional-client', version: '1.0.0' };
        this._clientOptions = withReverseServiceCapability(options.clientOptions, true);
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

    wsHandler(): any {
        const self = this;
        const wst = new WebSocketServerTransport();
        return wst.handler(function (conn: WebSocketServerTransport) {
            self._connect(conn, false).catch(function (error: any) {
                const normalized = toError(error);
                try {
                    if (conn.onerror) {
                        conn.onerror(normalized);
                    }
                } catch (_) {}
                try {
                    conn.close();
                } catch (_) {}
            });
        });
    }

    async listenStdio(): Promise<BidirectionalConnection> {
        const transport = new StdioServerTransport();
        return await this._connect(transport, false);
    }

    async connect(config: BidirectionalConnectOptions): Promise<BidirectionalConnection>;
    async connect(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection> {
        return this._connect(transport, true);
    }

    async connect(target: any): Promise<BidirectionalConnection> {
        if (typeof target === 'object' && target && typeof target.transport === 'string') {
            return this._connect(createBidirectionalClientTransportFromConfig(target), true);
        }

        if (target && typeof target === 'object') {
            return this._connect(target, true);
        }

        throw new Error('BidirectionalSession.connect requires a transport descriptor object or transport instance');
    }

    async accept(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection> {
        return await this._connect(transport, false);
    }

    private async _connect(transport: BidirectionalMessageTransport, eagerClientConnect: boolean): Promise<BidirectionalConnection> {
        await this._ensureServerConnected();
        await transport.start();

        const client = new McpClient(this._clientInfo, this._clientOptions);
        const connection = new ConnectionBridge(this, transport, client, this._shouldAttemptReverse(), eagerClientConnect);
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
        this._reverseEnabledSessions.delete(sessionId);
        this._serverTransport.unregister(sessionId);
    }

    _enableReverseForSession(sessionId: string): void {
        if (!sessionId) return;
        this._reverseEnabledSessions.add(String(sessionId));
    }

    _shouldAttemptReverse(): boolean {
        return true;
    }

    _onPeerReverseSupported(sessionId: string): void {
        this._enableReverseForSession(sessionId);
    }

    _canUseReverse(sessionId: string): boolean {
        return this._isReverseEnabled(sessionId);
    }

    _isServerContextActive(sessionId: string): boolean {
        return this._serverTransport.isSessionActive(sessionId);
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
            } else if (handlerArgs.length >= 2) {
                payload = handlerArgs[0];
                extra = handlerArgs[1];
            }

            const client = this._serverContextClientForSession(extra?.sessionId);
            if (!client) {
                throw new Error(`BidirectionalSession client not found for session ${String(extra?.sessionId || '')}`);
            }

            const context: BidirectionalToolContext = { client, extra: extra as BidirectionalToolExtra };

            if (handlerArgs.length === 1) {
                return await userHandler(context);
            } else if (handlerArgs.length >= 2) {
                return await userHandler(payload, context);
            }

            return await userHandler();
        };
    }

    private _clientForSession(sessionId?: string): McpClient | null {
        if (!sessionId) return null;
        return this._connections.get(String(sessionId))?.client || null;
    }

    private _serverContextClientForSession(sessionId?: string): McpClient | null {
        let finalSessionId = sessionId;
        
        if (!finalSessionId && this._serverTransport) {
            finalSessionId = (this._serverTransport as any)._activeSessionId;
        }
        
        if (!finalSessionId) return null;
        const connection = this._connections.get(String(finalSessionId));
        return connection ? connection.serverContextClient() : null;
    }

    private _isReverseEnabled(sessionId: string): boolean {
        return this._reverseEnabledSessions.has(String(sessionId));
    }
}
