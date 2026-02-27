# EMPRESA NOS EUA + ROADMAP -- Touch?

Atualizado: 27/02/2026

## STATUS DA LLC

- Empresa: touch irl, LLC
- Estado: Delaware (via Stripe Atlas)
- Status: INCORPORACAO EM ANDAMENTO (esperado 27 Fev - 3 Mar 2026)
- EIN (Tax ID): Pendente (3-6 semanas apos incorporacao)
- Conta bancaria: Mercury (sera aberta apos incorporacao)
- Stripe US: Sera ativado apos incorporacao
- Custo pago: US$500

## ESTRUTURA FISCAL

- Tipo: Single-Member LLC (foreign-owned disregarded entity)
- Tributacao: Pass-through (lucro passa direto pro dono)
- Stripe Connect cobre licenca MTL (Money Transmitter License)
- Precisa de CPA (contador US) para: classificacao ECI, tratado bitributacao BR-US, Form 5472

## PRAZOS FISCAIS

| Prazo | O que | Custo | Quem |
|-------|-------|-------|------|
| Ate 180 dias (~ago 2026) | FinCEN MSB Registration (Form 107) | Gratis | Ramon + Agente fiscal |
| 1 junho/ano | Delaware Annual Tax | US$300 | Ramon |
| 1 junho/ano | Delaware Annual Report | Incluso | Stripe Atlas |
| 15 abril/ano | Form 5472 + Form 1120 (IRS) | CPA ~US$300-500 | CPA + Agente fiscal |
| US$100/ano | Registered Agent (a partir 2027) | US$100 | Stripe Atlas |
| Abril/ano | IRPF Brasil (declarar LLC) | Contador BR | Contador + Agente fiscal |

## CUSTOS RECORRENTES

| Item | Custo | Frequencia |
|------|-------|------------|
| Registered Agent | US$100 | Anual (a partir 2027) |
| Delaware Tax | US$300 | Anual |
| CPA (contador US) | US$300-500 | Anual |
| Stripe fees | 2.9% + US$0.30/tx | Por transacao |
| Render hosting | ~US$25/mes | Mensal |
| OpenAI (Voice Agent) | ~US$0.08-0.25/sessao | Por uso |
| Dominio | US$10-15 | Anual |

## ROADMAP (7 fases)

### FASE 1 -- AGORA (Fev 2026)
Ramon:
- [x] Abrir LLC via Stripe Atlas
- [ ] Configurar lembretes fiscais no Atlas
- [ ] Explorar creditos Atlas (US$2.500 Stripe + descontos)

Agentes:
- [ ] Soltar AGENTE TRADUTOR (PROMPT-TRADUTOR.md)

Codigo pronto:
- [x] Stripe integrado (Payment Intents, Apple Pay, Google Pay, Link, Connect)
- [x] Mural com 9 agentes AI
- [x] Radio Touch com locutor IA
- [x] requireAuth em todos endpoints novos

### FASE 2 -- INCORPORACAO (1-7 Mar 2026)
Ramon:
- [ ] Abrir conta Mercury
- [ ] Ativar Stripe pagamentos
- [ ] Guardar dados: LLC number, registered agent, endereco Delaware

Agentes:
- [ ] TRADUTOR continua ingles
- [ ] Soltar AGENTE FINANCEIRO (PROMPT-FINANCEIRO.md)

### FASE 3 -- POS-INCORPORACAO (Mar 2026)
Ramon:
- [ ] Receber EIN (3-6 semanas)
- [ ] Configurar contabilidade no Atlas

Agentes:
- [ ] Soltar AGENTE FISCAL (PROMPT-FISCAL.md)
- [ ] FINANCEIRO: testar sandbox Stripe
- [ ] TRADUTOR: finalizar EN-US, comecar ES-LATAM

Documentos:
- [ ] Terms of Service em ingles
- [ ] Privacy Policy (CCPA)

### FASE 4 -- COMPLIANCE (Abr-Mai 2026)
- [ ] Registrar FinCEN MSB (Form 107, gratuito)
- [ ] Modelar precos USD
- [ ] Migrar sandbox -> producao Stripe

### FASE 5 -- SOFT LAUNCH (Mai-Jun 2026)
- [ ] Beta testers americanos
- [ ] Testar fluxo completo: signup -> sonic -> chat -> tip -> subscription
- [ ] Monitorar pagamentos reais
- [ ] Ajustar precos

### FASE 6 -- LANCAMENTO PUBLICO (Jun-Jul 2026)
- [ ] PWA (touch-irl.com) ou App Store / Google Play
- [ ] Marketing US
- [ ] Metricas: DAU, revenue, churn, conversion

### FASE 7 -- ESCALA (Jul+ 2026)
- [ ] Espanhol LATAM
- [ ] Japones
- [ ] Servidor dedicado US (latencia)
- [ ] Avaliar LLC -> C-Corp se buscar investimento

## AGENTES PREPARADOS

| Prompt | Arquivo | Para que |
|--------|---------|---------|
| Contexto geral | PROMPT-NOVO-CHAT.md | Qualquer agente novo |
| Traducao/i18n | PROMPT-TRADUTOR.md | Internacionalizar o app |
| Financeiro | PROMPT-FINANCEIRO.md | Stripe Connect + pagamentos US |
| Fiscal/Contabil | PROMPT-FISCAL.md | Compliance, impostos, conciliacao |

## DOCUMENTOS DE REFERENCIA

- AUDITORIA-TOUCH-2026.docx -- 30+ fixes de seguranca/performance
- PLANO-EMPRESA-USA.docx -- guia completo da abertura da LLC
