/**
 * Child process for stdio bidirectional session test.
 * This process runs a BidirectionalSession in server mode (accepting stdio from parent).
 */
import { BidirectionalSession } from '../../index';

async function main() {
    const session = new BidirectionalSession({
        serverInfo: { name: 'stdio-child-server', version: '1.0.0' },
        clientInfo: { name: 'stdio-child-client', version: '1.0.0' },
    });

    // Register a tool that child can call
    session.tool('child.echo', {}, async () => ({
        content: [{ type: 'text', text: 'echo-from-child' }],
    }));

    // Register a tool that proxies to parent
    session.tool('child.proxy', {}, async (_args: any, ctx: any) => {
        try {
            const result = await ctx.client.callTool({ name: 'parent.greet', arguments: {} });
            return {
                content: [{ type: 'text', text: `child-got:${result.content[0].text}` }],
            };
        } catch (error: any) {
            return {
                content: [{ type: 'text', text: `child-error:${String(error?.message || error)}` }],
            };
        }
    });

    // Connect to parent via stdio
    try {
        await session.listenStdio();
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
