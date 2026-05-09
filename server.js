// ============================================================
// MINI GT Brunei — Backend v5
// Multi-batch system, per-batch products, image uploads
// ============================================================

import express from 'express';
import cors from 'cors';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

const CONFIG = {
  PORT:             process.env.PORT || 3000,
  ADMIN_PASSWORD:   process.env.ADMIN_PASSWORD || 'admin123',
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyCcpBE8U_SxKg8mRSG7X3VN_u-YJFVms1Q',
  DATA_DIR:         process.env.DATA_DIR || path.join(__dirname, 'data'),
};

// Ensure data and images directories exist
const IMAGES_DIR = path.join(CONFIG.DATA_DIR, 'images');
await mkdir(CONFIG.DATA_DIR, { recursive: true });
await mkdir(IMAGES_DIR, { recursive: true });

// Serve uploaded images
app.use('/images', express.static(IMAGES_DIR));

// ── HELPERS ───────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'minigt-salt-2025').digest('hex');
}

async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${CONFIG.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) throw new Error('Invalid Firebase token');
  const data = await res.json();
  if (!data.users?.[0]) throw new Error('User not found');
  return data.users[0];
}

function generateId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ── DATABASE ──────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(CONFIG.DATA_DIR, 'db.json');

const defaultData = {
  // batches: [ { id, ref, title, desc, deadline, status:'active'|'closed', createdAt } ]
  batches: [],
  // products: [ { id, batchId, name, scale, price, image, sort, createdAt } ]
  products: [],
  // orders: [ { ref, batchId, batchTitle, batchRef, customerId, phone, customerName, items, createdAt } ]
  orders: [],
  // customers: { phone -> { id, firstName, lastName, phone, passwordHash, createdAt } }
  customers: {},
  customerSessions: {},
};

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();
db.data = { ...defaultData, ...db.data };
if (!db.data.batches)          db.data.batches = [];
if (!db.data.products)         db.data.products = [];
if (!db.data.customers)        db.data.customers = {};
if (!db.data.customerSessions) db.data.customerSessions = {};
await db.write();

console.log(`\n🚗 MINI GT Brunei backend on port ${CONFIG.PORT}`);
console.log(`   Data dir: ${CONFIG.DATA_DIR}`);
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

// ── PUBLIC: ALL BATCHES (for dropdown) ───────────────────
app.get('/api/batches', async (req, res) => {
  await db.read();
  // Auto-close expired batches
  let changed = false;
  db.data.batches.forEach(b => {
    if (b.status === 'active' && b.deadline && new Date(b.deadline) < new Date()) {
      b.status = 'closed';
      changed = true;
    }
  });
  if (changed) await db.write();

  // Return batches newest first, with product counts
  const batches = [...db.data.batches]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(b => ({
      ...b,
      productCount: db.data.products.filter(p => p.batchId === b.id).length,
    }));
  res.json({ batches });
});

// ── PUBLIC: SINGLE BATCH + PRODUCTS ──────────────────────
app.get('/api/batches/:id', async (req, res) => {
  await db.read();
  const batch = db.data.batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const products = db.data.products
    .filter(p => p.batchId === batch.id)
    .sort((a, b) => a.sort - b.sort);
  res.json({ batch, products });
});

// ── CUSTOMER AUTH ─────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { idToken, phone, firstName, lastName, password } = req.body;
  if (!idToken || !phone || !firstName || !lastName || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try { await verifyFirebaseToken(idToken); }
  catch(e) { return res.status(401).json({ error: 'Phone verification failed. Please try again.' }); }

  await db.read();
  const cleanPhone = phone.replace(/\s+/g, '');
  if (db.data.customers[cleanPhone])
    return res.status(400).json({ error: 'Account already exists. Please login.' });

  const customerId = generateId('cust');
  db.data.customers[cleanPhone] = {
    id: customerId, firstName: firstName.trim(), lastName: lastName.trim(),
    phone: cleanPhone, passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
  };
  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = cleanPhone;
  await db.write();

  const c = db.data.customers[cleanPhone];
  res.json({ success: true, token, customer: { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: cleanPhone } });
});

