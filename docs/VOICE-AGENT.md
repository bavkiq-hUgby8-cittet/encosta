# VOICE AGENT -- Sistema de 3 Tiers

Atualizado: 27/02/2026

O Voice Agent usa OpenAI Realtime API via WebRTC. Tem 3 niveis de acesso.

## PLUS (basico -- qualquer assinante Touch Plus)

- Custo: $0.08/sessao
- 4 tools: navegar_tela, mostrar_perfil, listar_conexoes, consultar_relacao
- Voz: coral, VAD threshold 0.95

## PRO (premium -- qualquer assinante Touch Plus)

- Custo: $0.15/sessao
- 9 tools: as 4 do Plus + salvar_nota, ler_notas, buscar_pessoa, ver_estrelas, contar_fofoca
- Voz: coral, VAD threshold 0.95

## ULTIMATEDEV (apenas admin / Top 1)

- Custo: $0.25/sessao (voz) + ~$0.01-0.05/comando (Claude)
- 18+ tools: as 9 do Pro + comando_dev, ver_fila_dev, aprovar_plano, rejeitar_plano, aprender_usuario, escrever_pensamento, fazer_backup, salvar_arquivo
- CEREBRO: Claude Opus 4 (Anthropic) para planejamento e geracao de codigo
- Voz continua OpenAI (unico com Realtime API via WebRTC)
- Contexto inteligente: MAX_LINES_PER_FILE=400, CONTEXT_RADIUS=12, STOP_WORDS PT-BR
- IMPORTANTE: NAO filtrar CSS de HTML (quebra edicao de estilos)
- Fallback para GPT-4o se ANTHROPIC_API_KEY nao configurada
- ARQUITETURA ASYNC: /api/dev/command retorna imediato, Claude processa em background
- Frontend faz polling via GET /api/dev/status/:commandId a cada 3s
- RETRY AUTOMATICO: anthropicFetch() com 3 tentativas e backoff (5s/10s/15s)
- GIT AUTO-PUSH: remote origin com GITHUB_TOKEN
- COOLDOWN: 60s entre comandos DEV

### Personalidade do UltimateDEV:
- MELHOR AMIGO do Ramon, ponte entre ele e os agentes
- Fala pausado e claro, questiona decisoes quando necessario
- NAO e fofoqueiro -- companheiro de construcao

### Regras de seguranca do UltimateDEV:
- NUNCA apagar funcionalidades sem autorizacao
- NUNCA fazer rm/delete/drop/truncate em dados
- NUNCA modificar pagamento/auth/permissoes sem aprovacao
- Confirmar 2x antes de acao destrutiva

## FLUXO DO ULTIMATEDEV (dev commands)

1. Usuario fala instrucao por voz
2. Agente chama tool comando_dev -> POST /api/dev/command
3. Claude gera plano com mapa de endpoints (async, sem timeout)
4. Agente resume plano por voz, pergunta se aprova
5. Aprovado -> POST /api/dev/approve/:commandId -> Claude gera edits -> valida -> aplica -> backup -> git commit+push
6. Rejeitado -> POST /api/dev/reject/:commandId
7. Dev Log mostra status em tempo real

### Caminho alternativo (Dev Interceptor):
1. Transcricao de voz dispara evento
2. _devInterceptUserSpeech() detecta keywords de dev
3. Chama POST /api/dev/command direto (sem depender da OpenAI)
4. Injeta plano via _devInjectMsg() no DataChannel

## VA ADMIN PANEL

- URL: https://touch-irl.com/va-admin.html?userId=USER_ID
- Ajusta voz, VAD, personalidade, regras de privacidade/memoria por tier
- Salva no Firebase (colecao vaConfig)
- Endpoints leem do vaConfig via getTierConfig(tier)

## ADMIN PANEL (admin.html) -- ABAS

Dashboard, Users, Stars, Events, Financial, System, VA Config, DEV Monitor

DEV Monitor: total de comandos, done/pending/failed, uptime, status API keys
- GET /api/dev/monitor, auto-refresh 5s

## ANTI-ECHO SYSTEM

- Flags: _agentSpeaking, _pendingToolCall, _unmuteTimer
- Unmute com delay 800ms apos agente parar
- Server VAD: threshold 0.95, prefix_padding 500ms, silence 1500ms

## FRONTEND DO VOICE AGENT

- Variavel: vaTier ('plus' | 'pro' | 'ultimatedev')
- VA.open(tier) -> /api/agent/access
- VA.switchTier(newTier) -> reconecta
- Tool handlers: handleComandoDev, handleVerFilaDev, handleAprovarPlano, etc
- Escriba: auto-flush 2min (_escribaBuffer, _escribaLog, _escribaFlush)
- Camera: 640x480 @2fps (getUserMedia)
- Screen: @2fps (getDisplayMedia)
- Dev tools bar: #vaDevTools (so aparece em ultimatedev)
- Persistencia: ultimas 20 msgs entre sessoes

## RESTRICOES DO AGENTE (para o usuario saber)

- Contexto limitado (400 linhas/arquivo, raio 12)
- Nao cria arquivos novos do zero (apenas edita existentes)
- Mudancas muito grandes ou multi-arquivo sao mais arriscadas
- Pode falhar se old_string nao matcheia exatamente
- devQueue em RAM, perde comandos no redeploy (solucao futura: Firebase)

## DOCUMENTACAO COMPLETA

Ver docs/ULTIMATEDEV.md para detalhes de todas as tools, fluxos e exemplos.
