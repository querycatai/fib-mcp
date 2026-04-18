/**
 * fib-mcp: Transport base class
 * Compatible with @modelcontextprotocol/sdk Transport interface.
 */

export type JSONRPCMessage = Record<string, any>;

export type MessageHandler = (msg: JSONRPCMessage) => void | Promise<void>;
export type ErrorHandler   = (err: Error) => void | Promise<void>;
export type CloseHandler   = () => void | Promise<void>;

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
    readonly sessionId: string;

    constructor() {
        this.sessionId = `mcp-${Date.now()}-${(Math.random() * 0xffff | 0).toString(16)}`;
    }

    abstract start(): Promise<void>;
    abstract send(message: JSONRPCMessage): Promise<void>;
    abstract close(): Promise<void>;

    protected _receive(msg: JSONRPCMessage): void {
        try {
            const result = this.onmessage ? this.onmessage(msg) : null;
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
