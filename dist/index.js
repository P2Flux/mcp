#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { tools } from './tools.js';
/**
 * P2Flux MCP server: an AI assistant's wallet for paid web content (x402, USDC on Base), with the
 * owner's limits enforced here, in code. stdio only - it runs on the owner's computer, next to the key.
 */
const config = loadConfig();
/* The key leaves the machine only by the owner's own hand, in a terminal - never through a tool an
 * assistant can call, whatever a web page tells it. */
if (process.argv[2] === 'export-key') {
    const { exportKey } = await import('./wallet.js');
    process.stdout.write(`${exportKey(config)}\n`);
    process.exit(0);
}
const server = new McpServer({ name: 'p2flux', version: '0.3.0' });
for (const [name, tool] of Object.entries(tools(config))) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.input }, (async (args) => {
        try {
            return { content: [{ type: 'text', text: await tool.run(args) }] };
        }
        catch (err) {
            // The reason, in words - never a stack, never the key.
            return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
    }));
}
await server.connect(new StdioServerTransport());
