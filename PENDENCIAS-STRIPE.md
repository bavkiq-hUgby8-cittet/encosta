# PENDENCIAS - Stripe + Apple Pay (salvo 23/02/2026)

## STATUS: Codigo pronto, falta configurar chaves

### 1. STRIPE - Pegar chaves de API (URGENTE)
- Entrar no Stripe Dashboard (dashboard.stripe.com)
- Desenvolvedores -> Chaves da API
- Copiar: Chave publicavel (pk_test_...) e Chave secreta (sk_test_...)
- Conta Stripe: acct_1T3p5YIPm2JJbBVR (modo Teste, nome "Touch IRL")

### 2. STRIPE - Configurar Webhook
- Desenvolvedores -> Webhooks -> Adicionar endpoint
- URL: https://touch-irl.com/api/stripe/webhook
- Eventos para escutar:
  - payment_intent.succeeded
  - checkout.session.completed
  - account.updated
- Copiar o Webhook Secret (whsec_...) que o Stripe gera

### 3. RENDER - Configurar variaveis de ambiente
- No Render (render.com), ir no servico encosta -> Environment
- Adicionar:
  - STRIPE_SECRET_KEY = sk_test_... (do passo 1)
  - STRIPE_PUBLIC_KEY = pk_test_... (do passo 1)
  - STRIPE_WEBHOOK_SECRET = whsec_... (do passo 2)
- Salvar e redeploy

### 4. APPLE DEVELOPER - Resolver conta
- Ramon pagou $99 mas caiu numa conta antiga (Super Startup / Herson Leite)
- Essa conta esta expirada e nao e do Ramon
- OPCOES:
  - A) Criar conta Apple Developer NOVA no nome do Ramon (recomendado)
  - B) Pedir reembolso dos $99 da conta antiga e criar nova
  - C) Pedir pro Herson transferir/renovar
- Depois de ter conta ativa:
  - Criar Merchant ID (merchant.com.touchirl)
  - Gerar Apple Pay Certificate
  - Upload no Stripe (Settings -> Payment Methods -> Apple Pay)
  - Verificar dominio touch-irl.com

### 5. OUTRAS PENDENCIAS
- Atualizar PROMPT-NOVO-CHAT.md com commits novos de pagamento
- Testar redirect encosta.onrender.com -> touch-irl.com
- Testar fluxo do jogo no mobile (end-to-end)

## O QUE JA FOI FEITO (nesta sessao 23/02/2026)
- Stripe Payment Element integrado (cartao + Link + Apple Pay + Google Pay)
- Stripe Checkout Sessions para assinaturas
- Stripe Connect para prestadores (pagamentos internacionais)
- Stripe Webhook com verificacao de assinatura
- PIX para eventos (endpoint novo)
- PIX para assinaturas (endpoint novo, ativa 30 dias)
- Checkout Pro MP para eventos (endpoint novo)
- Middleware condicional (raw body para webhook Stripe)
- Tudo commitado e pushado no GitHub
