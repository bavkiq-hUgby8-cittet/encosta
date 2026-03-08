# Sistema de Notificacoes - Touch?

**Ultima atualizacao:** 2026-03-08

## Visao Geral

A tela "Atividade" (sininho no canto superior direito da tela Minha Rede) exibe todas as interacoes recentes do usuario. As notificacoes sao geradas dinamicamente a cada request (nao sao armazenadas como entidades separadas) — o backend monta a lista a partir dos dados existentes no banco.

**Endpoint:** `GET /api/notifications/:userId`
**Frontend:** funcao `loadNotifications()` em `public/index.html`

---

## Tipos de Notificacao (9 tipos)

### 1. `like` — Alguem curtiu voce
- **Fonte:** array `user.likedBy[]` + timestamps em `liker._likedAt[targetId]`
- **Texto:** "Fulano curtiu voce"
- **Icone:** Coracao vermelho preenchido
- **Clique:** Abre perfil na constelacao
- **Privacidade:** Mostra foto/nome real apenas se o liker revelou identidade (`isRevealedTo`)
- **Bug corrigido (2026-03-08):** `_likedAt` nao estava sendo salvo no like/toggle, entao likes nao apareciam como notificacao (timestamp era 0)

### 2. `star` — Voce recebeu uma estrela
- **Fonte:** array `user.stars[]` (campo `donatedAt` ou `at`)
- **Texto:** "Fulano te deu uma estrela"
- **Icone:** Estrela dourada preenchida
- **Clique:** Abre perfil do doador na constelacao
- **Privacidade:** Mostra foto/nome real apenas se o doador revelou identidade

### 3. `friend-star` — Um amigo ganhou uma estrela
- **Fonte:** Percorre todos os amigos (encounters nao-evento), pega as ultimas 5 estrelas de cada amigo nos ultimos 30 dias
- **Texto:** "Fulano ganhou uma estrela"
- **Icone:** Estrela dourada vazada (outline)
- **Clique:** Abre perfil do amigo na constelacao
- **Filtros:** Ignora estrelas dadas pelo proprio usuario (`star.from === userId`)
- **Limite:** Max 5 estrelas por amigo, apenas ultimos 30 dias
- **Privacidade:** Mostra foto/nome real se o amigo revelou identidade

### 4. `reveal-request` — Alguem pediu seu ID
- **Fonte:** `db.revealRequests` onde `toUserId === userId` e `status === 'pending'`
- **Texto:** "Fulano pediu seu ID"
- **Icone:** Olho roxo
- **Clique:** Abre perfil na constelacao
- **Privacidade:** Mostra foto/nome real se a pessoa revelou identidade

### 5. `identity-revealed` — Alguem revelou o ID pra voce
- **Fonte:** `user.canSee` (entradas com `revealedAt` timestamp)
- **Texto:** "Fulano revelou o ID pra voce"
- **Icone:** Cartao de identidade verde
- **Clique:** Abre perfil na constelacao
- **Dados:** Sempre mostra nome real e foto (ja revelados)

### 6. `game-invite` — Convite pra jogar
- **Fonte:** Mensagens de chat que comecam com `[game-invite:...]`
- **Texto:** "Fulano te convidou pra jogar NomeDoJogo"
- **Icone:** Controle de jogo azul
- **Clique:** Abre perfil na constelacao
- **Filtro:** Apenas convites recebidos (ignora os enviados)
- **Privacidade:** Mostra foto/nome real se revelado

### 7. `new-connection` — Nova conexao
- **Fonte:** `db.encounters[userId]` nos ultimos 7 dias (apenas encontros pessoa-pessoa)
- **Texto:** "Fulano se conectou com voce" + "(Nx)" se multiplos encontros
- **Icone:** Pessoa com + azul
- **Clique:** Abre perfil na constelacao
- **Deduplicacao:** Agrupa por pessoa, mostra apenas o encontro mais recente com contagem total
- **Privacidade:** Mostra foto/nome real se revelado

### 8. `unread-message` — Mensagem nao lida
- **Fonte:** `db.messages[relationId]` em relacoes ativas (nao expiradas)
- **Texto:** "Fulano te enviou N msg(s)"
- **Icone:** Balao de chat laranja
- **Clique:** Abre o chat diretamente
- **Logica:** Conta mensagens do parceiro apos a ultima mensagem do usuario
- **Filtro:** Ignora convites de jogo (`[game-invite:...]`)
- **Privacidade:** Mostra foto/nome real se revelado

