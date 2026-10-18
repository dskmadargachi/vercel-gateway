// Shared helpers (files starting with "_" are not exposed as URLs by Vercel).
import { UPIPay } from 'upipay';
import { timingSafeEqual } from 'node:crypto';

export const SITE = () => (process.env.SITE_URL || 'https://therajesh.shop').replace(/\/+$/, '');

export function client() {
  const { PAYTM_MERCHANT_ID, PAYTM_MERCHANT_KEY } = process.env;
  if (!PAYTM_MERCHANT_ID || !PAYTM_MERCHANT_KEY) throw new Error('PAYTM_MERCHANT_ID / PAYTM_MERCHANT_KEY are not set in Vercel');
  return new UPIPay({
    provider: 'paytm',
    environment: process.env.PAYTM_ENV === 'sandbox' ? 'sandbox' : 'production',
    credentials: { merchantId: PAYTM_MERCHANT_ID, merchantKey: PAYTM_MERCHANT_KEY },
  });
}

// Only your Cloudflare worker may call create/status: it sends the shared BRIDGE_KEY.
export function authed(req) {
  const a = Buffer.from(String(req.headers['x-bridge-key'] || ''));
  const b = Buffer.from(String(process.env.BRIDGE_KEY || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// Our gateway order id: RJ + 6-char shop order id + T + attempt suffix
export const GW_ID = /^RJ([A-Z0-9]{6})T[A-Z0-9]{1,12}$/;

export function fail(res, code, error) { return res.status(code).json({ ok: false, error }); }
