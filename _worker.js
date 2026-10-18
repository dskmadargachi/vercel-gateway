// Cloudflare Pages "advanced mode" worker (_worker.js) — works with drag-and-drop upload.
// Bindings to add in the dashboard:  DB (D1 database)  and  FILES (KV namespace)
// Secrets/variables:  ADMIN_PIN, AGENT_KEY, PAY_GATEWAY_URL + BRIDGE_KEY (UPIPay on Vercel), optional SHOP_NAME, UPI_VPA, UPI_NAME

// ---- DEFAULT PRICES (rupees) — the counter's 💰 Prices button overrides these (saved in the database) ----
const RATE = { bw: 5, color: 10 };          // A4 per page
const A3_MULTIPLIER = 2;                    // A3 page = A4 price x 2
const PHOTO_4X6 = 20;                       // one 4x6 photo print
const PASSPORT_SHEET = { '4x6': 30, A4: 50 }; // one sheet of passport photos
const PAPERS = ['A4', 'A3', '4x6'];
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // KV value limit is 25 MB
const ALLOWED = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
const FILE_TTL = 2 * 60 * 60; // safety: KV auto-deletes files after 2 hours even if never printed

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });


// ---------- price control ----------
const PRICE_KEYS = { bw: 'B&W per page', color: 'Color per page', a3: 'A3 multiplier', photo4x6: '4x6 photo print', passport4x6: 'Passport sheet 4x6', passportA4: 'Passport sheet A4' };
async function getPrices(env) {
  const d = { bw: RATE.bw, color: RATE.color, a3: A3_MULTIPLIER, photo4x6: PHOTO_4X6, passport4x6: PASSPORT_SHEET['4x6'], passportA4: PASSPORT_SHEET.A4 };
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k='prices'").first();
    if (row && row.v) { const s = JSON.parse(row.v); for (const k of Object.keys(d)) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) d[k] = Number(s[k]); }
  } catch {}
  return d;
}
async function savePrices(request, env) {
  await ensureSchema(env);
  const b = await request.json().catch(() => ({}));
  const cur = await getPrices(env), out = {};
  for (const k of Object.keys(PRICE_KEYS)) {
    const n = Number(b[k] !== undefined ? b[k] : cur[k]);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return json({ error: 'Invalid price for ' + PRICE_KEYS[k] }, 400);
    out[k] = Math.round(n * 100) / 100;
  }
  if (out.a3 < 1) return json({ error: 'A3 multiplier must be 1 or more' }, 400);
  await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('prices',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(out)).run();
  return json({ ok: true, prices: out });
}

const ext = (name) => (name.split('.').pop() || '').toLowerCase();
const safeName = (name) => name.replace(/[^\w.\-]+/g, '_').slice(0, 80);

