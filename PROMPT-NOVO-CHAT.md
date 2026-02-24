# PROMPT PARA INICIAR NOVO CHAT -- Touch? (Encosta)

Copie e cole o texto abaixo ao iniciar um novo chat com outro agente:

---

## O Prompt:

```
Voce vai me ajudar a continuar o desenvolvimento do app "Touch?" (Encosta) -- uma rede social baseada em proximidade fisica (ultrassonica).

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## ACESSO AO PROJETO

1. PASTA NA MAQUINA (selecione quando o Cowork pedir):
   -> A pasta "encosta" no meu computador

2. GITHUB:
   -> https://github.com/bavkiq-hUgby8-cittet/encosta.git
   -> O token de acesso esta configurado no remote do git local (git remote -v)
   -> Se precisar reconfigurar, me pergunte

3. GIT CONFIG:
   -> Email: ramonnvc@hotmail.com
   -> Nome: Ramon

## ESTRUTURA DO PROJETO (atualizado 24/02/2026)

Arquivos principais:
- `server.js` (~9400 linhas) -- Backend Node.js + Express + Socket.IO + Firebase RTDB
- `public/index.html` (~13445 linhas) -- Frontend SPA completo (23+ telas)
- `public/va-test.html` (~825 linhas) -- Pagina de ligacao telefonica pros 3 assistentes + Dev Log
- `public/va-admin.html` (~501 linhas) -- Painel admin dos 3 assistentes de voz
- `public/admin.html` (~535 linhas) -- Painel administrativo geral
- `public/games/index.html` (1909 linhas) -- TouchGames lobby (microservico iframe)
- `public/games/*.html` -- 11 jogos individuais
- `public/operator.html` -- Painel do operador de eventos
- `public/operator-restaurant.html` -- Painel do restaurante
- `public/site.html` -- Landing page
- `public/termos.html` -- Termos de uso
- `simulador-estrelas.html` -- Simulador da economia de estrelas
- `package.json` -- Dependencias (express, socket.io, firebase-admin, mercadopago, helmet, uuid, express-rate-limit)
- `docs/` -- Documentacao tecnica (inclui docs/ULTIMATEDEV.md)
- `CHANGELOG-sessao-*.md` -- Changelogs por sessao
- `.claude/CLAUDE.md` -- Instrucoes globais pro agente

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta na minha maquina
2. `git pull` para garantir que esta atualizado
3. `git log --oneline -20` para ver o historico recente
4. Leia este arquivo (PROMPT-NOVO-CHAT.md) por completo -- ELE TEM TUDO
5. Me diga em que pe esta o projeto e pergunte o que preciso

## REGRAS DE TRABALHO

- Sempre faca commit com mensagem descritiva
- Sempre faca push para o GitHub apos cada commit
- SEMPRE salve nos DOIS: maquina E GitHub
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo -- usamos SVGs vetoriais para icones
- Se eu pedir backup, verifique que git status esta clean e push foi feito

## CONTEXTO DO APP

Touch? e um app de conexao por proximidade. As pessoas se aproximam fisicamente,
o celular detecta via ultrassom (~18-22kHz), e cria uma relacao anonima de 24h (chat efemero).
Podem se revelar, dar estrelas, fazer check-in em eventos, enviar presentes digitais.

Dominio: touch-irl.com (Cloudflare DNS -> Render)
Render: encosta.onrender.com redireciona 301 para touch-irl.com
Firebase: Realtime Database para persistencia
MercadoPago: Pagamentos (Pix, cartao, checkout)
OpenAI: Voice Agent (Realtime API via WebRTC) -- voz dos 3 assistentes
Anthropic: Claude Sonnet 4 -- cerebro de dev do UltimateDEV

## FUNCIONALIDADES IMPLEMENTADAS

1. ULTRASOM (Sonic): Deteccao por frequencia ultrassonica, gain 0.6, threshold 80, confirm 3
2. CHAT 24H: Chat efemero com timer, quick phrases, foto, mensagem efemera
3. REVEAL: Revelar identidade real exige nome preenchido
4. CONSTELACAO: Mapa de conexoes em canvas (nodes = pessoas, links = relacoes)
5. EVENTOS: Operador cria evento, check-in via sonic, menu de restaurante, pedidos
6. ESTRELAS: Economia zero-sum (doar, comprar R$1.49, loja de acessorios, top tag)
7. PRESENTES DIGITAIS: Catalogo com itens que custam estrelas
8. BOARDING PASS: Cartao de embarque com dados do usuario
9. SELFIE NO REVEAL: Foto do casal salva na relacao
10. VOICE AGENT 3-TIER: Sistema de 3 assistentes de voz AI (ver secao abaixo)
11. TOUCHGAMES: Microservico com 11 jogos, lobby multiplayer, convites via chat
12. ASSINATURAS: Touch Plus R$50/mes (agente AI, acessorios premium, faixa VIP), Selo R$10/mes
13. GORJETAS: Pagamento via MercadoPago (Pix, cartao, checkout pro, saved card, one-tap)
14. EXTRATO FINANCEIRO: Tela com summary cards, filtros, lista de gorjetas
15. SWIPE-BACK: Gesto de arrastar da borda esquerda pra voltar
16. PAINEL RESTAURANTE: Menu CRUD, pedidos em tempo real, status por mesa

=================================================================
## VOICE AGENT -- SISTEMA DE 3 TIERS (DETALHADO)
=================================================================

O Voice Agent usa OpenAI Realtime API via WebRTC. Tem 3 niveis:

### PLUS (basico -- qualquer assinante Touch Plus)
- Custo: $0.08/sessao
- 4 tools: navegar_tela, mostrar_perfil, listar_conexoes, consultar_relacao
- Voz: coral, VAD threshold 0.95

### PRO (premium -- qualquer assinante Touch Plus)
- Custo: $0.15/sessao
- 9 tools: as 4 do Plus + salvar_nota, ler_notas, buscar_pessoa, ver_estrelas, contar_fofoca
- Voz: coral, VAD threshold 0.95

### ULTIMATEDEV (apenas admin / Top 1)
- Custo: $0.25/sessao (voz) + ~$0.01-0.05/comando (Claude)
- 18+ tools: as 9 do Pro + comando_dev, ver_fila_dev, aprovar_plano, rejeitar_plano,
  aprender_usuario, escrever_pensamento, fazer_backup, salvar_arquivo
- CEREBRO: Claude Sonnet 4 (Anthropic) para planejamento e geracao de codigo
  - Voz continua OpenAI (unico com Realtime API via WebRTC)
  - Claude recebe codigo COMPLETO dos arquivos (nao mais 3000 chars)
  - Suporta TODOS os arquivos do projeto (nao so server.js e index.html)
  - Fallback para GPT-4o se ANTHROPIC_API_KEY nao configurada
- Tem consciencia TOTAL da arquitetura do app
- Personalidade: assertivo, critico, bom gosto, faz perguntas
- Funciona como PONTE entre o dono do app (Ramon, nao sabe programar) e o desenvolvedor (Claude)
- Sistema Escriba: documenta automaticamente tudo a cada 2 minutos
- Camera e tela: video via WebRTC a 2fps para OpenAI Realtime API vision
- Persistencia de conversas entre sessoes (ultimas 20 msgs)
- Dev Log: painel visual na tela de ligacao mostrando historico de commits em tempo real

### FLUXO DO ULTIMATEDEV (dev commands):
1. Usuario fala instrucao por voz
2. Agente chama tool `comando_dev` -> POST /api/dev/command
3. Claude Sonnet 4 gera plano com mapa de endpoints (~5-10s)
4. Agente resume plano por voz, pergunta se aprova
5. Se aprovado -> POST /api/dev/approve/:commandId -> Claude gera edits JSON com contexto completo -> valida -> aplica -> backup -> git commit+push
6. Se rejeitado -> POST /api/dev/reject/:commandId
7. Dev Log mostra status em tempo real na tela de ligacao

### VA ADMIN PANEL
- URL: https://touch-irl.com/va-admin.html?userId=USER_ID
- Permite ajustar voz, VAD, personalidade, regras de privacidade/memoria de cada tier
- Salva no Firebase (colecao vaConfig)
- Endpoints de sessao LEEM do vaConfig via getTierConfig(tier)

### DOCUMENTACAO COMPLETA DO ULTIMATEDEV
- Ver docs/ULTIMATEDEV.md para detalhes de todas as tools, fluxos e exemplos

### ANTI-ECHO SYSTEM
- Flags: _agentSpeaking, _pendingToolCall, _unmuteTimer
- Unmute com delay de 800ms apos agente parar de falar
- Server VAD: threshold 0.95, prefix_padding_ms 500, silence_duration_ms 1500

=================================================================
## MAPA DO SERVER.JS (~9400 linhas)
=================================================================

Linha ~1-150: Imports, seguranca (helmet, rate-limit, CORS, ADMIN_SECRET)
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
Linha ~6560-6880: Timezone helpers, buildUserContext (dados completos do usuario), VA cost tracking
Linha ~6880-7100: VA tier system (canUseProVA, canUseUltimateVA, /api/agent/access)
Linha ~7100-7400: VA Plus/Pro sessions (OpenAI Realtime)
Linha ~7400-7700: VA UltimateDEV session (OpenAI Realtime voz + prompt com arquitetura + 18 tools)
Linha ~7700-7860: Dev command endpoints -- planejamento com Claude Sonnet 4 (Anthropic)
Linha ~7860-8100: Dev approve endpoint -- geracao de codigo com Claude, backup, rollback, multi-arquivo
Linha ~8100-8400: Dev reject, learn, conversation endpoints
Linha ~8400-8600: Dev new tools (thought, backup, save-file, escriba)
Linha ~8600-8800: VA conversation persistence (vaConversations)
Linha ~8800-9400: VA Config system (GET/POST /api/va-config, test-prompt, getTierConfig)

### DB COLLECTIONS (Firebase):
users, sessions, relations, messages, encounters, gifts, declarations, events, checkins, tips, streaks, locations, revealRequests, likes, starDonations, operatorEvents, docVerifications, faceData, gameConfig, subscriptions, verifications, faceAccessLog, gameSessions, gameScores, ultimateBank, vaConfig, vaConversations

=================================================================
## MAPA DO INDEX.HTML (~13431 linhas)
=================================================================

Linha ~1-400: CSS completo (variaveis CSS, telas, componentes, animacoes)
Linha ~400-2800: HTML das 23+ telas (auth, home, constellation, chat, profile, events, stars, gifts, boarding-pass, reveal, operator, games, agent)
Linha ~2800-5600: JavaScript principal (state, socket handlers, API calls, renderizacao)
Linha ~5600-8000: Funcoes de tela (chat, constellation, profile, events, stars)
Linha ~8000-9500: Sonic system, swipe-back, notifications, boarding pass
Linha ~9500-11000: Voice Agent (WebRTC, audio pipeline, anti-echo, fofoca automatica)
Linha ~11000-11500: VA Tier system (tier selector, switchTier, tier chips CSS)
Linha ~11500-12000: VA UltimateDEV (dev tool handlers, escriba, camera/screen, dev tools bar)
Linha ~12000-12500: TouchGames integration (launcher, invite handlers, ready-check modal)
Linha ~12500-13431: Event handlers, game socket events, iframe communication

### VOICE AGENT FRONTEND (detalhes):
- Variavel principal: vaTier ('plus' | 'pro' | 'ultimatedev')
- VA.open(tier) -- abre overlay e busca /api/agent/access
- VA.switchTier(newTier) -- troca tier e reconecta
- connect() -- roteia para endpoint correto baseado em vaTier
- Tool handlers: handleComandoDev, handleVerFilaDev, handleAprovarPlano, handleRejeitarPlano, handleAprenderUsuario, handleEscreverPensamento, handleFazerBackup, handleSalvarArquivo
- Escriba: _escribaBuffer, _escribaLog(), _escribaFlush() (auto 2 min)
- Camera: _startCamera() (640x480 @2fps via getUserMedia)
- Screen: _startScreenShare() (@2fps via getDisplayMedia)
- Dev tools bar: #vaDevTools com botoes camera/screen (so aparece em ultimatedev)
- Cleanup: para video, flush escriba, fecha PeerConnection

=================================================================
## PENDENCIAS / COISAS NAO TESTADAS
=================================================================

### ALTA PRIORIDADE:
1. [RESOLVIDO] VA Config integrado aos prompts -- endpoints de sessao agora LEEM do vaConfig via getTierConfig(tier)

2. TouchGames fluxo completo -- nunca foi testado end-to-end. Ready-check modal pode ter problemas de timing.

3. Camera/Screen no UltimateDEV -- implementado mas NAO testado. Depende do suporte real do OpenAI Realtime API a video tracks via WebRTC.

### MEDIA PRIORIDADE:
4. Escriba system -- implementado, auto-flush a cada 2min, mas nao testado em sessao real.
5. [RESOLVIDO] Dev command flow -- cerebro trocado para Claude Sonnet 4 (Anthropic), contexto completo, multi-arquivo, backup+rollback. Precisa teste end-to-end.
6. Stripe Express Checkout -- preparado mas desativado (precisa STRIPE_SECRET_KEY e STRIPE_PUBLIC_KEY no .env)

### BAIXA PRIORIDADE:
7. Convite via sonic touch no lobby (encosta em alguem = convite de jogo)
8. Atualizar checkout das assinaturas com novo design (PIX primeiro + Express Checkout)

=================================================================
## GIT LOG RECENTE (24/02/2026)
=================================================================

5104ef3 feat: painel Dev Log na tela de chamada UltimateDEV
d38f441 feat: trocar cerebro de dev do UltimateDEV para Claude (Anthropic)
81a2ec1 feat: redesign completo do painel admin com UI premium
487634f feat: VAs agora tem acesso completo aos dados do usuario
5a72a55 feat: timezone awareness - detecta e usa horario local do usuario
3906c9a feat: adicionar endpoints admin (dashboard-stats, users, toggle-admin, events, financial)
3a5ef8a refactor: redesign va-test.html com UI moderna e polida
564bb29 feat: integrar vaConfig nos endpoints dos 3 agentes VA
6effd47 feat: redesenhar va-test como tela de ligacao telefonica real
e163b66 feat: UltimateDEV consciousness + escriba + camera/screen vision

## ROLLBACK RAPIDO

Se algo quebrar, voltar para commits estaveis:
- ANTES do UltimateDEV consciousness: git reset --hard d07a15f
- ANTES do VA admin panel: git reset --hard 540d994
- ANTES do 3-tier VA: git reset --hard ca25ac5
- ANTES do redesign visual: git reset --hard 1ccd782
- ANTES do voice agent inteiro: git reset --hard 1ffc98f

Apos rollback: git push --force origin main (CUIDADO: sobrescreve GitHub)

## VARIAVEIS DE AMBIENTE (.env)

- FIREBASE_* (config do Firebase Admin SDK)
- MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY
- MP_REDIRECT_URI=https://touch-irl.com/mp/callback
- APP_URL=https://touch-irl.com
- OPENAI_API_KEY (para voz em tempo real dos 3 assistentes)
- ANTHROPIC_API_KEY (cerebro de dev do UltimateDEV -- Claude Sonnet 4)
- ADMIN_SECRET (protege endpoints admin)
- ALLOWED_ORIGINS (CORS)
- STRIPE_SECRET_KEY, STRIPE_PUBLIC_KEY (quando ativar Apple Pay)

## FLUXOS DE PAGAMENTO

1. GORJETAS (tipScreen): PIX, cartao novo, cartao salvo one-tap, Checkout Pro MP
2. ASSINATURAS (subscriptionScreen): Touch Plus R$50/mes, Selo R$10/mes
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap com cartao salvo
4. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
5. PRESENTES: Comprados com pontos (sem dinheiro real)

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!
