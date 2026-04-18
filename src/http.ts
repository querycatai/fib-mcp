/**
 * fib-mcp: Streamable HTTP-like server transport for fibjs
 *
 * This transport handles MCP JSON-RPC over HTTP POST and returns JSON-RPC results
 * in the same response body.
 */

import { Transport } from './base';
import type { JSONRPCMessage } from './base';

interface PendingRequestContext {
    expectedIds: Set<string>;
    responses: JSONRPCMessage[];
    resolve: () => void;
    done: Promise<void>;
}

function toKey(id: any): string {
    return String(id);
}

export interface HttpServerTransportOptions {
    path?: string;
    timeoutMs?: number;
}

export class HttpServerTransport extends Transport {
    private _path: string;
    private _timeoutMs: number;
    private _pendingById: Map<string, PendingRequestContext> = new Map();

    constructor(options: HttpServerTransportOptions = {}) {
        super();
        this._path = options.path || '/mcp';
        this._timeoutMs = options.timeoutMs ?? 30000;
    }

    get path(): string {
        return this._path;
    }

    routes(): Record<string, any> {
        const self = this;

        const postHandler = function (req: any) {
            return self._handlePost(req);
        };

        const getHandler = function (req: any) {
            req.response.status = 405;
            req.response.setHeader('allow', 'POST');
            req.response.write('');
        };

        const routeHandler = function (req: any) {
            const method = String(req.method || 'GET').toUpperCase();
            if (method === 'POST') return postHandler(req);
            return getHandler(req);
        };

        return {
            [this._path]: routeHandler,
        };
    }

    private async _handlePost(req: any): Promise<void> {
        let payload: any;
        try {
            payload = req.json();
        } catch (_e: any) {
            req.response.status = 400;
            req.response.json({ error: 'invalid JSON' });
            return;
        }

            const messages: JSONRPCMessage[] = Array.isArray(payload) ? payload : [payload];
            const requestIds = messages
                .map((m) => (m && Object.prototype.hasOwnProperty.call(m, 'id') ? m.id : undefined))
                .filter((id) => id !== undefined && id !== null);

            if (requestIds.length === 0) {
                for (const msg of messages) this._receive(msg);
                req.response.status = 202;
                req.response.setHeader('mcp-session-id', this.sessionId);
                req.response.write('');
                return;
            }

            let resolveDone: () => void = () => {};
            const done = new Promise<void>((resolve) => {
                resolveDone = resolve;
            });

            const ctx: PendingRequestContext = {
                expectedIds: new Set(requestIds.map((id) => toKey(id))),
                responses: [],
                resolve: resolveDone,
                done,
            };

            for (const id of requestIds) {
                this._pendingById.set(toKey(id), ctx);
            }

            try {
                for (const msg of messages) this._receive(msg);

                let timeoutId: any = null;
                const timeoutDone = new Promise<void>((resolve) => {
                    timeoutId = setTimeout(resolve, this._timeoutMs);
                });
                try {
                    await Promise.race([ctx.done, timeoutDone]);
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }

                if (ctx.responses.length < ctx.expectedIds.size) {
                    req.response.status = 504;
                    req.response.json({ error: 'mcp response timeout' });
                    return;
                }

                req.response.status = 200;
                req.response.setHeader('content-type', 'application/json');
                req.response.setHeader('mcp-session-id', this.sessionId);

                if (ctx.responses.length === 1 && !Array.isArray(payload)) {
                    req.response.json(ctx.responses[0]);
                } else {
                    req.response.json(ctx.responses);
                }
            } finally {
                for (const id of requestIds) {
                    this._pendingById.delete(toKey(id));
                }
            }
    }

    async start(): Promise<void> {
        // no-op
    }

    async send(message: JSONRPCMessage): Promise<void> {
        const id = message && (message as any).id;
        if (id === undefined || id === null) return;

        const ctx = this._pendingById.get(toKey(id));
        if (!ctx) return;

        ctx.responses.push(message);
        if (ctx.responses.length >= ctx.expectedIds.size) {
            ctx.resolve();
        }
    }

    async close(): Promise<void> {
        this._pendingById.clear();
        this._closed();
    }
}
