# ROADMAP -- Lancamento do Touch? nos EUA

Atualizado: 25/02/2026

---

## STATUS ATUAL

- touch irl, LLC em Delaware -- INCORPORACAO EM ANDAMENTO (esperado 27 Fev - 3 Mar)
- Stripe Atlas -- PAGO (US$500)
- EIN -- PENDENTE (3-6 semanas)
- App -- FUNCIONANDO em PT-BR (touch-irl.com)
- Auditoria -- CONCLUIDA (30+ fixes de seguranca/performance)

---

## FASE 1 -- AGORA (Fev 2026)

### Voce (Ramon):
- [x] Abrir LLC via Stripe Atlas
- [ ] Configurar lembretes fiscais no Atlas (disponivel agora)
- [ ] Explorar vantagens/creditos no Atlas (US$2.500 Stripe + descontos)

### Agentes que podem rodar AGORA:
- [ ] Soltar AGENTE TRADUTOR (PROMPT-TRADUTOR.md) -- comecar i18n para ingles
  - Nao depende da LLC, pode comecar imediatamente
  - Prioridade: ingles americano primeiro
  - Entrega: inventario de textos + arquitetura i18n + traducoes

---

## FASE 2 -- INCORPORACAO (1-7 Mar 2026)

### Voce (Ramon):
- [ ] Abrir conta Mercury (banco digital US) -- desbloqueia no Atlas
- [ ] Ativar Stripe para aceitar pagamentos -- desbloqueia no Atlas
- [ ] Guardar dados da empresa: LLC number, registered agent, endereco Delaware

### Agentes:
- [ ] AGENTE TRADUTOR continua trabalhando no ingles
- [ ] Soltar AGENTE FINANCEIRO (PROMPT-FINANCEIRO.md) -- implementar Stripe Connect
  - Precisa do Stripe ativo
  - Entrega: endpoints de pagamento US, Apple Pay, Google Pay

---

## FASE 3 -- POS-INCORPORACAO (Mar 2026)

### Voce (Ramon):
- [ ] Receber EIN por correio (3-6 semanas = ate abril)
- [ ] Configurar contabilidade no Atlas (desbloqueia apos EIN)

### Agentes:
- [ ] Soltar AGENTE FISCAL (PROMPT-FISCAL.md)
  - Entrega: calendario fiscal, planilha de conciliacao, compliance US+BR
- [ ] AGENTE FINANCEIRO: testar pagamentos em sandbox Stripe
- [ ] AGENTE TRADUTOR: finalizar traducao EN-US + comecar ES-LATAM

### Documentos legais:
- [ ] Terms of Service em ingles (template Atlas + revisao)
- [ ] Privacy Policy em ingles (CCPA compliance)
- [ ] Opcional: consulta com advogado de fintech (~US$200-500)

---

## FASE 4 -- COMPLIANCE (Abr-Mai 2026)

### Voce (Ramon):
- [ ] Registrar no FinCEN como MSB (Form 107, gratuito, online)
  - Prazo: ate 180 dias apos abertura (~agosto 2026)
  - Mas quanto antes melhor

### Agentes:
- [ ] AGENTE FISCAL: preparar Form 107 do FinCEN
- [ ] AGENTE FISCAL: modelar precos USD (gorjetas, Plus, Selo, eventos)
- [ ] AGENTE FINANCEIRO: migrar de sandbox para producao no Stripe

---

## FASE 5 -- SOFT LAUNCH (Mai-Jun 2026)

### Acoes:
- [ ] Beta testers americanos (grupo limitado, convite)
- [ ] Testar fluxo completo: signup -> sonic -> chat -> tip -> subscription
- [ ] Monitorar pagamentos reais no Stripe Dashboard
- [ ] Ajustar precos baseado em feedback
- [ ] Corrigir bugs de i18n encontrados nos testes

---

## FASE 6 -- LANCAMENTO PUBLICO (Jun-Jul 2026)

### Acoes:
- [ ] App Store (iOS) -- se aplicavel
- [ ] Google Play (Android) -- se aplicavel
- [ ] Ou lancamento via PWA (touch-irl.com) -- ja funciona
- [ ] Marketing inicial para mercado US
- [ ] Monitoramento de metricas: DAU, revenue, churn, conversion

---

## FASE 7 -- ESCALA (Jul+ 2026)

### Acoes:
- [ ] Traducao para Espanhol LATAM
- [ ] Traducao para Japones
- [ ] Avaliar necessidade de servidor dedicado US (latencia)
- [ ] Avaliar conversao LLC -> C-Corp se buscar investimento
- [ ] AGENTE FISCAL: primeiro fechamento mensal com conciliacao

---

## PRAZOS FISCAIS ANUAIS

| Prazo | O que | Custo | Quem faz |
|-------|-------|-------|----------|
| Ate 180 dias da abertura | FinCEN MSB Registration (Form 107) | Gratis | Agente fiscal + Ramon |
| 1 junho de cada ano | Delaware Annual Tax | US$300 | Ramon (pagamento online) |
| 1 junho de cada ano | Delaware Annual Report | Incluso | Stripe Atlas |
| 15 abril de cada ano | Form 5472 + Form 1120 pro-forma (IRS) | CPA ~US$300-500 | CPA + Agente fiscal |
| US$100/ano | Registered Agent (a partir do 2o ano) | US$100 | Stripe Atlas |
| Abril de cada ano | IRPF Brasil (declarar LLC exterior) | Contador BR | Contador + Agente fiscal |

---

## CUSTOS RECORRENTES

| Item | Custo | Frequencia |
|------|-------|------------|
| Registered Agent | US$100 | Anual (a partir 2027) |
| Delaware Tax | US$300 | Anual |
| CPA (contador US) | US$300-500 | Anual (para Form 5472) |
| Stripe fees | 2.9% + US$0.30/transacao | Por transacao |
| Render hosting | ~US$25/mes | Mensal |
| OpenAI (Voice Agent) | ~US$0.08-0.25/sessao | Por uso |
| Dominio | US$10-15 | Anual |

---

## LISTA DE PROMPTS DISPONIVEIS

| Prompt | Arquivo | Para que serve |
|--------|---------|----------------|
| Contexto geral | PROMPT-NOVO-CHAT.md | Qualquer agente novo |
| Traducao/i18n | PROMPT-TRADUTOR.md | Internacionalizar o app |
| Financeiro | PROMPT-FINANCEIRO.md | Stripe Connect + pagamentos US |
| Fiscal/Contabil | PROMPT-FISCAL.md | Compliance, impostos, conciliacao |

---

## DOCUMENTOS DE REFERENCIA

| Documento | O que contem |
|-----------|-------------|
| AUDITORIA-TOUCH-2026.docx | 30+ fixes de seguranca e performance |
| PLANO-EMPRESA-USA.docx | Guia completo da abertura da LLC nos EUA |
| CHANGELOG-sessao-*.md | Historico de mudancas por sessao |
| docs/ULTIMATEDEV.md | Documentacao do Voice Agent UltimateDEV |
