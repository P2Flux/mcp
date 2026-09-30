/**
 * The approval page: the person sees what will be paid, to whom, and signs it in their own browser
 * wallet. The page only ever asks the wallet for one thing - a USDC transfer authorization
 * (EIP-3009) of exactly the shown amount to the shown seller address. No key and no money pass
 * through P2Flux. Everything from the site is put on the page as text, never as HTML.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve a payment - P2Flux</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#14171f}
main{max-width:30rem;margin:8vh auto;background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 1rem}
dl{margin:0 0 1.5rem}dt{font-size:.8rem;color:#5b6472;margin-top:.75rem}dd{margin:0;word-break:break-all}
#amount{font-size:1.75rem;font-weight:700}
button{font:inherit;font-weight:600;width:100%;padding:.85rem;border:0;border-radius:8px;background:#1652f0;color:#fff;cursor:pointer}
button:disabled{background:#9aa3b2;cursor:default}
#status{margin-top:1rem;min-height:1.5rem}.ok{color:#0a7d33}.err{color:#b3261e}
small{display:block;margin-top:1.25rem;color:#5b6472}
</style></head><body><main>
<h1>Your assistant asks to pay for a page</h1>
<dl>
<dt>Amount</dt><dd id="amount">…</dd>
<dt>Page</dt><dd id="url">…</dd>
<dt>Paid to (seller's P2Flux address)</dt><dd id="payto">…</dd>
<dt>Network</dt><dd id="network">…</dd>
</dl>
<button id="approve" disabled>Connect wallet and approve</button>
<div id="status" role="status" aria-live="polite"></div>
<small>You sign one USDC transfer of exactly this amount in your own wallet. It costs no network fee. P2Flux never holds your money or your key. If you did not ask an assistant for this page, close this window.</small>
</main><script src="/approve.js"></script></body></html>`

export const PAGE_JS = `(async () => {
  const id = location.pathname.split('/').pop()
  const $ = (x) => document.getElementById(x)
  const say = (text, cls) => { $('status').textContent = text; $('status').className = cls || '' }
  let d
  try {
    const r = await fetch('/approve/' + id + '/data')
    if (!r.ok) throw new Error((await r.json()).error || 'not found')
    d = await r.json()
  } catch (e) { return say('This request is no longer open: ' + e.message, 'err') }
  $('amount').textContent = d.price + ' USDC'
  $('url').textContent = d.url
  $('payto').textContent = d.payTo
  $('network').textContent = d.networkLabel
  if (d.state !== 'waiting') return say(d.state === 'paid' ? 'Already paid. Go back to your assistant.' : 'This request is closed.', d.state === 'paid' ? 'ok' : 'err')
  const button = $('approve')
  if (!window.ethereum) return say('No wallet found in this browser. Install a wallet extension (Coinbase Wallet, MetaMask) and reload.', 'err')
  button.disabled = false
  button.onclick = async () => {
    button.disabled = true
    try {
      say('Waiting for your wallet…')
      const [from] = await ethereum.request({ method: 'eth_requestAccounts' })
      const chainHex = '0x' + d.chainId.toString(16)
      if ((await ethereum.request({ method: 'eth_chainId' })) !== chainHex) {
        await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] })
      }
      const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
      const authorization = { from, to: d.payTo, value: d.units, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + d.timeout), nonce }
      const typed = {
        types: {
          EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
          TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
        },
        primaryType: 'TransferWithAuthorization',
        domain: { name: d.tokenName, version: d.tokenVersion, chainId: d.chainId, verifyingContract: d.asset },
        message: authorization,
      }
      const signature = await ethereum.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] })
      say('Paying…')
      const r = await fetch('/approve/' + id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature, authorization }) })
      const out = await r.json()
      if (!r.ok) throw new Error(out.error || 'the payment was not accepted')
      say('Paid. Go back to your assistant - it has the page now.', 'ok')
    } catch (e) {
      say((e && e.message) || 'Cancelled.', 'err')
      button.disabled = false
    }
  }
})()`
