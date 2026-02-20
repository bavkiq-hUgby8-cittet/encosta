const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Payment, Preference, OAuth } = require('mercadopago');
const admin = require('firebase-admin');

// ── Crash protection: prevent server from dying on unhandled errors ──
process.on('uncaughtException', (err) => {
  console.error('🔴 Uncaught Exception:', err.message, err.stack?.split('\n').slice(0,3).join('\n'));
});
process.on('unhandledRejection', (reason) => {
  console.error('🔴 Unhandled Rejection:', reason?.message || reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL routes for static pages
app.get('/site', (req, res) => res.sendFile(path.join(__dirname, 'public', 'site.html')));
app.get('/sobre', (req, res) => res.sendFile(path.join(__dirname, 'public', 'site.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));

// ── Firebase Admin SDK ──
const FIREBASE_SA = process.env.FIREBASE_SERVICE_ACCOUNT;
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL || 'https://encosta-f32e7-default-rtdb.firebaseio.com';
if (FIREBASE_SA) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SA)), databaseURL: FIREBASE_DB_URL });
} else {
  const saPath = path.join(__dirname, 'firebase-sa.json');
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)), databaseURL: FIREBASE_DB_URL });
  } else {
    console.warn('⚠️ Firebase não configurado. Rodando sem persistência.');
    admin.initializeApp({ projectId: 'encosta-f32e7', databaseURL: FIREBASE_DB_URL });
  }
}
const rtdb = admin.database();
const firebaseAuth = admin.auth();
const storageBucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET || 'encosta-f32e7.firebasestorage.app');

// ── Upload base64 image to Firebase Storage, return public URL ──
async function uploadBase64ToStorage(base64Data, filePath) {
  try {
    // Strip data:image/xxx;base64, prefix if present
    const base64Str = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Str, 'base64');
    const file = storageBucket.file(filePath);
    await file.save(buffer, {
      contentType: 'image/jpeg',
      metadata: { cacheControl: 'public, max-age=31536000' },
      public: true
    });
    return `https://storage.googleapis.com/${storageBucket.name}/${filePath}`;
  } catch (e) {
    console.error('❌ Storage upload error:', e.message);
    return null; // fallback: caller keeps base64
  }
}

// ── Database (in-memory cache synced with Firebase Realtime Database) ──
const DB_COLLECTIONS = ['users', 'sessions', 'relations', 'messages', 'encounters', 'gifts', 'declarations', 'events', 'checkins', 'tips', 'streaks', 'locations', 'revealRequests', 'likes', 'starDonations', 'operatorEvents', 'docVerifications', 'faceData', 'gameConfig', 'subscriptions', 'verifications', 'faceAccessLog'];
let db = {};
DB_COLLECTIONS.forEach(c => db[c] = {});
let dbLoaded = false;
let saveTimer = null;
let registrationCounter = 0; // global signup order

// ── Top Tag Calculation ──
function calculateTopTag(order, totalUsers) {
  const tiers = [
    { max: 1, tag: 'top1', needTotal: 5 },
    { max: 5, tag: 'top5', needTotal: 50 },
    { max: 50, tag: 'top50', needTotal: 100 },
    { max: 100, tag: 'top100', needTotal: 1000 },
    { max: 1000, tag: 'top1000', needTotal: 5000 },
    { max: 5000, tag: 'top5000', needTotal: 10000 },
    { max: 10000, tag: 'top10000', needTotal: 100000 },
    { max: 100000, tag: 'top100000', needTotal: 200000 }
  ];
  for (const t of tiers) {
    if (order <= t.max && totalUsers >= t.needTotal) return t.tag;
  }
  // Always show top1 even with few users
  if (order === 1) return 'top1';
  return null;
}

// Helper: promise with timeout
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms))
  ]);
}

async function loadDB() {
  console.log('🔄 loadDB() iniciando... RTDB URL:', FIREBASE_DB_URL);
  try {
    // Load from Firebase Realtime Database (with 15s timeout)
    console.log('📡 Tentando conectar ao RTDB...');
    const snapshot = await withTimeout(rtdb.ref('/').once('value'), 15000, 'RTDB read');
    const data = snapshot.val();
    if (data) {
      DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
      const userCount = Object.keys(db.users).length;
      console.log(`✅ DB carregado do Firebase Realtime Database (${userCount} users)`);
    } else {
      console.log('ℹ️ RTDB vazio, tentando migração...');
      // Try Firestore migration (one-time)
      try {
        const firestore = admin.firestore();
        const fsDoc = await withTimeout(firestore.collection('app').doc('state').get(), 10000, 'Firestore read');
        if (fsDoc.exists) {
          const fsData = fsDoc.data();
          DB_COLLECTIONS.forEach(c => { db[c] = fsData[c] || {}; });
          // Migrate to RTDB
          const updates = {};
          DB_COLLECTIONS.forEach(c => { updates[c] = db[c]; });
          await withTimeout(rtdb.ref('/').update(updates), 15000, 'RTDB migration write');
          console.log('✅ DB migrado do Firestore → Realtime Database');
        }
      } catch (migErr) {
        console.log('ℹ️ Sem dados no Firestore para migrar:', migErr.message);
      }
      // Fallback: try local db.json
      if (!Object.keys(db.users).length) {
        const DB_FILE = path.join(__dirname, 'db.json');
        if (fs.existsSync(DB_FILE)) {
          const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
          DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
          // Migrate to RTDB (best effort)
          try {
            const updates = {};
            DB_COLLECTIONS.forEach(c => { updates[c] = db[c]; });
            await withTimeout(rtdb.ref('/').update(updates), 10000, 'RTDB db.json migration');
            console.log('✅ DB migrado de db.json → Realtime Database');
          } catch (migErr2) {
            console.warn('⚠️ db.json carregado mas não migrou para RTDB:', migErr2.message);
          }
        } else {
          console.log('📦 DB novo criado (vazio)');
        }
      }
    }
    dbLoaded = true;
    initRegistrationCounter();
  } catch (e) {
    console.error('❌ Erro ao carregar DB:', e.message);
    console.log('🔄 Usando fallback local...');
    const DB_FILE = path.join(__dirname, 'db.json');
    try {
      if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
        console.log('✅ DB carregado de db.json (fallback)');
      } else {
        console.log('📦 DB novo criado (sem RTDB, sem db.json)');
      }
    } catch (e2) {
      console.error('❌ Fallback db.json também falhou:', e2.message);
    }
    dbLoaded = true;
    initRegistrationCounter();
  }
}

function initRegistrationCounter() {
  // Set counter from existing users, migrate missing fields
  const users = Object.values(db.users);
  registrationCounter = users.length;
  // Sort by createdAt to assign registrationOrder to existing users missing it
  const sorted = [...users].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  sorted.forEach((u, i) => {
    if (!u.registrationOrder) u.registrationOrder = i + 1;
    if (!u.canSee) u.canSee = {};
    if (!u.likedBy) u.likedBy = [];
    if (u.likesCount === undefined) u.likesCount = 0;
    if (u.touchers === undefined) u.touchers = 0;
    if (!u.revealedTo) u.revealedTo = [];
  });
  const total = users.length;
  sorted.forEach(u => {
    u.topTag = calculateTopTag(u.registrationOrder, total);
  });
  console.log(`📊 Registration counter: ${registrationCounter}, ${total} users migrated`);
  // Build performance indexes
  rebuildIndexes();
  // Auto-verify Top 1 + grant 50 stars
  ensureTop1Perks();
}

// ══ PERFORMANCE INDEXES (critical for 10M+ users) ══
const IDX = {
  firebaseUid: new Map(),   // firebaseUid → userId
  touchCode: new Map(),     // touchCode → userId
  nickname: new Map(),      // nickname.toLowerCase() → userId
  relationPair: new Map(),  // "a_b" (sorted) → relationId
  relationsByUser: new Map(), // userId → Set of relationIds
  donationsByFrom: new Map(), // fromUserId → [donationIds]
  donationsByPair: new Map(), // "from_to" → count
  uniqueConns: new Map(),   // userId → count (cache)
  operatorByCreator: new Map(), // creatorId → [eventIds]
};

function rebuildIndexes() {
  IDX.firebaseUid.clear(); IDX.touchCode.clear(); IDX.nickname.clear();
  IDX.relationPair.clear(); IDX.relationsByUser.clear();
  IDX.donationsByFrom.clear(); IDX.donationsByPair.clear();
  IDX.operatorByCreator.clear();
  for (const [uid, u] of Object.entries(db.users)) {
    if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, uid);
    if (u.touchCode) IDX.touchCode.set(u.touchCode, uid);
    if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), uid);
  }
  for (const [rid, r] of Object.entries(db.relations)) {
    if (r.userA && r.userB) {
      const key = [r.userA, r.userB].sort().join('_');
      IDX.relationPair.set(key, rid);
      if (!IDX.relationsByUser.has(r.userA)) IDX.relationsByUser.set(r.userA, new Set());
      if (!IDX.relationsByUser.has(r.userB)) IDX.relationsByUser.set(r.userB, new Set());
      IDX.relationsByUser.get(r.userA).add(rid);
      IDX.relationsByUser.get(r.userB).add(rid);
    }
  }
  for (const [did, d] of Object.entries(db.starDonations || {})) {
    if (!IDX.donationsByFrom.has(d.fromUserId)) IDX.donationsByFrom.set(d.fromUserId, []);
    IDX.donationsByFrom.get(d.fromUserId).push(did);
    const pk = d.fromUserId + '_' + d.toUserId;
    IDX.donationsByPair.set(pk, (IDX.donationsByPair.get(pk) || 0) + 1);
  }
  for (const [eid, ev] of Object.entries(db.operatorEvents || {})) {
    if (ev.creatorId) {
      if (!IDX.operatorByCreator.has(ev.creatorId)) IDX.operatorByCreator.set(ev.creatorId, []);
      IDX.operatorByCreator.get(ev.creatorId).push(eid);
    }
  }
  console.log(`🗂️ Indexes built: ${IDX.firebaseUid.size} firebase, ${IDX.touchCode.size} touchCodes, ${IDX.nickname.size} nicknames, ${IDX.relationPair.size} relations, ${IDX.relationsByUser.size} userRels`);
}

// Helper: find active relation between two users in O(1)
function findActiveRelation(userA, userB) {
  const key = [userA, userB].sort().join('_');
  const rid = IDX.relationPair.get(key);
  if (!rid) return null;
  const r = db.relations[rid];
  return (r && r.expiresAt > Date.now()) ? r : null;
}

// Helper: check nickname taken in O(1)
function isNickTaken(nick) { return IDX.nickname.has(nick.toLowerCase()); }

// Helper: register new relation in index
function idxAddRelation(relationId, userA, userB) {
  const key = [userA, userB].sort().join('_');
  IDX.relationPair.set(key, relationId);
  if (!IDX.relationsByUser.has(userA)) IDX.relationsByUser.set(userA, new Set());
  if (!IDX.relationsByUser.has(userB)) IDX.relationsByUser.set(userB, new Set());
  IDX.relationsByUser.get(userA).add(relationId);
  IDX.relationsByUser.get(userB).add(relationId);
}
function getActiveRelationsForUser(userId) {
  const rids = IDX.relationsByUser.get(userId);
  if (!rids) return [];
  const now = Date.now();
  const active = [];
  for (const rid of rids) {
    const r = db.relations[rid];
    if (r && r.expiresAt > now) active.push(r);
  }
  return active;
}
function isOperatorWithTipsCheck(receiverId) {
  const evIds = IDX.operatorByCreator.get(receiverId);
  if (!evIds) return false;
  return evIds.some(eid => {
    const ev = db.operatorEvents[eid];
    return ev && ev.acceptsTips;
  });
}

// Helper: register new user in indexes
function idxAddUser(user) {
  if (user.firebaseUid) IDX.firebaseUid.set(user.firebaseUid, user.id);
  if (user.touchCode) IDX.touchCode.set(user.touchCode, user.id);
  if (user.nickname) IDX.nickname.set(user.nickname.toLowerCase(), user.id);
}

// Helper: count donations from user in O(1)
function countDonationsFrom(userId) { return (IDX.donationsByFrom.get(userId) || []).length; }

// Helper: count donations between pair in O(1)
function countDonationsPair(from, to) { return IDX.donationsByPair.get(from + '_' + to) || 0; }

function ensureTop1Perks() {
  const users = Object.values(db.users);
  if (!users.length) return;
  // Find Top 1 by registration order (first user)
  let top1 = null;
  users.forEach(u => {
    if (u.topTag === 'top1') top1 = u;
  });
  if (!top1) {
    // Fallback: user with registration order 1
    top1 = users.find(u => u.registrationOrder === 1);
  }
  if (!top1) return;
  // Auto-verify
  if (!top1.verified) {
    top1.verified = true;
    top1.verifiedAt = Date.now();
    top1.verifiedBy = 'system';
    top1.verificationType = 'top1';
    if (!db.verifications) db.verifications = {};
    db.verifications[top1.id] = { userId: top1.id, verifiedAt: Date.now(), by: 'system', type: 'top1', note: 'Auto-verified as Top 1' };
    console.log(`⭐ Top 1 auto-verified: ${top1.nickname}`);
  }
  // Grant 50 stars if they don't have them yet
  if (!top1.stars) top1.stars = [];
  if (top1.stars.length < 50) {
    const needed = 50 - top1.stars.length;
    for (let i = 0; i < needed; i++) {
      top1.stars.push({ from: 'system', reason: 'top1_perk', timestamp: Date.now() - i * 1000 });
    }
    console.log(`⭐ Top 1 granted ${needed} stars (total: 50): ${top1.nickname}`);
  }
  // Also set isAdmin for Top 1
  if (!top1.isAdmin) {
    top1.isAdmin = true;
    console.log(`👑 Top 1 set as admin: ${top1.nickname}`);
  }
  saveDB('users');
}

// ── Dirty tracking: only write changed collections to RTDB ──
const _dirtyCollections = new Set();

async function flushToRTDB() {
  saveTimer = null;
  const cols = [..._dirtyCollections];
  _dirtyCollections.clear();
  if (!cols.length) return;
  try {
    const updates = {};
    cols.forEach(c => { updates[c] = db[c] || {}; });
    await withTimeout(rtdb.ref('/').update(updates), 15000, 'RTDB flush');
  } catch (e) {
    console.error('❌ RTDB save error:', e.message);
    // Re-add failed collections for retry
    cols.forEach(c => _dirtyCollections.add(c));
    // Fallback: save locally
    try { fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db), 'utf8'); } catch (e2) {}
  }
}

// ── BACKUP SYSTEM: auto-snapshot before destructive ops, rollback support ──
const MAX_BACKUPS = 5;

async function createBackup(reason) {
  try {
    const ts = Date.now();
    const backup = {};
    DB_COLLECTIONS.forEach(c => {
      const count = Object.keys(db[c] || {}).length;
      if (count > 0) backup[c] = db[c];
    });
    const meta = {
      timestamp: ts,
      date: new Date(ts).toISOString(),
      reason: reason || 'manual',
      counts: {}
    };
    DB_COLLECTIONS.forEach(c => { meta.counts[c] = Object.keys(db[c] || {}).length; });
    // Save to RTDB under /backups/{timestamp}
    await withTimeout(rtdb.ref('/backups/' + ts).set({ meta, data: backup }), 20000, 'backup write');
    console.log('💾 BACKUP created:', meta.date, '—', reason, '— counts:', JSON.stringify(meta.counts));
    // Cleanup old backups (keep last MAX_BACKUPS)
    try {
      const bkSnap = await withTimeout(rtdb.ref('/backups').orderByKey().once('value'), 10000, 'backup list');
      const bkData = bkSnap.val();
      if (bkData) {
        const keys = Object.keys(bkData).sort();
        if (keys.length > MAX_BACKUPS) {
          const toDelete = keys.slice(0, keys.length - MAX_BACKUPS);
          const delUpdates = {};
          toDelete.forEach(k => { delUpdates['/backups/' + k] = null; });
          await rtdb.ref('/').update(delUpdates);
          console.log('🧹 Cleaned', toDelete.length, 'old backups');
        }
      }
    } catch (cleanErr) { console.error('Backup cleanup err:', cleanErr.message); }
    return ts;
  } catch (e) {
    console.error('❌ Backup error:', e.message);
    // Fallback: save to local file
    try {
      const bkFile = path.join(__dirname, 'backup-' + Date.now() + '.json');
      fs.writeFileSync(bkFile, JSON.stringify(db), 'utf8');
      console.log('💾 Local backup saved:', bkFile);
    } catch (e2) {}
    return null;
  }
}

async function listBackups() {
  try {
    const snap = await withTimeout(rtdb.ref('/backups').once('value'), 10000, 'backup list');
    const data = snap.val();
    if (!data) return [];
    return Object.entries(data).map(([k, v]) => ({ id: k, ...v.meta })).sort((a, b) => b.timestamp - a.timestamp);
  } catch (e) { return []; }
}

async function restoreBackup(backupId) {
  try {
    const snap = await withTimeout(rtdb.ref('/backups/' + backupId).once('value'), 15000, 'backup read');
    const bk = snap.val();
    if (!bk || !bk.data) throw new Error('Backup não encontrado ou vazio');
    // Create backup of CURRENT state before restoring
    await createBackup('pre-restore-safety');
    // Restore data
    DB_COLLECTIONS.forEach(c => { db[c] = bk.data[c] || {}; });
    // Rebuild indexes
    IDX.nickname.clear(); IDX.firebaseUid.clear();
    if (IDX.operatorByCreator) IDX.operatorByCreator.clear();
    Object.values(db.users).forEach(u => {
      if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), u.id);
      if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, u.id);
    });
    if (db.operatorEvents) {
      Object.values(db.operatorEvents).forEach(ev => {
        if (ev.creatorId && IDX.operatorByCreator) {
          if (!IDX.operatorByCreator.has(ev.creatorId)) IDX.operatorByCreator.set(ev.creatorId, []);
          IDX.operatorByCreator.get(ev.creatorId).push(ev.id);
        }
      });
    }
    // Flush to RTDB
    DB_COLLECTIONS.forEach(c => _dirtyCollections.add(c));
    await flushToRTDB();
    const counts = {};
    DB_COLLECTIONS.forEach(c => { counts[c] = Object.keys(db[c] || {}).length; });
    console.log('✅ RESTORED from backup:', bk.meta.date, '— counts:', JSON.stringify(counts));
    return { ok: true, restoredFrom: bk.meta, counts };
  } catch (e) {
    console.error('❌ Restore error:', e.message);
    throw e;
  }
}

// saveDB(collections...) — mark collections as dirty and schedule flush
// Call with collection names: saveDB('users','relations')
// Call with no args: marks ALL collections dirty (legacy fallback)
function saveDB(...collections) {
  if (collections.length === 0) {
    // Legacy: mark all dirty
    DB_COLLECTIONS.forEach(c => _dirtyCollections.add(c));
  } else {
    collections.forEach(c => _dirtyCollections.add(c));
  }
  if (!saveTimer) {
    saveTimer = setTimeout(flushToRTDB, 2000);
  }
}

// ── Firebase Auth middleware (optional, verifies token if present) ──
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.firebaseUser = await firebaseAuth.verifyIdToken(token);
    } catch (e) { /* token invalid, continue without auth */ }
  }
  next();
}
app.use(verifyFirebaseToken);

// ── Firebase client config endpoint ──
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  });
});

// ── Server-side Email Actions ──
// Firebase Admin SDK generates links but does NOT send emails.
// We use nodemailer to actually deliver them.
const nodemailer = require('nodemailer');

// SMTP transporter — uses env vars, falls back to Firebase SMTP relay
let _mailTransporter = null;
function getMailTransporter() {
  if (_mailTransporter) return _mailTransporter;
  // Option 1: Custom SMTP (Gmail app password, SendGrid, etc.)
  if (process.env.SMTP_HOST) {
    _mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  // Option 2: Gmail with app password
  else if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    _mailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
  }
  return _mailTransporter;
}

async function sendTouchEmail(to, subject, html) {
  const transporter = getMailTransporter();
  if (!transporter) return false;
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.GMAIL_USER || '"Touch?" <noreply@touchirl.com>',
      to, subject, html
    });
    console.log('📧 Email sent to', to, '—', subject);
    return true;
  } catch (e) {
    console.error('📧 Email send failed:', e.message);
    return false;
  }
}