function newId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const path = url.pathname.slice(5).replace(/\/+$/, '');
    const method = request.method;
    let m;
    try {
      if (!env.DB || !env.FILES) {
        return json({ error: 'Setup incomplete: add bindings DB (D1) and FILES (KV), then redeploy.' }, 500);
      }
      if (path === 'config' && method === 'GET') {
        const p = await getPrices(env);
        return json({ shop: env.SHOP_NAME || 'Digital Seva Kendra', rate: { bw: p.bw, color: p.color }, a3: p.a3, photo4x6: p.photo4x6, passport: { '4x6': p.passport4x6, A4: p.passportA4 } });
      }
      if (path === 'orders' && method === 'POST') return createOrder(request, env);
      m = path.match(/^orders\/([A-Z0-9]+)\/pay$/);
      if (m && method === 'POST') return createPayment(request, env, m[1]);

      m = path.match(/^orders\/([A-Z0-9]+)$/);
      if (m && method === 'GET') return orderStatus(env, m[1]);

      if (path.startsWith('admin/')) {
        if (!clean(env.ADMIN_PIN)) return json({ error: 'ADMIN_PIN is not set in Cloudflare (Settings > Variables and Secrets), then redeploy.' }, 500);
        const role = roleOf(request, env);
        if (!role) return json({ error: 'Wrong PIN' }, 401);
        if (path === 'admin/orders' && method === 'GET') return adminList(env);
        if (path === 'admin/ping') return json({ ok: true, role });
        if (path === 'admin/prices' && method === 'GET') return json({ prices: await getPrices(env), labels: PRICE_KEYS });
        if (path === 'admin/prices' && method === 'POST') return savePrices(request, env);
        if (path === 'admin/clear' && method === 'POST') return adminClear(env);
        m = path.match(/^admin\/(start|done)\/([A-Z0-9]+)$/);
        if (m && method === 'POST') return adminMark(request, env, m[2], m[1]);
        m = path.match(/^admin\/(approve|reject)\/([A-Z0-9]+)$/);
        if (m && method === 'POST') return adminDecide(env, m[2], m[1]);
        m = path.match(/^admin\/file\/(\d+)$/);
        if (m && method === 'GET') return serveFile(env, m[1]);
      }

      if (path.startsWith('agent/')) {
        if (!sameSecret(request.headers.get('x-agent-key'), env.AGENT_KEY)) return json({ error: 'Bad agent key' }, 401);
        if (path === 'agent/jobs' && method === 'GET') return agentJobs(env);
        m = path.match(/^agent\/(claim|done|fail)\/([A-Z0-9]+)$/);
        if (m && method === 'POST') return agentUpdate(request, env, m[2], m[1]);
        m = path.match(/^agent\/file\/(\d+)$/);
        if (m && method === 'GET') return serveFile(env, m[1]);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String((e && e.message) || e) }, 500);
    }
  },
};

// One login: ADMIN_PIN (set it in Cloudflare > Settings > Variables and Secrets).
// Compared as trimmed text, so a trailing space/newline or a number-type variable in Cloudflare can't break the login.
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
function sameSecret(a, b) {
  a = clean(a); b = clean(b);
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function roleOf(request, env) {
  let pin = request.headers.get('x-admin-pin') || '';
  try { pin = decodeURIComponent(pin); } catch {}
  return sameSecret(pin, env.ADMIN_PIN) ? 'admin' : null;
}

// Adds the new columns automatically the first time (no manual SQL needed).
let schemaChecked = false;
async function ensureSchema(env) {
  if (schemaChecked) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)').run();
  const { results } = await env.DB.prepare('PRAGMA table_info(orders)').all();
  const have = new Set(results.map((r) => r.name));
  if (!have.has('paper')) await env.DB.prepare("ALTER TABLE orders ADD COLUMN paper TEXT DEFAULT 'A4'").run();
  if (!have.has('opts')) await env.DB.prepare('ALTER TABLE orders ADD COLUMN opts TEXT').run();
  if (!have.has('pay_url')) await env.DB.prepare('ALTER TABLE orders ADD COLUMN pay_url TEXT').run();
  if (!have.has('pay_status')) await env.DB.prepare('ALTER TABLE orders ADD COLUMN pay_status TEXT').run();
  if (!have.has('pay_intent')) await env.DB.prepare('ALTER TABLE orders ADD COLUMN pay_intent TEXT').run();
  if (!have.has('pay_utr')) await env.DB.prepare('ALTER TABLE orders ADD COLUMN pay_utr TEXT').run();
  schemaChecked = true;
}

