import { Transport } from './base';
import type { JSONRPCMessage, TransportSendOptions } from './base';
import { McpClient } from './client';
import { WebSocketServerTransport } from './ws';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    createBidirectionalClientTransportFromConfig,
    createBidirectionalSessionId,
    isNotification,
    isRequest,
    isResponse,
    supportsReverseService,
    toError,
    toRequestKey,
    withReverseServiceCapability,
    type BidirectionalConnectOptions,
    type BidirectionalConnection,
    type BidirectionalMessageTransport,
    type ClientInfo,
    type ProviderSide,
} from './bidirectional_shared';

interface SessionRelayOptions {
    clientInfo?: ClientInfo;
    clientOptions?: any;
    ensureServerConnected: (transport: SharedServerTransport) => Promise<void>;
    onPeerNotification?: (context: { sessionId: string; message: JSONRPCMessage }) => Promise<void> | void;
}

class ConnectionClientTransport extends Transport {
    private _closedByUser = false;
    private readonly _connection: BridgeConnection;
    private readonly _forceInitialize: boolean;

    constructor(connection: BridgeConnection, forceInitialize: boolean) {
        super();
        this._connection = connection;
        this._forceInitialize = forceInitialize;
    }

    get sessionId(): string | undefined {
        return this._forceInitialize ? undefined : super.sessionId;
    }

    async start(): Promise<void> {}

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

export class SharedServerTransport extends Transport {
    private readonly _connections: Map<string, BridgeConnection> = new Map();
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

    async start(): Promise<void> {}

