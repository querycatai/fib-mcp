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
    readonly browserSessionId: string;
    readonly request?: WebSocketConnectRequest;
    initialized: boolean;
    initializeRequest?: JSONRPCMessage;
    authContext?: any;
    agentConnection?: BidirectionalConnection;
}

export interface ForwardingGatewayRequestContext {
    session: ForwardingGatewaySession;
    message: JSONRPCMessage;
}

export interface ForwardingGatewayNotificationContext {
    session: ForwardingGatewaySession;
    message: JSONRPCMessage;
}

export interface ForwardingGatewayAgentNotificationContext {
    session: ForwardingGatewaySession;
    message: JSONRPCMessage;
}

export interface ForwardingGatewayConnectAgentContext {
    session: ForwardingGatewaySession;
    initializeRequest: JSONRPCMessage;
    authContext: any;
}

export interface ForwardingGatewayOptions {
    appInfo: ClientInfo;
    browserCapabilities?: any;
    instructions?: string;
    authenticate?: (context: { request?: WebSocketConnectRequest; initializeRequest: JSONRPCMessage }) => Promise<any> | any;
    connectAgent?: (context: ForwardingGatewayConnectAgentContext) => Promise<BidirectionalConnectOptions | BidirectionalMessageTransport> | (BidirectionalConnectOptions | BidirectionalMessageTransport);
    onForwardRequest?: (context: ForwardingGatewayRequestContext) => Promise<any> | any;
    onForwardNotification?: (context: ForwardingGatewayNotificationContext) => Promise<void> | void;
    onAgentNotification?: (context: ForwardingGatewayAgentNotificationContext) => Promise<boolean | void> | boolean | void;
    agentClientInfo?: BidirectionalSessionOptions['clientInfo'];
    agentClientOptions?: BidirectionalSessionOptions['clientOptions'];
    reverseServerOptions?: BidirectionalSessionOptions['serverOptions'];
}

interface BrowserSessionState extends ForwardingGatewaySession {
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
    private readonly _sessions: Map<string, BrowserSessionState> = new Map();

    constructor(options: ForwardingGatewayOptions) {
        this._options = options;
        this._relay = new SessionRelay({
            clientInfo: options.agentClientInfo,
            clientOptions: options.agentClientOptions,
            ensureServerConnected: async (_transport) => {},
            onPeerNotification: async ({ sessionId, message }) => {
                await this._handleAgentNotification(sessionId, message);
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
            self._acceptBrowser(conn, req).catch(async (error: any) => {
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
            await this._closeBrowserSession(session);
        }

        this._sessions.clear();
        await this._reverseEndpoint.close();
        await this._relay.close();
    }

    private async _acceptBrowser(transport: WebSocketServerTransport, request?: WebSocketConnectRequest): Promise<void> {
        const browserSessionId = createSessionId();
        const session: BrowserSessionState = {
            browserSessionId,
            request,
            transport,
            initialized: false,
            closed: false,
        };

        this._sessions.set(browserSessionId, session);

        transport.onmessage = (message) => {
            this._handleBrowserMessage(session, message).catch(async (error: any) => {
                if (!session.closed && isRequest(message)) {
                    await transport.send(jsonrpcError((message as any).id, -32603, toError(error).message));
                }
            });
        };
        transport.onerror = async () => {
            await this._closeBrowserSession(session);
        };
        transport.onclose = async () => {
            await this._closeBrowserSession(session);
        };
    }

    private async _handleBrowserMessage(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
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
                await session.transport.send(jsonrpcError((message as any).id, -32002, 'browser session is not initialized'));
            }
            return;
        }

        if (isRequest(message)) {
            await this._handleForwardRequest(session, message);
            return;
        }

        if (isNotification(message)) {
            await this._handleForwardNotification(session, message);
        }
    }

    private async _handleInitialize(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
        if (session.initialized) {
            await session.transport.send(jsonrpcError((message as any).id, -32600, 'browser session is already initialized'));
            return;
        }

        const authContext = this._options.authenticate
            ? await this._options.authenticate({ request: session.request, initializeRequest: message })
            : undefined;

        session.authContext = authContext;
        session.initializeRequest = message;

        if (this._options.connectAgent) {
            const target = await this._options.connectAgent({
                session,
                initializeRequest: message,
                authContext,
            });
            session.agentConnection = await this._relay.connect(target as any);
        }

        session.initialized = true;

        const requestedVersion = (message as any)?.params?.protocolVersion;
        const result: any = {
            protocolVersion: resolveProtocolVersion(requestedVersion),
            capabilities: this._options.browserCapabilities || {},
            serverInfo: this._options.appInfo,
        };

        if (this._options.instructions) {
            result.instructions = this._options.instructions;
        }

        await session.transport.send(jsonrpcResult((message as any).id, result));
    }

    private async _handleForwardRequest(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
        try {
            if (this._options.onForwardRequest) {
                const result = await this._options.onForwardRequest({ session, message });
                await session.transport.send(jsonrpcResult((message as any).id, result));
                return;
            }

            await this._handleDefaultForwardRequest(session, message);
        } catch (error: any) {
            const code = typeof error?.code === 'number' ? error.code : -32603;
            await session.transport.send(jsonrpcError((message as any).id, code, toError(error).message));
        }
    }

    private async _handleForwardNotification(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
        if (this._options.onForwardNotification) {
            await this._options.onForwardNotification({ session, message });
            return;
        }

        await this._handleDefaultForwardNotification(session, message);
    }

    private async _handleAgentNotification(agentSessionId: string, message: JSONRPCMessage): Promise<void> {
        const session = this._findSessionByAgentSessionId(agentSessionId);
        if (!session || session.closed || !session.initialized) {
            return;
        }

        const handled = this._options.onAgentNotification
            ? await this._options.onAgentNotification({ session, message })
            : undefined;

        if (handled) {
            return;
        }

        await session.transport.send(message);
    }

    private async _handleDefaultForwardRequest(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
        if (!session.agentConnection) {
            const error: any = new Error('agent connection is not established');
            error.code = -32001;
            throw error;
        }

        const response = await session.agentConnection.request(message as any);
        if (!isResponse(response as any)) {
            const error: any = new Error('forward request did not produce a JSON-RPC response');
            error.code = -32603;
            throw error;
        }

        await session.transport.send(response as any);
    }

    private async _handleDefaultForwardNotification(session: BrowserSessionState, message: JSONRPCMessage): Promise<void> {
        if (!session.agentConnection) {
            return;
        }

        await session.agentConnection.notify(message as any);
    }

    private async _closeBrowserSession(session: BrowserSessionState): Promise<void> {
        if (session.closed) return;
        session.closed = true;
        this._sessions.delete(session.browserSessionId);

        if (session.agentConnection) {
            try { await session.agentConnection.close(); } catch (_) {}
            session.agentConnection = undefined;
        }

        try { await session.transport.close(); } catch (_) {}
    }

    private _findSessionByAgentSessionId(agentSessionId: string): BrowserSessionState | null {
        for (const session of this._sessions.values()) {
            if (session.agentConnection?.sessionId === agentSessionId) {
                return session;
            }
        }

        return null;
    }
}