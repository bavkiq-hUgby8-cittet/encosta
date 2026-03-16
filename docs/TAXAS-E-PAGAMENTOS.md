# Touch? — Taxas, Repasses e Prazos de Pagamento

**Ultima atualizacao:** 2026-03-16
**Status:** Documento de referencia para agentes e decisoes

---

## 1. RESUMO EXECUTIVO

A Touch IRL LLC cobra uma taxa de servico sobre cada transacao. O Stripe e o unico gateway de pagamento (MercadoPago pausado). O dinheiro passa por 3 etapas: pagamento do cliente -> saldo disponivel no Stripe da Touch -> conta bancaria da empresa/parceiro.

---

## 2. TAXAS DO STRIPE (custo fixo, nao controlamos)

### 2.1 Transacoes domesticas (EUA)
- **2.9% + $0.30** por transacao com cartao de credito/debito
- Apple Pay e Google Pay: mesma taxa (2.9% + $0.30) — usam Stripe Payment Request API
- Stripe Link (1-click checkout): mesma taxa

### 2.2 Transacoes internacionais
- Cartao emitido fora dos EUA: **+1%** adicional (total: 3.9% + $0.30)
- Conversao de moeda necessaria: **+1%** adicional (total: 4.9% + $0.30)
- Pior caso (cartao internacional + conversao): **5.9% + $0.30** (raro no cenario de gorjetas locais)

### 2.3 Stripe Tax (opcional, somente produtos)
- **0.5%** por transacao — aplica-se a vendas de produtos/delivery, NAO a gorjetas
- Configuravel via `STRIPE_TAX_ENABLED=true` no .env
- Tax codes configurados: `txcd_40060003` (comida) e `txcd_10000000` (delivery)
- Gorjetas sao isentas de sales tax nos EUA

### 2.4 Outras cobranças do Stripe
- Chargeback (disputa de pagamento): **$15 por ocorrencia**
- Sem mensalidade, sem taxa de setup, sem minimo mensal
- Stripe Connect (conta dos parceiros): sem custo adicional alem da taxa por transacao

---

## 3. TAXA DA TOUCH? (nos controlamos)

### 3.1 Configuracao atual
- **`TOUCH_FEE_PERCENT = 10`** (10% sobre o valor total da transacao)
- Definido em `server.js` linha 1396: `const TOUCH_FEE_PERCENT = parseFloat(process.env.TOUCH_FEE_PERCENT || '10');`
- Tambem configuravel via variavel de ambiente `TOUCH_FEE_PERCENT` no .env do Render
- No simulador financeiro (`business-model.html`), os defaults sao: 5% sobre vendas de produtos e 10% sobre gorjetas

### 3.2 Como a taxa e calculada no codigo
```javascript
// server.js linha ~8000 (gorjeta MP)
const touchFee = Math.round(tipAmount * TOUCH_FEE_PERCENT) / 100; // 10%

// server.js linha ~13856 (Stripe Connect)
const fee = Math.round(amountCents * TOUCH_FEE_PERCENT / 100);
intentData.application_fee_amount = fee;
intentData.transfer_data = { destination: receiver.stripeConnectId };

// server.js linha ~8065 (MercadoPago split)
paymentData.application_fee = touchFee;
```

### 3.3 Onde alterar a taxa
- **Rapido:** Mudar `TOUCH_FEE_PERCENT` no painel do Render (Environment Variables)
- **Permanente:** Alterar o default em `server.js` linha 1396
- **Nota:** A taxa se aplica igualmente a gorjetas, ingressos e vendas. Para taxas diferenciadas por tipo de transacao, sera necessario criar variaveis separadas (ex: `TOUCH_TIP_FEE_PERCENT`, `TOUCH_ORDER_FEE_PERCENT`)

---

## 4. EXEMPLOS PRATICOS — QUANTO CADA UM FICA

### 4.1 Gorjeta de $10 (cenario principal)

| Etapa | Valor |
|-------|-------|
| Cliente paga | $10.00 |
| Taxa Stripe (2.9% + $0.30) | -$0.59 |
| Disponivel no Stripe da Touch | $9.41 |
| Taxa Touch (10% de $10) | -$1.00 |
| **Prestador recebe** | **$8.41** |
| **Lucro liquido Touch** | **$0.41** ($1.00 taxa - $0.59 Stripe) |

