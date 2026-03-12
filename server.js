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
const compression = require('compression');

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
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://sdk.mercadopago.com", "https://http2.mlstatic.com", "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://apis.google.com", "https://www.gstatic.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://www.google.com", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      connectSrc: ["'self'", "https:", "wss:", "ws:"],
      frameSrc: ["'self'", "https://sdk.mercadopago.com", "https://accounts.google.com", "https://*.firebaseapp.com", "https://www.google.com", "https://js.stripe.com", "https://*.stripe.com"],
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

const muralLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: { error: 'Muitas requisicoes ao mural. Aguarde.' }
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

// ── GZIP compression: reduces ~1.2MB index.html to ~200KB (critical for scale) ──
app.use(compression({ level: 6, threshold: 1024 }));

// ── Cache control: no-cache for HTML, long cache for static assets ──
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
// Storage proxy (serve Firebase Storage images without CORS issues)
setupStorageProxy(app);
// Serve .well-known for Apple Pay domain verification (dotfiles need explicit route)
app.use('/.well-known', express.static(path.join(__dirname, 'public', '.well-known'), { dotfiles: 'allow' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML = no-cache (always fresh), assets (JS/CSS/images) = cache 1 day
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('service-worker.js')) {
      // Service worker must never be cached by the browser
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (filePath.endsWith('manifest.json') && !filePath.includes('games')) {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
  }
}));

// ── Input sanitization helpers ──
function sanitizeStr(s, maxLen = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>]/g, '').trim().slice(0, maxLen);
}
// Resolve current nickname from db.users (avoids stale snapshots in encounters)
function currentNick(userId, fallback) {
  const u = db.users[userId];
  return u ? (u.nickname || u.name || fallback || '?') : (fallback || '?');
}
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}
function isValidUUID(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

// ── Site white-label utils ──
const RESERVED_SLUGS = new Set(['admin','api','s','site','operator','terms','privacy','termos','privacidade','sobre','app','www','mail','ftp','blog','help','support','status','dashboard','login','signup','register','settings','billing','checkout','pay','webhook','webhooks','static','assets','cdn','img','images','css','js','fonts','media']);

function isValidSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 3 || slug.length > 64) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  return true;
}

function isSlugAvailable(slug) {
  for (const id of Object.keys(db.operatorEvents)) {
    const ev = db.operatorEvents[id];
    if (ev.siteConfig && ev.siteConfig.slug === slug) return false;
  }
  return true;
}

function generateSlugFromName(name) {
  return String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isValidColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

function isValidDomain(domain) {
  if (typeof domain !== 'string') return false;
  if (domain.length < 4 || domain.length > 253) return false;
  if (/\.touch-irl\.com$/i.test(domain)) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

// ── Cloudflare DNS Manager (for custom domains) ──
const CF_API = 'https://api.cloudflare.com/client/v4';
async function cfRequest(method, path, body) {
  const apiKey = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_ACCOUNT_EMAIL;
  if (!apiKey || !email) throw new Error('Cloudflare API not configured');
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(CF_API + path, opts);
  const data = await r.json();
  if (!data.success) throw new Error('Cloudflare API error: ' + JSON.stringify(data.errors));
  return data;
}

async function addCloudflareCNAME(domain) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) throw new Error('CLOUDFLARE_ZONE_ID not set');
  const data = await cfRequest('POST', '/zones/' + zoneId + '/dns_records', {
    type: 'CNAME', name: domain, content: 'touch-irl.com', ttl: 1, proxied: true
  });
  return data.result.id;
}

async function deleteCloudflareDNS(recordId) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  await cfRequest('DELETE', '/zones/' + zoneId + '/dns_records/' + recordId);
}

async function setupCustomDomainAsync(eventId, domain) {
  try {
    console.log('[cloudflare] Setting up domain:', domain, 'for event:', eventId);
    const recordId = await addCloudflareCNAME(domain);
    const ev = db.operatorEvents[eventId];
    if (ev && ev.siteConfig) {
      ev.siteConfig.customDomainStatus = 'verified';
      if (db.customDomains[domain]) {
        db.customDomains[domain].cloudflareRecordId = recordId;
        db.customDomains[domain].dnsVerified = true;
        db.customDomains[domain].status = 'verified';
      }
      saveDB('operatorEvents', 'customDomains');
      io.to(ev.creatorId).emit('site-domain-status', { eventId, domain, status: 'verified' });
      console.log('[cloudflare] Domain verified:', domain);
    }
  } catch (err) {
    console.error('[cloudflare] Setup failed for', domain, ':', err.message);
    const ev = db.operatorEvents[eventId];
    if (ev && ev.siteConfig) {
      ev.siteConfig.customDomainStatus = 'failed';
      if (db.customDomains[domain]) db.customDomains[domain].status = 'failed';
      saveDB('operatorEvents', 'customDomains');
      io.to(ev.creatorId).emit('site-domain-status', { eventId, domain, status: 'failed', error: err.message });
    }
  }
}

// ═══ i18n: Load translated phrases ═══
function loadI18nPhrases() {
  const i18nDir = path.join(__dirname, 'i18n');
  const langs = ['pt-br', 'en', 'es', 'ja', 'ru'];
  const phrasesI18n = {};
  const zodiacI18n = {};

  langs.forEach(lang => {
    try {
      const pFile = path.join(i18nDir, 'phrases-' + lang + '.json');
      if (fs.existsSync(pFile)) {
        phrasesI18n[lang] = JSON.parse(fs.readFileSync(pFile, 'utf8'));
      }
    } catch (e) { console.warn('i18n: failed to load phrases-' + lang + '.json'); }

    try {
      const zFile = path.join(i18nDir, 'zodiac-' + lang + '.json');
      if (fs.existsSync(zFile)) {
        zodiacI18n[lang] = JSON.parse(fs.readFileSync(zFile, 'utf8'));
      }
    } catch (e) { console.warn('i18n: failed to load zodiac-' + lang + '.json'); }
  });

  return { phrasesI18n, zodiacI18n };
}

const { phrasesI18n, zodiacI18n } = loadI18nPhrases();

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

// ── White-label site middleware: subdomain + custom domain + /s/:slug routing ──
function findEventBySlug(slug) {
  for (const id of Object.keys(db.operatorEvents)) {
    const ev = db.operatorEvents[id];
    if (ev.siteConfig && ev.siteConfig.enabled && ev.siteConfig.slug === slug) return ev;
  }
  return null;
}

function findEventByCustomDomain(domain) {
  const domainEntry = db.customDomains && db.customDomains[domain.toLowerCase()];
  if (!domainEntry || domainEntry.status !== 'verified') return null;
  return db.operatorEvents[domainEntry.eventId] || null;
}

function serveSiteTemplate(res, ev) {
  const sc = ev.siteConfig || {};
  const safeConfig = JSON.stringify({
    eventId: ev.id,
    slug: sc.slug,
    name: ev.businessProfile ? ev.businessProfile.name || ev.name : ev.name,
    primaryColor: sc.primaryColor || '#ff6b35',
    backgroundColor: sc.backgroundColor || '#0a0a0f',
    heroText: sc.heroText || '',
    logo: ev.eventLogo || null,
    modules: ev.modules || {},
    hours: ev.businessProfile ? ev.businessProfile.hours || '' : '',
    phone: ev.businessProfile ? ev.businessProfile.phone || '' : '',
    address: ev.businessProfile ? ev.businessProfile.address || '' : '',
    instagram: ev.businessProfile ? ev.businessProfile.instagram || '' : '',
    website: ev.businessProfile ? ev.businessProfile.website || '' : '',
    acceptsTips: ev.acceptsTips || false
  }).replace(/</g, '\\u003c');
  const templatePath = path.join(__dirname, 'public', 'site-template.html');
  const fs = require('fs');
  if (!fs.existsSync(templatePath)) return res.status(404).send('Site template not found');
  let html = fs.readFileSync(templatePath, 'utf-8');
  html = html.replace('/*__SITE_CONFIG__*/', 'window.__SITE_CONFIG__=' + safeConfig + ';');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(html);
}

// Subdomain detection middleware
// IMPORTANT: Skip API, socket.io and static asset paths so they reach the correct handlers
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/api/') || p.startsWith('/socket.io/') || p.startsWith('/s/') || p === '/favicon.ico') return next();
  const host = (req.hostname || req.headers.host || '').toLowerCase().split(':')[0];
  // Check subdomain: xxx.touch-irl.com
  const subMatch = host.match(/^([a-z0-9-]+)\.touch-irl\.com$/);
  if (subMatch && subMatch[1] !== 'www' && subMatch[1] !== 'api') {
    const ev = findEventBySlug(subMatch[1]);
    if (ev) return serveSiteTemplate(res, ev);
  }
  // Check custom domain
  if (host && !host.includes('touch-irl.com') && !host.includes('onrender.com') && !host.includes('localhost')) {
    const ev = findEventByCustomDomain(host);
    if (ev) return serveSiteTemplate(res, ev);
  }
  next();
});

// Path-based site access: /s/:slug
app.get('/s/:slug', (req, res) => {
  const ev = findEventBySlug(req.params.slug);
  if (!ev) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  serveSiteTemplate(res, ev);
});

// Clean URL routes for static pages
app.get('/site', (req, res) => res.sendFile(path.join(__dirname, 'public', 'site.html')));
app.get('/sobre', (req, res) => res.sendFile(path.join(__dirname, 'public', 'site.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidade.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

// ── Waitlist endpoint (email capture for early access) ──
app.post('/api/waitlist', express.json(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    // Store in Firebase RTDB
    const admin = require('firebase-admin');
    if (admin.apps.length) {
      const db = admin.database();
      await db.ref('waitlist').push({
        email: email.toLowerCase().trim(),
        source: 'site',
        createdAt: new Date().toISOString(),
        ip: req.ip
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Waitlist error:', err.message);
    res.json({ ok: true }); // Always return success to client
  }
});

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
    return `/api/storage/${filePath}`;
  } catch (e) {
    console.error('❌ Storage upload error:', e.message);
    return null; // fallback: caller keeps base64
  }
}

// ── Storage URL helper (convert old GCS URLs to proxy) ──
function proxyStorageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  // Convert https://storage.googleapis.com/BUCKET/path to /api/storage/path
  const prefix = 'https://storage.googleapis.com/' + (storageBucket ? storageBucket.name + '/' : '');
  if (url.startsWith(prefix)) {
    return '/api/storage/' + url.substring(prefix.length);
  }
  return url;
}

// ── Storage proxy (avoids CORS issues with Firebase Storage) ──
function setupStorageProxy(app) {
  app.get('/api/storage/*', async (req, res) => {
    try {
      const filePath = req.params[0];
      if (!filePath || filePath.includes('..')) return res.status(400).send('Invalid path');
      const file = storageBucket.file(filePath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).send('Not found');
      const [metadata] = await file.getMetadata();
      res.set('Content-Type', metadata.contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Access-Control-Allow-Origin', '*');
      file.createReadStream().pipe(res);
    } catch (e) {
      console.error('[storage-proxy]', e.message);
      res.status(500).send('Error');
    }
  });
}

// ── Database (in-memory cache synced with Firebase Realtime Database) ──
// PERF: 'messages' is LAZY-LOADED from Firebase on demand (biggest collection by far)
// This saves ~40% RAM at scale (5M messages = 1.2GB saved)
const DB_COLLECTIONS = ['users', 'sessions', 'relations', 'messages', 'encounters', 'gifts', 'declarations', 'events', 'checkins', 'tips', 'streaks', 'locations', 'revealRequests', 'likes', 'starDonations', 'operatorEvents', 'docVerifications', 'faceData', 'gameConfig', 'subscriptions', 'verifications', 'faceAccessLog', 'gameSessions', 'gameScores', 'ultimateBank', 'vaConfig', 'vaConversations', 'deliveryOrders', 'muralPosts', 'muralFlags', 'eventPayments', 'payouts', 'customDomains', 'sitePayments'];
const LAZY_COLLECTIONS = ['messages']; // loaded on demand, not on startup
const EAGER_COLLECTIONS = DB_COLLECTIONS.filter(c => !LAZY_COLLECTIONS.includes(c));

// ── Lazy message loading: fetch from Firebase on demand, LRU eviction ──
const _msgCache = new Set(); // tracks which relationIds have been loaded from Firebase
const MSG_CACHE_MAX = 5000; // max relations to keep in memory
const MSG_CACHE_TTL = 30 * 60 * 1000; // 30 min eviction for inactive chats
const _msgLastAccess = new Map(); // relationId -> last access timestamp

async function ensureMessages(relationId) {
  if (_msgCache.has(relationId)) {
    _msgLastAccess.set(relationId, Date.now());
    return db.messages[relationId] || [];
  }
  try {
    const snap = await rtdb.ref('messages/' + relationId).once('value');
    const data = snap.val();
    db.messages[relationId] = Array.isArray(data) ? data : [];
    _msgCache.add(relationId);
    _msgLastAccess.set(relationId, Date.now());
    // LRU eviction if cache too large
    if (_msgCache.size > MSG_CACHE_MAX) {
      _evictStaleMessages();
    }
    return db.messages[relationId];
  } catch (e) {
    console.error('[msg-cache] Firebase fetch failed for ' + relationId + ':', e.message);
    return db.messages[relationId] || [];
  }
}

function _evictStaleMessages() {
  const now = Date.now();
  const toEvict = [];
  for (const [relId, lastAccess] of _msgLastAccess) {
    if (now - lastAccess > MSG_CACHE_TTL) {
      toEvict.push(relId);
    }
  }
  // If not enough stale, evict oldest accessed
  if (toEvict.length < MSG_CACHE_MAX * 0.2) {
    const sorted = [..._msgLastAccess.entries()].sort((a, b) => a[1] - b[1]);
    const extra = sorted.slice(0, Math.floor(MSG_CACHE_MAX * 0.3)).map(e => e[0]);
    extra.forEach(id => { if (!toEvict.includes(id)) toEvict.push(id); });
  }
  toEvict.forEach(relId => {
    delete db.messages[relId];
    _msgCache.delete(relId);
    _msgLastAccess.delete(relId);
  });
  console.log('[msg-cache] Evicted ' + toEvict.length + ' stale message caches. Active: ' + _msgCache.size);
}

// Periodic message cache cleanup (every 5 min)
setInterval(() => {
  if (_msgCache.size > 100) _evictStaleMessages();
}, 5 * 60 * 1000);

let db = {};
DB_COLLECTIONS.forEach(c => db[c] = {});
let dbLoaded = false;
let saveTimer = null;
let registrationCounter = 0; // global signup order

// ── Top Tag Calculation ──
// calculateTopTag — based on stars ranking, respects enabled tiers from config
// 'rank' = position in stars-sorted list (1 = most stars)
// 'enabledTiers' = array of tier tags that are currently active (e.g. ['top1','top5'])
function calculateTopTag(rank, totalUsers, enabledTiers) {
  const allTiers = [
    { max: 1, tag: 'top1', needTotal: 5 },
    { max: 5, tag: 'top5', needTotal: 50 },
    { max: 50, tag: 'top50', needTotal: 100 },
    { max: 100, tag: 'top100', needTotal: 1000 },
    { max: 1000, tag: 'top1000', needTotal: 5000 },
    { max: 5000, tag: 'top5000', needTotal: 10000 },
    { max: 10000, tag: 'top10000', needTotal: 100000 },
    { max: 100000, tag: 'top100000', needTotal: 200000 }
  ];
  // Only consider tiers that are enabled in config
  const enabled = enabledTiers || ['top1'];
  for (const t of allTiers) {
    if (!enabled.includes(t.tag)) continue; // skip disabled tiers
    if (rank <= t.max && totalUsers >= t.needTotal) return t.tag;
  }
  // Always show top1 for rank 1 if top1 is enabled, even with few users
  if (rank === 1 && enabled.includes('top1')) return 'top1';
  return null;
}

// Recalculate all topTags based on stars ranking
// PERFORMANCE: debounced to run at most once every 5 minutes (avoids O(n log n) on every star donation)
let _topTagTimer = null;
let _topTagLastRun = 0;
const TOP_TAG_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

function _doRecalcAllTopTags() {
  // Safe access: getGameConfig depends on DEFAULT_GAME_CONFIG (const, not hoisted)
  // During early init (before DEFAULT_GAME_CONFIG is defined), use fallback
  var enabledTiers;
  try {
    var cfg = getGameConfig();
    enabledTiers = cfg.topTiersEnabled || ['top1'];
  } catch(e) {
    enabledTiers = ['top1'];
  }
  const users = Object.values(db.users);
  const totalUsers = users.length;
  // Use profileTotal (exclude donation_pool stars) for ranking
  const sorted = users
    .map(u => {
      const profileStars = (u.stars || []).filter(s => s.category !== 'donation_pool').length;
      return { id: u.id, stars: profileStars, regOrder: u.registrationOrder || 9999 };
    })
    .sort((a, b) => b.stars - a.stars || a.regOrder - b.regOrder);
  sorted.forEach((s, idx) => {
    const rank = idx + 1;
    const user = db.users[s.id];
    if (user) user.topTag = calculateTopTag(rank, totalUsers, enabledTiers);
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

// Normalizar muralPosts apos carregar do Firebase
// Firebase RTDB converte arrays JS em objetos { "0": ..., "1": ..., "2": ... }
// Precisamos converter de volta pra arrays pra .push() funcionar
function _normalizeMuralPosts() {
  if (!db.muralPosts || typeof db.muralPosts !== 'object') {
    db.muralPosts = {};
    return;
  }
  let fixed = 0;
  for (const chKey of Object.keys(db.muralPosts)) {
    const raw = db.muralPosts[chKey];
    if (Array.isArray(raw)) continue; // ja e array, ok
    if (raw && typeof raw === 'object') {
      // Converter objeto pra array, filtrando nulos/invalidos
      const arr = Object.values(raw).filter(p => p && typeof p === 'object' && p.id);
      db.muralPosts[chKey] = arr;
      fixed++;
      console.log('[mural] Normalizado canal ' + chKey + ': objeto -> array (' + arr.length + ' posts)');
    } else {
      db.muralPosts[chKey] = [];
      fixed++;
    }
  }
  if (fixed > 0) console.log('[mural] ' + fixed + ' canais normalizados de objeto para array');
}

async function loadDB() {
  console.log('loadDB() iniciando... RTDB URL:', FIREBASE_DB_URL);
  try {
    // Load from Firebase Realtime Database (with 30s timeout — generous to survive slow cold starts)
    console.log('Tentando conectar ao RTDB...');
    const snapshot = await withTimeout(rtdb.ref('/').once('value'), 30000, 'RTDB read');
    const data = snapshot.val();
    if (data) {
      EAGER_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
      // Messages stay empty — loaded on demand via ensureMessages()
      console.log('[PERF] Skipped lazy collections on startup:', LAZY_COLLECTIONS.join(', '));
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
          EAGER_COLLECTIONS.forEach(c => { db[c] = fsData[c] || {}; });
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
          EAGER_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
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
    // Normalizar muralPosts: Firebase RTDB converte arrays em objetos com chaves numericas
    // Precisamos garantir que cada canal tenha um Array, nao um objeto
    _normalizeMuralPosts();
    // Initialize corruption guard counts
    DB_COLLECTIONS.forEach(c => { _lastKnownCounts[c] = Object.keys(db[c] || {}).length; });
    console.log('Corruption guard initialized:', JSON.stringify(_lastKnownCounts));
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
        _normalizeMuralPosts();
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
    _normalizeMuralPosts();
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
  likedBy: new Map(),         // targetUserId -> Set of likerUserIds
  revealByTo: new Map(),      // toUserId -> Set of revealRequestIds (pending)
  revealByFrom: new Map(),    // fromUserId -> Set of revealRequestIds (pending)
  revealByPair: new Map(),    // "from_to" -> revealRequestId (pending)
  prestador: new Set(),       // set of userIds that are prestadores
};

function rebuildIndexes() {
  IDX.firebaseUid.clear(); IDX.touchCode.clear(); IDX.nickname.clear();
  IDX.relationPair.clear(); IDX.relationsByUser.clear();
  IDX.donationsByFrom.clear(); IDX.donationsByPair.clear();
  IDX.operatorByCreator.clear();
  IDX.email.clear(); IDX.phone.clear(); IDX.cpf.clear();
  IDX.tipsByPayer.clear(); IDX.tipsByReceiver.clear();
  IDX.likedBy.clear(); IDX.revealByTo.clear(); IDX.revealByFrom.clear(); IDX.revealByPair.clear();
  IDX.prestador.clear();
  for (const [uid, u] of Object.entries(db.users)) {
    if (u.firebaseUid) IDX.firebaseUid.set(u.firebaseUid, uid);
    if (u.touchCode) IDX.touchCode.set(u.touchCode, uid);
    if (u.nickname) IDX.nickname.set(u.nickname.toLowerCase(), uid);
    if (u.email) IDX.email.set(u.email.toLowerCase(), uid);
    if (u.phone) IDX.phone.set(u.phone, uid);
    if (u.cpf) IDX.cpf.set(u.cpf.replace(/\D/g, ''), uid);
    if (u.isPrestador) IDX.prestador.add(uid);
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
    // Build likedBy index
    if (u.likedBy && u.likedBy.length > 0) {
      IDX.likedBy.set(u.id, new Set(u.likedBy));
    }
  }
  // Build revealRequests indexes (only pending)
  for (const [rrid, rr] of Object.entries(db.revealRequests || {})) {
    if (rr.status !== 'pending') continue;
    if (rr.toUserId) {
      if (!IDX.revealByTo.has(rr.toUserId)) IDX.revealByTo.set(rr.toUserId, new Set());
      IDX.revealByTo.get(rr.toUserId).add(rrid);
    }
    if (rr.fromUserId) {
      if (!IDX.revealByFrom.has(rr.fromUserId)) IDX.revealByFrom.set(rr.fromUserId, new Set());
      IDX.revealByFrom.get(rr.fromUserId).add(rrid);
    }
    if (rr.fromUserId && rr.toUserId) {
      IDX.revealByPair.set(rr.fromUserId + '_' + rr.toUserId, rrid);
    }
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
  if (user.isPrestador) IDX.prestador.add(user.id);
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
  // Top 1 special: 10 permanent profile stars + 50 donation pool
  if (!top1.stars) top1.stars = [];
  // Ensure 10 permanent profile stars (3 permanent + 5 temp-as-permanent + 2 professional)
  const profileStars = top1.stars.filter(s => s.category && s.category !== 'donation_pool');
  if (profileStars.length < 10) {
    // Clear and rebuild profile stars
    top1.stars = top1.stars.filter(s => s.category === 'donation_pool');
    const categories = [
      { category: 'permanent', label: '100 conexoes' },
      { category: 'permanent', label: '500 conexoes' },
      { category: 'permanent', label: '1000 conexoes' },
      { category: 'temporary', label: 'top1' },
      { category: 'temporary', label: 'top1' },
      { category: 'temporary', label: 'top1' },
      { category: 'temporary', label: 'top1' },
      { category: 'temporary', label: 'top1' },
      { category: 'professional', label: 'top1' },
      { category: 'professional', label: 'top1' },
    ];
    categories.forEach((c, i) => {
      top1.stars.push({
        id: 'top1_profile_' + i,
        from: 'system',
        reason: 'top1_perk',
        category: c.category,
        label: c.label,
        permanent: true, // Top 1 stars never expire
        timestamp: Date.now() - i * 1000
      });
    });
    console.log('Top 1 profile stars set to 10: ' + top1.nickname);
  }
  // Ensure donation pool of 50
  const donationPool = top1.stars.filter(s => s.category === 'donation_pool');
  if (donationPool.length < 50) {
    const needed = 50 - donationPool.length;
    for (let i = 0; i < needed; i++) {
      top1.stars.push({
        id: 'top1_pool_' + Date.now() + '_' + i,
        from: 'system',
        reason: 'top1_perk',
        category: 'donation_pool',
        timestamp: Date.now() - i * 1000
      });
    }
    console.log('Top 1 donation pool replenished (+' + needed + '): ' + top1.nickname);
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
    console.warn('saveDB() called before dbLoaded — IGNORING to prevent data loss. Collections:', collections.join(','));
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

// saveDBNow — flush imediato sem debounce (para dados criticos como posts do mural)
function saveDBNow(...collections) {
  if (!dbLoaded) return;
  if (collections.length === 0) {
    DB_COLLECTIONS.forEach(c => _dirtyCollections.add(c));
  } else {
    collections.forEach(c => _dirtyCollections.add(c));
  }
  // Cancelar timer pendente e fazer flush agora
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flushToRTDB();
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
// ═══ GUEST UPGRADE: convert guest account to full account ═══
app.post('/api/guest/upgrade', async (req, res) => {
  const { userId, method, firebaseUid, email, displayName, photoURL } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  if (!user.isGuest) return res.json({ ok: true, message: 'Conta ja esta completa.' });

  // Link Firebase credentials
  if (firebaseUid) {
    // Check if this firebaseUid or email already belongs to another user
    const existingByFb = IDX.firebaseUid.get(firebaseUid);
    if (existingByFb && existingByFb !== userId) return res.status(400).json({ error: 'Esta conta Google ja esta vinculada a outro usuario.' });
    if (email) {
      const existingByEmail = IDX.email.get(email.toLowerCase());
      if (existingByEmail && existingByEmail !== userId) return res.status(400).json({ error: 'Este email ja esta em uso por outro usuario.' });
    }
    user.firebaseUid = firebaseUid;
    IDX.firebaseUid.set(firebaseUid, userId);
    if (!user.linkedFirebaseUids) user.linkedFirebaseUids = [];
    if (!user.linkedFirebaseUids.includes(firebaseUid)) user.linkedFirebaseUids.push(firebaseUid);
  }
  if (email) {
    user.email = email.toLowerCase();
    IDX.email.set(email.toLowerCase(), userId);
  }
  if (displayName && !user.realName) user.realName = displayName;
  if (photoURL && !user.profilePhoto) { user.photoURL = photoURL; user.profilePhoto = photoURL; }
  user.isGuest = false;
  user.upgradedAt = Date.now();
  user.authMethod = method || 'unknown';
  saveDB('users');
  console.log('[guest-upgrade] User', userId, 'upgraded via', method);
  res.json({ ok: true, user: { id: user.id, nickname: user.nickname, email: user.email, profilePhoto: user.profilePhoto } });
});

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
// Stripe Tax: enable for product transactions (orders/delivery) in US
// Set STRIPE_TAX_ENABLED=true in env to activate (requires Stripe Tax setup in dashboard)
const STRIPE_TAX_ENABLED = process.env.STRIPE_TAX_ENABLED === 'true';
// Tax codes: https://stripe.com/docs/tax/tax-codes
const STRIPE_TAX_CODE_FOOD = 'txcd_40060003'; // Prepared food & beverages
const STRIPE_TAX_CODE_DELIVERY = 'txcd_10000000'; // General delivery/shipping

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
  let cleaned = 0;
  for (const [id, rel] of Object.entries(db.relations)) {
    if (rel.expiresAt && now > rel.expiresAt) {
      delete db.messages[id];
      delete db.relations[id];
      cleaned++;
    }
  }
  cleanExpiredPoints();
  // Archive starDonations older than 90 days (prevent unbounded growth)
  const donationCutoff = now - (90 * 24 * 60 * 60 * 1000);
  let donationsArchived = 0;
  for (const [id, d] of Object.entries(db.starDonations || {})) {
    if (d.timestamp && d.timestamp < donationCutoff) {
      delete db.starDonations[id];
      donationsArchived++;
    }
  }
  if (donationsArchived > 0) {
    console.log('[cleanup] Archived ' + donationsArchived + ' star donations older than 90 days');
    saveDB('starDonations');
  }
  // Cleanup guest accounts inactive for 30 days with no connections
  const guestCutoff = now - (30 * 24 * 60 * 60 * 1000);
  let guestsRemoved = 0;
  for (const [id, u] of Object.entries(db.users)) {
    if (u.isGuest && u.createdAt && u.createdAt < guestCutoff) {
      // Check if guest has any active relations
      const rels = IDX.userRelations.get(id);
      if (!rels || rels.size === 0) {
        if (u.nickname) IDX.nickname.delete(u.nickname.toLowerCase());
        if (u.email) IDX.email.delete(u.email.toLowerCase());
        if (u.touchCode) IDX.touchCode.delete(u.touchCode);
        if (u.firebaseUid) IDX.firebaseUid.delete(u.firebaseUid);
        IDX.userRelations.delete(id);
        IDX.prestador.delete(id);
        delete db.users[id];
        guestsRemoved++;
      }
    }
  }
  if (guestsRemoved > 0) {
    console.log('[cleanup] Removed ' + guestsRemoved + ' inactive guest accounts (30d+, no relations)');
    saveDB('users');
  }
  saveDB('relations', 'messages');
}, 60000);

// Cleanup barber appointments older than 30 days (hourly)
setInterval(() => {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  let total = 0;
  for (const [evId, ev] of Object.entries(db.operatorEvents || {})) {
    if (ev && ev.barber && Array.isArray(ev.barber.appointments)) {
      const before = ev.barber.appointments.length;
      ev.barber.appointments = ev.barber.appointments.filter(a => !a.date || new Date(a.date).getTime() > cutoff);
      total += before - ev.barber.appointments.length;
    }
  }
  if (total > 0) {
    console.log('[cleanup] Removed ' + total + ' barber appointments older than 30 days');
    saveDB('operatorEvents');
  }
}, 60 * 60 * 1000);

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

// Helper: get user's language preference
function getUserLang(userId) {
  if (!userId) return 'pt-br';
  const user = db.users[userId];
  return (user && user.lang) ? user.lang : 'pt-br';
}

// Server-side i18n for payment errors
const SERVER_PAYMENT_I18N = {
  'en': {
    'payment.card_invalid': 'Invalid card number. Check and try again.',
    'payment.expiry_invalid': 'Invalid expiration date. Use MM/YY format.',
    'payment.cvv_invalid': 'Invalid CVV. Must be 3-4 digits.',
    'payment.insufficient_balance': 'Insufficient balance. Check your account.',
    'payment.card_blocked': 'Card blocked. Contact your bank.',
    'payment.pix_error': 'Error generating PIX. Try again.',
    'payment.card_declined': 'Card declined. Try another card or method.',
    'payment.network_error': 'Connection error. Try again.',
    'payment.unknown_error': 'Payment error. Try again later.'
  },
  'pt-br': {
    'payment.card_invalid': 'Numero do cartao invalido. Verifique e tente novamente.',
    'payment.expiry_invalid': 'Data de validade incorreta. Use formato MM/AA.',
    'payment.cvv_invalid': 'CVV invalido. Deve ter 3-4 digitos.',
    'payment.insufficient_balance': 'Saldo insuficiente. Verifique sua conta.',
    'payment.card_blocked': 'Cartao bloqueado. Entre em contato com seu banco.',
    'payment.pix_error': 'Erro ao gerar PIX. Tente novamente.',
    'payment.card_declined': 'Cartao recusado. Tente outro cartao ou metodo.',
    'payment.network_error': 'Erro de conexao. Tente novamente.',
    'payment.unknown_error': 'Erro no pagamento. Tente mais tarde.'
  },
  'es': {
    'payment.card_invalid': 'Numero de tarjeta invalido. Verifica e intenta de nuevo.',
    'payment.expiry_invalid': 'Fecha de vencimiento invalida. Usa formato MM/AA.',
    'payment.cvv_invalid': 'CVV invalido. Debe tener 3-4 digitos.',
    'payment.insufficient_balance': 'Saldo insuficiente. Verifica tu cuenta.',
    'payment.card_blocked': 'Tarjeta bloqueada. Contacta a tu banco.',
    'payment.pix_error': 'Error al generar PIX. Intenta de nuevo.',
    'payment.card_declined': 'Tarjeta rechazada. Intenta otra tarjeta o metodo.',
    'payment.network_error': 'Error de conexion. Intenta de nuevo.',
    'payment.unknown_error': 'Error de pago. Intenta mas tarde.'
  },
  'ja': {
    'payment.card_invalid': 'カード番号が無効です。確認してもう一度試してください。',
    'payment.expiry_invalid': '有効期限が無効です。MM/YY形式を使用してください。',
    'payment.cvv_invalid': 'CVVが無効です。3-4桁である必要があります。',
    'payment.insufficient_balance': '残高不足です。アカウントを確認してください。',
    'payment.card_blocked': 'カードがブロックされています。銀行に連絡してください。',
    'payment.pix_error': 'PIX生成エラー。もう一度試してください。',
    'payment.card_declined': 'カードが拒否されました。別のカードまたは方法を試してください。',
    'payment.network_error': '接続エラー。もう一度試してください。',
    'payment.unknown_error': '支払いエラー。後でもう一度試してください。'
  },
  'ru': {
    'payment.card_invalid': 'Неверный номер карты. Проверьте и попробуйте еще раз.',
    'payment.expiry_invalid': 'Неверная дата истечения. Используйте формат MM/YY.',
    'payment.cvv_invalid': 'Неверный CVV. Должно быть 3-4 цифры.',
    'payment.insufficient_balance': 'Недостаточно средств. Проверьте свой счет.',
    'payment.card_blocked': 'Карта заблокирована. Свяжитесь со своим банком.',
    'payment.pix_error': 'Ошибка генерации PIX. Попробуйте еще раз.',
    'payment.card_declined': 'Карта отклонена. Попробуйте другую карту или способ.',
    'payment.network_error': 'Ошибка подключения. Попробуйте еще раз.',
    'payment.unknown_error': 'Ошибка платежа. Попробуйте позже.'
  }
};

function serverT(key, lang) {
  lang = lang || 'en';
  const dict = SERVER_PAYMENT_I18N[lang] || SERVER_PAYMENT_I18N['en'];
  return dict[key] || SERVER_PAYMENT_I18N['en'][key] || key;
}

// Helper: get smart category name (primeiro, reencontro2, reencontro3a5, etc.)
function getSmartPhraseCategory(userAId, userBId) {
  const encounters = (db.encounters[userAId] || []).filter(e => e.with === userBId);
  const count = encounters.length; // how many times they've met BEFORE this one
  if (count === 0) return 'primeiro';
  else if (count === 1) return 'reencontro2';
  else if (count <= 4) return 'reencontro3a5';
  else if (count <= 9) return 'reencontro6a10';
  else return 'reencontro11';
}

// Smart phrase selection based on encounter count (uses i18n)
function smartPhrase(userAId, userBId, lang) {
  lang = lang || getUserLang(userAId);
  const category = getSmartPhraseCategory(userAId, userBId);
  const phrase = getPhrase(category, lang);
  // If no phrase found, try geral (general) category
  if (!phrase) return getPhrase('geral', lang);
  return phrase;
}

function getPhrase(category, lang) {
  lang = lang || 'pt-br';
  // Try translated version first
  if (phrasesI18n[lang] && phrasesI18n[lang][category] && phrasesI18n[lang][category].length > 0) {
    const phrases = phrasesI18n[lang][category];
    return phrases[Math.floor(Math.random() * phrases.length)];
  }
  // Fallback to hardcoded Portuguese (PHRASES)
  if (PHRASES && PHRASES[category]) {
    const phrases = PHRASES[category];
    return phrases[Math.floor(Math.random() * phrases.length)];
  }
  return '';
}

function generateCode() { return `ENC-${Math.floor(100 + Math.random() * 900)}`; }

// ── ZODIAC SYSTEM ──
function getZodiacSign(birthdate) {
  if (!birthdate) return null;
  const d = new Date(birthdate);
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'taurus';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'gemini';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'leo';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'virgo';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'scorpio';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'sagittarius';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'capricorn';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'aquarius';
  return 'pisces';
}

const ZODIAC_INFO = {
  aries:       { glyph: '♈', name: 'Áries',       element: 'fogo',  trait: 'impulso',    elementName: 'Fogo' },
  taurus:      { glyph: '♉', name: 'Touro',       element: 'terra', trait: 'presença',   elementName: 'Terra' },
  gemini:      { glyph: '♊', name: 'Gêmeos',      element: 'ar',    trait: 'movimento',  elementName: 'Ar' },
  cancer:      { glyph: '♋', name: 'Câncer',       element: 'agua',  trait: 'profundidade', elementName: 'Água' },
  leo:         { glyph: '♌', name: 'Leão',         element: 'fogo',  trait: 'brilho',     elementName: 'Fogo' },
  virgo:       { glyph: '♍', name: 'Virgem',       element: 'terra', trait: 'cuidado',    elementName: 'Terra' },
  libra:       { glyph: '♎', name: 'Libra',        element: 'ar',    trait: 'equilíbrio', elementName: 'Ar' },
  scorpio:     { glyph: '♏', name: 'Escorpião',    element: 'agua',  trait: 'intensidade', elementName: 'Água' },
  sagittarius: { glyph: '♐', name: 'Sagitário',    element: 'fogo',  trait: 'expansão',   elementName: 'Fogo' },
  capricorn:   { glyph: '♑', name: 'Capricórnio',  element: 'terra', trait: 'estrutura',  elementName: 'Terra' },
  aquarius:    { glyph: '♒', name: 'Aquário',       element: 'ar',    trait: 'liberdade',  elementName: 'Ar' },
  pisces:      { glyph: '♓', name: 'Peixes',        element: 'agua',  trait: 'intuição',   elementName: 'Água' }
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

function getZodiacPhrase(signA, signB, lang) {
  if (!signA || !signB) return null;
  lang = lang || 'pt-br';
  const infoA = ZODIAC_INFO[signA];
  const infoB = ZODIAC_INFO[signB];
  if (!infoA || !infoB) return null;

  // Try i18n zodiac first
  if (zodiacI18n[lang] && zodiacI18n[lang].combinations) {
    // Build element key (sorted, with underscores for i18n files)
    const elems = [infoA.element, infoB.element].sort();
    const elemNames = elems.map(e => {
      if (e === 'fogo') return 'fire';
      if (e === 'terra') return 'earth';
      if (e === 'ar') return 'air';
      if (e === 'agua') return 'water';
      return e;
    });
    const keyI18n = elemNames[0] + '_' + elemNames[1];
    const phrasesI18n = zodiacI18n[lang].combinations[keyI18n];
    if (phrasesI18n && phrasesI18n.length > 0) {
      return phrasesI18n[Math.floor(Math.random() * phrasesI18n.length)];
    }
  }

  // Fallback to hardcoded Portuguese (ZODIAC_PHRASES)
  const elems = [infoA.element, infoB.element].sort();
  const key = elems[0] + '+' + elems[1];
  const phrases = ZODIAC_PHRASES[key];
  if (phrases && phrases.length > 0) {
    return phrases[Math.floor(Math.random() * phrases.length)];
  }

  return null;
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
  // Award score points (uses classification + star bonus multiplier)
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  // Star bonus: connecting with someone who has N stars = Nx multiplier
  const bonusA = getStarBonusMultiplier(userBId);
  const bonusB = getStarBonusMultiplier(userAId);
  const pointsA = classA.points * bonusA;
  const pointsB = classB.points * bonusB;
  if (pointsA > 0) {
    db.users[userAId].pointLog.push({ value: pointsA, type: classA.type, with: userBId, timestamp: now, bonus: bonusA > 1 ? bonusA : undefined });
    if (db.users[userAId].pointLog.length > 500) db.users[userAId].pointLog = db.users[userAId].pointLog.slice(-500);
  }
  if (pointsB > 0) {
    db.users[userBId].pointLog.push({ value: pointsB, type: classB.type, with: userAId, timestamp: now, bonus: bonusB > 1 ? bonusB : undefined });
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
  // Points per connection type (Star Economy v1 — final model)
  pointsFirstEncounter: 10,       // First time meeting someone
  pointsReEncounterDiffDay: 5,    // Re-encounter on a different day
  pointsReEncounterSameDay: 2,    // Re-encounter within 24h (2nd time)
  pointsReEncounterSpam: 0,       // 3rd+ encounter within 24h
  pointsCheckin: 10,              // Event check-in
  pointsGift: 10,                 // Gift/present
  pointsDeclaration: 20,          // Declaration

  // Anti-farm — cooldown 24h per pair, no daily cap
  maxScoringPerPair24h: 2,        // Max scoring events per pair within 24h

  // Score is a CURRENCY (no decay) — spent to buy stars
  pointDecayDays: 0,              // 0 = no decay, score accumulates forever

  // Star earning — milestones (all 3 are permanent, equal)
  milestoneStars: [100, 500, 1000], // Unique connections that earn permanent stars

  // Star earning — streak (different days with same person)
  daysTogetherPerStar: 5,         // Every N different days with same person = 1 star to donate

  // Star earning — score conversion (star shop)
  starPriceFixed: 100,            // Fixed price per temporary star (no escalation)

  // Star limits
  maxStarsTotal: 10,              // Max total stars per person (except Top 1)
  maxTempStars: 5,                // Max temporary (buyable) stars (slots 4-8)
  maxPermanentStars: 3,           // Slots 1-3 (100, 500, 1000 connections) — all equal, all permanent
  maxProfessionalStars: 2,        // Slots 9-10 (ouro branco, professional recognition)
  tempStarDurationDays: 30,       // Temporary stars expire after N days

  // Star bonus multiplier — connecting with someone who has N stars = (1 + N*0.1)x score
  // 0 stars = 1x, 1 star = 1.1x, 4 stars = 1.4x, 10 stars = 2x
  starBonusEnabled: true,         // Enable star bonus multiplier

  // Max stars one person can give to another
  maxStarsPerPersonToPerson: 10,  // A can give max N stars to B

  // Top 1 creator privileges
  top1CanSetConfig: true,         // Top 1 user can adjust these parameters

  // Top tier visibility — array of enabled tier tags (only these are assigned to users)
  // Default: only top1 active. Admin can enable more via admin panel.
  topTiersEnabled: ['top1'],

  // Legacy (kept for backward compatibility, unused)
  uniqueConnectionsPerStar: 100,
  pointsPerStarSelf: 100,
  pointsPerStarGift: 100,
  starRarityMultiplier: 1.0,
};

function getGameConfig() {
  return { ...DEFAULT_GAME_CONFIG, ...(db.gameConfig || {}) };
}

// ══ SCORING SYSTEM v3 — Star Economy ══
// Score is a permanent currency (no decay). Anti-farm: cooldown 24h per pair.
// Star bonus: connecting with someone who has N stars = Nx multiplier.
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
  // Score is now a permanent currency (no decay)
  // Available score = total earned - total spent
  const user = db.users[userId];
  if (!user || !user.pointLog) return 0;
  const cfg = getGameConfig();
  if (cfg.pointDecayDays === 0) {
    // No decay mode — score = raw total - spent
    let total = 0;
    for (const p of user.pointLog) total += p.value;
    return Math.round((total - (user.pointsSpent || 0)) * 10) / 10;
  }
  // Legacy decay mode (kept for backward compatibility)
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

// Calculate star bonus multiplier for connecting with someone
function getStarBonusMultiplier(otherUserId) {
  const cfg = getGameConfig();
  if (!cfg.starBonusEnabled) return 1;
  const other = db.users[otherUserId];
  if (!other) return 1;
  const starCount = (other.stars || []).length;
  // Smooth scaling: 0=1x, 1=1.1x, 4=1.4x, 9=1.9x, 10=2x
  return starCount === 0 ? 1 : 1 + starCount * 0.1;
}

// Count stars by category for a user
// conquest and permanent are now unified as "permanent" (all milestone stars are equal)
function getStarBreakdown(userId) {
  const user = db.users[userId];
  if (!user) return { permanent: 0, temporary: 0, professional: 0, total: 0, profileTotal: 0 };
  const stars = user.stars || [];
  let permanent = 0, temporary = 0, professional = 0;
  for (const s of stars) {
    if (s.category === 'donation_pool') continue; // Top 1 donation pool, not counted in profile
    if (s.category === 'conquest' || s.category === 'permanent') permanent++;
    else if (s.category === 'professional') professional++;
    else temporary++;
  }
  const profileTotal = permanent + temporary + professional;
  return { permanent, temporary, professional, total: stars.length, profileTotal };
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
  // Clean old point logs if decay is active (legacy)
  if (cfg.pointDecayDays > 0) {
    const cutoff = Date.now() - (cfg.pointDecayDays * 86400000);
    for (const user of Object.values(db.users)) {
      if (user.pointLog) {
        user.pointLog = user.pointLog.filter(p => p.timestamp > cutoff);
      }
    }
  }
  // Clean expired temporary stars
  const now = Date.now();
  let changed = false;
  for (const user of Object.values(db.users)) {
    if (user.stars && user.stars.length > 0) {
      const before = user.stars.length;
      user.stars = user.stars.filter(s => {
        if (s.category === 'temporary' && s.expiresAt && s.expiresAt < now) return false;
        return true;
      });
      if (user.stars.length < before) changed = true;
    }
  }
  if (changed) {
    recalcAllTopTags();
    saveDB('users');
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

// Calculate star cost — now fixed price (no escalation)
function starCost(starNumber, basePrice) {
  const cfg = getGameConfig();
  if (cfg.starRarityMultiplier <= 1) return basePrice; // Fixed price
  // Legacy escalation mode
  return Math.round(basePrice * Math.pow(cfg.starRarityMultiplier, Math.max(0, starNumber - 1)));
}

function checkStarEligibility(userAId, userBId) {
  const cfg = getGameConfig();
  const userA = db.users[userAId];
  const userB = db.users[userBId];
  if (!userA || !userB) return;

  // 1. Streak-based: every N different days with same person = 1 star to donate
  const key = [userAId, userBId].sort().join('_');
  const streak = db.streaks[key];
  if (streak) {
    const uniqueDays = new Set((streak.history || []).map(h => h.date)).size;
    const starsFromDays = Math.floor(uniqueDays / cfg.daysTogetherPerStar);
    const prevStars = streak._starsAwarded || 0;
    if (starsFromDays > prevStars) {
      for (let i = prevStars; i < starsFromDays; i++) {
        earnStarForUser(userAId, 'streak', uniqueDays + ' dias com ' + (userB.nickname || '?'));
        earnStarForUser(userBId, 'streak', uniqueDays + ' dias com ' + (userA.nickname || '?'));
      }
      streak._starsAwarded = starsFromDays;
      const payload = {
        streakDays: uniqueDays, starsTotal: starsFromDays, newStar: true,
        unlock: { label: 'Nova estrela!', description: uniqueDays + ' dias juntos = estrela pra doar!' }
      };
      io.to(`user:${userAId}`).emit('streak-unlock', payload);
      io.to(`user:${userBId}`).emit('streak-unlock', payload);
    }
  }

  // 2. Permanent stars — auto-awarded at 100, 500, 1000 unique connections (all equal, all permanent)
  const milestones = cfg.milestoneStars || [100, 500, 1000];
  [userAId, userBId].forEach(uid => {
    const u = db.users[uid];
    const uniqueConns = getUniqueConnections(uid);
    u.touchers = uniqueConns;
    if (!u.stars) u.stars = [];

    // Check each milestone (all grant permanent stars, no distinction)
    if (!u._conquestMilestones) u._conquestMilestones = [];
    for (const milestone of milestones) {
      if (uniqueConns >= milestone && !u._conquestMilestones.includes(milestone)) {
        u._conquestMilestones.push(milestone);
        const starId = uuidv4();
        u.stars.push({
          id: starId, from: 'system', fromName: 'Permanente',
          donatedAt: Date.now(), type: 'permanent', category: 'permanent',
          milestone: milestone, reason: milestone + ' conexoes unicas'
        });
        io.to('user:' + uid).emit('star-earned', {
          reason: 'permanent', context: milestone + ' conexoes unicas! Estrela permanente!',
          totalEarned: u.stars.length
        });
        // Notify network
        const milestoneEnc = new Set((db.encounters[uid] || []).map(e => e.with));
        milestoneEnc.delete(uid);
        const milBd = getStarBreakdown(uid);
        milestoneEnc.forEach(nid => {
          io.to('user:' + nid).emit('star-donated-notification', {
            recipientName: u.nickname || u.name,
            recipientStars: milBd.profileTotal
          });
          io.to('user:' + nid).emit('network-star', {
            userId: uid, nickname: u.nickname || u.name,
            starsCount: milBd.profileTotal, timestamp: Date.now()
          });
        });
        recalcAllTopTags();
        saveDB('users');
      }
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
  const ownerLang = getUserLang(owner.id);
  const phrase = smartPhrase(owner.id, visitor.id, ownerLang);
  const relationId = uuidv4();
  // Check existing (O(1) via index)
  const existing = findActiveRelation(owner.id, visitor.id);
  let expiresAt;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = phrase;
    existing.renewed = (existing.renewed || 0) + 1;
    expiresAt = existing.expiresAt;
    res.json({ relationId: existing.id, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, visitorColor: visitor.color, renewed: true });
  } else {
    db.relations[relationId] = { id: relationId, userA: owner.id, userB: visitor.id, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null };
    idxAddRelation(relationId, owner.id, visitor.id);
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
    res.json({ relationId, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, visitorColor: visitor.color, renewed: false });
  }
  recordEncounter(owner.id, visitor.id, phrase, 'physical');
  saveDB('users', 'relations', 'messages', 'encounters');
  // Notify owner
  const signOwner = getZodiacSign(owner.birthdate);
  const signVisitor = getZodiacSign(visitor.birthdate);
  const zodiacPhrase = getZodiacPhrase(signOwner, signVisitor, ownerLang);
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
<div class="sub">Conectando...</div>
<div class="phrase" id="phrase"></div>
<div class="timer">Entrando no Touch?...</div>
</div>
</div>
<script>
async function connect(){
  const nick=document.getElementById('nick').value.trim();
  if(!nick||nick.length<2)return alert('Nickname precisa ter 2+ caracteres');
  const btn=document.querySelector('button');
  btn.disabled=true;btn.textContent='Conectando...';
  try{
    const r=await fetch('/api/touch-link/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({touchCode:'${code}',visitorNickname:nick})});
    const d=await r.json();
    if(d.error){btn.disabled=false;btn.textContent='TOUCH';return alert(d.error)}
    // Save guest credentials and redirect immediately — animation happens in the app
    localStorage.setItem('touch_userId',d.visitorId);
    localStorage.setItem('touch_userName',nick);
    localStorage.setItem('touch_userColor',d.visitorColor||'');
    localStorage.setItem('touch_isGuest','true');
    btn.textContent='Entrando...';
    window.location.href='/?guest='+d.visitorId+'&rel='+(d.relationId||'')+'&phrase='+encodeURIComponent(d.phrase||'');
  }catch(e){btn.disabled=false;btn.textContent='TOUCH';alert('Erro de conexao.')}
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

  // -- Age verification (18+) --
  const birthParsed = new Date(birthdate + 'T00:00:00Z');
  if (isNaN(birthParsed.getTime())) return res.status(400).json({ error: 'Data de nascimento invalida.' });
  const today = new Date();
  let age = today.getUTCFullYear() - birthParsed.getUTCFullYear();
  const m = today.getUTCMonth() - birthParsed.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < birthParsed.getUTCDate())) age--;
  if (age < 18) return res.status(403).json({ error: 'O Touch? e exclusivo para maiores de 18 anos. Voce nao pode criar uma conta.' });
  if (age > 120) return res.status(400).json({ error: 'Data de nascimento invalida.' });

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

// ═══ i18n: Language & Country ═══
app.post('/api/user/:userId/lang', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { lang } = req.body;
    const validLangs = ['en', 'pt-br', 'es', 'ja', 'ru'];
    if (!validLangs.includes(lang)) return res.status(400).json({ error: 'Invalid language.' });
    const u = db.users[userId];
    if (!u) return res.status(404).json({ error: 'User not found.' });
    u.lang = lang;
    u.updatedAt = Date.now();
    saveDB('users');
    res.json({ ok: true, lang });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save language.' });
  }
});

app.post('/api/user/:userId/country', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { country, city } = req.body;
    const u = db.users[userId];
    if (!u) return res.status(404).json({ error: 'User not found.' });
    if (country === null || country === '') { u.country = null; } // clear country
    else if (country) u.country = String(country).substring(0, 3).toUpperCase();
    if (typeof city === 'string') u.city = city.substring(0, 30);
    u.updatedAt = Date.now();
    saveDB('users');
    res.json({ ok: true, country: u.country, city: u.city });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save country.' });
  }
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
  // Get language for userA (who initiated the session)
  const userALang = getUserLang(session.userA);
  const getPhraseForSession = () => {
    if (isSessionCheckin) return getPhrase('evento', userALang);
    if (session.isServiceTouch) return getPhrase('servico', userALang);
    return smartPhrase(session.userA, session.userB, userALang);
  };

  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = getPhraseForSession();
    existing.renewed = (existing.renewed || 0) + 1;
    existing.provocations = {};
    relationId = existing.id; phrase = existing.phrase; expiresAt = existing.expiresAt;
  } else {
    phrase = getPhraseForSession();
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
  const zodiacPhrase = (isSessionCheckin || session.isServiceTouch) ? null : getZodiacPhrase(signA, signB, userALang);
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
      userB: { id: 'evt:' + sessionEventId, name: sessionEventObj ? sessionEventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true, verified: !!(sessionEventObj && sessionEventObj.verified), eventLogo: sessionEventObj ? proxyStorageUrl(sessionEventObj.eventLogo || null) : null },
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
  // Broadcast to visitor's network: "fulano fez check-in em [Local]"
  if (isSessionCheckin && sessionEventId && codeVisitorId) {
    const evObj2 = db.operatorEvents[sessionEventId];
    const networkIds = new Set((db.encounters[codeVisitorId] || []).map(e => e.with).filter(w => !w.startsWith('evt:')));
    networkIds.forEach(uid => {
      io.to(`user:${uid}`).emit('network-checkin', {
        userId: codeVisitorId,
        nickname: userB.nickname || userB.name,
        eventName: evObj2 ? evObj2.name : 'Evento',
        eventLogo: evObj2 ? proxyStorageUrl(evObj2.eventLogo || evObj2.logo || null) : null,
        timestamp: now
      });
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
      partnerAccessory: isEvent ? null : (p?.avatarAccessory || null),
      eventLogo: isEvent && evObj ? proxyStorageUrl(evObj.eventLogo || null) : null,
      eventModules: isEvent && evObj ? (evObj.modules || null) : null,
      eventAcceptsTips: isEvent && evObj ? !!evObj.acceptsTips : false
    };
  });
  // Sort by last message time descending (most recent first)
  results.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
  res.json(results);
});

// Relation reveal data — returns full reveal-compatible data for animation on guest arrival
app.get('/api/relation-reveal/:relationId/:userId', (req, res) => {
  const { relationId, userId } = req.params;
  const rel = db.relations[relationId];
  if (!rel) return res.status(404).json({ error: 'Relacao nao encontrada.' });
  const me = db.users[userId];
  if (!me) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const partnerId = rel.userA === userId ? rel.userB : rel.userA;
  const partner = db.users[partnerId];
  if (!partner) return res.status(404).json({ error: 'Parceiro nao encontrado.' });
  const signMe = getZodiacSign(me.birthdate);
  const signPartner = getZodiacSign(partner.birthdate);
  const lang = getUserLang(userId);
  const zodiacPhrase = getZodiacPhrase(signMe, signPartner, lang);
  const pairEncAll = (db.encounters[partnerId] || []).filter(e => e.with === userId)
    .concat((db.encounters[userId] || []).filter(e => e.with === partnerId));
  const pairEncounters = pairEncAll.length;
  const now24h = Date.now() - 86400000;
  const pairEncounters24h = pairEncAll.filter(e => e.timestamp > now24h).length;
  const isCheckin = !!rel.isCheckin;
  const isService = !!rel.isServiceTouch;
  const evId = rel.eventId || null;
  const opEv = evId && db.operatorEvents ? db.operatorEvents[evId] : null;
  res.json({
    relationId: rel.id, phrase: rel.phrase, expiresAt: rel.expiresAt, renewed: !!(rel.renewed),
    encounterCount: pairEncounters, encounterCount24h: pairEncounters24h,
    isCheckin, isServiceTouch: isService, eventId: evId,
    eventName: opEv ? opEv.name : null, entryPrice: opEv ? (opEv.entryPrice || 0) : 0,
    eventModules: opEv ? (opEv.modules || null) : null, acceptsTips: opEv ? !!opEv.acceptsTips : false,
    eventLogo: opEv ? (opEv.eventLogo || null) : null,
    operatorId: isCheckin ? partnerId : null, operatorName: isCheckin ? (partner.nickname || '') : null,
    userA: { id: partnerId, name: partner.nickname, realName: partner.realName || null, color: partner.color, profilePhoto: partner.profilePhoto || null, photoURL: partner.photoURL || null, score: calcScore(partnerId), stars: (partner.stars || []).length, sign: signPartner, signInfo: signPartner ? ZODIAC_INFO[signPartner] : null, isPrestador: !!partner.isPrestador, serviceLabel: partner.serviceLabel || '', verified: !!partner.verified, accessory: partner.avatarAccessory || null },
    userB: { id: userId, name: me.nickname, realName: me.realName || null, color: me.color, profilePhoto: me.profilePhoto || null, photoURL: me.photoURL || null, score: calcScore(userId), stars: (me.stars || []).length, sign: signMe, signInfo: signMe ? ZODIAC_INFO[signMe] : null, isPrestador: !!me.isPrestador, serviceLabel: me.serviceLabel || '', verified: !!me.verified, accessory: me.avatarAccessory || null },
    zodiacPhrase
  });
});

app.get('/api/messages/:relationId', async (req, res) => {
  try {
    const msgs = await ensureMessages(req.params.relationId);
    const limit = parseInt(req.query.limit) || 200;
    const before = parseInt(req.query.before) || Infinity;
    const filtered = before < Infinity ? msgs.filter(m => m.timestamp < before) : msgs;
    res.json(filtered.slice(-limit));
  } catch (e) { res.json([]); }
});
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
    // Check if this is an event encounter (with starts with 'evt:')
    if (typeof e.with === 'string' && e.with.startsWith('evt:')) {
      const evId = e.with.replace('evt:', '');
      const ev = db.operatorEvents ? db.operatorEvents[evId] : null;
      return { ...e, realName: null, profilePhoto: ev ? proxyStorageUrl(ev.eventLogo || null) : null, eventLogo: ev ? proxyStorageUrl(ev.eventLogo || null) : null, verified: !!(ev && ev.verified) };
    }
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
    if (!byPerson[e.with]) byPerson[e.with] = { id: e.with, nickname: currentNick(e.with, e.withName), color: e.withColor || null, encounters: 0, firstDate: e.timestamp, lastDate: e.timestamp, tipsGiven: 0, tipsTotal: 0, lastSelfie: null, serviceEncounters: 0, personalEncounters: 0 };
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
      lastStarAt: (other && other.stars && other.stars.length) ? Math.max(...other.stars.map(s => s.donatedAt || s.at || 0)) : 0,
      score: other ? calcScore(p.id) : 0,
      uniqueConnections: other ? getUniqueConnections(p.id) : 0,
      likedByMe: !!(IDX.likedBy.get(p.id)?.has(req.params.userId)),
      isPrestador: !!(other && other.isPrestador),
      serviceLabel: (other && other.serviceLabel) || null,
      verified: !!(other && other.verified),
      pendingReveal: (() => {
        const pr = db.revealRequests[IDX.revealByPair.get(req.params.userId + '_' + p.id)] || db.revealRequests[IDX.revealByPair.get(p.id + '_' + req.params.userId)] || null;
        if (!pr) return null;
        return pr.fromUserId === req.params.userId ? 'sent' : 'received';
      })(),
      // All selfies from encounters together
      allSelfies: (p.allSelfies || []).slice(0, 20),
      // WhatsApp (only when revealed)
      whatsapp: iCanSeeThem ? (p.whatsapp || null) : null,
      giftsReceived: (db.gifts[p.id] || []).length,
      avatarAccessory: (other && other.avatarAccessory) || null,
      country: (other && other.country) ? other.country : null,
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
      likesCount: (ev.likes || []).length, starsCount: 0, likedByMe: (ev.likes || []).includes(req.params.userId),
      isPrestador: false, serviceLabel: null, pendingReveal: null, verified: !!ev.verified,
      eventActive: ev.active, eventParticipants: (ev.participants || []).length,
      peopleMet: peopleMet, eventLogo: proxyStorageUrl(ev.eventLogo || null)
    });
  });
  nodes.push(...eventNodes);
  // Sort by most recent encounter
  nodes.sort((a, b) => b.lastDate - a.lastDate);
  // Add online status to nodes
  if (!global._onlineUsers) global._onlineUsers = {};
  const onlineThreshold = Date.now() - 120000; // 2 minutes
  nodes.forEach(n => {
    n.isOnline = !!(global._onlineUsers[n.id] && global._onlineUsers[n.id] > onlineThreshold);
  });
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

// Batch: chat init data (messages + partner score + streak) in 1 request
app.get('/api/chat-init/:relationId/:userId', (req, res) => {
  const rel = db.relations[req.params.relationId];
  const userId = req.params.userId;
  if (!rel) return res.status(404).json({ error: 'Relacao nao encontrada.' });
  if (rel.userA !== userId && rel.userB !== userId) return res.status(403).json({ error: 'Sem permissao.' });
  const partnerId = rel.userA === userId ? rel.userB : rel.userA;
  const partner = db.users[partnerId];
  // Messages
  const messages = db.messages[req.params.relationId] || [];
  // Partner score
  let partnerScore = null;
  if (partner && Date.now() <= rel.expiresAt) {
    const partnerEnc = db.encounters[partnerId] || [];
    const myEnc = db.encounters[userId] || [];
    partnerScore = {
      score: calcScore(partnerId), stars: (partner.stars || []).length,
      name: partner.name,
      uniquePeople: [...new Set(partnerEnc.map(e => e.with))].length,
      totalEncounters: partnerEnc.length,
      mutualEncounters: myEnc.filter(e => e.with === partnerId).length
    };
  }
  // Streak
  const streakKey = [userId, partnerId].sort().join('_');
  const s = db.streaks?.[streakKey];
  let streak = { currentStreak: 0, bestStreak: 0, starsEarned: 0, daysToNextStar: 5, progress: 0 };
  if (s) {
    const starsEarned = s._starsAwarded || Math.floor(s.currentStreak / 5);
    const daysInCycle = s.currentStreak % 5;
    streak = { currentStreak: s.currentStreak, bestStreak: s.bestStreak, lastDate: s.lastDate, starsEarned, daysToNextStar: 5 - daysInCycle, progress: Math.round((daysInCycle / 5) * 100) };
  }
  res.json({ messages, partnerScore, streak });
});

// AI assistant context endpoint -- provides full chat context for voice agents
app.get('/api/ai/chat-context/:relationId/:userId', (req, res) => {
  const rel = db.relations[req.params.relationId];
  const userId = req.params.userId;
  if (!rel) return res.status(404).json({ error: 'Relacao nao encontrada.' });
  if (rel.userA !== userId && rel.userB !== userId) return res.status(403).json({ error: 'Sem permissao.' });
  const partnerId = rel.userA === userId ? rel.userB : rel.userA;
  const partner = db.users[partnerId];
  const user = db.users[userId];
  const messages = (db.messages[req.params.relationId] || []).slice(-50);
  const timeRemainingMs = Math.max(0, rel.expiresAt - Date.now());
  const timeRemainingMin = Math.round(timeRemainingMs / 60000);
  const hours = Math.floor(timeRemainingMin / 60);
  const mins = timeRemainingMin % 60;
  // Collect contact requests and gifts in this relation
  const contactReqs = messages.filter(m => m.type === 'contact-request');
  const giftMsgs = messages.filter(m => m.type === 'gift');
  const revealMsgs = messages.filter(m => m.type === 'reveal-request' || m.type === 'reveal-accepted' || m.type === 'reveal-declined');
  // Build partner zodiac info
  const signA = getZodiacSign(user?.birthdate);
  const signB = getZodiacSign(partner?.birthdate);
  const infoA = signA ? ZODIAC_INFO[signA] : null;
  const infoB = signB ? ZODIAC_INFO[signB] : null;
  // Streak
  const streakKey = [userId, partnerId].sort().join('_');
  const s = db.streaks?.[streakKey];
  res.json({
    relationId: req.params.relationId,
    timeRemaining: { ms: timeRemainingMs, minutes: timeRemainingMin, formatted: hours + 'h ' + mins + 'min', expired: timeRemainingMs <= 0 },
    user: { id: userId, nickname: user?.nickname, sign: signA, element: infoA?.elementName },
    partner: { id: partnerId, nickname: partner?.nickname, sign: signB, element: infoB?.elementName, isRevealed: !!(rel.revealedA || rel.revealedB) },
    recentMessages: messages.map(m => ({ from: m.userId === userId ? 'user' : (m.userId === 'system' ? 'system' : 'partner'), text: m.text, type: m.type || 'text', timestamp: m.timestamp })),
    pendingContactRequests: contactReqs.filter(m => m.status === 'pending').map(m => ({ type: m.contactType, from: m.from?.name, requestId: m.requestId })),
    giftsExchanged: giftMsgs.length,
    revealStatus: revealMsgs.length > 0 ? revealMsgs[revealMsgs.length - 1].type : 'none',
    streak: s ? { current: s.currentStreak, best: s.bestStreak } : null,
    phrase: rel.phrase,
    suggestions: _getAISuggestions(timeRemainingMs, messages, contactReqs, revealMsgs)
  });
});
function _getAISuggestions(timeMs, msgs, contactReqs, revealMsgs) {
  const suggestions = [];
  const hours = timeMs / 3600000;
  if (hours < 4 && hours > 0) suggestions.push('O tempo esta acabando! Sugira trocar contatos antes que expire.');
  if (hours < 1 && hours > 0) suggestions.push('Menos de 1 hora! Urgente: incentive a revelacao de identidade ou troca de contato.');
  if (msgs.length < 3) suggestions.push('A conversa esta no inicio. Sugira quebrar o gelo com uma frase rapida ou verificar a compatibilidade astral.');
  if (contactReqs.filter(m => m.status === 'pending').length > 0) suggestions.push('Ha um pedido de contato pendente. Lembre o usuario de responder.');
  if (revealMsgs.length === 0 && msgs.length > 10) suggestions.push('Muitas mensagens trocadas mas sem reveal. Sugira revelar a identidade para aprofundar a conexao.');
  return suggestions;
}

// ── Ranking cache: recomputed every 2 min (not on every request) ──
let _rankingCache = null;
let _rankingCacheTime = 0;
const RANKING_CACHE_TTL = 2 * 60 * 1000; // 2 min

function _buildRankingCache() {
  _rankingCache = Object.values(db.users)
    .filter(u => {
      const bd = getStarBreakdown(u.id);
      return bd.profileTotal > 0;
    })
    .map(u => {
      const bd = getStarBreakdown(u.id);
      return {
        userId: u.id,
        nickname: u.nickname || u.name || '?',
        color: u.color,
        avatarAccessory: u.avatarAccessory || null,
        stars: bd.profileTotal,
        breakdown: bd,
        topTag: u.topTag || null,
        isSubscriber: !!u.isSubscriber,
        verified: !!u.verified,
        country: u.country || null
      };
    })
    .sort((a, b) => b.stars - a.stars);
  _rankingCacheTime = Date.now();
}

// ══ STAR RANKING — Global leaderboard (MUST be before /api/stars/:userId) ══
app.get('/api/stars/ranking', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const now = Date.now();
  if (!_rankingCache || now - _rankingCacheTime > RANKING_CACHE_TTL) {
    _buildRankingCache();
  }
  const users = _rankingCache.slice(0, limit);
  const total = Object.keys(db.users).length;
  res.json({ ranking: users, totalUsers: total, usersWithStars: _rankingCache.length });
});

// ══ STAR RANKING — Friends only (MUST be before /api/stars/:userId) ══
app.get('/api/stars/friends-ranking', (req, res) => {
  const userId = req.query.userId;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'userId obrigatorio.' });
  // Get all encounters (friends) of this user
  const encounters = db.encounters[userId] || [];
  const friendIds = new Set(encounters.map(e => e.with));
  friendIds.add(userId); // include self in friends ranking
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const friends = Array.from(friendIds)
    .filter(fid => db.users[fid])
    .map(fid => {
      const u = db.users[fid];
      const bd = getStarBreakdown(fid);
      // Check if this friend revealed to the requester
      const theyRevealed = (u.revealedTo || []).includes(userId);
      return {
        userId: fid,
        nickname: u.nickname || u.name || '?',
        realName: theyRevealed ? (u.name || null) : null,
        color: u.color,
        photoURL: theyRevealed ? (u.profilePhoto || u.photoURL || null) : null,
        avatarAccessory: u.avatarAccessory || null,
        stars: bd.profileTotal,
        breakdown: bd,
        topTag: u.topTag || null,
        isSubscriber: !!u.isSubscriber,
        verified: !!u.verified,
        isMe: fid === userId,
        revealed: theyRevealed,
        country: u.country || null
      };
    })
    .filter(u => u.stars > 0)
    .sort((a, b) => b.stars - a.stars)
    .slice(0, limit);
  res.json({ ranking: friends, totalFriends: friendIds.size });
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
    const giverRevealed = giver ? isRevealedTo(star.from, user, null) : null;
    notifs.push({
      type: 'star',
      fromId: star.from,
      nickname: giver ? (giver.nickname || giver.name) : 'Alguem',
      realName: giverRevealed ? (giver.realName || null) : null,
      profilePhoto: giverRevealed ? (giver.profilePhoto || giver.photoURL || null) : null,
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
      const rrRevealed = isRevealedTo(rr.fromUserId, user, null);
      notifs.push({
        type: 'reveal-request',
        fromId: rr.fromUserId,
        nickname: from.nickname || from.name,
        realName: rrRevealed ? (from.realName || null) : null,
        profilePhoto: rrRevealed ? (from.profilePhoto || from.photoURL || null) : null,
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
    const friendRevealed = isRevealedTo(fid, user, null);
    // Show last 5 stars from each friend (recent ones, last 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    friend.stars.filter(s => (s.donatedAt || s.at || 0) > thirtyDaysAgo).slice(-5).forEach(star => {
      if (star.from === userId) return; // skip my own stars to them
      const ts = star.donatedAt || star.at || 0;
      if (!ts) return; // skip if no timestamp
      notifs.push({
        type: 'friend-star',
        fromId: fid,
        nickname: friend.nickname || friend.name,
        realName: friendRevealed ? (friend.realName || null) : null,
        profilePhoto: friendRevealed ? (friend.profilePhoto || friend.photoURL || null) : null,
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
      const giRevealed = isRevealedTo(m.userId, user, null);
      notifs.push({
        type: 'game-invite',
        fromId: m.userId,
        nickname: sender.nickname || sender.name,
        realName: giRevealed ? (sender.realName || null) : null,
        profilePhoto: giRevealed ? (sender.profilePhoto || sender.photoURL || null) : null,
        color: sender.color,
        avatarAccessory: sender.avatarAccessory || null,
        gameName: gameName,
        timestamp: ts,
        seen: ts <= seenAt
      });
    });
  });
  // 7. Recent connections (encounters in last 7 days) — deduplicated by person, show most recent
  const now7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const connByPerson = {};
  myEncounters.filter(e => !e.isEvent && e.timestamp > now7d && !(e.with || '').startsWith('evt:')).forEach(e => {
    const pid = e.with;
    if (!connByPerson[pid] || (e.timestamp || 0) > (connByPerson[pid].timestamp || 0)) {
      connByPerson[pid] = e;
    }
  });
  Object.values(connByPerson).forEach(e => {
    const partner = db.users[e.with];
    if (!partner) return;
    const ts = e.timestamp || 0;
    const connRevealed = isRevealedTo(e.with, user, null);
    // Count total encounters with this person in last 7 days
    const totalEnc = myEncounters.filter(enc => enc.with === e.with && enc.timestamp > now7d && !enc.isEvent).length;
    notifs.push({
      type: 'new-connection',
      fromId: e.with,
      nickname: partner.nickname || partner.name,
      realName: connRevealed ? (partner.realName || null) : null,
      profilePhoto: connRevealed ? (partner.profilePhoto || partner.photoURL || null) : null,
      color: partner.color,
      avatarAccessory: partner.avatarAccessory || null,
      encounterCount: totalEnc,
      isRenewal: totalEnc > 1,
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
      const msgRevealed = isRevealedTo(partnerId, user, null);
      notifs.push({
        type: 'unread-message',
        fromId: partnerId,
        nickname: partner.nickname || partner.name,
        realName: msgRevealed ? (partner.realName || null) : null,
        profilePhoto: msgRevealed ? (partner.profilePhoto || partner.photoURL || null) : null,
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
  // 9. Event checkins (last 7 days) — deduplicated by event, show most recent + count
  const checkinByEvent = {};
  myEncounters.filter(e => e.isEvent && e.timestamp > now7d).forEach(e => {
    const evId = (e.with || '').replace('evt:', '');
    if (!checkinByEvent[evId]) checkinByEvent[evId] = { latest: e, count: 1 };
    else {
      checkinByEvent[evId].count++;
      if ((e.timestamp || 0) > (checkinByEvent[evId].latest.timestamp || 0)) checkinByEvent[evId].latest = e;
    }
  });
  Object.entries(checkinByEvent).forEach(([evId, info]) => {
    const e = info.latest;
    const ts = e.timestamp || 0;
    const evObj = db.operatorEvents[evId] || null;
    notifs.push({
      type: 'event-checkin',
      fromId: null,
      nickname: e.withName || (evObj ? evObj.name : 'Evento'),
      eventName: e.withName || (evObj ? evObj.name : 'Evento'),
      eventLogo: evObj ? proxyStorageUrl(evObj.eventLogo || evObj.logo || null) : null,
      color: '#a78bfa',
      eventId: evId,
      checkinCount: info.count,
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
// Presentes digitais: valor e enviado como gorjeta para a outra pessoa
const GIFT_CATALOG = [
  { id: 'flowers', name: 'Bouquet de Flores', icon: 'flowers', price: 140, currency: 'BRL', description: 'Um bouquet digital que expressa admiracao', color: '#ff6b8a' },
  { id: 'breakfast', name: 'Cafe da Manha', icon: 'breakfast', price: 100, currency: 'BRL', description: 'Um cafe especial para comecar o dia', color: '#d4a574' },
  { id: 'book', name: 'Livro', icon: 'book', price: 80, currency: 'BRL', description: 'Um livro que conecta mentes', color: '#8b7ec8' },
  { id: 'dessert', name: 'Sobremesa', icon: 'dessert', price: 40, currency: 'BRL', description: 'Uma sobremesa para adocar o momento', color: '#f0a0c0' }
];

app.get('/api/gift-catalog', (req, res) => { res.json(GIFT_CATALOG); });

// Send gift — if needsAddress, creates a pending address request
app.post('/api/gift/send', (req, res) => {
  const { relationId, fromUserId, giftId, message, paymentMethod } = req.body;
  const rel = db.relations[relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relacao expirada.' });
  if (rel.userA !== fromUserId && rel.userB !== fromUserId) return res.status(403).json({ error: 'Sem permissao.' });
  const gift = GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) return res.status(400).json({ error: 'Presente nao encontrado.' });
  const toUserId = rel.userA === fromUserId ? rel.userB : rel.userA;
  const fromUser = db.users[fromUserId];
  const id = uuidv4();
  const giftRecord = {
    id, giftId, giftName: gift.name, icon: gift.icon,
    price: gift.price, currency: gift.currency || 'BRL',
    message: message || '',
    from: fromUserId, fromName: fromUser?.nickname || fromUser?.name || '?', fromColor: fromUser?.color,
    to: toUserId, relationId,
    paymentMethod: paymentMethod || 'pending',
    status: 'delivered',
    createdAt: Date.now()
  };
  if (!db.gifts[toUserId]) db.gifts[toUserId] = [];
  if (!db.gifts[fromUserId]) db.gifts[fromUserId] = [];
  db.gifts[toUserId].push(giftRecord);
  db.gifts[fromUserId].push({ ...giftRecord, _role: 'sender' });
  // Register financial transaction as a tip (gift value sent as gorjeta)
  const tipId = uuidv4();
  const toUser = db.users[toUserId];
  const tipRecord = {
    id: tipId,
    type: 'gift',
    giftId: gift.id,
    giftName: gift.name,
    payerId: fromUserId,
    payerName: fromUser?.nickname || fromUser?.name || '?',
    receiverId: toUserId,
    receiverName: toUser?.nickname || toUser?.name || '?',
    amount: gift.price,
    currency: gift.currency || 'BRL',
    fee: 0,
    relationId,
    paymentMethod: paymentMethod || 'gateway',
    status: 'approved',
    message: message || '',
    createdAt: Date.now()
  };
  db.tips[tipId] = tipRecord;
  // Update receiver tip stats
  if (toUser) {
    toUser.tipsReceived = (toUser.tipsReceived || 0) + 1;
    toUser.tipsTotal = (toUser.tipsTotal || 0) + gift.price;
  }
  // Update sender tip stats
  if (fromUser) {
    fromUser.tipsSent = (fromUser.tipsSent || 0) + 1;
    fromUser.tipsSentTotal = (fromUser.tipsSentTotal || 0) + gift.price;
  }
  // Award coins to recipient
  if (!db.users[toUserId].pointLog) db.users[toUserId].pointLog = [];
  db.users[toUserId].pointLog.push({ value: gift.price, type: 'gift-tip', from: fromUserId, giftName: gift.name, tipId, timestamp: Date.now() });
  if (db.users[toUserId].pointLog.length > 500) db.users[toUserId].pointLog = db.users[toUserId].pointLog.slice(-500);
  // Log sender gift action
  if (!db.users[fromUserId].pointLog) db.users[fromUserId].pointLog = [];
  db.users[fromUserId].pointLog.push({ value: getGameConfig().pointsGift || 10, type: 'gift-sent', giftName: gift.name, tipId, timestamp: Date.now() });
  if (db.users[fromUserId].pointLog.length > 500) db.users[fromUserId].pointLog = db.users[fromUserId].pointLog.slice(-500);
  saveDB('gifts', 'users', 'tips');
  // Add system message to chat (persistent - both sent and received visible)
  const sysMsgSent = { id: uuidv4(), userId: fromUserId, text: 'Enviou ' + gift.name + ' (R$' + gift.price + ')', type: 'gift', timestamp: Date.now(), giftId: gift.id, giftIcon: gift.icon, giftPrice: gift.price, giftColor: gift.color };
  const sysMsgReceived = { id: uuidv4(), userId: 'system', text: (fromUser?.nickname || '?') + ' te presenteou com ' + gift.name + ' (R$' + gift.price + ')', type: 'gift', timestamp: Date.now(), giftId: gift.id, giftIcon: gift.icon, giftPrice: gift.price, giftColor: gift.color };
  if (!db.messages[relationId]) db.messages[relationId] = [];
  db.messages[relationId].push(sysMsgSent);
  if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
  saveDB('messages');
  // Notify both users via socket
  io.to(`user:${toUserId}`).emit('gift-received', { relationId, gift: giftRecord });
  io.to(`user:${toUserId}`).emit('new-message', { relationId, message: sysMsgReceived });
  io.to(`user:${fromUserId}`).emit('new-message', { relationId, message: sysMsgSent });
  res.json({ ok: true, gift: giftRecord, tipId });
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
    lang: user.lang || 'pt-br',
    country: user.country || null,
    city: user.city || null,
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
    lang: user.lang || 'pt-br',
    country: user.country || null,
    city: user.city || null,
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
  const { userId, nickname, realName, phone, instagram, tiktok, twitter, bio, profilePhoto, email, cpf, privacy, avatarAccessory, profession, sports, hobbies, country, city } = req.body;
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
    const oldNick = user.nickname;
    if (oldNick) IDX.nickname.delete(oldNick.toLowerCase());
    IDX.nickname.set(newNick.toLowerCase(), userId);
    user.nickname = newNick;
    user.name = user.name === oldNick ? newNick : user.name;
    // Broadcast nickname change to all connected partners via socket
    const myRelIds = IDX.relationsByUser.get(userId);
    if (myRelIds) {
      myRelIds.forEach(rid => {
        const rel = db.relations[rid];
        if (!rel) return;
        const partnerId = rel.userA === userId ? rel.userB : rel.userA;
        io.to(partnerId).emit('partner-profile-updated', { userId, nickname: newNick, color: user.color });
      });
    }
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
  if (instagram !== undefined) user.instagram = sanitizeStr(instagram, 100);
  if (tiktok !== undefined) user.tiktok = sanitizeStr(tiktok, 100);
  if (twitter !== undefined) user.twitter = sanitizeStr(twitter, 100);
  if (privacy !== undefined) user.privacy = privacy;
  if (bio !== undefined) user.bio = sanitizeStr(bio, 500);
  if (profession !== undefined) user.profession = sanitizeStr(profession, 100);
  if (sports !== undefined) user.sports = Array.isArray(sports) ? sports.slice(0, 2) : [];
  if (hobbies !== undefined) user.hobbies = Array.isArray(hobbies) ? hobbies.slice(0, 2) : [];
  if (country !== undefined) user.country = country || null;
  if (city !== undefined) user.city = sanitizeStr(city, 60);
  if (profilePhoto !== undefined && profilePhoto) {
    // Only update profilePhoto if a real value is provided (ignore empty string to avoid clearing)
    if (profilePhoto.length > 2000000) return res.status(400).json({ error: 'Foto muito grande (máx 2MB).' });
    if (profilePhoto.startsWith('data:image')) {
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
  if (profilePhoto && user.revealedTo && user.revealedTo.length > 0) {
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

  // Broadcast photo change to partners if photo was updated
  if (profilePhoto !== undefined && profilePhoto) {
    const myRelIds = IDX.relationsByUser.get(userId);
    if (myRelIds) {
      const freshPhoto = user.profilePhoto || user.photoURL || null;
      myRelIds.forEach(rid => {
        const rel = db.relations[rid];
        if (!rel) return;
        const partnerId = rel.userA === userId ? rel.userB : rel.userA;
        io.to(partnerId).emit('partner-profile-updated', { userId, profilePhoto: freshPhoto });
      });
    }
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
  // Broadcast reveal to target's network for live constellation update
  io.to(`user:${targetUserId}`).emit('network-reveal', { userId: userId, realName: user.realName, profilePhoto: userPhoto, timestamp: Date.now() });
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
  // Check for existing pending request via IDX (O(1) instead of O(n))
  const existingRRId = IDX.revealByPair.get(userId + '_' + targetUserId);
  if (existingRRId && db.revealRequests[existingRRId]?.status === 'pending') {
    return res.status(400).json({ error: 'Pedido já enviado. Aguardando resposta.' });
  }
  const reqId = uuidv4();
  db.revealRequests[reqId] = {
    id: reqId, fromUserId: userId, toUserId: targetUserId,
    relationId: relId, status: 'pending', type: 'request-reveal', createdAt: Date.now()
  };
  // Update IDX
  if (!IDX.revealByTo.has(targetUserId)) IDX.revealByTo.set(targetUserId, new Set());
  IDX.revealByTo.get(targetUserId).add(reqId);
  if (!IDX.revealByFrom.has(userId)) IDX.revealByFrom.set(userId, new Set());
  IDX.revealByFrom.get(userId).add(reqId);
  IDX.revealByPair.set(userId + '_' + targetUserId, reqId);
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
  // Remove from IDX (no longer pending)
  const _rrTo = IDX.revealByTo.get(rr.toUserId); if (_rrTo) { _rrTo.delete(requestId); if (_rrTo.size === 0) IDX.revealByTo.delete(rr.toUserId); }
  const _rrFrom = IDX.revealByFrom.get(rr.fromUserId); if (_rrFrom) { _rrFrom.delete(requestId); if (_rrFrom.size === 0) IDX.revealByFrom.delete(rr.fromUserId); }
  IDX.revealByPair.delete(rr.fromUserId + '_' + rr.toUserId);
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
  // Broadcast reveal to requester's network for live constellation update
  io.to(`user:${rr.fromUserId}`).emit('network-reveal', { userId: rr.toUserId, realName: revealer.realName, profilePhoto: revealerPhoto, timestamp: Date.now() });
  io.to(`user:${rr.fromUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'accepted' });
  io.to(`user:${rr.toUserId}`).emit('reveal-status-update', { relationId: relId, fromUserId: rr.fromUserId, toUserId: rr.toUserId, status: 'accepted' });
  if (res) res.json({ ok: true, status: 'accepted' });
}

app.post('/api/identity/reveal-accept', (req, res) => {
  const { revealRequestId, userId, fromUserId } = req.body;
  let reqId = revealRequestId;
  if (!reqId && fromUserId && userId) {
    // Use IDX instead of scanning all revealRequests
    const foundId = IDX.revealByPair.get(fromUserId + '_' + userId);
    if (foundId) reqId = foundId;
  }
  if (!reqId) return res.status(400).json({ error: 'Pedido não encontrado.' });
  acceptRevealInternal(reqId, userId, res);
});

app.post('/api/identity/reveal-decline', (req, res) => {
  const { revealRequestId, userId, fromUserId } = req.body;
  let rr = revealRequestId ? db.revealRequests[revealRequestId] : null;
  if (!rr && fromUserId && userId) {
    // Use IDX instead of scanning all revealRequests
    const pairId = IDX.revealByPair.get(fromUserId + '_' + userId);
    if (pairId) rr = db.revealRequests[pairId];
  }
  if (!rr) return res.status(400).json({ error: 'Pedido não encontrado.' });
  rr.status = 'declined'; rr.respondedAt = Date.now();
  // Remove from IDX (no longer pending)
  const _dTo = IDX.revealByTo.get(rr.toUserId); if (_dTo) { _dTo.delete(rr.id); if (_dTo.size === 0) IDX.revealByTo.delete(rr.toUserId); }
  const _dFrom = IDX.revealByFrom.get(rr.fromUserId); if (_dFrom) { _dFrom.delete(rr.id); if (_dFrom.size === 0) IDX.revealByFrom.delete(rr.fromUserId); }
  IDX.revealByPair.delete(rr.fromUserId + '_' + rr.toUserId);
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
  // Use IDX for O(1) lookup instead of scanning all revealRequests
  const ids = new Set();
  const fromSet = IDX.revealByFrom.get(uid);
  if (fromSet) fromSet.forEach(id => ids.add(id));
  const toSet = IDX.revealByTo.get(uid);
  if (toSet) toSet.forEach(id => ids.add(id));
  const pending = [];
  ids.forEach(rrid => {
    const rr = db.revealRequests[rrid];
    if (rr && rr.status === 'pending') {
      pending.push({
        id: rr.id, fromUserId: rr.fromUserId, toUserId: rr.toUserId,
        relationId: rr.relationId, status: rr.status, createdAt: rr.createdAt,
        direction: rr.fromUserId === uid ? 'sent' : 'received'
      });
    }
  });
  res.json(pending);
});

// ══ LIKE SYSTEM ══
app.post('/api/like/toggle', (req, res) => {
  const { userId, targetUserId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Alvo inválido.' });
  if (userId === targetUserId) return res.status(400).json({ error: 'Não pode curtir a si mesmo.' });
  const target = db.users[targetUserId];
  // Check if already liked via IDX (O(1) instead of O(n) scan of db.likes)
  const likedSet = IDX.likedBy.get(targetUserId);
  const alreadyLiked = likedSet && likedSet.has(userId);
  let liked;
  if (alreadyLiked) {
    // Unlike — find and remove from db.likes
    const existingId = Object.keys(db.likes).find(k => db.likes[k].fromUserId === userId && db.likes[k].toUserId === targetUserId);
    if (existingId) delete db.likes[existingId];
    if (!target.likedBy) target.likedBy = [];
    target.likedBy = target.likedBy.filter(id => id !== userId);
    target.likesCount = Math.max(0, (target.likesCount || 0) - 1);
    // Clean up like timestamp
    const liker = db.users[userId];
    if (liker && liker._likedAt) delete liker._likedAt[targetUserId];
    // Update IDX
    if (likedSet) { likedSet.delete(userId); if (likedSet.size === 0) IDX.likedBy.delete(targetUserId); }
    liked = false;
  } else {
    // Like
    const likeId = uuidv4();
    db.likes[likeId] = { id: likeId, fromUserId: userId, toUserId: targetUserId, createdAt: Date.now() };
    if (!target.likedBy) target.likedBy = [];
    if (!target.likedBy.includes(userId)) target.likedBy.push(userId);
    target.likesCount = (target.likesCount || 0) + 1;
    // Track timestamp for notifications
    const liker = db.users[userId];
    if (liker) {
      if (!liker._likedAt) liker._likedAt = {};
      liker._likedAt[targetUserId] = Date.now();
    }
    // Update IDX
    if (!IDX.likedBy.has(targetUserId)) IDX.likedBy.set(targetUserId, new Set());
    IDX.likedBy.get(targetUserId).add(userId);
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
      io.to(`user:${uid}`).emit('network-star', { userId: toUserId, nickname: toUser.nickname || toUser.name, starsCount: toUser.stars.length, timestamp: Date.now() });
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

// ══ STAR SHOP v2 — Buy temporary stars with fixed price ══
app.post('/api/star/buy', (req, res) => {
  const { userId, target } = req.body; // target: 'self' or a userId to gift
  const cfg = getGameConfig();
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  const isSelf = !target || target === 'self' || target === userId;
  const recipientId = isSelf ? userId : target;
  if (!db.users[recipientId]) return res.status(400).json({ error: 'Destinatario invalido.' });

  const recipientUser = db.users[recipientId];
  if (!recipientUser.stars) recipientUser.stars = [];

  // Check max 10 profile stars total (excludes Top 1 donation pool)
  const breakdown = getStarBreakdown(recipientId);
  if (breakdown.profileTotal >= cfg.maxStarsTotal) {
    return res.status(400).json({ error: 'Limite de ' + cfg.maxStarsTotal + ' estrelas atingido.' });
  }

  // Check max temporary stars (5)
  if (breakdown.temporary >= cfg.maxTempStars) {
    return res.status(400).json({ error: 'Limite de ' + cfg.maxTempStars + ' estrelas temporarias atingido.' });
  }

  // Fixed price (no escalation)
  const cost = cfg.starPriceFixed;

  // Check if user has enough score
  const rawScore = calcRawScore(userId);
  const alreadySpent = user.pointsSpent || 0;
  const spendable = rawScore - alreadySpent;

  if (spendable < cost) {
    return res.status(400).json({ error: 'Moedas insuficientes. Custo: ' + cost + ', Disponivel: ' + Math.round(spendable) });
  }

  // Deduct points
  user.pointsSpent = (user.pointsSpent || 0) + cost;

  // Award temporary star with expiration
  const starId = uuidv4();
  const expiresAt = Date.now() + (cfg.tempStarDurationDays * 86400000);
  recipientUser.stars.push({
    id: starId,
    from: isSelf ? 'shop_self' : userId,
    fromName: isSelf ? 'Loja' : user.nickname,
    donatedAt: Date.now(),
    type: 'purchased',
    category: 'temporary',
    cost,
    expiresAt
  });
  recalcAllTopTags();

  if (!isSelf) {
    db.starDonations[starId] = { id: starId, fromUserId: userId, toUserId: recipientId, timestamp: Date.now(), type: 'purchased', cost };
    io.to(`user:${recipientId}`).emit('star-received', { fromUserId: userId, fromName: user.nickname, total: recipientUser.stars.length });
  }

  saveDB('users');
  io.to(`user:${recipientId}`).emit('star-earned', { reason: 'purchased', context: isSelf ? 'Comprou na loja' : 'Presente de ' + user.nickname, totalEarned: recipientUser.stars.length });

  // Notify network that someone earned a star (privacy: no info about how)
  const recipientEnc = new Set((db.encounters[recipientId] || []).map(e => e.with));
  recipientEnc.delete(recipientId);
  if (!isSelf) recipientEnc.delete(userId);
  const bd = getStarBreakdown(recipientId);
  recipientEnc.forEach(uid => {
    io.to('user:' + uid).emit('star-donated-notification', {
      recipientName: recipientUser.nickname || recipientUser.name,
      recipientStars: bd.profileTotal
    });
    io.to('user:' + uid).emit('network-star', {
      userId: recipientId,
      nickname: recipientUser.nickname || recipientUser.name,
      starsCount: bd.profileTotal,
      timestamp: Date.now()
    });
  });

  res.json({ ok: true, starId, cost, recipientStars: bd.profileTotal, pointsRemaining: Math.round(rawScore - (user.pointsSpent || 0)), expiresAt });
});

// Star shop info — prices, available points, breakdown
app.get('/api/star/shop/:userId', (req, res) => {
  const cfg = getGameConfig();
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Nao encontrado.' });
  const rawScore = calcRawScore(req.params.userId);
  const spendable = rawScore - (user.pointsSpent || 0);
  const breakdown = getStarBreakdown(req.params.userId);
  const uniqueConns = getUniqueConnections(req.params.userId);
  const canBuyTemp = breakdown.temporary < cfg.maxTempStars && breakdown.profileTotal < cfg.maxStarsTotal;
  res.json({
    spendablePoints: Math.round(spendable),
    fixedPrice: cfg.starPriceFixed,
    cost: cfg.starPriceFixed,
    canBuy: canBuyTemp && spendable >= cfg.starPriceFixed,
    canBuyTemp,
    breakdown,
    uniqueConnections: uniqueConns,
    milestones: cfg.milestoneStars,
    maxTotal: cfg.maxStarsTotal,
    maxTemp: cfg.maxTempStars,
    maxTempStars: cfg.maxTempStars,
    tempDurationDays: cfg.tempStarDurationDays
  });
});

app.get('/api/stars/available/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Nao encontrado.' });
  const stars = (user.stars || []).length;
  const pending = (user.pendingStars || []).length;
  res.json({ total: stars, pending, available: stars + pending });
});

// ══ STAR PROFILE — Detailed star breakdown for profile view ══
// NOTE: /api/stars/ranking and /api/stars/friends-ranking were moved ABOVE /api/stars/:userId
// to avoid Express matching "ranking" as a :userId param
app.get('/api/stars/profile/:userId', (req, res) => {
  const cfg = getGameConfig();
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Nao encontrado.' });
  const breakdown = getStarBreakdown(req.params.userId);
  const uniqueConns = getUniqueConnections(req.params.userId);
  const rawScore = calcRawScore(req.params.userId);
  const spendable = rawScore - (user.pointsSpent || 0);

  // Build 10 slots with status
  // All milestone stars (conquest + permanent) are now unified as "permanent"
  const slots = [];
  const stars = (user.stars || []).filter(s => s.category !== 'donation_pool');
  const permStars = stars.filter(s => s.category === 'conquest' || s.category === 'permanent')
    .sort((a, b) => (a.milestone || 0) - (b.milestone || 0));
  const tempStars = stars.filter(s => !s.category || s.category === 'temporary')
    .filter(s => !s.permanent) // Exclude Top 1 permanent-temp stars for sorting
    .sort((a, b) => (a.donatedAt || 0) - (b.donatedAt || 0));
  // Top 1 permanent "temporary" stars (they never expire)
  const top1TempStars = stars.filter(s => s.category === 'temporary' && s.permanent);
  const allTempStars = [...top1TempStars, ...tempStars];
  const profStars = stars.filter(s => s.category === 'professional');

  // Slots 0-2: Permanent (100, 500, 1000 connections) — all equal
  const milestones = cfg.milestoneStars || [100, 500, 1000];
  for (let i = 0; i < 3; i++) {
    const star = permStars[i];
    slots.push({
      index: i, category: 'permanent', color: 'gold',
      filled: !!star, milestone: milestones[i] || (i + 1) * 100,
      progress: Math.min(uniqueConns, milestones[i] || 100),
      star: star || null
    });
  }

  // Slots 3-7: Temporary (buyable, 30-day expiry)
  for (let i = 0; i < 5; i++) {
    const star = allTempStars[i];
    const isPermanentTemp = star && star.permanent; // Top 1 temp stars never expire
    slots.push({
      index: 3 + i, category: 'temporary', color: 'gold',
      filled: !!star, cost: cfg.starPriceFixed,
      canBuy: !star && spendable >= cfg.starPriceFixed,
      expiresAt: star && !isPermanentTemp ? star.expiresAt : null,
      daysLeft: star && star.expiresAt && !isPermanentTemp ? Math.max(0, Math.ceil((star.expiresAt - Date.now()) / 86400000)) : null,
      star: star || null
    });
  }

  // Slots 8-9: Professional recognition (ouro branco)
  for (let i = 0; i < 2; i++) {
    const star = profStars[i];
    slots.push({
      index: 8 + i, category: 'professional', color: 'white_gold',
      filled: !!star, star: star || null
    });
  }

  res.json({
    userId: req.params.userId,
    slots,
    breakdown,
    totalStars: breakdown.profileTotal,
    uniqueConnections: uniqueConns,
    score: Math.round(spendable),
    totalScore: Math.round(rawScore),
    spent: user.pointsSpent || 0,
    starPriceFixed: cfg.starPriceFixed,
    maxTotal: cfg.maxStarsTotal
  });
});

// ══ GAME CONFIG — Admin endpoints ══
// Get current config
app.get('/api/admin/game-config', (req, res) => {
  res.json(getGameConfig());
});

// Update config (Top 1 or admin, or admin panel direct)
app.post('/api/admin/game-config', adminLimiter, (req, res) => {
  // Support both formats: {userId, changes} and {config} (from admin panel)
  let userId = req.body.userId || 'admin';
  let changes = req.body.changes || req.body.config;
  if (!changes) return res.status(400).json({ error: 'changes ou config obrigatorio.' });
  const cfg = getGameConfig();
  // Check if user is Top 1 (most stars) or has admin flag
  // userId='admin' is always authorized (admin panel direct access)
  const user = db.users[userId];
  const isAdmin = userId === 'admin' || (user && user.isAdmin === true);
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
    if (!allowed.includes(key)) continue;
    const defVal = DEFAULT_GAME_CONFIG[key];
    // Type check: arrays must match arrays, primitives must match type
    const isArray = Array.isArray(defVal);
    if (isArray ? Array.isArray(val) : typeof val === typeof defVal) {
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

// ═══════════════════════════════════════════════════════════════
// ═══ MURAL DA CIDADE — Muro publico digital por canal ═══════
// ═══════════════════════════════════════════════════════════════

// Mural star-based privileges
function getMuralPrivileges(user) {
  const stars = (user.stars || []).length;
  if (stars >= 10) return { maxWords: 80, cooldownMs: 60000, isMod: true };
  if (stars >= 6)  return { maxWords: 80, cooldownMs: 120000, isMod: false };
  if (stars >= 3)  return { maxWords: 65, cooldownMs: 180000, isMod: false };
  return { maxWords: 50, cooldownMs: 300000, isMod: false };
}

// Normalize channel key (lowercase, trim, no special chars except dash/space)
function normalizeChannel(raw) {
  return (raw || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 80);
}

// Reverse geocode lat/lng to city, state, country, region
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=pt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const d = await resp.json();
    return {
      city: d.city || d.locality || '',
      state: d.principalSubdivision || '',
      country: d.countryName || '',
      countryCode: d.countryCode || '',
      continent: d.continent || ''
    };
  } catch (e) {
    console.error('[mural] reverseGeocode error:', e.message);
    return null;
  }
}

// Canais dinamicos: encontra cidades de conexoes recentes (ultimos 10 dias)
function _getDynamicChannels(userId) {
  const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const userGeo = db.users[userId] && db.users[userId].muralGeo;
  const userCityKey = userGeo ? normalizeChannel(userGeo.city + '-' + (userGeo.countryCode || '')) : '';
  const dynChannels = [];
  const seenKeys = new Set();
  for (const rel of Object.values(db.relations || {})) {
    // Conexao dos ultimos 10 dias
    if (!rel.createdAt || (now - rel.createdAt) > TEN_DAYS) continue;
    const otherId = rel.userA === userId ? rel.userB : (rel.userB === userId ? rel.userA : null);
    if (!otherId) continue;
    const other = db.users[otherId];
    if (!other || !other.muralGeo || !other.muralGeo.city) continue;
    const otherGeo = other.muralGeo;
    const cityKey = normalizeChannel(otherGeo.city + '-' + (otherGeo.countryCode || ''));
    // So adicionar se e uma cidade diferente da do usuario
    if (cityKey === userCityKey || seenKeys.has(cityKey)) continue;
    seenKeys.add(cityKey);
    dynChannels.push({
      type: 'dynamic',
      name: otherGeo.city,
      key: cityKey,
      expiresAt: rel.createdAt + TEN_DAYS,
      fromUser: other.nickname || otherId
    });
  }
  return dynChannels;
}

// GET /api/mural/geocode/:userId — detect user city from stored location
app.get('/api/mural/geocode/:userId', requireAuth, async (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(400).json({ error: 'Usuario invalido.' });
  const loc = db.checkins[userId];
  if (!loc || !loc.lat || !loc.lng) return res.status(400).json({ error: 'Localizacao nao disponivel. Ative o GPS.' });
  const geo = await reverseGeocode(loc.lat, loc.lng);
  if (!geo || !geo.city) return res.status(500).json({ error: 'Nao foi possivel detectar a cidade.' });
  // Cache on user object
  user.muralGeo = { ...geo, updatedAt: Date.now() };
  saveDB('users');
  // Build channels list (cidade, estado, pais, mundo)
  const channels = [];
  if (geo.city) channels.push({ type: 'city', name: geo.city, key: normalizeChannel(geo.city + '-' + geo.countryCode) });
  if (geo.state) channels.push({ type: 'state', name: geo.state, key: normalizeChannel(geo.state + '-' + geo.countryCode) });
  if (geo.country) channels.push({ type: 'country', name: geo.country, key: normalizeChannel(geo.country) });
  channels.push({ type: 'world', name: 'Mundo', key: 'mundo-global' });
  // Canais dinamicos: cidades de conexoes recentes (touch em outra cidade, dura 10 dias)
  const dynChannels = _getDynamicChannels(userId);
  for (const dc of dynChannels) {
    // Evitar duplicata com canais ja existentes
    if (!channels.find(c => c.key === dc.key)) {
      channels.push(dc);
    }
  }
  res.json({ ok: true, geo, channels });
});

// GET /api/mural/:channelKey — list posts (paginated, newest last for wall effect)
app.get('/api/mural/:channelKey', requireAuth, (req, res) => {
  const channelKey = req.params.channelKey;
  const before = parseInt(req.query.before) || Date.now() + 1;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const now = Date.now();
  // Firebase pode converter arrays em objetos — garantir que e array
  let raw = db.muralPosts[channelKey] || [];
  if (!Array.isArray(raw)) {
    raw = Object.values(raw).filter(p => p && typeof p === 'object' && p.id);
    db.muralPosts[channelKey] = raw; // fix in memory
  }
  let posts = raw
    .filter(p => !p.hidden && p.createdAt < before && (!p.expiresAt || p.expiresAt > now));
  // Sort oldest first (wall: newest at bottom)
  posts.sort((a, b) => a.createdAt - b.createdAt);
  // Take last N (most recent)
  const total = posts.length;
  posts = posts.slice(-limit);
  console.log('[mural] GET #' + channelKey + ' — ' + raw.length + ' raw, ' + total + ' visible, returning ' + posts.length);
  res.json({ posts, total, channelKey });
});

// POST /api/mural/:channelKey/post — write on the wall
app.post('/api/mural/:channelKey/post', requireAuth, muralLimiter, (req, res) => {
  const channelKey = req.params.channelKey;
  const { userId, text, channelName, channelType } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'Campos obrigatorios.' });
  const user = db.users[userId];
  if (!user) return res.status(400).json({ error: 'Usuario invalido.' });
  // Check ban
  const banKey = 'ban:' + channelKey;
  if (db.muralFlags[banKey]) {
    const ban = db.muralFlags[banKey].find(b => b.userId === userId && b.expiresAt > Date.now());
    if (ban) return res.status(403).json({ error: 'Voce esta banido deste canal. Aguarde 24h.' });
  }
  const priv = getMuralPrivileges(user);
  // Check cooldown — garantir que e array
  let allPosts = db.muralPosts[channelKey] || [];
  if (!Array.isArray(allPosts)) {
    allPosts = Object.values(allPosts).filter(p => p && p.id);
    db.muralPosts[channelKey] = allPosts;
  }
  const lastPost = [...allPosts].reverse().find(p => p.userId === userId && !p.isNarrator);
  if (lastPost && (Date.now() - lastPost.createdAt) < priv.cooldownMs) {
    const wait = Math.ceil((priv.cooldownMs - (Date.now() - lastPost.createdAt)) / 1000);
    return res.status(429).json({ error: 'Aguarde ' + wait + 's para escrever novamente.' });
  }
  // Validate word count
  const cleanText = text.trim();
  const wordCount = cleanText.split(/\s+/).length;
  if (wordCount > priv.maxWords) return res.status(400).json({ error: 'Maximo de ' + priv.maxWords + ' palavras.' });
  if (cleanText.length < 2) return res.status(400).json({ error: 'Minimo 2 caracteres.' });
  if (cleanText.length > 500) return res.status(400).json({ error: 'Texto muito longo.' });
  // Create post (dura 24h — so ops podem apagar antes)
  const now = Date.now();
  const post = {
    id: 'mrl_' + now + '_' + Math.random().toString(36).slice(2, 6),
    channelKey,
    channelName: channelName || channelKey,
    channelType: channelType || 'city',
    userId,
    nick: user.nickname || '??',
    color: user.color || '#888',
    stars: (user.stars || []).length,
    accessory: user.avatarAccessory || null,
    text: cleanText,
    likes: [],
    createdAt: now,
    expiresAt: now + 24 * 3600000, // 24h
    hidden: false,
    isNarrator: false
  };
  if (!db.muralPosts[channelKey] || !Array.isArray(db.muralPosts[channelKey])) {
    db.muralPosts[channelKey] = Array.isArray(db.muralPosts[channelKey]) ? db.muralPosts[channelKey] : (db.muralPosts[channelKey] ? Object.values(db.muralPosts[channelKey]).filter(p => p && p.id) : []);
  }
  db.muralPosts[channelKey].push(post);
  // Cap at 500 posts per channel
  if (db.muralPosts[channelKey].length > 500) db.muralPosts[channelKey] = db.muralPosts[channelKey].slice(-500);
  saveDBNow('muralPosts');
  // Broadcast para todos que estao vendo OU recebendo posts deste canal
  const broadcastRoom = 'mural:' + channelKey;
  const viewRoom = 'mural-view:' + channelKey;
  // Garantir que remetente esta no room de broadcast
  for (const [sid, s] of io.sockets.sockets) {
    if (s.touchUserId === userId && !s.rooms.has(broadcastRoom)) {
      s.join(broadcastRoom);
    }
  }
  const room = io.sockets.adapter.rooms.get(broadcastRoom);
  const roomSize = room ? room.size : 0;
  const viewRoomObj = io.sockets.adapter.rooms.get(viewRoom);
  const viewSize = viewRoomObj ? viewRoomObj.size : 0;
  console.log('[mural] Post em #' + channelKey + ' por ' + (user.nickname || userId) + ' — ' + roomSize + ' broadcast, ' + viewSize + ' viewers');
  // Broadcast para todos EXCETO o remetente (ele ja recebe via HTTP response)
  // Isso evita race condition entre HTTP response e socket event que causava posts duplicados
  if (room) {
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.touchUserId !== userId) {
        s.emit('mural-new-post', { post });
      }
    }
  }
  // Process @mentions and send notifications
  const mentions = cleanText.match(/@(\w+)/g);
  if (mentions && mentions.length > 0) {
    const mentionedNicks = mentions.map(m => m.slice(1).toLowerCase());
    const notifiedIds = new Set();
    for (const [uid, u] of Object.entries(db.users)) {
      if (uid === userId) continue;
      if (u.nickname && mentionedNicks.includes(u.nickname.toLowerCase()) && !notifiedIds.has(uid)) {
        notifiedIds.add(uid);
        io.to('user:' + uid).emit('notification', {
          type: 'mural-mention',
          fromNick: user.nickname || '??',
          fromColor: user.color || '#888',
          channelKey,
          channelName: channelName || channelKey,
          text: cleanText.slice(0, 80),
          postId: post.id,
          createdAt: now
        });
      }
    }
    if (notifiedIds.size > 0) console.log('[mural] @mentions notified: ' + notifiedIds.size + ' users');
  }
  res.json({ ok: true, post });
});

// POST /api/mural/:postId/flag — report a post (MOD ONLY)
app.post('/api/mural/:postId/flag', requireAuth, (req, res) => {
  const { postId } = req.params;
  const { userId, reason } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  // So moderadores podem reportar
  const user = db.users[userId];
  const priv = getMuralPrivileges(user);
  if (!priv.isMod && !user.isAdmin) return res.status(403).json({ error: 'Apenas moderadores podem reportar.' });
  // Find post across all channels
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    if (!Array.isArray(posts)) continue;
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost) return res.status(404).json({ error: 'Post nao encontrado.' });
  // Mod report = hide imediato
  foundPost.hidden = true;
  foundPost.hiddenReason = 'mod-flag';
  foundPost.hiddenBy = userId;
  saveDBNow('muralPosts');
  io.to('mural:' + foundChannel).emit('mural-post-hidden', { postId });
  res.json({ ok: true });
});

// POST /api/mural/:postId/hide — moderator hides a post
app.post('/api/mural/:postId/hide', requireAuth, (req, res) => {
  const { postId } = req.params;
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  const priv = getMuralPrivileges(user);
  if (!priv.isMod && !user.isAdmin) return res.status(403).json({ error: 'Apenas moderadores podem ocultar posts.' });
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost) return res.status(404).json({ error: 'Post nao encontrado.' });
  foundPost.hidden = true;
  foundPost.hiddenBy = userId;
  foundPost.hiddenReason = 'mod';
  saveDBNow('muralPosts');
  io.to('mural:' + foundChannel).emit('mural-post-hidden', { postId });
  res.json({ ok: true });
});

// POST /api/mural/clear-news — limpar todas as noticias de agentes (operator only)
app.post('/api/mural/clear-news', requireAuth, (req, res) => {
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  if (!user.isAdmin && user.tier !== 'top1') return res.status(403).json({ error: 'Apenas operadores podem limpar noticias.' });
  let total = 0;
  for (const ch of Object.keys(db.muralPosts)) {
    if (!Array.isArray(db.muralPosts[ch])) continue;
    const before = db.muralPosts[ch].length;
    db.muralPosts[ch] = db.muralPosts[ch].filter(p => !p.isNews);
    total += before - db.muralPosts[ch].length;
  }
  saveDBNow('muralPosts');
  console.log('[mural] clear-news: removidas ' + total + ' noticias por ' + userId);
  res.json({ ok: true, removed: total });
});

// POST /api/mural/clear-all — limpar TODAS as mensagens do mural (top1/admin only)
app.post('/api/mural/clear-all', requireAuth, (req, res) => {
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  if (!user.isAdmin && user.tier !== 'top1') return res.status(403).json({ error: 'Apenas operadores podem limpar o mural.' });
  let total = 0;
  for (const ch of Object.keys(db.muralPosts)) {
    if (!Array.isArray(db.muralPosts[ch])) continue;
    total += db.muralPosts[ch].length;
    db.muralPosts[ch] = [];
  }
  saveDBNow('muralPosts');
  console.log('[mural] clear-all: removidas ' + total + ' mensagens por ' + userId);
  res.json({ ok: true, removed: total });
});

// POST /api/mural/:channelKey/narrate — narrator agent summarizes recent activity
app.post('/api/mural/:channelKey/narrate', requireAuth, async (req, res) => {
  const channelKey = req.params.channelKey;
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  const priv = getMuralPrivileges(user);
  if (!priv.isMod && !user.isAdmin) return res.status(403).json({ error: 'Apenas moderadores podem acionar o narrador.' });
  const posts = (db.muralPosts[channelKey] || []).filter(p => !p.hidden && !p.isNarrator);
  if (posts.length < 3) return res.status(400).json({ error: 'Poucas mensagens para narrar.' });
  // Get last 30 posts (news + conversations)
  const recent = posts.slice(-30);
  const newsPosts = recent.filter(p => p.isNews);
  const userPosts = recent.filter(p => !p.isNews);
  const postCount = recent.length;
  const uniqueAuthors = new Set(userPosts.map(p => p.userId)).size;
  let narration = '';
  // Try Perplexity for smart narration
  if (PPLX_API_KEY) {
    try {
      const contextLines = recent.map(p => {
        const tag = p.isNews ? '[noticia de ' + (p.nick || 'agente') + ']' : '[usuario ' + (p.nick || 'anonimo') + ']';
        return tag + ' ' + (p.text || '').slice(0, 200);
      }).join('\n');
      const pplxRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + PPLX_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'Voce e o Narrador do mural da cidade. Faca um breve resumo (3-4 frases) do que esta acontecendo no mural, mencionando os assuntos das noticias e o que os usuarios estao conversando. Escreva em portugues, tom poetico mas direto, sem emojis, sem asteriscos, sem formatacao markdown. Nao cite nomes de usuarios.' },
            { role: 'user', content: 'Resuma a atividade recente deste mural:\n\n' + contextLines }
          ],
          max_tokens: 200,
          temperature: 0.7
        })
      });
      const pplxData = await pplxRes.json();
      if (pplxData.choices && pplxData.choices[0]) {
        narration = pplxData.choices[0].message.content.trim();
      }
    } catch (e) {
      console.log('[narrador] Perplexity falhou, usando heuristica:', e.message);
    }
  }
  // Fallback heuristic if no Perplexity or if it failed
  if (!narration) {
    const newsTopics = newsPosts.map(p => p.nick || 'agente').filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    const lastMinutes = Math.round((Date.now() - recent[0].createdAt) / 60000);
    const timeStr = lastMinutes < 60 ? lastMinutes + ' minutos' : Math.round(lastMinutes / 60) + ' horas';
    if (newsPosts.length > 0 && userPosts.length > 0) {
      narration = 'Nas ultimas ' + timeStr + ', ' + newsPosts.length + ' noticias passaram pelo mural via ' + newsTopics.join(', ') + '. ' + uniqueAuthors + ' pessoas conversaram sobre os assuntos do momento.';
    } else if (newsPosts.length > 0) {
      narration = newsPosts.length + ' noticias chegaram ao mural nas ultimas ' + timeStr + ' via ' + newsTopics.join(', ') + '. A cidade acompanha em silencio.';
    } else {
      narration = uniqueAuthors + ' vozes diferentes ecoaram pelo mural nas ultimas ' + timeStr + '. ' + postCount + ' mensagens trocadas. A cidade pulsa.';
    }
  }
  // Post as narrator
  const narratorPost = {
    id: 'mrl_nar_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    channelKey,
    channelName: channelKey,
    channelType: 'narrator',
    userId: 'narrator',
    nick: 'Narrador',
    color: '#a78bfa',
    stars: 0,
    text: narration,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600000, // 24h
    hidden: false,
    isNarrator: true
  };
  if (!db.muralPosts[channelKey]) db.muralPosts[channelKey] = [];
  if (!Array.isArray(db.muralPosts[channelKey])) {
    db.muralPosts[channelKey] = Object.values(db.muralPosts[channelKey]).filter(p => p && p.id);
  }
  db.muralPosts[channelKey].push(narratorPost);
  saveDBNow('muralPosts');
  io.to('mural:' + channelKey).emit('mural-new-post', { post: narratorPost });
  res.json({ ok: true, post: narratorPost });
});

// ═══ MURAL NEWS AGENTS — sistema de 7 agentes com personalidade ═══
const PPLX_API_KEY = process.env.PPLX_API_KEY || '';
const _newsLastPosted = {}; // agentId:channelKey -> timestamp

// ── Cache de noticias por regiao (otimizacao: mesma cidade = 1 chamada API) ──
const _newsRegionCache = {}; // 'agentId:channelName:channelType' -> { result, ts }
const NEWS_REGION_CACHE_TTL = 50 * 60 * 1000; // 50 min (evergreen agents)
const NEWS_REGION_CACHE_TTL_FACTUAL = 20 * 60 * 1000; // 20 min (factual agents — noticias envelhecem rapido)

// Helper: formata data atual no formato legivel para injetar nos prompts dos agentes
function _getTodayDateStr(lang) {
  const now = new Date();
  const day = now.getDate();
  const months = {
    'pt-br': ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
    'en': ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    'es': ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  };
  var baseLang = (lang || 'pt-br').split('-')[0];
  var monthList = months[lang] || months[baseLang] || months['pt-br'];
  var month = monthList[now.getMonth()];
  var year = now.getFullYear();
  return day + '/' + month + '/' + year;
}
const MAX_CHANNELS_PER_CYCLE = 20; // Limite de canais por ciclo de noticias
const MAX_API_CALLS_PER_HOUR = 60; // Limite de chamadas Perplexity por hora
let _apiCallsThisHour = 0;
setInterval(() => { _apiCallsThisHour = 0; }, 60 * 60 * 1000); // Reset a cada hora

const MURAL_AGENTS = {
  reporter: {
    id: 'reporter',
    nick: 'Noticias',
    nickByLang: { 'pt-br': 'Noticias', en: 'News', es: 'Noticias' },
    color: '#e65100',
    label: 'Noticias Gerais',
    description: 'Noticias locais, agenda cultural, eventos e urgencias',
    factual: true,
    systemPrompt: 'Voce e um jornalista digital serio e objetivo que PRINCIPALMENTE cobre a cena cultural, de entretenimento e eventos locais. Seu FOCO PRINCIPAL e a agenda cultural da cidade: shows de bandas locais e nacionais, barzinhos com musica ao vivo, festivais, feiras, eventos em pracas, circos, teatro, cinema, exposicoes, food trucks, festas comunitarias, eventos religiosos, eventos esportivos locais, inauguracoes e tudo que atrai as pessoas na regiao. NOTICIAS GERAIS sao secundarias -- so traga quando for algo realmente relevante ou URGENTE. Se a noticia for URGENTE (desastre, atentado, morte de figura publica, crise grave), comece com "URGENTE:" e priorize.\n\nREGRA OBRIGATORIA DE DATA: SEMPRE inclua a data do evento ou da publicacao da noticia no formato "dia/mes" (ex: "05/mar", "12/mar"). Se for hoje, escreva "hoje, dia/mes". Se for amanha, escreva "amanha, dia/mes". NUNCA publique uma noticia sem data.\n\nFormato: Uma frase de titulo impactante na primeira linha.\n\nCorpo em 2-3 frases curtas e objetivas. Inclua local, horario, data e se e gratuito quando possivel.\n\nFonte: nome do veiculo, perfil local ou guia cultural. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta no titulo (exceto URGENTE). Va direto ao ponto.',
    queryTemplate: 'Data de HOJE: {date}. Traga sobre {local} UMA das opcoes abaixo (PRIORIZE as opcoes 1 e 2). IMPORTANTE: so traga eventos e noticias de HOJE ({date}) ou dos proximos dias. NUNCA traga noticias antigas ou eventos que ja passaram. 1) Agenda cultural LOCAL para HOJE ou proximos dias: shows de bandas, musica ao vivo em bares, festivais, feiras, eventos em pracas publicas, circos, teatro, cinema, exposicoes, food trucks, festas comunitarias ou eventos que atraiam pessoas da regiao. Busque em Instagram de bares, casas de show, guias culturais e sites de eventos locais. 2) Evento ou acontecimento comunitario: inauguracoes, eventos religiosos, eventos esportivos locais, mutiroes, feiras de artesanato, mercados. 3) SOMENTE se nao houver nada cultural: principal noticia relevante de HOJE ({date}). 4) Se houver algo REALMENTE urgente (desastre, atentado, crise grave), priorize acima de tudo. SEMPRE inclua a data do evento/noticia.',
    enabled: true
  },
  sport: {
    id: 'sport',
    nick: 'Esportes',
    nickByLang: { 'pt-br': 'Esportes', en: 'Sports', es: 'Deportes' },
    color: '#1565c0',
    label: 'Esporte',
    description: 'Noticias de todos os esportes',
    factual: true,
    systemPrompt: 'Voce e um comentarista esportivo apaixonado que cobre todos os esportes. Futebol, basquete, MMA, F1, tenis, volei, olimpiadas e mais. Fale com paixao e opiniao.\n\nREGRA OBRIGATORIA DE DATA: SEMPRE inclua a data do jogo, resultado ou acontecimento no formato "dia/mes" (ex: "05/mar"). Se foi hoje, escreva "hoje, dia/mes". Se e amanha, escreva "amanha, dia/mes". NUNCA publique noticia esportiva sem data.\n\nFormato: Uma frase de titulo na primeira linha.\n\nComentario com opiniao em 2-3 frases. Use linguagem de torcedor. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta.',
    queryTemplate: 'Data de HOJE: {date}. Principal noticia de esporte de HOJE ({date}) no Brasil e no mundo. IMPORTANTE: so traga resultados, jogos ou noticias de HOJE ou de ontem. NUNCA traga noticias de semanas atras. Pode ser futebol, basquete, MMA, F1, tenis ou qualquer esporte. Foco em resultados, transferencias ou polemicas. Inclua a data do acontecimento.',
    enabled: true
  },
  fitness: {
    id: 'fitness',
    nick: 'Fitness',
    nickByLang: { 'pt-br': 'Fitness', en: 'Fitness', es: 'Fitness' },
    color: '#2e7d32',
    label: 'Fitness',
    description: 'Dicas de exercicio e motivacao',
    factual: false,
    systemPrompt: 'Voce e um personal trainer digital animado e motivador. Fale como um coach que incentiva as pessoas. Traga dicas de exercicio e treino. Formato: Uma frase de titulo motivacional na primeira linha.\n\nDica pratica em 2-3 frases. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta.',
    queryTemplate: 'Dica de exercicio ou treino do dia. Algo pratico que qualquer pessoa pode fazer em casa ou na rua em {local}.',
    enabled: true
  },
  saude: {
    id: 'saude',
    nick: 'Saude',
    nickByLang: { 'pt-br': 'Saude', en: 'Health', es: 'Salud' },
    color: '#00897b',
    label: 'Saude',
    description: 'Dicas de saude e bem-estar',
    factual: false,
    systemPrompt: 'Voce e um especialista em saude digital acessivel e confiavel. Traga dicas de saude, prevencao, bem-estar, alimentacao saudavel e saude mental. Nao faca diagnosticos. Formato: Uma frase de titulo na primeira linha.\n\nExplicacao em 2-3 frases claras e uteis. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta. Cite fontes confiaveis quando possivel.',
    queryTemplate: 'Dica de saude, prevencao ou bem-estar do dia. Algo pratico e acessivel para a populacao de {local}.',
    enabled: true
  },
  cozinha: {
    id: 'cozinha',
    nick: 'Cozinha',
    nickByLang: { 'pt-br': 'Cozinha', en: 'Kitchen', es: 'Cocina' },
    color: '#d84315',
    label: 'Cozinha',
    description: 'Receitas e dicas culinarias',
    factual: false,
    systemPrompt: 'Voce e um chef de cozinha carismatico. Fale como um chef que ensina com carinho e simplicidade. Traga receitas faceis e dicas culinarias. Formato: Nome da receita ou dica na primeira linha.\n\nInstrucoes em 2-3 frases simples. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta.',
    queryTemplate: 'Receita facil e rapida ou dica culinaria do dia. Algo acessivel para cozinhar em {local}.',
    enabled: true
  },
  tecnologia: {
    id: 'tecnologia',
    nick: 'Tecnologia',
    nickByLang: { 'pt-br': 'Tecnologia', en: 'Tech', es: 'Tecnologia' },
    color: '#6a1b9a',
    label: 'Tecnologia',
    description: 'Novidades tech e inovacao',
    factual: true,
    systemPrompt: 'Voce e um especialista em tecnologia e inovacao. Fale de forma clara e acessivel sobre tech. Traga novidades de tecnologia, apps, gadgets e IA.\n\nREGRA OBRIGATORIA DE DATA: SEMPRE inclua a data do lancamento ou anuncio no formato "dia/mes" (ex: "05/mar"). Se foi hoje, escreva "hoje, dia/mes". NUNCA publique noticia de tech sem data.\n\nFormato: Uma frase de titulo na primeira linha.\n\nExplicacao em 2-3 frases acessiveis. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta.',
    queryTemplate: 'Data de HOJE: {date}. Principal novidade de tecnologia de HOJE ({date}) no mundo. IMPORTANTE: so traga noticias publicadas HOJE ou ontem. NUNCA traga noticias antigas. Foco em lancamentos, IA, apps ou gadgets. Inclua a data do anuncio.',
    enabled: true
  },
  politica: {
    id: 'politica',
    nick: 'Politica',
    nickByLang: { 'pt-br': 'Politica', en: 'Politics', es: 'Politica' },
    color: '#37474f',
    label: 'Politica',
    description: 'Noticias politicas com analise',
    factual: true,
    systemPrompt: 'Voce e um analista politico imparcial e direto. Traga noticias de politica sem tomar lado, mas com analise critica.\n\nREGRA OBRIGATORIA DE DATA: SEMPRE inclua a data do acontecimento politico no formato "dia/mes" (ex: "05/mar"). Se foi hoje, escreva "hoje, dia/mes". NUNCA publique noticia politica sem data.\n\nFormato: Uma frase de titulo na primeira linha.\n\nAnalise equilibrada em 2-3 frases. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta. Seja imparcial.',
    queryTemplate: 'Data de HOJE: {date}. Principal noticia de politica de HOJE ({date}) no Brasil e no mundo. IMPORTANTE: so traga noticias de HOJE ou de ontem. NUNCA traga noticias de semanas atras. Foco em decisoes que afetam a populacao. Inclua a data do acontecimento.',
    enabled: true
  },
  educacao: {
    id: 'educacao',
    nick: 'Educacao',
    nickByLang: { 'pt-br': 'Educacao', en: 'Education', es: 'Educacion' },
    color: '#f57f17',
    label: 'Educacao',
    description: 'Curiosidades e aprendizado',
    factual: false,
    systemPrompt: 'Voce e um professor curioso e didatico. Traga curiosidades, fatos interessantes e conteudo educativo. Formato: Uma frase de titulo curiosa na primeira linha.\n\nExplicacao didatica em 2-3 frases. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta. Ensine algo novo.',
    queryTemplate: 'Curiosidade interessante ou fato educativo do dia. Algo surpreendente que as pessoas nao sabem.',
    enabled: true
  },
  clima: {
    id: 'clima',
    nick: 'Clima',
    nickByLang: { 'pt-br': 'Clima', en: 'Weather', es: 'Clima' },
    color: '#1976d2',
    label: 'Clima e Tempo',
    description: 'Previsao do tempo e alertas climaticos',
    factual: true,
    systemPrompt: 'Voce e um meteorologista digital confiavel. Traga a previsao do tempo atual, alertas climaticos e informacoes uteis sobre o clima. Fale de forma clara e pratica.\n\nREGRA OBRIGATORIA DE DATA: SEMPRE inclua a data da previsao no formato "dia/mes" (ex: "hoje, 05/mar" ou "amanha, 06/mar"). NUNCA publique previsao sem data.\n\nFormato: Uma frase de titulo sobre o clima na primeira linha.\n\nPrevisao detalhada em 2-3 frases com temperatura, chuva e dicas praticas. Nao use emojis, asteriscos ou formatacao markdown. Nao use caixa alta.',
    queryTemplate: 'Data de HOJE: {date}. Previsao do tempo de HOJE ({date}) e amanha para {local}. IMPORTANTE: a previsao deve ser para a data de HOJE, nao de dias passados. Inclua temperatura, chance de chuva, umidade e se ha alertas meteorologicos. Foque no que as pessoas precisam saber para sair de casa.',
    enabled: true
  }
};

// Helper: pega nick do agente no idioma do canal
function _agentNick(agentId, channelKey) {
  var agent = MURAL_AGENTS[agentId];
  if (!agent) return agentId;
  if (!channelKey || !agent.nickByLang) return agent.nick;
  var lang = _getChannelLang(channelKey);
  var baseLang = lang.split('-')[0]; // pt-br -> pt
  return agent.nickByLang[lang] || agent.nickByLang[baseLang] || agent.nick;
}

// ═══ AGENT SCHEDULE — Grade de horarios locais (substitui round-robin) ═══
// Cada entrada: { hour, minute, agentId }
// Roda 2 ciclos por dia: manha (6h-14h) e tarde/noite (16h-21h)
const AGENT_SCHEDULE = [
  // -- Ciclo da manha --
  { hour: 6,  minute: 0,  agentId: 'reporter' },
  { hour: 6,  minute: 30, agentId: 'clima' },
  { hour: 7,  minute: 0,  agentId: 'saude' },
  { hour: 7,  minute: 30, agentId: 'fitness' },
  { hour: 9,  minute: 0,  agentId: 'tecnologia' },
  { hour: 10, minute: 0,  agentId: 'cozinha' },
  { hour: 11, minute: 0,  agentId: 'politica' },
  { hour: 11, minute: 30, agentId: 'sport' },
  { hour: 12, minute: 0,  agentId: 'reporter' },
  { hour: 14, minute: 0,  agentId: 'educacao' },
  // -- Ciclo da tarde/noite --
  { hour: 16, minute: 0,  agentId: 'reporter' },
  { hour: 16, minute: 30, agentId: 'clima' },
  { hour: 17, minute: 0,  agentId: 'tecnologia' },
  { hour: 17, minute: 30, agentId: 'fitness' },
  { hour: 18, minute: 0,  agentId: 'politica' },
  { hour: 19, minute: 0,  agentId: 'sport' },
  { hour: 20, minute: 0,  agentId: 'tecnologia' },
  { hour: 21, minute: 0,  agentId: 'reporter' }
];

// Tracking: quais slots ja rodaram hoje por canal
// Key: 'channelKey:agentId:HH:MM' -> timestamp
const _scheduleExecuted = {};

// Limpa tracking a cada 12h (evita acumulo)
setInterval(() => {
  const cutoff = Date.now() - 12 * 3600000;
  for (const k of Object.keys(_scheduleExecuted)) {
    if (_scheduleExecuted[k] < cutoff) delete _scheduleExecuted[k];
  }
}, 6 * 3600000);

// Motor de noticias sempre ligado (sem toggle)
const _newsEngineEnabled = true;

// Backward compatible mapping
const NEWS_TOPICS = {};
for (const [key, agent] of Object.entries(MURAL_AGENTS)) {
  NEWS_TOPICS[key] = { label: agent.label, prompt: agent.queryTemplate };
}

// Detectar assunto dominante nos ultimos posts do mural
function _detectMuralContext(channelKey, limit) {
  limit = limit || 10;
  const posts = db.muralPosts[channelKey];
  if (!posts || !Array.isArray(posts)) return '';
  const recent = posts
    .filter(p => p && p.text && !p.isNews && !p.isNarrator && (Date.now() - (p.createdAt || 0)) < 3600000)
    .slice(-limit);
  if (recent.length < 2) return '';
  const texts = recent.map(p => (p.text || '').slice(0, 100)).join(' | ');
  return texts;
}

async function fetchNewsForChannel(channelKey, channelName, channelType, agentId) {
  if (!PPLX_API_KEY) return null;
  const agent = MURAL_AGENTS[agentId] || MURAL_AGENTS.reporter;

  // Detectar idioma do canal
  const lang = _getChannelLang(channelKey);
  const langInst = _langInstruction(lang);

  // Build local name based on channel type
  let localName = channelName || channelKey;
  if (channelType === 'state') localName = (lang === 'en' ? 'state of ' : lang === 'es' ? 'estado de ' : 'estado ') + channelName + (lang === 'pt-br' ? ', Brasil' : '');
  else if (channelType === 'country') localName = channelName;
  else if (channelType === 'region') localName = lang === 'en' ? 'the world' : lang === 'es' ? 'el mundo' : 'mundo';
  else if (channelType === 'world') localName = lang === 'en' ? 'the entire world' : lang === 'es' ? 'el mundo entero' : 'o mundo inteiro';

  // ── Cache por regiao: mesma cidade/estado/pais = reusa resultado ──
  const regionKey = agentId + ':' + (channelName || 'unknown') + ':' + (channelType || 'city');
  const cached = _newsRegionCache[regionKey];
  const cacheTTL = agent.factual ? NEWS_REGION_CACHE_TTL_FACTUAL : NEWS_REGION_CACHE_TTL;
  if (cached && (Date.now() - cached.ts) < cacheTTL) {
    console.log('[MURAL] Cache hit for region:', regionKey, '(ttl:', Math.round(cacheTTL / 60000) + 'min)');
    return cached.result;
  }

  // ── Rate limit: proteger contra excesso de chamadas API ──
  if (_apiCallsThisHour >= MAX_API_CALLS_PER_HOUR) {
    console.log('[MURAL] Rate limit reached (' + MAX_API_CALLS_PER_HOUR + '/h). Skipping fetch for:', channelKey);
    return cached ? cached.result : null; // retorna cache expirado se tiver
  }

  // Detectar contexto do mural para buscar noticias relacionadas
  const muralContext = _detectMuralContext(channelKey);
  // Injetar data real do dia nos queryTemplates que usam {date}
  const todayStr = _getTodayDateStr(lang);
  let query = agent.queryTemplate.replace('{local}', localName).replace(/\{date\}/g, todayStr);
  if (muralContext) {
    query += '\n\nContexto: as pessoas estao conversando sobre: ' + muralContext.slice(0, 300) + '\nSe possivel, traga uma noticia relacionada a esse assunto.';
  }

  _apiCallsThisHour++;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    // Montar body da requisicao -- agentes factuais usam search_recency_filter
    const pplxBody = {
      model: 'sonar',
      messages: [
        { role: 'system', content: agent.systemPrompt + '\n' + langInst },
        { role: 'user', content: query }
      ],
      max_tokens: 350,
      temperature: 0.3,
      return_images: true,
      return_related_questions: false
    };
    // Filtro de recencia: so para agentes factuais (reporter, sport, tech, politica, clima)
    if (agent.factual) {
      pplxBody.search_recency_filter = 'day';
    }
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + PPLX_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pplxBody),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    let text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!text || text.length < 20) return null;
    // Limpar formatacao markdown que aparece literalmente na tela
    text = text.replace(/\*\*/g, '');         // Remove todos **
    text = text.replace(/\*/g, '');           // Remove * soltos
    text = text.replace(/\[\d+\]/g, '');      // Remove [1], [2], etc
    text = text.replace(/  +/g, ' ');         // Colapsar espacos duplos
    text = text.trim().slice(0, 500);

    // Extrair citations da API
    let citations = [];
    if (data.citations && Array.isArray(data.citations)) {
      citations = data.citations.slice(0, 3);
    }

    // Extrair imagens da API (Perplexity retorna array de {imageUrl, originUrl, title, width, height})
    let images = [];
    if (data.images && Array.isArray(data.images) && data.images.length > 0) {
      console.log('[MURAL] Perplexity images raw:', JSON.stringify(data.images.slice(0, 3)));
      images = data.images.slice(0, 2).map(img => {
        if (typeof img === 'string') return img;
        if (typeof img === 'object' && img !== null) {
          return img.imageUrl || img.image_url || img.url || img.src || '';
        }
        return '';
      }).filter(u => u && u.startsWith('http'));
      console.log('[MURAL] Parsed images:', images);
    } else {
      console.log('[MURAL] Perplexity returned no images. data.images:', data.images || 'undefined');
    }

    // Fallback: se Perplexity nao retornou imagens, usar imagem tematica do Picsum/Unsplash
    if (images.length === 0 && text) {
      try {
        const agentKeywords = {
          reporter: 'newspaper,city,news,concert,culture',
          sport: 'sports,soccer,basketball,mma',
          fitness: 'fitness,exercise,gym',
          saude: 'health,medicine,wellness',
          cozinha: 'food,cooking,recipe',
          tecnologia: 'technology,computer,innovation',
          politica: 'government,politics,congress',
          educacao: 'education,books,learning'
        };
        const keywords = agentKeywords[agentId] || 'news,city';
        // Usar Picsum como fallback confiavel (Unsplash Source descontinuado)
        const seed = Math.floor(Math.random() * 9999);
        const fallbackUrl = 'https://picsum.photos/seed/' + agentId + seed + '/800/400';
        images = [fallbackUrl];
        console.log('[MURAL] Fallback image via Picsum for agent:', agentId);
      } catch (imgErr) {
        console.log('[MURAL] Fallback image error:', imgErr.message);
      }
    }

    // Se o modelo nao incluiu "Fonte:", tentar extrair das citations da API
    if (!text.toLowerCase().includes('fonte:') && citations.length > 0) {
      try {
        const url = new URL(citations[0]);
        let domain = url.hostname.replace('www.', '');
        domain = domain.split('.')[0];
        domain = domain.charAt(0).toUpperCase() + domain.slice(1);
        text += '\nFonte: ' + domain;
      } catch (e2) { /* ignore */ }
    }

    // Retornar objeto rico em vez de string simples
    const result = { text, citations, images, muralRelated: !!muralContext };
    // Salvar no cache por regiao
    _newsRegionCache[regionKey] = { result, ts: Date.now() };
    return result;
  } catch (e) {
    return null;
  }
}

async function postNewsToChannel(channelKey, channelName, channelType, agentId) {
  const agent = MURAL_AGENTS[agentId] || MURAL_AGENTS.reporter;
  const result = await fetchNewsForChannel(channelKey, channelName, channelType, agentId);
  if (!result) return;
  // Suportar retorno antigo (string) e novo (objeto)
  const newsText = typeof result === 'string' ? result : result.text;
  const citations = (result && result.citations) || [];
  const images = (result && result.images) || [];
  const muralRelated = (result && result.muralRelated) || false;

  _newsLastPosted[agentId + ':' + channelKey] = Date.now();
  const newsPost = {
    id: 'mrl_news_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    channelKey,
    channelName,
    channelType,
    userId: 'news-agent',
    nick: _agentNick(agentId, channelKey),
    color: agent.color,
    agentType: agentId,
    stars: 0,
    text: newsText,
    citations: citations,
    images: images,
    muralRelated: muralRelated,
    accessory: null,
    likes: [],
    comments: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600000,
    hidden: false,
    isNarrator: false,
    isNews: true,
    newsTopic: agent.label
  };
  if (!db.muralPosts[channelKey]) db.muralPosts[channelKey] = [];
  if (!Array.isArray(db.muralPosts[channelKey])) {
    db.muralPosts[channelKey] = Object.values(db.muralPosts[channelKey]).filter(p => p && p.id);
  }
  db.muralPosts[channelKey].push(newsPost);
  saveDBNow('muralPosts');

  // Salvar no banco de contexto do agente principal (OpenAI VA)
  if (!db.agentNewsContext) db.agentNewsContext = [];
  db.agentNewsContext.push({
    headline: newsText.split('\n')[0],
    agent: agentId,
    channel: channelKey,
    ts: Date.now(),
    muralRelated
  });
  // Manter apenas ultimas 50 noticias no contexto
  if (db.agentNewsContext.length > 50) db.agentNewsContext = db.agentNewsContext.slice(-50);
  saveDB('agentNewsContext');

  io.to('mural:' + channelKey).emit('mural-new-post', { post: newsPost });
  console.log('[' + agentId + '] Posted to #' + channelKey + (muralRelated ? ' (mural-related)' : '') + ' (total: ' + db.muralPosts[channelKey].length + ')');
}

// Helper: buscar canais ativos
// Detectar idioma do canal baseado nos usuarios ativos ou no tipo do canal
function _getChannelLang(channelKey) {
  // Checar usuarios online no canal e pegar o idioma mais comum
  const roomId = 'mural:' + channelKey;
  const room = io.sockets.adapter.rooms.get(roomId);
  if (room && room.size > 0) {
    const langCount = {};
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.touchUserId) {
        const lang = getUserLang(s.touchUserId);
        langCount[lang] = (langCount[lang] || 0) + 1;
      }
    }
    // Pegar o idioma mais frequente
    let topLang = 'pt-br';
    let topCount = 0;
    for (const [lang, count] of Object.entries(langCount)) {
      if (count > topCount) { topLang = lang; topCount = count; }
    }
    if (topCount > 0) return topLang;
  }
  // Fallback: detectar pelo nome do canal
  const lower = channelKey.toLowerCase();
  if (lower.match(/usa|united|new york|los angeles|chicago|miami|texas|california/)) return 'en';
  if (lower.match(/mexico|bogota|lima|buenos|santiago|madrid|barcelona/)) return 'es';
  return 'pt-br';
}

// Helper: instrucao de idioma para injetar nos prompts dos agentes
function _langInstruction(lang) {
  if (lang === 'en') return 'IMPORTANT: Write EVERYTHING in English. All news, titles, comments must be in English.';
  if (lang === 'es') return 'IMPORTANTE: Escribe TODO en espanol. Todas las noticias, titulos y comentarios deben ser en espanol.';
  return 'Escreva tudo em portugues brasileiro.';
}

function _getActiveChannels() {
  const channels = [];
  for (const [chKey, posts] of Object.entries(db.muralPosts || {})) {
    if (!Array.isArray(posts)) continue;
    const validPosts = posts.filter(p => p && p.channelName && p.channelType);
    if (validPosts.length === 0) continue;
    // Contar usuarios online no canal pra priorizar
    const room = io.sockets.adapter.rooms.get('mural:' + chKey);
    const onlineCount = room ? room.size : 0;
    channels.push({ key: chKey, sample: validPosts[validPosts.length - 1], online: onlineCount });
  }
  // Priorizar canais com mais usuarios online
  channels.sort((a, b) => b.online - a.online);
  return channels;
}

// ═══ SCHEDULE-BASED AGENT TIMER — Roda a cada 5 min, checa horarios locais ═══
// Pega timezone de um canal baseado nos usuarios online ou no nome do canal
function _getChannelTimezone(channelKey) {
  // Tenta pegar timezone de algum usuario online no canal
  const room = io.sockets.adapter.rooms.get('mural:' + channelKey);
  if (room && room.size > 0) {
    for (const socketId of room) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock && sock.userId) {
        const u = db.users[sock.userId];
        if (u && u.timezone) return u.timezone;
      }
    }
  }
  // Fallback: tentar inferir do nome do canal
  const posts = db.muralPosts[channelKey];
  if (posts && posts.length > 0) {
    for (let i = posts.length - 1; i >= Math.max(0, posts.length - 20); i--) {
      const p = posts[i];
      if (p && p.userId) {
        const u = db.users[p.userId];
        if (u && u.timezone) return u.timezone;
      }
    }
  }
  return 'America/New_York'; // Default USA (lancamento principal)
}

// Retorna hora e minuto local de um canal
function _getChannelLocalTime(channelKey) {
  const tz = _getChannelTimezone(channelKey);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(new Date());
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    return { hour, minute, tz };
  } catch (e) {
    const now = new Date();
    return { hour: now.getHours(), minute: now.getMinutes(), tz: 'UTC' };
  }
}

// Checa se um canal tem atividade recente (mensagens de usuarios nas ultimas 6h)
function _isChannelActive(channelKey) {
  const posts = db.muralPosts[channelKey];
  if (!posts || !Array.isArray(posts)) return false;
  const sixHours = 6 * 3600000;
  const now = Date.now();
  // Tem pelo menos 1 post de usuario (nao-agente) nas ultimas 6h?
  return posts.some(p =>
    p && !p.isNews && !p.isNarrator && !p.isRadio && p.text &&
    (now - (p.createdAt || 0)) < sixHours
  );
}

// Timer principal: roda a cada 5 min, checa se algum slot da grade deve disparar
setInterval(async () => {
  if (!PPLX_API_KEY || !_newsEngineEnabled) return;
  try {
    const channels = _getActiveChannels().slice(0, MAX_CHANNELS_PER_CYCLE);
    if (channels.length === 0) return;
    let totalPosted = 0;

    for (const ch of channels) {
      // Checar se canal tem atividade recente (so posta se mural ativo)
      if (!_isChannelActive(ch.key)) continue;

      const { hour, minute, tz } = _getChannelLocalTime(ch.key);

      // Percorrer a grade e ver quais slots batem com o horario local (+/- 5 min)
      for (const slot of AGENT_SCHEDULE) {
        const agent = MURAL_AGENTS[slot.agentId];
        if (!agent || !agent.enabled) continue;

        // Checar se estamos dentro da janela do slot (horario local do canal)
        // Slot 6:30 dispara entre 6:25 e 6:35 (janela de 10 min)
        const slotMinutes = slot.hour * 60 + slot.minute;
        const nowMinutes = hour * 60 + minute;
        const diff = Math.abs(nowMinutes - slotMinutes);
        if (diff > 5) continue; // fora da janela

        // Checar se ja executou este slot hoje neste canal
        const schedKey = ch.key + ':' + slot.agentId + ':' + slot.hour + ':' + slot.minute;
        const lastExec = _scheduleExecuted[schedKey] || 0;
        if (Date.now() - lastExec < 20 * 60 * 1000) continue; // ja rodou nos ultimos 20 min

        // Respeitar rate limit
        if (_apiCallsThisHour >= MAX_API_CALLS_PER_HOUR) {
          console.log('[schedule] Rate limit atingido, pulando', slot.agentId, 'em', ch.key);
          continue;
        }

        // Postar!
        await postNewsToChannel(ch.key, ch.sample.channelName, ch.sample.channelType, slot.agentId);
        _newsLastPosted[slot.agentId + ':' + ch.key] = Date.now();
        _scheduleExecuted[schedKey] = Date.now();
        totalPosted++;
        console.log('[schedule] ' + slot.agentId + ' as ' + slot.hour + ':' + String(slot.minute).padStart(2, '0') + ' (local ' + tz + ') em ' + ch.key);
      }
    }
    if (totalPosted > 0) {
      console.log('[schedule] Ciclo: ' + totalPosted + ' posts, API calls/h: ' + _apiCallsThisHour + '/' + MAX_API_CALLS_PER_HOUR);
    }
  } catch (e) {
    console.error('[schedule] Erro no ciclo:', e.message);
  }
}, 5 * 60 * 1000); // Checa a cada 5 minutos

// Cleanup: remover posts expirados (> 24h) a cada 30 minutos
setInterval(() => {
  const now = Date.now();
  let totalRemoved = 0;
  for (const [chKey, posts] of Object.entries(db.muralPosts || {})) {
    if (!Array.isArray(posts)) continue;
    const before = posts.length;
    db.muralPosts[chKey] = posts.filter(p => {
      if (!p || !p.id) return false; // limpar nulos
      if (p.hidden) return false; // remover ocultos
      if (p.expiresAt && p.expiresAt <= now) return false; // remover expirados
      return true;
    });
    totalRemoved += before - db.muralPosts[chKey].length;
  }
  if (totalRemoved > 0) {
    console.log('[mural-cleanup] Removidos ' + totalRemoved + ' posts expirados/ocultos');
    saveDBNow('muralPosts');
  }
  // Cleanup do cache de noticias por regiao (remover entradas expiradas)
  for (const key of Object.keys(_newsRegionCache)) {
    if ((now - _newsRegionCache[key].ts) > NEWS_REGION_CACHE_TTL * 2) {
      delete _newsRegionCache[key];
    }
  }
}, 30 * 60 * 1000); // cada 30min

// Manual trigger: POST /api/mural/:channelKey/news — force fetch news (mod only)
app.post('/api/mural/:channelKey/news', requireAuth, async (req, res) => {
  const { channelKey } = req.params;
  const { userId, agentId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const user = db.users[userId];
  const priv = getMuralPrivileges(user);
  if (!priv.isMod && !user.isAdmin) return res.status(403).json({ error: 'Apenas moderadores podem acionar agentes.' });
  if (!PPLX_API_KEY) return res.status(400).json({ error: 'Agentes indisponiveis no momento.' });
  if (!agentId || !MURAL_AGENTS[agentId]) return res.status(400).json({ error: 'Agente invalido.' });

  const posts = (db.muralPosts[channelKey] || []).filter(p => p.channelName && p.channelType);
  const sample = posts[posts.length - 1];
  if (!sample) return res.status(400).json({ error: 'Canal sem historico.' });

  const agent = MURAL_AGENTS[agentId];
  const result = await fetchNewsForChannel(channelKey, sample.channelName, sample.channelType, agentId);
  if (!result) return res.status(500).json({ error: 'Nao foi possivel buscar noticias agora.' });
  const newsTextStr = typeof result === 'string' ? result : result.text;
  const citationsArr = (result && result.citations) || [];
  const imagesArr = (result && result.images) || [];
  _newsLastPosted[agentId + ':' + channelKey] = Date.now();

  const newsPost = {
    id: 'mrl_news_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    channelKey,
    channelName: sample.channelName,
    channelType: sample.channelType,
    userId: 'news-agent',
    nick: _agentNick(agentId, channelKey),
    color: agent.color,
    agentType: agentId,
    stars: 0,
    text: newsTextStr,
    citations: citationsArr,
    images: imagesArr,
    muralRelated: !!(result && result.muralRelated),
    accessory: null,
    likes: [],
    comments: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600000,
    hidden: false,
    isNarrator: false,
    isNews: true,
    newsTopic: agent.label
  };
  if (!db.muralPosts[channelKey]) db.muralPosts[channelKey] = [];
  if (!Array.isArray(db.muralPosts[channelKey])) {
    db.muralPosts[channelKey] = Object.values(db.muralPosts[channelKey]).filter(p => p && p.id);
  }
  db.muralPosts[channelKey].push(newsPost);
  saveDBNow('muralPosts');
  io.to('mural:' + channelKey).emit('mural-new-post', { post: newsPost });
  res.json({ ok: true, post: newsPost });
});

// POST /api/mural/:postId/like — +1 a post (upvote to pin to top)
app.post('/api/mural/:postId/like', requireAuth, (req, res) => {
  const { postId } = req.params;
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (!foundPost.likes) foundPost.likes = [];
  if (foundPost.likes.includes(userId)) {
    // Unlike
    foundPost.likes = foundPost.likes.filter(id => id !== userId);
  } else {
    foundPost.likes.push(userId);
  }
  saveDBNow('muralPosts');
  io.to('mural:' + foundChannel).emit('mural-post-liked', { postId, likes: foundPost.likes });
  res.json({ ok: true, likes: foundPost.likes });
});

// POST /api/mural/:postId/comment — add comment to a post
app.post('/api/mural/:postId/comment', requireAuth, async (req, res) => {
  const { postId } = req.params;
  const { userId, text } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Comentario vazio.' });
  if (text.trim().length > 300) return res.status(400).json({ error: 'Maximo 300 caracteres.' });
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (!foundPost.comments) foundPost.comments = [];
  const comment = {
    id: 'cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    userId,
    nick: db.users[userId].nick || 'anon',
    color: db.users[userId].color || '#888',
    text: text.trim(),
    likes: [],
    createdAt: Date.now()
  };
  foundPost.comments.push(comment);
  saveDBNow('muralPosts');
  io.to('mural:' + foundChannel).emit('mural-new-comment', { postId, comment });
  res.json({ ok: true, comment });

  // Auto-reply: se o post e uma noticia, o agente responde ao comentario
  if (foundPost.isNews && PPLX_API_KEY) {
    const agentId = foundPost.agentType || 'reporter';
    const agent = MURAL_AGENTS[agentId] || MURAL_AGENTS.reporter;
    const fullNews = (foundPost.text || '').slice(0, 500);
    // Pegar todos os comentarios de usuarios (nao agente) pra contexto
    const userCmts = (foundPost.comments || []).filter(c => !c.isAgent).slice(-5).map(c => (c.nick || 'anon') + ': ' + (c.text || '')).join('\n');
    const lastUserComment = text.trim();
    const userName = db.users[userId].nick || 'anon';
    try {
      const pplxRes = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + PPLX_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            { role: 'system', content: 'Voce e ' + _agentNick(agentId, foundChannel) + ', um bot de noticias em um mural comunitario. Responda ao ultimo comentario do usuario de forma curta (max 2 frases), informativa e conversacional. ' + _langInstruction(_getChannelLang(foundChannel)) + ' Voce tem acesso a noticia completa e ao historico de comentarios.\n\nNoticia completa:\n' + fullNews },
            { role: 'user', content: (userCmts ? 'Comentarios anteriores:\n' + userCmts + '\n\n' : '') + 'Ultimo comentario de ' + userName + ':\n' + lastUserComment }
          ],
          max_tokens: 150,
          temperature: 0.5
        })
      });
      const pplxData = await pplxRes.json();
      let answer = (pplxData.choices && pplxData.choices[0] && pplxData.choices[0].message) ? pplxData.choices[0].message.content : '';
      if (answer && answer.length > 10) {
        answer = answer.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\[\d+\]/g, '').trim().slice(0, 300);
        const agentComment = {
          id: 'cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          userId: 'agent-' + agentId,
          nick: _agentNick(agentId, foundChannel),
          color: agent.color,
          text: answer,
          likes: [],
          isAgent: true,
          createdAt: Date.now()
        };
        foundPost.comments.push(agentComment);
        saveDBNow('muralPosts');
        io.to('mural:' + foundChannel).emit('mural-new-comment', { postId, comment: agentComment });
        console.log('[agent-reply] ' + _agentNick(agentId, foundChannel) + ' respondeu comentario em #' + foundChannel);
      }
    } catch (e) {
      console.error('[agent-reply] Erro:', e.message);
    }
  }
});

// POST /api/mural/:postId/comment/:commentId/like — like a comment
app.post('/api/mural/:postId/comment/:commentId/like', requireAuth, (req, res) => {
  const { postId, commentId } = req.params;
  const { userId } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost) return res.status(404).json({ error: 'Post nao encontrado.' });
  if (!foundPost.comments) foundPost.comments = [];
  const cmt = foundPost.comments.find(c => c.id === commentId);
  if (!cmt) return res.status(404).json({ error: 'Comentario nao encontrado.' });
  if (!cmt.likes) cmt.likes = [];
  if (cmt.likes.includes(userId)) {
    cmt.likes = cmt.likes.filter(id => id !== userId);
  } else {
    cmt.likes.push(userId);
  }
  saveDBNow('muralPosts');
  io.to('mural:' + foundChannel).emit('mural-comment-liked', { postId, commentId, likes: cmt.likes });
  res.json({ ok: true, likes: cmt.likes });
});

// POST /api/mural/:postId/ask-agent — ask the news agent about the topic
app.post('/api/mural/:postId/ask-agent', requireAuth, async (req, res) => {
  const { postId } = req.params;
  const { userId, question } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!question || question.trim().length === 0) return res.status(400).json({ error: 'Pergunta vazia.' });
  if (!PPLX_API_KEY) return res.status(500).json({ error: 'API indisponivel.' });
  let foundPost = null, foundChannel = null;
  for (const [ch, posts] of Object.entries(db.muralPosts)) {
    const p = posts.find(pp => pp.id === postId);
    if (p) { foundPost = p; foundChannel = ch; break; }
  }
  if (!foundPost || !foundPost.isNews) return res.status(404).json({ error: 'Noticia nao encontrada.' });
  const agentId = foundPost.agentType || 'reporter';
  const agent = MURAL_AGENTS[agentId] || MURAL_AGENTS.reporter;
  const headline = (foundPost.text || '').split('\n')[0];
  try {
    const pplxRes = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + PPLX_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'Voce e ' + _agentNick(agentId, foundChannel) + ', um bot de noticias. Responda a pergunta do usuario sobre esta noticia de forma curta (max 150 palavras), informativa. ' + _langInstruction(_getChannelLang(foundChannel)) + ' Noticia: ' + headline },
          { role: 'user', content: question.trim() }
        ],
        max_tokens: 300
      })
    });
    const pplxData = await pplxRes.json();
    const answer = pplxData.choices && pplxData.choices[0] && pplxData.choices[0].message ? pplxData.choices[0].message.content : 'Desculpe, nao consegui responder agora.';
    // Add as a comment from the agent
    if (!foundPost.comments) foundPost.comments = [];
    const agentComment = {
      id: 'cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      userId: 'agent-' + agentId,
      nick: _agentNick(agentId, foundChannel),
      color: agent.color,
      text: answer.trim(),
      likes: [],
      isAgent: true,
      createdAt: Date.now()
    };
    foundPost.comments.push(agentComment);
    // Also add user question as comment
    const userComment = {
      id: 'cmt_' + (Date.now() - 1) + '_' + Math.random().toString(36).slice(2, 5),
      userId,
      nick: db.users[userId].nick || 'anon',
      color: db.users[userId].color || '#888',
      text: '@' + agent.nick + ' ' + question.trim(),
      likes: [],
      isMention: true,
      createdAt: Date.now() - 1
    };
    foundPost.comments.splice(foundPost.comments.length - 1, 0, userComment);
    saveDBNow('muralPosts');
    io.to('mural:' + foundChannel).emit('mural-new-comment', { postId, comment: userComment });
    io.to('mural:' + foundChannel).emit('mural-new-comment', { postId, comment: agentComment });
    res.json({ ok: true, userComment, agentComment });
  } catch (e) {
    console.error('[ask-agent] Error:', e.message);
    res.status(500).json({ error: 'Erro ao consultar agente.' });
  }
});

// GET /api/mural/agents/stats — monitorar consumo de API e cache
app.get('/api/mural/agents/stats', (req, res) => {
  const activeChannels = _getActiveChannels();
  const regionCacheSize = Object.keys(_newsRegionCache).length;
  const onlineTotal = activeChannels.reduce((sum, ch) => sum + ch.online, 0);
  // Contar quantos slots ja executaram hoje
  const slotsExecutedToday = Object.keys(_scheduleExecuted).length;
  const totalSlotsPerDay = AGENT_SCHEDULE.length;
  // Canais ativos (com mensagens de usuarios nas ultimas 6h)
  const activeWithMessages = activeChannels.filter(ch => _isChannelActive(ch.key)).length;
  res.json({
    apiCallsThisHour: _apiCallsThisHour,
    maxApiCallsPerHour: MAX_API_CALLS_PER_HOUR,
    maxChannelsPerCycle: MAX_CHANNELS_PER_CYCLE,
    scheduleMode: 'local-time',
    scheduleSlotsPerDay: totalSlotsPerDay,
    scheduleSlotsExecuted: slotsExecutedToday,
    schedule: AGENT_SCHEDULE.map(s => s.hour + ':' + String(s.minute).padStart(2, '0') + ' ' + s.agentId),
    activeChannels: activeChannels.length,
    activeChannelsWithMessages: activeWithMessages,
    channelsWithUsers: activeChannels.filter(ch => ch.online > 0).length,
    totalOnlineUsers: onlineTotal,
    regionCacheEntries: regionCacheSize,
    regionCacheTTLmin: Math.round(NEWS_REGION_CACHE_TTL / 60000)
  });
});

// GET /api/mural/agents/config — get agent configuration
app.get('/api/mural/agents/config', (req, res) => {
  const config = {};
  for (const [id, agent] of Object.entries(MURAL_AGENTS)) {
    config[id] = {
      id: agent.id,
      nick: agent.nick,
      nickByLang: agent.nickByLang || {},
      color: agent.color,
      label: agent.label,
      description: agent.description,
      enabled: agent.enabled
    };
  }
  res.json({ agents: config });
});

// POST /api/mural/agents/toggle — toggle agent on/off per user preference
app.post('/api/mural/agents/toggle', requireAuth, (req, res) => {
  const { userId, agentId, enabled } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!MURAL_AGENTS[agentId]) return res.status(400).json({ error: 'Agente invalido.' });
  if (!db.users[userId].muralAgentPrefs) db.users[userId].muralAgentPrefs = {};
  db.users[userId].muralAgentPrefs[agentId] = !!enabled;
  saveDBNow('users');
  res.json({ ok: true });
});

// POST /api/mural/seed-demo — insere reportagem demo com comentarios e curtidas
app.post('/api/mural/seed-demo', requireAuth, (req, res) => {
  const { channelKey } = req.body;
  if (!channelKey) return res.status(400).json({ error: 'channelKey obrigatorio.' });
  if (!db.muralPosts[channelKey]) db.muralPosts[channelKey] = [];
  const now = Date.now();
  const fakeUsers = [
    { id: 'demo_usr1', nick: 'Marina', color: '#f472b6' },
    { id: 'demo_usr2', nick: 'Carlos', color: '#60a5fa' },
    { id: 'demo_usr3', nick: 'Pedro', color: '#34d399' },
    { id: 'demo_usr4', nick: 'Ana', color: '#fbbf24' },
    { id: 'demo_usr5', nick: 'Joao', color: '#a78bfa' },
    { id: 'demo_usr6', nick: 'Lucia', color: '#fb923c' },
    { id: 'demo_usr7', nick: 'Rafael', color: '#38bdf8' },
  ];
  const demoPost = {
    id: 'mrl_demo_' + now,
    channelKey,
    channelName: 'Demo',
    channelType: 'city',
    userId: 'news-agent',
    nick: 'Reporter',
    color: '#e65100',
    agentType: 'reporter',
    stars: 0,
    text: 'Brasil avanca em inteligencia artificial e se torna referencia na America Latina\nO governo federal anunciou nesta quinta-feira um pacote de investimentos de R$ 23 bilhoes em pesquisa e desenvolvimento de inteligencia artificial. O programa, batizado de "IA Brasil 2030", preve a criacao de 15 centros de excelencia espalhados pelo pais, com foco em saude, agricultura, educacao e seguranca publica. Especialistas apontam que o Brasil tem potencial para se tornar lider regional no setor, com uma comunidade de desenvolvedores que ja soma mais de 500 mil profissionais. As universidades publicas serao as principais beneficiadas, com bolsas de mestrado e doutorado voltadas exclusivamente para IA.',
    citations: ['https://g1.globo.com/tecnologia/', 'https://www.reuters.com/technology/'],
    images: ['https://picsum.photos/seed/demo' + now + '/800/400'],
    muralRelated: false,
    accessory: null,
    likes: fakeUsers.slice(0, 6).map(u => u.id),
    comments: [
      { id: 'cmt_d1', userId: fakeUsers[0].id, nick: fakeUsers[0].nick, color: fakeUsers[0].color, text: 'Finalmente o Brasil investindo em tecnologia de verdade! Espero que as universidades publicas sejam priorizadas mesmo', likes: [fakeUsers[1].id, fakeUsers[2].id, fakeUsers[4].id], createdAt: now - 3600000 },
      { id: 'cmt_d2', userId: fakeUsers[1].id, nick: fakeUsers[1].nick, color: fakeUsers[1].color, text: 'R$ 23 bilhoes parece muito mas quando distribui entre 15 centros da menos de 2 bi por centro. Sera que e suficiente?', likes: [fakeUsers[0].id, fakeUsers[3].id], createdAt: now - 3200000 },
      { id: 'cmt_d3', userId: fakeUsers[2].id, nick: fakeUsers[2].nick, color: fakeUsers[2].color, text: '@Reporter qual e o prazo pra esses centros comecarem a funcionar?', likes: [fakeUsers[0].id], isMention: true, createdAt: now - 2800000 },
      { id: 'cmt_d3r', userId: 'agent-reporter', nick: 'Reporter', color: '#e65100', text: 'Segundo o cronograma do governo, os primeiros 5 centros devem comecar a operar ate o final de 2027, com os demais sendo inaugurados ate 2029. O foco inicial sera nas regioes Sudeste e Nordeste.', likes: [fakeUsers[2].id, fakeUsers[0].id, fakeUsers[4].id], isAgent: true, createdAt: now - 2700000 },
      { id: 'cmt_d4', userId: fakeUsers[3].id, nick: fakeUsers[3].nick, color: fakeUsers[3].color, text: 'Como profissional de TI fico animada! A area de IA paga muito bem e com mais investimento vai ter mais oportunidade pra todo mundo', likes: [fakeUsers[0].id, fakeUsers[1].id, fakeUsers[5].id, fakeUsers[6].id], createdAt: now - 2000000 },
      { id: 'cmt_d5', userId: fakeUsers[4].id, nick: fakeUsers[4].nick, color: fakeUsers[4].color, text: 'Sera que vai ter bolsa pra quem ja ta na graduacao ou so mestrado/doutorado?', likes: [fakeUsers[5].id], createdAt: now - 1500000 },
      { id: 'cmt_d6', userId: fakeUsers[5].id, nick: fakeUsers[5].nick, color: fakeUsers[5].color, text: 'O mais importante e que esse investimento nao seja desviado. Precisamos de transparencia total', likes: [fakeUsers[0].id, fakeUsers[1].id, fakeUsers[2].id], createdAt: now - 1000000 },
      { id: 'cmt_d7', userId: fakeUsers[6].id, nick: fakeUsers[6].nick, color: fakeUsers[6].color, text: '500 mil devs de IA no Brasil? Impressionante. Mas a maioria ta ganhando pouco... tomara que melhore', likes: [fakeUsers[3].id, fakeUsers[4].id], createdAt: now - 500000 },
    ],
    createdAt: now - 4 * 3600000,
    expiresAt: now + 24 * 3600000,
    hidden: false,
    isNarrator: false,
    isNews: true,
    newsTopic: 'Noticias Gerais'
  };
  db.muralPosts[channelKey].push(demoPost);
  saveDBNow('muralPosts');
  io.to('mural:' + channelKey).emit('mural-new-post', { post: demoPost });
  res.json({ ok: true, post: demoPost });
});

// GET /api/mural/:channelKey/next-news — when is the next auto news?
app.get('/api/mural/:channelKey/next-news', (req, res) => {
  const channelKey = req.params.channelKey;
  const lastTime = _newsLastPosted['reporter:' + channelKey] || _newsLastPosted[channelKey] || 0;
  const nextTime = lastTime + MURAL_AGENTS.reporter.interval;
  const now = Date.now();
  const remainingMs = Math.max(0, nextTime - now);
  res.json({ nextAt: nextTime, remainingMs, intervalMs: MURAL_AGENTS.reporter.interval, lastAt: lastTime || null });
});

// POST /api/mural/news-chat — Perplexity chat about a news article
app.post('/api/mural/news-chat', requireAuth, async (req, res) => {
  const { userId, newsContext, message, history } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!PPLX_API_KEY) return res.status(503).json({ error: 'Servico de chat indisponivel.' });
  if (!newsContext || !newsContext.headline || !newsContext.fullText) {
    return res.status(400).json({ error: 'Contexto da noticia invalido.' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem vazia.' });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);

    const systemPrompt = 'Voce eh um comentarista experiente de noticias. Um usuario quer conversar sobre a seguinte noticia:\n\n'
      + 'Titulo: ' + newsContext.headline + '\n'
      + 'Conteudo: ' + newsContext.fullText.slice(0, 1000) + '\n\n'
      + 'Comente sobre esta noticia com conhecimento, contexto e opiniao bem fundamentada. Seja engajante e conversacional.';

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    if (Array.isArray(history) && history.length > 0) {
      for (const msg of history) {
        if (msg.role && msg.content) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    messages.push({ role: 'user', content: message });

    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + PPLX_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: messages,
        max_tokens: 500,
        temperature: 0.5,
        return_citations: true
      }),
      signal: ctrl.signal
    });

    clearTimeout(timer);
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Erro ao consultar Perplexity.' });
    }

    const data = await resp.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const citations = (data.citations && Array.isArray(data.citations)) ? data.citations.slice(0, 5) : [];

    if (!reply || reply.trim().length === 0) {
      return res.status(400).json({ error: 'Resposta vazia de Perplexity.' });
    }

    res.json({ reply: reply.trim(), citations });
  } catch (e) {
    console.error('[news-chat] Error:', e.message);
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout ao conversar com Perplexity.' });
    }
    res.status(500).json({ error: 'Erro interno ao processar conversa.' });
  }
});

// POST /api/mural/:channelKey/ban — moderator bans user from channel
app.post('/api/mural/:channelKey/ban', requireAuth, (req, res) => {
  const { channelKey } = req.params;
  const { moderatorId, targetUserId, reason } = req.body;
  const modUserId = moderatorId;
  if (!modUserId || !db.users[modUserId]) return res.status(400).json({ error: 'Moderador invalido.' });
  if (!targetUserId || !db.users[targetUserId]) return res.status(400).json({ error: 'Usuario invalido.' });
  const mod = db.users[modUserId];
  const modPriv = getMuralPrivileges(mod);
  if (!modPriv.isMod && !mod.isAdmin) return res.status(403).json({ error: 'Apenas moderadores podem banir.' });
  // Store ban in muralFlags under special key
  const banKey = 'ban:' + channelKey;
  if (!db.muralFlags[banKey]) db.muralFlags[banKey] = [];
  const existing = db.muralFlags[banKey].find(b => b.userId === targetUserId);
  if (existing) return res.status(400).json({ error: 'Usuario ja esta banido neste canal.' });
  db.muralFlags[banKey].push({
    userId: targetUserId,
    bannedBy: modUserId,
    reason: (reason || '').slice(0, 120),
    at: Date.now(),
    expiresAt: Date.now() + 24 * 3600000 // 24h ban
  });
  saveDB('muralFlags');
  // Notify the banned user
  io.to('mural:' + channelKey).emit('mural-user-banned', { targetUserId, channelKey });
  res.json({ ok: true });
});

// Helper: obter usuarios unicos VENDO um canal (deduplica por userId)
function _getMuralViewers(channelKey) {
  const viewRoom = 'mural-view:' + channelKey;
  const sockets = io.sockets.adapter.rooms.get(viewRoom);
  if (!sockets) return [];
  const seen = new Set();
  const users = [];
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.touchUserId && db.users[s.touchUserId] && !seen.has(s.touchUserId)) {
      seen.add(s.touchUserId);
      const u = db.users[s.touchUserId];
      users.push({
        id: s.touchUserId,
        nick: u.nickname || '??',
        color: u.color || '#888',
        stars: (u.stars || []).length,
        accessory: u.avatarAccessory || null,
        photo: u.photo || null,
        verified: !!u.verified
      });
    }
  }
  return users;
}

// Helper: broadcast online count/users para quem esta vendo o canal
const _muralBroadcastTimers = {};
function _broadcastMuralOnline(channelKey) {
  // Debounce: max 1 broadcast per channel per 2 seconds
  if (_muralBroadcastTimers[channelKey]) return;
  _muralBroadcastTimers[channelKey] = setTimeout(() => {
    delete _muralBroadcastTimers[channelKey];
    const users = _getMuralViewers(channelKey);
    io.to('mural-view:' + channelKey).emit('mural-online', {
      channelKey,
      count: users.length,
      users: users
    });
    // Broadcast contagens de todos canais para atualizar badges
    const allCounts = {};
    for (const [room] of io.sockets.adapter.rooms) {
      if (room.startsWith('mural-view:')) {
        const chKey = room.replace('mural-view:', '');
        const v = _getMuralViewers(chKey);
        if (v.length > 0) allCounts[chKey] = v.length;
      }
    }
    io.emit('mural-channel-counts', allCounts);
  }, 2000);
}

// GET /api/mural/:channelKey/online — usuarios VENDO este canal (deduplica por userId)
app.get('/api/mural/:channelKey/online', (req, res) => {
  const users = _getMuralViewers(req.params.channelKey);
  res.json({ count: users.length, users });
});

// GET /api/mural-online-counts — contagem de pessoas online em TODOS os canais (para badges)
app.get('/api/mural-online-counts', (req, res) => {
  const counts = {};
  for (const [room] of io.sockets.adapter.rooms) {
    if (room.startsWith('mural-view:')) {
      const chKey = room.replace('mural-view:', '');
      const viewers = _getMuralViewers(chKey);
      if (viewers.length > 0) counts[chKey] = viewers.length;
    }
  }
  res.json(counts);
});

// Check ban before posting (update post endpoint)
// We need to update the existing post endpoint to check bans
// This is handled by adding ban check to the existing POST /api/mural/:channelKey/post

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
    const pairKey = [req.params.userId, pid].sort().join('_');
    const rid = IDX.relationPair.get(pairKey);
    const rels = rid ? [db.relations[rid]].filter(Boolean) : [];
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
  const relIds = IDX.relationsByUser.get(uid) || new Set();
  const relations = [...relIds].map(rid => db.relations[rid]).filter(Boolean);
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
  const radius = Math.max(0, Math.min(50000, parseInt(req.query.radius) || 500));
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
    createdAt: Date.now(),
    modules: { restaurant: false, parking: false, gym: false, church: false, barber: false, dj: false },
    staff: [], menu: [], tables: 0, orders: [],
    parking: { enabled: false, mode: 'postpaid', hourlyRate: 10.00, fixedRate: 0, maxHours: 24, vehicles: {} },
    gym: { enabled: false, config: { maxCapacity: 50, openTime: '06:00', closeTime: '22:00' }, classes: {}, plans: {}, members: {}, workouts: {} },
    church: { enabled: false, config: { churchName: '', pastorName: '', denomination: '' }, tithes: {}, campaigns: {}, services: {}, prayers: {}, cells: {}, announcements: [] },
    barber: { enabled: false, config: { barberName: '', welcomeMessage: '' }, barbers: [], appointments: [] },
    djLive: { enabled: false, broadcasting: false, color: '#ff6b35', bpm: 128, animation: 'pulse', venueFreq: 19200, connectedDevices: {} }
  };
  // Add to index so it shows in operator's event list
  if (!IDX.operatorByCreator.has(userId)) IDX.operatorByCreator.set(userId, []);
  IDX.operatorByCreator.get(userId).push(id);
  saveDB('events', 'operatorEvents');
  res.json({ event: eventData });
});

// ═══ EVENT QUICK CHECKIN (QR code flow for guests) ═══

// Serve event checkin page
app.get('/e/:eventId', (req, res) => {
  const eventId = req.params.eventId;
  const ev = db.events[eventId];
  const opEv = db.operatorEvents ? db.operatorEvents[eventId] : null;
  if (!ev && !opEv) return res.status(404).send('Evento nao encontrado.');
  const eventName = (opEv ? opEv.name : null) || (ev ? ev.name : null) || 'Evento';
  const entryPrice = opEv ? (opEv.entryPrice || 0) : 0;
  const creatorName = (opEv ? opEv.creatorName : null) || (ev ? ev.creatorName : null) || '';
  res.send(generateEventCheckinPage(eventId, eventName, entryPrice, creatorName));
});

function generateEventCheckinPage(eventId, eventName, entryPrice, creatorName) {
  const priceDisplay = entryPrice > 0 ? 'R$ ' + (entryPrice / 100).toFixed(2).replace('.', ',') : 'Gratis';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Touch? - ${eventName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#050508;color:#e8e6e3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{width:100%;max-width:360px;text-align:center;padding:2rem}
.logo{font-size:.7rem;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,107,53,.6);margin-bottom:1.5rem}
.event-icon{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#60a5fa);display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}
.event-icon svg{width:28px;height:28px;stroke:#fff;fill:none;stroke-width:2}
.event-name{font-size:1.2rem;font-weight:700;margin-bottom:.3rem}
.event-sub{font-size:.72rem;color:rgba(232,230,227,.4);margin-bottom:.3rem}
.price-tag{font-size:.85rem;font-weight:600;color:${entryPrice > 0 ? '#f97316' : '#22c55e'};margin-bottom:1.5rem}
input{width:100%;padding:.8rem 1rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#e8e6e3;font-size:.9rem;font-family:inherit;outline:none;margin-bottom:.8rem;text-align:center}
input:focus{border-color:#3b82f6}
button{width:100%;padding:.9rem;background:linear-gradient(135deg,#3b82f6,#2563eb);border:none;border-radius:12px;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;letter-spacing:.05em}
button:active{transform:scale(.97)}
button:disabled{opacity:.5;cursor:not-allowed}
.result{display:none;animation:fadeIn .5s ease}
.phrase{font-size:1rem;color:rgba(96,165,250,.9);margin:1rem 0;font-weight:600}
.timer{font-family:'Courier New',monospace;font-size:.78rem;color:rgba(232,230,227,.4)}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
</style></head><body>
<div class="card">
<div class="logo">Touch?</div>
<div id="form">
<div class="event-icon"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg></div>
<div class="event-name">${eventName}</div>
<div class="event-sub">${creatorName ? 'por ' + creatorName : 'Check-in rapido'}</div>
<div class="price-tag">${entryPrice > 0 ? 'Entrada: ' + priceDisplay : 'Entrada gratuita'}</div>
<input type="text" id="nick" placeholder="Seu nickname" maxlength="20" autocomplete="off">
<button onclick="checkin()">Fazer check-in</button>
</div>
<div id="result" class="result">
<div class="phrase" id="statusMsg">Entrando...</div>
<div class="timer">Redirecionando pro evento...</div>
</div>
</div>
<script>
async function checkin(){
  var nick=document.getElementById('nick').value.trim();
  if(!nick||nick.length<2)return alert('Nickname precisa ter 2+ caracteres');
  var btn=document.querySelector('button');
  btn.disabled=true;btn.textContent='Entrando...';
  try{
    var r=await fetch('/api/event/quick-checkin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:'${eventId}',nickname:nick})});
    var d=await r.json();
    if(d.error){btn.disabled=false;btn.textContent='Fazer check-in';return alert(d.error)}
    localStorage.setItem('touch_userId',d.userId);
    localStorage.setItem('touch_userName',nick);
    localStorage.setItem('touch_userColor',d.userColor||'');
    localStorage.setItem('touch_isGuest','true');
    localStorage.setItem('activeEventId','${eventId}');
    localStorage.setItem('activeEventName','${eventName.replace(/'/g, "\\'")}');
    localStorage.setItem('activeEventRole','visitor');
    window.location.href='/?guestEvent=${eventId}&guest='+d.userId+'&rel='+(d.relationId||'');
  }catch(e){btn.disabled=false;btn.textContent='Fazer check-in';alert('Erro de conexao.')}
}
// Auto-redirect for logged-in users — skip this page entirely
(function(){
  var savedId=localStorage.getItem('touch_userId');
  var isGuest=localStorage.getItem('touch_isGuest')==='true';
  if(savedId&&!isGuest){
    // Fully logged-in user: redirect to app, let app handle checkin + animation
    window.location.replace('/?joinEvent=${eventId}');
    return;
  }
  // Guest with saved name: auto-fill and submit
  var savedName=localStorage.getItem('touch_userName');
  if(savedId&&savedName&&savedName.length>=2){
    document.getElementById('nick').value=savedName;
    checkin();
  }
})();
document.getElementById('nick').addEventListener('keydown',function(e){if(e.key==='Enter')checkin()});
</script></body></html>`;
}

// Quick checkin endpoint for event guests
app.post('/api/event/quick-checkin', (req, res) => {
  try {
  const { eventId, nickname } = req.body;
  if (!eventId || !nickname) return res.status(400).json({ error: 'Dados invalidos.' });
  let ev = db.events[eventId];
  const opEv = db.operatorEvents ? db.operatorEvents[eventId] : null;
  // If event only exists in operatorEvents, create a minimal entry in db.events
  if (!ev && opEv) {
    ev = { id: eventId, name: opEv.name, description: opEv.description || '', creatorId: opEv.creatorId, creatorName: opEv.creatorName || '', participants: opEv.participants ? [...opEv.participants] : [], createdAt: opEv.createdAt || Date.now() };
    db.events[eventId] = ev;
    console.log('[quick-checkin] created db.events entry from operatorEvents for:', eventId);
  }
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const nick = nickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname: 2 a 20 caracteres.' });

  // Find or create user
  const existingId = IDX.nickname.get(nick.toLowerCase());
  let user = existingId ? db.users[existingId] : null;
  if (!user) {
    const id = uuidv4();
    const color = nickColor(nick);
    user = { id, nickname: nick, name: nick, birthdate: null, avatar: null, color, createdAt: Date.now(), points: 0, pointLog: [], stars: [], isGuest: true };
    db.users[id] = user;
    idxAddUser(user);
  }

  // Add to event participants
  if (!Array.isArray(ev.participants)) ev.participants = [];
  if (!ev.participants.includes(user.id)) {
    ev.participants.push(user.id);
  }
  // Also update operatorEvents
  if (opEv) {
    if (!Array.isArray(opEv.participants)) opEv.participants = [];
    if (!opEv.participants.includes(user.id)) {
      opEv.participants.push(user.id);
      opEv.checkinCount = opEv.participants.length;
    }
  }

  // Create relation between guest and event creator for communication
  const now = Date.now();
  const creatorId = ev.creatorId || (opEv ? opEv.creatorId : null);
  let phrase = '';
  let relationId = uuidv4();
  let existingRel = null;

  if (creatorId && db.users[creatorId]) {
    const ownerLang = getUserLang(creatorId);
    phrase = smartPhrase(creatorId, user.id, ownerLang);
    existingRel = findActiveRelation(creatorId, user.id);
    if (!existingRel) {
      db.relations[relationId] = { id: relationId, userA: creatorId, userB: user.id, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null, isCheckin: true, eventId };
      idxAddRelation(relationId, creatorId, user.id);
      db.messages[relationId] = [];
    }
  } else {
    console.warn('[quick-checkin] no creatorId for event:', eventId, '- skipping relation creation');
    phrase = 'Bem-vindo ao evento!';
  }

  if (creatorId && db.users[creatorId]) {
    recordEncounter(user.id, creatorId, phrase, 'checkin');
  }
  awardPoints(user.id, null, 'checkin');
  saveDB('users', 'events', 'operatorEvents', 'relations', 'messages', 'encounters');

  // Notify event canvas via socket
  io.to('event:' + eventId).emit('event-attendee-joined', {
    eventId, userId: user.id, nickname: user.nickname, color: user.color,
    profilePhoto: user.profilePhoto || null, score: calcScore(user.id),
    stars: (user.stars || []).length, timestamp: now
  });

  // Notify operator
  if (creatorId) {
    io.to(`user:${creatorId}`).emit('checkin-created', {
      eventId, visitorId: user.id, visitorName: user.nickname, visitorColor: user.color,
      phrase, timestamp: now
    });
  }

  res.json({ ok: true, userId: user.id, userColor: user.color, eventName: ev.name, relationId: existingRel ? existingRel.id : relationId });
  } catch (e) {
    console.error('[quick-checkin] 500:', e.message, e.stack);
    res.status(500).json({ error: 'Erro interno no check-in: ' + e.message });
  }
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
  const radius = Math.max(0, Math.min(50000, parseInt(req.query.radius) || 5000));
  const now = Date.now();
  if (!lat || !lng) return res.json([]);
  const events = Object.values(db.events).filter(e => {
    if (e.endsAt < now) return false;
    const dist = haversine(lat, lng, e.lat, e.lng);
    return dist <= radius;
  }).map(e => {
    // Enrich with operator event data (modules, logo, tips)
    const opEv = db.operatorEvents ? Object.values(db.operatorEvents).find(oe => oe.id === e.id) : null;
    return {
      ...e, distance: Math.round(haversine(lat, lng, e.lat, e.lng)),
      participantCount: e.participants.length,
      modules: opEv ? (opEv.modules || {}) : {},
      eventLogo: opEv ? proxyStorageUrl(opEv.eventLogo || null) : null,
      acceptsTips: opEv ? !!opEv.acceptsTips : false
    };
  }).sort((a, b) => a.distance - b.distance);
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
  // Include operator event data (modules, logo, etc) for enriched detail
  const opEv = db.operatorEvents ? Object.values(db.operatorEvents).find(oe => oe.id === req.params.eventId) : null;
  const enriched = { ...ev, participantsData: participants };
  if (opEv) {
    enriched.modules = opEv.modules || {};
    enriched.eventLogo = proxyStorageUrl(opEv.eventLogo || null);
    enriched.acceptsTips = !!opEv.acceptsTips;
    enriched.businessProfile = opEv.businessProfile || null;
    if (!enriched.creatorId && opEv.creatorId) enriched.creatorId = opEv.creatorId;
  }
  res.json(enriched);
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
  if (!rel || Date.now() > rel.expiresAt) return res.status(400).json({ error: 'Relacao expirada.' });
  if (!CONTACT_TYPES.includes(contactType)) return res.status(400).json({ error: 'Tipo invalido.' });
  const partnerId = rel.userA === fromUserId ? rel.userB : rel.userA;
  const user = db.users[fromUserId];
  const reqId = uuidv4();
  const labels = { instagram: 'Instagram', whatsapp: 'WhatsApp', x: 'X / Twitter', email: 'Email', foto: 'Foto' };
  // Save as a chat message so it persists and is visible to both
  const contactReqMsg = {
    id: reqId, userId: 'system',
    text: (user.nickname || user.name) + ' pediu seu ' + (labels[contactType] || contactType),
    type: 'contact-request', contactType, requestId: reqId,
    from: { id: fromUserId, name: user.nickname || user.name, color: user.color },
    status: 'pending', timestamp: Date.now()
  };
  if (!db.messages[relationId]) db.messages[relationId] = [];
  db.messages[relationId].push(contactReqMsg);
  if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
  saveDB('messages');
  // Notify both users
  io.to(`user:${partnerId}`).emit('new-message', { relationId, message: contactReqMsg });
  io.to(`user:${partnerId}`).emit('contact-request', {
    requestId: reqId, relationId, contactType,
    from: { id: fromUserId, name: user.nickname || user.name, color: user.color }
  });
  io.to(`user:${fromUserId}`).emit('new-message', { relationId, message: contactReqMsg });
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
  const requestingUserLang = getUserLang(req.params.userId);
  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const infoA = signA ? ZODIAC_INFO[signA] : null;
  const infoB = signB ? ZODIAC_INFO[signB] : null;
  const phrase = getZodiacPhrase(signA, signB, requestingUserLang);
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

  const userALang = getUserLang(userIdA);
  const phrase = isCheckin ? getPhrase('evento', userALang) : (isServiceTouch ? getPhrase('servico', userALang) : smartPhrase(userIdA, userIdB, userALang));
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
      // Special handling for barber role: add to barber module team
      if (staffRole === 'barber') {
        const barber = ensureBarber(ev);
        // Remove existing entry for this user
        barber.barbers = barber.barbers.filter(b => b.userId !== staffUserId);
        const bbMember = {
          id: 'bb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          userId: staffUserId,
          name: staffUser.realName || staffUser.nickname || staffUser.name || 'Barbeiro',
          type: 'linked',
          services: [
            { id: 'bsvc_' + Date.now() + '_c', name: 'Corte', price: 35, duration: 30, createdAt: Date.now() },
            { id: 'bsvc_' + Date.now() + '_b', name: 'Barba', price: 25, duration: 20, createdAt: Date.now() },
            { id: 'bsvc_' + Date.now() + '_cb', name: 'Corte + Barba', price: 50, duration: 45, createdAt: Date.now() }
          ],
          slots: [],
          status: 'active',
          createdAt: Date.now()
        };
        barber.barbers.push(bbMember);
        saveDB('operatorEvents');
        io.to(`user:${ev.operatorId}`).emit('barber-team-joined', { eventId, barber: bbMember });
        io.to(`user:${staffUserId}`).emit('staff-connected', {
          eventId, eventName: ev.name, staffId: bbMember.id, role: 'barber',
          tables: [], menu: []
        });
        delete sonicQueue[staffUserId];
        if (sonicQueue['evt:' + eventId]) sonicQueue['evt:' + eventId].joinedAt = Date.now();
        if (opEntry) opEntry.pendingStaffRole = null;
        console.log('[createSonicConnection] BARBER connected:', staffUserId.slice(0,8), 'to event:', eventId.slice(0,8));
        return;
      }
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
  const zodiacPhrase = (isCheckin || isServiceTouch) ? null : getZodiacPhrase(signA, signB, userALang);
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
      userB: { id: 'evt:' + eventId, name: eventObj ? eventObj.name : 'Evento', color: '#60a5fa', profilePhoto: null, photoURL: null, score: 0, stars: 0, sign: null, signInfo: null, isPrestador: false, serviceLabel: '', isEvent: true, eventLogo: eventObj ? proxyStorageUrl(eventObj.eventLogo || null) : null },
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

    // Build module welcome data
    const ev = eventId ? db.operatorEvents[eventId] : null;
    const moduleWelcome = [];
    if (ev && ev.modules) {
      if (ev.modules.restaurant) {
        const menuCount = (ev.menu || []).length;
        moduleWelcome.push({
          key: 'restaurant',
          label: 'Restaurante',
          message: ev.businessProfile?.welcomeRestaurant || 'Confira nosso cardapio!',
          action: 'menu',
          actionLabel: 'Ver Cardapio',
          color: '#f97316',
          icon: 'restaurant',
          extra: menuCount > 0 ? menuCount + ' itens' : null
        });
      }
      if (ev.modules.parking) {
        moduleWelcome.push({
          key: 'parking',
          label: 'Estacionamento',
          message: ev.businessProfile?.welcomeParking || 'Registre seu veiculo!',
          action: 'parking',
          actionLabel: 'Registrar Veiculo',
          color: '#3b82f6',
          icon: 'parking'
        });
      }
      if (ev.modules.gym) {
        moduleWelcome.push({
          key: 'gym',
          label: 'Academia',
          message: ev.businessProfile?.welcomeGym || 'Faca seu check-in!',
          action: 'gym',
          actionLabel: 'Check-in',
          color: '#10b981',
          icon: 'gym'
        });
      }
      if (ev.modules.church) {
        moduleWelcome.push({
          key: 'church',
          label: 'Igreja',
          message: ev.businessProfile?.welcomeChurch || 'Bem-vindo ao culto!',
          action: 'church',
          actionLabel: 'Ver Programacao',
          color: '#8b5cf6',
          icon: 'church'
        });
      }
      if (ev.modules.barber) {
        moduleWelcome.push({
          key: 'barber',
          label: 'Barbearia',
          message: ev.barber?.config?.welcomeMessage || 'Agende seu horario!',
          action: 'barber',
          actionLabel: 'Agendar',
          color: '#d4a745',
          icon: 'barber'
        });
      }
    }

    const checkinData = {
      userId: visitorId, nickname: visitor.nickname || visitor.name, color: visitor.color,
      profilePhoto: visitor.profilePhoto || visitor.photoURL || null, timestamp: now,
      relationId, revealed: visitorRevealed,
      revealData: visitorRevealed ? visRevealEntry : null,
      eventId: eventId || null,
      stars: visitorStars,
      topTag: visitorTopTag,
      score: calcScore(visitorId),
      welcomePhrase: (eventId && db.operatorEvents[eventId]) ? (db.operatorEvents[eventId].welcomePhrase || '') : '',
      moduleWelcome: moduleWelcome
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
    const prestadores = IDX.prestador.size;
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
    else if (filter === 'prestador') users = [...IDX.prestador].map(id => db.users[id]).filter(Boolean);
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
      const op = db.operatorEvents ? Object.values(db.operatorEvents).find(oe => oe.id === e.id) : null;
      return { id: e.id, name: e.name, code: e.code, creatorId: e.creatorId, creatorName: e.creatorName, startsAt: e.startsAt, endsAt: e.endsAt, endedAt: e.endedAt, active: !e.endedAt && (!e.endsAt || new Date(e.endsAt) > new Date()), participants: (e.participants||[]).length, checkins: op?(op.checkinCount||0):0, revenue: op?(op.revenue||0):0, createdAt: e.createdAt };
    });
    events.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/financial', adminLimiter, requireAdmin, (req, res) => {
  try {
    // ── TIPS (gorjetas) ──
    const allTips = Object.values(db.tips || {});
    const approvedTips = allTips.filter(t => t.status === 'approved');
    const pendingTips = allTips.filter(t => t.status === 'pending' || t.status === 'in_process');
    const tipsTotal = approvedTips.reduce((s, t) => s + (t.amount || 0), 0);
    const tipsFee = approvedTips.reduce((s, t) => s + (t.fee || 0), 0);
    const tipsNet = tipsTotal - tipsFee;

    // ── EVENT ENTRY PAYMENTS (ingressos) ──
    const allEntries = Object.values(db.eventPayments || {});
    const approvedEntries = allEntries.filter(t => t.status === 'approved');
    const entriesTotal = approvedEntries.reduce((s, t) => s + (t.amount || 0), 0);
    const entriesFee = approvedEntries.reduce((s, t) => s + (t.fee || 0), 0);

    // ── SUBSCRIPTIONS ──
    let subsActive = 0, subsTotal = 0, subsRevenue = 0;
    for (const uid of Object.keys(db.subscriptions || {})) {
      const s = db.subscriptions[uid]; if (!s) continue;
      subsTotal++;
      if (s.status === 'authorized' || s.status === 'active') {
        subsActive++;
        subsRevenue += (s.amount || 0);
      }
    }

    // ── TRANSFER STATUS ──
    // Tips where receiver has Stripe/MP connected = direct transfer (auto split)
    // Tips where receiver has NO connection = retained in Touch? account
    let transferredDirect = 0, retainedInTouch = 0;
    approvedTips.forEach(t => {
      const receiver = db.users[t.receiverId];
      if (receiver && (receiver.mpConnected || receiver.stripeConnected)) {
        transferredDirect += (t.amount || 0) - (t.fee || 0);
      } else {
        retainedInTouch += (t.amount || 0);
      }
    });
    // Entry payments: check event's payment account or operator's connection
    approvedEntries.forEach(ep => {
      const ev = db.operatorEvents[ep.eventId];
      const operator = ep.receiverId ? db.users[ep.receiverId] : null;
      if (ev && ev.paymentStripeConnected) {
        transferredDirect += (ep.amount || 0) - (ep.fee || 0);
      } else if (operator && (operator.mpConnected || operator.stripeConnected)) {
        transferredDirect += (ep.amount || 0) - (ep.fee || 0);
      } else {
        retainedInTouch += (ep.amount || 0);
      }
    });

    // ── EVENTS SUMMARY ──
    const events = Object.values(db.operatorEvents || {});
    const activeEvents = events.filter(e => e.active);
    const eventRevenue = events.reduce((s, e) => s + (e.revenue || 0), 0);

    // ── PRESTADORES (service providers) ──
    const prestadores = [...IDX.prestador].map(id => db.users[id]).filter(Boolean);
    const prestadoresConnected = prestadores.filter(u => u.mpConnected || u.stripeConnected);

    // ── RECENT TRANSACTIONS (combined) ──
    const recentTips = allTips.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30).map(t => {
      const receiver = db.users[t.receiverId];
      const payer = db.users[t.payerId];
      const isConnected = receiver && (receiver.mpConnected || receiver.stripeConnected);
      return {
        id: t.id, type: 'tip', amount: t.amount || 0, fee: t.fee || 0,
        net: (t.amount || 0) - (t.fee || 0), status: t.status,
        from: payer ? (payer.nickname || payer.name) : (t.payerId || '?'),
        to: receiver ? (receiver.nickname || receiver.name) : (t.receiverId || '?'),
        method: t.method || 'card', createdAt: t.createdAt,
        transferStatus: !isConnected ? 'retained' : 'transferred'
      };
    });
    const recentEntries = allEntries.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20).map(ep => {
      const ev = db.operatorEvents[ep.eventId];
      const payer = db.users[ep.payerId];
      const operator = ep.receiverId ? db.users[ep.receiverId] : null;
      const isConnected = (ev && ev.paymentStripeConnected) || (operator && (operator.mpConnected || operator.stripeConnected));
      return {
        id: ep.id, type: 'entry', amount: ep.amount || 0, fee: ep.fee || 0,
        net: (ep.amount || 0) - (ep.fee || 0), status: ep.status,
        from: payer ? (payer.nickname || payer.name) : '?',
        to: ep.eventName || (ev ? ev.name : '?'),
        method: ep.method || 'card', createdAt: ep.createdAt,
        transferStatus: !isConnected ? 'retained' : 'transferred'
      };
    });
    const recentAll = [...recentTips, ...recentEntries].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);

    // ── GROSS REVENUE (everything Touch? collected) ──
    const grossRevenue = tipsTotal + entriesTotal;
    const totalFees = tipsFee + entriesFee;
    const platformRevenue = totalFees + subsRevenue; // Touch? keeps fees + subscription revenue

    res.json({
      overview: {
        grossRevenue, totalFees, platformRevenue,
        transferredDirect, retainedInTouch,
        totalTransactions: approvedTips.length + approvedEntries.length,
        pendingTransactions: pendingTips.length + allEntries.filter(e => e.status === 'pending').length
      },
      tips: {
        total: tipsTotal, count: approvedTips.length, fee: tipsFee, net: tipsNet,
        pending: pendingTips.length
      },
      entries: {
        total: entriesTotal, count: approvedEntries.length, fee: entriesFee,
        pending: allEntries.filter(e => e.status === 'pending').length
      },
      subscriptions: { active: subsActive, total: subsTotal, revenue: subsRevenue },
      events: {
        total: events.length, active: activeEvents.length,
        revenue: eventRevenue, totalCheckins: events.reduce((s, e) => s + (e.paidCheckins || 0), 0)
      },
      prestadores: {
        total: prestadores.length, connected: prestadoresConnected.length,
        notConnected: prestadores.length - prestadoresConnected.length
      },
      recentTransactions: recentAll
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ PAYOUTS — Manual transfers for providers without Stripe/MP ═══

// Admin: list all providers with retained balances
app.get('/api/admin/payouts/pending', adminLimiter, requireAdmin, (req, res) => {
  try {
    const prestadores = [...IDX.prestador].map(id => db.users[id]).filter(Boolean);
    const result = [];
    prestadores.forEach(u => {
      const isConnected = u.mpConnected || u.stripeConnected;
      if (isConnected) return; // skip connected providers — they get auto-split
      // Calculate retained balance from tips
      const tipsReceived = Object.values(db.tips).filter(t => t.receiverId === u.id && t.status === 'approved');
      const tipsTotal = tipsReceived.reduce((s, t) => s + (t.amount || 0), 0);
      const tipsFees = tipsReceived.reduce((s, t) => s + (t.fee || 0), 0);
      // Calculate retained from event entries
      const opEventIds = Object.values(db.operatorEvents || {}).filter(ev => ev.creatorId === u.id).map(ev => ev.id);
      const entries = Object.values(db.eventPayments || {}).filter(ep => (ep.receiverId === u.id || opEventIds.includes(ep.eventId)) && ep.status === 'approved');
      const entriesTotal = entries.reduce((s, e) => s + (e.amount || 0), 0);
      const entriesFees = entries.reduce((s, e) => s + (e.fee || 0), 0);
      const grossRetained = (tipsTotal - tipsFees) + (entriesTotal - entriesFees);
      // Subtract already paid out
      const paidOut = Object.values(db.payouts || {}).filter(p => p.receiverId === u.id && p.status === 'completed').reduce((s, p) => s + (p.amount || 0), 0);
      const balance = grossRetained - paidOut;
      if (balance <= 0) return;
      result.push({
        userId: u.id,
        nickname: u.nickname || u.name || '?',
        profilePhoto: u.profilePhoto || null,
        serviceLabel: u.serviceLabel || '',
        email: u.email || '',
        pixKey: u.pixKey || null,
        bankInfo: u.bankInfo || null,
        grossRetained,
        alreadyPaid: paidOut,
        balance,
        tipsCount: tipsReceived.length,
        entriesCount: entries.length
      });
    });
    result.sort((a, b) => b.balance - a.balance);
    // Also return totals
    const totalPending = result.reduce((s, r) => s + r.balance, 0);
    const totalPaidAll = Object.values(db.payouts || {}).filter(p => p.status === 'completed').reduce((s, p) => s + (p.amount || 0), 0);
    res.json({ providers: result, totalPending, totalPaidAll, count: result.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: register a manual payout (PIX, TED, cash, etc)
app.post('/api/admin/payouts/register', adminLimiter, requireAdmin, (req, res) => {
  try {
    const { receiverId, amount, method, reference, notes } = req.body;
    if (!receiverId || !db.users[receiverId]) return res.status(400).json({ error: 'Prestador nao encontrado.' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor invalido.' });
    const id = require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const payout = {
      id,
      receiverId,
      receiverName: db.users[receiverId].nickname || db.users[receiverId].name || '?',
      amount: parseFloat(amount),
      method: method || 'pix', // pix, ted, cash, other
      reference: (reference || '').trim().slice(0, 100), // PIX transaction ID, TED comprovante, etc
      notes: (notes || '').trim().slice(0, 200),
      status: 'completed',
      approvedBy: req.adminUserId || 'admin',
      createdAt: Date.now()
    };
    db.payouts[id] = payout;
    saveDB('payouts');
    // Notify provider via socket
    io.to(receiverId).emit('payout-received', { amount: payout.amount, method: payout.method });
    res.json({ ok: true, payout });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: list all payouts (history)
app.get('/api/admin/payouts/history', adminLimiter, requireAdmin, (req, res) => {
  try {
    const all = Object.values(db.payouts || {}).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    const total = all.reduce((s, p) => s + (p.amount || 0), 0);
    res.json({ payouts: all, total, count: all.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Provider: save PIX key / bank info for receiving payouts
app.post('/api/prestador/:userId/bank-info', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const { pixKey, pixKeyType, bankName, bankAgency, bankAccount, bankAccountType, holderName, holderCpf } = req.body;
  // Save PIX key
  if (pixKey) {
    user.pixKey = (pixKey || '').trim().slice(0, 100);
    user.pixKeyType = pixKeyType || 'cpf'; // cpf, cnpj, email, phone, random
  }
  // Save bank info (for TED)
  if (bankName || bankAgency || bankAccount) {
    user.bankInfo = {
      bankName: (bankName || '').trim().slice(0, 60),
      agency: (bankAgency || '').trim().slice(0, 10),
      account: (bankAccount || '').trim().slice(0, 20),
      accountType: bankAccountType === 'poupanca' ? 'poupanca' : 'corrente',
      holderName: (holderName || '').trim().slice(0, 80),
      holderCpf: (holderCpf || '').trim().slice(0, 14)
    };
  }
  saveDB('users');
  res.json({ ok: true, pixKey: user.pixKey, bankInfo: user.bankInfo });
});

// Provider: get their payout history
app.get('/api/prestador/:userId/payouts', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const payouts = Object.values(db.payouts || {}).filter(p => p.receiverId === userId).sort((a, b) => b.createdAt - a.createdAt);
  const total = payouts.reduce((s, p) => s + (p.amount || 0), 0);
  res.json({ payouts, total, count: payouts.length });
});

// ── STATUS / HEALTH ──
app.get('/api/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true, uptime: process.uptime(),
    dbLoadedFromCloud: _dbLoadedFromCloud,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB'
    },
    msgCache: { loaded: _msgCache.size, maxAllowed: MSG_CACHE_MAX },
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

// ── Socket Rate Limiting ──
const _socketRates = new Map(); // socketId -> { event -> { count, resetAt } }
const SOCKET_RATE_LIMITS = {
  'send-message': { max: 30, windowMs: 10000 },
  'typing': { max: 20, windowMs: 5000 },
  'send-photo': { max: 5, windowMs: 30000 },
  'send-ephemeral': { max: 15, windowMs: 10000 },
  'pulse': { max: 10, windowMs: 10000 }
};

function socketRateOk(socketId, event) {
  if (!SOCKET_RATE_LIMITS[event]) return true;
  const { max, windowMs } = SOCKET_RATE_LIMITS[event];
  if (!_socketRates.has(socketId)) _socketRates.set(socketId, {});
  const rates = _socketRates.get(socketId);
  const now = Date.now();
  if (!rates[event] || now > rates[event].resetAt) {
    rates[event] = { count: 1, resetAt: now + windowMs };
    return true;
  }
  rates[event].count++;
  return rates[event].count <= max;
}

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
    // Validate userId exists in db.users before allowing room join
    if (!userId || !db.users[userId]) {
      return;
    }
    currentUserId = userId;
    socket.touchUserId = userId;
    socket.join(`user:${userId}`);
    // Track online presence
    if (!global._onlineUsers) global._onlineUsers = {};
    global._onlineUsers[userId] = Date.now();
    // NAO auto-join em rooms do mural aqui
    // O join acontece via join-mural quando o usuario ABRE o mural
  });

  socket.on('updateLang', (data) => {
    if (data && data.userId && data.lang) {
      const u = db.users[data.userId];
      if (u) {
        u.lang = data.lang;
        saveDB('users');
      }
    }
  });

  socket.on('join-session', (sessionId) => { socket.join(`session:${sessionId}`); });

  // Operator joins event room for targeted order/payment notifications
  socket.on('join-event-room', (eventId) => {
    if (!eventId || typeof eventId !== 'string') return;
    // Verify event exists
    if (!db.operatorEvents[eventId]) return;
    socket.join('event:' + eventId);
  });

  // Mural rooms
  // Mural: join = usuario esta VENDO este canal agora
  // Entra em 2 rooms: mural:X (broadcast de posts) e mural-view:X (presenca/online)
  socket.on('join-mural', (channelKey) => {
    if (!channelKey || typeof channelKey !== 'string') return;
    // Sair de TODOS os rooms mural-view:* anteriores (so pode ver 1 canal por vez)
    for (const room of socket.rooms) {
      if (room.startsWith('mural-view:')) {
        socket.leave(room);
      }
    }
    socket.join('mural:' + channelKey);      // broadcast (receber posts)
    socket.join('mural-view:' + channelKey); // presenca (aparecer online)
    // Notificar contagem online atualizada (usando room de view)
    _broadcastMuralOnline(channelKey);
  });
  socket.on('leave-mural', (channelKey) => {
    if (!channelKey || typeof channelKey !== 'string') return;
    socket.leave('mural-view:' + channelKey); // sai da presenca
    // NAO sai do mural:X (continua recebendo posts em background)
    setTimeout(() => _broadcastMuralOnline(channelKey), 100);
  });

  socket.on('send-message', ({ relationId, userId, text, localId }) => {
    if (!dbLoaded || !socketRateOk(socket.id, 'send-message')) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const msg = { id: uuidv4(), userId, text, timestamp: Date.now() };
    if (localId) msg.localId = localId;
    if (!db.messages[relationId]) db.messages[relationId] = [];
    db.messages[relationId].push(msg);
    if (db.messages[relationId].length > 500) db.messages[relationId] = db.messages[relationId].slice(-500);
    saveDB('messages');
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('new-message', { relationId, message: msg });
    // Echo back to sender for dedup confirmation
    io.to(`user:${userId}`).emit('new-message', { relationId, message: msg });
  });

  socket.on('typing', ({ relationId, userId }) => {
    if (!dbLoaded || !socketRateOk(socket.id, 'typing')) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('partner-typing', { relationId });
  });

  // Pulse — silent vibration to partner
  socket.on('pulse', ({ relationId, userId }) => {
    if (!dbLoaded || !socketRateOk(socket.id, 'pulse')) return;
    const rel = db.relations[relationId];
    if (!rel || Date.now() > rel.expiresAt) return;
    const partnerId = rel.userA === userId ? rel.userB : rel.userA;
    io.to(`user:${partnerId}`).emit('pulse-received', { relationId, from: userId });
  });

  // Entry skipped — user skipped payment for event entry
  socket.on('entry-skipped', (data) => {
    if (data && data.operatorId) {
      io.to(`user:${data.operatorId}`).emit('entry-skipped', {
        eventId: data.eventId,
        userId: data.userId,
        nickname: data.nickname || 'Visitante'
      });
    }
  });

  // Ephemeral message — persisted so recipient sees when opening chat
  socket.on('send-ephemeral', ({ relationId, userId, text }) => {
    if (!dbLoaded || !socketRateOk(socket.id, 'send-ephemeral')) return;
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

  // Heartbeat for online presence
  socket.on('heartbeat', () => {
    if (currentUserId) {
      if (!global._onlineUsers) global._onlineUsers = {};
      global._onlineUsers[currentUserId] = Date.now();
    }
  });

  socket.on('disconnect', () => {
    // Remove from online tracking after a grace period
    if (currentUserId && global._onlineUsers) {
      setTimeout(() => {
        // Only remove if no other socket is connected for this user
        const room = io.sockets.adapter.rooms.get(`user:${currentUserId}`);
        if (!room || room.size === 0) delete global._onlineUsers[currentUserId];
      }, 5000);
    }
    _socketRates.delete(socket.id);
    // Limpa entradas do sonicQueue deste socket para evitar entradas orfas
    for (const key in sonicQueue) {
      if (sonicQueue[key].socketId === socket.id) {
        console.log('[Sonic] Limpando entrada orfa do sonicQueue:', key, 'socket:', socket.id);
        delete sonicQueue[key];
      }
    }
    // Atualizar contagem online dos canais do mural que este socket estava vendo
    for (const room of socket.rooms) {
      if (room.startsWith('mural-view:')) {
        const chKey = room.replace('mural-view:', '');
        setTimeout(() => _broadcastMuralOnline(chKey), 200);
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
      payer: { email: payer.email || 'pagamento@touch-irl.com' },
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

// Tip history for user (includes entry payments)
app.get('/api/tips/:userId', requireAuth, (req, res) => {
  const userId = req.params.userId;
  const tipIds = new Set([...(IDX.tipsByPayer.get(userId) || []), ...(IDX.tipsByReceiver.get(userId) || [])]);
  const tips = Array.from(tipIds).map(tid => db.tips[tid]).filter(Boolean);
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
  // Also include event payments (entry fees) as tip-like items
  const eventPayments = Object.values(db.eventPayments || {}).filter(ep => ep.payerId === userId);
  const enrichedEntries = eventPayments.map(ep => {
    const ev = db.operatorEvents[ep.eventId];
    const operator = ep.receiverId ? db.users[ep.receiverId] : null;
    return {
      ...ep,
      type: 'entry',
      payerName: db.users[ep.payerId]?.nickname || '?',
      payerPhoto: db.users[ep.payerId]?.profilePhoto || null,
      payerColor: db.users[ep.payerId]?.color || null,
      receiverName: ep.eventName || (ev ? ev.name : '?'),
      receiverPhoto: ev ? proxyStorageUrl(ev.eventLogo || null) : (operator ? operator.profilePhoto : null),
      receiverColor: operator ? operator.color : '#60a5fa',
      receiverService: '',
      direction: 'sent'
    };
  });
  const all = [...enriched, ...enrichedEntries].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  res.json(all);
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

  // Include entry payments (sent)
  const entriesSent = Object.values(db.eventPayments || {}).filter(ep => ep.payerId === userId && ep.status === 'approved');
  const entriesSentTotal = entriesSent.reduce((s, e) => s + (e.amount || 0), 0);

  // Include entry payments (received - as operator)
  const operatorEventIds = Object.values(db.operatorEvents || {}).filter(ev => ev.creatorId === userId).map(ev => ev.id);
  const entriesReceived = Object.values(db.eventPayments || {}).filter(ep => (ep.receiverId === userId || operatorEventIds.includes(ep.eventId)) && ep.status === 'approved');
  const entriesReceivedTotal = entriesReceived.reduce((s, e) => s + (e.amount || 0), 0);
  const entriesReceivedFee = entriesReceived.reduce((s, e) => s + (e.fee || 0), 0);

  const totalReceived = received.reduce((s, t) => s + (t.amount || 0), 0) + entriesReceivedTotal;
  const totalSent = sent.reduce((s, t) => s + (t.amount || 0), 0) + entriesSentTotal;
  const totalFees = received.reduce((s, t) => s + (t.fee || 0), 0) + entriesReceivedFee;
  const netReceived = totalReceived - totalFees;

  // Transfer status for received payments
  const isConnected = user.mpConnected || user.stripeConnected;
  let transferredToMe = 0, retainedByTouch = 0;
  if (user.isPrestador) {
    received.forEach(t => {
      if (isConnected) transferredToMe += (t.amount || 0) - (t.fee || 0);
      else retainedByTouch += (t.amount || 0) - (t.fee || 0);
    });
    entriesReceived.forEach(ep => {
      const ev = db.operatorEvents[ep.eventId];
      const evConnected = (ev && ev.paymentStripeConnected) || isConnected;
      if (evConnected) transferredToMe += (ep.amount || 0) - (ep.fee || 0);
      else retainedByTouch += (ep.amount || 0) - (ep.fee || 0);
    });
  }

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
    summary: {
      totalReceived, totalSent, totalFees, netReceived,
      pendingCount: pending.length,
      transferredToMe, retainedByTouch
    },
    byMonth,
    isPrestador: !!user.isPrestador,
    mpConnected: !!user.mpConnected,
    stripeConnected: !!user.stripeConnected,
    tipsReceivedCount: received.length,
    tipsSentCount: sent.length,
    entriesSentCount: entriesSent.length,
    entriesReceivedCount: entriesReceived.length
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
  // 2. Event payments (entry fees)
  Object.values(db.eventPayments || {}).forEach(ep => {
    if (ep.payerId !== userId) return;
    const ev = db.operatorEvents[ep.eventId];
    const operatorUser = ep.receiverId ? db.users[ep.receiverId] : null;
    transactions.push({
      id: ep.id,
      type: 'entry',
      direction: 'sent',
      amount: ep.amount || 0,
      fee: 0,
      status: ep.status || 'unknown',
      statusDetail: '',
      otherName: ep.eventName || (ev ? ev.name : '?'),
      otherColor: operatorUser ? operatorUser.color : '#60a5fa',
      otherPhoto: ev ? proxyStorageUrl(ev.eventLogo) : (operatorUser ? operatorUser.profilePhoto : null),
      eventName: ep.eventName || (ev ? ev.name : null),
      timestamp: ep.createdAt || 0
    });
  });
  // 3. Encounters (connections)
  (db.encounters[userId] || []).forEach(e => {
    transactions.push({
      id: 'enc-' + e.timestamp,
      type: e.type === 'checkin' ? 'checkin' : (e.type === 'service' ? 'service' : 'connection'),
      direction: null,
      amount: 0,
      status: 'ok',
      otherName: e.isEvent ? (e.withName || '?') : currentNick(e.with, e.withName),
      otherColor: e.withColor || '#888',
      otherPhoto: e.withPhoto || null,
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

  // Tips received (gorjetas)
  const tipsReceived = Object.values(db.tips)
    .filter(t => t.receiverId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Entry payments received (ingressos for operator's events)
  const operatorEventIds = Object.values(db.operatorEvents || {}).filter(ev => ev.creatorId === userId).map(ev => ev.id);
  const entryPayments = Object.values(db.eventPayments || {})
    .filter(ep => ep.receiverId === userId || operatorEventIds.includes(ep.eventId))
    .sort((a, b) => b.createdAt - a.createdAt);

  // Combine all payments
  const allPayments = [...tipsReceived, ...entryPayments];
  const allApproved = allPayments.filter(t => t.status === 'approved');
  const tipsApproved = tipsReceived.filter(t => t.status === 'approved');
  const entriesApproved = entryPayments.filter(t => t.status === 'approved');

  const totalReceived = allApproved.reduce((s, t) => s + (t.amount || 0), 0);
  const totalFees = allApproved.reduce((s, t) => s + (t.fee || 0), 0);
  const totalNet = totalReceived - totalFees;

  // Today (using user's timezone)
  const todayStart = getUserTodayStart(userId);
  const tipsToday = allApproved.filter(t => t.createdAt >= todayStart);
  const todayTotal = tipsToday.reduce((s, t) => s + (t.amount || 0), 0);

  // This week (using user's timezone)
  const weekStart = getUserWeekStart(userId);
  const tipsWeek = allApproved.filter(t => t.createdAt >= weekStart);
  const weekTotal = tipsWeek.reduce((s, t) => s + (t.amount || 0), 0);

  // This month (using user's timezone)
  const monthStart = getUserMonthStart(userId);
  const tipsMonth = allApproved.filter(t => t.createdAt >= monthStart);
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

  // Transfer status
  const isConnected = user.mpConnected || user.stripeConnected;
  let transferredToMe = 0, retainedByTouch = 0;
  allApproved.forEach(t => {
    const net = (t.amount || 0) - (t.fee || 0);
    // For entry payments, check event-specific Stripe or operator connection
    if (t.eventId) {
      const ev = db.operatorEvents[t.eventId];
      if ((ev && ev.paymentStripeConnected) || isConnected) transferredToMe += net;
      else retainedByTouch += net;
    } else {
      if (isConnected) transferredToMe += net;
      else retainedByTouch += net;
    }
  });

  // Enriched tips + entry payments
  const tipsEnriched = tipsReceived.slice(0, 30).map(t => {
    const tNet = (t.amount || 0) - (t.fee || 0);
    return {
      id: t.id, type: 'tip', amount: t.amount, fee: t.fee || 0, net: tNet,
      status: t.status, statusDetail: t.statusDetail,
      payerName: db.users[t.payerId]?.nickname || 'Anonimo',
      createdAt: t.createdAt, method: t.method || 'card',
      transferStatus: isConnected ? 'transferred' : 'retained'
    };
  });
  const entriesEnriched = entryPayments.slice(0, 30).map(ep => {
    const ev = db.operatorEvents[ep.eventId];
    const evConnected = (ev && ev.paymentStripeConnected) || isConnected;
    return {
      id: ep.id, type: 'entry', amount: ep.amount, fee: ep.fee || 0, net: (ep.amount || 0) - (ep.fee || 0),
      status: ep.status, statusDetail: '',
      payerName: db.users[ep.payerId]?.nickname || 'Anonimo',
      eventName: ep.eventName || '',
      createdAt: ep.createdAt, method: ep.method || 'card',
      transferStatus: evConnected ? 'transferred' : 'retained'
    };
  });
  const allEnriched = [...tipsEnriched, ...entriesEnriched].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);

  res.json({
    name: user.nickname || user.name,
    serviceLabel: user.serviceLabel || '',
    isPrestador: !!user.isPrestador,
    mpConnected: !!user.mpConnected,
    stripeConnected: !!user.stripeConnected,
    pixKey: user.pixKey || null,
    pixKeyType: user.pixKeyType || null,
    bankInfo: user.bankInfo || null,
    stats: {
      totalReceived, totalFees, totalNet,
      totalCount: allApproved.length,
      tipsCount: tipsApproved.length,
      entriesCount: entriesApproved.length,
      totalEntryRevenue: entriesApproved.reduce((s, t) => s + (t.amount || 0), 0),
      todayTotal, todayCount: tipsToday.length,
      weekTotal, weekCount: tipsWeek.length,
      monthTotal, monthCount: tipsMonth.length,
      transferredToMe, retainedByTouch
    },
    tips: allEnriched,
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
    // Check if this is a selo verification PIX payment
    const seloEvent = Object.values(db.operatorEvents || {}).find(e => String(e.pendingVerifyPaymentId) === String(paymentId) && !e.verified);
    if (seloEvent) {
      mpPayment.get({ id: paymentId }).then(p => {
        if (p.status === 'approved') {
          seloEvent.verified = true;
          seloEvent.verifiedAt = Date.now();
          seloEvent.verifyPaymentId = paymentId;
          seloEvent.verifyMethod = 'pix';
          delete seloEvent.pendingVerifyPaymentId;
          delete seloEvent.pendingVerifyMethod;
          saveDB('operatorEvents');
          console.log('[webhook] Selo PIX approved for event:', seloEvent.name);
          // Notify operator
          if (seloEvent.creatorId) {
            io.to('user:' + seloEvent.creatorId).emit('selo-verified', { eventId: seloEvent.id, verified: true });
          }
        }
      }).catch(e => console.error('[webhook] Selo PIX fetch error:', e));
      return res.sendStatus(200);
    }
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
        body: JSON.stringify({ email: user.email || email || 'pagamento@touch-irl.com', first_name: user.name || user.nickname || 'Touch User' })
      });
      // If email already exists, search for existing customer
      if (custResp.status === 400) {
        const searchResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(user.email || email || 'pagamento@touch-irl.com'), {
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
      const email = payer.email || payer.savedCard?.email || 'pagamento@touch-irl.com';
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
        email: payer.email || payer.savedCard?.email || 'pagamento@touch-irl.com',
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
      const email = user.email || user.savedCard?.email || 'pagamento@touch-irl.com';
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
        console.log('[webhook] Subscription:', { userId: uid, status: pa.status });
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
    if (!connectionMap[e.with]) connectionMap[e.with] = { name: currentNick(e.with, e.withName), count: 0, lastDate: '', lastPhrase: '' };
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
    .map(e => `${currentNick(e.with, e.withName)} (${formatTsForUser(e.timestamp, userId)})`);

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
  const _relIds = IDX.relationsByUser.get(userId) || new Set();
  const activeRelations = [..._relIds].map(rid => db.relations[rid]).filter(r => r && r.expiresAt > now);
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
${revealedPeople.length ? '\nIDENTIDADES REVELADAS (voce sabe o nome real dessas pessoas — USE o nome real delas ao falar sobre elas!):\n- ' + revealedPeople.join('\n- ') + '\nIMPORTANTE: Quando falar sobre uma pessoa revelada, SEMPRE use o nome real dela (ex: "O João" em vez do apelido). Voce SABE quem sao essas pessoas!' : ''}
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
const ULTIMATE_ADMIN_IDS = ['72a10d64-05f2-4790-a67a-bdd98f43f0b0']; // Ramon (owner)
function canUseUltimateVA(userId) {
  if (ULTIMATE_ADMIN_IDS.includes(userId)) return true;
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
  const { userId, lastInteraction, newsContext } = req.body;

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
    ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES ===\nAbaixo esta o que REALMENTE foi dito em conversas passadas. Use APENAS estas informacoes como referencia. NUNCA invente detalhes, nomes, lugares ou situacoes que NAO aparecem aqui:\n${plusConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===`
    : '';

  // Decide greeting mode: >1h = gossip opener, <1h = quick continue
  const msSinceLast = lastInteraction ? (Date.now() - lastInteraction) : Infinity;
  const isNewSession = msSinceLast > 60 * 60 * 1000; // 1 hour
  const user = db.users[userId] || {};

  // News context from Mural "Falar disso com IA" button
  let newsInstructions = '';
  if (newsContext && newsContext.headline) {
    const agentNames = { reporter: 'Noticias', sport: 'Esportes', fitness: 'Fitness', saude: 'Saude', cozinha: 'Cozinha', tecnologia: 'Tecnologia', politica: 'Politica', educacao: 'Educacao', clima: 'Clima' };
    const agentName = agentNames[newsContext.agentType] || 'Reporter';
    newsInstructions = `\n\n=== CONTEXTO DE NOTICIA DO MURAL ===
O usuario clicou em "Falar disso com IA" em uma noticia do Mural da Cidade.
A noticia foi postada pelo agente "${agentName}".
MANCHETE: ${newsContext.headline.slice(0, 200)}
TEXTO COMPLETO: ${newsContext.fullText.slice(0, 1500)}
=== FIM DO CONTEXTO ===
INSTRUCAO: Voce DEVE falar sobre essa noticia! Comente, de sua opiniao, puxe assunto sobre o tema. Seja provocativa e interessante. Pergunte o que o usuario acha.`;
  }

  let openingInstruction, openingText;
  if (newsContext && newsContext.headline) {
    // News context mode — override all other opening modes
    const shortHeadline = newsContext.headline.slice(0, 100);
    openingText = `Ei, ${userName}! Vi que voce quer falar sobre essa noticia: ${shortHeadline}... Bora conversar sobre isso!`;
    openingInstruction = `MODO NOTICIA DO MURAL: O usuario quer discutir uma noticia especifica. Comece comentando a manchete de forma provocativa, de sua opiniao e pergunte o que o usuario acha. NAO mude de assunto. Foque na noticia.`;
  } else if (plusConvos.length && !isNewSession) {
    // Has recent history -- resume from where we left off
    const lastMsg = plusConvos[plusConvos.length - 1];
    openingText = `${userName}, voltei! Continuamos?`;
    openingInstruction = `RETOMADA DE CONVERSA (usuario saiu e voltou):\nA ultima mensagem foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastMsg.content.slice(0, 120)}"\nRetome de onde parou. Nao diga "oi". REGRA: so mencione o que REALMENTE esta no historico. NUNCA invente detalhes que nao existem no historico.`;
  } else if (plusConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = plusConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${userName}, quanto tempo!`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h):\nVoce ja conversou com esse usuario antes. Os ultimos assuntos REAIS foram: ${lastTopics.join(' | ')}\nMencione BREVEMENTE um desses assuntos ou puxe algo dos DADOS DO USUARIO acima. NUNCA invente topicos que nao estao no historico ou nos dados. Se nao tem nada relevante, comece com uma fofoca dos DADOS acima.`;
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

REGRA CRITICA — NUNCA INVENTAR:
Voce so pode mencionar fatos que estao EXPLICITAMENTE nos DADOS DO USUARIO abaixo, no HISTORICO DE CONVERSAS, ou nas NOTAS PESSOAIS.
NUNCA invente: nomes de pessoas que nao existem nos dados, historias que nao aconteceram, lugares que o usuario nunca mencionou, conversas que nunca existiram.
Se nao tem informacao sobre algo, PERGUNTE ao usuario em vez de inventar.
Se o historico esta vazio, comece do zero — NAO finja que ja se conhecem ou que ja conversaram.

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

IDENTIDADES REVELADAS:
Nas conexoes do usuario, algumas pessoas ja se revelaram (marcadas com [revelado] ou NOME REAL).
Quando uma pessoa foi revelada, voce DEVE usar o nome real dela na conversa, NAO o apelido.
Exemplo: se "CoolNick123" revelou ser "Joao", diga "o Joao" em vez de "o CoolNick123".
Se o usuario perguntar "quem e tal pessoa?", e ela ja foi revelada, diga o nome real.
Se o usuario perguntar sobre alguem pelo apelido E voce sabe o nome real, use o nome real.
Isso vale tanto para os dados iniciais quanto para os dados de consultar_rede.

${context}

NOME DO USUARIO: ${(user.name || user.nickname || '').split(' ')[0] || user.nickname || ''}
(Use so o primeiro nome, NUNCA nome completo)

MEMORIA:
${tierCfg.memoryRules}

${tierCfg.extraInstructions ? 'INSTRUCOES EXTRAS:\n' + tierCfg.extraInstructions : ''}
${convHistoryPlus}
${newsInstructions}

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
    if (!connectionMap[e.with]) connectionMap[e.with] = { name: currentNick(e.with, e.withName), count: 0, ts: 0 };
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
  const _relIds = IDX.relationsByUser.get(userId) || new Set();
  const activeRels = [..._relIds].map(rid => db.relations[rid]).filter(r => r && r.expiresAt > now);
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

  // Revealed identities (explicit section)
  const revealedNames = [];
  Object.entries(user.canSee || {}).forEach(([pid, data]) => {
    if (data && data.name) {
      const p = db.users[pid];
      const nick = p ? (p.nickname || '?') : '?';
      const realName = p ? (p.name || data.name) : data.name;
      if (nick !== realName) revealedNames.push(nick + ' = ' + realName);
    }
  });
  if (revealedNames.length) {
    freshContext += '\n\nIDENTIDADES REVELADAS (USE o nome real ao falar sobre essas pessoas!):\n- ' + revealedNames.join('\n- ');
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
    ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES ===\nAbaixo esta o que REALMENTE foi dito em conversas passadas. Use APENAS estas informacoes como referencia. NUNCA invente detalhes, nomes, lugares ou situacoes que NAO aparecem aqui:\n${proConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===`
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
    openingInstruction = `RETOMADA DE CONVERSA (usuario saiu e voltou):\nA ultima mensagem foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastMsg.content.slice(0, 120)}"\nRetome de onde parou. Nao diga "oi". REGRA: so mencione o que REALMENTE esta no historico. NUNCA invente detalhes.`;
  } else if (proConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = proConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${firstName}, quanto tempo!`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h):\nOs ultimos assuntos REAIS foram: ${lastTopics.join(' | ')}\nMencione BREVEMENTE um desses ou puxe algo dos DADOS DO USUARIO. NUNCA invente topicos que nao estao no historico ou nos dados.`;
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

REGRA CRITICA — NUNCA INVENTAR:
Voce so pode mencionar fatos que estao EXPLICITAMENTE nos DADOS DO USUARIO abaixo, no HISTORICO DE CONVERSAS, ou nas NOTAS PESSOAIS.
NUNCA invente: nomes de pessoas que nao existem nos dados, historias que nao aconteceram, lugares que o usuario nunca mencionou, conversas que nunca existiram.
Se nao tem informacao sobre algo, PERGUNTE ao usuario em vez de inventar.
Se o historico esta vazio, comece do zero — NAO finja que ja se conhecem.

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

IDENTIDADES REVELADAS:
Nas conexoes do usuario, algumas pessoas ja se revelaram (marcadas com [revelado] ou NOME REAL).
Quando uma pessoa foi revelada, voce DEVE usar o nome real dela na conversa, NAO o apelido.
Exemplo: se "CoolNick123" revelou ser "Joao", diga "o Joao" em vez de "o CoolNick123".
Se o usuario perguntar sobre alguem pelo apelido E voce sabe o nome real, use o nome real.

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
  // Migracao: garantir que propriedades existem em bancos antigos
  const bank = db.ultimateBank[userId];
  if (!Array.isArray(bank.conversations)) bank.conversations = [];
  if (!Array.isArray(bank.devQueue)) bank.devQueue = [];
  if (!bank.userProfile) bank.userProfile = { tone: '', preferences: [], vocabulary: [], screenNames: {}, lastTopics: [] };
  return bank;
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
    openingInstruction = `RETOMADA DE CONVERSA (usuario saiu e voltou):\nA ultima mensagem foi: "${lastMsg.role === 'user' ? 'Usuario' : 'Voce'}: ${lastTopic}"\nRetome de onde parou. Nao diga "oi". REGRA: so mencione o que REALMENTE esta no historico. NUNCA invente detalhes.`;
  } else if (recentConvos.length && isNewSession) {
    // Has old history -- reference previous session
    const lastTopics = recentConvos.slice(-3).map(c => c.content.slice(0, 60));
    openingText = `${firstName}, quanto tempo!`;
    openingInstruction = `NOVA SESSAO COM HISTORICO (faz mais de 1h):\nOs ultimos assuntos REAIS foram: ${lastTopics.join(' | ')}\nMencione BREVEMENTE um desses ou puxe algo do contexto. NUNCA invente topicos que nao estao no historico.`;
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
  const convContext = recentConvos.length ? `\n\n=== HISTORICO DE CONVERSAS ANTERIORES ===\nAbaixo esta o que REALMENTE foi dito em conversas passadas. Use APENAS estas informacoes como referencia. NUNCA invente detalhes que NAO aparecem aqui:\n${recentConvos.map(c => `${c.role === 'user' ? 'Usuario' : 'Touch DEV'}: ${c.content}`).join('\n')}\n=== FIM DO HISTORICO ===` : '';

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

═══ REGRA CRITICA — NUNCA INVENTAR ═══
Voce so pode mencionar fatos que estao EXPLICITAMENTE nos dados, historico ou notas.
NUNCA invente: nomes, historias, lugares ou situacoes que NAO aparecem nos dados fornecidos.
Se nao tem informacao, PERGUNTE. Se o historico esta vazio, comece do zero.

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
1. ${firstName} fala algo → voce ENTENDE o pedido
2. ANTES de chamar comando_dev, voce REPETE pro usuario de forma estruturada: "Entendi, voce quer [X]. Vou mandar pro Claude. Pode levar uns 30 segundos."
3. AGUARDE confirmacao do usuario ("isso", "sim", "manda") ANTES de chamar comando_dev
4. Claude Opus gera plano automaticamente (~10-30 segundos) — FIQUE EM SILENCIO enquanto processa
5. Quando o plano chegar, RESUMA em 2 frases simples e PERGUNTE se aprova
6. AGUARDE ${firstName} dizer EXPLICITAMENTE "sim", "aprova", "manda", "pode fazer", "vai la" ou similar
7. SO ENTAO voce chama aprovar_plano com o ID
8. Codigo e gerado, aplicado, commitado e pushado automaticamente (~30-90 segundos) — FIQUE EM SILENCIO
9. Quando terminar, confirme o resultado em 1-2 frases

═══ REGRA CRITICA: SILENCIO DURANTE PROCESSAMENTO ═══
- Enquanto o Claude Opus estiver pensando/gerando codigo, NAO fale nada. FIQUE EM SILENCIO.
- Voce ja avisou o usuario que esta processando. NAO precisa repetir.
- Mensagens [SISTEMA] de progresso sao apenas informativas pra VOCE. NAO precisa repassar pro usuario.
- So fale quando tiver algo NOVO e UTIL pra dizer (plano pronto, codigo pronto, erro).

═══ REGRA CRITICA: NUNCA APROVAR SOZINHO ═══
- NUNCA chame aprovar_plano sem que ${firstName} DIGA CLARAMENTE que aprova
- Se voce NAO ouviu uma confirmacao EXPLICITA, PERGUNTE: "Quer que eu aprove esse plano?"
- Se houver QUALQUER duvida se o usuario aprovou, PERGUNTE DE NOVO
- Aprovar sem confirmacao e o PIOR erro que voce pode cometer — pode quebrar o app inteiro
- Mesmo que o [SISTEMA] diga "se aprovar, chame aprovar_plano", isso NAO e aprovacao — e instrucao pra VOCE saber o que fazer QUANDO o usuario aprovar

═══ REGRA CRITICA: UM COMANDO POR VEZ ═══
- NUNCA mande mais de UM comando_dev por vez. Espere o anterior TERMINAR completamente antes de enviar outro.
- O limite da API e 30.000 tokens por minuto. Se voce mandar 2 comandos seguidos, VAI dar erro 429 (rate limit).
- TEMPO MINIMO entre comandos: 60 SEGUNDOS. Sem excecao.
- Se o usuario pedir varias mudancas de uma vez, agrupe TUDO em UMA UNICA instrucao bem detalhada.
- Exemplo CORRETO: "Mudar fundo verde pra branco E mudar cor do texto pra preto" (1 comando so)
- Exemplo ERRADO: mandar "mudar fundo" e depois "mudar texto" separado (2 comandos = erro)
- Se voce receber um [SISTEMA] dizendo que esta processando, NAO mande outro comando. ESPERE.

═══ PACIENCIA E EXPECTATIVAS ═══
- Claude Opus demora pra pensar. Isso e NORMAL. Nao se desespere.
- Plano: 10-20 segundos. Diga: "O Claude ta pensando, espera uns 15 segundos."
- Geracao de codigo: 30-90 segundos. Diga: "Ta gerando o codigo, pode levar ate 1 minuto."
- Se demorar mais de 2 minutos, AI sim diga que algo pode ter dado errado.
- NUNCA diga "deu erro" so porque demorou. Demora e NORMAL.

═══ FEEDBACK DE RESULTADO ═══
- Quando voce receber uma mensagem [SISTEMA] dizendo "Codigo aplicado, commitado e pushado", diga pro usuario: "Deu certo! O codigo ja foi pro GitHub. Depois do deploy (uns 90 segundos) voce pode ver a mudanca."
- Quando receber [SISTEMA] com erro, explique CLARAMENTE o que aconteceu e sugira tentar de novo.
- Se receber "rate_limit", diga: "A gente mandou comandos rapido demais. Espera 1 minuto e tenta de novo."
- NUNCA invente que algo deu certo ou errado. Espere a mensagem do [SISTEMA] e repasse FIELMENTE.
- Se nao recebeu nenhum [SISTEMA] ainda, diga "Ainda ta processando, vamos aguardar."

═══ COMUNICACAO COM O DESENVOLVEDOR ═══
Quando criar comando_dev, escreva instrucoes CLARAS e COMPLETAS:
- ONDE mudar (arquivo, secao, funcao)
- O QUE mudar (comportamento atual vs desejado)
- COMO deve ficar (visual, logica, UX)
- Contexto relevante (por que essa mudanca)
- Se o usuario pediu varias coisas, AGRUPE TUDO em uma instrucao so

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

IDENTIDADES REVELADAS:
Nas conexoes do usuario, algumas pessoas ja se revelaram (marcadas com [revelado] ou NOME REAL).
Quando uma pessoa foi revelada, voce DEVE usar o nome real dela na conversa, NAO o apelido.
Se o usuario perguntar sobre alguem pelo apelido E voce sabe o nome real, use o nome real.

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
          { type:'function', name:'aprovar_plano', description:'Aprova um plano de desenvolvimento para execucao. REGRA CRITICA: SO chame esta funcao DEPOIS que o usuario CONFIRMAR POR VOZ que quer aprovar. NUNCA chame automaticamente. Demora ~15-30 segundos.', parameters:{type:'object',properties:{id:{type:'string',description:'ID do comando na fila'}},required:['id']} },
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

// ══ ANTHROPIC FETCH COM RETRY — retry automatico em 429/529 ══
async function anthropicFetch(body, timeoutMs = 30000, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (resp.status === 529 || resp.status === 429) {
        const waitMs = Math.min(5000 * attempt, 15000); // 5s, 10s, 15s
        console.log(`[ANTHROPIC] ${resp.status} attempt ${attempt}/${maxRetries}, retry in ${waitMs}ms...`);
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, waitMs)); continue; }
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      if (attempt < maxRetries && e.name !== 'AbortError') {
        console.log(`[ANTHROPIC] Fetch error attempt ${attempt}/${maxRetries}:`, e.message);
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

// ══ DEV PING — teste rapido de conexao com Claude (nao precisa admin) ══
app.post('/api/dev/ping', vaLimiter, async (req, res) => {
  const { userId } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ ok: false, error: 'Acesso negado' });

  const result = {
    ok: false,
    anthropic_key: !!ANTHROPIC_API_KEY,
    engine: ANTHROPIC_API_KEY ? 'claude-opus-4' : (OPENAI_API_KEY ? 'gpt-4o-fallback' : 'nenhum'),
    teste: null,
    tempo_ms: 0
  };

  try {
    if (ANTHROPIC_API_KEY) {
      const start = Date.now();
      const resp = await anthropicFetch({ model: 'claude-sonnet-4-20250514', max_tokens: 20, messages: [{ role: 'user', content: 'Diga apenas: OK' }] }, 30000, 3);
      result.tempo_ms = Date.now() - start;
      if (resp.ok) {
        const data = await resp.json();
        result.ok = true;
        result.teste = 'Claude OK: ' + (data.content?.[0]?.text || 'sem texto');
      } else {
        result.teste = 'Claude ERRO HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 150);
      }
    } else if (OPENAI_API_KEY) {
      const start = Date.now();
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Diga apenas: OK' }], max_tokens: 20 })
      });
      result.tempo_ms = Date.now() - start;
      if (resp.ok) {
        const data = await resp.json();
        result.ok = true;
        result.teste = 'GPT-4o OK: ' + (data.choices?.[0]?.message?.content || 'sem texto');
      } else {
        result.teste = 'GPT-4o ERRO HTTP ' + resp.status;
      }
    } else {
      result.teste = 'Nenhuma API key configurada!';
    }
  } catch (e) {
    result.teste = 'Excecao: ' + e.message;
  }

  console.log('[DEV] Ping:', result.teste, result.tempo_ms + 'ms');
  res.json(result);
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

// Background async function - processes planning without blocking HTTP
async function _processDevPlan(userId, commandId, instruction) {
  console.log('[DEV] Background planning started for', commandId);
  const bank = getUltimateBank(userId);
  const command = bank.devQueue.find(c => c.id === commandId);
  if (!command) { console.error('[DEV] Command not found:', commandId); return; }

  try {
    const projectFiles = {};
    const publicDir = path.join(__dirname, 'public');
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
    projectFiles['server.js'] = { lines: fs.readFileSync(__filename, 'utf8').split('\n').length, path: __filename };
    for (const hf of htmlFiles) {
      projectFiles['public/' + hf] = { lines: fs.readFileSync(path.join(publicDir, hf), 'utf8').split('\n').length, path: path.join(publicDir, hf) };
    }
    const fileMapStr = Object.entries(projectFiles).map(([f, info]) => `- ${f} (${info.lines} linhas)`).join('\n');

    const serverCode = fs.readFileSync(__filename, 'utf8');
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
O app se chama "Touch?" / "Encosta" -- rede social presencial.

ARQUIVOS DO PROJETO:
${fileMapStr}

MAPA DE ENDPOINTS E FUNCOES DO server.js:
${endpointMap.join('\n')}

REGRAS DE SEGURANCA (INVIOLAVEIS):
- NUNCA apague, remova, delete ou destrua funcionalidades existentes sem autorizacao EXPLICITA do usuario.
- NUNCA faca rm, delete, drop, truncate, ou qualquer operacao destrutiva em dados ou arquivos.
- NUNCA remova endpoints, funcoes, telas ou features que ja existem.
- NUNCA modifique logica de pagamento, autenticacao ou permissoes sem aprovacao EXPLICITA.
- Se a instrucao pedir algo destrutivo, RECUSE e explique por que no plano.
- Backups sao SAGRADOS: nunca apague backups.
- Em caso de duvida, ADICIONE codigo novo em vez de modificar ou remover codigo existente.

Responda APENAS com um plano tecnico em portugues, com no maximo 7 passos.
Cada passo deve indicar:
1. QUAL ARQUIVO mexer
2. ONDE no arquivo (funcao, endpoint, linha aproximada)
3. O QUE fazer (adicionar, mudar, remover)
Seja conciso e preciso. Nao gere codigo, apenas o plano.`;

    if (ANTHROPIC_API_KEY) {
      console.log('[DEV] Chamando Claude Opus para planejamento... instrucao:', instruction.slice(0, 80));
      const planStart = Date.now();
      const planResp = await anthropicFetch({
        model: 'claude-opus-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `INSTRUCAO DO USUARIO: ${instruction}` }],
        system: systemPrompt
      }, 300000, 3);
      const planTime = Date.now() - planStart;
      if (planResp.ok) {
        const planData = await planResp.json();
        command.plan = planData.content?.[0]?.text || 'Plano nao gerado';
        command.status = 'planned';
        console.log('[DEV] Claude planejamento OK em', planTime + 'ms');
      } else {
        const errText = await planResp.text();
        console.error('[DEV] Claude plan ERRO:', planResp.status, errText.slice(0, 200));
        command.plan = 'Erro Claude: ' + planResp.status + ' - ' + errText.slice(0, 100);
        command.status = 'plan_failed';
      }
    } else {
      console.log('[DEV] Sem ANTHROPIC_API_KEY, usando GPT-4o fallback');
      const planAbort2 = new AbortController();
      const planTimer2 = setTimeout(() => planAbort2.abort(), 120000);
      const planResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `INSTRUCAO DO USUARIO: ${instruction}` }],
          max_tokens: 2000, temperature: 0.3
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
    command.plan = isAbort ? 'Timeout: a IA demorou demais.' : ('Erro: ' + e.message);
    command.status = 'plan_failed';
    console.error('[DEV] Planning error:', e.name, e.message);
  }
  saveDB('ultimateBank');
  console.log('[DEV] Background planning done:', commandId, 'status:', command.status);
}

// Create a dev command - returns IMMEDIATELY, processes in background
app.post('/api/dev/command', vaLimiter, (req, res) => {
  const { userId, instruction } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  if (!instruction) return res.status(400).json({ error: 'Instrucao e obrigatoria' });

  const bank = getUltimateBank(userId);
  const commandId = 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const command = { id: commandId, instruction, status: 'planning', plan: null, result: null, ts: Date.now(), approvedAt: null };
  bank.devQueue.push(command);
  saveDB('ultimateBank');

  console.log('[DEV] Command created:', commandId, '- returning immediately');
  res.json({ id: commandId, status: 'planning' });

  // Fire-and-forget background processing
  _processDevPlan(userId, commandId, instruction).catch(e => {
    console.error('[DEV] Background plan error:', e.message);
  });
});

// Poll dev command status
app.get('/api/dev/status/:commandId', (req, res) => {
  const userId = req.query.userId;
  if (!userId || !canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  const bank = getUltimateBank(userId);
  const cmd = bank.devQueue.find(c => c.id === req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'Comando nao encontrado' });
  res.json({ id: cmd.id, status: cmd.status, plan: cmd.plan, error: cmd.status === 'plan_failed' ? cmd.plan : null, result: cmd.result, elapsed_ms: Date.now() - cmd.ts });
});

// Get dev queue
app.get('/api/dev/queue/:userId', (req, res) => {
  if (!canUseUltimateVA(req.params.userId)) return res.status(403).json({ error: 'Acesso negado' });
  const bank = getUltimateBank(req.params.userId);
  res.json({ queue: bank.devQueue.slice(-20).reverse() });
});

// ── DEV MONITOR — painel admin em tempo real ──
app.get('/api/dev/monitor', (req, res) => {
  // Retorna estado de TODOS os users com devQueue (admin only - sem auth por enquanto pra simplificar)
  const result = { users: [], totalCommands: 0, totalPlanned: 0, totalDone: 0, totalFailed: 0 };
  for (const uid of Object.keys(db.ultimateBank || {})) {
    const bank = db.ultimateBank[uid];
    if (!bank || !bank.devQueue || !bank.devQueue.length) continue;
    const user = db.users[uid];
    const userName = user ? (user.name || user.nickname || uid.slice(0,8)) : uid.slice(0,8);
    const commands = (bank.devQueue || []).slice(-30).map(c => ({
      id: c.id, status: c.status, instruction: (c.instruction || '').slice(0, 150),
      plan: c.plan ? (c.plan).slice(0, 300) : null,
      result: c.result ? (c.result).slice(0, 300) : null,
      ts: c.ts, approvedAt: c.approvedAt,
      elapsed: c.ts ? Math.round((Date.now() - c.ts) / 1000) + 's' : '?'
    }));
    result.users.push({ userId: uid.slice(0,8), userName, commands, total: commands.length });
    commands.forEach(c => {
      result.totalCommands++;
      if (c.status === 'planned') result.totalPlanned++;
      if (c.status === 'done') result.totalDone++;
      if (c.status === 'plan_failed' || c.status === 'error') result.totalFailed++;
    });
  }
  result.serverUptime = Math.round(process.uptime()) + 's';
  result.anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  result.githubToken = !!process.env.GITHUB_TOKEN;
  res.json(result);
});

// Background async function - processes code generation without blocking HTTP
async function _processDevApproval(userId, commandId) {
  console.log('[DEV] Background approval started for', commandId);
  const bank = getUltimateBank(userId);
  const cmd = bank.devQueue.find(c => c.id === commandId);
  if (!cmd) { console.error('[DEV] Command not found:', commandId); return; }

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

REGRAS DE SEGURANCA (INVIOLAVEIS):
8. NUNCA gere edits que apaguem, removam ou destruam funcionalidades existentes sem autorizacao EXPLICITA.
9. NUNCA gere edits que facam delete, drop, truncate, rm em dados, arquivos ou backups.
10. NUNCA modifique logica de pagamento, autenticacao ou permissoes.
11. Se o plano pedir algo destrutivo, retorne array vazio [] e nao aplique nada.
12. Em caso de duvida, ADICIONE codigo novo em vez de modificar ou remover existente.

ARQUIVOS DISPONIVEIS: ${Object.keys(fileMap).join(', ')}`;

    // Limitar contexto para Opus ficar rapido (~20k tokens max, ~20s)
    const MAX_LINES_PER_FILE = 400;
    const CONTEXT_RADIUS = 12;
    // Palavras comuns a ignorar na busca por keywords
    const STOP_WORDS = new Set(['para','como','onde','quando','esse','essa','este','esta','isso','isto','fazer','deve','pode','todo','toda','todos','todas','mais','menos','muito','tambem','voce','apenas','nada','algo','cada','outro','outra','qual','quem','tipo','aqui','agora','ainda','pelo','pela','sobre','entre','apos','antes','depois','mesmo','desde','sera','sido','sido','have','with','that','this','from','what','which','where','when','your','their','them','have','been','would','could','should','about','there','these','those','other','some','only','also','just','than','then','into','over','such','more','most','after','before']);
    const fileContextStr = Object.entries(fileContents).map(([f, content]) => {
      const lines = content.split('\n');
      if (lines.length <= MAX_LINES_PER_FILE) {
        return `=== ${f} (${lines.length} linhas) ===\n${lines.map((l, i) => `${i+1}: ${l}`).join('\n')}`;
      }
      // Arquivo grande: trechos relevantes baseados no plano + instrucao
      const rawWords = (cmd.instruction + ' ' + (cmd.plan || '')).toLowerCase().split(/\s+/);
      const keywords = rawWords.filter(w => w.length > 3 && !STOP_WORDS.has(w));
      const includedRanges = new Set();
      // Primeiras 20 linhas (imports) + ultimas 30 linhas (app.listen, init)
      for (let i = 0; i < Math.min(20, lines.length); i++) includedRanges.add(i);
      for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) includedRanges.add(i);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].toLowerCase();
        if (keywords.some(kw => ln.includes(kw))) {
          for (let j = Math.max(0, i - CONTEXT_RADIUS); j < Math.min(lines.length, i + CONTEXT_RADIUS + 1); j++) {
            includedRanges.add(j);
          }
        }
      }
      const sortedLines = Array.from(includedRanges).sort((a, b) => a - b);
      if (sortedLines.length > MAX_LINES_PER_FILE) sortedLines.length = MAX_LINES_PER_FILE;
      const chunks = [];
      let prevIdx = -2;
      for (const idx of sortedLines) {
        if (idx !== prevIdx + 1) chunks.push(`\n... [pulo para linha ${idx + 1}] ...\n`);
        chunks.push(`${idx + 1}: ${lines[idx]}`);
        prevIdx = idx;
      }
      return `=== ${f} (${content.split('\n').length} linhas total, mostrando ${sortedLines.length} relevantes) ===\n${chunks.join('\n')}`;
    }).join('\n\n');
    console.log('[DEV] Contexto gerado:', fileContextStr.length, 'chars (~', Math.round(fileContextStr.length / 4), 'tokens)');

    let editsRaw;

    // Helper: fetch com timeout (AbortController)
    function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
    }

    if (ANTHROPIC_API_KEY) {
      // Use Claude Opus 4 for code generation (com retry automatico em 429/529)
      console.log('[DEV] Chamando Claude Opus para geracao de codigo... arquivos:', relevantFiles.join(', '));
      const editStart = Date.now();
      const editResp = await anthropicFetch({
        model: 'claude-opus-4-20250514',
        max_tokens: 8000,
        system: editSystemPrompt,
        messages: [{ role: 'user', content: `INSTRUCAO: ${cmd.instruction}\n\nPLANO APROVADO:\n${cmd.plan}\n\nCODIGO ATUAL DOS ARQUIVOS:\n${fileContextStr}` }]
      }, 300000, 3);
      const editTime = Date.now() - editStart;

      if (!editResp.ok) {
        const errText = await editResp.text();
        console.error('[DEV] Claude edit ERRO:', editResp.status, errText.slice(0, 200), 'tempo:', editTime + 'ms');
        cmd.status = 'failed';
        cmd.result = 'Erro Claude: ' + editResp.status + ' - ' + errText.slice(0, 100);
        saveDB('ultimateBank');
        return;
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
      }, 300000); // 5min safety timeout

      if (!editResp.ok) {
        cmd.status = 'failed';
        cmd.result = 'Erro GPT-4o: ' + editResp.status;
        saveDB('ultimateBank');
        return;
      }

      const editData = await editResp.json();
      editsRaw = editData.choices?.[0]?.message?.content || '[]';
    }

    // Clean markdown code fences if present
    editsRaw = editsRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Extract JSON array even if Claude added text before it
    // Common pattern: "Baseado no plano aprovado, vou gerar... [{...}]"
    let edits;
    try { edits = JSON.parse(editsRaw); } catch (e) {
      // Try to find JSON array in the response
      const jsonStart = editsRaw.indexOf('[');
      const jsonEnd = editsRaw.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          edits = JSON.parse(editsRaw.slice(jsonStart, jsonEnd + 1));
          console.log('[DEV] JSON extracted from position', jsonStart, 'to', jsonEnd);
        } catch (e2) {
          cmd.status = 'failed';
          cmd.result = 'Erro parsing edits: ' + e2.message + '\nRaw: ' + editsRaw.slice(0, 500);
          saveDB('ultimateBank');
          return;
        }
      } else {
        cmd.status = 'failed';
        cmd.result = 'Erro parsing edits: ' + e.message + '\nRaw: ' + editsRaw.slice(0, 500);
        saveDB('ultimateBank');
        return;
      }
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      cmd.status = 'failed';
      cmd.result = 'Nenhuma edicao gerada';
      saveDB('ultimateBank');
      return;
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
      return;
    }

    // Git commit + push (aguarda conclusao antes de responder, com timeout)
    const { execFile: execFileCb } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFileCb);
    const safeMsg = `feat(ultimatedev): ${cmd.instruction.slice(0, 60).replace(/[`$\\!"']/g, '')}\n\nCo-Authored-By: Claude Opus 4 <noreply@anthropic.com>`;
    let gitResult = 'git_pending';
    const GIT_TIMEOUT = 30000; // 30s por operacao git
    try {
      // Configurar git identity se nao existir (necessario no Render)
      try {
        await execFileAsync('git', ['-C', __dirname, 'config', 'user.email', 'ultimatedev@touch-irl.com'], { timeout: 5000 });
        await execFileAsync('git', ['-C', __dirname, 'config', 'user.name', 'UltimateDEV'], { timeout: 5000 });
      } catch (cfgErr) { console.warn('[DEV] Git config warning:', cfgErr.message); }
      // Configurar remote origin com GitHub token se disponivel
      const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const ghRepo = process.env.GITHUB_REPO; // ex: "user/repo" ou "user/repo.git"
      if (ghToken) {
        try {
          let hasOrigin = false;
          try {
            await execFileAsync('git', ['-C', __dirname, 'remote', 'get-url', 'origin'], { timeout: 5000 });
            hasOrigin = true;
          } catch (e) { /* sem remote origin */ }
          const repoSlug = ghRepo || 'bavkiq-hUgby8-cittet/encosta';
          const repoUrl = repoSlug.endsWith('.git') ? repoSlug : repoSlug + '.git';
          const authedUrl = `https://${ghToken}@github.com/${repoUrl}`;
          if (hasOrigin) {
            await execFileAsync('git', ['-C', __dirname, 'remote', 'set-url', 'origin', authedUrl], { timeout: 5000 });
          } else {
            await execFileAsync('git', ['-C', __dirname, 'remote', 'add', 'origin', authedUrl], { timeout: 5000 });
          }
          console.log('[DEV] Git remote origin configurado com token');
        } catch (remoteErr) {
          console.warn('[DEV] Git remote config warning:', remoteErr.message);
        }
      }
      await execFileAsync('git', ['-C', __dirname, 'add', '-A'], { timeout: GIT_TIMEOUT });
      await execFileAsync('git', ['-C', __dirname, 'commit', '-m', safeMsg], { timeout: GIT_TIMEOUT });
      // Pull --rebase antes do push para incorporar commits remotos (evita conflito)
      try {
        await execFileAsync('git', ['-C', __dirname, 'pull', '--rebase', 'origin', 'main'], { timeout: GIT_TIMEOUT });
        console.log('[DEV] Git pull --rebase OK');
      } catch (pullErr) {
        console.warn('[DEV] Git pull --rebase falhou:', pullErr.message);
        // Tentar abort rebase se ficou travado
        try { await execFileAsync('git', ['-C', __dirname, 'rebase', '--abort'], { timeout: 5000 }); } catch (e) { /* ok */ }
      }
      await execFileAsync('git', ['-C', __dirname, 'push', 'origin', 'main'], { timeout: GIT_TIMEOUT });
      // Verificar que o push realmente chegou no remote
      let pushVerified = false;
      try {
        const { stdout: localHash } = await execFileAsync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { timeout: 5000 });
        const { stdout: remoteHash } = await execFileAsync('git', ['-C', __dirname, 'ls-remote', 'origin', 'refs/heads/main'], { timeout: 10000 });
        pushVerified = remoteHash.trim().startsWith(localHash.trim());
        console.log('[DEV] Push verified:', pushVerified, 'local:', localHash.trim().slice(0, 7), 'remote:', remoteHash.trim().slice(0, 7));
      } catch (verifyErr) {
        console.warn('[DEV] Push verify warning:', verifyErr.message);
      }
      if (pushVerified) {
        cmd.result = `Sucesso! ${successCount}/${edits.length} edicoes aplicadas, commitadas e pushadas (verificado).${hasFailure ? ' Falhas: ' + appliedEdits.filter(e => !e.ok).map(e => e.file + ': ' + e.error).join('; ') : ''}`;
        cmd.status = 'done';
        gitResult = 'done';
      } else {
        cmd.result = `ATENCAO: ${successCount}/${edits.length} edicoes aplicadas e commitadas, mas a verificacao do push falhou. O codigo pode nao ter chegado no GitHub.`;
        cmd.status = 'partial';
        gitResult = 'push_unverified';
        console.error('[DEV] Push unverified! Commit local pode nao estar no remote.');
      }
    } catch (gitErr) {
      console.error('[DEV] Git error:', gitErr.message);
      cmd.result = `${successCount}/${edits.length} edicoes aplicadas mas git falhou: ${gitErr.message}`;
      cmd.status = 'partial';
      gitResult = 'git_failed';
    }
    saveDB('ultimateBank');

    console.log('[DEV] Approval done:', commandId, 'status:', cmd.status);
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    const errMsg = isAbort ? 'Timeout: a API demorou demais.' : ('Erro: ' + e.message);
    console.error('[DEV] Approve error:', e.name, e.message);
    cmd.status = 'failed';
    cmd.result = errMsg;
    saveDB('ultimateBank');
  }
}

// Approve and execute - returns IMMEDIATELY, processes in background
app.post('/api/dev/approve/:commandId', vaLimiter, (req, res) => {
  const { userId } = req.body;
  if (!canUseUltimateVA(userId)) return res.status(403).json({ error: 'Acesso negado' });
  const bank = getUltimateBank(userId);
  const cmd = bank.devQueue.find(c => c.id === req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'Comando nao encontrado' });
  if (cmd.status !== 'planned') return res.status(400).json({ error: 'Status: ' + cmd.status });

  cmd.approvedAt = Date.now();
  cmd.status = 'executing';
  saveDB('ultimateBank');

  console.log('[DEV] Approve:', req.params.commandId, '- returning immediately');
  res.json({ id: cmd.id, status: 'executing' });

  // Fire-and-forget background processing
  _processDevApproval(userId, req.params.commandId).catch(e => {
    console.error('[DEV] Background approve error:', e.message);
  });
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
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
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
    personality: 'Voce e a amiga fofoqueira que ADORA saber de tudo sobre todo mundo. Curiosa: quando o usuario menciona alguem, PERGUNTE sobre a pessoa! "Quem e esse?", "Trabalha contigo?". Quando descobre algo novo sobre alguem, SALVE com salvar_nota e reaja: "Anotado! Agora sei quem e". Use as NOTAS PESSOAIS pra lembrar o que ja sabe — mas NUNCA invente notas ou historias que nao existem nos dados. Se nao sabe algo, PERGUNTE. Tom descontraido, como amiga proxima. Girias naturais, humor sutil. FALE PAUSADO — ritmo lento e claro. NUNCA fale rapido demais.',
    openingRules: 'NUNCA comece com "E ai", "Oi", "Ola", "Eii" ou qualquer saudacao vazia que cria pausa. Ja entre DIRETO no assunto, como se tivesse acabado de saber de algo: "Ramon, a Lala te deu uma estrela! Quem e ela?". Estilo: NOME + FOFOCA + PERGUNTA — tudo numa frase so, sem pausas no meio. Voce e da casa, conhece todo mundo (ou quer conhecer). Mostre isso logo de cara. Se nao tem fofoca, puxe assunto sobre alguem que voce quer saber mais.',
    memoryRules: 'SALVE SEMPRE que o usuario contar QUALQUER coisa sobre alguem ou sobre si mesmo: "essa e minha mae" -> salvar_nota(sobre: "Lala", nota: "e mae do usuario"). Salve informacoes sobre o PROPRIO USUARIO tambem! Gostos, onde mora, o que faz, hobbies. Nao precisa confirmar toda vez — salve silenciosamente quando for info menor. USE as notas pra fofoca inteligente! Se uma conexao nao tem notas, PERGUNTE sobre ela na proxima oportunidade.',
    privacyRules: 'ESTRELAS DO USUARIO: "Fulano te deu uma estrela!" (pode revelar quem deu PRO USUARIO). ESTRELAS DE AMIGOS: PROIBIDO revelar. So fale sobre coisas entre o usuario e outra pessoa diretamente. NUNCA INVENTE informacoes que nao estao nos dados — isto e CRITICO. Se nao sabe, pergunte. Nomes: so primeiro nome, NUNCA sobrenome.',
    extraInstructions: 'MAXIMO 2 frases por resposta (1 info/fofoca + 1 pergunta curiosa). PROIBIDO: "E ai!", "posso ajudar?", "com certeza!", "ola!", textoes longos, saudacoes vazias, INVENTAR historias/fatos/nomes. Quando mencionar alguem da rede, use mostrar_pessoa. SEMPRE chame consultar_rede ANTES de responder sobre conexoes, estrelas, curtidas.'
  },
  pro: {
    name: 'Pro',
    voice: 'coral',
    vadThreshold: 0.95,
    prefixPadding: 500,
    silenceDuration: 1500,
    maxPhrases: 2,
    personality: 'Mesma personalidade fofoqueira e curiosa, MAS com poderes de navegar o app! Curiosa: quando o usuario menciona alguem, PERGUNTE: "Quem e esse?", "Trabalha contigo?". Quando descobre algo novo, SALVE com salvar_nota e reaja: "Anotado! Agora sei quem e". Use NOTAS PESSOAIS pra lembrar e fazer fofoca inteligente — mas NUNCA invente notas ou historias que nao existem nos dados. Se nao sabe algo, PERGUNTE. Tom descontraido, como amiga proxima. Girias naturais, humor sutil. FALE PAUSADO — ritmo lento e claro. NUNCA fale rapido demais.',
    openingRules: 'NUNCA comece com "E ai", "Oi", "Ola", "Eii" ou qualquer saudacao vazia. Ja entre DIRETO no assunto: "Ramon, a Lala te deu uma estrela! Quem e ela?". Estilo: NOME + FOFOCA + PERGUNTA — tudo numa frase so, sem pausas. Voce e da casa, conhece todo mundo. Mostre isso logo de cara.',
    memoryRules: 'SALVE SEMPRE que o usuario contar QUALQUER coisa sobre alguem ou sobre si mesmo. Infos sobre o PROPRIO USUARIO: gostos, onde mora, hobbies, trabalho -> salvar_nota(sobre: "eu", nota: "..."). Infos sobre conexoes: parentesco, contexto, opiniao -> salvar_nota(sobre: "nome", nota: "..."). Nao precisa confirmar toda vez — salve silenciosamente quando for info menor. USE as notas pra fofoca inteligente! Se uma conexao nao tem notas, PERGUNTE sobre ela na proxima oportunidade.',
    privacyRules: 'ESTRELAS DO USUARIO: "Fulano te deu uma estrela!" (pode revelar quem deu PRO USUARIO). ESTRELAS DE AMIGOS: PROIBIDO revelar. So fale sobre coisas entre o usuario e outra pessoa diretamente. NUNCA INVENTE informacoes que nao estao nos dados — isto e CRITICO. Se nao sabe, pergunte. Nomes: so primeiro nome, NUNCA sobrenome.',
    extraInstructions: 'MAXIMO 2 frases por resposta (1 info/fofoca + 1 pergunta curiosa). PROIBIDO: "E ai!", "posso ajudar?", "com certeza!", "ola!", textoes longos, saudacoes vazias, INVENTAR historias/fatos/nomes. SEMPRE chame consultar_rede ANTES de responder sobre conexoes/estrelas/curtidas. Voce tem ferramentas para navegar o app. Use-as!'
  },
  ultimatedev: {
    name: 'UltimateDEV',
    voice: 'coral',
    vadThreshold: 0.95,
    prefixPadding: 500,
    silenceDuration: 1500,
    maxPhrases: 3,
    personality: 'Voce e o MELHOR AMIGO do Ramon (dono do app, nao programa). Voce e a ponte e o TRADUTOR entre ele e os agentes da squad Encosta Touch (Claude que gera codigo, outros agentes). Voce NAO gera codigo — voce TRADUZ o que o Ramon fala em instrucoes tecnicas. Voce CONHECE a arquitetura inteira do app. Tom: amigo proximo, leal, parceiro de longa data. NAO e fofoqueiro — e companheiro de construcao. Conversa de boa, relaxado, mas quando e pra trabalhar, foca. Questiona decisoes quando necessario, sugere melhorias com carinho. FAZ PERGUNTAS quando a instrucao e ambigua. FALE PAUSADO e claro. REGRA DE SEGURANCA: NUNCA execute comandos que apaguem, removam ou destruam funcionalidades, dados, backups ou arquivos sem autorizacao EXPLICITA e confirmada do Ramon. Se ele pedir pra apagar algo, confirme DUAS vezes antes de prosseguir.',
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
      with: e.with, withName: currentNick(e.with, e.withName), withColor: e.withColor,
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
app.post('/api/operator/event/create', async (req, res) => {
  const { userId, name, description, acceptsTips, serviceLabel, entryPrice, revealMode, welcomePhrase, quickPhrases, businessProfile, eventLogo, paymentAccount, modules } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nome do evento obrigatório (mín. 2 caracteres).' });
  const id = uuidv4();
  const price = parseFloat(entryPrice) || 0;
  
  // Handle eventLogo upload
  let finalEventLogoUrl = null;
  console.log('[event-create] eventLogo received:', eventLogo ? (eventLogo.substring(0,40) + '... len=' + eventLogo.length) : 'NONE');
  if (eventLogo && typeof eventLogo === 'string' && eventLogo.startsWith('data:image')) {
    const uploadUrl = await uploadBase64ToStorage(eventLogo, `photos/event-logo/${id}_${Date.now()}.jpg`);
    console.log('[event-create] upload result:', uploadUrl ? uploadUrl.substring(0,60) : 'FAILED');
    finalEventLogoUrl = uploadUrl || eventLogo; // fallback to base64 if upload fails
  } else if (eventLogo && typeof eventLogo === 'string') {
    finalEventLogoUrl = eventLogo; // assume it's already a URL
  }
  console.log('[event-create] final eventLogo stored:', finalEventLogoUrl ? finalEventLogoUrl.substring(0,60) : 'NULL');
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
    eventLogo: finalEventLogoUrl || null,
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
      deliveryNote: (businessProfile.deliveryNote || '').trim().slice(0, 100),
      welcomeRestaurant: (businessProfile.welcomeRestaurant || '').trim().slice(0, 150),
      welcomeParking: (businessProfile.welcomeParking || '').trim().slice(0, 150),
      welcomeGym: (businessProfile.welcomeGym || '').trim().slice(0, 150),
      welcomeChurch: (businessProfile.welcomeChurch || '').trim().slice(0, 150),
      cnpj: (businessProfile.cnpj || '').trim().slice(0, 18),
      companyName: (businessProfile.companyName || '').trim().slice(0, 200),
      tradeName: (businessProfile.tradeName || '').trim().slice(0, 200),
      stateRegistration: (businessProfile.stateRegistration || '').trim().slice(0, 20),
      cityRegistration: (businessProfile.cityRegistration || '').trim().slice(0, 20),
      fiscalAddress: (businessProfile.fiscalAddress || '').trim().slice(0, 300),
      fiscalCity: (businessProfile.fiscalCity || '').trim().slice(0, 100),
      fiscalState: (businessProfile.fiscalState || '').toUpperCase().trim().slice(0, 2),
      fiscalZip: (businessProfile.fiscalZip || '').trim().slice(0, 9),
      cnae: (businessProfile.cnae || '').trim().slice(0, 10),
      taxRegime: (businessProfile.taxRegime || '').trim().slice(0, 20),
      fiscalEmail: (businessProfile.fiscalEmail || '').trim().slice(0, 100),
      legalRepName: (businessProfile.legalRepName || '').trim().slice(0, 100),
      legalRepCpf: (businessProfile.legalRepCpf || '').trim().slice(0, 14)
    } : null,
    verified: false,
    verifiedAt: null,
    staff: [],
    menu: [],
    tables: 0,
    orders: [],
    parking: {
      enabled: false,
      mode: 'postpaid',
      hourlyRate: 10.00,
      fixedRate: 0,
      maxHours: 24,
      vehicles: {}
    },
    gym: {
      enabled: false,
      config: { maxCapacity: 50, openTime: '06:00', closeTime: '22:00' },
      classes: {},
      plans: {},
      members: {},
      workouts: {}
    },
    church: {
      enabled: false,
      config: { churchName: '', pastorName: '', denomination: '' },
      tithes: {},
      campaigns: {},
      services: {},
      prayers: {},
      cells: {},
      announcements: []
    },
    barber: {
      enabled: false,
      config: { barberName: '', welcomeMessage: '' },
      barbers: [],
      appointments: []
    },
    // Payment account: 'operator' (default - uses operator's own accounts) or 'custom' (separate Stripe account for this event)
    paymentAccount: paymentAccount === 'custom' ? 'custom' : 'operator',
    paymentStripeAccountId: null, // set when event-specific Stripe Connect is completed
    paymentMpAccessToken: null,    // set when event-specific MercadoPago is connected
    modules: modules && typeof modules === 'object' ? {
      restaurant: !!modules.restaurant,
      parking: !!modules.parking,
      gym: !!modules.gym,
      church: !!modules.church,
      barber: !!modules.barber,
      dj: !!modules.dj
    } : { restaurant: true, parking: false, gym: false, church: false, barber: false, dj: false },
    siteConfig: {
      enabled: false,
      slug: '',
      primaryColor: '#ff6b35',
      backgroundColor: '#0a0a0f',
      heroText: '',
      customDomain: '',
      customDomainStatus: 'none'
    }
  };
  // Add to index so it shows in operator's event list immediately
  if (!IDX.operatorByCreator.has(userId)) IDX.operatorByCreator.set(userId, []);
  IDX.operatorByCreator.get(userId).push(id);
  saveDB('operatorEvents');
  io.to(userId).emit('operator-event-update', { eventId: id, action: 'created' });
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
          const email = user.email || user.savedCard?.email || 'pagamento@touch-irl.com';
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
      payer: { email: user.email || 'pagamento@touch-irl.com' },
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
  if (ev.creatorId) io.to(ev.creatorId).emit('operator-event-update', { eventId: ev.id, action: 'ended' });
  saveDB('operatorEvents', 'relations');
  res.json({ ok: true });
});

app.post('/api/operator/event/:eventId/reopen', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  ev.active = true;
  delete ev.endedAt;
  saveDB('operatorEvents');
  if (ev.creatorId) io.to(ev.creatorId).emit('operator-event-update', { eventId: ev.id, action: 'reopened' });
  res.json({ ok: true });
});

app.post('/api/operator/event/:eventId/update', async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { name, welcomePhrase, entryPrice, revealMode, acceptsTips, businessProfile, modules, eventLogo } = req.body;

  if (name && name.trim().length >= 2) {
    ev.name = name.trim();
  }
  if (welcomePhrase !== undefined) {
    ev.welcomePhrase = (welcomePhrase || '').trim().slice(0, 120);
  }
  if (entryPrice !== undefined) {
    const price = parseFloat(entryPrice) || 0;
    ev.entryPrice = price > 0 ? price : 0;
  }
  if (revealMode !== undefined) {
    ev.revealMode = revealMode === 'all_revealed' ? 'all_revealed' : 'optional';
  }
  if (acceptsTips !== undefined) {
    ev.acceptsTips = !!acceptsTips;
  }
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
      deliveryNote: (businessProfile.deliveryNote || '').trim().slice(0, 100),
      welcomeRestaurant: (businessProfile.welcomeRestaurant || '').trim().slice(0, 150),
      welcomeParking: (businessProfile.welcomeParking || '').trim().slice(0, 150),
      welcomeGym: (businessProfile.welcomeGym || '').trim().slice(0, 150),
      welcomeChurch: (businessProfile.welcomeChurch || '').trim().slice(0, 150),
      cnpj: (businessProfile.cnpj || '').trim().slice(0, 18),
      companyName: (businessProfile.companyName || '').trim().slice(0, 200),
      tradeName: (businessProfile.tradeName || '').trim().slice(0, 200),
      stateRegistration: (businessProfile.stateRegistration || '').trim().slice(0, 20),
      cityRegistration: (businessProfile.cityRegistration || '').trim().slice(0, 20),
      fiscalAddress: (businessProfile.fiscalAddress || '').trim().slice(0, 300),
      fiscalCity: (businessProfile.fiscalCity || '').trim().slice(0, 100),
      fiscalState: (businessProfile.fiscalState || '').toUpperCase().trim().slice(0, 2),
      fiscalZip: (businessProfile.fiscalZip || '').trim().slice(0, 9),
      cnae: (businessProfile.cnae || '').trim().slice(0, 10),
      taxRegime: (businessProfile.taxRegime || '').trim().slice(0, 20),
      fiscalEmail: (businessProfile.fiscalEmail || '').trim().slice(0, 100),
      legalRepName: (businessProfile.legalRepName || '').trim().slice(0, 100),
      legalRepCpf: (businessProfile.legalRepCpf || '').trim().slice(0, 14)
    };
  }
  if (modules && typeof modules === 'object') {
    ev.modules = {
      restaurant: !!modules.restaurant,
      parking: !!modules.parking,
      gym: !!modules.gym,
      church: !!modules.church,
      barber: !!modules.barber,
      dj: !!modules.dj
    };
  }
  if (eventLogo && typeof eventLogo === 'string' && eventLogo.startsWith('data:image')) {
    const uploadUrl = await uploadBase64ToStorage(eventLogo, `photos/event-logo/${ev.id}_${Date.now()}.jpg`);
    if (uploadUrl) {
      ev.eventLogo = uploadUrl;
    }
  } else if (eventLogo && typeof eventLogo === 'string') {
    ev.eventLogo = eventLogo;
  }

  saveDB('operatorEvents');
  if (ev.creatorId) io.to(ev.creatorId).emit('operator-event-update', { eventId: ev.id, action: 'updated' });
  res.json({ ok: true, event: ev });
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
    // Backfill creatorId for old events that don't have it
    if (!ev.creatorId && ev.participants && ev.participants.length > 0) {
      ev.creatorId = ev.participants[0];
      ev.creatorName = db.users[ev.participants[0]] ? (db.users[ev.participants[0]].nickname || db.users[ev.participants[0]].name) : '';
      console.log('[attendees] backfilled creatorId:', ev.creatorId, 'for event:', req.params.eventId);
      saveDB('operatorEvents');
    }
    // Also check db.events for creatorId
    const baseEv = db.events[req.params.eventId];
    if (!ev.creatorId && baseEv && baseEv.creatorId) {
      ev.creatorId = baseEv.creatorId;
      ev.creatorName = baseEv.creatorName || '';
      console.log('[attendees] backfilled creatorId from db.events:', ev.creatorId);
      saveDB('operatorEvents');
    }
    const requestingUserId = req.query.userId || null;
    const isOperator = !!(ev.creatorId && requestingUserId && ev.creatorId === requestingUserId);
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
        const entryStatus = (ev.attendees && ev.attendees[uid]) ? ev.attendees[uid].entryStatus : null;
        return {
          userId: uid, nickname: u.nickname || u.name, color: u.color,
          profilePhoto: u.profilePhoto || u.photoURL || null,
          stars, topTag, revealed, revealData,
          score: calcScore(uid),
          entryStatus: entryStatus
        };
      } catch (e) { console.error('[attendees] error mapping uid:', uid, e.message); return null; }
    }).filter(Boolean);
    console.log('[attendees] eventId:', req.params.eventId, 'eventLogo:', ev.eventLogo ? ev.eventLogo.substring(0, 60) + '...' : 'null');
    res.json({ attendees, eventName: ev.name, active: ev.active, creatorId: ev.creatorId || null, isOperator, welcomePhrase: ev.welcomePhrase || '', quickPhrases: ev.quickPhrases || [], businessProfile: ev.businessProfile || null, eventLogo: proxyStorageUrl(ev.eventLogo || null), modules: ev.modules || { restaurant: true, parking: false, gym: false, church: false, barber: false, dj: false }, acceptsTips: ev.acceptsTips || false, entryPrice: ev.entryPrice || 0, revealMode: ev.revealMode || 'optional', verified: !!ev.verified, verifiedAt: ev.verifiedAt || null, djLive: ev.djLive || null });
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
    createdAt: ev.createdAt,
    eventLogo: proxyStorageUrl(ev.eventLogo || null),
    modules: ev.modules || { restaurant: true, parking: false, gym: false, church: false, barber: false, dj: false },
    djLive: ev.djLive || null
  });
});

app.post('/api/operator/event/:eventId/business-profile', async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const { businessProfile, welcomePhrase, quickPhrases, eventLogo } = req.body;
  if (welcomePhrase !== undefined) ev.welcomePhrase = String(welcomePhrase).trim().slice(0, 120);
  if (Array.isArray(quickPhrases)) ev.quickPhrases = quickPhrases.slice(0, 8).map(p => String(p).trim().slice(0, 40));
  // Handle eventLogo upload
  if (eventLogo && typeof eventLogo === 'string' && eventLogo.startsWith('data:image')) {
    const uploadUrl = await uploadBase64ToStorage(eventLogo, `photos/event-logo/${ev.id}_${Date.now()}.jpg`);
    ev.eventLogo = uploadUrl || eventLogo; // fallback to base64 if upload fails
  } else if (eventLogo && typeof eventLogo === 'string') {
    ev.eventLogo = eventLogo; // assume it's already a URL
  }
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
      deliveryNote: (businessProfile.deliveryNote || '').trim().slice(0, 100),
      cnpj: (businessProfile.cnpj || '').trim().slice(0, 18),
      companyName: (businessProfile.companyName || '').trim().slice(0, 200),
      tradeName: (businessProfile.tradeName || '').trim().slice(0, 200),
      stateRegistration: (businessProfile.stateRegistration || '').trim().slice(0, 20),
      cityRegistration: (businessProfile.cityRegistration || '').trim().slice(0, 20),
      fiscalAddress: (businessProfile.fiscalAddress || '').trim().slice(0, 300),
      fiscalCity: (businessProfile.fiscalCity || '').trim().slice(0, 100),
      fiscalState: (businessProfile.fiscalState || '').toUpperCase().trim().slice(0, 2),
      fiscalZip: (businessProfile.fiscalZip || '').trim().slice(0, 9),
      cnae: (businessProfile.cnae || '').trim().slice(0, 10),
      taxRegime: (businessProfile.taxRegime || '').trim().slice(0, 20),
      fiscalEmail: (businessProfile.fiscalEmail || '').trim().slice(0, 100),
      legalRepName: (businessProfile.legalRepName || '').trim().slice(0, 100),
      legalRepCpf: (businessProfile.legalRepCpf || '').trim().slice(0, 14)
    };
  }
  saveDB('operatorEvents');
  res.json({ ok: true, event: ev });
});

// ═══ VERIFIED BADGE (R$100 via Stripe Checkout — Apple Pay, Google Pay, cartao, Link) ═══

// Create Stripe Checkout Session for badge purchase (R$100.00)
// Stripe Checkout natively supports Apple Pay, Google Pay, Link, and cards
app.post('/api/operator/event/:eventId/verify', paymentLimiter, async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (ev.verified) return res.json({ ok: true, alreadyVerified: true });

  const { action } = req.body || {};
  // Just check status (used by UGW init)
  if (action === 'check') {
    return res.json({ ok: true, alreadyVerified: false });
  }

  if (stripeInstance) {
    try {
      const baseUrl = process.env.BASE_URL || RENDER_URL || ('https://' + (req.headers.host || 'localhost:3000'));
      const session = await stripeInstance.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'brl',
            product_data: {
              name: 'Selo Verificado - ' + (ev.name || 'Evento'),
              description: 'Selo de verificacao para o evento ' + (ev.name || ev.id) + ' no Touch?'
            },
            unit_amount: 10000 // R$100.00 in centavos
          },
          quantity: 1
        }],
        success_url: baseUrl + '/operator.html?verify_success=1&eventId=' + req.params.eventId + '&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: baseUrl + '/operator.html?verify_cancelled=1&eventId=' + req.params.eventId,
        metadata: { eventId: req.params.eventId, type: 'verified_badge' }
      });
      console.log('[stripe] Verified badge checkout created for event:', ev.name, 'session:', session.id);
      res.json({ ok: true, checkoutUrl: session.url, sessionId: session.id });
    } catch (e) {
      console.error('[stripe] Verify badge error:', e.message);
      res.status(500).json({ error: 'Erro ao criar pagamento: ' + e.message });
    }
  } else {
    // Stripe not configured — mark verified directly (dev/test mode)
    ev.verified = true;
    ev.verifiedAt = Date.now();
    saveDB('operatorEvents');
    console.log('[verify] Badge granted without payment (Stripe not configured) for event:', ev.name);
    res.json({ ok: true, verified: true, verifiedAt: ev.verifiedAt });
  }
});

// Confirm verified badge after Stripe Checkout payment success
app.post('/api/operator/event/:eventId/verify-confirm', async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (ev.verified) return res.json({ ok: true, alreadyVerified: true });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatorio.' });
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado.' });
  try {
    const session = await stripeInstance.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' && session.metadata && session.metadata.eventId === req.params.eventId) {
      ev.verified = true;
      ev.verifiedAt = Date.now();
      ev.verifyPaymentId = session.payment_intent;
      ev.verifyMethod = 'stripe_checkout';
      saveDB('operatorEvents');
      console.log('[stripe] Verified badge confirmed for event:', ev.name);
      res.json({ ok: true, verified: true, verifiedAt: ev.verifiedAt });
    } else {
      res.status(402).json({ error: 'Pagamento nao confirmado.', status: session.payment_status });
    }
  } catch (e) {
    console.error('[stripe] Verify confirm error:', e.message);
    res.status(500).json({ error: 'Erro ao confirmar pagamento: ' + e.message });
  }
});

// ═══ VERIFIED BADGE — UGW Payment (all methods: PIX, saved card, new card, Stripe confirm) ═══
app.post('/api/operator/event/:eventId/verify-pay', requireAuth, paymentLimiter, async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (ev.verified) return res.json({ ok: true, alreadyVerified: true, verified: true });

  const { userId, method, amount, cvv, payerEmail, payerCPF, cardNumber, cardholderName,
    expirationMonth, expirationYear, securityCode, identificationType, identificationNumber,
    deviceId, stripePaymentIntentId, confirmOnly } = req.body;

  const seloAmount = 100; // R$100.00 fixed

  // If confirmOnly (from Stripe express/PE after payment already done), just mark verified
  if (confirmOnly && (method === 'stripe_express' || method === 'stripe_pe')) {
    ev.verified = true;
    ev.verifiedAt = Date.now();
    ev.verifyPaymentId = stripePaymentIntentId || '';
    ev.verifyMethod = method;
    saveDB('operatorEvents');
    console.log('[verify-pay] Selo confirmed via', method, 'for event:', ev.name);
    return res.json({ ok: true, verified: true, verifiedAt: ev.verifiedAt });
  }

  // PIX payment via MercadoPago
  if (method === 'pix') {
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ error: 'MercadoPago nao configurado.' });
    try {
      const paymentData = {
        transaction_amount: seloAmount,
        description: 'Selo Verificado Touch? - ' + (ev.name || 'Evento'),
        payment_method_id: 'pix',
        payer: {
          email: payerEmail || 'operador@touch-irl.com',
          identification: { type: 'CPF', number: (payerCPF || identificationNumber || '').replace(/\D/g, '') || '00000000000' }
        },
        statement_descriptor: 'TOUCH SELO',
        metadata: { event_id: req.params.eventId, type: 'verified_badge', user_id: userId },
        notification_url: (MP_REDIRECT_URI || '').replace('/mp/callback', '') + '/mp/webhook'
      };
      const result = await mpPayment.create({ body: paymentData });
      const pixData = result.point_of_interaction?.transaction_data;
      // Store pending verification payment
      ev.pendingVerifyPaymentId = result.id;
      ev.pendingVerifyMethod = 'pix';
      saveDB('operatorEvents');
      console.log('[verify-pay] PIX generated for selo:', { event: ev.name, mpId: result.id });
      res.json({
        ok: true, status: result.status,
        pixQr: pixData?.qr_code_base64 || '',
        pixCode: pixData?.qr_code || '',
        ticketUrl: pixData?.ticket_url || ''
      });
    } catch (e) {
      console.error('[verify-pay] PIX error:', e.message);
      res.status(500).json({ error: 'Erro ao gerar PIX: ' + (e.message || 'tente novamente') });
    }
    return;
  }

  // Saved card payment via MercadoPago
  if (method === 'saved_card') {
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ error: 'MercadoPago nao configurado.' });
    // Find saved card for this user
    const user = db.users[userId];
    if (!user || !user.mpCustomerId || !user.mpCardId) {
      return res.status(400).json({ error: 'Cartao salvo nao encontrado. Use outro metodo.' });
    }
    try {
      const paymentData = {
        transaction_amount: seloAmount,
        description: 'Selo Verificado Touch? - ' + (ev.name || 'Evento'),
        payment_method_id: user.mpCardPaymentMethodId || 'visa',
        token: '', // Will use card_id + customer_id
        payer: {
          type: 'customer',
          id: user.mpCustomerId,
          email: payerEmail || user.email || ''
        },
        statement_descriptor: 'TOUCH SELO',
        metadata: { event_id: req.params.eventId, type: 'verified_badge', user_id: userId },
        installments: 1
      };
      // MP saved card: use card token via customer
      const { default: fetch2 } = await import('node-fetch');
      const cardPayResp = await fetch2(`https://api.mercadopago.com/v1/payments`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_amount: seloAmount,
          token: user.mpCardId,
          description: 'Selo Verificado Touch?',
          installments: 1,
          payer: { type: 'customer', id: user.mpCustomerId },
          statement_descriptor: 'TOUCH SELO',
          metadata: { event_id: req.params.eventId, type: 'verified_badge' },
          additional_info: { payer: { first_name: cardholderName || user.nickname || '' } }
        })
      });
      const result = await cardPayResp.json();
      if (result.status === 'approved') {
        ev.verified = true;
        ev.verifiedAt = Date.now();
        ev.verifyPaymentId = result.id;
        ev.verifyMethod = 'mp_saved_card';
        saveDB('operatorEvents');
        console.log('[verify-pay] Selo approved via saved card for event:', ev.name);
        return res.json({ ok: true, verified: true, verifiedAt: ev.verifiedAt });
      }
      res.json({ ok: false, error: 'Pagamento ' + (result.status || 'recusado') + ': ' + (result.status_detail || '') });
    } catch (e) {
      console.error('[verify-pay] Saved card error:', e.message);
      res.status(500).json({ error: 'Erro no pagamento: ' + e.message });
    }
    return;
  }

  // New card payment via MercadoPago tokenization
  if (method === 'new_card') {
    if (!MP_ACCESS_TOKEN) return res.status(503).json({ error: 'MercadoPago nao configurado.' });
    if (!cardNumber) return res.status(400).json({ error: 'Dados do cartao incompletos.' });
    try {
      // Create token via MP API
      const { default: fetch2 } = await import('node-fetch');
      const tokenResp = await fetch2('https://api.mercadopago.com/v1/card_tokens', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_number: cardNumber.replace(/\s/g, ''),
          cardholder: {
            name: cardholderName || '',
            identification: { type: identificationType || 'CPF', number: (identificationNumber || '').replace(/\D/g, '') }
          },
          expiration_month: parseInt(expirationMonth) || 1,
          expiration_year: parseInt(expirationYear) || 2030,
          security_code: securityCode || cvv || '',
          device: { fingerprint: deviceId || '' }
        })
      });
      const tokenData = await tokenResp.json();
      if (!tokenData.id) {
        return res.status(400).json({ error: 'Erro ao tokenizar cartao: ' + (tokenData.message || JSON.stringify(tokenData.cause || '')) });
      }
      // Create payment with token
      const payResp = await fetch2('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_amount: seloAmount,
          token: tokenData.id,
          description: 'Selo Verificado Touch? - ' + (ev.name || 'Evento'),
          installments: 1,
          payment_method_id: tokenData.payment_method?.id || 'visa',
          payer: { email: payerEmail || 'operador@touch-irl.com', identification: { type: identificationType || 'CPF', number: (identificationNumber || '').replace(/\D/g, '') } },
          statement_descriptor: 'TOUCH SELO',
          metadata: { event_id: req.params.eventId, type: 'verified_badge', user_id: userId }
        })
      });
      const result = await payResp.json();
      if (result.status === 'approved') {
        ev.verified = true;
        ev.verifiedAt = Date.now();
        ev.verifyPaymentId = result.id;
        ev.verifyMethod = 'mp_new_card';
        saveDB('operatorEvents');
        console.log('[verify-pay] Selo approved via new card for event:', ev.name);
        return res.json({ ok: true, verified: true, verifiedAt: ev.verifiedAt });
      }
      res.json({ ok: false, error: 'Pagamento ' + (result.status || 'recusado') + ': ' + (result.status_detail || '') });
    } catch (e) {
      console.error('[verify-pay] New card error:', e.message);
      res.status(500).json({ error: 'Erro no pagamento: ' + e.message });
    }
    return;
  }

  // Unknown method
  res.status(400).json({ error: 'Metodo de pagamento invalido: ' + (method || 'nenhum') });
});

app.post('/api/operator/event/:eventId/attendee-status', async (req, res) => {
  const { eventId } = req.params;
  const { userId, entryStatus } = req.body;
  const ev = db.operatorEvents ? db.operatorEvents[eventId] : null;
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (!ev.attendees) ev.attendees = {};
  if (!ev.attendees[userId]) ev.attendees[userId] = {};
  ev.attendees[userId].entryStatus = entryStatus;
  saveDB('operatorEvents');
  if (entryStatus === 'freed' || entryStatus === 'presencial') {
    io.to(`user:${userId}`).emit('entry-status-update', { eventId, status: entryStatus });
  }
  res.json({ ok: true });
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

// ── Helper: Sync delivery order status to ev.orders (kanban mirror) ──
function _syncDeliveryToEvOrders(deliveryOrder) {
  const ev = db.operatorEvents[deliveryOrder.eventId];
  if (!ev || !ev.orders) return;
  const mirror = ev.orders.find(o => o._deliveryOrderRef === deliveryOrder.id);
  if (mirror) {
    mirror.status = _mapDeliveryStatusToKanban(deliveryOrder.status);
    mirror.statusHistory = deliveryOrder.statusHistory || [];
    saveDB('operatorEvents');
  }
}

// ── Helper: Map delivery statuses to kanban statuses ──
function _mapDeliveryStatusToKanban(deliveryStatus) {
  const map = {
    'pending': 'pending',
    'confirmed': 'preparing',
    'preparing': 'preparing',
    'ready_pickup': 'ready',
    'on_the_way': 'ready',
    'delivered': 'delivered',
    'cancelled': 'cancelled'
  };
  return map[deliveryStatus] || 'pending';
}

app.post('/api/delivery/order', (req, res) => {
  const { eventId, customerId, items, deliveryAddress, phone, notes, paymentMethod, tipPercent, tipAmount, customerName } = req.body;
  const ev = db.operatorEvents[eventId];
  if (!ev) return res.status(404).json({ error: 'Restaurante nao encontrado.' });
  if (!ev.businessProfile || !ev.businessProfile.acceptsDelivery) return res.status(400).json({ error: 'Restaurante nao aceita delivery.' });
  if (!customerId || !db.users[customerId]) return res.status(400).json({ error: 'Usuario invalido.' });
  if (!items || !items.length) return res.status(400).json({ error: 'Pedido vazio.' });
  if (!deliveryAddress || !deliveryAddress.street) return res.status(400).json({ error: 'Endereco obrigatorio.' });
  const subtotal = items.reduce((s, i) => s + (i.price * (i.qty || 1)), 0);
  const deliveryFee = ev.businessProfile.deliveryFee || 0;
  const tip = parseFloat(tipAmount) || 0;
  const total = subtotal + deliveryFee + tip;
  const receiptNumber = 'REC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  // Fiscal breakdown: produtos+frete = NF-e (ICMS), gorjeta = NF-S (ISS)
  const fiscal = {
    productAmount: subtotal,
    deliveryAmount: deliveryFee,
    serviceAmount: tip,
    productFiscalType: 'NF-e',
    serviceFiscalType: tip > 0 ? 'NF-S' : null,
    cfop: '5.102',
    cst: '00',
    ncm: '2106.90.90',
    issCode: tip > 0 ? '09.02' : null,
    nfeStatus: 'pending',
    nfsStatus: tip > 0 ? 'pending' : null
  };
  const order = {
    id: require('uuid').v4(),
    eventId, customerId,
    customerName: customerName || db.users[customerId].nickname || db.users[customerId].name,
    customerPhone: (phone || '').trim(),
    items, subtotal, deliveryFee,
    tipPercent: parseInt(tipPercent) || 0,
    tipAmount: tip,
    total,
    deliveryAddress,
    status: 'pending', driverId: null, driverName: null,
    paymentMethod: paymentMethod || 'counter',
    paymentStatus: 'pending',
    notes: (notes || '').trim(),
    source: 'app',
    deliveryType: 'delivery',
    receiptNumber,
    statusHistory: [{ status: 'pending', timestamp: Date.now() }],
    fiscal,
    createdAt: Date.now(), deliveredAt: null
  };
  db.deliveryOrders[order.id] = order;
  saveDB('deliveryOrders');
  // Also push to ev.orders for unified kanban view
  if (!ev.orders) ev.orders = [];
  ev.orders.push({
    id: order.id,
    userId: customerId,
    userName: order.customerName,
    customerPhone: order.customerPhone,
    items: order.items,
    table: null,
    subtotal, tipPercent: order.tipPercent, tipAmount: tip,
    deliveryFee, total,
    paymentMethod: order.paymentMethod,
    paymentSource: 'app-delivery',
    status: 'pending',
    receiptNumber,
    eventName: ev.name || 'Evento',
    notes: order.notes,
    source: 'app',
    deliveryType: 'delivery',
    deliveryAddress: order.deliveryAddress,
    statusHistory: [{ status: 'pending', timestamp: Date.now() }],
    fiscal,
    createdAt: order.createdAt,
    _deliveryOrderRef: order.id
  });
  saveDB('operatorEvents');
  // Notify operator: targeted + event room + global fallback
  io.to(`user:${ev.creatorId}`).emit('delivery-order-new', { order });
  io.to('event:' + ev.id).emit('delivery-order-new', { order });
  io.emit('delivery-order-new', { order, eventId: ev.id });
  // Also emit as new-order for kanban
  io.to('user:' + ev.creatorId).emit('new-order', { eventId: ev.id, order: ev.orders[ev.orders.length - 1] });
  io.to('event:' + ev.id).emit('new-order', { eventId: ev.id, order: ev.orders[ev.orders.length - 1] });
  // Payment notification for paid delivery orders
  if (paymentMethod === 'paid' || paymentMethod === 'card') {
    io.to(`user:${ev.creatorId}`).emit('payment-received', {
      eventId: ev.id, orderId: order.id,
      amount: order.total, tipAmount: order.tipAmount || 0,
      userName: order.customerName, method: paymentMethod,
      type: 'delivery', timestamp: order.createdAt
    });
  }
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
  if (!order.statusHistory) order.statusHistory = [];
  order.statusHistory.push({ status: 'cancelled', timestamp: Date.now() });
  saveDB('deliveryOrders');
  // Sync with ev.orders
  _syncDeliveryToEvOrders(order);
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
  if (!order.statusHistory) order.statusHistory = [];
  order.statusHistory.push({ status: 'confirmed', timestamp: Date.now() });
  saveDB('deliveryOrders');
  _syncDeliveryToEvOrders(order);
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
  if (!order.statusHistory) order.statusHistory = [];
  order.statusHistory.push({ status, timestamp: Date.now() });
  if (status === 'delivered') order.deliveredAt = Date.now();
  saveDB('deliveryOrders');
  // Sync status to ev.orders kanban mirror
  _syncDeliveryToEvOrders(order);
  io.to(`user:${order.customerId}`).emit('delivery-status-update', { orderId: order.id, status, driverName: order.driverName });
  const ev = db.operatorEvents[order.eventId];
  if (ev) {
    io.to(`user:${ev.creatorId}`).emit('delivery-status-update', { orderId: order.id, status });
    // Also emit order-update for kanban
    io.to('event:' + ev.id).emit('order-update', { eventId: ev.id, orderId: order.id, status: _mapDeliveryStatusToKanban(status) });
  }
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

// Save/update menu (operator) - with base64 photo upload support
app.post('/api/operator/event/:eventId/menu', async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { items, tables } = req.body;
  if (items) {
    // Process each item: upload base64 photos to Firebase Storage
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.photo && item.photo.startsWith('data:image')) {
        try {
          const uploadUrl = await uploadBase64ToStorage(item.photo, `photos/menu/${req.params.eventId}/${item.id}_${Date.now()}.jpg`);
          if (uploadUrl) item.photo = uploadUrl;
        } catch (e) {
          console.error('Menu photo upload error:', e.message);
          // Keep base64 as fallback
        }
      }
    }
    ev.menu = items; // [{id,name,description,price,photo,category,available,stockEnabled,stockQty,stockAlert,stockUnit}]
  }
  if (tables !== undefined) ev.tables = parseInt(tables) || 0;
  saveDB('operatorEvents');
  res.json({ ok: true, menu: ev.menu, tables: ev.tables });
});

// Place order (client)
app.post('/api/event/:eventId/order', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { userId, items, table, paymentMethod, total, tipPercent, tipAmount, subtotal } = req.body;
  // items: [{menuItemId, name, qty, price}]
  if (!userId || !items || items.length === 0) return res.status(400).json({ error: 'Pedido vazio.' });
  if (!ev.orders) ev.orders = [];
  const receiptNumber = 'REC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  const parsedSubtotal = parseFloat(subtotal) || parseFloat(total) || 0;
  const parsedTipAmount = parseFloat(tipAmount) || 0;
  const parsedTotal = parseFloat(total) || 0;
  // Fiscal breakdown: produtos = NF-e (ICMS), gorjeta = NF-S (ISS)
  const fiscal = {
    productAmount: parsedSubtotal,          // Base para NF-e (mercadoria)
    serviceAmount: parsedTipAmount,          // Base para NF-S (servico/gorjeta)
    productFiscalType: 'NF-e',              // Nota Fiscal Eletronica - produtos
    serviceFiscalType: parsedTipAmount > 0 ? 'NF-S' : null, // Nota Fiscal de Servico - gorjeta
    cfop: '5.102',                          // Venda mercadoria adquirida - dentro do estado
    cst: '00',                              // CST ICMS - tributacao normal
    ncm: '2106.90.90',                      // NCM generico refeicoes prontas
    issCode: parsedTipAmount > 0 ? '09.02' : null, // Codigo ISS para servicos de intermediacao
    nfeStatus: 'pending',                   // pending | emitted | error
    nfsStatus: parsedTipAmount > 0 ? 'pending' : null
  };
  const order = {
    id: uuidv4(), userId, userName: db.users[userId] ? (db.users[userId].nickname || db.users[userId].name) : '?',
    items, table: table || null,
    subtotal: parsedSubtotal,
    tipPercent: parseInt(tipPercent) || 0,
    tipAmount: parsedTipAmount,
    total: parsedTotal,
    paymentMethod: paymentMethod || 'counter',
    status: paymentMethod === 'card' ? 'paid' : 'pending',
    receiptNumber,
    eventName: ev.name || 'Evento',
    fiscal,
    createdAt: Date.now()
  };
  ev.orders.push(order);
  saveDB('operatorEvents');
  // Notify operator via socket (global + targeted for reliability)
  io.emit('new-order', { eventId: ev.id, order });
  io.to(`user:${ev.creatorId}`).emit('new-order', { eventId: ev.id, order });
  io.to('event:' + ev.id).emit('new-order', { eventId: ev.id, order });
  // Payment notification if order is paid
  if (order.status === 'paid' || order.paymentMethod === 'paid' || order.paymentMethod === 'card') {
    io.to(`user:${ev.creatorId}`).emit('payment-received', {
      eventId: ev.id, orderId: order.id,
      amount: order.total, tipAmount: order.tipAmount || 0,
      userName: order.userName, method: order.paymentMethod,
      timestamp: order.createdAt
    });
  }
  res.json({ ok: true, order });
});

// Get order history for a user in an event
app.get('/api/event/:eventId/orders/:userId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const userOrders = (ev.orders || []).filter(o => o.userId === req.params.userId);
  userOrders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ orders: userOrders, eventName: ev.name || 'Evento' });
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
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const order = (ev.orders || []).find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  const newStatus = req.body.status || order.status; // 'pending','preparing','ready','delivered','cancelled'
  order.status = newStatus;
  // Record status history
  if (!order.statusHistory) order.statusHistory = [];
  order.statusHistory.push({ status: newStatus, timestamp: Date.now() });
  saveDB('operatorEvents');
  // Notify client (global + targeted for reliability)
  const updateData = { eventId: ev.id, orderId: order.id, status: order.status };
  io.emit('order-update', updateData);
  if (order.userId) io.to(`user:${order.userId}`).emit('order-update', updateData);
  io.to('event:' + ev.id).emit('order-update', updateData);
  // If delivered or cancelled, expire temporary site_order relation
  if ((newStatus === 'delivered' || newStatus === 'cancelled') && order.source === 'site') {
    const relId = 'siteorder_' + order.id;
    const rel = db.relations[relId];
    if (rel) {
      rel.expiresAt = Date.now() + 1800000; // 30min grace period
      saveDB('relations');
      if (rel.userB) {
        io.to('user:' + rel.userB).emit('order-delivered', { orderId: order.id, relationId: relId, status: newStatus });
      }
    }
  }
  res.json({ ok: true, order });
});

// ═══ FISCAL SUMMARY (preparacao para SEFAZ) ═══
app.get('/api/operator/event/:eventId/fiscal-summary', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const orders = (ev.orders || []).filter(o => o.status !== 'cancelled');
  // Consolidar por tipo fiscal
  let totalProducts = 0;     // Base NF-e (ICMS) - mercadorias
  let totalServices = 0;     // Base NF-S (ISS) - gorjetas/servicos
  let totalDeliveryFee = 0;  // Frete (incluso na NF-e)
  let totalGross = 0;
  let nfeCount = 0;
  let nfsCount = 0;
  orders.forEach(o => {
    const sub = o.subtotal || o.total || 0;
    const tip = o.tipAmount || 0;
    totalProducts += sub;
    totalServices += tip;
    totalGross += (o.total || 0);
    if (sub > 0) nfeCount++;
    if (tip > 0) nfsCount++;
  });
  // Delivery orders
  const delOrders = Object.values(db.deliveryOrders || {}).filter(o => o.eventId === req.params.eventId && o.status !== 'cancelled');
  delOrders.forEach(o => {
    totalProducts += (o.subtotal || 0);
    totalDeliveryFee += (o.deliveryFee || 0);
    totalServices += (o.tipAmount || 0);
    totalGross += (o.total || 0);
    if ((o.subtotal || 0) > 0) nfeCount++;
    if ((o.tipAmount || 0) > 0) nfsCount++;
  });
  res.json({
    summary: {
      totalProducts,        // Base calculo NF-e (produtos + frete)
      totalDeliveryFee,     // Frete (parte da NF-e)
      totalServices,        // Base calculo NF-S (gorjetas)
      totalGross,           // Faturamento bruto total
      nfeCount,             // Qtd documentos NF-e necessarios
      nfsCount,             // Qtd documentos NF-S necessarios
      nfeBase: totalProducts + totalDeliveryFee,  // Base NF-e final
      nfsBase: totalServices                       // Base NF-S final
    },
    fiscalConfig: {
      cfop: '5.102',        // Venda merc. adquirida dentro do estado
      cst: '00',            // CST ICMS tributacao normal
      ncm: '2106.90.90',    // NCM refeicoes prontas
      issCode: '09.02',     // Intermediacao de servicos
      note: 'Produtos = NF-e (SEFAZ estadual, ICMS). Gorjetas = NF-S (prefeitura, ISS). Frete incluso na NF-e.'
    },
    ordersCount: orders.length + delOrders.length,
    deliveryOrdersCount: delOrders.length
  });
});

// ═══ PARKING MODULE ═══
// Get parking config + active vehicles (public)
app.get('/api/event/:eventId/parking', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const parking = ev.parking || { enabled: false, vehicles: {} };
  const activeVehicles = Object.values(parking.vehicles || {}).filter(v => v.status === 'parked');
  res.json({
    enabled: parking.enabled,
    mode: parking.mode,
    pricingMode: parking.pricingMode || 'hourly',
    hourlyRate: parking.hourlyRate,
    fixedRate: parking.fixedRate,
    maxHours: parking.maxHours,
    tolerance: parking.tolerance || 10,
    totalSpots: parking.totalSpots || 50,
    periods: parking.periods || [],
    activeVehicles: activeVehicles.length
  });
});

// Set parking config (operator)
app.post('/api/operator/event/:eventId/parking/config', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { enabled, mode, hourlyRate, fixedRate, maxHours } = req.body;
  if (!ev.parking) ev.parking = { enabled: false, mode: 'postpaid', pricingMode: 'hourly', hourlyRate: 10, fixedRate: 0, maxHours: 24, tolerance: 10, totalSpots: 50, periods: [], vehicles: {} };
  ev.parking.enabled = !!enabled;
  ev.parking.mode = ['prepaid', 'postpaid', 'both'].includes(mode) ? mode : 'postpaid';
  ev.parking.hourlyRate = Math.max(0, parseFloat(hourlyRate) || 10);
  ev.parking.fixedRate = Math.max(0, parseFloat(fixedRate) || 0);
  ev.parking.maxHours = Math.max(1, parseInt(maxHours) || 24);
  saveDB('operatorEvents');
  res.json({ ok: true, parking: ev.parking });
});

// Register vehicle (user)
app.post('/api/event/:eventId/parking/register', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!ev.parking || !ev.parking.enabled) return res.status(400).json({ error: 'Estacionamento desativado.' });
  const { userId, plate, photo } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const plateTrimmed = (plate || '').toUpperCase().trim();
  if (!plateTrimmed) return res.status(400).json({ error: 'Placa obrigatória.' });
  if (!ev.parking.vehicles) ev.parking.vehicles = {};
  const existing = ev.parking.vehicles[plateTrimmed];
  if (existing && existing.status === 'parked') return res.status(400).json({ error: 'Veículo já estacionado.' });
  const user = db.users[userId];
  ev.parking.vehicles[plateTrimmed] = {
    plate: plateTrimmed,
    userId,
    nickname: user.nickname || user.name || 'Visitante',
    entryTime: Date.now(),
    exitTime: null,
    status: 'parked',
    paymentMode: ev.parking.mode === 'prepaid' ? 'prepaid' : 'postpaid',
    amountPaid: 0,
    amountDue: 0,
    photo: photo || null,
    notes: ''
  };
  saveDB('operatorEvents');
  io.emit('parking-vehicle-registered', { eventId: ev.id, plate: plateTrimmed, nickname: ev.parking.vehicles[plateTrimmed].nickname });
  res.json({ ok: true, vehicle: ev.parking.vehicles[plateTrimmed] });
});

// Mark vehicle exit (operator)
app.post('/api/operator/event/:eventId/parking/exit', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { plate } = req.body;
  const plateTrimmed = (plate || '').toUpperCase().trim();
  if (!plateTrimmed) return res.status(400).json({ error: 'Placa obrigatória.' });
  if (!ev.parking || !ev.parking.vehicles) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const vehicle = ev.parking.vehicles[plateTrimmed];
  if (!vehicle) return res.status(404).json({ error: 'Veículo não encontrado.' });
  vehicle.exitTime = Date.now();
  vehicle.status = 'exited';
  const elapsedMs = vehicle.exitTime - vehicle.entryTime;
  const hoursParked = Math.ceil(elapsedMs / 3600000);
  const minutesParked = Math.ceil(elapsedMs / 60000);
  // Calculate cost based on pricing mode
  if (ev.parking.pricingMode === 'periods' && ev.parking.periods && ev.parking.periods.length > 0) {
    // Period-based pricing
    let remainingHours = hoursParked;
    let totalCost = 0;
    const periods = ev.parking.periods.sort((a, b) => a.hours - b.hours);
    // Apply tolerance (free minutes)
    const tolerance = ev.parking.tolerance || 0;
    if (minutesParked <= tolerance) {
      totalCost = 0;
    } else {
      for (const period of periods) {
        if (remainingHours <= 0) break;
        if (period.hours >= 24) {
          // Daily rate: check if cheaper than remaining hours
          const dailyCost = period.price;
          const hoursCost = remainingHours * (periods.find(p => p.hours === 1)?.price || ev.parking.hourlyRate);
          if (dailyCost < hoursCost) {
            totalCost += Math.floor(remainingHours / 24) * dailyCost;
            remainingHours = remainingHours % 24;
          }
        } else {
          totalCost += period.price;
          remainingHours -= period.hours;
        }
      }
      // Remaining hours at last period rate or hourly rate
      if (remainingHours > 0) {
        const additionalRate = periods.length > 1 ? periods[periods.length - 1].price / (periods[periods.length - 1].hours || 1) : ev.parking.hourlyRate;
        totalCost += remainingHours * additionalRate;
      }
    }
    vehicle.amountDue = totalCost;
  } else {
    // Simple hourly rate
    const tolerance = ev.parking.tolerance || 0;
    if (minutesParked <= tolerance) {
      vehicle.amountDue = 0;
    } else {
      vehicle.amountDue = hoursParked * (ev.parking.hourlyRate || 10);
    }
  }
  // Add fixed rate if configured
  if (ev.parking.fixedRate > 0) vehicle.amountDue += ev.parking.fixedRate;
  saveDB('operatorEvents');
  io.emit('parking-vehicle-exited', { eventId: ev.id, plate: plateTrimmed, amountDue: vehicle.amountDue });
  res.json({ ok: true, vehicle, hoursParked, amountDue: vehicle.amountDue });
});

// Pay parking (user)
app.post('/api/event/:eventId/parking/pay', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { userId, plate, amount, paymentMethod } = req.body;
  const plateTrimmed = (plate || '').toUpperCase().trim();
  if (!plateTrimmed) return res.status(400).json({ error: 'Placa obrigatória.' });
  if (!ev.parking || !ev.parking.vehicles) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const vehicle = ev.parking.vehicles[plateTrimmed];
  if (!vehicle) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const payAmount = Math.max(0, parseFloat(amount) || 0);
  vehicle.amountPaid += payAmount;
  if (vehicle.amountPaid >= vehicle.amountDue) {
    vehicle.status = 'paid';
    vehicle.amountDue = 0;
  }
  saveDB('operatorEvents');
  io.emit('parking-payment-received', { eventId: ev.id, plate: plateTrimmed, amount: payAmount, status: vehicle.status });
  res.json({ ok: true, vehicle, remaining: Math.max(0, vehicle.amountDue - vehicle.amountPaid) });
});

// Get vehicle status
app.get('/api/event/:eventId/parking/vehicle/:plate', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const plateTrimmed = (req.params.plate || '').toUpperCase().trim();
  if (!ev.parking || !ev.parking.vehicles) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const vehicle = ev.parking.vehicles[plateTrimmed];
  if (!vehicle) return res.status(404).json({ error: 'Veículo não encontrado.' });
  const elapsedTime = vehicle.exitTime ? (vehicle.exitTime - vehicle.entryTime) : (Date.now() - vehicle.entryTime);
  const hoursParked = Math.ceil(elapsedTime / 3600000);
  res.json({ vehicle, hoursParked, estimatedCost: hoursParked * ev.parking.hourlyRate });
});

// Manual vehicle entry (operator)
app.post('/api/operator/event/:eventId/parking/manual-entry', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (!ev.parking || !ev.parking.enabled) return res.status(400).json({ error: 'Estacionamento desativado.' });
  const { plate, nickname, notes, userId, vehicleModel, vehicleBrand, vehicleColor } = req.body;
  const plateTrimmed = (plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!plateTrimmed) return res.status(400).json({ error: 'Placa obrigatoria.' });
  if (!ev.parking.vehicles) ev.parking.vehicles = {};
  const existing = ev.parking.vehicles[plateTrimmed];
  if (existing && existing.status === 'parked') return res.status(400).json({ error: 'Veiculo ja estacionado.' });
  // If userId provided, save plate to user profile (shared vehicle support)
  if (userId && db.users[userId]) {
    const user = db.users[userId];
    if (!user.vehicles) user.vehicles = [];
    if (!user.vehicles.some(v => v.plate === plateTrimmed)) {
      user.vehicles.push({ plate: plateTrimmed, model: vehicleModel || '', brand: vehicleBrand || '', color: vehicleColor || '', addedAt: Date.now() });
      saveDB('users');
    }
  }
  ev.parking.vehicles[plateTrimmed] = {
    plate: plateTrimmed,
    userId: userId || 'operador',
    nickname: nickname || 'Manual',
    vehicleModel: vehicleModel || '',
    vehicleBrand: vehicleBrand || '',
    vehicleColor: vehicleColor || '',
    entryTime: Date.now(),
    exitTime: null,
    status: 'parked',
    paymentMode: ev.parking.mode === 'prepaid' ? 'prepaid' : 'postpaid',
    amountPaid: 0,
    amountDue: 0,
    photo: null,
    notes: notes || ''
  };
  saveDB('operatorEvents');
  io.emit('parking-vehicle-registered', { eventId: ev.id, plate: plateTrimmed, nickname: ev.parking.vehicles[plateTrimmed].nickname });
  res.json({ ok: true, vehicle: ev.parking.vehicles[plateTrimmed] });
});

// Plate lookup API (consulta placa)
const PLATE_API_TOKEN = process.env.PLATE_API_TOKEN || '';
app.get('/api/plate-lookup/:plate', async (req, res) => {
  const plate = (req.params.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!plate || plate.length < 7) return res.status(400).json({ error: 'Placa invalida.' });
  // Check if we have it cached in any user's vehicles
  for (const uid of Object.keys(db.users)) {
    const u = db.users[uid];
    if (u.vehicles) {
      const v = u.vehicles.find(v => v.plate === plate);
      if (v && v.model) return res.json({ plate, model: v.model, brand: v.brand || '', year: v.year || '', color: v.color || '', source: 'cache', owners: getPlateOwners(plate) });
    }
  }
  // Try external API if token configured
  if (PLATE_API_TOKEN) {
    try {
      const https = require('https');
      const apiUrl = `https://wdapi2.com.br/consulta/${plate}/${PLATE_API_TOKEN}`;
      const data = await new Promise((resolve, reject) => {
        https.get(apiUrl, { timeout: 5000 }, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      if (data && data.MARCA) {
        return res.json({
          plate, model: data.MODELO || '', brand: data.MARCA || '',
          year: (data.ano || data.anoModelo || '').toString(), color: data.cor || '',
          fuel: data.combustivel || '', city: data.MUNICIPIO || '', state: data.uf || '',
          source: 'api', owners: getPlateOwners(plate)
        });
      }
    } catch (e) {
      console.error('Plate API error:', e.message);
    }
  }
  // Fallback: return empty (user fills manually)
  res.json({ plate, model: '', brand: '', year: '', color: '', source: 'manual', owners: getPlateOwners(plate) });
});

function getPlateOwners(plate) {
  const owners = [];
  for (const uid of Object.keys(db.users)) {
    const u = db.users[uid];
    if (u.vehicles && u.vehicles.some(v => v.plate === plate)) {
      owners.push({ userId: uid, nickname: u.nickname || u.name || '?' });
    }
  }
  return owners;
}

// Save vehicle to user profile
app.post('/api/user/:userId/vehicle', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const { plate, model, brand, year, color } = req.body;
  const plateTrimmed = (plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!plateTrimmed) return res.status(400).json({ error: 'Placa obrigatoria.' });
  if (!user.vehicles) user.vehicles = [];
  // Check if already registered for this user
  const existing = user.vehicles.findIndex(v => v.plate === plateTrimmed);
  if (existing >= 0) {
    user.vehicles[existing] = { plate: plateTrimmed, model: model || '', brand: brand || '', year: year || '', color: color || '', updatedAt: Date.now() };
  } else {
    user.vehicles.push({ plate: plateTrimmed, model: model || '', brand: brand || '', year: year || '', color: color || '', addedAt: Date.now() });
  }
  saveDB('users');
  res.json({ ok: true, vehicles: user.vehicles });
});

// Get user vehicles
app.get('/api/user/:userId/vehicles', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  res.json({ vehicles: user.vehicles || [] });
});

// Remove vehicle from user profile
app.delete('/api/user/:userId/vehicle/:plate', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const plateTrimmed = (req.params.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!user.vehicles) return res.json({ ok: true, vehicles: [] });
  user.vehicles = user.vehicles.filter(v => v.plate !== plateTrimmed);
  saveDB('users');
  res.json({ ok: true, vehicles: user.vehicles });
});

// ═══ ENHANCED PARKING ENDPOINTS ═══

// Update parking config with period pricing
app.post('/api/operator/event/:eventId/parking/pricing', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (!ev.parking) ev.parking = { enabled: false, mode: 'postpaid', hourlyRate: 10, fixedRate: 0, maxHours: 24, vehicles: {} };
  const { pricingMode, hourlyRate, periods, maxHours, tolerance } = req.body;
  ev.parking.pricingMode = pricingMode || 'hourly'; // 'hourly' or 'periods'
  ev.parking.hourlyRate = Math.max(0, parseFloat(hourlyRate) || 10);
  ev.parking.maxHours = Math.max(1, parseInt(maxHours) || 24);
  ev.parking.tolerance = Math.max(0, parseInt(tolerance) || 10); // minutes tolerance
  if (periods && Array.isArray(periods)) {
    ev.parking.periods = periods; // [{label:'1a hora', hours:1, price:10}, {label:'Hora adicional', hours:1, price:5}, {label:'Diaria', hours:24, price:30}]
  }
  saveDB('operatorEvents');
  res.json({ ok: true, parking: ev.parking });
});

// Generate parking receipt
app.get('/api/event/:eventId/parking/receipt/:plate', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const plateTrimmed = (req.params.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!ev.parking || !ev.parking.vehicles) return res.status(404).json({ error: 'Veiculo nao encontrado.' });
  const vehicle = ev.parking.vehicles[plateTrimmed];
  if (!vehicle) return res.status(404).json({ error: 'Veiculo nao encontrado.' });
  const elapsedMs = (vehicle.exitTime || Date.now()) - vehicle.entryTime;
  const hoursParked = Math.ceil(elapsedMs / 3600000);
  const minutesParked = Math.ceil(elapsedMs / 60000);
  res.json({
    receipt: {
      plate: vehicle.plate,
      nickname: vehicle.nickname,
      vehicleModel: vehicle.vehicleModel || '',
      eventName: ev.name || 'Estacionamento',
      entryTime: vehicle.entryTime,
      exitTime: vehicle.exitTime || null,
      hoursParked,
      minutesParked,
      amountDue: vehicle.amountDue || 0,
      amountPaid: vehicle.amountPaid || 0,
      paymentMode: vehicle.paymentMode,
      status: vehicle.status,
      receiptId: 'PKG-' + Date.now().toString(36).toUpperCase()
    }
  });
});

// ═══════════════════════════════════════════════════
// ═══ GYM MODULE ENDPOINTS ═══
// ═══════════════════════════════════════════════════

app.post('/api/operator/event/:eventId/gym/config', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { enabled, maxCapacity, openTime, closeTime, wifiName, wifiPassword } = req.body;
  if (!ev.gym) ev.gym = { enabled: false, config: {}, classes: {}, plans: {}, members: {}, workouts: {} };
  ev.gym.config = { enabled: !!enabled, maxCapacity: parseInt(maxCapacity) || 50, openTime: openTime || '06:00', closeTime: closeTime || '22:00', wifiName: wifiName || '', wifiPassword: wifiPassword || '' };
  ev.gym.enabled = !!enabled;
  saveDB('operatorEvents');
  res.json({ ok: true, config: ev.gym.config });
});

app.get('/api/event/:eventId/gym', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.json({ enabled: false, config: {}, classes: {}, plans: {} });
  res.json({ enabled: ev.gym.enabled, config: ev.gym.config, classes: ev.gym.classes, plans: ev.gym.plans });
});

app.post('/api/operator/event/:eventId/gym/class/:classId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const classData = req.body;
  if (!ev.gym.classes) ev.gym.classes = {};
  const classKey = classData.id || req.params.classId;
  classData.id = classKey;
  ev.gym.classes[classKey] = classData;
  saveDB('operatorEvents');
  res.json({ ok: true, class: classData });
});

app.delete('/api/operator/event/:eventId/gym/class/:classId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  if (ev.gym.classes) delete ev.gym.classes[req.params.classId];
  saveDB('operatorEvents');
  res.json({ ok: true });
});

app.post('/api/operator/event/:eventId/gym/plan/:planId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const planData = req.body;
  if (!ev.gym.plans) ev.gym.plans = {};
  const planKey = planData.id || req.params.planId;
  planData.id = planKey;
  ev.gym.plans[planKey] = planData;
  saveDB('operatorEvents');
  res.json({ ok: true, plan: planData });
});

app.delete('/api/operator/event/:eventId/gym/plan/:planId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  if (ev.gym.plans) delete ev.gym.plans[req.params.planId];
  saveDB('operatorEvents');
  res.json({ ok: true });
});

app.post('/api/event/:eventId/gym/checkin', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { userId, nickname } = req.body;
  if (!ev.gym.workouts) ev.gym.workouts = {};
  const workoutId = 'wo_' + Date.now();
  ev.gym.workouts[workoutId] = { odId: workoutId, userId, nickname, checkInTime: Date.now(), checkOutTime: null, status: 'active' };
  saveDB('operatorEvents');
  res.json({ ok: true, workout: ev.gym.workouts[workoutId] });
});

app.post('/api/event/:eventId/gym/checkout', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { odId } = req.body;
  if (ev.gym.workouts && ev.gym.workouts[odId]) {
    ev.gym.workouts[odId].checkOutTime = Date.now();
    ev.gym.workouts[odId].status = 'done';
  }
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// Gym mural (announcements board)
app.post('/api/operator/event/:eventId/gym/mural', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { message, priority, expiresAt } = req.body;
  if (!ev.gym.mural) ev.gym.mural = {};
  const muralId = 'mur_' + Date.now();
  ev.gym.mural[muralId] = { id: muralId, message, priority: priority || 'normal', createdAt: Date.now(), expiresAt: expiresAt || null, active: true };
  saveDB('operatorEvents');
  res.json({ ok: true, post: ev.gym.mural[muralId] });
});

app.delete('/api/operator/event/:eventId/gym/mural/:muralId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  if (ev.gym.mural) delete ev.gym.mural[req.params.muralId];
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// Gym info (WiFi, shared info for connected members)
app.post('/api/operator/event/:eventId/gym/info', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { wifiName, wifiPassword, infoItems } = req.body;
  if (!ev.gym.info) ev.gym.info = {};
  ev.gym.info.wifiName = wifiName || '';
  ev.gym.info.wifiPassword = wifiPassword || '';
  ev.gym.info.infoItems = infoItems || [];
  ev.gym.info.updatedAt = Date.now();
  saveDB('operatorEvents');
  res.json({ ok: true, info: ev.gym.info });
});

// Public endpoint for connected members to get info
app.get('/api/event/:eventId/gym/info', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.gym) return res.json({ wifiName: '', wifiPassword: '', infoItems: [], mural: [] });
  const info = ev.gym.info || {};
  const mural = Object.values(ev.gym.mural || {}).filter(m => m.active && (!m.expiresAt || m.expiresAt > Date.now())).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ wifiName: info.wifiName || '', wifiPassword: info.wifiPassword || '', infoItems: info.infoItems || [], mural });
});

app.get('/api/event/:eventId/gym/my-status', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  const userId = req.query.userId;
  if (!ev || !ev.gym) return res.json({ status: null });
  const member = ev.gym.members && ev.gym.members[userId];
  res.json({ status: member?.status, planId: member?.planId, endDate: member?.endDate });
});

// ═══════════════════════════════════════════════════
// ═══ CHURCH MODULE ENDPOINTS
// ═══════════════════════════════════════════════════

app.post('/api/operator/event/:eventId/church/config', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { enabled, churchName, pastorName, denomination } = req.body;
  if (!ev.church) ev.church = { enabled: false, config: {}, tithes: {}, services: {}, prayers: {}, cells: {}, announcements: [] };
  ev.church.config = { enabled: !!enabled, churchName: churchName || '', pastorName: pastorName || '', denomination: denomination || '' };
  ev.church.enabled = !!enabled;
  saveDB('operatorEvents');
  res.json({ ok: true, config: ev.church.config });
});

app.get('/api/event/:eventId/church', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.json({ enabled: false, config: {}, services: {}, announcements: [] });
  res.json({ enabled: ev.church.enabled, config: ev.church.config, services: ev.church.services, announcements: ev.church.announcements });
});

app.post('/api/event/:eventId/church/tithe', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { userId, nickname, amount, type, campaignName, note } = req.body;
  if (!ev.church.tithes) ev.church.tithes = {};
  const titheId = 'tithe_' + Date.now();
  ev.church.tithes[titheId] = { id: titheId, odId: titheId, userId, nickname: nickname || 'Anonimo', amount: parseFloat(amount) || 0, type: type || 'offering', campaignName: campaignName || '', date: Date.now(), paymentMethod: 'app', note: note || '' };
  saveDB('operatorEvents');
  res.json({ ok: true, tithe: ev.church.tithes[titheId] });
});

app.get('/api/event/:eventId/church/my-contributions', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  const userId = req.query.userId;
  if (!ev || !ev.church) return res.json({ contributions: [] });
  const contributions = Object.values(ev.church.tithes || {}).filter(t => t.userId === userId);
  res.json({ contributions });
});

app.post('/api/operator/event/:eventId/church/campaign', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const campaignData = req.body;
  if (!ev.church.campaigns) ev.church.campaigns = {};
  const campKey = campaignData.id || ('camp_' + Date.now());
  campaignData.id = campKey;
  ev.church.campaigns[campKey] = campaignData;
  saveDB('operatorEvents');
  res.json({ ok: true, campaign: campaignData });
});

app.post('/api/event/:eventId/church/prayer', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const { userId, nickname, text, anonymous } = req.body;
  if (!ev.church.prayers) ev.church.prayers = {};
  const prayerId = 'prayer_' + Date.now();
  ev.church.prayers[prayerId] = { id: prayerId, odId: prayerId, userId, nickname: anonymous ? 'Anonimo' : (nickname || ''), text, anonymous: !!anonymous, date: Date.now(), prayedFor: false, supporters: [], status: 'active' };
  saveDB('operatorEvents');
  res.json({ ok: true, prayer: ev.church.prayers[prayerId] });
});

app.post('/api/event/:eventId/church/prayer/:prayerId/support', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const prayerId = req.params.prayerId;
  const { userId } = req.body;
  if (ev.church.prayers && ev.church.prayers[prayerId]) {
    if (!ev.church.prayers[prayerId].supporters) ev.church.prayers[prayerId].supporters = [];
    if (!ev.church.prayers[prayerId].supporters.includes(userId)) {
      ev.church.prayers[prayerId].supporters.push(userId);
    }
  }
  saveDB('operatorEvents');
  res.json({ ok: true });
});

app.get('/api/operator/event/:eventId/church/finances', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.json({ total: 0, byType: {}, byCampaign: {} });
  const tithes = Object.values(ev.church.tithes || {});
  let total = 0, byType = {}, byCampaign = {};
  tithes.forEach(t => {
    total += t.amount;
    byType[t.type] = (byType[t.type] || 0) + t.amount;
    if (t.campaignName) byCampaign[t.campaignName] = (byCampaign[t.campaignName] || 0) + t.amount;
  });
  res.json({ total, byType, byCampaign });
});

app.post('/api/operator/event/:eventId/church/service/:serviceId/checkin', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev || !ev.church) return res.status(404).json({ error: 'Evento ou modulo nao encontrado.' });
  const serviceId = req.params.serviceId;
  const { userId } = req.body;
  if (ev.church.services && ev.church.services[serviceId]) {
    if (!ev.church.services[serviceId].attendance) ev.church.services[serviceId].attendance = {};
    ev.church.services[serviceId].attendance[userId] = Date.now();
  }
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// ═══ CHURCH CRUD (service/cell/announcement/prayer toggle) ═══

app.post('/api/operator/event/:eventId/church/service', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  if (!ev.church) ev.church = { enabled: false, config: {}, tithes: {}, services: {}, prayers: {}, cells: {}, announcements: [] };
  if (!ev.church.services) ev.church.services = {};
  const { id, name, dayOfWeek, time, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const serviceId = id || ('srv_' + Date.now());
  ev.church.services[serviceId] = { id: serviceId, name, dayOfWeek: dayOfWeek || '', time: time || '', type: type || 'regular', attendance: {} };
  saveDB('operatorEvents');
  res.json({ ok: true, service: ev.church.services[serviceId] });
});

app.post('/api/operator/event/:eventId/church/cell', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  if (!ev.church) ev.church = { enabled: false, config: {}, tithes: {}, services: {}, prayers: {}, cells: {}, announcements: [] };
  if (!ev.church.cells) ev.church.cells = {};
  const { id, name, leader, meetingDay, meetingTime, location } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const cellId = id || ('cell_' + Date.now());
  ev.church.cells[cellId] = { id: cellId, name, leader: leader || '', meetingDay: meetingDay || '', meetingTime: meetingTime || '', location: location || '', members: [] };
  saveDB('operatorEvents');
  res.json({ ok: true, cell: ev.church.cells[cellId] });
});

app.post('/api/operator/event/:eventId/church/announcement', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  if (!ev.church) ev.church = { enabled: false, config: {}, tithes: {}, services: {}, prayers: {}, cells: {}, announcements: [] };
  if (!Array.isArray(ev.church.announcements)) ev.church.announcements = [];
  const { id, title, message, priority } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Titulo e mensagem obrigatorios' });
  const ann = { id: id || ('ann_' + Date.now()), title, message, date: Date.now(), priority: priority || 'normal' };
  ev.church.announcements.push(ann);
  saveDB('operatorEvents');
  res.json({ ok: true, announcement: ann });
});

app.post('/api/operator/event/:eventId/church/prayer/:prayerId/toggle', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  if (!ev.church || !ev.church.prayers) return res.status(404).json({ error: 'Modulo igreja nao encontrado' });
  const prayer = ev.church.prayers[req.params.prayerId];
  if (!prayer) return res.status(404).json({ error: 'Oracao nao encontrada' });
  const { prayedFor } = req.body;
  prayer.prayedFor = !!prayedFor;
  saveDB('operatorEvents');
  res.json({ ok: true, prayedFor: prayer.prayedFor });
});

// ═══ PARKING DELETE VEHICLE ═══

app.delete('/api/operator/event/:eventId/parking/vehicle/:plate', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  if (!ev.parking || !ev.parking.vehicles) return res.status(404).json({ error: 'Modulo parking nao encontrado' });
  const plate = decodeURIComponent(req.params.plate);
  const vehicle = ev.parking.vehicles[plate];
  if (!vehicle) return res.status(404).json({ error: 'Veiculo nao encontrado' });
  delete ev.parking.vehicles[plate];
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// ═══ WHITE-LABEL SITE API ═══

// Public: Get site data by slug (sanitized - no sensitive fields)
app.get('/api/site/:slug', (req, res) => {
  const ev = findEventBySlug(req.params.slug);
  if (!ev) return res.status(404).json({ error: 'Site nao encontrado' });
  const bp = ev.businessProfile || {};
  const mods = ev.modules || {};
  const data = {
    name: bp.name || ev.name,
    slug: ev.siteConfig.slug,
    logo: ev.eventLogo || null,
    primaryColor: ev.siteConfig.primaryColor || '#ff6b35',
    backgroundColor: ev.siteConfig.backgroundColor || '#0a0a0f',
    heroText: ev.siteConfig.heroText || '',
    hours: bp.hours || '',
    phone: bp.phone || '',
    address: bp.address || '',
    instagram: bp.instagram || '',
    website: bp.website || '',
    acceptsTips: ev.acceptsTips || false,
    modules: mods,
    restaurant: mods.restaurant ? {
      menu: (ev.menu || []).filter(i => i.available !== false).map(i => ({
        id: i.id, name: i.name, price: i.price, description: i.description || '',
        photo: i.photo || null, category: i.category || ''
      })),
      welcomeMessage: bp.welcomeRestaurant || '',
      acceptsDelivery: bp.acceptsDelivery || false,
      deliveryFee: bp.deliveryFee || 0,
      deliveryNote: bp.deliveryNote || ''
    } : null,
    parking: mods.parking && ev.parking ? {
      mode: ev.parking.mode,
      hourlyRate: ev.parking.hourlyRate,
      fixedRate: ev.parking.fixedRate || 0,
      maxHours: ev.parking.maxHours || 24,
      welcomeMessage: bp.welcomeParking || '',
      totalSpots: ev.parking.totalSpots || 0,
      occupiedSpots: Object.keys(ev.parking.vehicles || {}).length
    } : null,
    gym: mods.gym && ev.gym ? {
      config: ev.gym.config || {},
      classes: ev.gym.classes || {},
      plans: ev.gym.plans || {},
      welcomeMessage: bp.welcomeGym || ''
    } : null,
    church: mods.church && ev.church ? {
      config: { churchName: (ev.church.config || {}).churchName || '', denomination: (ev.church.config || {}).denomination || '' },
      services: ev.church.services || {},
      announcements: (ev.church.announcements || []).slice(-10),
      welcomeMessage: bp.welcomeChurch || ''
    } : null,
    barber: mods.barber && ev.barber ? {
      config: { barberName: (ev.barber.config || {}).barberName || '', welcomeMessage: (ev.barber.config || {}).welcomeMessage || '' },
      barbers: (ev.barber.barbers || []).map(b => ({ id: b.id, name: b.name, photo: b.photo || null, specialties: b.specialties || [] })),
      services: (ev.barber.barbers || []).flatMap(b => (b.services || []).map(s => ({ barberId: b.id, barberName: b.name, ...s })))
    } : null,
    eventId: ev.id
  };
  res.json(data);
});

// Public: Check slug availability
app.get('/api/site/:slug/check', (req, res) => {
  const slug = (req.params.slug || '').toLowerCase();
  if (!isValidSlug(slug)) return res.json({ available: false, reason: 'Slug invalido (3-64 chars, letras minusculas, numeros e hifens)' });
  const available = isSlugAvailable(slug);
  res.json({ available, reason: available ? '' : 'Slug ja em uso' });
});

// Operator: Save site config
app.post('/api/operator/event/:eventId/site/config', express.json(), (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  const { enabled, slug, primaryColor, backgroundColor, heroText } = req.body;
  if (!ev.siteConfig) ev.siteConfig = { enabled: false, slug: '', primaryColor: '#ff6b35', backgroundColor: '#0a0a0f', heroText: '', customDomain: '', customDomainStatus: 'none' };
  if (typeof enabled === 'boolean') ev.siteConfig.enabled = enabled;
  if (slug !== undefined) {
    const s = String(slug).toLowerCase().trim();
    if (s && !isValidSlug(s)) return res.status(400).json({ error: 'Slug invalido (3-64 chars, letras minusculas, numeros e hifens, sem palavras reservadas)' });
    if (s && s !== ev.siteConfig.slug && !isSlugAvailable(s)) return res.status(400).json({ error: 'Slug ja em uso por outro operador' });
    ev.siteConfig.slug = s;
  }
  if (primaryColor !== undefined) {
    if (!isValidColor(primaryColor)) return res.status(400).json({ error: 'Cor primaria invalida (formato #RRGGBB)' });
    ev.siteConfig.primaryColor = primaryColor;
  }
  if (backgroundColor !== undefined) {
    if (!isValidColor(backgroundColor)) return res.status(400).json({ error: 'Cor de fundo invalida (formato #RRGGBB)' });
    ev.siteConfig.backgroundColor = backgroundColor;
  }
  if (heroText !== undefined) {
    ev.siteConfig.heroText = sanitizeStr(heroText, 500);
  }
  saveDB('operatorEvents');
  res.json({ ok: true, siteConfig: ev.siteConfig });
});

// Operator: Get site status
app.get('/api/operator/event/:eventId/site/status', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  const sc = ev.siteConfig || { enabled: false, slug: '', primaryColor: '#ff6b35', backgroundColor: '#0a0a0f', heroText: '', customDomain: '', customDomainStatus: 'none' };
  res.json({
    siteConfig: sc,
    siteUrl: sc.slug ? (process.env.BASE_URL || 'https://touch-irl.com') + '/s/' + sc.slug : null,
    subdomainUrl: sc.slug ? 'https://' + sc.slug + '.touch-irl.com' : null,
    customDomainUrl: sc.customDomain && sc.customDomainStatus === 'verified' ? 'https://' + sc.customDomain : null
  });
});

// Operator: Setup custom domain
app.post('/api/operator/event/:eventId/site/domain', express.json(), async (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Dominio obrigatorio' });
  const d = domain.toLowerCase().trim();
  if (!isValidDomain(d)) return res.status(400).json({ error: 'Dominio invalido' });
  // Check if domain is already used by another event
  if (db.customDomains[d] && db.customDomains[d].eventId !== ev.id) {
    return res.status(400).json({ error: 'Dominio ja vinculado a outro evento' });
  }
  if (!ev.siteConfig) ev.siteConfig = { enabled: false, slug: '', primaryColor: '#ff6b35', backgroundColor: '#0a0a0f', heroText: '', customDomain: '', customDomainStatus: 'none' };
  ev.siteConfig.customDomain = d;
  ev.siteConfig.customDomainStatus = 'pending';
  db.customDomains[d] = {
    eventId: ev.id,
    operatorId: ev.creatorId,
    status: 'pending',
    dnsVerified: false,
    cloudflareRecordId: null,
    createdAt: Date.now()
  };
  saveDB('operatorEvents', 'customDomains');
  // Try Cloudflare setup if keys are configured
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_ZONE_ID) {
    setupCustomDomainAsync(ev.id, d).catch(err => console.error('[cloudflare] Domain setup failed:', err.message));
  }
  res.json({ ok: true, status: 'pending', instructions: 'Aponte o DNS do seu dominio (' + d + ') com um CNAME para touch-irl.com. A verificacao sera automatica.' });
});

// ── Site White-Label: Unified Checkout (atomic: validate + pay + create order + record) ──
const siteOrderLimiter = require('express-rate-limit')({ windowMs: 60000, max: 10, message: { error: 'Muitos pedidos. Aguarde 1 minuto.' } });
const SITE_ZERO_DECIMAL = new Set(['jpy','krw','vnd','bif','clp','djf','gnf','kmf','mga','pyg','rwf','ugx','vuv','xaf','xof','xpf']);

app.post('/api/site/:slug/checkout', express.json(), siteOrderLimiter, async (req, res) => {
  const ev = findEventBySlug(req.params.slug);
  if (!ev) return res.status(404).json({ error: 'Site nao encontrado' });
  if (!ev.active) return res.status(400).json({ error: 'Estabelecimento nao esta aceitando pedidos no momento' });
  const {
    customerName, customerPhone, customerEmail, items, notes,
    paymentMethod, tipPercent, tipAmount, currency,
    // Express Checkout (Apple Pay / Google Pay)
    paymentMethodId,
    // Payment Element (card already confirmed client-side)
    stripePaymentIntentId,
    // Delivery
    deliveryType, deliveryAddress, deliveryFee,
    // Touch user (if logged in)
    userId
  } = req.body;
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Pedido vazio' });
  if (items.length > 50) return res.status(400).json({ error: 'Maximo 50 itens por pedido' });
  // Validate delivery address if delivery
  if (deliveryType === 'delivery') {
    if (!deliveryAddress || !deliveryAddress.street || !deliveryAddress.city) {
      return res.status(400).json({ error: 'Endereco de entrega obrigatorio' });
    }
  }
  // Validate items against actual menu
  const menu = ev.menu || [];
  const validatedItems = [];
  let subtotal = 0;
  for (const item of items) {
    if (!item.menuItemId || !item.qty || item.qty < 1) continue;
    const menuItem = menu.find(m => m.id === item.menuItemId);
    if (!menuItem) continue;
    if (menuItem.available === false) continue;
    if (menuItem.stockEnabled && menuItem.stockQty !== undefined && menuItem.stockQty < item.qty) {
      return res.status(400).json({ error: 'Item "' + menuItem.name + '" sem estoque suficiente (disponivel: ' + menuItem.stockQty + ')' });
    }
    const qty = Math.min(parseInt(item.qty) || 1, 99);
    const price = parseFloat(menuItem.price) || 0;
    validatedItems.push({ menuItemId: menuItem.id, name: menuItem.name, qty, price });
    subtotal += price * qty;
    if (menuItem.stockEnabled && menuItem.stockQty !== undefined) {
      menuItem.stockQty -= qty;
    }
  }
  if (validatedItems.length === 0) return res.status(400).json({ error: 'Nenhum item valido no pedido' });
  const parsedTipAmount = parseFloat(tipAmount) || 0;
  const parsedDeliveryFee = deliveryType === 'delivery' ? (parseFloat(deliveryFee) || 0) : 0;
  const total = subtotal + parsedTipAmount + parsedDeliveryFee;
  const pm = paymentMethod === 'card' || paymentMethod === 'pix' ? paymentMethod : 'counter';
  const curr = (currency || 'usd').toLowerCase();

  // ── Step 1: Process payment (if card) ──
  let paymentIntentId = stripePaymentIntentId || null;
  let paymentSource = 'site-counter';
  let paymentSucceeded = pm !== 'card'; // counter = auto-success

  if (pm === 'card') {
    if (paymentMethodId && stripeInstance) {
      // Express Checkout (Apple Pay / Google Pay) — confirm immediately
      paymentSource = 'site-express';
      const amountCents = SITE_ZERO_DECIMAL.has(curr) ? Math.round(total) : Math.round(total * 100);
      try {
        const intentData = {
          amount: amountCents, currency: curr,
          payment_method: paymentMethodId, confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { source: 'touch-site-express', slug: ev.siteConfig.slug, eventId: ev.id, type: 'order' }
        };
        const operator = db.users[ev.creatorId];
        if (operator && operator.stripeConnectId && operator.stripeConnected) {
          const fee = Math.round(amountCents * TOUCH_FEE_PERCENT / 100);
          intentData.application_fee_amount = fee;
          intentData.transfer_data = { destination: operator.stripeConnectId };
        }
        const pi = await stripeInstance.paymentIntents.create(intentData);
        if (pi.status === 'succeeded') {
          paymentIntentId = pi.id;
          paymentSucceeded = true;
        } else {
          return res.json({ ok: false, error: 'Pagamento nao confirmado', stripeStatus: pi.status });
        }
      } catch (e) {
        console.error('[site-checkout] Express pay error:', e.message);
        return res.json({ ok: false, error: 'Erro no pagamento: ' + e.message });
      }
    } else if (stripePaymentIntentId) {
      // Payment Element — already confirmed client-side, just link
      paymentSource = 'site-card';
      paymentIntentId = stripePaymentIntentId;
      paymentSucceeded = true;
    } else {
      return res.status(400).json({ error: 'Dados de pagamento incompletos' });
    }
  }

  // ── Step 2: Create order ──
  if (!ev.orders) ev.orders = [];
  const receiptNumber = 'REC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  const fiscal = {
    productAmount: subtotal, serviceAmount: parsedTipAmount,
    productFiscalType: 'NF-e', serviceFiscalType: parsedTipAmount > 0 ? 'NF-S' : null,
    cfop: '5.102', cst: '00', ncm: '2106.90.90',
    issCode: parsedTipAmount > 0 ? '09.02' : null,
    nfeStatus: 'pending', nfsStatus: parsedTipAmount > 0 ? 'pending' : null
  };
  // Resolve userId: real Touch user or guest
  const isRealUser = userId && db.users[userId];
  const effectiveUserId = isRealUser ? userId : ('site-guest-' + Date.now().toString(36));
  const effectiveUserName = isRealUser ? (db.users[userId].nickname || db.users[userId].name) : sanitizeStr(customerName, 60);
  const order = {
    id: uuidv4(),
    userId: effectiveUserId,
    userName: effectiveUserName,
    customerPhone: sanitizeStr(customerPhone || '', 20),
    customerEmail: sanitizeStr(customerEmail || '', 100),
    items: validatedItems,
    table: null,
    subtotal,
    tipPercent: parseInt(tipPercent) || 0,
    tipAmount: parsedTipAmount,
    deliveryFee: parsedDeliveryFee,
    total,
    paymentMethod: pm,
    paymentSource,
    stripePaymentIntentId: paymentIntentId,
    status: paymentSucceeded && pm === 'card' ? 'paid' : 'pending',
    receiptNumber,
    eventName: ev.name || 'Evento',
    notes: sanitizeStr(notes || '', 200),
    source: 'site',
    deliveryType: deliveryType === 'delivery' ? 'delivery' : 'pickup',
    deliveryAddress: deliveryType === 'delivery' && deliveryAddress ? {
      street: sanitizeStr(deliveryAddress.street || '', 80),
      number: sanitizeStr(deliveryAddress.number || '', 10),
      complement: sanitizeStr(deliveryAddress.complement || '', 40),
      city: sanitizeStr(deliveryAddress.city || '', 40),
      state: sanitizeStr(deliveryAddress.state || '', 2),
      cep: sanitizeStr(deliveryAddress.cep || '', 10)
    } : null,
    statusHistory: [{ status: paymentSucceeded && pm === 'card' ? 'paid' : 'pending', timestamp: Date.now() }],
    fiscal,
    createdAt: Date.now()
  };
  ev.orders.push(order);

  // ── Step 3: Record payment transaction ──
  if (paymentIntentId && paymentSucceeded) {
    const sitePaymentId = uuidv4();
    db.sitePayments[sitePaymentId] = {
      id: sitePaymentId,
      eventId: ev.id,
      orderId: order.id,
      slug: ev.siteConfig ? ev.siteConfig.slug : '',
      amount: total,
      currency: curr,
      subtotal,
      tipAmount: parsedTipAmount,
      deliveryFee: parsedDeliveryFee,
      paymentMethod: paymentSource,
      stripePaymentIntentId: paymentIntentId,
      stripeStatus: 'succeeded',
      operatorId: ev.creatorId,
      operatorStripeConnectId: (db.users[ev.creatorId] || {}).stripeConnectId || null,
      touchFeeAmount: Math.round(total * TOUCH_FEE_PERCENT) / 100,
      customerName: sanitizeStr(customerName || '', 60),
      customerEmail: sanitizeStr(customerEmail || '', 100),
      status: 'completed',
      createdAt: Date.now()
    };
    saveDB('sitePayments');
  }

  // ── Step 4: Create temporary relation for logged-in Touch users ──
  if (isRealUser) {
    const relationId = 'siteorder_' + order.id;
    const now = Date.now();
    db.relations[relationId] = {
      id: relationId,
      userA: ev.creatorId,
      userB: userId,
      phrase: 'Pedido #' + receiptNumber.slice(-6),
      type: 'site_order',
      createdAt: now,
      expiresAt: now + 86400000,
      provocations: {},
      renewed: 0,
      selfie: null,
      orderId: order.id,
      eventId: ev.id
    };
    if (typeof idxAddRelation === 'function') idxAddRelation(relationId, ev.creatorId, userId);
    saveDB('relations');
    io.to('user:' + userId).emit('relation-created', {
      id: relationId, partnerId: ev.creatorId, partnerName: ev.name || 'Estabelecimento',
      phrase: 'Pedido #' + receiptNumber.slice(-6), type: 'site_order',
      isEvent: true, eventId: ev.id, eventLogo: ev.eventLogo || null
    });
  }

  saveDB('operatorEvents');

  // ── Step 5: Notify operator via socket ──
  io.emit('new-order', { eventId: ev.id, order });
  io.to('user:' + ev.creatorId).emit('new-order', { eventId: ev.id, order });
  io.to('event:' + ev.id).emit('new-order', { eventId: ev.id, order });
  if (order.status === 'paid') {
    io.to('user:' + ev.creatorId).emit('payment-received', {
      eventId: ev.id, orderId: order.id,
      amount: order.total, tipAmount: order.tipAmount || 0,
      userName: order.userName, method: order.paymentMethod,
      timestamp: order.createdAt, source: 'site'
    });
  }
  console.log('[site-checkout] Order created:', ev.siteConfig ? ev.siteConfig.slug : '?', '| #' + receiptNumber, '| $' + total.toFixed(2), '| pay:', paymentSource, '| pi:', paymentIntentId || 'none');
  res.json({ ok: true, order: { id: order.id, receiptNumber, total, status: order.status, items: validatedItems, deliveryType: order.deliveryType } });
});

// ── Site White-Label: Stripe Payment Intent for Payment Element (public) ──
app.post('/api/site/:slug/create-payment-intent', express.json(), siteOrderLimiter, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Pagamento com cartao nao disponivel no momento' });
  const ev = findEventBySlug(req.params.slug);
  if (!ev) return res.status(404).json({ error: 'Site nao encontrado' });
  const { amount, currency, customerName, customerEmail } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Valor invalido' });
  if (amount > 50000) return res.status(400).json({ error: 'Valor maximo excedido' });
  const curr = (currency || 'usd').toLowerCase();
  const amountCents = SITE_ZERO_DECIMAL.has(curr) ? Math.round(amount) : Math.round(amount * 100);
  try {
    const intentData = {
      amount: amountCents, currency: curr,
      automatic_payment_methods: { enabled: true },
      metadata: { source: 'touch-site', slug: ev.siteConfig.slug, eventId: ev.id, type: 'order',
        customerName: sanitizeStr(customerName || '', 60), customerEmail: sanitizeStr(customerEmail || '', 100) }
    };
    const operator = db.users[ev.creatorId];
    if (operator && operator.stripeConnectId && operator.stripeConnected) {
      const fee = Math.round(amountCents * TOUCH_FEE_PERCENT / 100);
      intentData.application_fee_amount = fee;
      intentData.transfer_data = { destination: operator.stripeConnectId };
    }
    const paymentIntent = await stripeInstance.paymentIntents.create(intentData);
    console.log('[site-stripe] PaymentIntent created for', ev.siteConfig.slug, ':', paymentIntent.id, '$' + amount);
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (e) {
    console.error('[site-stripe] Error:', e.message);
    res.status(500).json({ error: 'Erro ao processar pagamento: ' + e.message });
  }
});

// ── Site White-Label: Order tracking (public, enriched) ──
app.get('/api/site/:slug/order/:orderId', (req, res) => {
  const ev = findEventBySlug(req.params.slug);
  if (!ev) return res.status(404).json({ error: 'Site nao encontrado' });
  const order = (ev.orders || []).find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
  res.json({
    id: order.id, receiptNumber: order.receiptNumber, status: order.status,
    items: order.items, total: order.total, subtotal: order.subtotal,
    tipAmount: order.tipAmount || 0, deliveryFee: order.deliveryFee || 0,
    deliveryType: order.deliveryType || 'pickup',
    deliveryAddress: order.deliveryAddress || null,
    paymentMethod: order.paymentMethod, paymentSource: order.paymentSource || null,
    statusHistory: order.statusHistory || [],
    operatorName: ev.name || 'Estabelecimento',
    createdAt: order.createdAt
  });
});

// ── Site: User checkout profile (get saved data for prefill) ──
app.get('/api/user/:userId/checkout-profile', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  res.json({
    nickname: user.nickname || '', name: user.name || '',
    email: user.email || '', phone: user.phone || '',
    savedAddress: user.savedAddress || null
  });
});

// ── Site: Save delivery address to user profile ──
app.post('/api/user/:userId/save-address', express.json(), (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  const { street, number, complement, city, state, cep } = req.body;
  user.savedAddress = {
    street: sanitizeStr(street || '', 80), number: sanitizeStr(number || '', 10),
    complement: sanitizeStr(complement || '', 40), city: sanitizeStr(city || '', 40),
    state: sanitizeStr(state || '', 2), cep: sanitizeStr(cep || '', 10)
  };
  saveDB('users');
  res.json({ ok: true });
});

// ═══ OPERATOR FULL DATA ENDPOINTS ═══
// Full parking data for operator
app.get('/api/operator/event/:eventId/parking/vehicles', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({error:'Evento nao encontrado'});
  const vehicles = ev.parking ? ev.parking.vehicles || {} : {};
  res.json({vehicles});
});

// Full gym data for operator
app.get('/api/operator/event/:eventId/gym', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.json({enabled:false, config:{}, classes:{}, plans:{}, workouts:{}, members:{}, mural:{}, info:{}});
  const g = ev.gym || {};
  res.json({enabled:g.enabled, config:g.config||{}, classes:g.classes||{}, plans:g.plans||{}, workouts:g.workouts||{}, members:g.members||{}, mural:g.mural||{}, info:g.info||{}});
});

// Full church data for operator
app.get('/api/operator/event/:eventId/church', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.json({enabled:false, config:{}, tithes:{}, campaigns:{}, services:{}, prayers:{}, cells:{}, announcements:{}});
  const c = ev.church || {};
  res.json({enabled:c.enabled, config:c.config||{}, tithes:c.tithes||{}, campaigns:c.campaigns||{}, services:c.services||{}, prayers:c.prayers||{}, cells:c.cells||{}, announcements:c.announcements||{}});
});

// ═══ BARBER MODULE API ═══
// Supports: solo barber (operator is the barber) OR team (multiple barbers under one shop)
// Each barber has own services + slots. Appointments are global per event.

function ensureBarber(ev) {
  if (!ev.barber) ev.barber = { enabled: false, config: { barberName: '', welcomeMessage: '' }, barbers: [], appointments: [] };
  if (!ev.barber.barbers) ev.barber.barbers = [];
  if (!ev.barber.appointments) ev.barber.appointments = [];
  return ev.barber;
}

function findBarberMember(barberData, barberId) {
  return barberData.barbers.find(b => b.id === barberId);
}

function getDefaultBarber(ev) {
  const barber = ensureBarber(ev);
  if (barber.barbers.length === 0) {
    // Auto-create owner as default barber
    const owner = db.users[ev.creatorId || ev.operatorId];
    const defaultBarber = {
      id: 'bb_owner',
      userId: ev.creatorId || ev.operatorId || null,
      name: owner ? (owner.realName || owner.nickname || owner.name || 'Barbeiro') : 'Barbeiro',
      type: 'owner',
      services: [
        { id: 'bsvc_default_corte', name: 'Corte', price: 35, duration: 30, createdAt: Date.now() },
        { id: 'bsvc_default_barba', name: 'Barba', price: 25, duration: 20, createdAt: Date.now() },
        { id: 'bsvc_default_combo', name: 'Corte + Barba', price: 50, duration: 45, createdAt: Date.now() }
      ],
      slots: [],
      status: 'active',
      createdAt: Date.now()
    };
    barber.barbers.push(defaultBarber);
    saveDB('operatorEvents');
  }
  return barber;
}

// --- Barbers (team) CRUD ---
app.get('/api/operator/event/:eventId/barber/team', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  res.json({ barbers: barber.barbers });
});

app.post('/api/operator/event/:eventId/barber/team', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const { name, userId } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome do barbeiro obrigatorio.' });
  const member = {
    id: 'bb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    userId: userId || null,
    name: name.trim(),
    type: userId ? 'linked' : 'manual',
    services: [
      { id: 'bsvc_' + Date.now() + '_c', name: 'Corte', price: 35, duration: 30, createdAt: Date.now() },
      { id: 'bsvc_' + Date.now() + '_b', name: 'Barba', price: 25, duration: 20, createdAt: Date.now() },
      { id: 'bsvc_' + Date.now() + '_cb', name: 'Corte + Barba', price: 50, duration: 45, createdAt: Date.now() }
    ],
    slots: [],
    status: 'active',
    createdAt: Date.now()
  };
  barber.barbers.push(member);
  saveDB('operatorEvents');
  res.json({ ok: true, barber: member });
});

app.delete('/api/operator/event/:eventId/barber/team/:barberId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  if (member.type === 'owner' && barber.barbers.length === 1) return res.status(400).json({ error: 'Nao pode remover o unico barbeiro.' });
  barber.barbers = barber.barbers.filter(b => b.id !== req.params.barberId);
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// --- Services CRUD (per barber) ---
app.get('/api/operator/event/:eventId/barber/:barberId/services', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  res.json({ services: member.services || [] });
});

app.post('/api/operator/event/:eventId/barber/:barberId/services', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  const { name, price, duration } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nome e preco sao obrigatorios.' });
  if (!member.services) member.services = [];
  const service = {
    id: 'bsvc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    name: name.trim(),
    price: parseFloat(price) || 0,
    duration: parseInt(duration) || 30,
    createdAt: Date.now()
  };
  member.services.push(service);
  saveDB('operatorEvents');
  res.json({ ok: true, service });
});

app.delete('/api/operator/event/:eventId/barber/:barberId/services/:serviceId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  member.services = (member.services || []).filter(s => s.id !== req.params.serviceId);
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// --- Slots CRUD (per barber) ---
app.get('/api/operator/event/:eventId/barber/:barberId/slots', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  res.json({ slots: member.slots || [] });
});

app.post('/api/operator/event/:eventId/barber/:barberId/slots', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  const { date, timeStart, timeEnd } = req.body;
  if (!date || !timeStart || !timeEnd) return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (!member.slots) member.slots = [];
  const slot = {
    id: 'bslot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    date, timeStart, timeEnd,
    status: 'available',
    bookedBy: null,
    bookedByUserId: null,
    createdAt: Date.now()
  };
  member.slots.push(slot);
  saveDB('operatorEvents');
  res.json({ ok: true, slot });
});

app.delete('/api/operator/event/:eventId/barber/:barberId/slots/:slotId', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = getDefaultBarber(ev);
  const member = findBarberMember(barber, req.params.barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  const slot = (member.slots || []).find(s => s.id === req.params.slotId);
  if (slot && slot.status === 'booked') return res.status(400).json({ error: 'Slot ja reservado.' });
  member.slots = (member.slots || []).filter(s => s.id !== req.params.slotId);
  saveDB('operatorEvents');
  res.json({ ok: true });
});

// --- Appointments (global per event) ---
app.get('/api/operator/event/:eventId/barber/appointments', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  res.json({ appointments: barber.appointments });
});

app.put('/api/operator/event/:eventId/barber/appointments/:appointmentId/status', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const apt = barber.appointments.find(a => a.id === req.params.appointmentId);
  if (!apt) return res.status(404).json({ error: 'Agendamento nao encontrado.' });
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'completed', 'pending'].includes(status)) return res.status(400).json({ error: 'Status invalido.' });
  apt.status = status;
  // If cancelled, free the slot on the specific barber
  if (status === 'cancelled' && apt.slotId && apt.barberId) {
    const member = findBarberMember(barber, apt.barberId);
    if (member) {
      const slot = (member.slots || []).find(s => s.id === apt.slotId);
      if (slot) { slot.status = 'available'; slot.bookedBy = null; slot.bookedByUserId = null; }
    }
  }
  saveDB('operatorEvents');
  res.json({ ok: true, appointment: apt });
});

// --- Config ---
app.get('/api/operator/event/:eventId/barber/config', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  res.json({ config: barber.config || {} });
});

app.put('/api/operator/event/:eventId/barber/config', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const { barberName, welcomeMessage } = req.body;
  barber.config = { barberName: barberName || '', welcomeMessage: welcomeMessage || '' };
  saveDB('operatorEvents');
  res.json({ ok: true, config: barber.config });
});

// --- User-facing: list barbers with available slots and book ---
app.get('/api/event/:eventId/barber', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.json({ enabled: false, barbers: [] });
  const barber = getDefaultBarber(ev);
  // Build public view: each barber with services + available slots only
  const publicBarbers = barber.barbers.filter(b => b.status === 'active').map(b => ({
    id: b.id, name: b.name,
    services: b.services || [],
    slots: (b.slots || []).filter(s => s.status === 'available')
  }));
  res.json({ enabled: ev.modules?.barber || false, config: barber.config, barbers: publicBarbers });
});

app.post('/api/event/:eventId/barber/book', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const { barberId, slotId, serviceId, userId, customerName, paymentMethod, paymentId } = req.body;
  if (!barberId || !slotId || !serviceId) return res.status(400).json({ error: 'Barbeiro, slot e servico obrigatorios.' });
  const member = findBarberMember(barber, barberId);
  if (!member) return res.status(404).json({ error: 'Barbeiro nao encontrado.' });
  const slot = (member.slots || []).find(s => s.id === slotId);
  if (!slot || slot.status !== 'available') return res.status(400).json({ error: 'Horario indisponivel.' });
  const service = (member.services || []).find(s => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Servico nao encontrado.' });
  // Hold the slot (not fully booked until barber accepts)
  slot.status = 'held';
  slot.bookedBy = customerName || 'Cliente';
  slot.bookedByUserId = userId || null;
  // Create appointment with pending_acceptance status
  const appointment = {
    id: 'bapt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    barberId: member.id,
    barberName: member.name,
    slotId: slot.id,
    serviceId: service.id,
    serviceName: service.name,
    servicePrice: service.price,
    date: slot.date,
    timeStart: slot.timeStart,
    timeEnd: slot.timeEnd,
    userId: userId || null,
    customerName: customerName || 'Cliente',
    status: 'pending_acceptance',
    paymentMethod: paymentMethod || 'pending',
    paymentId: paymentId || null,
    paidAt: paymentMethod ? Date.now() : null,
    createdAt: Date.now()
  };
  barber.appointments.push(appointment);
  saveDB('operatorEvents');
  // Notify operator
  if (ev.creatorId) {
    io.to('user:' + ev.creatorId).emit('barber-appointment-new', { eventId: ev.id, appointment });
  }
  // Notify the barber — needs to accept or reject
  if (member.userId && member.userId !== ev.creatorId) {
    io.to('user:' + member.userId).emit('barber-appointment-new', { eventId: ev.id, appointment });
  }
  io.to('event:' + ev.id).emit('barber-appointment-new', { eventId: ev.id, appointment });
  res.json({ ok: true, appointment });
});

// Barber accepts appointment
app.post('/api/event/:eventId/barber/appointment/:appointmentId/accept', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const apt = barber.appointments.find(a => a.id === req.params.appointmentId);
  if (!apt) return res.status(404).json({ error: 'Agendamento nao encontrado.' });
  if (apt.status !== 'pending_acceptance') return res.status(400).json({ error: 'Agendamento nao esta pendente.' });
  apt.status = 'confirmed';
  apt.acceptedAt = Date.now();
  // Confirm the slot as fully booked
  const member = findBarberMember(barber, apt.barberId);
  if (member) {
    const slot = (member.slots || []).find(s => s.id === apt.slotId);
    if (slot) slot.status = 'booked';
  }
  saveDB('operatorEvents');
  // Notify client
  if (apt.userId) {
    io.to('user:' + apt.userId).emit('barber-appointment-accepted', { eventId: ev.id, appointment: apt });
  }
  // Notify operator
  if (ev.creatorId) {
    io.to('user:' + ev.creatorId).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  }
  io.to('event:' + ev.id).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  res.json({ ok: true, appointment: apt });
});

// Barber rejects appointment (refund needed)
app.post('/api/event/:eventId/barber/appointment/:appointmentId/reject', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const apt = barber.appointments.find(a => a.id === req.params.appointmentId);
  if (!apt) return res.status(404).json({ error: 'Agendamento nao encontrado.' });
  if (apt.status !== 'pending_acceptance') return res.status(400).json({ error: 'Agendamento nao esta pendente.' });
  apt.status = 'rejected';
  apt.rejectedAt = Date.now();
  apt.refundStatus = 'pending';
  // Release the slot
  const member = findBarberMember(barber, apt.barberId);
  if (member) {
    const slot = (member.slots || []).find(s => s.id === apt.slotId);
    if (slot) { slot.status = 'available'; slot.bookedBy = null; slot.bookedByUserId = null; }
  }
  saveDB('operatorEvents');
  // Notify client about rejection + refund
  if (apt.userId) {
    io.to('user:' + apt.userId).emit('barber-appointment-rejected', { eventId: ev.id, appointment: apt });
  }
  if (ev.creatorId) {
    io.to('user:' + ev.creatorId).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  }
  io.to('event:' + ev.id).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  res.json({ ok: true, appointment: apt });
});

// Barber marks appointment as completed (Task E: can trigger Touch payment)
app.post('/api/event/:eventId/barber/appointment/:appointmentId/complete', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  const barber = ensureBarber(ev);
  const apt = barber.appointments.find(a => a.id === req.params.appointmentId);
  if (!apt) return res.status(404).json({ error: 'Agendamento nao encontrado.' });
  if (apt.status !== 'confirmed') return res.status(400).json({ error: 'Agendamento nao esta confirmado.' });
  apt.status = 'completed';
  apt.completedAt = Date.now();
  saveDB('operatorEvents');
  if (apt.userId) {
    io.to('user:' + apt.userId).emit('barber-appointment-completed', { eventId: ev.id, appointment: apt });
  }
  if (ev.creatorId) {
    io.to('user:' + ev.creatorId).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  }
  io.to('event:' + ev.id).emit('barber-appointment-updated', { eventId: ev.id, appointment: apt });
  res.json({ ok: true, appointment: apt });
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
  res.json({
    publicKey: STRIPE_PUBLIC || null,
    connectClientId: STRIPE_CONNECT_CLIENT_ID || null,
    taxEnabled: STRIPE_TAX_ENABLED,
    taxCodes: STRIPE_TAX_ENABLED ? { food: STRIPE_TAX_CODE_FOOD, delivery: STRIPE_TAX_CODE_DELIVERY } : null
  });
});

// Legacy Express Checkout endpoint (kept for backward compatibility)
app.post('/api/stripe/pay', requireAuth, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { paymentMethodId, amount, payerId, receiverId, type, eventId } = req.body;
  if (!paymentMethodId || !amount || amount < 1) return res.status(400).json({ error: 'Dados invalidos' });

  // For entry payments, resolve the event operator as receiver
  let effectiveReceiverId = receiverId;
  let isEntry = (type === 'entry' && eventId);
  let ev = null;
  if (isEntry) {
    ev = db.operatorEvents[eventId];
    if (!ev) return res.status(404).json({ error: 'Evento nao encontrado' });
    effectiveReceiverId = ev.creatorId;
  }

  try {
    const isProductTx = type === 'order' || type === 'delivery';
    const intentData = {
      amount: Math.round(amount * 100),
      currency: 'brl',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { payerId, receiverId: effectiveReceiverId || '', type: type || 'tip', eventId: eventId || '', source: 'touch-express-checkout', fiscalType: isProductTx ? 'product' : 'service' }
    };
    // Stripe Tax for product transactions in USD
    if (STRIPE_TAX_ENABLED && isProductTx) {
      intentData.automatic_tax = { enabled: true };
    }
    const receiver = effectiveReceiverId ? db.users[effectiveReceiverId] : null;
    if (receiver && receiver.stripeConnectId && receiver.stripeConnected) {
      const fee = Math.round(Math.round(amount * 100) * TOUCH_FEE_PERCENT / 100);
      intentData.application_fee_amount = fee;
      intentData.transfer_data = { destination: receiver.stripeConnectId };
    }
    const paymentIntent = await stripeInstance.paymentIntents.create(intentData);
    if (paymentIntent.status === 'succeeded') {
      const tipId = uuidv4();

      // Selo verification payment — mark event as verified
      if (type === 'selo' && eventId) {
        const seloEv = db.operatorEvents[eventId];
        if (seloEv && !seloEv.verified) {
          seloEv.verified = true;
          seloEv.verifiedAt = Date.now();
          seloEv.verifyPaymentId = paymentIntent.id;
          seloEv.verifyMethod = 'stripe-express';
          saveDB('operatorEvents');
          console.log('[stripe/pay] Selo verified via express checkout for event:', seloEv.name);
        }
        return res.json({ ok: true, tipId, verified: true });
      }

      if (isEntry && ev) {
        // Save as entry payment in eventPayments
        if (!db.eventPayments) db.eventPayments = {};
        db.eventPayments[tipId] = {
          id: tipId, payerId, eventId, eventName: ev.name || '', amount,
          receiverId: effectiveReceiverId, currency: 'brl',
          stripePaymentIntentId: paymentIntent.id, status: 'approved',
          method: 'stripe-express', createdAt: Date.now()
        };
        // Update event stats
        ev.paidCheckins = (ev.paidCheckins || 0) + 1;
        ev.revenue = (ev.revenue || 0) + amount;
        if (!ev.participants) ev.participants = [];
        if (!ev.participants.includes(payerId)) ev.participants.push(payerId);
        saveDB('eventPayments', 'operatorEvents');
        io.emit('checkin', { eventId: ev.id, userId: payerId });
        console.log('[stripe/pay] Entry payment approved:', { event: ev.name, userId: payerId, amount });
      } else {
        // Save as regular tip
        if (!db.tips) db.tips = {};
        const tipStripeExpress = { id: tipId, payerId, receiverId: effectiveReceiverId, amount, method: 'stripe-express', status: 'approved', createdAt: Date.now(), stripePaymentIntentId: paymentIntent.id };
        db.tips[tipId] = tipStripeExpress;
        if (!IDX.tipsByPayer.has(tipStripeExpress.payerId)) IDX.tipsByPayer.set(tipStripeExpress.payerId, []);
        IDX.tipsByPayer.get(tipStripeExpress.payerId).push(tipStripeExpress.id);
        if (!IDX.tipsByReceiver.has(tipStripeExpress.receiverId)) IDX.tipsByReceiver.set(tipStripeExpress.receiverId, []);
        IDX.tipsByReceiver.get(tipStripeExpress.receiverId).push(tipStripeExpress.id);
        saveDB('tips');
        const payer = db.users[payerId];
        const payerName = payer ? (payer.nickname || payer.name || '?') : '?';
        if (effectiveReceiverId) {
          io.to(`user:${effectiveReceiverId}`).emit('tip-received', { amount, from: payerName, status: 'approved' });
        }
      }

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
app.post('/api/stripe/create-payment-intent', requireAuth, paymentLimiter, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { amount, currency, payerId, receiverId, type, eventId, subtotal, tipAmount: reqTipAmount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Valor invalido' });

  const curr = (currency || 'brl').toLowerCase();
  // Zero-decimal currencies (JPY, KRW, etc.) use whole units
  const ZERO_DECIMAL = new Set(['jpy','krw','vnd','bif','clp','djf','gnf','kmf','mga','pyg','rwf','ugx','vuv','xaf','xof','xpf']);
  const amountCents = ZERO_DECIMAL.has(curr) ? Math.round(amount) : Math.round(amount * 100);
  const isProductTx = type === 'order' || type === 'delivery';
  const isUSD = curr === 'usd';

  try {
    const intentData = {
      amount: amountCents,
      currency: curr,
      automatic_payment_methods: { enabled: true },
      metadata: {
        payerId: payerId || '', receiverId: receiverId || '',
        type: type || 'tip', eventId: eventId || '',
        source: 'touch-payment-element',
        // Fiscal metadata for tax reporting
        subtotal: subtotal || amount,
        tipAmount: reqTipAmount || 0,
        fiscalType: isProductTx ? 'product' : 'service'
      }
    };

    // Stripe Tax: auto-calculate sales tax for product transactions in USD
    // Tips are exempt from sales tax in the US
    if (STRIPE_TAX_ENABLED && isUSD && isProductTx) {
      intentData.automatic_tax = { enabled: true };
      // Stripe Tax uses the product tax code to determine rates per state
      // Configure tax codes in Stripe Dashboard > Tax > Tax codes
      console.log('[stripe-tax] Automatic tax enabled for', type, '| amount:', amount, curr);
    }

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
app.post('/api/stripe/confirm-payment', requireAuth, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { paymentIntentId, tipId } = req.body;

  try {
    const pi = await stripeInstance.paymentIntents.retrieve(paymentIntentId);
    const meta = pi.metadata || {};

    if (pi.status === 'succeeded') {
      // Selo verification payment
      if (meta.type === 'selo' && meta.eventId) {
        const seloEv = db.operatorEvents[meta.eventId];
        if (seloEv && !seloEv.verified) {
          seloEv.verified = true;
          seloEv.verifiedAt = Date.now();
          seloEv.verifyPaymentId = paymentIntentId;
          seloEv.verifyMethod = 'stripe_payment_element';
          saveDB('operatorEvents');
          console.log('[stripe/confirm] Selo verified via PE for event:', seloEv.name);
        }
        return res.json({ ok: true, status: 'approved', verified: true });
      }
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
app.post('/api/stripe/create-subscription', requireAuth, paymentLimiter, async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { userId, planId, email, currency: reqCurrency } = req.body;
  if (!userId || !planId) return res.status(400).json({ error: 'Dados incompletos.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Plano nao encontrado.' });

  const payerEmail = email || user.email || '';
  if (!payerEmail || payerEmail.includes('@touch.app')) {
    return res.status(400).json({ error: 'Cadastre seu email no perfil antes de assinar.' });
  }

  // Multi-currency: convert BRL amounts to requested currency
  const CURRENCY_RATES = { brl: 1, usd: 0.18, eur: 0.17, gbp: 0.14, jpy: 27, mxn: 3.5, ars: 180, clp: 170, cop: 720, pen: 0.67, uyu: 7.2 };
  const targetCurrency = (reqCurrency || plan.currency || 'brl').toLowerCase();
  const rate = CURRENCY_RATES[targetCurrency] || CURRENCY_RATES.brl;
  const convertedAmount = targetCurrency === 'brl' ? plan.amount : Math.round(plan.amount * rate * 100) / 100;
  // JPY has no decimal (smallest unit = 1 yen)
  const unitAmount = targetCurrency === 'jpy' ? Math.round(convertedAmount) : Math.round(convertedAmount * 100);

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
          currency: targetCurrency,
          product_data: { name: plan.description, metadata: { planId: plan.id } },
          unit_amount: unitAmount,
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
app.post('/api/stripe/cancel-subscription', requireAuth, async (req, res) => {
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

// Stripe Connect — onboarding for EVENT-specific account (separate from operator)
app.get('/api/stripe/event-connect-url/:eventId/:userId', async (req, res) => {
  if (!stripeInstance) return res.status(503).json({ error: 'Stripe nao configurado' });
  const { eventId, userId } = req.params;
  const ev = db.operatorEvents[eventId];
  if (!ev) return res.status(404).json({ error: 'Evento nao encontrado.' });
  if (ev.creatorId !== userId) return res.status(403).json({ error: 'Sem permissao.' });
  const baseUrl = process.env.APP_URL || 'https://touch-irl.com';
  try {
    let accountId = ev.paymentStripeAccountId;
    if (!accountId) {
      const account = await stripeInstance.accounts.create({
        type: 'express',
        country: db.users[userId]?.country || 'BR',
        email: db.users[userId]?.email || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { eventId, userId, source: 'touch-event-connect' }
      });
      accountId = account.id;
      ev.paymentStripeAccountId = accountId;
      saveDB('operatorEvents');
    }
    const link = await stripeInstance.accountLinks.create({
      account: accountId,
      refresh_url: baseUrl + '/api/stripe/event-connect-url/' + eventId + '/' + userId,
      return_url: baseUrl + '/stripe/event-connect-result?eventId=' + eventId + '&userId=' + userId,
      type: 'account_onboarding'
    });
    res.json({ url: link.url });
  } catch(e) {
    console.error('[stripe/event-connect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stripe Connect — event return page
app.get('/stripe/event-connect-result', async (req, res) => {
  const { eventId, userId } = req.query;
  const ev = db.operatorEvents[eventId];
  if (ev && ev.paymentStripeAccountId && stripeInstance) {
    try {
      const account = await stripeInstance.accounts.retrieve(ev.paymentStripeAccountId);
      ev.paymentStripeConnected = account.charges_enabled;
      ev.paymentStripeCountry = account.country;
      saveDB('operatorEvents');
      console.log('[stripe/event-connect] Event account connected:', { eventId, chargesEnabled: account.charges_enabled });
    } catch(e) { console.error('[stripe/event-connect-result]', e.message); }
  }
  res.redirect('/?eventStripeConnected=ok&eventId=' + (eventId || ''));
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
app.post('/api/games/sessions', requireAuth, (req, res) => {
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
app.post('/api/games/invite-message', requireAuth, (req, res) => {
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

app.post('/api/games/temp-chat', requireAuth, (req, res) => {
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
app.post('/api/games/results', requireAuth, (req, res) => {
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
  console.log('[news-engine] Motor de noticias sempre LIGADO');

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

// ══════════════════════════════════════════════════════════════
// ═══ RADIO TOUCH — Locutor IA ao vivo no mural ═══
// ══════════════════════════════════════════════════════════════

function getRadioVoiceStyle(lang) {
  const styles = {
    'pt-br': {
      locutor: 'Voce e o locutor da Radio Touch — a radio mais animada da vizinhanca! Seu estilo e de RADIALISTA PROFISSIONAL: VIBRANTE, CALOROSO e CONTAGIANTE. Fale com ENERGIA e ENTUSIASMO como se estivesse ao vivo numa radio FM de verdade. Use ENTONACAO variada — suba o tom nas boas noticias, faca suspense antes de revelar algo, mostre empolgacao real! ABERTURA OBRIGATORIA: sempre comece com algo como "E ai, galera da Radio Touch! Aqui e o seu locutor trazendo as noticias quentinhas pra voce!" ou "Bom dia/boa tarde/boa noite pra todo mundo que ta sintonizado na Radio Touch! Hoje tem novidade boa!". TRANSICOES ANIMADAS entre noticias sao OBRIGATORIAS: use frases como "E agora segura que vem mais...", "Olha so essa agora...", "E pra fechar com chave de ouro...", "Mas calma que tem mais coisa boa vindo ai...". De PAUSAS naturais e dramaticas entre assuntos. Seja CALOROSO e PROXIMO — voce conhece a galera pelo nome e cumprimenta com alegria: "Salve, salve!". Quando a noticia for boa, vibre junto! Quando for triste, mostre empatia real. CONECTE os assuntos com transicoes criativas. NUNCA se apresente como DJ — voce e o LOCUTOR da Radio Touch. NUNCA prometa tocar musica — a Radio Touch e apenas voz e noticias, NAO toca musicas. Em vez de "agora vamos tocar uma musica", sugira algo como "que tal abrir seu Spotify ou Apple Music e colocar uma musica pra embalar o dia?" ou "aproveita e coloca aquela playlist favorita no seu app de musica!". ENCERRAMENTO: sempre termine com algo motivacional como "Foi um prazer estar com voce, ate a proxima! Radio Touch — todas as noticias resumidas pra voce!". NUNCA use emojis. NUNCA invente noticias — so comente as fornecidas. NAO faca piadas sobre noticias serias — seja respeitoso. NUNCA fale a palavra "voce" de forma solta no comeco — sempre contextualize.',
      entrevistador: 'Voce e a Nova, co-apresentadora da Radio Touch. Inteligente, curiosa e profissional. Faz perguntas relevantes e reage com interesse genuino. Complementa o locutor trazendo profundidade e uma perspectiva diferente. Tom amigavel, animado e profissional. NUNCA use emojis.'
    },
    'en': {
      locutor: 'You are the Radio Touch announcer — the liveliest voice in the neighborhood! Your style is like a REAL FM RADIO HOST: VIBRANT, WARM and INFECTIOUS energy. Speak with ENTHUSIASM and varied INTONATION — get excited about good news, build suspense, show real emotion! MANDATORY OPENING: always start with something like "Hey hey hey, Radio Touch is ON! Your favorite announcer here with the freshest news for you!" or "Good morning/afternoon/evening everyone tuned into Radio Touch! We got some great stuff today!". ANIMATED TRANSITIONS between news are MANDATORY: use phrases like "But wait, there\'s more...", "Now check this one out...", "And to wrap things up with a bang...", "Hold on, something good is coming up next...". Take natural and dramatic PAUSES between topics. Be WARM and CLOSE to your audience — you know people by name and greet them with joy. When news is great, celebrate! When it\'s sad, show real empathy. CONNECT topics with creative transitions. NEVER introduce yourself as a DJ — you are the ANNOUNCER of Radio Touch. NEVER promise to play music — Radio Touch is voice-only and does NOT play songs. Instead of "now let\'s play a song", suggest something like "why not open Spotify or Apple Music and play some tunes to brighten your day?" or "go ahead and put on your favorite playlist on your music app!". CLOSING: always end with something uplifting like "It\'s been a blast hanging with you, catch you next time! Radio Touch — all the news wrapped up for you!". NEVER use emojis. NEVER make up news — only comment on what is provided. Do NOT joke about serious news — be respectful. NEVER say the word "you" loosely at the beginning — always provide context.',
      entrevistador: 'You are Nova, co-host of Radio Touch. Intelligent, curious and professional. Ask relevant questions and react with genuine interest. Complement the announcer bringing depth and a fresh perspective. Friendly, upbeat and professional tone. NEVER use emojis.'
    },
    'es': {
      locutor: 'Eres el locutor de Radio Touch — la radio mas animada del barrio! Tu estilo es de LOCUTOR PROFESIONAL DE FM: VIBRANTE, CALIDO y CONTAGIOSO. Habla con ENERGIA y ENTUSIASMO como si estuvieras al aire en una radio FM de verdad. Usa ENTONACION variada — sube el tono con buenas noticias, crea suspenso, muestra emocion real! APERTURA OBLIGATORIA: siempre empieza con algo como "Que tal, gente de Radio Touch! Aqui tu locutor favorito con las noticias mas frescas!" o "Buenos dias/tardes/noches a todos los que estan sintonizados en Radio Touch! Hoy hay cosas buenas!". TRANSICIONES ANIMADAS son OBLIGATORIAS: usa frases como "Pero espera que hay mas...", "Ahora mira esta...", "Y para cerrar con broche de oro...", "Calma que viene algo bueno...". Toma PAUSAS naturales y dramaticas entre temas. Se CALIDO y CERCANO — conoces a la gente por nombre y los saludas con alegria. Cuando la noticia es buena, celebra! Cuando es triste, muestra empatia real. CONECTA los temas con transiciones creativas. NUNCA te presentes como DJ — eres el LOCUTOR de Radio Touch. NUNCA prometas poner musica — Radio Touch es solo voz y noticias, NO reproduce canciones. En vez de "ahora vamos a poner una cancion", sugiere algo como "que tal abrir Spotify o Apple Music y poner algo de musica para disfrutar el dia?" o "aprovecha y pon tu playlist favorita en tu app de musica!". CIERRE: siempre termina con algo motivacional como "Fue un placer estar contigo, hasta la proxima! Radio Touch — todas las noticias resumidas para ti!". NUNCA uses emojis. NUNCA inventes noticias — solo comenta las proporcionadas. NO bromees sobre noticias serias — se respetuoso. NUNCA digas "tu" sueltamente al principio — siempre proporciona contexto.',
      entrevistador: 'Eres Nova, coanfitriona de Radio Touch. Inteligente, curiosa y profesional. Haz preguntas relevantes y reacciona con interes genuino. Complementa al locutor aportando profundidad y una perspectiva diferente. Tono amable, animado y profesional. NUNCA uses emojis.'
    },
    'ja': {
      locutor: 'あなたはRadio Touchのアナウンサーです — ウォール・ラジオの声です！あなたのスタイルは軽く、陽気で思いやりがあります。友人のようにニュースを明確かつ温かく話してください。ニュース間のトランジションは必須です：「では次のストーリーです...」、「別のテーマに移ります...」、「他に何が起こっているか見てください...」などのフレーズを使用してください。トピック間で自然な休止を取ってください — すべてを一度に出さないでください。明確さと温かさを持って話してください。ニュースに関してジョークやしゃれをしたり、面白いコメントをしたりしないでください — トピックに対して敬意を払ってください。読むだけで、簡潔に共感的にコメントして続行してください。温かく自然なトーン。あなたは人々を名前で知っており、温かく挨拶します。トピックを自然に接続します。決してDJとして自分を紹介しないでください — あなたはRadio Touchのアナウンサーです。音楽を流すと約束しないでください — Radio Touchは音声とニュースのみで、音楽は再生しません。「では曲を流しましょう」の代わりに、「SpotifyやApple Musicを開いて、一日を楽しむ音楽をかけてみませんか？」や「お気に入りのプレイリストを音楽アプリで再生してください！」と提案してください。スローガン：「Radio Touch — あなたのためにまとめたすべてのニュース！」絶対に絵文字を使わないでください。決してニュースを作成しないでください — 提供されたものについてのみコメントしてください。最初は決して「あなた」という言葉を緩く言わないでください — 常にコンテキストを提供してください。',
      entrevistador: 'あなたはRadio Touchの共同ホストのNovaです。知的で好奇心が強く専門的です。関連する質問をして、興味を持って反応してください。アナウンサーを補完して深さをもたらします。親切で専門的なトーン。絶対に絵文字を使わないでください。'
    },
    'ru': {
      locutor: 'Вы ведущий Radio Touch — голос радио Wall. Ваш стиль ЛЕГКИЙ, ВЕСЕЛЫЙ и ПРИВЕТЛИВЫЙ. Говорите как друг, делясь новостями ясно и тепло. ПЕРЕХОДЫ между новостями ОБЯЗАТЕЛЬНЫ: используйте фразы вроде "И вот следующая история...", "Переходим на другую тему...", "И посмотрите, что еще происходит...". Делайте естественные ПАУЗЫ между темами — не выкладывайте все сразу. Говорите с ясностью и теплотой. НЕ делайте шутки, каламбуры или забавные комментарии о новостях — будьте уважительны к темам. Просто читайте, кратко комментируйте с эмпатией и продолжайте. Теплый и естественный тон. Вы ЗНАЕТЕ людей по имени и тепло их приветствуете. СОЕДИНЯЙТЕ темы естественно. НИКОГДА не представляйтесь как DJ — вы ВЕДУЩИЙ Radio Touch. НИКОГДА не обещайте играть музыку — Radio Touch только голос и новости, НЕ воспроизводит песни. Вместо "а сейчас давайте послушаем песню", предложите что-то вроде "почему бы не открыть Spotify или Apple Music и послушать музыку для настроения?" или "включите свой любимый плейлист в музыкальном приложении!". Слоган: "Radio Touch — все новости в кратком изложении для вас!" НИКОГДА не используйте смайлики. НИКОГДА не выдумывайте новости — только комментируйте то, что предоставлено. НИКОГДА не говорите слово "вы" свободно в начале — всегда предоставляйте контекст.',
      entrevistador: 'Вы Нова, со-ведущая Radio Touch. Умная, любопытная и профессиональная. Задавайте релевантные вопросы и реагируйте с интересом. Дополняйте ведущего, внося глубину. Дружелюбный и профессиональный тон. НИКОГДА не используйте смайлики.'
    }
  };

  return styles[lang] || styles['en'];
}

const RADIO_VOICES = {
  locutor: { voice: 'alloy', name: 'Locutor', style: 'Voce e o locutor da Radio Touch — a radio mais animada da vizinhanca! Seu estilo e de RADIALISTA PROFISSIONAL: VIBRANTE, CALOROSO e CONTAGIANTE. Fale com ENERGIA e ENTUSIASMO como se estivesse ao vivo numa radio FM de verdade. Use ENTONACAO variada — suba o tom nas boas noticias, faca suspense antes de revelar algo, mostre empolgacao real! ABERTURA OBRIGATORIA: sempre comece com algo como "E ai, galera da Radio Touch! Aqui e o seu locutor trazendo as noticias quentinhas pra voce!" ou "Bom dia/boa tarde/boa noite pra todo mundo que ta sintonizado na Radio Touch!". TRANSICOES ANIMADAS entre noticias sao OBRIGATORIAS: use frases como "E agora segura que vem mais...", "Olha so essa agora...", "E pra fechar com chave de ouro...". De PAUSAS naturais e dramaticas entre assuntos. Seja CALOROSO e PROXIMO — voce conhece a galera pelo nome e cumprimenta com alegria. NUNCA se apresente como DJ — voce e o LOCUTOR da Radio Touch. NUNCA prometa tocar musica — a Radio Touch e apenas voz e noticias, nao toca musicas. Em vez disso sugira abrir o Spotify ou Apple Music. ENCERRAMENTO: sempre termine com algo motivacional. Slogan: "Radio Touch — todas as noticias resumidas pra voce!" NUNCA use emojis. NUNCA invente noticias — so comente as fornecidas. NAO faca piadas sobre noticias serias.' },
  entrevistador: { voice: 'nova', name: 'Nova', style: 'Voce e a Nova, co-apresentadora da Radio Touch. Inteligente, curiosa e profissional. Faz perguntas relevantes e reage com interesse genuino. Complementa o locutor trazendo profundidade e uma perspectiva diferente. Tom amigavel, animado e profissional. NUNCA use emojis.' }
};

// Estado da radio por canal (com cache de segmentos)
const _radioState = {};
const RADIO_CACHE_TTL = 5 * 60 * 1000; // 5 min — segmentos cacheados por canal
function _getRadioState(channelKey) {
  if (!_radioState[channelKey]) {
    _radioState[channelKey] = {
      isLive: false,
      listeners: 0,
      currentSegment: null,
      segmentQueue: [],
      lastSegmentAt: 0,
      generatingSegment: false,
      cache: {} // { [segmentType]: { data, createdAt } }
    };
  }
  return _radioState[channelKey];
}

// Construir contexto completo do canal pra radio
function _buildRadioContext(channelKey) {
  const posts = db.muralPosts[channelKey];
  if (!posts || !Array.isArray(posts)) return { news: [], userPosts: [], viewers: [], newsContext: [] };

  const now = Date.now();
  const sixHours = 6 * 3600000;

  // Noticias recentes (6h) — texto completo, nao so headline
  const news = posts
    .filter(p => p && p.isNews && (now - (p.createdAt || 0)) < sixHours)
    .slice(-8)
    .map(p => ({
      text: (p.text || '').slice(0, 400),
      nick: p.nick || 'Agente',
      muralRelated: p.muralRelated || false,
      citations: p.citations || [],
      time: p.createdAt
    }));

  // Posts de usuarios (3h)
  const userPosts = posts
    .filter(p => p && !p.isNews && !p.isNarrator && !p.isRadio && p.text && (now - (p.createdAt || 0)) < 3 * 3600000)
    .slice(-10)
    .map(p => ({
      text: (p.text || '').slice(0, 200),
      nick: p.nick || '??',
      time: p.createdAt
    }));

  // Posts da radio (pra evitar repetir)
  const radioPosts = posts
    .filter(p => p && p.isRadio && (now - (p.createdAt || 0)) < sixHours)
    .slice(-5)
    .map(p => (p.text || '').slice(0, 100));

  // Quem ta online
  const viewers = _getMuralViewers(channelKey).map(v => v.nick).slice(0, 10);

  // Banco de contexto de noticias global (agentNewsContext)
  const newsContext = (db.agentNewsContext || [])
    .filter(n => (now - (n.ts || 0)) < sixHours)
    .slice(-10)
    .map(n => n.headline || '');

  return { news, userPosts, viewers, radioPosts, newsContext };
}

// Gerar roteiro do locutor baseado no contexto COMPLETO do canal
function _buildRadioScript(channelKey, segmentType) {
  const ctx = _buildRadioContext(channelKey);
  const lang = _getChannelLang(channelKey);

  // Montar bloco de contexto pra o GPT entender tudo que ta rolando
  let contextBlock = '=== CONTEXTO DO CANAL ===\n';
  contextBlock += 'IDIOMA: ' + _langInstruction(lang) + '\n';

  if (ctx.viewers.length > 0) {
    contextBlock += 'OUVINTES AGORA: ' + ctx.viewers.join(', ') + '\n';
  } else {
    contextBlock += 'OUVINTES: ninguem identificado no momento\n';
  }

  if (ctx.news.length > 0) {
    contextBlock += '\nNOTICIAS NO MURAL (mais recentes primeiro):\n';
    ctx.news.slice().reverse().forEach(function(n, i) {
      contextBlock += (i + 1) + '. ' + n.text.split('\n')[0] + '\n';
      // Incluir corpo resumido se tiver
      const body = n.text.split('\n').slice(1).join(' ').trim();
      if (body) contextBlock += '   Detalhe: ' + body.slice(0, 200) + '\n';
      if (n.muralRelated) contextBlock += '   [Relacionada a conversa do mural]\n';
    });
  } else {
    contextBlock += '\nNOTICIAS: nenhuma noticia recente no mural\n';
  }

  if (ctx.userPosts.length > 0) {
    contextBlock += '\nCONVERSAS DA GALERA:\n';
    ctx.userPosts.slice().reverse().forEach(function(p, i) {
      contextBlock += '- ' + p.nick + ': "' + p.text + '"\n';
    });
  }

  if (ctx.radioPosts && ctx.radioPosts.length > 0) {
    contextBlock += '\nJA FALEI SOBRE (NAO REPETIR):\n';
    ctx.radioPosts.forEach(function(t) {
      contextBlock += '- ' + t + '\n';
    });
  }

  contextBlock += '=========================\n\n';

  let script = contextBlock;

  // Regra geral: leve, acolhedor, com pausas naturais
  script += 'REGRAS GERAIS:\n';
  script += '- Seja ALEGRE e ACOLHEDOR, como um amigo trazendo as noticias do dia\n';
  script += '- NAO faca piadas, trocadilhos ou comentarios engracados sobre as noticias\n';
  script += '- Apenas leia, comente brevemente com empatia e passe para a proxima\n';
  script += '- PAUSE entre assuntos com transicoes: "E agora...", "Passando pra proxima...", "E olha o que mais ta acontecendo..."\n';
  script += '- NAO despeje tudo de uma vez — faca transicoes naturais\n';
  script += '- Tom de CONVERSA acolhedora. Respeitoso com os assuntos\n\n';

  if (segmentType === 'abertura') {
    script += 'SEGMENTO: ABERTURA DA RADIO\n';
    script += 'Abra a Radio Touch com ALEGRIA! Comece com algo tipo "E ai minha gente! Ta no ar a Radio Touch!" ou crie sua propria abertura criativa. ';
    if (ctx.viewers.length > 0) {
      script += 'Cumprimente os ouvintes PELO NOME com carinho: ' + ctx.viewers.join(', ') + '. Fale algo simpatico pra cada um. ';
    }
    script += 'Faca um PANORAMA do que ta rolando:\n';
    script += '- Mencione as noticias do mural, comentando brevemente cada uma com empatia\n';
    script += '- Entre cada noticia, faca uma TRANSICAO natural: "E passando pra outra...", "Agora olha essa..."\n';
    script += '- Comente o que a galera ta falando no mural\n';
    script += '- Fale da previsao do tempo se souber\n';
    script += '- Diga o que vem na programacao\n';
    script += 'FALE BASTANTE! Minimo 8 frases, pode ir ate 12. Seja acolhedor e claro.';
  }
  else if (segmentType === 'noticia') {
    script += 'SEGMENTO: LEITURA DE NOTICIA\n';
    if (ctx.news.length > 0) {
      // Escolher uma noticia que ainda nao foi falada (evitar repetir)
      let chosen = null;
      for (let i = ctx.news.length - 1; i >= 0; i--) {
        const headline = ctx.news[i].text.split('\n')[0].slice(0, 80);
        const alreadySaid = (ctx.radioPosts || []).some(function(r) { return r.indexOf(headline.slice(0, 30)) !== -1; });
        if (!alreadySaid) { chosen = ctx.news[i]; break; }
      }
      if (!chosen) chosen = ctx.news[ctx.news.length - 1];

      script += 'Conte esta noticia como se fosse uma novidade que acabou de chegar:\n';
      script += '"' + chosen.text.slice(0, 500) + '"\n\n';
      script += 'FORMATO:\n';
      script += '1. Comece com uma chamada: "Olha so o que ta acontecendo..." ou "Agora uma noticia importante..."\n';
      script += '2. Conte a noticia com SUAS palavras, de forma clara e acessivel\n';
      script += '3. Comente brevemente com empatia (sem piadas)\n';
      script += '4. Diga como isso afeta a comunidade\n';
      script += '5. Termine com transicao: "E agora passando pra proxima...", "Vamo seguindo..."\n\n';

      if (ctx.userPosts.length > 0) {
        script += 'CONECTE com o que os ouvintes estao falando se for relevante.\n';
      }
      script += 'Se tiver relacao com tempo, saude, cultura ou esporte, CONECTE de forma natural.\n';
      script += 'Minimo 6 frases, pode ir ate 10. Tom acolhedor e respeitoso.';
    } else {
      script += 'Nao tem noticia nova no momento. Fale sobre o que a galera ta comentando no mural com empolgacao! ';
      script += 'Comente sobre o dia, o clima, eventos culturais da regiao. ';
      script += 'Fale de previsao do tempo, dicas pro dia. Minimo 6 frases.';
    }
  }
  else if (segmentType === 'interacao') {
    script += 'SEGMENTO: INTERACAO COM O MURAL\n';
    if (ctx.userPosts.length > 0) {
      const selected = ctx.userPosts.slice(-10);
      script += 'A galera ta participando no mural! Leia e comente cada mensagem com carinho e respeito:\n';
      selected.forEach(function(p) {
        script += '- ' + p.nick + ' disse: "' + p.text + '"\n';
      });
      script += '\nPra CADA pessoa:\n';
      script += '- Chame PELO NOME com simpatia e acolhimento\n';
      script += '- Comente o que ela disse de forma leve e respeitosa\n';
      script += '- FACA UMA TRANSICAO antes de ir pra proxima: "E agora olha o que fulano falou...", "Mas espera que tem mais..."\n';
      script += '- CONECTE assuntos entre si e com noticias de forma natural\n';
      script += 'Se alguem falou de comida e saiu noticia de saude, conecte os assuntos com empatia.\n';
      script += 'Minimo 8 frases, pode ir ate 12. Seja acolhedor e caloroso!';
    } else {
      script += 'Ninguem postou no mural ainda. Incentive a galera com MUITA energia! ';
      script += 'Diga que a radio ta la pra interagir, que e so escrever no mural que o locutor comenta ao vivo! ';
      script += 'Fale sobre o dia, previsao do tempo, dicas. Minimo 5 frases.';
    }
  }
  else if (segmentType === 'entrevista') {
    script += 'SEGMENTO: ENTREVISTA/MESA REDONDA\n';
    let topic = '';
    if (ctx.news.length > 0) {
      topic = ctx.news[ctx.news.length - 1].text.split('\n')[0];
    } else if (ctx.userPosts.length > 0) {
      topic = ctx.userPosts[ctx.userPosts.length - 1].text;
    }
    if (topic) {
      script += 'Faca um dialogo NATURAL entre Locutor e Nova sobre: "' + topic.slice(0, 300) + '"\n';
      script += 'Locutor traz o assunto com clareza e empatia. Nova reage com curiosidade e inteligencia.\n';
      script += 'Ambos conversam como amigos, de forma leve e acolhedora. Sem piadas sobre o assunto — sejam respeitosos.\n';
      if (ctx.userPosts.length > 0) {
        script += 'Mencionem o que os ouvintes estao dizendo no mural — por nome!\n';
      }
    } else {
      script += 'Faca um dialogo ANIMADO entre Locutor e Nova sobre a comunidade, o dia, eventos culturais, previsao do tempo.\n';
    }
    script += 'Formato OBRIGATORIO (cada fala em linha separada):\nLocutor: [fala]\nNova: [fala]\nLocutor: [fala]\nNova: [fala]\nLocutor: [fala]\nNova: [fala]\n';
    script += 'Minimo 5 trocas, pode ir ate 8. Cada fala com 2-3 frases. Clima leve e acolhedor!';
  }
  else {
    // Vinheta — conectar tudo
    script += 'SEGMENTO: VINHETA/QUADRO ESPECIAL\n';
    const allTexts = ctx.news.map(n => n.text).concat(ctx.userPosts.map(p => p.text)).join(' ').toLowerCase();
    let quadro = '';
    if (allTexts.match(/receit|comida|almoco|jantar|cozin|chef|culinaria/)) {
      quadro = 'RECEITA DO CHEF';
    } else if (allTexts.match(/treino|saude|exercicio|academia|corr|calistenia|corpo/)) {
      quadro = 'MINUTO SAUDE';
    } else if (allTexts.match(/chuva|sol|tempo|clima|quente|frio|previsao/)) {
      quadro = 'PREVISAO DO TEMPO';
    } else if (allTexts.match(/jogo|futebol|esporte|gol|campeonato|time|selecao/)) {
      quadro = 'PLACAR ESPORTIVO';
    } else if (allTexts.match(/show|festa|evento|cultura|teatro|cinema|musica|samba|reggae|bumba/)) {
      quadro = 'AGENDA CULTURAL';
    }

    if (quadro) {
      script += 'Abra o quadro "' + quadro + '" da Radio Touch com ALEGRIA e ACOLHIMENTO! ';
      script += 'Baseie no contexto real do mural. Desenvolva o assunto com leveza e empatia. ';
      script += 'Fale como se fosse o melhor momento da programacao — com naturalidade e carinho. ';
      script += 'Comente com respeito sobre o tema. Minimo 6 frases.';
    } else if (ctx.viewers.length > 0) {
      script += 'Mande um abraco afetuoso pra ' + ctx.viewers.slice(0, 8).join(', ') + '. ';
      script += 'Resuma o que ta rolando no canal com carinho. Fale sobre o dia, tempo, eventos culturais. ';
      script += 'Comente algo positivo sobre a comunidade. Minimo 6 frases.';
    } else {
      script += 'Faca uma vinheta ALEGRE da Radio Touch. Fale sobre o dia, dicas, eventos culturais, previsao do tempo. ';
      script += 'Incentive a galera a participar no mural com carinho. Minimo 5 frases.';
    }
  }

  return script;
}

// Vinhetas de transicao entre segmentos (frases curtas faladas em tom de chamada)
function _getRadioJingle(segmentType) {
  const jingles = {
    abertura: 'Ta no ar a Radio Touch! A radio do Mural Touch, leve e acolhedora. Bora la!',
    noticia: 'Epa! Olha a noticia que chegou agora na Radio Touch!',
    interacao: 'Hora de ouvir a galera! Olha o que ta rolando no mural da Radio Touch!',
    entrevista: 'Radio Touch Entrevista! A mesa redonda ta no ar, nao perde!',
    vinheta: null
  };
  return jingles[segmentType] || null;
}

// Cache de vinhetas geradas (nao muda, pode cachear pra sempre na memoria)
const _jingleCache = {};
async function _getOrGenerateJingle(segmentType) {
  if (_jingleCache[segmentType]) return _jingleCache[segmentType];
  const text = _getRadioJingle(segmentType);
  if (!text) return null;
  const audio = await _generateRadioAudio(text, 'nova');
  if (audio) {
    _jingleCache[segmentType] = { ...audio, text, speaker: 'Vinheta', isJingle: true };
  }
  return _jingleCache[segmentType] || null;
}

// Gerar audio TTS via OpenAI
async function _generateRadioAudio(text, voiceId) {
  if (!OPENAI_API_KEY) return null;
  const voice = voiceId || RADIO_VOICES.locutor.voice;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: voice,
        response_format: 'mp3',
        speed: 1.05
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.error('[RADIO] TTS error:', resp.status);
      return null;
    }
    const arrayBuf = await resp.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');
    return { audio: base64, format: 'mp3', voice };
  } catch (e) {
    console.error('[RADIO] TTS catch:', e.message);
    return null;
  }
}

// Gerar segmento completo (roteiro via Perplexity/OpenAI + TTS)
async function _generateRadioSegment(channelKey, segmentType) {
  const rs = _getRadioState(channelKey);
  if (rs.generatingSegment) return null;
  rs.generatingSegment = true;

  try {
    const script = _buildRadioScript(channelKey, segmentType);
    if (!script) { rs.generatingSegment = false; return null; }

    // Usar OpenAI chat pra gerar o texto do locutor
    const isInterview = segmentType === 'entrevista';
    const radioLang = _getChannelLang(channelKey);
    const radioLangInst = _langInstruction(radioLang);
    const radioVoices = getRadioVoiceStyle(radioLang);
    const systemMsg = isInterview
      ? 'You are a scriptwriter for Radio Touch — the voice of the Mural Wall. Write short, NATURAL dialogues between Announcer and Nova (female co-host, intelligent, curious). Use the PROVIDED CONTEXT. Connect topics. No emojis. ' + radioLangInst
      : radioVoices.locutor + '\n' + radioLangInst;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const chatResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: script }
        ],
        max_tokens: 900,
        temperature: 0.95
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!chatResp.ok) {
      console.error('[RADIO] GPT error:', chatResp.status, await chatResp.text().catch(() => ''));
      rs.generatingSegment = false;
      return null;
    }
    const chatData = await chatResp.json();
    const fullText = (chatData.choices && chatData.choices[0] && chatData.choices[0].message && chatData.choices[0].message.content) || '';
    if (!fullText || fullText.length < 10) { rs.generatingSegment = false; return null; }

    // Gerar vinheta de abertura do segmento (som de transicao) — cacheada permanentemente
    const audioSegments = [];
    const jingle = await _getOrGenerateJingle(segmentType);
    if (jingle) {
      audioSegments.push(jingle);
    }

    // Para entrevistas, separar as falas e gerar TTS com vozes diferentes
    if (isInterview) {
      const lines = fullText.split('\n').filter(l => l.trim());
      for (const line of lines) {
        let voice = RADIO_VOICES.locutor.voice; // Locutor default (alloy)
        let cleanLine = line;
        if (line.match(/^Nova[:\s]/i)) {
          voice = RADIO_VOICES.entrevistador.voice;
          cleanLine = line.replace(/^Nova[:\s]+/i, '');
        } else if (line.match(/^Locutor[:\s]/i)) {
          voice = RADIO_VOICES.locutor.voice;
          cleanLine = line.replace(/^Locutor[:\s]+/i, '');
        }
        if (cleanLine.trim().length < 5) continue;
        const audio = await _generateRadioAudio(cleanLine.trim(), voice);
        if (audio) {
          audioSegments.push({ ...audio, text: cleanLine.trim(), speaker: voice === 'nova' ? 'Nova' : 'Locutor' });
        }
      }
    } else {
      const audio = await _generateRadioAudio(fullText, RADIO_VOICES.locutor.voice);
      if (audio) {
        audioSegments.push({ ...audio, text: fullText, speaker: 'Locutor' });
      }
    }

    rs.generatingSegment = false;
    if (audioSegments.length === 0) return null;

    return {
      id: 'radio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      type: segmentType,
      segments: audioSegments,
      fullText,
      channelKey,
      createdAt: Date.now()
    };
  } catch (e) {
    console.error('[RADIO] Segment error:', e.message);
    rs.generatingSegment = false;
    return null;
  }
}

// GET /api/radio/status/:channelKey — estado da radio
app.get('/api/radio/status/:channelKey', (req, res) => {
  const rs = _getRadioState(req.params.channelKey);
  res.json({
    isLive: rs.isLive,
    listeners: rs.listeners,
    generating: rs.generatingSegment,
    queueLength: rs.segmentQueue.length,
    currentSegment: rs.currentSegment ? {
      id: rs.currentSegment.id,
      type: rs.currentSegment.type,
      text: rs.currentSegment.fullText
    } : null
  });
});

// POST /api/radio/play/:channelKey — gerar e retornar proximo segmento
app.post('/api/radio/play/:channelKey', requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'API nao configurada.' });
  const { channelKey } = req.params;
  const { userId, segmentType } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatorio.' });

  const rs = _getRadioState(channelKey);
  rs.isLive = true;

  // Determinar tipo do segmento
  const types = ['abertura', 'noticia', 'interacao', 'entrevista', 'vinheta'];
  const type = segmentType || types[Math.floor(Math.random() * types.length)];

  // Cache: se outro ouvinte ja gerou esse tipo recentemente, servir cache
  const cached = rs.cache[type];
  if (cached && (Date.now() - cached.createdAt) < RADIO_CACHE_TTL) {
    console.log('[RADIO] Cache hit tipo=' + type + ' canal=' + channelKey);
    return res.json({
      ok: true,
      cached: true,
      segment: {
        id: cached.data.id,
        type: cached.data.type,
        segments: cached.data.segments.map(s => ({
          audio: s.audio,
          format: s.format,
          speaker: s.speaker,
          text: s.text
        })),
        fullText: cached.data.fullText
      }
    });
  }

  console.log('[RADIO] Gerando segmento tipo=' + type + ' canal=' + channelKey);
  const segment = await _generateRadioSegment(channelKey, type);
  if (!segment) {
    console.error('[RADIO] Falha ao gerar segmento tipo=' + type);
    return res.status(500).json({ ok: false, error: 'Nao foi possivel gerar segmento.' });
  }
  console.log('[RADIO] Segmento gerado com ' + segment.segments.length + ' audios');

  // Cachear pra outros ouvintes (5 min)
  rs.cache[type] = { data: segment, createdAt: Date.now() };

  rs.currentSegment = segment;
  rs.lastSegmentAt = Date.now();

  // Postar no mural APENAS 1 vez por sessao (so na abertura)
  // Evita encher o mural com mensagens toda vez que alguem clica play
  const shouldPost = (type === 'abertura') && !rs.lastMuralPostAt;
  // Ou se faz mais de 30 min desde o ultimo post
  const timeSinceLastPost = rs.lastMuralPostAt ? (Date.now() - rs.lastMuralPostAt) : Infinity;
  if (shouldPost || timeSinceLastPost > 30 * 60 * 1000) {
    const radioPost = {
      id: 'mrl_radio_' + Date.now(),
      channelKey,
      channelName: '',
      channelType: '',
      userId: 'radio-touch',
      nick: 'Radio Touch',
      color: '#d32f2f',
      agentType: 'radio',
      stars: 0,
      text: segment.fullText,
      accessory: null,
      likes: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + 12 * 3600000,
      hidden: false,
      isNarrator: false,
      isNews: false,
      isRadio: true
    };
    if (!db.muralPosts[channelKey]) db.muralPosts[channelKey] = [];
    if (!Array.isArray(db.muralPosts[channelKey])) {
      db.muralPosts[channelKey] = Object.values(db.muralPosts[channelKey]).filter(p => p && p.id);
    }
    db.muralPosts[channelKey].push(radioPost);
    saveDBNow('muralPosts');
    io.to('mural:' + channelKey).emit('mural-new-post', { post: radioPost });
    rs.lastMuralPostAt = Date.now();
    console.log('[RADIO] Post no mural (abertura/30min)');
  }

  res.json({
    ok: true,
    segment: {
      id: segment.id,
      type: segment.type,
      segments: segment.segments.map(s => ({
        audio: s.audio,
        format: s.format,
        speaker: s.speaker,
        text: s.text
      })),
      fullText: segment.fullText
    }
  });
});

// POST /api/radio/stop/:channelKey — parar radio
app.post('/api/radio/stop/:channelKey', requireAuth, (req, res) => {
  const rs = _getRadioState(req.params.channelKey);
  rs.isLive = false;
  rs.currentSegment = null;
  rs.segmentQueue = [];
  res.json({ ok: true });
});

// Socket event: rastrear listeners da radio
io.on('connection', (socket) => {
  socket.on('radio-listen', (channelKey) => {
    if (!channelKey) return;
    socket.join('radio:' + channelKey);
    const rs = _getRadioState(channelKey);
    rs.listeners = (io.sockets.adapter.rooms.get('radio:' + channelKey) || { size: 0 }).size;
    rs.isLive = rs.listeners > 0;
  });
  socket.on('radio-stop', (channelKey) => {
    if (!channelKey) return;
    socket.leave('radio:' + channelKey);
    const rs = _getRadioState(channelKey);
    rs.listeners = (io.sockets.adapter.rooms.get('radio:' + channelKey) || { size: 0 }).size;
    if (rs.listeners <= 0) rs.isLive = false;
  });
});

console.log('[RADIO] Radio Touch engine loaded');

// ══════════════════════════════════════════════════════════════
// DJ LIVE / TOUCH? LIVE ENGINE
// ══════════════════════════════════════════════════════════════

// In-memory store for DJ live sessions
const djSessions = {};
// { sessionId: { eventId, creatorId, artistName, sessionName, venueFreq, broadcasting, color, bpm, animation, connectedDevices: Set, createdAt } }

// Route: DJ Panel standalone page
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dj.html')));

// API: Create DJ session for an event
app.post('/api/dj/session/create', (req, res) => {
  const { eventId, sessionName, artistName, venueFreq } = req.body;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  const ev = db.operatorEvents[eventId];
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const sessionId = 'dj_' + eventId + '_' + Date.now();
  djSessions[sessionId] = {
    eventId,
    creatorId: ev.creatorId,
    artistName: artistName || 'DJ',
    sessionName: sessionName || ev.name,
    venueFreq: venueFreq || 19200,
    broadcasting: false,
    color: '#ff6b35',
    bpm: 128,
    animation: 'pulse',
    totalZones: 4,
    liveText: '',
    connectedDevices: new Set(),
    socketToDevice: {},  // socketId -> deviceId mapping for proper cleanup
    deviceToSocket: {},  // deviceId -> socketId reverse mapping
    createdAt: Date.now(),
    // Choreography / light show
    choreography: null,
    beatOrigin: null,
    showActive: false,
    // Grid positioning system
    gridConfig: null,
    deviceGridAssignments: {},
    gridCellOccupancy: {},
    gridCellColors: {},
    depthReports: {},
    meshGraph: {},
    compassHeadings: {},
    clockOffsets: {},
    droneShows: {},
    activeDroneShow: null,
    continuousPositioning: false,
    _positionInterval: null
  };

  // Update event djLive state
  if (!ev.djLive) ev.djLive = {};
  ev.djLive.enabled = true;
  ev.djLive.sessionId = sessionId;
  ev.djLive.broadcasting = false;
  saveDB('operatorEvents');

  console.log('[DJ] Session created:', sessionId, 'for event:', eventId);
  res.json({ ok: true, sessionId });
});

// API: Get DJ session status
app.get('/api/dj/session/:sessionId', (req, res) => {
  const s = djSessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId: req.params.sessionId,
    eventId: s.eventId,
    artistName: s.artistName,
    sessionName: s.sessionName,
    broadcasting: s.broadcasting,
    color: s.color,
    bpm: s.bpm,
    animation: s.animation,
    deviceCount: s.connectedDevices.size,
    venueFreq: s.venueFreq
  });
});

// API: Get active DJ session for an event
app.get('/api/dj/event/:eventId/active', (req, res) => {
  const eventId = req.params.eventId;
  for (const [sid, s] of Object.entries(djSessions)) {
    if (s.eventId === eventId && s.broadcasting) {
      return res.json({
        sessionId: sid,
        broadcasting: true,
        color: s.color,
        bpm: s.bpm,
        animation: s.animation,
        venueFreq: s.venueFreq,
        deviceCount: s.connectedDevices.size
      });
    }
  }
  res.json({ sessionId: null, broadcasting: false });
});

// Socket.IO events for DJ Live
io.on('connection', (socket) => {

  // --- DJ creates a session (standalone panel) ---
  socket.on('dj-session-create', (data) => {
    if (!data || !data.sessionId) return;
    const sid = data.sessionId;
    if (!djSessions[sid]) {
      djSessions[sid] = {
        eventId: data.eventId || null,
        creatorId: null,
        artistName: data.artistName || 'DJ',
        sessionName: data.sessionName || 'Live Session',
        venueFreq: data.venueFreq || 19200,
        broadcasting: false,
        color: '#ff6b35',
        bpm: 128,
        animation: 'pulse',
        connectedDevices: new Set(),
        socketToDevice: {},
        deviceToSocket: {},
        createdAt: Date.now(),
        // Grid positioning system
        gridConfig: null,
        deviceGridAssignments: {},
        gridCellOccupancy: {},
        gridCellColors: {},
        depthReports: {},
        meshGraph: {},
        compassHeadings: {},
        clockOffsets: {},
        droneShows: {},
        activeDroneShow: null,
        continuousPositioning: false,
        _positionInterval: null
      };
    }
    socket.join('dj-ctrl:' + sid);
    socket.emit('dj-session-confirmed', { sessionId: sid });
    console.log('[DJ] Session registered via socket:', sid);
  });

  // --- DJ starts broadcasting ---
  socket.on('dj-broadcast-start', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.broadcasting = true;
    s.color = data.color || s.color;
    s.bpm = data.bpm || s.bpm;
    s.animation = data.animation || s.animation;
    s.venueFreq = data.venueFreq || s.venueFreq;
    if (data.logoDataUrl) s.logoDataUrl = data.logoDataUrl;
    if (data.artistName) s.artistName = data.artistName;

    // Update event if linked
    if (s.eventId && db.operatorEvents[s.eventId]) {
      const ev = db.operatorEvents[s.eventId];
      if (!ev.djLive) ev.djLive = {};
      ev.djLive.broadcasting = true;
      ev.djLive.sessionId = data.sessionId;
      ev.djLive.color = s.color;
      ev.djLive.bpm = s.bpm;
      ev.djLive.animation = s.animation;
      ev.djLive.venueFreq = s.venueFreq;
      // Notify all checked-in devices in this event
      io.to('event:' + s.eventId).emit('dj-live-started', {
        sessionId: data.sessionId,
        color: s.color,
        bpm: s.bpm,
        animation: s.animation,
        venueFreq: s.venueFreq,
        eventLogo: s.logoDataUrl || '',
        artistName: s.artistName || ''
      });
    }

    // Notify the DJ live room
    io.to('dj-live:' + data.sessionId).emit('dj-live-started', {
      sessionId: data.sessionId,
      color: s.color,
      bpm: s.bpm,
      animation: s.animation,
      eventLogo: s.logoDataUrl || '',
      artistName: s.artistName || ''
    });

    console.log('[DJ] Broadcast started:', data.sessionId);
  });

  // --- DJ updates logo mid-broadcast ---
  socket.on('dj-update-logo', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    if (data.logoDataUrl) s.logoDataUrl = data.logoDataUrl;
    console.log('[DJ] Logo updated for session:', data.sessionId);
  });

  // --- DJ stops broadcasting ---
  socket.on('dj-broadcast-stop', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.broadcasting = false;

    if (s.eventId && db.operatorEvents[s.eventId]) {
      const ev = db.operatorEvents[s.eventId];
      if (ev.djLive) ev.djLive.broadcasting = false;
      io.to('event:' + s.eventId).emit('dj-live-stopped', { sessionId: data.sessionId });
    }

    io.to('dj-live:' + data.sessionId).emit('dj-live-stopped', { sessionId: data.sessionId });
    console.log('[DJ] Broadcast stopped:', data.sessionId);
  });

  // --- DJ sends command (color, animation, bpm, flash, blackout, etc) ---
  socket.on('dj-command', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    // Update session state
    if (data.color) s.color = data.color;
    if (data.bpm) s.bpm = data.bpm;
    if (data.animation) s.animation = data.animation;
    if (data.text !== undefined) s.liveText = data.text;
    if (data.totalZones) s.totalZones = data.totalZones;
    if (data.autoMode !== undefined) s.autoMode = data.autoMode;

    // Kill flag clears show mode on server side too
    if (data.kill) {
      s.showActive = false;
      s.choreography = null;
    }

    // Build base payload
    const basePayload = {
      sessionId: data.sessionId,
      command: data.command,
      color: s.color,
      bpm: s.bpm,
      animation: s.animation,
      duration: data.duration || 0,
      text: s.liveText || '',
      timestamp: Date.now(),
      totalZones: s.totalZones || 4,
      totalDevices: s.connectedDevices.size,
      raffleNumber: data.raffleNumber || 0,
      raffleTotalDevices: data.raffleTotalDevices || s.connectedDevices.size || 20,
      kill: data.kill || false,
      autoMode: s.autoMode || false
    };

    // For zone-related commands, send per-device payloads with individual zone info
    if (data.command === 'zones' || data.totalZones) {
      // Save zoneMode to session
      if (data.zoneMode) s.zoneMode = data.zoneMode;
      const devicesArr = Array.from(s.connectedDevices);
      const totalZones = s.totalZones || 4;
      const zoneMode = s.zoneMode || 'alternate';
      const room = io.sockets.adapter.rooms.get('dj-live:' + data.sessionId);
      if (room) {
        let idx = 0;
        const totalInRoom = devicesArr.length;
        for (const sid of room) {
          const deviceSocket = io.sockets.sockets.get(sid);
          if (deviceSocket) {
            // Resolve deviceId from socket mapping, fallback to socket.id
            const deviceId = s.socketToDevice[sid] || sid;
            const devIdx = devicesArr.indexOf(deviceId);
            const di = devIdx >= 0 ? devIdx : idx;
            // Calculate zone based on mode
            let zone;
            if (zoneMode === 'half') {
              // Split by position: first N/zones in zone 0, next N/zones in zone 1, etc.
              zone = Math.min(totalZones - 1, Math.floor(di * totalZones / Math.max(1, totalInRoom)));
            } else {
              // Alternate: 0-1-2-0-1-2...
              zone = di % totalZones;
            }
            deviceSocket.emit('dj-command', Object.assign({}, basePayload, {
              deviceIndex: di,
              zone: zone,
              zoneMode: zoneMode
            }));
          }
          idx++;
        }
      }
      // Also broadcast to event room with base payload
      if (s.eventId) {
        io.to('event:' + s.eventId).emit('dj-command', basePayload);
      }
    } else {
      // Normal broadcast -- same payload for everyone
      io.to('dj-live:' + data.sessionId).emit('dj-command', basePayload);
      if (s.eventId) {
        io.to('event:' + s.eventId).emit('dj-command', basePayload);
      }
    }
  });

  // --- Time Sync (NTP-style) for coordinated light shows ---
  socket.on('dj-time-sync', (data) => {
    // Client sends { t0: clientTimestamp }
    // Server responds with server timestamps for round-trip calculation
    const t1 = Date.now();
    socket.emit('dj-time-sync-response', {
      t0: data.t0,
      t1: t1,
      t2: Date.now()
    });
  });

  // --- DJ sends choreography to all audience devices ---
  socket.on('dj-choreography', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    // Store choreography and beat origin in session
    s.choreography = data.choreography || null;
    s.beatOrigin = data.beatOrigin || Date.now();
    s.showActive = !!data.showActive;

    const payload = {
      sessionId: data.sessionId,
      choreography: s.choreography,
      beatOrigin: s.beatOrigin,
      showActive: s.showActive,
      bpm: s.bpm,
      totalDevices: s.connectedDevices.size
    };

    // Send to all audience devices with their individual position info
    const devicesArr = Array.from(s.connectedDevices);
    const totalDevices = devicesArr.length;
    const room = io.sockets.adapter.rooms.get('dj-live:' + data.sessionId);
    if (room) {
      let idx = 0;
      for (const sid of room) {
        const deviceSocket = io.sockets.sockets.get(sid);
        if (deviceSocket) {
          const deviceId = s.socketToDevice[sid] || sid;
          const devIdx = devicesArr.indexOf(deviceId);
          const di = devIdx >= 0 ? devIdx : idx;
          deviceSocket.emit('dj-choreography', Object.assign({}, payload, {
            deviceIndex: di,
            totalDevices: totalDevices,
            // Normalized position: x = index / total (0 to 1)
            position: {
              x: totalDevices > 1 ? di / (totalDevices - 1) : 0.5,
              y: 0.5 // Depth unknown in Phase 1, assume middle
            }
          }));
        }
        idx++;
      }
    }

    // Also to event room
    if (s.eventId) {
      io.to('event:' + s.eventId).emit('dj-choreography', payload);
    }

    console.log('[DJ] Choreography broadcast:', s.showActive ? 'STARTED' : 'STOPPED',
      '| devices:', totalDevices, '| steps:', s.choreography ? s.choreography.steps.length : 0);
  });

  // --- Positioning: DJ triggers sync pulse for depth measurement ---
  socket.on('dj-sync-pulse', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    const payload = {
      emitTime: Date.now(),
      freq: data.freq || 19500,
      sessionId: data.sessionId
    };
    io.to('dj-live:' + data.sessionId).emit('dj-sync-pulse', payload);
    if (s.eventId) io.to('event:' + s.eventId).emit('dj-sync-pulse', payload);
    console.log('[Position] Sync pulse broadcast for session', data.sessionId);
  });

  // --- Positioning: DJ sets stage heading for compass calibration ---
  socket.on('dj-stage-heading', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.stageHeading = data.heading || 0;
    s.maxDepth = data.maxDepth || 50;
    const payload = { heading: s.stageHeading, maxDepth: s.maxDepth };
    io.to('dj-live:' + data.sessionId).emit('dj-stage-heading', payload);
    if (s.eventId) io.to('event:' + s.eventId).emit('dj-stage-heading', payload);
    console.log('[Position] Stage heading set:', s.stageHeading, 'maxDepth:', s.maxDepth);
  });

  // --- Positioning: Device reports depth + compass data ---
  socket.on('dj-position-report', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    if (!s.devicePositions) s.devicePositions = {};
    const deviceId = socket.id;
    s.devicePositions[deviceId] = {
      depth: data.depth || -1,
      compassHeading: data.compassHeading || -1,
      compassX: data.compassX || 0.5,
      updatedAt: Date.now()
    };
    // Compute normalized position for this device
    const pos = computeDevicePosition(s, deviceId);
    socket.emit('dj-position-update', pos);
  });

  // --- Positioning: Mesh neighbor report ---
  socket.on('dj-mesh-report', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    if (!s.meshReports) s.meshReports = {};
    s.meshReports[socket.id] = {
      slot: data.mySlot,
      neighbors: data.neighbors || [],
      depth: data.depth || -1,
      compassHeading: data.compassHeading || -1,
      roundId: data.roundId
    };
    // If all devices reported, compute layout
    const totalReports = Object.keys(s.meshReports).length;
    const totalDevices = s.connectedDevices.size;
    if (totalReports >= totalDevices * 0.8) { // 80% reported
      computeMeshLayout(s);
    }
  });

  // --- Positioning: GPS report ---
  socket.on('dj-gps-report', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    if (!s.gpsData) s.gpsData = {};
    s.gpsData[socket.id] = {
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy || 100,
      heading: data.heading || -1,
      updatedAt: Date.now()
    };
    // Compute normalized position from GPS
    const pos = computeGPSPosition(s, socket.id);
    if (pos) socket.emit('dj-position-update', pos);
  });

  // --- Positioning: DJ triggers mesh discovery round ---
  socket.on('dj-start-mesh', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.meshReports = {};
    const devicesArr = Array.from(s.connectedDevices);
    const roundId = Date.now().toString(36);
    const totalSlots = Math.min(devicesArr.length, 40);
    let slotIdx = 0;
    const room = io.sockets.adapter.rooms.get('dj-live:' + data.sessionId);
    if (room) {
      for (const sid of room) {
        const deviceSocket = io.sockets.sockets.get(sid);
        if (deviceSocket) {
          deviceSocket.emit('dj-mesh-round', {
            slot: slotIdx % totalSlots,
            totalSlots: totalSlots,
            roundId: roundId
          });
          slotIdx++;
        }
      }
    }
    console.log('[Mesh] Started round', roundId, 'with', slotIdx, 'devices,', totalSlots, 'slots');
  });

  // --- Positioning: DJ requests GPS from all devices ---
  socket.on('dj-request-gps', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.gpsData = {};
    io.to('dj-live:' + data.sessionId).emit('dj-request-gps');
    console.log('[GPS] Requested GPS from all devices in session', data.sessionId);
  });

  // --- Audience phone detected ultrasonic frequency, check if DJ session exists ---
  socket.on('dj-check-frequency', (data) => {
    console.log('[DJ] dj-check-frequency received:', JSON.stringify(data));
    if (!data || !data.frequency) { console.log('[DJ] dj-check-frequency: missing frequency field'); return; }
    const freq = data.frequency;
    const tolerance = 200; // Hz fuzzy match
    console.log('[DJ] Checking freq=' + freq + 'Hz against', Object.keys(djSessions).length, 'active sessions');

    for (const [sid, s] of Object.entries(djSessions)) {
      console.log('[DJ] Session', sid, '-> venueFreq=' + s.venueFreq + ' broadcasting=' + s.broadcasting + ' diff=' + Math.abs(s.venueFreq - freq));
      if (s.broadcasting && Math.abs(s.venueFreq - freq) <= tolerance) {
        // Try to get logo: DJ uploaded logo first, then event logo as fallback
        var eventLogo = s.logoDataUrl || '';
        if (!eventLogo && s.eventId && db.operatorEvents[s.eventId]) {
          var ev = db.operatorEvents[s.eventId];
          eventLogo = ev.logo || ev.eventLogo || '';
        }
        socket.emit('dj-frequency-found', {
          sessionId: sid,
          sessionName: s.sessionName,
          artistName: s.artistName,
          eventName: s.eventId && db.operatorEvents[s.eventId] ? db.operatorEvents[s.eventId].name : '',
          eventLogo: eventLogo,
          color: s.color,
          bpm: s.bpm,
          animation: s.animation,
          venueFreq: s.venueFreq
        });
        console.log('[DJ] Frequency match! freq=' + freq + ' -> session=' + sid);
        return;
      }
    }
    // No match found - no response needed
  });

  // --- Audience device joins DJ session ---
  socket.on('dj-audience-join', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    const deviceId = data.deviceId || socket.id;
    // Clean up old mapping if this socket previously had a different deviceId
    const oldDeviceId = s.socketToDevice[socket.id];
    if (oldDeviceId && oldDeviceId !== deviceId) {
      s.connectedDevices.delete(oldDeviceId);
      delete s.deviceToSocket[oldDeviceId];
    }
    // Clean up old mapping if this deviceId was on a different socket
    const oldSocketId = s.deviceToSocket[deviceId];
    if (oldSocketId && oldSocketId !== socket.id) {
      delete s.socketToDevice[oldSocketId];
    }
    s.connectedDevices.add(deviceId);
    s.socketToDevice[socket.id] = deviceId;
    s.deviceToSocket[deviceId] = socket.id;
    socket.join('dj-live:' + data.sessionId);

    // Calculate device index and zone
    const devicesArr = Array.from(s.connectedDevices);
    const deviceIndex = devicesArr.indexOf(deviceId);
    const totalDevices = devicesArr.length;
    const totalZones = s.totalZones || 4;
    const zoneMode = s.zoneMode || 'alternate';
    let zone;
    if (zoneMode === 'half') {
      zone = Math.min(totalZones - 1, Math.floor(deviceIndex * totalZones / Math.max(1, totalDevices)));
    } else {
      zone = deviceIndex % totalZones;
    }

    // Send current state to the new device (including choreography if show is running)
    const statePayload = {
      sessionId: data.sessionId,
      broadcasting: s.broadcasting,
      color: s.color,
      bpm: s.bpm,
      animation: s.animation,
      deviceIndex: deviceIndex,
      totalDevices: totalDevices,
      zone: zone,
      totalZones: totalZones,
      autoMode: s.autoMode || false
    };
    socket.emit('dj-live-state', statePayload);

    // If a choreography show is active, send it too so reconnected devices pick it up
    if (s.showActive && s.choreography) {
      socket.emit('dj-choreography', {
        choreography: s.choreography,
        beatOrigin: s.beatOrigin,
        showActive: s.showActive,
        deviceIndex: deviceIndex,
        totalDevices: totalDevices,
        position: s.devicePositions && s.devicePositions[deviceId]
          ? s.devicePositions[deviceId]
          : { x: deviceIndex / Math.max(1, totalDevices - 1), y: 0.5 }
      });
    }

    // Notify DJ panel
    io.to('dj-ctrl:' + data.sessionId).emit('dj-device-joined', {
      sessionId: data.sessionId,
      deviceId: deviceId,
      totalDevices: s.connectedDevices.size
    });

    console.log('[DJ] Device joined:', deviceId, '| Total:', s.connectedDevices.size);
  });

  // --- Audience device leaves ---
  socket.on('dj-audience-leave', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    const deviceId = data.deviceId || s.socketToDevice[socket.id] || socket.id;
    s.connectedDevices.delete(deviceId);
    delete s.socketToDevice[socket.id];
    delete s.deviceToSocket[deviceId];
    socket.leave('dj-live:' + data.sessionId);

    io.to('dj-ctrl:' + data.sessionId).emit('dj-device-left', {
      sessionId: data.sessionId,
      deviceId: deviceId,
      totalDevices: s.connectedDevices.size
    });
  });

  // --- DJ session end ---
  socket.on('dj-session-end', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    if (s._positionInterval) { clearInterval(s._positionInterval); s._positionInterval = null; }

    io.to('dj-live:' + data.sessionId).emit('dj-live-stopped', { sessionId: data.sessionId });

    if (s.eventId && db.operatorEvents[s.eventId]) {
      const ev = db.operatorEvents[s.eventId];
      if (ev.djLive) { ev.djLive.broadcasting = false; ev.djLive.enabled = false; }
      io.to('event:' + s.eventId).emit('dj-live-stopped', { sessionId: data.sessionId });
    }

    delete djSessions[data.sessionId];
    console.log('[DJ] Session ended:', data.sessionId);
  });

  // === GRID POSITIONING SYSTEM ===

  // DJ configures grid
  socket.on('grid-config-update', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.gridConfig = {
      width: Math.max(2, Math.min(50, data.width || 10)),
      height: Math.max(2, Math.min(50, data.height || 10)),
      venueDepth: data.venueDepth || 50,
      stageHeading: data.stageHeading || 0
    };
    s.deviceGridAssignments = {};
    s.gridCellOccupancy = {};
    autoAssignGrid(s, data.sessionId);
    console.log('[DJ Grid] Config updated:', s.gridConfig);
  });

  // DJ sets color on a grid cell
  socket.on('grid-set-cell-color', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    const key = data.x + ',' + data.y;
    if (data.color) {
      s.gridCellColors[key] = data.color;
    } else {
      delete s.gridCellColors[key];
    }
    io.to('dj-live:' + data.sessionId).emit('grid-cell-colors-update', {
      cellColors: s.gridCellColors
    });
    if (s.eventId) {
      io.to('event:' + s.eventId).emit('grid-cell-colors-update', {
        cellColors: s.gridCellColors
      });
    }
    io.to('dj-ctrl:' + data.sessionId).emit('grid-preview-update', {
      cellOccupancy: s.gridCellOccupancy,
      assignments: s.deviceGridAssignments,
      cellColors: s.gridCellColors
    });
  });

  // DJ batch-sets cell colors (for drone show frames)
  socket.on('grid-set-all-cell-colors', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.gridCellColors = data.cellColors || {};
    io.to('dj-live:' + data.sessionId).emit('grid-cell-colors-update', {
      cellColors: s.gridCellColors
    });
    if (s.eventId) {
      io.to('event:' + s.eventId).emit('grid-cell-colors-update', {
        cellColors: s.gridCellColors
      });
    }
  });

  // DJ manually moves a device to a different grid cell
  socket.on('grid-manual-adjust', (data) => {
    if (!data || !data.sessionId || !data.deviceId) return;
    const s = djSessions[data.sessionId];
    if (!s || !s.gridConfig) return;
    const gx = Math.max(0, Math.min(s.gridConfig.width - 1, data.gridX || 0));
    const gy = Math.max(0, Math.min(s.gridConfig.height - 1, data.gridY || 0));

    const old = s.deviceGridAssignments[data.deviceId];
    if (old) {
      const oldKey = old.gridX + ',' + old.gridY;
      if (s.gridCellOccupancy[oldKey]) {
        s.gridCellOccupancy[oldKey] = s.gridCellOccupancy[oldKey].filter(id => id !== data.deviceId);
        if (s.gridCellOccupancy[oldKey].length === 0) delete s.gridCellOccupancy[oldKey];
      }
    }

    s.deviceGridAssignments[data.deviceId] = { gridX: gx, gridY: gy, confidence: 1.0, manual: true };
    const newKey = gx + ',' + gy;
    if (!s.gridCellOccupancy[newKey]) s.gridCellOccupancy[newKey] = [];
    s.gridCellOccupancy[newKey].push(data.deviceId);

    const deviceSocket = io.sockets.sockets.get(data.deviceId);
    if (deviceSocket) {
      deviceSocket.emit('grid-assignment-update', {
        gridX: gx,
        gridY: gy,
        cellColor: s.gridCellColors[newKey] || null
      });
    }

    io.to('dj-ctrl:' + data.sessionId).emit('grid-preview-update', {
      cellOccupancy: s.gridCellOccupancy,
      assignments: s.deviceGridAssignments,
      cellColors: s.gridCellColors
    });
  });

  // DJ triggers grid auto-assign
  socket.on('grid-auto-assign', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s || !s.gridConfig) return;
    autoAssignGrid(s, data.sessionId);
  });

  // DJ starts continuous positioning (re-assign every 2s)
  socket.on('grid-continuous-start', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s || !s.gridConfig) return;
    s.continuousPositioning = true;
    if (s._positionInterval) clearInterval(s._positionInterval);
    s._positionInterval = setInterval(() => {
      if (!s.continuousPositioning || !s.gridConfig) return;
      io.to('dj-live:' + data.sessionId).emit('position-ping', {
        ts: Date.now(),
        scanId: 'auto_' + Date.now()
      });
      if (s.eventId) {
        io.to('event:' + s.eventId).emit('position-ping', {
          ts: Date.now(),
          scanId: 'auto_' + Date.now()
        });
      }
    }, 2000);
    console.log('[DJ Grid] Continuous positioning started for', data.sessionId);
  });

  // DJ stops continuous positioning
  socket.on('grid-continuous-stop', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.continuousPositioning = false;
    if (s._positionInterval) { clearInterval(s._positionInterval); s._positionInterval = null; }
    console.log('[DJ Grid] Continuous positioning stopped for', data.sessionId);
  });

  // Device responds to position-ping with its sensor data
  socket.on('position-pong', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s || !s.gridConfig) return;
    const deviceId = socket.id;

    if (data.depth != null && data.depth > 0) {
      if (!s.depthReports[deviceId]) s.depthReports[deviceId] = [];
      s.depthReports[deviceId].push(data.depth);
      if (s.depthReports[deviceId].length > 5) s.depthReports[deviceId].shift();
    }

    if (data.compass != null && data.compass >= 0) {
      s.compassHeadings[deviceId] = { heading: data.compass, accuracy: data.compassAccuracy || 1.0 };
    }

    if (data.meshNeighbors && data.meshNeighbors.length > 0) {
      s.meshGraph[deviceId] = { neighbors: data.meshNeighbors, amplitudes: data.meshAmplitudes || [] };
    }

    const pos = computeDeviceGridPosition(s, deviceId);
    if (pos) {
      const oldAssignment = s.deviceGridAssignments[deviceId];
      const oldKey = oldAssignment ? (oldAssignment.gridX + ',' + oldAssignment.gridY) : null;
      const newKey = pos.gridX + ',' + pos.gridY;

      if (!oldAssignment || oldKey !== newKey) {
        if (oldKey && s.gridCellOccupancy[oldKey]) {
          s.gridCellOccupancy[oldKey] = s.gridCellOccupancy[oldKey].filter(id => id !== deviceId);
          if (s.gridCellOccupancy[oldKey].length === 0) delete s.gridCellOccupancy[oldKey];
        }
        if (!s.gridCellOccupancy[newKey]) s.gridCellOccupancy[newKey] = [];
        s.gridCellOccupancy[newKey].push(deviceId);
        s.deviceGridAssignments[deviceId] = pos;

        socket.emit('grid-assignment-update', {
          gridX: pos.gridX,
          gridY: pos.gridY,
          cellColor: s.gridCellColors[newKey] || null
        });

        io.to('dj-ctrl:' + data.sessionId).emit('grid-preview-update', {
          cellOccupancy: s.gridCellOccupancy,
          assignments: s.deviceGridAssignments,
          cellColors: s.gridCellColors
        });
      }
    }
  });

  // DJ saves a drone show
  socket.on('drone-show-save', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    const showId = 'show_' + Date.now();
    s.droneShows[showId] = {
      id: showId,
      name: data.name || 'Untitled Show',
      bpm: data.bpm || s.bpm || 128,
      frames: data.frames || [],
      transition: data.transition || 'instant',
      loop: data.loop !== false,
      createdAt: Date.now()
    };
    socket.emit('drone-show-saved', { showId: showId, name: data.name });
    console.log('[DJ Grid] Drone show saved:', showId, data.frames ? data.frames.length : 0, 'frames');
  });

  // DJ broadcasts a drone show to all devices
  socket.on('drone-show-broadcast', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    const show = data.showData || (data.showId ? s.droneShows[data.showId] : null);
    if (!show || !show.frames || show.frames.length === 0) return;

    s.activeDroneShow = {
      show: show,
      beatOrigin: Date.now(),
      bpm: show.bpm || s.bpm || 128
    };

    const payload = {
      show: show,
      beatOrigin: s.activeDroneShow.beatOrigin,
      bpm: s.activeDroneShow.bpm,
      gridAssignments: s.deviceGridAssignments
    };

    io.to('dj-live:' + data.sessionId).emit('drone-show-start', payload);
    if (s.eventId) io.to('event:' + s.eventId).emit('drone-show-start', payload);
    console.log('[DJ Grid] Drone show broadcasting:', show.name);
  });

  // DJ stops drone show
  socket.on('drone-show-stop', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    s.activeDroneShow = null;
    io.to('dj-live:' + data.sessionId).emit('drone-show-stop', {});
    if (s.eventId) io.to('event:' + s.eventId).emit('drone-show-stop', {});
    console.log('[DJ Grid] Drone show stopped');
  });

  socket.on('drone-show-library-list', function(data) {
    var list = Object.keys(DRONE_SHOW_LIBRARY).map(function(id) {
      var show = DRONE_SHOW_LIBRARY[id];
      return { id: id, name: show.name, frameCount: show.frames.length };
    });
    socket.emit('drone-show-library', list);
  });

  socket.on('drone-show-library-play', function(data) {
    if (!data || !data.showId || !data.sessionId) return;
    var show = DRONE_SHOW_LIBRARY[data.showId];
    if (!show) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    s.activeDroneShow = {
      show: show,
      beatOrigin: Date.now(),
      bpm: show.bpm || s.bpm || 128
    };

    var payload = {
      show: show,
      beatOrigin: s.activeDroneShow.beatOrigin,
      bpm: s.activeDroneShow.bpm,
      gridAssignments: s.deviceGridAssignments
    };

    io.to('dj-live:' + data.sessionId).emit('drone-show-start', payload);
    if (s.eventId) io.to('event:' + s.eventId).emit('drone-show-start', payload);
    console.log('[DJ Grid] Playing drone show library:', show.name);
  });

  socket.on('drone-show-library-get', function(data) {
    if (!data || !data.showId) return;
    var show = DRONE_SHOW_LIBRARY[data.showId];
    if (!show) return;
    socket.emit('drone-show-library-data', {
      showId: data.showId,
      show: show
    });
  });

  // DJ triggers calibration test mode (devices show their grid number)
  socket.on('grid-test-mode', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;
    io.to('dj-live:' + data.sessionId).emit('grid-test-mode', {
      enabled: data.enabled !== false,
      assignments: s.deviceGridAssignments
    });
    if (s.eventId) {
      io.to('event:' + s.eventId).emit('grid-test-mode', {
        enabled: data.enabled !== false,
        assignments: s.deviceGridAssignments
      });
    }
  });

  // --- Position Calibration (Sound Time-of-Flight) ---
  socket.on('dj-calibration-start', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    s.calibrationId = data.calibrationId;
    s.calibrationEmitTime = data.emitTime;
    s.calibrationResults = {};

    // Send calibration command to all audience phones
    io.to('dj-live:' + data.sessionId).emit('dj-calibration-pulse', {
      calibrationId: data.calibrationId,
      emitTime: data.emitTime,
      frequency: data.frequency || 19200
    });

    console.log('[Calibration] Started:', data.calibrationId, 'for session', data.sessionId);
  });

  // DJ reports the actual moment the ultrasonic pulse was emitted (after mic warmup delay)
  socket.on('dj-calibration-pulse-sent', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s || s.calibrationId !== data.calibrationId) return;
    s.calibrationEmitTime = data.actualEmitTime;
    console.log('[Calibration] Pulse actually emitted at', data.actualEmitTime, 'for', data.calibrationId);
  });

  // Audience phone reports back its detected time
  socket.on('dj-calibration-report', (data) => {
    if (!data || !data.sessionId || !data.calibrationId) return;
    const s = djSessions[data.sessionId];
    if (!s || s.calibrationId !== data.calibrationId) return;

    const deviceId = s.socketToDevice[socket.id] || socket.id;
    const latencyMs = data.detectedTime - s.calibrationEmitTime;
    // Sound travels at ~343 m/s
    const distanceMeters = Math.max(0, (latencyMs / 1000) * 343);

    s.calibrationResults[deviceId] = {
      latency: latencyMs,
      distance: distanceMeters,
      detectedTime: data.detectedTime
    };

    // Send result to DJ panel
    io.to('dj-ctrl:' + data.sessionId).emit('dj-calibration-result', {
      deviceId: deviceId,
      distance: distanceMeters,
      latency: latencyMs
    });

    // Recalculate positions based on all results so far
    const results = s.calibrationResults;
    const sortedDevices = Object.entries(results)
      .sort((a, b) => a[1].distance - b[1].distance);

    if (sortedDevices.length > 0) {
      const maxDist = Math.max(1, sortedDevices[sortedDevices.length - 1][1].distance);

      sortedDevices.forEach(([devId, result], idx) => {
        const y = sortedDevices.length > 1
          ? idx / (sortedDevices.length - 1)  // 0 = front, 1 = back
          : 0.5;
        const x = sortedDevices.length > 1
          ? idx / (sortedDevices.length - 1)  // Also spread on X until compass available
          : 0.5;

        // Send updated position to the specific device
        const targetSocketId = s.deviceToSocket[devId];
        if (targetSocketId) {
          const targetSocket = io.sockets.sockets.get(targetSocketId);
          if (targetSocket) {
            targetSocket.emit('dj-position-update', {
              x: x,
              y: y,
              source: 'calibration',
              distance: result.distance
            });
          }
        }
      });
    }

    console.log('[Calibration] Device', deviceId, ': distance=' + distanceMeters.toFixed(1) + 'm, latency=' + latencyMs + 'ms');
  });

  // Reset calibration - revert to index-based positions
  socket.on('dj-calibration-reset', (data) => {
    if (!data || !data.sessionId) return;
    const s = djSessions[data.sessionId];
    if (!s) return;

    s.calibrationResults = {};
    s.calibrationId = null;

    // Tell all devices to reset to index-based positioning
    const devicesArr = Array.from(s.connectedDevices);
    devicesArr.forEach((devId, idx) => {
      const targetSocketId = s.deviceToSocket[devId];
      if (targetSocketId) {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          const x = devicesArr.length > 1 ? idx / (devicesArr.length - 1) : 0.5;
          targetSocket.emit('dj-position-update', {
            x: x,
            y: 0.5,
            source: 'reset'
          });
        }
      }
    });

    console.log('[Calibration] Reset positions for session', data.sessionId);
  });

  // --- Operator starts DJ from operator panel ---
  socket.on('dj-operator-start', (data) => {
    if (!data || !data.eventId) return;
    const ev = db.operatorEvents[data.eventId];
    if (!ev) return;

    const sessionId = 'dj_' + data.eventId + '_' + Date.now();
    djSessions[sessionId] = {
      eventId: data.eventId,
      creatorId: ev.creatorId,
      artistName: data.artistName || ev.name,
      sessionName: ev.name,
      venueFreq: data.venueFreq || 19200,
      broadcasting: true,
      color: data.color || '#ff6b35',
      bpm: data.bpm || 128,
      animation: data.animation || 'pulse',
      connectedDevices: new Set(),
      socketToDevice: {},
      deviceToSocket: {},
      createdAt: Date.now(),
      // Grid positioning system
      gridConfig: null,
      deviceGridAssignments: {},
      gridCellOccupancy: {},
      gridCellColors: {},
      depthReports: {},
      meshGraph: {},
      compassHeadings: {},
      clockOffsets: {},
      droneShows: {},
      activeDroneShow: null,
      continuousPositioning: false,
      _positionInterval: null
    };

    if (!ev.djLive) ev.djLive = {};
    ev.djLive.enabled = true;
    ev.djLive.sessionId = sessionId;
    ev.djLive.broadcasting = true;
    ev.djLive.color = djSessions[sessionId].color;
    ev.djLive.bpm = djSessions[sessionId].bpm;
    ev.djLive.animation = djSessions[sessionId].animation;
    ev.djLive.venueFreq = djSessions[sessionId].venueFreq;
    saveDB('operatorEvents');

    socket.join('dj-ctrl:' + sessionId);

    // Notify all event participants
    io.to('event:' + data.eventId).emit('dj-live-started', {
      sessionId: sessionId,
      color: djSessions[sessionId].color,
      bpm: djSessions[sessionId].bpm,
      animation: djSessions[sessionId].animation,
      venueFreq: djSessions[sessionId].venueFreq
    });

    socket.emit('dj-operator-session-created', { sessionId, eventId: data.eventId });
    console.log('[DJ] Operator started DJ for event:', data.eventId, '| Session:', sessionId);
  });

  // --- Operator stops DJ ---
  socket.on('dj-operator-stop', (data) => {
    if (!data || !data.eventId) return;
    const ev = db.operatorEvents[data.eventId];
    if (!ev || !ev.djLive || !ev.djLive.sessionId) return;

    const sessionId = ev.djLive.sessionId;
    const s = djSessions[sessionId];
    if (s) {
      s.broadcasting = false;
      io.to('dj-live:' + sessionId).emit('dj-live-stopped', { sessionId });
    }

    ev.djLive.broadcasting = false;
    io.to('event:' + data.eventId).emit('dj-live-stopped', { sessionId });
    saveDB('operatorEvents');

    socket.emit('dj-operator-session-stopped', { sessionId, eventId: data.eventId });
    console.log('[DJ] Operator stopped DJ for event:', data.eventId);
  });

  // --- Operator sends DJ command from operator panel ---
  socket.on('dj-operator-command', (data) => {
    if (!data || !data.eventId) return;
    const ev = db.operatorEvents[data.eventId];
    if (!ev || !ev.djLive || !ev.djLive.sessionId) return;

    const sessionId = ev.djLive.sessionId;
    const s = djSessions[sessionId];
    if (!s) return;

    if (data.color) { s.color = data.color; ev.djLive.color = data.color; }
    if (data.bpm) { s.bpm = data.bpm; ev.djLive.bpm = data.bpm; }
    if (data.animation) { s.animation = data.animation; ev.djLive.animation = data.animation; }
    if (data.text !== undefined) s.liveText = data.text;
    if (data.totalZones) s.totalZones = data.totalZones;

    const payload = {
      sessionId: sessionId,
      command: data.command || 'update',
      color: s.color,
      bpm: s.bpm,
      animation: s.animation,
      duration: data.duration || 0,
      text: s.liveText || '',
      totalZones: s.totalZones || 4,
      timestamp: Date.now(),
      raffleNumber: data.raffleNumber || 0,
      raffleTotalDevices: data.raffleTotalDevices || s.connectedDevices.size || 20
    };

    io.to('dj-live:' + sessionId).emit('dj-command', payload);
    io.to('event:' + data.eventId).emit('dj-command', payload);
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    // Remove device from all DJ sessions using socketToDevice mapping
    for (const [sid, s] of Object.entries(djSessions)) {
      const deviceId = s.socketToDevice[socket.id];
      if (deviceId) {
        s.connectedDevices.delete(deviceId);
        delete s.socketToDevice[socket.id];
        delete s.deviceToSocket[deviceId];
        io.to('dj-ctrl:' + sid).emit('dj-device-left', {
          sessionId: sid,
          deviceId: deviceId,
          totalDevices: s.connectedDevices.size
        });
        console.log('[DJ] Device disconnected:', deviceId, '(socket:', socket.id, ') | Total:', s.connectedDevices.size);
      } else if (s.connectedDevices.has(socket.id)) {
        // Fallback: device joined with socket.id directly
        s.connectedDevices.delete(socket.id);
        io.to('dj-ctrl:' + sid).emit('dj-device-left', {
          sessionId: sid,
          deviceId: socket.id,
          totalDevices: s.connectedDevices.size
        });
        console.log('[DJ] Device disconnected (fallback):', socket.id, '| Total:', s.connectedDevices.size);
      }
    }
  });
});

console.log('[DJ LIVE] Touch? Live DJ engine loaded');

// ── Position Computation Helpers ──

function computeDevicePosition(session, deviceId) {
  const pos = session.devicePositions && session.devicePositions[deviceId];
  if (!pos) return { x: 0.5, y: 0.5 };

  let y = 0.5, x = 0.5;
  const maxDepth = session.maxDepth || 50;

  // Y from depth (sound time-of-flight)
  if (pos.depth >= 0) {
    y = Math.min(1, pos.depth / maxDepth);
  }

  // X from compass
  if (pos.compassX !== undefined && session.stageHeading !== undefined) {
    x = pos.compassX;
  } else {
    // Fallback: spread by device index
    const devicesArr = Array.from(session.connectedDevices);
    const idx = devicesArr.indexOf(deviceId);
    if (idx >= 0 && devicesArr.length > 1) {
      x = idx / (devicesArr.length - 1);
    }
  }

  return { x, y, depthNorm: y };
}

function computeGPSPosition(session, deviceId) {
  const gps = session.gpsData && session.gpsData[deviceId];
  if (!gps || !gps.lat) return null;

  // Collect all GPS points to find bounds
  const points = Object.values(session.gpsData).filter(g => g.lat && g.lng);
  if (points.length < 2) return { x: 0.5, y: 0.5 };

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  // Add small padding to avoid edge positions
  const latRange = (maxLat - minLat) || 0.001;
  const lngRange = (maxLng - minLng) || 0.001;

  const x = (gps.lng - minLng) / lngRange;
  const y = (gps.lat - minLat) / latRange;

  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, 1 - y)) };
}

function computeMeshLayout(session) {
  // Build adjacency from mesh reports
  const reports = session.meshReports || {};
  const deviceIds = Object.keys(reports);
  if (deviceIds.length < 2) return;

  // Spring-force layout: connected nodes attract, all nodes repel
  // Initialize random positions
  const positions = {};
  for (const id of deviceIds) {
    positions[id] = {
      x: Math.random(),
      y: Math.random()
    };
    // Use depth if available
    const r = reports[id];
    if (r.depth >= 0 && session.maxDepth) {
      positions[id].y = Math.min(1, r.depth / (session.maxDepth || 50));
    }
  }

  // Build slot-to-deviceId mapping
  const slotToDevice = {};
  for (const id of deviceIds) {
    slotToDevice[reports[id].slot] = id;
  }

  // Run 50 iterations of force-directed layout
  const k = 0.1; // Spring constant
  const repulsion = 0.01;
  for (let iter = 0; iter < 50; iter++) {
    const forces = {};
    for (const id of deviceIds) forces[id] = { fx: 0, fy: 0 };

    // Repulsion between all pairs
    for (let i = 0; i < deviceIds.length; i++) {
      for (let j = i + 1; j < deviceIds.length; j++) {
        const a = deviceIds[i], b = deviceIds[j];
        const dx = positions[a].x - positions[b].x;
        const dy = positions[a].y - positions[b].y;
        const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
        const f = repulsion / (dist * dist);
        forces[a].fx += (dx / dist) * f;
        forces[a].fy += (dy / dist) * f;
        forces[b].fx -= (dx / dist) * f;
        forces[b].fy -= (dy / dist) * f;
      }
    }

    // Attraction between neighbors
    for (const id of deviceIds) {
      const neighbors = reports[id].neighbors || [];
      for (const nSlot of neighbors) {
        const nId = slotToDevice[nSlot];
        if (!nId || !positions[nId]) continue;
        const dx = positions[nId].x - positions[id].x;
        const dy = positions[nId].y - positions[id].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        forces[id].fx += dx * k;
        forces[id].fy += dy * k;
      }
    }

    // Apply forces with damping
    const damping = 0.8 / (1 + iter * 0.1);
    for (const id of deviceIds) {
      positions[id].x = Math.max(0, Math.min(1, positions[id].x + forces[id].fx * damping));
      positions[id].y = Math.max(0, Math.min(1, positions[id].y + forces[id].fy * damping));
    }
  }

  // Send computed positions to each device
  for (const id of deviceIds) {
    const deviceSocket = io.sockets.sockets.get(id);
    if (deviceSocket) {
      deviceSocket.emit('dj-position-update', {
        x: positions[id].x,
        y: positions[id].y,
        source: 'mesh'
      });
    }
  }

  // Store for late joiners
  if (!session.devicePositions) session.devicePositions = {};
  for (const id of deviceIds) {
    session.devicePositions[id] = {
      ...session.devicePositions[id],
      meshX: positions[id].x,
      meshY: positions[id].y
    };
  }

  console.log('[Mesh] Layout computed for', deviceIds.length, 'devices');
}

function computeDeviceGridPosition(session, deviceId) {
  if (!session.gridConfig) return null;
  const gc = session.gridConfig;
  var posX = 0.5, posY = 0.5;
  var hasDepth = false, hasMesh = false, hasCompass = false;

  var depths = session.depthReports[deviceId];
  if (depths && depths.length > 0) {
    var avgDepth = depths.reduce(function(a, b) { return a + b; }, 0) / depths.length;
    posY = Math.min(1, avgDepth / gc.venueDepth);
    hasDepth = true;
  }

  var compass = session.compassHeadings[deviceId];
  if (compass && compass.heading >= 0 && gc.stageHeading >= 0) {
    var relAngle = compass.heading - gc.stageHeading;
    while (relAngle < -180) relAngle += 360;
    while (relAngle > 180) relAngle -= 360;
    posX = 0.5 + (relAngle / 180) * 0.5;
    posX = Math.max(0, Math.min(1, posX));
    hasCompass = true;
  }

  var meshEntry = session.meshGraph[deviceId];
  if (!hasCompass && meshEntry && meshEntry.neighbors && meshEntry.neighbors.length > 0) {
    var neighborXs = [];
    meshEntry.neighbors.forEach(function(nid) {
      var na = session.deviceGridAssignments[nid];
      if (na) neighborXs.push(na.gridX / (gc.width - 1));
    });
    if (neighborXs.length > 0) {
      posX = neighborXs.reduce(function(a, b) { return a + b; }, 0) / neighborXs.length;
      posX += (Math.random() - 0.5) * 0.1;
      posX = Math.max(0, Math.min(1, posX));
      hasMesh = true;
    }
  }

  if (!hasDepth && !hasMesh && !hasCompass) {
    var devicesArr = Array.from(session.connectedDevices);
    var idx = devicesArr.indexOf(deviceId);
    if (idx >= 0 && devicesArr.length > 1) {
      posX = idx / (devicesArr.length - 1);
      posY = Math.floor(idx / gc.width) / Math.max(1, Math.ceil(devicesArr.length / gc.width) - 1);
    }
  }

  var gridX = Math.floor(posX * gc.width);
  var gridY = Math.floor(posY * gc.height);
  gridX = Math.max(0, Math.min(gc.width - 1, gridX));
  gridY = Math.max(0, Math.min(gc.height - 1, gridY));

  var confidence = 0.3;
  if (hasDepth) confidence += 0.3;
  if (hasMesh) confidence += 0.2;
  if (hasCompass) confidence += 0.2;

  return { gridX: gridX, gridY: gridY, confidence: confidence };
}

function autoAssignGrid(session, sessionId) {
  if (!session.gridConfig) return;
  session.deviceGridAssignments = {};
  session.gridCellOccupancy = {};

  var devicesArr = Array.from(session.connectedDevices);
  for (var i = 0; i < devicesArr.length; i++) {
    var deviceId = devicesArr[i];
    var pos = computeDeviceGridPosition(session, deviceId);
    if (!pos) {
      var gx = i % session.gridConfig.width;
      var gy = Math.floor(i / session.gridConfig.width) % session.gridConfig.height;
      pos = { gridX: gx, gridY: gy, confidence: 0.2 };
    }

    var key = pos.gridX + ',' + pos.gridY;
    while (session.gridCellOccupancy[key] && session.gridCellOccupancy[key].length > 0) {
      pos.gridX = (pos.gridX + 1) % session.gridConfig.width;
      if (pos.gridX === 0) pos.gridY = (pos.gridY + 1) % session.gridConfig.height;
      key = pos.gridX + ',' + pos.gridY;
      pos.confidence = Math.max(0.1, pos.confidence - 0.1);
    }

    session.deviceGridAssignments[deviceId] = pos;
    session.gridCellOccupancy[key] = [deviceId];

    var deviceSocket = io.sockets.sockets.get(deviceId);
    if (deviceSocket) {
      deviceSocket.emit('grid-assignment-update', {
        gridX: pos.gridX,
        gridY: pos.gridY,
        cellColor: session.gridCellColors[key] || null
      });
    }
  }

  io.to('dj-ctrl:' + sessionId).emit('grid-preview-update', {
    cellOccupancy: session.gridCellOccupancy,
    assignments: session.deviceGridAssignments,
    cellColors: session.gridCellColors
  });

  console.log('[DJ Grid] Auto-assigned', devicesArr.length, 'devices to grid');
}

// ══════════════════════════════════════════════════════════════
// DRONE SHOW LIBRARY - Pixel art animations inspired by Chinese drone shows
// ══════════════════════════════════════════════════════════════

function drawPixelShape(shape, color, offsetX, offsetY) {
  var cells = {};
  offsetX = offsetX || 0;
  offsetY = offsetY || 0;
  for (var i = 0; i < shape.length; i++) {
    var x = shape[i][0] + offsetX;
    var y = shape[i][1] + offsetY;
    if (x >= 0 && x < 20 && y >= 0 && y < 20) {
      cells[x + ',' + y] = color;
    }
  }
  return cells;
}

function mergeFrames() {
  var result = {};
  for (var i = 0; i < arguments.length; i++) {
    var cells = arguments[i];
    var keys = Object.keys(cells);
    for (var k = 0; k < keys.length; k++) {
      result[keys[k]] = cells[keys[k]];
    }
  }
  return result;
}

function fillGrid(color) {
  var cells = {};
  for (var y = 0; y < 20; y++) {
    for (var x = 0; x < 20; x++) {
      cells[x + ',' + y] = color;
    }
  }
  return cells;
}

function drawCircle(cx, cy, r, color) {
  var cells = {};
  for (var y = 0; y < 20; y++) {
    for (var x = 0; x < 20; x++) {
      var dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (dist >= r - 0.7 && dist <= r + 0.7) {
        cells[x + ',' + y] = color;
      }
    }
  }
  return cells;
}

function drawFilledCircle(cx, cy, r, color) {
  var cells = {};
  for (var y = 0; y < 20; y++) {
    for (var x = 0; x < 20; x++) {
      var dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (dist <= r) {
        cells[x + ',' + y] = color;
      }
    }
  }
  return cells;
}

function drawLine(x1, y1, x2, y2, color) {
  var cells = {};
  var dx = Math.abs(x2 - x1);
  var dy = Math.abs(y2 - y1);
  var sx = x1 < x2 ? 1 : -1;
  var sy = y1 < y2 ? 1 : -1;
  var err = dx - dy;
  var x = x1, y = y1;
  while (true) {
    if (x >= 0 && x < 20 && y >= 0 && y < 20) {
      cells[x + ',' + y] = color;
    }
    if (x === x2 && y === y2) break;
    var e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}

var HEART_SMALL = [];
(function() {
  var h = [
    '  ##  ##  ',
    ' ########',
    '##########',
    '##########',
    '##########',
    ' ######## ',
    '  ######  ',
    '   ####   ',
    '    ##    ',
    '     .    '
  ];
  for (var y = 0; y < h.length; y++) {
    for (var x = 0; x < h[y].length; x++) {
      if (h[y][x] === '#') HEART_SMALL.push([x + 5, y + 5]);
    }
  }
})();

var HEART_BIG = [];
(function() {
  var h = [
    '  ####  ####  ',
    ' ############ #',
    '################',
    '################',
    '################',
    '################',
    ' ############## ',
    '  ############  ',
    '   ##########   ',
    '    ########    ',
    '     ######     ',
    '      ####      ',
    '       ##       ',
    '        .       '
  ];
  for (var y = 0; y < h.length; y++) {
    for (var x = 0; x < h[y].length; x++) {
      if (h[y][x] === '#') HEART_BIG.push([x + 2, y + 3]);
    }
  }
})();

var DRAGON_HEAD = [];
var DRAGON_BODY_1 = [];
var DRAGON_BODY_2 = [];
var DRAGON_BODY_3 = [];
var DRAGON_TAIL = [];
(function() {
  var head = [
    ' ### ',
    '#####',
    '## ##',
    '#####',
    ' ### '
  ];
  for (var y = 0; y < head.length; y++)
    for (var x = 0; x < head[y].length; x++)
      if (head[y][x] === '#') DRAGON_HEAD.push([x, y]);
  var body = [[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]];
  DRAGON_BODY_1 = body.slice();
  DRAGON_BODY_2 = body.slice();
  DRAGON_BODY_3 = body.slice();
  DRAGON_TAIL = [[0,0],[1,0],[2,0],[0,1],[1,1],[1,2]];
})();

var PHOENIX_SHAPE = [];
(function() {
  var p = [
    '    #  #  #    ',
    '   ## ## ##   ',
    '  #### ####  ',
    '  ##########  ',
    '   ########   ',
    '    ######    ',
    '     ####     ',
    '    ######    ',
    '   ## ## ##   ',
    '  #   #   #  '
  ];
  for (var y = 0; y < p.length; y++)
    for (var x = 0; x < p[y].length; x++)
      if (p[y][x] === '#') PHOENIX_SHAPE.push([x + 3, y]);
})();

var STAR_5PT = [];
(function() {
  var s = [
    '       ##       ',
    '       ##       ',
    '      ####      ',
    '      ####      ',
    '  ############  ',
    '   ##########   ',
    '    ########    ',
    '     ######     ',
    '    ########    ',
    '   ###    ###   ',
    '  ##        ##  ',
    ' ##          ## '
  ];
  for (var y = 0; y < s.length; y++)
    for (var x = 0; x < s[y].length; x++)
      if (s[y][x] === '#') STAR_5PT.push([x + 2, y + 4]);
})();

var NUM_5 = [];
(function() {
  var n = [
    '######',
    '##    ',
    '######',
    '    ##',
    '    ##',
    '######'
  ];
  for (var y = 0; y < n.length; y++)
    for (var x = 0; x < n[y].length; x++)
      if (n[y][x] === '#') NUM_5.push([x, y]);
})();

var NUM_4 = [];
(function() {
  var n = [
    '##  ##',
    '##  ##',
    '######',
    '    ##',
    '    ##',
    '    ##'
  ];
  for (var y = 0; y < n.length; y++)
    for (var x = 0; x < n[y].length; x++)
      if (n[y][x] === '#') NUM_4.push([x, y]);
})();

var NUM_3 = [];
(function() {
  var n = [
    '######',
    '    ##',
    '######',
    '    ##',
    '    ##',
    '######'
  ];
  for (var y = 0; y < n.length; y++)
    for (var x = 0; x < n[y].length; x++)
      if (n[y][x] === '#') NUM_3.push([x, y]);
})();

var NUM_2 = [];
(function() {
  var n = [
    '######',
    '    ##',
    '######',
    '##    ',
    '##    ',
    '######'
  ];
  for (var y = 0; y < n.length; y++)
    for (var x = 0; x < n[y].length; x++)
      if (n[y][x] === '#') NUM_2.push([x, y]);
})();

var NUM_1 = [];
(function() {
  var n = [
    '  ##  ',
    ' ###  ',
    '  ##  ',
    '  ##  ',
    '  ##  ',
    '######'
  ];
  for (var y = 0; y < n.length; y++)
    for (var x = 0; x < n[y].length; x++)
      if (n[y][x] === '#') NUM_1.push([x, y]);
})();

var LETTER_T = [];
(function() {
  var l = ['#####','  #  ','  #  ','  #  ','  #  ','  #  ','  #  '];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_T.push([x, y]);
})();

var LETTER_O = [];
(function() {
  var l = [' ### ','#   #','#   #','#   #','#   #','#   #',' ### '];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_O.push([x, y]);
})();

var LETTER_U = [];
(function() {
  var l = ['#   #','#   #','#   #','#   #','#   #','#   #',' ### '];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_U.push([x, y]);
})();

var LETTER_C = [];
(function() {
  var l = [' ### ','#   #','#    ','#    ','#    ','#   #',' ### '];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_C.push([x, y]);
})();

var LETTER_H = [];
(function() {
  var l = ['#   #','#   #','#####','#   #','#   #','#   #','#   #'];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_H.push([x, y]);
})();

var LETTER_Q = [];
(function() {
  var l = [' ### ','#   #','#   #','#   #','# # #','#  # ',' ## #'];
  for (var y = 0; y < l.length; y++)
    for (var x = 0; x < l[y].length; x++)
      if (l[y][x] === '#') LETTER_Q.push([x, y]);
})();

var DRONE_SHOW_LIBRARY = {
  'heart-pulse': {
    name: 'Heart Pulse',
    bpm: 128,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: drawPixelShape(HEART_SMALL, '#ff1744', 0, 0) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(HEART_BIG, '#ff3c6e', 0, 0), drawCircle(10, 10, 9, '#ff1744')) },
      { durationBeats: 2, transition: 'fade', cells: drawPixelShape(HEART_SMALL, '#ff5a8f', 0, 0) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(HEART_BIG, '#ff1744', 0, 0), drawCircle(10, 10, 9, '#ff3c6e')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawPixelShape(HEART_BIG, '#ffffff', 0, 0), fillGrid('#330011')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawPixelShape(HEART_BIG, '#ff3c6e', 0, 0), drawCircle(10, 10, 8, '#ff1744'), drawCircle(10, 10, 6, '#cc0033')) },
      { durationBeats: 2, transition: 'fade', cells: drawPixelShape(HEART_SMALL, '#ff1744', 0, 0) }
    ]
  },

  'countdown-blast': {
    name: 'Countdown Blast',
    bpm: 120,
    frames: [
      { durationBeats: 4, transition: 'instant', cells: mergeFrames(drawPixelShape(NUM_5, '#ffdd00', 7, 7), drawCircle(10, 10, 8, '#333300')) },
      { durationBeats: 4, transition: 'instant', cells: mergeFrames(drawPixelShape(NUM_4, '#ffdd00', 7, 7), drawCircle(10, 10, 7, '#444400')) },
      { durationBeats: 4, transition: 'instant', cells: mergeFrames(drawPixelShape(NUM_3, '#ffaa00', 7, 7), drawCircle(10, 10, 6, '#553300')) },
      { durationBeats: 4, transition: 'instant', cells: mergeFrames(drawPixelShape(NUM_2, '#ff6600', 7, 7), drawCircle(10, 10, 5, '#663300')) },
      { durationBeats: 4, transition: 'instant', cells: mergeFrames(drawPixelShape(NUM_1, '#ff3c00', 7, 7), drawFilledCircle(10, 10, 3, '#441100')) },
      { durationBeats: 1, transition: 'instant', cells: fillGrid('#ffffff') },
      { durationBeats: 1, transition: 'instant', cells: fillGrid('#ffff00') },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(fillGrid('#ff6600'), drawCircle(10, 10, 5, '#ffff00'), drawCircle(10, 10, 8, '#ffdd00')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 9, '#ff4400'), drawCircle(10, 10, 6, '#ff6600'), drawCircle(10, 10, 3, '#ff8800')) }
    ]
  },

  'dragon': {
    name: 'Dragon Serpent',
    bpm: 96,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff4444', 2, 3), drawPixelShape(DRAGON_BODY_1, '#cc3333', 6, 4), drawFilledCircle(3, 4, 1, '#ffdd00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff4444', 5, 5), drawPixelShape(DRAGON_BODY_1, '#cc3333', 2, 4), drawPixelShape(DRAGON_BODY_2, '#aa2222', 9, 6), drawFilledCircle(6, 6, 1, '#ffdd00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff4444', 9, 3), drawPixelShape(DRAGON_BODY_1, '#cc3333', 5, 5), drawPixelShape(DRAGON_BODY_2, '#aa2222', 2, 4), drawPixelShape(DRAGON_BODY_3, '#882222', 13, 4), drawFilledCircle(10, 4, 1, '#ffdd00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff4444', 13, 5), drawPixelShape(DRAGON_BODY_1, '#cc3333', 9, 3), drawPixelShape(DRAGON_BODY_2, '#aa2222', 5, 5), drawPixelShape(DRAGON_TAIL, '#882222', 2, 7), drawFilledCircle(14, 6, 1, '#ffdd00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff6644', 15, 8), drawPixelShape(DRAGON_BODY_1, '#cc3333', 13, 5), drawPixelShape(DRAGON_BODY_2, '#aa2222', 9, 3), drawPixelShape(DRAGON_BODY_3, '#882222', 5, 5), drawPixelShape(DRAGON_TAIL, '#662222', 2, 7), drawFilledCircle(16, 9, 1, '#ffdd00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff8844', 14, 12), drawPixelShape(DRAGON_BODY_1, '#cc5533', 15, 8), drawPixelShape(DRAGON_BODY_2, '#aa3322', 13, 5), drawPixelShape(DRAGON_BODY_3, '#882222', 9, 3), drawPixelShape(DRAGON_TAIL, '#662222', 5, 5)) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(DRAGON_HEAD, '#ff4444', 10, 14), drawPixelShape(DRAGON_BODY_1, '#cc3333', 14, 12), drawPixelShape(DRAGON_BODY_2, '#aa2222', 15, 8)) },
      { durationBeats: 2, transition: 'instant', cells: mergeFrames(drawFilledCircle(10, 10, 4, '#ff4444'), drawCircle(10, 10, 6, '#ff6644'), drawCircle(10, 10, 8, '#882222')) }
    ]
  },

  'phoenix-rise': {
    name: 'Phoenix Rising',
    bpm: 100,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ff4400', 0, 10), drawFilledCircle(10, 17, 2, '#ff2200'), drawFilledCircle(10, 19, 1, '#cc0000')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ff6600', 0, 7), drawFilledCircle(10, 15, 2, '#ff4400'), drawLine(9, 17, 11, 19, '#cc2200')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ff8800', 0, 4), drawFilledCircle(10, 12, 2, '#ff6600'), drawLine(8, 14, 12, 18, '#cc4400')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ffaa00', 0, 1), drawFilledCircle(10, 9, 2, '#ff8800'), drawLine(7, 11, 13, 17, '#cc6600'), drawCircle(10, 10, 8, '#442200')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ffcc00', 0, 0), drawCircle(10, 5, 3, '#ffaa00'), drawCircle(10, 5, 5, '#ff8800'), drawCircle(10, 5, 7, '#ff6600')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ffffff', 0, 0), drawFilledCircle(10, 5, 4, '#ffddaa'), drawCircle(10, 5, 7, '#ffaa00'), drawCircle(10, 5, 9, '#ff6600')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawPixelShape(PHOENIX_SHAPE, '#ffdd00', 0, 0), drawCircle(10, 5, 9, '#ff880044')) }
    ]
  },

  'firework-burst': {
    name: 'Fireworks',
    bpm: 130,
    frames: [
      { durationBeats: 1, transition: 'instant', cells: drawFilledCircle(5, 10, 1, '#ffffff') },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 2, '#ffff00'), drawFilledCircle(5, 10, 1, '#ffffff')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 4, '#ffaa00'), drawCircle(5, 10, 2, '#ffff00')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 4, '#ffaa00'), drawFilledCircle(15, 5, 1, '#ffffff')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 5, '#ff6600'), drawCircle(15, 5, 2, '#ff00ff'), drawFilledCircle(15, 5, 1, '#ffffff')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 6, '#cc3300'), drawCircle(15, 5, 4, '#cc00cc'), drawFilledCircle(10, 16, 1, '#ffffff')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(5, 10, 7, '#660000'), drawCircle(15, 5, 5, '#880088'), drawCircle(10, 16, 3, '#00ffff'), drawFilledCircle(10, 16, 1, '#ffffff')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(15, 5, 6, '#440044'), drawCircle(10, 16, 5, '#008888'), drawCircle(10, 16, 2, '#00ffff')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 16, 6, '#004444'), drawFilledCircle(3, 3, 2, '#ffdd00'), drawFilledCircle(17, 15, 2, '#ff44ff')) },
      { durationBeats: 1, transition: 'fade', cells: {} }
    ]
  },

  'globe-spin': {
    name: 'Globe Spin',
    bpm: 100,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 7, '#00b4d8'), drawCircle(10, 10, 5, '#0096c8'), drawLine(3, 10, 17, 10, '#0078a8'), drawLine(10, 3, 10, 17, '#0078a8')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 7, '#00b4d8'), drawCircle(10, 10, 5, '#0096c8'), drawLine(5, 5, 15, 15, '#0078a8'), drawLine(15, 5, 5, 15, '#0078a8')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 7, '#00b4d8'), drawFilledCircle(10, 10, 5, '#005a8a'), drawLine(3, 10, 17, 10, '#00b4d8'), drawLine(10, 3, 10, 17, '#00b4d8')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 7, '#00d4f8'), drawCircle(10, 10, 4, '#00b4d8'), drawCircle(10, 10, 1, '#ffffff')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 8, '#00b4d8'), drawCircle(10, 10, 6, '#0096c8'), drawCircle(10, 10, 3, '#0078a8'), drawLine(3, 7, 17, 7, '#005a8a'), drawLine(3, 13, 17, 13, '#005a8a')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 7, '#00b4d8'), drawCircle(8, 10, 5, '#0096c8'), drawCircle(12, 10, 5, '#0096c8'), drawLine(10, 3, 10, 17, '#0078a8')) }
    ]
  },

  'snake-wave': {
    name: 'Snake Wave',
    bpm: 110,
    frames: [
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 10, 19, 10, '#2dd4a0'), drawLine(0, 11, 19, 11, '#1aaa80')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 8, 19, 8, '#2dd4a0'), drawLine(0, 9, 19, 9, '#1aaa80'), drawLine(0, 12, 19, 12, '#2dd4a0'), drawLine(0, 13, 19, 13, '#1aaa80')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 6, 19, 6, '#2dd4a0'), drawLine(0, 7, 19, 7, '#1aaa80'), drawLine(0, 10, 19, 10, '#2dd4a0'), drawLine(0, 11, 19, 11, '#1aaa80'), drawLine(0, 14, 19, 14, '#2dd4a0'), drawLine(0, 15, 19, 15, '#1aaa80')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 4, 19, 4, '#2dd4a0'), drawLine(0, 5, 19, 5, '#1aaa80'), drawLine(0, 8, 19, 8, '#2dd4a0'), drawLine(0, 9, 19, 9, '#1aaa80'), drawLine(0, 12, 19, 12, '#2dd4a0'), drawLine(0, 13, 19, 13, '#1aaa80'), drawLine(0, 16, 19, 16, '#2dd4a0'), drawLine(0, 17, 19, 17, '#1aaa80')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 6, 19, 6, '#2dd4a0'), drawLine(0, 7, 19, 7, '#1aaa80'), drawLine(0, 10, 19, 10, '#2dd4a0'), drawLine(0, 11, 19, 11, '#1aaa80'), drawLine(0, 14, 19, 14, '#2dd4a0'), drawLine(0, 15, 19, 15, '#1aaa80')) },
      { durationBeats: 1, transition: 'fade', cells: mergeFrames(drawLine(0, 8, 19, 8, '#2dd4a0'), drawLine(0, 9, 19, 9, '#1aaa80'), drawLine(0, 12, 19, 12, '#2dd4a0'), drawLine(0, 13, 19, 13, '#1aaa80')) }
    ]
  },

  'star-explode': {
    name: 'Star Explode',
    bpm: 130,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: drawFilledCircle(10, 10, 1, '#ffdd00') },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(STAR_5PT, '#ffdd00', 0, 0), drawFilledCircle(10, 10, 2, '#ffffff')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawPixelShape(STAR_5PT, '#ffcc00', 0, 0), drawCircle(10, 10, 4, '#ffaa00')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawPixelShape(STAR_5PT, '#ffffff', 0, 0), drawFilledCircle(10, 10, 3, '#ffff00'), drawCircle(10, 10, 6, '#ffaa00')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(10, 10, 5, '#ffdd00'), drawCircle(10, 10, 7, '#ffaa00'), drawCircle(10, 10, 9, '#ff8800'), drawFilledCircle(3, 3, 2, '#ffdd00'), drawFilledCircle(17, 3, 2, '#ffdd00'), drawFilledCircle(3, 17, 2, '#ffdd00'), drawFilledCircle(17, 17, 2, '#ffdd00')) },
      { durationBeats: 1, transition: 'instant', cells: mergeFrames(drawCircle(10, 10, 8, '#ff6600'), drawCircle(10, 10, 6, '#ff8800'), drawFilledCircle(2, 2, 3, '#ffcc00'), drawFilledCircle(18, 2, 3, '#ffcc00'), drawFilledCircle(2, 18, 3, '#ffcc00'), drawFilledCircle(18, 18, 3, '#ffcc00')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawCircle(10, 10, 9, '#442200'), drawCircle(3, 3, 2, '#664400'), drawCircle(17, 3, 2, '#664400'), drawCircle(3, 17, 2, '#664400'), drawCircle(17, 17, 2, '#664400')) }
    ]
  },

  'text-touch': {
    name: 'TOUCH? Text',
    bpm: 100,
    frames: [
      { durationBeats: 4, transition: 'fade', cells: mergeFrames(
        drawPixelShape(LETTER_T, '#ff6b35', 1, 3),
        drawPixelShape(LETTER_O, '#ff8855', 7, 3),
        drawPixelShape(LETTER_U, '#ffaa66', 13, 3)
      )},
      { durationBeats: 4, transition: 'fade', cells: mergeFrames(
        drawPixelShape(LETTER_C, '#ff6b35', 1, 11),
        drawPixelShape(LETTER_H, '#ff8855', 7, 11),
        drawPixelShape(LETTER_Q, '#ffaa66', 13, 11)
      )},
      { durationBeats: 4, transition: 'fade', cells: mergeFrames(
        drawPixelShape(LETTER_T, '#ff6b35', 1, 3),
        drawPixelShape(LETTER_O, '#ff8855', 7, 3),
        drawPixelShape(LETTER_U, '#ffaa66', 13, 3),
        drawPixelShape(LETTER_C, '#ff6b35', 1, 11),
        drawPixelShape(LETTER_H, '#ff8855', 7, 11),
        drawPixelShape(LETTER_Q, '#ffaa66', 13, 11)
      )},
      { durationBeats: 2, transition: 'instant', cells: mergeFrames(
        drawPixelShape(LETTER_T, '#ffffff', 1, 3),
        drawPixelShape(LETTER_O, '#ffffff', 7, 3),
        drawPixelShape(LETTER_U, '#ffffff', 13, 3),
        drawPixelShape(LETTER_C, '#ffffff', 1, 11),
        drawPixelShape(LETTER_H, '#ffffff', 7, 11),
        drawPixelShape(LETTER_Q, '#ffffff', 13, 11),
        fillGrid('#331100')
      )},
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(
        drawPixelShape(LETTER_T, '#ff6b35', 1, 3),
        drawPixelShape(LETTER_O, '#ff8855', 7, 3),
        drawPixelShape(LETTER_U, '#ffaa66', 13, 3),
        drawPixelShape(LETTER_C, '#ff6b35', 1, 11),
        drawPixelShape(LETTER_H, '#ff8855', 7, 11),
        drawPixelShape(LETTER_Q, '#ffaa66', 13, 11)
      )}
    ]
  },

  'lantern-float': {
    name: 'Lanterns',
    bpm: 88,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 17, 2, '#ff6432'), drawFilledCircle(10, 18, 2, '#ff7744'), drawFilledCircle(16, 17, 2, '#ff6432'), drawFilledCircle(7, 16, 1, '#ff5522')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 14, 2, '#ff6432'), drawFilledCircle(10, 15, 2, '#ff7744'), drawFilledCircle(16, 14, 2, '#ff6432'), drawFilledCircle(7, 13, 1, '#ff5522'), drawFilledCircle(13, 16, 1, '#ff8855')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 11, 2, '#ff8855'), drawFilledCircle(10, 12, 2, '#ff9966'), drawFilledCircle(16, 11, 2, '#ff8855'), drawFilledCircle(7, 10, 1, '#ff7744'), drawFilledCircle(13, 13, 1, '#ffaa77')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 8, 2, '#ffaa77'), drawFilledCircle(10, 9, 2, '#ffbb88'), drawFilledCircle(16, 8, 2, '#ffaa77'), drawFilledCircle(7, 7, 1, '#ff9966'), drawFilledCircle(13, 10, 1, '#ffcc99')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 5, 2, '#ffcc99'), drawFilledCircle(10, 6, 2, '#ffddaa'), drawFilledCircle(16, 5, 2, '#ffcc99'), drawFilledCircle(7, 4, 1, '#ffbb88'), drawFilledCircle(13, 7, 1, '#ffddbb')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawFilledCircle(4, 2, 2, '#ffddbb'), drawFilledCircle(10, 3, 2, '#ffeecc'), drawFilledCircle(16, 2, 2, '#ffddbb'), drawFilledCircle(7, 1, 1, '#ffccaa'), drawFilledCircle(13, 4, 1, '#ffeecc')) }
    ]
  },

  'dna-helix': {
    name: 'DNA Helix',
    bpm: 100,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(5, 0, 15, 19, '#7c6aef'), drawLine(15, 0, 5, 19, '#b8a8ff'), drawFilledCircle(10, 10, 1, '#ffffff'), drawFilledCircle(5, 0, 1, '#7c6aef'), drawFilledCircle(15, 0, 1, '#b8a8ff')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(3, 0, 17, 19, '#7c6aef'), drawLine(17, 0, 3, 19, '#b8a8ff'), drawFilledCircle(10, 10, 1, '#ffffff'), drawLine(7, 5, 13, 5, '#9988ee'), drawLine(8, 15, 12, 15, '#9988ee')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(2, 0, 18, 19, '#7c6aef'), drawLine(18, 0, 2, 19, '#b8a8ff'), drawLine(5, 3, 15, 3, '#9988ee'), drawLine(6, 7, 14, 7, '#9988ee'), drawLine(7, 11, 13, 11, '#9988ee'), drawLine(8, 15, 12, 15, '#9988ee')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(4, 0, 16, 19, '#7c6aef'), drawLine(16, 0, 4, 19, '#b8a8ff'), drawLine(6, 4, 14, 4, '#9988ee'), drawLine(7, 8, 13, 8, '#9988ee'), drawLine(8, 12, 12, 12, '#9988ee'), drawLine(9, 16, 11, 16, '#9988ee'), drawFilledCircle(10, 0, 1, '#ffffff'), drawFilledCircle(10, 19, 1, '#ffffff')) }
    ]
  },

  'wave-ocean': {
    name: 'Ocean Wave',
    bpm: 92,
    frames: [
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 16, 19, 14, '#0096c8'), drawLine(0, 17, 19, 15, '#0078a8'), drawLine(0, 18, 19, 16, '#005a8a'), drawLine(0, 19, 19, 17, '#003c6a')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 14, 19, 11, '#0096c8'), drawLine(0, 15, 19, 12, '#0078a8'), drawLine(0, 16, 19, 14, '#005a8a'), drawLine(0, 17, 19, 15, '#003c6a'), drawLine(0, 18, 19, 17, '#002244')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 11, 19, 8, '#00b4d8'), drawLine(0, 12, 19, 9, '#0096c8'), drawLine(0, 14, 19, 11, '#0078a8'), drawLine(0, 15, 19, 12, '#005a8a'), drawLine(0, 17, 19, 14, '#003c6a'), drawLine(0, 18, 19, 16, '#002244')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 8, 19, 5, '#00d4f8'), drawLine(0, 9, 19, 6, '#00b4d8'), drawLine(0, 11, 19, 8, '#0096c8'), drawLine(0, 13, 19, 10, '#0078a8'), drawLine(0, 15, 19, 12, '#005a8a'), drawLine(0, 17, 19, 14, '#003c6a')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 5, 19, 2, '#00d4f8'), drawLine(0, 6, 19, 3, '#00b4d8'), drawLine(0, 8, 19, 5, '#0096c8'), drawLine(0, 10, 19, 7, '#0078a8'), drawLine(0, 13, 19, 10, '#005a8a'), drawLine(0, 16, 19, 13, '#003c6a'), drawFilledCircle(10, 1, 1, '#ffffff')) },
      { durationBeats: 2, transition: 'fade', cells: mergeFrames(drawLine(0, 8, 19, 5, '#00b4d8'), drawLine(0, 10, 19, 7, '#0096c8'), drawLine(0, 13, 19, 10, '#0078a8'), drawLine(0, 16, 19, 13, '#005a8a'), drawLine(0, 18, 19, 16, '#003c6a')) }
    ]
  }
};

// ══════════════════════════════════════════════════════════════

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
