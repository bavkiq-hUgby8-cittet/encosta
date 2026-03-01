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
| PROMPT-JURIDICO.md | Termos, LGPD, GDPR, PI, contratos, estrutura societaria |

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
- Site institucional (site.html) redesenhado com video hero, particulas, 3D animations
- Card de conexao animado (shareConnectionVideo) para Instagram Stories
- 3 videos Veo 3 gerados (bar-tipping, restaurant-checkin, rooftop-connection)
- 12 prompts de imagem cinematica preparados (PROMPTS-IMAGENS-GEMINI.md)
- GTM strategy doc criado (GTM-GORJETA-USA.docx)
- Restricao legal: somente maiores de 18 anos (definido pelo agente juridico)

## ESTRATEGIA DE LANCAMENTO E MARKETING (MUITO IMPORTANTE)

### Visao Geral
- Lancamento PRIMEIRO nos EUA, depois expandir para outros paises
- Estrategia 100% REMOTA -- Ramon (Zito) mora no Brasil, nao vai para os EUA
- Canal principal: REDES SOCIAIS (Instagram, TikTok, YouTube) com trafego pago
- Todo conteudo criativo (videos, imagens, textos) feito 100% com IA
- Orcamento inicial: $1K-2K/mes em paid traffic
- Foco inicial: GORJETAS DIGITAIS como porta de entrada (mercado de $50B+/ano nos EUA)

### Mercado de Gorjetas nos EUA (pesquisa feita)
- $50B+ por ano em gorjetas
- 85% ja sao digitais
- 74% dos restaurantes tem tipping digital
- +23% de ganho com digital vs cash-only
- Concorrentes: Tippy ($6.1M funding), eTip ($990K), TipHaus, Canary, bene
- DIFERENCIAL do Touch?: nenhum concorrente tem camada social + ultrassom

### Duas Frentes de Aquisicao
1. PRESTADORES DE SERVICO (supply side): bartenders, barbeiros, valets, DJs, nail techs
   - Convencer que podem receber gorjetas digitais sem intermediario
   - Modo Operador para gerenciar rotinas do local
2. CONSUMIDORES (demand side): quem da gorjeta + quem quer conexoes sociais
   - App web, sem download, 15 segundos pra cadastrar
   - QR code resolve o cold-start problem (nao precisa dos dois terem o app antes)

### Estrategia de Marketing em 3 Frentes
1. CASE VIRAL -- "Zito: 1 pessoa sem saber programar + Claude = app de pagamentos e rede social em 20 dias"
   - Narrativa: solo founder brasileiro, sem codigo, usando apenas IA
   - Cases de referencia: Base44 vendida por $80M, Yaphone feito em 1 weekend, 52.3% dos exits sao solo founders
   - Formato: threads no X/LinkedIn, videos curtos pro TikTok/Reels, posts no Reddit (r/startups, r/SideProject)
   - Headlines: "How one person who can't code built a payment network in 20 days with AI"

2. CONTENT MACHINE 100% IA -- todo conteudo feito com IA
   - Videos: Google Veo 3 / Veo 3.1 Fast (3 videos/dia gratis)
   - Imagens: Gemini image generation ("nano banana")
   - Textos: Claude para copy, roteiros, threads
   - 3 idiomas: EN, PT, ES
   - Formato vertical 9:16 para Reels/TikTok/Shorts

3. INFLUENCER SEEDING -- micro-influencers tech/startup
   - Tier 1: tech creators (10K-100K followers) -- enviar o case
   - Tier 2: bartender/service industry creators -- mostrar o tipping
   - Tier 3: solo founder/indie hacker community -- compartilhar o build story

### Trafego Pago (budget $1K-2K/mes)
- TikTok 60% (CPC $0.35-1.00, melhor para viral)
- Instagram 30% (CPC ~$1.10, targeting preciso)
- YouTube 10% (CPC $0.10-0.30, awareness)
- Segmentacao: 18-35, US metros (NYC, LA, Miami, Austin, SF)

### Posicao Correta dos Celulares no Touch (CRITICO PARA TODO CONTEUDO)
- Os celulares ficam COM AS TELAS VIRADAS UMA PARA A OUTRA (screen-to-screen)
- Cada pessoa segura o celular na vertical, tela apontando pro celular do outro
- As costas dos celulares ficam viradas para fora (para a camera/espectador)
- Os alto-falantes ficam na parte de baixo
- E como se os celulares estivessem "se olhando" -- tela contra tela
- NAO e topo-com-topo, NAO e costas-com-costas, NAO e lado a lado com telas pra cima
- Toda imagem, video, animacao e prompt DEVE seguir essa posicao

## SITE INSTITUCIONAL (public/site.html)