### 4.2 Gorjeta de $5

| Etapa | Valor |
|-------|-------|
| Cliente paga | $5.00 |
| Taxa Stripe (2.9% + $0.30) | -$0.45 |
| Disponivel no Stripe | $4.55 |
| Taxa Touch (10% de $5) | -$0.50 |
| **Prestador recebe** | **$4.05** |
| **Lucro liquido Touch** | **$0.05** |

**Observacao:** Em gorjetas abaixo de ~$4, a Touch pode ter prejuizo por causa do $0.30 fixo do Stripe.

### 4.3 Gorjeta de $20

| Etapa | Valor |
|-------|-------|
| Cliente paga | $20.00 |
| Taxa Stripe (2.9% + $0.30) | -$0.88 |
| Disponivel no Stripe | $19.12 |
| Taxa Touch (10% de $20) | -$2.00 |
| **Prestador recebe** | **$17.12** |
| **Lucro liquido Touch** | **$1.12** |

### 4.4 Gorjeta de $50

| Etapa | Valor |
|-------|-------|
| Cliente paga | $50.00 |
| Taxa Stripe (2.9% + $0.30) | -$1.75 |
| Disponivel no Stripe | $48.25 |
| Taxa Touch (10% de $50) | -$5.00 |
| **Prestador recebe** | **$43.25** |
| **Lucro liquido Touch** | **$3.25** |

### 4.5 Venda de produto $30 (com Stripe Tax habilitado)

| Etapa | Valor |
|-------|-------|
| Cliente paga | $30.00 + sales tax (varia por estado) |
| Taxa Stripe (2.9% + $0.30) | -$1.17 (sobre $30) |
| Stripe Tax (0.5%) | -$0.15 |
| Disponivel no Stripe | $28.68 |
| Taxa Touch (5% sobre venda) | -$1.50 |
| **Parceiro (restaurante) recebe** | **$27.18** |
| **Lucro liquido Touch** | **$0.33** |

---

## 5. PRAZOS — QUANDO O DINHEIRO CAI

### 5.1 Para a conta Stripe da Touch IRL LLC

| Etapa | Prazo |
|-------|-------|
| Pagamento processado | Instantaneo |
| Saldo fica "pendente" no Stripe | Instantaneo |
| Saldo fica "disponivel" (settlement) | **T+2 dias uteis** (padrao EUA) |
| Payout automatico para banco da LLC | **+1-2 dias uteis** apos disponivel |
| **TOTAL: pagamento ate banco** | **3-4 dias uteis** |

**Excecao:** Primeiro payout de conta nova = **7-14 dias** (padrao Stripe para novas contas).

### 5.2 Para parceiros/prestadores via Stripe Connect

| Etapa | Prazo |
|-------|-------|
| Pagamento processado (split automatico) | Instantaneo |
| Saldo disponivel na conta Connect do parceiro | **T+2 dias uteis** |
| Payout para banco do parceiro | **+1-2 dias uteis** |
| **TOTAL: pagamento ate banco do parceiro** | **3-7 dias uteis** |

**Primeiro payout do parceiro:** 7-14 dias (conta nova no Stripe Connect).

### 5.3 Para parceiros SEM Stripe Connect (payout manual)

| Etapa | Prazo |
|-------|-------|
| Saldo acumula na conta da Touch | Continuo |
| Admin executa payout manual | Quando o admin decidir |
| Dinheiro cai no banco do parceiro | **1-3 dias uteis** apos execucao |
| **TOTAL** | Depende da frequencia de payouts manuais |

### 5.4 Opcoes de payout schedule (configuravel no Stripe Dashboard)

| Frequencia | Como funciona |
|------------|---------------|
| **Daily (padrao)** | Payout automatico todo dia util, dos fundos disponiveis |
| **Weekly** | Payout 1x por semana, dia configuravel |
| **Monthly** | Payout 1x por mes, data configuravel |
| **Manual** | So transfere quando a Touch executar manualmente |

---

## 6. FLUXO TECNICO DO SPLIT (Stripe Connect)

Quando o parceiro tem Stripe Connect configurado, o split e automatico:

```
Cliente paga $10.00
    |
    v
Stripe processa pagamento
    |-- Stripe fica com $0.59 (2.9% + $0.30)
    |-- Touch fica com $1.00 (application_fee_amount = 10%)
    |-- Parceiro recebe $8.41 (transfer_data.destination)
    |
    v
Tudo automatico, sem acao manual
```

Quando o parceiro NAO tem Stripe Connect:
```
Cliente paga $10.00
    |
    v
Stripe processa pagamento
    |-- Stripe fica com $0.59
    |-- Touch recebe $9.41 integralmente
    |-- Saldo do parceiro: registrado no DB (retainedInTouch)
    |
    v
Admin faz payout manual quando necessario (api/admin/payouts)
```

---

## 7. ROTAS DE PAGAMENTO NO CODIGO

| Rota | Metodo | Funcao |
|------|--------|--------|
| `POST /api/tip` | MercadoPago cartao | Gorjeta via MP (Brasil) |
| `POST /api/tip/pix` | MercadoPago PIX | Gorjeta via PIX (Brasil) |
| `POST /api/tip/checkout` | MP Checkout Pro | Redirect MP (todos metodos) |
| `POST /api/stripe/create-payment-intent` | Stripe Payment Element | Gorjeta/entrada/venda (global) |
| `POST /api/stripe/confirm-payment` | Stripe | Confirma pagamento pos-frontend |
| `POST /api/stripe/pay` | Stripe Express Checkout | Apple Pay / Google Pay rapido |
| `POST /api/stripe/create-subscription` | Stripe Checkout | Assinatura |
| `POST /api/stripe/webhook` | Stripe Webhook | Confirmacoes assincronas |
| `GET /api/admin/finance` | Admin | Dashboard financeiro |
| `GET /api/admin/payouts/pending` | Admin | Lista parceiros com saldo retido |

---

## 8. O QUE PRECISA IR NO SITE (site.html)

### 8.1 Secao de transparencia para prestadores/parceiros

O site precisa de uma secao clara (sugestao: "Pricing" ou "For Partners") com:

**Para quem RECEBE gorjetas (prestadores):**
- "Receba gorjetas digitais via Apple Pay, Google Pay ou cartao"
- "Taxa de servico: 10% — voce recebe 90% de cada gorjeta"
- "Prazo de recebimento: 2-7 dias uteis na sua conta bancaria"
- "Primeiro recebimento: ate 14 dias (verificacao Stripe)"
- "Sem mensalidade, sem taxa de adesao"
- "$0 para o cliente — quem paga a taxa e a plataforma"

**Para parceiros comerciais (restaurantes, eventos):**
- "Taxa de servico: a partir de 5% sobre vendas"
- "Split automatico: dinheiro vai direto pra sua conta"
- "Dashboard em tempo real dos seus recebimentos"
- "Suporte a Apple Pay, Google Pay, cartao e Link"

### 8.2 O que JA esta no site
- "$0 fees for tippers" (correto — taxa zero para quem da gorjeta)
- "No expensive hardware, no card reader, no monthly fees" (correto)
- Falta: secao dedicada de pricing/taxas para prestadores

### 8.3 Sugestao de disclaimer legal
- "Gorjetas sao processadas pela Stripe, Inc. Touch IRL LLC atua como intermediador."
- "Prazos de deposito podem variar conforme instituicao bancaria e verificacao da conta."
- "A Touch IRL LLC nao e uma instituicao financeira."

---

## 9. DECISOES PENDENTES

### 9.1 Taxa diferenciada por tipo
Atualmente `TOUCH_FEE_PERCENT = 10` se aplica a tudo. Considerar:
- Gorjeta: 10% (incentiva uso, margem menor)
- Venda de produto: 5% (competitivo com iFood/DoorDash que cobram 15-30%)
- Ingresso de evento: 8%?
- Assinatura: taxa fixa (ja funciona via Stripe Checkout)

### 9.2 Gorjetas muito pequenas
Em gorjetas abaixo de ~$4, o $0.30 fixo do Stripe consome quase toda a margem da Touch. Opcoes:
- Definir valor minimo de gorjeta ($3 ou $5)
- Absorver o custo como investimento em adocao
- Criar bundles ("3 gorjetas de $2 por $6" — 1 unica transacao)

