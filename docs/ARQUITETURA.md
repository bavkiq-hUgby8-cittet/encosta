# ARQUITETURA TECNICA -- Touch? (Encosta)

Atualizado: 27/02/2026

## STACK

- Backend: Node.js + Express + Socket.IO + Firebase RTDB
- Frontend: HTML/CSS/JS vanilla (SPA)
- Auth: Firebase Authentication (Google, Email, Phone)
- Pagamentos BR: MercadoPago (Pix, cartao, checkout)
- Pagamentos US: Stripe (Payment Intents, Apple Pay, Google Pay, Link, Connect)
- Voice Agent: OpenAI Realtime API (WebRTC) + Claude Opus 4 (cerebro dev)
- AI News: Perplexity API (agentes do Mural)
- AI Radio: OpenAI TTS (locutor do Radio Touch)
- Deploy: Render (encosta.onrender.com -> 301 -> touch-irl.com)
- DNS: Cloudflare
- Dominio: touch-irl.com

## ARQUIVOS PRINCIPAIS

- server.js (~13017 linhas) -- Backend monolito
- public/index.html (~18391 linhas) -- Frontend SPA (25+ telas)
- public/va-test.html (~1260 linhas) -- Tela de ligacao dos 3 assistentes + Dev Log
- public/va-admin.html (~501 linhas) -- Painel admin dos assistentes de voz
- public/admin.html (~989 linhas) -- Painel administrativo (8 abas)
- public/games/index.html (1909 linhas) -- TouchGames lobby (iframe)
- public/games/*.html -- 11 jogos individuais
- public/operator.html -- Painel do operador de eventos
- public/operator-restaurant.html -- Painel do restaurante
- public/site.html -- Landing page
- public/termos.html -- Termos de uso
- simulador-estrelas.html -- Simulador da economia de estrelas
- package.json -- Dependencias

## MAPA DO SERVER.JS (~13017 linhas)

Linha ~1-150: Imports, seguranca (helmet, rate-limit, CORS, ADMIN_SECRET, vaLimiter)
Linha ~180-600: Firebase Admin, DB in-memory com dirty tracking, indexes (IDX), top tag calc
Linha ~600-760: Dirty tracking (saveDB), backup/rollback system
Linha ~780-1050: Auth (Firebase verify, link accounts, unificacao de contas)
Linha ~1050-1250: MercadoPago config, phrases bank, zodiac system
Linha ~1400-1800: Sonic matching, session create/join, streak system, NFC/QR links
Linha ~1800-4400: REST APIs (user, relations, messages, constellation, stars, gifts, reveals, likes, profile, notifications, events, selfie, horoscope)
Linha ~4400-4600: Admin endpoints (reset, backup, rollback, recover, dashboard-stats, users, toggle-admin, events, financial)
Linha ~4600-4900: Socket.IO (identify, messages, typing, sonic, game lobby, game events)
Linha ~4900-5850: MercadoPago (prestador, tips, pix, checkout, saved card, one-tap, subscription)
Linha ~5850-6080: Assinaturas (Plus + Selo)
Linha ~6080-6440: Voice Agent base (OpenAI Realtime sessions, notas, acesso)
Linha ~6440-6550: Operator/Events/Restaurant (checkins, settings, events, menu, orders)
Linha ~6550-6560: API Keys (OPENAI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY)
Linha ~6560-6880: Timezone helpers, buildUserContext, VA cost tracking
Linha ~6880-7100: VA tier system (canUseProVA, canUseUltimateVA, /api/agent/access)
Linha ~7100-7400: VA Plus/Pro sessions (OpenAI Realtime)
Linha ~7400-7700: VA context endpoint (/api/agent/context/:userId)
Linha ~7700-8100: VA UltimateDEV session (OpenAI Realtime + 18 tools + interceptor)
Linha ~7751: ULTIMATE_ADMIN_IDS (hardcoded UUIDs) + canUseUltimateVA()
Linha ~8100-8300: Dev command endpoints (planejamento ASYNC com Claude)
Linha ~8300-8400: Dev ping endpoint (POST /api/dev/ping)
Linha ~8400-8600: _processDevPlan() e _processDevApproval() (async background)
Linha ~8600-8700: GET /api/dev/status/:commandId (polling)
Linha ~8700-8900: Dev diagnostico, approve, reject, learn, conversation endpoints
Linha ~8800-9000: Dev history endpoint
Linha ~9000-9200: VA conversation persistence (vaConversations)
Linha ~9200-11000: VA Config system, fetchWithTimeout, security audit fixes
Linha ~11000-11970: Onboarding VA, Stripe config (stripeInstance)
Linha ~11970-12260: Stripe endpoints (pay, create-payment-intent, confirm, subscription, cancel) -- requireAuth
Linha ~12260-12330: Stripe Connect (connect-url, connect-refresh, connect-result)
Linha ~12330-12450: Stripe webhook (/stripe/webhook -- sem auth, necessario)
Linha ~12450-12620: Games endpoints (sessions, invite, temp-chat, results) -- requireAuth
Linha ~12620-12890: Mural system (canais, posts, likes, comments, ask-agent, news-chat, ban, narrate)
Linha ~12890-12970: Radio Touch (play, stop) -- requireAuth
Linha ~12970-13017: Server listen, cleanup
GET /api/dev/monitor (~9100-9200): stats de todos os usuarios

## MAPA DO INDEX.HTML (~18391 linhas)

Linha ~1-400: CSS completo (variaveis, telas, componentes, animacoes)
Linha ~400-1460: CSS Dev Log panel (tema branco/clean, azul #60a5fa)
Linha ~1460-2800: HTML das 23+ telas
Linha ~2800-5600: JavaScript principal (state, socket handlers, API calls)
Linha ~5600-8000: Funcoes de tela (chat, constellation, profile, events, stars)
Linha ~8000-8450: Sonic system, swipe-back, notifications, boarding pass
Linha ~8450-8600: Dev Log global functions
Linha ~8600-9500: Funcoes de tela extras
Linha ~9500-11000: Voice Agent (WebRTC, audio pipeline, anti-echo)
Linha ~11000-11500: VA Tier system
Linha ~11500-12000: VA UltimateDEV (dev tool handlers, escriba, camera/screen)
Linha ~12000-12500: TouchGames integration
Linha ~12500-13700: Event handlers, game socket events, Dev Log HTML
Linha ~13700-14200: VA connect(), DataChannel, SDP exchange
Linha ~14200-14600: VA tool handlers + Dev Interceptor
Linha ~14600-14700: Dev Log IIFE
Linha ~14700-15200: Escriba, cleanup, init

## DB COLLECTIONS (Firebase)

users, sessions, relations, messages, encounters, gifts, declarations, events, checkins, tips, streaks, locations, revealRequests, likes, starDonations, operatorEvents, docVerifications, faceData, gameConfig, subscriptions, verifications, faceAccessLog, gameSessions, gameScores, ultimateBank, vaConfig, vaConversations, muralPosts

## VARIAVEIS DE AMBIENTE (Render)

### Obrigatorias (verificadas 27/02/2026):
- ADMIN_SECRET -- protege endpoints admin
- ANTHROPIC_API_KEY -- cerebro de dev (Claude Opus 4)
- APP_URL=https://touch-irl.com
- FIREBASE_API_KEY, FIREBASE_APP_ID, FIREBASE_AUTH_DOMAIN
- FIREBASE_MESSAGING_SENDER_ID, FIREBASE_PROJECT_ID
- FIREBASE_SERVICE_ACCOUNT, FIREBASE_STORAGE_BUCKET
- GITHUB_REPO -- bavkiq-hUgby8-cittet/encosta
- GITHUB_TOKEN -- Personal Access Token (repo, sem expiracao)
- MP_ACCESS_TOKEN, MP_APP_ID, MP_CLIENT_SECRET, MP_PUBLIC_KEY
- MP_REDIRECT_URI, MP_WEBHOOK_SECRET
- OPENAI_API_KEY -- voz dos 3 assistentes + TTS Radio
- PPLX_API_KEY -- agentes de noticias do Mural

### Pendentes de verificacao no Render:
- STRIPE_SECRET_KEY -- pagamentos Stripe US
- STRIPE_PUBLIC_KEY -- frontend Stripe
- STRIPE_WEBHOOK_SECRET -- webhook Stripe
- STRIPE_CONNECT_CLIENT_ID -- Stripe Connect

## FLUXOS DE PAGAMENTO

1. GORJETAS: PIX, cartao novo, cartao salvo one-tap, Checkout Pro MP, Stripe (US)
2. ASSINATURAS: Touch Plus R$50/mes, Selo R$10/mes
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap
4. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
5. PRESENTES: Comprados com pontos (sem dinheiro real)

## FUNCIONALIDADES IMPLEMENTADAS

1. Ultrasom (Sonic): gain 0.6, threshold 80, confirm 3
2. Chat 24h efemero com quick phrases e foto
3. Reveal (exige nome real preenchido)
4. Constelacao: mapa de conexoes em canvas
5. Eventos: check-in via sonic, menu restaurante, pedidos
6. Estrelas: economia zero-sum (doar, comprar, loja, top tag)
7. Presentes digitais: catalogo com itens
8. Boarding Pass: cartao de embarque
9. Selfie no Reveal: foto do casal
10. Voice Agent 3-Tier (Plus, Pro, UltimateDEV) -- ver docs/VOICE-AGENT.md
11. TouchGames: 11 jogos, lobby multiplayer, convites via chat
12. Assinaturas: Plus R$50/mes, Selo R$10/mes
13. Gorjetas: MercadoPago (BR) + Stripe (US)
14. Extrato financeiro: summary cards, filtros, lista
15. Swipe-back: gesto de borda esquerda
16. Painel restaurante: menu CRUD, pedidos real-time
17. Mural: feed social, canais, 9 agentes AI, comentarios, likes
18. Radio Touch: locutor IA (OpenAI TTS)
19. Stripe Connect: pagamentos internacionais, Apple Pay, Google Pay
20. Nacionalidade: campo com deteccao automatica

## RATE LIMITING

| Categoria | Limite | Janela |
|-----------|--------|--------|
| Geral | 300 req | 15 min |
| Autenticacao | 10 req | 15 min |
| Pagamentos | 15 req | 5 min |
| Admin | 20 req | 15 min |