function emailTemplate(title, body, btnText, btnUrl) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0">
<div style="max-width:480px;margin:0 auto;padding:2rem 1.5rem">
<div style="text-align:center;margin-bottom:1.5rem"><span style="font-size:2rem;font-weight:800;color:#ff6b35;letter-spacing:.2em">Touch?</span></div>
<div style="background:#1a1a24;border-radius:16px;padding:1.5rem;border:1px solid rgba(255,255,255,.06)">
<h2 style="margin:0 0 .8rem;color:#fff;font-size:1.1rem">${title}</h2>
<p style="color:#a0a0b0;font-size:.9rem;line-height:1.6;margin:0 0 1.2rem">${body}</p>
<div style="text-align:center"><a href="${btnUrl}" style="display:inline-block;padding:.75rem 2rem;background:linear-gradient(135deg,#ff6b35,#ff4500);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:.9rem">${btnText}</a></div>
</div>
<p style="text-align:center;color:#555;font-size:.7rem;margin-top:1.5rem">Touch? — encontros reais, conexões efêmeras</p>
</div></body></html>`;
}

app.post('/api/auth/send-verification', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório.' });
  try {
    // Get user email from UID
    const userRecord = await firebaseAuth.getUser(uid);
    const email = userRecord.email;
    if (!email) return res.status(400).json({ error: 'Usuário sem email.' });
    if (userRecord.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    // Generate verification link
    const appUrl = process.env.APP_URL || 'https://encosta-push.onrender.com';
    const link = await firebaseAuth.generateEmailVerificationLink(email, { url: appUrl });
    // Send via nodemailer
    const sent = await sendTouchEmail(email,
      'Verifique seu email — Touch?',
      emailTemplate('Verificação de email',
        'Clique no botão abaixo para verificar seu email e ativar sua conta Touch?.',
        'Verificar email', link)
    );
    if (sent) {
      console.log('📧 Verification email sent to', email);
      res.json({ ok: true, sent: true });
    } else {
      // No SMTP configured — return link for client-side fallback
      console.log('📧 No SMTP — returning verification link for', email);
      res.json({ ok: true, sent: false, useClientFallback: true });
    }
  } catch (e) {
    console.error('Send verification error:', e.code || e.message);
    res.status(400).json({ error: e.message || 'Erro ao enviar verificação.' });
  }
});

app.post('/api/auth/send-magic-link', async (req, res) => {
  const { email, returnUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const appUrl = returnUrl || process.env.APP_URL || 'https://encosta-push.onrender.com';
    const link = await firebaseAuth.generateSignInWithEmailLink(email, {
      url: appUrl, handleCodeInApp: true
    });
    // Send via nodemailer
    const sent = await sendTouchEmail(email,
      'Seu link de acesso — Touch?',
      emailTemplate('Login sem senha',
        'Você solicitou acesso ao Touch? sem senha. Clique no botão abaixo para entrar. Este link expira em 1 hora.',
        'Entrar no Touch?', link)
    );
    if (sent) {
      console.log('🔗 Magic link email sent to', email);
      res.json({ ok: true, sent: true });
    } else {
      // No SMTP — return link for client to use fallback
      console.log('🔗 No SMTP — returning magic link for client fallback');
      res.json({ ok: true, sent: false, useClientFallback: true });
    }
  } catch (e) {
    console.error('Magic link error:', e.code || e.message);
    const msgs = { 'auth/user-not-found': 'Email não cadastrado. Crie uma conta primeiro.' };
    res.status(400).json({ error: msgs[e.code] || e.message || 'Erro ao gerar link.' });
  }
});

app.post('/api/auth/send-password-reset', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const appUrl = process.env.APP_URL || 'https://encosta-push.onrender.com';
    const link = await firebaseAuth.generatePasswordResetLink(email, { url: appUrl });
    // Send via nodemailer
    const sent = await sendTouchEmail(email,
      'Recuperar senha — Touch?',
      emailTemplate('Recuperação de senha',
        'Você solicitou a recuperação da sua senha do Touch?. Clique no botão abaixo para criar uma nova senha.',
        'Redefinir senha', link)
    );
    if (sent) {
      console.log('🔑 Password reset email sent to', email);
      res.json({ ok: true, sent: true });
    } else {
      // No SMTP — return link for client fallback
      console.log('🔑 No SMTP — password reset link generated for', email);
      res.json({ ok: true, sent: false, useClientFallback: true });
    }
  } catch (e) {
    console.error('Password reset error:', e.code || e.message);
    const msgs = { 'auth/user-not-found': 'Email não cadastrado.', 'auth/invalid-email': 'Email inválido.' };
    res.status(400).json({ error: msgs[e.code] || e.message || 'Erro ao enviar.' });
  }
});

// ── Link Firebase Auth UID to ENCOSTA user ──
app.post('/api/auth/link', async (req, res) => {
  const { firebaseUid, email, displayName, photoURL, encUserId } = req.body;
  if (!firebaseUid) return res.status(400).json({ error: 'Firebase UID obrigatório.' });

  // Check if firebase user already linked to an ENCOSTA user (O(1) index)
  const existingId = IDX.firebaseUid.get(firebaseUid);
  let existingUser = existingId ? db.users[existingId] : null;
  if (existingUser) {
    // Already linked — return existing
    return res.json({ userId: existingUser.id, user: existingUser, linked: true });
  }

  // If encUserId provided, link Firebase to existing ENCOSTA user
  if (encUserId && db.users[encUserId]) {
    const user = db.users[encUserId];
    user.firebaseUid = firebaseUid;
    user.email = email || user.email;
    if (displayName && !user.name) user.name = displayName;
    if (photoURL) user.photoURL = photoURL;
    IDX.firebaseUid.set(firebaseUid, user.id);
    saveDB('users');
    return res.json({ userId: user.id, user, linked: true });
  }

  // Create new ENCOSTA user from Firebase auth
  const id = uuidv4();
  const nick = (displayName || email?.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20) || 'user' + Math.floor(Math.random() * 9999);
  // Ensure unique nickname
  let finalNick = nick;
  let suffix = 1;
  while (isNickTaken(finalNick)) {
    finalNick = nick + suffix++;
  }
  const color = '#' + ((Math.abs([...finalNick].reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)) % 0xFFFFFF)).toString(16).padStart(6, '0');
  registrationCounter = Math.max(registrationCounter, Object.keys(db.users).length) + 1;
  const totalUsers = Object.keys(db.users).length + 1;
  db.users[id] = {
    id, nickname: finalNick, name: displayName || finalNick, email: email || null,
    firebaseUid, photoURL: photoURL || null,
    birthdate: null, avatar: null, color, createdAt: Date.now(),
    points: 0, pointLog: [], stars: [],
    registrationOrder: registrationCounter, topTag: calculateTopTag(registrationCounter, totalUsers),
    likedBy: [], likesCount: 0, touchers: 0, canSee: {}, revealedTo: []
  };
  idxAddUser(db.users[id]);
  saveDB('users');
  res.json({ userId: id, user: db.users[id], linked: false });
});

// ── MercadoPago Config ──
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const MP_APP_ID = process.env.MP_APP_ID || '';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || '';
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://encosta.onrender.com/mp/callback';
const TOUCH_FEE_PERCENT = parseFloat(process.env.TOUCH_FEE_PERCENT || '10');

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

// Expose public key for frontend SDK
app.get('/api/mp-public-key', (req, res) => {
  res.json({ publicKey: MP_PUBLIC_KEY });
});

const SERVICE_TYPES = [
  { id: 'flanelinha', label: 'Flanelinha / Guardador' },
  { id: 'garcom', label: 'Garçom / Garçonete' },
  { id: 'musico', label: 'Músico de rua' },
  { id: 'artista', label: 'Artista de rua' },
  { id: 'delivery', label: 'Entregador' },
  { id: 'faxineiro', label: 'Faxineiro(a)' },
  { id: 'porteiro', label: 'Porteiro' },
  { id: 'cabeleireiro', label: 'Cabeleireiro(a)' },
  { id: 'outro', label: 'Outro' }
];

// Cleanup expired relations + expired points every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, rel] of Object.entries(db.relations)) {
    if (rel.expiresAt && now > rel.expiresAt) {
      delete db.messages[id];
      delete db.relations[id];
    }
  }
  cleanExpiredPoints();
  saveDB('relations', 'messages');
}, 60000);

// ── PHRASES BANK v2 ── Hundreds of phrases by category + re-encounter tiers
const PHRASES = {
  // ── FIRST ENCOUNTER — nunca se viram ──
  primeiro: [
    "Presença aceita.", "Dois mundos, um gesto.", "Sem esforço. Só verdade.",
    "Afinidade instantânea.", "Conforto raro.", "Se reconheceram de primeira.",
    "Isso não se planeja.", "Encontro que já valeu.", "Dois estranhos a menos.",
    "Sintonia no improviso.", "O gesto disse tudo.", "Conexão sem filtro.",
    "O acaso acertou.", "A cidade conspirou.", "Dois caminhos cruzados.",
    "Universos se tocaram.", "Um toque. Tudo mudou.", "Desconhecidos? Não mais.",
    "O primeiro gesto.", "Começo de tudo.", "O ar mudou.",
    "Algo começou aqui.", "Gravidade entre dois.", "Química de surpresa.",
    "Impossível ignorar.", "O toque ficou.", "Curiosidade recíproca.",
    "Fio invisível.", "Olharam e souberam.", "Isso vai ecoar.",
    "A peça que faltava.", "Mentes em sincronia.", "Potencial detectado.",
    "Sinergia imediata.", "Respeito mútuo.", "Complementares.",
    "Encontro com futuro.", "Parceria inesperada.", "Paletas misturadas.",
    "Faísca criativa.", "Frequência rara.", "Dois universos, uma porta.",
    "Energia que cria.", "O improviso acendeu.", "Tela em branco, a dois.",
    "Encostou. Conectou.", "Sem roteiro. Perfeito.", "Ponto de partida.",
    "Dois sinais. Uma frequência.", "A sorte encontrou vocês.",
    "Zero forçação. Pura sintonia.", "Primeiro capítulo.",
    "O mundo ficou menor.", "Coincidência? Talvez não.",
    "Conexão registrada. Pra sempre.", "Caminhos que se cruzam.",
    "Nem precisou de palavras.", "O universo apresentou vocês.",
    "Um toque vale mil follows.", "Estranhos com afinidade.",
    "Sem script. Funcionou.", "O acaso tem bom gosto.",
    "Duas órbitas, um ponto.", "Encontro não planejado. O melhor tipo.",
    "A vida real surpreende.", "Ninguém esperava. Todos sentiram.",
    "Presentes no mesmo instante.", "Cruzaram no momento certo.",
    "Surpresa bem-vinda.", "Timing perfeito.",
  ],
  // ── RE-ENCOUNTER 2 — segunda vez ──
  reencontro2: [
    "De novo vocês.", "Não foi coincidência.", "O destino insiste.",
    "Segundo round.", "A vida juntou de novo.", "Parece que gostaram.",
    "Voltaram. Bom sinal.", "O universo repetiu.", "Reencontro confirmado.",
    "Dois toques. Zero dúvida.", "De volta ao jogo.", "Repetição com propósito.",
    "Já era esperado.", "Pois é. De novo.", "Sem surpresa. Com alegria.",
    "Quem diria... de novo.", "A sintonia continua.", "Reencontro merecido.",
    "Parece que funciona.", "Segundo capítulo.", "O vínculo fortaleceu.",
    "Não foi à toa da primeira vez.", "De novo? De novo.",
    "O toque lembrou.", "Continuação natural.", "A conexão pediu mais.",
    "Reencontro com gosto de 'eu sabia'.", "Duas vezes não é acaso.",
    "Voltaram com mais certeza.", "O primeiro touch pediu bis.",
  ],
  // ── RE-ENCOUNTER 3-5 — já são chegados ──
  reencontro3a5: [
    "Esses são chegados.", "Já virou rotina boa.", "Amizade em construção.",
    "Terceira vez. Já conta como amigo.", "Vínculo em andamento.",
    "Vocês não desgrudam.", "Relação que cresce.", "Já são parte da paisagem um do outro.",
    "Trio de encontros. Cumplicidade.", "Relação real, confirmada.",
    "Quem encontra 3 vezes, fica.", "Consistência. O segredo do vínculo.",
    "Presença constante.", "Esses se conhecem de verdade.",
    "Mais que conhecidos. Menos que irmãos. Por enquanto.",
    "Se veem tanto que já é rotina.", "Frequência de quem se gosta.",
    "O touch virou hábito.", "Já nem precisa de motivo.",
    "Encontro número e tanto. Quem conta?", "Relação que já tem história.",
    "Esses vivem juntos.", "A constelação agradece.",
    "Firmes. Presentes. Juntos.", "Laço real em formação.",
    "Eles de novo. E a gente adorando.", "Os inseparáveis.",
    "Já são parte da constelação um do outro.", "Vínculo que o tempo prova.",
    "Se perderam, se acharam de novo.", "Consistência é o novo like.",
  ],
  // ── RE-ENCOUNTER 6-10 — frequência alta ──
  reencontro6a10: [
    "Isso aqui já é família.", "Dupla imbatível.", "Encontro de veteranos.",
    "Conexão blindada.", "Relação que não precisa de wi-fi.",
    "Vocês são prova de que presença importa.", "Os fiéis.",
    "Se o touch tivesse prêmio, era de vocês.", "Parceria sólida.",
    "Nível: melhores amigos.", "Laço que ninguém corta.",
    "Juntos de novo. Como sempre.", "A rotina mais bonita.",
    "Quem dera todo mundo tivesse isso.", "Relação real. Sem filtro. Sem prazo.",
    "Os que sempre se encontram.", "Amizade nível estrela.",
    "Isso não é encontro. É compromisso.", "Presença garantida.",
    "Vocês redefinem proximidade.", "Relação que inspira.",
    "Os que provam que o físico importa.", "Touch level: expert.",
    "Referência de conexão real.", "Esses dois... inseparáveis.",
    "Encontro marcado pela vida.", "Consistência que emociona.",
    "Amizade que a constelação celebra.", "Frequência de irmãos.",
    "Vocês são o motivo do Touch existir.",
  ],
  // ── RE-ENCOUNTER 11+ — lendários ──
  reencontro11: [
    "Lendários.", "Relação que virou referência.", "Vocês são o Touch.",
    "A constelação gira em torno disso.", "Os eternos.",
    "Se existisse um hall da fama, vocês estariam lá.",
    "Conexão nível: patrimônio.", "Mais que amigos. Constelação.",
    "Relação que merece documentário.", "Vocês transcenderam o app.",
    "Não precisa mais de pontos. Já é estrela.", "Os imbatíveis.",
    "Encontro número... perdemos a conta.", "Lenda viva.",
    "Relação que a cidade conhece.", "Juntos até a última órbita.",
    "Influenciadores físicos de verdade.", "Top do Touch. Sem contestação.",
    "Vocês são inspiração pra quem começa.", "Conexão que virou história.",
    "Se o Touch fosse livro, vocês seriam o capítulo principal.",
    "Parceria que desafia o tempo.", "Eternos na constelação.",
    "Isso aqui não é app. É vida.", "Os que nunca param de se encontrar.",
    "Relação intocável.", "Amizade com todas as estrelas.",
    "Juntos do começo ao fim.", "Referência absoluta.",
    "A definição de conexão real.",
  ],
  // ── GENERAL / CREATIVE — miscelânea inspiracional ──
  geral: [
    "Conexão com propósito.", "Visões que se somam.", "O próximo passo.",
    "Energia que gera.", "Ideias em colisão.", "Resultado no ar.",
    "Juntos vão mais longe.", "Cor e textura.", "Fora da caixa, juntos.",
    "Inspiração mútua.", "Colisão de ideias.", "Criatividade contagiosa.",
    "Cores diferentes, funcionam.", "Invenção no ar.", "Imaginação dobrada.",
    "Antes e depois.", "Tensão bonita.", "Coragem de continuar.",
    "O silêncio já basta.", "Amizade sem introdução.",
    "Momento presente. Pessoas reais.", "O melhor algoritmo é o acaso.",
    "Nenhum feed mostra isso.", "Isso aqui é ao vivo.",
    "Sem replay. Só o momento.", "O encontro é o conteúdo.",
    "A vida offline tem mais resolução.", "Presente no presente.",
    "O real não precisa de legenda.", "Aconteceu de verdade.",
    "Memória que nenhuma nuvem guarda.", "Touch > scroll.",
    "O melhor post é estar aqui.", "Fora da bolha. No mundo.",
    "Presença é a rede social mais rara.", "A melhor notificação é um abraço.",
    "Onde o sinal acaba, a conexão começa.", "Viver > assistir.",
    "O toque que nenhuma tela substitui.", "Offline nunca foi tão bom.",
  ],
  // ── EVENTS ──
  evento: [
    "Check-in com estilo.", "Presente no rolê.", "A noite começou.",
    "Entrou na história do evento.", "O rolê ficou melhor.",
    "Presença confirmada.", "Chegou quem faltava.", "A festa agradece.",
    "Mais um na pista.", "O evento acaba de começar pra você.",
    "Registrado. Agora aproveita.", "A energia subiu.", "Bem-vindo ao momento.",
    "O rolê é real.", "Check-in feito. Lembranças garantidas.",
  ],
  // ── TIPS / SERVICE ──
  servico: [
    "Gratidão registrada.", "O serviço merece reconhecimento.",
    "Valorizar quem faz bem.", "Gorjeta de quem sentiu.",
    "O trabalho foi notado.", "Presença que valoriza.",
    "Reconhecimento merecido.", "Obrigado pelo serviço.",
    "Conexão profissional, gratidão real.", "O gesto vale mais que o valor.",
  ]
};

// Build flat arrays
const FIRST_PHRASES = [...PHRASES.primeiro, ...PHRASES.geral];
const ALL_PHRASES = [...PHRASES.primeiro, ...PHRASES.geral, ...PHRASES.evento, ...PHRASES.servico];

function randomPhrase() { return FIRST_PHRASES[Math.floor(Math.random() * FIRST_PHRASES.length)]; }

// Smart phrase selection based on encounter count
function smartPhrase(userAId, userBId) {
  const encounters = (db.encounters[userAId] || []).filter(e => e.with === userBId);
  const count = encounters.length; // how many times they've met BEFORE this one
  let pool;
  if (count === 0) pool = PHRASES.primeiro;
  else if (count === 1) pool = PHRASES.reencontro2;
  else if (count <= 4) pool = PHRASES.reencontro3a5;
  else if (count <= 9) pool = PHRASES.reencontro6a10;
  else pool = PHRASES.reencontro11;
  // Mix in some general phrases (20% chance)
  if (Math.random() < 0.2) pool = [...pool, ...PHRASES.geral];
  return pool[Math.floor(Math.random() * pool.length)];
}
function generateCode() { return `ENC-${Math.floor(100 + Math.random() * 900)}`; }

// ── ZODIAC SYSTEM ──
function getZodiacSign(birthdate) {
  if (!birthdate) return null;
  const d = new Date(birthdate);
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'touro';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'gemeos';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'leao';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'virgem';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'escorpiao';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'sagitario';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'capricornio';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'aquario';
  return 'peixes';
}

const ZODIAC_INFO = {
  aries:       { glyph: '♈', name: 'Áries',       element: 'fogo',  trait: 'impulso',    elementName: 'Fogo' },
  touro:       { glyph: '♉', name: 'Touro',       element: 'terra', trait: 'presença',   elementName: 'Terra' },
  gemeos:      { glyph: '♊', name: 'Gêmeos',      element: 'ar',    trait: 'movimento',  elementName: 'Ar' },
  cancer:      { glyph: '♋', name: 'Câncer',       element: 'agua',  trait: 'profundidade', elementName: 'Água' },
  leao:        { glyph: '♌', name: 'Leão',         element: 'fogo',  trait: 'brilho',     elementName: 'Fogo' },
  virgem:      { glyph: '♍', name: 'Virgem',       element: 'terra', trait: 'cuidado',    elementName: 'Terra' },
  libra:       { glyph: '♎', name: 'Libra',        element: 'ar',    trait: 'equilíbrio', elementName: 'Ar' },
  escorpiao:   { glyph: '♏', name: 'Escorpião',    element: 'agua',  trait: 'intensidade', elementName: 'Água' },
  sagitario:   { glyph: '♐', name: 'Sagitário',    element: 'fogo',  trait: 'expansão',   elementName: 'Fogo' },
  capricornio: { glyph: '♑', name: 'Capricórnio',  element: 'terra', trait: 'estrutura',  elementName: 'Terra' },
  aquario:     { glyph: '♒', name: 'Aquário',       element: 'ar',    trait: 'liberdade',  elementName: 'Ar' },
  peixes:      { glyph: '♓', name: 'Peixes',        element: 'agua',  trait: 'intuição',   elementName: 'Água' }
};

// Zodiac compatibility — poetic, element-focused language
const ZODIAC_PHRASES = {
  'fogo+fogo': [
    'duas chamas que se reconhecem no escuro.',
    'isso não se apaga com facilidade.',
    'vocês ardem na mesma direção.',
    'fogo encontra fogo — e o mundo esquenta.',
    'nenhum dos dois sabe ir devagar.',
    'combustão bonita.'
  ],
  'fogo+ar': [
    'o vento sopra — e a chama cresce.',
    'leveza que encontra coragem.',
    'vocês se movem rápido e com propósito.',
    'o ar alimenta o que o fogo ilumina.',
    'inspiração e ação no mesmo gesto.',
    'juntos criam tempestade bonita.'
  ],
  'fogo+terra': [
    'a chama aquece o chão. o chão sustenta a chama.',
    'tensão que constrói.',
    'paixão que aprende paciência.',
    'opostos que se precisam.',
    'a firmeza acalma. o calor transforma.',
    'nada disso é óbvio — e é por isso que funciona.'
  ],
  'fogo+agua': [
    'vapor. quando se encontram, algo muda de estado.',
    'o fogo ilumina. a água aprofunda.',
    'encontro que transforma os dois.',
    'intensidade e sensibilidade no mesmo instante.',
    'nada aqui é superficial.',
    'isso vai deixar marca.'
  ],
  'terra+terra': [
    'dois pés no chão. um silêncio que basta.',
    'raiz encontra raiz — cresce devagar, mas forte.',
    'vocês se entendem sem explicar.',
    'juntos são montanha.',
    'a confiança já estava ali antes do gesto.',
    'solidez rara.'
  ],
  'terra+ar': [
    'o sonho encontra o concreto.',
    'a terra respira quando o ar chega.',
    'pensamento e ação no mesmo movimento.',
    'um expande o que o outro sustenta.',
    'a leveza não diminui a força — amplifica.',
    'equilíbrio entre voar e permanecer.'
  ],
  'terra+agua': [
    'a água nutre. a terra acolhe.',
    'conexão que faz florescer.',
    'cuidado manifesto no gesto.',
    'profundidade encontra segurança.',
    'juntos criam um jardim.',
    'isso cresce naturalmente.'
  ],
  'ar+ar': [
    'ar encontra ar — liberdade compartilhada.',
    'conversa sem fim. e sem necessidade de fim.',
    'duas mentes que voam juntas.',
    'nada disso gosta de ficar parado.',
    'juntos pensam mais longe.',
    'movimento é a linguagem de vocês.'
  ],
  'ar+agua': [
    'o vento move a superfície. revela profundidade.',
    'pensar e sentir no mesmo encontro.',
    'contrastes que se completam.',
    'a razão entende. a emoção sabe.',
    'juntos descobrem o que não esperavam.',
    'nada aqui é previsível.'
  ],
  'agua+agua': [
    'dois oceanos. profundidade infinita.',
    'vocês sentem o que o outro não diz.',
    'corrente que une sem esforço.',
    'intuição compartilhada.',
    'juntos mergulham mais fundo.',
    'silêncio que comunica tudo.'
  ]
};

function getZodiacPhrase(signA, signB) {
  if (!signA || !signB) return null;
  const infoA = ZODIAC_INFO[signA];
  const infoB = ZODIAC_INFO[signB];
  if (!infoA || !infoB) return null;
  // Build element key (sorted to match)
  const elems = [infoA.element, infoB.element].sort();
  const key = elems[0] + '+' + elems[1];
  const phrases = ZODIAC_PHRASES[key];
  if (!phrases || !phrases.length) return null;
  return phrases[Math.floor(Math.random() * phrases.length)];
}

// Helper: record encounter trace (v2 — uses classifyEncounter for smart points)
function recordEncounter(userAId, userBId, phrase, type = 'physical', relationId = null) {
  const uA = db.users[userAId], uB = db.users[userBId];
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  // Classify BEFORE recording (so encounter count is accurate)
  const classA = classifyEncounter(userAId, userBId);
  const classB = classifyEncounter(userBId, userAId);
  const trace = { with: userBId, withName: uB?.nickname || uB?.name || '?', withColor: uB?.color, phrase, timestamp: now, date: today, type, points: classA.points, scoreType: classA.type, chatDurationH: 24, relationId };
  const traceB = { with: userAId, withName: uA?.nickname || uA?.name || '?', withColor: uA?.color, phrase, timestamp: now, date: today, type, points: classB.points, scoreType: classB.type, chatDurationH: 24, relationId };
  if (!db.encounters[userAId]) db.encounters[userAId] = [];
  if (!db.encounters[userBId]) db.encounters[userBId] = [];
  db.encounters[userAId].push(trace);
  db.encounters[userBId].push(traceB);
  // Award score points (uses classification)
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  if (classA.points > 0) db.users[userAId].pointLog.push({ value: classA.points, type: classA.type, with: userBId, timestamp: now });
  if (classB.points > 0) db.users[userBId].pointLog.push({ value: classB.points, type: classB.type, with: userAId, timestamp: now });
  // Update streaks
  updateStreak(userAId, userBId, today);
  // Check star eligibility (streak + milestone)
  checkStarEligibility(userAId, userBId);
}

// ══════════════════════════════════════════════════════════
// ══ GAME CONFIG — All tunable parameters in one place ══
// ══════════════════════════════════════════════════════════
if (!db.gameConfig) db.gameConfig = {};
const DEFAULT_GAME_CONFIG = {
  // Points per connection type
  pointsFirstEncounter: 10,       // First time meeting someone
  pointsReEncounterDiffDay: 8,    // Re-encounter on a different day
  pointsReEncounterSameDay: 4,    // Re-encounter within 24h (2nd time)
  pointsReEncounterSpam: 0,       // 3rd+ encounter within 24h
  pointsCheckin: 2,               // Event check-in
  pointsGift: 1,                  // Gift/declaration
  pointsDeclaration: 2,           // Declaration

  // Anti-farm
  maxScoringPerPair24h: 2,        // Max scoring events per pair within 24h

  // Point decay
  pointDecayDays: 30,             // Points decay to 0 over N days

  // Star earning — milestone
  uniqueConnectionsPerStar: 100,  // Every N unique connections = 1 star earned

  // Star earning — streak (different days with same person)
  daysTogetherPerStar: 5,         // Every N different days with same person = 1 star earned

  // Star earning — score conversion (star shop)
  pointsPerStarSelf: 120,         // Buy a star for yourself costs N points
  pointsPerStarGift: 100,         // Buy a star to gift costs N points

  // Star rarity escalation — each successive star costs more
  starRarityMultiplier: 1.15,     // Each star costs 15% more points than the last

  // Max stars one person can give to another
  maxStarsPerPersonToPerson: 10,  // A can give max N stars to B

  // Top 1 creator privileges
  top1CanSetConfig: true,         // Top 1 user can adjust these parameters
};

function getGameConfig() {
  return { ...DEFAULT_GAME_CONFIG, ...(db.gameConfig || {}) };
}

// ══ SCORING SYSTEM v2 ══
// Points decay over N days. Anti-farm: max 2 scoring events per pair in 24h.
// Score types: first_encounter, re_encounter_diff_day, re_encounter_same_day, spam

function classifyEncounter(userAId, userBId) {
  const cfg = getGameConfig();
  const now = Date.now();
  const DAY_MS = 86400000;
  const encounters = (db.encounters[userAId] || []).filter(e => e.with === userBId);

  // No previous encounters → first encounter
  if (encounters.length === 0) return { type: 'first_encounter', points: cfg.pointsFirstEncounter };

  // Count encounters in last 24h (excluding current one being processed)
  const last24h = encounters.filter(e => (now - e.timestamp) < DAY_MS);
  if (last24h.length >= cfg.maxScoringPerPair24h) {
    return { type: 'spam', points: cfg.pointsReEncounterSpam };
  }

  // Check if we had encounters today already
  const today = new Date(now).toISOString().slice(0, 10);
  const todayEncounters = encounters.filter(e => e.date === today);

  if (todayEncounters.length === 0) {
    // Different day re-encounter
    return { type: 're_encounter_diff_day', points: cfg.pointsReEncounterDiffDay };
  } else if (todayEncounters.length === 1) {
    // 2nd encounter same day
    return { type: 're_encounter_same_day', points: cfg.pointsReEncounterSameDay };
  } else {
    // 3rd+ same day
    return { type: 'spam', points: cfg.pointsReEncounterSpam };
  }
}

function awardPoints(userAId, userBId, type, overridePoints = null) {
  const now = Date.now();
  if (!db.users[userAId]) return;
  if (type === 'checkin') {
    const cfg = getGameConfig();
    const val = overridePoints != null ? overridePoints : cfg.pointsCheckin;
    if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
    db.users[userAId].pointLog.push({ value: val, type: 'checkin', timestamp: now });
    return;
  }
  if (!db.users[userBId]) return;

  // Classify and award
  const classA = classifyEncounter(userAId, userBId);
  const classB = classifyEncounter(userBId, userAId);
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  db.users[userAId].pointLog.push({ value: classA.points, type: classA.type, with: userBId, timestamp: now });
  db.users[userBId].pointLog.push({ value: classB.points, type: classB.type, with: userAId, timestamp: now });
}

function calcScore(userId) {
  const user = db.users[userId];
  if (!user || !user.pointLog) return 0;
  const cfg = getGameConfig();
  const now = Date.now();
  const decayMs = cfg.pointDecayDays * 86400000;
  let total = 0;
  for (const p of user.pointLog) {
    const age = now - p.timestamp;
    if (age >= decayMs) continue;
    const weight = 1 - (age / decayMs);
    total += p.value * weight;
  }
  return Math.round(total * 10) / 10;
}

function calcRawScore(userId) {
  // Raw score without decay — used for star shop purchases
  const user = db.users[userId];
  if (!user || !user.pointLog) return 0;
  let total = 0;
  for (const p of user.pointLog) total += p.value;
  return total;
}

function getUniqueConnections(userId) {
  return new Set((db.encounters[userId] || []).filter(e => !e.isEvent && !(e.with || '').startsWith('evt:')).map(e => e.with)).size;
}

function cleanExpiredPoints() {
  const cfg = getGameConfig();
  const cutoff = Date.now() - (cfg.pointDecayDays * 86400000);
  for (const user of Object.values(db.users)) {
    if (user.pointLog) {
      user.pointLog = user.pointLog.filter(p => p.timestamp > cutoff);
    }
  }
}

// ══ STARS SYSTEM v3 ══
// Stars earned via streaks/milestones MUST be donated immediately.
// Stars bought with points go to self or recipient directly.
// Notification: "fulano ganhou estrela de beltrano" broadcast to network.

function getStars(userId) {
  const user = db.users[userId];
  if (!user) return [];
  return user.stars || [];
}

function earnStarForUser(userId, reason, context = '') {
  const user = db.users[userId];
  if (!user) return;
  user.starsEarned = (user.starsEarned || 0) + 1;
  // Create pending star that MUST be donated
  if (!user.pendingStars) user.pendingStars = [];
  const pendingId = uuidv4();
  user.pendingStars.push({ id: pendingId, reason, context, earnedAt: Date.now() });
  // Emit forced donation event — user MUST choose someone to give this star to
  io.to(`user:${userId}`).emit('star-must-donate', {
    pendingStarId: pendingId,
    reason,
    context,
    totalEarned: user.starsEarned,
    pendingCount: user.pendingStars.length
  });
  saveDB('users');
}

// Calculate how many points the Nth star costs (rarity escalation)
function starCost(starNumber, basePrice) {
  const cfg = getGameConfig();
  // Star 1 = basePrice, Star 2 = basePrice * 1.15, Star 3 = basePrice * 1.15^2, etc.
  return Math.round(basePrice * Math.pow(cfg.starRarityMultiplier, Math.max(0, starNumber - 1)));
}

function checkStarEligibility(userAId, userBId) {
  const cfg = getGameConfig();
  const userA = db.users[userAId];
  const userB = db.users[userBId];
  if (!userA || !userB) return;

  // 1. Streak-based: every N different days with same person
  const key = [userAId, userBId].sort().join('_');
  const streak = db.streaks[key];
  if (streak) {
    // Count different days they met (from streak history)
    const uniqueDays = new Set((streak.history || []).map(h => h.date)).size;
    const starsFromDays = Math.floor(uniqueDays / cfg.daysTogetherPerStar);
    const prevStars = streak._starsAwarded || 0;
    if (starsFromDays > prevStars) {
      for (let i = prevStars; i < starsFromDays; i++) {
        earnStarForUser(userAId, 'streak', `${uniqueDays} dias com ${userB.nickname}`);
        earnStarForUser(userBId, 'streak', `${uniqueDays} dias com ${userA.nickname}`);
      }
      streak._starsAwarded = starsFromDays;
      const payload = {
        streakDays: uniqueDays, starsTotal: starsFromDays, newStar: true,
        unlock: { label: 'Nova estrela!', description: uniqueDays + ' dias juntos = ' + starsFromDays + ' estrela' + (starsFromDays > 1 ? 's' : '') }
      };
      io.to(`user:${userAId}`).emit('streak-unlock', payload);
      io.to(`user:${userBId}`).emit('streak-unlock', payload);
    }
  }

  // 2. Milestone: every N unique connections
  [userAId, userBId].forEach(uid => {
    const u = db.users[uid];
    const uniqueConns = getUniqueConnections(uid);
    u.touchers = uniqueConns;
    const milestonesHit = Math.floor(uniqueConns / cfg.uniqueConnectionsPerStar);
    const currentMilestoneStars = (u._milestone100Stars || 0);
    if (milestonesHit > currentMilestoneStars) {
      u._milestone100Stars = milestonesHit;
      earnStarForUser(uid, 'milestone', `${uniqueConns} conexões únicas`);
    }
  });
}

function awardStar(userId, reason, fromUserId = null) {
  earnStarForUser(userId, reason, fromUserId ? `de ${db.users[fromUserId]?.nickname}` : '');
}

// ── STREAK SYSTEM ──
function updateStreak(userAId, userBId, today) {
  if (!db.streaks) db.streaks = {};
  const key = [userAId, userBId].sort().join('_');
  if (!db.streaks[key]) db.streaks[key] = { users: [userAId, userBId], currentStreak: 0, bestStreak: 0, lastDate: null, history: [], unlocks: [] };
  const s = db.streaks[key];
  if (s.lastDate === today) return;
  if (s.lastDate) {
    const diff = Math.round((new Date(today) - new Date(s.lastDate)) / 86400000);
    if (diff === 1) { s.currentStreak += 1; } else { s.currentStreak = 1; }
  } else { s.currentStreak = 1; }
  s.lastDate = today;
  if (s.currentStreak > s.bestStreak) s.bestStreak = s.currentStreak;
  s.history.push({ date: today, streak: s.currentStreak });
  saveDB('streaks');
}

// ── NFC / QR WEB LINK ──
// Generate a unique touch link for a user (works without app)
app.post('/api/touch-link/create', (req, res) => {
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const user = db.users[userId];
  // Generate or reuse touch code
  if (!user.touchCode) {
    user.touchCode = uuidv4().replace(/-/g, '').slice(0, 12);
    IDX.touchCode.set(user.touchCode, userId);
    saveDB('users');
  }
  const baseUrl = req.protocol + '://' + req.get('host');
  res.json({ touchCode: user.touchCode, url: baseUrl + '/t/' + user.touchCode, nfcUrl: baseUrl + '/t/' + user.touchCode });
});

// Touch link page — serves the web experience for NFC/QR scan
app.get('/t/:code', (req, res) => {
  const code = req.params.code;
  const owner = db.users[IDX.touchCode.get(code)];
  if (!owner) return res.status(404).send('Link inválido.');
  // Serve a lightweight touch page
  res.send(generateTouchPage(owner, code));
});

// Touch link action — when visitor submits their name on the touch page
app.post('/api/touch-link/connect', (req, res) => {
  const { touchCode, visitorNickname } = req.body;
  if (!touchCode || !visitorNickname) return res.status(400).json({ error: 'Dados inválidos.' });
  const owner = db.users[IDX.touchCode.get(touchCode)];
  if (!owner) return res.status(404).json({ error: 'Código inválido.' });
  const nick = visitorNickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname: 2 a 20 caracteres.' });
  // Check if visitor already exists
  const existingVisitorId = IDX.nickname.get(nick.toLowerCase());
  let visitor = existingVisitorId ? db.users[existingVisitorId] : null;
  if (!visitor) {
    const id = uuidv4();
    const color = nickColor(nick);
    visitor = { id, nickname: nick, name: nick, birthdate: null, avatar: null, color, createdAt: Date.now(), points: 0, pointLog: [], stars: [], isGuest: true };
    db.users[id] = visitor;
    idxAddUser(visitor);
  }
  if (visitor.id === owner.id) return res.status(400).json({ error: 'Não pode dar touch em si mesmo.' });
  // Create relation
  const now = Date.now();
  const phrase = smartPhrase(owner.id, visitor.id);
  const relationId = uuidv4();
  // Check existing (O(1) via index)
  const existing = findActiveRelation(owner.id, visitor.id);
  let expiresAt;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = phrase;
    existing.renewed = (existing.renewed || 0) + 1;
    expiresAt = existing.expiresAt;
    res.json({ relationId: existing.id, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, renewed: true });
  } else {
    db.relations[relationId] = { id: relationId, userA: owner.id, userB: visitor.id, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null };
    idxAddRelation(relationId, owner.id, visitor.id);
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
    res.json({ relationId, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, renewed: false });
  }
  recordEncounter(owner.id, visitor.id, phrase, 'physical');
  saveDB('users', 'relations', 'messages', 'encounters');
  // Notify owner
  const signOwner = getZodiacSign(owner.birthdate);
  const signVisitor = getZodiacSign(visitor.birthdate);
  const zodiacPhrase = getZodiacPhrase(signOwner, signVisitor);
  const responseData = {
    relationId: existing ? existing.id : relationId, phrase, expiresAt, renewed: !!existing,
    userA: { id: owner.id, name: owner.nickname, realName: owner.realName || null, color: owner.color, profilePhoto: owner.profilePhoto || null, photoURL: owner.photoURL || null, score: calcScore(owner.id), stars: (owner.stars || []).length, sign: signOwner, signInfo: signOwner ? ZODIAC_INFO[signOwner] : null, isPrestador: !!owner.isPrestador, serviceLabel: owner.serviceLabel || '', verified: !!owner.verified },
    userB: { id: visitor.id, name: visitor.nickname, realName: visitor.realName || null, color: visitor.color, profilePhoto: visitor.profilePhoto || null, photoURL: visitor.photoURL || null, score: calcScore(visitor.id), stars: (visitor.stars || []).length, sign: signVisitor, signInfo: signVisitor ? ZODIAC_INFO[signVisitor] : null, isPrestador: !!visitor.isPrestador, serviceLabel: visitor.serviceLabel || '', verified: !!visitor.verified },
    zodiacPhrase
  };
  io.to(`user:${owner.id}`).emit('relation-created', responseData);
});

// Streak info endpoint
app.get('/api/streak/:userId/:partnerId', (req, res) => {
  const key = [req.params.userId, req.params.partnerId].sort().join('_');
  const s = db.streaks?.[key];
  if (!s) return res.json({ currentStreak: 0, bestStreak: 0, starsEarned: 0, daysToNextStar: 5, progress: 0 });
  const starsEarned = s._starsAwarded || Math.floor(s.currentStreak / 5);
  const daysInCycle = s.currentStreak % 5;
  const daysToNextStar = 5 - daysInCycle;
  const progress = Math.round((daysInCycle / 5) * 100);
  res.json({ currentStreak: s.currentStreak, bestStreak: s.bestStreak, lastDate: s.lastDate, starsEarned, daysToNextStar, progress });
});

function generateTouchPage(owner, code) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Touch? — ${owner.nickname}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#050508;color:#e8e6e3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{width:100%;max-width:360px;text-align:center;padding:2rem}
.logo{font-size:.7rem;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,107,53,.6);margin-bottom:2rem}
.avatar{width:80px;height:80px;border-radius:50%;background:${owner.color};display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:800;color:#fff;margin:0 auto 1rem}
.name{font-size:1.4rem;font-weight:700;margin-bottom:.5rem}
.sub{font-size:.8rem;color:rgba(232,230,227,.5);margin-bottom:2rem}
.stars{color:#fbbf24;font-size:.85rem;margin-bottom:2rem}
input{width:100%;padding:.8rem 1rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#e8e6e3;font-size:.9rem;font-family:inherit;outline:none;margin-bottom:.8rem;text-align:center}
input:focus{border-color:#ff6b35}
button{width:100%;padding:.9rem;background:linear-gradient(135deg,#ff6b35,#e85d2a);border:none;border-radius:12px;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;letter-spacing:.05em}
button:active{transform:scale(.97)}
.result{display:none;animation:fadeIn .5s ease}
.phrase{font-size:1.1rem;font-style:italic;color:rgba(255,107,53,.9);margin:1.5rem 0;line-height:1.5}
.timer{font-family:'Courier New',monospace;font-size:.8rem;color:rgba(232,230,227,.4)}
.cta{margin-top:2rem;font-size:.75rem;color:rgba(232,230,227,.3)}
.cta a{color:#ff6b35;text-decoration:none}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
</style></head><body>
<div class="card">
<div class="logo">Touch?</div>
<div id="form">
<div class="avatar">${(owner.nickname || '??').slice(0, 2).toUpperCase()}</div>
<div class="name">${owner.nickname}</div>
${(owner.stars || []).length > 0 ? '<div class="stars">' + '⭐'.repeat(Math.min((owner.stars || []).length, 10)) + '</div>' : ''}
<div class="sub">quer dar um touch com você</div>
<input type="text" id="nick" placeholder="Seu nickname" maxlength="20" autocomplete="off">
<button onclick="connect()">👆 TOUCH</button>
</div>
<div id="result" class="result">
<div class="sub">Vocês se tocaram! ✨</div>
<div class="phrase" id="phrase"></div>
<div class="timer">24h juntos a partir de agora</div>
<div class="cta">Baixe o app para a experiência completa<br><a href="/">Abrir Touch?</a></div>
</div>
</div>
<script>
async function connect(){
  const nick=document.getElementById('nick').value.trim();
  if(!nick||nick.length<2)return alert('Nickname precisa ter 2+ caracteres');
  try{
    const r=await fetch('/api/touch-link/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({touchCode:'${code}',visitorNickname:nick})});
    const d=await r.json();
    if(d.error)return alert(d.error);
    document.getElementById('form').style.display='none';
    document.getElementById('result').style.display='block';
    document.getElementById('phrase').textContent='"'+d.phrase+'"';
    localStorage.setItem('touch_userId',d.visitorId);
    localStorage.setItem('touch_userName',nick);
  }catch(e){alert('Erro de conexão.')}
}
document.getElementById('nick').addEventListener('keydown',e=>{if(e.key==='Enter')connect()});
</script></body></html>`;
}

