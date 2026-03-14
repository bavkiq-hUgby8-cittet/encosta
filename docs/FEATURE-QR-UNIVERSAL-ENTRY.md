# FEATURE: QR CODE COMO ENTRADA UNIVERSAL

## A IDEIA

Qualquer pessoa, em qualquer modulo, entra pelo QR code sem cadastro.
Coloca so o nick e ja usa. Depois completa o cadastro quando quiser.

Isso elimina a maior barreira de QUALQUER app: "preciso criar conta pra usar?"
A resposta do Touch? e: NAO. Escaneia e entra.

---

## O PROBLEMA ATUAL

Hoje:
- Pessoa chega no bar, ve o QR code do Touch?
- Escaneia, abre o site
- Tela de cadastro: email, senha, nascimento...
- "Ah, deixa pra la" -- PERDEU O USUARIO

Com a mudanca:
- Pessoa chega no bar, ve o QR code do Touch?
- Escaneia, abre o site
- "Escolha um nick:" → digita "Jake" → ENTROU
- Ja ta usando, pedindo cerveja, dando gorjeta, conectando
- Depois o app pede pra completar cadastro (quando ja ta engajado)

---

## FLUXO POR MODULO

### Restaurante / Bar (operador)
1. Mesa tem QR code (impresso ou no display)
2. Cliente escaneia → abre touch-irl.com/r/[slug-do-lugar]
3. Tela: "Bem-vindo ao [nome do bar]! Escolha um nick:"
4. Digita nick → entra direto no cardapio
5. Pede comida/bebida, paga com Apple Pay/Google Pay
6. Quer dar gorjeta? Touch no celular do garcom → funciona (guest mode)
7. Na hora de sair: "Quer salvar seu historico? Complete seu cadastro"

### Barbearia
1. QR code na recepcao/caixa de som
2. Escaneia → "Escolha um nick:" → "Tyler"
3. Faz check-in automatico (barbeiro recebe notificacao)
4. Cardapio aparece (cerveja, cafe)
5. Touch pro barbeiro = gorjeta
6. Fim: "Quer receber lembrete do proximo corte? Complete cadastro"

### Igreja
1. QR code no banco/parede
2. Escaneia → nick → entra
3. Ve programacao do culto, avisos
4. Touch pra dizimo/oferta
5. "Quer fazer parte da comunidade? Complete cadastro"

### Estacionamento
1. QR code na cancela/totem
2. Escaneia → nick → entra
3. Paga estacionamento
4. Touch com funcionario na saida
5. "Quer recibo por email? Complete cadastro"

### Academia / Gym
1. QR code na entrada
2. Escaneia → nick → check-in feito
3. Ve treino do dia, horarios
4. Touch com coach
5. "Quer tracking de treinos? Complete cadastro"

### DJ Live / Show
1. QR code no telao/ingresso/entrada
2. Escaneia → nick → celular entra no modo Live
3. Animacoes, cores, participa do show
4. Tip pro artista
5. "Quer guardar as conexoes do show? Complete cadastro"

### Karaoke
1. QR code no telao/mesa
2. Escaneia → nick → entra na fila
3. Escolhe musica, canta, vota
4. "Quer salvar suas performances? Complete cadastro"

### Conexao social (Touch entre pessoas)
1. Pessoa A tem conta, pessoa B nao tem
2. B escaneia o QR code do perfil de A
3. "Escolha um nick:" → entra como guest
4. Fazem Touch → conexao criada (B aparece como guest na constelacao de A)
5. "Quer que [A] veja seu perfil completo? Complete cadastro"

---

## TELA DE ENTRADA RAPIDA (wireframe conceitual)

```
+----------------------------------+
|          [logo Touch?]           |
|                                  |
|    Bem-vindo ao [Nome do Local]  |
|                                  |
|    Escolha um nick pra entrar:   |
|                                  |
|    +------------------------+    |
|    |  seu nick aqui...      |    |
|    +------------------------+    |
|                                  |
|    [ ENTRAR ]                    |
|                                  |
|    -------- ou --------          |
|                                  |
|    [ Ja tenho conta → Login ]    |
|                                  |
|    Ao entrar, voce concorda      |
|    com os Termos de Uso          |
+----------------------------------+
```

### Regras do nick:
- Minimo 2 caracteres, maximo 20
- Sem caracteres especiais (so letras, numeros, _)
- Nao precisa ser unico (guest nao tem perfil permanente)
- Mostrado como "~Jake" (o til indica guest)

---

## GUEST vs CADASTRADO (o que muda)

| Funcionalidade | Guest (so nick) | Cadastrado |
|---------------|-----------------|------------|
| Ver cardapio | Sim | Sim |
| Fazer pedido | Sim | Sim |
| Pagar (Apple/Google Pay) | Sim | Sim |
| Dar gorjeta via Touch | Sim | Sim |
| Check-in no local | Sim | Sim |
| Participar do DJ Live | Sim | Sim |
| Participar do Karaoke | Sim | Sim |
| Conectar com outra pessoa | Sim (aparece como ~nick) | Sim |
| Constelacao (MY NETWORK) | Nao (precisa cadastro) | Sim |
| Historico de pedidos | Nao (perde ao fechar) | Sim |
| Receber notificacoes | Nao | Sim |
| Stars / Ranking | Nao | Sim |
| Moedas (coins) | Nao (ganha ao cadastrar) | Sim |
| Revelar identidade | Nao (sempre ~nick) | Sim |
| Ser revelado na constelacao | Nao (fica como silhueta) | Sim |
| Chat apos Touch | Limitado (3 msgs) | Ilimitado |

