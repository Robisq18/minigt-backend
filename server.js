// ============================================================
// MINI GT Brunei — Backend with D7 Networks OTP API
// D7 handles code generation + verification natively
// ============================================================

import express from 'express';
import cors from 'cors';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(cors());

const CONFIG = {
  PORT:           process.env.PORT || 3000,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  D7_TOKEN:       process.env.D7_API_TOKEN || '',
  D7_ORIGINATOR:  process.env.D7_ORIGINATOR || 'MINIGT',
  CODE_EXPIRY:    600, // seconds (10 minutes)
};

// D7 OTP API base URL
const D7_OTP_URL = 'https://api.d7networks.com/verify/v1';

// ── D7 OTP HELPERS ────────────────────────────────────────
// D7 sends the code AND verifies it — we just store the otp_id they return

async function d7SendOTP(phone) {
  const res = await fetch(`${D7_OTP_URL}/otp/send-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${CONFIG.D7_TOKEN}`,
    },
    body: JSON.stringify({
      originator: CONFIG.D7_ORIGINATOR,
      recipient: phone,
      content: 'Your MINI GT Brunei verification code is: {}. Valid for 10 minutes.',
      expiry: CONFIG.CODE_EXPIRY,
      data_coding: 'text',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.detail || `D7 error ${res.status}`);
  }
  const data = await res.json();
  return data.otp_id; // D7 returns an otp_id we use to verify later
}