### 9.3 Instant Payouts
Stripe oferece Instant Payouts (dinheiro em 30 min) com taxa adicional de 1% + $0.50. Considerar oferecer como premium pro parceiro que quiser receber mais rapido.

### 9.4 Payout schedule dos parceiros
Definir se parceiros recebem daily (mais satisfatorio) ou weekly (menos custo operacional). Recomendacao: daily como padrao — diferencial competitivo.

---

## 10. RESUMO RAPIDO PRA QUALQUER AGENTE

- **Stripe cobra:** 2.9% + $0.30 por transacao nos EUA
- **Touch cobra:** 10% do valor (configuravel via env TOUCH_FEE_PERCENT)
- **Parceiro recebe:** ~84% do valor pago pelo cliente (ex: $8.41 de cada $10)
- **Touch lucra:** ~4% liquido por transacao (apos pagar Stripe)
- **Prazo empresa:** 3-4 dias uteis (T+2 settlement + 1-2 dias payout)
- **Prazo parceiro:** 3-7 dias uteis (Stripe Connect com auto-split)
- **Primeiro payout:** 7-14 dias (conta nova, tanto Touch quanto parceiro)
- **Site precisa:** secao de "Pricing" transparente pra prestadores
- **Arquivo de config:** server.js linha 1396, ou env TOUCH_FEE_PERCENT no Render
- **Simulador:** business-model.html (5% vendas, 10% gorjetas, ajustavel)

---

## 11. SISTEMA DE REEMBOLSOS (IMPLEMENTADO 16/03/2026)

### Endpoints de Reembolso

| Rota | Metodo | Funcao | Quem usa |
|------|--------|--------|----------|
| `POST /api/admin/refund` | Admin | Reembolso total ou parcial de qualquer transacao | Admin |
| `GET /api/admin/refunds` | Admin | Lista todos os reembolsos | Admin |
| `GET /api/admin/disputes` | Admin | Lista chargebacks/disputas | Admin |
| `POST /api/operator/event/:id/refund-order` | Operador | Reembolso de pedido especifico | Dono do evento |
| `POST /api/stripe/refund-payment` | Usuario | Solicitar reembolso (janela 24h) | Cliente |
| `POST /api/admin/reconcile-payments` | Admin | Reconcilia pagamentos pendentes com Stripe | Admin |

### Como funciona o reembolso

1. **Admin refund**: Pode reembolsar qualquer transacao por tipId, eventPaymentId ou paymentIntentId. Suporta reembolso parcial (informar amount).
2. **Operator refund**: Dono do evento pode reembolsar pedidos (ex: pedido errado, cancelamento). Verifica permissao.
3. **User refund**: Cliente pode pedir reembolso de gorjetas dentro de 24h. Apos 24h, precisa contatar suporte.
4. **Reconciliation**: Admin pode rodar reconciliacao que verifica pagamentos pendentes (ultimas 48h) diretamente no Stripe e atualiza status.

### Webhook handlers adicionados (16/03/2026)

- `payment_intent.payment_failed` - Marca transacao como falha, notifica usuario
- `charge.dispute.created` - Registra chargeback, notifica admins
- `charge.dispute.closed` - Atualiza resultado da disputa (won/lost)
- `charge.refunded` - Marca transacao como reembolsada

### Protecoes implementadas

- Idempotency keys em todos os PaymentIntents (previne cobranca duplicada)
- Rate limiting em endpoints de reembolso
- Verificacao de permissao (admin, operador, ou dono da transacao)
- Janela de 24h para auto-reembolso pelo usuario
- Reversao automatica de stats do receiver em reembolso total

---

## 12. COMPARATIVO STRIPE vs MERCADOPAGO (BRASIL)

### Taxas por transacao

| | Stripe (Brasil) | MercadoPago |
|---|---|---|
| Cartao credito a vista | 3.99% + R$0.39 | 4.99% |
| Cartao debito | 3.99% + R$0.39 | 1.99% |
| PIX | 3.99% + R$0.39 | 0.99% (ou gratis ate R$150) |
| Boleto | Nao suporta | 3.49% (min R$3.49) |
| Prazo recebimento | T+2 (cartao), instantaneo (PIX) | T+14 (cartao), instantaneo (PIX) |
| Antecipacao | 1.09%/mes | 2.99%/mes |
| Chargeback | R$75 | R$50 |