async function createOrder(request, env) {
  await ensureSchema(env);
  const form = await request.formData();
  let meta;
  try { meta = JSON.parse(form.get('meta') || '{}'); } catch { return json({ error: 'Bad request' }, 400); }
  const files = form.getAll('files').filter((f) => typeof f !== 'string');
  if (!files.length) return json({ error: 'No files' }, 400);
  if (files.length > MAX_FILES) return json({ error: `Max ${MAX_FILES} files` }, 400);

  const kind = meta.kind === 'passport' ? 'passport' : 'doc';
  const paper = PAPERS.includes(meta.paper) ? meta.paper : 'A4';
  const color = (meta.color || paper === '4x6' || kind === 'passport') ? 1 : 0;
  const copies = Math.min(Math.max(parseInt(meta.copies) || 1, 1), kind === 'passport' ? 20 : 100);
  const orient = (Array.isArray(meta.orient) ? meta.orient : []).map((o) => (o === 'landscape' ? 'landscape' : 'portrait'));
  const info = String(meta.info || '').slice(0, 160);
  const pagesList = Array.isArray(meta.pages) ? meta.pages : [];
  const id = newId();
  const now = Date.now();

  const rows = [];
  let totalPages = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!ALLOWED.includes(ext(f.name))) return json({ error: `File type not allowed: ${f.name}` }, 400);
    if (f.size > MAX_FILE_BYTES) return json({ error: `${f.name} is larger than 25 MB` }, 400);
    const pages = Math.min(Math.max(parseInt(pagesList[i]) || 1, 1), 2000);
    totalPages += pages;
    const key = `${id}/${i}-${safeName(f.name)}`;
    await env.FILES.put(key, await f.arrayBuffer(), {
      expirationTtl: FILE_TTL,
      metadata: { type: f.type || 'application/octet-stream' },
    });
    rows.push({ name: f.name.slice(0, 120), key, pages });
  }

  const P = await getPrices(env);
  let amount;
  if (kind === 'passport') amount = copies * (paper === '4x6' ? P.passport4x6 : P.passportA4);
  else if (paper === '4x6') amount = totalPages * copies * P.photo4x6;
  else amount = totalPages * copies * (color ? P.color : P.bw) * (paper === 'A3' ? P.a3 : 1);
  amount = Math.round(amount * 100) / 100;
  // AUTO_APPROVE = "1" (variable in Cloudflare) -> print immediately, no counter approval
  const startStatus = env.AUTO_APPROVE === '1' ? 'approved' : 'pending';
  // housekeeping: forget orders older than 1 day
  await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE order_id IN (SELECT id FROM orders WHERE created_at < ?)').bind(now - 86400000),
    env.DB.prepare('DELETE FROM orders WHERE created_at < ?').bind(now - 86400000),
  ]);
  const stmts = [
    env.DB.prepare('INSERT INTO orders (id,name,phone,color,copies,amount,status,created_at,paper,opts) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, String(meta.name || '').slice(0, 60), String(meta.phone || '').slice(0, 15), color, copies, amount, startStatus, now,
        paper, JSON.stringify({ kind, orient, info })),
    ...rows.map((r) =>
      env.DB.prepare('INSERT INTO files (order_id,name,r2_key,pages) VALUES (?,?,?,?)').bind(id, r.name, r.key, r.pages)
    ),
  ];
  await env.DB.batch(stmts);
  return json({ id, amount, status: startStatus });
}

async function orderStatus(env, id) {
  await ensureSchema(env);
  let o = await env.DB.prepare('SELECT id,status,amount,copies,color,note,pay_status,pay_url FROM orders WHERE id=?').bind(id).first();
  if (!o) return json({ error: 'Order not found' }, 404);
  if (o.status === 'pending' && o.pay_url && o.pay_status !== 'paid') {   // customer is waiting: ask SmartUPI if the money arrived
    await verifyPayment(env, id);
    o = await env.DB.prepare('SELECT id,status,amount,copies,color,note,pay_status,pay_url FROM orders WHERE id=?').bind(id).first();
  }
  return json({ id: o.id, status: o.status, amount: o.amount, copies: o.copies, color: o.color, note: o.note, pay_status: o.pay_status || '', paying: !!o.pay_url });
}

// ---------------- Payments: UPIPay gateway on Vercel (Paytm Business) ----------------
// Cloudflare variables: PAY_GATEWAY_URL (https://xxxx.vercel.app) and BRIDGE_KEY (same text as in Vercel).
// Without them the site falls back to a direct UPI QR and the counter approves orders by hand.
const PAY_PREFIX = 'RJ';   // gateway order id = RJ + our 6-char id + T + attempt suffix
const gwOn = (env) => !!clean(env.PAY_GATEWAY_URL) && !!clean(env.BRIDGE_KEY);

