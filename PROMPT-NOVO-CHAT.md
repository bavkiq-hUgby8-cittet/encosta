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

## ESTRUTURA DO PROJETO (atualizado 22/02/2026)

Arquivos principais:
- `server.js` (7063 linhas) -- Backend Node.js + Express + Socket.IO + Firebase RTDB
- `public/index.html` (11658 linhas) -- Frontend SPA completo (23+ telas)
- `public/games/index.html` (1909 linhas) -- TouchGames lobby (microservico iframe)
- `public/games/*.html` -- 11 jogos individuais (campo-minado, dama, xadrez, memory, rali, reflexo, cor-errada, empilha, impostor, speed-tap, 2048)
- `public/operator.html` -- Painel do operador de eventos
- `public/operator-restaurant.html` -- Painel do restaurante
- `public/site.html` -- Landing page
- `public/termos.html` -- Termos de uso
- `simulador-estrelas.html` -- Simulador da economia de estrelas
- `package.json` -- Dependencias (express, socket.io, firebase-admin, mercadopago, helmet, uuid, express-rate-limit)
- `docs/` -- Documentacao tecnica (API.md, CHANGELOG.md, RESUMO-PROJETO.md, SESSION-STATE.md)
- `CHANGELOG-sessao-*.md` -- Changelogs por sessao

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta na minha maquina
2. `git log --oneline -20` para ver o historico recente
3. Leia este arquivo (PROMPT-NOVO-CHAT.md) por completo
4. Leia o CHANGELOG mais recente
5. Me diga em que pe esta o projeto e pergunte o que preciso

## REGRAS DE TRABALHO

- Sempre faca commit com mensagem descritiva em portugues
- Sempre faca push para o GitHub apos cada commit
- SEMPRE salve nos DOIS: maquina E GitHub (nunca um sem o outro)
- Sincronize: o git da maquina deve estar no mesmo commit do GitHub
- Se eu pedir backup, verifique que git status esta clean e push foi feito
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo -- usamos SVGs vetoriais para icones

## CONTEXTO RAPIDO DO APP

Touch? e um app de conexao por proximidade. As pessoas se aproximam fisicamente,
o celular detecta via ultrassom, e cria uma relacao anonima de 24h (chat efemero).
Podem se revelar, dar estrelas, fazer check-in em eventos, enviar presentes digitais.

## FUNCIONALIDADES IMPLEMENTADAS

1. ULTRASOM (Sonic): Deteccao por frequencia ultrassonica (~18-22kHz), gain 0.6, threshold 80, confirm 3, alcance ~10-12cm
2. CHAT 24H: Chat efemero com timer, quick phrases, foto, mensagem efemera, menu plus com 8 opcoes SVG
3. REVEAL: Revelar identidade real exige nome preenchido, mostra nickname+telefone
4. CONSTELACAO: Mapa de conexoes em canvas (nodes = pessoas, links = relacoes)
5. EVENTOS: Operador cria evento, check-in via sonic, menu de restaurante, pedidos
6. ESTRELAS: Economia zero-sum (doar, comprar R$1.49, loja de acessorios, top tag)
7. PRESENTES DIGITAIS: Catalogo com itens que custam estrelas
8. BOARDING PASS: Cartao de embarque com dados do usuario
9. SELFIE NO REVEAL: Foto do casal salva na relacao
10. VOICE AGENT: Agente de voz AI (OpenAI Realtime WebRTC) que conhece a rede social, salva notas, mostra perfis, faz fofoca automatica, maximo 1 frase por resposta
11. TOUCHGAMES: Microservico com 11 jogos, lobby com jogadores online, convites via chat, ready-check para ambos confirmarem, suporte multiplayer via socket
12. ASSINATURAS: Touch Plus R$50/mes (agente AI, acessorios premium, faixa VIP), Selo R$10/mes (selo visual no perfil)
13. GORJETAS: Pagamento via MercadoPago (Pix, cartao, checkout pro, saved card, one-tap)
14. SWIPE-BACK: Gesto de arrastar da borda esquerda pra voltar
15. PAINEL RESTAURANTE: Menu CRUD, pedidos em tempo real, status por mesa

## MAPA DO SERVER.JS (secoes principais)

Linha ~1-150: Imports, seguranca (helmet, rate-limit, CORS, ADMIN_SECRET)
Linha ~180-600: Firebase Admin, DB in-memory, indexes (IDX), top tag calc
Linha ~600-760: Dirty tracking (saveDB), backup/rollback system
Linha ~780-1050: Auth (Firebase verify, link accounts, unificacao de contas)
Linha ~1050-1250: MercadoPago config, phrases bank, zodiac system
Linha ~1400-1800: Sonic matching, session create/join, streak system, NFC/QR links
Linha ~1800-4400: REST APIs (user, relations, messages, constellation, stars, gifts, reveals, likes, profile, notifications, events, selfie, horoscope)
Linha ~4400-4600: Admin endpoints (reset, backup, rollback, recover)
Linha ~4600-4900: Socket.IO (identify, messages, typing, sonic, game lobby, game events)
Linha ~4900-5850: MercadoPago (prestador, tips, pix, checkout, saved card, one-tap, subscription)
Linha ~5850-6080: Assinaturas (Plus + Selo)
Linha ~6080-6440: Voice Agent (OpenAI Realtime, notas, acesso AI)
Linha ~6440-6810: Operator/Events/Restaurant (checkins, settings, events, menu, orders)
Linha ~6810-7063: TouchGames REST API (manifest, sessions, invite-message, find-relation, temp-chat, results, leaderboard)

