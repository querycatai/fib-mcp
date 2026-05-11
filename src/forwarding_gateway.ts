import { createSessionId } from './base';
import type { JSONRPCMessage } from './base';
import { ReverseMcpEndpoint } from './reverse_mcp_endpoint';
import { SessionRelay } from './session_relay';
import { WebSocketServerTransport } from './ws';
import type { WebSocketConnectRequest } from './ws';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
    isNotification,
    isRequest,
    isResponse,
    toError,
    type BidirectionalConnectOptions,
    type BidirectionalConnection,
    type BidirectionalMessageTransport,
    type BidirectionalSessionOptions,
    type BidirectionalToolCallback,
    type ClientInfo,
} from './bidirectional_shared';

export interface ForwardingGatewaySession {
    readonly clientSessionId: string;
    readonly request?: WebSocketConnectRequest;
    initialized: boolean;
    initializeRequest?: JSONRPCMessage;
    authContext?: any;
    serverConnection?: BidirectionalConnection;
}

/**
 * Context for an incoming JSON-RPC request from the downstream MCP client.
 *
 * Call `next()` to forward the request to the upstream server with the original message.
 * Call `next(modifiedMessage)` to forward a rewritten message instead.
 * Call `reply(result)` to respond locally without forwarding to the upstream server.
 * Throw an error to send a JSON-RPC error response; attach a numeric `.code` property
 * to control the error code (default: -32603).
 */
export interface ForwardingGatewayClientRequestContext {
    readonly session: ForwardingGatewaySession;
    readonly message: JSONRPCMessage;
    reply(result: any): Promise<void>;
}

/**
 * Context for an incoming JSON-RPC notification from the downstream MCP client.
 *
 * Call `next()` to forward the notification to the upstream server unchanged.
 * Call `next(modifiedMessage)` to forward a rewritten notification instead.
 * Return without calling `next()` to suppress forwarding entirely.
 */
export interface ForwardingGatewayClientNotificationContext {
    readonly session: ForwardingGatewaySession;
    readonly message: JSONRPCMessage;
}

/**
 * Context for an incoming JSON-RPC notification from the upstream MCP server.
 *
 * Call `next()` to forward the notification to the downstream client unchanged.
 * Call `next(modifiedMessage)` to forward a rewritten notification instead.
 * Return without calling `next()` to suppress forwarding entirely.
 */
export interface ForwardingGatewayServerNotificationContext {
    readonly session: ForwardingGatewaySession;
    readonly message: JSONRPCMessage;
}

export interface ForwardingGatewayConnectServerContext {
    session: ForwardingGatewaySession;
    initializeRequest: JSONRPCMessage;
    authContext: any;
}

export type ForwardingGatewayClientRequestNext = (message?: JSONRPCMessage) => Promise<void>;
export type ForwardingGatewayClientNotificationNext = (message?: JSONRPCMessage) => Promise<void>;
export type ForwardingGatewayServerNotificationNext = (message?: JSONRPCMessage) => Promise<void>;

export interface ForwardingGatewayOptions {
    appInfo: ClientInfo;
    clientCapabilities?: any;
    instructions?: string;
    authenticate?: (context: { request?: WebSocketConnectRequest; initializeRequest: JSONRPCMessage }) => Promise<any> | any;
    connectServer?: (context: ForwardingGatewayConnectServerContext) => Promise<BidirectionalConnectOptions | BidirectionalMessageTransport> | (BidirectionalConnectOptions | BidirectionalMessageTransport);
    onClientDisconnect?: (session: ForwardingGatewaySession) => Promise<void> | void;
    onClientRequest?: (context: ForwardingGatewayClientRequestContext, next: ForwardingGatewayClientRequestNext) => Promise<void>;
    onClientNotification?: (context: ForwardingGatewayClientNotificationContext, next: ForwardingGatewayClientNotificationNext) => Promise<void>;
    onServerNotification?: (context: ForwardingGatewayServerNotificationContext, next: ForwardingGatewayServerNotificationNext) => Promise<void>;
    serverClientInfo?: BidirectionalSessionOptions['clientInfo'];
    serverClientOptions?: BidirectionalSessionOptions['clientOptions'];
    reverseServerOptions?: BidirectionalSessionOptions['serverOptions'];
}

