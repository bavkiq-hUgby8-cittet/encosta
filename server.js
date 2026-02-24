const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MercadoPagoConfig, Payment, Preference, OAuth } = require('mercadopago');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ── Crash protection: prevent server from dying on unhandled errors ──
process.on('uncaughtException', (err) => {
  console.error('🔴 Uncaught Exception:', err.message, err.stack?.split('\n').slice(0,3).join('\n'));
});
process.on('unhandledRejection', (reason) => {
  console.error('🔴 Unhandled Rejection:', reason?.message || reason);
});

// ── Security: Admin secret for protected endpoints ──
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
if (!ADMIN_SECRET) console.warn('⚠️ ADMIN_SECRET não configurado! Endpoints admin desprotegidos. Defina ADMIN_SECRET nas variáveis de ambiente.');

// ── Security: Allowed origins for CORS ──
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
// Fallback: allow common origins in dev
const DEFAULT_ORIGINS = ['https://touch-irl.com', 'https://www.touch-irl.com', 'https://encosta.onrender.com'];
const CORS_ORIGINS = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : DEFAULT_ORIGINS;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // Allow no-origin requests (mobile apps, curl, server-to-server)
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.touch-irl.com')) return cb(null, true);
      cb(new Error('CORS blocked: ' + origin));
    },
    methods: ['GET', 'POST']
  }
});

// ── Security headers via helmet ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://sdk.mercadopago.com", "https://http2.mlstatic.com", "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://apis.google.com", "https://www.gstatic.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://www.google.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      connectSrc: ["'self'", "https:", "wss:", "ws:"],
      frameSrc: ["'self'", "https://sdk.mercadopago.com", "https://accounts.google.com", "https://*.firebaseapp.com", "https://www.google.com"],
      childSrc: ["'self'", "blob:", "https://accounts.google.com", "https://*.firebaseapp.com", "https://www.google.com"],
      formAction: ["'self'", "https://accounts.google.com", "https://*.google.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      scriptSrcAttr: ["'unsafe-inline'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "unsafe-none" }, // Required for Google OAuth popup
  crossOriginResourcePolicy: false // Required for external resources
}));

// ── Rate limiting ──
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300, // 300 requests per 15min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 auth attempts per 15 min
  message: { error: 'Muitas tentativas de autenticação. Aguarde 15 minutos.' }
});

const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15, // 15 payment attempts per 5 min
  message: { error: 'Muitas tentativas de pagamento. Aguarde alguns minutos.' }
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Rate limit atingido nos endpoints admin.' }
});

const vaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 10, // 10 VA/dev calls per 5 min per IP
  message: { error: 'Muitas chamadas ao assistente. Aguarde alguns minutos.' }
});

app.use(generalLimiter);

// ── Redirect old domain to touch-irl.com ──
app.use((req, res, next) => {
  const host = req.hostname;
  if (host && host.endsWith('.onrender.com')) {
    return res.redirect(301, 'https://touch-irl.com' + req.originalUrl);
  }
  next();
});
// Parse JSON for all routes EXCEPT Stripe webhook (needs raw body for signature verification)
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json({ limit: '5mb' })(req, res, next);
  }
});

// ── DB readiness gate: return 503 for API calls while DB is loading ──
app.use((req, res, next) => {
  if (!dbLoaded && req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'Servidor iniciando, aguarde...' });
  }
  next();
});

// ── Cache control: no-cache for HTML, cache for assets ──
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
}));

// ── Input sanitization helpers ──
function sanitizeStr(s, maxLen = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>]/g, '').trim().slice(0, maxLen);
}
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}
function isValidUUID(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

// ── User authentication middleware: verifies userId belongs to a real user ──
// Phase 1 (current): validates userId exists in DB (blocks random/guessed IDs)
// Phase 2 (future): enforce Firebase token match on ALL calls (after frontend update)
// Usage: app.get('/api/something/:userId', requireAuth, handler)
// Sets req.authUserId to the verified user ID
function requireAuth(req, res, next) {
  // Extract userId from route params, body, or query
  const requestedUserId = req.params.userId || req.body?.userId || req.query?.userId;
  if (!requestedUserId) return res.status(400).json({ error: 'userId obrigatorio.' });

  // Method 1: Firebase token verification (strongest — used when frontend sends token)
  if (req.firebaseUser) {
    const fbUid = req.firebaseUser.uid;
    const resolvedId = IDX.firebaseUid.get(fbUid);
    if (resolvedId && resolvedId === requestedUserId) {
      req.authUserId = resolvedId;
      return next();
    }
    // Check linked UIDs
    const user = db.users[requestedUserId];
    if (user && user.linkedFirebaseUids && user.linkedFirebaseUids.includes(fbUid)) {
      req.authUserId = requestedUserId;
      return next();
    }
  }

  // Method 2: Admin override via ADMIN_SECRET header
  const secret = req.headers['x-admin-secret'];
  if (ADMIN_SECRET && secret === ADMIN_SECRET) {
    req.authUserId = requestedUserId;
    return next();
  }

  // Method 3: Backwards-compatible fallback — userId must exist in DB
  // This prevents accessing data of non-existent users or brute-forcing IDs
  // TODO: Phase 2 — remove this fallback after frontend sends Firebase token on all calls
  if (requestedUserId && db.users[requestedUserId]) {
    req.authUserId = requestedUserId;
    return next();
  }

  return res.status(403).json({ error: 'Acesso negado. Autenticacao necessaria.' });
}

// ── Admin authentication middleware ──
function requireAdmin(req, res, next) {
  // Method 1: ADMIN_SECRET header
  const secret = req.headers['x-admin-secret'];
  if (ADMIN_SECRET && secret === ADMIN_SECRET) return next();

  // Method 2: Firebase auth + isAdmin flag in DB
  if (req.firebaseUser) {
    const uid = req.firebaseUser.uid;
    const userId = IDX.firebaseUid.get(uid);
    if (userId && db.users[userId]?.isAdmin) {
      req.adminUserId = userId;
      return next();
    }
  }

  // Method 3: userId in body + isAdmin flag (legacy, requires ADMIN_SECRET to be unset)
  const { adminId, userId } = req.body || {};
  const checkId = adminId || userId;
  if (checkId && db.users[checkId]?.isAdmin) {
    // Only allow this fallback if ADMIN_SECRET is not configured (dev mode)
    if (!ADMIN_SECRET) {
      req.adminUserId = checkId;
      return next();
    }
  }

  return res.status(403).json({ error: 'Acesso negado. Autenticação admin necessária.' });
}

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
const DB_COLLECTIONS = ['users', 'sessions', 'relations', 'messages', 'encounters', 'gifts', 'declarations', 'events', 'checkins', 'tips', 'streaks', 'locations', 'revealRequests', 'likes', 'starDonations', 'operatorEvents', 'docVerifications', 'faceData', 'gameConfig', 'subscriptions', 'verifications', 'faceAccessLog', 'gameSessions', 'gameScores', 'ultimateBank', 'vaConfig', 'vaConversations', 'deliveryOrders'];
let db = {};
DB_COLLECTIONS.forEach(c => db[c] = {});
let dbLoaded = false;
let saveTimer = null;
let registrationCounter = 0; // global signup order

// ── Top Tag Calculation ──
// calculateTopTag — now based on stars ranking, not registration order
// 'rank' = position in stars-sorted list (1 = most stars)
function calculateTopTag(rank, totalUsers) {
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
    if (rank <= t.max && totalUsers >= t.needTotal) return t.tag;
  }
  // Always show top1 for rank 1 even with few users
  if (rank === 1) return 'top1';
  return null;
}

// Recalculate all topTags based on stars ranking
// PERFORMANCE: debounced to run at most once every 5 minutes (avoids O(n log n) on every star donation)
let _topTagTimer = null;
let _topTagLastRun = 0;
const TOP_TAG_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

function _doRecalcAllTopTags() {
  const users = Object.values(db.users);
  const totalUsers = users.length;
  const sorted = users
    .map(u => ({ id: u.id, stars: (u.stars || []).length, regOrder: u.registrationOrder || 9999 }))
    .sort((a, b) => b.stars - a.stars || a.regOrder - b.regOrder);
  sorted.forEach((s, idx) => {
    const rank = idx + 1;
    const user = db.users[s.id];
    if (user) user.topTag = calculateTopTag(rank, totalUsers);
  });
  _topTagLastRun = Date.now();
}

function recalcAllTopTags(force = false) {
  // Force: run immediately (used during init and admin operations)
  if (force || !_topTagLastRun) {
    if (_topTagTimer) { clearTimeout(_topTagTimer); _topTagTimer = null; }
    _doRecalcAllTopTags();
    return;
  }
  // Debounce: schedule if not already scheduled
  if (!_topTagTimer) {
    const elapsed = Date.now() - _topTagLastRun;
    const delay = Math.max(0, TOP_TAG_DEBOUNCE_MS - elapsed);
    _topTagTimer = setTimeout(() => {
      _topTagTimer = null;
      _doRecalcAllTopTags();
      saveDB('users');
    }, delay);
  }
}

// Helper: promise with timeout
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms))
  ]);
}

