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

## ESTRUTURA DO PROJETO (atualizado 25/02/2026 -- sessao 4)

Arquivos principais:
- `server.js` (~11444 linhas) -- Backend Node.js + Express + Socket.IO + Firebase RTDB
- `public/index.html` (~16197 linhas) -- Frontend SPA completo (23+ telas)
- `public/va-test.html` (~1260 linhas) -- Pagina de ligacao telefonica pros 3 assistentes + Dev Log
- `public/va-admin.html` (~501 linhas) -- Painel admin dos 3 assistentes de voz
- `public/admin.html` (~989 linhas) -- Painel administrativo geral (com aba DEV Monitor)
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
Anthropic: Claude Opus 4 -- cerebro de dev do UltimateDEV (planejamento + geracao de codigo)
GitHub Token: GITHUB_TOKEN no Render -- permite UltimateDEV fazer git push automatico

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
- CEREBRO: Claude Opus 4 (Anthropic) para planejamento e geracao de codigo
  - Voz continua OpenAI (unico com Realtime API via WebRTC)
  - Claude recebe codigo INTELIGENTE dos arquivos (contexto reduzido por keywords)
    * MAX_LINES_PER_FILE = 400 linhas (sempre inclui primeiro 20 + ultimas 30)
    * CONTEXT_RADIUS = 12 linhas ao redor de cada match de keyword
    * STOP_WORDS: filtra palavras comuns em PT-BR para melhor keyword extraction
    * Evita estouro de tokens (antigo problema de 203k tokens)
    * IMPORTANTE: NAO filtrar CSS de arquivos HTML (quebra edicao de estilos pelo agente)
  - Suporta TODOS os arquivos do projeto (nao so server.js e index.html)
  - Fallback para GPT-4o se ANTHROPIC_API_KEY nao configurada
  - ARQUITETURA ASYNC: /api/dev/command retorna imediato, Claude processa em background
  - Frontend faz polling via GET /api/dev/status/:commandId a cada 3s
  - Fila de injecao no DataChannel com response.cancel antes de injetar
  - Prevencao de comando duplicado (interceptor bloqueado quando tool fires)
  - RETRY AUTOMATICO: anthropicFetch() com 3 tentativas e backoff progressivo (5s/10s/15s)
    * Lida com 429 (rate limit) e 529 (overloaded) automaticamente
  - GIT AUTO-PUSH: Configura remote origin com GITHUB_TOKEN no Render
    * Cria remote se nao existe, atualiza URL se existe
    * Usa GITHUB_REPO env var ou fallback hardcoded
  - REGRAS DE SEGURANCA no planning E code generation:
    * NUNCA apagar funcionalidades sem autorizacao explicita
    * NUNCA fazer rm/delete/drop/truncate em dados
    * NUNCA modificar pagamento/auth/permissoes sem aprovacao
    * Confirmar 2x antes de qualquer acao destrutiva
- Tem consciencia TOTAL da arquitetura do app
- Personalidade: MELHOR AMIGO do Ramon, ponte e TRADUTOR entre ele e os agentes da squad
  - NAO e fofoqueiro -- e companheiro de construcao
  - Fala pausado e claro, questiona decisoes quando necessario
