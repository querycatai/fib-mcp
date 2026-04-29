import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import coroutine from 'coroutine';
import http from 'http';

import { McpServer } from '../index';
import { createSessionId } from '../src/base';
import { WebSocketServerTransport } from '../src/ws';

const basePort = coroutine.vmid * 10000;

type CleanupFn = () => void | Promise<void>;
const cleanupStack: CleanupFn[] = [];

function trackCleanup(fn: CleanupFn): void {
  cleanupStack.push(fn);
}

async function withDedicatedHttpServer<T>(
  port: number,
  configure: (server: any) => void,
  run: () => Promise<T>,
  timeoutMs = 500,
): Promise<T> {
  const server = new McpServer({ name: `http-temp-${port}`, version: '1.0.0' });
  const httpServer = new http.Server(port, { '/mcp': server.httpHandler({ timeoutMs }) });

  try {
    configure(server);
    httpServer.start();
    coroutine.sleep(50);
    return await run();
  } finally {
    try { await server.close(); } catch (_) {}
    try { httpServer.stop(); } catch (_) {}
  }
}

async function runCleanupStack(): Promise<void> {
  while (cleanupStack.length > 0) {
    const fn = cleanupStack.pop();
    if (!fn) continue;
    try {
      await fn();
    } catch (_) {}
  }
}

describe('fib-mcp edge cases', () => {
  after(async () => {
    await runCleanupStack();
  });

  describe('session id generation', () => {
    it('creates unique session ids under high-frequency generation', () => {
      const generated = new Set<string>();

      for (let index = 0; index < 10000; index += 1) {
        const sessionId = createSessionId();
        assert.ok(sessionId.startsWith('mcp-'));
        assert.equal(generated.has(sessionId), false);
        generated.add(sessionId);
      }

      assert.equal(generated.size, 10000);
    });
  });

  describe('http transport edge cases', () => {
    const port = basePort + 3910;
    let server: any = null;
    let httpServer: any = null;

    before(() => {
      server = new McpServer({ name: 'http-edge-server', version: '1.0.0' });
      trackCleanup(async () => {
        if (!server) return;
        try { await server.close(); } catch (_) {}
        server = null;
      });

      server.tool('ok', {}, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));

      // Intentionally never resolves to exercise transport timeout behavior.
      server.tool('hang', {}, async () => {
        await new Promise<void>(() => {});
        return { content: [{ type: 'text', text: 'never' }] };
      });

      httpServer = new http.Server(port, { '/mcp': server.httpHandler({ timeoutMs: 500 }) });
      httpServer.start();
      trackCleanup(() => {
        if (!httpServer) return;
        try { httpServer.stop(); } catch (_) {}
        httpServer = null;
      });

      coroutine.sleep(50);
    });

    it('returns 400 on invalid JSON body', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad-json',
      });

      assert.equal(resp.status, 400);
      const data = await resp.json();
      assert.equal(data.error, 'invalid JSON');
    });

    it('returns 202 for notifications (no id)', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });

      assert.equal(resp.status, 202);
    });

    it('returns 504 when request handler times out', async () => {
      const started = Date.now();

      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1001,
          method: 'tools/call',
          params: { name: 'hang', arguments: {} },
        }),
      });

      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 400, `expected >=400ms, got ${elapsed}ms`);
      assert.equal(resp.status, 504);
      const data = await resp.json();
      assert.equal(data.error, 'mcp response timeout');
    });

    it('returns JSON array for batch requests', async () => {
      await withDedicatedHttpServer(port + 20, () => {}, async () => {
        const resp = await fetch(`http://127.0.0.1:${port + 20}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          ]),
        });

        assert.equal(resp.status, 200);
        const data = await resp.json();
        assert.ok(Array.isArray(data));
        assert.equal(data.length, 2);
        assert.equal(data[0].id, 1);
        assert.equal(data[1].id, 2);
      });
    });

    it('supports mixed batch with request and notification', async () => {
      await withDedicatedHttpServer(port + 21, () => {}, async () => {
        const resp = await fetch(`http://127.0.0.1:${port + 21}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
          ]),
        });

        assert.equal(resp.status, 200);
        const data = await resp.json();
        assert.ok(Array.isArray(data));
        assert.equal(data.length, 1);
        assert.equal(data[0].id, 11);
      });
    });

    it('can recover after timeout and handle next request', async () => {
      const timeoutResp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2001,
          method: 'tools/call',
          params: { name: 'hang', arguments: {} },
        }),
      });

      assert.equal(timeoutResp.status, 504);

      const okResp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2002,
          method: 'tools/call',
          params: { name: 'ok', arguments: {} },
        }),
      });

      assert.equal(okResp.status, 200);
      const data = await okResp.json();
      assert.equal(data.id, 2002);
      const text = data?.result?.content?.[0]?.text;
      assert.equal(text, 'ok');
    });
  });

  describe('sse transport edge cases', () => {
    const port = basePort + 3911;
    let server: any = null;
    let httpServer: any = null;

    before(() => {
      server = new McpServer({ name: 'sse-edge-server', version: '1.0.0' });
      trackCleanup(async () => {
        if (!server) return;
        try { await server.close(); } catch (_) {}
        server = null;
      });

      server.tool('status', {}, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));

      httpServer = new http.Server(port, { '/mcp': server.sseHandlers() });
      httpServer.start();
      trackCleanup(() => {
        if (!httpServer) return;
        try { httpServer.stop(); } catch (_) {}
        httpServer = null;
      });

      coroutine.sleep(50);
    });

    it('returns 400 when sse message endpoint gets invalid JSON', async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/mcp/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid',
      });

      assert.equal(resp.status, 400);
      const data = await resp.json();
      assert.equal(data.error, 'invalid JSON');
    });
  });

  describe('ws transport edge cases', () => {
    const port = basePort + 3912;
    let httpServer: any = null;
    let transport: WebSocketServerTransport | null = null;

    before(() => {
      transport = new WebSocketServerTransport();
      const routes: Record<string, any> = {
        '/mcp': transport.handler(),
      };
      const http = require('http');
      httpServer = new http.Server(port, routes);
      trackCleanup(() => {
        if (!httpServer) return;
        try { httpServer.stop(); } catch (_) {}
        httpServer = null;
      });
      trackCleanup(async () => {
        if (!transport) return;
        try { await transport.close(); } catch (_) {}
        transport = null;
      });
      httpServer.start();
      coroutine.sleep(50);
    });

    it('emits error on malformed ws JSON payload', async () => {
      let gotError = false;
      if (!transport) throw new Error('transport not initialized');

      transport.onerror = () => {
        gotError = true;
      };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
      trackCleanup(() => {
        try { ws.close(); } catch (_) {}
      });

      await new Promise<void>((resolve) => {
        ws.onopen = function () {
          ws.send('{bad-json');
          setTimeout(() => resolve(), 80);
        };
      });

      assert.equal(gotError, true);
    });

    it('accepts the default MCP websocket subprotocol', async () => {
      let opened = false;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`, 'mcp');
      trackCleanup(() => {
        try { ws.close(); } catch (_) {}
      });

      await new Promise<void>((resolve, reject) => {
        ws.onopen = function () {
          opened = true;
          resolve();
        };

        ws.onerror = function (err: any) {
          reject(err instanceof Error ? err : new Error(String(err)));
        };
      });

      assert.equal(opened, true);
    });
  });
});
