/**
 * fib-mcp: SSE (Server-Sent Events) transport
 *
 * SseServerTransport – HTTP server with two routes:
 *   GET  <ssePath>     → SSE stream (server → client messages)
 *   POST <messagePath> → receive client → server messages
 *
 * SseClientTransport – connects to SSE endpoint, sends via HTTP POST.
 *
 * Usage (server):
 *   const t = new SseServerTransport('/mcp/sse', '/mcp/message');
 *   const routes = t.routes();
 *   // mount routes into an http.Server, then:
 *   await mcpServer.connect(t);
 *
 * Usage (client):
 *   const t = new SseClientTransport('http://host/mcp/sse', 'http://host/mcp/message');
 *   await t.start();
 */

import { Transport } from './base';
import type { JSONRPCMessage } from './base';

import sse from 'sse';

// ─── SseServerTransport ───────────────────────────────────────────────────────

/**
 * Server-side SSE transport.
 *
 * Call `.routes()` to get a fibjs route map with two entries:
 *   { [ssePath]: sseHandler, [messagePath]: postHandler }
 *
 * Mount these routes inside an `http.Server` routing object.
 *
 * Upon connection the server immediately pushes an `endpoint` named SSE event
 * containing the POST URL (standard MCP SSE protocol), enabling clients that
 * use automatic endpoint discovery (i.e. no pre-configured messageUrl).
 */
export class SseServerTransport extends Transport {
    private _ssePath:     string;
    private _messagePath: string;
    private _sender:      any  = null;   // sse sender object

    constructor(ssePath: string = '/mcp/sse', messagePath: string = '/mcp/message') {
        super();
        this._ssePath     = ssePath;
        this._messagePath = messagePath;
    }

    /**
     * Returns path-agnostic handlers for SSE GET and message POST endpoints.
     */
    handlers(): { sse: any; message: any } {
        const self = this;

        const sseHandler = sse.upgrade(function (se: any, _req: any) {
            self._sender = se;

            // Send the standard MCP "endpoint" event so clients can discover
            // the POST URL without it being pre-configured.
            se.send(self._messagePath, { event: 'endpoint' });

            se.onclose = function () {
                self._sender = null;
                self._closed();
            };
        });

        const postHandler = function (req: any) {
            let msg: JSONRPCMessage;
            try {
                msg = req.json();
            } catch (e: any) {
                req.response.status = 400;
                req.response.json({ error: 'invalid JSON' });
                return;
            }

            self._receive(msg);
            req.response.status = 202;
            req.response.write('');
        };

        return { sse: sseHandler, message: postHandler };
    }

    /**
     * Returns a fibjs route map:
     * {
     *   [ssePath]:     sse.upgrade handler  – client connects here
     *   [messagePath]: POST handler         – client sends messages here
     * }
     */
    routes(): Record<string, any> {
        const h = this.handlers();
        return {
            [this._ssePath]: h.sse,
            [this._messagePath]: h.message,
        };
    }

    async start(): Promise<void> {
        // Nothing to do – routes must be mounted before start
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this._sender) throw new Error('SseServerTransport: no client connected');
        this._sender.send(JSON.stringify(message));
    }

    async close(): Promise<void> {
        if (this._sender) {
            try { this._sender.close(); } catch (_) {}
            this._sender = null;
        }
        this._closed();
    }

    get connected(): boolean {
        return this._sender !== null;
    }
}

// ─── SseClientTransport ───────────────────────────────────────────────────────

export interface SseClientOptions {
    /** Extra headers to include in requests */
    headers?: Record<string, string>;
    /** HTTP method for the POST message endpoint (default: 'POST') */
    method?: string;
}

/**
 * Client-side SSE transport.
 *
 * Opens an SSE connection (GET) to `sseUrl` to receive server messages.
 * Sends client messages via HTTP POST to `messageUrl`.
 *
 * If `messageUrl` is omitted, the transport listens for the `endpoint` named
 * SSE event (standard MCP SSE protocol) and discovers the POST URL dynamically.
 * In that case `start()` resolves only after the endpoint has been received.
 */
export class SseClientTransport extends Transport {
    private _sseUrl:     string;
    private _messageUrl: string;
    private _options:    SseClientOptions;
    private _es:         any  = null;   // sse.EventSource

    constructor(
        sseUrl:     string,
        messageUrl: string = '',
        options:    SseClientOptions = {}
    ) {
        super();
        this._sseUrl     = sseUrl;
        this._messageUrl = messageUrl;
        this._options    = options;
    }

    async start(): Promise<void> {
        const self = this;
        const needsEndpointDiscovery = !self._messageUrl;

        return new Promise<void>(function (resolve, reject) {
            const es = new sse.EventSource(self._sseUrl);

            // For local transports (messageUrl pre-set), resolve on open.
            // For remote transports, resolve only after endpoint event.
            if (!needsEndpointDiscovery) {
                es.onopen = function () {
                    resolve();
                };
            }

            // Named "endpoint" event – standard MCP SSE protocol:
            //   event: endpoint
            //   data: /messages/?session_id=xxx   (or absolute URL)
            es.addEventListener('endpoint', function (evt: any) {
                const data: string = typeof evt === 'string' ? evt : (evt.data ?? evt);
                if (!data) return;
                if (data.startsWith('http://') || data.startsWith('https://')) {
                    self._messageUrl = data;
                } else {
                    // Relative path – resolve against the SSE origin
                    const origin = self._sseUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1');
                    self._messageUrl = origin + data;
                }
                if (needsEndpointDiscovery) {
                    resolve();
                }
            });

            es.onerror = function (err: any) {
                const e = err instanceof Error ? err : new Error('sse connect error: ' + String(err));
                reject(e);
                self._error(e);
            };

            es.onmessage = function (evt: any) {
                const data: string = typeof evt === 'string' ? evt : (evt.data ?? evt);
                try {
                    self._receive(JSON.parse(data));
                } catch (e: any) {
                    self._error(new Error('sse: JSON parse error: ' + e.message));
                }
            };

            es.onclose = function () {
                self._es = null;
                self._closed();
            };

            self._es = es;
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        const body    = JSON.stringify(message);
        const headers = Object.assign(
            { 'Content-Type': 'application/json' },
            this._options.headers || {}
        );

        const resp = await fetch(this._messageUrl, {
            method: this._options.method || 'POST',
            headers,
            body,
        });

        const status = resp.status ?? 0;
        if (status >= 400) {
            throw new Error(`SseClientTransport: POST failed with status ${status}`);
        }
    }

    async close(): Promise<void> {
        if (this._es) {
            try { this._es.close(); } catch (_) {}
            this._es = null;
        }
        this._closed();
    }

    get connected(): boolean {
        return this._es !== null;
    }
}
