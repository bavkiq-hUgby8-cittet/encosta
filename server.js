const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Payment, Preference, OAuth } = require('mercadopago');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Firebase Admin SDK ──
const FIREBASE_SA = process.env.FIREBASE_SERVICE_ACCOUNT;
if (FIREBASE_SA) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SA)) });
} else {
  // Fallback: local service account file
  const saPath = path.join(__dirname, 'firebase-sa.json');
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
  } else {
    console.warn('⚠️ Firebase não configurado. Rodando sem persistência.');
    admin.initializeApp({ projectId: 'encosta-f32e7' });
  }
}
const firestore = admin.firestore();
const firebaseAuth = admin.auth();

// ── Database (in-memory cache synced with Firestore) ──
const DB_COLLECTIONS = ['users', 'sessions', 'relations', 'messages', 'encounters', 'gifts', 'declarations', 'events', 'checkins', 'tips', 'streaks', 'locations', 'revealRequests', 'likes', 'starDonations', 'operatorEvents'];
let db = {};
DB_COLLECTIONS.forEach(c => db[c] = {});
let dbLoaded = false;
let savePending = false;
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

async function loadDB() {
  try {
    // Try Firestore first
    const doc = await firestore.collection('app').doc('state').get();
    if (doc.exists) {
      const data = doc.data();
      DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
      console.log('✅ DB carregado do Firestore');
    } else {
      // Fallback: try local db.json (migration)
      const DB_FILE = path.join(__dirname, 'db.json');
      if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
        // Migrate to Firestore
        await saveDBToFirestore();
        console.log('✅ DB migrado de db.json para Firestore');
      } else {
        console.log('📦 DB novo criado');
      }
    }
    dbLoaded = true;
    initRegistrationCounter();
  } catch (e) {
    console.error('Erro ao carregar DB:', e.message);
    // Fallback local
    const DB_FILE = path.join(__dirname, 'db.json');
    try {
      if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        DB_COLLECTIONS.forEach(c => { db[c] = data[c] || {}; });
      }
    } catch (e2) { /* start fresh */ }
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
}

async function saveDBToFirestore() {
  try {
    const payload = {};
    DB_COLLECTIONS.forEach(c => { payload[c] = db[c] || {}; });
    await firestore.collection('app').doc('state').set(payload, { merge: true });
  } catch (e) {
    console.error('Erro ao salvar no Firestore:', e.message);
    // Fallback: save locally
    try { fs.writeFileSync(path.join(__dirname, 'db.json'), JSON.stringify(db), 'utf8'); } catch (e2) {}
  }
}

function saveDB() {
  // Debounced save: batch writes within 2 seconds
  savePending = true;
  if (!saveTimer) {
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (savePending) {
        savePending = false;
        await saveDBToFirestore();
      }
    }, 2000);
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

// ── Link Firebase Auth UID to ENCOSTA user ──
app.post('/api/auth/link', async (req, res) => {
  const { firebaseUid, email, displayName, photoURL, encUserId } = req.body;
  if (!firebaseUid) return res.status(400).json({ error: 'Firebase UID obrigatório.' });

  // Check if firebase user already linked to an ENCOSTA user
  let existingUser = Object.values(db.users).find(u => u.firebaseUid === firebaseUid);
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
    saveDB();
    return res.json({ userId: user.id, user, linked: true });
  }

  // Create new ENCOSTA user from Firebase auth
  const id = uuidv4();
  const nick = (displayName || email?.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20) || 'user' + Math.floor(Math.random() * 9999);
  // Ensure unique nickname
  let finalNick = nick;
  let suffix = 1;
  while (Object.values(db.users).some(u => u.nickname && u.nickname.toLowerCase() === finalNick.toLowerCase())) {
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
  saveDB();
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
  saveDB();
}, 60000);

// ── PHRASES BANK ──
const PHRASES = {
  amizade: [
    "Presença aceita.",
    "Dois mundos, um gesto.",
    "Sem esforço. Só verdade.",
    "Afinidade instantânea.",
    "Conforto raro. Aproveitem.",
    "Amizade sem introdução.",
    "Se reconheceram de primeira.",
    "Isso não se planeja.",
    "O silêncio já basta.",
    "Encontro que já valeu.",
    "Dois estranhos a menos.",
    "Sintonia no improviso.",
    "O gesto disse tudo.",
    "Conexão sem filtro.",
    "O acaso acertou.",
  ],
  interesse: [
    "O ar mudou.",
    "Algo começou aqui.",
    "Antes e depois.",
    "Gravidade entre dois.",
    "Tensão bonita.",
    "Química de surpresa.",
    "Impossível ignorar.",
    "O toque ficou.",
    "Curiosidade recíproca.",
    "O primeiro gesto.",
    "Fio invisível.",
    "Coragem de continuar.",
    "Olharam e souberam.",
    "Isso vai ecoar.",
    "Começo de tudo.",
  ],
  profissional: [
    "A peça que faltava.",
    "Mentes em sincronia.",
    "Potencial detectado.",
    "Conexão com propósito.",
    "Visões que se somam.",
    "Sinergia imediata.",
    "O próximo passo.",
    "Respeito mútuo.",
    "Energia que gera.",
    "Complementares.",
    "Encontro com futuro.",
    "Ideias em colisão.",
    "Parceria inesperada.",
    "Resultado no ar.",
    "Juntos vão mais longe.",
  ],
  criativo: [
    "Paletas misturadas.",
    "Faísca criativa.",
    "Cor e textura.",
    "Fora da caixa, juntos.",
    "Inspiração mútua.",
    "Frequência rara.",
    "Colisão de ideias.",
    "Criatividade contagiosa.",
    "Dois universos, uma porta.",
    "Tela em branco, a dois.",
    "Cores diferentes, funcionam.",
    "Invenção no ar.",
    "Energia que cria.",
    "Imaginação dobrada.",
    "O improviso acendeu.",
  ]
};

const ALL_PHRASES = [...PHRASES.amizade, ...PHRASES.interesse, ...PHRASES.profissional, ...PHRASES.criativo];
function randomPhrase() { return ALL_PHRASES[Math.floor(Math.random() * ALL_PHRASES.length)]; }
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

// Helper: record encounter trace
function recordEncounter(userAId, userBId, phrase, type = 'physical', relationId = null) {
  const uA = db.users[userAId], uB = db.users[userBId];
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const encA = (db.encounters[userAId] || []).filter(e => e.with === userBId);
  const isRePre = encA.length > 0;
  const pointTypePre = isRePre ? 're_' + type : type;
  const pts = POINT_VALUES[pointTypePre] || POINT_VALUES[type] || 1;
  const trace = { with: userBId, withName: uB?.nickname || uB?.name || '?', withColor: uB?.color, phrase, timestamp: now, date: today, type, points: pts, chatDurationH: 24, relationId };
  const traceB = { with: userAId, withName: uA?.nickname || uA?.name || '?', withColor: uA?.color, phrase, timestamp: now, date: today, type, points: pts, chatDurationH: 24, relationId };
  if (!db.encounters[userAId]) db.encounters[userAId] = [];
  if (!db.encounters[userBId]) db.encounters[userBId] = [];
  db.encounters[userAId].push(trace);
  db.encounters[userBId].push(traceB);
  // Award score points
  awardPoints(userAId, userBId, type);
  // Update streaks
  updateStreak(userAId, userBId, today);
  // Check star eligibility (streak + milestone)
  checkStarEligibility(userAId, userBId);
}

