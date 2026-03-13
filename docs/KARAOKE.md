# MODULO KARAOKE -- Documentacao Tecnica

> Ultima atualizacao: 13/03/2026
> Autor: Ramon + Claude Opus 4.6

## VISAO GERAL

Karaoke e um modulo do painel operacional do Touch?. Quando ativado em um evento,
permite que participantes busquem musicas no YouTube, entrem na fila, cantem, e
sejam avaliados pela plateia em tempo real.

O operador (TV/projetor) ve o player do YouTube com o video tocando, a fila de
cantores e o placar. Os participantes (celular) buscam musicas, entram na fila,
ativam o microfone com visualizador de energia, e a plateia aplaude e vota.

## COMO ATIVAR

1. Operador cria ou edita evento no painel (operator.html)
2. Marca o checkbox "Karaoke" nos modulos disponiveis
3. Ou: abre Perfil > ativa checkbox Karaoke > Salvar
4. O FAB rosa "K" aparece no cascade de botoes flutuantes
5. Clica no FAB > abre painel Karaoke > aba Config > "Ativar Karaoke" = ON

## COR DO MODULO

- Cor principal: #ec4899 (rosa/pink)
- Cor secundaria: #f472b6
- CSS class: .op-karaoke-panel
- Variaveis: --mod-accent, --mod-accent2, etc (mesmo padrao dos outros modulos)

## ARQUITETURA

### Fluxo Completo

```
1. Operador ativa modulo Karaoke no evento
2. Participante ve botao "Karaoke" no card de conexao / quick actions
3. Participante abre overlay Karaoke no celular
4. Participante busca musica (campo de busca > YouTube Data API v3)
5. Participante clica "Cantar!" > entra na fila com videoId da musica
6. Operador clica "Proximo Cantor" no painel
7. YouTube IFrame Player carrega e toca o video automaticamente na TV
8. Participante ve "SUA VEZ!" e pode ativar microfone (Web Audio API)
9. Plateia aplaude (botao &#128079;) e vota com estrelas (1-5) pelo celular
10. Operador clica "Finalizar" > pontuacao calculada > proximo cantor assume
11. Placar atualiza em tempo real pra todos
```

### Onde o Codigo Vive

| Arquivo | O que tem |
|---------|-----------|
| server.js | 10 endpoints REST + YouTube search proxy + socket event |
| public/operator.html | Painel do operador (CSS + HTML + JS do modulo) |
| public/index.html | Vista do participante (overlay, busca, fila, mic, voto) |

## ENDPOINTS REST (server.js)

### Operador

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | /api/operator/event/:eventId/karaoke | Estado completo (config, fila, cantor atual, scores, historico) |
| POST | /api/operator/event/:eventId/karaoke/config | Salvar config (enabled, sessionName, maxQueue, autoAdvance, votingEnabled) |
| POST | /api/operator/event/:eventId/karaoke/start | Chamar proximo cantor (ou especifico via singerId) |
| POST | /api/operator/event/:eventId/karaoke/finish | Finalizar performance atual (calcula score, avanca se autoAdvance) |
| POST | /api/operator/event/:eventId/karaoke/skip | Pular cantor sem pontuar |
| POST | /api/operator/event/:eventId/karaoke/reset | Limpar tudo (fila, scores, historico) |

### Participante

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | /api/event/:eventId/karaoke | Estado publico (fila, cantor, scores, config parcial) |
| POST | /api/event/:eventId/karaoke/join | Entrar na fila (userId, nickname, song, videoId, thumbnail) |
| POST | /api/event/:eventId/karaoke/update-song | Trocar musica na fila |
| POST | /api/event/:eventId/karaoke/leave | Sair da fila |
| POST | /api/event/:eventId/karaoke/vote | Votar no cantor atual (voterId, stars 1-5) |
| POST | /api/event/:eventId/karaoke/applause | Aplaudir cantor atual (incrementa contador) |

### YouTube

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | /api/youtube/search?q=texto | Busca no YouTube Data API v3 (adiciona "karaoke" ao query) |

Requer env var: YOUTUBE_API_KEY

## SOCKET EVENT

Evento: `karaoke-update`
Sala: `event:{eventId}`
Payload: `{ type, queue, currentSinger, scores, finished? }`

Types: config, queue, start, finish, skip, vote, applause, reset

Todos os dispositivos conectados ao evento recebem updates em tempo real.

## DADOS NO FIREBASE (server.js in-memory db)