async function d7VerifyOTP(otpId, code) {
  const res = await fetch(`${D7_OTP_URL}/otp/verify-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${CONFIG.D7_TOKEN}`,
    },
    body: JSON.stringify({ otp_id: otpId, otp_code: code }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.status === 'approved';
}

// ── DATABASE ──────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

const defaultData = {
  batch: {
    title: 'Batch #12 — May 2025',
    desc: 'Select your models and place your pre-order before the deadline.',
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'open',
  },
  products: [
    { id: 'p1', name: 'Nissan Skyline GT-R R34 V-Spec', scale: '1:64', price: 8.90, image: '', sort: 1 },
    { id: 'p2', name: 'Toyota Supra A80 RZ',            scale: '1:64', price: 8.90, image: '', sort: 2 },
    { id: 'p3', name: 'Honda NSX Type R NA1',           scale: '1:64', price: 9.50, image: '', sort: 3 },
    { id: 'p4', name: 'Mazda RX-7 FD3S Spirit R',       scale: '1:64', price: 9.50, image: '', sort: 4 },
    { id: 'p5', name: 'Mitsubishi Lancer Evo IX',       scale: '1:64', price: 8.90, image: '', sort: 5 },
    { id: 'p6', name: 'Subaru Impreza WRX STI',         scale: '1:64', price: 8.90, image: '', sort: 6 },
  ],
  orders: [],
  customers: {},        // phone -> { name, address, registeredAt }
  otpIds: {},           // phone -> { otpId, purpose, expiresAt }
  customerSessions: {}, // token -> phone
};

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();
db.data = { ...defaultData, ...db.data };
if (!db.data.customers) db.data.customers = {};
if (!db.data.customerSessions) db.data.customerSessions = {};
if (!db.data.otpIds) db.data.otpIds = {};
await db.write();

const D7_ENABLED = !!CONFIG.D7_TOKEN;
console.log(D7_ENABLED ? '✓ D7 Networks OTP connected' : '⚠  D7 not configured — demo mode (code: 123456)');

// ── AUTH MIDDLEWARE ───────────────────────────────────────
const adminSessions = new Set();

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!adminSessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireCustomer(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const phone = db.data.customerSessions[token];
  if (!phone) return res.status(401).json({ error: 'Not logged in' });
  req.customerPhone = phone;
  req.customer = db.data.customers[phone];
  next();
}

// ── PUBLIC: BATCH & PRODUCTS ─────────────────────────────
app.get('/api/batch', async (req, res) => {
  await db.read();
  if (db.data.batch.status === 'open' && db.data.batch.deadline && new Date(db.data.batch.deadline) < new Date()) {
    db.data.batch.status = 'closed';
    await db.write();
  }
  res.json({ batch: db.data.batch, products: [...db.data.products].sort((a, b) => a.sort - b.sort) });
});

// ── AUTH: SEND OTP ────────────────────────────────────────
app.post('/api/auth/send-code', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const purpose = req.body.purpose || 'register';
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  await db.read();

  if (purpose === 'login' && !db.data.customers[phone]) {
    return res.status(404).json({ error: 'No account found. Please register first.' });
  }

  if (!D7_ENABLED) {
    // Demo mode — no real SMS
    db.data.otpIds[phone] = { otpId: 'demo', purpose, expiresAt: Date.now() + 600000 };
    await db.write();
    return res.json({ success: true, demo: true });
  }

  try {
    const otpId = await d7SendOTP(phone);
    db.data.otpIds[phone] = { otpId, purpose, expiresAt: Date.now() + 600000 };
    await db.write();
    console.log(`OTP sent to ${phone}, otp_id: ${otpId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('D7 send error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. ' + err.message });
  }
});

// ── AUTH: REGISTER ────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const phone   = (req.body.phone   || '').replace(/\s+/g, '');
  const code    = (req.body.code    || '').trim();
  const name    = (req.body.name    || '').trim();
  const address = (req.body.address || '').trim();

  if (!phone || !code || !name) return res.status(400).json({ error: 'Phone, code and name required' });

  await db.read();

  if (db.data.customers[phone]) return res.status(400).json({ error: 'Account already exists. Please login.' });

  // Verify OTP
  const entry = db.data.otpIds[phone];
  if (!entry) return res.json({ verified: false, error: 'No OTP found — request a new one.' });
  if (Date.now() > entry.expiresAt) {
    delete db.data.otpIds[phone];
    await db.write();
    return res.json({ verified: false, error: 'OTP expired — request a new one.' });
  }

  let verified = false;
  if (!D7_ENABLED && code === '123456') {
    verified = true;
  } else if (D7_ENABLED) {
    verified = await d7VerifyOTP(entry.otpId, code);
  }

  if (!verified) return res.json({ verified: false, error: 'Incorrect code.' });

  delete db.data.otpIds[phone];
  db.data.customers[phone] = { name, phone, address, registeredAt: new Date().toISOString() };
  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = phone;
  await db.write();

  console.log(`New customer: ${name} (${phone})`);
  res.json({ success: true, token, customer: { name, phone, address } });
});

// ── AUTH: LOGIN ───────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const code  = (req.body.code  || '').trim();

  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  await db.read();

  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Account not found.' });

  const entry = db.data.otpIds[phone];
  if (!entry) return res.json({ verified: false, error: 'No OTP found — request a new one.' });
  if (Date.now() > entry.expiresAt) {
    delete db.data.otpIds[phone];
    await db.write();
    return res.json({ verified: false, error: 'OTP expired — request a new one.' });
  }

  let verified = false;
  if (!D7_ENABLED && code === '123456') {
    verified = true;
  } else if (D7_ENABLED) {
    verified = await d7VerifyOTP(entry.otpId, code);
  }

  if (!verified) return res.json({ verified: false, error: 'Incorrect code.' });

  delete db.data.otpIds[phone];
  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = phone;
  await db.write();

  const customer = db.data.customers[phone];
  res.json({ success: true, token, customer: { name: customer.name, phone: customer.phone, address: customer.address } });
});

// ── AUTH: LOGOUT ──────────────────────────────────────────
app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.data.customerSessions[token];
  await db.write();
  res.json({ success: true });
});

// ── AUTH: ME ──────────────────────────────────────────────
app.get('/api/auth/me', requireCustomer, (req, res) => {
  res.json({ customer: { name: req.customer.name, phone: req.customerPhone, address: req.customer.address } });
});

// ── ORDERS ────────────────────────────────────────────────
app.post('/api/orders', requireCustomer, async (req, res) => {
  await db.read();
  const { items } = req.body;
  const phone = req.customerPhone;
  const customer = req.customer;

  if (!items?.length) return res.status(400).json({ error: 'No items selected' });
  if (db.data.batch.status !== 'open') return res.status(400).json({ error: 'Pre-order is closed' });
  if (db.data.orders.find(o => o.phone === phone)) {
    return res.status(400).json({ error: 'You have already placed an order for this batch.' });
  }
  for (const item of items) {
    if (!item.qty || item.qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  }

  const ref = 'MGT-' + Date.now().toString().slice(-6);
  db.data.orders.push({ ref, name: customer.name, phone, address: customer.address || '', items, verified: true, createdAt: new Date().toISOString() });
  await db.write();
  console.log(`New order: ${ref} — ${customer.name} (${phone})`);
  res.json({ success: true, ref });
});

// ── ADMIN ─────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== CONFIG.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ token });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  await db.read();
  res.json({ orders: db.data.orders });
});

app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  await db.read();
  res.json({ customers: Object.values(db.data.customers) });
});

app.put('/api/admin/batch', requireAdmin, async (req, res) => {
  await db.read();
  db.data.batch = { ...db.data.batch, ...req.body };
  await db.write();
  res.json({ success: true });
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  await db.read();
  const prod = { id: 'p' + Date.now(), sort: db.data.products.length + 1, image: '', ...req.body };
  db.data.products.push(prod);
  await db.write();
  res.json({ id: prod.id, success: true });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await db.read();
  db.data.products = db.data.products.filter(p => p.id !== req.params.id);
  await db.write();
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, err => { if (err) res.status(200).send('MINI GT API running'); });
});

app.listen(CONFIG.PORT, () => {
  console.log(`\n🚗 MINI GT Brunei backend on port ${CONFIG.PORT}`);
  console.log(`   Admin password: ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`   D7 OTP: ${D7_ENABLED ? 'enabled' : 'demo mode'}`);
  console.log(`   DB: ${DB_PATH}\n`);
});
