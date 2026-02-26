# SECURITY AGENT REPORT -- Touch? (Encosta)

**Data:** 26 de Fevereiro de 2026
**Agente:** Claude Opus 4.6 -- Security Specialist
**Escopo:** Auditoria completa de seguranca (server.js + frontend + infra)
**Status:** LEVANTAMENTO COMPLETO -- ACAO NECESSARIA

---

## RESUMO EXECUTIVO

Auditoria de seguranca completa do app Touch? cobrindo backend (server.js ~11.400 linhas),
frontend (index.html ~16.200 linhas + admin/operator/va-admin/va-test), infra (Render + Firebase + Cloudflare)
e integracoes (MercadoPago, Stripe, OpenAI, Anthropic).

**Resultado: 29 vulnerabilidades identificadas**

| Severidade | Quantidade | Descricao |
|------------|-----------|-----------|
| CRITICA    | 5         | Fraude de pagamento, takeover de conta, exposicao de secrets |
| ALTA       | 8         | IDOR, XSS, race conditions, tokens expostos |
| MEDIA      | 10        | Socket sem auth, rate limiting incompleto, CSRF |
| BAIXA      | 6         | Validacao de input, configuracoes subotimas |

---

## VULNERABILIDADES CRITICAS (CORRIGIR IMEDIATAMENTE)

### C1. Webhook do MercadoPago aceita requests sem assinatura
- **Onde:** server.js, funcao verifyMPWebhookSignature (~linha 6727)
- **Problema:** Se MP_WEBHOOK_SECRET nao esta configurado, a funcao retorna `true` -- aceita qualquer request como webhook valido.
- **Impacto:** Atacante pode fabricar webhooks fingindo pagamentos aprovados. Gorjetas falsas, assinaturas Plus gratis, entrada em eventos sem pagar.
- **Correcao:** NUNCA pular verificacao. Se secret nao existe, rejeitar com 401. Adicionar verificacao secundaria via API do MercadoPago.

### C2. Admin secret armazenado no sessionStorage do navegador
- **Onde:** admin.html (~linhas 524-545)
- **Problema:** O ADMIN_SECRET e guardado em sessionStorage, acessivel via JavaScript. Qualquer XSS no app pode roubar o secret.
- **Impacto:** Acesso administrativo completo -- reset de usuarios, acesso financeiro, modificacao de eventos.
- **Correcao:** Usar httpOnly cookies com sessao server-side. Nunca armazenar secrets no browser.

### C3. OpenAI client_secret exposto no frontend
- **Onde:** index.html (~linhas 14961, 15040, 16189, 16221)
- **Problema:** Token da OpenAI Realtime API (client_secret) e buscado do server e colocado diretamente no JavaScript do frontend. Visivel no DevTools.
- **Impacto:** Roubo do token permite uso da API da OpenAI na conta do Touch?, gerando custos financeiros.
- **Correcao:** Usar proxy server-side para todas as chamadas. O frontend nunca deve ver o token.

### C4. Endpoints admin sem autenticacao consistente
- **Onde:** server.js (~linhas 4482-5700)
- **Problema:** Varios endpoints admin checam ADMIN_SECRET OU isAdmin no banco. Se ADMIN_SECRET nao esta configurado, a unica barreira e o flag isAdmin que pode ser manipulado.
- **Endpoints vulneraveis:** /api/admin/verify, /api/admin/unverify, /api/admin/grant-plus, /api/admin/verify-event
- **Correcao:** Exigir ADMIN_SECRET em TODOS os endpoints admin. Remover fallback para isAdmin.

### C5. Account takeover via link de conta Firebase
- **Onde:** server.js (~linhas 1050-1207)
- **Problema:** O endpoint de link de conta unifica contas baseado em email/telefone/nome. Atacante pode criar conta Firebase com o email de outra pessoa e tomar a conta.
- **Correcao:** Exigir verificacao de email antes de linkar. Enviar codigo de confirmacao. Nunca unificar automaticamente.

---

## VULNERABILIDADES ALTAS (CORRIGIR ESTA SEMANA)

### A1. IDOR em endpoints de dados do usuario
- **Onde:** server.js (~linhas 2124-3238)
- **Problema:** Endpoints como /api/user/timezone, /api/user/:userId/lang aceitam userId do body/params sem verificar se o usuario autenticado e o dono.
- **Impacto:** Atacante pode modificar timezone, idioma, pais de qualquer usuario.
- **Correcao:** Verificar que userId === req.authUserId em toda operacao de update.

