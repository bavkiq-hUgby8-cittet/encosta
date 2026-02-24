# UltimateDEV -- Assistente de Desenvolvimento por Voz

Ultima atualizacao: 24/02/2026

## O que e

O UltimateDEV e o assistente de voz mais avancado do Touch?. Ele funciona como um programador pessoal: voce fala o que quer por voz e ele planeja, gera codigo, aplica, commita e pusha automaticamente.

Acesso restrito: apenas admin / Top 1 do app.

## Arquitetura

```
[Voce fala por voz]
       |
       v
[OpenAI Realtime API] -- voz em tempo real via WebRTC
       |
       v
[Tool chamada: comando_dev]
       |
       v
[Claude Sonnet 4 (Anthropic)] -- cerebro de planejamento
       |
       v
[Plano tecnico gerado]
       |
       v
[Voce aprova por voz]
       |
       v
[Claude Sonnet 4] -- cerebro de geracao de codigo
       |
       v
[Edicoes aplicadas nos arquivos]
       |
       v
[Git commit + push automatico]
```

A voz usa OpenAI (unico provedor com voz em tempo real via WebRTC).
O cerebro de desenvolvimento usa Claude (Anthropic) por ter janela de contexto de 200k tokens, permitindo ver o codigo inteiro.
Se a ANTHROPIC_API_KEY nao estiver configurada, usa GPT-4o como fallback.

## Variaveis de Ambiente

- `OPENAI_API_KEY` -- para voz em tempo real (obrigatoria)
- `ANTHROPIC_API_KEY` -- para o cerebro de desenvolvimento (recomendada)

Configurar ambas no Render (Environment Variables).

## Custo por Sessao

- $0.25 por sessao de voz (OpenAI Realtime)
- Custo adicional do Claude por chamada de planejamento/codigo (estimativa ~$0.01-0.05 por comando dev)

## Tools Disponiveis (18+)

### Tools do App (heranca do Pro)

| Tool | Descricao |
|------|-----------|
| `navegar_tela` | Navega para uma tela do app (home, history, encounter, etc.) |
| `abrir_perfil` | Abre perfil de uma conexao pelo nome |
| `abrir_chat` | Abre chat com uma conexao pelo nome |
| `iniciar_conexao` | Inicia processo de conexao (scan) |
| `dar_estrela` | Da estrela para uma conexao |
| `enviar_pulse` | Envia pulse no chat ativo |
| `consultar_rede` | Busca dados da rede de conexoes |
| `mostrar_pessoa` | Mostra alguem na constelacao 3D |
| `salvar_nota` | Salva nota pessoal sobre alguem |

### Tools de Desenvolvimento (exclusivas)

| Tool | Descricao | Tempo |
|------|-----------|-------|
| `comando_dev` | Traduz pedido do usuario em instrucao tecnica. Claude gera plano. | ~5-10s |
| `ver_fila_dev` | Mostra fila de comandos pendentes | instant |
| `aprovar_plano` | Aprova plano e executa: Claude gera codigo, aplica, git commit+push | ~15-30s |
| `rejeitar_plano` | Rejeita plano com motivo | instant |

### Tools de Memoria e Aprendizado

| Tool | Descricao |
|------|-----------|
| `aprender_usuario` | Salva preferencias: tom, vocabulario, nomes de telas, topicos |
| `escrever_pensamento` | Anota ideias, reflexoes, decisoes entre sessoes |
| `fazer_backup` | Salva snapshot do estado atual no banco |
| `salvar_arquivo` | Cria/atualiza arquivo no repositorio com commit+push |

## Fluxo de Desenvolvimento Detalhado

### 1. Planejamento (POST /api/dev/command)

Quando voce fala algo como "quero mudar a cor do botao":

- O assistente chama `comando_dev` com a instrucao traduzida
- O servidor envia para o Claude Sonnet 4:
  - Mapa completo de endpoints e funcoes do server.js
  - Lista de todos os arquivos do projeto com numero de linhas
  - Primeiras 200 linhas dos arquivos principais
  - A instrucao do usuario
- Claude retorna um plano tecnico com ate 7 passos
- Status: `planning` -> `planned`

### 2. Aprovacao (POST /api/dev/approve/:commandId)

Quando voce fala "pode fazer" ou "aprova":

- O assistente chama `aprovar_plano`
- O servidor envia para o Claude Sonnet 4:
  - A instrucao original + plano aprovado
  - Conteudo COMPLETO dos arquivos relevantes (nao mais so 3000 chars)
  - Para arquivos muito grandes (3000+ linhas): primeiras 500 + ultimas 500 + trechos relevantes
- Claude retorna array JSON de edicoes: `[{file, old_string, new_string}]`
- Sistema valida cada edicao:
  - old_string deve existir no arquivo
  - old_string deve ser unico (nao ambiguo)
  - Se multiplos matches, rejeita com erro
- Backup automatico antes de editar
- Aplica edicoes nos arquivos
- Git add + commit + push automatico
- Se todas falharem: rollback automatico
- Status: `executing` -> `done` ou `failed` ou `partial`

