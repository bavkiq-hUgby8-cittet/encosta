# FEATURE: DJ PANEL / ARTIST PANEL -- Touch? Live

## RESUMO

Um painel especial para DJs e artistas controlarem os celulares da plateia
em tempo real durante shows, via frequencia ultrassonica pelo sistema de som.

O DJ consegue: ativar todos os celulares, mudar cores por setor, criar ondas
de luz, pulsar no BPM, formar letras/palavras, e receber gorjetas em massa.

---

## COMO FUNCIONA (TECNICO)

### Fluxo basico:

1. DJ abre o painel em touch-irl.com/dj (ou /artist)
2. O painel gera comandos codificados em frequencias ultrassonicas
3. O sistema de som do venue transmite as frequencias junto com a musica
4. Todo celular com Touch? aberto no venue recebe e executa o comando
5. Os celulares respondem (mudam cor, pulsam, mostram animacao)

### Requisitos tecnicos:

- As frequencias ultrassonicas ja sao a base do Touch? (18-22 kHz)
- O PA system do venue precisa reproduzir acima de 18 kHz (maioria ja faz)
- Cada comando e um pacote curto de dados via som (tipo modem ultrassonico)
- Latencia esperada: <200ms (suficiente pra sincronizar com musica)
- Nao precisa de wifi nem bluetooth -- funciona 100% pelo som

### Mapeamento de setores:

- Opcao 1 (simples): o ingresso tem um setor (A, B, C, D...). Na hora do
  check-in via Touch?, o celular registra o setor. O DJ manda comandos
  por setor.
- Opcao 2 (avancado): GPS + triangulacao de som estima posicao no venue.
  O DJ pode "pintar" areas no mapa e mandar comandos por area.
- Opcao 3 (hibrido): setores no ingresso + refinamento por posicao.

---

## TELAS DO PAINEL DJ

### 1. Dashboard principal (/dj)
- Mapa do venue visto de cima
- Numero de devices conectados em tempo real
- Devices por setor (A: 2.400 | B: 3.100 | C: 2.800 ...)
- BPM detector (escuta o som e detecta automaticamente)
- Botoes de acao rapida

### 2. Controles de luz/cor
- Color picker: escolher cor pra cada setor ou todos
- Preset de cores: esquema do artista, cores do time, bandeira do pais
- Gradiente: cor A no setor esquerdo, transicao suave ate cor B no direito
- Brilho: slider de 0-100%

### 3. Controles de animacao
- PULSE: todos pulsam no BPM (auto-detectado ou manual)
- WAVE: onda de luz que percorre de um lado ao outro
- STROBE: flash rapido sincronizado
- RIPPLE: ondas concentricas a partir de um ponto (tipo pedra na agua)
- HEARTBEAT: pulso lento tipo coracao (pra momentos emocionais)
- BLACKOUT: apaga tudo por X segundos (pra antes do drop)
- FLASH: todos acendem de uma vez (pra o drop)
- WRITE: escrever texto/letras formadas pelos celulares visto de cima

### 4. Controle WRITE (escrever na plateia)
- O DJ digita uma palavra (ex: "TOUCH?")
- O sistema calcula quais celulares acendem e quais apagam
- Baseado no setor/posicao, cada celular recebe: ACENDE ou APAGA
- Visto de cima (jumbotron/drone), a plateia forma a palavra
- Pode animar letra por letra ou tudo de uma vez
- Limite pratico: palavras curtas (5-8 letras) pra ser legivel

### 5. Tipping / Gorjeta
- O DJ aperta "TIP TIME"
- Todos os celulares mostram: "Tip the artist? $3 / $5 / $10 / $20"
- Um toque e a gorjeta vai direto pro artista
- O painel mostra o contador subindo em tempo real
- Pode configurar: percentual pro venue, percentual pro artista

### 6. Momentos especiais
- PROPOSAL: cria um coracao vazio na plateia + escreve texto dentro
- BIRTHDAY: destaca a area de uma pessoa com cor diferente
- ENCORE: animacao especial de "pedido de bis" sincronizada
- COUNTDOWN: 3... 2... 1... (celulares mostram os numeros)

---

## ANIMACOES NOS CELULARES DA PLATEIA

As animacoes que aparecem no celular de cada pessoa sao DIFERENTES das
animacoes normais do Touch? (que sao o circulo laranja "TOUCHING...").

### Animacoes exclusivas de show:

1. **FIRE**: ondas de fogo (laranja/vermelho) subindo na tela
2. **OCEAN**: ondas de agua azul/verde fluindo
3. **GALAXY**: estrelas girando, nebulosas, cosmos
4. **LASER**: feixes de laser coloridos cruzando a tela
5. **PULSE RING**: aneis concentricos expandindo no ritmo
6. **MATRIX**: chuva de caracteres estilo matrix na cor do artista
7. **AURORA**: aurora boreal fluindo em cores
8. **HEARTBEAT**: coracao pulsando (pra momento emocional)
9. **SOLID COLOR**: tela inteira de uma cor (pra formar letras/palavras)
10. **STROBE**: flash branco rapido
11. **GRADIENT FLOW**: gradiente de cores fluindo suavemente
12. **CONFETTI**: confetti digital caindo na tela

