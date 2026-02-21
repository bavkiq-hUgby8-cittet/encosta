# Changelog — Touch?

## [2.1.0] - 2026-02-21

### Adicionado
- **Painel do Restaurante** (`operator-restaurant.html`)
  - Landing page profissional com explicação dos serviços
  - Sistema de login/registro
  - Gestão completa de cardápio (CRUD de itens)
  - Pedidos em tempo real via Socket.IO
  - Sistema de status: Novo → Preparando → Pronto → Entregue
  - Notificação sonora para novos pedidos
  - Impressão de comanda (formato térmico 80mm)
  - Visão de mesas com status ocupada/livre
  - Dashboard com faturamento e estatísticas
  - 20 produtos teste com fotos reais
  - Rota `/restaurante` no servidor

- **Documentação profissional**
  - `docs/API.md` — Documentação completa de todas as APIs
  - `docs/RESUMO-PROJETO.md` — Resumo do projeto e arquitetura
  - `docs/CHANGELOG.md` — Histórico de mudanças

### Corrigido
- Animação de conexão: feixes agora sobem (bottom→top) ao invés de descer
- Acelerador visual posicionado corretamente embaixo (onde fica o alto-falante)

## [2.0.0] - 2026-02-21

### Adicionado
- **Menu do restaurante no cliente** (dentro do evento)
  - Botão FAB 🍽 quando evento tem cardápio
  - Navegação por categorias
  - Carrinho de compras com +/- quantidade
  - Seleção de mesa
  - Modo "Mostrar pro garçom" (tela fullscreen)
  - Modo pagamento via cartão

- **Raios de proximidade no operador**
  - Pares conectados mostram mini-raio quando passam perto
  - Intensidade reduzida (40%) para diferenciar de raios normais

- **5 APIs de restaurante** no servidor
  - GET/POST menu, POST order, GET orders, POST order status
  - Socket events: `new-order`, `order-update`

### Corrigido
- Botão Revelar no check-in agora funciona (usa operatorId real)
- Compartilhar conexão: try-catch + Promise toBlob (fix iOS)
- Frase duplicada "encontro no evento" removida
- Painel do evento do usuário agora usa estilo aquário

## [1.9.0] - 2026-02-20

### Adicionado
- Painel do evento tipo "aquário" para o usuário
  - Nós flutuando com física 2D
  - Raios elétricos para event matches
  - Silhueta anônima (cabeça + corpo)
  - Sem opção de zoom

- Avatar anônimo no reveal e card de compartilhar
  - Mostra silhueta quando não revelado
  - Mostra foto real quando revelado

### Corrigido
- Bolas do operador todas do mesmo tamanho (baseR=24)

## [1.8.0] - 2026-02-19

### Adicionado
- Estrelas orbitando na tela de reveal
- Animação de conexão com timing reduzido
- Badge "verificado" (plus)
- Botão compartilhar com imagem 9:16 (story)
- Modo aquário no painel do operador
- Nick creativity engine (apelidos únicos)
- Sonic auto-restart
- Sistema de event match (raios entre pessoas no mesmo evento)

---

*Mantido por Ramon — Touch? Project*