### A2. Manipulacao de valor em gorjetas
- **Onde:** server.js (~linhas 6248-6280)
- **Problema:** O servidor confia no valor enviado pelo cliente. Nao verifica com o MercadoPago se o valor realmente cobrado bate.
- **Impacto:** Pagar R$1 e registrar gorjeta de R$500.
- **Correcao:** Consultar API do MercadoPago para confirmar valor real antes de registrar.

### A3. Race condition no pagamento de assinatura
- **Onde:** server.js (~linhas 6248-6350)
- **Problema:** Servidor marca user.isSubscriber = true ANTES do webhook confirmar o pagamento.
- **Impacto:** Usuario ganha acesso Plus sem pagar (janela entre inicio do pagamento e cancelamento).
- **Correcao:** Usar status intermediario "pending" ate webhook confirmar approved.

### A4. XSS no Mural (sanitizacao fraca)
- **Onde:** server.js funcao sanitizeStr (~linha 160) + index.html funcao esc (~linha 11868)
- **Problema:** sanitizeStr so remove `<>`. A funcao esc no frontend usa textContent/innerHTML que nao cobre todos os vetores.
- **Impacto:** Injecao de scripts via posts no mural, roubo de sessao.
- **Correcao:** Usar DOMPurify no frontend. No backend, usar biblioteca de sanitizacao HTML.

### A5. WebRTC data channels sem validacao
- **Onde:** index.html (~linhas 14826-16221)
- **Problema:** Dados do WebRTC data channel sao processados sem validacao de tipo ou formato.
- **Impacto:** Injecao de dados maliciosos via data channel.
- **Correcao:** Validar e tipar todos os dados recebidos via data channel.

### A6. Dados de pagamento em plaintext
- **Onde:** index.html (~linhas 13200-13270)
- **Problema:** CPF e email enviados em plaintext no body de requests POST.
- **Impacto:** Violacao PCI-DSS. Dados pessoais expostos em logs.
- **Correcao:** Nunca logar dados pessoais. Implementar tokenizacao.

### A7. Firebase config exposto sem auth
- **Onde:** server.js (~linha 966)
- **Problema:** /api/firebase-config retorna todas as credenciais Firebase sem autenticacao.
- **Impacto:** Permite enumeracao de contas e acesso direto ao Firebase.
- **Correcao:** Servir config apenas apos autenticacao. Reforcar Firebase Security Rules.

### A8. Inline event handlers com dados nao escapados
- **Onde:** index.html (~linhas 5876, 5885)
- **Problema:** Atributos onerror com dados de usuario nao sanitizados.
- **Impacto:** XSS baseado em DOM via avatar/foto do usuario.
- **Correcao:** Usar addEventListener em vez de atributos inline.

---

## VULNERABILIDADES MEDIAS (CORRIGIR EM 2 SEMANAS)

### M1. Socket.IO sem autenticacao em varios eventos
- **Onde:** server.js (~linhas 5700-6136)
- **Endpoints:** sonic-set-staff-role, join-mural, sonic-stop
- **Problema:** Eventos nao verificam identidade do socket.

### M2. Stripe webhook com verificacao incompleta
- **Onde:** server.js (~linha 11169)
- **Problema:** Quando assinatura e invalida, apenas loga warning em vez de rejeitar.

### M3. Rate limiting ausente em endpoints sensiveis
- **Onde:** server.js -- /api/admin/verify, /api/star/donate, /api/declaration/send
- **Problema:** Sem rate limiter, permite brute force e spam.

### M4. Endereco fisico armazenado sem criptografia
- **Onde:** server.js (~linha 3103)
- **Problema:** Endereco real de usuarios anonimos armazenado em texto puro.

### M5. Checagem de permissao no frontend (bypassavel)
- **Onde:** index.html -- localStorage para flags de permissao
- **Problema:** Qualquer usuario pode modificar localStorage.

### M6. Sem protecao CSRF
- **Onde:** Todos os POST endpoints
- **Problema:** Requests POST nao exigem token CSRF.

### M7. Obfuscacao fraca no localStorage
- **Onde:** index.html -- dados em Base64
- **Problema:** Base64 nao e criptografia. Dados facilmente decodificados.

### M8. Sem validacao de tamanho em mensagens de chat
- **Onde:** Socket.IO message handlers
- **Problema:** Sem limite de tamanho, permite flooding.

### M9. UltimateDEV -- escalacao de privilegio possivel
- **Onde:** server.js (~linhas 7984-8705)
- **Problema:** Admin IDs hardcoded. Se banco comprometido, isAdmin=true da acesso a geracao de codigo.

### M10. Divulgacao de info via endereco de presentes
- **Onde:** server.js (~linha 3103)
- **Problema:** Privacidade do usuario comprometida se presentes vazam.

---

## VULNERABILIDADES BAIXAS

