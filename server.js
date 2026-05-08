import express from 'express';
import cors from 'cors';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import twilio from 'twilio';
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
  TWILIO_SID:     process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_TOKEN:   process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM:    process.env.TWILIO_PHONE_NUMBER || '',
  CODE_EXPIRY_MS: 10 * 60 * 1000,
};

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

const defaultData = {
  batch: {
    title: 'Batch #12 — May 2025',
    desc: 'Select your models and place your pre-order before the deadline.',
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'open'
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
  customers: {},    // phone -> { name, address, registeredAt }
  smsCodes: {},     // phone -> { code, expiresAt, purpose }
  customerSessions: {}, // token -> phone
};

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();
db.data = { ...defaultData, ...db.data };
if (!db.data.customers) db.data.customers = {};
if (!db.data.customerSessions) db.data.customerSessions = {};
await db.write();

let twilioClient = null;
if (CONFIG.TWILIO_SID && CONFIG.TWILIO_TOKEN) {
  twilioClient = twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
  console.log('✓ Twilio connected');
} else {
  console.log('⚠  Twilio not configured — demo mode (code: 123456)');
}

// Admin auth
const adminSessions = new Set();
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!adminSessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Customer auth middleware
function requireCustomer(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const phone = db.data.customerSessions[token];
  if (!phone) return res.status(401).json({ error: 'Not logged in' });
  req.customerPhone = phone;
  req.customer = db.data.customers[phone];
  next();
}

async function sendSMS(phone, message) {
  if (twilioClient) {
    await twilioClient.messages.create({ body: message, from: CONFIG.TWILIO_FROM, to: phone });
    return true;
  }
  console.log(`[DEMO SMS to ${phone}]: ${message}`);
  return false;
}

// ── PUBLIC: Batch & Products ──────────────────────────────
app.get('/api/batch', async (req, res) => {
  await db.read();
  if (db.data.batch.status === 'open' && db.data.batch.deadline && new Date(db.data.batch.deadline) < new Date()) {
    db.data.batch.status = 'closed';
    await db.write();
  }
  res.json({ batch: db.data.batch, products: [...db.data.products].sort((a, b) => a.sort - b.sort) });
});

// ── REGISTRATION: Send code ───────────────────────────────
app.post('/api/auth/send-code', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const purpose = req.body.purpose || 'register'; // 'register' or 'login'
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  await db.read();

  // If login but not registered
  if (purpose === 'login' && !db.data.customers[phone]) {
    return res.status(404).json({ error: 'No account found. Please register first.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.data.smsCodes[phone] = { code, expiresAt: Date.now() + CONFIG.CODE_EXPIRY_MS, purpose };
  await db.write();

  const msg = purpose === 'login'
    ? `Your MINI GT Brunei login code is: ${code}. Valid for 10 minutes.`
    : `Your MINI GT Brunei registration code is: ${code}. Valid for 10 minutes.`;

  try {
    await sendSMS(phone, msg);
    res.json({ success: true, demo: !twilioClient });
  } catch (err) {
    console.error('SMS error:', err.message);
    res.status(500).json({ error: 'SMS failed' });
  }
});

// ── REGISTRATION: Verify code + create account ────────────
app.post('/api/auth/register', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const code  = (req.body.code  || '').trim();
  const name  = (req.body.name  || '').trim();
  const address = (req.body.address || '').trim();

  if (!phone || !code || !name) return res.status(400).json({ error: 'Phone, code and name required' });

  await db.read();

  if (db.data.customers[phone]) return res.status(400).json({ error: 'Account already exists. Please login.' });

  // Verify code
  if (!twilioClient && code === '123456') {
    // demo bypass
  } else {
    const entry = db.data.smsCodes[phone];
    if (!entry) return res.json({ verified: false, error: 'No code found — request a new one.' });
    if (Date.now() > entry.expiresAt) {
      delete db.data.smsCodes[phone];
      await db.write();
      return res.json({ verified: false, error: 'Code expired.' });
    }
    if (entry.code !== code) return res.json({ verified: false, error: 'Incorrect code.' });
    delete db.data.smsCodes[phone];
  }

  // Create customer
  db.data.customers[phone] = { name, phone, address, registeredAt: new Date().toISOString() };

  // Create session
  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = phone;
  await db.write();

  console.log(`New customer: ${name} (${phone})`);
  res.json({ success: true, token, customer: { name, phone, address } });
});

// ── LOGIN: Verify code ────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const code  = (req.body.code  || '').trim();

  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  await db.read();

  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Account not found.' });

  // Verify code
  if (!twilioClient && code === '123456') {
    // demo bypass
  } else {
    const entry = db.data.smsCodes[phone];
    if (!entry) return res.json({ verified: false, error: 'No code found.' });
    if (Date.now() > entry.expiresAt) {
      delete db.data.smsCodes[phone];
      await db.write();
      return res.json({ verified: false, error: 'Code expired.' });
    }
    if (entry.code !== code) return res.json({ verified: false, error: 'Incorrect code.' });
    delete db.data.smsCodes[phone];
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = phone;
  await db.write();

  const customer = db.data.customers[phone];
  res.json({ success: true, token, customer: { name: customer.name, phone: customer.phone, address: customer.address } });
});

// ── LOGOUT ────────────────────────────────────────────────
app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.data.customerSessions[token];
  await db.write();
  res.json({ success: true });
});

// ── GET current customer ──────────────────────────────────
app.get('/api/auth/me', requireCustomer, (req, res) => {
  res.json({ customer: { name: req.customer.name, phone: req.customerPhone, address: req.customer.address } });
});

// ── SUBMIT ORDER (requires login) ─────────────────────────
app.post('/api/orders', requireCustomer, async (req, res) => {
  await db.read();
  const { items } = req.body;
  const phone = req.customerPhone;
  const customer = req.customer;

  if (!items?.length) return res.status(400).json({ error: 'No items selected' });
  if (db.data.batch.status !== 'open') return res.status(400).json({ error: 'Pre-order is closed' });
  if (db.data.orders.find(o => o.phone === phone)) return res.status(400).json({ error: 'You have already placed an order for this batch.' });

  // Validate quantities
  for (const item of items) {
    if (!item.qty || item.qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  }

  const ref = 'MGT-' + Date.now().toString().slice(-6);
  db.data.orders.push({
    ref, name: customer.name, phone, address: customer.address || '',
    items, verified: true, createdAt: new Date().toISOString()
  });
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
  console.log(`   DB: ${DB_PATH}\n`);
});