interface ClientSessionState extends ForwardingGatewaySession {
    transport: WebSocketServerTransport;
    closed: boolean;
}

function jsonrpcResult(id: any, result: any): JSONRPCMessage {
    return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id: any, code: number, message: string): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code, message },
    };
}

function resolveProtocolVersion(requestedVersion?: string): string {
    if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.indexOf(requestedVersion) >= 0) {
        return requestedVersion;
    }

    return LATEST_PROTOCOL_VERSION;
}

export class ForwardingGateway {
    readonly server: ReverseMcpEndpoint['server'];

    private readonly _options: ForwardingGatewayOptions;
    private readonly _relay: SessionRelay;
    private readonly _reverseEndpoint: ReverseMcpEndpoint;
    private readonly _sessions: Map<string, ClientSessionState> = new Map();

    constructor(options: ForwardingGatewayOptions) {
        this._options = options;
        this._relay = new SessionRelay({
            clientInfo: options.serverClientInfo,
            clientOptions: options.serverClientOptions,
            ensureServerConnected: async (_transport) => {},
            onPeerNotification: async ({ sessionId, message }) => {
                await this._handleServerNotification(sessionId, message);
            },
        });
        this._reverseEndpoint = new ReverseMcpEndpoint({
            serverInfo: options.appInfo,
            serverOptions: options.reverseServerOptions,
            clientProvider: this._relay,
        });
        this._relay.setEnsureServerConnected(async (transport) => {
            await this._reverseEndpoint.ensureConnected(transport);
        });
        this.server = this._reverseEndpoint.server;
    }

    tool(name: string, cb: BidirectionalToolCallback): RegisteredTool;
    tool(name: string, description: string, cb: BidirectionalToolCallback): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchemaOrAnnotations: Args | ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, description: string, paramsSchemaOrAnnotations: Args | ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, paramsSchema: Args, annotations: ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool<Args extends ZodRawShapeCompat>(name: string, description: string, paramsSchema: Args, annotations: ToolAnnotations, cb: BidirectionalToolCallback<Args>): RegisteredTool;
    tool(...args: any[]): RegisteredTool {
        return this._reverseEndpoint.tool(...args);
    }

    wsHandler(): any {
        const self = this;
        const transport = new WebSocketServerTransport();
        return transport.handler(function (conn: WebSocketServerTransport, req?: WebSocketConnectRequest) {
            self._acceptClient(conn, req).catch(async (error: any) => {
                const normalized = toError(error);
                try {
                    if (conn.onerror) conn.onerror(normalized);
                } catch (_) {}
                try { await conn.close(); } catch (_) {}
            });
        });
    }

    async close(): Promise<void> {
        const sessions = Array.from(this._sessions.values());
        for (const session of sessions) {
            await this._closeClientSession(session);
        }

        this._sessions.clear();
        await this._reverseEndpoint.close();
        await this._relay.close();
    }

    private async _acceptClient(transport: WebSocketServerTransport, request?: WebSocketConnectRequest): Promise<void> {
        const clientSessionId = createSessionId();
        const session: ClientSessionState = {
            clientSessionId,
            request,
            transport,
            initialized: false,
            closed: false,
        };

        this._sessions.set(clientSessionId, session);

        transport.onmessage = (message) => {
            this._handleClientMessage(session, message).catch(async (error: any) => {
                if (!session.closed && isRequest(message)) {
                    await transport.send(jsonrpcError((message as any).id, -32603, toError(error).message));
                }
            });
        };
        transport.onerror = async () => {
            await this._closeClientSession(session);
        };
        transport.onclose = async () => {
            await this._closeClientSession(session);
        };
    }

    private async _handleClientMessage(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        if (isResponse(message)) {
            return;
        }

        if (isRequest(message) && (message as any).method === 'initialize') {
            await this._handleInitialize(session, message);
            return;
        }

        if (isNotification(message) && (message as any).method === 'notifications/initialized') {
            return;
        }

        if (!session.initialized) {
            if (isRequest(message)) {
                await session.transport.send(jsonrpcError((message as any).id, -32002, 'client session is not initialized'));
            }
            return;
        }

        if (isRequest(message)) {
            await this._handleClientRequest(session, message);
            return;
        }

        if (isNotification(message)) {
            await this._handleClientNotification(session, message);
        }
    }

