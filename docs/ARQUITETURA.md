# ARQUITETURA TECNICA -- Touch? (Encosta)

Atualizado: 16/03/2026

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

- server.js (~22825 linhas) -- Backend monolito
- public/index.html (~30405 linhas) -- Frontend SPA (25+ telas)
- public/va-test.html (~1260 linhas) -- Tela de ligacao dos 3 assistentes + Dev Log
- public/va-admin.html (~501 linhas) -- Painel admin dos assistentes de voz
- public/admin.html (~989 linhas) -- Painel administrativo (8 abas)
- public/games/index.html (1909 linhas) -- TouchGames lobby (iframe)
- public/games/*.html -- 11 jogos individuais
- public/operator.html (~11514 linhas) -- Painel do operador de eventos
- public/operator-restaurant.html -- Painel do restaurante
- public/partners.html (~385 linhas) -- Pagina de onboarding parceiros (3 idiomas: EN/PT/ES)
- public/site.html -- Landing page
- public/termos.html -- Termos de uso
- simulador-estrelas.html -- Simulador da economia de estrelas
- package.json -- Dependencias

## MAPA DO SERVER.JS (~22825 linhas)

Linha ~1-150: Imports, seguranca (helmet, rate-limit, CORS, ADMIN_SECRET, vaLimiter)
Linha ~180-600: Firebase Admin, DB in-memory com dirty tracking, indexes (IDX), top tag calc
Linha ~600-760: Dirty tracking (saveDB), backup/rollback system
Linha ~780-1050: Auth (Firebase verify, link accounts, unificacao de contas)
Linha ~1050-1300: MercadoPago config, phrases bank, zodiac system
Linha ~1400-1920: Sonic matching, session create/join, streak system, NFC/QR links
Linha ~1920-2000: TABELA DE PRECOS REGIONAIS (PRICING_DEFAULTS + PRICING dinamico + Firebase persist)
Linha ~2000-2070: Region detection (detectRegion, getPricing, GET /api/region-config)
Linha ~2070-4050: REST APIs (user, relations, messages, constellation, stars, gifts, reveals, likes, profile, notifications, events, selfie, horoscope)
Linha ~4050-5300: Mural system (canais, posts, likes, comments, ask-agent, news-chat, ban, narrate, online)
Linha ~5300-5400: Doc verification, face enrollment/verify
Linha ~5400-5700: Admin verify, admin grant-plus, admin events, score breakdown, debug
Linha ~5700-5850: Location, events (create, join, nearby, encosta-request/accept)
Linha ~5850-6100: Contact requests, horoscope, selfie
Linha ~6100-6440: Voice Agent base (OpenAI Realtime sessions, notas, acesso)
Linha ~6440-6690: Admin endpoints (reset, backup, rollback, recover, dashboard-stats, users, toggle-admin, events)
Linha ~6690-6850: Dashboard Financeiro Admin + Payouts manuais + Bank info prestador
Linha ~8843-8920: Admin Pricing endpoints (GET/POST /api/admin/pricing, POST /api/admin/pricing/reset)
Linha ~6930-7000: Status, Firebase diagnostic, force-reload, force-connect
Linha ~7000-7460: VA tier system (canUseProVA, canUseUltimateVA, sessions Plus/Pro/UltimateDEV)
Linha ~7460-7570: MercadoPago config (service-types, mp-public-key, prestador register, MP OAuth)
Linha ~7570-8060: Gorjetas (tip/create, tip/pix, tip/checkout, tip-result, tips list, financial, transactions)
Linha ~8060-8200: Prestador dashboard (gorjetas + entradas recebidas)
Linha ~8200-8270: MP Webhook (/mp/webhook)
Linha ~8270-8530: Cartao salvo (save-card, saved-card, quick-pay, delete, mp-checkout)
Linha ~8530-8900: Assinaturas MP (create-card, plans, status, create, sub-result, webhook, cancel, create-pix)
Linha ~8900-9500: VA config, conversation persistence, onboarding
Linha ~9500-9810: VA onboarding (config, session, audio, done, reset)
Linha ~9810-10000: VA context endpoint, notes, grant-access, access check, costs
Linha ~10000-10180: VA Premium (Pro) session
Linha ~10180-10450: VA UltimateDEV session (OpenAI Realtime + 18 tools + interceptor)
Linha ~10450-10700: Dev command endpoints (ping, diagnostico, command)
Linha ~10700-11100: Dev status, queue, monitor, _processDevPlan, _processDevApproval
Linha ~11100-11300: Dev approve, reject, learn, conversation, va conversation
Linha ~11300-11400: Dev thought, backup, save-file, escriba
Linha ~11400-12260: Stripe config (stripeInstance), Stripe endpoints (pay, create-payment-intent, confirm, subscription, cancel)
Linha ~12260-12330: Stripe Connect pessoal (connect-url, connect-refresh, connect-result)
Linha ~12330-12450: Stripe Connect status + Event Connect (event-connect-url, event-connect-result)
Linha ~12450-12620: Stripe Webhook (/api/stripe/webhook)
Linha ~12620-12840: Games endpoints (sessions, invite, temp-chat, results)
Linha ~12840-13100: Mural extended (Radio Touch play/stop)
Linha ~13100-13762: Server listen, cleanup, error handling

## MAPA DO INDEX.HTML (~30405 linhas)

Linha ~1-400: CSS completo (variaveis, telas, componentes, animacoes)
Linha ~400-1460: CSS Dev Log panel (tema branco/clean, azul #60a5fa)
Linha ~1460-2800: HTML das 23+ telas
Linha ~2800-3750: JavaScript principal (state, socket handlers, API calls)
Linha ~3750-3830: REGION object, formatPrice(), loadRegionConfig(), applyRegionPricing()
Linha ~3830-5600: API fetch, funcoes de tela
Linha ~5600-8000: Funcoes de tela (chat, constellation, profile, events, stars)
Linha ~8000-8450: Sonic system, swipe-back, notifications, boarding pass
Linha ~8450-8600: Dev Log global functions
Linha ~8600-9500: Funcoes de tela extras
Linha ~9500-11000: Voice Agent (WebRTC, audio pipeline, anti-echo)
Linha ~11000-11500: VA Tier system
Linha ~11500-12000: VA UltimateDEV (dev tool handlers, escriba, camera/screen)
Linha ~12000-12500: TouchGames integration
Linha ~12500-14000: Event handlers, game socket events, Dev Log HTML
Linha ~14000-14600: VA connect(), DataChannel, SDP exchange
Linha ~14600-15200: VA tool handlers + Dev Interceptor
Linha ~15200-15400: Dev Log IIFE
Linha ~15400-16000: Escriba, cleanup, init, more-menu
Linha ~16000-22600: Financial dashboard, prestador UX, payout screens, event payment UI
Linha ~22617-22845: Admin Financial Panel (showAdminFinancial, payouts, history)
Linha ~22846-23080: Admin Pricing Panel (showAdminPricing, campos editaveis, save/reset)
Linha ~23080-30405: Admin Agents panel, restante do app

## DB COLLECTIONS (Firebase)

users, sessions, relations, messages, encounters, gifts, declarations, events, checkins, tips, streaks, locations, revealRequests, likes, starDonations, operatorEvents, docVerifications, faceData, gameConfig, subscriptions, verifications, faceAccessLog, gameSessions, gameScores, ultimateBank, vaConfig, vaConversations, muralPosts, eventPayments, payouts, customDomains, sitePayments

### Paths separados no Firebase RTDB (fora de DB_COLLECTIONS)
- /pricingConfig -- Tabela de precos editavel pelo admin (override dos PRICING_DEFAULTS)
- /backups/{timestamp} -- Backups automaticos do DB
- /waitlist -- Cadastros da landing page

## VARIAVEIS DE AMBIENTE (Render)

### Obrigatorias (verificadas 28/02/2026):
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
2. ASSINATURAS: Touch Plus (US $4.99, BR R$29.90), Selo (US $1.99, BR R$9.90) -- precos regionais
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap, com split para operador via Stripe Connect por evento
4. PAYOUTS MANUAIS: Admin registra pagamento (PIX/TED/dinheiro) para prestadores sem Stripe/MP
5. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
6. PRESENTES: Comprados com pontos (sem dinheiro real)
7. REEMBOLSOS: Admin refund (qualquer tx), Operador refund (pedidos), User refund (gorjetas 24h)
8. PRECOS REGIONAIS: Centralizados em PRICING, editaveis pelo admin panel, persistidos no Firebase

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
21. Dashboard financeiro admin: receita bruta, taxas, plataforma, prestadores, payouts
22. Payout manual: sistema de pagamento para prestadores sem Stripe/MP
23. Stripe Connect por evento: conta separada para cada evento do operador
24. Pagina Partners: onboarding de parceiros com comparativo Stripe vs MP (3 idiomas)
25. Precos regionais: tabela centralizada (US/BR/LATAM), deteccao auto de regiao, frontend dinamico
26. Admin Pricing Panel: editar todos os precos pelo admin (sem tocar no codigo), persist Firebase
27. Sistema de reembolsos: admin, operador e usuario (Stripe refund, MP refund, janela 24h)
28. Receipts em tempo real: notificacoes de pagamento aprovado/falha/reembolso via socket

## DEPLOY (Render.com)

### Configuracao do servico:
- Tipo: Web Service
- URL interna: encosta.onrender.com
- Dominio producao: touch-irl.com (Cloudflare DNS, redirect 301 do onrender)
- Build command: npm install
- Start command: node server.js
- Node version: >=18.0.0 (package.json engines)
- Auto-deploy: ativado (cada push na main dispara deploy, ~90 segundos)
- Health check: GET /api/status (retorna uptime, dbLoaded, userCount)
- Free tier: nao recomendado (cold start mata o ultrassom); usar Starter ou superior

### Fluxo de deploy:
1. Agente faz commit + push na main
2. Render detecta push via webhook do GitHub
3. Render roda npm install
4. Render inicia node server.js
5. App sobe, carrega Firebase DB para memoria (~5-15s dependendo do tamanho)
6. Health check em /api/status confirma dbLoaded: true
7. Dominio touch-irl.com ja aponta para o servico

### Cloudflare DNS:
- A/CNAME apontando para encosta.onrender.com
- SSL: Full (strict) -- Render + Cloudflare ambos com cert
- Proxy: ativado (laranja) para CDN + DDoS protection
- CORS no server.js aceita: touch-irl.com, www.touch-irl.com, encosta.onrender.com

### Logs e monitoramento:
- Render Dashboard: logs em tempo real
- /api/status: uptime, dbLoaded, userCount, firebase connected
- /api/admin/dashboard-stats: stats completos (requer ADMIN_SECRET)
- /api/admin/firebase-diagnostic: health do Firebase (requer admin)

### Rollback:
- Render permite rollback para deploy anterior via dashboard
- POST /api/admin/rollback: rollback de dados do Firebase (requer admin)
- Backups automaticos do DB em memoria via POST /api/admin/backup

## RATE LIMITING

| Categoria | Limite | Janela |
|-----------|--------|--------|
| Geral | 300 req | 15 min |
| Autenticacao | 10 req | 15 min |
| Pagamentos | 15 req | 5 min |
| Admin | 20 req | 15 min |
