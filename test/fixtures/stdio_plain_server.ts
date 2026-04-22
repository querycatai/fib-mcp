/**
 * Plain MCP server over stdio (not bidirectional session).
 * Used to test backward compatibility with normal MCP clients.
 */
import { McpServer } from '../../index';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
    const server = new McpServer({ name: 'stdio-plain-server', version: '1.0.0' });

    server.tool('server.ping', {}, async () => ({
        content: [{ type: 'text', text: 'pong-from-stdio-server' }],
    }));

    try {
        const stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);
    } catch (error: any) {
        const msg = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`stdio error: ${msg}\n`);
        process.exit(1);
    }
}

main().catch((e) => {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(msg + '\n');
    process.exit(1);
});
