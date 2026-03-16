# PENDENCIAS E TESTES -- Touch?

Atualizado: 16/03/2026

## ALTA PRIORIDADE

### 1. Voice Agent (Plus, Pro, UltimateDEV)
- [ ] Revisar instrucoes, personalidade e tools de cada tier
- [ ] Testar fluxo completo de cada um em dispositivo real
- [ ] Verificar prompts alinhados com visao do produto
- [ ] UltimateDEV: primeiro teste real pelo usuario PENDENTE

### 2. UltimateDEV -> Claude
- TESTADO VIA CHROME: ping OK, comando->plano OK, aprovacao->codigo OK, git commit OK, git push OK
- PROBLEMA CONHECIDO: devQueue em RAM, perde comandos no redeploy
- RESTRICOES: contexto 400 linhas/arquivo, nao cria arquivos novos

### 3. TouchGames
- [ ] Testar fluxo completo end-to-end: lobby -> convite -> chat -> aceitar -> ready -> jogar
- [ ] Ready-check modal pode ter problemas de timing entre jogadores
- [ ] Game-start recarrega iframe (timing sensivel)

### 4. Camera/Screen no UltimateDEV
- Implementado mas NAO testado em sessao real

### 5. Seguranca -- vulnerabilidades criticas
- [ ] C1: Webhook MP sem verificacao quando secret ausente
- [ ] C2: Admin secret em sessionStorage
- [ ] C3: OpenAI token exposto no frontend
- [ ] C4: Endpoints admin com fallback inseguro
- [ ] C5: Account takeover via link de conta
- Ver docs/SEGURANCA.md para lista completa

## MEDIA PRIORIDADE

### 6. Escriba system
- Implementado, auto-flush 2min, nao testado em sessao real

### 7. Stripe pagamentos
- IMPLEMENTADO no codigo, precisa testar fluxo completo em producao
- Chaves de API pendentes de verificacao no Render:
  - [ ] STRIPE_SECRET_KEY
  - [ ] STRIPE_PUBLIC_KEY
  - [ ] STRIPE_WEBHOOK_SECRET
  - [ ] STRIPE_CONNECT_CLIENT_ID

### 8. Mural + Radio
- IMPLEMENTADO, precisa monitorar performance com muitos usuarios

### 9. Apple Developer Account
- Ramon pagou $99 mas caiu em conta antiga (Super Startup / Herson Leite)
- Opcoes: criar conta nova, pedir reembolso, ou pedir transferencia
- Necessario para Apple Pay nativo no Stripe

### 10. Stripe Webhook
- [ ] Configurar URL: https://touch-irl.com/api/stripe/webhook
- [ ] Eventos: payment_intent.succeeded, checkout.session.completed, account.updated

### 14. Precos regionais -- testar em producao
- [x] Sistema implementado (PRICING centralizado, deteccao de regiao, admin panel)
- [ ] Testar deteccao de regiao com usuario real nos EUA
- [ ] Testar se admin panel salva/carrega precos corretamente no Firebase
- [ ] Verificar formatPrice() em todas as telas (index, operator, partners)

### 15. Partners page -- testar integracao
- [x] Pagina criada com 3 idiomas (EN/PT/ES) e CTAs
- [ ] Testar Stripe Connect onboarding flow end-to-end
- [ ] Testar redirect de /partners?uid=xxx pro onboarding
- [ ] Verificar se MP OAuth redirect funciona em producao

### 16. Reembolsos -- testar em producao
- [x] Endpoints implementados (admin, operador, usuario)
- [ ] Testar refund via Stripe em transacao real
- [ ] Testar janela de 24h para auto-refund do usuario
- [ ] Verificar webhook de charge.refunded

### 17. Entidade brasileira (MEI/ME)
- [ ] Abrir entidade brasileira para operar MercadoPago
- [ ] Contrato intercompany com LLC (royalties)
- [ ] Configurar MP com CNPJ da entidade brasileira

## BAIXA PRIORIDADE

### 11. Convite via sonic touch no lobby
- Encostar em alguem = convite de jogo

### 12. Checkout de assinaturas
- Atualizar design com novo visual

### 13. i18n UI strings
- Frases poeticas traduzidas, UI labels ainda hardcoded em PT-BR
- Ver docs/I18N.md

## TESTES AUTOMATICOS

- test.js: 20 testes estaticos, 18 PASS, 2 UNCERTAIN, 0 FAIL
- Syntax check: node -c server.js PASSA

## ROLLBACK RAPIDO

Se algo quebrar, voltar para commits estaveis:
- ANTES do requireAuth fix: git reset --hard 5dfbb02
- ANTES do DEV Monitor + otimizacao: git reset --hard 703fc78
- ANTES do tema branco UltimateDEV: git reset --hard 25fb5c6
- ANTES do 3-tier VA: git reset --hard ca25ac5
- ANTES do voice agent inteiro: git reset --hard 1ffc98f

Apos rollback: git push --force origin main (CUIDADO: sobrescreve GitHub)
