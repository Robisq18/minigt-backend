// ============================================================
// MINI GT Brunei — Backend v3
// Phone+Password auth, Firebase OTP for registration only
// Full user management, order history
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
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyCcpBE8U_SxKg8mRSG7X3VN_u-YJFVms1Q',
};

// ── HELPERS ───────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'minigt-salt-2025').digest('hex');
}

async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${CONFIG.FIREBASE_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) throw new Error('Invalid Firebase token');
  const data = await res.json();
  if (!data.users?.[0]) throw new Error('User not found');
  return data.users[0];
}

// ── DATABASE ──────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

const defaultData = {
  batch: {
    title: 'Batch #12 — May 2025',
    desc: 'Select your models and place your pre-order before the deadline.',
    deadline: new Date(Date.now() + 7*24*60*60*1000).toISOString(),
    status: 'open',
  },
  products: [
    { id:'p1', name:'Nissan Skyline GT-R R34 V-Spec', scale:'1:64', price:8.90, image:'', sort:1 },
    { id:'p2', name:'Toyota Supra A80 RZ',            scale:'1:64', price:8.90, image:'', sort:2 },
    { id:'p3', name:'Honda NSX Type R NA1',           scale:'1:64', price:9.50, image:'', sort:3 },
    { id:'p4', name:'Mazda RX-7 FD3S Spirit R',       scale:'1:64', price:9.50, image:'', sort:4 },
    { id:'p5', name:'Mitsubishi Lancer Evo IX',       scale:'1:64', price:8.90, image:'', sort:5 },
    { id:'p6', name:'Subaru Impreza WRX STI',         scale:'1:64', price:8.90, image:'', sort:6 },
  ],
  // customers: { phone -> { id, firstName, lastName, phone, passwordHash, createdAt } }
  customers: {},
  // orders: [ { ref, customerId, phone, name, batchTitle, items, createdAt } ]
  orders: [],
  // sessions: { token -> phone }
  customerSessions: {},
};

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();
db.data = { ...defaultData, ...db.data };
if (!db.data.customers)       db.data.customers = {};
if (!db.data.customerSessions) db.data.customerSessions = {};
await db.write();

console.log(`\n🚗 MINI GT Brunei backend on port ${CONFIG.PORT}`);
console.log(`   Admin password: ${CONFIG.ADMIN_PASSWORD}`);
console.log(`   DB: ${DB_PATH}\n`);

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

// ── PUBLIC: BATCH & PRODUCTS ──────────────────────────────
app.get('/api/batch', async (req, res) => {
  await db.read();
  if (db.data.batch.status === 'open' && db.data.batch.deadline && new Date(db.data.batch.deadline) < new Date()) {
    db.data.batch.status = 'closed';
    await db.write();
  }
  res.json({ batch: db.data.batch, products: [...db.data.products].sort((a,b) => a.sort - b.sort) });
});

// ── REGISTER: Step 1 — Firebase verifies phone, we create account ─
app.post('/api/auth/register', async (req, res) => {
  const { idToken, phone, firstName, lastName, password } = req.body;
  if (!idToken || !phone || !firstName || !lastName || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Verify Firebase token (confirms phone ownership)
  try {
    await verifyFirebaseToken(idToken);
  } catch(e) {
    return res.status(401).json({ error: 'Phone verification failed. Please try again.' });
  }

  await db.read();

  // Normalize phone — strip country code for storage, keep consistent
  const cleanPhone = phone.replace(/\s+/g, '');

  if (db.data.customers[cleanPhone]) {
    return res.status(400).json({ error: 'An account with this number already exists. Please login.' });
  }

  const customerId = 'cust_' + Date.now();
  db.data.customers[cleanPhone] = {
    id: customerId,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: cleanPhone,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };

  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = cleanPhone;
  await db.write();

  const c = db.data.customers[cleanPhone];
  console.log(`New customer: ${c.firstName} ${c.lastName} (${cleanPhone})`);
  res.json({ success: true, token, customer: { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: cleanPhone } });
});

// ── LOGIN: phone (no country code) + password ─────────────
app.post('/api/auth/login', async (req, res) => {
  const { phone, countryCode, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

  await db.read();

  // Try with country code first, then without
  const cc = countryCode || '+673';
  const fullPhone = cc + phone.replace(/\s+/g, '');
  const customer = db.data.customers[fullPhone] || db.data.customers[phone];
  const resolvedPhone = db.data.customers[fullPhone] ? fullPhone : phone;

  if (!customer) return res.status(404).json({ error: 'No account found with this number.' });
  if (customer.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = resolvedPhone;
  await db.write();

  res.json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, phone: resolvedPhone } });
});