### Regras:
- Cada animacao funciona em LOOP ate o DJ mudar
- O BPM controla a velocidade da animacao
- O DJ pode combinar animacao + cor (ex: FIRE em azul, OCEAN em rosa)
- Brilho adaptativo: em venue escuro aumenta, em outdoor diminui

---

## CONEXAO COM A PLATEIA

### Check-in no show:
1. Pessoa chega no venue
2. Abre touch-irl.com no celular
3. O sistema de som emite um "handshake" ultrassonico de boas-vindas
4. O celular se registra automaticamente no painel do DJ
5. O celular sabe seu setor (via ingresso/QR ou GPS)
6. Pronto -- o DJ ja pode controlar esse celular

### Durante o show:
- O celular fica em modo "LIVE" -- tela cheia com a animacao
- O usuario pode trancar a tela e a animacao continua
- Bateria: animacoes sao leves (CSS/WebGL), consumo baixo
- Se o usuario quiser sair do modo LIVE, so deslizar pra baixo

### Depois do show:
- Todas as pessoas que estavam no modo LIVE sao adicionadas na
  constelacao como "Met at [nome do show] -- [data]"
- O artista tambem aparece como um no especial (estrela dourada)
- O usuario pode ver: "Voce estava entre 45.000 pessoas nesse show"

---

## MODELO DE NEGOCIO

### Pra Touch?:
- Comissao sobre gorjetas (ex: 5% do total de tips)
- Assinatura mensal pro painel DJ (ex: $99/mes pro basico, $499/mes pro premium)
- Patrocinios: marcas pagam pra ter o logo na animacao (ex: Heineken verde)

### Pra o DJ/Artista:
- Ferramenta gratuita pra controlar a plateia (atrai DJs)
- Recebe gorjetas diretamente (menos a comissao)
- Dados da plateia (quantos devices, tempo medio, setores mais ativos)

### Pra o Venue:
- Check-in automatico (controle de lotacao em tempo real)
- Percentual das gorjetas (configuravel)
- Analytics: mapa de calor da plateia, picos de energia

---

## INTEGRACAO COM O APP EXISTENTE

### O que ja existe e pode ser reusado:
- Sistema de som ultrassonico (core do Touch?)
- Tela "TOUCHING..." (base pras animacoes)
- Constelacao / MY NETWORK (pra adicionar conexoes do show)
- Service Mode (base pro painel do DJ)
- Sistema de gorjetas (ja funciona pra bartenders, etc.)
- Socket.IO em tempo real (pra o painel controlar devices)

### O que precisa ser criado:
- Rota /dj com o painel de controle
- Modo LIVE no celular (tela cheia de animacao)
- Protocolo de broadcast ultrassonico (1-para-muitos, hoje e 1-para-1)
- Animacoes CSS/WebGL exclusivas de show
- Sistema de mapeamento de setor/posicao
- Detector de BPM automatico
- Tela de tipping em massa

### Estimativa de complexidade:
- Painel DJ (frontend): medio -- e basicamente um dashboard com botoes
- Modo LIVE (frontend): medio -- animacoes CSS/WebGL
- Broadcast 1-para-muitos: ALTO -- o core hoje e 1-para-1, precisa adaptar
- Mapeamento de posicao: medio -- setor por ingresso e simples, GPS e complexo
- Tipping em massa: baixo -- ja existe o sistema de gorjetas

---

## PRIORIDADE DE IMPLEMENTACAO

### Fase 1 (MVP): "DJ consegue ativar celulares"
- Rota /dj com controles basicos (cor, pulse, blackout, flash)
- Modo LIVE no celular (tela cheia respondendo a comandos)
- Broadcast 1-para-muitos via ultrasom
- Check-in automatico por som
- Contador de devices conectados

### Fase 2: "Animacoes e sincronizacao"
- Todas as animacoes (fire, ocean, galaxy, etc.)
- BPM detector automatico
- Wave e ripple por setor
- Presets de show salvos

### Fase 3: "Tipping e letras"
- Tipping em massa com botao no painel
- Sistema WRITE pra formar letras na plateia
- Momentos especiais (proposal, birthday, countdown)
- Analytics pos-show

### Fase 4: "Escala e parcerias"
- API pra integrar com softwares de DJ (Serato, Traktor, Rekordbox)
- SDK pra venues integrarem no sistema de ingressos
- Patrocinios (logos de marca nas animacoes)
- Perfil publico do artista com historico de shows

---

## PITCH PRA DJS

"Imagina controlar 60.000 celulares na plateia com um botao.
Sem pulseiras LED. Sem hardware extra. So o celular que todo mundo ja tem.
Voce aperta PULSE e 60.000 telas pulsam no seu BPM.
Voce aperta WAVE e uma onda de luz cruza o estadio em 3 segundos.
Voce escreve TOUCH e 60.000 telas formam a palavra visto de cima.
E no final do set, um botao: gorjeta do artista. $5.000 em 10 segundos.
Isso e Touch? Live. O som faz a conexao."
