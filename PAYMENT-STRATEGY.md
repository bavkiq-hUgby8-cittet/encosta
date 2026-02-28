# Touch? - Estrategia de Pagamento

**Ultima atualizacao:** 2026-02-28
**Status:** Em implementacao

---

## Modelo de Negocio

A **Touch IRL LLC** e o intermediador de todos os pagamentos na plataforma.
Todos os pagamentos passam pela conta Stripe da Touch, que faz o split/repasse
para os recebedores (prestadores, organizadores de eventos, etc.).

## Gateway Unico: Stripe

Utilizamos **exclusivamente Stripe** como gateway de pagamento.
MercadoPago esta pausado ate segunda ordem.

### Metodos de pagamento disponiveis para o pagador:

| Metodo | Onde funciona | Notas |
|--------|--------------|-------|
| Apple Pay | iOS / Safari (global) | Via Stripe Payment Request API |
| Google Pay | Android / Chrome (global) | Via Stripe Payment Request API |
| Cartao de credito/debito | Global | Via Stripe Payment Element |
| Link (Stripe) | Global | Email-based, 1-click after primeiro uso |
| PIX | Brasil | Via Stripe (beta) ou integracao direta |

### UI padrao em TODAS as telas de pagamento:

```
[  Apple Pay  ]  ou  [  Google Pay  ]    <-- detecta o SO automaticamente
[  Outras formas de pagamento  v  ]      <-- toggle, abre:
   - Cartao de credito (Stripe PE com Link)
   - PIX (somente Brasil)
   - Cartao salvo (se houver)
```

## Recebimento: Como o prestador/organizador recebe

### Opcao 1: Stripe Connect (PRINCIPAL)

- Prestador clica em "Conectar conta" no perfil do Touch?
- Redirecionado para onboarding do Stripe Connect (Express)
- Stripe faz KYC automatico (verificacao de identidade)
- Funciona em 46+ paises
- Split automatico: Touch cobra taxa, resto vai direto pro prestador
- Payout: 2-7 dias uteis, cai na conta bancaria local

**Fluxo tecnico:**
1. Touch cria Connected Account via API
2. Prestador completa onboarding no Stripe
3. Cada pagamento: Touch cria PaymentIntent com `transfer_data.destination`
4. Stripe faz split automatico

### Opcao 2: Stripe Payouts (COMPLEMENTAR)

- Para quem NAO quer/pode criar conta Stripe Connect
- Touch recebe o pagamento integralmente
- Touch faz payout manual para conta bancaria do recebedor
- Funciona nos paises onde a Touch tem conta Stripe (inicialmente: EUA e Brasil)
- Mais lento que Connect (depende de acao manual ou batch)

**Fluxo tecnico:**
1. Prestador cadastra dados bancarios no perfil do Touch?
2. Saldo acumula no perfil dele
3. Touch executa Payout via Stripe API
4. Dinheiro cai na conta bancaria em 1-3 dias uteis

### Opcao 3: Saldo pendente (FALLBACK)

- Prestador nao configurou nenhuma forma de recebimento
- Touch recebe e guarda como "saldo pendente"
- Saldo fica disponivel quando prestador conectar Stripe Connect ou cadastrar conta para Payout
- Notificacao periodica para lembrar o prestador de configurar recebimento

## Taxa da Plataforma

- A definir (sugestao: 5-15% dependendo do tipo de transacao)
- Gorjeta: taxa menor (incentivo)
- Ingresso: taxa padrao
- Assinatura: taxa fixa

## Mercados de Lancamento

| Pais | Metodos do pagador | Recebimento |
|------|-------------------|-------------|
| EUA | Apple Pay, Google Pay, Card, Link | Stripe Connect + Payouts |
| Brasil | Apple Pay, Google Pay, Card, Link, PIX | Stripe Connect + Payouts |

## Roadmap

- [x] Stripe Payment Element inline (cartao + Link)
- [x] Apple Pay / Google Pay via Express Checkout
- [x] PIX para pagamentos
- [ ] Stripe Connect onboarding para prestadores
- [ ] Stripe Payouts para prestadores sem Connect
- [ ] Dashboard de saldo/recebimentos para prestador
- [ ] Split automatico nos PaymentIntents
- [ ] Notificacao de saldo pendente
- [ ] MercadoPago (futuro, quando necessario)
