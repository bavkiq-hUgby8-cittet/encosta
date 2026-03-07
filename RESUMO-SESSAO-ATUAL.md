# RESUMO DA SESSAO - 6 de Marco 2026

## O QUE FOI FEITO NESTA SESSAO

### 1. Treinos (ex-Academia) - COMPLETO
- Renomeou "Academia" para "Treinos" em todo o app (cobre CrossFit, qualquer esporte)
- Adicionou sistema de mural/anuncios com prioridade e validade
- Adicionou WiFi auto-share e info items para membros conectados
- Layout moderno com cards, formularios inline, timers ao vivo
- Dados de teste completos com mural posts, WiFi, treinos ativos
- Commits: `2baf058` (server endpoints) + `f43adab` (frontend redesign)

### 2. Fix Real-Time Pedidos/Pagamentos - COMPLETO
- Operador agora entra na sala `event:${eventId}` ao conectar/reconectar
- Servidor adicionou `join-event-room` socket event
- Pedidos agora emitem para 3 canais: global + user room + event room
- Delivery orders tambem emitem para event room + global fallback
- Novo evento `payment-received` para pedidos pagos (restaurante + delivery)
- Toast de novo pedido no painel do operador com numero do recibo e valor
- Toast de pagamento recebido com auto-refresh do painel financeiro
- Deduplicacao de pedidos quando chegam por multiplos canais
- `patchInitSocket` agora usa flags e espera evento `connect` (nao setTimeout)
- Botao "Pedir Delivery" adicionado direto no card da rede (nao so no modal)
- Commit: `c7864d1`

---

## PROXIMAS TAREFAS (PENDENTES)

Ramon pediu varias features interligadas. Segue o resumo de cada uma com o que ja existe no codigo e o que precisa ser feito:

### TAREFA A: Botao Touch nos Paineis de Modulo (Cardapio/Estacionamento)
**Problema:** Quando ativa Touch de dentro de um modulo (restaurante, estacionamento), a UI volta pra tela principal e o botao fica la embaixo. Nao tem feedback visual claro.
**O que existe:**
- Botao Touch principal: `<button id="opTouchBtn" onclick="opToggleTouch()">` na linha 1742 do operator.html
- Quando ativa, adiciona classes `shake-activate` e `energized` com animacao CSS
- `callStaff('waiter')` ja chama `opToggleTouch()` se nao estiver ativo (linha 5795)
- Sonic bars (`sonicBarsL/R`) e fire overlay existem mas so no botao principal
**O que fazer:**
- Criar uma animacao/overlay DENTRO do painel do modulo que mostre que o Touch esta ativo
- Tipo um banner pulsante no topo do painel: "TOUCH ATIVADO - encoste os celulares"
- Quando conectar (checkin-created ou staff-joined), mostrar animacao de sucesso
- NAO fechar o painel do modulo ao ativar Touch - manter aberto com feedback visual
- Pode ser um mini-status bar flutuante dentro do mod-panel

### TAREFA B: Funcionarios (Staff) como Nodes Itinerantes no Aquario
**Problema:** Quando garcom ou barbeiro conecta, eles aparecem so na lista HTML de staff. Nao aparecem no aquario.
**O que existe:**
- Array `nodes` do canvas com propriedades: x, y, vx, vy, baseRadius, color, name, userId, profilePhoto, etc
- `addNodeToCanvas(d)` adiciona node com drift physics
- Staff sao criados via `sonic-matched` quando `pendingStaffRole` esta setado e visitor usa `isServiceTouch`
- Staff atual: `{id, userId, name, role, tables, status, socketId, connectedAt}`
- Rendering: nodes flutuam com velocidade 0.4, bounce nas bordas, repulsao do centro e entre si
**O que fazer:**
- Quando `staff-joined` chegar, chamar `addNodeToCanvas()` com dados especiais
- Diferenciar visualmente: usar cor do modulo (laranja pra garcom, dourado pra barbeiro, verde pra motorista)
- Em vez de foto, mostrar o logo do evento ou um icone do cargo (garcom/barbeiro/motorista)
- Adicionar um badge/tag no node: "Garcom", "Barbeiro", "Motorista"
- No `renderCanvas`, checar se node tem flag `isStaff` e desenhar diferente (ex: borda pontilhada, icone de cargo)
- Nodes de staff devem ser removidos quando o staff desconecta (`staff-left` event)

### TAREFA C: Fluxo de Pedido por Staff (Garcom pede para cliente)
**Problema:** O fluxo de pedido do garcom precisa incluir opcoes: por mesa OU por Touch (encosta no cliente). No final, Touch pra pagar.
**O que existe:**
- Waiter View completa em index.html (linhas 13025-13250)
- `_waiterState` com tabs: tables, orders, menu
- Endpoint: `POST /api/event/:eventId/staff-order` (server.js linha 13686)
- Garcom ve suas mesas atribuidas, adiciona itens ao carrinho, cria pedido
- Pedido criado com `waiterId`, `table`, `customerName`
**O que fazer:**
- Adicionar opcao "Pedir por Touch" alem de "Pedir por Mesa"
- Fluxo: Garcom seleciona itens > escolhe mesa OU toca no cliente > pedido criado
- No final do pedido, opcao de "Touch para Pagar" (garcom e cliente encostam celulares pra processar pagamento)
- Gateway de pagamento unificado aparece no celular do CLIENTE apos o Touch
- Garcom ve confirmacao em tempo real quando cliente paga

