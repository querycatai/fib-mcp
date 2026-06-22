/**
 * fib-mcp: TypeScript type declarations
 *
 * This file provides type information for consumers without resolving into
 * the .ts source files in node_modules, which may reference fibjs-specific
 * globals (process, sse, coroutine, etc.) that are not available in a
 * standard TypeScript environment.
 *
 * When this file exists and "types" points to it in package.json, TypeScript
 * uses it for type-checking and does not trace into the .ts source files.
 */

// ── Base types ────────────────────────────────────────────────────────────────

declare module 'fib-mcp' {
    export type JSONRPCMessage = Record<string, any>;

    export interface MessageExtraInfo {
        requestInfo?: any;
        authInfo?: any;
        closeSSEStream?: () => void;
        closeStandaloneSSEStream?: () => void;
        rawMessage?: string;
    }

    export interface TransportSendOptions {
        relatedRequestId?: string | number;
        resumptionToken?: string;
        onresumptiontoken?: (token: string) => void;
        rawMessage?: string;
    }

    export type MessageHandler = (msg: JSONRPCMessage, extra?: MessageExtraInfo) => void | Promise<void>;
    export type ErrorHandler = (err: Error) => void | Promise<void>;
    export type CloseHandler = () => void | Promise<void>;

    export abstract class Transport {
        onmessage: MessageHandler | null;
        onerror: ErrorHandler | null;
        onclose: CloseHandler | null;
        readonly sessionId: string;
        abstract start(): Promise<void>;
        abstract send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        abstract close(): Promise<void>;
    }

    // ── Client ────────────────────────────────────────────────────────────────

    export interface StdioServerParameters {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        stderr?: string | number;
    }

    export interface StreamableHTTPClientTransportOptions {
        authProvider?: any;
        sessionId?: string;
        [key: string]: unknown;
    }

    export interface McpClientHttpConnectOptions {
        transport: 'streamable-http';
        url: string;
        options?: StreamableHTTPClientTransportOptions;
    }

    export interface McpClientWsConnectOptions {
        transport: 'ws' | 'websocket';
        url: string;
        headers?: Record<string, string>;
        protocol?: string;
    }

    export interface McpClientSseConnectOptions {
        transport: 'sse';
        url: string;
        messageUrl?: string;
        options?: SseClientOptions;
    }

    export interface McpClientStdioConnectOptions {
        transport: 'stdio';
        command?: string;
        args?: string[];
        path?: string;
        options?: Omit<StdioServerParameters, 'command' | 'args'>;
    }

    export type McpClientConnectOptions =
        | McpClientHttpConnectOptions
        | McpClientWsConnectOptions
        | McpClientSseConnectOptions
        | McpClientStdioConnectOptions;

    export class McpClient {
        constructor(info: { name: string; version: string }, options?: any);
        connect(config: McpClientHttpConnectOptions): Promise<void>;
        connect(config: McpClientWsConnectOptions): Promise<void>;
        connect(config: McpClientSseConnectOptions): Promise<void>;
        connect(config: McpClientStdioConnectOptions): Promise<void>;
        connect(transport: any): Promise<void>;
        close(): Promise<void>;
        listTools(params?: any, options?: any): Promise<any>;
        callTool(params: any, options?: any): Promise<any>;
        listResources(params?: any, options?: any): Promise<any>;
        readResource(params: any, options?: any): Promise<any>;
        listPrompts(params?: any, options?: any): Promise<any>;
        getPrompt(params: any, options?: any): Promise<any>;
        ping(options?: any): Promise<any>;
        complete(params: any, options?: any): Promise<any>;
        setProtocolVersion(version: string): void;
        [key: string]: any;
    }

    // ── Server ────────────────────────────────────────────────────────────────

    export class McpServer {
        constructor(info: { name: string; version: string }, options?: any);
        listenStdio(): Promise<void>;
        wsHandler(): any;
        sseHandlers(): Record<string, any>;
        httpHandler(options?: any): any;
        httpHandlers(options?: HttpServerTransportOptions): Record<string, any>;
        connect(transport: any): Promise<void>;
        close(): Promise<void>;
        tool(name: string, cb: (...args: any[]) => any): any;
        tool(name: string, description: string, cb: (...args: any[]) => any): any;
        tool(name: string, paramsSchema: any, cb: (...args: any[]) => any): any;
        tool(name: string, description: string, paramsSchema: any, cb: (...args: any[]) => any): any;
        tool(name: string, paramsSchema: any, annotations: any, cb: (...args: any[]) => any): any;
        tool(name: string, description: string, paramsSchema: any, annotations: any, cb: (...args: any[]) => any): any;
        resource(name: string, uri: string, options: any, cb: (...args: any[]) => any): any;
        prompt(name: string, description: string, cb: (...args: any[]) => any): any;
        setRequestHandler(schema: any, cb: (...args: any[]) => any): any;
        setNotificationHandler(schema: any, cb: (...args: any[]) => any): any;
        registerCapabilities(capabilities: any): void;
        [key: string]: any;
    }

    // ── Transports ────────────────────────────────────────────────────────────

