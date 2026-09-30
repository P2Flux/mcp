# P2Flux MCP — let your AI assistant pay for web content

Some websites ask AI assistants to pay a few cents to read an article or use their data. This gives
your assistant a small wallet **on your own computer** and lets it pay those sites for you — never
more than the limits you set. P2Flux never holds your money or your key.

## Claude Desktop (no technical knowledge needed)

1. Download `p2flux.mcpb` and double-click it. Claude Desktop asks you to install it.
2. In the form, leave **Money** on `test` the first time, and set your limits
   (default: 0.50 USDC per page, 5 USDC per day).
3. Ask Claude: **"Set up my P2Flux wallet."** Claude shows the wallet's address and how to add money.
   - Test: free test money from https://faucet.circle.com (choose *Base Sepolia*).
   - Real money: in the Coinbase app choose *Send → USDC → Base network* and paste the address.
     Send a small amount. Treat it like cash in a pocket.
4. Use it: *"Find articles about soup recipes I can buy"*, *"Read this page: https://…"*,
   *"How much have I spent?"*

If the computer is lost, the wallet on it is lost. Keep small amounts.

## Claude Code, Cursor and other MCP clients

```bash
claude mcp add p2flux -e P2FLUX_NETWORK=test -- npx -y @p2flux/mcp
```

| Variable | Default | Meaning |
|---|---|---|
| `P2FLUX_NETWORK` | `test` | `test` = Base Sepolia, `live` = Base with real USDC |
| `P2FLUX_MAX_PER_PAYMENT` | `0.50` | most for one page |
| `P2FLUX_MAX_PER_DAY` | `5` | most in 24 hours |
| `P2FLUX_MAX_PREPAID` | `1` | most to put aside at one site; `0` = pay every page on its own |
| `P2FLUX_MCP_DIR` | `~/.p2flux-mcp` | where the wallet and the spending log are kept |

## What it does, and does not

- Pays pages that ask with HTTP 402 (the x402 standard) in USDC on Base. Nothing else.
- Checks the price against your limits **before** signing, and signs exactly that price. A site that
  changes the price between the check and the payment gets nothing.
- Keeps a spending log on your computer; the daily limit survives restarts.
- Money put aside at a site and not used comes back when you ask (*"take my unused balance at that
  site back"*), and on its own after a week without use when it is 0.50 USDC or more.
- The key is in one file only you can read. It is never sent anywhere and is shown only if you ask
  Claude to export it, with an exact confirmation sentence.
- ChatGPT and the claude.ai website cannot run a program on your computer. For them there is the
  remote server below: no wallet is kept anywhere; you approve each payment in your own browser wallet.

## Development

```bash
npm install && npm test          # unit tests
npm run build
node test/live.mjs               # live on Base Sepolia (see the file)
npx @anthropic-ai/mcpb pack . p2flux.mcpb
```

## ChatGPT and claude.ai (remote server)

`p2flux-mcp-remote` is the same idea for assistants that only connect to servers on the internet. It
holds **no wallet, no balance and no history**, and needs no login. Tools: `find_paid_content`,
`check_price`, `request_paid_page`, `get_paid_page`.

1. The assistant asks for a paid page. It gets a link, and shows it to you.
2. You open the link. The page shows the amount, the page and the seller's address. You approve in
   your own wallet (Coinbase Wallet, MetaMask…): one signature for exactly that amount, no network fee.
3. The page is paid and fetched at once; the assistant reads it.

Only sites paid through P2Flux can be paid, only in USDC on Base, and never more than
`P2FLUX_REMOTE_MAX_PRICE` (default 5 USDC). The server reads only public https websites.

```bash
P2FLUX_PUBLIC_URL=https://agent.example.com P2FLUX_NETWORK=test PORT=8787 npx -p @p2flux/mcp p2flux-mcp-remote
```

Put it behind https (nginx) with `P2FLUX_TRUST_PROXY=1`, then add `https://agent.example.com/mcp` as a
custom connector in claude.ai or ChatGPT (developer mode), authentication: none.

Limits today: a browser wallet extension is needed (no WalletConnect / phone wallets yet); one
approval per page (no prepaid balance).