    register(connection: BridgeConnection): void {
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

    activeSessionId(): string | null {
        return this._activeSessionId;
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

class BridgeConnection implements BidirectionalConnection {
    readonly sessionId: string;

    private readonly _manager: SessionRelay;
    private readonly _transport: BidirectionalMessageTransport;
    private readonly _clientFactory: () => McpClient;
    private readonly _clientTransport: ConnectionClientTransport;
    private readonly _eagerClientConnect: boolean;
    private readonly _serverContextClient: McpClient;
    private readonly _pendingOwners: Map<string, ProviderSide> = new Map();
    private readonly _pendingForwardRequests: Map<string, { resolve: (message: JSONRPCMessage) => void; reject: (error: Error) => void }> = new Map();
    private _client: McpClient | null = null;
    private _clientConnectPromise: Promise<void> | null = null;
    private _clientConnected = false;
    private _closed = false;

    constructor(
        manager: SessionRelay,
        transport: BidirectionalMessageTransport,
        clientFactory: () => McpClient,
        forceInitialize: boolean,
        eagerClientConnect: boolean,
    ) {
        this._manager = manager;
        this._transport = transport;
        this._clientFactory = clientFactory;
        this.sessionId = createBidirectionalSessionId();
        this._clientTransport = new ConnectionClientTransport(this, forceInitialize);
        this._eagerClientConnect = eagerClientConnect;
        this._serverContextClient = this._createServerContextClient();
    }

    get client(): McpClient {
        return this._getOrCreateClient();
    }

    async start(): Promise<void> {
        this._manager.registerConnection(this);

        this._transport.onmessage = (message) => {
            this._handleInboundMessage(message).catch((error: any) => {
                this._clientTransport.fail(toError(error));
            });
        };
        this._transport.onerror = (error) => {
            this._failPendingForwardRequests(toError(error));
            this._clientTransport.fail(toError(error));
        };
        this._transport.onclose = () => {
            this._closed = true;
            this._manager.unregisterConnection(this.sessionId);
            this._failPendingForwardRequests(new Error('BidirectionalSession connection is closed'));
            this._clientTransport.shutdown();
        };

        if (this._eagerClientConnect) {
            await this._ensureClientConnected();
        }
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this._manager.unregisterConnection(this.sessionId);
        this._failPendingForwardRequests(new Error('BidirectionalSession connection is closed'));
        this._clientTransport.shutdown();
        if (this._client) {
            try { await this._client.close(); } catch (_) {}
        }
        await this._transport.close();
    }

    isReverseEnabled(): boolean {
        return this._manager.canUseReverse(this.sessionId);
    }

    serverContextClient(): McpClient {
        return this._serverContextClient;
    }

    requiresReverseNegotiation(): boolean {
        return this._manager.isServerContextActive(this.sessionId);
    }

    async sendFromClient(message: JSONRPCMessage): Promise<void> {
        await this.sendFromOwner('client', message);
    }

    async sendFromServer(message: JSONRPCMessage): Promise<void> {
        await this.sendFromOwner('server', message);
    }

    async request(message: JSONRPCMessage): Promise<JSONRPCMessage> {
        if (!isRequest(message)) {
            throw new Error('BidirectionalConnection.request requires a JSON-RPC request message');
        }

        const key = toRequestKey((message as any).id);
        if (this._pendingForwardRequests.has(key)) {
            throw new Error(`BidirectionalConnection duplicate forward request id: ${key}`);
        }

        return await new Promise<JSONRPCMessage>((resolve, reject) => {
            this._pendingForwardRequests.set(key, { resolve, reject });
            this.sendFromOwner('forward', message).catch((error: any) => {
                this._pendingOwners.delete(key);
                this._pendingForwardRequests.delete(key);
                reject(toError(error));
            });
        });
    }

    async notify(message: JSONRPCMessage): Promise<void> {
        if (!isNotification(message)) {
            throw new Error('BidirectionalConnection.notify requires a JSON-RPC notification message');
        }

        await this.sendFromOwner('forward', message);
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
        if (!this._manager.canUseReverse(this.sessionId)) {
            throw new Error('BidirectionalSession reverse service is not declared by peer for this session');
        }

        await this._ensureClientConnected();
    }

    private _createServerContextClient(): McpClient {
        const self = this;
        return new Proxy(Object.create(McpClient.prototype) as McpClient, {
            get(_obj: any, prop: string | symbol, _receiver: any) {
                const target = self.client as any;
                const value = Reflect.get(target, prop, target);
                if (typeof value !== 'function') {
                    return value;
                }

                return async function (...args: any[]) {
                    await self._ensureReverseClientReady();
                    return await value.apply(target, args);
                };
            },
        }) as unknown as McpClient;
    }

    private _getOrCreateClient(): McpClient {
        if (!this._client) {
            this._client = this._clientFactory();
        }

        return this._client;
    }

    private async _handleInboundMessage(message: JSONRPCMessage): Promise<void> {
        if (isRequest(message)) {
            if ((message as any).method === 'initialize') {
                const capabilities = (message as any)?.params?.capabilities;
                if (supportsReverseService(capabilities)) {
                    this._manager.enableReverseForSession(this.sessionId);
                }
            }

            await this._manager.receiveFromConnection(this.sessionId, message);
            return;
        }

        if (isResponse(message)) {
            const key = toRequestKey((message as any).id);
            const owner = this._pendingOwners.get(key) || 'client';
            this._pendingOwners.delete(key);

            if (owner === 'server') {
                await this._manager.receiveFromConnection(this.sessionId, message);
                return;
            }

            if (owner === 'forward') {
                const pending = this._pendingForwardRequests.get(key);
                if (pending) {
                    this._pendingForwardRequests.delete(key);
                    pending.resolve(message);
                    return;
                }
            }

            this._clientTransport.deliver(message);
            return;
        }

        if (isNotification(message)) {
            await this._manager.handlePeerNotification(this.sessionId, message);
            this._clientTransport.deliver(message);
            await this._manager.receiveFromConnection(this.sessionId, message);
        }
    }

    private _failPendingForwardRequests(error: Error): void {
        if (this._pendingForwardRequests.size === 0) {
            return;
        }

        for (const [key, pending] of this._pendingForwardRequests.entries()) {
            this._pendingOwners.delete(key);
            pending.reject(error);
        }

        this._pendingForwardRequests.clear();
    }
}

export class SessionRelay {
    private readonly _serverTransport: SharedServerTransport;
    private readonly _connections: Map<string, BridgeConnection> = new Map();
    private readonly _reverseEnabledSessions: Set<string> = new Set();
    private readonly _clientInfo: ClientInfo;
    private readonly _clientOptions: any;
    private _ensureServerConnected: (transport: SharedServerTransport) => Promise<void>;
    private _onPeerNotification?: (context: { sessionId: string; message: JSONRPCMessage }) => Promise<void> | void;

    constructor(options: SessionRelayOptions) {
        this._serverTransport = new SharedServerTransport(
            (sessionId) => this._isReverseEnabled(sessionId),
            (sessionId) => this._onPeerReverseSupported(sessionId),
        );
        this._clientInfo = options.clientInfo || { name: 'bidirectional-client', version: '1.0.0' };
        this._clientOptions = withReverseServiceCapability(options.clientOptions, true);
        this._ensureServerConnected = options.ensureServerConnected;
        this._onPeerNotification = options.onPeerNotification;
    }

    setEnsureServerConnected(ensureServerConnected: (transport: SharedServerTransport) => Promise<void>): void {
        this._ensureServerConnected = ensureServerConnected;
    }

    setOnPeerNotification(onPeerNotification?: (context: { sessionId: string; message: JSONRPCMessage }) => Promise<void> | void): void {
        this._onPeerNotification = onPeerNotification;
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
    async connect(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection>;
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

    async close(): Promise<void> {
        const connections = Array.from(this._connections.values());
        for (const connection of connections) {
            try { await connection.close(); } catch (_) {}
        }

        this._connections.clear();
        try { await this._serverTransport.close(); } catch (_) {}
    }

    async receiveFromConnection(sessionId: string, message: JSONRPCMessage): Promise<void> {
        await this._serverTransport.receiveFromConnection(sessionId, message);
    }

    registerConnection(connection: BridgeConnection): void {
        this._connections.set(connection.sessionId, connection);
        this._serverTransport.register(connection);
    }

    unregisterConnection(sessionId: string): void {
        this._connections.delete(sessionId);
        this._reverseEnabledSessions.delete(sessionId);
        this._serverTransport.unregister(sessionId);
    }

    enableReverseForSession(sessionId: string): void {
        if (!sessionId) return;
        this._reverseEnabledSessions.add(String(sessionId));
    }

    canUseReverse(sessionId: string): boolean {
        return this._isReverseEnabled(sessionId);
    }

    isServerContextActive(sessionId: string): boolean {
        return this._serverTransport.isSessionActive(sessionId);
    }

    serverContextClientForSession(sessionId?: string): McpClient | null {
        let finalSessionId = sessionId;

        if (!finalSessionId) {
            finalSessionId = this._serverTransport.activeSessionId() || undefined;
        }

        if (!finalSessionId) return null;
        const connection = this._connections.get(String(finalSessionId));
        return connection ? connection.serverContextClient() : null;
    }

    async handlePeerNotification(sessionId: string, message: JSONRPCMessage): Promise<void> {
        if (!this._onPeerNotification) return;
        await this._onPeerNotification({ sessionId, message });
    }

    private async _connect(transport: BidirectionalMessageTransport, eagerClientConnect: boolean): Promise<BidirectionalConnection> {
        await this._ensureServerConnected(this._serverTransport);
        await transport.start();

        const connection = new BridgeConnection(
            this,
            transport,
            () => new McpClient(this._clientInfo, this._clientOptions),
            true,
            eagerClientConnect,
        );
        await connection.start();

        return connection;
    }

    private _onPeerReverseSupported(sessionId: string): void {
        this.enableReverseForSession(sessionId);
    }

    private _isReverseEnabled(sessionId: string): boolean {
        return this._reverseEnabledSessions.has(String(sessionId));
    }
}