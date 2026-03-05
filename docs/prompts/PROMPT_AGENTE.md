# Prompt de Continuação — Agente de Voz (Touch? / Encosta)

## Contexto do Projeto
Touch? (Encosta) é um app social de proximidade. O código está no repositório GitHub e o projeto inteiro roda em um único `server.js` (backend Node.js + Express) e `public/index.html` (frontend SPA).

## Foco desta sessão: AGENTE DE VOZ (VA)

### O que já existe:
- **Agente de voz via OpenAI Realtime API + WebRTC** — o usuário abre o assistente, fala pelo microfone, o agente responde por áudio
- **Duas versões**: padrão (Plus) e premium (PRO) com instruções diferentes
- **Endpoints no server.js**:
  - `POST /api/agent/session` — gera ephemeral token para VA padrão
  - `POST /api/agent/premium-session` — gera ephemeral token para VA premium
  - `GET /api/agent/context/:userId` — retorna contexto do usuário (perfil, conexões, notificações) para o agente consultar via tool
- **Frontend** (index.html): IIFE `VA` com WebRTC, orb animado (brain SVG), cosmos background, waveform bars, mini mode, botão vermelho "Encerrar"
- **Onboarding**: sistema de áudio pré-gravado (TTS) com 4 steps — já implementado e funcionando

### Problemas conhecidos / pendentes do agente:
1. **Agent ainda pode falar duas vezes** — foi corrigido removendo greeting das instructions e adicionando "NÃO fale automaticamente", mas vale verificar se está 100%
2. **Echo** — mic é mutado durante `response.audio.delta` e reativado no `response.done`, mas pode precisar de ajuste fino
3. **Fala pausada** — instrução "FALE PAUSADO" já está nos 3 endpoints
4. **Notificações** — agente já recebe likes, stars, reveals, pending requests dos últimos 7 dias via `/api/agent/context`
5. **Personalidade fofoqueira** — último commit adicionou personalidade curiosa sobre pessoas e parentescos
6. **Onboarding** — convertido para áudio pré-gravado (MP3 estáticos), sem WebRTC, custo zero por usuário

### Arquitetura técnica:
- **VAD**: server_vad, threshold 0.9, prefix_padding_ms 400, silence_duration_ms 1200
- **Voz**: `shimmer` (padrão) e `nova` (premium)
- **Tools do agente**: `consultar_rede` (busca contexto), `navegar` (muda página do app)
- **Echo fix**: mic tracks disabled durante response.audio.delta, re-enabled em response.done
- **Mini mode**: botão flutuante lilás com pulse quando agente navega páginas

### Commits recentes desta sessão:
```
187b466 feat: agente de voz com personalidade fofoqueira
50031cb feat: rota /api/agent/onboarding-reset para testes
c28f1c8 fix: onboarding — geração sob demanda + autoplay mobile
ded9c9d fix: privacidade das notificacoes — so entre as duas pessoas envolvidas
4b122ab feat: onboarding com áudio pré-gravado — remove WebRTC, custo zero
3c27cb4 feat: botao rede abaixo do chat + badge de notificacoes unificado
f77c494 fix: onboarding — textos ajustados, step 4 corrigido
b2ec1fc fix: agente duplo + botão vermelho + cosmos + notificações
8dd10f0 fix: onboarding — botão Começar, bubble mais baixo, spark no timing certo
f4a936e feat: VA redesign futurista + fix echo + fala pausada
874844d feat: onboarding visual overhaul — loading moderno, spark, novo fluxo
```

### Instruções:
- O dono do projeto (Ramon) não sabe programar — faça tudo, pense em tudo, suba no GitHub
- Código em português (variáveis, comentários)
- Sempre commitar e fazer push após cada alteração significativa
- Testar mentalmente o fluxo antes de alterar
- Ler o código existente ANTES de modificar
