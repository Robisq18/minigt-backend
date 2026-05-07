// ============================================================
// MINI GT Brunei — Pre-Order Backend
// Node.js + Express + LowDB (JSON file) + Twilio
// No build tools required — works on all platforms
// ============================================================

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
  smsCodes: {},
  verifiedPhones: {},
};

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();
db.data = { ...defaultData, ...db.data };
await db.write();

let twilioClient = null;
if (CONFIG.TWILIO_SID && CONFIG.TWILIO_TOKEN) {
  twilioClient = twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
  console.log('✓ Twilio connected');
} else {
  console.log('⚠  Twilio not configured — demo mode (code: 123456)');
}

const sessions = new Set();
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/batch', async (req, res) => {
  await db.read();
  if (db.data.batch.status === 'open' && db.data.batch.deadline && new Date(db.data.batch.deadline) < new Date()) {
    db.data.batch.status = 'closed';
    await db.write();
  }
  res.json({ batch: db.data.batch, products: [...db.data.products].sort((a, b) => a.sort - b.sort) });
});

app.post('/api/send-code', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.data.smsCodes[phone] = { code, expiresAt: Date.now() + CONFIG.CODE_EXPIRY_MS };
  await db.write();
  if (twilioClient) {
    try {
      await twilioClient.messages.create({
        body: `Your MINI GT Brunei pre-order code is: ${code}. Valid for 10 minutes.`,
        from: CONFIG.TWILIO_FROM,
        to: phone,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('Twilio error:', err.message);
      res.status(500).json({ error: 'SMS failed. Check Twilio config.' });
    }
  } else {
    console.log(`[DEMO] Code for ${phone}: ${code}`);
    res.json({ success: true, demo: true });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\s+/g, '');
  const code  = (req.body.code  || '').trim();
  if (!twilioClient && code === '123456') {
    db.data.verifiedPhones[phone] = true;
    await db.write();
    return res.json({ verified: true });
  }
  const entry = db.data.smsCodes[phone];
  if (!entry) return res.json({ verified: false, error: 'No code found — request a new one.' });
  if (Date.now() > entry.expiresAt) {
    delete db.data.smsCodes[phone];
    await db.write();
    return res.json({ verified: false, error: 'Code expired — request a new one.' });
  }
  if (entry.code !== code) return res.json({ verified: false });
  db.data.verifiedPhones[phone] = true;
  delete db.data.smsCodes[phone];
  await db.write();
  res.json({ verified: true });
});

app.post('/api/orders', async (req, res) => {
  await db.read();
  const { name, phone, address, items } = req.body;
  if (!name || !phone || !items?.length) return res.status(400).json({ error: 'Missing fields' });
  if (db.data.batch.status !== 'open') return res.status(400).json({ error: 'Pre-order is closed' });
  if (!db.data.verifiedPhones[phone]) return res.status(400).json({ error: 'Phone not verified' });
  if (db.data.orders.find(o => o.phone === phone)) return res.status(400).json({ error: 'Order already exists for this number' });
  const ref = 'MGT-' + Date.now().toString().slice(-6);
  db.data.orders.push({ ref, name, phone, address: address || '', items, verified: true, createdAt: new Date().toISOString() });
  await db.write();
  console.log(`New order: ${ref} — ${name} (${phone})`);
  res.json({ success: true, ref });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== CONFIG.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.json({ token });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  await db.read();
  res.json({ orders: db.data.orders });
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