// ── SCORING SYSTEM ──
// Points decay over 30 days. Each point has a timestamp.
// Score = sum of all points weighted by freshness.
const POINT_DECAY_DAYS = 30;
const POINT_VALUES = { physical: 3, digital: 1, re_physical: 5, re_digital: 2, gift: 1, declaration: 2 };

function awardPoints(userAId, userBId, type) {
  const now = Date.now();
  if (!db.users[userAId]) return;
  if (!db.users[userBId]) return;
  // Check if re-encounter (met this person before)
  const encA = (db.encounters[userAId] || []).filter(e => e.with === userBId);
  const isRe = encA.length > 1; // >1 because current encounter already recorded
  const pointType = isRe ? 're_' + type : type;
  const value = POINT_VALUES[pointType] || POINT_VALUES[type] || 1;
  // Store individual point entries with timestamps
  if (!db.users[userAId].pointLog) db.users[userAId].pointLog = [];
  if (!db.users[userBId].pointLog) db.users[userBId].pointLog = [];
  db.users[userAId].pointLog.push({ value, type: pointType, timestamp: now });
  db.users[userBId].pointLog.push({ value, type: pointType, timestamp: now });
}

function calcScore(userId) {
  const user = db.users[userId];
  if (!user || !user.pointLog) return 0;
  const now = Date.now();
  const decayMs = POINT_DECAY_DAYS * 86400000;
  let total = 0;
  for (const p of user.pointLog) {
    const age = now - p.timestamp;
    if (age >= decayMs) continue; // expired
    const weight = 1 - (age / decayMs); // 1.0 → 0.0 linear decay
    total += p.value * weight;
  }
  return Math.round(total * 10) / 10;
}

// Clean expired point entries periodically (within the existing cleanup interval)
function cleanExpiredPoints() {
  const cutoff = Date.now() - (POINT_DECAY_DAYS * 86400000);
  for (const user of Object.values(db.users)) {
    if (user.pointLog) {
      user.pointLog = user.pointLog.filter(p => p.timestamp > cutoff);
    }
  }
}

// ── STARS SYSTEM ──
// Stars are permanent. Earned organically or gifted.
function getStars(userId) {
  const user = db.users[userId];
  if (!user) return [];
  return user.stars || [];
}

// ══ STAR SYSTEM — Stars are EARNED then DONATED ══
// Earn conditions: (1) 5 encounters with same person in 5 consecutive days
//                  (2) every 100 unique new connections
// Stars must be donated to someone in the network to honor them.

function earnStarForUser(userId, reason, context = '') {
  const user = db.users[userId];
  if (!user) return;
  user.starsEarned = (user.starsEarned || 0) + 1;
  io.to(`user:${userId}`).emit('star-earned', { reason, context, totalEarned: user.starsEarned });
  saveDB();
}

function checkStarEligibility(userAId, userBId) {
  const userA = db.users[userAId];
  const userB = db.users[userBId];
  if (!userA || !userB) return;
  // Check streak-based star: 5 encounters with same person in 5 consecutive days
  const key = [userAId, userBId].sort().join('_');
  const streak = db.streaks[key];
  if (streak && streak.currentStreak >= 5 && streak.currentStreak % 5 === 0) {
    const tag = `streak5_${key}_${streak.currentStreak}`;
    if (!userA._starTags) userA._starTags = [];
    if (!userB._starTags) userB._starTags = [];
    if (!userA._starTags.includes(tag)) { userA._starTags.push(tag); earnStarForUser(userAId, 'streak', `${streak.currentStreak} dias com ${userB.nickname}`); }
    if (!userB._starTags.includes(tag)) { userB._starTags.push(tag); earnStarForUser(userBId, 'streak', `${streak.currentStreak} dias com ${userA.nickname}`); }
  }
  // Check milestone-based star: every 100 unique connections
  [userAId, userBId].forEach(uid => {
    const u = db.users[uid];
    const uniqueConnections = new Set((db.encounters[uid] || []).map(e => e.with)).size;
    u.touchers = uniqueConnections;
    const milestonesHit = Math.floor(uniqueConnections / 100);
    const currentMilestoneStars = (u._milestone100Stars || 0);
    if (milestonesHit > currentMilestoneStars) {
      u._milestone100Stars = milestonesHit;
      earnStarForUser(uid, 'milestone', `${uniqueConnections} conexões únicas`);
    }
  });
}

// Backward compat wrapper (old code calls this)
function awardStar(userId, reason, fromUserId = null) {
  earnStarForUser(userId, reason, fromUserId ? `de ${db.users[fromUserId]?.nickname}` : '');
}

// ── STREAK SYSTEM ──
// Tracks consecutive days two people encosta together
function updateStreak(userAId, userBId, today) {
  if (!db.streaks) db.streaks = {};
  const key = [userAId, userBId].sort().join('_');
  if (!db.streaks[key]) db.streaks[key] = { users: [userAId, userBId], currentStreak: 0, bestStreak: 0, lastDate: null, history: [], unlocks: [] };
  const s = db.streaks[key];
  if (s.lastDate === today) return; // already counted today
  // Check if consecutive
  if (s.lastDate) {
    const last = new Date(s.lastDate);
    const now = new Date(today);
    const diff = Math.round((now - last) / 86400000);
    if (diff === 1) {
      s.currentStreak += 1;
    } else {
      s.currentStreak = 1; // reset
    }
  } else {
    s.currentStreak = 1;
  }
  s.lastDate = today;
  if (s.currentStreak > s.bestStreak) s.bestStreak = s.currentStreak;
  s.history.push({ date: today, streak: s.currentStreak });
  // Check for star awards (every 5 days = 1 star)
  checkStreakStars(key, userAId, userBId);
  saveDB();
}

// ── STAR SYSTEM: every 5 encounters on different days = 1 star ──
function checkStreakStars(key, userAId, userBId) {
  const s = db.streaks[key];
  if (!s) return;
  // Count how many stars they should have earned from days together
  const totalDays = s.currentStreak; // consecutive days
  const starsEarned = Math.floor(totalDays / 5);
  const prevStars = s._starsAwarded || 0;
  if (starsEarned > prevStars) {
    // Award new stars
    for (let i = prevStars; i < starsEarned; i++) {
      awardStar(userAId, 'streak', userBId);
      awardStar(userBId, 'streak', userAId);
    }
    s._starsAwarded = starsEarned;
    // Notify both users
    const payload = {
      streakDays: totalDays,
      starsTotal: starsEarned,
      newStar: true,
      unlock: { label: '⭐ Nova estrela!', description: totalDays + ' dias juntos = ' + starsEarned + ' estrela' + (starsEarned > 1 ? 's' : '') }
    };
    io.to(`user:${userAId}`).emit('streak-unlock', payload);
    io.to(`user:${userBId}`).emit('streak-unlock', payload);
  }
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
    saveDB();
  }
  const baseUrl = req.protocol + '://' + req.get('host');
  res.json({ touchCode: user.touchCode, url: baseUrl + '/t/' + user.touchCode, nfcUrl: baseUrl + '/t/' + user.touchCode });
});

// Touch link page — serves the web experience for NFC/QR scan
app.get('/t/:code', (req, res) => {
  const code = req.params.code;
  const owner = Object.values(db.users).find(u => u.touchCode === code);
  if (!owner) return res.status(404).send('Link inválido.');
  // Serve a lightweight touch page
  res.send(generateTouchPage(owner, code));
});