app.post('/api/auth/login', async (req, res) => {
  const { phone, countryCode, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  await db.read();
  const cc = countryCode || '+673';
  const fullPhone = cc + phone.replace(/\s+/g, '');
  const customer = db.data.customers[fullPhone] || db.data.customers[phone];
  const resolvedPhone = db.data.customers[fullPhone] ? fullPhone : phone;
  if (!customer) return res.status(404).json({ error: 'No account found with this number.' });
  if (customer.passwordHash !== hashPassword(password))
    return res.status(401).json({ error: 'Incorrect password.' });
  const token = crypto.randomBytes(32).toString('hex');
  db.data.customerSessions[token] = resolvedPhone;
  await db.write();
  res.json({ success: true, token, customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, phone: resolvedPhone } });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.data.customerSessions[token];
  await db.write();
  res.json({ success: true });
});

app.get('/api/auth/me', requireCustomer, (req, res) => {
  const c = req.customer;
  res.json({ customer: { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: req.customerPhone } });
});

app.post('/api/auth/change-password', requireCustomer, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  await db.read();
  const customer = db.data.customers[req.customerPhone];
  if (customer.passwordHash !== hashPassword(currentPassword))
    return res.status(401).json({ error: 'Current password is incorrect' });
  db.data.customers[req.customerPhone].passwordHash = hashPassword(newPassword);
  await db.write();
  res.json({ success: true });
});

// ── ORDERS ────────────────────────────────────────────────
app.get('/api/orders/my', requireCustomer, async (req, res) => {
  await db.read();
  const myOrders = db.data.orders
    .filter(o => o.phone === req.customerPhone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: myOrders });
});

app.post('/api/orders', requireCustomer, async (req, res) => {
  await db.read();
  const { batchId, items } = req.body;
  const phone = req.customerPhone;
  const customer = req.customer;
  if (!batchId || !items?.length) return res.status(400).json({ error: 'Missing batch or items' });

  const batch = db.data.batches.find(b => b.id === batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'active') return res.status(400).json({ error: 'This batch is no longer accepting orders.' });

  const duplicate = db.data.orders.find(o => o.phone === phone && o.batchId === batchId);
  if (duplicate) return res.status(400).json({ error: 'You have already placed an order for this batch.' });

  const ref = batch.ref + '-' + Date.now().toString().slice(-4);
  db.data.orders.push({
    ref, batchId, batchTitle: batch.title, batchRef: batch.ref,
    customerId: customer.id, phone,
    customerName: `${customer.firstName} ${customer.lastName}`,
    items, createdAt: new Date().toISOString(),
  });
  await db.write();
  console.log(`New order: ${ref} — ${customer.firstName} ${customer.lastName}`);
  res.json({ success: true, ref });
});

// ── IMAGE UPLOAD ──────────────────────────────────────────
app.post('/api/admin/upload-image', requireAdmin, async (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    if (!imageData || !fileName) return res.status(400).json({ error: 'No image data' });

    // imageData is base64 from frontend
    const matches = imageData.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid image format' });

    const ext = matches[1].split('/')[1].replace('jpeg', 'jpg');
    const allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: 'Only JPG, PNG, WebP images allowed' });

    const uniqueName = Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    const filePath = path.join(IMAGES_DIR, uniqueName);
    await writeFile(filePath, Buffer.from(matches[2], 'base64'));

    const imageUrl = `/images/${uniqueName}`;
    res.json({ success: true, url: imageUrl, fileName: uniqueName });
  } catch(e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// Delete image
app.delete('/api/admin/images/:fileName', requireAdmin, async (req, res) => {
  try {
    const filePath = path.join(IMAGES_DIR, req.params.fileName);
    if (existsSync(filePath)) await unlink(filePath);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── ADMIN: LOGIN ──────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== CONFIG.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ token });
});

// ── ADMIN: BATCHES ────────────────────────────────────────
app.get('/api/admin/batches', requireAdmin, async (req, res) => {
  await db.read();
  const batches = [...db.data.batches]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(b => ({
      ...b,
      productCount: db.data.products.filter(p => p.batchId === b.id).length,
      orderCount: db.data.orders.filter(o => o.batchId === b.id).length,
    }));
  res.json({ batches });
});