// ── REST API ──

// Nickname color hash — deterministic color from nickname
function nickColor(nick) {
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = nick.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
}

// Check nickname availability
app.get('/api/check-nick/:nick', (req, res) => {
  const nick = req.params.nick.toLowerCase().trim();
  const taken = isNickTaken(nick);
  res.json({ available: !taken });
});

app.post('/api/register', (req, res) => {
  const { nickname, birthdate, acceptedTerms, userId } = req.body;
  if (!nickname || !birthdate || !acceptedTerms) return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
  const nick = nickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname deve ter 2 a 20 caracteres.' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(nick)) return res.status(400).json({ error: 'Só letras, números, _ . -' });

  // If userId provided, update existing user (from Firebase Auth link)
  if (userId && db.users[userId]) {
    const existing = db.users[userId];
    // Check nick uniqueness (exclude self)
    const existingNickId = IDX.nickname.get(nick.toLowerCase());
    if (existingNickId && existingNickId !== userId) return res.status(400).json({ error: 'Esse nickname já existe.' });
    if (existing.nickname) IDX.nickname.delete(existing.nickname.toLowerCase());
    IDX.nickname.set(nick.toLowerCase(), userId);
    existing.nickname = nick;
    existing.name = existing.name || nick;
    existing.birthdate = birthdate;
    existing.color = existing.color || nickColor(nick);
    saveDB('users');
    return res.json({ userId, user: existing });
  }

  // Check uniqueness for new user
  const taken = isNickTaken(nick);
  if (taken) return res.status(400).json({ error: 'Esse nickname já existe.' });
  const id = uuidv4();
  const color = nickColor(nick);
  registrationCounter = Math.max(registrationCounter, Object.keys(db.users).length) + 1;
  const totalUsers = Object.keys(db.users).length + 1;
  db.users[id] = {
    id, nickname: nick, name: nick, birthdate, avatar: null, color, createdAt: Date.now(),
    points: 0, pointLog: [], stars: [],
    registrationOrder: registrationCounter, topTag: calculateTopTag(registrationCounter, totalUsers),
    likedBy: [], likesCount: 0, touchers: 0, canSee: {}, revealedTo: []
  };
  idxAddUser(db.users[id]);
  saveDB('users');
  res.json({ userId: id, user: db.users[id] });
});

app.get('/api/user/:id', (req, res) => {
  const user = db.users[req.params.id];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const sign = getZodiacSign(user.birthdate);
  res.json({ ...user, sign, signInfo: sign ? ZODIAC_INFO[sign] : null });
});

app.post('/api/session/create', (req, res) => {
  const { userId, isServiceTouch, isCheckin } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const code = generateCode();
  const sessionId = uuidv4();
  db.sessions[sessionId] = {
    id: sessionId, code, userA: userId, userB: null, status: 'waiting', createdAt: Date.now(),
    isServiceTouch: !!isServiceTouch, serviceProviderId: isServiceTouch ? userId : null,
    isCheckin: !!isCheckin, operatorId: isCheckin ? userId : null
  };
  saveDB('sessions');
  res.json({ sessionId, code, isServiceTouch: !!isServiceTouch, isCheckin: !!isCheckin });
});

// Join session → instant relation + encounter trace
app.post('/api/session/join', (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const session = Object.values(db.sessions).find(s => s.code === code && s.status === 'waiting');
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada ou expirada.' });
  if (session.userA === userId) return res.status(400).json({ error: 'Você não pode dar touch em si mesmo.' });

  session.userB = userId;
  session.status = 'completed';
  const userA = db.users[session.userA], userB = db.users[session.userB];
  const now = Date.now();

  const isSessionCheckin = !!session.isCheckin;
  const sessionEventId = session.eventId || null;
  const sessionOperatorId = session.operatorId || null;

  // For check-ins: relation is between VISITOR and EVENT (not operator)
  const codeVisitorId = isSessionCheckin ? userId : null;
  const relA = isSessionCheckin && sessionEventId ? codeVisitorId : session.userA;
  const relB = isSessionCheckin && sessionEventId ? ('evt:' + sessionEventId) : userId;

  const existing = findActiveRelation(relA, relB);

  let relationId, phrase, expiresAt;
  const getPhrase = () => {
    if (isSessionCheckin) return PHRASES.evento[Math.floor(Math.random() * PHRASES.evento.length)];
    if (session.isServiceTouch) return PHRASES.servico[Math.floor(Math.random() * PHRASES.servico.length)];
    return smartPhrase(session.userA, session.userB);
  };

  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = getPhrase();
    existing.renewed = (existing.renewed || 0) + 1;
    existing.provocations = {};
    relationId = existing.id; phrase = existing.phrase; expiresAt = existing.expiresAt;
  } else {
    phrase = getPhrase();
    relationId = uuidv4();
    db.relations[relationId] = { id: relationId, userA: relA, userB: relB, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null, eventId: sessionEventId, isEventCheckin: isSessionCheckin && !!sessionEventId };
    idxAddRelation(relationId, relA, relB);
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
  }

  // Record encounter — for check-ins, record with event not operator
  const encounterType = isSessionCheckin ? 'checkin' : (session.isServiceTouch ? 'service' : 'physical');
  if (isSessionCheckin && sessionEventId && codeVisitorId) {
    const evObj = db.operatorEvents[sessionEventId];
    const evName = evObj ? evObj.name : 'Evento';
    if (!db.encounters[codeVisitorId]) db.encounters[codeVisitorId] = [];
    db.encounters[codeVisitorId].push({ with: 'evt:' + sessionEventId, withName: evName, withColor: '#60a5fa', phrase, timestamp: now, date: new Date(now).toISOString().slice(0,10), type: 'checkin', points: 1, chatDurationH: 24, relationId, isEvent: true });
    awardPoints(codeVisitorId, null, 'checkin');
    // Add to event participants
    if (evObj && !evObj.participants.includes(codeVisitorId)) {
      evObj.participants.push(codeVisitorId);
      evObj.checkinCount = evObj.participants.length;
    }
  } else {
    recordEncounter(session.userA, userId, phrase, encounterType);
  }
  session.relationId = relationId;
  saveDB('sessions', 'relations', 'messages', 'encounters');

  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const zodiacPhrase = (isSessionCheckin || session.isServiceTouch) ? null : getZodiacPhrase(signA, signB);
  const zodiacInfoA = signA ? ZODIAC_INFO[signA] : null;
  const zodiacInfoB = signB ? ZODIAC_INFO[signB] : null;

  const operatorUser = isSessionCheckin ? db.users[sessionOperatorId] : null;
  const opRequireRevealJoin = operatorUser && operatorUser.operatorSettings && operatorUser.operatorSettings.requireReveal;
  const sessionEventObj = sessionEventId ? db.operatorEvents[sessionEventId] : null;

  let responseData;
  if (isSessionCheckin && sessionEventId) {
    // Visitor gets event data, not operator data
    responseData = {
      relationId, phrase, expiresAt, renewed: !!existing,
      isServiceTouch: false, isCheckin: true,
      eventId: sessionEventId, eventName: sessionEventObj ? sessionEventObj.name : 'Evento',
      requireReveal: !!opRequireRevealJoin,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (sessionEventObj && sessionEventObj.entryPrice > 0) ? sessionEventObj.entryPrice : 0,
      userA: { id: userB.id, name: userB.nickname || userB.name, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: zodiacInfoB, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', verified: !!userB.verified },
      userB: { id: 'evt:' + sessionEventId, name: sessionEventObj ? sessionEventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true, verified: !!(sessionEventObj && sessionEventObj.verified) },
      zodiacPhrase: null
    };
  } else {
    responseData = {
      relationId, phrase, expiresAt, renewed: !!existing,
      isServiceTouch: !!session.isServiceTouch, isCheckin: false,
      requireReveal: !!opRequireRevealJoin,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      userA: { id: userA.id, name: userA.nickname || userA.name, realName: userA.realName || null, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: zodiacInfoA, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '', verified: !!userA.verified },
      userB: { id: userB.id, name: userB.nickname || userB.name, realName: userB.realName || null, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: zodiacInfoB, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', verified: !!userB.verified },
      zodiacPhrase
    };
  }

  io.to(`session:${session.id}`).emit('relation-created', responseData);
  // Emit to operator if this is a checkin (operator only gets dashboard notification)
  if (isSessionCheckin && sessionOperatorId) {
    const opUser = db.users[sessionOperatorId];
    const visRevealed = !!(opUser && opUser.canSee && opUser.canSee[userId]);
    io.to(`user:${sessionOperatorId}`).emit('checkin-created', {
      userId, nickname: userB.nickname || userB.name, color: userB.color,
      profilePhoto: userB.profilePhoto || userB.photoURL || null,
      timestamp: now, relationId,
      revealed: visRevealed, revealData: visRevealed ? opUser.canSee[userId] : null,
      eventId: sessionEventId || null
    });
  }
  res.json({ sessionId: session.id, ...responseData });
});

app.get('/api/relations/:userId', (req, res) => {
  const userId = req.params.userId, now = Date.now();
  const active = getActiveRelationsForUser(userId);
  const results = active.map(r => {
    const pid = r.userA === userId ? r.userB : r.userA;
    // Check if partner is an event (evt:xxx)
    const isEvent = !!r.isEventCheckin || (typeof pid === 'string' && pid.startsWith('evt:'));
    const evtId = isEvent ? (r.eventId || pid.replace('evt:', '')) : r.eventId;
    const evObj = evtId ? db.operatorEvents[evtId] : null;
    const p = isEvent ? null : db.users[pid];
    const me = db.users[userId];
    // UNILATERAL: canSee check (only for person relations)
    const isRevealed = !isEvent && !!(me?.canSee?.[pid]);
    const iRevealed = !isEvent && !!(p?.canSee?.[userId]);
    const msgs = db.messages[r.id] || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMessageTime = lastMsg ? lastMsg.timestamp : r.createdAt || 0;
    return { ...r,
      partnerName: isEvent ? (evObj?.name || r.eventName || 'Evento') : (p?.nickname || p?.name || '?'),
      partnerColor: isEvent ? '#60a5fa' : (p?.color || '#ff6b35'),
      timeLeft: r.expiresAt - now,
      partnerPhoto: isEvent ? null : (isRevealed ? (p?.profilePhoto || p?.photoURL || null) : null),
      partnerRealName: isEvent ? null : (isRevealed ? (p?.realName || null) : null),
      partnerNickname: isEvent ? (evObj?.name || 'Evento') : (p?.nickname || '?'),
      iRevealedToPartner: isEvent ? false : !!iRevealed,
      partnerRevealedToMe: isEvent ? false : !!isRevealed,
      isEvent,
      eventId: evtId || null,
      eventName: isEvent ? (evObj?.name || r.eventName || null) : null,
      lastMessageTime,
      lastMessagePreview: lastMsg ? (lastMsg.type === 'ephemeral' ? '✨ ' + (lastMsg.text || '').slice(0, 40) : (lastMsg.text || '').slice(0, 40)) : null,
      lastMessageUserId: lastMsg ? lastMsg.userId : null,
      partnerVerified: isEvent ? !!(evObj && evObj.verified) : !!(p && p.verified)
    };
  });
  // Sort by last message time descending (most recent first)
  results.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
  res.json(results);
});

app.get('/api/messages/:relationId', (req, res) => { res.json(db.messages[req.params.relationId] || []); });
app.get('/api/session/:id', (req, res) => {
  const s = db.sessions[req.params.id];
  s ? res.json(s) : res.status(404).json({ error: 'Sessão não encontrada.' });
});

// Encounter trace (personal history)
app.get('/api/encounters/:userId', (req, res) => {
  const list = db.encounters[req.params.userId] || [];
  const enriched = list.slice().reverse().map(e => {
    const other = db.users[e.with];
    const isRevealed = other?.revealedTo?.includes(req.params.userId);
    return { ...e, realName: isRevealed ? (other?.realName || null) : null, profilePhoto: isRevealed ? (other?.profilePhoto || other?.photoURL || null) : null, verified: !!(other && other.verified) };
  });
  res.json(enriched); // newest first
});

// Delete a specific encounter entry
app.delete('/api/encounters/:userId/:timestamp', (req, res) => {
  const userId = req.params.userId;
  const ts = parseInt(req.params.timestamp);
  if (!db.encounters[userId]) return res.json({ ok: true });
  db.encounters[userId] = db.encounters[userId].filter(e => e.timestamp !== ts);
  saveDB('encounters');
  res.json({ ok: true });
});

// Daily counter
app.get('/api/today/:userId', (req, res) => {
  const list = db.encounters[req.params.userId] || [];
  const cutoff = Date.now() - 86400000; // últimas 24h reais
  const recentEnc = list.filter(e => e.timestamp >= cutoff);
  const unique = [...new Set(recentEnc.map(e => e.with))];
  res.json({ count: unique.length });
});

// Constellation — visual network of encounters (no scores exposed)
app.get('/api/constellation/:userId', (req, res) => {
  const list = db.encounters[req.params.userId] || [];
  if (!list.length) return res.json({ nodes: [], links: [], total: 0 });
  // Group by person (skip event encounters — they become event nodes)
  const byPerson = {};
  list.forEach(e => {
    // Skip event encounters — handled separately as event nodes
    if (e.isEvent || (typeof e.with === 'string' && e.with.startsWith('evt:'))) return;
    if (!byPerson[e.with]) byPerson[e.with] = { id: e.with, nickname: e.withName || '?', color: e.withColor || null, encounters: 0, firstDate: e.timestamp, lastDate: e.timestamp, tipsGiven: 0, tipsTotal: 0, lastSelfie: null };
    byPerson[e.with].encounters++;
    if (e.tipAmount && e.tipStatus === 'approved') { byPerson[e.with].tipsGiven++; byPerson[e.with].tipsTotal += e.tipAmount; }
    if (e.timestamp < byPerson[e.with].firstDate) byPerson[e.with].firstDate = e.timestamp;
    if (e.timestamp > byPerson[e.with].lastDate) byPerson[e.with].lastDate = e.timestamp;
  });
  // Enrich with selfies from all relations and real identity if revealed
  Object.values(byPerson).forEach(p => {
    const myRids = IDX.relationsByUser.get(req.params.userId);
    const rels = myRids ? [...myRids].map(rid => db.relations[rid]).filter(r => r && ((r.userA === req.params.userId && r.userB === p.id) || (r.userA === p.id && r.userB === req.params.userId))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : [];
    // Collect ALL selfies from all relations (both mine and theirs)
    p.allSelfies = [];
    rels.forEach(r => {
      if (r.selfie) {
        // Both sides' selfies from this relation
        Object.entries(r.selfie).forEach(([uid, data]) => {
          if (data) p.allSelfies.push({ url: data, userId: uid, relationId: r.id, date: r.createdAt || 0 });
        });
      }
    });
    p.allSelfies.sort((a, b) => b.date - a.date);
    if (rels.length > 0 && rels[0].selfie) {
      p.lastSelfie = rels[0].selfie[p.id] || null;
    }
    const other = db.users[p.id];
    if (other) {
      p.realName = other.realName || null;
      p.profilePhoto = other.profilePhoto || other.photoURL || null;
      p.revealedTo = other.revealedTo || [];
      p.whatsapp = other.whatsapp || other.phone || null;
    }
  });
  const nodes = Object.values(byPerson).map(p => {
    const other = db.users[p.id];
    const me = db.users[req.params.userId];
    // UNILATERAL: canSee means I can see their real data
    const iCanSeeThem = !!(me && me.canSee && me.canSee[p.id]);
    const theyCanSeeMe = !!(other && other.canSee && other.canSee[req.params.userId]);
    // Count unique touchers for this person
    const toucherCount = other ? new Set((db.encounters[p.id] || []).map(e => e.with)).size : 0;
    return {
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      encounters: p.encounters,
      intensity: Math.min(1, 0.3 + Math.log2(p.encounters) * 0.25),
      isPrestador: !!(other && other.isPrestador),
      serviceLabel: (other && other.serviceLabel) || '',
      lastSelfie: p.lastSelfie,
      lastDate: p.lastDate,
      firstDate: p.firstDate,
      // Only show real data if I can see them (they revealed to me)
      realName: iCanSeeThem ? (other.realName || null) : null,
      profilePhoto: iCanSeeThem ? (other.profilePhoto || other.photoURL || null) : null,
      instagram: iCanSeeThem ? (other.instagram || null) : null,
      tipsGiven: p.tipsGiven,
      tipsTotal: p.tipsTotal,
      iRevealedToPartner: !!theyCanSeeMe, // they can see me = I revealed to them
      partnerRevealedToMe: !!iCanSeeThem, // I can see them = they revealed to me
      hasActiveRelation: !!findActiveRelation(req.params.userId, p.id),
      // New fields
      topTag: (other && other.topTag) || null,
      touchers: toucherCount,
      likesCount: iCanSeeThem ? (other.likesCount || 0) : 0,
      starsCount: (other && other.stars) ? other.stars.length : 0,
      score: other ? calcScore(p.id) : 0,
      uniqueConnections: other ? getUniqueConnections(p.id) : 0,
      likedByMe: !!(other && other.likedBy && other.likedBy.includes(req.params.userId)),
      isPrestador: !!(other && other.isPrestador),
      serviceLabel: (other && other.serviceLabel) || null,
      verified: !!(other && other.verified),
      pendingReveal: (() => {
        const pr = Object.values(db.revealRequests).find(rr => rr.status === 'pending' && ((rr.fromUserId === req.params.userId && rr.toUserId === p.id) || (rr.fromUserId === p.id && rr.toUserId === req.params.userId)));
        if (!pr) return null;
        return pr.fromUserId === req.params.userId ? 'sent' : 'received';
      })(),
      // All selfies from encounters together
      allSelfies: (p.allSelfies || []).slice(0, 20),
      // WhatsApp (only when revealed)
      whatsapp: iCanSeeThem ? (p.whatsapp || null) : null,
      giftsReceived: (db.gifts[p.id] || []).length
    };
  });
  // Add event nodes — events the user participated in
  const eventNodes = Object.values(db.operatorEvents).filter(ev => ev.participants && ev.participants.includes(req.params.userId)).map(ev => {
    const userRids = IDX.relationsByUser.get(req.params.userId);
    const lastRel = userRids ? [...userRids].map(rid => db.relations[rid]).find(r => r && r.eventId === ev.id) : null;
    return {
      id: 'evt:' + ev.id, isEvent: true, eventId: ev.id,
      nickname: ev.name, color: '#60a5fa',
      encounters: 1, intensity: 0.6,
      lastDate: lastRel ? lastRel.createdAt : ev.createdAt,
      firstDate: ev.createdAt,
      realName: null, profilePhoto: null, instagram: null,
      tipsGiven: 0, tipsTotal: 0, lastSelfie: null,
      iRevealedToPartner: false, partnerRevealedToMe: false,
      hasActiveRelation: ev.active, topTag: null, touchers: (ev.participants || []).length,
      likesCount: 0, starsCount: 0, likedByMe: false,
      isPrestador: false, serviceLabel: null, pendingReveal: null, verified: !!ev.verified,
      eventActive: ev.active, eventParticipants: (ev.participants || []).length
    };
  });
  nodes.push(...eventNodes);
  // Sort by most recent encounter
  nodes.sort((a, b) => b.lastDate - a.lastDate);
  res.json({ nodes, links: [], total: nodes.length });
});

// Score — calculated with decay
app.get('/api/points/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({ score: calcScore(req.params.userId), stars: (user.stars || []).length, name: user.name });
});
// Alias for tests
app.get('/api/score/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({ score: calcScore(req.params.userId), stars: (user.stars || []).length, name: user.name });
});

// Partner score — requires active relation
app.get('/api/partner-score/:relationId/:userId', (req, res) => {
  const rel = db.relations[req.params.relationId];
  const userId = req.params.userId;
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relação expirada.' });
  if (rel.userA !== userId && rel.userB !== userId) return res.status(403).json({ error: 'Sem permissão.' });
  const partnerId = rel.userA === userId ? rel.userB : rel.userA;
  const partner = db.users[partnerId];
  if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado.' });
  const partnerEnc = db.encounters[partnerId] || [];
  const uniquePeople = [...new Set(partnerEnc.map(e => e.with))].length;
  // Mutual encounters between these two
  const myEnc = db.encounters[userId] || [];
  const mutualCount = myEnc.filter(e => e.with === partnerId).length;
  res.json({ score: calcScore(partnerId), stars: (partner.stars || []).length, name: partner.name, uniquePeople, totalEncounters: partnerEnc.length, mutualEncounters: mutualCount });
});

// Stars detail
app.get('/api/stars/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({ stars: user.stars || [], total: (user.stars || []).length });
});

// Boarding pass data
app.get('/api/boarding-pass/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const enc = db.encounters[req.params.userId] || [];
  const unique = [...new Set(enc.map(e => e.with))].length;
  const firstEnc = enc.length > 0 ? enc[enc.length - 1].timestamp : user.createdAt;
  res.json({
    name: user.nickname || user.name,
    color: user.color,
    score: calcScore(req.params.userId),
    stars: (user.stars || []).length,
    totalEncounters: enc.length,
    uniquePeople: unique,
    memberSince: user.createdAt,
    firstEncounter: firstEnc,
    likesCount: user.likesCount || 0,
    topTag: user.topTag || null,
    starsEarned: user.starsEarned || 0
  });
});

// ── Notifications / Activity Feed ──
// Mark notifications as seen
app.post('/api/notifications/seen', (req, res) => {
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  user.notifSeenAt = Date.now();
  saveDB('users');
  res.json({ ok: true });
});