    private async _handleInitialize(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        if (session.initialized) {
            await session.transport.send(jsonrpcError((message as any).id, -32600, 'client session is already initialized'));
            return;
        }

        const authContext = this._options.authenticate
            ? await this._options.authenticate({ request: session.request, initializeRequest: message })
            : undefined;

        session.authContext = authContext;
        session.initializeRequest = message;

        if (this._options.connectServer) {
            const target = await this._options.connectServer({
                session,
                initializeRequest: message,
                authContext,
            });
            session.serverConnection = await this._relay.connect(target as any);
        }

        session.initialized = true;

        const requestedVersion = (message as any)?.params?.protocolVersion;
        const result: any = {
            protocolVersion: resolveProtocolVersion(requestedVersion),
            capabilities: this._options.clientCapabilities || {},
            serverInfo: this._options.appInfo,
        };

        if (this._options.instructions) {
            result.instructions = this._options.instructions;
        }

        await session.transport.send(jsonrpcResult((message as any).id, result));
    }

    private async _handleClientRequest(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        const defaultNext = async (msg: JSONRPCMessage = message) => {
            await this._defaultClientRequest(session, msg);
        };

        try {
            if (this._options.onClientRequest) {
                const ctx: ForwardingGatewayClientRequestContext = {
                    session,
                    message,
                    reply: async (result) => {
                        await session.transport.send(jsonrpcResult((message as any).id, result));
                    },
                };
                await this._options.onClientRequest(ctx, defaultNext);
            } else {
                await defaultNext();
            }
        } catch (error: any) {
            const code = typeof error?.code === 'number' ? error.code : -32603;
            await session.transport.send(jsonrpcError((message as any).id, code, toError(error).message));
        }
    }

    private async _handleClientNotification(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        const defaultNext = async (msg: JSONRPCMessage = message) => {
            await this._defaultClientNotification(session, msg);
        };

        if (this._options.onClientNotification) {
            const ctx: ForwardingGatewayClientNotificationContext = { session, message };
            await this._options.onClientNotification(ctx, defaultNext);
        } else {
            await defaultNext();
        }
    }

    private async _handleServerNotification(serverSessionId: string, message: JSONRPCMessage): Promise<void> {
        const session = this._findSessionByServerSessionId(serverSessionId);
        if (!session || session.closed || !session.initialized) {
            return;
        }

        const defaultNext = async (msg: JSONRPCMessage = message) => {
            await session.transport.send(msg);
        };

        if (this._options.onServerNotification) {
            const ctx: ForwardingGatewayServerNotificationContext = { session, message };
            await this._options.onServerNotification(ctx, defaultNext);
        } else {
            await defaultNext();
        }
    }

    private async _defaultClientRequest(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        if (!session.serverConnection) {
            const error: any = new Error('server connection is not established');
            error.code = -32001;
            throw error;
        }

        const response = await session.serverConnection.request(message as any);
        if (!isResponse(response as any)) {
            const error: any = new Error('forward request did not produce a JSON-RPC response');
            error.code = -32603;
            throw error;
        }

        await session.transport.send(response as any);
    }

    private async _defaultClientNotification(session: ClientSessionState, message: JSONRPCMessage): Promise<void> {
        if (!session.serverConnection) {
            return;
        }

        await session.serverConnection.notify(message as any);
    }

    private async _closeClientSession(session: ClientSessionState): Promise<void> {
        if (session.closed) return;
        session.closed = true;
        this._sessions.delete(session.clientSessionId);

        if (session.serverConnection) {
            try { await session.serverConnection.close(); } catch (_) {}
            session.serverConnection = undefined;
        }

        try { await session.transport.close(); } catch (_) {}

        if (this._options.onClientDisconnect) {
            try { await this._options.onClientDisconnect(session); } catch (_) {}
        }
    }

    private _findSessionByServerSessionId(serverSessionId: string): ClientSessionState | null {
        for (const session of this._sessions.values()) {
            if (session.serverConnection?.sessionId === serverSessionId) {
                return session;
            }
        }

        return null;
    }
}