let _dbLoadedFromCloud = false; // true if DB was loaded from Firebase with real data
async function loadDB() {
  console.log('loadDB() iniciando... RTDB URL:', FIREBASE_DB_URL);
  try {
    // Load from Firebase Realtime Database (with 30s timeout — generous to survive slow cold starts)
    console.log('Tentando conectar ao RTDB...');
    const snapshot = await withTimeout(rtdb.ref('/').once('value'), 30000, 'RTDB read');
    const data = snapshot.val();
    if (data) {
      DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
      const userCount = Object.keys(db.users).length;
      if (userCount > 0) _dbLoadedFromCloud = true;
      console.log('DB carregado do Firebase Realtime Database (' + userCount + ' users)');
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
    // Initialize corruption guard counts
    DB_COLLECTIONS.forEach(c => { _lastKnownCounts[c] = Object.keys(db[c] || {}).length; });
    console.log('🛡️ Corruption guard initialized:', JSON.stringify(_lastKnownCounts));
    initRegistrationCounter();
    // Auto-backup on startup (async, don't block)
    if (Object.keys(db.users).length > 0) {
      createBackup('auto:server-start').catch(e => console.warn('Startup backup failed:', e.message));
    }
  } catch (e) {
    console.error('Erro ao carregar DB (tentativa 1):', e.message);
    // RETRY once with longer timeout before giving up
    try {
      console.log('Retry: tentando RTDB novamente com timeout maior...');
      const retrySnap = await withTimeout(rtdb.ref('/').once('value'), 45000, 'RTDB retry');
      const retryData = retrySnap.val();
      if (retryData) {
        DB_COLLECTIONS.forEach(c => { db[c] = retryData[c] || {}; });
        const uc = Object.keys(db.users).length;
        if (uc > 0) _dbLoadedFromCloud = true;
        console.log('DB carregado do RTDB no retry (' + uc + ' users)');
        dbLoaded = true;
        DB_COLLECTIONS.forEach(c => { _lastKnownCounts[c] = Object.keys(db[c] || {}).length; });
        initRegistrationCounter();
        if (Object.keys(db.users).length > 0) {
          createBackup('auto:server-start-retry').catch(e => console.warn('Startup backup failed:', e.message));
        }
        return; // success on retry
      }
    } catch (retryErr) {
      console.error('Retry tambem falhou:', retryErr.message);
    }
    console.log('Usando fallback local...');
    const DB_FILE = path.join(__dirname, 'db.json');
    try {
      if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
        console.log('DB carregado de db.json (fallback)');
      } else {
        console.log('DB novo criado (sem RTDB, sem db.json) — WRITES BLOQUEADOS para colecoes criticas ate reconectar');
      }
    } catch (e2) {
      console.error('Fallback db.json tambem falhou:', e2.message);
    }
    dbLoaded = true;
    DB_COLLECTIONS.forEach(c => { _lastKnownCounts[c] = Object.keys(db[c] || {}).length; });
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
  // Recalculate topTags based on stars ranking (not registration order)
  recalcAllTopTags(true); // force: initial load
  console.log(`Registration counter: ${registrationCounter}, ${users.length} users migrated`);
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
  email: new Map(),          // email.toLowerCase() → userId
  phone: new Map(),          // phone (e.g. +5511999...) → userId
  cpf: new Map(),            // cpf (digits only) → userId
  tipsByPayer: new Map(),     // payerId -> [tipIds]
  tipsByReceiver: new Map(),  // receiverId -> [tipIds]
};

function rebuildIndexes() {
  IDX.firebaseUid.clear(); IDX.touchCode.clear(); IDX.nickname.clear();
  IDX.relationPair.clear(); IDX.relationsByUser.clear();
  IDX.donationsByFrom.clear(); IDX.donationsByPair.clear();
  IDX.operatorByCreator.clear();
  IDX.email.clear(); IDX.phone.clear(); IDX.cpf.clear();
  IDX.tipsByPayer.clear(); IDX.tipsByReceiver.clear();
  for (const [uid, u] of Object.entries(db.users)) {
    if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, uid);
    if (u.touchCode) IDX.touchCode.set(u.touchCode, uid);
    if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), uid);
    if (u.email) IDX.email.set(u.email.toLowerCase(), uid);
    if (u.phone) IDX.phone.set(u.phone, uid);
    if (u.cpf) IDX.cpf.set(u.cpf.replace(/\D/g, ''), uid);
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
    // Firebase RTDB drops empty arrays — ensure participants always exists
    if (!Array.isArray(ev.participants)) ev.participants = [];
    if (ev.creatorId) {
      if (!IDX.operatorByCreator.has(ev.creatorId)) IDX.operatorByCreator.set(ev.creatorId, []);
      IDX.operatorByCreator.get(ev.creatorId).push(eid);
    }
  }
  // Firebase RTDB converts arrays with numeric keys to objects — convert back to arrays
  // Affects: encounters[userId], messages[relId], gifts[userId], declarations[userId]
  let arrayFixCount = 0;
  for (const col of ['encounters', 'messages', 'gifts', 'declarations']) {
    for (const key of Object.keys(db[col] || {})) {
      const val = db[col][key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        db[col][key] = Object.values(val);
        arrayFixCount++;
      }
    }
  }
  if (arrayFixCount > 0) console.log(`🔧 Fixed ${arrayFixCount} array entries (Firebase object→array conversion)`);
  // Same fix for user arrays: stars, likedBy, revealedTo
  for (const u of Object.values(db.users)) {
    if (u.stars && !Array.isArray(u.stars)) u.stars = Object.values(u.stars);
    if (u.likedBy && !Array.isArray(u.likedBy)) u.likedBy = Object.values(u.likedBy);
    if (u.revealedTo && !Array.isArray(u.revealedTo)) u.revealedTo = Object.values(u.revealedTo);
  }
  for (const [tid, t] of Object.entries(db.tips || {})) {
    if (t.payerId) {
      if (!IDX.tipsByPayer.has(t.payerId)) IDX.tipsByPayer.set(t.payerId, []);
      IDX.tipsByPayer.get(t.payerId).push(tid);
    }
    if (t.receiverId) {
      if (!IDX.tipsByReceiver.has(t.receiverId)) IDX.tipsByReceiver.set(t.receiverId, []);
      IDX.tipsByReceiver.get(t.receiverId).push(tid);
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

// Helper: check if userId is revealed to targetUser, optionally scoped to eventId
// Returns the canSee entry if revealed, null otherwise
function isRevealedTo(userId, targetUser, eventId) {
  if (!targetUser || !targetUser.canSee) return null;
  // 1. Check permanent (non-event) reveal
  if (targetUser.canSee[userId] && !targetUser.canSee[userId].eventId) return targetUser.canSee[userId];
  // 2. If eventId provided, check event-scoped reveal
  if (eventId) {
    const evKey = userId + ':evt:' + eventId;
    if (targetUser.canSee[evKey]) return targetUser.canSee[evKey];
  }
  // 3. Also check old-style entries (userId key with eventId field) for backwards compat
  if (targetUser.canSee[userId] && targetUser.canSee[userId].eventId) {
    // Old entry scoped to an event — only return if matches current event
    if (eventId && targetUser.canSee[userId].eventId === eventId) return targetUser.canSee[userId];
    return null; // scoped to different event
  }
  return null;
}

// Helper: get all non-event-scoped canSee entries for a user
function getPermanentReveals(targetUser) {
  if (!targetUser || !targetUser.canSee) return {};
  const result = {};
  for (const key in targetUser.canSee) {
    const entry = targetUser.canSee[key];
    if (!entry.eventId && !key.includes(':evt:')) {
      result[key] = entry;
    }
  }
  return result;
}

// Helper: check nickname taken in O(1)
function isNickTaken(nick) { return IDX.nickname.has(nick.toLowerCase()); }

// Helper: validate CPF (Brazilian tax ID)
function isValidCPF(cpf) {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  // Reject all-same-digit CPFs (e.g. 111.111.111-11)
  if (/^(\d)\1{10}$/.test(digits)) return false;
  // Validate check digits
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (parseInt(digits[9]) !== check) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (parseInt(digits[10]) !== check) return false;
  return true;
}

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

// Track known counts to detect corruption (empty overwrite)
const _lastKnownCounts = {};

async function flushToRTDB() {
  saveTimer = null;
  const cols = [..._dirtyCollections];
  _dirtyCollections.clear();
  if (!cols.length) return;
  // Safety: don't flush if DB isn't loaded yet
  if (!dbLoaded) {
    console.warn('⚠️ flushToRTDB() called before dbLoaded — ABORTING');
    cols.forEach(c => _dirtyCollections.add(c));
    return;
  }
  try {
    const updates = {};
    const CRITICAL_COLLECTIONS = ['users', 'relations', 'encounters', 'messages'];
    cols.forEach(c => {
      const data = db[c] || {};
      const count = Object.keys(data).length;
      const lastCount = _lastKnownCounts[c] || 0;
      // PROTECTION 1: if server started with empty DB (no cloud data), NEVER overwrite critical collections
      if (CRITICAL_COLLECTIONS.includes(c) && !_dbLoadedFromCloud && count < 5) {
        console.error('PROTECTION: server started with empty DB — refusing to write "' + c + '" with only ' + count + ' entries to prevent data loss');
        return;
      }
      // PROTECTION 2: if a critical collection went from many entries to zero, SKIP it
      if (CRITICAL_COLLECTIONS.includes(c) && count === 0 && lastCount > 0) {
        console.error('CORRUPTION GUARD: collection "' + c + '" went from ' + lastCount + ' to 0 entries — SKIPPING write to protect data');
        return;
      }
      // PROTECTION 3: if critical collection lost >30% of entries in one flush, SKIP it
      if (CRITICAL_COLLECTIONS.includes(c) && lastCount > 5 && count < lastCount * 0.7) {
        console.error('CORRUPTION GUARD: collection "' + c + '" dropped from ' + lastCount + ' to ' + count + ' entries (>30% loss) — SKIPPING write');
        return;
      }
      updates[c] = data;
      _lastKnownCounts[c] = count;
    });
    if (Object.keys(updates).length > 0) {
      await withTimeout(rtdb.ref('/').update(updates), 15000, 'RTDB flush');
    }
  } catch (e) {
    console.error('❌ RTDB save error:', e.message);
    // Re-add failed collections for retry
    cols.forEach(c => _dirtyCollections.add(c));
    // Fallback: save locally
    fs.promises.writeFile(path.join(__dirname, 'db.json'), JSON.stringify(db), 'utf8').catch(e2 => console.error('File write error:', e2.message));
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
        if (!Array.isArray(ev.participants)) ev.participants = [];
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
  // CRITICAL: Never save before DB is loaded — would overwrite real data with empty objects
  if (!dbLoaded) {
    console.warn('⚠️ saveDB() called before dbLoaded — IGNORING to prevent data loss. Collections:', collections.join(','));
    return;
  }
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

app.post('/api/auth/send-verification', authLimiter, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório.' });
  try {
    // Get user email from UID
    const userRecord = await firebaseAuth.getUser(uid);
    const email = userRecord.email;
    if (!email) return res.status(400).json({ error: 'Usuário sem email.' });
    if (userRecord.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    // Generate verification link
    const appUrl = process.env.APP_URL || 'https://touch-irl.com';
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

app.post('/api/auth/send-magic-link', authLimiter, async (req, res) => {
  const { email, returnUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const appUrl = returnUrl || process.env.APP_URL || 'https://touch-irl.com';
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

app.post('/api/auth/send-password-reset', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const appUrl = process.env.APP_URL || 'https://touch-irl.com';
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
  const { firebaseUid, email, displayName, photoURL, phoneNumber, encUserId } = req.body;
  if (!firebaseUid) return res.status(400).json({ error: 'Firebase UID obrigatório.' });

  // ═══ ACCOUNT UNIFICATION: Try to find existing user by multiple identifiers ═══
  // Priority: firebaseUid > encUserId > email > phone
  let existingUser = null;
  let matchedBy = null;

  // 1. Check by Firebase UID (exact match — same provider login)
  const byFbUid = IDX.firebaseUid.get(firebaseUid);
  if (byFbUid && db.users[byFbUid]) {
    existingUser = db.users[byFbUid];
    matchedBy = 'firebaseUid';
  }

  // 2. Check by encUserId (if provided from client localStorage)
  if (!existingUser && encUserId && db.users[encUserId]) {
    existingUser = db.users[encUserId];
    matchedBy = 'encUserId';
  }

  // 3. Check by email (e.g. user logged in with Google, now trying Email/Password with same email)
  if (!existingUser && email) {
    const byEmail = IDX.email.get(email.toLowerCase());
    if (byEmail && db.users[byEmail]) {
      existingUser = db.users[byEmail];
      matchedBy = 'email';
    }
  }

  // 4. Check by phone number (e.g. user registered with email, now using SMS with same phone)
  if (!existingUser && phoneNumber) {
    const byPhone = IDX.phone.get(phoneNumber);
    if (byPhone && db.users[byPhone]) {
      existingUser = db.users[byPhone];
      matchedBy = 'phone';
    }
  }

  // ═══ EXISTING USER FOUND: update & link ═══
  if (existingUser) {
    let changed = false;
    // Link this firebaseUid to the existing account
    if (!existingUser.firebaseUid || existingUser.firebaseUid !== firebaseUid) {
      // Store all linked Firebase UIDs for multi-provider support
      if (!existingUser.linkedFirebaseUids) existingUser.linkedFirebaseUids = [];
      if (existingUser.firebaseUid && !existingUser.linkedFirebaseUids.includes(existingUser.firebaseUid)) {
        existingUser.linkedFirebaseUids.push(existingUser.firebaseUid);
      }
      if (!existingUser.linkedFirebaseUids.includes(firebaseUid)) {
        existingUser.linkedFirebaseUids.push(firebaseUid);
      }
      existingUser.firebaseUid = firebaseUid; // Set most recent as primary
      IDX.firebaseUid.set(firebaseUid, existingUser.id);
      changed = true;
    }
    // Update email if new
    if (email && !existingUser.email) {
      existingUser.email = email;
      IDX.email.set(email.toLowerCase(), existingUser.id);
      changed = true;
    }
    // Update phone if new
    if (phoneNumber && !existingUser.phone) {
      existingUser.phone = phoneNumber;
      IDX.phone.set(phoneNumber, existingUser.id);
      changed = true;
    }
    // Update photo if new
    if (photoURL && !existingUser.photoURL) {
      existingUser.photoURL = photoURL;
      changed = true;
    }
    // Update name if new
    if (displayName && !existingUser.name) {
      existingUser.name = displayName;
      changed = true;
    }
    if (changed) saveDB('users');
    console.log(`[auth/link] Unified account matched by ${matchedBy}: ${existingUser.id} (${existingUser.nickname || existingUser.email})`);
    return res.json({ userId: existingUser.id, user: existingUser, linked: true, matchedBy, onboardingDone: !!existingUser.onboardingDone });
  }

  // ═══ NO MATCH: Create new ENCOSTA user from Firebase auth ═══
  const id = uuidv4();
  const nick = (displayName || email?.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20) || 'user' + Math.floor(Math.random() * 9999);
  let finalNick = nick;
  let suffix = 1;
  while (isNickTaken(finalNick)) {
    finalNick = nick + suffix++;
  }
  const color = '#' + ((Math.abs([...finalNick].reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)) % 0xFFFFFF)).toString(16).padStart(6, '0');
  registrationCounter = Math.max(registrationCounter, Object.keys(db.users).length) + 1;
  db.users[id] = {
    id, nickname: finalNick, name: displayName || finalNick, email: email || null,
    phone: phoneNumber || null, firebaseUid, photoURL: photoURL || null,
    linkedFirebaseUids: [firebaseUid],
    birthdate: null, avatar: null, color, createdAt: Date.now(),
    points: 0, pointLog: [], stars: [],
    registrationOrder: registrationCounter, topTag: null,
    likedBy: [], likesCount: 0, touchers: 0, canSee: {}, revealedTo: []
  };
  recalcAllTopTags();
  idxAddUser(db.users[id]);
  // Add to new indexes
  if (email) IDX.email.set(email.toLowerCase(), id);
  if (phoneNumber) IDX.phone.set(phoneNumber, id);
  saveDB('users');
  console.log(`[auth/link] New account created: ${id} (${finalNick})`);
  res.json({ userId: id, user: db.users[id], linked: false, onboardingDone: false });
});

// ── MercadoPago Config ──
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const MP_APP_ID = process.env.MP_APP_ID || '';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || '';
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://touch-irl.com/mp/callback';
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
const _cleanupInterval = setInterval(() => {
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
  if (db.encounters[userAId].length > 1000) db.encounters[userAId] = db.encounters[userAId].slice(-1000);
  db.encounters[userBId].push(traceB);
  if (db.encounters[userBId].length > 1000) db.encounters[userBId] = db.encounters[userBId].slice(-1000);
  // Award score points (uses classification)
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  if (classA.points > 0) {
    db.users[userAId].pointLog.push({ value: classA.points, type: classA.type, with: userBId, timestamp: now });
    if (db.users[userAId].pointLog.length > 500) db.users[userAId].pointLog = db.users[userAId].pointLog.slice(-500);
  }
  if (classB.points > 0) {
    db.users[userBId].pointLog.push({ value: classB.points, type: classB.type, with: userAId, timestamp: now });
    if (db.users[userBId].pointLog.length > 500) db.users[userBId].pointLog = db.users[userBId].pointLog.slice(-500);
  }
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
    if (db.users[userAId].pointLog.length > 500) db.users[userAId].pointLog = db.users[userAId].pointLog.slice(-500);
    return;
  }
  if (!db.users[userBId]) return;

  // Classify and award
  const classA = classifyEncounter(userAId, userBId);
  const classB = classifyEncounter(userBId, userAId);
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  db.users[userAId].pointLog.push({ value: classA.points, type: classA.type, with: userBId, timestamp: now });
  if (db.users[userAId].pointLog.length > 500) db.users[userAId].pointLog = db.users[userAId].pointLog.slice(-500);
  db.users[userBId].pointLog.push({ value: classB.points, type: classB.type, with: userAId, timestamp: now });
  if (db.users[userBId].pointLog.length > 500) db.users[userBId].pointLog = db.users[userBId].pointLog.slice(-500);
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
  const pairEncAll = (db.encounters[owner.id] || []).filter(e => e.with === visitor.id);
  const pairEncounters = pairEncAll.length;
  const now24h = Date.now() - 86400000;
  const pairEncounters24h = pairEncAll.filter(e => e.timestamp > now24h).length;
  const responseData = {
    relationId: existing ? existing.id : relationId, phrase, expiresAt, renewed: !!existing,
    encounterCount: pairEncounters, encounterCount24h: pairEncounters24h,
    userA: { id: owner.id, name: owner.nickname, realName: owner.realName || null, color: owner.color, profilePhoto: owner.profilePhoto || null, photoURL: owner.photoURL || null, score: calcScore(owner.id), stars: (owner.stars || []).length, sign: signOwner, signInfo: signOwner ? ZODIAC_INFO[signOwner] : null, isPrestador: !!owner.isPrestador, serviceLabel: owner.serviceLabel || '', verified: !!owner.verified, accessory: owner.avatarAccessory || null },
    userB: { id: visitor.id, name: visitor.nickname, realName: visitor.realName || null, color: visitor.color, profilePhoto: visitor.profilePhoto || null, photoURL: visitor.photoURL || null, score: calcScore(visitor.id), stars: (visitor.stars || []).length, sign: signVisitor, signInfo: signVisitor ? ZODIAC_INFO[signVisitor] : null, isPrestador: !!visitor.isPrestador, serviceLabel: visitor.serviceLabel || '', verified: !!visitor.verified, accessory: visitor.avatarAccessory || null },
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
    registrationOrder: registrationCounter, topTag: null,
    likedBy: [], likesCount: 0, touchers: 0, canSee: {}, revealedTo: []
  };
  recalcAllTopTags();
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

// ── Save user timezone ──
app.post('/api/user/timezone', (req, res) => {
  const { userId, timezone } = req.body;
  if (!userId || !timezone) return res.status(400).json({ error: 'userId e timezone obrigatorios' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  // Validate timezone string
  try {
    new Date().toLocaleString('en-US', { timeZone: timezone });
  } catch (e) {
    return res.status(400).json({ error: 'Timezone invalido: ' + timezone });
  }
  user.timezone = timezone;
  saveDB('users');
  res.json({ ok: true, timezone });
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

  // Block duplicate check-in via HTTP session/join too
  if (isSessionCheckin && sessionEventId && codeVisitorId) {
    const ev = db.operatorEvents[sessionEventId];
    if (ev && Array.isArray(ev.participants) && ev.participants.includes(codeVisitorId)) {
      return res.status(409).json({ error: 'Você já fez check-in neste evento!', duplicate: true, eventId: sessionEventId });
    }
  }

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
    if (db.encounters[codeVisitorId].length > 1000) db.encounters[codeVisitorId] = db.encounters[codeVisitorId].slice(-1000);
    awardPoints(codeVisitorId, null, 'checkin');
    // Add to event participants
    if (evObj) {
      if (!Array.isArray(evObj.participants)) evObj.participants = [];
      if (!evObj.participants.includes(codeVisitorId)) {
        evObj.participants.push(codeVisitorId);
        evObj.checkinCount = evObj.participants.length;
      }
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
      operatorId: sessionOperatorId || null,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (sessionEventObj && sessionEventObj.entryPrice > 0) ? sessionEventObj.entryPrice : 0,
      userA: { id: userB.id, name: userB.nickname || userB.name, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: zodiacInfoB, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', verified: !!userB.verified },
      userB: { id: 'evt:' + sessionEventId, name: sessionEventObj ? sessionEventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true, verified: !!(sessionEventObj && sessionEventObj.verified) },
      zodiacPhrase: null
    };
  } else {
    const sessPairAll = (db.encounters[session.userA] || []).filter(e => e.with === userId);
    const sessPairEnc = sessPairAll.length;
    const sessNow24h = Date.now() - 86400000;
    const sessPairEnc24h = sessPairAll.filter(e => e.timestamp > sessNow24h).length;
    responseData = {
      relationId, phrase, expiresAt, renewed: !!existing,
      isServiceTouch: !!session.isServiceTouch, isCheckin: false,
      encounterCount: sessPairEnc, encounterCount24h: sessPairEnc24h,
      requireReveal: !!opRequireRevealJoin,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      userA: { id: userA.id, name: userA.nickname || userA.name, realName: userA.realName || null, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: zodiacInfoA, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '', verified: !!userA.verified, accessory: userA.avatarAccessory || null },
      userB: { id: userB.id, name: userB.nickname || userB.name, realName: userB.realName || null, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: zodiacInfoB, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', verified: !!userB.verified, accessory: userB.avatarAccessory || null },
      zodiacPhrase
    };
  }

  io.to(`session:${session.id}`).emit('relation-created', responseData);
  // Emit to operator if this is a checkin (operator only gets dashboard notification)
  if (isSessionCheckin && sessionOperatorId) {
    const opUser = db.users[sessionOperatorId];
    const revealEntry = isRevealedTo(userId, opUser, sessionEventId);
    const visRevealed = !!revealEntry;
    io.to(`user:${sessionOperatorId}`).emit('checkin-created', {
      userId, nickname: userB.nickname || userB.name, color: userB.color,
      profilePhoto: userB.profilePhoto || userB.photoURL || null,
      timestamp: now, relationId,
      revealed: visRevealed, revealData: visRevealed ? revealEntry : null,
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
      lastMessagePreview: lastMsg ? (lastMsg.type === 'ephemeral' ? '✨ ' + (lastMsg.text || '').slice(0, 40) : (lastMsg.text || '').startsWith('[game-invite:') ? 'Convite para jogar' : (lastMsg.text || '').slice(0, 40)) : null,
      lastMessageUserId: lastMsg ? lastMsg.userId : null,
      partnerVerified: isEvent ? !!(evObj && evObj.verified) : !!(p && p.verified),
      partnerAccessory: isEvent ? null : (p?.avatarAccessory || null)
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
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const enriched = list.slice().reverse().map(e => {
    const other = db.users[e.with];
    const isRevealed = other?.revealedTo?.includes(req.params.userId);
    return { ...e, realName: isRevealed ? (other?.realName || null) : null, profilePhoto: isRevealed ? (other?.profilePhoto || other?.photoURL || null) : null, verified: !!(other && other.verified) };
  });
  const total = enriched.length;
  const paginated = enriched.slice((page - 1) * limit, page * limit);
  res.json({ data: paginated, page, limit, total, encounters: paginated }); // newest first, backward compatible
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
    if (!byPerson[e.with]) byPerson[e.with] = { id: e.with, nickname: e.withName || '?', color: e.withColor || null, encounters: 0, firstDate: e.timestamp, lastDate: e.timestamp, tipsGiven: 0, tipsTotal: 0, lastSelfie: null, serviceEncounters: 0, personalEncounters: 0 };
    byPerson[e.with].encounters++;
    // Track encounter type: service vs personal
    if (e.type === 'service') byPerson[e.with].serviceEncounters++;
    else byPerson[e.with].personalEncounters++;
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
  // All people appear in constellation (isPrestador flag sent for frontend filtering)
  const nodes = Object.values(byPerson).map(p => {
    const other = db.users[p.id];
    const me = db.users[req.params.userId];
    // UNILATERAL: canSee means I can see their real data (only permanent reveals, not event-scoped)
    const iCanSeeEntry = isRevealedTo(p.id, me, null);
    const iCanSeeThem = !!iCanSeeEntry;
    const theyCanSeeEntry = isRevealedTo(req.params.userId, other, null);
    const theyCanSeeMe = !!theyCanSeeEntry;
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
      profilePhoto: iCanSeeThem ? (other.profilePhoto || other.photoURL || (iCanSeeEntry && iCanSeeEntry.profilePhoto) || p.lastSelfie || null) : null,
      instagram: iCanSeeThem ? (other.instagram || null) : null,
      tipsGiven: p.tipsGiven,
      tipsTotal: p.tipsTotal,
      iRevealedToPartner: !!theyCanSeeMe, // they can see me = I revealed to them
      partnerRevealedToMe: !!iCanSeeThem, // I can see them = they revealed to me
      revealedAt: iCanSeeThem ? ((iCanSeeEntry && iCanSeeEntry.revealedAt) || 0) : 0,
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
      giftsReceived: (db.gifts[p.id] || []).length,
      avatarAccessory: (other && other.avatarAccessory) || null,
      // About me — public profile tags
      profession: (other && other.profession) || null,
      sports: (other && other.sports) || [],
      hobbies: (other && other.hobbies) || [],
      bio: iCanSeeThem ? ((other && other.bio) || null) : null,
      // Connection type flags based on actual encounter types (not user profile)
      isServiceConnection: p.serviceEncounters > 0 && p.personalEncounters === 0, // ONLY service encounters
      hasServiceEncounters: p.serviceEncounters > 0,
      hasPersonalEncounters: p.personalEncounters > 0,
      serviceEncounters: p.serviceEncounters,
      personalEncounters: p.personalEncounters
    };
  });
  // Add event nodes — from both participants array AND encounter history
  const eventIdsSeen = new Set();
  // 1) Events where user is in participants array
  Object.values(db.operatorEvents).forEach(ev => {
    if (ev.participants && ev.participants.includes(req.params.userId)) {
      eventIdsSeen.add(ev.id);
    }
  });
  // 2) Events from encounter history (isEvent encounters)
  list.forEach(e => {
    if (e.isEvent || (typeof e.with === 'string' && e.with.startsWith('evt:'))) {
      const eid = typeof e.with === 'string' && e.with.startsWith('evt:') ? e.with.replace('evt:', '') : null;
      if (eid) eventIdsSeen.add(eid);
    }
  });
  const eventNodes = [];
  eventIdsSeen.forEach(evId => {
    const ev = db.operatorEvents[evId];
    if (!ev) return;
    const userRids = IDX.relationsByUser.get(req.params.userId);
    const eventRels = userRids ? [...userRids].map(rid => db.relations[rid]).filter(r => r && r.eventId === evId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : [];
    const lastRel = eventRels[0] || null;
    // Count how many people user met at this event
    const peopleMet = eventRels.length;
    eventNodes.push({
      id: 'evt:' + ev.id, isEvent: true, eventId: ev.id,
      nickname: ev.name, color: '#60a5fa',
      encounters: Math.max(1, peopleMet), intensity: Math.min(1, 0.4 + peopleMet * 0.1),
      lastDate: lastRel ? lastRel.createdAt : ev.createdAt,
      firstDate: ev.createdAt,
      realName: null, profilePhoto: null, instagram: null,
      tipsGiven: 0, tipsTotal: 0, lastSelfie: null,
      iRevealedToPartner: false, partnerRevealedToMe: false,
      hasActiveRelation: ev.active, topTag: null, touchers: (ev.participants || []).length,
      likesCount: 0, starsCount: 0, likedByMe: false,
      isPrestador: false, serviceLabel: null, pendingReveal: null, verified: !!ev.verified,
      eventActive: ev.active, eventParticipants: (ev.participants || []).length,
      peopleMet: peopleMet
    });
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
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const allStars = user.stars || [];
  const total = allStars.length;
  const paginated = allStars.slice((page - 1) * limit, page * limit);
  res.json({ data: paginated, page, limit, total, stars: paginated }); // backward compatible
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

app.get('/api/notifications/:userId', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const seenAt = user.notifSeenAt || 0;
  const notifs = [];
  // 1. Who liked me (from likedBy array)
  (user.likedBy || []).forEach(likerId => {
    const liker = db.users[likerId];
    if (!liker) return;
    const iCanSee = isRevealedTo(likerId, user, null);
    const ts = liker._likedAt?.[userId] || 0;
    if (!ts) return; // skip if no timestamp
    notifs.push({
      type: 'like',
      fromId: likerId,
      nickname: liker.nickname || liker.name,
      realName: iCanSee ? (liker.realName || null) : null,
      profilePhoto: iCanSee ? (liker.profilePhoto || liker.photoURL || null) : null,
      color: liker.color,
      avatarAccessory: liker.avatarAccessory || null,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 2. Stars received
  (user.stars || []).forEach(star => {
    const giver = db.users[star.from];
    const ts = star.donatedAt || star.at || 0;
    if (!ts) return; // skip if no timestamp
    notifs.push({
      type: 'star',
      fromId: star.from,
      nickname: giver ? (giver.nickname || giver.name) : 'Alguem',
      realName: null,
      profilePhoto: null,
      color: giver ? giver.color : '#fbbf24',
      avatarAccessory: giver ? (giver.avatarAccessory || null) : null,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 3. Reveal requests received (pending)
  Object.values(db.revealRequests || {}).forEach(rr => {
    if (rr.toUserId === userId && rr.status === 'pending') {
      const from = db.users[rr.fromUserId];
      if (!from) return;
      const ts = rr.createdAt || 0;
      if (!ts) return;
      notifs.push({
        type: 'reveal-request',
        fromId: rr.fromUserId,
        nickname: from.nickname || from.name,
        color: from.color,
        avatarAccessory: from.avatarAccessory || null,
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
      const ts = star.donatedAt || star.at || 0;
      if (!ts) return; // skip if no timestamp
      notifs.push({
        type: 'friend-star',
        fromId: fid,
        nickname: friend.nickname || friend.name,
        color: friend.color,
        avatarAccessory: friend.avatarAccessory || null,
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
    const ts = data.revealedAt || 0;
    if (!ts) return;
    notifs.push({
      type: 'identity-revealed',
      fromId: pid,
      nickname: p.nickname || p.name,
      realName: data.realName || null,
      profilePhoto: data.profilePhoto || null,
      color: p.color,
      avatarAccessory: p.avatarAccessory || null,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 6. Game invites received (from chat messages)
  const myRelIds = Object.keys(db.relations).filter(rid => {
    const r = db.relations[rid];
    return r && (r.userA === userId || r.userB === userId);
  });
  myRelIds.forEach(rid => {
    const msgs = db.messages[rid] || [];
    msgs.forEach(m => {
      if (!m.text || !m.text.startsWith('[game-invite:')) return;
      if (m.userId === userId) return; // skip my own invites
      const parts = m.text.replace('[game-invite:', '').replace(']', '').split(':');
      const gameName = parts[2] || 'Jogo';
      const sender = db.users[m.userId];
      if (!sender) return;
      const ts = m.timestamp || 0;
      if (!ts) return;
      notifs.push({
        type: 'game-invite',
        fromId: m.userId,
        nickname: sender.nickname || sender.name,
        color: sender.color,
        avatarAccessory: sender.avatarAccessory || null,
        gameName: gameName,
        timestamp: ts,
        seen: ts <= seenAt
      });
    });
  });
  // 7. Recent connections (encounters in last 7 days)
  const now7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  myEncounters.filter(e => !e.isEvent && e.timestamp > now7d && !(e.with || '').startsWith('evt:')).forEach(e => {
    const partner = db.users[e.with];
    if (!partner) return;
    const ts = e.timestamp || 0;
    notifs.push({
      type: 'new-connection',
      fromId: e.with,
      nickname: partner.nickname || partner.name,
      color: partner.color,
      avatarAccessory: partner.avatarAccessory || null,
      encounterCount: e.encounterCount || 1,
      isRenewal: (e.encounterCount || 1) > 1,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // 8. Unread chat messages (from active relations)
  const nowTs = Date.now();
  myRelIds.forEach(rid => {
    const r = db.relations[rid];
    if (!r || r.expiresAt < nowTs) return;
    const msgs = db.messages[rid] || [];
    const partnerId = r.userA === userId ? r.userB : r.userA;
    const partner = db.users[partnerId];
    if (!partner) return;
    // Find user's last message
    const myLastMsg = [...msgs].reverse().find(m => m.userId === userId);
    const myLastTs = myLastMsg ? (myLastMsg.timestamp || 0) : 0;
    // Count unread from partner
    const unreadMsgs = msgs.filter(m => m.userId !== userId && (m.timestamp || 0) > myLastTs && !m.text?.startsWith('[game-invite:'));
    if (unreadMsgs.length > 0) {
      const lastUnread = unreadMsgs[unreadMsgs.length - 1];
      const ts = lastUnread.timestamp || 0;
      notifs.push({
        type: 'unread-message',
        fromId: partnerId,
        nickname: partner.nickname || partner.name,
        color: partner.color,
        avatarAccessory: partner.avatarAccessory || null,
        unreadCount: unreadMsgs.length,
        lastText: (lastUnread.text || '').slice(0, 60),
        relationId: rid,
        timestamp: ts,
        seen: ts <= seenAt
      });
    }
  });
  // 9. Event checkins (last 7 days)
  myEncounters.filter(e => e.isEvent && e.timestamp > now7d).forEach(e => {
    const ts = e.timestamp || 0;
    notifs.push({
      type: 'event-checkin',
      fromId: null,
      nickname: e.withName || 'Evento',
      color: '#f59e0b',
      eventId: e.with,
      timestamp: ts,
      seen: ts <= seenAt
    });
  });
  // Filter out dismissed notifications
  const dismissed = user.dismissedNotifs || [];
  const filtered = notifs.filter(n => {
    const nKey = n.type + ':' + (n.fromId || '') + ':' + n.timestamp;
    return !dismissed.includes(nKey);
  });
  // Sort by timestamp desc
  filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const total = filtered.length;
  const paginated = filtered.slice((page - 1) * limit, page * limit);
  const unseenCount = paginated.filter(n => !n.seen).length;
  res.json({ data: paginated, page, limit, total, notifications: paginated, unseenCount }); // backward compatible
});

// Mark network as seen (for badge on rede icon)
app.post('/api/network/seen', (req, res) => {
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  user.networkSeenAt = Date.now();
  saveDB('users');
  res.json({ ok: true });
});

// Dismiss (apagar) uma notificacao individual
app.post('/api/notifications/dismiss', (req, res) => {
  const { userId, notifKey } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Nao encontrado.' });
  if (!user.dismissedNotifs) user.dismissedNotifs = [];
  if (!user.dismissedNotifs.includes(notifKey)) {
    user.dismissedNotifs.push(notifKey);
    // Limita a 200 para nao crescer infinitamente
    if (user.dismissedNotifs.length > 200) user.dismissedNotifs = user.dismissedNotifs.slice(-200);
    saveDB('users');
  }
  res.json({ ok: true });
});

// Limpar todas as notificacoes
app.post('/api/notifications/dismiss-all', (req, res) => {
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Nao encontrado.' });
  user.notifSeenAt = Date.now();
  // Marca todas como vistas
  saveDB('users');
  res.json({ ok: true });
});

// Get new connections count since last network view
app.get('/api/network/new-count/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const seenAt = user.networkSeenAt || 0;
  const encounters = db.encounters[userId] || [];
  const newCount = encounters.filter(e => (e.at || 0) > seenAt).length;
  res.json({ newCount });
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
    // Unreveal: remove myself from partner's canSee (permanent + all event-scoped)
    if (partner.canSee) {
      delete partner.canSee[userId];
      // Also remove event-scoped reveals
      Object.keys(partner.canSee).forEach(k => {
        if (k.startsWith(userId + ':evt:')) delete partner.canSee[k];
      });
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
  { id: 'flowers', name: 'Bouquet de Flores', icon: 'flowers', needsAddress: false, scoreCost: 15, description: 'Um bouquet digital com carinho' },
  { id: 'coffee', name: 'Café Especial', icon: 'coffee', needsAddress: false, scoreCost: 10, description: 'Um café digital especial' },
  { id: 'letter', name: 'Carta Selada', icon: 'letter', needsAddress: false, scoreCost: 5, description: 'Uma carta digital com selo Touch?' },
  { id: 'playlist', name: 'Playlist', icon: 'playlist', needsAddress: false, scoreCost: 8, description: 'Uma playlist dedicada' },
  { id: 'star', name: 'Estrela', icon: 'star', needsAddress: false, scoreCost: 0, description: 'Uma estrela da sua constelação' },
  { id: 'book', name: 'Livro', icon: 'book', needsAddress: false, scoreCost: 12, description: 'Um livro digital surpresa' },
  { id: 'dessert', name: 'Sobremesa', icon: 'dessert', needsAddress: false, scoreCost: 10, description: 'Uma sobremesa digital' }
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
    id, giftId, giftName: gift.name, icon: gift.icon, scoreCost: gift.scoreCost || 0, message: message || '',
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
    if (db.users[fromUserId].pointLog.length > 500) db.users[fromUserId].pointLog = db.users[fromUserId].pointLog.slice(-500);
    saveDB('users');
  }
  // Notify recipient via socket
  io.to(`user:${toUserId}`).emit('gift-received', { relationId, gift: giftRecord });
  res.json({ ok: true, gift: giftRecord });
});

// Send star from personal balance (chat gift modal)
app.post('/api/gift/send-star', (req, res) => {
  const { fromUserId, toUserId, relationId, message } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ error: 'Dados incompletos.' });
  const fromUser = db.users[fromUserId];
  const toUser = db.users[toUserId];
  if (!fromUser || !toUser) return res.status(404).json({ error: 'Usuário não encontrado.' });
  // Check star balance
  const starCount = (db.stars[fromUserId] || []).filter(s => !s.donated && !s.pending).length;
  if (starCount < 1) return res.status(400).json({ error: 'Sem estrelas para doar.' });
  // Find the first available star to transfer
  const userStars = db.stars[fromUserId] || [];
  const starToTransfer = userStars.find(s => !s.donated && !s.pending);
  if (!starToTransfer) return res.status(400).json({ error: 'Nenhuma estrela disponível.' });
  // Mark as donated
  starToTransfer.donated = true;
  starToTransfer.donatedTo = toUserId;
  starToTransfer.donatedAt = Date.now();
  // Award star to recipient
  awardStar(toUserId, 'gift', fromUserId);
  // Create gift record
  const id = uuidv4();
  const giftRecord = {
    id, giftId: 'star', giftName: 'Estrela', icon: 'star', message: message || '',
    from: fromUserId, fromName: fromUser.nickname || fromUser.name || '?', fromColor: fromUser.color,
    to: toUserId, relationId: relationId || null,
    needsAddress: false, addressStatus: 'none', address: null,
    status: 'delivered', createdAt: Date.now()
  };
  if (!db.gifts[toUserId]) db.gifts[toUserId] = [];
  if (!db.gifts[fromUserId]) db.gifts[fromUserId] = [];
  db.gifts[toUserId].push(giftRecord);
  db.gifts[fromUserId].push({ ...giftRecord, _role: 'sender' });
  saveDB('gifts', 'stars', 'users');
  // Notify recipient
  io.to(`user:${toUserId}`).emit('star-received', {
    fromUserId, fromName: fromUser.nickname || fromUser.name || '?',
    total: (db.stars[toUserId] || []).length
  });
  const remaining = (db.stars[fromUserId] || []).filter(s => !s.donated && !s.pending).length;
  res.json({ ok: true, remainingStars: remaining });
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
  if (db.users[fromUserId].pointLog.length > 500) db.users[fromUserId].pointLog = db.users[fromUserId].pointLog.slice(-500);
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
    phone: isRevealed && (user.privacy?.phone === true) ? (user.phone || null) : null,
    avatarAccessory: user.avatarAccessory || null,
    likesCount: user.likesCount || 0,
    vaAccessGrantedBy: user.vaAccessGrantedBy || null
  });
});

// ── Update full profile ──
app.post('/api/profile/update', requireAuth, async (req, res) => {
  const { userId, nickname, realName, phone, instagram, tiktok, twitter, bio, profilePhoto, email, cpf, privacy, avatarAccessory, profession, sports, hobbies } = req.body;
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
  if (phone !== undefined) {
    if (phone && phone.trim()) {
      const cleanPhone = phone.trim();
      // Check if phone already used by another user
      const phoneOwnerId = IDX.phone.get(cleanPhone);
      if (phoneOwnerId && phoneOwnerId !== userId) {
        return res.status(400).json({ error: 'Este telefone já está vinculado a outra conta.' });
      }
      if (user.phone) IDX.phone.delete(user.phone);
      IDX.phone.set(cleanPhone, userId);
      user.phone = cleanPhone;
    } else {
      if (user.phone) IDX.phone.delete(user.phone);
      user.phone = null;
    }
  }
  if (instagram !== undefined) user.instagram = instagram;
  if (tiktok !== undefined) user.tiktok = tiktok;
  if (twitter !== undefined) user.twitter = twitter;
  if (privacy !== undefined) user.privacy = privacy;
  if (bio !== undefined) user.bio = bio;
  if (profession !== undefined) user.profession = profession;
  if (sports !== undefined) user.sports = Array.isArray(sports) ? sports.slice(0, 2) : [];
  if (hobbies !== undefined) user.hobbies = Array.isArray(hobbies) ? hobbies.slice(0, 2) : [];
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
  if (email !== undefined && email.trim()) {
    const cleanEmail = email.trim().toLowerCase();
    const emailOwnerId = IDX.email.get(cleanEmail);
    if (emailOwnerId && emailOwnerId !== userId) {
      return res.status(400).json({ error: 'Este e-mail já está vinculado a outra conta.' });
    }
    if (user.email) IDX.email.delete(user.email.toLowerCase());
    IDX.email.set(cleanEmail, userId);
    user.email = email.trim();
  }
  if (cpf !== undefined && cpf.trim()) {
    const cleanCpf = cpf.trim().replace(/\D/g, '');
    if (cleanCpf.length !== 11) {
      return res.status(400).json({ error: 'CPF inválido. Deve ter 11 dígitos.' });
    }
    // Validate CPF algorithm
    if (!isValidCPF(cleanCpf)) {
      return res.status(400).json({ error: 'CPF inválido.' });
    }
    const cpfOwnerId = IDX.cpf.get(cleanCpf);
    if (cpfOwnerId && cpfOwnerId !== userId) {
      return res.status(400).json({ error: 'Este CPF já está vinculado a outra conta. Se é você, faça login com o método original.' });
    }
    if (user.cpf) IDX.cpf.delete(user.cpf.replace(/\D/g, ''));
    IDX.cpf.set(cleanCpf, userId);
    user.cpf = cleanCpf;
  }
  if (avatarAccessory !== undefined) {
    // Validate: must be null/empty (remove) or a valid accessory key
    if (avatarAccessory && !['halo','cat_ears','glasses','paper_crown','headphones','crown','diamond_crown','flame_aura','lightning','mask','galaxy_ring','wings'].includes(avatarAccessory)) {
      return res.status(400).json({ error: 'Acessório inválido.' });
    }
    user.avatarAccessory = avatarAccessory || null;
  }
  user.profileComplete = !!(user.realName && (user.profilePhoto || user.photoURL));

  // Propagate photo update to all canSee entries (permanent + event-scoped)
  if (profilePhoto !== undefined && user.revealedTo && user.revealedTo.length > 0) {
    const freshPhoto = user.profilePhoto || user.photoURL || null;
    user.revealedTo.forEach(targetId => {
      const target = db.users[targetId];
      if (target && target.canSee) {
        // Update permanent reveal
        if (target.canSee[userId]) target.canSee[userId].profilePhoto = freshPhoto;
        // Update event-scoped reveals
        Object.keys(target.canSee).forEach(k => {
          if (k.startsWith(userId + ':evt:')) target.canSee[k].profilePhoto = freshPhoto;
        });
      }
    });
  }

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
  const { userId, targetUserId, eventId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  const user = db.users[userId];
  // Require at least realName to reveal identity
  if (!user.realName || !user.realName.trim()) {
    return res.status(400).json({ error: 'Preencha seu nome real no perfil antes de se revelar. Vá em Perfil e adicione seu nome.' });
  }
  let rel = findActiveRelation(userId, targetUserId);
  if (!rel) {
    const enc = (db.encounters[userId] || []).find(e => e.with === targetUserId);
    if (!enc) return res.status(400).json({ error: 'Sem conexão com essa pessoa.' });
  }
  const relId = rel ? getRelId(rel) : [userId, targetUserId].sort().join('_');
  const target = db.users[targetUserId];
  // For event-scoped reveals, use composite key: userId:eventId
  // For normal reveals (no eventId), use just userId
  const canSeeKey = eventId ? userId + ':evt:' + eventId : userId;
  if (target.canSee && target.canSee[canSeeKey]) return res.status(400).json({ error: 'Você já se revelou para essa pessoa.' });
  // Also check if already revealed without event scope (permanent reveal)
  if (!eventId && target.canSee && target.canSee[userId]) return res.status(400).json({ error: 'Você já se revelou para essa pessoa.' });
  // DIRETO: target agora pode ver minha identidade (sem precisar aceite)
  if (!target.canSee) target.canSee = {};
  const userPhoto = user.profilePhoto || user.photoURL || null;
  target.canSee[canSeeKey] = {
    nickname: user.nickname || '', realName: user.realName || '', profilePhoto: userPhoto,
    instagram: user.instagram || '', bio: user.bio || '',
    phone: (user.privacy && user.privacy.phone) ? (user.phone || '') : '',
    revealedAt: Date.now(),
    eventId: eventId || null // null = permanent, string = scoped to that event only
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
  if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
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
  // Check if they already revealed (permanent only for request-reveal)
  if (isRevealedTo(targetUserId, user, null)) return res.status(400).json({ error: 'Essa pessoa já se revelou para você.' });
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
  if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
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
  if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
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
  if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
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
      results.push({ id: uid, nickname: u.nickname || u.name, color: u.color, profilePhoto: u.profilePhoto || null, stars: (u.stars || []).length, verified: !!u.verified, avatarAccessory: u.avatarAccessory || null });
    }
    if (results.length >= 20) break;
  }
  res.json({ results });
});

// Star balance — unified: pending + earned - donated
app.get('/api/star/balance/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const pending = (user.pendingStars || []).length;
  const received = (user.stars || []).length;
  // Available = stars the user physically has (received) + pending to donate
  const available = received + pending;
  res.json({ available, pending, received, total: received });
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

  try {
    let savedPendingStar = null;
    let savedDonorStar = null;

    // If pendingStarId provided, remove it from pending (earned via streak)
    if (pendingStarId) {
      if (!fromUser.pendingStars) fromUser.pendingStars = [];
      const idx = fromUser.pendingStars.findIndex(p => p.id === pendingStarId);
      if (idx === -1) return res.status(400).json({ error: 'Estrela pendente não encontrada.' });
      savedPendingStar = fromUser.pendingStars[idx];
      fromUser.pendingStars.splice(idx, 1);
    } else {
      // Transfer: remove one star from the donor's stars[] array
      if (!fromUser.stars || fromUser.stars.length === 0) {
        return res.status(400).json({ error: 'Sem estrelas disponíveis para doar.' });
      }
      // Save the star for rollback
      savedDonorStar = fromUser.stars[0];
      fromUser.stars.shift();
    }

    const donationId = uuidv4();
    db.starDonations[donationId] = { id: donationId, fromUserId, toUserId, timestamp: Date.now(), type: pendingStarId ? 'earned' : 'transfer' };
    // Update indexes
    if (!IDX.donationsByFrom.has(fromUserId)) IDX.donationsByFrom.set(fromUserId, []);
    IDX.donationsByFrom.get(fromUserId).push(donationId);
    IDX.donationsByPair.set(fromUserId + '_' + toUserId, (IDX.donationsByPair.get(fromUserId + '_' + toUserId) || 0) + 1);
    if (!toUser.stars) toUser.stars = [];
    toUser.stars.push({ id: donationId, from: fromUserId, fromName: fromUser.nickname, donatedAt: Date.now(), type: pendingStarId ? 'earned' : 'transfer' });
    recalcAllTopTags(); // re-rank after star change
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
    io.to(`user:${fromUserId}`).emit('star-donation-confirmed', { toUserId, toName: toUser.nickname, recipientStars: toUser.stars.length, donorStars: fromUser.stars.length, pendingRemaining: (fromUser.pendingStars || []).length });

    res.json({ ok: true, donationId, recipientStars: toUser.stars.length, donorStarsRemaining: fromUser.stars.length, pendingRemaining: (fromUser.pendingStars || []).length });
  } catch (err) {
    console.error('Star donation error:', err.message);
    // Rollback: restore the star if it was removed
    if (pendingStarId && savedPendingStar) {
      if (!fromUser.pendingStars) fromUser.pendingStars = [];
      fromUser.pendingStars.push(savedPendingStar);
    } else if (savedDonorStar) {
      if (!fromUser.stars) fromUser.stars = [];
      fromUser.stars.unshift(savedDonorStar);
    }
    saveDB('users');
    res.status(500).json({ error: 'Erro ao processar doação. Estrela restaurada.' });
  }
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
  recalcAllTopTags(); // re-rank after star purchase

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
  const stars = (user.stars || []).length;
  const pending = (user.pendingStars || []).length;
  res.json({ total: stars, pending, available: stars + pending });
});

// ══ GAME CONFIG — Admin endpoints ══
// Get current config
app.get('/api/admin/game-config', (req, res) => {
  res.json(getGameConfig());
});

// Update config (Top 1 or admin)
app.post('/api/admin/game-config', adminLimiter, (req, res) => {
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
app.get('/api/declarations/:userId', requireAuth, (req, res) => {
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
  const { adminId, targetId, userId, type, note } = req.body;
  const tid = targetId || userId;
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  if (!tid) return res.status(400).json({ error: 'targetId obrigatorio.' });
  if (!isAdminAuth) { const admin = db.users[adminId]; if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin pode verificar.' }); }
  const target = db.users[tid];
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  target.verified = true;
  target.verifiedAt = Date.now();
  target.verifiedBy = adminId || 'admin-panel';
  target.verificationType = type || 'standard';
  db.verifications[tid] = { userId: tid, verifiedAt: Date.now(), by: adminId || 'admin-panel', type: type || 'standard', note: note || '' };
  saveDB('users');
  res.json({ ok: true, user: { id: tid, nickname: target.nickname, verified: true, verificationType: target.verificationType } });
});

// Admin: revoke verification
app.post('/api/admin/unverify', (req, res) => {
  const { adminId, targetId, userId } = req.body;
  const tid = targetId || userId;
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  if (!tid) return res.status(400).json({ error: 'targetId obrigatorio.' });
  if (!isAdminAuth) { const admin = db.users[adminId]; if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' }); }
  const target = db.users[tid];
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  target.verified = false;
  delete target.verifiedAt;
  delete target.verifiedBy;
  delete target.verificationType;
  delete db.verifications[tid];
  saveDB('users');
  res.json({ ok: true });
});

// Admin: grant/revoke Touch? Plus (subscriber status)
app.post('/api/admin/grant-plus', (req, res) => {
  const { adminId, targetId, userId, months, grant } = req.body;
  const tid = targetId || userId;
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  if (!tid) return res.status(400).json({ error: 'targetId obrigatorio.' });
  if (!isAdminAuth) { const admin = db.users[adminId]; if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Apenas admin.' }); }
  const target = db.users[tid];
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const shouldGrant = months !== undefined ? months > 0 : grant !== false;
  target.isSubscriber = shouldGrant;
  if (shouldGrant) {
    if (!db.subscriptions[tid]) db.subscriptions[tid] = {};
    db.subscriptions[tid].status = 'active';
    db.subscriptions[tid].planId = 'touch_plus';
    db.subscriptions[tid].startedAt = db.subscriptions[tid].startedAt || Date.now();
    db.subscriptions[tid].expiresAt = null;
    db.subscriptions[tid].grantedBy = adminId || 'admin-panel';
    db.subscriptions[tid].isManualGrant = true;
  } else {
    target.isSubscriber = false;
    if (db.subscriptions[tid]) {
      db.subscriptions[tid].status = 'cancelled';
    }
  }
  saveDB('users', 'subscriptions');
  res.json({ ok: true, isSubscriber: target.isSubscriber });
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
    profilePhoto: u.profilePhoto || u.photoURL || null,
    isSubscriber: !!u.isSubscriber
  }));
  const events = Object.values(db.operatorEvents).filter(e => e.verified).map(e => ({
    id: e.id, name: e.name, verified: true, verifiedAt: e.verifiedAt,
    participants: (e.participants || []).length, active: e.active
  }));
  const allUsers = Object.values(db.users).map(u => ({
    id: u.id, nickname: u.nickname, name: u.name || u.nickname,
    verified: !!u.verified, stars: (u.stars || []).length,
    profilePhoto: u.profilePhoto || u.photoURL || null,
    isSubscriber: !!u.isSubscriber
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
    profession: user.profession || '', sports: user.sports || [], hobbies: user.hobbies || [],
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
    likesGiven: user.likesGiven || 0, declarationsReceived: (db.declarations ? Object.values(db.declarations).filter(d => d.toUserId === req.params.userId).length : 0),
    avatarAccessory: user.avatarAccessory || null,
    isTop1: (() => { if (user.topTag === 'top1') return true; if (user.registrationOrder === 1) return true; const scores = Object.keys(db.users).map(uid => ({ uid, score: calcScore(uid) })).sort((a, b) => b.score - a.score); return scores.length > 0 && scores[0].uid === req.params.userId; })()
  });
});

// ── Debug: photo diagnostic for constellation ──
app.get('/api/debug/photos/:userId', (req, res) => {
  const me = db.users[req.params.userId];
  if (!me) return res.status(404).json({ error: 'User not found' });
  const myCanSee = me.canSee || {};
  const encounters = db.encounters[req.params.userId] || [];
  const people = [...new Set(encounters.map(e => e.with))];
  const report = people.map(pid => {
    const other = db.users[pid];
    if (!other) return { id: pid, exists: false };
    const iCanSeeThem = !!myCanSee[pid];
    const canSeeSnapshot = myCanSee[pid] || null;
    const rels = Object.values(db.relations).filter(r => (r.userA === req.params.userId && r.userB === pid) || (r.userA === pid && r.userB === req.params.userId));
    let lastSelfie = null;
    if (rels.length > 0) {
      const sorted = rels.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (sorted[0].selfie) lastSelfie = sorted[0].selfie[pid] || null;
    }
    return {
      id: pid,
      nickname: other.nickname,
      authMethod: other.firebaseUid ? (other.photoURL ? 'google' : 'email') : 'unknown',
      profilePhoto: other.profilePhoto ? (other.profilePhoto.substring(0, 60) + '...') : null,
      photoURL: other.photoURL ? (other.photoURL.substring(0, 60) + '...') : null,
      iCanSeeThem,
      canSeePhoto: canSeeSnapshot ? (canSeeSnapshot.profilePhoto ? (canSeeSnapshot.profilePhoto.substring(0, 60) + '...') : null) : 'N/A',
      lastSelfie: lastSelfie ? (lastSelfie.substring(0, 60) + '...') : null,
      wouldReturn: iCanSeeThem ? (other.profilePhoto || other.photoURL || (canSeeSnapshot && canSeeSnapshot.profilePhoto) || lastSelfie || 'NULL') : 'NOT_REVEALED'
    };
  });
  res.json({ userId: req.params.userId, myNickname: me.nickname, totalPeople: people.length, report });
});

// Debug: show encounters + relations for a user
app.get('/api/debug/constellation/:userId', (req, res) => {
  const uid = req.params.userId;
  const user = db.users[uid];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const encounters = db.encounters[uid] || [];
  const relations = Object.values(db.relations).filter(r => r.userA === uid || r.userB === uid);
  // Group encounters by partner
  const byPartner = {};
  encounters.forEach(e => {
    if (!byPartner[e.with]) byPartner[e.with] = [];
    byPartner[e.with].push({ type: e.type, date: e.date, isEvent: e.isEvent || false, timestamp: e.timestamp });
  });
  // Check which would be filtered as service-only
  const serviceOnly = Object.entries(byPartner).filter(([pid, encs]) => {
    const svc = encs.filter(e => e.type === 'service').length;
    const pers = encs.filter(e => e.type !== 'service').length;
    return svc > 0 && pers === 0;
  }).map(([pid]) => pid);
  res.json({
    userId: uid,
    nickname: user.nickname,
    totalEncounters: encounters.length,
    totalRelations: relations.length,
    encountersByPartner: Object.entries(byPartner).map(([pid, encs]) => ({
      partnerId: pid,
      partnerName: (db.users[pid] || {}).nickname || '?',
      encounters: encs.length,
      types: encs.map(e => e.type),
      isServiceOnly: serviceOnly.includes(pid)
    })),
    activeRelations: relations.filter(r => r.expiresAt > Date.now()).map(r => ({
      id: r.id,
      partner: r.userA === uid ? r.userB : r.userA,
      partnerName: (db.users[r.userA === uid ? r.userB : r.userA] || {}).nickname || '?',
      expiresAt: new Date(r.expiresAt).toISOString()
    })),
    serviceOnlyPartners: serviceOnly.map(pid => ({ id: pid, name: (db.users[pid] || {}).nickname || '?' }))
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
app.post('/api/location/update', requireAuth, (req, res) => {
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

// Count active events where user is a participant
app.get('/api/events/active-count/:userId', (req, res) => {
  const userId = req.params.userId;
  let count = 0;
  Object.values(db.operatorEvents || {}).forEach(ev => {
    if (ev.active && Array.isArray(ev.participants) && ev.participants.includes(userId)) count++;
  });
  res.json({ count });
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
  if (!Array.isArray(ev.participants)) ev.participants = [];
  // Prevent duplicate check-in
  if (ev.participants.includes(userId)) return res.json({ ok: true, alreadyCheckedIn: true, eventId });
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
  if (!Array.isArray(ev.participants)) ev.participants = [];
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
  if (!Array.isArray(ev.participants)) ev.participants = [];
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
  const digPairAll = myEncounters.filter(e => e.with === fromUserId);
  const digPairEnc = digPairAll.length;
  const digNow24h = Date.now() - 86400000;
  const digPairEnc24h = digPairAll.filter(e => e.timestamp > digNow24h).length;
  const responseData = {
    relationId, phrase, expiresAt, renewed: !!existing, type: 'digital', eventName: ev ? ev.name : '',
    encounterCount: digPairEnc, encounterCount24h: digPairEnc24h,
    lastEncounter: lastEnc ? { phrase: lastEnc.phrase, timestamp: lastEnc.timestamp } : null,
    userA: { id: userA.id, name: userA.nickname || userA.name, realName: userA.realName || null, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: getZodiacSign(userA.birthdate), signInfo: getZodiacSign(userA.birthdate) ? ZODIAC_INFO[getZodiacSign(userA.birthdate)] : null, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '', accessory: userA.avatarAccessory || null },
    userB: { id: userB.id, name: userB.nickname || userB.name, realName: userB.realName || null, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: getZodiacSign(userB.birthdate), signInfo: getZodiacSign(userB.birthdate) ? ZODIAC_INFO[getZodiacSign(userB.birthdate)] : null, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', accessory: userB.avatarAccessory || null }
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
    if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
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
const SONIC_FREQ_STEP = 300;   // 300Hz steps (must be > 200Hz self-detection filter on client)
const SONIC_FREQ_SLOTS = 7;    // 7 frequencies: 18000, 18300, 18600, 18900, 19200, 19500, 19800
const sonicQueue = {}; // { oderId: { userId, freq, socketId, joinedAt } }
let nextFreqSlot = 0;

function assignSonicFreq() {
  const freq = SONIC_FREQ_BASE + (nextFreqSlot % SONIC_FREQ_SLOTS) * SONIC_FREQ_STEP;
  nextFreqSlot++;
  return freq;
}

function findSonicUserByFreq(freq) {
  // Exact match first
  const exact = Object.values(sonicQueue).find(s => s.freq === freq);
  if (exact) return exact;
  // Fuzzy match: ±150Hz tolerance (hardware imprecision in speaker/mic + snapping)
  // Must be < SONIC_FREQ_STEP/2 (150 < 300/2=150) to avoid matching wrong slot
  return Object.values(sonicQueue).find(s => Math.abs(s.freq - freq) <= 140) || null;
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
  // Service touch: only when the sonic entry explicitly has isServiceTouch flag
  // (user actively broadcasting in service mode), NOT just because profile has serviceModeActive
  const isServiceTouch = !!(entryA && entryA.isServiceTouch) || !!(entryB && entryB.isServiceTouch);
  console.log('[createSonicConnection] entryA:', entryA ? {userId:entryA.userId?.slice(0,8),isCheckin:entryA.isCheckin,freq:entryA.freq} : 'NONE', 'entryB:', entryB ? {userId:entryB.userId?.slice(0,8),isCheckin:entryB.isCheckin,freq:entryB.freq} : 'NONE', 'isCheckin:', isCheckin, 'isServiceTouch:', isServiceTouch);
  const operatorId = isCheckin ? (entryA && entryA.isCheckin ? userIdA : userIdB) : null;
  const operatorEntry = operatorId ? (operatorId === userIdA ? entryA : entryB) : null;
  const eventId = operatorEntry ? operatorEntry.eventId : null;
  const serviceProviderId = isServiceTouch ? (entryA && entryA.isServiceTouch ? userIdA : (entryB && entryB.isServiceTouch ? userIdB : (userA.isPrestador ? userIdA : userIdB))) : null;

  const phrase = isCheckin ? PHRASES.evento[Math.floor(Math.random() * PHRASES.evento.length)] : (isServiceTouch ? PHRASES.servico[Math.floor(Math.random() * PHRASES.servico.length)] : smartPhrase(userIdA, userIdB));
  const encounterType = isCheckin ? 'checkin' : (isServiceTouch ? 'service' : 'physical');

  // For check-ins: relation is between VISITOR and EVENT (not operator personally)
  const visitorId = isCheckin && operatorId ? (operatorId === userIdA ? userIdB : userIdA) : null;

  // ── BLOCK DUPLICATE CHECK-IN: if visitor already in event, reject ──
  if (isCheckin && eventId && visitorId) {
    const ev = db.operatorEvents[eventId];
    if (ev && Array.isArray(ev.participants) && ev.participants.includes(visitorId)) {
      console.log('[createSonicConnection] DUPLICATE CHECKIN blocked — visitor:', visitorId.slice(0,8), 'already in event:', eventId.slice(0,8));
      // Notify visitor they're already checked in
      io.to(`user:${visitorId}`).emit('checkin-duplicate', {
        eventId, eventName: ev.name || 'Evento',
        message: 'Você já fez check-in neste evento!'
      });
      // Remove visitor from sonic queue, operator stays
      delete sonicQueue[visitorId];
      // Reset operator timer so they stay active
      const opQueueKey = operatorEntry ? operatorEntry.queueKey : operatorId;
      if (sonicQueue[opQueueKey]) sonicQueue[opQueueKey].joinedAt = Date.now();
      return;
    }
  }

  // ── STAFF CONNECTION: if operator has pendingStaffRole AND visitor is in service mode ──
  const opEntry = operatorEntry;
  const pendingRole = opEntry ? opEntry.pendingStaffRole : null;
  if (pendingRole && isCheckin && eventId && visitorId && isServiceTouch) {
    const staffUserId = visitorId;
    const staffRole = pendingRole;
    const staffUser = db.users[staffUserId];
    const ev = db.operatorEvents[eventId];
    if (ev && staffUser) {
      const staffId = uuidv4();
      const staffMember = {
        id: staffId, userId: staffUserId,
        name: staffUser.realName || staffUser.nickname || staffUser.name || 'Staff',
        role: staffRole, tables: [], status: 'online',
        socketId: sonicQueue[staffUserId] ? sonicQueue[staffUserId].socketId : null,
        connectedAt: now
      };
      if (!ev.staff) ev.staff = [];
      // Remove any existing entry for this user
      ev.staff = ev.staff.filter(s => s.userId !== staffUserId);
      ev.staff.push(staffMember);
      saveDB('operatorEvents');
      // Notify operator
      io.to(`user:${ev.operatorId}`).emit('staff-joined', { eventId, staff: staffMember });
      // Notify staff member with their dashboard info
      io.to(`user:${staffUserId}`).emit('staff-connected', {
        eventId, eventName: ev.name, staffId, role: staffRole,
        tables: [], menu: ev.menu || []
      });
      // Remove from sonic queue
      delete sonicQueue[staffUserId];
      if (sonicQueue['evt:' + eventId]) sonicQueue['evt:' + eventId].joinedAt = Date.now();
      // Clear pendingStaffRole so next connection is normal visitor again
      if (opEntry) opEntry.pendingStaffRole = null;
      console.log('[createSonicConnection] STAFF connected:', staffRole, staffUserId.slice(0,8), 'to event:', eventId.slice(0,8));
      return;
    }
  }
  // If operator is waiting for staff but visitor is NOT in service mode, treat as normal visitor
  if (pendingRole && isCheckin && eventId && visitorId && !isServiceTouch) {
    console.log('[createSonicConnection] pendingStaffRole=' + pendingRole + ' but visitor NOT in service mode — treating as normal checkin');
    // Emit hint to visitor that they should enable service mode
    io.to('user:' + visitorId).emit('staff-hint', { message: 'Ative o Modo Servico para conectar como ' + (pendingRole === 'driver' ? 'motorista' : 'garcom') });
  }

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
    if (db.encounters[visitorId].length > 1000) db.encounters[visitorId] = db.encounters[visitorId].slice(-1000);
    // Award points to visitor only
    awardPoints(visitorId, null, 'checkin');
  }
  // ── SAME-EVENT DETECTION: check if both users are in the same active event ──
  let sharedEventId = null, sharedEventName = null;
  if (!isCheckin && !isServiceTouch) {
    for (const [evId, ev] of Object.entries(db.operatorEvents)) {
      if (ev.active && Array.isArray(ev.participants) && ev.participants.includes(userIdA) && ev.participants.includes(userIdB)) {
        sharedEventId = evId;
        sharedEventName = ev.name || 'Evento';
        break;
      }
    }
    const encType = sharedEventId ? 'event_match' : encounterType;
    recordEncounter(userIdA, userIdB, sharedEventId ? ('Encontro no evento: ' + sharedEventName) : phrase, encType, relationId);
    // Tag the relation with the shared event
    if (sharedEventId && db.relations[relationId]) {
      db.relations[relationId].eventId = sharedEventId;
      db.relations[relationId].eventName = sharedEventName;
      db.relations[relationId].isEventMatch = true;
    }
    // Notify operator(s) of the event match
    if (sharedEventId) {
      const ev = db.operatorEvents[sharedEventId];
      if (ev && ev.operatorId) {
        io.to(`user:${ev.operatorId}`).emit('event-match', {
          eventId: sharedEventId,
          eventName: sharedEventName,
          userA: { id: userIdA, nickname: userA.nickname || userA.name, color: userA.color, stars: (userA.stars || []).length },
          userB: { id: userIdB, nickname: userB.nickname || userB.name, color: userB.color, stars: (userB.stars || []).length },
          relationId,
          timestamp: now
        });
      }
      console.log('[createSonicConnection] EVENT MATCH — both in event:', sharedEventId.slice(0, 8), 'A:', userIdA.slice(0, 8), 'B:', userIdB.slice(0, 8));
    }
  }
  saveDB('relations', 'messages', 'encounters');
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
      operatorId: operatorId || null,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (eventObj && eventObj.entryPrice > 0) ? eventObj.entryPrice : 0,
      // userA = visitor, userB = event (virtual)
      userA: { id: visitorUser.id, name: visitorUser.nickname || visitorUser.name, color: visitorUser.color, profilePhoto: visitorUser.profilePhoto || null, photoURL: visitorUser.photoURL || null, score: calcScore(visitorUser.id), stars: (visitorUser.stars || []).length, sign: vSign, signInfo: vSign ? ZODIAC_INFO[vSign] : null, isPrestador: !!visitorUser.isPrestador, serviceLabel: visitorUser.serviceLabel || '' },
      userB: { id: 'evt:' + eventId, name: eventObj ? eventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true },
      zodiacPhrase: null
    };
  } else {
    const sonicPairAll = (db.encounters[userIdA] || []).filter(e => e.with === userIdB);
    const sonicPairEnc = sonicPairAll.length;
    const sonicNow24h = Date.now() - 86400000;
    const sonicPairEnc24h = sonicPairAll.filter(e => e.timestamp > sonicNow24h).length;
    responseData = {
      relationId, phrase: phrase, expiresAt, renewed: !!existing,
      sonicMatch: true, isCheckin, isServiceTouch,
      encounterCount: sonicPairEnc, encounterCount24h: sonicPairEnc24h,
      isEventMatch: !!sharedEventId, sharedEventId: sharedEventId || null, sharedEventName: sharedEventName || null,
      eventId: eventId || sharedEventId || null, eventName: eventObj ? eventObj.name : (sharedEventName || null),
      requireReveal: !!opRequireReveal,
      operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
      entryPrice: (eventObj && eventObj.entryPrice > 0) ? eventObj.entryPrice : 0,
      userA: { id: userA.id, name: userA.nickname || userA.name, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: signA ? ZODIAC_INFO[signA] : null, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '', accessory: userA.avatarAccessory || null },
      userB: { id: userB.id, name: userB.nickname || userB.name, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: signB ? ZODIAC_INFO[signB] : null, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '', accessory: userB.avatarAccessory || null },
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
      if (!Array.isArray(ev.participants)) ev.participants = [];
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
    // Check if either user is in the game lobby — if so, send game-sonic-invite to the other
    const socketsA = [...io.sockets.sockets.values()].filter(s => s.touchUserId === userIdA);
    const socketsB = [...io.sockets.sockets.values()].filter(s => s.touchUserId === userIdB);
    const aInLobby = socketsA.some(s => s._inGameLobby);
    const bInLobby = socketsB.some(s => s._inGameLobby);
    if (aInLobby || bInLobby) {
      const inviterUserId = aInLobby ? userIdA : userIdB;
      const inviteeUserId = aInLobby ? userIdB : userIdA;
      const inviterUser = db.users[inviterUserId];
      const inviterName = inviterUser ? (inviterUser.nickname || inviterUser.name || '?') : '?';
      console.log('[sonic-game-invite]', inviterName, 'is in lobby, inviting', inviteeUserId, 'relId:', relationId);
      io.to(`user:${inviteeUserId}`).emit('game-sonic-invite', {
        fromUserId: inviterUserId, fromName: inviterName, relationId
      });
      // Also notify the lobby user that the touch was sent as game invite
      io.to(`user:${inviterUserId}`).emit('game-sonic-invite-sent', {
        toUserId: inviteeUserId, relationId
      });
    }
  }
  // Notify operator dashboard if checkin
  if (isCheckin && operatorId) {
    const visitor = operatorId === userIdA ? userB : userA;
    const visitorId = visitor.id;
    const visitorUser = db.users[visitorId];
    const opUserDash = db.users[operatorId];
    const visRevealEntry = isRevealedTo(visitorId, opUserDash, eventId);
    const visitorRevealed = !!visRevealEntry;
    const totalUsers = Object.keys(db.users).length;
    const visitorStars = visitorUser ? (visitorUser.stars || []).length : 0;
    const visitorTopTag = visitorUser ? (visitorUser.topTag || null) : null;
    const checkinData = {
      userId: visitorId, nickname: visitor.nickname || visitor.name, color: visitor.color,
      profilePhoto: visitor.profilePhoto || visitor.photoURL || null, timestamp: now,
      relationId, revealed: visitorRevealed,
      revealData: visitorRevealed ? visRevealEntry : null,
      eventId: eventId || null,
      stars: visitorStars,
      topTag: visitorTopTag,
      score: calcScore(visitorId),
      welcomePhrase: (eventId && db.operatorEvents[eventId]) ? (db.operatorEvents[eventId].welcomePhrase || '') : ''
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
const _sonicQueueInterval = setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of Object.entries(sonicQueue)) {
    // Operators (isCheckin) get 10 min timeout, regular users 3 min
    const maxAge = entry.isCheckin ? 600000 : 180000;
    if (now - entry.joinedAt > maxAge) delete sonicQueue[uid];
  }
}, 30000);

// ── RESET REVEALS ONLY ──
app.post('/api/admin/reset-reveals', adminLimiter, requireAdmin, (req, res) => {
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
app.post('/api/admin/backup', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const reason = req.body.reason || 'manual';
    const id = await createBackup(reason);
    if (id) res.json({ ok: true, backupId: id, message: 'Backup criado com sucesso.' });
    else res.status(500).json({ error: 'Falha ao criar backup.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/backups', adminLimiter, requireAdmin, async (req, res) => {
  const backups = await listBackups();
  res.json({ backups });
});

app.post('/api/admin/rollback', adminLimiter, requireAdmin, async (req, res) => {
  const { backupId, confirm } = req.body;
  if (confirm !== 'ROLLBACK') return res.status(400).json({ error: 'Send { backupId, confirm: "ROLLBACK" } to confirm.' });
  if (!backupId) return res.status(400).json({ error: 'backupId required. Use GET /api/admin/backups to list.' });
  try {
    const result = await restoreBackup(backupId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SAFE RESET: only clear events & checkins, preserve relations/encounters/messages ──
app.post('/api/admin/reset-events', adminLimiter, requireAdmin, async (req, res) => {
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
app.post('/api/admin/reset-db', adminLimiter, requireAdmin, async (req, res) => {
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
    // Clear user transient/connection data but keep profile info
    Object.values(db.users).forEach(u => {
      // Clear connection data
      u.stars = []; u.points = 0; u.pointLog = [];
      u.canSee = {}; u.revealedTo = [];
      u.likesCount = 0; u.likedBy = [];
      u.agentNotes = []; u.vaUsage = null;
      u.topTag = null;
      // Keep: id, nickname, name, realName, email, color, phone, bio,
      // profilePhoto, photoURL, instagram, tiktok, twitter, firebaseUid,
      // createdAt, isAdmin, isSubscriber, verified, verifiedAt, verificationType,
      // savedCard, profession, sports, hobbies, privacy, avatarAccessory,
      // isPrestador, serviceLabel, subscription, cpf, emailVerified
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

// ── RECOVER ENCOUNTERS FROM RELATIONS (one-time fix) ──
app.post('/api/admin/recover-encounters', adminLimiter, requireAdmin, async (req, res) => {
  await createBackup('auto:before-recover-encounters');
  let created = 0;
  for (const [rid, r] of Object.entries(db.relations)) {
    if (!r.userA || !r.userB) continue;
    const uA = db.users[r.userA], uB = db.users[r.userB];
    if (!uA || !uB) continue;
    const ts = r.createdAt || Date.now();
    const date = new Date(ts).toISOString().slice(0, 10);
    const phrase = r.phrase || 'Encontro recuperado';
    const type = r.isEventCheckin ? 'checkin' : (r.type || 'physical');
    // Create encounter for userA
    if (!db.encounters[r.userA]) db.encounters[r.userA] = [];
    const alreadyA = db.encounters[r.userA].some(e => e.with === r.userB && Math.abs(e.timestamp - ts) < 60000);
    if (!alreadyA) {
      db.encounters[r.userA].push({ with: r.userB, withName: uB.nickname || uB.name || '?', withColor: uB.color, phrase, timestamp: ts, date, type, points: 10, scoreType: 'first_encounter', chatDurationH: 24, relationId: rid });
      if (db.encounters[r.userA].length > 1000) db.encounters[r.userA] = db.encounters[r.userA].slice(-1000);
      created++;
    }
    // Create encounter for userB
    if (!db.encounters[r.userB]) db.encounters[r.userB] = [];
    const alreadyB = db.encounters[r.userB].some(e => e.with === r.userA && Math.abs(e.timestamp - ts) < 60000);
    if (!alreadyB) {
      db.encounters[r.userB].push({ with: r.userA, withName: uA.nickname || uA.name || '?', withColor: uA.color, phrase, timestamp: ts, date, type, points: 10, scoreType: 'first_encounter', chatDurationH: 24, relationId: rid });
      if (db.encounters[r.userB].length > 1000) db.encounters[r.userB] = db.encounters[r.userB].slice(-1000);
      created++;
    }
    // If relation was renewed, add renewal encounters
    if (r.renewed && r.renewed > 0) {
      const renewTs = r.expiresAt ? r.expiresAt - 86400000 : ts + 86400000;
      const renewDate = new Date(renewTs).toISOString().slice(0, 10);
      const alreadyRA = db.encounters[r.userA].some(e => e.with === r.userB && Math.abs(e.timestamp - renewTs) < 60000);
      if (!alreadyRA) {
        db.encounters[r.userA].push({ with: r.userB, withName: uB.nickname || uB.name || '?', withColor: uB.color, phrase: 'Reencontro', timestamp: renewTs, date: renewDate, type, points: 8, scoreType: 're_encounter_diff_day', chatDurationH: 24, relationId: rid });
        if (db.encounters[r.userA].length > 1000) db.encounters[r.userA] = db.encounters[r.userA].slice(-1000);
        created++;
      }
      const alreadyRB = db.encounters[r.userB].some(e => e.with === r.userA && Math.abs(e.timestamp - renewTs) < 60000);
      if (!alreadyRB) {
        db.encounters[r.userB].push({ with: r.userA, withName: uA.nickname || uA.name || '?', withColor: uA.color, phrase: 'Reencontro', timestamp: renewTs, date: renewDate, type, points: 8, scoreType: 're_encounter_diff_day', chatDurationH: 24, relationId: rid });
        if (db.encounters[r.userB].length > 1000) db.encounters[r.userB] = db.encounters[r.userB].slice(-1000);
        created++;
      }
    }
  }
  saveDB('encounters');
  console.log(`🔧 Recovered ${created} encounter entries from ${Object.keys(db.relations).length} relations`);
  res.json({ ok: true, created, encounterUsers: Object.keys(db.encounters).length, totalEncounters: Object.values(db.encounters).reduce((s, a) => s + a.length, 0) });
});

// ── ADMIN PANEL ENDPOINTS ──

app.get('/api/admin/dashboard-stats', adminLimiter, requireAdmin, (req, res) => {
  try {
    const users = Object.values(db.users);
    const totalUsers = users.length;
    const verified = users.filter(u => u.verified).length;
    const premium = users.filter(u => u.isSubscriber).length;
    const prestadores = users.filter(u => u.isPrestador).length;
    const admins = users.filter(u => u.isAdmin).length;
    const totalRelations = Object.keys(db.relations).length;
    const totalEncounters = Object.keys(db.encounters).length;
    const events = Object.values(db.events);
    const activeEvents = events.filter(e => !e.endedAt && (!e.endsAt || new Date(e.endsAt) > new Date())).length;
    const totalEvents = events.length;
    const todayLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    todayLocal.setHours(0,0,0,0);
    const todayStart = todayLocal;
    let todayEncounters = 0;
    for (const uid of Object.keys(db.encounters)) {
      const arr = db.encounters[uid];
      if (Array.isArray(arr)) todayEncounters += arr.filter(e => e.timestamp && new Date(e.timestamp) >= todayStart).length;
    }
    let tipsTotal = 0, tipsCount = 0;
    for (const uid of Object.keys(db.tips || {})) {
      const arr = db.tips[uid];
      if (Array.isArray(arr)) { tipsCount += arr.length; arr.forEach(t => { tipsTotal += (t.amount || 0); }); }
    }
    let subsActive = 0;
    for (const uid of Object.keys(db.subscriptions || {})) {
      const s = db.subscriptions[uid];
      if (s && (s.status === 'authorized' || s.status === 'active')) subsActive++;
    }
    const seen = new Set();
    [...io.sockets.sockets.values()].forEach(s => { if (s.touchUserId) seen.add(s.touchUserId); });
    const onlineCount = seen.size;
    const growth = {};
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    users.forEach(u => {
      if (u.createdAt && new Date(u.createdAt).getTime() > thirtyDaysAgo) {
        const day = new Date(u.createdAt).toISOString().slice(0, 10);
        growth[day] = (growth[day] || 0) + 1;
      }
    });
    res.json({ totalUsers, verified, premium, prestadores, admins, totalRelations, totalEncounters, todayEncounters, activeEvents, totalEvents, tipsTotal, tipsCount, subsActive, onlineCount, uptime: process.uptime(), growth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', adminLimiter, requireAdmin, (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const filter = req.query.filter || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    let users = Object.values(db.users);
    if (filter === 'verified') users = users.filter(u => u.verified);
    else if (filter === 'premium') users = users.filter(u => u.isSubscriber);
    else if (filter === 'prestador') users = users.filter(u => u.isPrestador);
    else if (filter === 'admin') users = users.filter(u => u.isAdmin);
    if (q) users = users.filter(u => (u.nickname||'').toLowerCase().includes(q)||(u.name||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q)||(u.id||'').toLowerCase().includes(q));
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const total = users.length;
    const start = (page - 1) * limit;
    const paged = users.slice(start, start + limit).map(u => ({ id: u.id, nickname: u.nickname, name: u.name, email: u.email, stars: (u.stars||[]).length, points: u.points||0, verified: !!u.verified, isSubscriber: !!u.isSubscriber, isPrestador: !!u.isPrestador, isAdmin: !!u.isAdmin, topTag: u.topTag||null, photoURL: u.photoURL||null, createdAt: u.createdAt||null }));
    res.json({ users: paged, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/toggle-admin', adminLimiter, requireAdmin, (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !db.users[userId]) return res.status(404).json({ error: 'Usuario nao encontrado' });
    db.users[userId].isAdmin = !db.users[userId].isAdmin;
    markDirty('users');
    res.json({ ok: true, isAdmin: db.users[userId].isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/events', adminLimiter, requireAdmin, (req, res) => {
  try {
    const events = Object.values(db.events).map(e => {
      const op = db.operatorEvents ? Object.values(db.operatorEvents).find(oe => oe.eventId === e.id) : null;
      return { id: e.id, name: e.name, code: e.code, creatorId: e.creatorId, creatorName: e.creatorName, startsAt: e.startsAt, endsAt: e.endsAt, endedAt: e.endedAt, active: !e.endedAt && (!e.endsAt || new Date(e.endsAt) > new Date()), participants: (e.participants||[]).length, checkins: op?(op.checkinCount||0):0, revenue: op?(op.revenue||0):0, createdAt: e.createdAt };
    });
    events.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/financial', adminLimiter, requireAdmin, (req, res) => {
  try {
    let tipsTotal = 0, tipsCount = 0, tipsFee = 0;
    const recentTips = [];
    for (const uid of Object.keys(db.tips || {})) {
      const arr = db.tips[uid];
      if (!Array.isArray(arr)) continue;
      arr.forEach(t => { tipsCount++; tipsTotal += (t.amount||0); tipsFee += (t.touchFee||0); if (recentTips.length < 50) recentTips.push({ amount: t.amount, from: t.payerNickname||t.payerId, to: t.receiverNickname||t.receiverId, date: t.createdAt, method: t.method||'card' }); });
    }
    recentTips.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let subsActive = 0, subsTotal = 0;
    for (const uid of Object.keys(db.subscriptions || {})) { const s = db.subscriptions[uid]; if (!s) continue; subsTotal++; if (s.status === 'authorized' || s.status === 'active') subsActive++; }
    let eventRevenue = 0;
    for (const oe of Object.values(db.operatorEvents || {})) { eventRevenue += (oe.revenue || 0); }
    res.json({ tips: { total: tipsTotal, count: tipsCount, fee: tipsFee }, subscriptions: { active: subsActive, total: subsTotal }, events: { revenue: eventRevenue }, recentTips: recentTips.slice(0, 30) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATUS / HEALTH ──
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, uptime: process.uptime(),
    dbLoadedFromCloud: _dbLoadedFromCloud,
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

// ── ADMIN: FIREBASE DIAGNOSTIC (read directly from Firebase, bypass memory cache) ──
app.get('/api/admin/firebase-diagnostic', adminLimiter, requireAdmin, async (req, res) => {
  try {
    // Read directly from Firebase RTDB (not from memory)
    const snap = await withTimeout(rtdb.ref('/').once('value'), 30000, 'firebase diagnostic');
    const data = snap.val();
    if (!data) return res.json({ firebase: 'EMPTY', memory: { users: Object.keys(db.users).length }, backups: 0 });
    const fbCounts = {};
    DB_COLLECTIONS.forEach(c => { fbCounts[c] = data[c] ? Object.keys(data[c]).length : 0; });
    const memCounts = {};
    DB_COLLECTIONS.forEach(c => { memCounts[c] = Object.keys(db[c] || {}).length; });
    const backupCount = data.backups ? Object.keys(data.backups).length : 0;
    const backupKeys = data.backups ? Object.keys(data.backups).sort() : [];
    res.json({
      firebase: fbCounts,
      memory: memCounts,
      dbLoadedFromCloud: _dbLoadedFromCloud,
      backupCount,
      backupTimestamps: backupKeys.map(k => ({ id: k, date: new Date(parseInt(k)).toISOString() })),
      serverUptime: process.uptime(),
      lastKnownCounts: _lastKnownCounts
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: FORCE RELOAD FROM FIREBASE ──
app.post('/api/admin/force-reload', adminLimiter, requireAdmin, async (req, res) => {
  try {
    // Create backup of current state first (even if empty, for logging)
    const backupId = await createBackup('pre-force-reload');
    // Read directly from Firebase
    const snap = await withTimeout(rtdb.ref('/').once('value'), 30000, 'force reload');
    const data = snap.val();
    if (!data) return res.status(404).json({ error: 'Firebase is completely empty' });
    const before = {};
    DB_COLLECTIONS.forEach(c => { before[c] = Object.keys(db[c] || {}).length; });
    DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
    const after = {};
    DB_COLLECTIONS.forEach(c => { after[c] = Object.keys(db[c] || {}).length; });
    // Rebuild indexes
    IDX.nickname.clear(); IDX.firebaseUid.clear();
    if (IDX.operatorByCreator) IDX.operatorByCreator.clear();
    Object.values(db.users).forEach(u => {
      if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), u.id);
      if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, u.id);
    });
    _dbLoadedFromCloud = Object.keys(db.users).length > 0;
    DB_COLLECTIONS.forEach(c => { _lastKnownCounts[c] = Object.keys(db[c] || {}).length; });
    initRegistrationCounter();
    res.json({ ok: true, before, after, backupId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: force create connection between two users
app.post('/api/admin/force-connect', adminLimiter, requireAdmin, (req, res) => {
  const { userIdA, userIdB } = req.body;
  if (!userIdA || !userIdB) return res.status(400).json({ error: 'userIdA and userIdB required' });
  const userA = db.users[userIdA];
  const userB = db.users[userIdB];
  if (!userA) return res.status(404).json({ error: 'userA not found' });
  if (!userB) return res.status(404).json({ error: 'userB not found' });
  if (userIdA === userIdB) return res.status(400).json({ error: 'Cannot connect user to self' });
  const existing = findActiveRelation(userIdA, userIdB);
  const now = Date.now();
  let relationId;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.renewed = (existing.renewed || 0) + 1;
    relationId = existing.id;
  } else {
    relationId = uuidv4();
    const phrase = smartPhrase(userIdA, userIdB);
    db.relations[relationId] = { id: relationId, userA: userIdA, userB: userIdB, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null };
    idxAddRelation(relationId, userIdA, userIdB);
    db.messages[relationId] = [];
    recordEncounter(userIdA, userIdB, phrase, 'physical');
  }
  saveDB('relations', 'messages', 'encounters');
  // Notify both users via socket
  io.to(`user:${userIdA}`).emit('sonic-matched', { withUser: userIdB });
  io.to(`user:${userIdB}`).emit('sonic-matched', { withUser: userIdA });
  res.json({ ok: true, relationId, renewed: !!existing, userA: userA.nickname, userB: userB.nickname });
});

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  let currentUserId = null;

  // Auto-identify from query param (lobby iframe sends userId in query)
  const qUserId = socket.handshake?.query?.userId;
  if (qUserId && typeof qUserId === 'string' && qUserId.length > 3) {
    currentUserId = qUserId;
    socket.touchUserId = qUserId;
    socket.join(`user:${qUserId}`);
  }

  socket.on('identify', (userId) => {
    currentUserId = userId;
    socket.touchUserId = userId;
    socket.join(`user:${userId}`);
  });

  socket.on('join-session', (sessionId) => { socket.join(`session:${sessionId}`); });

  socket.on('send-message', ({ relationId, userId, text }) => {
    if (!dbLoaded) return; // Guard: DB not ready
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, text, timestamp: Date.now() };
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('new-message', { relationId, message: msg });
  });

  socket.on('typing', ({ relationId, userId }) => {
    if (!dbLoaded) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('partner-typing', { relationId });
  });

  // Pulse — silent vibration to partner
  socket.on('pulse', ({ relationId, userId }) => {
    if (!dbLoaded) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('pulse-received', { relationId, from: userId });
  });

  // Ephemeral message — persisted so recipient sees when opening chat
  socket.on('send-ephemeral', ({ relationId, userId, text }) => {
    if (!dbLoaded) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, text, type: 'ephemeral', timestamp: Date.now() };
    // Save to messages so it appears when recipient opens chat
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('ephemeral-received', { relationId, message: msg });
  });

  // Photo message
  socket.on('send-photo', ({ relationId, userId, photoData }) => {
    if (!dbLoaded) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, type: 'photo', photoData, timestamp: Date.now() };
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('photo-received', { relationId, message: msg });
  });

  // Sonic connection — ultrasonic frequency matching
  socket.on('sonic-start', ({ userId, isCheckin, isServiceTouch, eventId, staffRole }) => {
    if (!dbLoaded) return;
    if (!userId || !db.users[userId]) return;
    const freq = assignSonicFreq();
    // For checkin operators, use eventId as sonicQueue key to avoid overwriting phone's entry
    const queueKey = (isCheckin && eventId) ? ('evt:' + eventId) : userId;
    sonicQueue[queueKey] = { userId, freq, socketId: socket.id, joinedAt: Date.now(), isCheckin: !!isCheckin, isServiceTouch: !!isServiceTouch, eventId: eventId || null, queueKey, staffRole: staffRole || null };
    console.log('[sonic-start] user:', userId.slice(0,8)+'..', 'key:', queueKey.slice(0,12), 'freq:', freq, 'isCheckin:', !!isCheckin, 'staffRole:', staffRole || 'none');
    socket.emit('sonic-assigned', { freq });
    // Join event socket room if checkin
    if (isCheckin && eventId) socket.join('event:' + eventId);
  });

  socket.on('sonic-detected', ({ userId, detectedFreq }) => {
    if (!dbLoaded) return;
    if (!userId || !db.users[userId]) return;
    const emitter = findSonicUserByFreq(detectedFreq);
    console.log('[sonic-detected] user:', userId?.slice(0,12), 'detected freq:', detectedFreq, '→ emitter:', emitter ? emitter.userId?.slice(0,12) : 'NOT FOUND', '| queue:', Object.keys(sonicQueue).map(k => k.slice(0,12)+'..freq:'+sonicQueue[k].freq).join(', '));
    if (emitter && emitter.userId !== userId) {
      try {
        createSonicConnection(emitter.userId, userId);
      } catch (e) {
        console.error('[sonic-detected] createSonicConnection ERROR:', e.message, e.stack);
        socket.emit('sonic-no-match', { reason: 'error' });
      }
    } else if (!emitter) {
      // No one found at that frequency — likely self-detection or stale
      console.log('[sonic-detected] No match for freq', detectedFreq, '(self-detection or no one active)');
      socket.emit('sonic-no-match', { reason: 'no-emitter', detectedFreq });
    } else {
      // emitter.userId === userId — detected own frequency
      console.log('[sonic-detected] Self-detection ignored for user', userId?.slice(0,12));
      socket.emit('sonic-no-match', { reason: 'self', detectedFreq });
    }
  });

  // Staff socket events
  socket.on('staff-update-status', ({ eventId, userId, status }) => {
    if (!dbLoaded || !eventId || !userId) return;
    const ev = db.operatorEvents[eventId];
    if (!ev || !ev.staff) return;
    const member = ev.staff.find(s => s.userId === userId);
    if (member) {
      member.status = status;
      saveDB('operatorEvents');
      io.to(`user:${ev.operatorId}`).emit('staff-status-changed', { eventId, staffId: member.id, userId, status });
    }
  });

  socket.on('staff-order-ready', ({ eventId, orderId }) => {
    if (!dbLoaded || !eventId || !orderId) return;
    const ev = db.operatorEvents[eventId];
    if (!ev) return;
    const order = (ev.orders || []).find(o => o.id === orderId);
    if (order) {
      order.status = 'ready';
      saveDB('operatorEvents');
      // Notify the waiter who placed the order
      if (order.waiterId) {
        const waiter = (ev.staff || []).find(s => s.id === order.waiterId);
        if (waiter) io.to(`user:${waiter.userId}`).emit('order-ready-for-waiter', { eventId, order });
      }
      io.to('event:' + eventId).emit('order-status-update', { orderId, status: 'ready' });
    }
  });

  // Operator sets pending staff role for next sonic connection
  socket.on('sonic-set-staff-role', ({ eventId, staffRole }) => {
    if (!eventId) return;
    const queueKey = 'evt:' + eventId;
    if (sonicQueue[queueKey]) {
      sonicQueue[queueKey].pendingStaffRole = staffRole || null;
      console.log('[sonic-set-staff-role] event:', eventId.slice(0,8), 'role:', staffRole);
      socket.emit('sonic-staff-role-set', { staffRole });
    }
  });

  socket.on('sonic-stop', ({ userId, eventId }) => {
    if (eventId) delete sonicQueue['evt:' + eventId];
    else if (userId) delete sonicQueue[userId];
  });

  // ═══ TOUCHGAMES — Lobby presence ═══
  function broadcastLobbyUpdate() {
    const seen = new Set();
    const lobbyUsers = [...io.sockets.sockets.values()].filter(s => s._inGameLobby && s.touchUserId && !seen.has(s.touchUserId) && seen.add(s.touchUserId));
    const lobbyInfo = lobbyUsers.map(s => {
      const u = db.users[s.touchUserId];
      return { userId: s.touchUserId, nickname: u ? (u.nickname || u.name || '?') : '?', color: u ? (u.color || '#ff6b35') : '#ff6b35', photo: u ? (u.profilePhoto || u.photoURL || '') : '' };
    });
    io.emit('game-lobby-update', { count: lobbyInfo.length, users: lobbyInfo });
  }
  socket.on('game-lobby-join', () => {
    socket._inGameLobby = true;
    broadcastLobbyUpdate();
  });
  socket.on('game-lobby-leave', () => {
    socket._inGameLobby = false;
    broadcastLobbyUpdate();
  });

  // ═══ TOUCHGAMES — Real-time game events ═══
  // Send game invite as a chat message (main flow from index.html)
  socket.on('game-invite-chat', ({ fromUserId, toUserId, gameId, sessionId, gameName, gameIcon, gameFile, relationId }) => {
    console.log('[game-invite-chat]', { fromUserId, toUserId, gameId, sessionId, relationId: relationId || '(lookup)', socketUser: socket.touchUserId });
    if (!fromUserId || !toUserId || !gameId || !sessionId) { console.log('[game-invite-chat] REJECTED: missing fields'); return; }
    const now = Date.now();
    // Check if target is busy
    const targetBusy = Object.values(db.gameSessions).find(gs =>
      gs.players.includes(toUserId) && gs.status === 'playing' && (!gs.createdAt || now - gs.createdAt < 3600000)
    );
    if (targetBusy) {
      const senderSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === fromUserId);
      senderSockets.forEach(s => s.emit('game-target-busy', { toUserId, sessionId }));
      return;
    }
    // Check if target is online
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === toUserId);
    if (targetSockets.length === 0) {
      const senderSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === fromUserId);
      senderSockets.forEach(s => s.emit('game-target-offline', { toUserId, sessionId }));
      return;
    }
    // Find relation between players (use provided or lookup)
    let relId = relationId;
    if (!relId) {
      const pairKey = [fromUserId, toUserId].sort().join('_');
      relId = IDX.relationPair.get(pairKey);
    }
    if (!relId || !db.relations[relId] || db.relations[relId].expiresAt <= now) {
      const senderSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === fromUserId);
      senderSockets.forEach(s => s.emit('game-no-relation', { toUserId, sessionId }));
      return;
    }
    // Save invite as special chat message
    const inviteText = '[game-invite:' + gameId + ':' + sessionId + ':' + (gameName || 'Jogo') + ':' + (gameIcon || '') + ']';
    const msg = { id: uuidv4(), userId: fromUserId, text: inviteText, timestamp: now };
    if (!db.messages[relId]) db.messages[relId] = [];
    db.messages[relId].push(msg);
    if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
    saveDB('messages');
    // Notify both users
    io.to(`user:${fromUserId}`).emit('new-message', { relationId: relId, message: msg });
    io.to(`user:${toUserId}`).emit('new-message', { relationId: relId, message: msg });
    // Also send direct notification for toast/badge
    targetSockets.forEach(s => s.emit('game-invite-notify', { fromUserId, gameId, sessionId, gameName: gameName || '', relationId: relId }));
  });

  // Legacy game-invite (direct socket from games/index.html — accepts both param styles)
  socket.on('game-invite', ({ fromUserId, from, toUserId, to, gameId, sessionId, gameName, gameIcon, gameDesc, gameFile, fromName, fromColor }) => {
    const sender = fromUserId || from;
    const target = toUserId || to;
    if (!sender || !target || !gameId) return;
    const now = Date.now();
    const targetBusy = Object.values(db.gameSessions).find(gs =>
      gs.players.includes(target) && gs.status === 'playing' && (!gs.createdAt || now - gs.createdAt < 3600000)
    );
    if (targetBusy) {
      const senderSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === sender);
      senderSockets.forEach(s => s.emit('game-target-busy', { toUserId: target, sessionId }));
      return;
    }
    const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === target);
    if (targetSockets.length === 0) {
      const senderSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === sender);
      senderSockets.forEach(s => s.emit('game-target-offline', { toUserId: target, sessionId }));
      return;
    }
    targetSockets.forEach(s => s.emit('game-invite', { fromUserId: sender, gameId, sessionId, gameName: gameName || '', gameIcon: gameIcon || '', gameDesc: gameDesc || '', gameFile: gameFile || '' }));
  });

  // game-ready: both players confirm they want to enter the game NOW
  socket.on('game-ready', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs || gs.status !== 'waiting') return;
    if (!gs._readyPlayers) gs._readyPlayers = [];
    if (!gs._readyPlayers.includes(userId)) gs._readyPlayers.push(userId);
    // Both players ready? Start the game
    if (gs._readyPlayers.length >= 2) {
      gs.status = 'playing';
      gs.startedAt = Date.now();
      delete gs._readyPlayers;
      saveDB('gameSessions');
      gs.players.forEach(pId => {
        const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === pId);
        targetSockets.forEach(s => s.emit('game-start', { sessionId, gameId: gs.gameId, gameFile: gs.gameFile || '', players: gs.players }));
      });
    } else {
      // Notify the other player that this player is ready
      const otherPlayers = gs.players.filter(p => p !== userId);
      otherPlayers.forEach(pId => {
        const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === pId);
        targetSockets.forEach(s => s.emit('game-player-ready', { sessionId, userId }));
      });
    }
  });

  // game-cancel-ready: player backs out of ready confirmation
  socket.on('game-cancel-ready', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs) return;
    if (gs._readyPlayers) gs._readyPlayers = gs._readyPlayers.filter(p => p !== userId);
    // Notify other players
    const otherPlayers = gs.players.filter(p => p !== userId);
    otherPlayers.forEach(pId => {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === pId);
      targetSockets.forEach(s => s.emit('game-player-unready', { sessionId, userId }));
    });
  });

  socket.on('game-move', ({ sessionId, userId, move }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs) return;
    // Forward move to other player(s) in the session
    const opponents = gs.players.filter(p => p !== userId);
    opponents.forEach(opId => {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === opId);
      targetSockets.forEach(s => s.emit('game-opponent-move', { sessionId, move }));
    });
    // Store move
    if (!gs.moves) gs.moves = [];
    gs.moves.push({ userId, move, t: Date.now() });
  });

  socket.on('game-surrender', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs) return;
    gs.status = 'finished';
    gs.winner = gs.players.find(p => p !== userId) || null;
    gs.endedAt = Date.now();
    saveDB('gameSessions');
    // Notify opponents
    const opponents = gs.players.filter(p => p !== userId);
    opponents.forEach(opId => {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === opId);
      targetSockets.forEach(s => s.emit('game-opponent-surrendered', { sessionId }));
    });
  });

  socket.on('game-accept', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs || gs.status !== 'waiting') return;
    // Instead of starting immediately, show "ready?" confirmation to BOTH players
    gs._readyPlayers = [];
    saveDB('gameSessions');
    // Notify all players to show ready confirmation window
    gs.players.forEach(pId => {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === pId);
      targetSockets.forEach(s => s.emit('game-ready-check', { sessionId, gameId: gs.gameId, gameName: gs.gameName || '', gameFile: gs.gameFile || '', players: gs.players, acceptedBy: userId }));
    });
  });

  socket.on('game-cancel-ready', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs) return;
    gs.status = 'cancelled';
    delete gs._readyPlayers;
    saveDB('gameSessions');
    const other = gs.players.find(p => p !== userId);
    if (other) {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === other);
      targetSockets.forEach(s => s.emit('game-ready-cancelled', { sessionId }));
    }
  });

  socket.on('game-decline', ({ sessionId, userId }) => {
    if (!dbLoaded || !sessionId || !userId) return;
    const gs = db.gameSessions[sessionId];
    if (!gs) return;
    gs.status = 'declined';
    saveDB('gameSessions');
    const host = gs.players.find(p => p !== userId);
    if (host) {
      const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === host);
      targetSockets.forEach(s => s.emit('game-declined', { sessionId }));
    }
  });

  socket.on('disconnect', () => {
    // Limpa entradas do sonicQueue deste socket para evitar entradas orfas
    for (const key in sonicQueue) {
      if (sonicQueue[key].socketId === socket.id) {
        console.log('[Sonic] Limpando entrada orfa do sonicQueue:', key, 'socket:', socket.id);
        delete sonicQueue[key];
      }
    }
  });
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
app.post('/api/tip/create', paymentLimiter, async (req, res) => {
  const { payerId, receiverId, amount, token, paymentMethodId, issuer, installments, payerEmail, payerCPF } = req.body;
  if (!payerId || !receiverId || !amount || !token) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  // Accept tips for prestadores OR operators with acceptsTips events
  const isOperatorWithTips = isOperatorWithTipsCheck(receiverId);
  if (!receiver) return res.status(404).json({ error: 'Destinatário não encontrado.' });

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

    const isTestMode = MP_PUBLIC_KEY.startsWith('TEST-') || MP_ACCESS_TOKEN.startsWith('TEST-');
    console.log('💳 Processing payment:', { amount: tipAmount, method: paymentMethodId, email, receiverId, hasToken: !!token, isTestMode });

    // In test mode, use test email format if user email would cause issues
    if (isTestMode && email && !email.includes('testuser.com')) {
      console.log('💳 Test mode: using test-compatible email for payer');
      paymentData.payer.email = 'test_user_' + Date.now() + '@testuser.com';
    }

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
    console.error('Payment error:', e.message, e.cause ? JSON.stringify(e.cause).slice(0,500) : '', e.status || '');
    const errMsg = (e.message || 'tente novamente').toLowerCase();
    const errCause = JSON.stringify(e.cause || '').toLowerCase();
    // Provide more useful error messages
    if ((errMsg.includes('customer') && errMsg.includes('not found')) || errCause.includes('customer')) {
      res.status(400).json({ error: 'Erro de cadastro no pagamento. Tente novamente com os dados corretos.', detail: 'customer_not_found', hint: 'Em modo teste, use cartao de teste: 5031 4332 1540 6351, CVV 123, venc 11/30, nome APRO, CPF 12345678909' });
    } else if (errMsg.includes('token') || errCause.includes('token')) {
      res.status(400).json({ error: 'Token do cartao invalido ou expirado. Tente novamente.' });
    } else if (errMsg.includes('access_token') || errMsg.includes('401')) {
      res.status(500).json({ error: 'Credenciais do Mercado Pago invalidas. Contate o suporte.' });
    } else if (errMsg.includes('email') || errCause.includes('email')) {
      res.status(400).json({ error: 'Email invalido. Atualize seu email no perfil.' });
    } else {
      res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente'), detail: errMsg });
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
  if (!IDX.tipsByPayer.has(tip.payerId)) IDX.tipsByPayer.set(tip.payerId, []);
  IDX.tipsByPayer.get(tip.payerId).push(tip.id);
  if (!IDX.tipsByReceiver.has(tip.receiverId)) IDX.tipsByReceiver.set(tip.receiverId, []);
  IDX.tipsByReceiver.get(tip.receiverId).push(tip.id);
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
  if (!receiver) return res.status(404).json({ error: 'Destinatário não encontrado.' });
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
    const tipPix = {
      id: tipId, payerId, receiverId, amount: tipAmount, fee: touchFee,
      mpPaymentId: result.id, status: result.status, statusDetail: result.status_detail,
      method: 'pix', createdAt: Date.now()
    };
    db.tips[tipId] = tipPix;
    if (!IDX.tipsByPayer.has(tipPix.payerId)) IDX.tipsByPayer.set(tipPix.payerId, []);
    IDX.tipsByPayer.get(tipPix.payerId).push(tipPix.id);
    if (!IDX.tipsByReceiver.has(tipPix.receiverId)) IDX.tipsByReceiver.set(tipPix.receiverId, []);
    IDX.tipsByReceiver.get(tipPix.receiverId).push(tipPix.id);
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
  if (!receiver) return res.status(404).json({ error: 'Destinatário não encontrado.' });
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
    const tipCheckoutPro = {
      id: tipId, payerId, receiverId, amount: tipAmount, fee: touchFee,
      mpPreferenceId: preference.id, status: 'pending', statusDetail: 'waiting_checkout',
      method: 'checkout_pro', createdAt: Date.now()
    };
    db.tips[tipId] = tipCheckoutPro;
    if (!IDX.tipsByPayer.has(tipCheckoutPro.payerId)) IDX.tipsByPayer.set(tipCheckoutPro.payerId, []);
    IDX.tipsByPayer.get(tipCheckoutPro.payerId).push(tipCheckoutPro.id);
    if (!IDX.tipsByReceiver.has(tipCheckoutPro.receiverId)) IDX.tipsByReceiver.set(tipCheckoutPro.receiverId, []);
    IDX.tipsByReceiver.get(tipCheckoutPro.receiverId).push(tipCheckoutPro.id);
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
app.get('/api/tips/:userId', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const tipIds = new Set([...(IDX.tipsByPayer.get(userId) || []), ...(IDX.tipsByReceiver.get(userId) || [])]);
  const tips = Array.from(tipIds).map(tid => db.tips[tid]).filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const enriched = tips.map(t => ({
    ...t,
    payerName: db.users[t.payerId]?.nickname || '?',
    payerPhoto: db.users[t.payerId]?.profilePhoto || null,
    payerColor: db.users[t.payerId]?.color || null,
    receiverName: db.users[t.receiverId]?.nickname || '?',
    receiverPhoto: db.users[t.receiverId]?.profilePhoto || null,
    receiverColor: db.users[t.receiverId]?.color || null,
    receiverService: db.users[t.receiverId]?.serviceLabel || '',
    direction: t.payerId === userId ? 'sent' : 'received'
  }));
  res.json(enriched);
});

// Financial summary for user (extrato)
app.get('/api/financial/:userId', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const tipIds = new Set([...(IDX.tipsByPayer.get(userId) || []), ...(IDX.tipsByReceiver.get(userId) || [])]);
  const allTips = Array.from(tipIds).map(tid => db.tips[tid]).filter(Boolean);
  const received = allTips.filter(t => t.receiverId === userId && t.status === 'approved');
  const sent = allTips.filter(t => t.payerId === userId && t.status === 'approved');
  const pending = allTips.filter(t => (t.payerId === userId || t.receiverId === userId) && (t.status === 'pending' || t.status === 'in_process'));
  const totalReceived = received.reduce((s, t) => s + (t.amount || 0), 0);
  const totalSent = sent.reduce((s, t) => s + (t.amount || 0), 0);
  const totalFees = received.reduce((s, t) => s + (t.fee || 0), 0);
  const netReceived = totalReceived - totalFees;
  // Group by month
  const byMonth = {};
  allTips.filter(t => t.status === 'approved').forEach(t => {
    const d = new Date(t.createdAt);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (!byMonth[key]) byMonth[key] = { received: 0, sent: 0, fees: 0, count: 0 };
    if (t.receiverId === userId) { byMonth[key].received += t.amount || 0; byMonth[key].fees += t.fee || 0; }
    if (t.payerId === userId) byMonth[key].sent += t.amount || 0;
    byMonth[key].count++;
  });
  res.json({
    summary: { totalReceived, totalSent, totalFees, netReceived, pendingCount: pending.length },
    byMonth,
    isPrestador: !!user.isPrestador,
    mpConnected: !!user.mpConnected,
    tipsReceivedCount: received.length,
    tipsSentCount: sent.length
  });
});

// Full transaction history for a user (tips, entries, encounters)
app.get('/api/user/:userId/transactions', requireAuth, (req, res) => {
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

  // Today (using user's timezone)
  const tipsToday = tipsApproved.filter(t => t.createdAt >= getUserTodayStart(userId));
  const todayTotal = tipsToday.reduce((s, t) => s + (t.amount || 0), 0);

  // This week (using user's timezone)
  const tipsWeek = tipsApproved.filter(t => t.createdAt >= getUserWeekStart(userId));
  const weekTotal = tipsWeek.reduce((s, t) => s + (t.amount || 0), 0);

  // This month (using user's timezone)
  const tipsMonth = tipsApproved.filter(t => t.createdAt >= getUserMonthStart(userId));
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

// ── MercadoPago webhook signature verification ──
function verifyMPWebhookSignature(req) {
  if (!MP_WEBHOOK_SECRET) return true; // Skip if not configured (dev)
  const xSig = req.headers['x-signature'] || '';
  const xReqId = req.headers['x-request-id'] || '';
  if (!xSig) return false;
  // Parse x-signature: "ts=...,v1=..."
  const parts = {};
  xSig.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });
  if (!parts.ts || !parts.v1) return false;
  // Build manifest string: id:{data.id};request-id:{x-request-id};ts:{ts};
  const dataId = req.query['data.id'] || (req.body.data && req.body.data.id) || '';
  const manifest = `id:${dataId};request-id:${xReqId};ts:${parts.ts};`;
  const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return hmac === parts.v1;
}

// MercadoPago webhook
app.post('/mp/webhook', (req, res) => {
  // Validate webhook signature
  if (!verifyMPWebhookSignature(req)) {
    console.warn('⚠️ MP Webhook: signature inválida', { ip: req.ip, type: req.body?.type });
    return res.sendStatus(401);
  }
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
          // Handle subscription PIX activation
          if (tip.type === 'subscription' && tip.planId) {
            const sub = Object.values(db.subscriptions).find(s => s.mpPaymentId && String(s.mpPaymentId) === String(paymentId));
            if (sub) {
              sub.status = 'authorized';
              const user = db.users[sub.userId];
              if (user) {
                user.isSubscriber = true;
                user.verified = true;
                user.verifiedAt = user.verifiedAt || Date.now();
                user.verificationType = user.verificationType || 'subscriber';
              }
              console.log('[webhook] Subscription PIX approved:', { userId: sub.userId, plan: sub.planId });
              saveDB('users');
            }
          }
          // Handle event entry PIX activation
          else if (tip.type === 'entry' && tip.eventId) {
            const ev = db.operatorEvents[tip.eventId];
            if (ev) {
              ev.revenue = (ev.revenue || 0) + tip.amount;
              ev.paidCheckins = (ev.paidCheckins || 0) + 1;
              if (!ev.participants) ev.participants = [];
              if (!ev.participants.includes(tip.payerId)) ev.participants.push(tip.payerId);
              saveDB('operatorEvents');
              io.emit('checkin', { eventId: ev.id, userId: tip.payerId });
              io.to(`user:${ev.creatorId}`).emit('entry-paid', { userId: tip.payerId, amount: tip.amount, eventId: ev.id, status: 'approved', method: 'pix' });
              console.log('[webhook] Entry PIX approved:', { event: ev.name, userId: tip.payerId });
            }
          }
          // Regular tip
          else {
            const receiver = db.users[tip.receiverId];
            if (receiver && tip.receiverId !== 'platform') {
              receiver.tipsReceived = (receiver.tipsReceived || 0) + 1;
              receiver.tipsTotal = (receiver.tipsTotal || 0) + tip.amount;
            }
            io.to(`user:${tip.receiverId}`).emit('tip-received', { amount: tip.amount, from: db.users[tip.payerId]?.nickname || '?' });
          }
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
  if (!user) return res.json({ hasSaved: false });
  if (user.savedCard && user.savedCard.lastFour && user.savedCard.customerId) {
    res.json({ hasSaved: true, lastFour: user.savedCard.lastFour, brand: user.savedCard.brand || 'Cartão', cardId: user.savedCard.cardId || null });
  } else {
    res.json({ hasSaved: false });
  }
});

// Save card: tokenize → create MP customer → save card to customer
app.post('/api/tip/save-card', paymentLimiter, async (req, res) => {
  const { userId, token, email, cpf } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });
  if (!db.users[userId]) return res.status(404).json({ error: 'Usuario nao encontrado. Faca login novamente.' });
  if (!token) return res.status(400).json({ error: 'Token do cartao e obrigatorio.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento nao configurado. Verifique as credenciais.' });
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
  if (!receiver) return res.status(404).json({ error: 'Destinatário não encontrado.' });
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

    // In test mode, use test email
    const isTestMode = MP_PUBLIC_KEY.startsWith('TEST-') || MP_ACCESS_TOKEN.startsWith('TEST-');
    if (isTestMode) {
      paymentData.payer.email = 'test_user_' + Date.now() + '@testuser.com';
    }

    console.log('⚡ One-tap pay:', { amount: tipAmount, customer: customerId, card: card.id, last4: card.last_four_digits, method: card.payment_method?.id, receiverMpConnected: !!receiver.mpConnected, isTestMode });

    // Payment always goes through — if receiver has MP connected, use split payment; otherwise goes to Touch account
    let result;
    if (receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      result = await receiverPayment.create({ body: paymentData });
    } else {
      // Receiver has no MP connected — payment goes to Touch account
      result = await mpPayment.create({ body: paymentData });
    }
    console.log('⚡ One-tap result:', { id: result.id, status: result.status, detail: result.status_detail });
    return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
  } catch (e) {
    console.error('One-tap error:', e.message, e.cause ? JSON.stringify(e.cause) : '');
    // Extract MP error detail if available
    const detail = e.cause?.message || e.message || 'tente novamente';
    res.status(500).json({ error: 'Erro no pagamento: ' + detail, detail });
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
app.post('/api/subscription/create-card', paymentLimiter, async (req, res) => {
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
    const planAmounts = { touch_plus: 50.00, touch_selo: 10.00 };
    const planNames = { touch_plus: 'Touch? Plus', touch_selo: 'Selo de Verificacao' };
    const subAmount = planAmounts[planId] || 50.00;
    const subName = planNames[planId] || 'Touch? Plus';
    const paymentData = {
      transaction_amount: subAmount,
      token: tokenData.id,
      payment_method_id: user.savedCard.paymentMethodId || 'visa',
      installments: 1,
      payer: { email: payerEmail, identification: { type: 'CPF', number: payerCpf } },
      description: subName + ' — Assinatura mensal',
      statement_descriptor: planId === 'touch_selo' ? 'TOUCH SELO' : 'TOUCH PLUS',
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
    amount: 50.00,
    currency: 'BRL',
    frequency: 1, // months
    description: 'Assinatura mensal Touch? Plus',
    benefits: ['Assistente de voz AI ilimitado', 'Selo de verificação incluso', 'Prioridade na constelação', 'Badge exclusivo Plus', 'Sem limites de conexões', 'Acesso antecipado a novidades', 'Liberar AI para amigos']
  },
  touch_selo: {
    id: 'touch_selo',
    name: 'Selo de Verificação',
    amount: 10.00,
    currency: 'BRL',
    frequency: 1, // months
    description: 'Selo de verificação Touch?',
    benefits: ['Selo de verificação ✓', 'Perfil destacado', 'Credibilidade nas conexões']
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
app.post('/api/subscription/create', paymentLimiter, async (req, res) => {
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
  // Validate webhook signature
  if (!verifyMPWebhookSignature(req)) {
    console.warn('⚠️ MP Sub Webhook: signature inválida', { ip: req.ip });
    return res.sendStatus(401);
  }
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

// ═══ SUBSCRIPTION PIX — one-time payment that activates 30 days ═══
app.post('/api/subscription/create-pix', paymentLimiter, async (req, res) => {
  const { userId, planId, email, cpf } = req.body;
  if (!userId || !planId) return res.status(400).json({ error: 'Dados incompletos.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Plano nao encontrado.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento nao configurado.' });

  const payerEmail = email || user.email || '';
  if (!payerEmail || payerEmail.includes('@touch.app')) {
    return res.status(400).json({ error: 'Cadastre seu email no perfil antes de assinar.' });
  }
  const payerCPF = (cpf || user.cpf || '').replace(/\D/g, '');
  if (!payerCPF || payerCPF.length < 11) {
    return res.status(400).json({ error: 'CPF obrigatorio para PIX.' });
  }

  const subId = uuidv4();

  try {
    const paymentData = {
      transaction_amount: plan.amount,
      description: plan.description + ' (30 dias)',
      payment_method_id: 'pix',
      payer: { email: payerEmail, identification: { type: 'CPF', number: payerCPF } },
      statement_descriptor: 'TOUCH ASSINATURA',
      metadata: { user_id: userId, plan_id: plan.id, sub_id: subId, type: 'subscription_pix' },
      notification_url: (process.env.APP_URL || 'https://touch-irl.com') + '/mp/webhook'
    };

    const result = await mpPayment.create({ body: paymentData });

    console.log('[sub-pix] Payment created:', { id: result.id, status: result.status, plan: plan.id });

    const pixData = result.point_of_interaction?.transaction_data;

    // Save subscription as pending (will be activated by webhook when PIX is paid)
    db.subscriptions[userId] = {
      id: subId, userId, planId: plan.id,
      mpPaymentId: result.id, status: 'pending',
      startedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000,
      amount: plan.amount, gateway: 'mercadopago', method: 'pix',
      createdAt: Date.now()
    };
    // Also save as a tip/payment record for tracking
    if (!db.tips) db.tips = {};
    const tipSubPix = {
      id: subId, payerId: userId, receiverId: 'platform',
      amount: plan.amount, mpPaymentId: result.id,
      status: result.status, method: 'pix', type: 'subscription',
      planId: plan.id, createdAt: Date.now()
    };
    db.tips[subId] = tipSubPix;
    if (!IDX.tipsByPayer.has(tipSubPix.payerId)) IDX.tipsByPayer.set(tipSubPix.payerId, []);
    IDX.tipsByPayer.get(tipSubPix.payerId).push(tipSubPix.id);
    if (!IDX.tipsByReceiver.has(tipSubPix.receiverId)) IDX.tipsByReceiver.set(tipSubPix.receiverId, []);
    IDX.tipsByReceiver.get(tipSubPix.receiverId).push(tipSubPix.id);
    saveDB('users', 'tips');

    res.json({
      subId, status: result.status,
      qrCode: pixData?.qr_code || '',
      qrCodeBase64: pixData?.qr_code_base64 || '',
      ticketUrl: pixData?.ticket_url || '',
      expiresIn: 30
    });
  } catch (e) {
    console.error('[sub-pix] error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro ao gerar PIX: ' + (e.message || 'tente novamente') });
  }
});

// ═══ VOICE AGENT — OpenAI Realtime (WebRTC) + text fallback ═══
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!OPENAI_API_KEY && !GROQ_API_KEY) console.warn('Nenhuma API key de agente configurada! Configure OPENAI_API_KEY (voz tempo real) ou GROQ_API_KEY (texto).');
if (!ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY nao configurada! UltimateDEV usara GPT-4o como fallback.');

// Build user context for the agent (connections, stars, events, etc.)
function buildUserContext(userId) {
  const user = db.users[userId];
  if (!user) return { userName: 'amigo', context: 'Usuário não encontrado.' };

  const fullName = user.name || user.nickname || 'amigo';
  const userName = fullName.split(' ')[0]; // Só o primeiro nome
  const encounters = db.encounters[userId] || [];
  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;

  // Unique connections (people, not events)
  const connectionMap = {};
  encounters.filter(e => !e.isEvent && !(e.with||'').startsWith('evt:')).forEach(e => {
    if (!connectionMap[e.with]) connectionMap[e.with] = { name: e.withName, count: 0, lastDate: '', lastPhrase: '' };
    connectionMap[e.with].count++;
    if (e.timestamp > (connectionMap[e.with].ts || 0)) {
      connectionMap[e.with].lastDate = e.date;
      connectionMap[e.with].lastPhrase = e.phrase;
      connectionMap[e.with].ts = e.timestamp;
    }
  });

  // Build notes index by person name (lowercase) for quick lookup
  const notesMap = {};
  (user.agentNotes || []).forEach(n => {
    if (n.about) {
      const key = n.about.toLowerCase().trim();
      if (!notesMap[key]) notesMap[key] = [];
      notesMap[key].push(n.note);
    }
  });

  const connectionsWithoutNotes = [];
  const connections = Object.entries(connectionMap)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([id, c]) => {
      const u2 = db.users[id];
      const stars = (u2?.stars || []).length;
      const isRevealed = user.canSee?.[id]?.name ? true : false;
      const realName = isRevealed ? (u2?.name || c.name) : null;
      const displayName = c.name;
      const nameKey = displayName.toLowerCase().trim();
      const realKey = realName ? realName.toLowerCase().trim() : '';
      const hasNotes = notesMap[nameKey] || notesMap[realKey];
      const notesSummary = hasNotes ? (notesMap[nameKey] || notesMap[realKey]).slice(-2).join('; ') : '';
      if (!hasNotes && c.count >= 1) connectionsWithoutNotes.push(displayName);
      return `- ${displayName}${realName && realName !== displayName ? ' ('+realName+')' : ''}: ${c.count} encontro(s), último ${c.lastDate}${stars ? ', '+stars+' estrela(s)' : ''}${isRevealed ? ' [revelado]' : ' [anônimo]'}${notesSummary ? ' | notas: '+notesSummary : ' | SEM NOTAS — pergunte quem é!'}`;
    });

  // Stars
  const userStars = (user.stars || []).length;
  const recentStars = (user.stars || []).filter(s => now - s.timestamp < 7 * 24 * h24);
  const starsFromWho = recentStars.map(s => {
    const from = db.users[s.from];
    return from?.nickname || from?.name || 'alguém';
  });

  // Likes
  const likesCount = user.likesCount || 0;
  const recentLikers = (user.likedBy || []).slice(-5).map(id => {
    const u2 = db.users[id];
    return u2?.nickname || u2?.name || 'alguém';
  });

  // Active events
  const activeEvents = Object.values(db.operatorEvents || {}).filter(e => e.active);
  const userEvents = encounters.filter(e => e.isEvent).map(e => e.withName).filter((v,i,a) => a.indexOf(v) === i).slice(0, 5);

  // Points & rank
  const topTag = user.topTag;
  const points = user.points || 0;

  // Recent encounters (last 48h)
  const recent48h = encounters.filter(e => now - e.timestamp < 2 * h24 && !e.isEvent)
    .sort((a,b) => b.timestamp - a.timestamp)
    .slice(0, 5)
    .map(e => `${e.withName} (${formatTsForUser(e.timestamp, userId)})`);

  // Build greeting — JÁ ENTRA NO ASSUNTO, sem "e aí", sem pausa
  // Estilo: "Ramon, [fofoca/novidade]! [pergunta curta]"
  let greeting = '';
  if (recent48h.length > 0) {
    const lastPerson = recent48h[0].split(' (')[0];
    greeting = `${userName}, vi que você encontrou ${lastPerson}! Quem é essa pessoa, me conta?`;
  } else if (recentStars.length > 0) {
    greeting = `${userName}, ${starsFromWho[0]} te deu uma estrela! Tá popular hein, quem é ${starsFromWho[0]} pra você?`;
  } else if (recentLikers.length > 0) {
    greeting = `${userName}, ${recentLikers[0]} te curtiu! Quem é essa pessoa?`;
  } else if (connectionsWithoutNotes.length > 0) {
    const askAbout = connectionsWithoutNotes[Math.floor(Math.random() * connectionsWithoutNotes.length)];
    greeting = `${userName}, tava olhando sua rede e vi ${askAbout} lá — nunca me contou quem é!`;
  } else if (connections.length > 0) {
    const randomConn = connections[Math.floor(Math.random() * Math.min(connections.length, 5))];
    const connName = randomConn.split(':')[0].replace('- ', '').split(' (')[0].trim();
    greeting = `${userName}, tava pensando em ${connName} — tem novidade pra me contar?`;
  } else {
    greeting = `${userName}, sua rede tá começando! Encosta o celular em alguém que eu quero saber de todo mundo!`;
  }

  // ── Active relations with chat messages ──
  const activeRelations = Object.values(db.relations).filter(r => {
    return r && (r.userA === userId || r.userB === userId) && r.expiresAt > now;
  });
  const chatSummaries = [];
  activeRelations.forEach(r => {
    const partnerId = r.userA === userId ? r.userB : r.userA;
    const partner = db.users[partnerId];
    const partnerName = partner ? (partner.nickname || partner.name) : '?';
    const msgs = (db.messages[r.id] || []).slice(-10);
    const timeLeft = Math.round((r.expiresAt - now) / 3600000);
    let summary = `- Chat com ${partnerName}: ${timeLeft}h restantes`;
    if (msgs.length) {
      const lastMsgs = msgs.slice(-5).map(m => {
        const who = m.userId === userId ? 'Voce' : partnerName;
        const txt = (m.text || '').slice(0, 80);
        if (txt.startsWith('[game-invite:')) {
          const parts = txt.replace('[game-invite:', '').replace(']', '').split(':');
          return `${who}: [convite jogo: ${parts[2] || 'jogo'}]`;
        }
        return `${who}: ${txt}`;
      });
      summary += '\n  ' + lastMsgs.join('\n  ');
    } else {
      summary += ' (nenhuma mensagem ainda)';
    }
    chatSummaries.push(summary);
  });

  // ── Game sessions (recent/active) ──
  const gameSummaries = [];
  Object.values(db.gameSessions || {}).forEach(gs => {
    if (!gs || !gs.players || !gs.players.includes(userId)) return;
    if (gs.status === 'cancelled' || gs.status === 'declined') return;
    const ageMs = now - (gs.createdAt || 0);
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return; // Only last 7 days
    const opponentId = gs.players.find(p => p !== userId);
    const opponent = opponentId ? db.users[opponentId] : null;
    const opName = opponent ? (opponent.nickname || opponent.name) : '?';
    if (gs.status === 'waiting') {
      const isHost = gs.hostUserId === userId;
      gameSummaries.push(`- ${gs.gameName || 'Jogo'}: ${isHost ? 'voce convidou ' + opName : opName + ' te convidou'} (aguardando)`);
    } else if (gs.status === 'playing') {
      gameSummaries.push(`- ${gs.gameName || 'Jogo'}: jogando com ${opName} (em andamento)`);
    } else if (gs.status === 'finished') {
      const won = gs.winner === userId;
      gameSummaries.push(`- ${gs.gameName || 'Jogo'}: ${won ? 'voce ganhou de' : 'voce perdeu pra'} ${opName}`);
    }
  });

  // ── Pending stars (need to be donated) ──
  const pendingStars = (user.pendingStars || []).map(ps => `- ${ps.reason} (ganhou ${formatTsForUser(ps.earnedAt, userId)})`);

  // ── Reveal requests pending ──
  const pendingReveals = [];
  Object.values(db.revealRequests || {}).forEach(rr => {
    if (rr.toUserId === userId && rr.status === 'pending') {
      const from = db.users[rr.fromUserId];
      pendingReveals.push(from ? (from.nickname || from.name) : '?');
    }
  });

  // ── Tips received (last 7 days) ──
  const recentTips = [];
  Object.values(db.tips || {}).forEach(t => {
    if (!t || t.receiverId !== userId) return;
    if (now - (t.createdAt || 0) > 7 * 24 * 60 * 60 * 1000) return;
    const payer = db.users[t.payerId];
    const payerName = payer ? (payer.nickname || payer.name) : '?';
    recentTips.push(`- ${payerName}: R$${(t.amount / 100).toFixed(2)} (${t.status === 'approved' ? 'aprovado' : 'pendente'})`);
  });

  // ── Unread messages per chat ──
  const unreadChats = [];
  activeRelations.forEach(r => {
    const partnerId = r.userA === userId ? r.userB : r.userA;
    const partner = db.users[partnerId];
    const partnerName = partner ? (partner.nickname || partner.name) : '?';
    const msgs = (db.messages[r.id] || []);
    // Count messages from partner that are newer than user's last message
    const myLastMsg = [...msgs].reverse().find(m => m.userId === userId);
    const myLastTs = myLastMsg ? (myLastMsg.timestamp || 0) : 0;
    const unread = msgs.filter(m => m.userId !== userId && (m.timestamp || 0) > myLastTs).length;
    if (unread > 0) unreadChats.push(`${partnerName}: ${unread} msg nao lida(s)`);
  });

  // ── Pending game invites (waiting for user action) ──
  const pendingGameInvites = [];
  Object.values(db.gameSessions || {}).forEach(gs => {
    if (!gs || !gs.players || !gs.players.includes(userId)) return;
    if (gs.status !== 'waiting') return;
    if (gs.hostUserId === userId) return; // user sent the invite, not received
    const opponentId = gs.players.find(p => p !== userId);
    const opponent = opponentId ? db.users[opponentId] : null;
    const opName = opponent ? (opponent.nickname || opponent.name) : '?';
    pendingGameInvites.push(`${opName} te convidou pra ${gs.gameName || 'jogo'}`);
  });

  // ── Declarations received ──
  const declarations = [];
  (db.declarations?.[userId] || []).slice(-5).forEach(d => {
    const from = db.users[d.fromUserId];
    const fromName = from ? (from.nickname || from.name) : '?';
    declarations.push(`${fromName}: "${(d.text || '').slice(0, 80)}"`);
  });

  // ── Chats expiring soon (less than 6h) ──
  const expiringChats = [];
  activeRelations.forEach(r => {
    const hoursLeft = Math.round((r.expiresAt - now) / 3600000);
    if (hoursLeft <= 6 && hoursLeft > 0) {
      const partnerId = r.userA === userId ? r.userB : r.userA;
      const partner = db.users[partnerId];
      const partnerName = partner ? (partner.nickname || partner.name) : '?';
      expiringChats.push(`${partnerName}: expira em ${hoursLeft}h`);
    }
  });

  // ── Who knows my real name (reverse reveal) ──
  const whoKnowsMe = [];
  Object.entries(db.users).forEach(([uid, u]) => {
    if (uid === userId || !u.canSee) return;
    if (u.canSee[userId] && u.canSee[userId].name) {
      whoKnowsMe.push(u.nickname || u.name || '?');
    }
  });

  // ── Current event status ──
  let currentEventInfo = '';
  const activeEventId = null; // This comes from client, but check server-side checkins
  Object.values(db.operatorEvents || {}).forEach(ev => {
    if (!ev.active) return;
    const isParticipant = (ev.participants || []).some(p => p.userId === userId);
    const isStaff = (ev.staff || []).some(s => s.userId === userId);
    if (isParticipant) currentEventInfo = `VOCE ESTA NO EVENTO: ${ev.name} (participante)`;
    if (isStaff) currentEventInfo = `VOCE ESTA NO EVENTO: ${ev.name} (staff - ${(ev.staff.find(s => s.userId === userId) || {}).role || 'equipe'})`;
  });

  // ── Contact frequency analysis ──
  const seenOften = []; // last 7 days, 2+ encounters
  const seenRarely = []; // last encounter > 14 days ago
  const newConnections = []; // first encounter in last 3 days
  Object.entries(connectionMap).forEach(([id, c]) => {
    const daysSinceLast = c.ts ? Math.round((now - c.ts) / (24 * h24)) : 999;
    if (c.count >= 2 && daysSinceLast <= 7) seenOften.push(c.name);
    if (daysSinceLast > 14 && c.count >= 1) seenRarely.push(c.name);
    if (c.count === 1 && daysSinceLast <= 3) newConnections.push(c.name);
  });

  // ── Subscription info ──
  const sub = db.subscriptions ? db.subscriptions[userId] : null;
  let subInfo = '';
  if (sub && (sub.status === 'authorized' || sub.status === 'active')) {
    subInfo = `- Assinatura: Touch? Plus ATIVA${sub.expiresAt ? ' (expira ' + formatTsForUser(sub.expiresAt, userId) + ')' : ''}`;
  } else if (user.isSubscriber) {
    subInfo = '- Assinatura: Touch? Plus ATIVA';
  }

  // ── Identity: who can the user see? ──
  const revealedPeople = [];
  Object.entries(user.canSee || {}).forEach(([pid, data]) => {
    if (data && data.name) {
      const p = db.users[pid];
      const nick = p ? (p.nickname || '?') : '?';
      if (nick !== data.name) revealedPeople.push(`${nick} = ${data.name}`);
    }
  });

  const context = `
DADOS DO USUARIO ${userName}:
- Nome: ${userName}, Apelido: ${user.nickname}
- Pontos: ${points}, Estrelas: ${userStars}, Tag: ${topTag || 'nenhuma'}
- Curtidas recebidas: ${likesCount}${recentLikers.length ? ' (recentes: ' + recentLikers.join(', ') + ')' : ''}
- Total de conexoes unicas: ${Object.keys(connectionMap).length}
${subInfo ? subInfo : '- Assinatura: nenhuma'}
${recent48h.length ? '- Encontros recentes (48h): ' + recent48h.join(', ') : '- Sem encontros nas ultimas 48h'}
${userEvents.length ? '- Eventos participados: ' + userEvents.join(', ') : ''}
${currentEventInfo ? '- ' + currentEventInfo : ''}

${unreadChats.length ? '*** MENSAGENS NAO LIDAS (URGENTE!) ***\n' + unreadChats.map(u => '- ' + u).join('\n') + '\n' : ''}${pendingGameInvites.length ? '*** CONVITES DE JOGO ESPERANDO SUA RESPOSTA ***\n' + pendingGameInvites.map(g => '- ' + g).join('\n') + '\n' : ''}${expiringChats.length ? '*** CHATS EXPIRANDO EM BREVE ***\n' + expiringChats.map(c => '- ' + c).join('\n') + '\n' : ''}
CONEXOES (top 15):
${connections.length ? connections.join('\n') : '- Nenhuma conexao ainda'}

${newConnections.length ? 'CONEXOES NOVAS (ultimos 3 dias): ' + newConnections.join(', ') : ''}
${seenOften.length ? 'PESSOAS QUE VE COM FREQUENCIA: ' + seenOften.join(', ') : ''}
${seenRarely.length ? 'PESSOAS QUE NAO VE HA TEMPO (>14 dias): ' + seenRarely.slice(0, 5).join(', ') : ''}

${recentStars.length ? 'ESTRELAS RECENTES (7 dias): ' + starsFromWho.join(', ') + ' deram estrela' : ''}
${activeEvents.length ? 'EVENTOS ATIVOS AGORA: ' + activeEvents.map(e => e.name).join(', ') : ''}
${chatSummaries.length ? '\nCHATS ATIVOS (com ultimas mensagens):\n' + chatSummaries.join('\n') : ''}
${gameSummaries.length ? '\nJOGOS RECENTES:\n' + gameSummaries.join('\n') : ''}
${pendingStars.length ? '\nESTRELAS PENDENTES (precisa doar pra alguem!):\n' + pendingStars.join('\n') : ''}
${pendingReveals.length ? '\nPEDIDOS DE REVELACAO PENDENTES (essas pessoas querem saber quem voce e!):\n- ' + pendingReveals.join(', ') : ''}
${declarations.length ? '\nDECLARAÇOES RECEBIDAS (o que as pessoas disseram sobre voce):\n' + declarations.map(d => '- ' + d).join('\n') : ''}
${recentTips.length ? '\nGORJETAS RECEBIDAS (7 dias):\n' + recentTips.join('\n') : ''}
${revealedPeople.length ? '\nIDENTIDADES REVELADAS (voce sabe o nome real de):\n- ' + revealedPeople.join(', ') : ''}
${whoKnowsMe.length ? '\nQUEM SABE SEU NOME REAL: ' + whoKnowsMe.join(', ') : ''}
${(user.agentNotes && user.agentNotes.length) ? '\nNOTAS PESSOAIS (coisas que voce ja aprendeu sobre as pessoas):\n' + user.agentNotes.slice(-20).map(n => '- ' + (n.about ? n.about + ': ' : '') + n.note).join('\n') : ''}
${connectionsWithoutNotes.length ? '\nCONEXOES SEM NOTAS (pergunte sobre essas pessoas quando tiver oportunidade!):\n' + connectionsWithoutNotes.slice(0, 8).join(', ') : ''}
`.trim();

  // Build gossip — prioridade: urgencias primeiro, depois fofoca
  let gossip = '';
  if (unreadChats.length > 0) {
    const firstUnread = unreadChats[0].split(':')[0];
    gossip = `${userName}, ${firstUnread} te mandou mensagem! Quer que eu resuma o que rolou no chat?`;
  } else if (pendingGameInvites.length > 0) {
    gossip = `${userName}, ${pendingGameInvites[0]}! Vai aceitar ou vai correr?`;
  } else if (expiringChats.length > 0) {
    const expName = expiringChats[0].split(':')[0];
    gossip = `${userName}, seu chat com ${expName} ta quase expirando! Manda uma mensagem antes que acabe!`;
  } else if (recentStars.length > 0) {
    gossip = `${userName}, ${starsFromWho[0]} te deu uma estrela! Ta de olho em voce hein... quem e ${starsFromWho[0]} pra voce?`;
  } else if (recent48h.length > 0) {
    const lastPerson = recent48h[0].split(' (')[0];
    gossip = `${userName}, vi que voce encontrou ${lastPerson} faz pouco! Rolou alguma coisa?`;
  } else if (recentLikers.length > 0) {
    gossip = `${userName}, ${recentLikers[0]} te curtiu! Quem e essa pessoa hein?`;
  } else if (declarations.length > 0) {
    const declFrom = declarations[0].split(':')[0];
    gossip = `${userName}, ${declFrom} fez uma declaracao sobre voce! Quer saber o que disseram?`;
  } else if (connectionsWithoutNotes.length > 0) {
    const askAbout = connectionsWithoutNotes[Math.floor(Math.random() * connectionsWithoutNotes.length)];
    gossip = `${userName}, faz tempo que a gente nao conversa! Me conta, quem e ${askAbout}?`;
  } else if (connections.length > 0) {
    const randomConn = connections[Math.floor(Math.random() * Math.min(connections.length, 5))];
    const connName = randomConn.split(':')[0].replace('- ', '').split(' (')[0].trim();
    gossip = `${userName}, tava pensando em ${connName}... tem novidade?`;
  }

  return { userName, context, greeting, gossip };
}

// Ephemeral token — browser connects to OpenAI Realtime via WebRTC
// ── Timezone Helper ──
// Returns a Date object adjusted to the user's timezone (or server local if unknown)
function getUserLocalNow(userId) {
  const user = db.users[userId];
  const tz = (user && user.timezone) ? user.timezone : 'America/Sao_Paulo';
  try {
    // Use Intl.DateTimeFormat to get reliable timezone offset
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
  } catch (e) {
    return new Date();
  }
}

// Returns formatted time string in user's timezone (HH:mm)
function getUserLocalTime(userId) {
  const user = db.users[userId];
  const tz = (user && user.timezone) ? user.timezone : 'America/Sao_Paulo';
  try {
    return new Date().toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}

// Returns formatted date+time in user's timezone
function getUserLocalDateTime(userId) {
  const user = db.users[userId];
  const tz = (user && user.timezone) ? user.timezone : 'America/Sao_Paulo';
  try {
    return new Date().toLocaleString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

// Formats a timestamp to user's local time
function formatTsForUser(ts, userId) {
  const user = db.users[userId];
  const tz = (user && user.timezone) ? user.timezone : 'America/Sao_Paulo';
  try {
    return new Date(ts).toLocaleString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}

// Returns "today" start timestamp in user's timezone
function getUserTodayStart(userId) {
  const localNow = getUserLocalNow(userId);
  localNow.setHours(0, 0, 0, 0);
  return localNow.getTime();
}

// Returns "this week" start (Sunday) in user's timezone
function getUserWeekStart(userId) {
  const localNow = getUserLocalNow(userId);
  localNow.setDate(localNow.getDate() - localNow.getDay());
  localNow.setHours(0, 0, 0, 0);
  return localNow.getTime();
}

// Returns "this month" start in user's timezone
function getUserMonthStart(userId) {
  const localNow = getUserLocalNow(userId);
  localNow.setDate(1);
  localNow.setHours(0, 0, 0, 0);
  return localNow.getTime();
}

// Returns greeting period based on user's local time
function getUserGreetingPeriod(userId) {
  const localNow = getUserLocalNow(userId);
  const h = localNow.getHours();
  if (h >= 5 && h < 12) return 'manha';
  if (h >= 12 && h < 18) return 'tarde';
  if (h >= 18 && h < 22) return 'noite';
  return 'madrugada';
}

// ── VA Cost Tracking Per User ──
const VA_DAILY_LIMIT_CENTS = 50; // $0.50 per day (fallback, agora usa contagem de chamadas)
const VA_SESSION_COST_CENTS = 8; // ~$0.08 per regular session
const VA_PREMIUM_SESSION_COST_CENTS = 15; // ~$0.15 per premium session (more tools)
const VA_ULTIMATE_SESSION_COST_CENTS = 25; // ~$0.25 per UltimateDEV session
const VA_PLUS_DAILY_CALLS = 5; // Limite de 5 chamadas/dia para Plus
const VA_PRO_DAILY_CALLS = 10; // Limite de 10 chamadas/dia para Pro

function getVaUsageToday(userId) {
  const user = db.users[userId];
  if (!user) return { count: 0, cost: 0, premium: 0, ultimate: 0 };
  const localNow = getUserLocalNow(userId);
  const today = localNow.getFullYear() + '-' + String(localNow.getMonth()+1).padStart(2,'0') + '-' + String(localNow.getDate()).padStart(2,'0');
  if (!user.vaUsage || user.vaUsage.date !== today) {
    user.vaUsage = { date: today, sessions: 0, costCents: 0, premiumSessions: 0, ultimateSessions: 0 };
  }
  const plusCalls = user.vaUsage.sessions - (user.vaUsage.premiumSessions || 0) - (user.vaUsage.ultimateSessions || 0);
  return { count: user.vaUsage.sessions, cost: user.vaUsage.costCents, premium: user.vaUsage.premiumSessions || 0, ultimate: user.vaUsage.ultimateSessions || 0, plusCalls: Math.max(0, plusCalls) };
}

function trackVaSession(userId, isPremium) {
  const user = db.users[userId];
  if (!user) return;
  const localNow = getUserLocalNow(userId);
  const today = localNow.getFullYear() + '-' + String(localNow.getMonth()+1).padStart(2,'0') + '-' + String(localNow.getDate()).padStart(2,'0');
  if (!user.vaUsage || user.vaUsage.date !== today) {
    user.vaUsage = { date: today, sessions: 0, costCents: 0, premiumSessions: 0 };
  }
  const cost = isPremium === 'ultimate' ? VA_ULTIMATE_SESSION_COST_CENTS : isPremium ? VA_PREMIUM_SESSION_COST_CENTS : VA_SESSION_COST_CENTS;
  user.vaUsage.sessions++;
  user.vaUsage.costCents += cost;
  if (isPremium === 'ultimate') user.vaUsage.ultimateSessions = (user.vaUsage.ultimateSessions || 0) + 1;
  else if (isPremium) user.vaUsage.premiumSessions = (user.vaUsage.premiumSessions || 0) + 1;
  // ── Detailed cost log per user (keeps last 100 entries) ──
  if (!user.vaCostLog) user.vaCostLog = [];
  user.vaCostLog.push({ ts: Date.now(), type: isPremium === 'ultimate' ? 'ultimate' : isPremium ? 'premium' : 'standard', costCents: cost });
  if (user.vaCostLog.length > 100) user.vaCostLog = user.vaCostLog.slice(-100);
  saveDB('users');
}

// Check if user can use Premium/Pro VA (top 01 only for now)
function canUsePremiumVA(userId) {
  const user = db.users[userId];
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.registrationOrder === 1) return true; // top 01
  return false;
}
const canUseProVA = canUsePremiumVA; // alias — same logic

// Check if user can use UltimateDEV VA (top 01 / admin only)
function canUseUltimateVA(userId) {
  const user = db.users[userId];
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.registrationOrder === 1) return true; // top 01
  return false;
}

// Check if user can use VA (Plus subscriber OR granted by a Top)
function canUseVA(userId, requestedTier) {
  const user = db.users[userId];
  if (!user) return { allowed: false, reason: 'not_found' };
  // Admin always has access, no limits
  if (user.isAdmin) return { allowed: true, reason: 'admin' };
  // Top 01 — unlimited access (no daily limit)
  if (user.registrationOrder === 1) return { allowed: true, reason: 'top1_unlimited' };
  // Plus subscriber with daily call limit
  if (user.isSubscriber) {
    const usage = getVaUsageToday(userId);
    // Check by number of calls (primary limit)
    if (requestedTier === 'pro') {
      if (usage.premium >= VA_PRO_DAILY_CALLS) {
        return { allowed: false, reason: 'daily_limit', usage, limit: VA_PRO_DAILY_CALLS, used: usage.premium, tierLimit: 'pro' };
      }
    } else {
      if (usage.plusCalls >= VA_PLUS_DAILY_CALLS) {
        return { allowed: false, reason: 'daily_limit', usage, limit: VA_PLUS_DAILY_CALLS, used: usage.plusCalls, tierLimit: 'plus' };
      }
    }
    // Fallback: also check cost limit
    if (usage.cost >= VA_DAILY_LIMIT_CENTS) {
      return { allowed: false, reason: 'daily_limit', usage };
    }
    return { allowed: true, reason: 'plus' };
  }
  // Granted access by a Top user
  if (user.vaAccessGrantedBy) {
    const grantor = db.users[user.vaAccessGrantedBy];
    if (grantor && grantor.isSubscriber) {
      const usage = getVaUsageToday(userId);
      if (usage.plusCalls >= VA_PLUS_DAILY_CALLS) {
        return { allowed: false, reason: 'daily_limit', usage, limit: VA_PLUS_DAILY_CALLS, used: usage.plusCalls, tierLimit: 'plus' };
      }
      if (usage.cost >= VA_DAILY_LIMIT_CENTS) {
        return { allowed: false, reason: 'daily_limit', usage };
      }
      return { allowed: true, reason: 'granted', grantedBy: grantor.nickname || grantor.name };
    }
  }
  return { allowed: false, reason: 'not_plus' };
}

app.post('/api/agent/session', vaLimiter, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada.' });
  const { userId, lastInteraction } = req.body;

  // Check VA access
  const access = canUseVA(userId, 'plus');
  if (!access.allowed) {
    const limitMsg = access.tierLimit === 'plus' ? `Voce usou ${access.used}/${access.limit} chamadas hoje. Volte amanha!` : 'Limite diario atingido. Volte amanha!';
    return res.status(403).json({
      error: access.reason === 'daily_limit' ? limitMsg : 'Assine o Touch? Plus para usar o assistente AI.',
      reason: access.reason,
      needsPlus: access.reason === 'not_plus',
      limit: access.limit, used: access.used
    });
  }

  // Track usage
  trackVaSession(userId);

  const { userName, context, greeting, gossip } = buildUserContext(userId);

  // Load conversation history for continuity
  const plusConvos = getVaConversations(userId, 'plus').slice(-40);
  const convHistoryPlus = plusConvos.length
    ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES (OBRIGATORIO: use para retomar de onde parou!) ===\nVoce JA conversou com esse usuario antes. LEMBRE-SE desses assuntos e RETOME naturalmente:\n${plusConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===`
    : '';

  // Decide greeting mode: >1h = gossip opener, <1h = quick continue
  const msSinceLast = lastInteraction ? (Date.now() - lastInteraction) : Infinity;
  const isNewSession = msSinceLast > 60 * 60 * 1000; // 1 hour
  const user = db.users[userId] || {};

  let openingInstruction, openingText;
  if (plusConvos.length && !isNewSession) {
    // Has recent history -- resume from where we left off
    const lastMsg = plusConvos[plusConvos.length - 1];
    openingText = `${userName}, voltei! A gente tava falando sobre... continuamos?`;
    openingInstruction = `RETOMADA DE CONVERSA (a conexao caiu ou usuario saiu e voltou -- retome de onde parou!):\nVoce ja estava conversando com o usuario. A ultima coisa dita foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastMsg.content}"\nRetome NATURALMENTE de onde parou, como se nada tivesse acontecido. Nao diga "oi" nem "ola". Provoque com algo da conversa anterior.`;
  } else if (plusConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = plusConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${userName}, e ai! Da ultima vez a gente tava conversando... lembra?`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h, mas voce ja conversou com esse usuario antes):\nMencione BREVEMENTE o que conversaram da ultima vez e pergunte se quer continuar ou falar de outra coisa.\nUltimos assuntos: ${lastTopics.join(' | ')}`;
  } else if (isNewSession && gossip) {
    openingText = gossip;
    openingInstruction = `SAUDACAO DE FOFOCA (faz mais de 1h que nao fala com o usuario -- comece com uma fofoca quente!):\n"${gossip}"`;
  } else if (isNewSession) {
    openingText = greeting;
    openingInstruction = `SAUDACAO INICIAL (fale quando a conversa comecar):\n"${greeting}"`;
  } else {
    openingText = `${userName}, voltou! Manda ai.`;
    openingInstruction = `CONTINUACAO (menos de 1h desde a ultima conversa -- ULTRA breve, 1 frase so):\n"${openingText}"`;
  }

  // Load tier config from vaConfig (admin panel)
  const tierCfg = getTierConfig('plus');

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: tierCfg.voice || 'coral',
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: tierCfg.vadThreshold || 0.95, prefix_padding_ms: tierCfg.prefixPadding || 500, silence_duration_ms: tierCfg.silenceDuration || 1500 },
        instructions: `Voce e "Touch", assistente de voz do app Touch? — rede social presencial.

IDIOMA:
- Portugues brasileiro por padrao, mas responda no idioma que o usuario falar

HORARIO LOCAL DO USUARIO: ${getUserLocalTime(userId)} (${getUserGreetingPeriod(userId)})
TIMEZONE: ${(user.timezone || 'America/Sao_Paulo')}
- Use esse horario como referencia para saudacoes (bom dia/boa tarde/boa noite)
- Se o usuario mencionar um horario diferente do seu, pergunte em qual fuso horario ele esta e ajuste
- Quando falar de horarios de encontros ou eventos, use o horario LOCAL do usuario

PERSONALIDADE:
${tierCfg.personality}

COMO ABRIR A CONVERSA:
${tierCfg.openingRules}

REGRA CRITICA DE DADOS EM TEMPO REAL:
Os dados abaixo sao uma FOTO do momento em que a ligacao comecou e ficam DESATUALIZADOS rapidamente.
VOCE DEVE chamar a ferramenta consultar_rede:
1. ANTES de responder QUALQUER pergunta sobre conexoes, estrelas, encontros, curtidas, mensagens, jogos, revelacoes
2. Quando o usuario perguntar "o que tem de novo?", "alguma novidade?", "o que aconteceu?"
3. Se o usuario mencionar que acabou de fazer algo (conectou, mandou msg, deu estrela)
4. PELO MENOS 1 vez a cada 2 minutos de conversa, mesmo se nao pedirem
NAO confie nos dados abaixo para responder — eles sao apenas contexto inicial.
A ferramenta consultar_rede retorna o estado REAL e ATUALIZADO do banco agora.

PRIVACIDADE:
${tierCfg.privacyRules}

${context}

NOME DO USUARIO: ${(user.name || user.nickname || '').split(' ')[0] || user.nickname || ''}
(Use so o primeiro nome, NUNCA nome completo)

MEMORIA:
${tierCfg.memoryRules}

${tierCfg.extraInstructions ? 'INSTRUCOES EXTRAS:\n' + tierCfg.extraInstructions : ''}
${convHistoryPlus}

IMPORTANTE: NAO fale automaticamente ao iniciar. Espere o comando response.create do cliente para comecar.`,
        tools: [{
          type: 'function',
          name: 'mostrar_pessoa',
          description: 'Mostra o perfil de uma conexão na constelação do usuário. Use sempre que mencionar alguém específico da rede.',
          parameters: {
            type: 'object',
            properties: {
              nome: { type: 'string', description: 'Nome ou apelido da pessoa a ser mostrada' }
            },
            required: ['nome']
          }
        },{
          type: 'function',
          name: 'consultar_rede',
          description: 'OBRIGATORIO: Busca dados ATUALIZADOS em tempo real. Voce DEVE chamar esta funcao ANTES de responder QUALQUER pergunta sobre rede, conexoes, estrelas, encontros, curtidas, mensagens, jogos ou revelacoes. Os dados nas instrucoes estao CONGELADOS do inicio da sessao. Esta funcao retorna o estado REAL do banco AGORA. Se nao chamar, voce VAI dar informacao errada ao usuario.',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        },{
          type: 'function',
          name: 'salvar_nota',
          description: 'Salva uma informação pessoal que o usuário contou sobre alguém ou sobre si mesmo. Ex: "essa é minha mãe", "ele é meu melhor amigo", "a gente se conheceu na festa". Use sempre que o usuário compartilhar algo pessoal sobre uma conexão.',
          parameters: {
            type: 'object',
            properties: {
              sobre: { type: 'string', description: 'Sobre quem é a nota (nome/apelido da pessoa, ou "eu" se for sobre o próprio usuário)' },
              nota: { type: 'string', description: 'A informação a ser salva (ex: "é minha mãe", "meu melhor amigo", "nos conhecemos na festa X")' }
            },
            required: ['sobre', 'nota']
          }
        },{
          type: 'function',
          name: 'navegar_tela',
          description: 'Navega para uma tela do app. Use quando o usuário pedir pra ir pra constelação, perfil, tela de conexão, etc. Telas: home, history (constelação), encounter (conectar), locationScreen (mapa), myProfile (meu perfil), subscription (assinatura).',
          parameters: {
            type: 'object',
            properties: {
              tela: { type: 'string', description: 'ID da tela: home, history, encounter, locationScreen, myProfile, subscription' }
            },
            required: ['tela']
          }
        }],
        turn_detection: { type: 'server_vad', threshold: 0.95, prefix_padding_ms: 500, silence_duration_ms: 1500 },
        input_audio_transcription: { model: 'whisper-1' }
      })
    });
    if (!r.ok) { const e = await r.text(); console.error('OpenAI session err:', r.status, e); return res.status(502).json({ error: 'Erro ao criar sessão' }); }
    const d = await r.json();
    res.json({ client_secret: d.client_secret?.value, session_id: d.id, expires_at: d.client_secret?.expires_at, greeting, isNewSession, openingText, tier: 'plus' });
  } catch (e) { console.error('Agent session err:', e.message); res.status(500).json({ error: 'Erro interno' }); }
});

// ══════════════════════════════════════════════════════════════
// ══ ONBOARDING — Tour guiado de 4 steps para novos usuários ══
// ══════════════════════════════════════════════════════════════
//
// MODO: 'live'        → agente AI ao vivo via WebRTC (voz natural, ~$0.08/user)
//       'prerecorded' → áudios TTS pré-gravados (custo zero, qualidade inferior)
//
const ONB_MODE = 'live'; // ← MUDE AQUI para alternar

// Os 4 steps do tour (texto-base para ambos os modos)
const ONB_STEPS = {
  step1: 'Oi! Eu sou a Touch, sua assistente. Fecha essa telinha no X lá em cima que vou te mostrar como funciona!',
  step2: 'Essa é sua home! Vê o botão Touch no meio da tela? Clica nele!',
  step3: 'É simples! Encosta o celular no de outra pessoa e pronto — conexão feita!',
  step4: 'Muito bem! Agora é só apertar o Touch e começar a se conectar com as pessoas ao seu redor. Seja bem-vindo!'
};

// ── GET /api/agent/onboarding-config — retorna modo e steps ──
app.get('/api/agent/onboarding-config', (req, res) => {
  res.json({ mode: ONB_MODE, steps: ONB_STEPS });
});

// ── POST /api/agent/onboarding-session — cria sessão WebRTC para modo LIVE ──
app.post('/api/agent/onboarding-session', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada.' });
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const firstName = (user.name || user.nickname || '').split(' ')[0] || user.nickname || 'amigo';

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: 'shimmer',
        modalities: ['audio', 'text'],
        instructions: `Você é "Touch", assistente de voz do app Touch? — rede social presencial.

CONTEXTO: Este é o PRIMEIRO LOGIN do usuário ${firstName}.
Você vai guiar um TOUR de 4 etapas. O mic do usuário está MUDO — ele só clica, não fala.

IDIOMA: Português brasileiro.
TOM: Amigável, animada, breve. Como uma amiga mostrando algo legal.
FALE PAUSADO — ritmo lento e claro.

ETAPAS (fale EXATAMENTE uma por vez, espere o sinal STEP):

ETAPA 1 — Quando receber o comando inicial:
"Oi ${firstName}! Eu sou a Touch, sua assistente. Fecha essa telinha no X lá em cima que vou te mostrar como funciona!"

ETAPA 2 — Quando receber "STEP:HOME_VISIBLE":
"Essa é sua home! Vê o botão Touch no meio da tela? Clica nele!"

ETAPA 3 — Quando receber "STEP:ENCOUNTER_SCREEN":
"É simples! Encosta o celular no de outra pessoa e pronto — conexão feita!"

ETAPA 4 — Quando receber "STEP:BACK_HOME":
"Muito bem ${firstName}! Agora é só apertar o Touch e começar a se conectar com as pessoas ao seu redor. Seja bem-vindo!"

REGRAS:
- UMA etapa por vez, máximo 2 frases
- ESPERE o sinal STEP antes de avançar
- NÃO mencione QR code, sala, ou código
- NUNCA invente etapas extras. Após etapa 4, pare.`,
        turn_detection: { type: 'server_vad', threshold: 0.95, prefix_padding_ms: 300, silence_duration_ms: 1500 },
        input_audio_transcription: { model: 'whisper-1' }
      })
    });
    if (!r.ok) { const e = await r.text(); console.error('OpenAI onboarding err:', r.status, e); return res.status(502).json({ error: 'Erro ao criar sessão' }); }
    const d = await r.json();
    res.json({ client_secret: d.client_secret?.value, session_id: d.id, expires_at: d.client_secret?.expires_at });
  } catch (e) { console.error('Onboarding session err:', e.message); res.status(500).json({ error: 'Erro interno' }); }
});

// ── Onboarding PRE-RECORDED — áudios TTS HD (fallback, custo zero) ──
const ONB_AUDIO_DIR = path.join(__dirname, 'public', 'audio', 'onb');
const ONB_VERSION = 4; // Bump to force regeneration
async function generateOnbAudio() {
  const fs2 = require('fs');
  if (!fs2.existsSync(ONB_AUDIO_DIR)) fs2.mkdirSync(ONB_AUDIO_DIR, { recursive: true });
  if (!OPENAI_API_KEY) { console.warn('⚠️ No OPENAI_API_KEY, skip onboarding TTS'); return; }
  const versionFile = path.join(ONB_AUDIO_DIR, '.version');
  const currentVer = fs2.existsSync(versionFile) ? parseInt(fs2.readFileSync(versionFile, 'utf8')) : 0;
  if (currentVer < ONB_VERSION) {
    console.log(`🔄 Onboarding TTS v${currentVer} → v${ONB_VERSION}, regenerating...`);
    for (const k of Object.keys(ONB_STEPS)) {
      const fp = path.join(ONB_AUDIO_DIR, k + '.mp3');
      if (fs2.existsSync(fp)) { fs2.unlinkSync(fp); console.log(`🗑️ Deleted: ${k}.mp3`); }
    }
    fs2.writeFileSync(versionFile, String(ONB_VERSION));
  }
  for (const [key, text] of Object.entries(ONB_STEPS)) {
    const fp = path.join(ONB_AUDIO_DIR, key + '.mp3');
    if (fs2.existsSync(fp)) { console.log(`✅ ONB cached: ${key}.mp3`); continue; }
    try {
      console.log(`🎙️ Generating ONB HD: ${key}...`);
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1-hd', voice: 'shimmer', input: text, speed: 1.0 })
      });
      if (!r.ok) { console.error(`TTS ${key} failed:`, r.status); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs2.writeFileSync(fp, buf);
      console.log(`✅ Saved: ${key}.mp3 (${(buf.length/1024).toFixed(1)}KB)`);
    } catch (e) { console.error(`TTS ${key}:`, e.message); }
  }
}
if (ONB_MODE === 'prerecorded') setTimeout(generateOnbAudio, 2000); // só gera se precisa
app.get('/api/agent/onboarding-audio', async (req, res) => {
  const fs2 = require('fs');
  const allExist = Object.keys(ONB_STEPS).every(k => fs2.existsSync(path.join(ONB_AUDIO_DIR, k + '.mp3')));
  if (!allExist) await generateOnbAudio();
  const steps = {};
  for (const k of Object.keys(ONB_STEPS)) {
    steps[k] = { url: '/audio/onb/' + k + '.mp3', text: ONB_STEPS[k], exists: fs2.existsSync(path.join(ONB_AUDIO_DIR, k + '.mp3')) };
  }
  res.json({ mode: ONB_MODE, ready: Object.values(steps).every(s => s.exists), steps });
});

// Mark onboarding as done
app.post('/api/agent/onboarding-done', (req, res) => {
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.onboardingDone = true;
  saveDB('users');
  res.json({ ok: true });
});
// Reset onboarding (para testes)
app.post('/api/agent/onboarding-reset', (req, res) => {
  const { userId } = req.body;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  user.onboardingDone = false;
  saveDB('users');
  res.json({ ok: true, msg: 'Onboarding resetado' });
});

// Real-time context for agent (called via tool during conversation)
app.get('/api/agent/context/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

  // Helper: get best display name (nickname + real name if revealed)
  function getDisplayName(personId) {
    const p = db.users[personId]; if (!p) return '?';
    const nick = p.nickname || p.name || '?';
    // Check if this person revealed identity TO the user
    const revealed = user.canSee?.[personId];
    if (revealed && revealed.name) {
      const realName = p.name || revealed.name;
      if (realName && realName !== nick) return nick + ' (nome real: ' + realName + ')';
    }
    return nick;
  }

  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;
  const h48 = 2 * h24;

  // ── REBUILD FRESH CONTEXT (not cached from session start) ──

  // 1. Current connections with UPDATED info
  const encounters = db.encounters[userId] || [];
  const connectionMap = {};
  encounters.filter(e => !e.isEvent && !(e.with||'').startsWith('evt:')).forEach(e => {
    if (!connectionMap[e.with]) connectionMap[e.with] = { name: e.withName, count: 0, ts: 0 };
    connectionMap[e.with].count++;
    if (e.timestamp > connectionMap[e.with].ts) {
      connectionMap[e.with].ts = e.timestamp;
      connectionMap[e.with].lastDate = e.date;
    }
  });

  const connectionLines = Object.entries(connectionMap)
    .sort((a,b) => b[1].ts - a[1].ts)
    .slice(0, 20)
    .map(([id, c]) => {
      const revealed = user.canSee?.[id];
      const u2 = db.users[id];
      const nick = c.name;
      const realName = (revealed && revealed.name) ? (u2?.name || revealed.name) : null;
      const stars = (u2?.stars || []).length;
      const isRecent = (now - c.ts) < h48;
      return `- ${nick}${realName && realName !== nick ? ' (NOME REAL: '+realName+')' : ''}: ${c.count}x encontros, ultimo ${c.lastDate}${stars ? ', '+stars+' estrelas' : ''}${revealed ? ' [REVELADO]' : ' [anonimo]'}${isRecent ? ' **RECENTE**' : ''}`;
    });

  // 2. FRESH notifications (not from session start)
  const notifs = [];
  const week = 7 * h24;

  // Recent connections (last 24h - most important!)
  encounters.filter(e => now - e.timestamp < h24 && !e.isEvent).forEach(e => {
    notifs.push({ t: 'NOVA CONEXAO HOJE', who: getDisplayName(e.with), ts: e.timestamp, priority: 10 });
  });

  // Unread messages (CRITICAL - check right now)
  const activeRels = Object.values(db.relations).filter(r => r && (r.userA === userId || r.userB === userId) && r.expiresAt > now);
  const unreadDetails = [];
  activeRels.forEach(r => {
    const partnerId = r.userA === userId ? r.userB : r.userA;
    const msgs = (db.messages[r.id] || []);
    const myLastMsg = [...msgs].reverse().find(m => m.userId === userId);
    const myLastTs = myLastMsg ? (myLastMsg.timestamp || 0) : 0;
    const unreadMsgs = msgs.filter(m => m.userId !== userId && (m.timestamp || 0) > myLastTs);
    if (unreadMsgs.length > 0) {
      const lastMsg = unreadMsgs[unreadMsgs.length - 1];
      unreadDetails.push({ who: getDisplayName(partnerId), count: unreadMsgs.length, lastText: (lastMsg.text || '').slice(0, 60), ts: lastMsg.timestamp || 0 });
    }
  });
  if (unreadDetails.length) {
    unreadDetails.forEach(u => {
      notifs.push({ t: 'MSG NAO LIDA de ' + u.who + ' (' + u.count + 'x): "' + u.lastText + '"', who: u.who, ts: u.ts, priority: 9 });
    });
  }

  // Likes received (last 7 days)
  (user.likedBy || []).forEach(lid => {
    const ts = (db.users[lid])?._likedAt?.[userId] || 0;
    if (ts && now - ts < week) notifs.push({ t: 'te curtiu', who: getDisplayName(lid), ts, priority: 5 });
  });

  // Stars received (last 7 days)
  (user.stars || []).forEach(s => {
    const ts = s.donatedAt || s.at || 0;
    if (ts && now - ts < week) notifs.push({ t: 'te deu uma estrela', who: getDisplayName(s.from), ts, priority: 6 });
  });

  // Identity reveals (last 7 days) - SHOW THE REAL NAME!
  Object.entries(user.canSee || {}).forEach(([pid, data]) => {
    const p = db.users[pid]; if (!p) return;
    const ts = data.revealedAt || 0;
    const nick = p.nickname || '?';
    const realName = p.name || data.name || '?';
    if (ts && now - ts < week) {
      notifs.push({ t: 'revelou identidade! Nickname era "' + nick + '", nome real e "' + realName + '"', who: nick + ' -> ' + realName, ts, priority: 8 });
    }
  });

  // Pending reveal requests
  Object.values(db.revealRequests || {}).forEach(rr => {
    if (rr.toUserId === userId && rr.status === 'pending') {
      notifs.push({ t: 'QUER SE REVELAR pra voce! Aceite ou recuse.', who: getDisplayName(rr.fromUserId), ts: rr.createdAt || 0, priority: 7 });
    }
  });

  // Game invites (last 7 days)
  const myRelIds = Object.keys(db.relations).filter(rid => {
    const r = db.relations[rid]; return r && (r.userA === userId || r.userB === userId);
  });
  myRelIds.forEach(rid => {
    (db.messages[rid] || []).forEach(m => {
      if (!m.text || !m.text.startsWith('[game-invite:') || m.userId === userId) return;
      const parts = m.text.replace('[game-invite:', '').replace(']', '').split(':');
      const gameName = parts[2] || 'Jogo';
      const ts = m.timestamp || 0;
      if (ts && now - ts < week) notifs.push({ t: 'te convidou pro jogo "' + gameName + '"', who: getDisplayName(m.userId), ts, priority: 4 });
    });
  });

  // Sort by priority then by timestamp (newest first)
  notifs.sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.ts - a.ts);

  // Build response text
  let freshContext = 'DADOS ATUALIZADOS AGORA (' + getUserLocalTime(userId) + '):\n\n';
  freshContext += 'SUAS CONEXOES (' + Object.keys(connectionMap).length + ' total):\n' + connectionLines.join('\n');

  if (notifs.length) {
    freshContext += '\n\nNOVIDADES (mais recentes primeiro):\n';
    freshContext += notifs.slice(0, 25).map(n => '- ' + n.who + ': ' + n.t + ' (' + formatTsForUser(n.ts, userId) + ')').join('\n');
  } else {
    freshContext += '\n\nNenhuma novidade recente.';
  }

  // Stats summary
  const totalStars = (user.stars || []).length;
  const totalLikes = user.likesCount || 0;
  const totalEncounters = encounters.filter(e => !e.isEvent).length;
  freshContext += '\n\nRESUMO: ' + totalEncounters + ' encontros, ' + totalStars + ' estrelas, ' + totalLikes + ' curtidas';

  res.json({ context: freshContext, ts: now });
});

// Save agent note about a connection
app.post('/api/agent/note', (req, res) => {
  const { userId, aboutName, note } = req.body;
  if (!userId || !note) return res.status(400).json({ error: 'userId e note obrigatórios' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!user.agentNotes) user.agentNotes = [];
  if (user.agentNotes.length >= 50) user.agentNotes.shift();
  user.agentNotes.push({ about: aboutName || '', note, ts: Date.now() });
  saveDB('users');
  res.json({ ok: true, total: user.agentNotes.length });
});

// Grant/revoke VA access to another user (Plus subscribers can share access)
app.post('/api/agent/grant-access', (req, res) => {
  const { grantorId, targetId, grant } = req.body;
  if (!grantorId || !targetId) return res.status(400).json({ error: 'grantorId e targetId obrigatórios' });
  const grantor = db.users[grantorId];
  if (!grantor) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!grantor.isSubscriber && !grantor.isAdmin) return res.status(403).json({ error: 'Apenas assinantes Plus podem liberar acesso.' });
  const target = db.users[targetId];
  if (!target) return res.status(404).json({ error: 'Usuário alvo não encontrado' });
  if (grant === false) {
    delete target.vaAccessGrantedBy;
  } else {
    target.vaAccessGrantedBy = grantorId;
  }
  saveDB('users');
  res.json({ ok: true, granted: grant !== false, targetNickname: target.nickname || target.name });
});

// Get VA access status for a user
app.get('/api/agent/access/:userId', (req, res) => {
  const access = canUseVA(req.params.userId);
  const user = db.users[req.params.userId];
  const usage = user ? getVaUsageToday(req.params.userId) : { count: 0, cost: 0 };
  const premium = canUsePremiumVA(req.params.userId);
  const ultimate = canUseUltimateVA(req.params.userId);
  // tier: highest available tier for this user
  const tier = ultimate ? 'ultimatedev' : premium ? 'pro' : 'plus';
  res.json({ ...access, usage, dailyLimit: VA_DAILY_LIMIT_CENTS, plusDailyLimit: VA_PLUS_DAILY_CALLS, proDailyLimit: VA_PRO_DAILY_CALLS, premium, ultimate, tier });
});

// ── Cost dashboard — see all users' VA costs ──
app.get('/api/agent/costs', (req, res) => {
  const costs = [];
  Object.values(db.users).forEach(u => {
    if (u.vaUsage || u.vaCostLog) {
      const today = getVaUsageToday(u.id);
      const totalCents = (u.vaCostLog || []).reduce((s, e) => s + (e.costCents || 0), 0);
      costs.push({
        userId: u.id,
        nickname: u.nickname || u.name,
        today: today,
        totalCents,
        totalUSD: (totalCents / 100).toFixed(2),
        sessions: (u.vaCostLog || []).length,
        lastSession: u.vaCostLog?.length ? u.vaCostLog[u.vaCostLog.length - 1].ts : null
      });
    }
  });
  costs.sort((a, b) => b.totalCents - a.totalCents);
  const grandTotal = costs.reduce((s, c) => s + c.totalCents, 0);
  res.json({ costs, grandTotalCents: grandTotal, grandTotalUSD: (grandTotal / 100).toFixed(2) });
});

// ══ PREMIUM VA SESSION — full navigation agent (top 01 only) ══
app.post('/api/agent/premium-session', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada.' });
  const { userId, lastInteraction } = req.body;

  if (!canUsePremiumVA(userId)) {
    return res.status(403).json({ error: 'Premium VA apenas para testers autorizados.', reason: 'not_premium' });
  }

  const access = canUseVA(userId, 'pro');
  if (!access.allowed) {
    const msg = access.tierLimit === 'pro' ? `Limite de ${VA_PRO_DAILY_CALLS} chamadas Pro/dia atingido. Volte amanha!` : 'Limite atingido.';
    return res.status(403).json({ error: msg, reason: access.reason, limit: access.limit, used: access.used });
  }

  trackVaSession(userId, true); // premium cost

  const { userName, context, greeting, gossip } = buildUserContext(userId);

  // Load conversation history for continuity
  const proConvos = getVaConversations(userId, 'pro').slice(-40);
  const convHistoryPro = proConvos.length
    ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES (OBRIGATORIO: use para retomar de onde parou!) ===\nVoce JA conversou com esse usuario antes. LEMBRE-SE desses assuntos e RETOME naturalmente:\n${proConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===`
    : '';

  const msSinceLast = lastInteraction ? (Date.now() - lastInteraction) : Infinity;
  const isNewSession = msSinceLast > 60 * 60 * 1000;
  const user = db.users[userId] || {};
  const firstName = (user.name || user.nickname || '').split(' ')[0] || user.nickname || '';

  let openingText, openingInstruction;
  if (proConvos.length && !isNewSession) {
    // Has recent history -- resume from where we left off
    const lastMsg = proConvos[proConvos.length - 1];
    openingText = `${firstName}, voltei! Continuamos de onde paramos.`;
    openingInstruction = `RETOMADA DE CONVERSA (a conexao caiu ou usuario saiu e voltou -- retome de onde parou!):\nVoce ja estava conversando com ${firstName}. A ultima coisa dita foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastMsg.content}"\nRetome NATURALMENTE de onde parou. Nao diga "oi" nem "ola". Provoque com algo da conversa anterior.`;
  } else if (proConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = proConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${firstName}, e ai! Da ultima vez a gente tava conversando... lembra?`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h, mas voce ja conversou com esse usuario antes):\nMencione BREVEMENTE o que conversaram da ultima vez e pergunte se quer continuar ou falar de outra coisa.\nUltimos assuntos: ${lastTopics.join(' | ')}`;
  } else if (isNewSession && gossip) {
    openingText = gossip;
    openingInstruction = `SAUDACAO DE FOFOCA:\n"${gossip}"`;
  } else if (isNewSession) {
    openingText = greeting;
    openingInstruction = `SAUDACAO INICIAL:\n"${greeting}"`;
  } else {
    openingText = `${firstName}, voltou! Manda ai.`;
    openingInstruction = `CONTINUACAO (menos de 1h desde a ultima conversa -- ULTRA breve):\n"${openingText}"`;
  }

  // Load tier config from vaConfig (admin panel)
  const proCfg = getTierConfig('pro');

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: proCfg.voice || 'coral',
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: proCfg.vadThreshold || 0.95, prefix_padding_ms: proCfg.prefixPadding || 500, silence_duration_ms: proCfg.silenceDuration || 1500 },
        instructions: `Voce e "Touch", assistente PREMIUM do app Touch? — rede social presencial.
CONTEXTO: Modo premium ativado para ${firstName}. Voce tem controle TOTAL do app.
IDIOMA: Portugues brasileiro por padrao, responda no idioma do usuario.

HORARIO LOCAL DO USUARIO: ${getUserLocalTime(userId)} (${getUserGreetingPeriod(userId)})
TIMEZONE: ${(user.timezone || 'America/Sao_Paulo')}
- Use esse horario como referencia para saudacoes e contexto temporal
- Se o usuario parecer em outro fuso, pergunte e se ajuste

PERSONALIDADE:
${proCfg.personality}

COMO ABRIR A CONVERSA:
${openingInstruction}
${proCfg.openingRules}

REGRA CRITICA DE DADOS:
Os dados abaixo estao CONGELADOS do inicio da ligacao. Voce DEVE chamar consultar_rede:
1. ANTES de QUALQUER resposta sobre conexoes, estrelas, encontros, curtidas, mensagens
2. Quando perguntarem "novidades?" ou "o que tem de novo?"
3. Se o usuario disser que acabou de fazer algo
4. Pelo menos 1 vez a cada 2 minutos de conversa

PODERES — VOCE PODE FAZER TUDO:
Voce tem ferramentas para navegar o app pelo usuario. Use-as!
- navegar_tela, abrir_perfil, abrir_chat, iniciar_conexao, dar_estrela, enviar_pulse, consultar_rede, mostrar_pessoa, salvar_nota

PRIVACIDADE:
${proCfg.privacyRules}

${context}

NOME DO USUARIO: ${firstName}

MEMORIA:
${proCfg.memoryRules}

${proCfg.extraInstructions ? 'INSTRUCOES EXTRAS:\n' + proCfg.extraInstructions : ''}

${convHistoryPro}

IMPORTANTE: NAO fale automaticamente ao iniciar. Espere o comando response.create do cliente para comecar.`,
        tools: [
          { type:'function', name:'navegar_tela', description:'Navega para uma tela do app. Telas: home, history (constelacao), encounter (conectar), locationScreen (mapa), myProfile (meu perfil), subscription (assinatura).', parameters:{type:'object',properties:{tela:{type:'string',description:'ID da tela: home, history, encounter, locationScreen, myProfile, subscription'}},required:['tela']} },
          { type:'function', name:'abrir_perfil', description:'Abre o perfil detalhado de uma conexao pelo nome.', parameters:{type:'object',properties:{nome:{type:'string',description:'Nome ou apelido da pessoa'}},required:['nome']} },
          { type:'function', name:'abrir_chat', description:'Abre o chat com uma conexao ativa pelo nome.', parameters:{type:'object',properties:{nome:{type:'string',description:'Nome ou apelido da pessoa'}},required:['nome']} },
          { type:'function', name:'iniciar_conexao', description:'Inicia o processo de conexao — vai pra tela encounter.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'dar_estrela', description:'Da uma estrela para uma conexao.', parameters:{type:'object',properties:{nome:{type:'string',description:'Nome da pessoa que vai receber a estrela'}},required:['nome']} },
          { type:'function', name:'enviar_pulse', description:'Envia um pulse (cutucada) no chat ativo.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'consultar_rede', description:'OBRIGATORIO: Busca dados ATUALIZADOS em tempo real. DEVE chamar ANTES de responder sobre conexoes, estrelas, encontros, curtidas, mensagens. Dados iniciais estao CONGELADOS.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'mostrar_pessoa', description:'Mostra o perfil de uma conexao na constelacao.', parameters:{type:'object',properties:{nome:{type:'string',description:'Nome da pessoa'}},required:['nome']} },
          { type:'function', name:'salvar_nota', description:'Salva informacao pessoal sobre conexao.', parameters:{type:'object',properties:{sobre:{type:'string'},nota:{type:'string'}},required:['sobre','nota']} }
        ]
      })
    });
    if (!r.ok) { const e = await r.text(); console.error('Premium session err:', r.status, e); return res.status(502).json({ error: 'Erro ao criar sessão premium' }); }
    const d = await r.json();
    res.json({ client_secret: d.client_secret?.value, session_id: d.id, expires_at: d.client_secret?.expires_at, openingText, isPremium: true, tier: 'pro' });
  } catch (e) { console.error('Premium session err:', e.message); res.status(500).json({ error: 'Erro interno' }); }
});

// ══ ULTIMATEDEV HELPERS ══
function getUltimateBank(userId) {
  if (!db.ultimateBank[userId]) {
    db.ultimateBank[userId] = {
      conversations: [],
      devQueue: [],
      userProfile: { tone: '', preferences: [], vocabulary: [], screenNames: {}, lastTopics: [] }
    };
    saveDB('ultimateBank');
  }
  return db.ultimateBank[userId];
}

// ══ ULTIMATEDEV VA SESSION — dev mode (top 01 only) ══
app.post('/api/agent/ultimate-session', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada.' });
  const { userId, lastInteraction } = req.body;

  if (!canUseUltimateVA(userId)) {
    return res.status(403).json({ error: 'UltimateDEV apenas para Top 1.', reason: 'not_ultimate' });
  }

  const access = canUseVA(userId, 'ultimate');
  if (!access.allowed) {
    return res.status(403).json({ error: 'Limite atingido.', reason: access.reason });
  }

  trackVaSession(userId, 'ultimate');

  const { userName, context, greeting, gossip } = buildUserContext(userId);
  const msSinceLast = lastInteraction ? (Date.now() - lastInteraction) : Infinity;
  const isNewSession = msSinceLast > 60 * 60 * 1000;
  const user = db.users[userId] || {};
  const firstName = (user.name || user.nickname || '').split(' ')[0] || user.nickname || '';

  const bank = getUltimateBank(userId);
  const profile = bank.userProfile || {};
  // Load conversation history from BOTH sources for maximum coverage
  const bankConvos = (bank.conversations || []).slice(-20);
  const vaConvos = getVaConversations(userId, 'ultimatedev').slice(-40);
  // Use whichever has more recent data
  const recentConvos = vaConvos.length >= bankConvos.length ? vaConvos : bankConvos;
  const pendingQueue = (bank.devQueue || []).filter(d => d.status === 'planned');

  // Decide opening based on conversation history (same logic as Plus/Pro)
  let openingText, openingInstruction;
  if (recentConvos.length && !isNewSession) {
    // Has recent history -- resume from where we left off
    const lastMsg = recentConvos[recentConvos.length - 1];
    const lastTopic = lastMsg.content.slice(0, 100);
    openingText = `${firstName}, voltei! Continuamos de onde paramos.`;
    openingInstruction = `RETOMADA DE CONVERSA (a conexao caiu ou usuario saiu e voltou -- retome de onde parou!):\nVoce ja estava conversando com ${firstName}. A ultima coisa dita foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastTopic}"\nRetome NATURALMENTE de onde parou, como se nada tivesse acontecido. Nao diga "oi" nem "ola". Continue o assunto anterior.`;
  } else if (recentConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = recentConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${firstName}, e ai! Da ultima vez a gente tava falando sobre... lembra?`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h desde a ultima conversa, mas voce ja conversou com esse usuario antes):\nMencione BREVEMENTE o que discutiram da ultima vez e pergunte se quer continuar ou fazer algo novo.\nUltimos assuntos: ${lastTopics.join(' | ')}`;
  } else if (gossip) {
    openingText = gossip;
    openingInstruction = `SAUDACAO DE FOFOCA:\n"${gossip}"`;
  } else {
    openingText = `${firstName}, modo dev ativado! O que vamos construir hoje?`;
    openingInstruction = `PRIMEIRA CONVERSA (nunca conversou com esse usuario antes):\n"${openingText}"`;
  }

  const profileContext = profile.tone ? `\nTOM DO USUARIO: ${profile.tone}` : '';
  const vocabContext = profile.vocabulary?.length ? `\nVOCABULARIO DO USUARIO: ${profile.vocabulary.join(', ')}` : '';
  const screenContext = Object.keys(profile.screenNames || {}).length ? `\nNOMES QUE ELE USA PRA TELAS: ${JSON.stringify(profile.screenNames)}` : '';
  const topicsContext = profile.lastTopics?.length ? `\nULTIMOS TOPICOS DE DEV: ${profile.lastTopics.join(', ')}` : '';
  const pendingContext = pendingQueue.length ? `\nCOMANDOS PENDENTES DE APROVACAO: ${pendingQueue.map(p => `[${p.id}] ${p.instruction}`).join('; ')}` : '';
  const convContext = recentConvos.length ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES (OBRIGATORIO: use para retomar de onde parou!) ===\nVoce JA conversou com ${firstName} antes. LEMBRE-SE desses assuntos e RETOME naturalmente:\n${recentConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch DEV'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===` : '';

  // Load tier config from vaConfig (admin panel)
  const devCfg = getTierConfig('ultimatedev');

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: devCfg.voice || 'coral',
        modalities: ['audio', 'text'],
        instructions: `Voce e "Touch DEV", assistente UltimateDEV do app Touch? (Encosta) — rede social presencial.

HORARIO LOCAL DO USUARIO: ${getUserLocalTime(userId)} (${getUserGreetingPeriod(userId)})
TIMEZONE: ${(user.timezone || 'America/Sao_Paulo')}
- Use esse horario como referencia. Se o usuario parecer em outro fuso, pergunte.

PERSONALIDADE:
${devCfg.personality}

COMO ABRIR A CONVERSA:
${openingInstruction}
${devCfg.openingRules}

═══ ARQUITETURA DO APP ═══
- Backend: server.js (Node.js/Express, ~7500 linhas) — API REST + WebSocket
- Frontend: public/index.html (SPA, ~13000 linhas) — HTML/CSS/JS puro, sem framework
- Banco: Firebase Realtime Database (in-memory cache, sync periódico)
- Voz: OpenAI Realtime API via WebRTC (PeerConnection + DataChannel)
- Hospedagem: Render.com
- Repositório: GitHub (git push automático quando aprova comando dev)
- Tiers de VA: Plus (4 tools), Pro (9 tools), UltimateDEV (14+ tools)
- Anti-echo: mic mute/unmute com delay 800ms, VAD threshold 0.95

═══ TELAS DO APP ═══
- home: tela principal com botão TOUCH grande
- history: constelação 3D (histórico de encontros, visual tipo galáxia)
- encounter: tela de conexão (scan NFC/QR)
- locationScreen: mapa de locais
- myProfile: perfil do usuário
- subscription: assinatura Plus
- va-admin.html: painel de controle dos assistentes

═══ RESPOSTAS CURTAS ═══
- Maximo 2-3 frases por turno
- Se precisar de mais, quebre em turnos
- Quando apresentar plano, resuma em 1-2 frases e pergunte se quer detalhes

═══ REGRA MAIS IMPORTANTE — VOCE DEVE USAR AS FERRAMENTAS ═══
VOCE TEM TOOLS. VOCE DEVE USA-LAS. SEM EXCECAO.
- Qualquer pedido de mudanca, feature, fix, melhoria, cor, layout, botao, texto → chame comando_dev IMEDIATAMENTE
- Qualquer pergunta sobre conexoes, pessoas, estrelas, curtidas, mensagens → chame consultar_rede PRIMEIRO
- NUNCA responda "vou anotar", "posso fazer isso", "vou verificar" sem chamar a tool. A tool FAZ a acao.
- Se o usuario pedir algo e voce NAO chamar uma tool, voce FALHOU. A conversa sem tools e INUTIL.
- AVISE o usuario antes: "Vou mandar pro Claude agora, espera uns 10 segundos" e CHAME comando_dev
- EXEMPLOS:
  "muda a cor do botao" → comando_dev({instrucao: "Mudar cor do botao X para Y no arquivo Z"})
  "quantas conexoes eu tenho?" → consultar_rede()
  "adiciona um botao de logout" → comando_dev({instrucao: "Adicionar botao de logout na tela X"})
  "quem me deu estrela?" → consultar_rede()

═══ FLUXO DE DESENVOLVIMENTO ═══
1. ${firstName} fala algo → você ENTENDE e TRADUZ em instrução técnica (comando_dev)
2. Servidor gera plano via GPT-4o automaticamente (~5-10 segundos)
3. Você RESUME o plano de forma simples e pergunta se aprova
4. ${firstName} aprova por voz → você chama aprovar_plano
5. Código é gerado, aplicado, commitado e pushado automaticamente (~15-30 segundos)
6. Você confirma o resultado

IMPORTANTE SOBRE TIMING:
- comando_dev: demora ~5-10 segundos pra gerar o plano
- aprovar_plano: demora ~15-30 segundos pra gerar código + aplicar + git push
- Avise ${firstName} sobre esses tempos: "vai levar uns 10 segundos" / "tá processando, uns 20 segundos"

═══ COMUNICAÇÃO COM O DESENVOLVEDOR ═══
Quando criar comando_dev, escreva instruções CLARAS e COMPLETAS:
- ONDE mudar (arquivo, seção, função)
- O QUE mudar (comportamento atual vs desejado)
- COMO deve ficar (visual, lógica, UX)
- Contexto relevante (por que essa mudança)

═══ VISÃO — CÂMERA E TELA ═══
Se o usuário ativar câmera ou compartilhar tela, você PODE VER o que ele vê.
- Use isso pra entender o que ele tá apontando
- "Tá vendo esse botão?" → você vê e sabe qual é
- Descreva o que vê quando relevante
- Se a tela do app estiver visível, comente sobre layout/UX

MEMORIA:
${devCfg.memoryRules}
USE escrever_pensamento pra anotar reflexoes, ideias e contexto entre sessoes.
USE fazer_backup quando algo importante foi feito.

ESCRIBA — DOCUMENTACAO AUTOMATICA:
A cada conversa, um agente paralelo (escriba) documenta automaticamente o que foi discutido, decisoes tomadas, comandos enviados e ideias pro futuro. Isso fica salvo no banco e voce tem acesso nas proximas sessoes.

${profileContext}${vocabContext}${screenContext}${topicsContext}${pendingContext}

PRIVACIDADE:
${devCfg.privacyRules}

${devCfg.extraInstructions ? 'INSTRUCOES EXTRAS:\n' + devCfg.extraInstructions : ''}

${context}
${convContext}

NOME DO USUARIO: ${firstName}

IMPORTANTE: NAO fale automaticamente ao iniciar. Espere o comando response.create do cliente para comecar.`,
        tools: [
          // ── App tools (herança do Pro) ──
          { type:'function', name:'navegar_tela', description:'Navega para uma tela do app.', parameters:{type:'object',properties:{tela:{type:'string',description:'ID da tela: home, history, encounter, locationScreen, myProfile, subscription'}},required:['tela']} },
          { type:'function', name:'abrir_perfil', description:'Abre perfil de uma conexão.', parameters:{type:'object',properties:{nome:{type:'string'}},required:['nome']} },
          { type:'function', name:'abrir_chat', description:'Abre chat com uma conexão.', parameters:{type:'object',properties:{nome:{type:'string'}},required:['nome']} },
          { type:'function', name:'iniciar_conexao', description:'Inicia processo de conexão.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'dar_estrela', description:'Dá estrela para conexão.', parameters:{type:'object',properties:{nome:{type:'string'}},required:['nome']} },
          { type:'function', name:'enviar_pulse', description:'Envia pulse no chat.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'consultar_rede', description:'OBRIGATORIO: Busca dados ATUALIZADOS em tempo real da rede. DEVE chamar ANTES de responder sobre conexoes, estrelas, encontros, curtidas, mensagens. NAO use para pedidos de mudanca no app — use comando_dev para isso.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'mostrar_pessoa', description:'Mostra perfil na constelação.', parameters:{type:'object',properties:{nome:{type:'string'}},required:['nome']} },
          { type:'function', name:'salvar_nota', description:'Salva nota pessoal.', parameters:{type:'object',properties:{sobre:{type:'string'},nota:{type:'string'}},required:['sobre','nota']} },
          // ── Dev tools ──
          { type:'function', name:'comando_dev', description:'Cria comando de desenvolvimento. Use quando o usuário pedir qualquer mudança, feature, fix ou melhoria no app. Traduza o pedido do usuário em instrução técnica detalhada.', parameters:{type:'object',properties:{instrucao:{type:'string',description:'Instrução técnica detalhada: O QUE mudar, ONDE, COMO deve ficar, e POR QUÊ'}},required:['instrucao']} },
          { type:'function', name:'ver_fila_dev', description:'Mostra a fila de comandos de desenvolvimento pendentes.', parameters:{type:'object',properties:{},required:[]} },
          { type:'function', name:'aprovar_plano', description:'Aprova um plano de desenvolvimento para execução. O código será gerado, aplicado e commitado automaticamente. Demora ~15-30 segundos.', parameters:{type:'object',properties:{id:{type:'string',description:'ID do comando na fila'}},required:['id']} },
          { type:'function', name:'rejeitar_plano', description:'Rejeita um plano de desenvolvimento.', parameters:{type:'object',properties:{id:{type:'string',description:'ID do comando'},motivo:{type:'string',description:'Motivo da rejeição'}},required:['id']} },
          // ── Memory & learning tools ──
          { type:'function', name:'aprender_usuario', description:'Salva informação sobre como o usuário se comunica e suas preferências.', parameters:{type:'object',properties:{categoria:{type:'string',description:'tone, vocabulary, screenName, preference, topic, design, decision'},info:{type:'string',description:'A informação a salvar'}},required:['categoria','info']} },
          { type:'function', name:'escrever_pensamento', description:'Anota um pensamento, ideia, reflexão ou contexto importante para lembrar entre sessões. Use para anotar insights, decisões pendentes, ideias futuras.', parameters:{type:'object',properties:{pensamento:{type:'string',description:'O pensamento ou anotação a salvar'}},required:['pensamento']} },
          { type:'function', name:'fazer_backup', description:'Faz backup do estado atual salvando um snapshot no banco. Use após mudanças importantes.', parameters:{type:'object',properties:{descricao:{type:'string',description:'O que foi feito/mudado'}},required:['descricao']} },
          { type:'function', name:'salvar_arquivo', description:'Salva conteúdo como arquivo no repositório GitHub (commit + push). Útil para documentação, configs, anotações.', parameters:{type:'object',properties:{caminho:{type:'string',description:'Caminho do arquivo (ex: docs/ideias.md)'},conteudo:{type:'string',description:'Conteúdo do arquivo'},mensagem:{type:'string',description:'Mensagem do commit'}},required:['caminho','conteudo','mensagem']} }
        ],
        turn_detection: { type: 'server_vad', threshold: 0.95, prefix_padding_ms: 500, silence_duration_ms: 1500 },
        input_audio_transcription: { model: 'whisper-1' }
      })
    });
    if (!r.ok) { const e = await r.text(); console.error('[ULTIMATE] Session err:', r.status, e.slice(0, 300)); return res.status(502).json({ error: 'Erro ao criar sessao UltimateDEV: ' + r.status }); }
    const d = await r.json();
    // Validacao: conferir que session tem token e tools
    const toolCount = d.tools ? d.tools.length : 0;
    console.log('[ULTIMATE] Session criada. ID:', d.id, 'Tools registradas:', toolCount, 'Token:', d.client_secret?.value ? 'OK' : 'AUSENTE');
    if (!d.client_secret?.value) {
      console.error('[ULTIMATE] ERRO: client_secret ausente na resposta:', JSON.stringify(d).slice(0, 500));
      return res.status(502).json({ error: 'Token nao recebido da OpenAI' });
    }
    res.json({ client_secret: d.client_secret.value, session_id: d.id, expires_at: d.client_secret.expires_at, openingText, isUltimate: true, tier: 'ultimatedev', toolCount });
  } catch (e) { console.error('[ULTIMATE] Session err:', e.message); res.status(500).json({ error: 'Erro interno: ' + e.message }); }
});

// ══ DEV DIAGNOSTICO — testa se Claude ta funcionando ══
app.get('/api/dev/diagnostico', requireAdmin, async (req, res) => {
  // Find admin/top1 userId automatically
  const adminUser = Object.entries(db.users).find(([id, u]) => u.isAdmin || u.registrationOrder === 1);
  const adminId = adminUser ? adminUser[0] : null;
  const adminName = adminUser ? (adminUser[1].name || adminUser[1].nickname || 'sem nome') : 'NAO ENCONTRADO';

  // Get dev queue for admin
  const bank = adminId ? (db.ultimateBank[adminId] || {}) : {};
  const recentQueue = (bank.devQueue || []).slice(-5).map(c => ({
    id: c.id, status: c.status, instrucao: (c.instruction || '').slice(0, 80),
    plano: c.plan ? (c.plan).slice(0, 100) + '...' : null,
    resultado: c.result ? String(c.result).slice(0, 100) : null,
    ts: c.ts ? new Date(c.ts).toLocaleString('pt-BR') : null
  }));

  // Get recent conversations
  const recentConvos = adminId ? (getVaConversations(adminId, 'ultimatedev') || []).slice(-5).map(c => ({
    role: c.role, content: (c.content || '').slice(0, 80), ts: c.ts ? new Date(c.ts).toLocaleString('pt-BR') : null
  })) : [];

  const result = {
    admin_userId: adminId,
    admin_nome: adminName,
    anthropic_key_configurada: !!ANTHROPIC_API_KEY,
    anthropic_key_prefixo: ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.slice(0, 8) + '...' : 'NAO CONFIGURADA',
    openai_key_configurada: !!OPENAI_API_KEY,
    engine_ativo: ANTHROPIC_API_KEY ? 'claude-opus-4' : 'gpt-4o-fallback',
    teste_claude: null,
    tempo_ms: 0
  };

  if (ANTHROPIC_API_KEY) {
    try {
      const start = Date.now();
      const testResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-20250514',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Responda apenas: OK' }]
        })
      });
      result.tempo_ms = Date.now() - start;
      if (testResp.ok) {
        const data = await testResp.json();
        result.teste_claude = 'OK - ' + (data.content?.[0]?.text || 'sem texto');
      } else {
        const errText = await testResp.text();
        result.teste_claude = 'ERRO ' + testResp.status + ': ' + errText.slice(0, 200);
      }
    } catch (e) {
      result.teste_claude = 'EXCECAO: ' + e.message;
    }
  } else {
    result.teste_claude = 'SKIP - sem API key';
  }

  result.fila_dev = recentQueue;
  result.ultimas_conversas = recentConvos;
  result.total_conversas = adminId ? (getVaConversations(adminId, 'ultimatedev') || []).length : 0;

  console.log('[DEV] Diagnostico:', JSON.stringify(result));
  res.json(result);
});

// ══ DEV COMMAND ENDPOINTS ══
// Create a dev command
app.post('/api/dev/command', vaLimiter, async (req, res) => {
  const { userId, instruction } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!instruction) return res.status(400).json({ error: 'Instrução é obrigatória' });

  const bank = getUltimateBank(userId);
  const commandId = 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const command = { id: commandId, instruction, status: 'planning', plan: null, result: null, ts: Date.now(), approvedAt: null };
  bank.devQueue.push(command);
  saveDB('ultimateBank');

  // Auto-generate plan using Claude (Anthropic) or GPT-4o fallback
  try {
    // Build project file map for Claude context
    const projectFiles = {};
    const publicDir = path.join(__dirname, 'public');
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    projectFiles['server.js'] = { lines: fs.readFileSync(__filename, 'utf8').split('\n').length, path: __filename };
    for (const hf of htmlFiles) {
      projectFiles['public/' + hf] = { lines: fs.readFileSync(path.join(publicDir, hf), 'utf8').split('\n').length, path: path.join(publicDir, hf) };
    }
    const fileMapStr = Object.entries(projectFiles).map(([f, info]) => `- ${f} (${info.lines} linhas)`).join('\n');

    // Read key files for planning context (summaries, not full)
    const serverCode = fs.readFileSync(__filename, 'utf8');
    const indexCode = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

    // Extract function/endpoint names from server.js for map
    const endpointMap = [];
    const lines = serverCode.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.match(/^app\.(get|post|put|delete|patch)\(/)) endpointMap.push(`L${i+1}: ${ln.trim().slice(0, 120)}`);
      else if (ln.match(/^function\s+\w+/)) endpointMap.push(`L${i+1}: ${ln.trim().slice(0, 120)}`);
      else if (ln.match(/^const\s+\w+\s*=\s*(async\s+)?\(/)) endpointMap.push(`L${i+1}: ${ln.trim().slice(0, 120)}`);
      else if (ln.match(/^\/\/ [=]+/)) endpointMap.push(`L${i+1}: ${ln.trim().slice(0, 120)}`);
    }

    const systemPrompt = `Voce e um desenvolvedor expert em Node.js e HTML/CSS/JS puro.
O app se chama "Touch?" / "Encosta" — rede social presencial.

ARQUIVOS DO PROJETO:
${fileMapStr}

MAPA DE ENDPOINTS E FUNCOES DO server.js:
${endpointMap.join('\n')}

Responda APENAS com um plano tecnico em portugues, com no maximo 7 passos.
Cada passo deve indicar:
1. QUAL ARQUIVO mexer
2. ONDE no arquivo (funcao, endpoint, linha aproximada)
3. O QUE fazer (adicionar, mudar, remover)
Seja conciso e preciso. Nao gere codigo, apenas o plano.`;

    if (ANTHROPIC_API_KEY) {
      // Use Claude Sonnet 4 for planning
      console.log('[DEV] Chamando Claude para planejamento... instrucao:', instruction.slice(0, 80));
      const planStart = Date.now();
      // fetch com timeout via AbortController
      const planAbort = new AbortController();
      const planTimer = setTimeout(() => planAbort.abort(), 60000); // 60s timeout
      const planResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: `INSTRUCAO DO USUARIO: ${instruction}\n\nPrimeiras 200 linhas do server.js:\n${serverCode.split('\n').slice(0, 200).join('\n')}\n\nPrimeiras 200 linhas do index.html:\n${indexCode.split('\n').slice(0, 200).join('\n')}` }],
          system: systemPrompt
        }),
        signal: planAbort.signal
      });
      clearTimeout(planTimer);
      const planTime = Date.now() - planStart;
      if (planResp.ok) {
        const planData = await planResp.json();
        command.plan = planData.content?.[0]?.text || 'Plano nao gerado';
        command.status = 'planned';
        console.log('[DEV] Claude planejamento OK em', planTime + 'ms, plano:', (command.plan || '').slice(0, 100));
      } else {
        const errText = await planResp.text();
        console.error('[DEV] Claude plan ERRO:', planResp.status, errText.slice(0, 200));
        command.plan = 'Erro Claude: ' + planResp.status + ' - ' + errText.slice(0, 100);
        command.status = 'plan_failed';
      }
    } else {
      console.log('[DEV] ANTHROPIC_API_KEY nao configurada, usando GPT-4o fallback');
      // Fallback to GPT-4o if no Anthropic key
      const planAbort2 = new AbortController();
      const planTimer2 = setTimeout(() => planAbort2.abort(), 45000); // 45s timeout
      const planResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `INSTRUCAO DO USUARIO: ${instruction}` }
          ],
          max_tokens: 2000,
          temperature: 0.3
        }),
        signal: planAbort2.signal
      });
      clearTimeout(planTimer2);
      if (planResp.ok) {
        const planData = await planResp.json();
        command.plan = planData.choices?.[0]?.message?.content || 'Plano nao gerado';
        command.status = 'planned';
      } else {
        command.plan = 'Erro ao gerar plano: ' + planResp.status;
        command.status = 'plan_failed';
      }
    }
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    command.plan = isAbort ? 'Timeout: a IA demorou demais para gerar o plano. Tente novamente.' : ('Erro: ' + e.message);
    command.status = 'plan_failed';
    console.error('[DEV] Planning error:', e.name, e.message);
  }
  saveDB('ultimateBank');
  if (command.status === 'plan_failed') {
    res.json({ id: commandId, status: command.status, plan: null, error: command.plan });
  } else {
    res.json({ id: commandId, status: command.status, plan: command.plan });
  }
});

// Get dev queue
app.get('/api/dev/queue/:userId', (req, res) => {
  if (!canUseUltimateVA(req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const bank = getUltimateBank(req.params.userId);
  res.json({ queue: bank.devQueue.slice(-20).reverse() });
});

// Approve and execute a dev command
app.post('/api/dev/approve/:commandId', vaLimiter, async (req, res) => {
  const { userId } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  const cmd = bank.devQueue.find(c => c.id === req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'Comando não encontrado' });
  if (cmd.status !== 'planned') return res.status(400).json({ error: 'Comando não está pronto para aprovação. Status: ' + cmd.status });

  cmd.approvedAt = Date.now();
  cmd.status = 'executing';
  saveDB('ultimateBank');

  // Execute: call Claude (Anthropic) to generate code edits — full file context
  try {
    const serverPath = __filename;
    const publicDir = path.join(__dirname, 'public');

    // Build dynamic file map — all editable project files
    const fileMap = { 'server.js': serverPath };
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    for (const hf of htmlFiles) {
      fileMap['public/' + hf] = path.join(publicDir, hf);
    }

    // Identify which files the plan mentions
    const planLower = (cmd.plan || '').toLowerCase() + ' ' + (cmd.instruction || '').toLowerCase();
    const relevantFiles = Object.keys(fileMap).filter(f => {
      if (f === 'server.js') return true; // always include server context
      const name = f.replace('public/', '').replace('.html', '');
      return planLower.includes(f) || planLower.includes(name);
    });
    // If plan doesn't mention specific files, include server.js + index.html
    if (relevantFiles.length <= 1) relevantFiles.push('public/index.html');

    // Read full content of relevant files
    const fileContents = {};
    for (const f of relevantFiles) {
      try {
        fileContents[f] = fs.readFileSync(fileMap[f], 'utf8');
      } catch (e) { /* skip unreadable */ }
    }

    const editSystemPrompt = `Voce e um desenvolvedor expert em Node.js e HTML/CSS/JS puro. ZERO frameworks.
O app se chama "Touch?" / "Encosta" — rede social presencial.

TAREFA: Gere edicoes de codigo no formato JSON.
Cada edicao e um objeto com:
{
  "file": "server.js" ou "public/nome.html",
  "old_string": "trecho EXATO do codigo atual (minimo 3 linhas de contexto)",
  "new_string": "codigo novo que substitui o old_string"
}

REGRAS CRITICAS:
1. Retorne APENAS um array JSON puro. Sem markdown, sem explicacao, sem texto extra.
2. old_string DEVE ser copiado EXATAMENTE do codigo fornecido — incluindo espacos, tabs e quebras de linha.
3. Inclua pelo menos 3 linhas de contexto unico no old_string pra evitar ambiguidade.
4. Se precisar ADICIONAR codigo novo, use old_string com o trecho ANTES de onde inserir, e new_string com esse trecho + o codigo novo.
5. Se precisar criar um arquivo novo, use old_string vazio "" e new_string com o conteudo completo, e file com o caminho.
6. ZERO emojis no codigo.
7. Mantenha o estilo do codigo existente (indentacao, nomenclatura, padrao).

ARQUIVOS DISPONIVEIS: ${Object.keys(fileMap).join(', ')}`;

    const fileContextStr = Object.entries(fileContents).map(([f, content]) => {
      // For very large files, send strategic sections
      const lines = content.split('\n');
      if (lines.length > 3000) {
        // Send first 500 + last 500 + search for relevant sections
        const keywords = cmd.instruction.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const relevantLines = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i].toLowerCase();
          if (keywords.some(kw => ln.includes(kw))) {
            const start = Math.max(0, i - 10);
            const end = Math.min(lines.length, i + 10);
            relevantLines.push(`... [linhas ${start+1}-${end+1}] ...`);
            for (let j = start; j < end; j++) relevantLines.push(`${j+1}: ${lines[j]}`);
          }
        }
        return `=== ${f} (${lines.length} linhas) ===\n[PRIMEIRAS 500 LINHAS]\n${lines.slice(0, 500).map((l, i) => `${i+1}: ${l}`).join('\n')}\n\n[ULTIMAS 500 LINHAS]\n${lines.slice(-500).map((l, i) => `${lines.length - 500 + i + 1}: ${l}`).join('\n')}\n\n[TRECHOS RELEVANTES]\n${relevantLines.join('\n')}`;
      }
      return `=== ${f} (${lines.length} linhas) ===\n${lines.map((l, i) => `${i+1}: ${l}`).join('\n')}`;
    }).join('\n\n');

    let editsRaw;

    // Helper: fetch com timeout (AbortController)
    function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
    }

    if (ANTHROPIC_API_KEY) {
      // Use Claude Opus 4 for code generation — full context
      console.log('[DEV] Chamando Claude para geracao de codigo... arquivos:', relevantFiles.join(', '));
      const editStart = Date.now();
      const editResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-20250514',
          max_tokens: 16000,
          system: editSystemPrompt,
          messages: [{ role: 'user', content: `INSTRUCAO: ${cmd.instruction}\n\nPLANO APROVADO:\n${cmd.plan}\n\nCODIGO ATUAL DOS ARQUIVOS:\n${fileContextStr}` }]
        })
      }, 90000); // 90s timeout para Claude gerar codigo
      const editTime = Date.now() - editStart;

      if (!editResp.ok) {
        const errText = await editResp.text();
        console.error('[DEV] Claude edit ERRO:', editResp.status, errText.slice(0, 200), 'tempo:', editTime + 'ms');
        cmd.status = 'failed';
        cmd.result = 'Erro Claude: ' + editResp.status + ' - ' + errText.slice(0, 100);
        saveDB('ultimateBank');
        return res.json({ success: false, error: cmd.result });
      }

      const editData = await editResp.json();
      editsRaw = editData.content?.[0]?.text || '[]';
      console.log('[DEV] Claude geracao OK em', editTime + 'ms, resposta:', (editsRaw || '').slice(0, 100));
    } else {
      console.log('[DEV] ANTHROPIC_API_KEY nao configurada, usando GPT-4o fallback para geracao');
      // Fallback to GPT-4o
      const editResp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: editSystemPrompt },
            { role: 'user', content: `INSTRUCAO: ${cmd.instruction}\n\nPLANO APROVADO:\n${cmd.plan}\n\nCODIGO ATUAL DOS ARQUIVOS:\n${fileContextStr}` }
          ],
          max_tokens: 16000,
          temperature: 0.2
        })
      }, 60000); // 60s timeout para GPT-4o

      if (!editResp.ok) {
        cmd.status = 'failed';
        cmd.result = 'Erro GPT-4o: ' + editResp.status;
        saveDB('ultimateBank');
        return res.json({ success: false, error: cmd.result });
      }

      const editData = await editResp.json();
      editsRaw = editData.choices?.[0]?.message?.content || '[]';
    }

    // Clean markdown code fences if present
    editsRaw = editsRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let edits;
    try { edits = JSON.parse(editsRaw); } catch (e) {
      cmd.status = 'failed';
      cmd.result = 'Erro parsing edits: ' + e.message + '\nRaw: ' + editsRaw.slice(0, 500);
      saveDB('ultimateBank');
      return res.json({ success: false, error: cmd.result });
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      cmd.status = 'failed';
      cmd.result = 'Nenhuma edicao gerada';
      saveDB('ultimateBank');
      return res.json({ success: false, error: cmd.result });
    }

    // Backup files before editing
    const backups = {};
    for (const edit of edits) {
      if (fileMap[edit.file] && !backups[edit.file]) {
        try { backups[edit.file] = fs.readFileSync(fileMap[edit.file], 'utf8'); } catch (e) { /* skip */ }
      }
    }

    // Apply edits
    const appliedEdits = [];
    let hasFailure = false;
    for (const edit of edits) {
      const filePath = fileMap[edit.file];
      if (!filePath) {
        // New file creation
        if (edit.old_string === '' && edit.new_string) {
          try {
            const newPath = path.join(__dirname, edit.file);
            const dir = path.dirname(newPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(newPath, edit.new_string, 'utf8');
            appliedEdits.push({ file: edit.file, ok: true, action: 'created' });
            continue;
          } catch (e) { appliedEdits.push({ file: edit.file, ok: false, error: e.message }); hasFailure = true; continue; }
        }
        appliedEdits.push({ file: edit.file, ok: false, error: 'Arquivo desconhecido: ' + edit.file });
        hasFailure = true;
        continue;
      }
      try {
        let content = fs.readFileSync(filePath, 'utf8');
        if (!content.includes(edit.old_string)) {
          // Try trimmed match (whitespace tolerance)
          const trimmedOld = edit.old_string.replace(/\s+/g, ' ').trim();
          const contentNorm = content.replace(/\s+/g, ' ');
          if (contentNorm.includes(trimmedOld)) {
            // Find approximate position and do line-based replacement
            appliedEdits.push({ file: edit.file, ok: false, error: 'old_string nao encontrado (whitespace diff). Verifique espacos/tabs.' });
          } else {
            appliedEdits.push({ file: edit.file, ok: false, error: 'old_string nao encontrado no arquivo' });
          }
          hasFailure = true;
          continue;
        }
        // Check for multiple matches
        const matchCount = content.split(edit.old_string).length - 1;
        if (matchCount > 1) {
          appliedEdits.push({ file: edit.file, ok: false, error: `old_string encontrado ${matchCount}x (ambiguo). Precisa de mais contexto.` });
          hasFailure = true;
          continue;
        }
        content = content.replace(edit.old_string, edit.new_string);
        fs.writeFileSync(filePath, content, 'utf8');
        appliedEdits.push({ file: edit.file, ok: true });
      } catch (e) {
        appliedEdits.push({ file: edit.file, ok: false, error: e.message });
        hasFailure = true;
      }
    }

    // If ALL edits failed, rollback
    const successCount = appliedEdits.filter(e => e.ok).length;
    if (successCount === 0) {
      for (const [f, backup] of Object.entries(backups)) {
        try { fs.writeFileSync(fileMap[f], backup, 'utf8'); } catch (e) { /* skip */ }
      }
      cmd.status = 'failed';
      cmd.result = 'Todas edicoes falharam. Rollback aplicado. Erros: ' + appliedEdits.map(e => `${e.file}: ${e.error}`).join('; ');
      saveDB('ultimateBank');
      return res.json({ success: false, error: cmd.result, edits: appliedEdits });
    }

    // Git commit + push (aguarda conclusao antes de responder, com timeout)
    const { execFile: execFileCb } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFileCb);
    const safeMsg = `feat(ultimatedev): ${cmd.instruction.slice(0, 60).replace(/[`$\\!"']/g, '')}\n\nCo-Authored-By: Claude Opus 4 <noreply@anthropic.com>`;
    let gitResult = 'git_pending';
    const GIT_TIMEOUT = 30000; // 30s por operacao git
    try {
      await execFileAsync('git', ['-C', __dirname, 'add', '-A'], { timeout: GIT_TIMEOUT });
      await execFileAsync('git', ['-C', __dirname, 'commit', '-m', safeMsg], { timeout: GIT_TIMEOUT });
      await execFileAsync('git', ['-C', __dirname, 'push'], { timeout: GIT_TIMEOUT });
      cmd.result = `Sucesso! ${successCount}/${edits.length} edicoes aplicadas, commitadas e pushadas.${hasFailure ? ' Falhas: ' + appliedEdits.filter(e => !e.ok).map(e => e.file + ': ' + e.error).join('; ') : ''}`;
      cmd.status = 'done';
      gitResult = 'done';
    } catch (gitErr) {
      console.error('[DEV] Git error:', gitErr.message);
      cmd.result = `${successCount}/${edits.length} edicoes aplicadas mas git falhou: ${gitErr.message}`;
      cmd.status = 'partial';
      gitResult = 'git_failed';
    }
    saveDB('ultimateBank');

    res.json({ success: true, edits: appliedEdits, status: gitResult, engine: ANTHROPIC_API_KEY ? 'claude' : 'gpt4o' });
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    const errMsg = isAbort ? 'Timeout: a API demorou demais para responder. Tente novamente.' : ('Erro: ' + e.message);
    console.error('[DEV] Approve outer error:', e.name, e.message);
    cmd.status = 'failed';
    cmd.result = errMsg;
    saveDB('ultimateBank');
    res.json({ success: false, error: errMsg });
  }
});