### TAREFA D: Barbeiro com Agendamento via Rede
**Problema:** Se eu ja conectei com um barbeiro, quero agendar direto da minha rede de conexoes, sem precisar ir ao evento.
**O que existe:**
- Modulo barbeiro completo com: team, services, slots, appointments, config
- BARBER state: `{activeTab, team[], selectedBarberId, appointments[]}`
- Server endpoints: team CRUD, services CRUD, slots CRUD, appointments, config
- Client: UI de 3 passos (escolhe barbeiro > servico > slot) em index.html linhas 5529-5740
- Booking: `POST /api/event/:eventId/barber/book` com barberId, slotId, serviceId
- Socket: `barber-appointment-new` notifica operador e barbeiro
- Barbeiro conecta via Touch: `sonic-set-staff-role` com `staffRole='barber'`
- Barbeiro recebe servicos default: Corte (R$35), Barba (R$25), Combo (R$50)
**O que fazer:**
- **Agendamento via Rede:** No card de conexao (constDetail), se o evento tem modulo barber ativo, mostrar botao "Agendar"
- Abrir mesma UI de 3 passos (barbeiro > servico > slot) mas a partir da rede, nao do evento ao vivo
- **Barbeiro aceita antes:** Mudar status inicial de appointment para `pending` em vez de `confirmed`
- Barbeiro recebe notificacao e precisa clicar "Aceitar" ou "Recusar"
- So depois de aceitar, o slot e marcado como `booked` e cliente recebe confirmacao
- **Barbeiro solo vs barbearia:** Barbeiro pode ser vinculado a um evento (barbearia) OU ser independente
- Se solo: aceita agendamentos das suas conexoes diretas
- Se vinculado: agenda sincroniza com a barbearia (ja funciona via event)
- **Painel do barbeiro:** Adicionar view propria pro barbeiro (como waiter view) mostrando agenda do dia, proximos clientes, aceitar/recusar agendamentos

### TAREFA E: Barbeiro - Pedido com Agendamento
**Problema:** Barbeiro funciona igual garcom mas com agendamento. Cliente agenda slot, barbeiro aceita, e no dia do servico pode cobrar via Touch.
**O que fazer:**
- Integrar pagamento no fluxo de appointment completion
- Quando barbeiro marca `completed`, opcao de cobrar via Touch
- Gateway de pagamento aparece no celular do cliente

---

## ARQUITETURA RELEVANTE (pra referencia rapida)

### Arquivos Principais
- `server.js` (~16400 linhas) - Backend monolito
- `public/operator.html` (~8000 linhas) - Painel do operador
- `public/index.html` (~18000 linhas) - App do cliente

### Socket Rooms
- `user:${userId}` - Room individual do usuario
- `event:${eventId}` - Room do evento (operador entra agora via join-event-room)
- `session:${sessionId}` - Room de sessao de chat
- `mural:${channelKey}` - Room de broadcast do mural

### Sonic/Touch Flow
1. Operador emite `sonic-start` com `{userId, isCheckin:true, eventId}`
2. Server registra na `sonicQueue` com key `evt:${eventId}`
3. Operador pode setar `sonic-set-staff-role` com `{eventId, staffRole:'waiter'|'driver'|'barber'}`
4. Visitante emite `sonic-start` com `{userId, isServiceTouch:true}` (se modo servico)
5. Quando frequencias batem (`sonic-matched`):
   - Se `pendingStaffRole` existe: cria staff member, emite `staff-joined` + `staff-connected`
   - Se nao: cria checkin normal, emite `checkin-created`

### Canvas do Aquario
- Array `nodes[]` com propriedades: x, y, vx, vy, baseRadius, color, name, userId, etc
- `addNodeToCanvas(d, instant)` - adiciona node com animacao
- `renderCanvas()` - loop de animacao a 60fps
- Drift physics: velocidade 0.4, bounce nas bordas, repulsao entre nodes
- Lightning bolts entre matches
- Centro: logo do evento

### Unified Payment Gateway
- `renderUnifiedPaymentGateway(containerId, opts)` - Renderiza UI de pagamento
- Suporta: Apple Pay, Google Pay, PIX, Stripe Card, Cartao salvo, Balcao
- `opts.onConfirm(result)` - Callback apos pagamento confirmado
- Usado em: ingresso, pedido restaurante, delivery, gorjeta

### Barber Data Model
```
ev.barber = {
  enabled: bool,
  config: { barberName, welcomeMessage },
  barbers: [{
    id, userId, name, status,
    services: [{ id, name, price, duration }],
    slots: [{ id, date, timeStart, timeEnd, status, bookedBy, bookedByUserId }]
  }],
  appointments: [{
    id, barberId, barberName, slotId, serviceId, serviceName, servicePrice,
    date, timeStart, timeEnd, userId, customerName, status
  }]
}
```

### Staff Data Model
```
ev.staff = [{
  id, userId, name, role ('waiter'|'driver'|'barber'),
  tables: [1,2,3], status ('online'|'offline'),
  socketId, connectedAt
}]
```

---

## COMMITS DESTA SESSAO
1. `2baf058` - feat: add gym mural, wifi, info endpoints (server)
2. `f43adab` - feat: complete Treinos panel redesign with mural, wifi, info
3. `c7864d1` - fix: real-time order/payment notifications + delivery flow

## ORDEM SUGERIDA DE IMPLEMENTACAO
1. Tarefa B (Staff no aquario) - visual, nao quebra nada
2. Tarefa A (Touch feedback nos modulos) - UX, nao quebra nada
3. Tarefa D (Barbeiro agendamento via rede) - funcionalidade nova
4. Tarefa C (Pedido por Touch do garcom) - fluxo complexo
5. Tarefa E (Pagamento via Touch do barbeiro) - depende de C e D
