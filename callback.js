import { client, fail, GW_ID, SITE } from './_lib.js';

// Paytm sends the CUSTOMER'S BROWSER here (form POST) after payment.
// We never trust this data: we only verify the checksum, wake the worker (which asks /api/status itself), and send the customer back.
export default async function handler(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const m = GW_ID.exec(String(body.ORDERID || body.orderId || ''));
  if (!m) return res.redirect(303, SITE());
  const shopId = m[1];
  try {
    const raw = new URLSearchParams(body).toString();
    client().verifyWebhook(raw, body.CHECKSUMHASH || '');   // result is informational only
  } catch (e) { console.warn('callback checksum check failed', e && e.message); }
  try {   // GET /api/orders/:id makes the worker confirm the payment with /api/status
    await fetch(`${SITE()}/api/orders/${shopId}`, { signal: AbortSignal.timeout(8000) });
  } catch {}
  return res.redirect(303, `${SITE()}/#order=${shopId}`);
}
