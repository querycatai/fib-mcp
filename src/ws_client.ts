import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export interface WsClientConnectOptions {
    headers?: Record<string, string>;
    protocol?: string;
}

export class FibWebSocketClientTransport {
    onmessage: ((message: any) => void) | null = null;
    onerror: ((error: any) => void) | null = null;
    onclose: (() => void) | null = null;

    private _socket: any = null;
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
                try {
                    const raw = evt?.json ? evt.json() : JSON.parse(String(evt?.data || 'null'));
                    const message = JSONRPCMessageSchema.parse(raw);
                    if (this.onmessage) this.onmessage(message);
                } catch (error: any) {
                    if (this.onerror) this.onerror(error);
                }
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

    send(message: any): Promise<void> {
        if (!this._socket) {
            return Promise.reject(new Error('FibWebSocketClientTransport not connected'));
        }

        this._socket.send(JSON.stringify(message));
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
}

export function createWsClientTransport(url: string, options?: WsClientConnectOptions): any {
    return new FibWebSocketClientTransport(url, options || {}) as any;
}
