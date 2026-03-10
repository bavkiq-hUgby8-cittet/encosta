# PROMPT PRO AGENTE ARQUITETO -- Implementar DJ Panel / Touch? Live

Cole isso na janela do agente:

---

Leia o arquivo docs/FEATURE-DJ-PANEL.md -- e o doc completo da feature DJ Panel / Touch? Live.

Resumo rapido: e um painel pra DJs e artistas controlarem os celulares da plateia em tempo real durante shows. O sistema de som do venue emite frequencias ultrassonicas (que ja e a base do Touch?) e todos os celulares com o app aberto respondem -- mudando cor, pulsando no BPM, mostrando animacoes (fire, ocean, galaxy, aurora, laser, matrix), formando letras/palavras vistas de cima, e recebendo gorjetas em massa.

Implemente a FASE 1 (MVP):

1. ROTA /dj -- Painel de controle do DJ
   - Dashboard com contador de devices conectados em tempo real
   - Botoes: PULSE, FLASH, BLACKOUT, color picker
   - Slider de BPM (manual + auto-detect)
   - Botao ACTIVATE que inicia o broadcast ultrassonico

2. MODO LIVE no celular da plateia
   - Quando o celular recebe o handshake ultrassonico do venue, entra em tela cheia
   - Tela cheia mostra a animacao que o DJ escolheu (comeca com PULSE laranja)
   - O usuario pode sair deslizando pra baixo
   - Animacoes respondem aos comandos do DJ em tempo real

3. BROADCAST 1-PARA-MUITOS via ultrasom
   - Hoje o Touch? e 1-para-1 (dois celulares). Precisa adaptar pra 1-para-muitos
   - O PA system emite a frequencia, todos os celulares no venue recebem
   - Cada comando e um pacote curto codificado na frequencia (cor, animacao, bpm)
   - Latencia alvo: <200ms

4. CHECK-IN AUTOMATICO
   - Quando o celular detecta o handshake do venue, registra automaticamente
   - O painel do DJ mostra o contador subindo em tempo real via Socket.IO

5. ANIMACOES CSS/WebGL exclusivas de show (pelo menos 4 no MVP):
   - PULSE: circulo pulsando no BPM na cor escolhida
   - FIRE: ondas de fogo subindo na tela
   - OCEAN: ondas azuis fluindo
   - SOLID COLOR: tela inteira de uma cor (base pra formar letras depois)

Leia docs/FEATURE-DJ-PANEL.md pra entender a arquitetura completa, modelo de negocio, e fases futuras. Foque na Fase 1 agora.

IMPORTANTE: git pull origin main antes de comecar. Commit e push depois de cada etapa.
