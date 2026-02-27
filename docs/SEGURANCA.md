# SEGURANCA -- Touch? (Encosta)

Consolidacao de todas as auditorias realizadas ate 27/02/2026.

## AUDITORIAS REALIZADAS

1. SECURITY.md (Fev 2026) -- documentacao de seguranca original
2. SECURITY-AUDIT-2026-02-26.md -- 15 vulnerabilidades frontend (index.html)
3. SECURITY-AGENT-REPORT.md -- 29 vulnerabilidades full-stack
4. AUDIT-INDEX-HTML-2026-02-27.md -- auditoria de integridade do index.html
5. AUDITORIA-TOUCH-2026.docx -- 30+ fixes de performance e seguranca

## VULNERABILIDADES CRITICAS (5)

C1. Webhook MP aceita requests sem assinatura quando MP_WEBHOOK_SECRET nao configurado
C2. Admin secret armazenado em sessionStorage (acessivel via XSS)
C3. OpenAI client_secret exposto no frontend (DevTools)
C4. Endpoints admin sem autenticacao consistente (fallback inseguro para isAdmin)
C5. Account takeover via link de conta Firebase (unifica sem verificar email)

## VULNERABILIDADES ALTAS (8)

A1. IDOR em endpoints de dados do usuario (userId do body sem ownership check)
A2. Manipulacao de valor em gorjetas (servidor confia no cliente)
A3. Race condition em assinatura (marca subscriber antes do webhook)
A4. XSS no Mural (sanitizeStr so remove <>)
A5. WebRTC data channels sem validacao de tipo/formato
A6. Dados de pagamento em plaintext (CPF/email no POST body)
A7. Firebase config exposto sem auth (/api/firebase-config)
A8. Inline event handlers com dados nao escapados (onerror no avatar)

## VULNERABILIDADES MEDIAS (10)

M1. Socket.IO sem autenticacao em varios eventos
M2. Stripe webhook com verificacao incompleta
M3. Rate limiting ausente em endpoints sensiveis
M4. Endereco fisico armazenado sem criptografia
M5. Permissoes no frontend (bypassavel via localStorage)
M6. Sem protecao CSRF
M7. Obfuscacao fraca no localStorage (Base64, nao e criptografia)
M8. Sem validacao de tamanho em mensagens de chat
M9. UltimateDEV -- escalacao de privilegio possivel (admin IDs hardcoded)
M10. Divulgacao de info via endereco de presentes

## VULNERABILIDADES BAIXAS (6)

B1. Validacao insuficiente em campos de perfil
B2. CSP com unsafe-inline e unsafe-eval (necessario para MercadoPago SDK)
B3. Paginas admin/operador sem role check no frontend
B4. Sem rate limiting client-side
B5. CORS permite qualquer subdominio .onrender.com
B6. Logs de console com dados sensiveis

## FIXES JA APLICADOS

- [x] requireAuth em TODOS os endpoints Stripe (5 endpoints) -- 27/02
- [x] requireAuth em TODOS os endpoints Radio (2 endpoints) -- 27/02
- [x] requireAuth em TODOS os endpoints Games (4 endpoints) -- 27/02
- [x] lsSet/lsGet com obfuscacao para dados sensiveis no localStorage
- [x] Toast FIFO queue (evita sobreposicao)
- [x] Canvas throttle 24fps (performance)
- [x] Helmet security headers (CSP, HSTS, X-Frame-Options, etc)
- [x] Rate limiting (geral 300/15min, auth 10/15min, pagamentos 15/5min, admin 20/15min)
- [x] Webhook MercadoPago com HMAC-SHA256
- [x] sanitizeStr() para inputs
- [x] withTimeout() para operacoes Firebase
- [x] uncaughtException e unhandledRejection handlers

## PRIORIDADE DE CORRECAO

### Imediato (24h):
1. Nunca pular verificacao de webhook quando secret ausente (C1)
2. Remover admin secret do sessionStorage (C2)
3. Proxiar OpenAI tokens pelo server (C3)

### Esta semana:
4. Exigir ADMIN_SECRET em todos endpoints admin (C4)
5. Verificacao de email antes de linkar contas (C5)
6. Ownership check em endpoints de usuario (A1)
7. Verificar valor via API do MP antes de registrar gorjeta (A2)

### Proximas 2 semanas:
8. DOMPurify para sanitizacao HTML (A4)
9. CSRF tokens (M6)
10. Criptografar dados pessoais (M4)

## COMPLIANCE

### PCI-DSS: violacoes 2.1 (chaves expostas), 3.2 (plaintext), 6.5.1 (injecao)
### OWASP Top 10: A01 (Broken Access), A02 (Crypto Failures), A03 (Injection), A07 (XSS)
### LGPD: dados pessoais sem criptografia, CPF em plaintext, falta consent management

## CHECKLIST DE DEPLOY

- [ ] .env e firebase-sa.json no .gitignore
- [ ] Sem secrets hardcoded
- [ ] node -c server.js (syntax check)
- [ ] ADMIN_SECRET configurado no Render
- [ ] MP_WEBHOOK_SECRET configurado
- [ ] Endpoints admin retornam 403 sem auth
- [ ] Webhook rejeita requests sem assinatura
- [ ] Rate limiter bloqueia excesso
