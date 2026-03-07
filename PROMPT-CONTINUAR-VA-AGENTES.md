# PROMPT DE CONTINUACAO -- Voice Agent (VA) Avatar + Agentes

Copie e cole ao iniciar novo chat:

---

```
Voce vai me ajudar a continuar o desenvolvimento do app "Touch?" (Encosta) -- uma rede social baseada em proximidade fisica (ultrassonica).

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## ACESSO AO PROJETO

1. PASTA NA MAQUINA: a pasta "encosta" no meu computador
2. GITHUB: https://github.com/bavkiq-hUgby8-cittet/encosta.git
3. GIT CONFIG: Email: ramonnvc@hotmail.com | Nome: Ramon

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta
2. git pull origin main
3. Leia PROMPT-NOVO-CHAT.md na raiz (contexto completo do projeto)
4. Leia este prompt inteiro antes de comecar

## REGRAS DE TRABALHO

- SEMPRE git pull origin main ANTES de editar qualquer arquivo
- SEMPRE commit e push depois de cada tarefa
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo

## CONTEXTO DA SESSAO ANTERIOR (o que ja foi feito)

### Voice Agent (VA) -- Sistema de Avatar 3D com Giroscopio

O VA e o assistente de voz do app (OpenAI Realtime API via WebRTC). Ele tem um avatar robo com 5 angulos de visao (front, qleft, profile, qright, back) que trocam conforme o usuario mexe o celular.

ARQUIVOS PRINCIPAIS:
- public/index.html (~22000 linhas) -- SPA com todo CSS/HTML/JS
- server.js -- backend Node.js/Express com endpoints de sessao VA

### Correcoes ja feitas nesta sessao:

1. **Wave bars na boca do avatar** (commit bdc2e5b)
   - Barras de audio estavam invisiveis por causa do transform-style:preserve-3d no .va-orb
   - Adicionado translateZ(10px) no .va-wave e translateZ(5px) nos overlays (olhos/boca/coracao)
   - Aumentado tamanho das barras (3px width, glow shadow, opacity 0.5+, max height 28px)

2. **Unmute delay revertido** (commit 17bc771)
   - UNMUTE_DELAY_MS voltou de 1200ms para 2500ms
   - Com 1200ms o agente se escutava e criava loop de feedback

3. **Volume earpiece/speaker via GainNode** (commit bf969cd)
   - audioEl.volume nao funciona no iOS (read-only)
   - Audio agora roteado via Web Audio API GainNode
   - Earpiece: 15% gain, Speaker: 100% gain
   - Sensor de proximidade auto-baixa volume quando celular no ouvido
   - Funcao centralizada _setVolume() usada por toggleEarpiece e proximity sensor

4. **Anti-alucinacao dos agentes** (commit 78a6102)
   - Agentes inventavam historias/memorias falsas
   - Causa: prompts com "OBRIGATORIO: retome" e "LEMBRE-SE" forcavam o LLM a inventar
   - Adicionado "REGRA CRITICA -- NUNCA INVENTAR" em todos 3 tiers (Plus, Pro, UltimateDEV)
   - Reescrito header de historico para "Use APENAS estas informacoes"
   - Suavizadas instrucoes de abertura para nao forcar invencao

5. **Giroscopio race condition** (commit ad95c76)
   - _requestGyroPermission() (click) e _initGyro() (dc.onopen) resolviam em ordem aleatoria
   - Criado _tryAttachGyro() que verifica AMBAS condicoes (handler ready + permission granted)
   - Ambos callbacks chamam _tryAttachGyro -- quem rodar por ultimo faz a conexao

6. **Troca de views restaurada** (commit d1e8ad0)
   - Parallax 3D suave funcionava mas nao trocava imagens do avatar
   - Adicionadas zonas de view: front(-8 a 8), qleft(-8 a -18), qright(8 a 18), profile(<-18), back(>18)
   - Parallax local dentro de cada zona + idle breathing
   - Desktop: mouse cobre todas as 5 views

### Estrutura do codigo VA (referencias rapidas):

**CSS do avatar (linhas ~1756-1825):**
- .va-orb: transform-style:preserve-3d, overflow:visible
- .va-wave: position:absolute, top:46%, translateZ(10px), z-index:3
- .va-eye-overlay: translateZ(5px), z-index:2
- .va-mouth-overlay: translateZ(5px), z-index:2

**Giroscopio (linhas ~20185-20310):**
- _gyroViewZones: 5 zonas com thresholds em graus
- _switchView(): troca classes va-view-active/va-view-hidden
- _gyroAnimate(): lerp + view switch + parallax local + idle breathing
- _tryAttachGyro(): resolve race condition iOS permission
- _requestGyroPermission(): chamado no click, guarda _gyroPermissionGranted
- _initGyro(): chamado em dc.onopen, cria handler e chama _tryAttachGyro

**Audio e volume (linhas ~20130-20175, ~20300-20360):**
- _vaAudioCtx, _vaGainNode: Web Audio API para controle de volume
- EARPIECE_GAIN = 0.15, SPEAKER_GAIN = 1.0
- _setVolume(): helper centralizado
- Proximity sensor: auto-ajusta volume quando perto do ouvido

**System prompts dos agentes (server.js):**
- VA_DEFAULT_CONFIG (linha ~12439): personalidade/regras de cada tier
- buildUserContext() (linha ~10200): monta dados do usuario
- /api/agent/session (linha ~10542): endpoint Plus
- /api/agent/premium-session: endpoint Pro
- /api/agent/ultimate-session: endpoint UltimateDEV
- Todos tem "REGRA CRITICA -- NUNCA INVENTAR" no instructions

### O QUE FALTA / PROXIMOS PASSOS:

- Testar se wave bars estao visiveis na boca do avatar
- Testar se troca de views esta suave e natural
- Testar se volume baixa no earpiece
- Testar se agentes pararam de inventar historias
- Qualquer ajuste fino nos agentes VA (personalidade, abertura, ferramentas)
- Melhorias na UI de chamada (mute button, blackout screen, etc)

Pergunte o que devo trabalhar agora!
```
