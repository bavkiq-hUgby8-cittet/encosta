# Prompt para criar o Painel do Restaurante — Touch? App

## Contexto do Projeto

O **Touch?** é um app social que funciona com proximidade física. O sistema já tem:
- **Operador**: pessoa/estabelecimento que cria eventos e gerencia check-ins de visitantes
- **Eventos**: quando alguém faz check-in (via NFC/código/sonic), entra no evento e vê os outros participantes num canvas "aquário" (nós flutuando)
- **Conexões**: pessoas no mesmo evento podem se conectar, e o app registra encontros

## Repositório GitHub
```
https://github.com/bavkiq-hUgby8-cittet/encosta.git
```
- Email: `ramonnvc@hotmail.com` / Nome: `Ramon`
- (Credenciais de acesso já configuradas no remote do projeto)

## Arquitetura Atual

### Servidor: `server.js` (Node.js + Express + Socket.IO)
- **Database**: JSON file-based (`db.json`) com collections
- **Eventos**: `db.operatorEvents[eventId]` — estrutura:
  ```js
  {
    id, name, description, creatorId, creatorName,
    active, participants: [userId, ...],
    checkinCount, acceptsTips, serviceLabel,
    entryPrice, revealMode, revenue, paidCheckins,
    menu: [{id, name, description, price, photo, category, available}], // JÁ EXISTE
    tables: 0, // JÁ EXISTE
    orders: [{id, userId, userName, items, table, total, paymentMethod, status, createdAt}], // JÁ EXISTE
    createdAt
  }
  ```

### APIs já criadas (servidor):
```
GET  /api/event/:eventId/menu                          — lista menu do evento
POST /api/operator/event/:eventId/menu                  — salva/atualiza menu {items, tables}
POST /api/event/:eventId/order                          — cria pedido {userId, items, table, paymentMethod, total}
GET  /api/operator/event/:eventId/orders                — lista pedidos do evento
POST /api/operator/event/:eventId/order/:orderId/status — atualiza status {status}
```

### Sockets já existentes:
- `new-order` — emitido quando cliente faz pedido `{eventId, order}`
- `order-update` — emitido quando operador muda status `{eventId, orderId, status}`

### Cliente (já feito no index.html):
- O cliente já tem o menu overlay dentro do eventView
- Carrinho com categorias, +/- quantidade, seleção de mesa
- Modo "Mostrar pro garçom" (tela fullscreen com texto grande)
- Modo pagamento via card
- FAB 🍽 aparece quando evento tem menu

## O QUE VOCÊ PRECISA CRIAR: Painel do Restaurante (operator-restaurant.html)

### Conceito
Uma **nova página** para o operador do tipo restaurante. Ele acessa essa página e gerencia tudo:

### 1. CADASTRO DO CARDÁPIO
- Interface para adicionar/editar/remover items do menu
- Cada item tem: **nome, descrição, preço, foto (upload ou URL), categoria, disponível (sim/não)**
- Categorias sugeridas: Entradas, Pratos Principais, Bebidas, Sobremesas, Porções (mas customizável)
- Upload de foto com preview
- Drag & drop para reordenar items
- Toggle de disponibilidade (acabou/disponível)
- **Configurar número de mesas** do restaurante
- Usa a API: `POST /api/operator/event/:eventId/menu` com `{items: [...], tables: N}`

### 2. PAINEL DE PEDIDOS (tempo real)
- Lista de pedidos recebidos em tempo real via Socket.IO (`new-order`)
- Cada pedido mostra:
  - Número do pedido
  - Nome do cliente
  - Mesa
  - Items (nome × quantidade)
  - Total
  - Status (cores): **Novo** (amarelo) → **Preparando** (azul) → **Pronto** (verde) → **Entregue** (cinza)
- Botões grandes de atualizar status (tipo totem touchscreen)
- Som/notificação quando novo pedido chega
- **Impressão**: botão para imprimir comanda individual (formato térmico 80mm)
  - Layout da comanda: nome do restaurante, nº pedido, mesa, items com qty, total, hora
  - Usar `window.print()` com CSS `@media print` formatado para impressora térmica

### 3. VISÃO DO AQUÁRIO (mesmo estilo)
- Canvas com os nós flutuando (clientes no evento)
- Quando alguém faz pedido, o nó dele fica com um badge "🍽" ou muda de cor
- Raio entre conexões como no operador principal

### 4. DASHBOARD RESUMO
- Total de pedidos
- Faturamento total
- Pedidos por status (gráfico simples)
- Itens mais pedidos
- Número de pessoas no evento

### Design
- Tema escuro igual ao app (background `#0a0a0f`, textos brancos/cinzas)
- Cores de destaque: `#f97316` (laranja) para comida, `#ef4444` (vermelho) para urgente
- Fonte: Inter
- Mobile-first, mas funcionar bem em tablet/desktop também
- Botões GRANDES para touchscreen (min 48px touch target)
- Interface limpa tipo totem de autoatendimento

### Autenticação
O operador faz login no app normal e cria o evento. A página do restaurante recebe o `eventId` e `userId` via URL params:
```
operator-restaurant.html?eventId=xxx&userId=yyy
```

### Integração com servidor
- Todas as APIs necessárias JÁ EXISTEM no `server.js`
- Socket.IO já está configurado na mesma porta
- Conectar via `io()` e escutar `new-order`, `order-update`

### Flow completo:
1. Restaurante cria evento no app Touch? (já existe)
2. Abre `operator-restaurant.html` no tablet/computador
3. Cadastra o cardápio (items, fotos, preços, categorias)
4. Define número de mesas
5. Cliente chega, faz check-in no Touch?
6. Cliente vê o evento, clica no 🍽, navega o cardápio
7. Cliente monta carrinho, escolhe mesa
8. Opção A: "Mostrar pro garçom" → tela grande com resumo
9. Opção B: Envia pedido digitalmente → chega no painel em tempo real
10. Restaurante vê pedido, muda status (Preparando → Pronto → Entregue)
11. Pode imprimir comanda para cozinha
12. Dashboard mostra resumo de vendas

### Arquivo final
Criar `public/operator-restaurant.html` — arquivo único com HTML, CSS e JS inline (mesmo padrão do projeto).

### Dica importante
O Ramon (dono do projeto) não sabe programar. Faça tudo completo, funcional, pronto para uso. Ele já tem o servidor rodando. Suba no mesmo repositório GitHub.
