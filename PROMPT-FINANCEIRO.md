# PROMPT -- Integracoes Financeiras do Touch?

Cole este prompt ao iniciar um novo chat:

---

```
Voce vai me ajudar com as INTEGRACOES FINANCEIRAS do app "Touch?" (Encosta) -- uma rede social baseada em proximidade fisica (ultrassonica).

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## SETUP OBRIGATORIO (faca ANTES de qualquer coisa)

1. Selecione a pasta "encosta" no meu computador quando o Cowork pedir
2. Execute: git pull origin main
3. Execute: git log --oneline -15
4. Leia o arquivo PROMPT-NOVO-CHAT.md na raiz do projeto -- ele tem o mapa COMPLETO do projeto
5. Leia docs/ARQUITETURA.md -- tem o mapa de linhas de TODOS os endpoints
6. Me diga o que entendeu do estado financeiro atual e pergunte o que preciso

## ACESSO AO PROJETO

- GITHUB: https://github.com/bavkiq-hUgby8-cittet/encosta.git
  (token de acesso ja esta no remote do git local)
- GIT CONFIG: Email ramonnvc@hotmail.com / Nome Ramon

## REGRAS DE TRABALHO

- SEMPRE git pull origin main ANTES de editar qualquer arquivo
- Sempre commit + push apos cada tarefa
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo

## O QUE JA EXISTE DE FINANCEIRO (estado atual 28/02/2026)

### MercadoPago (BR) -- server.js linhas ~7464-8900:
- PIX (QR code via API MercadoPago)
- Cartao novo (tokenizado via frontend MP SDK)
- Cartao salvo (customer + card via MP API)
- One-tap (pagamento com 1 clique usando cartao salvo)
- Checkout Pro (redirect para checkout MercadoPago)
- Webhook de notificacao (/mp/webhook)
- Prestador register/status/dashboard
- Assinaturas (Plus R$50/mes, Selo R$10/mes via preapproval MP)

### Stripe (US/International) -- server.js linhas ~12260-12840:
- Payment Intents (pay, create-payment-intent, confirm)
- Subscription (create, cancel, plans)
- Connect pessoal: onboarding (connect-url, connect-refresh, connect-result, connect-status)
- Connect por evento: onboarding separado (event-connect-url, event-connect-result)
- Webhook (/api/stripe/webhook) com verificacao de assinatura

### Dashboard Financeiro Admin -- server.js linhas ~6690-6930:
- GET /api/admin/financial -- dashboard completo com:
  - Gorjetas: total, taxas, liquido, metodos de pagamento, top prestadores
  - Entradas de eventos: total, taxas, contagem
  - Assinaturas: ativas, inativas, receita
  - Resumo: receita bruta, taxas, plataforma, saldo retido
  - Status de transferencias (Stripe, MP, manual, pendente)
  - Prestadores: total, com Stripe, com MP, sem meio
  - Transacoes recentes (ultimas 50)
- GET /api/admin/payouts/pending -- prestadores com saldo retido
- POST /api/admin/payouts/register -- registrar payout manual (PIX, TED, dinheiro)
- GET /api/admin/payouts/history -- historico de payouts

### Prestador endpoints -- server.js linhas ~6899-6930 e ~7473-8200:
- POST /api/prestador/register -- cadastro de prestador
- GET /api/prestador/:userId/status -- status de conexao MP/Stripe
- GET /api/prestador/:userId/dashboard -- painel com gorjetas + entradas recebidas
- POST /api/prestador/:userId/bank-info -- salvar chave PIX / dados bancarios
- GET /api/prestador/:userId/payouts -- historico de pagamentos do prestador

### Fluxos de cobranca:
1. GORJETAS (tipScreen): PIX, cartao novo, cartao salvo one-tap, Checkout Pro, Stripe
2. ASSINATURAS: Touch Plus R$50/mes, Selo R$10/mes (preapproval MP)
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap, com split para operador
4. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
5. PRESENTES: Comprados com pontos (sem dinheiro real)

### DB Collections relevantes:
- tips -- gorjetas (status, amount, fee, method, receiverId, payerId)
- subscriptions -- assinaturas ativas/canceladas
- ultimateBank -- saldo de pontos
- operatorEvents -- eventos (inclui paymentStripeAccountId, paymentStripeConnected)
- eventPayments -- pagamentos de entrada em eventos
- payouts -- pagamentos manuais para prestadores
- users -- inclui campos: stripeConnectId, stripeConnected, mpAccessToken, bankInfo

### Variaveis de ambiente (Render):
- MP_ACCESS_TOKEN, MP_APP_ID, MP_CLIENT_SECRET, MP_PUBLIC_KEY
- MP_REDIRECT_URI=https://touch-irl.com/mp/callback
- MP_WEBHOOK_SECRET
- STRIPE_SECRET_KEY, STRIPE_PUBLIC_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_CONNECT_CLIENT_ID (pendente verificar no Render)

## AUDITORIA RECENTE (25-27/02/2026)

- 30+ fixes de seguranca/performance aplicados
- requireAuth em todos endpoints novos
- Rate limiting em todas as rotas
- Ver docs/SEGURANCA.md para lista completa

## O QUE EU VOU TE PEDIR

Vou te pedir features de integracoes financeiras. Pode ser:
- Novos metodos de pagamento
- Melhorias no fluxo de checkout
- Dashboard financeiro avancado
- Relatorios e conciliacao
- Split de pagamento
- Novas formas de monetizacao
- Stripe Connect (producao)
- Payout automatico para prestadores
- Qualquer coisa relacionada a dinheiro no app

Quando estiver pronto com o setup, me avisa que a gente comeca.
```

---

**Como usar:** Abra um novo chat no Cowork, cole o texto acima (so o que esta dentro do bloco de codigo), e o agente vai fazer o setup completo antes de comecar.
