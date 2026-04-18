import { McpServer } from '../../index';

async function main() {
    const server = new McpServer({ name: 'stdio-server', version: '1.0.0' });

    server.tool('ping', {}, async () => ({
        content: [{ type: 'text', text: 'pong-stdio' }],
    }));

    await server.listenStdio();
}

main().catch((e) => {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    process.stderr.write(msg + '\n');
    process.exit(1);
});