// Touch link action — when visitor submits their name on the touch page
app.post('/api/touch-link/connect', (req, res) => {
  const { touchCode, visitorNickname } = req.body;
  if (!touchCode || !visitorNickname) return res.status(400).json({ error: 'Dados inválidos.' });
  const owner = Object.values(db.users).find(u => u.touchCode === touchCode);
  if (!owner) return res.status(404).json({ error: 'Código inválido.' });
  const nick = visitorNickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname: 2 a 20 caracteres.' });
  // Check if visitor already exists
  let visitor = Object.values(db.users).find(u => u.nickname && u.nickname.toLowerCase() === nick.toLowerCase());
  if (!visitor) {
    // Create temporary visitor account
    const id = uuidv4();
    const color = nickColor(nick);
    visitor = { id, nickname: nick, name: nick, birthdate: null, avatar: null, color, createdAt: Date.now(), points: 0, pointLog: [], stars: [], isGuest: true };
    db.users[id] = visitor;
  }
  if (visitor.id === owner.id) return res.status(400).json({ error: 'Não pode dar touch em si mesmo.' });
  // Create relation
  const now = Date.now();
  const phrase = randomPhrase();
  const relationId = uuidv4();
  // Check existing
  const existing = Object.values(db.relations).find(r =>
    ((r.userA === owner.id && r.userB === visitor.id) || (r.userA === visitor.id && r.userB === owner.id)) && r.expiresAt > now
  );
  let expiresAt;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = phrase;
    existing.renewed = (existing.renewed || 0) + 1;
    expiresAt = existing.expiresAt;
    res.json({ relationId: existing.id, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, renewed: true });
  } else {
    db.relations[relationId] = { id: relationId, userA: owner.id, userB: visitor.id, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null };
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
    res.json({ relationId, phrase, expiresAt, ownerName: owner.nickname, visitorId: visitor.id, renewed: false });
  }
  recordEncounter(owner.id, visitor.id, phrase, 'physical');
  saveDB();
  // Notify owner
  const signOwner = getZodiacSign(owner.birthdate);
  const signVisitor = getZodiacSign(visitor.birthdate);
  const zodiacPhrase = getZodiacPhrase(signOwner, signVisitor);
  const responseData = {
    relationId: existing ? existing.id : relationId, phrase, expiresAt, renewed: !!existing,
    userA: { id: owner.id, name: owner.nickname, realName: owner.realName || null, color: owner.color, profilePhoto: owner.profilePhoto || null, photoURL: owner.photoURL || null, score: calcScore(owner.id), stars: (owner.stars || []).length, sign: signOwner, signInfo: signOwner ? ZODIAC_INFO[signOwner] : null, isPrestador: !!owner.isPrestador, serviceLabel: owner.serviceLabel || '' },
    userB: { id: visitor.id, name: visitor.nickname, realName: visitor.realName || null, color: visitor.color, profilePhoto: visitor.profilePhoto || null, photoURL: visitor.photoURL || null, score: calcScore(visitor.id), stars: (visitor.stars || []).length, sign: signVisitor, signInfo: signVisitor ? ZODIAC_INFO[signVisitor] : null, isPrestador: !!visitor.isPrestador, serviceLabel: visitor.serviceLabel || '' },
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
  const taken = Object.values(db.users).some(u => u.nickname && u.nickname.toLowerCase() === nick);
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
    const taken = Object.values(db.users).some(u => u.id !== userId && u.nickname && u.nickname.toLowerCase() === nick.toLowerCase());
    if (taken) return res.status(400).json({ error: 'Esse nickname já existe.' });
    existing.nickname = nick;
    existing.name = existing.name || nick;
    existing.birthdate = birthdate;
    existing.color = existing.color || nickColor(nick);
    saveDB();
    return res.json({ userId, user: existing });
  }

  // Check uniqueness for new user
  const taken = Object.values(db.users).some(u => u.nickname && u.nickname.toLowerCase() === nick.toLowerCase());
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
  saveDB();
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
  saveDB();
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

  // Check renewal
  const existing = Object.values(db.relations).find(r =>
    ((r.userA === session.userA && r.userB === userId) || (r.userA === userId && r.userB === session.userA)) && r.expiresAt > now
  );

  let relationId, phrase, expiresAt;
  // Phrase: service/checkin get fixed phrases
  const getPhrase = () => {
    if (session.isCheckin) return 'Check-in realizado';
    if (session.isServiceTouch) return 'Serviço realizado';
    return randomPhrase();
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
    db.relations[relationId] = { id: relationId, userA: session.userA, userB: userId, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null };
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
  }

  // Record encounter trace
  const encounterType = session.isCheckin ? 'checkin' : (session.isServiceTouch ? 'service' : 'physical');
  recordEncounter(session.userA, userId, phrase, encounterType);
  session.relationId = relationId;
  saveDB();

  // Zodiac
  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const zodiacPhrase = getZodiacPhrase(signA, signB);
  const zodiacInfoA = signA ? ZODIAC_INFO[signA] : null;
  const zodiacInfoB = signB ? ZODIAC_INFO[signB] : null;

  const operatorUser = session.isCheckin ? db.users[session.operatorId] : null;
  const opRequireRevealJoin = operatorUser && operatorUser.operatorSettings && operatorUser.operatorSettings.requireReveal;
  const responseData = {
    relationId, phrase, expiresAt, renewed: !!existing,
    isServiceTouch: !!session.isServiceTouch,
    isCheckin: !!session.isCheckin,
    requireReveal: !!opRequireRevealJoin,
    operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
    userA: { id: userA.id, name: userA.nickname || userA.name, realName: userA.realName || null, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: zodiacInfoA, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '' },
    userB: { id: userB.id, name: userB.nickname || userB.name, realName: userB.realName || null, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: zodiacInfoB, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '' },
    zodiacPhrase
  };

  io.to(`session:${session.id}`).emit('relation-created', responseData);
  // Emit to operator if this is a checkin
  if (session.isCheckin && session.operatorId) {
    const opUser = db.users[session.operatorId];
    const visRevealed = !!(opUser && opUser.canSee && opUser.canSee[userId]);
    io.to(`user:${session.operatorId}`).emit('checkin-created', {
      userId, nickname: userB.nickname || userB.name, color: userB.color,
      profilePhoto: userB.profilePhoto || userB.photoURL || null,
      timestamp: now, relationId,
      revealed: visRevealed, revealData: visRevealed ? opUser.canSee[userId] : null
    });
  }
  res.json({ sessionId: session.id, ...responseData });
});