app.get('/api/notifications/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const seenAt = user.notifSeenAt || 0;
  const notifs = [];
  // 1. Who liked me (from likedBy array)
  (user.likedBy || []).forEach(likerId => {
    const liker = db.users[likerId];
    if (!liker) return;
    const iCanSee = user.canSee && user.canSee[likerId];
    const ts = liker._likedAt?.[userId] || Date.now();
    notifs.push({
      type: 'like',
      fromId: likerId,
      nickname: liker.nickname || liker.name,
      realName: iCanSee ? (liker.realName || null) : null,
      profilePhoto: iCanSee ? (liker.profilePhoto || liker.photoURL || null) : null,
      color: liker.color,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 2. Stars received
  (user.stars || []).forEach(star => {
    const giver = db.users[star.from];
    const ts = star.donatedAt || star.at || Date.now();
    notifs.push({
      type: 'star',
      fromId: star.from,
      nickname: giver ? (giver.nickname || giver.name) : 'Alguém',
      realName: null,
      profilePhoto: null,
      color: giver ? giver.color : '#fbbf24',
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 3. Reveal requests received (pending)
  Object.values(db.revealRequests || {}).forEach(rr => {
    if (rr.toUserId === userId && rr.status === 'pending') {
      const from = db.users[rr.fromUserId];
      if (!from) return;
      const ts = rr.createdAt || Date.now();
      notifs.push({
        type: 'reveal-request',
        fromId: rr.fromUserId,
        nickname: from.nickname || from.name,
        color: from.color,
        requestId: rr.id,
        timestamp: ts,
        seen: ts <= seenAt
      });
    }
  });
  // 4. Friends who earned stars (someone in my network got a star — no donor info)
  const myEncounters = db.encounters[userId] || [];
  const myFriendIds = [...new Set(myEncounters.filter(e => !e.isEvent && !(e.with || '').startsWith('evt:')).map(e => e.with))];
  myFriendIds.forEach(fid => {
    const friend = db.users[fid];
    if (!friend || !friend.stars || !friend.stars.length) return;
    // Show last 3 stars from each friend (recent ones)
    friend.stars.slice(-3).forEach(star => {
      if (star.from === userId) return; // skip my own stars to them
      const ts = star.donatedAt || star.at || Date.now();
      notifs.push({
        type: 'friend-star',
        fromId: fid,
        nickname: friend.nickname || friend.name,
        color: friend.color,
        topTag: friend.topTag || null,
        timestamp: ts,
        seen: ts <= seenAt
      });
    });
  });
  // 5. People who revealed to me (canSee entries)
  Object.entries(user.canSee || {}).forEach(([pid, data]) => {
    const p = db.users[pid];
    if (!p) return;
    const ts = data.revealedAt || Date.now();
    notifs.push({
      type: 'identity-revealed',
      fromId: pid,
      nickname: p.nickname || p.name,
      realName: data.realName || null,
      profilePhoto: data.profilePhoto || null,
      color: p.color,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 6. Star donations in network (broadcast — "fulano ganhou estrela")
  const recentDonations = Object.values(db.starDonations || {}).filter(d => {
    if (d.fromUserId === userId || d.toUserId === userId) return false; // skip own
    const recipInNetwork = myFriendIds.includes(d.toUserId);
    const donorInNetwork = myFriendIds.includes(d.fromUserId);
    return recipInNetwork || donorInNetwork;
  }).slice(-20);
  recentDonations.forEach(d => {
    const recip = db.users[d.toUserId];
    if (!recip) return;
    const ts = d.timestamp || Date.now();
    notifs.push({
      type: 'network-star',
      fromId: d.toUserId,
      nickname: recip.nickname || recip.name,
      color: recip.color,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // Sort by timestamp desc
  notifs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const all = notifs.slice(0, 50);
  const unseenCount = all.filter(n => !n.seen).length;
  res.json({ notifications: all, unseenCount });
});

// Selfie for relation
app.post('/api/selfie/:relationId', async (req, res) => {
  const { userId, selfieData } = req.body;
  const rel = db.relations[req.params.relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relação expirada.' });
  if (rel.userA !== userId && rel.userB !== userId) return res.status(403).json({ error: 'Sem permissão.' });
  if (!rel.selfie) rel.selfie = {};
  // Upload selfie to Storage if base64
  if (selfieData && selfieData.startsWith('data:image')) {
    const url = await uploadBase64ToStorage(selfieData, `photos/selfie/${req.params.relationId}_${userId}.jpg`);
    rel.selfie[userId] = url || selfieData;
  } else {
    rel.selfie[userId] = selfieData;
  }
  saveDB('relations');
  // If both submitted, notify both
  if (rel.selfie[rel.userA] && rel.selfie[rel.userB]) {
    io.to(`user:${rel.userA}`).to(`user:${rel.userB}`).emit('selfie-complete', {
      relationId: req.params.relationId,
      selfie: rel.selfie
    });
  } else {
    // Notify partner that selfie was requested
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('selfie-request', { relationId: req.params.relationId, from: userId });
  }
  res.json({ ok: true });
});

// Delete a specific selfie from a relation
app.delete('/api/selfie/:relationId/:userId', (req, res) => {
  const rel = db.relations[req.params.relationId];
  if (!rel) return res.status(404).json({ error: 'Não encontrada.' });
  if (rel.selfie && rel.selfie[req.params.userId]) {
    delete rel.selfie[req.params.userId];
    if (Object.keys(rel.selfie).length === 0) rel.selfie = null;
    saveDB('relations');
  }
  res.json({ ok: true });
});

// Toggle reveal — user can hide their identity from a partner (unreveal)
app.post('/api/reveal/toggle', (req, res) => {
  const { userId, partnerId, reveal } = req.body;
  if (!userId || !partnerId) return res.status(400).json({ error: 'Dados incompletos.' });
  const partner = db.users[partnerId];
  if (!partner) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!reveal) {
    // Unreveal: remove myself from partner's canSee
    if (partner.canSee && partner.canSee[userId]) {
      delete partner.canSee[userId];
    }
    // Also remove from revealedTo array if it exists
    if (partner.revealedTo) {
      partner.revealedTo = partner.revealedTo.filter(id => id !== userId);
    }
    // Notify partner
    io.to(`user:${partnerId}`).emit('reveal-revoked', { userId });
    saveDB('users');
  }
  res.json({ ok: true });
});

// ── GIFTS CATALOG ──
const GIFT_CATALOG = [
  { id: 'flowers', name: 'Bouquet de Flores', emoji: '💐', needsAddress: true, description: 'Um bouquet entregue com carinho' },
  { id: 'coffee', name: 'Café Especial', emoji: '☕', needsAddress: true, description: 'Um café especial na porta' },
  { id: 'letter', name: 'Carta Selada', emoji: '💌', needsAddress: false, description: 'Uma carta digital com selo Touch?' },
  { id: 'playlist', name: 'Playlist', emoji: '🎵', needsAddress: false, description: 'Uma playlist dedicada' },
  { id: 'star', name: 'Estrela', emoji: '⭐', needsAddress: false, description: 'Uma estrela na constelação da pessoa' },
  { id: 'book', name: 'Livro', emoji: '📖', needsAddress: true, description: 'Um livro surpresa entregue' },
  { id: 'dessert', name: 'Sobremesa', emoji: '🍰', needsAddress: true, description: 'Uma sobremesa entregue' }
];

app.get('/api/gift-catalog', (req, res) => { res.json(GIFT_CATALOG); });

// Send gift — if needsAddress, creates a pending address request
app.post('/api/gift/send', (req, res) => {
  const { relationId, fromUserId, giftId, message } = req.body;
  const rel = db.relations[relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relação expirada.' });
  if (rel.userA !== fromUserId && rel.userB !== fromUserId) return res.status(403).json({ error: 'Sem permissão.' });
  const gift = GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) return res.status(400).json({ error: 'Presente não encontrado.' });
  const toUserId = rel.userA === fromUserId ? rel.userB : rel.userA;
  const fromUser = db.users[fromUserId];
  const id = uuidv4();
  const giftRecord = {
    id, giftId, giftName: gift.name, emoji: gift.emoji, message: message || '',
    from: fromUserId, fromName: fromUser?.nickname || fromUser?.name || '?', fromColor: fromUser?.color,
    to: toUserId, relationId,
    needsAddress: gift.needsAddress,
    addressStatus: gift.needsAddress ? 'pending' : 'none', // pending | accepted | declined | none
    address: null,
    status: gift.needsAddress ? 'awaiting_address' : 'delivered',
    createdAt: Date.now()
  };
  if (!db.gifts[toUserId]) db.gifts[toUserId] = [];
  if (!db.gifts[fromUserId]) db.gifts[fromUserId] = [];
  db.gifts[toUserId].push(giftRecord);
  db.gifts[fromUserId].push({ ...giftRecord, _role: 'sender' });
  saveDB('gifts', 'users');
  // If gift is a star, award a permanent star
  if (giftId === 'star') {
    awardStar(toUserId, 'gift', fromUserId);
    // Also award score points for gifting
    if (!db.users[fromUserId].pointLog) db.users[fromUserId].pointLog = [];
    db.users[fromUserId].pointLog.push({ value: getGameConfig().pointsGift, type: 'gift', timestamp: Date.now() });
    saveDB('users');
  }
  // Notify recipient via socket
  io.to(`user:${toUserId}`).emit('gift-received', { relationId, gift: giftRecord });
  res.json({ ok: true, gift: giftRecord });
});

// Respond to address request (recipient accepts/declines)
app.post('/api/gift/address-response', (req, res) => {
  const { giftId, userId, accepted, address } = req.body;
  // Find in recipient's gifts
  const userGifts = db.gifts[userId] || [];
  const gift = userGifts.find(g => g.id === giftId && g.to === userId);
  if (!gift) return res.status(404).json({ error: 'Presente não encontrado.' });
  if (accepted && address) {
    gift.addressStatus = 'accepted';
    gift.address = address; // stored privately, never exposed to sender
    gift.status = 'processing';
    // Also update in sender's records
    const senderGifts = db.gifts[gift.from] || [];
    const senderGift = senderGifts.find(g => g.id === giftId);
    if (senderGift) { senderGift.addressStatus = 'accepted'; senderGift.status = 'processing'; }
    // Notify sender
    io.to(`user:${gift.from}`).emit('gift-address-accepted', { giftId, giftName: gift.giftName });
  } else {
    gift.addressStatus = 'declined';
    gift.status = 'declined';
    const senderGifts = db.gifts[gift.from] || [];
    const senderGift = senderGifts.find(g => g.id === giftId);
    if (senderGift) { senderGift.addressStatus = 'declined'; senderGift.status = 'declined'; }
    io.to(`user:${gift.from}`).emit('gift-address-declined', { giftId, giftName: gift.giftName });
  }
  saveDB('gifts');
  res.json({ ok: true });
});

// Send declaration/testimonial
app.post('/api/declaration/send', (req, res) => {
  const { relationId, fromUserId, text } = req.body;
  const rel = db.relations[relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relação expirada.' });
  if (rel.userA !== fromUserId && rel.userB !== fromUserId) return res.status(403).json({ error: 'Sem permissão.' });
  if (!text || text.trim().length < 3) return res.status(400).json({ error: 'Declaração muito curta.' });
  if (text.trim().length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres.' });
  const toUserId = rel.userA === fromUserId ? rel.userB : rel.userA;
  const fromUser = db.users[fromUserId];
  const id = uuidv4();
  const decl = {
    id, text: text.trim(),
    from: fromUserId, fromName: fromUser?.nickname || fromUser?.name || '?', fromColor: fromUser?.color,
    to: toUserId, relationId,
    createdAt: Date.now()
  };
  if (!db.declarations[toUserId]) db.declarations[toUserId] = [];
  db.declarations[toUserId].push(decl);
  // Also keep reference for sender
  if (!db.declarations[fromUserId]) db.declarations[fromUserId] = [];
  db.declarations[fromUserId].push({ ...decl, _role: 'author' });
  // Award score points for declaration
  if (!db.users[fromUserId].pointLog) db.users[fromUserId].pointLog = [];
  db.users[fromUserId].pointLog.push({ value: getGameConfig().pointsDeclaration, type: 'declaration', timestamp: Date.now() });
  saveDB('declarations', 'users');
  io.to(`user:${toUserId}`).emit('declaration-received', { relationId, declaration: decl });
  res.json({ ok: true, declaration: decl });
});

// Get user's public profile (declarations, gifts, connections)
app.get('/api/profile/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const enc = db.encounters[req.params.userId] || [];
  const unique = [...new Set(enc.map(e => e.with))].length;
  // Declarations received (public)
  const decls = (db.declarations[req.params.userId] || []).filter(d => !d._role).map(d => ({
    id: d.id, text: d.text, fromName: d.fromName, fromColor: d.fromColor, createdAt: d.createdAt
  }));
  // Gifts received (public, no address info)
  const gifts = (db.gifts[req.params.userId] || []).filter(g => !g._role && g.status !== 'declined').map(g => ({
    id: g.id, giftName: g.giftName, emoji: g.emoji, fromName: g.fromName, fromColor: g.fromColor, message: g.message, createdAt: g.createdAt
  }));
  res.json({
    nickname: user.nickname || user.name,
    color: user.color,
    score: calcScore(req.params.userId),
    stars: (user.stars || []).length,
    totalEncounters: enc.length,
    uniquePeople: unique,
    memberSince: user.createdAt,
    isSubscriber: !!user.isSubscriber,
    isPrestador: !!user.isPrestador,
    declarations: decls.slice(-30),
    gifts: gifts.slice(-30)
  });
});

// Get profile in context of active relation (full view)
app.get('/api/profile/:userId/from/:viewerId', (req, res) => {
  const user = db.users[req.params.userId];
  const viewerId = req.params.viewerId;
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  // Check active relation
  const now = Date.now();
  const hasRelation = !!findActiveRelation(req.params.userId, viewerId);
  if (!hasRelation) return res.status(403).json({ error: 'Sem conexão ativa. Perfil visível apenas durante as 24h.' });
  const enc = db.encounters[req.params.userId] || [];
  const unique = [...new Set(enc.map(e => e.with))].length;
  const decls = (db.declarations[req.params.userId] || []).filter(d => !d._role).map(d => ({
    id: d.id, text: d.text, fromName: d.fromName, fromColor: d.fromColor, createdAt: d.createdAt
  }));
  const gifts = (db.gifts[req.params.userId] || []).filter(g => !g._role && g.status !== 'declined').map(g => ({
    id: g.id, giftName: g.giftName, emoji: g.emoji, fromName: g.fromName, fromColor: g.fromColor, message: g.message, createdAt: g.createdAt
  }));
  // Check if identity was revealed to viewer
  const isRevealed = (user.revealedTo || []).includes(viewerId);
  res.json({
    nickname: user.nickname || user.name,
    color: user.color,
    score: calcScore(req.params.userId),
    stars: (user.stars || []).length,
    starDetails: (user.stars || []).slice(-20),
    totalEncounters: enc.length,
    uniquePeople: unique,
    memberSince: user.createdAt,
    declarations: decls.slice(-50),
    gifts: gifts.slice(-50),
    canInteract: true,
    isSubscriber: !!user.isSubscriber,
    isPrestador: !!user.isPrestador,
    // Real identity if revealed (respecting privacy flags)
    realName: isRevealed ? (user.realName || null) : null,
    profilePhoto: isRevealed ? (user.profilePhoto || user.photoURL || null) : null,
    bio: isRevealed ? (user.bio || null) : null,
    instagram: isRevealed && (user.privacy?.instagram !== false) ? (user.instagram || null) : null,
    tiktok: isRevealed && (user.privacy?.tiktok !== false) ? (user.tiktok || null) : null,
    twitter: isRevealed && (user.privacy?.twitter !== false) ? (user.twitter || null) : null,
    phone: isRevealed && (user.privacy?.phone === true) ? (user.phone || null) : null
  });
});

// ── Update full profile ──
app.post('/api/profile/update', async (req, res) => {
  const { userId, nickname, realName, phone, instagram, tiktok, twitter, bio, profilePhoto, email, cpf, privacy } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const user = db.users[userId];
  // Nickname change
  if (nickname !== undefined && nickname.trim()) {
    const newNick = nickname.trim();
    if (newNick.length < 2 || newNick.length > 20) return res.status(400).json({ error: 'Nickname: 2-20 caracteres.' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(newNick)) return res.status(400).json({ error: 'Nickname: só letras, números, _ . -' });
    // Check uniqueness — allow if same user
    const existingId = IDX.nickname.get(newNick.toLowerCase());
    if (existingId && existingId !== userId) return res.status(400).json({ error: 'Esse nickname já existe.' });
    // Update index
    if (user.nickname) IDX.nickname.delete(user.nickname.toLowerCase());
    IDX.nickname.set(newNick.toLowerCase(), userId);
    user.nickname = newNick;
    user.name = user.name === user.nickname ? newNick : user.name;
  }
  if (realName !== undefined && realName.trim()) {
    if (realName.trim().toLowerCase() === (user.nickname || '').toLowerCase()) {
      return res.status(400).json({ error: 'Seu nome real deve ser diferente do nickname. O nickname é seu apelido criativo!' });
    }
    user.realName = realName.trim();
  } else if (realName !== undefined) { user.realName = realName; }
  if (phone !== undefined) user.phone = phone;
  if (instagram !== undefined) user.instagram = instagram;
  if (tiktok !== undefined) user.tiktok = tiktok;
  if (twitter !== undefined) user.twitter = twitter;
  if (privacy !== undefined) user.privacy = privacy;
  if (bio !== undefined) user.bio = bio;
  if (profilePhoto !== undefined) {
    if (profilePhoto && profilePhoto.length > 2000000) return res.status(400).json({ error: 'Foto muito grande (máx 2MB).' });
    if (profilePhoto && profilePhoto.startsWith('data:image')) {
      // Upload to Firebase Storage instead of storing base64
      const photoUrl = await uploadBase64ToStorage(profilePhoto, `photos/profile/${userId}_${Date.now()}.jpg`);
      user.profilePhoto = photoUrl || profilePhoto; // fallback to base64 if upload fails
    } else {
      user.profilePhoto = profilePhoto;
    }
  }
  if (email !== undefined && email.trim()) user.email = email.trim();
  if (cpf !== undefined && cpf.trim()) user.cpf = cpf.trim();
  user.profileComplete = !!(user.realName && (user.profilePhoto || user.photoURL));
  saveDB('users');
  res.json({ ok: true, user });
});

// ── Reveal Real ID — Centralized system ──
// findActiveRelation already defined in index layer above
function getRelId(rel) { return rel.id || Object.keys(db.relations).find(k => db.relations[k] === rel); }

// ══ REVEAL — DUAS AÇÕES DIFERENTES ══
// 1. "Me revelar" → imediato, sem precisar aceite. Eu decido mostrar minha ID.
// 2. "Solicitar reveal" → peço para o outro se revelar. Precisa aceite.

// ACTION 1: Me revelar (direto, sem aceite)
app.post('/api/identity/reveal', (req, res) => {
  const { userId, targetUserId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  const user = db.users[userId];
  if (!user.realName && !user.profilePhoto && !user.photoURL) return res.status(400).json({ error: 'Complete seu perfil antes de se revelar.' });
  let rel = findActiveRelation(userId, targetUserId);
  if (!rel) {
    const enc = (db.encounters[userId] || []).find(e => e.with === targetUserId);
    if (!enc) return res.status(400).json({ error: 'Sem conexão com essa pessoa.' });
  }
  const relId = rel ? getRelId(rel) : [userId, targetUserId].sort().join('_');
  const target = db.users[targetUserId];
  if (target.canSee && target.canSee[userId]) return res.status(400).json({ error: 'Você já se revelou para essa pessoa.' });
  // DIRETO: target agora pode ver minha identidade (sem precisar aceite)
  if (!target.canSee) target.canSee = {};
  const userPhoto = user.profilePhoto || user.photoURL || null;
  target.canSee[userId] = {
    realName: user.realName || '', profilePhoto: userPhoto,
    instagram: user.instagram || '', bio: user.bio || '',
    revealedAt: Date.now()
  };
  if (!user.revealedTo) user.revealedTo = [];
  if (!user.revealedTo.includes(targetUserId)) user.revealedTo.push(targetUserId);
  // Chat message
  const chatMsg = {
    id: uuidv4(), userId: 'system', type: 'reveal-accepted', timestamp: Date.now(),
    revealedUser: { id: userId, nickname: user.nickname, realName: user.realName || '', profilePhoto: userPhoto, instagram: user.instagram || '', bio: user.bio || '' },
    acceptorId: targetUserId
  };
  if (!db.messages[relId]) db.messages[relId] = [];
  db.messages[relId].push(chatMsg);
  saveDB('users', 'messages');
  io.to(`user:${userId}`).emit('new-message', { relationId: relId, message: chatMsg });
  io.to(`user:${targetUserId}`).emit('new-message', { relationId: relId, message: chatMsg });
  io.to(`user:${targetUserId}`).emit('identity-revealed', {
    fromUserId: userId, realName: user.realName, profilePhoto: userPhoto,
    instagram: user.instagram, bio: user.bio
  });
  io.to(`user:${userId}`).emit('reveal-status-update', { relationId: relId, fromUserId: userId, toUserId: targetUserId, status: 'accepted' });
  res.json({ ok: true, status: 'revealed' });
});

// ACTION 2: Solicitar que o outro se revele (precisa aceite)
app.post('/api/identity/request-reveal', (req, res) => {
  const { userId, targetUserId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  const user = db.users[userId];
  const target = db.users[targetUserId];
  // Check if they already revealed
  if (user.canSee && user.canSee[targetUserId]) return res.status(400).json({ error: 'Essa pessoa já se revelou para você.' });
  let rel = findActiveRelation(userId, targetUserId);
  if (!rel) {
    const enc = (db.encounters[userId] || []).find(e => e.with === targetUserId);
    if (!enc) return res.status(400).json({ error: 'Sem conexão com essa pessoa.' });
  }
  const relId = rel ? getRelId(rel) : [userId, targetUserId].sort().join('_');
  // Check for existing pending request
  const existing = Object.values(db.revealRequests).find(rr =>
    rr.fromUserId === userId && rr.toUserId === targetUserId && rr.status === 'pending'
  );
  if (existing) return res.status(400).json({ error: 'Pedido já enviado. Aguardando resposta.' });
  const reqId = uuidv4();
  db.revealRequests[reqId] = {
    id: reqId, fromUserId: userId, toUserId: targetUserId,
    relationId: relId, status: 'pending', type: 'request-reveal', createdAt: Date.now()
  };
  const chatMsg = {
    id: uuidv4(), userId: 'system', type: 'reveal-request',
    revealRequestId: reqId,
    fromUserId: userId, fromName: user.nickname || user.name || '?',
    fromColor: user.color || '#6baaff',
    requestType: 'ask-to-reveal', // "Eu peço pra você se revelar"
    timestamp: Date.now()
  };
  if (!db.messages[relId]) db.messages[relId] = [];
  db.messages[relId].push(chatMsg);
  saveDB('revealRequests', 'messages');
  io.to(`user:${targetUserId}`).emit('new-message', { relationId: relId, message: chatMsg });
  io.to(`user:${userId}`).emit('new-message', { relationId: relId, message: chatMsg });
  io.to(`user:${targetUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: userId, toUserId: targetUserId, status: 'pending' });
  io.to(`user:${userId}`).emit('reveal-status-update', { relationId: relId, fromUserId: userId, toUserId: targetUserId, status: 'pending' });
  res.json({ ok: true, requestId: reqId, status: 'pending' });
});

// Accept request-reveal: "Alguém pediu pra eu me revelar" → eu aceito → me revelo
// O toUser (quem recebeu o pedido) agora revela SUA identidade para o fromUser (quem pediu)
function acceptRevealInternal(requestId, acceptorUserId, res) {
  const rr = db.revealRequests[requestId];
  if (!rr) return res ? res.status(404).json({ error: 'Pedido não encontrado.' }) : null;
  if (rr.status !== 'pending') return res ? res.status(400).json({ error: 'Pedido já respondido.' }) : null;
  // rr.fromUserId = quem PEDIU pra ver, rr.toUserId = quem foi PEDIDO pra se revelar
  const requester = db.users[rr.fromUserId]; // quem pediu
  const revealer = db.users[rr.toUserId]; // quem vai se revelar (aceitou)
  if (!requester || !revealer) return res ? res.status(400).json({ error: 'Usuário não encontrado.' }) : null;
  if (!revealer.realName && !revealer.profilePhoto && !revealer.photoURL) return res ? res.status(400).json({ error: 'Complete seu perfil antes de se revelar.' }) : null;
  rr.status = 'accepted'; rr.respondedAt = Date.now();
  const revealerPhoto = revealer.profilePhoto || revealer.photoURL || null;
  // O requester (fromUser) agora pode VER o revealer (toUser)
  if (!requester.canSee) requester.canSee = {};
  requester.canSee[rr.toUserId] = {
    realName: revealer.realName || '', profilePhoto: revealerPhoto,
    instagram: revealer.instagram || '', bio: revealer.bio || '',
    revealedAt: Date.now()
  };
  if (!revealer.revealedTo) revealer.revealedTo = [];
  if (!revealer.revealedTo.includes(rr.fromUserId)) revealer.revealedTo.push(rr.fromUserId);
  const relId = rr.relationId;
  const acceptMsg = {
    id: uuidv4(), userId: 'system', type: 'reveal-accepted', timestamp: Date.now(),
    revealRequestId: requestId,
    revealedUser: { id: rr.toUserId, nickname: revealer.nickname, realName: revealer.realName || '', profilePhoto: revealerPhoto, instagram: revealer.instagram || '', bio: revealer.bio || '' },
    acceptorId: rr.toUserId
  };
  if (!db.messages[relId]) db.messages[relId] = [];
  db.messages[relId].push(acceptMsg);
  saveDB('users', 'revealRequests', 'messages');
  io.to(`user:${rr.fromUserId}`).emit('new-message', { relationId: relId, message: acceptMsg });
  io.to(`user:${rr.toUserId}`).emit('new-message', { relationId: relId, message: acceptMsg });
  // fromUser (requester) can now see toUser (revealer)
  io.to(`user:${rr.fromUserId}`).emit('identity-revealed', {
    fromUserId: rr.toUserId, realName: revealer.realName, profilePhoto: revealerPhoto,
    instagram: revealer.instagram, bio: revealer.bio
  });
  io.to(`user:${rr.fromUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'accepted' });
  io.to(`user:${rr.toUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'accepted' });
  if (res) res.json({ ok: true, status: 'accepted' });
}

app.post('/api/identity/reveal-accept', (req, res) => {
  const { revealRequestId, userId, fromUserId } = req.body;
  let reqId = revealRequestId;
  if (!reqId && fromUserId && userId) {
    const found = Object.values(db.revealRequests).find(rr =>
      rr.fromUserId === fromUserId && rr.toUserId === userId && rr.status === 'pending'
    );
    if (found) reqId = found.id;
  }
  if (!reqId) return res.status(400).json({ error: 'Pedido não encontrado.' });
  acceptRevealInternal(reqId, userId, res);
});

app.post('/api/identity/reveal-decline', (req, res) => {
  const { revealRequestId, userId, fromUserId } = req.body;
  let rr = revealRequestId ? db.revealRequests[revealRequestId] : null;
  if (!rr && fromUserId && userId) {
    rr = Object.values(db.revealRequests).find(r => r.fromUserId === fromUserId && r.toUserId === userId && r.status === 'pending');
  }
  if (!rr) return res.status(400).json({ error: 'Pedido não encontrado.' });
  rr.status = 'declined'; rr.respondedAt = Date.now();
  const declineMsg = {
    id: uuidv4(), userId: 'system', type: 'reveal-declined', timestamp: Date.now(),
    revealRequestId: rr.id, declinedBy: userId
  };
  const relId = rr.relationId;
  if (!db.messages[relId]) db.messages[relId] = [];
  db.messages[relId].push(declineMsg);
  saveDB('revealRequests', 'messages');
  io.to(`user:${rr.fromUserId}`).emit('new-message', { relationId: relId, message: declineMsg });
  io.to(`user:${rr.toUserId}`).emit('new-message', { relationId: relId, message: declineMsg });
  io.to(`user:${rr.fromUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'declined' });
  io.to(`user:${rr.toUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'declined' });
  res.json({ ok: true });
});

app.get('/api/identity/pending/:userId', (req, res) => {
  const uid = req.params.userId;
  const pending = Object.values(db.revealRequests).filter(rr =>
    (rr.fromUserId === uid || rr.toUserId === uid) && rr.status === 'pending'
  ).map(rr => ({
    id: rr.id, fromUserId: rr.fromUserId, toUserId: rr.toUserId,
    relationId: rr.relationId, status: rr.status, createdAt: rr.createdAt,
    direction: rr.fromUserId === uid ? 'sent' : 'received'
  }));
  res.json(pending);
});

// ══ LIKE SYSTEM ══
app.post('/api/like/toggle', (req, res) => {
  const { userId, targetUserId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Alvo inválido.' });
  if (userId === targetUserId) return res.status(400).json({ error: 'Não pode curtir a si mesmo.' });
  const target = db.users[targetUserId];
  // Check if already liked
  const existing = Object.values(db.likes).find(l => l.fromUserId === userId && l.toUserId === targetUserId);
  let liked;
  if (existing) {
    // Unlike
    delete db.likes[existing.id];
    if (!target.likedBy) target.likedBy = [];
    target.likedBy = target.likedBy.filter(id => id !== userId);
    target.likesCount = Math.max(0, (target.likesCount || 0) - 1);
    liked = false;
  } else {
    // Like
    const likeId = uuidv4();
    db.likes[likeId] = { id: likeId, fromUserId: userId, toUserId: targetUserId, createdAt: Date.now() };
    if (!target.likedBy) target.likedBy = [];
    if (!target.likedBy.includes(userId)) target.likedBy.push(userId);
    target.likesCount = (target.likesCount || 0) + 1;
    liked = true;
  }
  saveDB('users', 'likes');
  io.to(`user:${targetUserId}`).emit('like-toggled', { fromUserId: userId, liked, count: target.likesCount || 0 });
  res.json({ ok: true, liked, count: target.likesCount || 0 });
});

// ══ STAR DONATION SYSTEM v3 ══
// Earned stars MUST be donated immediately. pendingStarId identifies which pending star.
// Bought stars go directly to self or recipient.

// Search people to donate to (by nickname)
app.get('/api/star/search-people/:userId', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const userId = req.params.userId;
  if (!q || q.length < 1) return res.json({ results: [] });
  const results = [];
  for (const [uid, u] of Object.entries(db.users)) {
    if (uid === userId) continue;
    if (!u.nickname && !u.name) continue;
    const nick = (u.nickname || u.name || '').toLowerCase();
    if (nick.includes(q)) {
      results.push({ id: uid, nickname: u.nickname || u.name, color: u.color, profilePhoto: u.profilePhoto || null, stars: (u.stars || []).length, verified: !!u.verified });
    }
    if (results.length >= 20) break;
  }
  res.json({ results });
});

// Check pending stars
app.get('/api/star/pending/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({ pending: user.pendingStars || [], count: (user.pendingStars || []).length });
});

app.post('/api/star/donate', (req, res) => {
  const { fromUserId, toUserId, pendingStarId } = req.body;
  if (!fromUserId || !db.users[fromUserId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!toUserId || !db.users[toUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  if (fromUserId === toUserId) return res.status(400).json({ error: 'Não pode doar estrela pra si mesmo.' });
  const fromUser = db.users[fromUserId];
  const toUser = db.users[toUserId];

  // If pendingStarId provided, remove it from pending
  if (pendingStarId) {
    if (!fromUser.pendingStars) fromUser.pendingStars = [];
    const idx = fromUser.pendingStars.findIndex(p => p.id === pendingStarId);
    if (idx === -1) return res.status(400).json({ error: 'Estrela pendente não encontrada.' });
    fromUser.pendingStars.splice(idx, 1);
  } else {
    // Legacy: check available stars (earned - donated) — O(1) via index
    const totalEarned = (fromUser.starsEarned || 0);
    const totalDonated = countDonationsFrom(fromUserId);
    const available = totalEarned - totalDonated;
    if (available <= 0) return res.status(400).json({ error: 'Sem estrelas disponíveis para doar.' });
  }

  const donationId = uuidv4();
  db.starDonations[donationId] = { id: donationId, fromUserId, toUserId, timestamp: Date.now(), type: 'earned', pendingStarId };
  // Update indexes
  if (!IDX.donationsByFrom.has(fromUserId)) IDX.donationsByFrom.set(fromUserId, []);
  IDX.donationsByFrom.get(fromUserId).push(donationId);
  IDX.donationsByPair.set(fromUserId + '_' + toUserId, (IDX.donationsByPair.get(fromUserId + '_' + toUserId) || 0) + 1);
  if (!toUser.stars) toUser.stars = [];
  toUser.stars.push({ id: donationId, from: fromUserId, fromName: fromUser.nickname, donatedAt: Date.now(), type: 'earned' });
  saveDB('users', 'starDonations');

  // Notify recipient
  io.to(`user:${toUserId}`).emit('star-received', { fromUserId, fromName: fromUser.nickname, total: toUser.stars.length });

  // Broadcast to network: "fulano ganhou estrela de beltrano"
  const notifPayload = {
    recipientId: toUserId,
    recipientName: toUser.nickname || toUser.name,
    donorId: fromUserId,
    donorName: fromUser.nickname || fromUser.name,
    recipientStars: toUser.stars.length,
    timestamp: Date.now()
  };
  // Send to all users who have encountered either person
  const encA = new Set((db.encounters[fromUserId] || []).map(e => e.with));
  const encB = new Set((db.encounters[toUserId] || []).map(e => e.with));
  const network = new Set([...encA, ...encB]);
  network.delete(fromUserId);
  network.delete(toUserId);
  network.forEach(uid => {
    io.to(`user:${uid}`).emit('star-donated-notification', notifPayload);
  });
  // Also notify donor confirmation
  io.to(`user:${fromUserId}`).emit('star-donation-confirmed', { toUserId, toName: toUser.nickname, recipientStars: toUser.stars.length, pendingRemaining: (fromUser.pendingStars || []).length });

  res.json({ ok: true, donationId, recipientStars: toUser.stars.length, pendingRemaining: (fromUser.pendingStars || []).length });
});

// ══ STAR SHOP — Buy stars with score points ══
app.post('/api/star/buy', (req, res) => {
  const { userId, target } = req.body; // target: 'self' or a userId to gift
  const cfg = getGameConfig();
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const user = db.users[userId];
  const isSelf = !target || target === 'self' || target === userId;
  const recipientId = isSelf ? userId : target;
  if (!db.users[recipientId]) return res.status(400).json({ error: 'Destinatário inválido.' });

  // Calculate cost with rarity escalation
  const recipientUser = db.users[recipientId];
  const currentStars = (recipientUser.stars || []).length;
  const basePrice = isSelf ? cfg.pointsPerStarSelf : cfg.pointsPerStarGift;
  const cost = starCost(currentStars + 1, basePrice);

  // Check if user has enough raw score
  const rawScore = calcRawScore(userId);
  const alreadySpent = user.pointsSpent || 0;
  const spendable = rawScore - alreadySpent;

  if (spendable < cost) {
    return res.status(400).json({ error: `Pontos insuficientes. Custo: ${cost}, Disponível: ${Math.round(spendable)}` });
  }

  // Check max per person if gifting
  if (!isSelf) {
    const existingCount = countDonationsPair(userId, recipientId);
    if (existingCount >= cfg.maxStarsPerPersonToPerson) {
      return res.status(400).json({ error: `Máximo de ${cfg.maxStarsPerPersonToPerson} estrela(s) por pessoa.` });
    }
  }

  // Deduct points
  user.pointsSpent = (user.pointsSpent || 0) + cost;

  // Award star
  const starId = uuidv4();
  if (!recipientUser.stars) recipientUser.stars = [];
  recipientUser.stars.push({ id: starId, from: isSelf ? 'shop_self' : userId, fromName: isSelf ? 'Loja' : user.nickname, donatedAt: Date.now(), type: 'purchased', cost });

  if (!isSelf) {
    db.starDonations[starId] = { id: starId, fromUserId: userId, toUserId: recipientId, timestamp: Date.now(), type: 'purchased', cost };
    io.to(`user:${recipientId}`).emit('star-received', { fromUserId: userId, fromName: user.nickname, total: recipientUser.stars.length });
  }

  saveDB('users');
  io.to(`user:${recipientId}`).emit('star-earned', { reason: 'purchased', context: isSelf ? 'Comprou na loja' : `Presente de ${user.nickname}`, totalEarned: recipientUser.stars.length });
  res.json({ ok: true, starId, cost, recipientStars: recipientUser.stars.length, pointsRemaining: Math.round(rawScore - (user.pointsSpent || 0)) });
});

// Star shop info — prices, available points
app.get('/api/star/shop/:userId', (req, res) => {
  const cfg = getGameConfig();
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const rawScore = calcRawScore(req.params.userId);
  const spendable = rawScore - (user.pointsSpent || 0);
  const currentStars = (user.stars || []).length;
  const selfCost = starCost(currentStars + 1, cfg.pointsPerStarSelf);
  const giftCost = starCost(1, cfg.pointsPerStarGift); // base for gifting
  res.json({ spendablePoints: Math.round(spendable), selfCost, giftCost, currentStars, config: { pointsPerStarSelf: cfg.pointsPerStarSelf, pointsPerStarGift: cfg.pointsPerStarGift, starRarityMultiplier: cfg.starRarityMultiplier } });
});

app.get('/api/stars/available/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const totalEarned = user.starsEarned || 0;
  const totalDonated = countDonationsFrom(req.params.userId);
  res.json({ total: totalEarned, donated: totalDonated, available: totalEarned - totalDonated });
});

// ══ GAME CONFIG — Admin endpoints ══
// Get current config
app.get('/api/admin/game-config', (req, res) => {
  res.json(getGameConfig());
});

// Update config (Top 1 or admin)
app.post('/api/admin/game-config', (req, res) => {
  const { userId, changes } = req.body;
  if (!userId || !changes) return res.status(400).json({ error: 'userId e changes obrigatórios.' });
  const cfg = getGameConfig();
  // Check if user is Top 1 (most stars) or has admin flag
  const user = db.users[userId];
  if (!user) return res.status(403).json({ error: 'Usuário não encontrado.' });
  const isAdmin = user.isAdmin === true;
  let isTop1 = false;
  if (cfg.top1CanSetConfig) {
    // Find user with most stars
    let maxStars = 0, top1Id = null;
    for (const [uid, u] of Object.entries(db.users)) {
      const s = (u.stars || []).length;
      if (s > maxStars) { maxStars = s; top1Id = uid; }
    }
    isTop1 = (userId === top1Id && maxStars > 0);
  }
  if (!isAdmin && !isTop1) return res.status(403).json({ error: 'Apenas o Top 1 ou admin pode alterar configurações.' });
  // Only allow known config keys
  const allowed = Object.keys(DEFAULT_GAME_CONFIG);
  const applied = {};
  for (const [key, val] of Object.entries(changes)) {
    if (allowed.includes(key) && typeof val === typeof DEFAULT_GAME_CONFIG[key]) {
      db.gameConfig[key] = val;
      applied[key] = val;
    }
  }
  saveDB('users');
  res.json({ ok: true, applied, current: getGameConfig() });
});

// ═══ DECLARATIONS — 30-day testimonials ═══
if (!db.declarations) db.declarations = {};

// Send declaration
app.post('/api/declarations/send', (req, res) => {
  const { fromUserId, toUserId, text } = req.body;
  if (!fromUserId || !toUserId || !text) return res.status(400).json({ error: 'Campos obrigatórios.' });
  if (fromUserId === toUserId) return res.status(400).json({ error: 'Não pode declarar para si mesmo.' });
  if (!db.users[fromUserId]) return res.status(400).json({ error: 'Remetente inválido.' });
  if (!db.users[toUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  const cleanText = text.trim().slice(0, 120);
  if (cleanText.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres.' });
  // Max 1 declaration per person per target per 24h
  if (!db.declarations[toUserId]) db.declarations[toUserId] = [];
  const recent = db.declarations[toUserId].find(d => d.fromUserId === fromUserId && Date.now() - d.createdAt < 86400000);
  if (recent) return res.status(400).json({ error: 'Você já enviou uma declaração recentemente. Aguarde 24h.' });
  const decl = {
    id: 'decl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    fromUserId,
    fromNick: db.users[fromUserId].nickname || '??',
    fromColor: db.users[fromUserId].color || '#666',
    text: cleanText,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 86400000 // 30 days
  };
  db.declarations[toUserId].push(decl);
  saveDB('declarations');
  res.json({ ok: true, declaration: decl });
});

// Get declarations for a user (only non-expired)
app.get('/api/declarations/:userId', (req, res) => {
  const userId = req.params.userId;
  const now = Date.now();
  let decls = (db.declarations[userId] || []).filter(d => d.expiresAt > now);
  // Clean expired
  if (db.declarations[userId]) {
    const before = db.declarations[userId].length;
    db.declarations[userId] = decls;
    if (before !== decls.length) saveDB('declarations');
  }
  // Sort newest first
  decls.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ declarations: decls, count: decls.length });
});

// ═══ DOC ID — DOCUMENT VERIFICATION ═══
if (!db.docVerifications) db.docVerifications = {};

app.post('/api/doc/submit', async (req, res) => {
  const { userId, docPhoto, selfiePhoto, docName, cpf, submittedAt } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!docPhoto || !selfiePhoto) return res.status(400).json({ error: 'Fotos obrigatórias.' });
  if (!docName || docName.trim().length < 3) return res.status(400).json({ error: 'Nome do documento obrigatório (mín 3 caracteres).' });

  // Upload doc photos to Firebase Storage
  const ts = Date.now();
  const docUrl = docPhoto.startsWith('data:image') ? (await uploadBase64ToStorage(docPhoto, `docs/${userId}_doc_${ts}.jpg`)) || docPhoto : docPhoto;
  const selfieUrl = selfiePhoto.startsWith('data:image') ? (await uploadBase64ToStorage(selfiePhoto, `docs/${userId}_selfie_${ts}.jpg`)) || selfiePhoto : selfiePhoto;

  db.docVerifications[userId] = {
    userId,
    docPhoto: docUrl,
    selfiePhoto: selfieUrl,
    docName: docName.trim(),
    cpf: cpf || null,
    submittedAt: submittedAt || Date.now(),
    status: 'pending', // pending, approved, rejected
    reviewedAt: null,
    reviewedBy: null
  };
  db.users[userId].docSubmitted = true;
  db.users[userId].docSubmittedAt = Date.now();
  db.users[userId].docStatus = 'pending';
  saveDB('users', 'docVerifications');
  res.json({ ok: true, status: 'pending' });
});

app.get('/api/doc/status/:userId', (req, res) => {
  const doc = db.docVerifications[req.params.userId];
  if (!doc) return res.json({ submitted: false });
  res.json({ submitted: true, status: doc.status, submittedAt: doc.submittedAt, docName: doc.docName });
});

// Admin: approve/reject doc
app.post('/api/doc/review', (req, res) => {
  const { adminId, userId, action } = req.body;
  const admin = db.users[adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const doc = db.docVerifications[userId];
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
  doc.status = action === 'approve' ? 'approved' : 'rejected';
  doc.reviewedAt = Date.now();
  doc.reviewedBy = adminId;
  db.users[userId].docStatus = doc.status;
  if (doc.status === 'approved') db.users[userId].docVerified = true;
  saveDB('users', 'docVerifications');
  res.json({ ok: true, status: doc.status });
});

// Admin: list all doc submissions
app.get('/api/doc/admin/list/:adminId', (req, res) => {
  const admin = db.users[req.params.adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const docs = Object.entries(db.docVerifications).map(([uid, d]) => ({
    userId: uid,
    nickname: db.users[uid]?.nickname || '??',
    docName: d.docName,
    status: d.status,
    submittedAt: d.submittedAt,
    // Don't send photos in list — too heavy
    hasDoc: !!d.docPhoto,
    hasSelfie: !!d.selfiePhoto
  }));
  res.json({ docs, total: docs.length });
});

// Admin: get specific doc for review (with photos)
app.get('/api/doc/admin/review/:adminId/:userId', (req, res) => {
  const admin = db.users[req.params.adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const doc = db.docVerifications[req.params.userId];
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});

// ═══ GIFTS SYSTEM ═══
if (!db.gifts) db.gifts = {};

// Gift count for a user
app.get('/api/gifts/count/:userId', (req, res) => {
  const userId = req.params.userId;
  const gifts = db.gifts[userId] || [];
  res.json({ count: gifts.length, userId });
});

// ═══ FACE ID — BIOMETRIC ENROLLMENT & VERIFICATION ═══
// Face descriptors are 128-dimensional float arrays from face-api.js
// We store ONLY the mathematical descriptors, never raw photos (LGPD Art.11 compliance)
if (!db.faceData) db.faceData = {};

// Enroll face descriptors
app.post('/api/face/enroll', (req, res) => {
  const { userId, descriptors, capturedAt, angles } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!descriptors || !Array.isArray(descriptors) || descriptors.length < 3) {
    return res.status(400).json({ error: 'Mínimo 3 capturas faciais necessárias.' });
  }
  // Validate descriptors (each should be array of 128 floats)
  for (const d of descriptors) {
    if (!Array.isArray(d) || d.length !== 128) {
      return res.status(400).json({ error: 'Descriptor inválido (esperado 128 dimensões).' });
    }
  }
  // Compute average descriptor for faster matching
  const avg = new Array(128).fill(0);
  descriptors.forEach(d => d.forEach((v, i) => avg[i] += v));
  avg.forEach((v, i) => avg[i] = v / descriptors.length);

  db.faceData[userId] = {
    userId,
    descriptors, // all captured angles
    averageDescriptor: avg, // for quick matching
    capturedAt: capturedAt || Date.now(),
    angles: angles || descriptors.length,
    enrolledAt: Date.now(),
    version: 1 // for future model upgrades
  };
  db.users[userId].faceEnrolled = true;
  db.users[userId].faceEnrolledAt = Date.now();
  saveDB('users', 'faceData');
  res.json({ ok: true, enrolled: true });
});

// Remove face data
app.post('/api/face/remove', (req, res) => {
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  delete db.faceData[userId];
  db.users[userId].faceEnrolled = false;
  delete db.users[userId].faceEnrolledAt;
  saveDB('users', 'faceData');
  res.json({ ok: true });
});

// Verify face — compare a live descriptor against enrolled data
// Returns match score and whether it passes threshold
app.post('/api/face/verify', (req, res) => {
  const { targetUserId, liveDescriptor } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId obrigatório.' });
  if (!liveDescriptor || !Array.isArray(liveDescriptor) || liveDescriptor.length !== 128) {
    return res.status(400).json({ error: 'liveDescriptor inválido (128 dimensões).' });
  }
  const faceRecord = db.faceData[targetUserId];
  if (!faceRecord) return res.status(404).json({ error: 'Face ID não cadastrado para este usuário.', enrolled: false });

  // Euclidean distance between two 128-d vectors
  function euclideanDist(a, b) {
    let sum = 0;
    for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  // Compare against all stored descriptors and average
  const distances = faceRecord.descriptors.map(d => euclideanDist(liveDescriptor, d));
  const avgDist = euclideanDist(liveDescriptor, faceRecord.averageDescriptor);
  const minDist = Math.min(...distances);
  const meanDist = distances.reduce((a, b) => a + b, 0) / distances.length;

  // Threshold: face-api.js typically uses 0.6 as "same person" threshold
  const THRESHOLD = 0.6;
  const match = minDist < THRESHOLD;
  const confidence = Math.max(0, Math.min(1, 1 - (minDist / THRESHOLD)));

  res.json({
    match,
    confidence: Math.round(confidence * 100),
    minDistance: Math.round(minDist * 1000) / 1000,
    avgDistance: Math.round(avgDist * 1000) / 1000,
    threshold: THRESHOLD,
    user: match ? { id: targetUserId, nickname: db.users[targetUserId]?.nickname } : null
  });
});

// Identify face — search across ALL enrolled users
// For portaria/condominium access: "who is this person?"
app.post('/api/face/identify', (req, res) => {
  const { liveDescriptor, context } = req.body;
  if (!liveDescriptor || !Array.isArray(liveDescriptor) || liveDescriptor.length !== 128) {
    return res.status(400).json({ error: 'liveDescriptor inválido (128 dimensões).' });
  }

  function euclideanDist(a, b) {
    let sum = 0;
    for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  const THRESHOLD = 0.6;
  const results = [];

  for (const [uid, faceRecord] of Object.entries(db.faceData)) {
    const distances = faceRecord.descriptors.map(d => euclideanDist(liveDescriptor, d));
    const minDist = Math.min(...distances);
    if (minDist < THRESHOLD) {
      const user = db.users[uid];
      const confidence = Math.max(0, Math.min(1, 1 - (minDist / THRESHOLD)));
      results.push({
        userId: uid,
        nickname: user?.nickname || '??',
        realName: user?.realName || null,
        verified: !!user?.verified,
        profilePhoto: user?.profilePhoto || null,
        distance: Math.round(minDist * 1000) / 1000,
        confidence: Math.round(confidence * 100)
      });
    }
  }

  // Sort by confidence (best match first)
  results.sort((a, b) => b.confidence - a.confidence);

  // Log access for audit trail
  if (results.length > 0) {
    if (!db.faceAccessLog) db.faceAccessLog = [];
    db.faceAccessLog.push({
      timestamp: Date.now(),
      matchedUserId: results[0].userId,
      confidence: results[0].confidence,
      context: context || 'unknown',
      totalCandidates: Object.keys(db.faceData).length
    });
    if (db.faceAccessLog.length > 10000) db.faceAccessLog = db.faceAccessLog.slice(-5000);
    saveDB('users');
  }

  res.json({
    found: results.length > 0,
    matches: results.slice(0, 3), // top 3 matches
    scannedTotal: Object.keys(db.faceData).length
  });
});

// Admin: list all face enrollments
app.get('/api/face/admin/list/:adminId', (req, res) => {
  const admin = db.users[req.params.adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const enrolled = Object.entries(db.faceData).map(([uid, fd]) => ({
    userId: uid,
    nickname: db.users[uid]?.nickname || '??',
    realName: db.users[uid]?.realName || null,
    enrolledAt: fd.enrolledAt,
    angles: fd.angles,
    verified: !!db.users[uid]?.verified
  }));
  const recentAccess = (db.faceAccessLog || []).slice(-20).reverse();
  res.json({ enrolled, recentAccess, totalEnrolled: enrolled.length });
});

// ═══ VERIFICATION SYSTEM ═══
if (!db.verifications) db.verifications = {};

// Admin: verify a user
app.post('/api/admin/verify', (req, res) => {
  const { adminId, targetId, type, note } = req.body;
  if (!adminId || !targetId) return res.status(400).json({ error: 'adminId e targetId obrigatórios.' });
  const admin = db.users[adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin pode verificar.' });
  const target = db.users[targetId];
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  target.verified = true;
  target.verifiedAt = Date.now();
  target.verifiedBy = adminId;
  target.verificationType = type || 'standard';
  db.verifications[targetId] = { userId: targetId, verifiedAt: Date.now(), by: adminId, type: type || 'standard', note: note || '' };
  saveDB('users');
  res.json({ ok: true, user: { id: targetId, nickname: target.nickname, verified: true, verificationType: target.verificationType } });
});

// Admin: revoke verification
app.post('/api/admin/unverify', (req, res) => {
  const { adminId, targetId } = req.body;
  if (!adminId || !targetId) return res.status(400).json({ error: 'adminId e targetId obrigatórios.' });
  const admin = db.users[adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const target = db.users[targetId];
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  target.verified = false;
  delete target.verifiedAt;
  delete target.verifiedBy;
  delete target.verificationType;
  delete db.verifications[targetId];
  saveDB('users');
  res.json({ ok: true });
});

// Admin: verify an event
app.post('/api/admin/verify-event', (req, res) => {
  const { adminId, eventId, note } = req.body;
  if (!adminId || !eventId) return res.status(400).json({ error: 'adminId e eventId obrigatórios.' });
  const admin = db.users[adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const ev = db.operatorEvents[eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  ev.verified = true;
  ev.verifiedAt = Date.now();
  ev.verifiedBy = adminId;
  saveDB('operatorEvents');
  res.json({ ok: true, event: { id: eventId, name: ev.name, verified: true } });
});

// Admin: list all verifications
app.get('/api/admin/verifications/:adminId', (req, res) => {
  const admin = db.users[req.params.adminId];
  if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' });
  const users = Object.values(db.users).filter(u => u.verified).map(u => ({
    id: u.id, nickname: u.nickname, name: u.name || u.nickname, verified: true,
    verifiedAt: u.verifiedAt, verificationType: u.verificationType || 'standard',
    stars: (u.stars || []).length, score: calcScore(u.id),
    profilePhoto: u.profilePhoto || u.photoURL || null
  }));
  const events = Object.values(db.operatorEvents).filter(e => e.verified).map(e => ({
    id: e.id, name: e.name, verified: true, verifiedAt: e.verifiedAt,
    participants: (e.participants || []).length, active: e.active
  }));
  const allUsers = Object.values(db.users).map(u => ({
    id: u.id, nickname: u.nickname, name: u.name || u.nickname,
    verified: !!u.verified, stars: (u.stars || []).length,
    profilePhoto: u.profilePhoto || u.photoURL || null
  }));
  const allEvents = Object.values(db.operatorEvents).map(e => ({
    id: e.id, name: e.name, verified: !!e.verified,
    participants: (e.participants || []).length, active: e.active
  }));
  res.json({ verifiedUsers: users, verifiedEvents: events, allUsers, allEvents });
});

// Full score breakdown for a user
app.get('/api/score/breakdown/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const cfg = getGameConfig();
  const encounters = db.encounters[req.params.userId] || [];
  const uniqueConns = getUniqueConnections(req.params.userId);
  const rawScore = calcRawScore(req.params.userId);
  const decayedScore = calcScore(req.params.userId);
  const spendable = rawScore - (user.pointsSpent || 0);
  const starsReceived = (user.stars || []).length;
  const starsEarned = user.starsEarned || 0;
  const totalDonated = countDonationsFrom(req.params.userId);
  // Count by type
  const typeCounts = {};
  for (const p of (user.pointLog || [])) {
    typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
  }
  res.json({
    score: decayedScore, rawScore, spendablePoints: Math.round(spendable),
    stars: starsReceived, starsEarned, starsDonated: totalDonated, starsAvailable: starsEarned - totalDonated,
    uniqueConnections: uniqueConns, totalEncounters: encounters.length,
    likes: user.likesCount || 0,
    pointBreakdown: typeCounts,
    config: cfg
  });
});

// ── Get own full profile data ──
app.get('/api/myprofile/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({
    nickname: user.nickname, realName: user.realName || '',
    phone: user.phone || '', instagram: user.instagram || '',
    tiktok: user.tiktok || '', twitter: user.twitter || '', bio: user.bio || '',
    privacy: user.privacy || {},
    profilePhoto: user.profilePhoto || user.photoURL || '', photoURL: user.photoURL || '', profileComplete: !!user.profileComplete,
    email: user.email || '', cpf: user.cpf || '',
    canSee: user.canSee || {}, isPrestador: !!user.isPrestador,
    starsEarned: user.starsEarned || 0, likesCount: user.likesCount || 0,
    starsReceived: (user.stars || []).length, score: calcScore(req.params.userId),
    uniqueConnections: getUniqueConnections(req.params.userId),
    topTag: user.topTag || null, registrationOrder: user.registrationOrder || 0,
    verified: !!user.verified, isAdmin: !!user.isAdmin,
    faceEnrolled: !!user.faceEnrolled, faceEnrolledAt: user.faceEnrolledAt || null,
    docSubmitted: !!user.docSubmitted, docStatus: user.docStatus || null, docVerified: !!user.docVerified,
    isSubscriber: !!user.isSubscriber, verificationType: user.verificationType || null,
    giftsReceived: (db.gifts[req.params.userId] || []).length,
    likesGiven: user.likesGiven || 0, declarationsReceived: (db.declarations ? Object.values(db.declarations).filter(d => d.toUserId === req.params.userId).length : 0)
  });
});

// ── LOCATION & EVENTS ──

// Haversine distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Update user location (temporary, not stored permanently)
app.post('/api/location/update', (req, res) => {
  const { userId, lat, lng } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (lat == null || lng == null) return res.status(400).json({ error: 'Localização inválida.' });
  if (!db.checkins[userId]) db.checkins[userId] = {};
  db.checkins[userId] = { lat, lng, updatedAt: Date.now() };
  saveDB('checkins');
  res.json({ ok: true });
});

// Nearby people (within radius, only those who shared location recently <15min)
app.get('/api/nearby/:userId', (req, res) => {
  const userId = req.params.userId;
  const radius = parseInt(req.query.radius) || 500; // meters default
  const myLoc = db.checkins[userId];
  if (!myLoc) return res.json([]);
  const now = Date.now();
  const nearby = [];
  for (const [uid, loc] of Object.entries(db.checkins)) {
    if (uid === userId) continue;
    if (now - loc.updatedAt > 900000) continue; // 15min stale
    const dist = haversine(myLoc.lat, myLoc.lng, loc.lat, loc.lng);
    if (dist <= radius) {
      const u = db.users[uid];
      if (!u) continue;
      nearby.push({ id: uid, nickname: u.nickname || u.name, color: u.color, score: calcScore(uid), stars: (u.stars || []).length, distance: Math.round(dist), verified: !!u.verified });
    }
  }
  nearby.sort((a, b) => a.distance - b.distance);
  res.json(nearby);
});

// Create event (physical location with digital meeting point)
app.post('/api/event/create', (req, res) => {
  const { userId, name, description, lat, lng, radius, startsAt, endsAt } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!name || !lat || !lng) return res.status(400).json({ error: 'Nome e localização obrigatórios.' });
  const id = uuidv4();
  const code = 'EVT-' + Math.floor(100 + Math.random() * 900);
  const creator = db.users[userId];
  const eventData = {
    id, code, name: name.trim(), description: (description || '').trim(),
    lat, lng, radius: radius || 200,
    creatorId: userId, creatorName: creator.nickname || creator.name, creatorColor: creator.color,
    startsAt: startsAt || Date.now(), endsAt: endsAt || (Date.now() + 86400000),
    participants: [userId],
    createdAt: Date.now()
  };
  db.events[id] = eventData;
  // Also create in operatorEvents so sonic checkin system can find it
  db.operatorEvents[id] = {
    id, name: eventData.name, description: eventData.description,
    creatorId: userId, creatorName: eventData.creatorName,
    active: true, participants: [userId], checkinCount: 0,
    acceptsTips: false, serviceLabel: '',
    entryPrice: 0, revenue: 0, paidCheckins: 0,
    createdAt: Date.now()
  };
  saveDB('events', 'operatorEvents');
  res.json({ event: eventData });
});

// List nearby events
app.get('/api/events/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = parseInt(req.query.radius) || 5000; // 5km default
  const now = Date.now();
  if (!lat || !lng) return res.json([]);
  const events = Object.values(db.events).filter(e => {
    if (e.endsAt < now) return false;
    const dist = haversine(lat, lng, e.lat, e.lng);
    return dist <= radius;
  }).map(e => ({
    ...e, distance: Math.round(haversine(lat, lng, e.lat, e.lng)),
    participantCount: e.participants.length
  })).sort((a, b) => a.distance - b.distance);
  res.json(events);
});

// Join event
app.post('/api/event/join', (req, res) => {
  const { userId, eventId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const ev = db.events[eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (Date.now() > ev.endsAt) return res.status(400).json({ error: 'Evento encerrado.' });
  if (!ev.participants.includes(userId)) ev.participants.push(userId);
  saveDB('operatorEvents');
  // Notify others in event
  ev.participants.forEach(pid => {
    if (pid !== userId) io.to(`user:${pid}`).emit('event-join', { eventId, user: { id: userId, nickname: db.users[userId].nickname, color: db.users[userId].color } });
  });
  res.json({ ok: true, event: ev });
});

// Get event details + participants
app.get('/api/event/:eventId', (req, res) => {
  const ev = db.events[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const participants = ev.participants.map(pid => {
    const u = db.users[pid];
    return u ? { id: pid, nickname: u.nickname || u.name, color: u.color, profilePhoto: u.profilePhoto || null, photoURL: u.photoURL || null, score: calcScore(pid), stars: (u.stars || []).length, verified: !!u.verified } : null;
  }).filter(Boolean);
  res.json({ ...ev, participantsData: participants });
});

// Digital encosta REQUEST — needs acceptance from the other person
app.post('/api/event/encosta-request', (req, res) => {
  const { userId, eventId, targetNickname, targetId: directTargetId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const ev = db.events[eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!ev.participants.includes(userId)) return res.status(403).json({ error: 'Você não está neste evento.' });
  let targetId;
  if (directTargetId && db.users[directTargetId] && ev.participants.includes(directTargetId) && directTargetId !== userId) {
    targetId = directTargetId;
  } else if (targetNickname) {
    const targetEntry = Object.entries(db.users).find(([id, u]) =>
      (u.nickname || u.name || '').toLowerCase() === targetNickname.toLowerCase() && ev.participants.includes(id) && id !== userId
    );
    if (!targetEntry) return res.status(404).json({ error: 'Pessoa não encontrada neste evento.' });
    targetId = targetEntry[0];
  } else {
    return res.status(400).json({ error: 'Informe targetId ou targetNickname.' });
  }
  const user = db.users[userId];
  const reqId = uuidv4();
  // Send request via socket to target
  io.to(`user:${targetId}`).emit('encosta-request', {
    requestId: reqId, eventId, eventName: ev.name,
    from: { id: userId, name: user.nickname || user.name, color: user.color, profilePhoto: user.profilePhoto || null, photoURL: user.photoURL || null }
  });
  res.json({ ok: true, requestId: reqId });
});

// Accept/decline digital encosta
app.post('/api/event/encosta-accept', (req, res) => {
  const { userId, eventId, fromUserId, accepted } = req.body;
  if (!accepted) {
    io.to(`user:${fromUserId}`).emit('encosta-declined', { eventId, by: userId });
    return res.json({ ok: true, declined: true });
  }
  // Create digital relation (1h duration)
  const userA = db.users[fromUserId], userB = db.users[userId];
  if (!userA || !userB) return res.status(400).json({ error: 'Usuário inválido.' });
  const ev = db.events[eventId];
  const now = Date.now();
  const DIGITAL_DURATION = 3600000; // 1 hour
  const existing = findActiveRelation(fromUserId, userId);
  let relationId, phrase, expiresAt;
  if (existing) {
    existing.expiresAt = now + DIGITAL_DURATION;
    existing.phrase = smartPhrase(fromUserId, userId);
    existing.renewed = (existing.renewed || 0) + 1;
    existing.provocations = {};
    relationId = existing.id; phrase = existing.phrase; expiresAt = existing.expiresAt;
  } else {
    phrase = smartPhrase(fromUserId, userId);
    relationId = uuidv4();
    db.relations[relationId] = { id: relationId, userA: fromUserId, userB: userId, phrase, type: 'digital', createdAt: now, expiresAt: now + DIGITAL_DURATION, provocations: {}, renewed: 0, selfie: null, eventId };
    idxAddRelation(relationId, fromUserId, userId);
    db.messages[relationId] = [];
    expiresAt = now + DIGITAL_DURATION;
  }
  // Find last encounter between these two
  const myEncounters = db.encounters[userId] || [];
  const lastEnc = myEncounters.filter(e => e.with === fromUserId).sort((a,b) => b.timestamp - a.timestamp)[0];
  recordEncounter(fromUserId, userId, phrase, 'digital');
  saveDB('users', 'relations', 'messages', 'encounters');
  const responseData = {
    relationId, phrase, expiresAt, renewed: !!existing, type: 'digital', eventName: ev ? ev.name : '',
    lastEncounter: lastEnc ? { phrase: lastEnc.phrase, timestamp: lastEnc.timestamp } : null,
    userA: { id: userA.id, name: userA.nickname || userA.name, realName: userA.realName || null, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: getZodiacSign(userA.birthdate), signInfo: getZodiacSign(userA.birthdate) ? ZODIAC_INFO[getZodiacSign(userA.birthdate)] : null, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '' },
    userB: { id: userB.id, name: userB.nickname || userB.name, realName: userB.realName || null, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: getZodiacSign(userB.birthdate), signInfo: getZodiacSign(userB.birthdate) ? ZODIAC_INFO[getZodiacSign(userB.birthdate)] : null, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '' }
  };
  io.to(`user:${fromUserId}`).emit('relation-created', responseData);
  io.to(`user:${userId}`).emit('relation-created', responseData);
  res.json(responseData);
});

// Request contact info (Instagram, WhatsApp, X, email, photo)
const CONTACT_TYPES = ['instagram', 'x', 'whatsapp', 'email', 'foto'];
app.post('/api/request-contact', (req, res) => {
  const { relationId, fromUserId, contactType } = req.body;
  const rel = db.relations[relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(400).json({ error: 'Relação expirada.' });
  if (!CONTACT_TYPES.includes(contactType)) return res.status(400).json({ error: 'Tipo inválido.' });
  const partnerId = rel.userA === fromUserId ? rel.userB : rel.userA;
  const user = db.users[fromUserId];
  const reqId = uuidv4();
  io.to(`user:${partnerId}`).emit('contact-request', {
    requestId: reqId, relationId, contactType,
    from: { id: fromUserId, name: user.nickname || user.name, color: user.color }
  });
  res.json({ ok: true });
});

// Respond to contact request
app.post('/api/respond-contact', (req, res) => {
  const { relationId, toUserId, contactType, accepted, value } = req.body;
  const rel = db.relations[relationId];
  if (!rel) return res.status(400).json({ error: 'Relação não encontrada.' });
  const fromUserId = rel.userA === toUserId ? rel.userB : rel.userA;
  if (accepted && value) {
    // Save contact info as persistent message in chat history
    const labels = { instagram: '📸 Instagram', whatsapp: '💬 WhatsApp', x: '𝕏 X', email: '📧 Email' };
    const contactMsg = {
      userId: 'system',
      text: (labels[contactType] || contactType) + ': ' + value,
      timestamp: Date.now(),
      type: 'contact'
    };
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(contactMsg);
    saveDB('messages');
    io.to(`user:${fromUserId}`).emit('contact-shared', { relationId, contactType, value, from: toUserId });
  } else {
    io.to(`user:${fromUserId}`).emit('contact-declined', { relationId, contactType, from: toUserId });
  }
  res.json({ ok: true });
});

// Horoscope interaction — zodiac phrase for both users
app.get('/api/horoscope/:relationId/:userId', (req, res) => {
  const rel = db.relations[req.params.relationId];
  if (!rel) return res.status(400).json({ error: 'Relação não encontrada.' });
  const userA = db.users[rel.userA];
  const userB = db.users[rel.userB];
  if (!userA || !userB) return res.json({ error: 'Usuários não encontrados.' });
  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const infoA = signA ? ZODIAC_INFO[signA] : null;
  const infoB = signB ? ZODIAC_INFO[signB] : null;
  const phrase = getZodiacPhrase(signA, signB);
  if (!phrase) return res.json({ error: 'Signos não disponíveis.' });
  const nameA = userA.nickname || userA.name;
  const nameB = userB.nickname || userB.name;
  const elA = infoA ? infoA.elementName : '?';
  const elB = infoB ? infoB.elementName : '?';
  const same = elA === elB;
  const intro = same ? elA + ' encontra ' + elA : elA + ' encontra ' + elB;
  res.json({
    phrase: intro + ' — ' + phrase,
    signA, signB, elementA: elA, elementB: elB
  });
});

// Save selfie for relation
app.post('/api/selfie', async (req, res) => {
  const { relationId, userId, selfieData } = req.body;
  const rel = db.relations[relationId];
  if (!rel) return res.status(400).json({ error: 'Relação não encontrada.' });
  if (!rel.selfie) rel.selfie = {};
  if (selfieData && selfieData.startsWith('data:image')) {
    const url = await uploadBase64ToStorage(selfieData, `photos/selfie/${relationId}_${userId}.jpg`);
    rel.selfie[userId] = url || selfieData;
  } else {
    rel.selfie[userId] = selfieData;
  }
  saveDB('relations');
  const partnerId = rel.userA === userId ? rel.userB : rel.userA;
  io.to(`user:${partnerId}`).emit('selfie-taken', { relationId, from: userId });
  res.json({ ok: true });
});

// ── SONIC MATCHING SYSTEM ──
// Each phone emits a unique ultrasonic frequency AND listens.
// When Phone B detects Phone A's frequency, it reports to server → match!
const SONIC_FREQ_BASE = 18000; // 18kHz base
const SONIC_FREQ_STEP = 100;   // 100Hz steps
const SONIC_FREQ_SLOTS = 20;   // 20 possible frequencies (18000-19900Hz)
const sonicQueue = {}; // { oderId: { userId, freq, socketId, joinedAt } }
let nextFreqSlot = 0;

function assignSonicFreq() {
  const freq = SONIC_FREQ_BASE + (nextFreqSlot % SONIC_FREQ_SLOTS) * SONIC_FREQ_STEP;
  nextFreqSlot++;
  return freq;
}

function findSonicUserByFreq(freq) {
  return Object.values(sonicQueue).find(s => s.freq === freq);
}

// Find sonicQueue entry by userId (searches all entries since operators use 'evt:' keys)
function findSonicEntryByUserId(userId) {
  // First try direct key (regular users)
  if (sonicQueue[userId]) return sonicQueue[userId];
  // Then search all entries (for operators with 'evt:' keys)
  return Object.values(sonicQueue).find(s => s.userId === userId) || null;
}

function createSonicConnection(userIdA, userIdB) {
  console.log('[createSonicConnection] START — A:', userIdA?.slice(0,12), 'B:', userIdB?.slice(0,12));
  const userA = db.users[userIdA];
  const userB = db.users[userIdB];
  if (!userA || !userB) {
    console.log('[createSonicConnection] ABORT — userA:', !!userA, 'userB:', !!userB, '(user not in db.users)');
    return;
  }
  const now = Date.now();

  // Check if either user is in checkin or service mode (search by userId since operators use 'evt:' keys)
  const entryA = findSonicEntryByUserId(userIdA);
  const entryB = findSonicEntryByUserId(userIdB);
  const isCheckin = !!(entryA && entryA.isCheckin) || !!(entryB && entryB.isCheckin);
  const isServiceTouch = !!(entryA && entryA.isServiceTouch) || !!(entryB && entryB.isServiceTouch)
    || (userA.isPrestador && userA.serviceModeActive) || (userB.isPrestador && userB.serviceModeActive);
  console.log('[createSonicConnection] entryA:', entryA ? {userId:entryA.userId?.slice(0,8),isCheckin:entryA.isCheckin,freq:entryA.freq} : 'NONE', 'entryB:', entryB ? {userId:entryB.userId?.slice(0,8),isCheckin:entryB.isCheckin,freq:entryB.freq} : 'NONE', 'isCheckin:', isCheckin, 'isServiceTouch:', isServiceTouch);
  const operatorId = isCheckin ? (entryA && entryA.isCheckin ? userIdA : userIdB) : null;
  const operatorEntry = operatorId ? (operatorId === userIdA ? entryA : entryB) : null;
  const eventId = operatorEntry ? operatorEntry.eventId : null;
  const serviceProviderId = isServiceTouch ? (entryA && entryA.isServiceTouch ? userIdA : (entryB && entryB.isServiceTouch ? userIdB : (userA.isPrestador ? userIdA : userIdB))) : null;

  const phrase = isCheckin ? PHRASES.evento[Math.floor(Math.random() * PHRASES.evento.length)] : (isServiceTouch ? PHRASES.servico[Math.floor(Math.random() * PHRASES.servico.length)] : smartPhrase(userIdA, userIdB));
  const encounterType = isCheckin ? 'checkin' : (isServiceTouch ? 'service' : 'physical');

  // For check-ins: relation is between VISITOR and EVENT (not operator personally)
  const visitorId = isCheckin && operatorId ? (operatorId === userIdA ? userIdB : userIdA) : null;
  const relPartnerA = isCheckin && eventId ? visitorId : userIdA;
  const relPartnerB = isCheckin && eventId ? ('evt:' + eventId) : userIdB;

  const existing = findActiveRelation(relPartnerA, relPartnerB);
  let relationId, expiresAt;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = phrase;
    existing.renewed = (existing.renewed || 0) + 1;
    relationId = existing.id;
    expiresAt = existing.expiresAt;
  } else {
    relationId = uuidv4();
    db.relations[relationId] = { id: relationId, userA: relPartnerA, userB: relPartnerB, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null, eventId: eventId || null, eventName: (eventId && db.operatorEvents[eventId]) ? db.operatorEvents[eventId].name : null, isEventCheckin: isCheckin && !!eventId };
    idxAddRelation(relationId, relPartnerA, relPartnerB);
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
  }
  // For check-ins, record encounter with event virtual ID, NOT with operator
  if (isCheckin && eventId && visitorId) {
    const evObj = db.operatorEvents[eventId];
    const evName = evObj ? evObj.name : 'Evento';
    if (!db.encounters[visitorId]) db.encounters[visitorId] = [];
    db.encounters[visitorId].push({ with: 'evt:' + eventId, withName: evName, withColor: '#60a5fa', phrase, timestamp: now, date: new Date(now).toISOString().slice(0,10), type: 'checkin', points: 1, chatDurationH: 24, relationId, isEvent: true });
    // Award points to visitor only
    awardPoints(visitorId, null, 'checkin');
  } else {
    recordEncounter(userIdA, userIdB, phrase, encounterType, relationId);
  }
  saveDB('relations', 'messages');
  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const zodiacPhrase = (isCheckin || isServiceTouch) ? null : getZodiacPhrase(signA, signB);
  const operatorUser = operatorId ? db.users[operatorId] : null;
  // Check if operator requires reveal
  const opRequireReveal = operatorUser && operatorUser.operatorSettings && operatorUser.operatorSettings.requireReveal;
  const eventObj = eventId ? db.operatorEvents[eventId] : null;
  // For check-ins, visitor sees event info, NOT operator personal data
  let responseData;
  if (isCheckin && eventId && visitorId) {
    const visitorUser = visitorId === userIdA ? userA : userB;
    const vSign = getZodiacSign(visitorUser.birthdate);
    responseData = {
      relationId, phrase, expiresAt, renewed: !!existing,
      sonicMatch: true, isCheckin: true, isServiceTouch: false,
      eventId, eventName: eventObj ? eventObj.name : null,
      requireReveal: !!opRequireReveal,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (eventObj && eventObj.entryPrice > 0) ? eventObj.entryPrice : 0,
      // userA = visitor, userB = event (virtual)
      userA: { id: visitorUser.id, name: visitorUser.nickname || visitorUser.name, color: visitorUser.color, profilePhoto: visitorUser.profilePhoto || null, photoURL: visitorUser.photoURL || null, score: calcScore(visitorUser.id), stars: (visitorUser.stars || []).length, sign: vSign, signInfo: vSign ? ZODIAC_INFO[vSign] : null, isPrestador: !!visitorUser.isPrestador, serviceLabel: visitorUser.serviceLabel || '' },
      userB: { id: 'evt:' + eventId, name: eventObj ? eventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true },
      zodiacPhrase: null
    };
  } else {
    responseData = {
      relationId, phrase, expiresAt, renewed: !!existing,
      sonicMatch: true, isCheckin, isServiceTouch,
      eventId: eventId || null, eventName: eventObj ? eventObj.name : null,
      requireReveal: !!opRequireReveal,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (eventObj && eventObj.entryPrice > 0) ? eventObj.entryPrice : 0,
      userA: { id: userA.id, name: userA.nickname || userA.name, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: signA ? ZODIAC_INFO[signA] : null, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '' },
      userB: { id: userB.id, name: userB.nickname || userB.name, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: signB ? ZODIAC_INFO[signB] : null, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '' },
      zodiacPhrase
    };
  }
  // Clean both from queue (but NOT the operator — they stay for continuous check-ins)
  if (isCheckin && operatorId) {
    // Only remove the visitor, operator stays with same freq
    const checkinVisitorId = operatorId === userIdA ? userIdB : userIdA;
    delete sonicQueue[checkinVisitorId];
    // Reset operator's joinedAt so the 10min cleanup timer doesn't expire (use queueKey for 'evt:' keys)
    const opQueueKey = operatorEntry ? operatorEntry.queueKey : operatorId;
    if (sonicQueue[opQueueKey]) {
      sonicQueue[opQueueKey].joinedAt = Date.now();
    }
    // Add visitor to event participants
    if (eventId && db.operatorEvents[eventId]) {
      const ev = db.operatorEvents[eventId];
      if (!ev.participants.includes(visitorId)) {
        ev.participants.push(visitorId);
        ev.checkinCount = ev.participants.length;
      }
    }
  } else {
    delete sonicQueue[userIdA];
    delete sonicQueue[userIdB];
  }
  if (isCheckin && operatorId && visitorId) {
    // Check socket rooms exist
    const visitorRoom = io.sockets.adapter.rooms.get(`user:${visitorId}`);
    const operatorRoom = io.sockets.adapter.rooms.get(`user:${operatorId}`);
    console.log('[createSonicConnection] CHECKIN emit — visitorRoom:', visitorRoom ? visitorRoom.size + ' sockets' : 'EMPTY/MISSING', 'operatorRoom:', operatorRoom ? operatorRoom.size + ' sockets' : 'EMPTY/MISSING');
    // Only emit to VISITOR (operator doesn't get personal relation, only checkin-created)
    io.to(`user:${visitorId}`).emit('relation-created', responseData);
    io.to(`user:${visitorId}`).emit('sonic-matched', { withUser: 'evt:' + eventId });
    // Operator gets sonic-matched so dashboard re-registers
    io.to(`user:${operatorId}`).emit('sonic-matched', { withUser: visitorId });
  } else {
    const roomA = io.sockets.adapter.rooms.get(`user:${userIdA}`);
    const roomB = io.sockets.adapter.rooms.get(`user:${userIdB}`);
    console.log('[createSonicConnection] REGULAR emit — roomA:', roomA ? roomA.size + ' sockets' : 'EMPTY/MISSING', 'roomB:', roomB ? roomB.size + ' sockets' : 'EMPTY/MISSING');
    io.to(`user:${userIdA}`).emit('relation-created', responseData);
    io.to(`user:${userIdB}`).emit('relation-created', responseData);
    io.to(`user:${userIdA}`).emit('sonic-matched', { withUser: userIdB });
    io.to(`user:${userIdB}`).emit('sonic-matched', { withUser: userIdA });
  }
  // Notify operator dashboard if checkin
  if (isCheckin && operatorId) {
    const visitor = operatorId === userIdA ? userB : userA;
    const visitorId = visitor.id;
    const visitorUser = db.users[visitorId];
    const visitorRevealed = !!(db.users[operatorId] && db.users[operatorId].canSee && db.users[operatorId].canSee[visitorId]);
    const totalUsers = Object.keys(db.users).length;
    const visitorStars = visitorUser ? (visitorUser.stars || []).length : 0;
    const visitorOrder = visitorUser ? (visitorUser.registrationOrder || 9999) : 9999;
    const visitorTopTag = calculateTopTag(visitorOrder, totalUsers);
    const checkinData = {
      userId: visitorId, nickname: visitor.nickname || visitor.name, color: visitor.color,
      profilePhoto: visitor.profilePhoto || visitor.photoURL || null, timestamp: now,
      relationId, revealed: visitorRevealed,
      revealData: visitorRevealed ? db.users[operatorId].canSee[visitorId] : null,
      eventId: eventId || null,
      stars: visitorStars,
      topTag: visitorTopTag,
      score: calcScore(visitorId)
    };
    io.to(`user:${operatorId}`).emit('checkin-created', checkinData);
    // Notify event room so phone users see new attendee
    if (eventId) {
      io.to('event:' + eventId).emit('event-attendee-joined', checkinData);
      // Join visitor to event room
      const visitorSockets = io.sockets.adapter.rooms.get(`user:${visitorId}`);
      if (visitorSockets) {
        for (const sid of visitorSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.join('event:' + eventId);
        }
      }
    }
  }
}

// Cleanup stale sonic entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of Object.entries(sonicQueue)) {
    // Operators (isCheckin) get 10 min timeout, regular users 1 min
    const maxAge = entry.isCheckin ? 600000 : 60000;
    if (now - entry.joinedAt > maxAge) delete sonicQueue[uid];
  }
}, 30000);

// ── RESET REVEALS ONLY ──
app.post('/api/admin/reset-reveals', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET_REVEALS') return res.status(400).json({ error: 'Send { confirm: "RESET_REVEALS" }.' });
  let count = 0;
  Object.values(db.users).forEach(u => {
    u.canSee = {};
    u.revealedTo = [];
    count++;
  });
  db.revealRequests = {};
  // Also remove reveal messages from all chats
  Object.keys(db.messages).forEach(relId => {
    db.messages[relId] = (db.messages[relId] || []).filter(m => !['reveal-request', 'reveal-accepted', 'reveal-declined'].includes(m.type));
  });
  saveDB('users');
  res.json({ ok: true, usersReset: count });
});

// ── DATABASE RESET ──
// ── BACKUP / ROLLBACK ENDPOINTS ──
app.post('/api/admin/backup', async (req, res) => {
  try {
    const reason = req.body.reason || 'manual';
    const id = await createBackup(reason);
    if (id) res.json({ ok: true, backupId: id, message: 'Backup criado com sucesso.' });
    else res.status(500).json({ error: 'Falha ao criar backup.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/backups', async (req, res) => {
  const backups = await listBackups();
  res.json({ backups });
});

app.post('/api/admin/rollback', async (req, res) => {
  const { backupId, confirm } = req.body;
  if (confirm !== 'ROLLBACK') return res.status(400).json({ error: 'Send { backupId, confirm: "ROLLBACK" } to confirm.' });
  if (!backupId) return res.status(400).json({ error: 'backupId required. Use GET /api/admin/backups to list.' });
  try {
    const result = await restoreBackup(backupId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SAFE RESET: only clear events & checkins, preserve relations/encounters/messages ──
app.post('/api/admin/reset-events', async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET_EVENTS') return res.status(400).json({ error: 'Send { confirm: "RESET_EVENTS" } to confirm.' });
  // Auto-backup before any reset
  await createBackup('auto:before-reset-events');
  const eventCount = Object.keys(db.operatorEvents || {}).length;
  const checkinRelations = Object.values(db.relations).filter(r => r.type === 'checkin' || r.isCheckin);
  const checkinCount = checkinRelations.length;
  // Only remove checkin-type relations, keep friendship/service/sonic
  checkinRelations.forEach(r => delete db.relations[r.id]);
  // Clear operator events
  db.operatorEvents = {};
  // Clear sessions (temporary connection data)
  if (db.sessions) db.sessions = {};
  const cleared = { operatorEvents: eventCount, checkinRelations: checkinCount };
  const preserved = { relations: Object.keys(db.relations).length, encounters: Object.keys(db.encounters).length, messages: Object.keys(db.messages).length, users: Object.keys(db.users).length };
  saveDB('operatorEvents'); saveDB('relations'); saveDB('sessions');
  console.log('🧹 SAFE RESET (events only) — cleared:', cleared, 'preserved:', preserved);
  res.json({ ok: true, cleared, preserved });
});

// ── FULL RESET: dangerous, clears everything ──
app.post('/api/admin/reset-db', async (req, res) => {
  const { confirm, keepUsers } = req.body;
  if (confirm !== 'FULL_RESET_DANGEROUS') return res.status(400).json({ error: 'DANGEROUS: Send { confirm: "FULL_RESET_DANGEROUS" } to confirm. Use /api/admin/reset-events for safe reset.' });
  // Auto-backup before destructive operation
  await createBackup('auto:before-full-reset');
  const userCount = Object.keys(db.users).length;
  const relationCount = Object.keys(db.relations).length;
  const eventCount = Object.keys(db.operatorEvents || {}).length;
  const encounterCount = Object.keys(db.encounters).length;
  const msgCount = Object.keys(db.messages).length;
  if (keepUsers) {
    // Reset everything except users
    DB_COLLECTIONS.forEach(c => { if (c !== 'users') db[c] = {}; });
    // Clear user transient data but keep profiles (name, nickname, email, color, etc)
    Object.values(db.users).forEach(u => {
      u.stars = []; u.points = 0; u.pointLog = [];
      u.canSee = {}; u.revealedTo = [];
    });
    // Rebuild user index
    IDX.nickname.clear(); IDX.firebaseUid.clear();
    Object.values(db.users).forEach(u => {
      if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), u.id);
      if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, u.id);
    });
  } else {
    DB_COLLECTIONS.forEach(c => { db[c] = {}; });
    IDX.nickname.clear(); IDX.firebaseUid.clear();
  }
  // Save all collections to Firebase
  DB_COLLECTIONS.forEach(c => saveDB(c));
  console.log('🗑️ FULL DATABASE RESET — keepUsers:', !!keepUsers, 'cleared:', { users: keepUsers ? 0 : userCount, relations: relationCount, events: eventCount, encounters: encounterCount, messages: msgCount });
  res.json({ ok: true, cleared: { users: keepUsers ? 0 : userCount, relations: relationCount, events: eventCount, encounters: encounterCount, messages: msgCount } });
});

// ── STATUS / HEALTH ──
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, uptime: process.uptime(),
    counts: {
      users: Object.keys(db.users).length,
      relations: Object.keys(db.relations).length,
      events: Object.keys(db.events).length,
      encounters: Object.keys(db.encounters).length,
      sessions: Object.keys(db.sessions).length,
      messages: Object.keys(db.messages).length
    }
  });
});

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('identify', (userId) => {
    currentUserId = userId;
    socket.join(`user:${userId}`);
  });

  socket.on('join-session', (sessionId) => { socket.join(`session:${sessionId}`); });

  socket.on('send-message', ({ relationId, userId, text }) => {
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, text, timestamp: Date.now() };
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('new-message', { relationId, message: msg });
  });

  socket.on('typing', ({ relationId, userId }) => {
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('partner-typing', { relationId });
  });

  // Pulse — silent vibration to partner
  socket.on('pulse', ({ relationId, userId }) => {
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('pulse-received', { relationId, from: userId });
  });

  // Ephemeral message — persisted so recipient sees when opening chat
  socket.on('send-ephemeral', ({ relationId, userId, text }) => {
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, text, type: 'ephemeral', timestamp: Date.now() };
    // Save to messages so it appears when recipient opens chat
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('ephemeral-received', { relationId, message: msg });
  });

  // Photo message
  socket.on('send-photo', ({ relationId, userId, photoData }) => {
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, type: 'photo', photoData, timestamp: Date.now() };
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('photo-received', { relationId, message: msg });
  });

  // Sonic connection — ultrasonic frequency matching
  socket.on('sonic-start', ({ userId, isCheckin, isServiceTouch, eventId }) => {
    if (!userId || !db.users[userId]) return;
    const freq = assignSonicFreq();
    // For checkin operators, use eventId as sonicQueue key to avoid overwriting phone's entry
    const queueKey = (isCheckin && eventId) ? ('evt:' + eventId) : userId;
    sonicQueue[queueKey] = { userId, freq, socketId: socket.id, joinedAt: Date.now(), isCheckin: !!isCheckin, isServiceTouch: !!isServiceTouch, eventId: eventId || null, queueKey };
    console.log('[sonic-start] user:', userId.slice(0,8)+'..', 'key:', queueKey.slice(0,12), 'freq:', freq, 'isCheckin:', !!isCheckin);
    socket.emit('sonic-assigned', { freq });
    // Join event socket room if checkin
    if (isCheckin && eventId) socket.join('event:' + eventId);
  });

  socket.on('sonic-detected', ({ userId, detectedFreq }) => {
    if (!userId || !db.users[userId]) return;
    const emitter = findSonicUserByFreq(detectedFreq);
    console.log('[sonic-detected] user:', userId?.slice(0,12), 'detected freq:', detectedFreq, '→ emitter:', emitter ? emitter.userId?.slice(0,12) : 'NOT FOUND', '| queue:', Object.keys(sonicQueue).map(k => k.slice(0,12)+'..freq:'+sonicQueue[k].freq).join(', '));
    if (emitter && emitter.userId !== userId) {
      // Prevent visitor-to-visitor connections when checkin operators are in queue
      const detectorEntry = findSonicEntryByUserId(userId);
      const emitterIsCheckin = emitter.isCheckin;
      const detectorIsCheckin = detectorEntry && detectorEntry.isCheckin;
      const hasActiveCheckinOps = Object.values(sonicQueue).some(s => s.isCheckin);
      if (!emitterIsCheckin && !detectorIsCheckin && hasActiveCheckinOps) {
        // Both are visitors but there's an operator — don't connect them, tell detector to retry
        console.log('[sonic-detected] SKIP visitor-to-visitor (checkin operators active) — sending sonic-retry');
        socket.emit('sonic-retry', { reason: 'Procurando o operador do evento...' });
        return;
      }
      try {
        createSonicConnection(emitter.userId, userId);
      } catch (e) {
        console.error('[sonic-detected] createSonicConnection ERROR:', e.message, e.stack);
      }
    }
  });

  socket.on('sonic-stop', ({ userId, eventId }) => {
    if (eventId) delete sonicQueue['evt:' + eventId];
    else if (userId) delete sonicQueue[userId];
  });

  socket.on('disconnect', () => {});
});

// ═══ MERCADOPAGO — Gorjetas ═══

// Service types catalog
app.get('/api/service-types', (req, res) => res.json(SERVICE_TYPES));

// MP public key (client needs it for Secure Fields)
app.get('/api/mp/public-key', (req, res) => res.json({ publicKey: MP_PUBLIC_KEY }));

// Register as prestador (beneficiary) — converts existing user OR creates new
app.post('/api/prestador/register', (req, res) => {
  const { userId, nickname, serviceType, fullName, cpf, birthdate } = req.body;
  if (!serviceType || !fullName) return res.status(400).json({ error: 'Preencha todos os campos.' });
  const svcLabel = (SERVICE_TYPES.find(s => s.id === serviceType) || {}).label || serviceType;

  // If userId provided, convert existing user to prestador
  if (userId && db.users[userId]) {
    const user = db.users[userId];
    user.isPrestador = true;
    user.serviceType = serviceType;
    user.serviceLabel = svcLabel;
    user.name = fullName || user.name;
    if (cpf) user.cpf = cpf;
    if (birthdate) user.birthdate = birthdate;
    if (!user.mpConnected) { user.mpConnected = false; user.mpAccessToken = null; user.mpRefreshToken = null; user.mpUserId = null; }
    if (!user.tipsReceived) { user.tipsReceived = 0; user.tipsTotal = 0; }
    saveDB('users');
    return res.json({ userId: user.id, user });
  }

  // Otherwise create new user
  if (!nickname) return res.status(400).json({ error: 'Preencha o nickname.' });
  const nick = nickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname deve ter 2 a 20 caracteres.' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(nick)) return res.status(400).json({ error: 'Só letras, números, _ . -' });
  const taken = isNickTaken(nick);
  if (taken) return res.status(400).json({ error: 'Esse nickname já existe.' });
  const id = uuidv4();
  const color = nickColor(nick);
  db.users[id] = {
    id, nickname: nick, name: fullName, birthdate: birthdate || null,
    avatar: null, color, createdAt: Date.now(), points: 0, pointLog: [], stars: [],
    isPrestador: true, serviceType, serviceLabel: svcLabel,
    cpf: cpf || null, mpConnected: false, mpAccessToken: null, mpRefreshToken: null, mpUserId: null,
    tipsReceived: 0, tipsTotal: 0
  };
  idxAddUser(db.users[id]);
  saveDB('users');
  res.json({ userId: id, user: db.users[id] });
});

// OAuth: redirect prestador to MercadoPago to connect account
app.get('/mp/auth/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user || !user.isPrestador) return res.status(400).send('Usuário não é prestador.');
  const authUrl = `https://auth.mercadopago.com.br/authorization?client_id=${MP_APP_ID}&response_type=code&platform_id=mp&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}&state=${user.id}`;
  res.redirect(authUrl);
});

// OAuth callback from MercadoPago
app.get('/mp/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Erro na autorização.');
  const user = db.users[userId];
  if (!user) return res.status(404).send('Usuário não encontrado.');
  try {
    // Exchange code for tokens
    const resp = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_APP_ID,
        client_secret: MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: MP_REDIRECT_URI
      })
    });
    const data = await resp.json();
    if (data.access_token) {
      user.mpConnected = true;
      user.mpAccessToken = data.access_token;
      user.mpRefreshToken = data.refresh_token || null;
      user.mpUserId = data.user_id || null;
      saveDB('users');
      // Redirect back to app with success
      res.redirect('/?mp_connected=1&userId=' + userId);
    } else {
      console.error('MP OAuth error:', data);
      res.redirect('/?mp_error=1');
    }
  } catch (e) {
    console.error('MP OAuth exception:', e);
    res.redirect('/?mp_error=1');
  }
});

// Check if prestador is connected to MP
app.get('/api/prestador/:userId/status', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({
    isPrestador: !!user.isPrestador,
    serviceType: user.serviceType || null,
    serviceLabel: user.serviceLabel || null,
    mpConnected: !!user.mpConnected,
    tipsReceived: user.tipsReceived || 0
  });
});

// Create a tip payment
app.post('/api/tip/create', async (req, res) => {
  const { payerId, receiverId, amount, token, paymentMethodId, issuer, installments, payerEmail, payerCPF } = req.body;
  if (!payerId || !receiverId || !amount || !token) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  // Accept tips for prestadores OR operators with acceptsTips events
  const isOperatorWithTips = isOperatorWithTipsCheck(receiverId);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });

  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100; // 10%

  const email = payerEmail || payer.email;
  const cpf = (payerCPF || payer.cpf || '').replace(/\D/g, '');
  if (!email || email.includes('@touch.app')) {
    return res.status(400).json({ error: 'Informe seu email para continuar.' });
  }
  if (!cpf || cpf.length < 11) {
    return res.status(400).json({ error: 'Informe seu CPF para continuar.' });
  }

  // Validate MP credentials
  if (!MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN not configured!');
    return res.status(500).json({ error: 'Sistema de pagamento não configurado. Configure MP_ACCESS_TOKEN.' });
  }

  try {
    const payerUser = db.users[payerId];
    const payerName = payerUser ? (payerUser.name || payerUser.nickname || 'Pagador') : 'Pagador';
    const paymentData = {
      transaction_amount: tipAmount,
      token,
      description: 'Gorjeta Touch? — ' + (receiver.serviceLabel || receiver.nickname || receiver.name),
      installments: installments || 1,
      payment_method_id: paymentMethodId || 'visa',
      binary_mode: true,
      payer: {
        email: email,
        first_name: payerName.split(' ')[0],
        last_name: payerName.split(' ').slice(1).join(' ') || payerName.split(' ')[0],
        identification: cpf ? { type: 'CPF', number: cpf } : undefined
      },
      additional_info: {
        items: [{
          id: 'tip-' + receiverId,
          title: 'Gorjeta para ' + (receiver.nickname || receiver.name),
          category_id: 'services',
          quantity: 1,
          unit_price: tipAmount
        }],
        payer: {
          first_name: payerName.split(' ')[0],
          last_name: payerName.split(' ').slice(1).join(' ') || payerName.split(' ')[0],
          registration_date: payerUser?.createdAt ? new Date(payerUser.createdAt).toISOString() : undefined
        }
      },
      statement_descriptor: 'TOUCH GORJETA',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip' }
    };

    console.log('💳 Processing payment:', { amount: tipAmount, method: paymentMethodId, email, receiverId, hasToken: !!token });

    const idempotencyKey = uuidv4();
    const requestOptions = { idempotencyKey };

    // If receiver has MP OAuth, use split payment
    if (receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      const result = await receiverPayment.create({ body: paymentData, requestOptions });
      console.log('💳 Split payment result:', { id: result.id, status: result.status, detail: result.status_detail });
      return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
    } else {
      const result = await mpPayment.create({ body: paymentData, requestOptions });
      console.log('💳 Direct payment result:', { id: result.id, status: result.status, detail: result.status_detail });
      return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
    }
  } catch (e) {
    console.error('Payment error:', e.message, e.cause ? JSON.stringify(e.cause) : '');
    const errMsg = (e.message || 'tente novamente').toLowerCase();
    // Provide more useful error messages
    if (errMsg.includes('customer') && errMsg.includes('not found')) {
      res.status(400).json({ error: 'Erro de cadastro no MercadoPago. Tente com outro email ou entre em contato.', detail: 'customer_not_found' });
    } else if (errMsg.includes('token')) {
      res.status(400).json({ error: 'Token do cartão inválido ou expirado. Tente novamente.' });
    } else if (errMsg.includes('access_token') || errMsg.includes('401')) {
      res.status(500).json({ error: 'Credenciais do Mercado Pago inválidas. Contate o suporte.' });
    } else if (errMsg.includes('email')) {
      res.status(400).json({ error: 'Email inválido. Atualize seu email no perfil.' });
    } else {
      res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente') });
    }
  }
});

function handlePaymentResult(result, payerId, receiverId, amount, fee, res) {
  const tipId = uuidv4();
  const tip = {
    id: tipId,
    payerId, receiverId, amount, fee,
    mpPaymentId: result.id,
    status: result.status, // approved, pending, rejected
    statusDetail: result.status_detail,
    createdAt: Date.now()
  };
  db.tips[tipId] = tip;
  // Update receiver stats
  const receiver = db.users[receiverId];
  if (receiver && result.status === 'approved') {
    receiver.tipsReceived = (receiver.tipsReceived || 0) + 1;
    receiver.tipsTotal = (receiver.tipsTotal || 0) + amount;
  }
  // Link tip to most recent encounter between payer and receiver
  const payerEnc = db.encounters[payerId] || [];
  const recentEnc = payerEnc.filter(e => e.with === receiverId).sort((a, b) => b.timestamp - a.timestamp)[0];
  if (recentEnc) {
    recentEnc.tipAmount = amount;
    recentEnc.tipId = tipId;
    recentEnc.tipStatus = result.status;
  }
  // Also mark on receiver side
  const recEnc = (db.encounters[receiverId] || []).filter(e => e.with === payerId).sort((a, b) => b.timestamp - a.timestamp)[0];
  if (recEnc) {
    recEnc.tipAmount = amount;
    recEnc.tipId = tipId;
    recEnc.tipStatus = result.status;
  }
  saveDB('tips', 'users', 'encounters');
  // Notify receiver via socket
  io.to(`user:${receiverId}`).emit('tip-received', { amount, tipId, from: db.users[payerId]?.nickname || '?', status: result.status });
  res.json({ status: result.status, tipId, statusDetail: result.status_detail });
}

// ═══ PIX PAYMENT ═══
app.post('/api/tip/pix', async (req, res) => {
  const { payerId, receiverId, amount, payerEmail, payerCPF } = req.body;
  if (!payerId || !receiverId || !amount) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  const isOperatorWithTips = isOperatorWithTipsCheck(receiverId);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento não configurado.' });

  const email = payerEmail || payer.email;
  const cpf = (payerCPF || payer.cpf || '').replace(/\D/g, '');
  if (!email || email.includes('@touch.app')) return res.status(400).json({ error: 'Informe seu email para pagar com PIX.' });
  if (!cpf || cpf.length < 11) return res.status(400).json({ error: 'CPF é obrigatório para PIX.' });
  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100;

  try {
    const paymentData = {
      transaction_amount: tipAmount,
      description: 'Gorjeta Touch? — ' + (receiver.serviceLabel || receiver.nickname || 'gorjeta'),
      payment_method_id: 'pix',
      payer: { email, identification: { type: 'CPF', number: cpf } },
      statement_descriptor: 'TOUCH GORJETA',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip_pix' },
      notification_url: MP_REDIRECT_URI.replace('/mp/callback', '') + '/mp/webhook'
    };

    let result;
    if (receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      result = await new Payment(receiverClient).create({ body: paymentData });
    } else {
      result = await mpPayment.create({ body: paymentData });
    }

    console.log('🟢 PIX payment created:', { id: result.id, status: result.status });

    // Extract PIX data
    const pixData = result.point_of_interaction?.transaction_data;
    const qrCode = pixData?.qr_code || '';
    const qrCodeBase64 = pixData?.qr_code_base64 || '';
    const ticketUrl = pixData?.ticket_url || '';

    // Save tip
    const tipId = uuidv4();
    db.tips[tipId] = {
      id: tipId, payerId, receiverId, amount: tipAmount, fee: touchFee,
      mpPaymentId: result.id, status: result.status, statusDetail: result.status_detail,
      method: 'pix', createdAt: Date.now()
    };
    saveDB('tips');
    io.to(`user:${receiverId}`).emit('tip-received', { amount: tipAmount, tipId, from: payer.nickname || '?', status: 'pending', method: 'pix' });

    res.json({
      status: result.status, tipId,
      qrCode, qrCodeBase64, ticketUrl,
      expiresIn: 30 // minutes
    });
  } catch (e) {
    console.error('PIX error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro ao gerar PIX: ' + (e.message || 'tente novamente') });
  }
});

// ═══ CHECKOUT PRO (redirect MP — all methods) ═══
app.post('/api/tip/checkout', async (req, res) => {
  const { payerId, receiverId, amount } = req.body;
  if (!payerId || !receiverId || !amount) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  const isOperatorWithTips = isOperatorWithTipsCheck(receiverId);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento não configurado.' });

  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100;
  const tipId = uuidv4();
  const baseUrl = MP_REDIRECT_URI.replace('/mp/callback', '');

  try {
    const prefData = {
      items: [{
        id: 'tip_' + tipId,
        title: 'Gorjeta Touch? — ' + (receiver.serviceLabel || receiver.nickname || 'gorjeta'),
        quantity: 1,
        unit_price: tipAmount,
        currency_id: 'BRL'
      }],
      payer: { email: payer.email || 'pagamento@encosta.app' },
      back_urls: {
        success: baseUrl + '/tip-result?status=approved&tipId=' + tipId,
        failure: baseUrl + '/tip-result?status=rejected&tipId=' + tipId,
        pending: baseUrl + '/tip-result?status=pending&tipId=' + tipId
      },
      auto_return: 'approved',
      external_reference: tipId,
      notification_url: baseUrl + '/mp/webhook',
      statement_descriptor: 'TOUCH GORJETA',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip_checkout' }
    };

    // If receiver connected via OAuth, use their credentials for split
    let preference;
    if (receiver.mpConnected && receiver.mpAccessToken) {
      prefData.marketplace_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      preference = await new Preference(receiverClient).create({ body: prefData });
    } else {
      const mpPref = new Preference(mpClient);
      preference = await mpPref.create({ body: prefData });
    }

    // Pre-save tip as pending
    db.tips[tipId] = {
      id: tipId, payerId, receiverId, amount: tipAmount, fee: touchFee,
      mpPreferenceId: preference.id, status: 'pending', statusDetail: 'waiting_checkout',
      method: 'checkout_pro', createdAt: Date.now()
    };
    saveDB('tips');

    console.log('🛒 Checkout Pro preference created:', preference.id);
    res.json({
      preferenceId: preference.id,
      initPoint: preference.init_point, // Production URL
      sandboxInitPoint: preference.sandbox_init_point, // Sandbox URL
      tipId
    });
  } catch (e) {
    console.error('Checkout Pro error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro ao criar checkout: ' + (e.message || 'tente novamente') });
  }
});

// Checkout Pro return page
app.get('/tip-result', (req, res) => {
  const { status, tipId, payment_id } = req.query;
  // Update tip if we got a payment_id from MP
  if (tipId && db.tips[tipId] && status) {
    db.tips[tipId].status = status === 'approved' ? 'approved' : status === 'pending' ? 'pending' : 'rejected';
    if (payment_id) db.tips[tipId].mpPaymentId = payment_id;
    if (status === 'approved') {
      const tip = db.tips[tipId];
      const receiver = db.users[tip.receiverId];
      if (receiver) { receiver.tipsReceived = (receiver.tipsReceived || 0) + 1; receiver.tipsTotal = (receiver.tipsTotal || 0) + tip.amount; }
      io.to(`user:${tip.receiverId}`).emit('tip-received', { amount: tip.amount, tipId, from: db.users[tip.payerId]?.nickname || '?', status: 'approved' });
    }
    saveDB('tips', 'users');
  }
  // Redirect back to app
  res.redirect('/?tipResult=' + (status || 'unknown') + '&tipId=' + (tipId || ''));
});

// Tip history for user
app.get('/api/tips/:userId', (req, res) => {
  const userId = req.params.userId;
  const tips = Object.values(db.tips).filter(t => t.payerId === userId || t.receiverId === userId)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const enriched = tips.map(t => ({
    ...t,
    payerName: db.users[t.payerId]?.nickname || '?',
    receiverName: db.users[t.receiverId]?.nickname || '?',
    receiverService: db.users[t.receiverId]?.serviceLabel || ''
  }));
  res.json(enriched);
});

// Full transaction history for a user (tips, entries, encounters)
app.get('/api/user/:userId/transactions', (req, res) => {
  const userId = req.params.userId;
  if (!db.users[userId]) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const transactions = [];
  // 1. Tips/payments
  Object.values(db.tips).forEach(t => {
    if (t.payerId !== userId && t.receiverId !== userId) return;
    const isSender = t.payerId === userId;
    const otherUser = db.users[isSender ? t.receiverId : t.payerId];
    transactions.push({
      id: t.id,
      type: t.type === 'entry' ? 'entry' : 'tip',
      direction: isSender ? 'sent' : 'received',
      amount: t.amount || 0,
      fee: t.fee || 0,
      status: t.status || 'unknown',
      statusDetail: t.statusDetail || '',
      otherName: otherUser ? (otherUser.nickname || otherUser.name) : (t.eventName || '?'),
      otherColor: otherUser ? otherUser.color : '#60a5fa',
      eventName: t.eventName || null,
      timestamp: t.createdAt || 0
    });
  });
  // 2. Encounters (connections)
  (db.encounters[userId] || []).forEach(e => {
    transactions.push({
      id: 'enc-' + e.timestamp,
      type: e.type === 'checkin' ? 'checkin' : (e.type === 'service' ? 'service' : 'connection'),
      direction: null,
      amount: 0,
      status: 'ok',
      otherName: e.withName || '?',
      otherColor: e.withColor || '#888',
      phrase: e.phrase || null,
      eventName: e.isEvent ? e.withName : null,
      timestamp: e.timestamp || 0
    });
  });
  transactions.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ transactions: transactions.slice(0, 100) });
});

// ── Prestador Dashboard API ──
app.get('/api/prestador/:userId/dashboard', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });

  // Tips received
  const tipsReceived = Object.values(db.tips)
    .filter(t => t.receiverId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const tipsApproved = tipsReceived.filter(t => t.status === 'approved');
  const totalReceived = tipsApproved.reduce((s, t) => s + (t.amount || 0), 0);
  const totalFees = tipsApproved.reduce((s, t) => s + (t.fee || 0), 0);
  const totalNet = totalReceived - totalFees;

  // Today
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const tipsToday = tipsApproved.filter(t => t.createdAt >= todayStart.getTime());
  const todayTotal = tipsToday.reduce((s, t) => s + (t.amount || 0), 0);

  // This week
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0,0,0,0);
  const tipsWeek = tipsApproved.filter(t => t.createdAt >= weekStart.getTime());
  const weekTotal = tipsWeek.reduce((s, t) => s + (t.amount || 0), 0);

  // This month
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const tipsMonth = tipsApproved.filter(t => t.createdAt >= monthStart.getTime());
  const monthTotal = tipsMonth.reduce((s, t) => s + (t.amount || 0), 0);

  // Encounters (encostadas) received
  const allEncounters = [];
  for (const [uid, encs] of Object.entries(db.encounters)) {
    for (const e of encs) {
      if (e.with === userId) {
        allEncounters.push({ userId: uid, nickname: db.users[uid]?.nickname || '?', timestamp: e.timestamp, tipAmount: e.tipAmount || 0, tipStatus: e.tipStatus || null });
      }
    }
  }
  allEncounters.sort((a, b) => b.timestamp - a.timestamp);

  // Enriched tips
  const tipsEnriched = tipsReceived.slice(0, 30).map(t => ({
    id: t.id, amount: t.amount, fee: t.fee || 0, net: (t.amount || 0) - (t.fee || 0),
    status: t.status, statusDetail: t.statusDetail,
    payerName: db.users[t.payerId]?.nickname || 'Anônimo',
    createdAt: t.createdAt
  }));

  res.json({
    name: user.nickname || user.name,
    serviceLabel: user.serviceLabel || '',
    isPrestador: !!user.isPrestador,
    mpConnected: !!user.mpConnected,
    stats: {
      totalReceived, totalFees, totalNet,
      totalCount: tipsApproved.length,
      todayTotal, todayCount: tipsToday.length,
      weekTotal, weekCount: tipsWeek.length,
      monthTotal, monthCount: tipsMonth.length
    },
    tips: tipsEnriched,
    encounters: allEncounters.slice(0, 50),
    encounterCount: allEncounters.length
  });
});

// MercadoPago webhook
app.post('/mp/webhook', (req, res) => {
  // Validate signature (basic)
  const xSig = req.headers['x-signature'] || '';
  // Process payment notifications
  if (req.body.type === 'payment' && req.body.data && req.body.data.id) {
    const paymentId = req.body.data.id;
    // Find tip by mpPaymentId and update status
    const tip = Object.values(db.tips).find(t => String(t.mpPaymentId) === String(paymentId));
    if (tip) {
      // Fetch latest status from MP
      mpPayment.get({ id: paymentId }).then(p => {
        tip.status = p.status;
        tip.statusDetail = p.status_detail;
        if (p.status === 'approved') {
          const receiver = db.users[tip.receiverId];
          if (receiver) {
            receiver.tipsReceived = (receiver.tipsReceived || 0) + 1;
            receiver.tipsTotal = (receiver.tipsTotal || 0) + tip.amount;
          }
          io.to(`user:${tip.receiverId}`).emit('tip-received', { amount: tip.amount, from: db.users[tip.payerId]?.nickname || '?' });
        }
        saveDB('tips', 'users');
      }).catch(e => console.error('Webhook MP fetch error:', e));
    }
  }
  res.sendStatus(200);
});

// ═══ SAVED CARD ═══
// ── Saved Card with MP Customer API ──
app.get('/api/tip/saved-card/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.savedCard && user.savedCard.lastFour && user.savedCard.customerId) {
    res.json({ hasSaved: true, lastFour: user.savedCard.lastFour, brand: user.savedCard.brand || 'Cartão', cardId: user.savedCard.cardId || null });
  } else {
    res.json({ hasSaved: false });
  }
});

// Save card: tokenize → create MP customer → save card to customer
app.post('/api/tip/save-card', async (req, res) => {
  const { userId, token, email, cpf } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'User not found' });
  if (!token) return res.status(400).json({ error: 'Token do cartão é obrigatório.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });
  const user = db.users[userId];
  try {
    let customerId = user.savedCard?.customerId;
    // Create customer if needed
    if (!customerId) {
      const custResp = await fetch('https://api.mercadopago.com/v1/customers', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email || email || 'pagamento@encosta.app', first_name: user.name || user.nickname || 'Touch User' })
      });
      // If email already exists, search for existing customer
      if (custResp.status === 400) {
        const searchResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(user.email || email || 'pagamento@encosta.app'), {
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
        });
        const searchData = await searchResp.json();
        if (searchData.results && searchData.results.length > 0) {
          customerId = searchData.results[0].id;
        } else {
          return res.status(500).json({ error: 'Não foi possível criar cliente no MP.' });
        }
      } else {
        const custData = await custResp.json();
        customerId = custData.id;
      }
    }
    // Save card to customer using token
    const cardResp = await fetch('https://api.mercadopago.com/v1/customers/' + customerId + '/cards', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const cardData = await cardResp.json();
    if (cardData.error || !cardData.id) {
      console.error('Save card error:', cardData);
      return res.status(400).json({ error: cardData.message || 'Erro ao salvar cartão.' });
    }
    // Store in DB — keep all we need for one-tap payments
    user.savedCard = {
      customerId,
      cardId: cardData.id,
      lastFour: cardData.last_four_digits,
      brand: cardData.payment_method?.name || cardData.issuer?.name || 'Cartão',
      paymentMethodId: cardData.payment_method?.id || 'visa',
      firstSix: cardData.first_six_digits,
      email: email || user.email || '',
      cpf: cpf || user.cpf || '',
      savedAt: Date.now()
    };
    saveDB('users');
    console.log('💳 Card saved for user', userId, '- customer:', customerId, 'card:', cardData.id, 'last4:', cardData.last_four_digits);
    res.json({ ok: true, lastFour: cardData.last_four_digits, brand: user.savedCard.brand });
  } catch (e) {
    console.error('Save card error:', e);
    res.status(500).json({ error: 'Erro ao salvar cartão: ' + (e.message || 'tente novamente') });
  }
});