### B1. Validacao insuficiente em campos de perfil (handles sociais sem formato)
### B2. CSP com unsafe-inline e unsafe-eval (necessario para MercadoPago SDK)
### B3. Paginas de admin/operador sem verificacao de role no frontend
### B4. Sem rate limiting client-side
### B5. CORS permite qualquer subdominio .onrender.com
### B6. Logs de console com dados potencialmente sensiveis

---

## MAPA DE RISCO POR FUNCIONALIDADE

| Funcionalidade | Risco | Vulnerabilidades |
|----------------|-------|-----------------|
| Pagamentos (MP/Stripe) | CRITICO | C1, A2, A3, M2 |
| Admin Panel | CRITICO | C2, C4, M3 |
| Autenticacao | CRITICO | C5, A1, A7 |
| Voice Agent | ALTO | C3, M9 |
| Chat/Mural | ALTO | A4, A8, M8 |
| WebRTC | ALTO | A5, C3 |
| Dados pessoais | ALTO | A6, M4, M10 |
| Socket.IO | MEDIO | M1, M5 |
| CSRF/Session | MEDIO | M6, M7 |

---

## RECOMENDACOES POR PRIORIDADE

### HOJE (24 horas)
1. Configurar MP_WEBHOOK_SECRET e NUNCA pular verificacao (C1)
2. Remover admin secret do sessionStorage -- usar httpOnly cookies (C2)
3. Proxiar OpenAI tokens pelo server -- nunca expor no frontend (C3)
4. Exigir ADMIN_SECRET em todos endpoints admin (C4)

### ESTA SEMANA
5. Corrigir link de conta para exigir verificacao de email (C5)
6. Adicionar checagem de ownership (userId === authUserId) em todos endpoints (A1)
7. Verificar valor de pagamento via API do MP antes de registrar (A2)
8. Usar status "pending" ate webhook confirmar pagamento (A3)
9. Implementar DOMPurify para sanitizacao de HTML (A4)

### PROXIMAS 2 SEMANAS
10. Adicionar autenticacao em todos eventos Socket.IO (M1)
11. Implementar CSRF tokens (M6)
12. Rate limiting em endpoints sensiveis faltantes (M3)
13. Criptografar dados pessoais armazenados (M4)
14. Validar dados do data channel WebRTC (A5)

### PROXIMO MES
15. Auditoria PCI-DSS completa
16. Penetration test externo
17. Implementar monitoring de seguranca (alertas)
18. Revisar Firebase Security Rules

---

## ESTIMATIVA DE ESFORCO

| Categoria | Horas estimadas |
|-----------|----------------|
| Correcoes CRITICAS | 20-24h |
| Correcoes ALTAS | 20-27h |
| Correcoes MEDIAS | 12-15h |
| Correcoes BAIXAS | 6-8h |
| Testes e validacao | 16-20h |
| **TOTAL** | **~75-95h (2-2.5 semanas)** |

---

## COMPLIANCE

### PCI-DSS (pagamentos)
- Requisito 2.1 violado: chaves expostas
- Requisito 3.2 violado: credenciais em plaintext
- Requisito 6.5.1 violado: sem prevencao de injecao

### OWASP Top 10
- A01:2021 -- Broken Access Control (C4, C5, A1, M1)
- A02:2021 -- Cryptographic Failures (C2, C3, M4, M7)
- A03:2021 -- Injection (A4, A5, A8)
- A07:2021 -- Cross-Site Scripting (A4, A8)
- A08:2021 -- Software and Data Integrity Failures (C1, M2)

### LGPD (Brasil)
- Dados pessoais sem criptografia (M4)
- CPF em plaintext (A6)
- Falta de consent management explicitao

---

## NOTA SOBRE A AUDITORIA ANTERIOR

A auditoria de fevereiro 2026 (AUDITORIA-TOUCH-2026.docx) focou em performance e preparacao para escala.
Esta auditoria e complementar, focando exclusivamente em seguranca. As duas juntas cobrem o panorama completo.

---

## PROXIMOS PASSOS

Este relatorio serve como base para o **trabalho completo de levantamento de oportunidades** mencionado.
Quando formos implementar os fixes, a ordem de prioridade e:

1. Fixes CRITICOS (proteger pagamentos e admin) -- URGENTE
2. Fixes ALTOS (proteger dados e prevenir XSS) -- IMPORTANTE
3. Fixes MEDIOS (hardening geral) -- RECOMENDADO
4. Revisao de compliance (PCI-DSS, LGPD) -- ESTRATEGICO

Estou pronto para comecar a implementar qualquer correcao quando voce quiser.

---

*Gerado por Claude Opus 4.6 -- Security Specialist Agent*
*Touch? (Encosta) -- Auditoria de Seguranca 2026*