```
db.operatorEvents[eventId].karaoke = {
  enabled: boolean,
  config: {
    sessionName: string,      // "Karaoke dos Veloso"
    maxQueue: number,          // 50 (maximo na fila)
    autoAdvance: boolean,      // true (avanca automatico pro proximo)
    votingEnabled: boolean     // true (habilita votacao)
  },
  queue: [                     // Array ordenado
    {
      id: "kq_1710...",        // ID unico
      userId: string,
      nickname: string,
      song: string,            // "Evidencias - Chitaozinho e Xororo karaoke"
      videoId: string,         // YouTube video ID (ex: "dQw4w9WgXcQ")
      thumbnail: string,       // URL da thumbnail do YouTube
      joinedAt: timestamp,
      status: "waiting"        // waiting | singing | finished | skipped
    }
  ],
  currentSinger: {             // null se ninguem cantando
    ...mesmos campos do queue item,
    status: "singing",
    startedAt: timestamp
  },
  scores: {
    [userId]: {
      name: string,
      song: string,
      applause: number,        // total de aplausos recebidos
      votes: { [voterId]: stars },  // cada votante com nota 1-5
      avgStars: number,        // media calculada
      points: number           // (avgStars * 10) + (applause * 0.5)
    }
  },
  history: [                   // Performances finalizadas
    { ...singer, finishedAt, status: "finished"|"skipped" }
  ]
}
```

### Formula de Pontuacao

```
pontos = (media_estrelas * 10) + (aplausos * 0.5)
```

Exemplo: cantor recebeu 50 aplausos e media 4.2 estrelas
= (4.2 * 10) + (50 * 0.5) = 42 + 25 = 67 pontos

## OPERATOR.HTML (Painel do Operador)

### Localizacao no Codigo

- CSS: procurar `KARAOKE MODULE VARS` (~linha 1377)
- FAB: procurar `fabKaraoke` (~linha 1761)
- HTML do painel: procurar `opKaraokePanel` (~linha 2885)
- Modal de voto: procurar `karaokeVoteModal`
- JavaScript: procurar `KARAOKE MODULE` (~linha 8614)

### Estrutura do Painel

4 abas:
1. **Palco** -- YouTube IFrame Player + "Cantando agora" + controles + mini-fila
2. **Fila** -- Lista completa com stats (na fila, cantando, total)
3. **Placar** -- Ranking por pontos com medalhas
4. **Config** -- Ativar/desativar, nome da sessao, max fila, auto-avanco, votacao

### YouTube IFrame Player

- Carregado via `https://www.youtube.com/iframe_api`
- Funcao `karaokeInitYt()` carrega o script e cria o player
- Funcao `karaokeCreatePlayer()` instancia `new YT.Player`
- Quando currentSinger muda > `player.loadVideoById(videoId)`
- Quando video termina (YT.PlayerState.ENDED) > chama `karaokeFinish()` se autoAdvance

### YouTube Premium (sem propagandas)

- Botao "Login YouTube Premium" no topo do painel
- Abre nova aba em `accounts.google.com` para login no YouTube
- Se o operador estiver logado com conta Premium no browser, o player embeddado NAO mostra ads
- NAO existe forma de remover ads via API -- so funciona com login Premium no browser

### Estado Global JS

```javascript
const KARAOKE = {
  activeTab: 'stage',
  config: { enabled, sessionName, maxQueue, autoAdvance, votingEnabled },
  queue: [],
  currentSinger: null,
  scores: {},
  history: [],
  ytPlayer: null,     // instancia do YT.Player
  ytReady: false,     // true quando player carregou
  selectedStars: 0    // estrelas selecionadas no modal de voto
};
```

### Funcoes Principais (operator.html)

| Funcao | O que faz |
|--------|-----------|
| openKaraokePanel() | Abre painel, carrega dados, inicia YouTube player |
| closeKaraokePanel() | Fecha painel |
| switchKaraokeTab(tab) | Troca aba (stage/queue/scores/config) |
| loadAllKaraokeData() | GET /api/operator/.../karaoke > popula KARAOKE |
| renderKaraokeAll() | Renderiza tudo (now playing, fila, placar, badges) |
| renderKaraokeNowPlaying() | Atualiza banner "cantando agora" + carrega video |
| karaokeStartNext() | POST .../karaoke/start > chama proximo |
| karaokeFinish() | POST .../karaoke/finish > finaliza, calcula score |
| karaokeSkip() | POST .../karaoke/skip > pula sem pontuar |
| karaokeReset() | POST .../karaoke/reset > limpa tudo |
| karaokeVoteModal() | Abre modal de votacao |
| karaokeConfirmVote() | POST .../karaoke/vote > registra voto do operador |
| saveKaraokeConfig() | POST .../karaoke/config > salva configuracoes |
| karaokeYtLogin() | Abre YouTube em nova aba pra login Premium |
| bindKaraokeSocket() | Registra listener socket karaoke-update |

## INDEX.HTML (Vista do Participante)

### Localizacao no Codigo

- JavaScript: procurar `KARAOKE MODULE (Participant View)` (~antes de `EVENTS`)
- Botao no card de conexao: procurar `openKaraokeFromNetwork`
- Quick actions: procurar `em.karaoke`
- Botao no checkin: procurar `evModules.karaoke`
- Socket listener: procurar `karaoke-update` dentro de initSocket