### 9. `event-checkin` — Check-in em evento
- **Fonte:** `db.encounters[userId]` nos ultimos 7 dias (apenas `isEvent: true`)
- **Texto:** "Check-in em NomeDoEvento" + "(Nx)" se multiplos
- **Icone:** Pin de localizacao roxo + logo do evento
- **Clique:** Abre o chat do evento (se relacao ativa) ou mostra toast "Evento encerrado"
- **Deduplicacao:** Agrupa por evento, mostra o mais recente com contagem total

---

## Funcionalidades

### Agrupamento por Data
As notificacoes sao agrupadas em secoes visuais:
- **Hoje** — menos de 24h
- **Ontem** — 24h a 48h
- **Esta semana** — 48h a 7 dias
- **Anteriores** — mais de 7 dias

### Marcacao de Lida (seen)
- Ao abrir a tela, `POST /api/notifications/seen` salva `user.notifSeenAt = Date.now()`
- Notificacoes com `timestamp <= seenAt` aparecem sem destaque
- Notificacoes novas (unseen) tem fundo azul sutil e bolinha azul

### Badge de Contagem
- O sininho na tela Minha Rede mostra badge com quantidade de unseen
- Ao abrir a tela, badge vai para 0

### Dismiss Individual
- Botao "x" em cada notificacao
- `POST /api/notifications/dismiss` salva `notifKey` no array `user.dismissedNotifs`
- Formato do key: `tipo:fromId:timestamp`
- Limite de 200 dismissed (sliding window)
- Animacao de slide-out ao remover

### Limpar Tudo
- Botao "Limpar tudo" no header
- `POST /api/notifications/dismiss-all` marca todas como dismissed
- Recarrega a lista mostrando vazia

### Paginacao
- Parametros: `?page=1&limit=50`
- Default: pagina 1, 50 por pagina, max 100

---

## Fluxo de Dados

```
1. Frontend abre tela Atividade
2. GET /api/notifications/:userId
3. Backend monta lista de 9 fontes diferentes
4. Filtra dismissed (user.dismissedNotifs)
5. Ordena por timestamp desc
6. Pagina resultados
7. Frontend renderiza com agrupamento por data
8. POST /api/notifications/seen (marca como vistas)
```

---

## Privacidade

Todas as notificacoes seguem a regra de revelacao de identidade:
- Se a pessoa JA revelou identidade pro usuario (`isRevealedTo`), mostra `realName` e `profilePhoto`
- Se NAO revelou, mostra apenas `nickname` e avatar anonimo (silhueta com acessorio se tiver)
- Excecao: `identity-revealed` sempre mostra nome real (faz parte da natureza da notificacao)

---

## Bugs Conhecidos e Correcoes

### Corrigido em 2026-03-08:
1. **`_likedAt` nao era salvo** — Likes nao geravam notificacao porque o timestamp nunca era gravado. Corrigido adicionando `_likedAt[targetUserId] = Date.now()` no endpoint `POST /api/like/toggle`
2. **Check-ins duplicados** — Multiplos check-ins no mesmo evento apareciam como notificacoes separadas. Corrigido com deduplicacao por eventId, mostrando apenas o mais recente + contagem "(Nx)"
3. **Conexoes duplicadas** — Multiplos encontros com a mesma pessoa apareciam separados. Corrigido com deduplicacao por pessoa, mostrando o mais recente + contagem "(Nx)"
4. **Fotos nao apareciam** — Notificacoes de star, friend-star, new-connection, unread-message, reveal-request e game-invite nao checavam `isRevealedTo()`. Corrigido adicionando verificacao em todos os tipos.

---

## Arquivos Relevantes

- **Backend:** `server.js` linhas ~3253-3480 (endpoint + dismiss + dismiss-all)
- **Frontend:** `public/index.html` funcao `loadNotifications()` (~linha 12873)
- **CSS:** `.notif-item`, `.notif-ico`, `.notif-content`, `.notif-dismiss` (~linha 1224)