app.get('/api/relations/:userId', (req, res) => {
  const userId = req.params.userId, now = Date.now();
  const active = Object.values(db.relations).filter(r => (r.userA === userId || r.userB === userId) && r.expiresAt > now);
  const results = active.map(r => {
    const pid = r.userA === userId ? r.userB : r.userA, p = db.users[pid];
    const me = db.users[userId];
    // UNILATERAL: canSee check
    const isRevealed = !!(me?.canSee?.[pid]); // I can see them (they revealed to me)
    const iRevealed = !!(p?.canSee?.[userId]); // They can see me (I revealed to them)
    // Get last message time and unread count for this relation
    const msgs = db.messages[r.id] || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMessageTime = lastMsg ? lastMsg.timestamp : r.createdAt || 0;
    // For event relations, show event name as partner
    const isEvent = !!r.eventId;
    const evObj = isEvent ? db.operatorEvents[r.eventId] : null;
    return { ...r,
      partnerName: isEvent ? (evObj?.name || r.eventName || 'Evento') : (p?.nickname || p?.name || '?'),
      partnerColor: isEvent ? '#60a5fa' : (p?.color || '#ff6b35'),
      timeLeft: r.expiresAt - now,
      partnerPhoto: isEvent ? null : (isRevealed ? (p?.profilePhoto || p?.photoURL || null) : null),
      partnerRealName: isEvent ? null : (isRevealed ? (p?.realName || null) : null),
      partnerNickname: isEvent ? (evObj?.name || 'Evento') : (p?.nickname || '?'),
      iRevealedToPartner: !!iRevealed,
      partnerRevealedToMe: isEvent ? false : !!isRevealed,
      isEvent,
      eventId: r.eventId || null,
      eventName: isEvent ? (evObj?.name || r.eventName || null) : null,
      lastMessageTime,
      lastMessagePreview: lastMsg ? (lastMsg.type === 'ephemeral' ? '✨ ' + (lastMsg.text || '').slice(0, 40) : (lastMsg.text || '').slice(0, 40)) : null,
      lastMessageUserId: lastMsg ? lastMsg.userId : null
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
    return { ...e, realName: isRevealed ? (other?.realName || null) : null, profilePhoto: isRevealed ? (other?.profilePhoto || other?.photoURL || null) : null };
  });
  res.json(enriched); // newest first
});

// Delete a specific encounter entry
app.delete('/api/encounters/:userId/:timestamp', (req, res) => {
  const userId = req.params.userId;
  const ts = parseInt(req.params.timestamp);
  if (!db.encounters[userId]) return res.json({ ok: true });
  db.encounters[userId] = db.encounters[userId].filter(e => e.timestamp !== ts);
  saveDB();
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
  if (!list.length) return res.json({ nodes: [], total: 0 });
  // Group by person
  const byPerson = {};
  list.forEach(e => {
    if (!byPerson[e.with]) byPerson[e.with] = { id: e.with, nickname: e.withName || '?', color: e.withColor || null, encounters: 0, firstDate: e.timestamp, lastDate: e.timestamp, tipsGiven: 0, tipsTotal: 0, lastSelfie: null };
    byPerson[e.with].encounters++;
    if (e.tipAmount && e.tipStatus === 'approved') { byPerson[e.with].tipsGiven++; byPerson[e.with].tipsTotal += e.tipAmount; }
    if (e.timestamp < byPerson[e.with].firstDate) byPerson[e.with].firstDate = e.timestamp;
    if (e.timestamp > byPerson[e.with].lastDate) byPerson[e.with].lastDate = e.timestamp;
  });
  // Enrich with selfie from last relation and real identity if revealed
  Object.values(byPerson).forEach(p => {
    // Find last relation between these two to get selfie
    const rels = Object.values(db.relations).filter(r =>
      (r.userA === req.params.userId && r.userB === p.id) || (r.userA === p.id && r.userB === req.params.userId)
    ).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (rels.length > 0 && rels[0].selfie) {
      // Get the other person's selfie
      p.lastSelfie = rels[0].selfie[p.id] || null;
    }
    const other = db.users[p.id];
    if (other) {
      // If user has revealed real identity, use real name/photo
      p.realName = other.realName || null;
      p.profilePhoto = other.profilePhoto || other.photoURL || null;
      p.revealedTo = other.revealedTo || [];
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
      hasActiveRelation: !!Object.values(db.relations).find(r => ((r.userA === req.params.userId && r.userB === p.id) || (r.userA === p.id && r.userB === req.params.userId)) && r.expiresAt > Date.now()),
      // New fields
      topTag: (other && other.topTag) || null,
      touchers: toucherCount,
      likesCount: iCanSeeThem ? (other.likesCount || 0) : 0,
      starsCount: (other && other.stars) ? other.stars.length : 0,
      likedByMe: !!(other && other.likedBy && other.likedBy.includes(req.params.userId)),
      isPrestador: !!(other && other.isPrestador),
      serviceLabel: (other && other.serviceLabel) || null,
      pendingReveal: (() => {
        const pr = Object.values(db.revealRequests).find(rr => rr.status === 'pending' && ((rr.fromUserId === req.params.userId && rr.toUserId === p.id) || (rr.fromUserId === p.id && rr.toUserId === req.params.userId)));
        if (!pr) return null;
        return pr.fromUserId === req.params.userId ? 'sent' : 'received';
      })()
    };
  });
  // Add event nodes — events the user participated in
  const eventNodes = Object.values(db.operatorEvents).filter(ev => ev.participants && ev.participants.includes(req.params.userId)).map(ev => {
    const lastRel = Object.values(db.relations).find(r => r.eventId === ev.id && (r.userA === req.params.userId || r.userB === req.params.userId));
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
      isPrestador: false, serviceLabel: null, pendingReveal: null,
      eventActive: ev.active, eventParticipants: (ev.participants || []).length
    };
  });
  nodes.push(...eventNodes);
  // Sort by most recent encounter
  nodes.sort((a, b) => b.lastDate - a.lastDate);
  res.json({ nodes, total: nodes.length });
});

// Score — calculated with decay
app.get('/api/points/:userId', (req, res) => {
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
app.get('/api/notifications/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const notifs = [];
  // 1. Who liked me (from likedBy array)
  (user.likedBy || []).forEach(likerId => {
    const liker = db.users[likerId];
    if (!liker) return;
    const iCanSee = user.canSee && user.canSee[likerId];
    notifs.push({
      type: 'like',
      fromId: likerId,
      nickname: liker.nickname || liker.name,
      realName: iCanSee ? (liker.realName || null) : null,
      profilePhoto: iCanSee ? (liker.profilePhoto || liker.photoURL || null) : null,
      color: liker.color,
      timestamp: Date.now()
    });
  });
  // 2. Stars received
  (user.stars || []).forEach(star => {
    const giver = db.users[star.from];
    if (!giver) return;
    const iCanSee = user.canSee && user.canSee[star.from];
    notifs.push({
      type: 'star',
      fromId: star.from,
      nickname: giver.nickname || giver.name,
      realName: iCanSee ? (giver.realName || null) : null,
      profilePhoto: iCanSee ? (giver.profilePhoto || giver.photoURL || null) : null,
      color: giver.color,
      timestamp: star.at || Date.now()
    });
  });
  // 3. Reveal requests received (pending)
  Object.values(db.revealRequests || {}).forEach(rr => {
    if (rr.toUserId === userId && rr.status === 'pending') {
      const from = db.users[rr.fromUserId];
      if (!from) return;
      notifs.push({
        type: 'reveal-request',
        fromId: rr.fromUserId,
        nickname: from.nickname || from.name,
        color: from.color,
        requestId: rr.id,
        timestamp: rr.createdAt || Date.now()
      });
    }
  });
  // 4. Friends who earned stars (someone I've encountered got a star)
  const myEncounters = db.encounters[userId] || [];
  const myFriendIds = [...new Set(myEncounters.map(e => e.with))];
  myFriendIds.forEach(fid => {
    const friend = db.users[fid];
    if (!friend || !friend.stars || !friend.stars.length) return;
    const iCanSee = user.canSee && user.canSee[fid];
    // Show last 3 stars from each friend (recent ones)
    friend.stars.slice(-3).forEach(star => {
      if (star.from === userId) return; // skip my own stars to them
      notifs.push({
        type: 'friend-star',
        fromId: fid,
        nickname: friend.nickname || friend.name,
        realName: iCanSee ? (friend.realName || null) : null,
        profilePhoto: iCanSee ? (friend.profilePhoto || friend.photoURL || null) : null,
        color: friend.color,
        topTag: friend.topTag || null,
        timestamp: star.at || Date.now()
      });
    });
  });
  // 5. People who revealed to me (canSee entries)
  Object.entries(user.canSee || {}).forEach(([pid, data]) => {
    const p = db.users[pid];
    if (!p) return;
    notifs.push({
      type: 'identity-revealed',
      fromId: pid,
      nickname: p.nickname || p.name,
      realName: data.realName || null,
      profilePhoto: data.profilePhoto || null,
      color: p.color,
      timestamp: data.revealedAt || Date.now()
    });
  });
  // Sort by timestamp desc
  notifs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ notifications: notifs.slice(0, 50) });
});

