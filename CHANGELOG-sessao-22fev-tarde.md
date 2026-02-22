# Touch? (Encosta) -- Changelog Sessao 22/02/2026 (tarde/noite)

## Resumo

Sessao focada em 3 grandes areas: Voice Agent AI, TouchGames multiplayer, e sistema de assinaturas.
30 commits nesta sessao, cobrindo desde o agente de voz ate sincronizacao de jogos.

---

## Commits desta sessao (ordem cronologica)

### Voice Agent
- `9c26d6b` feat: agente de voz em tempo real -- OpenAI Realtime WebRTC
- `2d8aa7e` feat: agente AI personalizado -- conhece sua rede social + botao AI na home
- `d1a9052` fix: corrige dupla conexao do agente de voz + voz mais natural
- `b781e02` fix: remove FAB flutuante duplicado + agente chama pelo nome real
- `8bcc812` fix: garante que microfone desliga ao encerrar conversa
- `4fafcf2` fix: forca desligar microfone ao encerrar -- remove senders + para tracks
- `9ded399` feat: fofoca automatica apos 1h + economia de creditos + mic nuclear stop
- `d6fd3dc` fix: rewrite completo do voice agent -- corrige audio que nao tocava
- `9f2a8a0` fix: nao matar mic tracks no cleanup do agente -- restaura sonic match
- `36e099f` fix: agente fala saudacao/fofoca exata com nome real
- `88d03dd` feat: agente mostra perfil na constelacao em tempo real
- `15a80eb` feat: agente salva notas pessoais + correcoes de bugs
- `7d3644a` fix: mic desliga ao encerrar + constelacao nao trava ao mostrar perfil
- `0c575e3` fix: agente fala menos -- maximo 1 frase por resposta
- `c6ef841` feat: redesign tela do Voice Agent -- visual moderno com raios animados

### TouchGames
- `f40f6f4` feat: TouchGames microservico independente + 6 jogos novos
- `a77bd47` fix: redesign completo do fluxo de convites TouchGames
- `5b86a23` fix: convite no chat + lobby banner + preview corrigido
- `5a57086` fix: lobby socket nao se identificava pro server
- `9d89a93` fix: convite agora salva via API HTTP ao inves de socket
- `a99d61f` feat: lobby com jogadores online e fluxo de conexao
- `12c2bcd` fix: sincronizacao lobby + nickname correto + fluxo convite completo

### Outros
- `1ffc98f` feat: swipe-back gesture da borda esquerda pra voltar
- `6b801fd` fix: adiciona cdnjs.cloudflare.com ao CSP scriptSrc
- `ecd08d2` fix: restaura parametros do sonic -- gain 0.6, threshold 80, confirm 3
- `2d80195` fix: reduz alcance do sonic pela metade -- quase encostando (~10-12cm)
- `df8493d` feat: sistema de assinaturas Plus R$50 + Selo R$10 com controle de AI

---

## O que foi implementado

### Voice Agent (OpenAI Realtime WebRTC)
- Agente de voz em tempo real usando OpenAI Realtime API via WebRTC
- Conhece toda a rede social do usuario (conexoes, estrelas, eventos)
- Salva notas pessoais sobre usuarios (/api/agent/note)
- Mostra perfis na constelacao via postMessage
- Fofoca automatica apos 1h sem uso
- Maximo 1 frase por resposta (conciso)
- Visual redesenhado com raios animados
- Controle de acesso: so Touch Plus ou admin grant (/api/agent/grant-access)

### TouchGames Multiplayer
- Microservico independente em /games/index.html (iframe)
- 11 jogos: campo-minado, dama, xadrez, memory, rali, reflexo, cor-errada, empilha, impostor, speed-tap, 2048
- Lobby com jogadores online (avatares clicaveis)
- Convites via API HTTP (salva como mensagem no chat)
- Card de convite no chat com timer 60s + botoes Jogar/Recusar
- Ready-check modal VS (ambos confirmam antes de iniciar)
- Auto-cria temp-chat quando jogadores nao tem relacao
- Socket identify automatico no lobby

### Assinaturas
- Touch Plus: R$50/mes (agente AI, acessorios premium, faixa VIP)
- Selo: R$10/mes (selo visual no perfil)
- Checkout via MercadoPago
- Verificacao de status em tempo real
- Admin pode conceder acesso ao agente sem assinatura

---

## Pendencias para proxima sessao

- [ ] TESTAR fluxo completo multiplayer end-to-end (lobby -> convite -> chat -> aceitar -> ready -> jogar)
- [ ] Ready-check modal pode ter problemas de timing entre os dois jogadores
- [ ] Game-start recarrega iframe -- timing sensivel, pode perder estado
- [ ] Voice Agent: testar em dispositivos reais (iOS/Android)
- [ ] Assinaturas: testar pagamento real no MercadoPago
- [ ] Sonic: calibrar alcance em diferentes dispositivos

## Pontos de rollback seguros

- `12c2bcd` -- ultimo estado estavel antes das assinaturas
- `a99d61f` -- antes do redesign do voice agent
- `0c575e3` -- antes das mudancas de games (lobby/convite)
- `1ffc98f` -- antes do voice agent inteiro (so swipe-back)
- `b77f837` -- antes do TouchGames v3

## Tamanho dos arquivos principais

- server.js: 7063 linhas
- public/index.html: 11658 linhas
- public/games/index.html: 1909 linhas
- Total do projeto: 304 commits
