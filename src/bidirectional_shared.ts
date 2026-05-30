import { createSessionId } from './base';
import { McpClient } from './client';
import { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWsClientTransport } from './ws_client';
import type { AnySchema, SchemaOutput, ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport as SdkTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { MessageExtraInfo } from './base';
import type { TransportSendOptions } from './base';

export type ProviderSide = 'server' | 'client' | 'forward';
export type AnyToolHandler = (...args: any[]) => any;

const REVERSE_EXTENSION_NAMESPACE = 'fib-mcp';

export interface ClientInfo {
    name: string;
    version: string;
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export function toRequestKey(id: any): string {
    return typeof id === 'string' ? id : JSON.stringify(id);
}

export function isRequest(message: Record<string, any>): boolean {
    return hasOwn(message, 'method') && hasOwn(message, 'id');
}

export function isNotification(message: Record<string, any>): boolean {
    return hasOwn(message, 'method') && !hasOwn(message, 'id');
}

export function isResponse(message: Record<string, any>): boolean {
    return hasOwn(message, 'id') && (hasOwn(message, 'result') || hasOwn(message, 'error'));
}

export function toError(error: any): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function createBidirectionalSessionId(): string {
    return createSessionId();
}

export function supportsReverseService(capabilities: any): boolean {
    return capabilities?.extensions?.[REVERSE_EXTENSION_NAMESPACE]?.reverseService === true;
}

export function withReverseServiceCapability(options: any, enabled: boolean): any {
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

export function createBidirectionalClientTransportFromConfig(config: BidirectionalConnectOptions): BidirectionalMessageTransport {
    if (config.transport === 'ws' || config.transport === 'websocket') {
        return createWsClientTransport(config.url, {
            headers: config.headers,
            protocol: config.protocol,
        }) as any;
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
    callTool(...args: any[]): Promise<any>;
    listTools(...args: any[]): Promise<any>;
    readResource(...args: any[]): Promise<any>;
    listResources(...args: any[]): Promise<any>;
    listPrompts(...args: any[]): Promise<any>;
    getPrompt(...args: any[]): Promise<any>;
    request(message: Record<string, any>, options?: TransportSendOptions & { onresponsemessage?: (extra?: MessageExtraInfo) => void; onrawresponse?: (rawMessage: string, extra?: MessageExtraInfo) => boolean | Promise<boolean> }): Promise<Record<string, any> | null>;
    notify(message: Record<string, any>, options?: TransportSendOptions): Promise<void>;
    close(): Promise<void>;
}