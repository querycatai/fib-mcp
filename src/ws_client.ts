import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

function extractWebSocketRawMessage(evt: any): string | undefined {
    if (typeof evt?.data === 'string') return evt.data;
    if (typeof evt?.string === 'function') {
        try {
            const raw = evt.string();
            return typeof raw === 'string' ? raw : undefined;
        } catch (_) {}
    }
    return undefined;
}

export interface WsClientConnectOptions {
    headers?: Record<string, string>;
    protocol?: string;
}

export class FibWebSocketClientTransport {
    onmessage: ((message: any, extra?: { rawMessage?: string }) => void | Promise<void>) | null = null;
    onrawmessage: ((rawMessage: string, extra?: { rawMessage?: string }) => boolean | Promise<boolean>) | null = null;
    onerror: ((error: any) => void) | null = null;
    onclose: (() => void) | null = null;

    private _socket: any = null;
    private _messageQueue: Promise<void> = Promise.resolve();
    private readonly _url: string;
    private readonly _options: WsClientConnectOptions;

    constructor(url: string, options?: WsClientConnectOptions) {
        this._url = String(url || '').trim();
        this._options = options || {};
    }

    start(): Promise<void> {
        if (this._socket) {
            throw new Error('WebSocketClientTransport already started! If using Client class, note that connect() calls start() automatically.');
        }

        return new Promise((resolve, reject) => {
            let opened = false;
            const wsOptions: any = {
                protocol: this._options.protocol || 'mcp',
            };

            const headers = this._options.headers || {};
            if (Object.keys(headers).length > 0) {
                wsOptions.headers = headers;
            }

            const socket = new WebSocket(this._url, wsOptions);
            this._socket = socket;

            socket.onopen = () => {
                opened = true;
                resolve();
            };

            socket.onmessage = (evt: any) => {
                this._enqueueInboundMessage(async () => {
                    const rawMessage = extractWebSocketRawMessage(evt);
                    const extra = rawMessage ? { rawMessage } : undefined;
                    if (rawMessage && this.onrawmessage) {
                        const handled = await this.onrawmessage(rawMessage, extra);
                        if (handled) return;
                    }

                    const raw = rawMessage ? JSON.parse(rawMessage) : evt?.json ? evt.json() : JSON.parse(String(evt?.data || 'null'));
                    const message = JSONRPCMessageSchema.parse(raw);
                    if (this.onmessage) {
                        await this.onmessage(message, extra);
                    }
                });
            };

            socket.onclose = () => {
                this._socket = null;
                if (this.onclose) this.onclose();
            };

            socket.onerror = (error: any) => {
                const normalized = error instanceof Error ? error : new Error(String(error || 'websocket error'));
                if (!opened) {
                    this._socket = null;
                    if (this.onerror) this.onerror(normalized);
                    reject(normalized);
                    return;
                }
                if (this.onerror) this.onerror(normalized);
            };
        });
    }

    send(message: any, options?: { rawMessage?: string }): Promise<void> {
        if (!this._socket) {
            return Promise.reject(new Error('FibWebSocketClientTransport not connected'));
        }

        this._socket.send(options?.rawMessage ?? JSON.stringify(message));
        return Promise.resolve();
    }

    close(): Promise<void> {
        if (this._socket) {
            try {
                this._socket.close();
            } catch {
                // Ignore close errors during teardown.
            }
            this._socket = null;
        }

        return Promise.resolve();
    }

    private _enqueueInboundMessage(handler: () => Promise<void>): void {
        const next = this._messageQueue.then(() => handler());
        this._messageQueue = next.catch(() => {});
        next.catch((error: any) => {
            if (this.onerror) {
                this.onerror(error);
            }
        });
    }
}

export function createWsClientTransport(url: string, options?: WsClientConnectOptions): any {
    return new FibWebSocketClientTransport(url, options || {}) as any;
}
