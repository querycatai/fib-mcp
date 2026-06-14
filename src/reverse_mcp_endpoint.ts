import { McpServer } from './server';
import { McpClient } from './client';
import { withReverseServiceCapability, type AnyToolHandler, type BidirectionalToolCallback, type BidirectionalToolContext, type BidirectionalToolExtra, type ClientInfo } from './bidirectional_shared';
import type { SharedServerTransport } from './session_relay';
import type { TransportSendOptions } from './base';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ReverseSessionClientProvider {
    serverContextClientForSession(sessionId?: string): McpClient | null;
}

interface ReverseMcpEndpointOptions {
    serverInfo: ClientInfo;
    serverOptions?: any;
    clientProvider: ReverseSessionClientProvider;
}

export class ReverseMcpEndpoint {
    private readonly _server: McpServer;

    private readonly _clientProvider: ReverseSessionClientProvider;
    private _connected = false;

    constructor(options: ReverseMcpEndpointOptions) {
        this._server = new McpServer(options.serverInfo, withReverseServiceCapability(options.serverOptions, true));
        this._clientProvider = options.clientProvider;
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

        return this._server.tool(...args.slice(0, -1), this._wrapToolHandler(userHandler));
    }

    registerTool(...args: any[]): RegisteredTool {
        return (this._server as any).registerTool(...args);
    }

    registerResource(...args: any[]): any {
        return (this._server as any).registerResource(...args);
    }

    registerPrompt(...args: any[]): any {
        return (this._server as any).registerPrompt(...args);
    }

    resource(...args: any[]): any {
        return (this._server as any).resource(...args);
    }

    prompt(...args: any[]): any {
        return (this._server as any).prompt(...args);
    }

    setRequestHandler(...args: any[]): any {
        return (this._server as any).server.setRequestHandler(...args);
    }

    setNotificationHandler(...args: any[]): any {
        return (this._server as any).server.setNotificationHandler(...args);
    }

    registerCapabilities(...args: any[]): any {
        return (this._server as any).server.registerCapabilities(...args);
    }

    /**
     * Send a notification through the reverse MCP channel.
     *
     * When called inside a tool handler (where a session is active),
     * the notification is automatically routed to the connected peer
     * that originated the current request.
     *
     * When called outside any handler context (no active session), a
     * target must be explicitly specified via options.
     *
     * @param method  - The notification method name (e.g. "notifications/progress").
     * @param params  - Optional notification parameters.
     * @param options - Optional transport options. Use `sessionId` to target
     *                  a specific session, or `relatedRequestId` to target the
     *                  session that owns a specific request.
     */
    async sendNotification(
        method: string,
        params?: Record<string, any>,
        options?: TransportSendOptions & { sessionId?: string },
    ): Promise<void> {
        await (this._server as any).server.notification(
            { method, params: params ?? {} },
            options,
        );
    }

    async ensureConnected(transport: SharedServerTransport): Promise<void> {
        if (this._connected) return;
        this._connected = true;
        await this._server.connect(transport);
    }

    async close(): Promise<void> {
        if (!this._connected) return;
        this._connected = false;
        try { await this._server.close(); } catch (_) {}
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

            const client = this._clientProvider.serverContextClientForSession(extra?.sessionId);
            if (!client) {
                throw new Error(`BidirectionalSession client not found for session ${String(extra?.sessionId || '')}`);
            }

            const context: BidirectionalToolContext = { client, extra: extra as BidirectionalToolExtra };

            if (handlerArgs.length === 1) {
                return await userHandler(context);
            }

            if (handlerArgs.length >= 2) {
                return await userHandler(payload, context);
            }

            return await userHandler();
        };
    }
}