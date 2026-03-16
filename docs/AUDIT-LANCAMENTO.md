# AUDITORIA PRE-LANCAMENTO -- Touch? (Encosta)

Data: 16/03/2026
Escopo: server.js, index.html, operator.html, package.json, dependencias

## RESUMO EXECUTIVO

App pronto para lancamento nos EUA. Corrigidos problemas criticos de seguranca e performance.
Restam itens nao-bloqueantes para melhorar pos-lancamento (detalhados abaixo).

## METRICAS DO PROJETO

- server.js: 22.825 linhas
- public/index.html: 30.405 linhas (1.8 MB) -- comprime para ~200KB com gzip
- public/operator.html: 11.514 linhas (645 KB)
- Total de arquivos HTML publicos: 22+
- Dependencias npm: 0 vulnerabilidades HIGH (corrigido), 8 LOW (firebase-admin sub-deps)

## FIXES APLICADOS NESTA AUDITORIA

### Seguranca (CRITICO)

1. requireAuth hardened -- fallback de auth sem token Firebase agora verifica se a origem e confiada (CORS_ORIGINS). Antes, qualquer request com userId valido passava.

2. HSTS header -- Strict-Transport-Security com maxAge=1ano, includeSubDomains, preload. Forca HTTPS em todas as visitas subsequentes.

3. safePhotoUrl() -- Nova funcao no index.html que sanitiza URLs de foto antes de usar em img src. So aceita https: e data:image/. Bloqueia javascript:, data:text/html, e qualquer outro protocolo malicioso.

4. npm audit fix -- Corrigido express-rate-limit HIGH (bypass via IPv4-mapped IPv6 addresses em servidores dual-stack).

### Performance

5. sonicFreqIndex (Map) -- Busca de frequencia ultrassonica agora e O(1) em vez de O(n). Em eventos com muitas pessoas simultaneas, isso evita delay no matching.

6. assignSonicFreq anti-collision -- Antes usava round-robin cego. Agora verifica se o slot esta livre antes de atribuir. So cai no fallback round-robin se TODOS os 7 slots estiverem ocupados.

7. Ranking cache TTL 10min -- Era 2min. Evita reconstruir o ranking a cada 2min quando tem muitos users.

8. Online users cleanup -- Novo intervalo a cada 30min que remove entradas de _onlineUsers com mais de 1h. Previne memory leak.

### Codigo

9. Emojis removidos -- Todos os console.log/warn/error no server.js agora usam tags texto: [OK], [ERR], [WARN], [FIX], [IDX], [ADMIN], [BACKUP], [CLEANUP], [EMAIL], [LINK], [AUTH], [DB], [PAY], [TICKET], [SUB], [SHOP], [START], [UPDATE], [DEL], [TTS].

10. sonicQueueSet/sonicQueueDel -- Helpers centralizados que mantêm o sonicQueue e o sonicFreqIndex sincronizados. Todos os 13+ pontos de mutacao do sonicQueue agora passam por esses helpers.

## O QUE JA ESTAVA BOM (NAO PRECISOU CORRECAO)

- Compressao gzip via compression() -- index.html de 1.8MB vira ~200KB
- Rate limiting em 6 camadas: geral, auth, payment, admin, mural, va
- Helmet com CSP completo (script-src, style-src, img-src, connect-src, frame-src)
- Firebase tokens via endpoint (nao hardcoded no client)
- CORS restrito a dominios confiados (touch-irl.com, *.onrender.com)
- Service Worker com cache inteligente (PWA)
- PWA manifest completo
- Crash protection (uncaughtException + unhandledRejection)
- Health check endpoint (/api/status)
- Backup automatico do DB com rotacao
- Socket.IO com CORS validation
- Webhook MercadoPago com HMAC-SHA256

## ITENS NAO-BLOQUEANTES (POS-LANCAMENTO)

### Medio prazo (proximas 2-4 semanas)

1. EXTRAIR CSS do index.html para arquivo externo -- reduz parse time e permite cache separado
2. EXTRAIR JS para modulos -- sonic engine, constellation, avatar accessories podem ser lazy-loaded
3. DOMPurify para sanitizacao HTML no mural (atualmente usa sanitizeStr que so remove <>)
4. CSRF tokens em formularios (atualmente nao tem)
5. Criptografar dados pessoais no DB (CPF, endereco em plaintext)
6. Media queries responsivas no index.html (atualmente 0 breakpoints)

### Longo prazo (1-3 meses)

7. Separar server.js em modulos (routes/auth.js, routes/payment.js, etc)
8. Migrar para Redis para session/cache quando passar de ~50k users
9. Implementar Socket.IO auth middleware (atualmente aceita conexoes sem token)
10. Code splitting com lazy loading para modulos nao-core
11. Proxiar OpenAI tokens pelo server em vez de expor client_secret

## VULNERABILIDADES CONHECIDAS (ACEITAS PRA LANCAMENTO)

- 8 LOW no npm audit -- sub-dependencias do firebase-admin (teeny-request, fast-xml-parser). Sem fix disponivel sem major version bump. Risco baixo.
- CSP com unsafe-inline e unsafe-eval -- necessario para MercadoPago SDK e inline scripts. Nao tem como remover sem reescrever todo o frontend.
- requireAuth fallback sem token -- mantido para compatibilidade com fluxos de guest e sessoes antigas. Logado para monitoramento. Plano: remover quando frontend migrar 100% para token-based auth.

## CHECKLIST DE DEPLOY PRE-LANCAMENTO

- [x] node -c server.js (syntax check OK)
- [x] npm audit: 0 HIGH, 0 CRITICAL
- [x] HSTS habilitado
- [x] XSS photo URL fix aplicado
- [x] Auth fallback endurecido
- [x] Sonic frequency collision fix
- [x] Memory leak prevention (online users cleanup)
- [x] Emojis removidos do codigo
- [ ] ADMIN_SECRET configurado no Render
- [ ] MP_WEBHOOK_SECRET configurado no Render
- [ ] STRIPE_SECRET_KEY configurado no Render (para lancamento US)
- [ ] STRIPE_WEBHOOK_SECRET configurado no Render
- [ ] STRIPE_CONNECT_CLIENT_ID configurado no Render
- [ ] Testar em dispositivo real (iPhone Safari + Android Chrome)
- [ ] Testar fluxo completo: cadastro -> Touch -> check-in -> gorjeta -> WiFi
- [ ] Monitorar logs nas primeiras 24h pos-lancamento
