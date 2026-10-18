import { client, authed, fail, GW_ID } from './_lib.js';

// Called by the Cloudflare worker. Returns SUCCESS only if Paytm says paid for EXACTLY the expected amount.
export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  if (!authed(req)) return fail(res, 401, 'Bad bridge key');
  try {
    const { orderId, amount } = req.body || {};
    if (!GW_ID.test(String(orderId || ''))) return fail(res, 400, 'Bad order id');
    const expected = Math.round(Number(amount) * 100);
    if (!Number.isFinite(expected) || expected < 100) return fail(res, 400, 'Bad amount');
    const s = await client().checkStatus(orderId, { expectedAmount: expected, maxRetries: 2 });
    return res.status(200).json({ ok: true, status: s.status, amount: s.amount, transactionId: s.transactionId || '' });
  } catch (e) {
    // amount mismatch or network error -> not paid as far as we know
    return res.status(200).json({ ok: false, status: 'UNKNOWN', error: String((e && e.message) || e).slice(0, 160) });
  }
}