// ═══ ONE-TAP PAYMENT — Server-side saved card charge (no CVV needed) ═══
app.post('/api/tip/quick-pay', async (req, res) => {
  const { payerId, receiverId, amount, cvv } = req.body;
  if (!payerId || !receiverId || !amount) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  if (!payer.savedCard?.customerId || !payer.savedCard?.cardId) return res.status(400).json({ error: 'Nenhum cartão salvo.' });
  const isOperatorWithTips = isOperatorWithTipsCheck(receiverId);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });
  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100;

  try {
    // 1. Verify customer exists on MP — if not, recreate
    let customerId = payer.savedCard.customerId;
    let cardId = payer.savedCard.cardId;
    const custCheck = await fetch('https://api.mercadopago.com/v1/customers/' + customerId, {
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
    });
    if (!custCheck.ok) {
      console.log('⚠️ Customer not found, recreating...', customerId);
      // Customer doesn't exist — recreate customer + re-add card
      const email = payer.email || payer.savedCard?.email || 'pagamento@encosta.app';
      const newCustResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(email), {
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
      });
      const searchData = await newCustResp.json();
      if (searchData.results && searchData.results.length > 0) {
        // Customer exists with this email, use it
        customerId = searchData.results[0].id;
        console.log('✅ Found existing customer by email:', customerId);
      } else {
        // Create new customer
        const createResp = await fetch('https://api.mercadopago.com/v1/customers', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const newCust = await createResp.json();
        if (!newCust.id) {
          console.error('⚠️ Customer creation failed:', newCust);
          delete payer.savedCard; saveDB('users');
          return res.status(400).json({ error: 'Erro ao recriar cliente. Cadastre o cartão novamente.', cardExpired: true });
        }
        customerId = newCust.id;
        console.log('✅ Created new customer:', customerId);
      }
      // Update saved customer ID
      payer.savedCard.customerId = customerId;
      saveDB('users');
      // Try to get cards from new customer
      const newCardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + customerId + '/cards', {
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
      });
      const newCards = newCardsResp.ok ? await newCardsResp.json() : [];
      if (!Array.isArray(newCards) || newCards.length === 0) {
        // No cards on new customer — need to re-register card
        delete payer.savedCard; saveDB('users');
        return res.status(400).json({ error: 'Cartão precisa ser cadastrado novamente.', cardExpired: true });
      }
      cardId = newCards[0].id;
      payer.savedCard.cardId = cardId;
      saveDB('users');
    }

    // 2. Get cards from customer
    const cardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + customerId + '/cards', {
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
    });
    if (!cardsResp.ok) {
      console.error('⚠️ Cards API error:', cardsResp.status);
      delete payer.savedCard; saveDB('users');
      return res.status(400).json({ error: 'Erro ao buscar cartão. Cadastre novamente.', cardExpired: true });
    }
    const cards = await cardsResp.json();
    if (!Array.isArray(cards) || cards.length === 0) {
      delete payer.savedCard; saveDB('users');
      return res.status(400).json({ error: 'Cartão salvo expirou. Cadastre novamente.', cardExpired: true });
    }
    const card = cards.find(c => c.id === cardId) || cards[0];

    // 3. Create card token — try with customer_id first, fallback without
    let tokenData;
    const tokenBody = { card_id: card.id, customer_id: customerId, ...(cvv ? { security_code: cvv } : {}) };
    const tokenResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenBody)
    });
    tokenData = await tokenResp.json();
    if (!tokenData.id) {
      console.error('⚠️ Token creation failed (with customer):', tokenData);
      // Fallback: try without customer_id
      const fallbackBody = { card_id: card.id, ...(cvv ? { security_code: cvv } : {}) };
      const fallbackResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody)
      });
      tokenData = await fallbackResp.json();
      if (!tokenData.id) {
        console.error('⚠️ Token fallback also failed:', tokenData);
        return res.status(400).json({ error: 'Erro ao processar cartão. Cadastre novamente.', cardExpired: true });
      }
    }

    // 4. Create payment using the fresh token
    const paymentData = {
      transaction_amount: tipAmount,
      token: tokenData.id,
      payment_method_id: card.payment_method?.id || payer.savedCard.paymentMethodId || 'visa',
      installments: 1,
      payer: {
        email: payer.email || payer.savedCard?.email || 'pagamento@encosta.app',
        identification: { type: 'CPF', number: (payer.cpf || payer.savedCard?.cpf || '').replace(/\D/g, '') }
      },
      description: 'Gorjeta Touch? — ' + (receiver.serviceLabel || receiver.nickname || receiver.name),
      statement_descriptor: 'TOUCH GORJETA',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip', method: 'one_tap' }
    };

    console.log('⚡ One-tap pay:', { amount: tipAmount, customer: payer.savedCard.customerId, card: card.id, last4: card.last_four_digits, method: card.payment_method?.id });

    let result;
    if (receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      result = await receiverPayment.create({ body: paymentData });
    } else {
      result = await mpPayment.create({ body: paymentData });
    }
    console.log('⚡ One-tap result:', { id: result.id, status: result.status, detail: result.status_detail });
    return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
  } catch (e) {
    console.error('One-tap error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente') });
  }
});

