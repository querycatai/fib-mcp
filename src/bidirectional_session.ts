import { ReverseMcpEndpoint } from './reverse_mcp_endpoint';
import { SessionRelay } from './session_relay';
import { McpServer } from './server';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { BidirectionalConnectOptions, BidirectionalConnection, BidirectionalMessageTransport, BidirectionalSessionOptions, BidirectionalToolCallback } from './bidirectional_shared';
export type {
    BidirectionalConnectOptions,
    BidirectionalConnection,
    BidirectionalMessageTransport,
    BidirectionalSessionOptions,
    BidirectionalStdioConnectOptions,
    BidirectionalToolCallback,
    BidirectionalToolContext,
    BidirectionalToolExtra,
    BidirectionalWsConnectOptions,
} from './bidirectional_shared';

export class BidirectionalSession {
    readonly server: McpServer;
    private readonly _relay: SessionRelay;
    private readonly _reverseEndpoint: ReverseMcpEndpoint;

    constructor(options: BidirectionalSessionOptions) {
        if (!options || !options.serverInfo) {
            throw new Error('BidirectionalSession requires serverInfo');
        }

        this._relay = new SessionRelay({
            clientInfo: options.clientInfo,
            clientOptions: options.clientOptions,
            ensureServerConnected: async (_transport) => {},
        });
        this._reverseEndpoint = new ReverseMcpEndpoint({
            serverInfo: options.serverInfo,
            serverOptions: options.serverOptions,
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
        return this._relay.wsHandler();
    }

    async listenStdio(): Promise<BidirectionalConnection> {
        return await this._relay.listenStdio();
    }

    async connect(config: BidirectionalConnectOptions): Promise<BidirectionalConnection>;
    async connect(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection> {
        return this._relay.connect(transport);
    }

    async connect(target: any): Promise<BidirectionalConnection> {
        return this._relay.connect(target);
    }

    async accept(transport: BidirectionalMessageTransport): Promise<BidirectionalConnection> {
        return await this._relay.accept(transport);
    }

    async close(): Promise<void> {
        await this._reverseEndpoint.close();
        await this._relay.close();
    }
}