### Como o Participante Acessa

3 pontos de entrada:
1. **Quick action** no card da lista de conexoes (botao rosa "Karaoke")
2. **Card de conexao** na rede (secao "Karaoke ativo" com botao "Entrar no Karaoke")
3. **Botao no checkin** (tela de boas-vindas quando faz check-in no evento)

Todos chamam `openKaraokeFromNetwork(eventId)`.

### Overlay do Participante

Cria um overlay fullscreen (id: karaokeOverlay) com:

1. **Banner "Cantando agora"** -- mostra quem esta cantando + botao aplaudir + votar estrelas
2. **Secao "SUA VEZ!"** (se o participante esta cantando):
   - Animacao de microfone pulsando
   - Botao "ATIVAR MICROFONE"
   - Visualizador de energia vocal (canvas com barras coloridas)
   - Botao "Terminei"
3. **Posicao na fila** (se esta esperando) com botao "Sair da fila"
4. **Busca de musica** (se NAO esta na fila) com resultados do YouTube
5. **Lista da fila** completa
6. **Placar** com ranking

### Microfone / Web Audio API

```
navigator.mediaDevices.getUserMedia({ audio: true })
> AudioContext > createAnalyser (fftSize 256)
> getByteFrequencyData > renderiza barras no canvas
> calcula "energia" de 0-100%
```

Funcoes: karaokeToggleMic(), karaokeMicLoop(), karaokeStopMic()

### Funcoes Principais (index.html)

| Funcao | O que faz |
|--------|-----------|
| openKaraokeFromNetwork(eventId) | Abre overlay, carrega dados |
| closeKaraokeOverlay() | Fecha overlay, para microfone |
| loadKaraokeParticipant() | GET /api/event/.../karaoke > renderiza |
| renderKaraokeParticipant() | Monta HTML do overlay (dinamico baseado no estado) |
| karaokeSearch() | GET /api/youtube/search > mostra resultados |
| karaokeSelectSong(videoId, title, thumbnail) | POST .../karaoke/join > entra na fila |
| karaokeLeaveQueue() | POST .../karaoke/leave > sai da fila |
| karaokeApplaud() | POST .../karaoke/applause > incrementa |
| karaokeParticipantVote(stars) | POST .../karaoke/vote > vota |
| karaokeFinishSinging() | Fecha overlay (operador controla o finish real) |
| karaokeToggleMic() | Ativa/desativa microfone e visualizador |

## VARIAVEIS DE AMBIENTE

| Variavel | Onde | Obrigatorio | Descricao |
|----------|------|-------------|-----------|
| YOUTUBE_API_KEY | Render (server.js) | Sim (pra busca funcionar) | Chave da YouTube Data API v3 |

Como obter:
1. console.cloud.google.com > APIs e servicos > Credenciais
2. Ativar "YouTube Data API v3" no projeto
3. Criar ou usar API Key existente
4. Adicionar no Render: Environment > YOUTUBE_API_KEY = chave

## MODULO NO SISTEMA DE MODULOS

- ev.modules.karaoke: boolean (ativa/desativa no evento)
- Checkbox na criacao: opModuleKaraoke
- Checkbox no perfil: profileModuleKaraoke
- FAB: fabKaraoke (rosa #ec4899, letra "K")
- Badge: fabKaraokeBadge (mostra qtd na fila)
- Welcome card: key "karaoke", cor #ec4899, icone "karaoke"

## LIMITACOES CONHECIDAS

1. **Propagandas do YouTube** -- So removidas se operador logado com YouTube Premium no browser.
   NAO existe forma via API de remover ads em embeds.

2. **Busca do YouTube** -- Limitada pela cota diaria da API key (10.000 unidades/dia no plano gratuito).
   Cada busca consome ~100 unidades = ~100 buscas/dia gratis.

3. **Microfone** -- Requer HTTPS (funciona em touch-irl.com e localhost).
   O audio NAO e transmitido -- e apenas visualizacao local no celular do cantor.

4. **Dados em memoria** -- Como todo o Touch?, dados do karaoke vivem no in-memory db do server.js.
   Se o servidor restartar, dados da sessao sao perdidos (mas Firebase persiste).

5. **Auto-advance** -- Quando video termina, automaticamente finaliza e avanca pro proximo.
   Pode desativar em Config > "Avancar automaticamente" = OFF.

## PROXIMOS PASSOS POSSIVEIS

- Card de resultado exportavel como imagem (html2canvas)
- Historico de musicas cantadas por usuario
- Modo "Plateia" dedicado (tela simplificada so pra aplaudir e votar)
- Integracao com sistema de moedas do Touch? (ganhar moedas por cantar)
- Playlist pre-definida pelo operador
- Modo offline (musicas locais sem YouTube)