// Selfie for relation
app.post('/api/selfie/:relationId', (req, res) => {
  const { userId, selfieData } = req.body;
  const rel = db.relations[req.params.relationId];
  if (!rel || Date.now() > rel.expiresAt) return res.status(404).json({ error: 'Relação expirada.' });
  if (rel.userA !== userId && rel.userB !== userId) return res.status(403).json({ error: 'Sem permissão.' });
  if (!rel.selfie) rel.selfie = {};
  rel.selfie[userId] = selfieData; // store each user's consent/photo
  saveDB();
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
  saveDB();
  // If gift is a star, award a permanent star
  if (giftId === 'star') {
    awardStar(toUserId, 'gift', fromUserId);
    // Also award score points for gifting
    if (!db.users[fromUserId].pointLog) db.users[fromUserId].pointLog = [];
    db.users[fromUserId].pointLog.push({ value: POINT_VALUES.gift, type: 'gift', timestamp: Date.now() });
    saveDB();
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
  saveDB();
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
  db.users[fromUserId].pointLog.push({ value: POINT_VALUES.declaration, type: 'declaration', timestamp: Date.now() });
  saveDB();
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
  const hasRelation = Object.values(db.relations).some(r =>
    ((r.userA === req.params.userId && r.userB === viewerId) || (r.userA === viewerId && r.userB === req.params.userId)) && r.expiresAt > now
  );
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
    // Real identity if revealed
    realName: isRevealed ? (user.realName || null) : null,
    profilePhoto: isRevealed ? (user.profilePhoto || user.photoURL || null) : null,
    instagram: isRevealed ? (user.instagram || null) : null,
    bio: isRevealed ? (user.bio || null) : null
  });
});

// ── Update full profile ──
app.post('/api/profile/update', (req, res) => {
  const { userId, nickname, realName, phone, instagram, twitter, bio, profilePhoto } = req.body;
  if (!userId || !db.users[userId]) return res.status(400).json({ error: 'Usuário inválido.' });
  const user = db.users[userId];
  // Nickname change
  if (nickname !== undefined && nickname.trim()) {
    const newNick = nickname.trim();
    if (newNick.length < 2 || newNick.length > 20) return res.status(400).json({ error: 'Nickname: 2-20 caracteres.' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(newNick)) return res.status(400).json({ error: 'Nickname: só letras, números, _ . -' });
    const taken = Object.values(db.users).some(u => u.id !== userId && u.nickname && u.nickname.toLowerCase() === newNick.toLowerCase());
    if (taken) return res.status(400).json({ error: 'Esse nickname já existe.' });
    user.nickname = newNick;
    user.name = user.name === user.nickname ? newNick : user.name; // update name if it was same as nick
  }
  if (realName !== undefined && realName.trim()) {
    if (realName.trim().toLowerCase() === (user.nickname || '').toLowerCase()) {
      return res.status(400).json({ error: 'Seu nome real deve ser diferente do nickname. O nickname é seu apelido criativo!' });
    }
    user.realName = realName.trim();
  } else if (realName !== undefined) { user.realName = realName; }
  if (phone !== undefined) user.phone = phone;
  if (instagram !== undefined) user.instagram = instagram;
  if (twitter !== undefined) user.twitter = twitter;
  if (bio !== undefined) user.bio = bio;
  if (profilePhoto !== undefined) user.profilePhoto = profilePhoto; // base64
  user.profileComplete = !!(user.realName && (user.profilePhoto || user.photoURL));
  saveDB();
  res.json({ ok: true, user });
});

// ── Reveal Real ID — Centralized system ──
// Helper: find active relation between two users
function findActiveRelation(userIdA, userIdB) {
  const now = Date.now();
  return Object.values(db.relations).find(r =>
    ((r.userA === userIdA && r.userB === userIdB) || (r.userA === userIdB && r.userB === userIdA)) && r.expiresAt > now
  );
}
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
  saveDB();
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
  saveDB();
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
  saveDB();
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
  saveDB();
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
  saveDB();
  io.to(`user:${targetUserId}`).emit('like-toggled', { fromUserId: userId, liked, count: target.likesCount || 0 });
  res.json({ ok: true, liked, count: target.likesCount || 0 });
});

// ══ STAR DONATION SYSTEM ══
app.post('/api/star/donate', (req, res) => {
  const { fromUserId, toUserId } = req.body;
  if (!fromUserId || !db.users[fromUserId]) return res.status(400).json({ error: 'Usuário inválido.' });
  if (!toUserId || !db.users[toUserId]) return res.status(400).json({ error: 'Destinatário inválido.' });
  if (fromUserId === toUserId) return res.status(400).json({ error: 'Não pode doar estrela pra si mesmo.' });
  const fromUser = db.users[fromUserId];
  const toUser = db.users[toUserId];
  // Check available stars
  const totalEarned = (fromUser.starsEarned || 0);
  const totalDonated = Object.values(db.starDonations).filter(d => d.fromUserId === fromUserId).length;
  const available = totalEarned - totalDonated;
  if (available <= 0) return res.status(400).json({ error: 'Sem estrelas disponíveis para doar. Continue conectando para ganhar!' });
  // Create donation
  const donationId = uuidv4();
  db.starDonations[donationId] = { id: donationId, fromUserId, toUserId, timestamp: Date.now() };
  // Add star to recipient
  if (!toUser.stars) toUser.stars = [];
  toUser.stars.push({ id: donationId, from: fromUserId, fromName: fromUser.nickname, donatedAt: Date.now() });
  saveDB();
  io.to(`user:${toUserId}`).emit('star-received', { fromUserId, fromName: fromUser.nickname, total: toUser.stars.length });
  res.json({ ok: true, donationId, recipientStars: toUser.stars.length });
});

app.get('/api/stars/available/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  const totalEarned = user.starsEarned || 0;
  const totalDonated = Object.values(db.starDonations).filter(d => d.fromUserId === req.params.userId).length;
  res.json({ total: totalEarned, donated: totalDonated, available: totalEarned - totalDonated });
});

