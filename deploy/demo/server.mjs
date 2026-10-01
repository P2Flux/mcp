// A paid test page for trying P2Flux with an AI assistant. People read it free; AI agents are asked
// to pay 0.05 USDC (x402). API_URL picks the network: api-test (Base Sepolia, test money, default)
// or api.p2flux.com (Base, real USDC).
import { createServer } from 'node:http'
import { createPaywall } from './paywall.js'

const PORT = Number(process.env.PORT) || 8788
const BASE = process.env.PUBLIC_URL || 'https://agent-test.p2flux.com'
const API = process.env.API_URL || 'https://api-test.p2flux.com'
const LIVE = API === 'https://api.p2flux.com'
const paywall = createPaywall({ apiUrl: API, recipient: process.env.RECIPIENT, price: '0.05', agentsOnly: true, prepaid: false })

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:40rem;margin:6vh auto;padding:0 1rem;color:#14171f}small{color:#5b6472}</style></head>
<body><h1>${title}</h1>${body}<p><small>${LIVE ? 'A P2Flux demo page on Base. AI agents pay 0.05 USDC (real money) to read it; people read it free.' : 'A P2Flux test page on Base Sepolia. AI agents pay 0.05 test USDC to read it; nothing here is real money.'}</small></p></body></html>`

const ARTICLES = {
  '/demo/': ['P2Flux test page', `<p>This is a free index. Paid page: <a href="${BASE}/demo/fish-soup">Fish soup with saffron</a>.</p>`],
  '/demo/fish-soup': ['Fish soup with saffron', '<p>Serves four. Soften a leek and a fennel bulb in olive oil, add a pinch of saffron, a litre of fish stock and 400 g of potatoes in cubes. Simmer 15 minutes, add 600 g of firm white fish in pieces and cook 5 minutes more. The test phrase for this page is <strong>SAFFRON-HARBOUR-42</strong>.</p>'],
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', BASE).pathname
  const article = ARTICLES[path]
  if (req.method !== 'GET' || !article) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  if (path !== '/demo/') {
    const one = (v) => (Array.isArray(v) ? v[0] : v)
    const result = await paywall.guard({ url: BASE + path, paymentHeader: one(req.headers['payment-signature']) ?? one(req.headers['x-payment']) ?? null, userAgent: one(req.headers['user-agent']), signatureAgent: one(req.headers['signature-agent']), mimeType: 'text/html' }).catch(() => null)
    if (!result) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end('{"error":"payment_service_unavailable"}')
    }
    if (!result.allow) {
      res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers })
      return res.end(JSON.stringify(result.body))
    }
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(page(...article))
}).listen(PORT, '127.0.0.1')