## MAPA DO INDEX.HTML (secoes principais)

Linha ~1-400: CSS completo (variaveris CSS, telas, componentes, animacoes)
Linha ~400-2800: HTML das 23+ telas (auth, home, constellation, chat, profile, events, stars, gifts, boarding-pass, reveal, operator, games, agent)
Linha ~2800-5600: JavaScript principal (state, socket handlers, API calls, renderizacao)
Linha ~5600-8000: Funcoes de tela (chat, constellation, profile, events, stars)
Linha ~8000-9500: Sonic system, swipe-back, notifications, boarding pass
Linha ~9500-10300: Voice Agent (WebRTC, audio pipeline, fofoca automatica)
Linha ~10300-10900: TouchGames integration (launcher, invite handlers, ready-check modal)
Linha ~10900-11658: Event handlers, game socket events, iframe communication

## TOUCHGAMES -- FLUXO MULTIPLAYER (status atual)

1. Jogador A abre lobby (games/index.html) -> ve "Jogadores no lobby" com avatares
2. Jogador A clica em avatar -> seleciona oponente (busca relacao via /api/games/find-relation)
3. Jogador A clica em jogo multiplayer -> cria session (/api/games/sessions) -> envia convite (/api/games/invite-message)
4. Se nao tem relacao ativa, cria temp-chat automatico (/api/games/temp-chat, 30min)
5. Convite salva como mensagem no chat: [game-invite:gameId:sessionId:gameName:]
6. Jogador B recebe toast (game-invite-notify) + mensagem no chat (new-message)
7. Jogador B abre chat -> ve card com "Jogar" e "Recusar" + timer 60s
8. Jogador B clica "Jogar" -> game-accept -> server emite game-ready-check para AMBOS
9. Ambos veem modal VS "Prontos?" -> clicam "Entrar!" -> game-ready
10. Server: quando 2 prontos -> game-start -> ambos abrem iframe do jogo

PENDENTE/NAO TESTADO:
- Fluxo completo end-to-end (do lobby ate o jogo abrir) NAO foi confirmado funcionando pelo usuario
- Ready-check modal pode ter problemas de timing
- Game-start recarrega iframe do lobby com acceptSession params -- timing sensivel

## DEPLOY

- Render: encosta.onrender.com (auto-deploy do GitHub, 2-3min build)
- Firebase: Realtime Database para persistencia
- MercadoPago: Pagamentos (Pix, cartao, checkout)

## ULTIMOS COMMITS (22/02/2026 -- sessao mais recente)

df8493d feat: sistema de assinaturas Plus R$50 + Selo R$10 com controle de AI
12c2bcd fix: sincronizacao lobby + nickname correto + fluxo convite completo
c6ef841 feat: redesign tela do Voice Agent -- visual moderno com raios animados
a99d61f feat: lobby com jogadores online e fluxo de conexao
0c575e3 fix: agente fala menos -- maximo 1 frase por resposta
9d89a93 fix: convite agora salva via API HTTP ao inves de socket
7d3644a fix: mic desliga ao encerrar + constelacao nao trava ao mostrar perfil
15a80eb feat: agente salva notas pessoais + correcoes de bugs
5a57086 fix: lobby socket nao se identificava pro server
88d03dd feat: agente mostra perfil na constelacao em tempo real
36e099f fix: agente fala saudacao/fofoca exata com nome real
5b86a23 fix: convite no chat + lobby banner + preview corrigido
a77bd47 fix: redesign completo do fluxo de convites TouchGames
9c26d6b feat: agente de voz em tempo real -- OpenAI Realtime WebRTC
f40f6f4 feat: TouchGames microservico independente + 6 jogos novos

## ROLLBACK RAPIDO

Se algo quebrar, voltar para commits estaveis conhecidos:
- ANTES das assinaturas: git reset --hard 12c2bcd
- ANTES do voice agent redesign: git reset --hard a99d61f
- ANTES de QUALQUER mudanca de games: git reset --hard 0c575e3
- ANTES do voice agent inteiro: git reset --hard 1ffc98f
- ANTES do TouchGames v3: git reset --hard b77f837

Apos rollback: git push --force origin main (CUIDADO: sobrescreve GitHub)

## VARIAVEIS DE AMBIENTE (.env)

Ver .env.example para a lista completa. Principais:
- FIREBASE_* (config do Firebase Admin SDK)
- MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY
- OPENAI_API_KEY (para o voice agent)
- ADMIN_SECRET (protege endpoints admin)
- ALLOWED_ORIGINS (CORS)

Quando estiver pronto, me avisa que a gente comeca.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Ai e so mandar o que quer fazer!