// ── Get own full profile data ──
app.get('/api/myprofile/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({
    nickname: user.nickname, realName: user.realName || '',
    phone: user.phone || '', instagram: user.instagram || '',
    twitter: user.twitter || '', bio: user.bio || '',
    profilePhoto: user.profilePhoto || user.photoURL || '', photoURL: user.photoURL || '', profileComplete: !!user.profileComplete,
    email: user.email || '',
    canSee: user.canSee || {}, isPrestador: !!user.isPrestador,
    starsEarned: user.starsEarned || 0, likesCount: user.likesCount || 0,
    topTag: user.topTag || null, registrationOrder: user.registrationOrder || 0
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
  saveDB();
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
      nearby.push({ id: uid, nickname: u.nickname || u.name, color: u.color, score: calcScore(uid), stars: (u.stars || []).length, distance: Math.round(dist) });
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
  db.events[id] = {
    id, code, name: name.trim(), description: (description || '').trim(),
    lat, lng, radius: radius || 200,
    creatorId: userId, creatorName: creator.nickname || creator.name, creatorColor: creator.color,
    startsAt: startsAt || Date.now(), endsAt: endsAt || (Date.now() + 86400000),
    participants: [userId],
    createdAt: Date.now()
  };
  saveDB();
  res.json({ event: db.events[id] });
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
  saveDB();
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
    return u ? { id: pid, nickname: u.nickname || u.name, color: u.color, profilePhoto: u.profilePhoto || null, photoURL: u.photoURL || null, score: calcScore(pid), stars: (u.stars || []).length } : null;
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
  const existing = Object.values(db.relations).find(r =>
    ((r.userA === fromUserId && r.userB === userId) || (r.userA === userId && r.userB === fromUserId)) && r.expiresAt > now
  );
  let relationId, phrase, expiresAt;
  if (existing) {
    existing.expiresAt = now + DIGITAL_DURATION;
    existing.phrase = randomPhrase();
    existing.renewed = (existing.renewed || 0) + 1;
    existing.provocations = {};
    relationId = existing.id; phrase = existing.phrase; expiresAt = existing.expiresAt;
  } else {
    phrase = randomPhrase();
    relationId = uuidv4();
    db.relations[relationId] = { id: relationId, userA: fromUserId, userB: userId, phrase, type: 'digital', createdAt: now, expiresAt: now + DIGITAL_DURATION, provocations: {}, renewed: 0, selfie: null, eventId };
    db.messages[relationId] = [];
    expiresAt = now + DIGITAL_DURATION;
  }
  // Find last encounter between these two
  const myEncounters = db.encounters[userId] || [];
  const lastEnc = myEncounters.filter(e => e.with === fromUserId).sort((a,b) => b.timestamp - a.timestamp)[0];
  recordEncounter(fromUserId, userId, phrase, 'digital');
  saveDB();
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
    saveDB();
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
app.post('/api/selfie', (req, res) => {
  const { relationId, userId, selfieData } = req.body;
  const rel = db.relations[relationId];
  if (!rel) return res.status(400).json({ error: 'Relação não encontrada.' });
  if (!rel.selfie) rel.selfie = {};
  rel.selfie[userId] = selfieData;
  saveDB();
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
  const userA = db.users[userIdA];
  const userB = db.users[userIdB];
  if (!userA || !userB) return;
  const now = Date.now();

  // Check if either user is in checkin or service mode (search by userId since operators use 'evt:' keys)
  const entryA = findSonicEntryByUserId(userIdA);
  const entryB = findSonicEntryByUserId(userIdB);
  const isCheckin = !!(entryA && entryA.isCheckin) || !!(entryB && entryB.isCheckin);
  const isServiceTouch = !!(entryA && entryA.isServiceTouch) || !!(entryB && entryB.isServiceTouch)
    || (userA.isPrestador && userA.serviceModeActive) || (userB.isPrestador && userB.serviceModeActive);
  const operatorId = isCheckin ? (entryA && entryA.isCheckin ? userIdA : userIdB) : null;
  const operatorEntry = operatorId ? (operatorId === userIdA ? entryA : entryB) : null;
  const eventId = operatorEntry ? operatorEntry.eventId : null;
  const serviceProviderId = isServiceTouch ? (entryA && entryA.isServiceTouch ? userIdA : (entryB && entryB.isServiceTouch ? userIdB : (userA.isPrestador ? userIdA : userIdB))) : null;

  const phrase = isCheckin ? 'Check-in realizado' : (isServiceTouch ? 'Serviço realizado' : randomPhrase());
  const encounterType = isCheckin ? 'checkin' : (isServiceTouch ? 'service' : 'physical');

  const existing = Object.values(db.relations).find(r =>
    ((r.userA === userIdA && r.userB === userIdB) || (r.userA === userIdB && r.userB === userIdA)) && r.expiresAt > now
  );
  let relationId, expiresAt;
  if (existing) {
    existing.expiresAt = now + 86400000;
    existing.phrase = phrase;
    existing.renewed = (existing.renewed || 0) + 1;
    relationId = existing.id;
    expiresAt = existing.expiresAt;
  } else {
    relationId = uuidv4();
    db.relations[relationId] = { id: relationId, userA: userIdA, userB: userIdB, phrase, createdAt: now, expiresAt: now + 86400000, provocations: {}, renewed: 0, selfie: null, eventId: eventId || null, eventName: (eventId && db.operatorEvents[eventId]) ? db.operatorEvents[eventId].name : null };
    db.messages[relationId] = [];
    expiresAt = now + 86400000;
  }
  recordEncounter(userIdA, userIdB, phrase, encounterType, relationId);
  saveDB();
  const signA = getZodiacSign(userA.birthdate);
  const signB = getZodiacSign(userB.birthdate);
  const zodiacPhrase = (isCheckin || isServiceTouch) ? null : getZodiacPhrase(signA, signB);
  const operatorUser = operatorId ? db.users[operatorId] : null;
  // Check if operator requires reveal
  const opRequireReveal = operatorUser && operatorUser.operatorSettings && operatorUser.operatorSettings.requireReveal;
  const eventObj = eventId ? db.operatorEvents[eventId] : null;
  const responseData = {
    relationId, phrase, expiresAt, renewed: !!existing,
    sonicMatch: true,
    isCheckin,
    isServiceTouch,
    eventId: eventId || null,
    eventName: eventObj ? eventObj.name : null,
    requireReveal: !!opRequireReveal,
    operatorName: operatorUser ? (operatorUser.nickname || operatorUser.name) : null,
    entryPrice: (eventObj && eventObj.entryPrice > 0) ? eventObj.entryPrice : 0,
    userA: { id: userA.id, name: userA.nickname || userA.name, color: userA.color, profilePhoto: userA.profilePhoto || null, photoURL: userA.photoURL || null, score: calcScore(userA.id), stars: (userA.stars || []).length, sign: signA, signInfo: signA ? ZODIAC_INFO[signA] : null, isPrestador: !!userA.isPrestador, serviceLabel: userA.serviceLabel || '' },
    userB: { id: userB.id, name: userB.nickname || userB.name, color: userB.color, profilePhoto: userB.profilePhoto || null, photoURL: userB.photoURL || null, score: calcScore(userB.id), stars: (userB.stars || []).length, sign: signB, signInfo: signB ? ZODIAC_INFO[signB] : null, isPrestador: !!userB.isPrestador, serviceLabel: userB.serviceLabel || '' },
    zodiacPhrase
  };
  // Clean both from queue (but NOT the operator — they stay for continuous check-ins)
  if (isCheckin && operatorId) {
    // Only remove the visitor, operator stays with same freq
    const visitorId = operatorId === userIdA ? userIdB : userIdA;
    delete sonicQueue[visitorId];
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
  io.to(`user:${userIdA}`).emit('relation-created', responseData);
  io.to(`user:${userIdB}`).emit('relation-created', responseData);
  // Emit sonic-matched so operator dashboard can re-register if needed
  io.to(`user:${userIdA}`).emit('sonic-matched', { withUser: userIdB });
  io.to(`user:${userIdB}`).emit('sonic-matched', { withUser: userIdA });
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
  saveDB();
  res.json({ ok: true, usersReset: count });
});

// ── DATABASE RESET ──
app.post('/api/admin/reset-db', (req, res) => {
  const { confirm, keepUsers } = req.body;
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Send { confirm: "RESET" } to confirm.' });
  const userCount = Object.keys(db.users).length;
  const relationCount = Object.keys(db.relations).length;
  const eventCount = Object.keys(db.events).length;
  const encounterCount = Object.keys(db.encounters).length;
  const msgCount = Object.keys(db.messages).length;
  if (keepUsers) {
    // Reset everything except users
    DB_COLLECTIONS.forEach(c => { if (c !== 'users') db[c] = {}; });
    // Clear user transient data but keep profiles
    Object.values(db.users).forEach(u => {
      u.stars = []; u.score = 0;
    });
  } else {
    DB_COLLECTIONS.forEach(c => { db[c] = {}; });
  }
  saveDB();
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
    saveDB();
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
    saveDB();
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
    saveDB();
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
    console.log('[sonic-detected] user:', userId, 'detected freq:', detectedFreq, '→ emitter:', emitter ? emitter.userId : 'NOT FOUND', '| queue:', Object.keys(sonicQueue).map(k => k.slice(0,8)+'..freq:'+sonicQueue[k].freq).join(', '));
    if (emitter && emitter.userId !== userId) {
      createSonicConnection(emitter.userId, userId);
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
    saveDB();
    return res.json({ userId: user.id, user });
  }

  // Otherwise create new user
  if (!nickname) return res.status(400).json({ error: 'Preencha o nickname.' });
  const nick = nickname.trim();
  if (nick.length < 2 || nick.length > 20) return res.status(400).json({ error: 'Nickname deve ter 2 a 20 caracteres.' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(nick)) return res.status(400).json({ error: 'Só letras, números, _ . -' });
  const taken = Object.values(db.users).some(u => u.nickname && u.nickname.toLowerCase() === nick.toLowerCase());
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
  saveDB();
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
      saveDB();
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
  const isOperatorWithTips = Object.values(db.operatorEvents).some(ev => ev.creatorId === receiverId && ev.acceptsTips);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });

  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100; // 10%

  const email = payerEmail || payer.email || 'test@testuser.com';
  const cpf = payerCPF || payer.cpf || '12345678909';

  // Validate MP credentials
  if (!MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN not configured!');
    return res.status(500).json({ error: 'Sistema de pagamento não configurado. Configure MP_ACCESS_TOKEN.' });
  }

  try {
    const paymentData = {
      transaction_amount: tipAmount,
      token,
      description: 'Gorjeta Touch? — ' + (receiver.serviceLabel || receiver.nickname || receiver.name),
      installments: installments || 1,
      payment_method_id: paymentMethodId || 'visa',
      payer: {
        email: email,
        identification: { type: 'CPF', number: cpf }
      },
      statement_descriptor: 'TOUCH GORJETA',
      metadata: { payer_id: payerId, receiver_id: receiverId, type: 'tip' }
    };

    console.log('💳 Processing payment:', { amount: tipAmount, method: paymentMethodId, email, receiverId, hasToken: !!token });

    // If receiver has MP OAuth, use split payment
    if (receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      const result = await receiverPayment.create({ body: paymentData });
      console.log('💳 Split payment result:', { id: result.id, status: result.status, detail: result.status_detail });
      return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
    } else {
      const result = await mpPayment.create({ body: paymentData });
      console.log('💳 Direct payment result:', { id: result.id, status: result.status, detail: result.status_detail });
      return handlePaymentResult(result, payerId, receiverId, tipAmount, touchFee, res);
    }
  } catch (e) {
    console.error('Payment error:', e.message, e.cause || '');
    const errMsg = e.message || 'tente novamente';
    // Provide more useful error messages
    if (errMsg.includes('token')) res.status(400).json({ error: 'Token do cartão inválido ou expirado. Tente novamente.' });
    else if (errMsg.includes('access_token') || errMsg.includes('401')) res.status(500).json({ error: 'Credenciais do Mercado Pago inválidas. Contate o suporte.' });
    else res.status(500).json({ error: 'Erro no pagamento: ' + errMsg });
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
  saveDB();
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
  const isOperatorWithTips = Object.values(db.operatorEvents).some(ev => ev.creatorId === receiverId && ev.acceptsTips);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Sistema de pagamento não configurado.' });

  const email = payerEmail || payer.email || 'payer@touch.app';
  const cpf = (payerCPF || payer.cpf || '').replace(/\D/g, '');
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
    saveDB();
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
  const isOperatorWithTips = Object.values(db.operatorEvents).some(ev => ev.creatorId === receiverId && ev.acceptsTips);
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
      payer: { email: payer.email || 'payer@touch.app' },
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
    saveDB();

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
    saveDB();
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
        saveDB();
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
        body: JSON.stringify({ email: user.email || userId + '@touch.app', first_name: user.name || user.nickname || 'Touch User' })
      });
      // If email already exists, search for existing customer
      if (custResp.status === 400) {
        const searchResp = await fetch('https://api.mercadopago.com/v1/customers/search?email=' + encodeURIComponent(user.email || userId + '@touch.app'), {
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
      email: email || user.email || userId + '@touch.app',
      cpf: cpf || user.cpf || '',
      savedAt: Date.now()
    };
    saveDB();
    console.log('💳 Card saved for user', userId, '- customer:', customerId, 'card:', cardData.id, 'last4:', cardData.last_four_digits);
    res.json({ ok: true, lastFour: cardData.last_four_digits, brand: user.savedCard.brand });
  } catch (e) {
    console.error('Save card error:', e);
    res.status(500).json({ error: 'Erro ao salvar cartão: ' + (e.message || 'tente novamente') });
  }
});

// ═══ ONE-TAP PAYMENT — Server-side saved card charge (no CVV needed) ═══
app.post('/api/tip/quick-pay', async (req, res) => {
  const { payerId, receiverId, amount } = req.body;
  if (!payerId || !receiverId || !amount) return res.status(400).json({ error: 'Dados incompletos.' });
  const payer = db.users[payerId];
  const receiver = db.users[receiverId];
  if (!payer) return res.status(404).json({ error: 'Pagador não encontrado.' });
  if (!payer.savedCard?.customerId || !payer.savedCard?.cardId) return res.status(400).json({ error: 'Nenhum cartão salvo.' });
  const isOperatorWithTips = Object.values(db.operatorEvents).some(ev => ev.creatorId === receiverId && ev.acceptsTips);
  if (!receiver || (!receiver.isPrestador && !isOperatorWithTips)) return res.status(400).json({ error: 'Destinatário não aceita gorjetas.' });
  const tipAmount = parseFloat(amount);
  if (tipAmount < 1 || tipAmount > 500) return res.status(400).json({ error: 'Valor entre R$1 e R$500.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });
  const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100;

  try {
    // 1. Verify the card still exists on MP
    const cardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + payer.savedCard.customerId + '/cards', {
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
    });
    if (!cardsResp.ok) {
      console.error('⚠️ Cards API error:', cardsResp.status, await cardsResp.text().catch(() => ''));
      delete payer.savedCard;
      saveDB();
      return res.status(400).json({ error: 'Cartão salvo não é mais válido. Cadastre novamente.', cardExpired: true });
    }
    const cards = await cardsResp.json();
    if (!Array.isArray(cards) || cards.length === 0) {
      console.error('⚠️ Cards API returned:', cards);
      delete payer.savedCard;
      saveDB();
      return res.status(400).json({ error: 'Cartão salvo expirou. Cadastre novamente.', cardExpired: true });
    }
    const card = cards.find(c => c.id === payer.savedCard.cardId) || cards[0];
    if (!card) {
      delete payer.savedCard;
      saveDB();
      return res.status(400).json({ error: 'Cartão não encontrado. Cadastre novamente.', cardExpired: true });
    }

    // 2. Create a card token server-side using the saved card
    const tokenResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: card.id, customer_id: payer.savedCard.customerId })
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.id) {
      console.error('⚠️ Token creation failed:', tokenData);
      return res.status(400).json({ error: 'Erro ao processar cartão salvo. Tente outro cartão.', cardExpired: true });
    }

    // 3. Create payment using the fresh token
    const paymentData = {
      transaction_amount: tipAmount,
      token: tokenData.id,
      payment_method_id: card.payment_method?.id || payer.savedCard.paymentMethodId || 'visa',
      installments: 1,
      payer: {
        email: payer.email || payer.savedCard.email || payerId + '@touch.app',
        identification: { type: 'CPF', number: payer.cpf || payer.savedCard.cpf || '00000000000' }
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
  saveDB();
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
    saveDB();
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
      payer_email: user.email || '',
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
    saveDB();

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
      if (user) user.isSubscriber = true;
      saveDB();
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
        }
        if (pa.status === 'cancelled') {
          sub.cancelledAt = Date.now();
        }
        saveDB();
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
    if (user) user.isSubscriber = false;
    saveDB();
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
  saveDB();
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
  saveDB();
  res.json({ event: db.operatorEvents[id] });
});

// ═══ PAY EVENT ENTRY — charge entry fee on check-in ═══
app.post('/api/operator/event/:eventId/pay-entry', async (req, res) => {
  const { userId, token, paymentMethodId, payerEmail, payerCPF, useSavedCard } = req.body;
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!ev.active) return res.status(400).json({ error: 'Evento encerrado.' });
  if (!ev.entryPrice || ev.entryPrice <= 0) return res.status(400).json({ error: 'Evento sem cobrança de ingresso.' });
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MP não configurado.' });

  const amount = ev.entryPrice;
  const touchFee = Math.round(amount * TOUCH_FEE_PERCENT) / 100;
  const receiver = db.users[ev.creatorId];

  try {
    let paymentToken = token;

    // One-tap: create token server-side from saved card
    if (useSavedCard && user.savedCard?.customerId && user.savedCard?.cardId) {
      const cardsResp = await fetch('https://api.mercadopago.com/v1/customers/' + user.savedCard.customerId + '/cards', {
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
      });
      const cards = await cardsResp.json();
      if (!Array.isArray(cards) || cards.length === 0) {
        delete user.savedCard; saveDB();
        return res.status(400).json({ error: 'Cartão salvo expirou.', cardExpired: true });
      }
      const card = cards.find(c => c.id === user.savedCard.cardId) || cards[0];
      const tokenResp = await fetch('https://api.mercadopago.com/v1/card_tokens', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: card.id, customer_id: user.savedCard.customerId })
      });
      const tokenData = await tokenResp.json();
      if (!tokenData.id) return res.status(400).json({ error: 'Erro ao processar cartão.', cardExpired: true });
      paymentToken = tokenData.id;
      // Use stored payment method
      var pmId = card.payment_method?.id || user.savedCard.paymentMethodId || 'visa';
    }

    const paymentData = {
      transaction_amount: amount,
      token: paymentToken,
      payment_method_id: pmId || paymentMethodId || 'visa',
      installments: 1,
      payer: {
        email: payerEmail || user.email || userId + '@touch.app',
        identification: { type: 'CPF', number: (payerCPF || user.cpf || user.savedCard?.cpf || '00000000000').replace(/\D/g, '') }
      },
      description: 'Ingresso Touch? — ' + ev.name,
      statement_descriptor: 'TOUCH INGRESSO',
      metadata: { payer_id: userId, event_id: ev.id, operator_id: ev.creatorId, type: 'entry' }
    };

    console.log('🎫 Entry payment:', { amount, event: ev.name, user: userId.slice(0, 8), method: paymentData.payment_method_id });

    let result;
    if (receiver && receiver.mpConnected && receiver.mpAccessToken) {
      paymentData.application_fee = touchFee;
      const receiverClient = new MercadoPagoConfig({ accessToken: receiver.mpAccessToken });
      const receiverPayment = new Payment(receiverClient);
      result = await receiverPayment.create({ body: paymentData });
    } else {
      result = await mpPayment.create({ body: paymentData });
    }

    console.log('🎫 Entry result:', { id: result.id, status: result.status, detail: result.status_detail });

    if (result.status === 'approved') {
      // Track revenue
      ev.revenue = (ev.revenue || 0) + amount;
      ev.paidCheckins = (ev.paidCheckins || 0) + 1;
      // Record as tip for dashboard tracking
      const tipId = uuidv4();
      db.tips[tipId] = {
        id: tipId, payerId: userId, receiverId: ev.creatorId,
        amount, fee: touchFee, mpPaymentId: result.id,
        status: 'approved', statusDetail: result.status_detail,
        type: 'entry', eventId: ev.id, eventName: ev.name,
        createdAt: Date.now()
      };
      saveDB();
      io.to(`user:${ev.creatorId}`).emit('entry-paid', { userId, amount, eventId: ev.id, nickname: user.nickname || user.name });
    }

    res.json({ status: result.status, statusDetail: result.status_detail, mpPaymentId: result.id });
  } catch (e) {
    console.error('Entry payment error:', e.message, e.cause || '');
    res.status(500).json({ error: 'Erro no pagamento: ' + (e.message || 'tente novamente') });
  }
});