### Filosofia
- A ESSENCIA do Touch? e a conexao por som ultrassonico -- isso e a magia
- O gesto de encostar os celulares e o mais natural e humano
- Site deve transmitir: cinematografico, premium, real, humano, moderno

### Estrutura Atual
- Hero com video de fundo (Veo 3) + particulas canvas + animacao 3D dos celulares
- Secao "How it Works" (3 passos)
- Secao "The Magic" (ultrassom, ondas, barras de frequencia)
- Secao "See it Live" (3 videos Veo 3 em cards)
- Secao Features (6 cards glassmorphism)
- Secao Tipping (stats com counter animation + fluxo 3 passos)
- Secao QR Code (onboarding sem fricao)
- Secao For Business (3 cards: prestadores, operadores, eventos)
- Secao Privacy (3 cards)
- Secao "Built Different" (historia do Zito: 1 pessoa, 1 IA, 20 dias)
- FAQ (7 perguntas)
- CTA final
- i18n completo: EN, PT, ES com auto-deteccao de idioma

### Cores da Marca
- --orange: #ff6b35 (principal)
- --pink: #ff3c6e (accent)
- --bg: #050508 (fundo escuro)
- --card: #0a0a12

### Assets de Media
- Videos: public/media/videos/ (bar-tipping.mp4, restaurant-checkin.mp4, rooftop-connection.mp4)
- Imagens: pendente geracao via Gemini (prompts em PROMPTS-IMAGENS-GEMINI.md)

## CADASTRO DO USUARIO

- Campos: nickname, data de nascimento, email, SENHA
- Restricao: 18+ obrigatorio (agente juridico definiu)
- Sem download de app -- funciona 100% no browser
- QR code pessoal de cada usuario para onboarding de novos

## FUNCIONALIDADES CORE (resumo expandido)

- ULTRASSOM: conexao por proximidade via speaker/mic (~18-22kHz)
- CHAT 24H: chat que expira em 24h se nao renovar a conexao
- REVEAL: revelar identidade seletivamente (nome, foto, instagram, whatsapp)
- CONSTELACAO: mapa visual animado do universo social do usuario
- ESTRELAS: reputacao fisica de 0 a 10 (nao pode ser falsificada)
- GORJETAS: tipping digital via Apple Pay, Google Pay, Stripe, PIX
- EVENTOS: check-in, ingresso, conexoes em grupo
- CAIXINHA DE SOM: speaker device com LED na entrada de locais pra check-in automatico
- OPERADOR: modo de gestao para donos de local (check-in, contas, gorjetas, eventos)
- PRESENTES DIGITAIS: enviar presentes entre usuarios
- SELFIE: selfie no momento da conexao
- BOARDING PASS: comprovante da conexao
- SHARE CARD: card estatico (PNG) ou video animado (MP4) da conexao pra compartilhar

## DOCUMENTOS DE ESTRATEGIA

| Documento | Conteudo |
|-----------|----------|
| PROMPTS-VEO3-BATCH1.md | 16 prompts de video para Google Veo 3 (4 cenarios x variantes) |
| PROMPTS-IMAGENS-GEMINI.md | 12 prompts de imagem cinematica para Gemini |
| GTM-GORJETA-USA.docx | Estrategia go-to-market completa para gorjetas nos EUA |

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!

---

## GATEWAY DE PAGAMENTO UNIFICADO (IMPORTANTE - NAO DUPLICAR!)

Existe UMA UNICA funcao de gateway de pagamento: `renderUnifiedPaymentGateway(containerId, opts)`.
Ela esta definida em `public/index.html` proximo a `getPaymentMethodBtnHTML()`.

**REGRA ABSOLUTA:** Todo checkout do app DEVE usar essa funcao. NUNCA criar botoes de pagamento avulsos.
Se precisar mudar algo no gateway, muda NESSA funcao e automaticamente muda em TODOS os checkouts.

### Como usar:
```javascript
renderUnifiedPaymentGateway('meuContainerId', {
  prefix: 'prefixoUnico',    // prefixo para IDs dos elementos (obrigatorio, deve ser unico)
  price: 49.90,              // valor em reais
  label: 'Meu Produto',      // label para Apple Pay / Stripe
  type: 'order',             // tipo para o backend (order, delivery, entry, tip)
  eventId: 'abc123',         // ID do evento
  showCounter: true,         // mostrar opcao "Na entrega" (so delivery)
  onConfirm: function(result){ /* chamado apos pagamento aprovado */ },
  onMethodSelect: function(method){ /* chamado ao trocar metodo */ }
});
```

### O que o gateway inclui automaticamente:
- Apple Pay (detecta iOS) e Google Pay (detecta Android) no TOPO, com botoes grandes
- Stripe Payment Element inline (cartao + Link)
- PIX
- Cartao salvo (com CVV para confirmar)
- Novo cartao (formulario completo: numero, validade, CVV, CPF, salvar)
- Opcao "Na entrega" (quando showCounter:true)
- Badge de seguranca (SSL + cadeado)

