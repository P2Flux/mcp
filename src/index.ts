#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { tools } from './tools.js'

/**
 * P2Flux MCP server: an AI assistant's wallet for paid web content (x402, USDC on Base), with the
 * owner's limits enforced here, in code. stdio only - it runs on the owner's computer, next to the key.
 */
const config = loadConfig()
const server = new McpServer({ name: 'p2flux', version: '0.2.0' })

for (const [name, tool] of Object.entries(tools(config))) {
  server.registerTool(name, { description: tool.description, inputSchema: tool.input }, (async (args: Record<string, unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: await (tool.run as (a: never) => Promise<string>)(args as never) }] }
    } catch (err) {
      // The reason, in words - never a stack, never the key.
      return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }
    }
  }) as never)
}

await server.connect(new StdioServerTransport())
