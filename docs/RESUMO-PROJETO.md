# Touch? — Resumo do Projeto

## Visão Geral
O **Touch?** é um aplicativo social baseado em proximidade física. Pessoas se conectam através de encontros presenciais usando NFC, códigos, ou som ultrassônico. O app registra essas conexões e cria uma rede social baseada em encontros reais.

## Arquitetura

### Stack Tecnológica
- **Backend**: Node.js + Express + Socket.IO
- **Database**: JSON file-based (`db.json`) — simples e portátil
- **Frontend**: HTML/CSS/JS vanilla (Single Page Apps)
- **Pagamentos**: MercadoPago API
- **Auth**: Firebase Auth + Magic Links + SMS
- **Deploy**: Qualquer VPS com Node.js

### Arquivos Principais

```
encosta/
├── server.js                          # Servidor principal (5900+ linhas)
├── db.json                            # Banco de dados JSON
├── public/
│   ├── index.html                     # App principal do cliente
│   ├── operator.html                  # Painel do operador (eventos)
│   ├── operator-restaurant.html       # Painel do restaurante (NOVO)
│   ├── site.html                      # Landing page do site
│   └── termos.html                    # Termos de uso
├── docs/
│   ├── API.md                         # Documentação completa da API
│   ├── RESUMO-PROJETO.md              # Este arquivo
│   └── CHANGELOG.md                   # Histórico de mudanças
└── PROMPT-PAINEL-RESTAURANTE.md       # Specs do painel restaurante
```

### Funcionalidades do App (index.html)

1. **Home/Registro**: Cadastro com nome, apelido, telefone
2. **Sonic Match**: Conexão por som ultrassônico (18kHz+) entre celulares
3. **Reveal Screen**: Tela de revelação quando dois se encontram — animação elétrica tipo Tron
4. **Constelação**: Visualização das conexões em formato de constelação estelar
5. **Chat**: Mensagens entre conexões
6. **Perfil**: Foto, bio, badges, verificação
7. **Eventos**: Criar/entrar em eventos, ver participantes no "aquário" (nós flutuando)
8. **Menu/Carrinho**: Dentro de eventos-restaurante, navegar cardápio e fazer pedidos
9. **Estrelas**: Sistema de moeda virtual (dar/receber/comprar)
10. **Presentes**: Enviar presentes virtuais para conexões
11. **Declarações**: Enviar declarações (tipo confissões)
12. **Boarding Pass**: Cartão social pessoal para compartilhar

### Painel do Operador (operator.html)

- Criar e gerenciar eventos
- Visualizar participantes no estilo "aquário" (nós flutuando com física 2D)
- Ver conexões sendo feitas em tempo real (raios elétricos)
- Raios de proximidade quando pares conectados passam perto
- Dashboard com estatísticas

### Painel Restaurante (operator-restaurant.html) — NOVO

- **Landing Page**: Página bonita explicando o serviço
- **Login/Registro**: Cadastro simples
- **Gestão de Cardápio**: CRUD completo de itens (nome, descrição, preço, foto, categoria, disponibilidade)
- **Pedidos em Tempo Real**: Via Socket.IO, com notificação sonora
- **Gestão de Status**: Novo → Preparando → Pronto → Entregue
- **Impressão de Comanda**: Formato 80mm para impressora térmica
- **Visão de Mesas**: Grid visual das mesas com status
- **Dashboard**: Faturamento, pedidos, itens mais vendidos
- **20 produtos teste** já populados com fotos reais

## Fluxo do Restaurante

```
1. Operador cria conta no Touch?
2. Acessa /restaurante no tablet/computador
3. Cria evento (nome do restaurante)
4. Cardápio teste já vem populado (20 itens)
5. Edita cardápio conforme necessidade
6. Define número de mesas

--- Cliente ---
7. Cliente chega, faz check-in no Touch? (NFC/código/sonic)
8. Dentro do evento, toca no botão 🍽
9. Navega cardápio, adiciona ao carrinho
10. Escolhe mesa, envia pedido
11. Opção A: "Mostrar pro garçom" (tela grande)
12. Opção B: Enviar digitalmente (chega no painel)

--- Restaurante ---
13. Painel toca som e mostra novo pedido
14. Operador muda status: Preparando → Pronto → Entregue
15. Pode imprimir comanda para cozinha
16. Dashboard mostra resumo de vendas
```

## APIs do Restaurante

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/event/:eventId/menu` | Lista cardápio |
| POST | `/api/operator/event/:eventId/menu` | Salva cardápio |
| POST | `/api/event/:eventId/order` | Cria pedido |
| GET | `/api/operator/event/:eventId/orders` | Lista pedidos |
| POST | `/api/operator/event/:eventId/order/:orderId/status` | Atualiza status |

## Socket Events (Tempo Real)

| Evento | Direção | Dados |
|--------|---------|-------|
| `new-order` | Server → Client | `{eventId, order}` |
| `order-update` | Server → Client | `{eventId, orderId, status}` |
| `event-match` | Server → Client | `{eventId, userA, userB}` |

## Status dos Pedidos

```
pending (Novo) → preparing (Preparando) → ready (Pronto) → delivered (Entregue)
                                                          ↘ cancelled (Cancelado)
```

## Integração com ERPs (Futuro)

O sistema foi projetado para fácil integração:
- APIs REST padrão com JSON
- Socket.IO para eventos em tempo real
- Campo `paymentMethod` extensível
- Webhook pattern para forward de pedidos
- Menu sync bidirecional via API

## URLs de Acesso

| URL | Página |
|-----|--------|
| `/` | App principal (cliente) |
| `/operator` | Painel do operador |
| `/restaurante` | Painel do restaurante |
| `/site` ou `/sobre` | Landing page |
| `/termos` | Termos de uso |

## Ambiente de Desenvolvimento

```bash
# Instalar dependências
npm install

# Rodar servidor
node server.js
# ou com auto-reload:
npx nodemon server.js

# Acessar
http://localhost:3000           # App
http://localhost:3000/restaurante  # Painel restaurante
```

## Git

```bash
# Repositório
git remote -v
# origin https://github.com/bavkiq-hUgby8-cittet/encosta.git

# Usuário
git config user.name   # Ramon
git config user.email  # ramonnvc@hotmail.com
```

---

*Touch? — Conectando pessoas no mundo real*
*Fevereiro 2026*