// ── MP Checkout — create preference for tip payment via Mercado Pago ──
app.post('/api/tip/mp-checkout', async (req, res) => {
  const { payerId, receiverId, amount } = req.body;
  if (!payerId || !receiverId || !amount) return res.status(400).json({ error: 'Dados incompletos.' });
  const receiver = db.users[receiverId];
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });
  try {
    const { Preference } = require('mercadopago');
    const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100;
    const prefBody = {
      items: [{ title: 'Gorjeta Touch? — ' + (receiver?.serviceLabel || receiver?.nickname || 'Touch'), quantity: 1, unit_price: tipAmount, currency_id: 'BRL' }],
      back_urls: { success: RENDER_URL + '/?tip_ok=1', failure: RENDER_URL + '/?tip_fail=1' },
      auto_return: 'approved',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip', method: 'mp_checkout' }
    };
    let initPoint;
    if (receiver?.mpConnected && receiver?.mpAccessToken) {
      prefBody.marketplace_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const pref = new Preference(receiverClient);
      const result = await pref.create({ body: prefBody });
      initPoint = result.init_point || result.sandbox_init_point;
    } else {
      const pref = new Preference(new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }));
      const result = await pref.create({ body: prefBody });
      initPoint = result.init_point || result.sandbox_init_point;
    }
    res.json({ initPoint });
  } catch (e) {
    console.error('MP checkout error:', e);
    res.status(500).json({ error: 'Erro ao criar checkout.' });
  }
});