// ── LOGOUT ────────────────────────────────────────────────
app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.data.customerSessions[token];
  await db.write();
  res.json({ success: true });
});

// ── ME ────────────────────────────────────────────────────
app.get('/api/auth/me', requireCustomer, (req, res) => {
  const c = req.customer;
  res.json({ customer: { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: req.customerPhone } });
});

// ── ORDER HISTORY (for logged-in customer) ────────────────
app.get('/api/orders/my', requireCustomer, async (req, res) => {
  await db.read();
  const myOrders = db.data.orders
    .filter(o => o.phone === req.customerPhone)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: myOrders });
});

// ── SUBMIT ORDER ──────────────────────────────────────────
app.post('/api/orders', requireCustomer, async (req, res) => {
  await db.read();
  const { items } = req.body;
  const phone = req.customerPhone;
  const customer = req.customer;

  if (!items?.length) return res.status(400).json({ error: 'No items selected' });
  if (db.data.batch.status !== 'open') return res.status(400).json({ error: 'Pre-order is currently closed.' });

  // Check duplicate for THIS batch only (by batch title)
  const duplicate = db.data.orders.find(o => o.phone === phone && o.batchTitle === db.data.batch.title);
  if (duplicate) return res.status(400).json({ error: 'You have already placed an order for this batch.' });

  for (const item of items) {
    if (!item.qty || item.qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  }

  const ref = 'MGT-' + Date.now().toString().slice(-6);
  db.data.orders.push({
    ref,
    customerId: customer.id,
    phone,
    customerName: `${customer.firstName} ${customer.lastName}`,
    batchTitle: db.data.batch.title,
    items,
    createdAt: new Date().toISOString(),
  });
  await db.write();

  console.log(`New order: ${ref} — ${customer.firstName} ${customer.lastName} (${phone})`);
  res.json({ success: true, ref });
});

// ── CHANGE PASSWORD ───────────────────────────────────────
app.post('/api/auth/change-password', requireCustomer, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  await db.read();
  const customer = db.data.customers[req.customerPhone];
  if (!customer) return res.status(404).json({ error: 'Account not found' });
  if (customer.passwordHash !== hashPassword(currentPassword)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.data.customers[req.customerPhone].passwordHash = hashPassword(newPassword);
  await db.write();
  console.log(`Password changed for ${req.customerPhone}`);
  res.json({ success: true });
});

// ── ADMIN: LOGIN ──────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== CONFIG.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ token });
});

// ── ADMIN: ORDERS ─────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  await db.read();
  res.json({ orders: db.data.orders });
});

// ── ADMIN: CUSTOMERS (full list) ──────────────────────────
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  await db.read();
  const customers = Object.values(db.data.customers).map(c => {
    const orders = db.data.orders.filter(o => o.phone === c.phone);
    return { ...c, passwordHash: undefined, orderCount: orders.length, orders };
  });
  res.json({ customers });
});

// ── ADMIN: EDIT CUSTOMER ──────────────────────────────────
app.put('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  await db.read();
  const phone = decodeURIComponent(req.params.phone);
  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Customer not found' });
  const { firstName, lastName } = req.body;
  if (firstName) db.data.customers[phone].firstName = firstName;
  if (lastName)  db.data.customers[phone].lastName  = lastName;
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: DELETE CUSTOMER ────────────────────────────────
app.delete('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  await db.read();
  const phone = decodeURIComponent(req.params.phone);
  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Customer not found' });
  delete db.data.customers[phone];
  // Remove their sessions
  for (const [token, p] of Object.entries(db.data.customerSessions)) {
    if (p === phone) delete db.data.customerSessions[token];
  }
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: RESET CUSTOMER PASSWORD ───────────────────────
app.post('/api/admin/customers/:phone/reset-password', requireAdmin, async (req, res) => {
  await db.read();
  const phone = decodeURIComponent(req.params.phone);
  const { newPassword } = req.body;
  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Customer not found' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  db.data.customers[phone].passwordHash = hashPassword(newPassword);
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: BATCH ──────────────────────────────────────────
app.put('/api/admin/batch', requireAdmin, async (req, res) => {
  await db.read();
  db.data.batch = { ...db.data.batch, ...req.body };
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: PRODUCTS ───────────────────────────────────────
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  await db.read();
  const prod = { id:'p'+Date.now(), sort: db.data.products.length+1, image:'', ...req.body };
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

app.listen(CONFIG.PORT);
