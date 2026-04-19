/**
 * fib-mcp: Transport base class
 * Compatible with @modelcontextprotocol/sdk Transport interface.
 */

export type JSONRPCMessage = Record<string, any>;

export interface MessageExtraInfo {
    requestInfo?: any;
    authInfo?: any;
    closeSSEStream?: () => void;
    closeStandaloneSSEStream?: () => void;
}

export interface TransportSendOptions {
    relatedRequestId?: string | number;
    resumptionToken?: string;
    onresumptiontoken?: (token: string) => void;
}

export type MessageHandler = (msg: JSONRPCMessage, extra?: MessageExtraInfo) => void | Promise<void>;
export type ErrorHandler   = (err: Error) => void | Promise<void>;
export type CloseHandler   = () => void | Promise<void>;

const SESSION_ID_SEED = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(36)}`;
let sessionIdCounter = 0;

export function createSessionId(): string {
    sessionIdCounter += 1;
    return `mcp-${SESSION_ID_SEED}-${sessionIdCounter.toString(36)}`;
}

/**
 * Base transport class. All transports extend this.
 *
 * Compatible with @modelcontextprotocol/sdk Transport interface:
 *   start()   – begin accepting / connecting
 *   send(msg) – send a JSON-RPC message
 *   close()   – tear down the connection
 *   onmessage – callback(msg)
 *   onerror   – callback(err)
 *   onclose   – callback()
 */
export abstract class Transport {
    onmessage: MessageHandler | null = null;
    onerror:   ErrorHandler   | null = null;
    onclose:   CloseHandler   | null = null;
    protected _sessionId: string;

    constructor() {
        this._sessionId = createSessionId();
    }

    get sessionId(): string {
        return this._sessionId;
    }

    abstract start(): Promise<void>;
    abstract send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
    abstract close(): Promise<void>;

    protected _receive(msg: JSONRPCMessage, extra?: MessageExtraInfo): void {
        try {
            const result = this.onmessage ? this.onmessage(msg, extra) : null;
            if (result && typeof (result as any).then === 'function') {
                (result as Promise<void>).catch((e: any) => {
                    this._error(e instanceof Error ? e : new Error(String(e)));
                });
            }
        } catch (e) {
            this._error(e instanceof Error ? e : new Error(String(e)));
        }
    }

    protected _error(err: Error): void {
        if (!this.onerror) return;
        try {
            const result = this.onerror(err);
            if (result && typeof (result as any).then === 'function') {
                (result as Promise<void>).catch(() => {});
            }
        } catch (_) {}
    }

    protected _closed(): void {
        if (!this.onclose) return;
        try {
            const result = this.onclose();
            if (result && typeof (result as any).then === 'function') {
                (result as Promise<void>).catch(() => {});
            }
        } catch (_) {}
    }
}