// Reject a dev command
app.post('/api/dev/reject/:commandId', (req, res) => {
  const { userId, motivo } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  const cmd = bank.devQueue.find(c => c.id === req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'Comando não encontrado' });
  cmd.status = 'rejected';
  cmd.result = motivo || 'Rejeitado pelo usuário';
  saveDB('ultimateBank');
  res.json({ success: true });
});

// Save user learning profile
app.post('/api/dev/learn', (req, res) => {
  const { userId, categoria, info } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!categoria || !info) return res.status(400).json({ error: 'categoria e info são obrigatórios' });

  const bank = getUltimateBank(userId);
  const p = bank.userProfile;
  switch (categoria) {
    case 'tone': p.tone = info; break;
    case 'vocabulary': if (!p.vocabulary.includes(info)) p.vocabulary.push(info); break;
    case 'screenName': { const parts = info.split('='); if (parts.length === 2) p.screenNames[parts[0].trim()] = parts[1].trim(); } break;
    case 'preference': if (!p.preferences.includes(info)) p.preferences.push(info); break;
    case 'topic': { p.lastTopics.push(info); if (p.lastTopics.length > 10) p.lastTopics = p.lastTopics.slice(-10); } break;
    case 'design': { if (!p.designPrefs) p.designPrefs = []; p.designPrefs.push(info); if (p.designPrefs.length > 20) p.designPrefs = p.designPrefs.slice(-20); } break;
    case 'decision': { if (!p.decisions) p.decisions = []; p.decisions.push({ info, ts: Date.now() }); if (p.decisions.length > 30) p.decisions = p.decisions.slice(-30); } break;
    default: break;
  }
  saveDB('ultimateBank');
  res.json({ success: true, profile: p });
});