    export class StdioServerTransport extends Transport {
        constructor();
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export class StdioClientTransport extends Transport {
        constructor(options: StdioServerParameters);
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export class WebSocketClientTransport extends Transport {
        constructor(url: string, options?: any);
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export type ConnectCallback = (transport: WebSocketServerTransport, req?: WebSocketConnectRequest) => void;

    export interface WebSocketConnectRequest {
        headers?: any;
        [key: string]: unknown;
    }

    export class WebSocketServerTransport extends Transport {
        constructor();
        handler(onconnect?: ConnectCallback): any;
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export interface SseClientOptions {
        sessionId?: string;
        [key: string]: unknown;
    }

    export class SseServerTransport extends Transport {
        constructor();
        handlers(): Record<string, any>;
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export class SseClientTransport extends Transport {
        constructor(url: string, messageUrl?: string, options?: SseClientOptions);
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    export interface HttpServerTransportOptions {
        path?: string;
        timeoutMs?: number;
        [key: string]: unknown;
    }

    export class HttpServerTransport extends Transport {
        constructor(options?: HttpServerTransportOptions);
        handler(): any;
        start(): Promise<void>;
        send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
        close(): Promise<void>;
    }

    // ── BidirectionalSession ──────────────────────────────────────────────────

    export type BidirectionalMessageTransport = Transport;

    export interface BidirectionalSessionOptions {
        serverInfo: ClientInfo;
        clientInfo?: ClientInfo;
        clientOptions?: any;
        serverOptions?: any;
    }

    export interface BidirectionalWsConnectOptions {
        transport: 'ws' | 'websocket';
        url: string;
        headers?: Record<string, string>;
        protocol?: string;
    }

    export interface BidirectionalStdioConnectOptions {
        transport: 'stdio';
        command?: string;
        args?: string[];
        path?: string;
        options?: Omit<StdioServerParameters, 'command' | 'args'>;
    }

    export type BidirectionalConnectOptions = BidirectionalWsConnectOptions | BidirectionalStdioConnectOptions;

    export type BidirectionalToolExtra = any;

    export interface BidirectionalToolContext<Extra extends BidirectionalToolExtra = BidirectionalToolExtra> {
        client: McpClient;
        extra: Extra;
    }

    export type BidirectionalToolCallback<Args extends any = any> = (
        args: Args,
        context: BidirectionalToolContext,
    ) => any | Promise<any>;

    export interface BidirectionalConnection {
        readonly sessionId: string;
        readonly client: McpClient;
        request(message: any, options?: any): Promise<any>;
        notify(message: any, options?: any): Promise<void>;
        sendNotification(method: string, params?: Record<string, any>, options?: any): Promise<void>;
        close(): Promise<void>;
    }

    export interface ClientInfo {
        name: string;
        version: string;
    }

    export class BidirectionalSession {
        constructor(options: BidirectionalSessionOptions);
        tool(name: string, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, cb: BidirectionalToolCallback): any;
        tool(name: string, paramsSchema: any, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, paramsSchema: any, cb: BidirectionalToolCallback): any;
        tool(name: string, paramsSchema: any, annotations: any, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, paramsSchema: any, annotations: any, cb: BidirectionalToolCallback): any;
        registerTool(...args: any[]): any;
        registerResource(...args: any[]): any;
        registerPrompt(...args: any[]): any;
        resource(...args: any[]): any;
        prompt(...args: any[]): any;
        setRequestHandler(...args: any[]): any;
        setNotificationHandler(...args: any[]): any;
        registerCapabilities(...args: any[]): any;
        sendNotification(method: string, params?: Record<string, any>, options?: TransportSendOptions & { sessionId?: string }): Promise<void>;
        wsHandler(): any;
        listenStdio(): Promise<BidirectionalConnection>;
        connect(config: BidirectionalConnectOptions): Promise<BidirectionalConnection>;
        connect(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection>;
        accept(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection>;
        close(): Promise<void>;
    }

    // ── ForwardingGateway ─────────────────────────────────────────────────────

    export interface ForwardingGatewaySession {
        readonly clientSessionId: string;
        readonly request?: WebSocketConnectRequest;
        initialized: boolean;
        initializeRequest?: JSONRPCMessage;
        authContext?: any;
        serverConnection?: BidirectionalConnection;
    }

    export interface ForwardingGatewayClientRequestContext {
        readonly session: ForwardingGatewaySession;
        readonly message: JSONRPCMessage;
        reply(result: any): Promise<void>;
    }

    export interface ForwardingGatewayClientNotificationContext {
        readonly session: ForwardingGatewaySession;
        readonly message: JSONRPCMessage;
    }

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
        connectServer?: (context: ForwardingGatewayConnectServerContext) => Promise<BidirectionalConnectOptions | BidirectionalMessageTransport> | BidirectionalConnectOptions | BidirectionalMessageTransport;
        onClientDisconnect?: (session: ForwardingGatewaySession) => Promise<void> | void;
        onClientRequest?: (context: ForwardingGatewayClientRequestContext, next: ForwardingGatewayClientRequestNext) => Promise<void>;
        onClientNotification?: (context: ForwardingGatewayClientNotificationContext, next: ForwardingGatewayClientNotificationNext) => Promise<void>;
        onServerNotification?: (context: ForwardingGatewayServerNotificationContext, next: ForwardingGatewayServerNotificationNext) => Promise<void>;
        serverClientInfo?: ClientInfo;
        serverClientOptions?: any;
        reverseServerOptions?: any;
    }

    export class ForwardingGateway {
        constructor(options: ForwardingGatewayOptions);
        tool(name: string, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, cb: BidirectionalToolCallback): any;
        tool(name: string, paramsSchema: any, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, paramsSchema: any, cb: BidirectionalToolCallback): any;
        tool(name: string, paramsSchema: any, annotations: any, cb: BidirectionalToolCallback): any;
        tool(name: string, description: string, paramsSchema: any, annotations: any, cb: BidirectionalToolCallback): any;
        sendNotification(method: string, params?: Record<string, any>, options?: TransportSendOptions & { sessionId?: string }): Promise<void>;
        wsHandler(): any;
        close(): Promise<void>;
    }
}
