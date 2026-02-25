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
5. Leia as secoes relevantes do server.js (linhas ~4900-5850 para MercadoPago, ~5850-6080 para assinaturas)
6. Me diga o que entendeu do estado financeiro atual e pergunte o que preciso

## ACESSO AO PROJETO

- GITHUB: https://github.com/bavkiq-hUgby8-cittet/encosta.git
  (token de acesso ja esta no remote do git local)
- GIT CONFIG: Email ramonnvc@hotmail.com / Nome Ramon

## REGRAS DE TRABALHO

- Sempre commit + push apos cada tarefa
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo
- Leia PROMPT-NOVO-CHAT.md ANTES de tudo -- tem o mapa completo do server.js e index.html

## O QUE JA EXISTE DE FINANCEIRO (estado atual)

### Pagamentos (MercadoPago) -- server.js linhas ~4900-5850:
- PIX (QR code via API MercadoPago)
- Cartao novo (tokenizado via frontend MP SDK)
- Cartao salvo (customer + card via MP API)
- One-tap (pagamento com 1 clique usando cartao salvo)
- Checkout Pro (redirect para checkout MercadoPago)
- Webhook de notificacao (/mp/webhook)

### Fluxos de cobranca:
1. GORJETAS (tipScreen): PIX, cartao novo, cartao salvo one-tap, Checkout Pro
2. ASSINATURAS: Touch Plus R$50/mes, Selo R$10/mes (via preapproval MP)
3. ENTRADA EM EVENTOS: Cartao novo ou one-tap com cartao salvo
4. ESTRELAS: Compradas com pontos de jogo (sem dinheiro real)
5. PRESENTES: Comprados com pontos (sem dinheiro real)

### Extrato financeiro:
- Tela existente com summary cards, filtros, lista de gorjetas
- Dados na collection "tips" do Firebase

### Variaveis de ambiente:
- MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY
- MP_REDIRECT_URI=https://touch-irl.com/mp/callback
- STRIPE_SECRET_KEY, STRIPE_PUBLIC_KEY (preparado mas desativado)

## AUDITORIA RECENTE (feita em 25/02/2026)

Uma auditoria completa de seguranca e performance foi concluida com 30+ fixes:
- Rate limiting em todas as rotas
- requireAuth obrigatorio
- Path traversal protection
- Memory caps em arrays
- IDX indexes para O(1) lookups
- Batch API calls
- Canvas throttle
- Toast FIFO queue
- localStorage obfuscation
Documento completo: AUDITORIA-TOUCH-2026.docx na raiz do projeto

## MAPA RAPIDO DO SERVER.JS (~10900 linhas)

As secoes financeiras estao entre:
- Linhas ~4900-5850: MercadoPago (prestador, tips, pix, checkout, saved card, one-tap, subscription)
- Linhas ~5850-6080: Assinaturas (Plus + Selo)
- DB collections relevantes: tips, subscriptions, ultimateBank

O PROMPT-NOVO-CHAT.md tem o mapa detalhado de TODAS as linhas.

## O QUE EU VOU TE PEDIR

Vou te pedir features de integracoes financeiras. Pode ser:
- Novos metodos de pagamento
- Melhorias no fluxo de checkout
- Dashboard financeiro
- Relatorios
- Split de pagamento
- Novas formas de monetizacao
- Integracao Stripe (Apple Pay / Google Pay)
- Qualquer coisa relacionada a dinheiro no app

Quando estiver pronto com o setup, me avisa que a gente comeca.
```

---

**Como usar:** Abra um novo chat no Cowork, cole o texto acima (so o que esta dentro do bloco de codigo), e o agente vai fazer o setup completo antes de comecar.