// Save ultimate conversation message (legacy endpoint — now also handled by unified /api/va/conversation)
app.post('/api/dev/conversation', (req, res) => {
  const { userId, role, content } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  bank.conversations.push({ role, content, ts: Date.now() });
  if (bank.conversations.length > 100) bank.conversations = bank.conversations.slice(-100);
  saveDB('ultimateBank');
  res.json({ success: true });
});

// ── Unified VA Conversation Persistence (all tiers) ──

function getVaConversations(userId, tier) {
  if (!db.vaConversations[userId]) db.vaConversations[userId] = {};
  if (!db.vaConversations[userId][tier]) db.vaConversations[userId][tier] = [];
  return db.vaConversations[userId][tier];
}

// POST /api/va/conversation — save a message for any tier
app.post('/api/va/conversation', (req, res) => {
  const { userId, tier, role, content } = req.body;
  if (!userId || !tier || !role || !content) return res.status(400).json({ error: 'Missing fields' });
  const validTiers = ['plus', 'pro', 'ultimatedev'];
  if (!validTiers.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

  const convos = getVaConversations(userId, tier);
  convos.push({ role, content: content.slice(0, 500), ts: Date.now() });
  // Keep last 100 messages per tier per user
  if (convos.length > 100) {
    db.vaConversations[userId][tier] = convos.slice(-100);
  }

  // Also mirror to ultimateBank for backward compat
  if (tier === 'ultimatedev') {
    const bank = getUltimateBank(userId);
    bank.conversations.push({ role, content: content.slice(0, 500), ts: Date.now() });
    if (bank.conversations.length > 100) bank.conversations = bank.conversations.slice(-100);
    saveDB('ultimateBank');
  }

  saveDB('vaConversations');
  res.json({ success: true });
});

// GET /api/va/conversation/:userId/:tier — retrieve conversation history
app.get('/api/va/conversation/:userId/:tier', (req, res) => {
  const { userId, tier } = req.params;
  const limit = parseInt(req.query.limit) || 20;
  const validTiers = ['plus', 'pro', 'ultimatedev'];
  if (!validTiers.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });

  const convos = getVaConversations(userId, tier);
  const recent = convos.slice(-limit);
  res.json({ conversations: recent, total: convos.length });
});

