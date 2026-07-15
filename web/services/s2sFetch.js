// Outbound S2S fetch: when mTLS enforcement is on (admin SSO card), calls
// present the Cloudflare-issued client certificate at the edge; otherwise this
// is plain fetch. Trust is the edge's job — we only present, never verify
// peers beyond normal TLS. The agent is rebuilt when the cert changes (renew)
// and torn down when enforcement goes off.
const { Agent, fetch: undiciFetch } = require('undici');
const { outboundIdentity } = require('./mtlsService');

let cached = null; // { agent, sig }

async function s2sFetch(url, init) {
  const id = await outboundIdentity();
  if (!id) {
    if (cached) {
      cached.agent.close().catch(() => {});
      cached = null;
    }
    return fetch(url, init);
  }
  if (!cached || cached.sig !== id.cert) {
    if (cached) cached.agent.close().catch(() => {});
    cached = { agent: new Agent({ connect: { cert: id.cert, key: id.key } }), sig: id.cert };
  }
  return undiciFetch(url, { ...init, dispatcher: cached.agent });
}

module.exports = { s2sFetch };
