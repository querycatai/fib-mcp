import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import coroutine from 'coroutine';
import http from 'http';

import { SseClientTransport } from '../src/sse';

const basePort = coroutine.vmid * 10000;

type CleanupFn = () => void | Promise<void>;
const cleanupStack: CleanupFn[] = [];

function trackCleanup(fn: CleanupFn): void {
  cleanupStack.push(fn);
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

async function waitFor<T>(factory: (resolve: (v: T) => void, reject: (e: any) => void) => void, timeoutMs = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    factory(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function collectMessages(url: string, count: number, timeoutMs = 1500): Promise<any[]> {
  const transport = new SseClientTransport(url, `http://127.0.0.1:1/unused-message`);
  trackCleanup(async () => {
    try { await transport.close(); } catch (_) {}
  });

  return waitFor<any[]>((resolve, reject) => {
    const out: any[] = [];
    transport.onmessage = (msg) => {
      out.push(msg);
      if (out.length >= count) resolve(out);
    };
    transport.onerror = reject;
    transport.start().catch(reject);
  }, timeoutMs);
}

describe('fib-mcp streaming-like cases', () => {
  after(async () => {
    await runCleanupStack();
  });

  describe('SSE decoding', () => {
    const port = basePort + 3920;
    let server: any = null;

    before(() => {
      server = new http.Server(port, {
        '/basic': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {"foo":true}\n\n');
        },
        '/multi-line': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {"foo":\n');
          req.response.write('data: true}\n\n');
        },
        '/invalid-json': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {bad-json}\n\n');
        },
        '/multiple-events': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {"a":1}\n\n');
          req.response.write('data: {"b":2}\n\n');
        },
        '/comments': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write(': this is comment\n');
          req.response.write('data: {"real":true}\n\n');
        },
        '/escaped-double-newline': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {"content":"my long\\n\\ncontent"}\n\n');
        },
        '/multibyte-split': (req: any) => {
          req.response.setHeader('Content-Type', 'text/event-stream');
          req.response.keepAlive = false;
          req.response.write('data: {"content":"');
          const bytes = Buffer.from('известни');
          req.response.write(Buffer.from([bytes[0]]));
          req.response.write(Buffer.from(bytes.slice(1, 4)));
          req.response.write(Buffer.from(bytes.slice(4)));
          req.response.write('"}\n\n');
        },
      });
      server.start();
      trackCleanup(() => {
        if (!server) return;
        try { server.stop(); } catch (_) {}
        server = null;
      });
      coroutine.sleep(50);
    });

    it('parses basic data-only SSE message', async () => {
      const transport = new SseClientTransport(
        `http://127.0.0.1:${port}/basic`,
        `http://127.0.0.1:${port}/unused-message`
      );
      trackCleanup(async () => {
        try { await transport.close(); } catch (_) {}
      });

      const message = await waitFor<any>((resolve, reject) => {
        transport.onmessage = resolve;
        transport.onerror = reject;
        transport.start().catch(reject);
      }, 1200);

      assert.equal(message.foo, true);
    });

    it('parses multi-line SSE data payload', async () => {
      const transport = new SseClientTransport(
        `http://127.0.0.1:${port}/multi-line`,
        `http://127.0.0.1:${port}/unused-message`
      );
      trackCleanup(async () => {
        try { await transport.close(); } catch (_) {}
      });

      const message = await waitFor<any>((resolve, reject) => {
        transport.onmessage = resolve;
        transport.onerror = reject;
        transport.start().catch(reject);
      }, 1200);

      assert.equal(message.foo, true);
    });

    it('emits parse error on invalid JSON payload', async () => {
      const transport = new SseClientTransport(
        `http://127.0.0.1:${port}/invalid-json`,
        `http://127.0.0.1:${port}/unused-message`
      );
      trackCleanup(async () => {
        try { await transport.close(); } catch (_) {}
      });

      const err = await waitFor<Error>((resolve, reject) => {
        transport.onmessage = () => reject(new Error('expected parse error, got message'));
        transport.onerror = (e) => resolve(e);
        transport.start().catch(reject);
      }, 1200);

      assert.ok(/JSON parse error/i.test(err.message));
    });

    it('parses multiple SSE messages in order', async () => {
      const msgs = await collectMessages(`http://127.0.0.1:${port}/multiple-events`, 2);
      assert.equal(msgs[0].a, 1);
      assert.equal(msgs[1].b, 2);
    });

    it('ignores SSE comments and parses real data', async () => {
      const msgs = await collectMessages(`http://127.0.0.1:${port}/comments`, 1);
      assert.equal(msgs[0].real, true);
    });

    it('parses escaped double newlines in JSON payload', async () => {
      const msgs = await collectMessages(`http://127.0.0.1:${port}/escaped-double-newline`, 1);
      assert.equal(msgs[0].content, 'my long\n\ncontent');
    });

    it('parses multibyte characters split across chunks', async () => {
      const msgs = await collectMessages(`http://127.0.0.1:${port}/multibyte-split`, 1);
      assert.equal(msgs[0].content, 'известни');
    });
  });
});