### A sacada:
- Guest pode TUDO que e instantaneo (pedir, pagar, gorjeta, DJ Live)
- Guest NAO pode o que e PERSISTENTE (constelacao, historico, ranking)
- Isso cria incentivo natural: "quero ver minha constelacao → preciso cadastrar"
- O cadastro nao e barreira de ENTRADA, e incentivo de RETENCAO

---

## PROGRESSIVE REGISTRATION (como pedir o cadastro)

### Momento 1: Apos o primeiro Touch com pessoa (mais eficaz)
"Voce acabou de conectar com [nome]!
Quer guardar essa conexao na sua constelacao?
[Completar cadastro em 30s] [Agora nao]"

### Momento 2: Apos pagar algo
"Pagamento confirmado!
Quer receber o recibo por email?
[Sim, completar cadastro] [Nao, obrigado]"

### Momento 3: Apos participar do DJ Live
"Voce participou do show de [DJ name]!
Quer salvar as [X] conexoes que fez no show?
[Salvar → cadastro] [Perder conexoes]"

### Momento 4: Apos X minutos usando
Barra discreta no topo:
"Crie sua conta e ganhe 50 moedas gratis →"

### Momento 5: Ao tentar ver constelacao
"Sua constelacao esta esperando!
Cadastre-se pra ver todas as suas conexoes.
[Cadastrar] [Continuar como guest]"

### Regra de ouro:
- NUNCA bloquear a acao atual
- SEMPRE mostrar o beneficio de cadastrar (nao a obrigacao)
- Maximo 1 prompt de cadastro por sessao (nao irritar)
- Depois de dispensar, so mostrar de novo na proxima visita

---

## O QR CODE SABE PRA ONDE LEVAR

Cada local/modulo tem seu proprio QR code com contexto:

| QR Code URL | Vai pra |
|-------------|---------|
| touch-irl.com/r/jakes-bar | Cardapio do Jake's Bar |
| touch-irl.com/r/jakes-bar/tip | Tela de gorjeta direta |
| touch-irl.com/b/sharp-cuts | Check-in da barbearia |
| touch-irl.com/g/crossfit-dtla | Check-in da academia |
| touch-irl.com/p/disney-lot-a | Pagamento estacionamento |
| touch-irl.com/c/grace-church | Dizimo/oferta da igreja |
| touch-irl.com/dj/alok-live | Entrar no DJ Live |
| touch-irl.com/k/karaoke-night | Entrar no Karaoke |
| touch-irl.com/u/ramon | Perfil do Ramon (pra Touch social) |

### Estrutura da URL:
- /r/ = restaurant/bar
- /b/ = barber
- /g/ = gym
- /p/ = parking
- /c/ = church
- /dj/ = dj live
- /k/ = karaoke
- /u/ = user profile

Cada URL abre direto no contexto certo. Nick → entra → ja ta usando.

---

## COMO COMUNICAR NO SITE (touch-irl.com)

### Nao precisa ser destaque na home
O QR code e pra quem JA ESTA no local. Nao precisa estar no site principal.
Mas pode ter uma frase simples no site:

> "No app. No signup. Just scan and go."

Ou na secao de como funciona:

> "See a Touch? QR code? Scan it, pick a nickname, and you're in.
> Order food, tip your bartender, join the show -- all in 2 seconds.
> Create an account later if you want to keep your connections."

### No material do operador (B2B):
O QR code e argumento de VENDA pro operador:

> "Your customers don't need to download anything.
> They scan, enter a nickname, and start ordering.
> Zero friction. Maximum conversion."

---

## IMPLEMENTACAO TECNICA (pro arquiteto)

### Guest session:
- Criar guest session no Firebase com ID temporario
- Armazenar nick no localStorage do browser
- Guest session expira em 24h de inatividade
- Se o guest voltar no mesmo browser, recupera o nick

### Transicao guest → cadastrado:
- Quando completa cadastro, todas as acoes da sessao guest
  sao migradas pro perfil permanente
- Touches feitos como guest aparecem na constelacao
- Pedidos feitos como guest aparecem no historico
- O ~nick vira o nick real

### QR code routing:
- Cada operador gera seu QR code no painel
- O QR aponta pra touch-irl.com/[tipo]/[slug]
- O servidor identifica o tipo e redireciona pro modulo certo
- Se o usuario ja tem conta (cookie/localStorage), pula o nick

### Seguranca:
- Guest nao pode acessar dados de outros usuarios
- Guest nao pode alterar configuracoes do operador
- Pagamentos de guest passam pelo mesmo fluxo seguro (Stripe/Apple Pay)
- Rate limit: max 10 pedidos por sessao guest (anti-abuso)

---

## METRICAS DE SUCESSO

| Metrica | Antes (com cadastro) | Depois (QR + nick) | Meta |
|---------|---------------------|--------------------|----|
| Taxa de conversao (scan → uso) | ~15% | ~70% | 5x |
| Tempo ate primeiro pedido | 3-5 min | 15 segundos | 10x mais rapido |
| Taxa de cadastro posterior | N/A | 30% | 1 em 3 guests cadastra |
| Guests que voltam | N/A | 40% | Retencao de guest |