async function gateway(env, path, body) {
  try {
    const r = await fetch(clean(env.PAY_GATEWAY_URL).replace(/\/+$/, '') + '/api/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-key': clean(env.BRIDGE_KEY) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: 'Bad response from payment gateway (HTTP ' + r.status + ')' }; }
  } catch (e) { return { ok: false, error: 'Payment gateway is not reachable' }; }
}

// Customer opens the pay screen: ask the gateway for a Paytm checkout link for the exact amount in OUR database.
async function createPayment(request, env, id) {
  await ensureSchema(env);
  if (!gwOn(env)) return directUpi(env, id);
  const o = await env.DB.prepare('SELECT id,phone,amount,status FROM orders WHERE id=?').bind(id).first();
  if (!o) return json({ error: 'Order not found' }, 404);
  if (o.status !== 'pending') return json({ error: 'This order is already ' + o.status });
  const gw = PAY_PREFIX + o.id + 'T' + Date.now().toString(36).toUpperCase();   // fresh id each try (Paytm links expire)
  const res = await gateway(env, 'create', { orderId: gw, amount: Number(o.amount), phone: o.phone });
  if (!res || !res.paymentUrl) return json({ error: (res && res.error) || 'Could not start payment' });
  await env.DB.prepare('UPDATE orders SET pay_url=?, pay_intent=? WHERE id=?').bind(res.paymentUrl, JSON.stringify({ gw }), id).run();
  return json({ payment_url: res.paymentUrl, upi_intent: {}, mode: 'gateway' });
}

// Never trust the browser: ask the gateway (which asks Paytm) and approve only on SUCCESS for the SAME amount.
async function verifyPayment(env, id) {
  if (!gwOn(env)) return false;
  const o = await env.DB.prepare('SELECT id,amount,status,pay_url,pay_intent FROM orders WHERE id=?').bind(id).first();
  if (!o || o.status !== 'pending' || !o.pay_url) return false;
  let gw = ''; try { gw = JSON.parse(o.pay_intent || '{}').gw || ''; } catch {}
  if (!gw) return false;
  const t = await gateway(env, 'status', { orderId: gw, amount: Number(o.amount) });
  if (!t || t.ok !== true || String(t.status).toUpperCase() !== 'SUCCESS') return false;
  if (Number(t.amount) !== Math.round(Number(o.amount) * 100)) return false;   // paid less/more than the bill -> counter decides
  const r = await env.DB.prepare("UPDATE orders SET status='approved', pay_status='paid', pay_utr=? WHERE id=? AND status='pending'")
    .bind(String(t.transactionId || ''), id).run();
  return (r.meta?.changes || 0) > 0;
}

// Fallback when no gateway is configured: direct UPI to the shop's own Paytm merchant VPA.
// No payment callback exists in this mode, so the order stays "pending" until the counter checks the Paytm app and presses Approve.
async function directUpi(env, id) {
  const o = await env.DB.prepare('SELECT id,amount,status FROM orders WHERE id=?').bind(id).first();
  if (!o) return json({ error: 'Order not found' }, 404);
  if (o.status !== 'pending') return json({ error: 'This order is already ' + o.status });
  const vpa = clean(env.UPI_VPA) || 'paytmqr2810050501011kdriqm6ls23@paytm';
  const name = clean(env.UPI_NAME) || 'Digital Seva Kendra';
  const q = 'pa=' + encodeURIComponent(vpa) + '&pn=' + encodeURIComponent(name) + '&am=' + Number(o.amount).toFixed(2)
    + '&cu=INR&tn=' + encodeURIComponent('Print order ' + o.id) + '&tr=' + o.id;
  const ui = { bhim: 'upi://pay?' + q, phonepe: 'phonepe://pay?' + q, gpay: 'tez://upi/pay?' + q, paytm: 'paytmmp://pay?' + q };
  return json({ payment_url: ui.bhim, upi_intent: ui, mode: 'direct' });
}

