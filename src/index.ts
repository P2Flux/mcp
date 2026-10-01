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

/* The key leaves the machine only by the owner's own hand, in a terminal - never through a tool an
 * assistant can call, whatever a web page tells it. */
if (process.argv[2] === 'export-key') {
  const { exportKey } = await import('./wallet.js')
  process.stdout.write(`${exportKey(config)}\n`)
  process.exit(0)
}

const server = new McpServer({ name: 'p2flux', version: '0.3.0' })

/* Above the budget the person is asked in their own app (MCP elicitation) - a dialog the assistant
 * cannot answer for them. An app that cannot show one gets null: the payment is refused, as before. */
const ask = async (message: string): Promise<boolean | null> => {
  if (!server.server.getClientCapabilities()?.elicitation) return null
  const r = await server.server.elicitInput({
    message,
    requestedSchema: { type: 'object', properties: { pay: { type: 'boolean', title: 'Pay this amount', default: false } }, required: ['pay'] },
  })
  return r.action === 'accept' && (r.content as { pay?: unknown } | undefined)?.pay === true
}

for (const [name, tool] of Object.entries(tools(config, fetch, ask))) {
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