// ── Subscribe with saved card (needs CVV) ──
app.post('/api/subscription/create-card', async (req, res) => {
  const { userId, planId, cvv } = req.body;
  if (!userId || !cvv) return res.status(400).json({ error: 'Dados incompletos.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!user.savedCard?.customerId || !user.savedCard?.cardId) return res.status(400).json({ error: 'Nenhum cartão salvo.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });
  try {
    // Verify customer exists, recreate if needed
    let custId = user.savedCard.customerId;
    const custCheck = await fetch('https://api.mercadopago.com/v1/customers/' + custId, {
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
    });
    if (!custCheck.ok) {
      console.log('⚠️ Sub: Customer not found, searching by email...');
      const email = user.email || user.savedCard?.email || 'pagamento@encosta.app';
      const searchResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(email), {
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
      });
      const searchData = await searchResp.json();
      if (searchData.results && searchData.results.length > 0) {
        custId = searchData.results[0].id;
      } else {
        const createResp = await fetch('https://api.mercadopago.com/v1/customers', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const newCust = await createResp.json();
        if (!newCust.id) { delete user.savedCard; saveDB('users'); return res.status(400).json({ error: 'Cadastre o cartão novamente.', cardExpired: true }); }
        custId = newCust.id;
      }
      user.savedCard.customerId = custId;
      // Get cards from updated customer
      const cardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + custId + '/cards', { headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN } });
      const cards = cardsResp.ok ? await cardsResp.json() : [];
      if (!Array.isArray(cards) || !cards.length) { delete user.savedCard; saveDB('users'); return res.status(400).json({ error: 'Cadastre o cartão novamente.', cardExpired: true }); }
      user.savedCard.cardId = cards[0].id;
      saveDB('users');
    }
    // Create token with CVV — try with customer, fallback without
    let tokenData;
    const tokenResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: user.savedCard.cardId, customer_id: custId, security_code: cvv })
    });
    tokenData = await tokenResp.json();
    if (!tokenData.id) {
      console.error('⚠️ Sub token failed:', tokenData);
      // Fallback without customer_id
      const fb = await fetch('https://api.mercadopago.com/v1/card_tokens', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: user.savedCard.cardId, security_code: cvv })
      });
      tokenData = await fb.json();
      if (!tokenData.id) return res.status(400).json({ error: 'CVV inválido ou cartão expirado.' });
    }
    // Create recurring payment
    const payerEmail = user.email || user.savedCard?.email;
    const payerCpf = user.cpf || user.savedCard?.cpf;
    if (!payerEmail || payerEmail.includes('@touch.app')) {
      return res.status(400).json({ error: 'Cadastre seu email no perfil antes de assinar.' });
    }
    if (!payerCpf || payerCpf === '00000000000') {
      return res.status(400).json({ error: 'Cadastre seu CPF no perfil antes de assinar.' });
    }
    const paymentData = {
      transaction_amount: 9.90,
      token: tokenData.id,
      payment_method_id: user.savedCard.paymentMethodId || 'visa',
      installments: 1,
      payer: { email: payerEmail, identification: { type: 'CPF', number: payerCpf } },
      description: 'Touch? Plus — Assinatura mensal',
      statement_descriptor: 'TOUCH PLUS',
      metadata: { user_id: userId, type: 'subscription', plan: planId }
    };
    console.log('💳 Sub card pay:', { email: payerEmail, cpf: payerCpf ? '***' + payerCpf.slice(-4) : 'none', method: user.savedCard.paymentMethodId, token: tokenData.id?.slice(0, 8) });
    const result = await mpPayment.create({ body: paymentData });
    console.log('💳 Sub card result:', { id: result.id, status: result.status, detail: result.status_detail });
    if (result.status === 'approved') {
      user.subscription = { active: true, planId, method: 'card', startDate: new Date().toISOString(), mpPaymentId: result.id };
      user.isSubscriber = true;
      user.verified = true;
      user.verifiedAt = user.verifiedAt || Date.now();
      user.verificationType = user.verificationType || 'subscriber';
      saveDB('users');
      res.json({ ok: true, status: result.status });
    } else {
      const detail = result.status_detail || result.status || 'recusado';
      const msgs = { cc_rejected_bad_filled_card_number: 'Número do cartão inválido', cc_rejected_bad_filled_date: 'Data de validade incorreta', cc_rejected_bad_filled_other: 'Dados do cartão incorretos', cc_rejected_bad_filled_security_code: 'CVV incorreto', cc_rejected_blacklist: 'Cartão bloqueado', cc_rejected_call_for_authorize: 'Ligue para a operadora para autorizar', cc_rejected_card_disabled: 'Cartão desabilitado', cc_rejected_duplicated_payment: 'Pagamento duplicado', cc_rejected_high_risk: 'Pagamento rejeitado por segurança', cc_rejected_insufficient_amount: 'Saldo insuficiente', cc_rejected_max_attempts: 'Excedido número de tentativas', cc_rejected_other_reason: 'Cartão recusado — tente outro' };
      res.status(400).json({ error: msgs[detail] || 'Pagamento recusado: ' + detail, detail });
    }
  } catch (e) {
    console.error('Sub card error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente') });
  }
});

