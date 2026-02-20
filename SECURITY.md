# 🔒 Touch? — Security Documentation

## Visão Geral

Este documento detalha todas as medidas de segurança implementadas no Touch?, incluindo proteções de backend, frontend, dados sensíveis, e práticas de desenvolvimento seguro.

---

## 1. Variáveis de Ambiente (Secrets Management)

### Variáveis Obrigatórias em Produção

| Variável | Descrição | Onde Configurar |
|----------|-----------|----------------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo da service account Firebase | Render → Environment |
| `FIREBASE_DATABASE_URL` | URL do Realtime Database | Render → Environment |
| `FIREBASE_API_KEY` | API Key do Firebase (pública, mas via env) | Render → Environment |
| `FIREBASE_AUTH_DOMAIN` | Auth domain do Firebase | Render → Environment |
| `FIREBASE_PROJECT_ID` | Project ID do Firebase | Render → Environment |
| `FIREBASE_STORAGE_BUCKET` | Storage bucket | Render → Environment |
| `FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID | Render → Environment |
| `FIREBASE_APP_ID` | App ID do Firebase | Render → Environment |
| `MP_ACCESS_TOKEN` | Access token do MercadoPago (SECRETO) | Render → Environment |
| `MP_PUBLIC_KEY` | Public key do MercadoPago | Render → Environment |
| `MP_WEBHOOK_SECRET` | Secret para validar webhooks do MP | Render → Environment |
| `MP_APP_ID` | App ID do MercadoPago | Render → Environment |
| `MP_CLIENT_SECRET` | Client secret do MercadoPago (SECRETO) | Render → Environment |
| `ADMIN_SECRET` | Secret para autenticação de endpoints admin | Render → Environment |
| `GMAIL_USER` | Email para envio de emails via SMTP | Render → Environment |
| `GMAIL_APP_PASSWORD` | App password do Gmail (SECRETO) | Render → Environment |

### Regras
- **NUNCA** commitar secrets no repositório Git
- Arquivo `.env` está no `.gitignore`
- Arquivo `firebase-sa.json` está no `.gitignore`
- Render armazena variáveis de ambiente de forma criptografada

---

## 2. Autenticação e Autorização

### Firebase Authentication
- Login via Google OAuth 2.0 e Email/Senha
- Tokens Firebase verificados via `admin.auth().verifyIdToken()`
- Middleware `verifyFirebaseToken` em todas as rotas (extrai user se token presente)

### Endpoints Admin
- Todos os endpoints `/api/admin/*` protegidos por middleware `requireAdmin`
- Autenticação por 3 métodos (em ordem de prioridade):
  1. Header `X-Admin-Secret` com valor igual a `ADMIN_SECRET`
  2. Firebase token + flag `isAdmin` no usuário do DB
  3. Fallback por `adminId`/`userId` no body (apenas se `ADMIN_SECRET` não está configurado — modo dev)
- Rate limit separado: 20 req/15min nos endpoints admin

### Endpoints Protegidos
| Endpoint | Proteção |
|----------|----------|
| `POST /api/admin/reset-db` | `requireAdmin` + confirmação `FULL_RESET_DANGEROUS` |
| `POST /api/admin/reset-events` | `requireAdmin` + confirmação `RESET_EVENTS` |
| `POST /api/admin/reset-reveals` | `requireAdmin` + confirmação `RESET_REVEALS` |
| `POST /api/admin/backup` | `requireAdmin` |
| `GET /api/admin/backups` | `requireAdmin` |
| `POST /api/admin/rollback` | `requireAdmin` + confirmação `ROLLBACK` |
| `POST /api/admin/game-config` | Rate limited + verificação admin/top1 |
| `POST /api/admin/verify` | Verificação `isAdmin` no body |
| `POST /api/admin/unverify` | Verificação `isAdmin` no body |

---

## 3. Rate Limiting

Implementado com `express-rate-limit`:

| Categoria | Limite | Janela | Endpoints |
|-----------|--------|--------|-----------|
| Geral | 300 req | 15 min | Todos os endpoints |
| Autenticação | 10 req | 15 min | `/api/auth/*` (login, magic link, password reset) |
| Pagamentos | 15 req | 5 min | `/api/tip/create`, `/api/tip/save-card`, `/api/subscription/*`, `pay-entry` |
| Admin | 20 req | 15 min | `/api/admin/*` |

### Respostas de Rate Limit
- Status HTTP 429 (Too Many Requests)
- Mensagem em português: "Muitas requisições. Tente novamente em alguns minutos."

---

## 4. Security Headers (Helmet)

### Headers Configurados
- **Content-Security-Policy (CSP)**: Restringe fontes de scripts, estilos, imagens, conexões
- **X-Content-Type-Options**: `nosniff`
- **X-Frame-Options**: `SAMEORIGIN`
- **X-XSS-Protection**: `1; mode=block`
- **Strict-Transport-Security**: HSTS habilitado
- **Referrer-Policy**: `no-referrer`
- **X-Permitted-Cross-Domain-Policies**: `none`

### CSP Detalhado
```
default-src: 'self'
script-src: 'self', 'unsafe-inline', 'unsafe-eval', sdk.mercadopago.com, mlstatic.com, google
style-src: 'self', 'unsafe-inline', fonts.googleapis.com
img-src: 'self', data:, blob:, storage.googleapis.com, googleusercontent.com
connect-src: 'self', api.mercadopago.com, firebase, wss:, ws:
frame-src: 'self', sdk.mercadopago.com, accounts.google.com
object-src: 'none'
```

---

## 5. CORS (Cross-Origin Resource Sharing)

### Socket.IO
- Origins permitidas: configurável via `ALLOWED_ORIGINS` env var
- Default: `encosta.onrender.com`, `localhost:3000`, `localhost:5500`
- Wildcard `*.onrender.com` para deploy previews
- Métodos: GET, POST apenas

### Express
- CORS não explícito (mesma origem via static files)
- API acessível apenas via mesmo domínio ou origins configuradas

---

## 6. Webhooks MercadoPago

### Verificação de Assinatura HMAC-SHA256
- Implementada em `verifyMPWebhookSignature()`
- Valida header `x-signature` usando `MP_WEBHOOK_SECRET`
- Formato: `ts={timestamp},v1={hmac}`
- Manifest: `id:{data.id};request-id:{x-request-id};ts:{ts};`
- Rejeita com HTTP 401 se assinatura inválida
- Logs de tentativas inválidas com IP

### Endpoints Protegidos
- `POST /mp/webhook` — notificações de pagamento
- `POST /mp/webhook/subscription` — notificações de assinatura

---

## 7. Proteção de Dados Sensíveis

### Dados em Repouso
- CPF: armazenado no Firebase RTDB (considerar criptografia futura)
- Tokens MP OAuth: armazenados no perfil do usuário (considerar vault futura)
- Fotos de perfil: armazenadas no Firebase Storage (público com URL longa)
- Selfies de verificação: dados faciais no Firebase RTDB

### Dados em Trânsito
- HTTPS obrigatório em produção (Render fornece SSL)
- Todas as chamadas externas via HTTPS
- Geolocalização via HTTPS (ipapi.co)

### Dados no Código
- Nenhum secret hardcoded no código-fonte
- Firebase config obtida via env vars → endpoint `/api/firebase-config`
- MP public key obtida via env var → endpoint `/api/mp-public-key`

---

## 8. Backup e Recuperação

### Sistema de Backup Automático
- Backup automático antes de QUALQUER operação de reset
- Armazenado em Firebase RTDB em `/backups/{timestamp}`
- Máximo de 5 backups mantidos (auto-cleanup)
- Fallback para arquivo local se Firebase falhar

### Endpoints
- `POST /api/admin/backup` — backup manual (protegido)
- `GET /api/admin/backups` — listar backups (protegido)
- `POST /api/admin/rollback` — restaurar backup (protegido + confirmação)

### Operações de Reset
- `reset-events` (SEGURO): remove apenas eventos/checkins, preserva relações
- `reset-db` (PERIGOSO): requer confirmação `FULL_RESET_DANGEROUS`

---

## 9. Validação de Input

### Funções de Sanitização
- `sanitizeStr(s, maxLen)` — remove `<>`, trim, limita tamanho
- `isValidEmail(e)` — regex de email + limite 254 chars
- `isValidCPF(cpf)` — verifica 11 dígitos numéricos
- `isValidUUID(id)` — formato alfanumérico 8-64 chars

### Validações em Endpoints
- Tamanho de foto: máx 2MB
- Tamanho de JSON body: máx 5MB
- Campos obrigatórios verificados antes de processamento

---

## 10. Proteção contra Crashes

### Handlers Globais
```javascript
process.on('uncaughtException', ...)
process.on('unhandledRejection', ...)
```
- Servidor não morre em erros não tratados
- Erros logados com stack trace parcial

### Timeouts
- `withTimeout()` wrapper para todas as operações Firebase
- Timeout padrão: 15s para leitura, 20s para escrita
- Previne travamento por conexão perdida

---

## 11. Checklist de Deploy Seguro

### Antes de Cada Deploy
- [ ] Verificar que `.env` e `firebase-sa.json` estão no `.gitignore`
- [ ] Verificar que não há secrets hardcoded no código
- [ ] Rodar `node -c server.js` para verificar sintaxe
- [ ] Confirmar que `ADMIN_SECRET` está configurado no Render
- [ ] Confirmar que `MP_WEBHOOK_SECRET` está configurado

### Variáveis de Ambiente Obrigatórias no Render
```
ADMIN_SECRET=<gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
MP_WEBHOOK_SECRET=<obter do painel MercadoPago>
FIREBASE_SERVICE_ACCOUNT=<JSON da service account>
MP_ACCESS_TOKEN=<token de produção do MP>
```

### Após Deploy
- [ ] Verificar que endpoints admin retornam 403 sem auth
- [ ] Verificar que webhook rejeita requests sem assinatura
- [ ] Verificar que rate limiter bloqueia excesso de requests
- [ ] Criar backup manual via `POST /api/admin/backup`

---

## 12. Vulnerabilidades Conhecidas e Mitigações Futuras

### Para v1.1+
1. **Criptografia de CPF em repouso** — usar AES-256-GCM com chave de env var
2. **Criptografia de tokens MP OAuth** — armazenar em vault ou encriptar
3. **CSRF tokens** — adicionar para formulários que alteram estado
4. **Ambiente de homologação** — staging separado antes de prod
5. **DOMPurify no frontend** — sanitização mais robusta de HTML dinâmico
6. **Event delegation** — refatorar inline event handlers para event listeners
7. **Audit logging** — log de request-id para rastreabilidade completa
8. **HttpOnly cookies** — considerar para sessão (atualmente usa Firebase tokens)

---

## 13. Contato de Segurança

Para reportar vulnerabilidades, entre em contato com o administrador do sistema.

---

*Última atualização: Fevereiro 2026*
*Versão: 1.0-security*