- Funciona como PONTE entre o dono do app (Ramon, nao sabe programar) e o desenvolvedor (Claude)
- Sistema Escriba: documenta automaticamente tudo a cada 2 minutos
- Camera e tela: video via WebRTC a 2fps para OpenAI Realtime API vision
- Persistencia de conversas entre sessoes (ultimas 20 msgs)
- Dev Log: painel visual na tela de ligacao mostrando historico de commits em tempo real
- TEMA VISUAL: branco/clean (fundo #f8f9fa, texto #212529, destaques azul #60a5fa)
  - Antigo tema verde matrix (#00ff41) foi removido completamente
  - Zero instancias de #00ff41 ou rgba(0,255,65,...) restantes
- COOLDOWN: 60 segundos entre comandos DEV (evita spam)

### FLUXO DO ULTIMATEDEV (dev commands):
1. Usuario fala instrucao por voz
2. Agente chama tool `comando_dev` -> POST /api/dev/command
3. Claude Opus 4 gera plano com mapa de endpoints (async, sem timeout)
4. Agente resume plano por voz, pergunta se aprova
5. Se aprovado -> POST /api/dev/approve/:commandId -> Claude gera edits JSON com contexto completo -> valida -> aplica -> backup -> git commit+push
6. Se rejeitado -> POST /api/dev/reject/:commandId
7. Dev Log mostra status em tempo real na tela de ligacao

### VA ADMIN PANEL
- URL: https://touch-irl.com/va-admin.html?userId=USER_ID
- Permite ajustar voz, VAD, personalidade, regras de privacidade/memoria de cada tier
- Salva no Firebase (colecao vaConfig)
- Endpoints de sessao LEEM do vaConfig via getTierConfig(tier)

### ADMIN PANEL (admin.html) -- ABAS:
- Dashboard, Users, Stars, Events, Financial, System, VA Config, DEV Monitor
- DEV Monitor: mostra total de comandos, done/pending/failed, uptime, status das API keys
  - Endpoint: GET /api/dev/monitor
  - Auto-refresh de 5s (toggle)
  - Cards por usuario com badges coloridos por status

### DOCUMENTACAO COMPLETA DO ULTIMATEDEV
- Ver docs/ULTIMATEDEV.md para detalhes de todas as tools, fluxos e exemplos

### ANTI-ECHO SYSTEM
- Flags: _agentSpeaking, _pendingToolCall, _unmuteTimer
- Unmute com delay de 800ms apos agente parar de falar
- Server VAD: threshold 0.95, prefix_padding_ms 500, silence_duration_ms 1500

=================================================================
## MAPA DO SERVER.JS (~11444 linhas)
=================================================================

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
Linha ~6560-6880: Timezone helpers, buildUserContext (dados completos do usuario), VA cost tracking
Linha ~6880-7100: VA tier system (canUseProVA, canUseUltimateVA, /api/agent/access)
Linha ~7100-7400: VA Plus/Pro sessions (OpenAI Realtime)
Linha ~7400-7700: VA context endpoint (/api/agent/context/:userId -- dados frescos com nomes reais)
Linha ~7700-8100: VA UltimateDEV session (OpenAI Realtime voz + prompt + 18 tools + interceptor)
Linha ~7751: ULTIMATE_ADMIN_IDS (hardcoded UUIDs) + canUseUltimateVA()
Linha ~8100-8300: Dev command endpoints -- planejamento ASYNC com Claude Opus 4 (Anthropic) + fallback GPT-4o
Linha ~8300-8400: Dev ping endpoint (POST /api/dev/ping -- teste rapido de conexao)
Linha ~8400-8600: _processDevPlan() e _processDevApproval() -- funcoes async em background
  - anthropicFetch(): retry 3x com backoff progressivo (5s/10s/15s) em 429/529
  - Contexto inteligente: MAX_LINES_PER_FILE=400, CONTEXT_RADIUS=12, STOP_WORDS PT-BR
  - Git auto-push: remote origin criado dinamicamente com GITHUB_TOKEN
  - Regras de seguranca no system prompt (anti-destruicao)
Linha ~9100-9200: GET /api/dev/monitor -- stats de todos os usuarios (total, done, pending, failed, uptime, keys)
Linha ~8600-8700: GET /api/dev/status/:commandId -- polling endpoint
Linha ~8700-8900: Dev diagnostico, approve (async), reject, learn, conversation endpoints
Linha ~8600-8800: Dev new tools (thought, backup, save-file, escriba)
Linha ~8800-9000: Dev history endpoint (GET /api/dev/history/:userId)
Linha ~9000-9200: VA conversation persistence (vaConversations)
Linha ~9200-11000+: VA Config system, fetchWithTimeout, security audit fixes

### DB COLLECTIONS (Firebase):
users, sessions, relations, messages, encounters, gifts, declarations, events, checkins, tips, streaks, locations, revealRequests, likes, starDonations, operatorEvents, docVerifications, faceData, gameConfig, subscriptions, verifications, faceAccessLog, gameSessions, gameScores, ultimateBank, vaConfig, vaConversations

=================================================================
## MAPA DO INDEX.HTML (~16197 linhas)
=================================================================

Linha ~1-400: CSS completo (variaveis CSS, telas, componentes, animacoes)
Linha ~400-1460: CSS Dev Log panel (tema branco/clean, azul #60a5fa para destaques)
Linha ~1460-2800: HTML das 23+ telas (auth, home, constellation, chat, profile, events, stars, gifts, boarding-pass, reveal, operator, games, agent)
Linha ~2800-5600: JavaScript principal (state, socket handlers, API calls, renderizacao)
Linha ~5600-8000: Funcoes de tela (chat, constellation, profile, events, stars)
Linha ~8000-8450: Sonic system, swipe-back, notifications, boarding pass
Linha ~8450-8600: Dev Log global functions (toggleDevLogPanel, devPingClaude, filterDevLog, renderDevLog)
Linha ~8600-9500: Mais funcoes de tela
Linha ~9500-11000: Voice Agent (WebRTC, audio pipeline, anti-echo, fofoca automatica)
Linha ~11000-11500: VA Tier system (tier selector, switchTier, tier chips CSS)
Linha ~11500-12000: VA UltimateDEV (dev tool handlers, escriba, camera/screen, dev tools bar)
Linha ~12000-12500: TouchGames integration (launcher, invite handlers, ready-check modal)
Linha ~12500-13700: Event handlers, game socket events, iframe communication, Dev Log HTML
Linha ~13700-14200: VA connect(), DataChannel, SDP exchange, handleEvent()
Linha ~14200-14600: VA tool handlers (comandoDev, aprovarPlano, etc) + Dev Interceptor
Linha ~14600-14700: Dev Log IIFE (_devAddLiveLog, _showDevLogFab, _devInjectMsg)
Linha ~14700-15200: Escriba, cleanup, init

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
1. REVISAO DOS 3 ASSISTENTES DE VOZ (Plus, Pro, UltimateDEV)
   - Revisar instrucoes, personalidade, tools de cada tier
   - Testar fluxo completo de cada um
   - Verificar se prompts estao alinhados com a visao do produto
   - UltimateDEV: primeiro teste real pelo usuario PENDENTE

2. UltimateDEV -> Claude: integracao FUNCIONAL mas com ressalvas
   - TESTADO VIA CHROME (sessao 3):
     * PING: OK | COMANDO -> PLANO: OK | APROVACAO -> CODIGO: OK | GIT COMMIT: OK
     * GIT PUSH: CORRIGIDO (remote origin dinamico com GITHUB_TOKEN)
   - OTIMIZACOES (sessao 4):
     * Contexto reduzido: MAX_LINES 800->400, RADIUS 30->12, STOP_WORDS PT-BR
     * ATENCAO: nao filtrar CSS de HTML (testado e revertido -- quebra edicao de estilos)
   - TEMA VISUAL: mudado de verde matrix para branco/clean (sessao 4)
   - PROBLEMA CONHECIDO: devQueue em RAM, perde comandos no redeploy do Render
     * Solucao futura: persistir fila no Firebase
   - RESTRICOES DO AGENTE (para o usuario saber):
     * Contexto limitado (400 linhas/arquivo, raio 12)
     * Nao cria arquivos novos do zero (apenas edita existentes)
     * Mudancas muito grandes ou multi-arquivo sao mais arriscadas
     * Pode falhar silenciosamente se old_string nao matcheia exatamente

3. TouchGames fluxo completo -- nunca foi testado end-to-end.

4. Camera/Screen no UltimateDEV -- implementado mas NAO testado.

### MEDIA PRIORIDADE:
4. Escriba system -- implementado, auto-flush a cada 2min, nao testado em sessao real.
5. Stripe Express Checkout -- preparado mas desativado.

### BAIXA PRIORIDADE:
6. Convite via sonic touch no lobby (encosta em alguem = convite de jogo)
7. Atualizar checkout das assinaturas com novo design

=================================================================
## GIT LOG RECENTE (25/02/2026)
=================================================================

4e9100c fix: tema UltimateDEV de verde matrix para branco clean + reverter filtro CSS
25fb5c6 feat: painel DEV Monitor no admin + otimizacao de contexto do UltimateDEV
703fc78 fix: corrigir crash bank.conversations undefined (bug de migracao)
7ea05ad fix: logging robusto v3 + fallback URL no handleComandoDev e handleAprovarPlano
cb22764 feat: suporte Apple Pay com rota .well-known para verificacao de dominio
5dd78d9 fix: trocar _fetchWithTimeout por fetch puro em todas funcoes DEV (Safari iOS)
aca07e7 feat: integracao Stripe completa com deteccao de regiao e multi-moeda
09741ae docs: roadmap de lancamento EUA + status da LLC no PROMPT
918add3 docs: plano de empresa USA + prompt do agente fiscal/contabil
0ba074f docs: atualizar PROMPT-NOVO-CHAT.md com todas as mudancas da sessao 3
fb755d8 fix: criar remote origin no Render quando nao existe
c826dfa fix: pegar URL do remote automaticamente em vez de hardcoded
b3106e3 fix: configurar git remote origin com GITHUB_TOKEN para push no Render
cc30292 feat: retry automatico com backoff em 429/529 da Anthropic API
0626f72 fix: voltar Opus na geracao + personalidade amigo tradutor + contexto otimizado

## ROLLBACK RAPIDO

Se algo quebrar, voltar para commits estaveis:
- ANTES do DEV Monitor + otimizacao contexto: git reset --hard 703fc78
- ANTES do tema branco UltimateDEV: git reset --hard 25fb5c6
- ANTES do UltimateDEV consciousness: git reset --hard d07a15f
- ANTES do VA admin panel: git reset --hard 540d994
- ANTES do 3-tier VA: git reset --hard ca25ac5
- ANTES do redesign visual: git reset --hard 1ccd782
- ANTES do voice agent inteiro: git reset --hard 1ffc98f

Apos rollback: git push --force origin main (CUIDADO: sobrescreve GitHub)

## VARIAVEIS DE AMBIENTE (Render Dashboard)

Todas configuradas e verificadas em 25/02/2026:
- ADMIN_SECRET (protege endpoints admin)
- ANTHROPIC_API_KEY (cerebro de dev do UltimateDEV -- Claude Opus 4)
- APP_URL=https://touch-irl.com
- FIREBASE_API_KEY, FIREBASE_APP_ID, FIREBASE_AUTH_DOMAIN
- FIREBASE_MESSAGING_SENDER_ID, FIREBASE_PROJECT_ID
- FIREBASE_SERVICE_ACCOUNT, FIREBASE_STORAGE_BUCKET
- GITHUB_REPO (repo do projeto no GitHub -- bavkiq-hUgby8-cittet/encosta)
- GITHUB_TOKEN (Personal Access Token classic, permissao repo, sem expiracao)
- MP_ACCESS_TOKEN, MP_APP_ID, MP_CLIENT_SECRET, MP_PUBLIC_KEY
- MP_REDIRECT_URI, MP_WEBHOOK_SECRET
- OPENAI_API_KEY (para voz em tempo real dos 3 assistentes)

## FLUXOS DE PAGAMENTO

1. GORJETAS (tipScreen): PIX, cartao novo, cartao salvo one-tap, Checkout Pro MP
2. ASSINATURAS (subscriptionScreen): Touch Plus R$50/mes, Selo R$10/mes
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap com cartao salvo
4. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
5. PRESENTES: Comprados com pontos (sem dinheiro real)

=================================================================
## EMPRESA NOS EUA -- EXPANSAO INTERNACIONAL (atualizado 25/02/2026)
=================================================================

### STATUS DA LLC:
- Empresa: touch irl, LLC
- Estado: Delaware (via Stripe Atlas)
- Status: INCORPORACAO EM ANDAMENTO (esperado 27 Fev - 3 Mar 2026)
- EIN (Tax ID): Pendente (3-6 semanas apos incorporacao)
- Conta bancaria: Mercury (sera aberta apos incorporacao)
- Stripe US: Sera ativado apos incorporacao
- Custo: US$500 (pago)

### PROXIMOS PASSOS APOS INCORPORACAO:
1. Abrir conta Mercury (banco digital US) -- desbloqueia apos incorporacao
2. Ativar Stripe payments -- desbloqueia apos incorporacao
3. Configurar lembretes fiscais -- DISPONIVEL AGORA no Atlas
4. Registrar no FinCEN como MSB -- ate 180 dias apos abertura (Form 107, gratuito)
5. Implementar Stripe Connect no server.js (agente financeiro)
6. Traduzir app para ingles (agente tradutor)

### PRAZOS FISCAIS (a partir da abertura):
- FinCEN MSB Registration: ate ~agosto 2026 (180 dias)
- Delaware Annual Tax: US$300, prazo 1 junho 2027
- Delaware Annual Report: prazo 1 junho 2027
- Form 5472 + Form 1120 pro-forma (IRS): 15 abril 2027
- IRPF Brasil (declarar LLC no exterior): abril 2027

### ESTRUTURA FISCAL:
- Tipo: Single-Member LLC (foreign-owned disregarded entity)
- Tributacao: Pass-through (lucro passa direto pro dono)
- Stripe Connect cobre licenca MTL (Money Transmitter License)
- Precisa de CPA (contador US) para: classificacao ECI, tratado bitributacao BR-US, Form 5472

### MERCADOS-ALVO (ordem de lancamento):
1. EUA (English US) -- PRIORIDADE #1
2. Brasil (PT-BR) -- ja operando
3. America Latina (Espanhol LATAM) -- segundo mercado
4. Japao (Japanese) -- terceiro mercado

### AGENTES PREPARADOS PARA EXPANSAO:
- PROMPT-TRADUTOR.md -- Arquiteto de linguagens (i18n para 4 idiomas)
- PROMPT-FINANCEIRO.md -- Integracoes financeiras (Stripe Connect)
- PROMPT-FISCAL.md -- Fiscal, contabil e conciliacao (compliance US+BR)
- PLANO-EMPRESA-USA.docx -- Guia completo da abertura da LLC

### DOCUMENTOS DE REFERENCIA:
- AUDITORIA-TOUCH-2026.docx -- Auditoria de seguranca e performance (30+ fixes)
- PLANO-EMPRESA-USA.docx -- Plano de abertura de empresa nos EUA
- PROMPT-FINANCEIRO.md -- Prompt para agente de integracoes financeiras
- PROMPT-TRADUTOR.md -- Prompt para agente de i18n
- PROMPT-FISCAL.md -- Prompt para agente fiscal/contabil

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!