### 3. Rejeicao (POST /api/dev/reject/:commandId)

Se voce nao gostou do plano, fala "nao" ou "muda isso":

- O assistente chama `rejeitar_plano` com motivo
- Status: `rejected`

## Arquivos Suportados

O cerebro Claude conhece e pode editar TODOS os arquivos do projeto:

- `server.js` -- backend principal
- `public/index.html` -- frontend SPA
- `public/va-test.html` -- pagina de ligacao
- `public/va-admin.html` -- painel admin dos assistentes
- `public/admin.html` -- painel administrativo geral
- `public/operator.html` -- painel do operador
- `public/operator-restaurant.html` -- painel do restaurante
- `public/site.html` -- landing page
- `public/termos.html` -- termos de uso
- Qualquer novo arquivo pode ser criado (old_string vazio + new_string com conteudo)

## Dev Log (Painel Visual)

Na tela de ligacao (va-test.html), quando conectado ao UltimateDEV, aparece um botao no canto superior direito com icone `</>`.

Ao clicar, abre painel deslizante com:

- Lista de todos os comandos dev (mais recentes primeiro)
- Status em tempo real com bolinha colorida:
  - Azul piscando = planejando
  - Roxo = plano pronto (aguardando aprovacao)
  - Amarelo piscando = executando
  - Verde = concluido com sucesso
  - Vermelho = falhou
  - Laranja = parcial (algumas edicoes falharam)
  - Cinza = rejeitado
- Instrucao original do usuario
- Botao "Ver plano" para expandir o plano tecnico
- Resultado da execucao (sucesso/falha com detalhes)
- Data e hora de cada comando

O painel atualiza automaticamente a cada 5 segundos e faz refresh imediato quando tools dev sao chamadas.

## Memoria entre Sessoes

O UltimateDEV salva no Firebase (colecao `ultimateBank`):

- `conversations` -- ultimas 20 mensagens (carregadas no prompt da proxima sessao)
- `devQueue` -- historico de todos os comandos dev com planos e resultados
- `userProfile`:
  - `tone` -- como o usuario se comunica (informal, direto, etc.)
  - `preferences` -- preferencias de design, UX, etc.
  - `vocabulary` -- termos que o usuario usa
  - `screenNames` -- nomes que o usuario da pras telas
  - `lastTopics` -- ultimos topicos discutidos

## Contexto do Usuario

O UltimateDEV recebe o mesmo contexto completo dos outros assistentes:

- Dados pessoais (nome, nickname, estrelas, nivel)
- Conexoes ativas com ultimas 5 mensagens de cada chat
- Convites de jogos, sessoes ativas, resultados
- Estrelas pendentes
- Pedidos de reveal pendentes
- Gorjetas recebidas (7 dias)
- Status da assinatura
- Identidades reveladas
- Horario local do usuario (timezone detectado automaticamente)

## Exemplos Praticos

| Voce fala | O que acontece |
|-----------|----------------|
| "Muda a cor do botao TOUCH pra verde" | Claude identifica o botao no index.html, gera edicao CSS |
| "Adiciona um botao de compartilhar no perfil" | Claude planeja novo elemento HTML + handler JS |
| "Tem um bug no chat, mensagens nao aparecem" | Claude analisa o fluxo de mensagens e propoe fix |
| "Cria uma pagina nova de FAQ" | Claude cria public/faq.html do zero |
| "Documenta o que fizemos hoje" | Usa tool `salvar_arquivo` pra criar docs/changelog.md |
| "Faz backup antes de mexer" | Usa tool `fazer_backup` pra salvar snapshot |
| "Quero que o som de notificacao mude" | Claude busca onde esta o audio e modifica |

## Limitacoes

- So edita arquivos do projeto (nao instala dependencias nem mexe no Render)
- Edicoes muito grandes podem falhar se o old_string nao for unico
- Tempo de resposta do Claude: ~5-10s para plano, ~15-30s para codigo
- Nao tem acesso a logs de producao em tempo real
- Nao faz deploy automatico (o Render faz auto-deploy via GitHub push)

## Endpoints Backend

| Metodo | Endpoint | Descricao |
|--------|----------|-----------|
| POST | `/api/agent/ultimate-session` | Cria sessao de voz UltimateDEV |
| POST | `/api/dev/command` | Cria comando dev (planejamento) |
| GET | `/api/dev/queue/:userId` | Lista fila de comandos |
| POST | `/api/dev/approve/:commandId` | Aprova e executa comando |
| POST | `/api/dev/reject/:commandId` | Rejeita comando |
| POST | `/api/dev/learn` | Salva aprendizado do usuario |
| POST | `/api/dev/conversation` | Salva mensagem da conversa |
| GET | `/api/dev/conversation/:userId` | Busca historico de conversas |
| POST | `/api/dev/thought` | Salva pensamento/reflexao |
| POST | `/api/dev/backup` | Faz backup do estado |
| POST | `/api/dev/save-file` | Salva arquivo com git commit+push |