app.post('/api/admin/batches', requireAdmin, async (req, res) => {
  await db.read();
  const { ref, title, desc, deadline } = req.body;
  if (!ref || !title) return res.status(400).json({ error: 'Ref and title required' });

  // Only one active batch at a time
  const alreadyActive = db.data.batches.find(b => b.status === 'active');
  if (alreadyActive) return res.status(400).json({ error: 'Close the current active batch before creating a new one.' });

  const batch = {
    id: generateId('batch'), ref: ref.trim(), title: title.trim(),
    desc: (desc || '').trim(), deadline: deadline || null,
    status: 'active', createdAt: new Date().toISOString(),
  };
  db.data.batches.push(batch);
  await db.write();
  res.json({ success: true, batch });
});

app.put('/api/admin/batches/:id', requireAdmin, async (req, res) => {
  await db.read();
  const idx = db.data.batches.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Batch not found' });
  db.data.batches[idx] = { ...db.data.batches[idx], ...req.body };
  await db.write();
  res.json({ success: true, batch: db.data.batches[idx] });
});

app.post('/api/admin/batches/:id/close', requireAdmin, async (req, res) => {
  await db.read();
  const batch = db.data.batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  batch.status = 'closed';
  batch.closedAt = new Date().toISOString();
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: PRODUCTS ───────────────────────────────────────
app.get('/api/admin/batches/:id/products', requireAdmin, async (req, res) => {
  await db.read();
  const products = db.data.products
    .filter(p => p.batchId === req.params.id)
    .sort((a, b) => a.sort - b.sort);
  res.json({ products });
});

app.post('/api/admin/batches/:id/products', requireAdmin, async (req, res) => {
  await db.read();
  const batch = db.data.batches.find(b => b.id === req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const existing = db.data.products.filter(p => p.batchId === req.params.id);
  const product = {
    id: generateId('prod'),
    batchId: req.params.id,
    name: req.body.name, scale: req.body.scale || '1:64',
    price: parseFloat(req.body.price), image: req.body.image || '',
    sort: existing.length + 1, createdAt: new Date().toISOString(),
  };
  db.data.products.push(product);
  await db.write();
  res.json({ success: true, product });
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await db.read();
  const idx = db.data.products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Product not found' });
  db.data.products[idx] = { ...db.data.products[idx], ...req.body };
  await db.write();
  res.json({ success: true, product: db.data.products[idx] });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await db.read();
  db.data.products = db.data.products.filter(p => p.id !== req.params.id);
  await db.write();
  res.json({ success: true });
});

// ── ADMIN: ORDERS ─────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  await db.read();
  const { batchId } = req.query;
  let orders = db.data.orders;
  if (batchId) orders = orders.filter(o => o.batchId === batchId);
  orders = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// ── ADMIN: CUSTOMERS ──────────────────────────────────────
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  await db.read();
  const customers = Object.values(db.data.customers).map(c => {
    const orders = db.data.orders.filter(o => o.phone === c.phone);
    return { ...c, passwordHash: undefined, orderCount: orders.length, orders };
  });
  res.json({ customers });
});

app.put('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  await db.read();
  const phone = decodeURIComponent(req.params.phone);
  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Customer not found' });
  const { firstName, lastName } = req.body;
  if (firstName) db.data.customers[phone].firstName = firstName;
  if (lastName) db.data.customers[phone].lastName = lastName;
  await db.write();
  res.json({ success: true });
});

app.delete('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  await db.read();
  const phone = decodeURIComponent(req.params.phone);
  if (!db.data.customers[phone]) return res.status(404).json({ error: 'Customer not found' });
  delete db.data.customers[phone];
  for (const [token, p] of Object.entries(db.data.customerSessions)) {
    if (p === phone) delete db.data.customerSessions[token];
  }
  await db.write();
  res.json({ success: true });
});

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

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, err => { if (err) res.status(200).send('MINI GT API running'); });
});

app.listen(CONFIG.PORT);
