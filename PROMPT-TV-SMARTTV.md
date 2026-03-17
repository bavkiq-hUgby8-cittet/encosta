# PROMPT PARA AGENTE: Criar pagina touch-irl.com/tv (Modo TV / Smart TV)

Copie e cole o texto abaixo ao iniciar um novo chat com outro agente:

---

## O Prompt:

```
Voce vai criar a pagina /tv do app "Touch?" (Encosta) -- uma tela de exibicao para Smart TVs de estabelecimentos.

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## ACESSO AO PROJETO

1. PASTA NA MAQUINA: a pasta "encosta" no meu computador
2. GITHUB: https://github.com/bavkiq-hUgby8-cittet/encosta.git
   - Token configurado no remote do git local
3. GIT CONFIG: Email: ramonnvc@hotmail.com | Nome: Ramon

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta
2. git pull origin main
3. Leia PROMPT-NOVO-CHAT.md (contexto geral do projeto)
4. Leia este prompt inteiro antes de comecar a codar
5. Olhe operator.html e server.js pra entender o sistema de eventos

## REGRAS DE TRABALHO

- SEMPRE git pull origin main ANTES de editar qualquer arquivo
- Sempre commit com mensagem descritiva + push apos cada tarefa
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no codigo -- usamos SVGs vetoriais para icones
- Valide JS com node -e antes de cada commit

## CONTEXTO RAPIDO

Touch? e um app de conexao por proximidade usando som ultrassonico.
Stack: Node.js + Express + Socket.IO + Firebase.
Deploy: Render (touch-irl.com via Cloudflare).

O app tem um painel do operador (operator.html) que donos de estabelecimentos
usam no computador/tablet pra gerenciar eventos, check-ins, modulos (restaurante,
karaoke, DJ Live, estacionamento, barbearia, etc).

## O QUE VOCE VAI CRIAR

Uma nova pagina: `public/tv.html` acessivel em `touch-irl.com/tv`

### Conceito

E uma TELA DE EXIBICAO PUBLICA. O dono do bar/restaurante/evento conecta uma
Smart TV na internet, abre o navegador da TV, entra em touch-irl.com/tv.
A TV fica rodando sozinha mostrando conteudo ao vivo do evento.

O operador NAO controla nada pela TV. Ele controla tudo pelo painel do operador
(operator.html) no notebook/tablet separado. A TV so MOSTRA.

### Fluxo de Vinculacao

1. Operador abre touch-irl.com/tv na Smart TV
2. Aparece tela escura elegante com logo "Touch?" e um QR code grande
3. O QR code contem um link tipo: touch-irl.com/tv/pair?code=XXXX (codigo de 6 digitos)
4. Operador pega o celular, le o QR code
5. Link abre no celular, mostra lista dos eventos ativos do operador
6. Operador escolhe qual evento vincular a essa TV
7. TV detecta via Socket.IO que foi vinculada, QR code some, comeca a exibir conteudo
8. Vinculacao fica salva na sessao -- se a TV recarregar, reconecta automaticamente

### O que a TV exibe (abas que alternam automaticamente ou por controle remoto)

A TV deve ter "abas" ou "modos" que alternam automaticamente a cada X segundos
(tipo 15-30s), ou o operador pode navegar com as setas do controle remoto da TV.

**Aba 1 - Bem-vindo / QR Check-in**
- Logo do evento grande no centro
- QR code para check-in rapido (link touch-irl.com/e/{eventId})
- Frase de boas-vindas do evento
- Contador de pessoas presentes (atualiza em tempo real via socket)
- Fundo com animacao suave (pode ser o estilo constelacao do app)

**Aba 2 - Ranking ao vivo**
- Top 10 pessoas com mais moedas no evento
- Avatar/nick, quantidade de moedas, estrelas
- Animacao quando alguem sobe de posicao
- Atualiza em tempo real

**Aba 3 - Feed de atividade**
- Ultimos check-ins ("Fulano acabou de chegar!")
- Ultimas gorjetas ("Fulano deu gorjeta de R$10!")
- Ultimas estrelas dadas
- Estilo ticker/feed que vai rolando

**Aba 4 - Karaoke (se modulo ativo)**
- Quem esta cantando agora + nome da musica
- Fila dos proximos cantores
- Placar de votacao/aplausos
- So aparece se ev.modules.karaoke === true

**Aba 5 - DJ Live (se modulo ativo)**
- Nome do DJ + visualizacao das ondas/animacao
- BPM atual
- Cor do tema do DJ
- So aparece se ev.djLive.broadcasting === true

### Requisitos Tecnicos

1. **Arquivo:** `public/tv.html` (pagina standalone, nao faz parte do SPA index.html)
2. **Rota no server.js:** `app.get('/tv', ...)` servindo o arquivo, e `app.get('/tv/pair', ...)` para a pagina de vinculacao no celular
3. **Socket.IO:** A TV conecta via socket, entra na room `tv:{eventId}` apos vincular
4. **Endpoints necessarios no server.js:**
   - POST /api/tv/generate-code -- gera codigo de pareamento temporario (expira em 5min)
   - POST /api/tv/pair -- celular envia {code, eventId, userId} para vincular
   - GET /api/tv/status/:code -- TV faz polling ou usa socket para saber se foi vinculada
   - GET /api/tv/feed/:eventId -- dados atuais do evento para a TV exibir
5. **Socket events:**
   - `tv-paired` -- emitido para a TV quando pareamento completa
   - `tv-update` -- emitido para room `tv:{eventId}` quando algo muda (checkin, gorjeta, etc)
   - `tv-karaoke-update` -- dados do karaoke ao vivo
   - `tv-dj-update` -- dados do DJ ao vivo
6. **Design:**
   - Fundo escuro (#050508 ou similar, mesma paleta do app)
   - Fontes grandes (legivel de longe na TV)
   - Animacoes suaves, sem nada que cause flicker
   - Responsivo mas otimizado para 1920x1080 (Full HD)
   - Sem scroll -- tudo cabe em uma tela
7. **Navegacao por controle remoto:**
   - Setas esquerda/direita: alternar abas manualmente
   - Se ninguem apertar nada por 30s, volta a alternar automaticamente
   - Teclas: ArrowLeft, ArrowRight, Enter (JavaScript keydown events)
8. **Persistencia:**
   - Salvar eventId vinculado em localStorage da TV
   - Se a TV recarregar e tiver eventId salvo, reconectar direto sem QR code
   - Se o evento nao existir mais, voltar pra tela de QR code

### Estilo Visual de Referencia

Olhe o design do operator.html (gradientes deep purple, glass morphism)
e do index.html (constelacao com particulas, tema escuro).
A TV deve parecer premium e impressionar quem ve no estabelecimento.

### Dados ja disponiveis no server.js que voce pode usar

- `db.operatorEvents[eventId]` -- dados do evento, participantes, modulos
- `db.operatorEvents[eventId].djLive` -- dados do DJ ao vivo
- Karaoke: endpoints em /api/event/:id/karaoke
- Check-ins via socket events: `checkin-created`, `entry-paid`
- Gorjetas: `tip-received` socket event
- Ranking: `calcScore(userId)` no server.js

### NAO FAZER

- NAO adicionar controles de operador na TV (a TV e so exibicao)
- NAO modificar o operator.html existente (so adicionar os socket emits necessarios)
- NAO quebrar funcionalidades existentes
- NAO usar emojis no codigo
- NAO fazer a TV depender de login -- o QR code e o unico metodo de vinculacao
```

---

## Notas para o Ramon

- Este prompt cria a pagina `touch-irl.com/tv` para Smart TVs
- O agente vai criar `public/tv.html` + uma pagina de pareamento + endpoints no server.js
- A TV so exibe conteudo, nao controla nada
- O operador vincula a TV ao evento pelo QR code usando o celular
- Depois de vinculada, a TV mostra ranking, feed, karaoke, DJ ao vivo etc
- O controle remoto da TV pode alternar entre as abas