async function ordersWithFiles(env, statuses, limit = 50) {
  const ph = statuses.map(() => '?').join(',');
  const { results: orders } = await env.DB.prepare(
    `SELECT * FROM orders WHERE status IN (${ph}) ORDER BY created_at DESC LIMIT ${limit}`
  ).bind(...statuses).all();
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const { results: files } = await env.DB.prepare(
    `SELECT id,order_id,name,pages FROM files WHERE order_id IN (${ids.map(() => '?').join(',')}) AND r2_key IS NOT NULL`
  ).bind(...ids).all();
  return orders.map((o) => ({ ...o, files: files.filter((f) => f.order_id === o.id) }));
}

async function adminList(env) {
  return json({ orders: await ordersWithFiles(env, ['pending', 'approved', 'printing', 'error', 'printed', 'rejected'], 40) });
}

async function adminDecide(env, id, action) {
  if (action === 'approve') {
    await env.DB.prepare("UPDATE orders SET status='approved' WHERE id=? AND status IN ('pending','error')").bind(id).run();
  } else {
    await env.DB.prepare("UPDATE orders SET status='rejected', name='', phone='' WHERE id=? AND status IN ('pending','approved','printing','error')").bind(id).run();
    await purgeFiles(env, id);
    await env.DB.prepare('DELETE FROM files WHERE order_id=?').bind(id).run(); // forget file names too
  }
  return json({ ok: true });
}

// "Remove all": deletes every order, its files in storage and all customer details.
async function adminClear(env) {
  const { results } = await env.DB.prepare('SELECT r2_key FROM files WHERE r2_key IS NOT NULL').all();
  for (const f of results) await env.FILES.delete(f.r2_key);
  await env.DB.batch([env.DB.prepare('DELETE FROM files'), env.DB.prepare('DELETE FROM orders')]);
  return json({ ok: true, removed: results.length });
}

async function adminMark(request, env, id, action) {
  if (action === 'start') {
    await env.DB.prepare("UPDATE orders SET status='printing' WHERE id=? AND status IN ('pending','approved','error')").bind(id).run();
    return json({ ok: true });
  }
  return agentUpdate(request, env, id, 'done'); // printed: delete files + erase name/phone
}

async function serveFile(env, fileId) {
  const f = await env.DB.prepare('SELECT name,r2_key FROM files WHERE id=?').bind(fileId).first();
  if (!f || !f.r2_key) return json({ error: 'File not found' }, 404);
  const { value, metadata } = await env.FILES.getWithMetadata(f.r2_key, { type: 'arrayBuffer' });
  if (!value) return json({ error: 'File missing (expired?)' }, 404);
  return new Response(value, {
    headers: {
      'content-type': (metadata && metadata.type) || 'application/octet-stream',
      'content-disposition': `inline; filename="${safeName(f.name)}"`,
      'cache-control': 'no-store',
    },
  });
}

async function agentJobs(env) {
  const orders = await ordersWithFiles(env, ['approved'], 20);
  return json({ orders: orders.reverse() }); // oldest first
}

async function agentUpdate(request, env, id, action) {
  if (action === 'claim') {
    const r = await env.DB.prepare("UPDATE orders SET status='printing' WHERE id=? AND status='approved'").bind(id).run();
    return json({ claimed: (r.meta?.changes || 0) > 0 });
  }
  if (action === 'done') {
    await env.DB.prepare("UPDATE orders SET status='printed', name='', phone='' WHERE id=?").bind(id).run();
    await purgeFiles(env, id); // privacy: file removed right after printing
    await env.DB.prepare('DELETE FROM files WHERE order_id=?').bind(id).run(); // forget file names too
    return json({ ok: true });
  }
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare("UPDATE orders SET status='error', note=? WHERE id=?")
    .bind(String(body.reason || 'Print failed').slice(0, 200), id).run();
  return json({ ok: true });
}

async function purgeFiles(env, id) {
  const { results } = await env.DB.prepare('SELECT r2_key FROM files WHERE order_id=? AND r2_key IS NOT NULL').bind(id).all();
  for (const f of results) await env.FILES.delete(f.r2_key);
  await env.DB.prepare('UPDATE files SET r2_key=NULL WHERE order_id=?').bind(id).run();
}
