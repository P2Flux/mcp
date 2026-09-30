# Paid test page (test money only)

`https://agent-test.p2flux.com/demo/fish-soup` - people read it free, AI agents pay 0.05 test USDC
(x402, Base Sepolia, settled by api-test). For trying the remote MCP server from claude.ai or ChatGPT.

On the test box: `/opt/p2flux-demo/` = `server.mjs` + `paywall.js` (from p2flux_sdk_js `dist/`),
unit `p2flux-demo.service`, `RECIPIENT=<seller wallet>` in `/etc/p2flux-demo.env`, nginx
`location /demo/` -> 127.0.0.1:8788 in the agent-test vhost. No keys, no state.
