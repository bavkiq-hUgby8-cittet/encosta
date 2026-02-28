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

## CONTEXTO DO APP

Touch? e um app de conexao por proximidade. Pessoas se aproximam fisicamente,
o celular detecta via ultrassom (~18-22kHz), e cria uma relacao anonima de 24h.
Podem se revelar, dar estrelas, fazer check-in em eventos, enviar presentes digitais.

Stack: Node.js + Express + Socket.IO + Firebase RTDB
Frontend: HTML/CSS/JS vanilla SPA (~19.5k linhas)
Backend: server.js monolito (~13.7k linhas)
Deploy: Render -> touch-irl.com (Cloudflare DNS)

## FUNCIONALIDADES (20 features)

Ultrasom, Chat 24h, Reveal, Constelacao, Eventos, Estrelas, Presentes,
Boarding Pass, Selfie, Voice Agent 3-Tier, TouchGames (11 jogos),
Assinaturas (Plus/Selo), Gorjetas (MP + Stripe), Extrato, Swipe-back,
Restaurante, Mural (9 AI agents), Radio Touch, Stripe Connect, Nacionalidade.

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

### Painel Operacional (operator.html)
- Tres telas: opLogin -> opEvents -> opApp (dentro do evento)
- Backgrounds usam gradientes deep purple coordenados entre todas as telas
- Canvas do aquarium: logo do evento no centro via S._eventLogoReady/S._eventLogoImg
- IMPORTANTE: resetar S._eventLogoLoaded, S._eventLogoReady, S._eventLogoImg ao trocar de evento (em opSelectEvent)
- Sidebar lateral (op-sidebar) tem lista de participantes com status de entrada (liberar/pago/remover)
- Socket events: checkin-created, entry-skipped, operator-event-update, event-attendee-joined/left

### Event View do Usuario (index.html)
- Tela eventView com canvas que renderiza aquarium de participantes
- Logo no centro via window._evLogoImg / window._evLogoLoaded
- API /api/operator/event/:id/attendees retorna eventLogo (ja com proxy)
- Workflow de pagamento: Pagar ou Pular -> operador decide (liberar/pago presencial/remover)

### Entry Management (fluxo de entrada)
- Usuario pula pagamento -> socket 'entry-skipped' emitido ao operador
- Operador ve alerta discreto com 3 opcoes: liberar, pagamento presencial, remover
- Status salvo em ev.attendees[userId].entryStatus via POST /api/operator/event/:id/attendee-status
- Badges coloridos na lista de participantes (verde=liberado, amarelo=presencial, vermelho=removido)

## STATUS ATUAL (28/02/2026)

- App funcionando em producao (touch-irl.com)
- touch irl, LLC em Delaware -- incorporacao em andamento
- Stripe implementado no codigo (pendente ativar chaves no Render)
- Dashboard financeiro admin completo (receita, taxas, payouts, prestadores)
- Sistema de payout manual para prestadores sem Stripe/MP
- Stripe Connect por evento (conta separada por evento)
- 30+ fixes de seguranca/performance aplicados
- i18n parcial (frases poeticas traduzidas, UI pendente)
- Painel operacional com glass morphism, logo de eventos, entry management
- Proxy de imagens /api/storage/* para contornar CORS do Firebase Storage
- Proximo: traduzir UI para ingles (mercado US e prioridade #1)

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!
