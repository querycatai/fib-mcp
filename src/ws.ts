/**
 * fib-mcp: WebSocket transport
 *
 * WebSocketServerTransport – pluggable HTTP route handler (no standalone server).
 *   Usage:
 *     const routes = { '/mcp': new WebSocketServerTransport().handler() };
 *
 * WebSocketClientTransport – connects to a WebSocket server URL.
 *   Usage:
 *     const t = new WebSocketClientTransport('ws://host:port/mcp');
 *     await t.start();
 */

import { Transport } from './base';
import type { JSONRPCMessage } from './base';

declare const WebSocket: any;

// ─── WebSocketServerTransport ─────────────────────────────────────────────────

export type ConnectCallback = (transport: WebSocketServerTransport) => void;

/**
 * Server-side WebSocket transport.
 *
 * Exposes a `handler()` suitable for fibjs HTTP routing.
 * A new transport instance is created per connection when `onconnect` is supplied
 * (multi-client). Without it, connections are attached to *this* instance.
 */
export class WebSocketServerTransport extends Transport {
    private _socket: any = null;
    private _started = false;

    /**
     * Returns a WebSocket.upgrade() route handler.
     *
     * @param onconnect – optional callback(transport) for each connection (multi-client).
     *   If omitted, the connection is attached to this transport instance (single-client).
     */
    handler(onconnect?: ConnectCallback): any {
        const self = this;
        return WebSocket.upgrade(function (socket: any) {
            if (typeof onconnect === 'function') {
                const t = new WebSocketServerTransport();
                t._attachSocket(socket);
                onconnect(t);
            } else {
                self._attachSocket(socket);
            }
        });
    }

    private _attachSocket(socket: any): void {
        this._socket = socket;
        const self = this;

        socket.onmessage = function (evt: any) {
            try {
                self._receive(evt.json());
            } catch (e: any) {
                self._error(new Error('ws: JSON parse error: ' + e.message));
            }
        };

        socket.onclose = function () {
            self._socket = null;
            self._closed();
        };

        socket.onerror = function (err: any) {
            self._error(err instanceof Error ? err : new Error(String(err)));
        };
    }

    async start(): Promise<void> {
        this._started = true;
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._socket) throw new Error('WebSocketServerTransport: no client connected');
        this._socket.send(JSON.stringify(message));
    }

    async close(): Promise<void> {
        if (this._socket) {
            try { this._socket.close(); } catch (_) {}
            this._socket = null;
        }
        this._closed();
    }

    get connected(): boolean {
        return this._socket !== null;
    }
}

// ─── WebSocketClientTransport ─────────────────────────────────────────────────

export interface WebSocketClientOptions {
    protocols?: string | string[];
}

/**
 * Client-side WebSocket transport. Connects to a WebSocket server URL.
 */
export class WebSocketClientTransport extends Transport {
    private _url: string;
    private _options: WebSocketClientOptions;
    private _socket: any = null;

    constructor(url: string, options: WebSocketClientOptions = {}) {
        super();
        this._url     = url;
        this._options = options;
    }

    async start(): Promise<void> {
        const self = this;
        return new Promise<void>(function (resolve, reject) {
            const protocols = self._options.protocols || '';
            const ws = new WebSocket(self._url, protocols);

            ws.onopen = function () { resolve(); };

            ws.onerror = function (err: any) {
                const e = err instanceof Error ? err : new Error('ws connect error');
                reject(e);
                self._error(e);
            };

            ws.onmessage = function (evt: any) {
                try {
                    self._receive(evt.json());
                } catch (e: any) {
                    self._error(new Error('ws: JSON parse error: ' + e.message));
                }
            };

            ws.onclose = function () {
                self._socket = null;
                self._closed();
            };

            self._socket = ws;
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._socket) throw new Error('WebSocketClientTransport: not connected');
        this._socket.send(JSON.stringify(message));
    }

    async close(): Promise<void> {
        if (this._socket) {
            try { this._socket.close(); } catch (_) {}
            this._socket = null;
        }
        this._closed();
    }

    get connected(): boolean {
        return this._socket !== null && this._socket.readyState === WebSocket.OPEN;
    }
}