app.delete('/api/tip/saved-card/:userId', async (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Remove card from MP customer if possible
  if (user.savedCard?.customerId && user.savedCard?.cardId && MP_ACCESS_TOKEN) {
    try {
      await fetch('https://api.mercadopago.com/v1/customers/' + user.savedCard.customerId + '/cards/' + user.savedCard.cardId, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
      });
    } catch (e) { console.error('Delete card from MP error:', e); }
  }
  delete user.savedCard;
  saveDB('users');
  res.json({ ok: true });
});

// ═══ ASSINATURA / SUBSCRIPTION ═══
const SUBSCRIPTION_PLANS = {
  touch_plus: {
    id: 'touch_plus',
    name: 'Touch? Plus',
    amount: 9.90,
    currency: 'BRL',
    frequency: 1, // months
    description: 'Assinatura mensal Touch? Plus',
    benefits: ['Perfil verificado', 'Prioridade na constelação', 'Badge exclusivo', 'Sem limites de conexões', 'Acesso antecipado a novidades']
  }
};

// Initialize subscriptions DB
if (!db.subscriptions) db.subscriptions = {};

// Get subscription plans
app.get('/api/subscription/plans', (req, res) => {
  res.json(Object.values(SUBSCRIPTION_PLANS));
});

// Get user subscription status
app.get('/api/subscription/status/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const sub = db.subscriptions[userId];
  if (!sub || sub.status === 'cancelled') {
    return res.json({ active: false, plan: null });
  }
  // Check if still valid
  const now = Date.now();
  if (sub.expiresAt && sub.expiresAt < now && sub.status !== 'authorized') {
    sub.status = 'expired';
    saveDB('users');
    return res.json({ active: false, plan: sub.planId, status: 'expired' });
  }
  res.json({
    active: sub.status === 'authorized' || sub.status === 'active' || (sub.expiresAt && sub.expiresAt > now),
    plan: sub.planId,
    status: sub.status,
    expiresAt: sub.expiresAt,
    startedAt: sub.startedAt,
    mpPreapprovalId: sub.mpPreapprovalId
  });
});

// Create subscription via MP Checkout Pro (simpler: recurring preference)
app.post('/api/subscription/create', async (req, res) => {
  const { userId, planId } = req.body;
  if (!userId || !planId) return res.status(400).json({ error: 'Dados incompletos.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Plano não encontrado.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento não configurado.' });

  const payerEmail = user.email || user.savedCard?.email || '';
  if (!payerEmail || payerEmail.includes('@touch.app')) {
    return res.status(400).json({ error: 'Cadastre seu email no perfil antes de assinar.' });
  }

  const baseUrl = MP_REDIRECT_URI.replace('/mp/callback', '');
  const subId = uuidv4();

  try {
    // Use MP Preapproval API (auto_recurring subscription)
    const preapprovalData = {
      reason: plan.description,
      auto_recurring: {
        frequency: plan.frequency,
        frequency_type: 'months',
        transaction_amount: plan.amount,
        currency_id: plan.currency
      },
      back_url: baseUrl + '/sub-result?subId=' + subId + '&userId=' + userId,
      payer_email: payerEmail,
      external_reference: subId,
      notification_url: baseUrl + '/mp/webhook/subscription'
    };

    const mpResp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + MP_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preapprovalData)
    });
    const preapproval = await mpResp.json();

    if (preapproval.error) {
      console.error('MP Preapproval error:', preapproval);
      throw new Error(preapproval.message || 'Erro ao criar assinatura');
    }

    console.log('📋 Subscription created:', { id: preapproval.id, status: preapproval.status });

    // Save subscription
    db.subscriptions[userId] = {
      id: subId,
      userId,
      planId: plan.id,
      mpPreapprovalId: preapproval.id,
      status: preapproval.status || 'pending',
      startedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86400000, // 30 days initial
      amount: plan.amount,
      createdAt: Date.now()
    };
    user.isSubscriber = false; // Will be activated on webhook confirmation
    saveDB('users');

    res.json({
      subId,
      initPoint: preapproval.init_point,
      sandboxInitPoint: preapproval.sandbox_init_point,
      status: preapproval.status
    });
  } catch (e) {
    console.error('Subscription error:', e.message);
    res.status(500).json({ error: 'Erro ao criar assinatura: ' + (e.message || 'tente novamente') });
  }
});

// Subscription return page
app.get('/sub-result', (req, res) => {
  const { subId, userId } = req.query;
  if (subId && userId && db.subscriptions[userId]) {
    const sub = db.subscriptions[userId];
    if (sub.id === subId) {
      sub.status = 'authorized';
      const user = db.users[userId];
      if (user) {
        user.isSubscriber = true;
        user.verified = true;
        user.verifiedAt = user.verifiedAt || Date.now();
        user.verificationType = user.verificationType || 'subscriber';
      }
      saveDB('users');
    }
  }
  res.redirect('/?subResult=ok');
});

// Subscription webhook
app.post('/mp/webhook/subscription', (req, res) => {
  const { type, data } = req.body;
  if (type === 'subscription_preapproval' && data && data.id) {
    // Fetch latest status
    fetch('https://api.mercadopago.com/preapproval/' + data.id, {
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
    }).then(r => r.json()).then(pa => {
      // Find subscription by mpPreapprovalId
      const entry = Object.entries(db.subscriptions).find(([k, v]) => v.mpPreapprovalId === data.id);
      if (entry) {
        const [uid, sub] = entry;
        sub.status = pa.status; // authorized, paused, cancelled
        const user = db.users[uid];
        if (user) {
          user.isSubscriber = (pa.status === 'authorized');
          if (pa.status === 'authorized') {
            user.verified = true;
            user.verifiedAt = user.verifiedAt || Date.now();
            user.verificationType = user.verificationType || 'subscriber';
          }
        }
        if (pa.status === 'cancelled') {
          sub.cancelledAt = Date.now();
        }
        saveDB('users');
        console.log('📋 Subscription webhook:', { userId: uid, status: pa.status });
      }
    }).catch(e => console.error('Sub webhook error:', e));
  }
  res.sendStatus(200);
});

// Cancel subscription
app.post('/api/subscription/cancel', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatório.' });
  const sub = db.subscriptions[userId];
  if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento não configurado.' });

  try {
    // Cancel on MP
    if (sub.mpPreapprovalId) {
      await fetch('https://api.mercadopago.com/preapproval/' + sub.mpPreapprovalId, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + MP_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'cancelled' })
      });
    }
    sub.status = 'cancelled';
    sub.cancelledAt = Date.now();
    const user = db.users[userId];
    if (user) {
      user.isSubscriber = false;
      // Only remove verified if it was subscriber-only verification
      if (user.verificationType === 'subscriber') {
        user.verified = false;
        delete user.verifiedAt;
        delete user.verificationType;
      }
    }
    saveDB('users');
    res.json({ ok: true });
  } catch (e) {
    console.error('Cancel sub error:', e);
    res.status(500).json({ error: 'Erro ao cancelar: ' + e.message });
  }
});

// ═══ OPERATOR / CHECK-IN ═══
app.get('/operator', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'operator.html'));
});

app.get('/api/operator/checkins/:userId', (req, res) => {
  const userId = req.params.userId;
  const list = db.encounters[userId] || [];
  const opUser = db.users[userId];
  const checkins = list.filter(e => e.type === 'checkin').map(e => ({
    with: e.with, withName: e.withName, withColor: e.withColor,
    timestamp: e.timestamp, date: e.date, relationId: e.relationId || null,
    revealed: !!(opUser && opUser.canSee && opUser.canSee[e.with]),
    revealData: (opUser && opUser.canSee && opUser.canSee[e.with]) ? opUser.canSee[e.with] : null
  }));
  checkins.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ checkins, total: checkins.length });
});

// ═══ OPERATOR SETTINGS ═══
app.get('/api/operator/settings/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.operatorSettings || { requireReveal: false });
});

app.post('/api/operator/settings', (req, res) => {
  const { userId, requireReveal } = req.body;
  if (!userId || !db.users[userId]) return res.status(404).json({ error: 'User not found' });
  if (!db.users[userId].operatorSettings) db.users[userId].operatorSettings = {};
  db.users[userId].operatorSettings.requireReveal = !!requireReveal;
  saveDB('users');
  res.json({ ok: true, settings: db.users[userId].operatorSettings });
});

// ═══ OPERATOR EVENTS ═══
app.post('/api/operator/event/create', (req, res) => {
  const { userId, name, description, acceptsTips, serviceLabel, entryPrice } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nome do evento obrigatório (mín. 2 caracteres).' });
  const id = uuidv4();
  const price = parseFloat(entryPrice) || 0;
  db.operatorEvents[id] = {
    id, name: name.trim(), description: (description || '').trim(),
    creatorId: userId, creatorName: db.users[userId].nickname || db.users[userId].name,
    active: true, participants: [], checkinCount: 0,
    acceptsTips: !!acceptsTips, serviceLabel: (serviceLabel || '').trim(),
    entryPrice: price > 0 ? price : 0,
    revenue: 0, paidCheckins: 0,
    createdAt: Date.now()
  };
  saveDB('operatorEvents');
  res.json({ event: db.operatorEvents[id] });
});

// ═══ PAY EVENT ENTRY — charge entry fee on check-in ═══
app.post('/api/operator/event/:eventId/pay-entry', async (req, res) => {
  const { userId, token, paymentMethodId, payerEmail, payerCPF, useSavedCard, deviceId, cardholderName } = req.body;
  console.log('🎫 pay-entry request:', { eventId: req.params.eventId, userId: userId?.slice(0,12), hasToken: !!token, useSavedCard, hasEmail: !!payerEmail });
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!ev.active) return res.status(400).json({ error: 'Evento encerrado.' });
  if (!ev.entryPrice || ev.entryPrice <= 0) return res.status(400).json({ error: 'Evento sem cobrança de ingresso.' });
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório.' });
  const user = db.users[userId];
  if (!user) {
    console.error('🎫 User not found in db.users:', userId, 'Total users:', Object.keys(db.users).length);
    return res.status(404).json({ error: 'Usuário não encontrado. Faça login novamente.' });
  }
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });

  const amount = ev.entryPrice;
  const touchFee = Math.round(amount * TOUCH_FEE_PERCENT) / 100;
  const receiver = db.users[ev.creatorId];

  try {
    let paymentToken = token;

    // One-tap: create token server-side from saved card
    if (useSavedCard && user.savedCard?.customerId && user.savedCard?.cardId) {
      try {
        let entryCustId = user.savedCard.customerId;
        const custCheck = await fetch('https://api.mercadopago.com/v1/customers/' + entryCustId, {
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
        });
        if (!custCheck.ok) {
          const email = user.email || user.savedCard?.email || 'pagamento@encosta.app';
          const searchResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(email), { headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN } });
          const searchData = await searchResp.json();
          if (searchData.results && searchData.results.length > 0) {
            entryCustId = searchData.results[0].id;
            user.savedCard.customerId = entryCustId;
            saveDB('users');
          } else {
            delete user.savedCard; saveDB('users');
            return res.status(400).json({ error: 'Cadastre o cartão novamente.', cardExpired: true });
          }
        }
        const cardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + entryCustId + '/cards', {
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
        });
        const cards = cardsResp.ok ? await cardsResp.json() : [];
        if (!Array.isArray(cards) || cards.length === 0) {
          delete user.savedCard; saveDB('users');
          return res.status(400).json({ error: 'Cartão salvo expirou.', cardExpired: true });
        }
        const card = cards.find(c => c.id === user.savedCard.cardId) || cards[0];
        let tokenData;
        const tokenResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_id: card.id, customer_id: entryCustId })
        });
        tokenData = await tokenResp.json();
        if (!tokenData.id) {
          const fb = await fetch('https://api.mercadopago.com/v1/card_tokens', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ card_id: card.id })
          });
          tokenData = await fb.json();
          if (!tokenData.id) return res.status(400).json({ error: 'Erro ao processar cartão.', cardExpired: true });
        }
        paymentToken = tokenData.id;
        var pmId = card.payment_method?.id || user.savedCard.paymentMethodId || 'visa';
      } catch (mpErr) {
        console.error('🎫 One-tap MP error:', mpErr.message);
        // Any MP API error → tell frontend to show card form
        return res.status(400).json({ error: 'Erro com cartão salvo.', cardExpired: true });
      }
    }

    const payerEmailFinal = payerEmail || user.email || '';
    const payerCPFFinal = (payerCPF || user.cpf || user.savedCard?.cpf || '').replace(/\D/g, '');
    const payerName = user.name || user.nickname || 'Visitante';
    const paymentData = {
      transaction_amount: amount,
      token: paymentToken,
      payment_method_id: pmId || paymentMethodId || 'visa',
      installments: 1,
      binary_mode: true,
      payer: {
        email: payerEmailFinal,
        first_name: cardholderName ? cardholderName.split(' ')[0] : payerName.split(' ')[0],
        last_name: cardholderName ? (cardholderName.split(' ').slice(1).join(' ') || cardholderName.split(' ')[0]) : (payerName.split(' ').slice(1).join(' ') || payerName.split(' ')[0]),
        identification: payerCPFFinal ? { type: 'CPF', number: payerCPFFinal } : undefined
      },
      additional_info: {
        items: [{
          id: ev.id,
          title: 'Ingresso ' + ev.name,
          description: 'Check-in no evento ' + ev.name,
          category_id: 'entertainment',
          quantity: 1,
          unit_price: amount
        }],
        payer: {
          first_name: cardholderName ? cardholderName.split(' ')[0] : payerName.split(' ')[0],
          last_name: cardholderName ? (cardholderName.split(' ').slice(1).join(' ') || cardholderName.split(' ')[0]) : (payerName.split(' ').slice(1).join(' ') || payerName.split(' ')[0]),
          registration_date: user.createdAt ? new Date(user.createdAt).toISOString() : undefined
        }
      },
      description: 'Ingresso Touch? — ' + ev.name,
      statement_descriptor: 'TOUCH INGRESSO',
      metadata: { payer_id: userId, event_id: ev.id, operator_id: ev.creatorId, type: 'entry' }
    };

    console.log('🎫 Entry payment:', { amount, event: ev.name, user: userId.slice(0, 8), method: paymentData.payment_method_id, hasDeviceId: !!deviceId });

    const idempotencyKey = uuidv4();
    const requestOptions = { idempotencyKey };

    let result;
    if (receiver && receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      result = await receiverPayment.create({ body: paymentData, requestOptions });
    } else {
      result = await mpPayment.create({ body: paymentData, requestOptions });
    }

    console.log('🎫 Entry result:', { id: result.id, status: result.status, detail: result.status_detail });

    // Always save payment record (approved, rejected, pending)
    const tipId = uuidv4();
    db.tips[tipId] = {
      id: tipId, payerId: userId, receiverId: ev.creatorId,
      amount, fee: touchFee, mpPaymentId: result.id,
      status: result.status, statusDetail: result.status_detail,
      type: 'entry', eventId: ev.id, eventName: ev.name,
      createdAt: Date.now()
    };

    if (result.status === 'approved') {
      ev.revenue = (ev.revenue || 0) + amount;
      ev.paidCheckins = (ev.paidCheckins || 0) + 1;
      saveDB('operatorEvents');
      io.to(`user:${ev.creatorId}`).emit('entry-paid', { userId, amount, eventId: ev.id, nickname: user.nickname || user.name });
    }
    saveDB('tips');

    res.json({ status: result.status, statusDetail: result.status_detail, mpPaymentId: result.id });
  } catch (e) {
    console.error('Entry payment error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente') });
  }
});

app.get('/api/operator/events/:userId', (req, res) => {
  const userId = req.params.userId;
  const evIds = IDX.operatorByCreator.get(userId) || [];
  const events = evIds.map(eid => db.operatorEvents[eid]).filter(Boolean);
  events.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ events });
});

app.post('/api/operator/event/:eventId/end', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  ev.active = false;
  ev.endedAt = Date.now();
  // Remove from sonicQueue
  delete sonicQueue['evt:' + ev.id];
  // Expire all event checkin relations (removes from chat list)
  const now = Date.now();
  for (const rId in db.relations) {
    const r = db.relations[rId];
    if (r.eventId === ev.id && r.isEventCheckin && r.expiresAt > now) {
      r.expiresAt = now; // expire immediately
    }
  }
  // Notify all participants
  io.to('event:' + ev.id).emit('event-ended', { eventId: ev.id, name: ev.name });
  saveDB('operatorEvents', 'relations');
  res.json({ ok: true });
});

app.post('/api/operator/event/:eventId/leave', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatório.' });
  ev.participants = (ev.participants || []).filter(uid => uid !== userId);
  ev.checkinCount = ev.participants.length;
  // Expire this user's event checkin relation (removes from chat list)
  const now = Date.now();
  for (const rId in db.relations) {
    const r = db.relations[rId];
    if (r.eventId === ev.id && r.isEventCheckin && (r.userA === userId || r.userB === userId) && r.expiresAt > now) {
      r.expiresAt = now;
    }
  }
  // Leave socket room
  const userSockets = io.sockets.adapter.rooms.get(`user:${userId}`);
  if (userSockets) {
    for (const sid of userSockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave('event:' + ev.id);
    }
  }
  io.to('event:' + ev.id).emit('event-attendee-left', { userId, eventId: ev.id });
  io.to(`user:${ev.creatorId}`).emit('event-attendee-left', { userId, eventId: ev.id });
  // Notify the removed user directly so their phone closes the event
  io.to(`user:${userId}`).emit('event-kicked', { userId, eventId: ev.id });
  saveDB('operatorEvents', 'relations');
  res.json({ ok: true });
});

app.get('/api/operator/event/:eventId/attendees', (req, res) => {
  try {
    const ev = db.operatorEvents[req.params.eventId];
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
    const totalUsers = Object.keys(db.users).length;
    const attendees = (ev.participants || []).map(uid => {
      try {
        const u = db.users[uid];
        if (!u) return null;
        const stars = (u.stars || []).length;
        const order = u.registrationOrder || 9999;
        const topTag = calculateTopTag(order, totalUsers);
        const creatorUser = db.users[ev.creatorId];
        const revealed = !!(creatorUser && creatorUser.canSee && creatorUser.canSee[uid]);
        const revealData = revealed ? creatorUser.canSee[uid] : null;
        return {
          userId: uid, nickname: u.nickname || u.name, color: u.color,
          profilePhoto: u.profilePhoto || u.photoURL || null,
          stars, topTag, revealed, revealData,
          score: calcScore(uid)
        };
      } catch (e) { console.error('[attendees] error mapping uid:', uid, e.message); return null; }
    }).filter(Boolean);
    res.json({ attendees, eventName: ev.name, active: ev.active });
  } catch (e) {
    console.error('[attendees] 500:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

// Async startup: load DB then start server (always starts even if DB fails)
(async () => {
  console.log(`🚀 Iniciando servidor... (PORT=${PORT})`);
  try {
    await loadDB();
  } catch (e) {
    console.error('❌ loadDB falhou completamente:', e.message);
    dbLoaded = true; // start with empty DB
  }
  console.log('✅ loadDB concluído, abrindo porta...');
  server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
      }
    }
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║         Touch? está rodando          ║`);
    console.log(`  ╠══════════════════════════════════════╣`);
    console.log(`  ║  Local:  http://localhost:${PORT}       ║`);
    console.log(`  ║  Rede:   http://${localIP}:${PORT}  ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
})();
