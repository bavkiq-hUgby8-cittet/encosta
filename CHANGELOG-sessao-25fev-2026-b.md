# CHANGELOG - Sessao 25/02/2026 (parte B)

## Resumo

Sessao focada em diagnosticar e corrigir a integracao UltimateDEV com Claude (Anthropic).
O Dev Log "Ao vivo" nunca mostrava nada, e o servidor nunca respondia aos comandos dev.

---

## Commits desta sessao

### 361dca9 - fix: bug critico de escopo no Dev Log
**Problema:** `_devLiveLog` estava declarado com `let` dentro do IIFE do Voice Agent,
mas `renderDevLog()` era uma funcao global que tentava ler essa variavel. Como `let` cria
escopo local, a funcao global recebia `ReferenceError` silencioso e o painel ficava vazio.

**Correcao:**
- Moveu `_devLiveLog` para escopo global (`var`) junto com `_devLogData` e `_devLogCurrentFilter`
- Removeu a declaracao `let _devLiveLog = [];` duplicada dentro do IIFE
- Usou `window._devLiveLog` explicitamente dentro do IIFE para clareza
- Adicionou protecao em `renderDevLog()` caso `_devLiveLog` nao exista
- Adicionou console.logs estrategicos: `[VA]`, `[DEV-LOG]` para debug

### cf1ccd3 - Update DEV INTERCEPTOR: enhance timeout handling
**Problema:** O interceptor de comandos dev usava `fetch()` sem timeout. Se o Claude
demorasse, `_devInterceptPending = true` ficava preso eternamente e TODAS as tentativas
seguintes eram bloqueadas silenciosamente.

**Correcao:**
- Trocou `fetch()` por `_fetchWithTimeout()` com timeout de 65s
- Adicionou safety timeout de 70s que libera o interceptor automaticamente
- Reduziu cooldown de 15s para 10s entre intercepts
- Ampliou lista de keywords: adicionou 'quero', 'preciso', 'pode', 'deveria', 'devia'
- Relaxou regex de deteccao: `^(eu )?quer(o|ia) ` sem exigir complemento
- Adicionou `console.log('[INTERCEPTOR]')` em TODOS os pontos criticos
- Criou helper `_devInjectMsg()` para injetar mensagens no DataChannel
- Adicionou tratamento de erro: se DC estiver fechado, loga o estado

### 205dba8 - feat: botao PING no Dev Log + endpoint /api/dev/ping
**Problema:** Nao havia forma rapida de testar se o Claude estava acessivel pelo servidor.
O endpoint `/api/dev/diagnostico` existia mas exigia `requireAdmin`.

**Correcao:**
- Novo endpoint `POST /api/dev/ping`: testa conexao com Claude (ou GPT-4o fallback)
  sem precisar ser admin, apenas precisa ser usuario UltimateDEV
- Usa `claude-sonnet-4-20250514` para o teste (mais barato que opus pra ping)
- Botao "PING" no header do painel Dev Log
- Funcao global `devPingClaude()` mostra resultado direto no painel
- Resultado mostra: engine ativo, tempo de resposta, se API key existe

---

## Arquitetura do UltimateDEV (atualizada)

### Fluxo de um comando dev (2 caminhos):

**Caminho 1 — Via OpenAI Tool Call (ideal mas instavel):**
1. Usuario fala por voz
2. OpenAI Realtime transcreve (Whisper)
3. OpenAI decide chamar tool `comando_dev`
4. Frontend recebe `response.function_call_arguments.done` via DataChannel
5. Frontend chama `handleComandoDev()` -> `POST /api/dev/command`
6. Servidor chama Claude Opus 4 para gerar plano (60s timeout)
7. Frontend envia resultado de volta via `_sendToolResult()`
8. OpenAI fala o plano pro usuario

**Caminho 2 — Via Dev Interceptor (bypass, mais confiavel):**
1. Usuario fala por voz
2. OpenAI Realtime transcreve (Whisper)
3. Evento `conversation.item.input_audio_transcription.completed` dispara
4. `_devInterceptUserSpeech()` detecta keywords de dev na transcricao
5. Chama direto `POST /api/dev/command` sem depender da OpenAI chamar tool
6. Recebe plano do Claude
7. Injeta plano como mensagem no DataChannel via `_devInjectMsg()`
8. OpenAI recebe e fala o plano pro usuario

### Pontos de falha identificados:
- **ANTHROPIC_API_KEY nao configurada no Render** -> cai no fallback GPT-4o
- **Rate limiter** (10 calls/5min por IP) -> pode bloquear em testes intensivos
- **`canUseUltimateVA(userId)`** -> requer `isAdmin` ou `registrationOrder === 1`
- **DataChannel fechado** -> resultado do Claude nao chega ao agente de voz
- **Timeout** -> Claude Opus pode demorar >60s em instrucoes complexas

### Como testar:
1. Abrir app -> VA -> UltimateDEV
2. Clicar no botao verde flutuante (Dev Log)
3. Clicar em PING -> deve mostrar "Claude OK" ou o erro
4. Falar algo como "muda a cor do botao pra vermelho"
5. Observar no "Ao vivo" se o interceptor detecta e envia
6. Abrir F12 > Console e filtrar por `[INTERCEPTOR]` para debug detalhado

---

## Estado dos arquivos

| Arquivo | Linhas | Descricao |
|---------|--------|-----------|
| server.js | ~10909 | Backend completo |
| public/index.html | ~15228 | Frontend SPA |
| public/va-test.html | ~825 | Tela de ligacao |
| public/va-admin.html | ~501 | Admin dos VAs |
| public/admin.html | ~535 | Admin geral |

---

### e79a5ac - fix: trocar Claude Opus por Sonnet 4 para resolver timeout de 65s
**Problema:** O endpoint `/api/dev/command` usava `claude-opus-4-20250514` que demorava
>65s para responder (confirmado no screenshot do Dev Log: "Timeout: servidor demorou mais de 65s").
Alem disso, enviava 200 linhas de server.js E index.html como contexto (desnecessario,
ja tinha o mapa de endpoints extraido automaticamente).

**Correcao:**
- Trocou modelo de `claude-opus-4-20250514` para `claude-sonnet-4-20250514` (3-5x mais rapido)
- Removeu envio de 200 linhas de codigo no prompt do planning (ja tem endpoint map no system prompt)
- Aumentou timeout do servidor de 60s para 90s
- Aumentou timeout do frontend fetch de 65s para 95s
- Aumentou safety timeout do interceptor de 70s para 100s
- Atualizou mensagens de UI de "Opus" para "Sonnet"
- Trocou modelo de execucao de codigo (endpoint approve) tambem para Sonnet 4

---

## Proximos passos recomendados

1. **TESTAR AGORA** — Fazer deploy no Render e testar com voz: "muda a cor do botao pra vermelho"
2. **Verificar ANTHROPIC_API_KEY no Render** — Garantir que esta configurada e com creditos
3. **Se Sonnet funcionar** — Testar fluxo completo: comando -> plano -> aprovacao -> execucao
4. **Se der timeout de novo** — Verificar rate limits da Anthropic API e conexao Render -> Anthropic
5. **PING** — Usar botao PING no Dev Log pra testar conexao direta (usa Sonnet)
