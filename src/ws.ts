/**
 * fib-mcp: WebSocket server transport
 *
 * WebSocketServerTransport – pluggable HTTP route handler (no standalone server).
 *   Usage:
 *     const routes = { '/mcp': new WebSocketServerTransport().handler() };
 *
 */

import { Transport } from './base';
import type { JSONRPCMessage } from './base';

declare const WebSocket: any;

const DEFAULT_WS_PROTOCOL = 'mcp';

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
        return WebSocket.upgrade({ protocol: DEFAULT_WS_PROTOCOL }, function (socket: any) {
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


