# Touch? — Documentação da API

> **Base URL**: `https://seu-servidor.com` (ou `http://localhost:3000` em desenvolvimento)
> **Protocolo**: REST (JSON) + Socket.IO (tempo real)
> **Autenticação**: userId via body/params (sem token obrigatório no momento)

---

## Índice

1. [Autenticação](#autenticação)
2. [Usuários e Perfil](#usuários-e-perfil)
3. [Sessões e Check-in](#sessões-e-check-in)
4. [Eventos](#eventos)
5. [Relações e Conexões](#relações-e-conexões)
6. [Identidade e Reveal](#identidade-e-reveal)
7. [Mensagens e Notificações](#mensagens-e-notificações)
8. [Estrelas e Pontos](#estrelas-e-pontos)
9. [Presentes e Declarações](#presentes-e-declarações)
10. [Operador](#operador)
11. [Restaurante / Cardápio](#restaurante--cardápio)
12. [Pagamentos e Tips](#pagamentos-e-tips)
13. [Assinaturas](#assinaturas)
14. [Administração](#administração)
15. [Socket.IO — Eventos em Tempo Real](#socketio--eventos-em-tempo-real)

---

## Autenticação

### `POST /api/auth/send-verification`
Envia código de verificação por email.
- **Body**: `{ email }`
- **Response**: `{ ok: true }`
- **Rate limit**: Sim

### `POST /api/auth/send-magic-link`
Envia magic link por email.
- **Body**: `{ email }`
- **Response**: `{ ok: true }`
- **Rate limit**: Sim

### `POST /api/auth/send-password-reset`
Envia link de reset de senha.
- **Body**: `{ email }`
- **Response**: `{ ok: true }`
- **Rate limit**: Sim

### `POST /api/auth/link`
Vincula conta (Firebase Auth → servidor).
- **Body**: `{ uid, email, name, ... }`
- **Response**: `{ ok: true, userId }`

---

## Usuários e Perfil

### `POST /api/register`
Registra novo usuário.
- **Body**: `{ name, nickname, phone }`
- **Response**: `{ userId, user: {...} }`

### `GET /api/user/:id`
Retorna dados básicos do usuário.
- **Response**: `{ id, name, nickname, ... }`

### `GET /api/check-nick/:nick`
Verifica se apelido está disponível.
- **Response**: `{ available: true/false }`

### `GET /api/profile/:userId`
Retorna perfil público do usuário.
- **Response**: `{ user: {...}, stats: {...} }`

### `GET /api/profile/:userId/from/:viewerId`
Retorna perfil visto por outro usuário (com contexto de relação).
- **Response**: `{ user: {...}, relation: {...} }`

### `POST /api/profile/update`
Atualiza perfil do usuário.
- **Body**: `{ userId, name?, nickname?, bio?, profilePhoto?, ... }`
- **Response**: `{ ok: true, user: {...} }`

### `GET /api/myprofile/:userId`
Retorna perfil completo para o próprio usuário.
- **Response**: `{ user: {...}, stats: {...}, settings: {...} }`

---

## Sessões e Check-in

### `POST /api/session/create`
Cria uma sessão de proximidade.
- **Body**: `{ userId }`
- **Response**: `{ sessionId }`

### `POST /api/session/join`
Entra numa sessão (check-in via NFC/código/sonic).
- **Body**: `{ sessionId, userId }`
- **Response**: `{ relation: {...}, operatorId, ... }`

### `GET /api/session/:id`
Retorna dados da sessão.
- **Response**: `{ session: {...} }`

---

## Eventos

### `POST /api/event/create`
Cria um evento público.
- **Body**: `{ userId, name, description, ... }`
- **Response**: `{ event: {...} }`

### `GET /api/events/nearby`
Lista eventos próximos.
- **Query**: `?lat=X&lng=Y&radius=Z`
- **Response**: `[{ event }, ...]`

### `POST /api/event/join`
Entra em um evento (check-in).
- **Body**: `{ eventId, userId }`
- **Response**: `{ ok: true, ... }`

### `GET /api/event/:eventId`
Retorna dados do evento.
- **Response**: `{ event: {...} }`

### `POST /api/event/encosta-request`
Solicita conexão com alguém no evento.
- **Body**: `{ eventId, fromUserId, toUserId }`
- **Response**: `{ ok: true, requestId }`

### `POST /api/event/encosta-accept`
Aceita solicitação de conexão.
- **Body**: `{ requestId, userId }`
- **Response**: `{ relation: {...} }`

---

## Relações e Conexões

### `GET /api/relations/:userId`
Lista todas as relações/conexões do usuário.
- **Response**: `[{ relation }, ...]`

### `GET /api/encounters/:userId`
Lista encontros recentes.
- **Response**: `[{ encounter }, ...]`

### `DELETE /api/encounters/:userId/:timestamp`
Remove um encontro.
- **Response**: `{ ok: true }`

### `GET /api/today/:userId`
Retorna encontros de hoje.
- **Response**: `[{ encounter }, ...]`

### `GET /api/constellation/:userId`
Retorna constelação de conexões do usuário.
- **Response**: `{ nodes: [...], edges: [...] }`

### `GET /api/streak/:userId/:partnerId`
Retorna streak de conexão entre dois usuários.
- **Response**: `{ streak: N, lastEncounter: Date }`

---

## Identidade e Reveal

### `POST /api/identity/reveal`
Revela identidade para outro usuário.
- **Body**: `{ userId, targetId, eventId?, eventName? }`
- **Response**: `{ ok: true }`

### `POST /api/identity/request-reveal`
Solicita que outro revele a identidade.
- **Body**: `{ fromId, toId }`
- **Response**: `{ ok: true, requestId }`

### `POST /api/identity/reveal-accept`
Aceita pedido de reveal.
- **Body**: `{ requestId, userId }`
- **Response**: `{ ok: true }`

### `POST /api/identity/reveal-decline`
Recusa pedido de reveal.
- **Body**: `{ requestId, userId }`
- **Response**: `{ ok: true }`

### `GET /api/identity/pending/:userId`
Lista pedidos de reveal pendentes.
- **Response**: `[{ request }, ...]`

---

## Mensagens e Notificações

### `GET /api/messages/:relationId`
Retorna mensagens de uma relação.
- **Response**: `[{ message }, ...]`

### `GET /api/notifications/:userId`
Lista notificações do usuário.
- **Response**: `[{ notification }, ...]`

### `POST /api/notifications/seen`
Marca notificações como vistas.
- **Body**: `{ userId, notificationIds: [...] }`
- **Response**: `{ ok: true }`

---

## Estrelas e Pontos

### `GET /api/points/:userId`
Retorna pontos do usuário.
- **Response**: `{ points: N }`

### `GET /api/score/:userId`
Retorna score do usuário.
- **Response**: `{ score: N }`

### `GET /api/stars/:userId`
Retorna saldo de estrelas.
- **Response**: `{ balance: N }`

### `POST /api/star/donate`
Doa estrelas para outro usuário.
- **Body**: `{ fromId, toId, amount }`
- **Response**: `{ ok: true, newBalance }`

### `POST /api/star/buy`
Compra estrelas.
- **Body**: `{ userId, amount, paymentMethod }`
- **Response**: `{ ok: true, newBalance }`

---

## Presentes e Declarações

### `GET /api/gift-catalog`
Retorna catálogo de presentes.
- **Response**: `[{ gift }, ...]`

### `POST /api/gift/send`
Envia um presente.
- **Body**: `{ fromId, toId, giftId, message? }`
- **Response**: `{ ok: true }`

### `POST /api/declarations/send`
Envia uma declaração.
- **Body**: `{ fromId, toId, text }`
- **Response**: `{ ok: true }`

### `GET /api/declarations/:userId`
Lista declarações recebidas.
- **Response**: `[{ declaration }, ...]`

---

## Operador

### `GET /operator`
Serve a página do painel do operador (operator.html).

### `GET /restaurante`
Serve a página do painel do restaurante (operator-restaurant.html).

### `GET /api/operator/checkins/:userId`
Lista check-ins do operador.
- **Response**: `[{ checkin }, ...]`

### `GET /api/operator/settings/:userId`
Retorna configurações do operador.
- **Response**: `{ settings: {...} }`

### `POST /api/operator/settings`
Salva configurações do operador.
- **Body**: `{ userId, settings: {...} }`
- **Response**: `{ ok: true }`

### `POST /api/operator/event/create`
Cria evento de operador.
- **Body**: `{ userId, name, description, acceptsTips, serviceLabel, entryPrice, revealMode }`
- **Response**: `{ event: {...} }`

### `GET /api/operator/events/:userId`
Lista eventos do operador.
- **Response**: `[{ event }, ...]`

### `POST /api/operator/event/:eventId/end`
Encerra um evento.
- **Response**: `{ ok: true }`

### `GET /api/operator/event/:eventId/attendees`
Lista participantes do evento.
- **Response**: `[{ attendee }, ...]`

---

## Restaurante / Cardápio

### `GET /api/event/:eventId/menu`
Retorna o cardápio do evento.
- **Response**: `{ menu: [{id, name, description, price, photo, category, available}], eventName, tables }`

### `POST /api/operator/event/:eventId/menu`
Salva/atualiza cardápio do evento (operador).
- **Body**:
  ```json
  {
    "items": [
      {
        "id": "uuid",
        "name": "Filé Mignon",
        "description": "Filé grelhado com molho",
        "price": 79.90,
        "photo": "https://...",
        "category": "Pratos Principais",
        "available": true
      }
    ],
    "tables": 15
  }
  ```
- **Response**: `{ ok: true, menu: [...], tables: N }`

### `POST /api/event/:eventId/order`
Cria um pedido (cliente).
- **Body**:
  ```json
  {
    "userId": "uuid",
    "items": [
      { "menuItemId": "uuid", "name": "Filé Mignon", "qty": 2, "price": 79.90 }
    ],
    "table": 5,
    "paymentMethod": "counter",
    "total": 159.80
  }
  ```
- **Response**: `{ ok: true, order: {...} }`
- **Socket**: Emite `new-order` para o operador.
- **Métodos de pagamento**: `counter` (garçom anota), `card` (pago online)

### `GET /api/operator/event/:eventId/orders`
Lista todos os pedidos do evento (operador).
- **Response**: `{ orders: [{id, userId, userName, items, table, total, paymentMethod, status, createdAt}] }`

### `POST /api/operator/event/:eventId/order/:orderId/status`
Atualiza status do pedido (operador).
- **Body**: `{ "status": "preparing" }`
- **Status possíveis**: `pending` → `preparing` → `ready` → `delivered` | `cancelled`
- **Response**: `{ ok: true, order: {...} }`
- **Socket**: Emite `order-update` para todos os clientes.

---

## Pagamentos e Tips

### `POST /api/tip/create`
Cria gorjeta/tip.
- **Body**: `{ fromId, toId, amount, ... }`
- **Rate limit**: Sim

### `POST /api/tip/pix`
Gera pagamento via PIX.
- **Body**: `{ ... }`

### `POST /api/tip/checkout`
Checkout de gorjeta.
- **Body**: `{ ... }`

### `GET /api/tips/:userId`
Lista gorjetas recebidas.
- **Response**: `[{ tip }, ...]`

### `GET /api/user/:userId/transactions`
Lista transações do usuário.
- **Response**: `[{ transaction }, ...]`

### `GET /api/prestador/:userId/dashboard`
Dashboard do prestador de serviço.
- **Response**: `{ stats: {...}, transactions: [...] }`

---

## Assinaturas

### `GET /api/subscription/plans`
Lista planos de assinatura.
- **Response**: `[{ plan }, ...]`

### `GET /api/subscription/status/:userId`
Status da assinatura do usuário.
- **Response**: `{ active: true/false, plan: {...} }`

### `POST /api/subscription/create`
Cria assinatura.
- **Body**: `{ userId, planId, ... }`
- **Rate limit**: Sim

### `POST /api/subscription/cancel`
Cancela assinatura.
- **Body**: `{ userId }`
- **Response**: `{ ok: true }`

---

## Administração

### `POST /api/admin/verify`
Verifica um usuário (badge ✓).
- **Body**: `{ adminId, userId }`

### `POST /api/admin/backup`
Cria backup do banco de dados.
- **Rate limit**: Sim, requer admin

### `GET /api/admin/backups`
Lista backups disponíveis.
- **Rate limit**: Sim, requer admin

### `POST /api/admin/rollback`
Restaura backup.
- **Body**: `{ backupId }`
- **Rate limit**: Sim, requer admin

### `GET /api/status`
Status geral do servidor.
- **Response**: `{ uptime, users, events, ... }`

---

## Socket.IO — Eventos em Tempo Real

### Conexão
```javascript
const socket = io(); // conecta ao mesmo servidor
```

### Eventos emitidos pelo servidor:

| Evento | Payload | Descrição |
|--------|---------|-----------|
| `connection-made` | `{ relation, userA, userB, ... }` | Nova conexão entre dois usuários |
| `event-match` | `{ eventId, userA, userB, sharedEventName }` | Dois usuários se conectaram num evento |
| `new-order` | `{ eventId, order }` | Novo pedido de restaurante |
| `order-update` | `{ eventId, orderId, status }` | Status do pedido atualizado |
| `chat-message` | `{ relationId, message }` | Nova mensagem de chat |
| `notification` | `{ userId, notification }` | Nova notificação |
| `session-join` | `{ sessionId, userId }` | Alguém entrou na sessão |
| `event-attendee-joined` | `{ eventId, userId, nickname }` | Alguém entrou no evento |
| `event-attendee-left` | `{ eventId, userId }` | Alguém saiu do evento |
| `reveal-request` | `{ fromId, toId }` | Pedido de reveal recebido |
| `reveal-accepted` | `{ fromId, toId }` | Reveal aceito |
| `star-received` | `{ userId, amount, fromName }` | Estrelas recebidas |
| `gift-received` | `{ userId, gift, fromName }` | Presente recebido |

### Eventos emitidos pelo cliente:

| Evento | Payload | Descrição |
|--------|---------|-----------|
| `join-event` | `{ eventId, userId }` | Entrar num room de evento |
| `leave-event` | `{ eventId, userId }` | Sair do room de evento |
| `typing` | `{ relationId, userId }` | Indicador de digitação |

---

## Estrutura de Dados

### Evento (operatorEvent)
```json
{
  "id": "uuid",
  "name": "Restaurante Sabor & Arte",
  "description": "Restaurante italiano no centro",
  "creatorId": "uuid",
  "creatorName": "Ramon",
  "active": true,
  "participants": ["userId1", "userId2"],
  "checkinCount": 15,
  "acceptsTips": true,
  "serviceLabel": "Restaurante",
  "entryPrice": 0,
  "revealMode": "optional",
  "revenue": 1250.00,
  "paidCheckins": 0,
  "menu": [
    {
      "id": "uuid",
      "name": "Filé Mignon",
      "description": "Filé grelhado com molho madeira",
      "price": 79.90,
      "photo": "https://...",
      "category": "Pratos Principais",
      "available": true
    }
  ],
  "tables": 15,
  "orders": [
    {
      "id": "uuid",
      "userId": "uuid",
      "userName": "João",
      "items": [{"menuItemId": "uuid", "name": "Filé Mignon", "qty": 2, "price": 79.90}],
      "table": 5,
      "total": 159.80,
      "paymentMethod": "counter",
      "status": "pending",
      "createdAt": 1708542000000
    }
  ],
  "createdAt": 1708540000000
}
```

### Usuário
```json
{
  "id": "uuid",
  "name": "Ramon",
  "nickname": "ramon",
  "phone": "+5511999999999",
  "profilePhoto": "https://...",
  "verified": false,
  "createdAt": 1708540000000
}
```

---

## Integrações Futuras (ERP)

A API de restaurante foi desenhada para facilitar integração com ERPs:

1. **Webhook de pedidos**: O evento Socket.IO `new-order` pode ser interceptado por um middleware para enviar para o ERP
2. **Status sync**: O `order-update` pode sincronizar status de volta para o ERP
3. **Menu sync**: O endpoint `POST /api/operator/event/:eventId/menu` aceita o cardápio completo, facilitando sync bidirecional
4. **Pagamentos**: O campo `paymentMethod` suporta extensão para gateways de pagamento integrados

### Exemplo de integração:
```javascript
// Webhook listener no servidor
io.on('new-order', (data) => {
  // Forward para ERP
  fetch('https://seu-erp.com/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data.order)
  });
});
```

---

## Códigos de Status HTTP

| Código | Significado |
|--------|-------------|
| 200 | Sucesso |
| 400 | Requisição inválida (dados faltando) |
| 404 | Recurso não encontrado |
| 429 | Rate limit excedido |
| 500 | Erro interno do servidor |

---

*Documentação gerada para o projeto Touch? — v2.0*
*Última atualização: Fevereiro 2026*
