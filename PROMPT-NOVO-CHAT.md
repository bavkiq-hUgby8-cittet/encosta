# PROMPT PARA INICIAR NOVO CHAT -- Touch? (Encosta)

Copie e cole o texto abaixo ao iniciar um novo chat com outro agente:

---

## O Prompt:

```
Voce vai me ajudar a continuar o desenvolvimento do app "Touch?" (Encosta) -- uma rede social baseada em proximidade fisica (ultrassonica).

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## ACESSO AO PROJETO

1. PASTA NA MAQUINA: a pasta "encosta" no meu computador
2. GITHUB: https://github.com/bavkiq-hUgby8-cittet/encosta.git
   - Token configurado no remote do git local
3. GIT CONFIG: Email: ramonnvc@hotmail.com | Nome: Ramon

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta
2. git pull origin main
3. git log --oneline -10
4. Leia ESTE arquivo (PROMPT-NOVO-CHAT.md)
5. Leia o doc relevante para sua tarefa (ver DOCUMENTACAO abaixo)
6. Me diga o que encontrou e pergunte o que preciso

## REGRAS DE TRABALHO

- SEMPRE git pull origin main ANTES de editar qualquer arquivo
- Sempre commit com mensagem descritiva + push apos cada tarefa
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo -- usamos SVGs vetoriais para icones
- Valide JS com node -e antes de cada commit

## CONTEXTO DO APP

Touch? e um app de conexao por proximidade. Pessoas se aproximam fisicamente,
o celular detecta via ultrassom (~18-22kHz), e cria uma relacao anonima de 24h.
Podem se revelar, dar estrelas, fazer check-in em eventos, enviar presentes digitais.

Stack: Node.js + Express + Socket.IO + Firebase RTDB
Frontend: HTML/CSS/JS vanilla SPA (~20k+ linhas)
Backend: server.js monolito (~14k+ linhas)
Deploy: Render -> touch-irl.com (Cloudflare DNS)

## FUNCIONALIDADES (20+ features)

Ultrasom, Chat 24h, Reveal, Constelacao, Eventos, Estrelas, Presentes,
Boarding Pass, Selfie, Voice Agent 3-Tier, TouchGames (11 jogos),
Assinaturas (Plus/Selo), Gorjetas (MP + Stripe), Extrato, Swipe-back,
Restaurante, Mural (9 AI agents), Radio Touch, Stripe Connect, Nacionalidade.

## PAINEL OPERACIONAL (operator.html) -- CONTEXTO DETALHADO

### Arquitetura do Painel
- Tres telas: opLogin -> opEvents -> opApp (dentro do evento)
- Backgrounds usam gradientes deep purple coordenados entre telas
- Canvas do aquarium: logo do evento no centro via S._eventLogoReady/S._eventLogoImg
- Sidebar lateral direita (op-sidebar, 280px) com lista de participantes
- FAB cascade (botoes flutuantes) no canto direito: Participantes, Perfil, Financeiro, Sorteio, [modulos], Pausar

### Sistema de Modulos
Eventos tem modulos selecionaveis via checkboxes no Perfil:
- Restaurante (laranja #f97316) -- cardapio, pedidos, mesas
- Estacionamento (azul #3b82f6) -- veiculos, cobranca, OCR
- Academia (verde #10b981) -- aulas, planos, alunos
- Igreja (roxo #8b5cf6) -- dizimos, cultos, celulas
Armazenados em ev.modules = {restaurant: bool, parking: bool, gym: bool, church: bool}
FABs dos modulos so aparecem se o modulo esta ativo.

### Modulo Perfil (Facebook blue #1877f2)
- Segundo FAB (abaixo de Participantes)
- Painel com: logo upload, nome, tipo, descricao, frase de boas-vindas, endereco, telefone, whatsapp, website, instagram, horario, delivery, pagamento
- Cards de modulo com SVG icons coloridos (nao emojis!) e checkbox visual
- Barra de progresso de completude do perfil
- CSS usa --mod-accent:#1877f2, --mod-accent2:#42a5fa e variantes rgba

### Glass Morphism CSS
- Todos os paineis de modulo usam classe .mod-panel com variaveis CSS:
  --mod-accent, --mod-accent2, --mod-accent-30, --mod-shadow, --mod-glow, --mod-glow2, --mod-bg1, --mod-bg2, --mod-tab-bg, --mod-tab-border
- Cards internos usam .mod-card com efeito glass (backdrop-filter:blur)
- Tabs com .mod-tab e .mod-tab.active
- Inputs/textareas com .mod-input

### Sistema de Notificacoes de Chat
- Badge vermelho pulsante (.op-ci-msg-badge) no card do usuario quando manda msg
- Contador total no header do sidebar (#opMsgNotifCount)
- Toast notification com preview da msg e som (AudioContext 880Hz)
- Highlight azul (.has-unread) no card com mensagens pendentes
- Limpa automaticamente ao abrir chat com o usuario
- State: unreadMsgs = {userId: count}

### Chat + Historico por Usuario
- Chat panel (.op-chat) desliza sobre o sidebar
- Abas: Chat (mensagens tempo real) | Historico (transacoes)
- Aba Historico carrega gorjetas e status de entrada do usuario
- switchChatTab('chat'|'history'), loadUserHistory(userId)

### Endpoints de API do Operador (server.js)
- POST /api/operator/event/create -- cria evento
- POST /api/operator/event/:id/end -- pausa evento (nao encerra definitivamente)
- POST /api/operator/event/:id/reopen -- reabre evento pausado
- POST /api/operator/event/:id/update -- edita tudo (nome, frase, preco, modulos, etc)
- POST /api/operator/event/:id/attendee-status -- status de entrada (freed/presencial/paid)
- GET /api/operator/event/:id/parking/vehicles -- dados de veiculos
- GET /api/operator/event/:id/gym -- dados da academia
- GET /api/operator/event/:id/church -- dados da igreja
- GET /api/tips/:userId -- gorjetas do operador
- GET /api/prestador/:userId/dashboard -- dashboard financeiro completo

### Socket Events do Operador
- checkin-created -- novo check-in (userId, nickname, color, profilePhoto, relationId, revealed, revealData)
- entry-skipped -- usuario pulou pagamento
- new-message -- msg do chat (relationId, message)
- identity-revealed -- usuario revelou identidade
- tip-received -- gorjeta recebida
- operator-event-update -- evento criado/pausado/reaberto/atualizado
- event-attendee-joined / event-attendee-left

### Welcome Card System (index.html)
- Quando usuario faz check-in, recebe welcome card com modulos do evento
- Server envia moduleWelcome array no socket relation-created
- Card glass morphism com botoes de acao por modulo
- dismissWelcomeCard() para fechar

### Dados por Check-in (S.checkins)
{userId, nickname, color, profilePhoto, timestamp, relationId, revealed, revealData:{realName,instagram,phone,email,bio}, stars, topTag, score, entryStatus}

### Funcoes Load dos Modulos
- Todas usam fetch() para endpoints API (NAO db.operatorEvents que e server-side)
- showToast() para feedback visual
- Cargas de teste: populateTestParking(), populateTestGym(), populateTestChurch()

## DOCUMENTACAO (leia o que for relevante)

| Documento | Conteudo |
|-----------|----------|
| docs/ARQUITETURA.md | Mapa tecnico do server.js + index.html, env vars, collections, pagamentos |
| docs/VOICE-AGENT.md | Sistema de 3 tiers, tools, fluxos, anti-echo, UltimateDEV |
| docs/SEGURANCA.md | Auditoria consolidada, vulnerabilidades, fixes, compliance |
| docs/I18N.md | Inventario de textos, arquivos de traducao, status por idioma |
| docs/USA-LLC.md | LLC, fiscal, roadmap EUA (7 fases), prazos, custos |
| docs/PENDENCIAS.md | O que falta testar, bugs conhecidos, prioridades, rollback |
| docs/CHANGELOG.md | Historico de todas as sessoes de desenvolvimento |
| docs/ULTIMATEDEV.md | Documentacao detalhada do Voice Agent UltimateDEV |
| docs/API.md | Documentacao completa das APIs REST |

## PROMPTS DE AGENTES ESPECIALIZADOS

| Prompt | Para que |
|--------|---------|
| PROMPT-TRADUTOR.md | Internacionalizar o app (4 idiomas) |
| PROMPT-FINANCEIRO.md | Stripe Connect + pagamentos US |
| PROMPT-FISCAL.md | Compliance fiscal US+BR, conciliacao |

## OBSERVACOES TECNICAS IMPORTANTES

### Firebase Storage e CORS
- Firebase Storage (bucket encosta-f32e7) NAO tem CORS configurado para touch-irl.com
- NUNCA use crossOrigin='anonymous' em Images carregadas do Firebase Storage
- Todas as URLs de imagens do Storage passam pelo proxy /api/storage/* no server.js
- A funcao proxyStorageUrl() converte URLs antigas do GCS para o proxy local
- A funcao uploadBase64ToStorage() ja retorna URLs no formato /api/storage/path

### Event View do Usuario (index.html)
- Tela eventView com canvas que renderiza aquarium de participantes
- Logo no centro via window._evLogoImg / window._evLogoLoaded
- API /api/operator/event/:id/attendees retorna eventLogo (ja com proxy)
- Workflow de pagamento: Pagar ou Pular -> operador decide (liberar/pago presencial/remover)

### Entry Management (fluxo de entrada)
- Usuario pula pagamento -> socket 'entry-skipped' emitido ao operador
- Operador ve alerta discreto com 3 opcoes: liberar, pagamento presencial, remover
- Status salvo em ev.attendees[userId].entryStatus via POST /api/operator/event/:id/attendee-status
- Badges coloridos na lista (verde=pago, azul=liberado, amarelo=presencial)

## DEPLOY (Render.com)

- Servico: Web Service no Render (encosta.onrender.com)
- Build command: npm install
- Start command: node server.js
- Node version: >=18 (definido no package.json engines)
- Auto-deploy: ativado (push na main = deploy automatico em ~90 segundos)
- Dominio customizado: touch-irl.com (DNS via Cloudflare, 301 do onrender)
- Env vars: configuradas no painel do Render (ver docs/ARQUITETURA.md ou .env.example)
- render.yaml: Infrastructure as Code na raiz do repositorio
- IMPORTANTE: apos cada push, aguardar ~90s para o deploy concluir no Render

## STATUS ATUAL (01/03/2026)

- App funcionando em producao (touch-irl.com)
- touch irl, LLC em Delaware -- incorporacao em andamento
- Stripe implementado no codigo (pendente ativar chaves no Render)
- Dashboard financeiro admin completo (receita, taxas, payouts, prestadores)
- Painel operacional com glass morphism, modulos, perfil, notificacoes de chat
- 4 modulos operacionais: Restaurante, Estacionamento, Academia, Igreja
- Modulo Perfil completo com gestao de dados do negocio
- Sistema de notificacao de chat com badges, som e toast
- Abas Chat/Historico no painel de conversa com transacoes por usuario
- Welcome card system para mostrar modulos no check-in do usuario
- Eventos podem ser pausados e reabertos (nao encerram definitivamente)
- Proxy de imagens /api/storage/* para contornar CORS do Firebase Storage
- 30+ fixes de seguranca/performance aplicados
- i18n parcial (frases poeticas traduzidas, UI pendente)

## COMMITS RECENTES

- d2d8c1d Notificacoes de chat + historico por usuario no painel Participantes
- 5d4ba4d UI: Perfil com cores Facebook, SVG icons nos modulos, limpar header
- 7519de2 Fix sidebar nesting and duplicate fullscreen button
- 97d1f98 Create Profile module as primary FAB
- 3a31af6 Fix broken module load functions - use API endpoints
- b232fcc Fix test data loading for parking, gym, church
- e6e6a39 Reopen events, module selection, event editing
- ee66088 Glass morphism for Parking, Gym, Church panels

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!