### Funcoes auxiliares do gateway (NAO chamar diretamente):
- `ugwToggleOther(pfx)` - abre/fecha painel de metodos
- `ugwSelectMethod(pfx, method)` - seleciona metodo
- `ugwLoadSavedCard(pfx, price)` - carrega cartao salvo do localStorage
- `ugwPaySavedCard(pfx)` - paga com cartao salvo
- `ugwShowNewCardForm(pfx)` - mostra form de novo cartao
- `ugwPayNewCard(pfx)` - processa novo cartao
- `ugwInitExpress(pfx, price)` - inicia Apple Pay / Google Pay
- `ugwExpressCheckout(pfx)` - processa pagamento express
- `ugwMountStripe(pfx, price)` - monta Stripe Payment Element
- `ugwConfirmStripe(pfx)` - confirma pagamento Stripe

### Onde esta sendo usado atualmente:
1. **Checkout do evento (restaurante):** `renderCheckout()` -> containerId='evMenuPayGateway'
2. **Checkout do delivery:** `renderDelCheckout()` -> containerId='delPayGateway'
3. **Ingresso de evento:** `showEntryCardForm()` (esse ainda usa o gateway antigo, mas o layout e identico)

### SVGs e logos:
- `PAY_LOGOS` - logos grandes (32x32) de todos os metodos
- `PAY_LOGOS_MINI` - logos compactos para badges de bandeira
- `CARD_BRANDS` - deteccao automatica de bandeira pelo numero do cartao
- `getPaymentMethodBtnHTML(method, opts)` - gera botao de metodo (auxiliar, prefira o gateway unificado)
- `getCardBrandBadgesHTML()` - row de badges de bandeiras
- `getCardBrandSVG(brand, size)` - SVG de bandeira individual

## SEPARACAO FISCAL: PRODUTOS vs SERVICOS (IMPORTANTE - SEFAZ)

### Regra Geral
- **Produtos (comida/bebida/frete)** = NF-e (Nota Fiscal Eletronica) -> SEFAZ estadual -> ICMS
- **Servicos (gorjeta)** = NF-S (Nota Fiscal de Servico) -> Prefeitura -> ISS
- NUNCA misturar produtos e servicos na mesma nota fiscal

### Dados Fiscais nos Pedidos
Todo pedido (restaurante e delivery) agora salva um objeto `fiscal`:
```
fiscal: {
  productAmount: 100.00,       // Base NF-e
  serviceAmount: 15.00,        // Base NF-S (gorjeta)
  deliveryAmount: 8.00,        // Frete (NF-e)
  productFiscalType: 'NF-e',
  serviceFiscalType: 'NF-S',   // null se sem gorjeta
  cfop: '5.102',               // Venda merc. adquirida dentro estado
  cst: '00',                   // CST ICMS normal
  ncm: '2106.90.90',           // NCM refeicoes prontas
  issCode: '09.02',            // ISS intermediacao servicos
  nfeStatus: 'pending',        // pending | emitted | error
  nfsStatus: 'pending'         // pending | emitted | error | null
}
```

### Endpoint Fiscal
`GET /api/operator/event/:eventId/fiscal-summary` retorna:
- `summary.totalProducts` - base NF-e (produtos)
- `summary.totalDeliveryFee` - frete (incluso NF-e)
- `summary.totalServices` - base NF-S (gorjetas)
- `summary.totalGross` - faturamento bruto
- `summary.nfeBase` - base final NF-e (produtos + frete)
- `summary.nfsBase` - base final NF-S
- `summary.nfeCount` / `nfsCount` - qtd documentos necessarios
- `fiscalConfig` - CFOP, CST, NCM, ISS code

### Exibicao nas Telas
Todas as telas agora separam claramente:
- **Meus Pedidos (cliente)**: Produtos R$X + Gorjeta R$Y = Total R$Z
- **Post-it kanban (operador)**: Produtos + Gorjeta separados
- **Dashboard stats**: "Produtos (NF-e)" + "Gorjetas (NF-S)" + "Total Bruto"
- **Detalhe de mesa**: Subtotal produtos + gorjetas + total
- **Comanda impressa**: Subtotal Produtos + Gorjeta + Total
- **Delivery card**: Prod + Gorj = Total

### Proximos Passos para SEFAZ
1. Integrar API de emissao NF-e (ex: NFe.io, Enotas, Focus NFe)
2. Integrar API de emissao NF-S (varia por municipio)
3. Usar `fiscal.nfeStatus`/`nfsStatus` para rastrear emissao
4. CFOP pode variar: 5.102 (dentro estado) vs 6.102 (fora estado)
5. Regime tributario: definir se Simples Nacional, Lucro Presumido, etc