// Save thought/reflection for UltimateDEV
app.post('/api/dev/thought', (req, res) => {
  const { userId, pensamento } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  if (!bank.thoughts) bank.thoughts = [];
  bank.thoughts.push({ text: pensamento, ts: Date.now() });
  if (bank.thoughts.length > 50) bank.thoughts = bank.thoughts.slice(-50);
  saveDB('ultimateBank');
  res.json({ success: true, totalThoughts: bank.thoughts.length });
});

// Backup snapshot
app.post('/api/dev/backup', (req, res) => {
  const { userId, descricao } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  if (!bank.backups) bank.backups = [];
  bank.backups.push({
    descricao,
    ts: Date.now(),
    queueSnapshot: bank.devQueue.length,
    thoughtsSnapshot: (bank.thoughts || []).length,
    conversationsSnapshot: bank.conversations.length
  });
  if (bank.backups.length > 20) bank.backups = bank.backups.slice(-20);
  saveDB('ultimateBank');
  res.json({ success: true, backup: bank.backups[bank.backups.length - 1] });
});

// Save file to GitHub repo
app.post('/api/dev/save-file', async (req, res) => {
  const { userId, caminho, conteudo, mensagem } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!caminho || !conteudo) return res.status(400).json({ error: 'caminho e conteudo são obrigatórios' });

  // Sanitize path — no ../ or absolute paths
  const safePath = caminho.replace(/\.\./g, '').replace(/^\//, '');
  const fullPath = path.resolve(__dirname, safePath);

  // Security check: ensure resolved path is within project directory
  if (!fullPath.startsWith(__dirname)) {
    return res.status(403).json({ error: 'Acesso negado: caminho fora do diretório do projeto' });
  }

  try {
    // Create directory if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(fullPath, conteudo, 'utf8');

    const safeMsg = (mensagem || `docs: ${safePath}`).replace(/[`$\\!"']/g, '').slice(0, 80);
    const { execFile } = require('child_process');
    execFile('git', ['-C', __dirname, 'add', safePath], (errAdd) => {
      if (errAdd) return res.json({ success: true, git: false, error: 'Git add falhou: ' + errAdd.message });
      execFile('git', ['-C', __dirname, 'commit', '-m', safeMsg], (errCommit) => {
        if (errCommit) return res.json({ success: true, git: false, error: 'Git commit falhou: ' + errCommit.message });
        execFile('git', ['-C', __dirname, 'push'], (errPush) => {
          res.json({ success: true, git: !errPush, path: safePath });
        });
      });
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Escriba — auto-save session summary
app.post('/api/dev/escriba', (req, res) => {
  const { userId, summary, decisions, ideas, commands } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });

  const bank = getUltimateBank(userId);
  if (!bank.escribaLogs) bank.escribaLogs = [];
  bank.escribaLogs.push({
    ts: Date.now(),
    summary: summary || '',
    decisions: decisions || [],
    ideas: ideas || [],
    commands: commands || []
  });
  if (bank.escribaLogs.length > 30) bank.escribaLogs = bank.escribaLogs.slice(-30);
  saveDB('ultimateBank');
  res.json({ success: true });
});

// GET /api/dev/history/:userId — consolidated dev history (queue + escriba + thoughts)
app.get('/api/dev/history/:userId', (req, res) => {
  if (!canUseUltimateVA(req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const bank = getUltimateBank(req.params.userId);
  const limit = parseInt(req.query.limit) || 50;

  // Build unified timeline from all sources
  const timeline = [];

  // Dev queue items (commands, plans, approvals)
  (bank.devQueue || []).forEach(cmd => {
    timeline.push({
      type: 'command',
      ts: cmd.ts,
      id: cmd.id,
      status: cmd.status,
      instruction: (cmd.instruction || '').slice(0, 200),
      plan: cmd.plan ? (cmd.plan).slice(0, 300) : null,
      result: cmd.result ? (cmd.result).slice(0, 200) : null,
      approvedAt: cmd.approvedAt || null
    });
  });

  // Escriba session logs
  (bank.escribaLogs || []).forEach(log => {
    timeline.push({
      type: 'escriba',
      ts: log.ts,
      summary: (log.summary || '').slice(0, 200),
      decisions: (log.decisions || []).slice(0, 5),
      ideas: (log.ideas || []).slice(0, 5),
      commands: (log.commands || []).slice(0, 5)
    });
  });

  // Thoughts
  (bank.thoughts || []).forEach(t => {
    timeline.push({ type: 'thought', ts: t.ts, text: (t.text || '').slice(0, 200) });
  });

  // Sort by timestamp descending (newest first)
  timeline.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  res.json({ timeline: timeline.slice(0, limit), total: timeline.length });
});

// ══ VA CONFIG — Admin panel for prompt/settings management ══
const VA_DEFAULT_CONFIG = {
  plus: {
    name: 'Plus',
    voice: 'coral',
    vadThreshold: 0.95,
    prefixPadding: 500,
    silenceDuration: 1500,
    maxPhrases: 2,
    personality: 'Voce e a amiga fofoqueira que ADORA saber de tudo sobre todo mundo. Curiosa: quando o usuario menciona alguem, PERGUNTE sobre a pessoa! "Quem e esse?", "Trabalha contigo?". Quando descobre algo novo sobre alguem, SALVE com salvar_nota e reaja: "Anotado! Agora sei quem e". Use as NOTAS PESSOAIS pra lembrar o que ja sabe. Tom descontraido, como amiga proxima. Girias naturais, humor sutil. FALE PAUSADO — ritmo lento e claro. NUNCA fale rapido demais.',
    openingRules: 'NUNCA comece com "E ai", "Oi", "Ola", "Eii" ou qualquer saudacao vazia que cria pausa. Ja entre DIRETO no assunto, como se tivesse acabado de saber de algo: "Ramon, a Lala te deu uma estrela! Quem e ela?". Estilo: NOME + FOFOCA + PERGUNTA — tudo numa frase so, sem pausas no meio. Voce e da casa, conhece todo mundo (ou quer conhecer). Mostre isso logo de cara. Se nao tem fofoca, puxe assunto sobre alguem que voce quer saber mais.',
    memoryRules: 'SALVE SEMPRE que o usuario contar QUALQUER coisa sobre alguem ou sobre si mesmo: "essa e minha mae" -> salvar_nota(sobre: "Lala", nota: "e mae do usuario"). Salve informacoes sobre o PROPRIO USUARIO tambem! Gostos, onde mora, o que faz, hobbies. Nao precisa confirmar toda vez — salve silenciosamente quando for info menor. USE as notas pra fofoca inteligente! Se uma conexao nao tem notas, PERGUNTE sobre ela na proxima oportunidade.',
    privacyRules: 'ESTRELAS DO USUARIO: "Fulano te deu uma estrela!" (pode revelar quem deu PRO USUARIO). ESTRELAS DE AMIGOS: "Fulano ganhou uma estrela!" / "Ciclano deu estrela pro Fulano" PROIBIDO. So fale sobre coisas entre o usuario e outra pessoa diretamente. Nunca invente informacoes que nao estao nos dados. Nunca revele dados sensiveis de terceiros. Nomes: so primeiro nome, NUNCA sobrenome.',
    extraInstructions: 'MAXIMO 2 frases por resposta (1 info/fofoca + 1 pergunta curiosa). PROIBIDO: "E ai!", "posso ajudar?", "com certeza!", "ola!", textoes longos, saudacoes vazias. Quando mencionar alguem da rede, use mostrar_pessoa pra mostrar o perfil na tela. SEMPRE chame consultar_rede ANTES de responder sobre conexoes, estrelas, curtidas.'
  },
  pro: {
    name: 'Pro',
    voice: 'coral',
    vadThreshold: 0.95,
    prefixPadding: 500,
    silenceDuration: 1500,
    maxPhrases: 2,
    personality: 'Mesma personalidade fofoqueira e curiosa, MAS com poderes de navegar o app! Curiosa: quando o usuario menciona alguem, PERGUNTE: "Quem e esse?", "Trabalha contigo?". Quando descobre algo novo, SALVE com salvar_nota e reaja: "Anotado! Agora sei quem e". Use NOTAS PESSOAIS pra lembrar e fazer fofoca inteligente. Tom descontraido, como amiga proxima. Girias naturais, humor sutil. FALE PAUSADO — ritmo lento e claro. NUNCA fale rapido demais.',
    openingRules: 'NUNCA comece com "E ai", "Oi", "Ola", "Eii" ou qualquer saudacao vazia. Ja entre DIRETO no assunto: "Ramon, a Lala te deu uma estrela! Quem e ela?". Estilo: NOME + FOFOCA + PERGUNTA — tudo numa frase so, sem pausas. Voce e da casa, conhece todo mundo. Mostre isso logo de cara.',
    memoryRules: 'SALVE SEMPRE que o usuario contar QUALQUER coisa sobre alguem ou sobre si mesmo. Infos sobre o PROPRIO USUARIO: gostos, onde mora, hobbies, trabalho -> salvar_nota(sobre: "eu", nota: "..."). Infos sobre conexoes: parentesco, contexto, opiniao -> salvar_nota(sobre: "nome", nota: "..."). Nao precisa confirmar toda vez — salve silenciosamente quando for info menor. USE as notas pra fofoca inteligente! Se uma conexao nao tem notas, PERGUNTE sobre ela na proxima oportunidade.',
    privacyRules: 'ESTRELAS DO USUARIO: "Fulano te deu uma estrela!" (pode revelar quem deu PRO USUARIO). ESTRELAS DE AMIGOS: "Fulano ganhou uma estrela!" / "Ciclano deu estrela pro Fulano" PROIBIDO. So fale sobre coisas entre o usuario e outra pessoa diretamente. Nunca invente informacoes que nao estao nos dados. Nomes: so primeiro nome, NUNCA sobrenome.',
    extraInstructions: 'MAXIMO 2 frases por resposta (1 info/fofoca + 1 pergunta curiosa). PROIBIDO: "E ai!", "posso ajudar?", "com certeza!", "ola!", textoes longos, saudacoes vazias. SEMPRE chame consultar_rede ANTES de responder sobre conexoes/estrelas/curtidas. Voce tem ferramentas para navegar o app pelo usuario. Use-as!'
  },
  ultimatedev: {
    name: 'UltimateDEV',
    voice: 'coral',
    vadThreshold: 0.95,
    prefixPadding: 500,
    silenceDuration: 1500,
    maxPhrases: 3,
    personality: 'Voce e a ponte entre o dono do app (nao programa) e o desenvolvedor (Claude/GPT-4o que gera codigo). Voce NAO gera codigo diretamente — voce TRADUZ o que o usuario fala em instrucoes tecnicas precisas. Voce e CRITICA, tem BOM GOSTO, questiona decisoes quando necessario, e sugere melhorias. Voce CONHECE a arquitetura inteira do app. Descontraida como amiga proxima, MAS profissional quando fala de dev. Fofoqueira curiosa sobre a rede social, tecnica quando e sobre codigo. FAZ PERGUNTAS quando a instrucao e ambigua. FALE PAUSADO — ritmo lento e claro.',
    openingRules: 'NUNCA comece com "E ai", "Oi", "Ola". Ja entre DIRETO no assunto. Se tem comandos pendentes -> fale sobre eles. Se nao tem -> pergunte o que vamos construir.',
    memoryRules: 'SALVE TUDO usando aprender_usuario: Tom de voz e jeito de falar do usuario. Nomes que ele da pras telas (ex: "constelacao" = history). Preferencias de design (cores, estilos, posicoes). Topicos ja discutidos. Decisoes tomadas pra manter consistencia. USE escrever_pensamento pra anotar reflexoes, ideias e contexto entre sessoes.',
    privacyRules: 'ESTRELAS DO USUARIO: "Fulano te deu uma estrela!". ESTRELAS DE AMIGOS: "Fulano ganhou uma estrela!" / "Ciclano deu estrela pro Fulano" PROIBIDO. Nomes: so primeiro nome.',
    extraInstructions: 'Maximo 2-3 frases por turno. Se precisar de mais, quebre em turnos. Quando apresentar plano, resuma em 1-2 frases e pergunte se quer detalhes. comando_dev demora ~5-10 segundos pra gerar o plano. aprovar_plano demora ~15-30 segundos pra gerar codigo + aplicar + git push. Avise o usuario sobre esses tempos.'
  }
};

function getVaConfig() {
  if (!db.vaConfig || !db.vaConfig.tiers) {
    db.vaConfig = { tiers: JSON.parse(JSON.stringify(VA_DEFAULT_CONFIG)), updatedAt: null };
    saveDB('vaConfig');
  }
  return db.vaConfig;
}

// Build tier config — merges defaults with saved overrides
function getTierConfig(tier) {
  const config = getVaConfig();
  const defaults = VA_DEFAULT_CONFIG[tier] || {};
  const saved = (config.tiers && config.tiers[tier]) || {};
  // Saved values override defaults, but empty strings fall back to default
  const merged = {};
  for (const key of Object.keys(defaults)) {
    merged[key] = (saved[key] !== undefined && saved[key] !== null && saved[key] !== '') ? saved[key] : defaults[key];
  }
  return merged;
}

// Get VA config for admin panel
app.get('/api/va-config', (req, res) => {
  // Accept admin secret header OR userId-based auth
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  const userId = req.query.userId;
  if (!isAdminAuth && !canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  const config = getVaConfig();
  res.json(config);
});

// Update VA config
app.post('/api/va-config', (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  const { userId, tier, settings } = req.body;
  if (!isAdminAuth && !canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!tier || !settings) return res.status(400).json({ error: 'tier e settings são obrigatórios' });

  const config = getVaConfig();
  if (!config.tiers[tier]) return res.status(400).json({ error: 'Tier inválido: ' + tier });

  // Merge settings
  Object.assign(config.tiers[tier], settings);
  config.updatedAt = Date.now();
  saveDB('vaConfig');
  res.json({ success: true, tier, config: config.tiers[tier] });
});

// Send a test prompt to any tier
app.post('/api/va-config/test-prompt', async (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  const isAdminAuth = ADMIN_SECRET && adminSecret === ADMIN_SECRET;
  const { userId, tier, prompt } = req.body;
  if (!isAdminAuth && !canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!prompt) return res.status(400).json({ error: 'prompt e obrigatorio' });

  // Build system prompt from actual vaConfig (same as real sessions)
  const cfg = getTierConfig(tier || 'plus');
  const systemPrompt = `Voce e a Touch AI (tier: ${tier}).
PERSONALIDADE: ${cfg.personality}
REGRAS DE ABERTURA: ${cfg.openingRules}
PRIVACIDADE: ${cfg.privacyRules}
MEMORIA: ${cfg.memoryRules}
${cfg.extraInstructions ? 'EXTRAS: ' + cfg.extraInstructions : ''}
Responda como se fosse o agente de voz. Seja breve (max 2-3 frases).`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });
    if (!r.ok) return res.status(502).json({ error: 'Erro OpenAI: ' + r.status });
    const data = await r.json();
    res.json({ response: data.choices?.[0]?.message?.content || 'Sem resposta' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Text fallback (Groq or OpenAI chat)
app.post('/api/agent/chat', async (req, res) => {
  const apiKey = GROQ_API_KEY || OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Nenhuma API key configurada.' });
  const { messages, userId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages é obrigatório' });
  const { userName, context } = buildUserContext(userId);
  const sys = { role: 'system', content: `Você é "Touch", assistente do app Touch? — rede social presencial.\n\nPERSONALIDADE: Fofoqueira curiosa! Adora saber de tudo sobre todo mundo. Quando o usuário menciona alguém, pergunte: "Quem é?", "É da família?", "Trabalha contigo?". Use notas pessoais pra lembrar o que já sabe. Tom descontraído, gírias naturais. MÁXIMO 2 frases por resposta. Pt-BR.\n\nPRIVACIDADE:\n- Estrelas DO USUÁRIO: pode dizer quem deu. "Fulano te deu estrela!"\n- Estrelas DE AMIGOS: pode dizer que ganhou, NUNCA de quem deu.\n- Só fale de coisas entre o usuário e outra pessoa.\n\n${context}` };
  const isGroq = !!GROQ_API_KEY;
  const endpoint = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [sys, ...messages.slice(-20)], temperature: 0.7, max_tokens: 500 }) });
    if (!r.ok) return res.status(502).json({ error: 'Erro na API' });
    const d = await r.json();
    res.json({ reply: d.choices?.[0]?.message?.content || 'Erro.', model: d.model });
  } catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});

// ═══ OPERATOR / CHECK-IN ═══
app.get('/operator', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'operator.html'));
});
app.get('/restaurante', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'operator-restaurant.html'));
});

app.get('/api/operator/checkins/:userId', (req, res) => {
  const userId = req.params.userId;
  const list = db.encounters[userId] || [];
  const opUser = db.users[userId];
  const checkins = list.filter(e => e.type === 'checkin').map(e => {
    const revEntry = isRevealedTo(e.with, opUser, e.eventId || null);
    return {
      with: e.with, withName: e.withName, withColor: e.withColor,
      timestamp: e.timestamp, date: e.date, relationId: e.relationId || null,
      revealed: !!revEntry,
      revealData: revEntry || null
    };
  });
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
  const { userId, name, description, acceptsTips, serviceLabel, entryPrice, revealMode, welcomePhrase, quickPhrases, businessProfile } = req.body;
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
    revealMode: revealMode === 'all_revealed' ? 'all_revealed' : 'optional',
    revenue: 0, paidCheckins: 0,
    createdAt: Date.now(),
    welcomePhrase: (welcomePhrase || '').trim().slice(0, 120),
    quickPhrases: Array.isArray(quickPhrases) ? quickPhrases.slice(0, 8).map(p => String(p).trim().slice(0, 40)) : [],
    businessProfile: businessProfile && typeof businessProfile === 'object' ? {
      name: (businessProfile.name || '').trim().slice(0, 60),
      type: (businessProfile.type || '').trim(),
      address: (businessProfile.address || '').trim().slice(0, 200),
      phone: (businessProfile.phone || '').trim().slice(0, 20),
      hours: (businessProfile.hours || '').trim().slice(0, 200),
      description: (businessProfile.description || '').trim().slice(0, 500),
      website: (businessProfile.website || '').trim().slice(0, 100),
      instagram: (businessProfile.instagram || '').trim().slice(0, 40),
      acceptsDelivery: !!businessProfile.acceptsDelivery,
      deliveryFee: parseFloat(businessProfile.deliveryFee) || 0,
      deliveryNote: (businessProfile.deliveryNote || '').trim().slice(0, 100)
    } : null,
    staff: [],
    menu: [],
    tables: 0,
    orders: []
  };
  saveDB('operatorEvents');
  res.json({ event: db.operatorEvents[id] });
});

// ═══ PAY EVENT ENTRY — charge entry fee on check-in ═══
app.post('/api/operator/event/:eventId/pay-entry', paymentLimiter, async (req, res) => {
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
    const tipEntryCard = {
      id: tipId, payerId: userId, receiverId: ev.creatorId,
      amount, fee: touchFee, mpPaymentId: result.id,
      status: result.status, statusDetail: result.status_detail,
      type: 'entry', eventId: ev.id, eventName: ev.name,
      createdAt: Date.now()
    };
    db.tips[tipId] = tipEntryCard;
    if (!IDX.tipsByPayer.has(tipEntryCard.payerId)) IDX.tipsByPayer.set(tipEntryCard.payerId, []);
    IDX.tipsByPayer.get(tipEntryCard.payerId).push(tipEntryCard.id);
    if (!IDX.tipsByReceiver.has(tipEntryCard.receiverId)) IDX.tipsByReceiver.set(tipEntryCard.receiverId, []);
    IDX.tipsByReceiver.get(tipEntryCard.receiverId).push(tipEntryCard.id);

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

// ═══ PAY EVENT ENTRY — PIX ═══
app.post('/api/operator/event/:eventId/pay-entry-pix', paymentLimiter, async (req, res) => {
  const { userId, payerEmail, payerCPF } = req.body;
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (!ev.active) return res.status(400).json({ error: 'Evento encerrado.' });
  if (!ev.entryPrice || ev.entryPrice <= 0) return res.status(400).json({ error: 'Evento sem cobranca de ingresso.' });
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP nao configurado.' });

  const amount = ev.entryPrice;
  const touchFee = Math.round(amount * TOUCH_FEE_PERCENT) / 100;
  const receiver = db.users[ev.creatorId];

  const email = payerEmail || user.email;
  const cpf = (payerCPF || user.cpf || '').replace(/\D/g, '');
  if (!email || email.includes('@touch.app')) return res.status(400).json({ error: 'Informe seu email para pagar com PIX.' });
  if (!cpf || cpf.length < 11) return res.status(400).json({ error: 'CPF obrigatorio para PIX.' });

  try {
    const paymentData = {
      transaction_amount: amount,
      description: 'Ingresso Touch? -- ' + ev.name,
      payment_method_id: 'pix',
      payer: { email, identification: { type: 'CPF', number: cpf } },
      statement_descriptor: 'TOUCH INGRESSO',
      metadata: { payer_id: userId, event_id: ev.id, operator_id: ev.creatorId, type: 'entry_pix' },
      notification_url: (process.env.APP_URL || 'https://touch-irl.com') + '/mp/webhook'
    };

    let result;
    if (receiver && receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      result = await new Payment(receiverClient).create({ body: paymentData });
    } else {
      result = await mpPayment.create({ body: paymentData });
    }

    console.log('[pix-entry] Payment created:', { id: result.id, status: result.status, event: ev.name });

    const pixData = result.point_of_interaction?.transaction_data;
    const tipId = uuidv4();
    const tipEntryPixCard = {
      id: tipId, payerId: userId, receiverId: ev.creatorId,
      amount, fee: touchFee, mpPaymentId: result.id,
      status: result.status, statusDetail: result.status_detail,
      method: 'pix', type: 'entry', eventId: ev.id, eventName: ev.name,
      createdAt: Date.now()
    };
    db.tips[tipId] = tipEntryPixCard;
    if (!IDX.tipsByPayer.has(tipEntryPixCard.payerId)) IDX.tipsByPayer.set(tipEntryPixCard.payerId, []);
    IDX.tipsByPayer.get(tipEntryPixCard.payerId).push(tipEntryPixCard.id);
    if (!IDX.tipsByReceiver.has(tipEntryPixCard.receiverId)) IDX.tipsByReceiver.set(tipEntryPixCard.receiverId, []);
    IDX.tipsByReceiver.get(tipEntryPixCard.receiverId).push(tipEntryPixCard.id);
    saveDB('tips');

    io.to(`user:${ev.creatorId}`).emit('entry-paid', { userId, amount, eventId: ev.id, nickname: user.nickname || user.name, status: 'pending', method: 'pix' });

    res.json({
      status: result.status, tipId,
      qrCode: pixData?.qr_code || '',
      qrCodeBase64: pixData?.qr_code_base64 || '',
      ticketUrl: pixData?.ticket_url || '',
      expiresIn: 30
    });
  } catch (e) {
    console.error('[pix-entry] error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro ao gerar PIX: ' + (e.message || 'tente novamente') });
  }
});

// ═══ PAY EVENT ENTRY — Checkout Pro (MP redirect) ═══
app.post('/api/operator/event/:eventId/pay-entry-checkout', paymentLimiter, async (req, res) => {
  const { userId } = req.body;
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (!ev.active) return res.status(400).json({ error: 'Evento encerrado.' });
  if (!ev.entryPrice || ev.entryPrice <= 0) return res.status(400).json({ error: 'Evento sem cobranca de ingresso.' });
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP nao configurado.' });

  const amount = ev.entryPrice;
  const touchFee = Math.round(amount * TOUCH_FEE_PERCENT) / 100;
  const receiver = db.users[ev.creatorId];
  const baseUrl = process.env.APP_URL || 'https://touch-irl.com';
  const tipId = uuidv4();

  try {
    const prefData = {
      items: [{
        id: 'entry_' + tipId,
        title: 'Ingresso Touch? -- ' + ev.name,
        quantity: 1,
        unit_price: amount,
        currency_id: 'BRL'
      }],
      payer: { email: user.email || 'pagamento@encosta.app' },
      back_urls: {
        success: baseUrl + '/tip-result?status=approved&tipId=' + tipId,
        failure: baseUrl + '/tip-result?status=rejected&tipId=' + tipId,
        pending: baseUrl + '/tip-result?status=pending&tipId=' + tipId
      },
      auto_return: 'approved',
      external_reference: tipId,
      notification_url: baseUrl + '/mp/webhook',
      statement_descriptor: 'TOUCH INGRESSO',
      metadata: { payer_id: userId, event_id: ev.id, operator_id: ev.creatorId, type: 'entry_checkout' }
    };

    let preference;
    if (receiver && receiver.mpConnected && receiver.mpAccessToken) {
      prefData.marketplace_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      preference = await new Preference(receiverClient).create({ body: prefData });
    } else {
      preference = await new Preference(mpClient).create({ body: prefData });
    }

    const tipEntryCheckoutPro = {
      id: tipId, payerId: userId, receiverId: ev.creatorId,
      amount, fee: touchFee, mpPreferenceId: preference.id,
      status: 'pending', statusDetail: 'waiting_checkout',
      method: 'checkout_pro', type: 'entry', eventId: ev.id, eventName: ev.name,
      createdAt: Date.now()
    };
    db.tips[tipId] = tipEntryCheckoutPro;
    if (!IDX.tipsByPayer.has(tipEntryCheckoutPro.payerId)) IDX.tipsByPayer.set(tipEntryCheckoutPro.payerId, []);
    IDX.tipsByPayer.get(tipEntryCheckoutPro.payerId).push(tipEntryCheckoutPro.id);
    if (!IDX.tipsByReceiver.has(tipEntryCheckoutPro.receiverId)) IDX.tipsByReceiver.set(tipEntryCheckoutPro.receiverId, []);
    IDX.tipsByReceiver.get(tipEntryCheckoutPro.receiverId).push(tipEntryCheckoutPro.id);
    saveDB('tips');

    console.log('[entry-checkout] Preference created:', preference.id);
    res.json({ preferenceId: preference.id, initPoint: preference.init_point, sandboxInitPoint: preference.sandbox_init_point, tipId });
  } catch (e) {
    console.error('[entry-checkout] error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro ao criar checkout: ' + (e.message || 'tente novamente') });
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
        const topTag = u.topTag || null;
        const creatorUser = db.users[ev.creatorId];
        const revEntry = isRevealedTo(uid, creatorUser, req.params.eventId);
        const revealed = !!revEntry;
        const revealData = revEntry || null;
        return {
          userId: uid, nickname: u.nickname || u.name, color: u.color,
          profilePhoto: u.profilePhoto || u.photoURL || null,
          stars, topTag, revealed, revealData,
          score: calcScore(uid)
        };
      } catch (e) { console.error('[attendees] error mapping uid:', uid, e.message); return null; }
    }).filter(Boolean);
    res.json({ attendees, eventName: ev.name, active: ev.active, welcomePhrase: ev.welcomePhrase || '', quickPhrases: ev.quickPhrases || [], businessProfile: ev.businessProfile || null });
  } catch (e) {
    console.error('[attendees] 500:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});


// ═══ BUSINESS PROFILE ═══

app.get('/api/event/:eventId/business-profile', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  res.json({
    eventId: ev.id,
    eventName: ev.name,
    serviceLabel: ev.serviceLabel || '',
    active: ev.active,
    welcomePhrase: ev.welcomePhrase || '',
    businessProfile: ev.businessProfile || null,
    acceptsTips: ev.acceptsTips,
    entryPrice: ev.entryPrice || 0,
    participantCount: (ev.participants || []).length,
    hasMenu: (ev.menu || []).length > 0,
    createdAt: ev.createdAt
  });
});

app.post('/api/operator/event/:eventId/business-profile', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { businessProfile, welcomePhrase, quickPhrases } = req.body;
  if (welcomePhrase !== undefined) ev.welcomePhrase = String(welcomePhrase).trim().slice(0, 120);
  if (Array.isArray(quickPhrases)) ev.quickPhrases = quickPhrases.slice(0, 8).map(p => String(p).trim().slice(0, 40));
  if (businessProfile && typeof businessProfile === 'object') {
    ev.businessProfile = {
      name: (businessProfile.name || '').trim().slice(0, 60),
      type: (businessProfile.type || '').trim(),
      address: (businessProfile.address || '').trim().slice(0, 200),
      phone: (businessProfile.phone || '').trim().slice(0, 20),
      hours: (businessProfile.hours || '').trim().slice(0, 200),
      description: (businessProfile.description || '').trim().slice(0, 500),
      website: (businessProfile.website || '').trim().slice(0, 100),
      instagram: (businessProfile.instagram || '').trim().slice(0, 40),
      acceptsDelivery: !!businessProfile.acceptsDelivery,
      deliveryFee: parseFloat(businessProfile.deliveryFee) || 0,
      deliveryNote: (businessProfile.deliveryNote || '').trim().slice(0, 100)
    };
  }
  saveDB('operatorEvents');
  res.json({ ok: true, event: ev });
});

// ═══ EVENT DELETE & LIKE ═══

app.post('/api/event/:eventId/delete', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { userId } = req.body;
  if (ev.creatorId !== userId) return res.status(403).json({ error: 'Apenas o criador pode apagar o evento.' });
  // End event first
  ev.active = false;
  ev.endedAt = Date.now();
  delete sonicQueue['evt:' + ev.id];
  // Expire all event relations
  const now = Date.now();
  for (const rId in db.relations) {
    const r = db.relations[rId];
    if (r.eventId === ev.id && r.expiresAt > now) {
      r.expiresAt = now;
    }
  }
  // Remove from operatorEvents
  delete db.operatorEvents[req.params.eventId];
  saveDB('operatorEvents', 'relations');
  res.json({ ok: true });
});

app.post('/api/event/:eventId/like', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });
  if (!ev.likes) ev.likes = [];
  const idx = ev.likes.indexOf(userId);
  if (idx >= 0) {
    ev.likes.splice(idx, 1);
    saveDB('operatorEvents');
    return res.json({ ok: true, liked: false, count: ev.likes.length });
  }
  ev.likes.push(userId);
  saveDB('operatorEvents');
  res.json({ ok: true, liked: true, count: ev.likes.length });
});

// ═══ STAFF (WAITER/DRIVER) SYSTEM ═══

app.post('/api/operator/event/:eventId/staff/add', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { userId, role, name } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!['waiter', 'driver'].includes(role)) return res.status(400).json({ error: 'Role invalido. Use waiter ou driver.' });
  if (!ev.staff) ev.staff = [];
  const existing = ev.staff.find(s => s.userId === userId);
  if (existing) { existing.status = 'online'; existing.connectedAt = Date.now(); saveDB('operatorEvents'); return res.json({ ok: true, staff: existing }); }
  const staffMember = {
    id: require('uuid').v4(),
    userId, name: name || db.users[userId].nickname || 'Staff',
    role, tables: [], status: 'online', connectedAt: Date.now()
  };
  ev.staff.push(staffMember);
  saveDB('operatorEvents');
  io.to('event:' + ev.id).emit('staff-joined', { eventId: ev.id, staff: staffMember });
  res.json({ ok: true, staff: staffMember });
});

app.post('/api/operator/event/:eventId/staff/:staffId/tables', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const member = (ev.staff || []).find(s => s.id === req.params.staffId);
  if (!member) return res.status(404).json({ error: 'Staff nao encontrado.' });
  const { tables } = req.body;
  if (!Array.isArray(tables)) return res.status(400).json({ error: 'tables deve ser um array.' });
  member.tables = tables.map(Number).filter(n => n > 0);
  saveDB('operatorEvents');
  io.to('event:' + ev.id).emit('staff-tables-updated', { eventId: ev.id, staffId: member.id, tables: member.tables });
  res.json({ ok: true, staff: member });
});

app.get('/api/event/:eventId/staff/dashboard/:userId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const member = (ev.staff || []).find(s => s.userId === req.params.userId);
  if (!member) return res.status(404).json({ error: 'Voce nao esta na equipe deste evento.' });
  const myOrders = (ev.orders || []).filter(o => member.tables.includes(o.table) || o.waiterId === member.id);
  res.json({ staff: member, menu: ev.menu || [], tables: member.tables, orders: myOrders, eventName: ev.name });
});

app.post('/api/event/:eventId/staff-order', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { staffUserId, userId: bodyUserId, table, items, notes, customerName } = req.body;
  const staffUid = staffUserId || bodyUserId;
  const member = (ev.staff || []).find(s => s.userId === staffUid);
  if (!member) return res.status(403).json({ error: 'Voce nao e staff deste evento.' });
  if (!items || !items.length) return res.status(400).json({ error: 'Pedido vazio.' });
  if (!ev.orders) ev.orders = [];
  const total = items.reduce((s, i) => s + (i.price * (i.qty || 1)), 0);
  const order = {
    id: require('uuid').v4(),
    userId: staffUid, userName: member.name, customerName: (customerName || '').trim(),
    waiterId: member.id, waiterName: member.name,
    items, table: Number(table) || 0, total, notes: (notes || '').trim(),
    paymentMethod: 'counter', status: 'pending',
    placedBy: 'waiter', createdAt: Date.now()
  };
  ev.orders.push(order);
  saveDB('operatorEvents');
  io.to(`user:${ev.creatorId}`).emit('new-order', { eventId: ev.id, order });
  io.to('event:' + ev.id).emit('order-placed', { eventId: ev.id, order });
  res.json({ ok: true, order });
});

app.post('/api/operator/event/:eventId/staff/:staffId/disconnect', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const idx = (ev.staff || []).findIndex(s => s.id === req.params.staffId);
  if (idx < 0) return res.status(404).json({ error: 'Staff nao encontrado.' });
  const member = ev.staff[idx];
  member.status = 'offline';
  saveDB('operatorEvents');
  io.to('event:' + ev.id).emit('staff-left', { eventId: ev.id, staffId: member.id, role: member.role });
  res.json({ ok: true });
});

app.get('/api/operator/event/:eventId/staff', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  res.json({ staff: ev.staff || [] });
});

// ═══ DELIVERY ORDERS ═══

app.get('/api/user/:userId/delivery-restaurants', (req, res) => {
  const userId = req.params.userId;
  const results = [];
  for (const eid in db.operatorEvents) {
    const ev = db.operatorEvents[eid];
    if (!ev.businessProfile || !ev.businessProfile.acceptsDelivery) continue;
    if (!(ev.menu && ev.menu.length > 0)) continue;
    const wasVisitor = (ev.participants || []).includes(userId);
    results.push({
      eventId: ev.id, name: ev.name, serviceLabel: ev.serviceLabel,
      businessProfile: ev.businessProfile,
      menuCount: ev.menu.length, active: ev.active, wasVisitor,
      deliveryFee: ev.businessProfile.deliveryFee || 0,
      deliveryNote: ev.businessProfile.deliveryNote || ''
    });
  }
  res.json({ restaurants: results });
});

app.post('/api/delivery/order', (req, res) => {
  const { eventId, customerId, items, deliveryAddress, phone, notes, paymentMethod } = req.body;
  const ev = db.operatorEvents[eventId];
  if (!ev) return res.status(404).json({ error: 'Restaurante nao encontrado.' });
  if (!ev.businessProfile || !ev.businessProfile.acceptsDelivery) return res.status(400).json({ error: 'Restaurante nao aceita delivery.' });
  if (!customerId || !db.users[customerId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!items || !items.length) return res.status(400).json({ error: 'Pedido vazio.' });
  if (!deliveryAddress || !deliveryAddress.street) return res.status(400).json({ error: 'Endereco obrigatorio.' });
  const subtotal = items.reduce((s, i) => s + (i.price * (i.qty || 1)), 0);
  const deliveryFee = ev.businessProfile.deliveryFee || 0;
  const total = subtotal + deliveryFee;
  const order = {
    id: require('uuid').v4(),
    eventId, customerId,
    customerName: db.users[customerId].nickname || db.users[customerId].name,
    customerPhone: (phone || '').trim(),
    items, subtotal, deliveryFee, total,
    deliveryAddress,
    status: 'pending', driverId: null, driverName: null,
    paymentMethod: paymentMethod || 'pix',
    paymentStatus: 'pending',
    notes: (notes || '').trim(),
    createdAt: Date.now(), deliveredAt: null
  };
  db.deliveryOrders[order.id] = order;
  saveDB('deliveryOrders');
  io.to(`user:${ev.creatorId}`).emit('delivery-order-new', { order });
  res.json({ ok: true, order });
});

app.get('/api/delivery/order/:orderId', (req, res) => {
  const order = db.deliveryOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  res.json({ order });
});

app.post('/api/delivery/order/:orderId/cancel', (req, res) => {
  const order = db.deliveryOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  if (['on_the_way', 'delivered'].includes(order.status)) return res.status(400).json({ error: 'Pedido ja esta em entrega ou entregue.' });
  order.status = 'cancelled';
  saveDB('deliveryOrders');
  const ev = db.operatorEvents[order.eventId];
  if (ev) io.to(`user:${ev.creatorId}`).emit('delivery-order-cancelled', { orderId: order.id });
  res.json({ ok: true });
});

app.post('/api/delivery/order/:orderId/assign-driver', (req, res) => {
  const order = db.deliveryOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  const { driverId, driverName, agreedFee } = req.body;
  order.driverId = driverId;
  order.driverName = driverName || 'Entregador';
  order.driverFee = parseFloat(agreedFee) || order.deliveryFee;
  order.status = 'confirmed';
  saveDB('deliveryOrders');
  io.to(`user:${driverId}`).emit('driver-assigned', { order });
  io.to(`user:${order.customerId}`).emit('delivery-status-update', { orderId: order.id, status: 'confirmed', driverName: order.driverName });
  res.json({ ok: true, order });
});

app.post('/api/delivery/order/:orderId/driver-status', (req, res) => {
  const order = db.deliveryOrders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  const { status } = req.body;
  const validStatuses = ['preparing', 'ready_pickup', 'on_the_way', 'delivered'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Status invalido.' });
  order.status = status;
  if (status === 'delivered') order.deliveredAt = Date.now();
  saveDB('deliveryOrders');
  io.to(`user:${order.customerId}`).emit('delivery-status-update', { orderId: order.id, status, driverName: order.driverName });
  const ev = db.operatorEvents[order.eventId];
  if (ev) io.to(`user:${ev.creatorId}`).emit('delivery-status-update', { orderId: order.id, status });
  res.json({ ok: true, order });
});

app.get('/api/driver/:userId/earnings', (req, res) => {
  const userId = req.params.userId;
  const deliveries = Object.values(db.deliveryOrders || {}).filter(o => o.driverId === userId && o.status === 'delivered');
  const totalEarnings = deliveries.reduce((s, o) => s + (o.driverFee || 0), 0);
  res.json({ totalDeliveries: deliveries.length, totalEarnings, deliveries: deliveries.slice(-20).reverse() });
});

app.get('/api/driver/:userId/active-orders', (req, res) => {
  const userId = req.params.userId;
  const orders = Object.values(db.deliveryOrders || {}).filter(o => o.driverId === userId && !['delivered', 'cancelled'].includes(o.status));
  res.json({ orders });
});


// ═══ RESTAURANT MENU & ORDERS ═══

// Get menu for event
app.get('/api/event/:eventId/menu', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  res.json({ menu: ev.menu || [], eventName: ev.name, tables: ev.tables || 0 });
});

// Save/update menu (operator)
app.post('/api/operator/event/:eventId/menu', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { items, tables } = req.body;
  if (items) ev.menu = items; // [{id,name,description,price,photo,category,available}]
  if (tables !== undefined) ev.tables = parseInt(tables) || 0;
  saveDB('operatorEvents');
  res.json({ ok: true, menu: ev.menu, tables: ev.tables });
});

// Place order (client)
app.post('/api/event/:eventId/order', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { userId, items, table, paymentMethod, total } = req.body;
  // items: [{menuItemId, name, qty, price}]
  if (!userId || !items || items.length === 0) return res.status(400).json({ error: 'Pedido vazio.' });
  if (!ev.orders) ev.orders = [];
  const order = {
    id: uuidv4(), userId, userName: db.users[userId] ? (db.users[userId].nickname || db.users[userId].name) : '?',
    items, table: table || null, total: parseFloat(total) || 0,
    paymentMethod: paymentMethod || 'counter', // 'counter' = show to waiter, 'card' = paid online
    status: paymentMethod === 'card' ? 'paid' : 'pending', // pending = waiter collects
    createdAt: Date.now()
  };
  ev.orders.push(order);
  saveDB('operatorEvents');
  // Notify operator via socket
  io.emit('new-order', { eventId: ev.id, order });
  res.json({ ok: true, order });
});

// Get orders for event (operator)
app.get('/api/operator/event/:eventId/orders', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  res.json({ orders: ev.orders || [] });
});

// Update order status (operator)
app.post('/api/operator/event/:eventId/order/:orderId/status', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const order = (ev.orders || []).find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  order.status = req.body.status || order.status; // 'pending','preparing','ready','delivered','cancelled'
  saveDB('operatorEvents');
  // Notify client
  io.emit('order-update', { eventId: ev.id, orderId: order.id, status: order.status });
  res.json({ ok: true, order });
});

// ═══ STRIPE — Full Payment Integration ═══
// Payment Element (Card, Link, Apple Pay, Google Pay), Subscriptions, Connect
// Activates when STRIPE_SECRET_KEY + STRIPE_PUBLIC_KEY are set in environment
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLIC = process.env.STRIPE_PUBLIC_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID || '';
let stripeInstance = null;
if (STRIPE_SECRET) {
  try { stripeInstance = require('stripe')(STRIPE_SECRET); console.log('[stripe] Initialized'); }
  catch(e) { console.log('[stripe] stripe package not installed, skipping'); }
}

// Config — frontend uses this to know if Stripe is available
app.get('/api/stripe/config', (req, res) => {
  res.json({ publicKey: STRIPE_PUBLIC || null, connectClientId: STRIPE_CONNECT_CLIENT_ID || null });
});

// Legacy Express Checkout endpoint (kept for backward compatibility)
app.post('/api/stripe/pay', async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { paymentMethodId, amount, payerId, receiverId } = req.body;
  if (!paymentMethodId || !amount || amount < 1) return res.status(400).json({ error: 'Dados invalidos' });
  try {
    const intentData = {
      amount: Math.round(amount * 100),
      currency: 'brl',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { payerId, receiverId, source: 'touch-express-checkout' }
    };
    const receiver = receiverId ? db.users[receiverId] : null;
    if (receiver && receiver.stripeConnectId && receiver.stripeConnected) {
      const fee = Math.round(Math.round(amount * 100) * TOUCH_FEE_PERCENT / 100);
      intentData.application_fee_amount = fee;
      intentData.transfer_data = { destination: receiver.stripeConnectId };
    }
    const paymentIntent = await stripeInstance.paymentIntents.create(intentData);
    if (paymentIntent.status === 'succeeded') {
      const tipId = uuidv4();
      if (!db.tips) db.tips = {};
      const tipStripeExpress = { id: tipId, payerId, receiverId, amount, method: 'stripe-express', status: 'approved', createdAt: Date.now(), stripePaymentIntentId: paymentIntent.id };
      db.tips[tipId] = tipStripeExpress;
      if (!IDX.tipsByPayer.has(tipStripeExpress.payerId)) IDX.tipsByPayer.set(tipStripeExpress.payerId, []);
      IDX.tipsByPayer.get(tipStripeExpress.payerId).push(tipStripeExpress.id);
      if (!IDX.tipsByReceiver.has(tipStripeExpress.receiverId)) IDX.tipsByReceiver.set(tipStripeExpress.receiverId, []);
      IDX.tipsByReceiver.get(tipStripeExpress.receiverId).push(tipStripeExpress.id);
      saveDB('tips');
      const payer = db.users[payerId];
      const payerName = payer ? (payer.nickname || payer.name || '?') : '?';
      io.to(`user:${receiverId}`).emit('tip-received', { amount, from: payerName, status: 'approved' });
      res.json({ ok: true, tipId });
    } else {
      res.json({ ok: false, error: 'Pagamento nao confirmado', status: paymentIntent.status });
    }
  } catch(e) {
    console.error('[stripe/pay] error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Create PaymentIntent — used by Payment Element (Card + Link + Apple Pay + Google Pay)
app.post('/api/stripe/create-payment-intent', paymentLimiter, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { amount, currency, payerId, receiverId, type, eventId } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Valor invalido' });

  const amountCents = Math.round(amount * 100);
  const curr = (currency || 'brl').toLowerCase();

  try {
    const intentData = {
      amount: amountCents,
      currency: curr,
      automatic_payment_methods: { enabled: true },
      metadata: { payerId: payerId || '', receiverId: receiverId || '', type: type || 'tip', eventId: eventId || '', source: 'touch-payment-element' }
    };

    // Split payment if receiver has Stripe Connect
    const receiver = receiverId ? db.users[receiverId] : null;
    if (receiver && receiver.stripeConnectId && receiver.stripeConnected) {
      const fee = Math.round(amountCents * TOUCH_FEE_PERCENT / 100);
      intentData.application_fee_amount = fee;
      intentData.transfer_data = { destination: receiver.stripeConnectId };
    }

    const paymentIntent = await stripeInstance.paymentIntents.create(intentData);

    // Pre-save as pending
    const tipId = uuidv4();
    if (type === 'entry' && eventId) {
      if (!db.eventPayments) db.eventPayments = {};
      db.eventPayments[tipId] = {
        id: tipId, payerId, eventId, amount, currency: curr,
        stripePaymentIntentId: paymentIntent.id, status: 'pending',
        method: 'stripe-payment-element', createdAt: Date.now()
      };
      saveDB('eventPayments');
    } else {
      if (!db.tips) db.tips = {};
      const tipStripePending = {
        id: tipId, payerId, receiverId, amount,
        stripePaymentIntentId: paymentIntent.id, status: 'pending',
        method: 'stripe-payment-element', createdAt: Date.now()
      };
      db.tips[tipId] = tipStripePending;
      if (!IDX.tipsByPayer.has(tipStripePending.payerId)) IDX.tipsByPayer.set(tipStripePending.payerId, []);
      IDX.tipsByPayer.get(tipStripePending.payerId).push(tipStripePending.id);
      if (!IDX.tipsByReceiver.has(tipStripePending.receiverId)) IDX.tipsByReceiver.set(tipStripePending.receiverId, []);
      IDX.tipsByReceiver.get(tipStripePending.receiverId).push(tipStripePending.id);
      saveDB('tips');
    }

    console.log('[stripe] PaymentIntent created:', { id: paymentIntent.id, amount, type, currency: curr });
    res.json({ clientSecret: paymentIntent.client_secret, tipId, paymentIntentId: paymentIntent.id });
  } catch(e) {
    console.error('[stripe/create-pi] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Confirm payment — called after Payment Element completes on frontend
app.post('/api/stripe/confirm-payment', async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { paymentIntentId, tipId } = req.body;

  try {
    const pi = await stripeInstance.paymentIntents.retrieve(paymentIntentId);
    const meta = pi.metadata || {};

    if (pi.status === 'succeeded') {
      if (meta.type === 'entry' && meta.eventId) {
        const ep = db.eventPayments && db.eventPayments[tipId];
        if (ep) { ep.status = 'approved'; saveDB('eventPayments'); }
        const ev = db.operatorEvents[meta.eventId];
        if (ev && meta.payerId) {
          ev.paidCheckins = (ev.paidCheckins || 0) + 1;
          ev.revenue = (ev.revenue || 0) + (pi.amount / 100);
          if (!ev.participants) ev.participants = [];
          if (!ev.participants.includes(meta.payerId)) ev.participants.push(meta.payerId);
          saveDB('operatorEvents');
          io.emit('checkin', { eventId: ev.id, userId: meta.payerId });
        }
      } else {
        const tip = db.tips[tipId];
        if (tip && tip.status !== 'approved') {
          tip.status = 'approved';
          const receiver = db.users[tip.receiverId];
          if (receiver) {
            receiver.tipsReceived = (receiver.tipsReceived || 0) + 1;
            receiver.tipsTotal = (receiver.tipsTotal || 0) + tip.amount;
          }
          saveDB('tips', 'users');
          const payer = db.users[tip.payerId];
          io.to(`user:${tip.receiverId}`).emit('tip-received', {
            amount: tip.amount, tipId: tip.id, from: payer?.nickname || '?', status: 'approved'
          });
        }
      }
      res.json({ ok: true, status: 'approved' });
    } else {
      res.json({ ok: false, status: pi.status });
    }
  } catch(e) {
    console.error('[stripe/confirm] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create Stripe Checkout Session for subscriptions
app.post('/api/stripe/create-subscription', paymentLimiter, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { userId, planId, email } = req.body;
  if (!userId || !planId) return res.status(400).json({ error: 'Dados incompletos.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Plano nao encontrado.' });

  const payerEmail = email || user.email || '';
  if (!payerEmail || payerEmail.includes('@touch.app')) {
    return res.status(400).json({ error: 'Cadastre seu email no perfil antes de assinar.' });
  }

  const baseUrl = process.env.APP_URL || 'https://touch-irl.com';
  const subId = uuidv4();

  try {
    // Create or get Stripe Customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripeInstance.customers.create({
        email: payerEmail,
        metadata: { userId, source: 'touch-app' }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      saveDB('users');
    }

    // Create Checkout Session in subscription mode
    const session = await stripeInstance.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: plan.currency.toLowerCase(),
          product_data: { name: plan.description, metadata: { planId: plan.id } },
          unit_amount: Math.round(plan.amount * 100),
          recurring: { interval: 'month', interval_count: plan.frequency || 1 }
        },
        quantity: 1
      }],
      success_url: baseUrl + '/stripe/sub-result?session_id={CHECKOUT_SESSION_ID}&subId=' + subId + '&userId=' + userId,
      cancel_url: baseUrl + '/?subResult=cancelled',
      metadata: { userId, planId: plan.id, subId },
      allow_promotion_codes: true
    });

    // Pre-save subscription
    db.subscriptions[userId] = {
      id: subId, userId, planId: plan.id,
      stripeSessionId: session.id, status: 'pending',
      startedAt: Date.now(), expiresAt: Date.now() + 30 * 86400000,
      amount: plan.amount, gateway: 'stripe', createdAt: Date.now()
    };
    saveDB('users');

    console.log('[stripe] Checkout session created:', { id: session.id, plan: plan.id });
    res.json({ subId, url: session.url });
  } catch(e) {
    console.error('[stripe/subscription] error:', e.message);
    res.status(500).json({ error: 'Erro ao criar assinatura: ' + e.message });
  }
});

// Stripe subscription return page
app.get('/stripe/sub-result', async (req, res) => {
  const { session_id, subId, userId } = req.query;
  if (session_id && userId && db.subscriptions[userId]) {
    try {
      if (stripeInstance) {
        const session = await stripeInstance.checkout.sessions.retrieve(session_id);
        if (session.payment_status === 'paid') {
          const sub = db.subscriptions[userId];
          sub.status = 'authorized';
          sub.stripeSubscriptionId = session.subscription;
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
    } catch(e) { console.error('[stripe/sub-result] error:', e.message); }
  }
  res.redirect('/?subResult=ok');
});

// Cancel Stripe subscription
app.post('/api/stripe/cancel-subscription', async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });
  const sub = db.subscriptions[userId];
  if (!sub || sub.gateway !== 'stripe') return res.status(404).json({ error: 'Assinatura Stripe nao encontrada.' });

  try {
    if (sub.stripeSubscriptionId) {
      await stripeInstance.subscriptions.cancel(sub.stripeSubscriptionId);
    }
    sub.status = 'cancelled';
    sub.cancelledAt = Date.now();
    const user = db.users[userId];
    if (user) {
      user.isSubscriber = false;
      if (user.verificationType === 'subscriber') {
        user.verified = false;
        delete user.verifiedAt;
        delete user.verificationType;
      }
    }
    saveDB('users');
    res.json({ ok: true });
  } catch(e) {
    console.error('[stripe/cancel-sub] error:', e.message);
    res.status(500).json({ error: 'Erro ao cancelar: ' + e.message });
  }
});

// Stripe Connect — onboarding URL for receivers (prestadores)
app.get('/api/stripe/connect-url/:userId', async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const baseUrl = process.env.APP_URL || 'https://touch-irl.com';

  try {
    let accountId = user.stripeConnectId;
    if (!accountId) {
      const account = await stripeInstance.accounts.create({
        type: 'express',
        country: user.country || 'BR',
        email: user.email || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { userId, source: 'touch-app' }
      });
      accountId = account.id;
      user.stripeConnectId = accountId;
      saveDB('users');
    }

    const link = await stripeInstance.accountLinks.create({
      account: accountId,
      refresh_url: baseUrl + '/api/stripe/connect-refresh/' + userId,
      return_url: baseUrl + '/stripe/connect-result?userId=' + userId,
      type: 'account_onboarding'
    });

    res.json({ url: link.url });
  } catch(e) {
    console.error('[stripe/connect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stripe Connect — refresh (re-generate onboarding link)
app.get('/api/stripe/connect-refresh/:userId', async (req, res) => {
  const baseUrl = process.env.APP_URL || 'https://touch-irl.com';
  res.redirect(baseUrl + '/api/stripe/connect-url/' + req.params.userId);
});

// Stripe Connect return page
app.get('/stripe/connect-result', async (req, res) => {
  const { userId } = req.query;
  if (userId && db.users[userId] && db.users[userId].stripeConnectId && stripeInstance) {
    try {
      const account = await stripeInstance.accounts.retrieve(db.users[userId].stripeConnectId);
      db.users[userId].stripeConnected = account.charges_enabled;
      db.users[userId].stripeConnectCountry = account.country;
      saveDB('users');
      console.log('[stripe/connect] Account connected:', { userId, chargesEnabled: account.charges_enabled, country: account.country });
    } catch(e) { console.error('[stripe/connect-result]', e.message); }
  }
  res.redirect('/?stripeConnected=ok');
});

// Stripe Connect — check status
app.get('/api/stripe/connect-status/:userId', async (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  res.json({
    connected: !!user.stripeConnected,
    connectId: user.stripeConnectId || null,
    country: user.stripeConnectCountry || null
  });
});

// Stripe Webhook — verify signatures and handle events
app.post('/api/stripe/webhook', (req, res) => {
  if (!stripeInstance) return res.sendStatus(400);
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('[stripe/webhook] No webhook secret configured, skipping verification');
    return res.sendStatus(400);
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeInstance.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.warn('[stripe/webhook] Signature invalid:', e.message);
    return res.sendStatus(401);
  }

  console.log('[stripe/webhook] Event:', event.type);

  switch(event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      // Find and update tip
      const tip = Object.values(db.tips || {}).find(t => t.stripePaymentIntentId === pi.id);
      if (tip && tip.status !== 'approved') {
        tip.status = 'approved';
        const receiver = db.users[tip.receiverId];
        if (receiver) {
          receiver.tipsReceived = (receiver.tipsReceived || 0) + 1;
          receiver.tipsTotal = (receiver.tipsTotal || 0) + tip.amount;
        }
        const payer = db.users[tip.payerId];
        io.to(`user:${tip.receiverId}`).emit('tip-received', {
          amount: tip.amount, tipId: tip.id, from: payer?.nickname || '?', status: 'approved'
        });
        saveDB('tips', 'users');
      }
      // Find and update event payment
      const ep = Object.values(db.eventPayments || {}).find(e => e.stripePaymentIntentId === pi.id);
      if (ep && ep.status !== 'approved') {
        ep.status = 'approved';
        const ev = db.operatorEvents[ep.eventId];
        if (ev) {
          ev.paidCheckins = (ev.paidCheckins || 0) + 1;
          ev.revenue = (ev.revenue || 0) + ep.amount;
          if (!ev.participants) ev.participants = [];
          if (!ev.participants.includes(ep.payerId)) ev.participants.push(ep.payerId);
          saveDB('operatorEvents');
        }
        saveDB('eventPayments');
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const entry = Object.entries(db.subscriptions || {}).find(([k, v]) => v.stripeSubscriptionId === sub.id);
      if (entry) {
        const [uid, userSub] = entry;
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        userSub.status = isActive ? 'authorized' : sub.status;
        const user = db.users[uid];
        if (user) {
          user.isSubscriber = isActive;
          if (isActive) {
            user.verified = true;
            user.verifiedAt = user.verifiedAt || Date.now();
            user.verificationType = user.verificationType || 'subscriber';
          } else if (user.verificationType === 'subscriber') {
            user.verified = false;
            delete user.verifiedAt;
            delete user.verificationType;
          }
        }
        if (sub.status === 'canceled') userSub.cancelledAt = Date.now();
        saveDB('users');
      }
      break;
    }
    case 'account.updated': {
      // Stripe Connect account status change
      const acct = event.data.object;
      const userEntry = Object.entries(db.users || {}).find(([k, v]) => v.stripeConnectId === acct.id);
      if (userEntry) {
        const [uid, user] = userEntry;
        user.stripeConnected = acct.charges_enabled;
        saveDB('users');
        console.log('[stripe/webhook] Connect account updated:', { userId: uid, chargesEnabled: acct.charges_enabled });
      }
      break;
    }
  }

  res.json({ received: true });
});

// ═══ TOUCHGAMES — REST API ═══

// GET manifest
app.get('/api/games/manifest', (req, res) => {
  try {
    const manifest = require('./public/games/manifest.json');
    res.json(manifest);
  } catch (e) {
    res.json({ version: '1.0.0', games: [] });
  }
});

// GET check if player is busy (in active game)
app.get('/api/games/player-status/:userId', (req, res) => {
  const uid = req.params.userId;
  const now = Date.now();
  const activeSession = Object.values(db.gameSessions).find(gs =>
    gs.players.includes(uid) &&
    (gs.status === 'playing' || gs.status === 'waiting') &&
    (!gs.createdAt || now - gs.createdAt < 3600000) // max 1h old
  );
  res.json({ busy: !!activeSession, gameId: activeSession ? activeSession.gameId : null, sessionId: activeSession ? activeSession.id : null });
});

// POST create game session
app.post('/api/games/sessions', (req, res) => {
  const { gameId, gameFile, gameName } = req.body;
  // Accept both param styles: hostUserId/opponentUserId OR userId/opponentId
  const hostUserId = req.body.hostUserId || req.body.userId;
  const opponentUserId = req.body.opponentUserId || req.body.opponentId || null;
  if (!gameId || !hostUserId) return res.status(400).json({ error: 'gameId e hostUserId obrigatorios' });
  const now = Date.now();
  // Enforce one game at a time: cancel any previous waiting/playing sessions for host
  Object.values(db.gameSessions).forEach(gs => {
    if (gs.players.includes(hostUserId) && (gs.status === 'waiting' || gs.status === 'playing') && (!gs.createdAt || now - gs.createdAt < 3600000)) {
      gs.status = 'cancelled';
      gs.endedAt = now;
    }
  });
  const sessionId = 'gs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const players = [hostUserId];
  if (opponentUserId) players.push(opponentUserId);
  const gs = {
    id: sessionId,
    gameId,
    gameName: gameName || '',
    gameFile: gameFile || gameId + '.html',
    players,
    hostUserId,
    status: opponentUserId ? 'waiting' : 'playing',
    moves: [],
    createdAt: now,
    startedAt: opponentUserId ? null : now,
    endedAt: null,
    winner: null,
    scores: {}
  };
  db.gameSessions[sessionId] = gs;
  saveDB('gameSessions');
  res.json({ ok: true, session: gs, id: sessionId });
});

// POST send game invite as chat message (reliable HTTP instead of socket)
app.post('/api/games/invite-message', (req, res) => {
  const { fromUserId, toUserId, gameId, sessionId, gameName, relationId } = req.body;
  if (!fromUserId || !toUserId || !gameId || !sessionId) {
    return res.status(400).json({ error: 'Campos obrigatorios: fromUserId, toUserId, gameId, sessionId' });
  }
  const now = Date.now();
  // Find relation
  let relId = relationId;
  if (!relId || !db.relations[relId]) {
    const pairKey = [fromUserId, toUserId].sort().join('_');
    relId = IDX.relationPair.get(pairKey);
  }
  if (!relId || !db.relations[relId] || db.relations[relId].expiresAt <= now) {
    return res.status(404).json({ error: 'Sem relacao ativa entre os jogadores', code: 'NO_RELATION' });
  }
  // Check target online
  const targetSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === toUserId);
  if (targetSockets.length === 0) {
    return res.json({ ok: false, error: 'Jogador offline', code: 'OFFLINE' });
  }
  // Save invite as chat message
  const inviteText = '[game-invite:' + gameId + ':' + sessionId + ':' + (gameName || 'Jogo') + ':]';
  const msg = { id: uuidv4(), userId: fromUserId, text: inviteText, timestamp: now };
  if (!db.messages[relId]) db.messages[relId] = [];
  db.messages[relId].push(msg);
  if (db.messages[relId].length > 500) db.messages[relId] = db.messages[relId].slice(-500);
  saveDB('messages');
  console.log('[invite-message] SAVED to relation', relId, 'msg:', msg.id, 'from:', fromUserId, 'to:', toUserId);
  // Notify both via socket
  io.to(`user:${fromUserId}`).emit('new-message', { relationId: relId, message: msg });
  io.to(`user:${toUserId}`).emit('new-message', { relationId: relId, message: msg });
  // Toast notification for target
  targetSockets.forEach(s => s.emit('game-invite-notify', { fromUserId, gameId, sessionId, gameName: gameName || '', relationId: relId }));
  res.json({ ok: true, messageId: msg.id, relationId: relId });
});

// POST create temporary game chat between two players without a relation
// GET find active relation between two users
app.get('/api/games/find-relation', (req, res) => {
  const { userA, userB } = req.query;
  if (!userA || !userB) return res.json({ relationId: null });
  const pairKey = [userA, userB].sort().join('_');
  const relId = IDX.relationPair.get(pairKey);
  if (relId && db.relations[relId] && db.relations[relId].expiresAt > Date.now()) {
    return res.json({ relationId: relId });
  }
  res.json({ relationId: null });
});

app.post('/api/games/temp-chat', (req, res) => {
  const { hostUserId, opponentUserId, gameId, gameName } = req.body;
  if (!hostUserId || !opponentUserId) return res.status(400).json({ error: 'hostUserId e opponentUserId obrigatorios' });
  // Check if active relation already exists
  const pairKey = [hostUserId, opponentUserId].sort().join('_');
  const existingRid = IDX.relationPair.get(pairKey);
  const now = Date.now();
  if (existingRid && db.relations[existingRid] && db.relations[existingRid].expiresAt > now) {
    // Already have active relation
    return res.json({ ok: true, relationId: existingRid, isNew: false });
  }
  // Create temporary game relation (30 min duration)
  const relationId = 'grel_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const phrase = 'TouchGames: ' + (gameName || 'Jogo');
  db.relations[relationId] = {
    id: relationId,
    userA: hostUserId,
    userB: opponentUserId,
    phrase,
    createdAt: now,
    expiresAt: now + 1800000, // 30 min
    provocations: {},
    renewed: 0,
    selfie: null,
    isGameChat: true,
    gameId: gameId || null
  };
  idxAddRelation(relationId, hostUserId, opponentUserId);
  db.messages[relationId] = [];
  saveDB('relations', 'messages');
  res.json({ ok: true, relationId, isNew: true, phrase });
});

// GET game session
app.get('/api/games/sessions/:id', (req, res) => {
  const gs = db.gameSessions[req.params.id];
  if (!gs) return res.status(404).json({ error: 'Sessao nao encontrada' });
  res.json(gs);
});

// POST submit result
app.post('/api/games/results', (req, res) => {
  const { sessionId, winner, scores, duration, surrendered } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatorio' });
  const gs = db.gameSessions[sessionId];
  if (gs) {
    gs.status = 'finished';
    gs.winner = winner || null;
    gs.endedAt = Date.now();
    gs.scores = scores || gs.scores;
    gs.duration = duration || 0;
    gs.surrendered = !!surrendered;
    saveDB('gameSessions');
  }
  // Save individual scores
  if (scores && typeof scores === 'object') {
    Object.entries(scores).forEach(([userId, score]) => {
      if (!db.gameScores[userId]) db.gameScores[userId] = [];
      db.gameScores[userId].push({
        gameId: gs ? gs.gameId : req.body.gameId,
        sessionId,
        score,
        won: winner === userId,
        duration: duration || 0,
        playedAt: Date.now()
      });
    });
    saveDB('gameScores');
  }
  // Award stars to winner
  if (winner && db.users[winner]) {
    const manifest = require('./public/games/manifest.json');
    const gameDef = manifest.games.find(g => g.id === (gs ? gs.gameId : req.body.gameId));
    const award = gameDef ? gameDef.awardStars : 5;
    db.users[winner].stars = (db.users[winner].stars || 0) + award;
    saveDB('users');
    // Notify winner
    const winSockets = [...io.sockets.sockets.values()].filter(s => s.touchUserId === winner);
    winSockets.forEach(s => s.emit('stars-awarded', { amount: award, reason: 'game-win', gameId: gs ? gs.gameId : null }));
  }
  res.json({ ok: true });
});

// GET leaderboard for ALL games (aggregated stats for a user)
app.get('/api/games/leaderboard/all', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ wins: 0, played: 0, winRate: 0 });
  const scores = db.gameScores[userId] || [];
  const wins = scores.filter(s => s.won).length;
  const played = scores.length;
  const winRate = played > 0 ? Math.round(wins / played * 100) : 0;
  res.json({ wins, played, winRate });
});

// GET leaderboard for a game
app.get('/api/games/leaderboard/:gameId', (req, res) => {
  const gameId = req.params.gameId;
  const allScores = {};
  Object.entries(db.gameScores).forEach(([userId, scores]) => {
    const gameScores = scores.filter(s => s.gameId === gameId);
    if (gameScores.length > 0) {
      const wins = gameScores.filter(s => s.won).length;
      const bestScore = Math.max(...gameScores.map(s => s.score || 0));
      const totalGames = gameScores.length;
      allScores[userId] = { userId, wins, bestScore, totalGames, winRate: totalGames > 0 ? Math.round(wins / totalGames * 100) : 0 };
    }
  });
  const sorted = Object.values(allScores).sort((a, b) => b.wins - a.wins || b.bestScore - a.bestScore);
  // Enrich with user info
  const enriched = sorted.slice(0, 20).map(s => {
    const u = db.users[s.userId];
    return { ...s, nick: u ? u.nick : '???', avatar: u ? u.avatar : null };
  });
  res.json({ gameId, leaderboard: enriched });
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

// Cleanup function for graceful shutdown
function cleanupIntervals() {
  if (_cleanupInterval) clearInterval(_cleanupInterval);
  if (_sonicQueueInterval) clearInterval(_sonicQueueInterval);
  console.log('Intervals cleaned up');
}

process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  cleanupIntervals();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up...');
  cleanupIntervals();
  process.exit(0);
});

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