### Recomendacao

- **EUA**: Stripe (unica opcao viavel, 2.9% + $0.30)
- **Brasil PIX**: MercadoPago (0.99% vs 3.99% do Stripe = 4x mais barato)
- **Brasil Cartao**: MercadoPago pra debito (1.99% vs 3.99%), empatado pra credito
- **Brasil Prazo**: Stripe melhor (T+2 vs T+14 no MP), mas MP tem PIX instantaneo
- **Conclusao**: Manter os dois gateways. Stripe como primario global, MP como opcao PIX no Brasil.

---

## 13. SISTEMA DE PRECOS REGIONAIS

### 13.1 Estrutura

Todos os precos do app estao centralizados na constante `PRICING` no server.js (~linha 1920).
O frontend carrega os precos via `GET /api/region-config` ao iniciar.

### 13.2 Regioes suportadas

| Regiao | Moeda | Gateway principal | Assinatura Plus | Selo | Gorjetas sugeridas |
|--------|-------|-------------------|-----------------|------|--------------------|
| US     | USD   | Stripe            | $4.99/mo        | $1.99/mo | $2, $5, $10, $20 |
| BR     | BRL   | MercadoPago       | R$29,90/mo      | R$9,90/mo | R$5, R$10, R$20, R$50 |
| LATAM  | USD   | Stripe            | $4.99/mo        | $1.99/mo | $2, $5, $10, $20 |

### 13.3 Deteccao automatica de regiao

1. Header `X-Touch-Region` (override explicito do frontend)
2. `Accept-Language` do browser (pt=BR, es=LATAM, default=US)
3. Header `X-Touch-Timezone` (fusos brasileiros=BR, fusos latinos=LATAM)
4. Fallback: `DEFAULT_REGION` env var (padrao: US)

### 13.4 Onde editar precos

**Opcao 1 -- Pelo admin panel (RECOMENDADO):**
Abra o app -> menu -> botao "Precos" (roxo, so aparece pra admin).
Troque entre abas US/BR/LATAM, edite os campos, clique "Salvar alteracoes".
Precos salvos no Firebase RTDB (/pricingConfig) e aplicados imediatamente.
Botao "Resetar" volta tudo pro padrao original (PRICING_DEFAULTS no server.js).

**Opcao 2 -- Pelo codigo:**
Edite a constante `PRICING_DEFAULTS` no server.js (~linha 1926). Busque por "TABELA DE PRECOS POR REGIAO".
Cada regiao tem: plusMonthly, seloMonthly, tipSuggestions, tipMin, tipMax, gifts, verifiedBadge, barberDefaults, parkingHourly, gymMonthly, starPrice.
Note: overrides salvos via admin panel prevalecem sobre os defaults do codigo.

**Endpoints admin:**
- `GET /api/admin/pricing` -- retorna precos atuais + defaults
- `POST /api/admin/pricing` -- salva alteracoes (body: {pricing: {US: {...}, BR: {...}}})
- `POST /api/admin/pricing/reset` -- reseta para defaults (body: {region: 'BR'} ou {} para todos)

O frontend atualiza automaticamente via `applyRegionPricing()`.

### 13.5 Estrutura tributaria

- **LLC (Delaware):** Fatura tudo via Stripe (USD) — mercado global
- **Entidade brasileira (MEI/ME):** Fatura via MercadoPago (BRL) — mercado domestico
- Contrato intercompany entre as duas entidades (royalties de licenca de software)

---

## FONTES

- Stripe Pricing: https://stripe.com/pricing
- Stripe Pricing BR: https://stripe.com/br/pricing
- MercadoPago Taxas: https://www.mercadopago.com.br/costs-section
- Stripe Payout Schedules: https://support.stripe.com/questions/payout-schedules-faq
- Stripe Payouts: https://stripe.com/resources/more/payouts-explained
- Stripe Settlement: https://docs.stripe.com/payments/balances
- Stripe Connect Payouts: https://docs.stripe.com/connect/payouts-connected-accounts
- Stripe Tax: https://stripe.com/docs/tax/tax-codes
