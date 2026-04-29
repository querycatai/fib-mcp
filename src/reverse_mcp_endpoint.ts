import { McpServer } from './server';
import { McpClient } from './client';
import { withReverseServiceCapability, type AnyToolHandler, type BidirectionalToolCallback, type BidirectionalToolContext, type BidirectionalToolExtra, type ClientInfo } from './bidirectional_shared';
import type { SharedServerTransport } from './session_relay';
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
    readonly server: McpServer;

    private readonly _clientProvider: ReverseSessionClientProvider;
    private _connected = false;

    constructor(options: ReverseMcpEndpointOptions) {
        this.server = new McpServer(options.serverInfo, withReverseServiceCapability(options.serverOptions, true));
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

        return this.server.tool(...args.slice(0, -1), this._wrapToolHandler(userHandler));
    }

    async ensureConnected(transport: SharedServerTransport): Promise<void> {
        if (this._connected) return;
        this._connected = true;
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        if (!this._connected) return;
        this._connected = false;
        try { await this.server.close(); } catch (_) {}
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