app.get('/api/operator/events/:userId', (req, res) => {
  const userId = req.params.userId;
  const events = Object.values(db.operatorEvents).filter(e => e.creatorId === userId);
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
  // Notify all participants
  io.to('event:' + ev.id).emit('event-ended', { eventId: ev.id, name: ev.name });
  saveDB();
  res.json({ ok: true });
});

app.post('/api/operator/event/:eventId/leave', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId obrigatório.' });
  ev.participants = (ev.participants || []).filter(uid => uid !== userId);
  ev.checkinCount = ev.participants.length;
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
  saveDB();
  res.json({ ok: true });
});

app.get('/api/operator/event/:eventId/attendees', (req, res) => {
  const ev = db.operatorEvents[req.params.eventId];
  if (!ev) return res.status(404).json({ error: 'Evento não encontrado.' });
  const totalUsers = Object.keys(db.users).length;
  const attendees = ev.participants.map(uid => {
    const u = db.users[uid];
    if (!u) return null;
    const stars = (u.stars || []).length;
    const order = u.registrationOrder || 9999;
    const topTag = calculateTopTag(order, totalUsers);
    // Check if this user revealed to the event creator
    const creatorUser = db.users[ev.creatorId];
    const revealed = !!(creatorUser && creatorUser.canSee && creatorUser.canSee[uid]);
    const revealData = revealed ? creatorUser.canSee[uid] : null;
    return {
      userId: uid, nickname: u.nickname || u.name, color: u.color,
      profilePhoto: u.profilePhoto || u.photoURL || null,
      stars, topTag, revealed, revealData,
      score: calcScore(uid)
    };
  }).filter(Boolean);
  res.json({ attendees, eventName: ev.name, active: ev.active });
});

const PORT = process.env.PORT || 3000;

// Async startup: load DB from Firestore before accepting connections
(async () => {
  await loadDB();
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
