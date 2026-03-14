// ══════════════════════════════════════════════════════════════
// TOUCH? SITE ASSISTANT -- BASE DE CONHECIMENTO COMPLETA
// ══════════════════════════════════════════════════════════════
// Cada topico tem: keywords (pra matching), resposta em PT, EN, ES
// O assistant pega a pergunta, encontra o topico mais relevante,
// e responde de forma didatica e objetiva.

const KNOWLEDGE = [

  // ── O QUE E O TOUCH? ──
  {
    id: 'what-is',
    keywords: ['o que e', 'what is', 'que es', 'explica', 'explain', 'sobre o touch', 'about touch', 'pra que serve', 'what for', 'what is touch'],
    weight: 1,
    pt: `O Touch? e uma plataforma de conexao por proximidade. Funciona assim: dois celulares se aproximam com as telas viradas um pro outro (tela contra tela), os alto-falantes conversam por som ultrassonico (inaudivel), e uma conexao nasce.

Tudo acontece pelo navegador, sem precisar baixar app nenhum. Funciona pra:

- Check-in automatico em estabelecimentos (bares, restaurantes, barbearias, academias)
- Pagamentos e gorjetas instantaneas
- Conexao entre pessoas (tipo trocar contato, so que melhor)
- Cardapio digital, pedidos e pagamentos sem fila
- Shows e eventos com luzes sincronizadas nos celulares da plateia

O som que conecta e de 18-22 kHz -- completamente inaudivel pro ouvido humano, mas o microfone do celular detecta.`,
    en: `Touch? is a proximity connection platform. It works like this: two phones get close with screens facing each other (screen-to-screen), the speakers communicate via ultrasonic sound (inaudible), and a connection is born.

Everything happens in the browser, no app download needed. It works for:

- Automatic check-in at businesses (bars, restaurants, barbershops, gyms)
- Instant payments and tips
- Connecting people (like exchanging contacts, but better)
- Digital menu, orders and payments without lines
- Shows and events with synchronized lights on the audience's phones

The connecting sound is 18-22 kHz -- completely inaudible to the human ear, but the phone's microphone detects it.`,
    es: `Touch? es una plataforma de conexion por proximidad. Funciona asi: dos celulares se acercan con las pantallas una frente a la otra (pantalla contra pantalla), los altavoces conversan por sonido ultrasonico (inaudible), y una conexion nace.

Todo sucede en el navegador, sin necesidad de descargar ninguna app. Funciona para:

- Check-in automatico en establecimientos (bares, restaurantes, barberias, gimnasios)
- Pagos y propinas instantaneas
- Conexion entre personas (como intercambiar contacto, pero mejor)
- Menu digital, pedidos y pagos sin fila
- Shows y eventos con luces sincronizadas en los celulares del publico

El sonido de conexion es de 18-22 kHz -- completamente inaudible para el oido humano, pero el microfono del celular lo detecta.`
  },

  // ── COMO FUNCIONA O SOM ──
  {
    id: 'ultrasonic',
    keywords: ['som', 'sound', 'sonido', 'ultrassonico', 'ultrasonic', 'ultrasonico', 'frequencia', 'frequency', 'frecuencia', 'khz', 'inaudivel', 'inaudible', 'alto-falante', 'speaker', 'altavoz', 'microfone', 'microphone'],
    weight: 2,
    pt: `O Touch? usa som ultrassonico entre 18 e 22 kHz. Essa faixa e acima do que o ouvido humano consegue ouvir, mas os microfones dos celulares detectam perfeitamente.

Quando dois celulares se aproximam tela contra tela:
1. Um celular emite um "handshake" pelo alto-falante (som inaudivel)
2. O outro celular capta pelo microfone
3. Os dois trocam um ID unico
4. O servidor confirma a conexao

Funciona tambem com caixa de som: o estabelecimento coloca uma caixa tocando o som ultrassonico em loop. Quando o cliente abre o Touch? perto, o celular dele detecta e faz check-in automatico.

O alcance e de cerca de 1-3 metros, perfeito pra proximidade real.`,
    en: `Touch? uses ultrasonic sound between 18 and 22 kHz. This range is above what the human ear can hear, but phone microphones detect it perfectly.

When two phones get close screen-to-screen:
1. One phone emits a "handshake" through its speaker (inaudible sound)
2. The other phone picks it up through its microphone
3. Both exchange a unique ID
4. The server confirms the connection

It also works with speakers: the business plays ultrasonic audio on loop. When a customer opens Touch? nearby, their phone detects it and checks in automatically.

Range is about 1-3 meters, perfect for real proximity.`,
    es: `Touch? usa sonido ultrasonico entre 18 y 22 kHz. Este rango esta por encima de lo que el oido humano puede escuchar, pero los microfonos de los celulares lo detectan perfectamente.

Cuando dos celulares se acercan pantalla contra pantalla:
1. Un celular emite un "handshake" por su altavoz (sonido inaudible)
2. El otro celular lo capta por su microfono
3. Ambos intercambian un ID unico
4. El servidor confirma la conexion

Tambien funciona con altavoces: el establecimiento pone un altavoz reproduciendo el audio ultrasonico en bucle. Cuando un cliente abre Touch? cerca, su celular lo detecta y hace check-in automaticamente.

El alcance es de aproximadamente 1-3 metros, perfecto para proximidad real.`
  },

  // ── RESTAURANTE / BAR ──
  {
    id: 'restaurant',
    keywords: ['restaurante', 'restaurant', 'bar', 'cafe', 'lanchonete', 'pizzaria', 'cardapio', 'menu', 'pedido', 'order', 'comida', 'food', 'bebida', 'drink', 'garcom', 'waiter', 'mesa', 'table'],
    weight: 2,
    pt: `Pra restaurantes, bares e cafes, o Touch? funciona assim:

1. O cliente chega e faz check-in (encosta o celular na caixa de som ou escaneia o QR code na entrada)
2. O cardapio digital abre automaticamente no celular dele
3. Ele escolhe o que quer e faz o pedido direto do celular
4. O pedido aparece na cozinha/bar em tempo real
5. Quando termina, paga pelo celular (cartao, Pix, Apple Pay)
6. Pode dar gorjeta pro garcom direto no app

Voce nao precisa de tablet em cada mesa, nao precisa de cardapio impresso, e o garcom nao precisa anotar pedido. Tudo digital, tudo automatico.

O setup e simples: coloca uma caixa de som na entrada tocando o audio ultrassonico, e QR codes nas mesas. Pronto.`,
    en: `For restaurants, bars, and cafes, Touch? works like this:

1. Customer arrives and checks in (touches phone to speaker or scans QR code at entrance)
2. The digital menu opens automatically on their phone
3. They choose what they want and order directly from their phone
4. The order appears in the kitchen/bar in real time
5. When done, they pay through their phone (card, mobile pay)
6. They can tip the waiter directly through the app

You don't need tablets at each table, no printed menus, and waiters don't need to take orders. Everything digital, everything automatic.

Setup is simple: place a speaker at the entrance playing ultrasonic audio, and QR codes on tables. Done.`,
    es: `Para restaurantes, bares y cafes, Touch? funciona asi:

1. El cliente llega y hace check-in (acerca el celular al altavoz o escanea el codigo QR en la entrada)
2. El menu digital se abre automaticamente en su celular
3. Elige lo que quiere y hace el pedido directo desde su celular
4. El pedido aparece en la cocina/bar en tiempo real
5. Al terminar, paga por el celular (tarjeta, pago movil)
6. Puede dar propina al mesero directo en la app

No necesitas tablets en cada mesa, ni menus impresos, y los meseros no necesitan anotar pedidos. Todo digital, todo automatico.

La configuracion es simple: coloca un altavoz en la entrada reproduciendo audio ultrasonico, y codigos QR en las mesas. Listo.`
  },

  // ── FOOD TRUCK ──
  {
    id: 'foodtruck',
    keywords: ['food truck', 'foodtruck', 'trailer', 'ambulante', 'food cart', 'caminhao', 'truck'],
    weight: 3,
    pt: `Pra food trucks, o Touch? e perfeito porque resolve o maior problema: a fila.

Como funciona:
1. Voce coloca uma caixa de som pequena no balcao do food truck tocando o audio ultrassonico
2. Cola um QR code Touch? no vidro/lateral do truck
3. O cliente chega, escaneia o QR ou encosta o celular na caixa
4. O cardapio abre no celular dele, ele escolhe e faz o pedido
5. Ele paga pelo celular, sem precisar de maquininha
6. Pode ir sentar e espera -- quando estiver pronto, recebe notificacao

O cliente nao precisa ficar na fila pra pedir, nao precisa ficar esperando em pe. Pede de onde estiver, paga de onde estiver.

Pra voce como dono: nao precisa de maquininha de cartao, nao precisa de troco, ve todos os pedidos no celular. Custo zero de equipamento -- so sua caixa de som bluetooth que voce ja tem.`,
    en: `For food trucks, Touch? is perfect because it solves the biggest problem: the line.

How it works:
1. You place a small speaker on the food truck counter playing ultrasonic audio
2. Stick a Touch? QR code on the truck's window/side
3. Customer arrives, scans the QR or touches their phone to the speaker
4. Menu opens on their phone, they choose and place the order
5. They pay through their phone, no card machine needed
6. They can sit down and wait -- when it's ready, they get notified

The customer doesn't need to stand in line to order, doesn't need to wait standing up. Order from anywhere, pay from anywhere.

For you as owner: no card machine needed, no change to give, see all orders on your phone. Zero equipment cost -- just your bluetooth speaker you already have.`,
    es: `Para food trucks, Touch? es perfecto porque resuelve el mayor problema: la fila.

Como funciona:
1. Colocas un altavoz pequeno en el mostrador del food truck reproduciendo audio ultrasonico
2. Pegas un codigo QR Touch? en el vidrio/lateral del truck
3. El cliente llega, escanea el QR o acerca su celular al altavoz
4. El menu se abre en su celular, elige y hace el pedido
5. Paga por el celular, sin maquina de tarjeta
6. Puede sentarse a esperar -- cuando este listo, recibe notificacion

El cliente no necesita hacer fila para pedir, ni esperar parado. Pide desde donde sea, paga desde donde sea.

Para ti como dueno: no necesitas maquina de tarjeta, ni cambio, ves todos los pedidos en tu celular. Costo cero de equipo -- solo tu altavoz bluetooth que ya tienes.`
  },

  // ── BARBEARIA ──
  {
    id: 'barber',
    keywords: ['barbearia', 'barbershop', 'barber', 'barberia', 'cabelo', 'hair', 'corte', 'cut', 'barba', 'beard', 'salao', 'salon'],
    weight: 2,
    pt: `Pra barbearias e saloes, o Touch? transforma a experiencia:

1. Cliente chega e faz check-in na caixa de som da recepcao
2. O barbeiro dele recebe notificacao de que o cliente chegou
3. O cliente ja pode navegar pelo cardapio de servicos e bebidas
4. Enquanto corta o cabelo, pede uma cerveja pelo celular
5. Alguem serve a cerveja pra ele na cadeira
6. Quando termina, paga tudo pelo celular (corte + cerveja + gorjeta)

Pra voce como dono:
- Check-in automatico (sabe quem chegou, a que horas, quem e o barbeiro)
- Controle de fila inteligente
- Cardapio de bebidas e produtos sem precisar de garcom
- Historico de cada cliente (ultimo corte, preferencias)
- Dashboard com dados: tempo medio, ticket medio, horarios de pico`,
    en: `For barbershops and salons, Touch? transforms the experience:

1. Client arrives and checks in at the reception speaker
2. Their barber gets notified that the client arrived
3. Client can browse the service and drinks menu
4. While getting a haircut, they order a beer from their phone
5. Someone serves the beer to them in the chair
6. When done, pay everything through the phone (cut + beer + tip)

For you as owner:
- Automatic check-in (know who arrived, what time, who's their barber)
- Smart queue management
- Drink and product menu without needing a waiter
- Client history (last cut, preferences)
- Dashboard with data: average time, average ticket, peak hours`,
    es: `Para barberias y salones, Touch? transforma la experiencia:

1. El cliente llega y hace check-in en el altavoz de la recepcion
2. Su barbero recibe notificacion de que el cliente llego
3. El cliente puede navegar el menu de servicios y bebidas
4. Mientras le cortan el pelo, pide una cerveza desde su celular
5. Alguien le sirve la cerveza en la silla
6. Al terminar, paga todo por el celular (corte + cerveza + propina)

Para ti como dueno:
- Check-in automatico (sabes quien llego, a que hora, quien es su barbero)
- Control de fila inteligente
- Menu de bebidas y productos sin necesitar mesero
- Historial de cada cliente (ultimo corte, preferencias)
- Dashboard con datos: tiempo promedio, ticket promedio, horarios pico`
  },

  // ── ACADEMIA / GYM ──
  {
    id: 'gym',
    keywords: ['academia', 'gym', 'gimnasio', 'treino', 'workout', 'ejercicio', 'musculacao', 'fitness', 'crossfit', 'personal', 'catraca', 'turnstile'],
    weight: 2,
    pt: `Pra academias, o Touch? substitui carteirinha, catraca e recepcao:

1. O aluno chega e encosta o celular na caixa de som da entrada
2. A catraca libera automaticamente (sem cartao, sem biometria)
3. O treino do dia aparece no celular dele
4. Pode registrar series e pesos direto no celular
5. Na saida, o check-out e automatico

Pra voce como dono:
- Sabe exatamente quem ta na academia a qualquer momento
- Controle de acesso sem investir em catracas biometricas caras
- Ficha de treino digital (sem papel, sem perder)
- Dados de frequencia de cada aluno
- Pode enviar avisos e promocoes pra quem ta la dentro`,
    en: `For gyms, Touch? replaces membership cards, turnstiles, and reception:

1. Member arrives and touches their phone to the entrance speaker
2. Turnstile opens automatically (no card, no biometrics)
3. Today's workout appears on their phone
4. They can log sets and weights directly on their phone
5. On exit, check-out is automatic

For you as owner:
- Know exactly who's in the gym at any moment
- Access control without investing in expensive biometric turnstiles
- Digital workout plans (no paper, no losing them)
- Attendance data for each member
- Can send notifications and promotions to people inside`,
    es: `Para gimnasios, Touch? reemplaza la tarjeta de membresia, los torniquetes y la recepcion:

1. El miembro llega y acerca su celular al altavoz de la entrada
2. El torniquete se abre automaticamente (sin tarjeta, sin biometria)
3. El entrenamiento del dia aparece en su celular
4. Puede registrar series y pesos directo en su celular
5. A la salida, el check-out es automatico

Para ti como dueno:
- Sabes exactamente quien esta en el gimnasio en cualquier momento
- Control de acceso sin invertir en torniquetes biometricos caros
- Fichas de entrenamiento digitales (sin papel, sin perderlas)
- Datos de asistencia de cada miembro
- Puedes enviar avisos y promociones a quienes estan adentro`
  },

  // ── GORJETA / TIP ──
  {
    id: 'tips',
    keywords: ['gorjeta', 'tip', 'propina', 'tipping', 'pagar', 'pay', 'pagamento', 'payment', 'pago', 'dinheiro', 'money', 'dinero', 'musico', 'musician', 'musico', 'artista', 'artist'],
    weight: 2,
    pt: `O sistema de gorjetas do Touch? e um dos recursos mais poderosos. Funciona assim:

1. Qualquer pessoa pode receber gorjetas: garcons, barbeiros, musicos de rua, entregadores
2. O cliente so encosta o celular no do prestador (ou escaneia o QR)
3. Escolhe o valor da gorjeta
4. Paga por cartao, Pix ou Apple Pay
5. O dinheiro vai direto pra pessoa

Pra musicos de rua e street: coloca uma caixa de som no chao com QR code. As pessoas passam, escaneiam, e dap a gorjeta sem precisar de dinheiro trocado.

Pra garcons: no final da refeicao, o cliente pode dar gorjeta direto pelo celular sem precisar pedir ao caixa.

A taxa e de apenas 5-10% sobre a gorjeta. O resto vai integralmente pro trabalhador.

Mercado de gorjetas digitais nos EUA: mais de $50 bilhoes por ano.`,
    en: `Touch?'s tipping system is one of the most powerful features. Here's how it works:

1. Anyone can receive tips: waiters, barbers, street musicians, delivery people
2. The customer just touches their phone to the worker's (or scans the QR)
3. Chooses the tip amount
4. Pays by card, mobile pay
5. Money goes directly to the person

For street musicians: place a speaker on the ground with a QR code. People walk by, scan, and tip without needing cash.

For waiters: at the end of the meal, the customer can tip directly through their phone without asking the cashier.

The fee is only 5-10% on the tip. The rest goes entirely to the worker.

Digital tipping market in the US: over $50 billion per year.`,
    es: `El sistema de propinas de Touch? es uno de los recursos mas poderosos. Funciona asi:

1. Cualquier persona puede recibir propinas: meseros, barberos, musicos callejeros, repartidores
2. El cliente solo acerca su celular al del trabajador (o escanea el QR)
3. Elige el monto de la propina
4. Paga por tarjeta o pago movil
5. El dinero va directo a la persona

Para musicos callejeros: coloca un altavoz en el suelo con codigo QR. La gente pasa, escanea, y da propina sin necesitar efectivo.

Para meseros: al final de la comida, el cliente puede dar propina directo por su celular sin pedir al cajero.

La comision es de solo 5-10% sobre la propina. El resto va integramente al trabajador.

Mercado de propinas digitales en EE.UU.: mas de $50 mil millones al ano.`
  },

  // ── SHOWS / DJ / EVENTOS ──
  {
    id: 'events-dj',
    keywords: ['show', 'evento', 'event', 'dj', 'festival', 'concerto', 'concert', 'concierto', 'luz', 'light', 'led', 'celular', 'phone', 'plateia', 'audience', 'publico', 'crowd', 'coldplay', 'live', 'palco', 'stage'],
    weight: 2,
    pt: `O Touch? Live transforma shows e eventos. O DJ ou artista controla os celulares da plateia em tempo real:

1. O som do PA (sistema de som do palco) emite a frequencia ultrassonica
2. Todos os celulares com Touch? aberto se conectam automaticamente
3. O DJ abre o painel de controle e comanda as cores e animacoes
4. Os celulares da plateia viram "pixels" -- acendem, mudam de cor, fazem ondas

Imagina tipo um show do Coldplay, mas sem precisar comprar pulseiras LED caras ($400.000 por evento). Cada pessoa ja tem o "LED" no bolso: o celular.

O DJ pode:
- Fazer ondas de cor pela plateia
- Escrever palavras com os celulares (como num estadio)
- Sincronizar com o BPM da musica
- Dividir a plateia em setores de cores diferentes
- Criar momentos especiais (proposta de casamento, aniversario)

Funciona pra shows de 100 a 100.000 pessoas.`,
    en: `Touch? Live transforms shows and events. The DJ or artist controls the audience's phones in real time:

1. The PA system emits ultrasonic frequency
2. All phones with Touch? open connect automatically
3. The DJ opens the control panel and commands colors and animations
4. The audience's phones become "pixels" -- they light up, change colors, create waves

Imagine like a Coldplay show, but without buying expensive LED wristbands ($400,000 per event). Each person already has the "LED" in their pocket: their phone.

The DJ can:
- Create color waves across the audience
- Write words with the phones (like in a stadium)
- Sync with the music's BPM
- Divide the audience into color sections
- Create special moments (marriage proposal, birthday)

Works for shows from 100 to 100,000 people.`,
    es: `Touch? Live transforma shows y eventos. El DJ o artista controla los celulares del publico en tiempo real:

1. El sistema de sonido del escenario emite frecuencia ultrasonica
2. Todos los celulares con Touch? abierto se conectan automaticamente
3. El DJ abre el panel de control y comanda colores y animaciones
4. Los celulares del publico se vuelven "pixeles" -- se encienden, cambian de color, hacen olas

Imagina como un show de Coldplay, pero sin comprar pulseras LED caras ($400,000 por evento). Cada persona ya tiene el "LED" en su bolsillo: su celular.

El DJ puede:
- Crear olas de color por el publico
- Escribir palabras con los celulares (como en un estadio)
- Sincronizar con el BPM de la musica
- Dividir el publico en sectores de colores diferentes
- Crear momentos especiales (propuesta de matrimonio, cumpleanos)

Funciona para shows de 100 a 100,000 personas.`
  },

  // ── IGREJA ──
  {
    id: 'church',
    keywords: ['igreja', 'church', 'iglesia', 'culto', 'missa', 'worship', 'pastor', 'padre', 'religiao', 'religion', 'fe', 'faith'],
    weight: 2,
    pt: `Pra igrejas e comunidades religiosas, o Touch? simplifica tudo:

1. Os membros fazem check-in ao chegar (encostam o celular ou escaneiam QR)
2. O programa do culto/missa aparece no celular
3. Podem acompanhar letras de musica em tempo real
4. Dizimo e ofertas digitais (sem precisar passar o saquinho)
5. Cadastro de visitantes automatico

Pra a administracao:
- Controle de presenca automatico (sabe quem veio, quantos vieram)
- Dizimo digital seguro e rastreavel
- Comunicacao direta com os membros
- Eventos e programacoes no celular de todos
- Relatorios de frequencia e financeiros`,
    en: `For churches and religious communities, Touch? simplifies everything:

1. Members check in when arriving (touch phone or scan QR)
2. The service program appears on their phone
3. They can follow song lyrics in real time
4. Digital tithes and offerings (no passing the plate)
5. Automatic visitor registration

For administration:
- Automatic attendance tracking (know who came, how many)
- Secure and trackable digital tithing
- Direct communication with members
- Events and schedules on everyone's phone
- Attendance and financial reports`,
    es: `Para iglesias y comunidades religiosas, Touch? simplifica todo:

1. Los miembros hacen check-in al llegar (acercan celular o escanean QR)
2. El programa del culto/misa aparece en su celular
3. Pueden seguir letras de canciones en tiempo real
4. Diezmos y ofrendas digitales (sin pasar la canasta)
5. Registro automatico de visitantes

Para la administracion:
- Control de asistencia automatico (sabes quien vino, cuantos vinieron)
- Diezmo digital seguro y rastreable
- Comunicacion directa con los miembros
- Eventos y programaciones en el celular de todos
- Reportes de asistencia y financieros`
  },

  // ── ESTACIONAMENTO ──
  {
    id: 'parking',
    keywords: ['estacionamento', 'parking', 'estacionamiento', 'carro', 'car', 'auto', 'veiculo', 'vehicle', 'vehiculo', 'vaga', 'spot', 'cancela', 'barrier', 'pedagio', 'toll'],
    weight: 2,
    pt: `Pra estacionamentos, o Touch? elimina filas e maquininhas:

1. O motorista chega na cancela
2. O funcionario encosta o celular no celular do motorista (ou o motorista escaneia o QR)
3. Check-in feito, a cancela abre
4. Na saida, o mesmo processo: encosta, paga, sai
5. Pagamento instantaneo pelo celular

Funciona pra estacionamentos de shopping, estadio, aeroporto, eventos. Em estacionamentos grandes (tipo Disney, festivais), o fluxo e rapido: varias cancelas ao mesmo tempo, cada funcionario com um celular dando Touch nos motoristas.

Pra voce como dono:
- Sem maquininhas de cartao
- Sem trocos
- Controle de vagas em tempo real
- Relatorio de faturamento automatico
- Funciona offline parcialmente (o Touch e por som, nao precisa de internet no momento da conexao)`,
    en: `For parking lots, Touch? eliminates lines and card machines:

1. Driver arrives at the barrier
2. Attendant touches their phone to the driver's phone (or driver scans QR)
3. Check-in done, barrier opens
4. On exit, same process: touch, pay, leave
5. Instant payment through phone

Works for mall, stadium, airport, event parking. In large lots (like Disney, festivals), flow is fast: multiple gates at once, each attendant with a phone touching drivers'.

For you as owner:
- No card machines
- No change needed
- Real-time spot tracking
- Automatic revenue reports
- Works partially offline (Touch is by sound, no internet needed at connection moment)`,
    es: `Para estacionamientos, Touch? elimina filas y maquinas de tarjeta:

1. El conductor llega a la barrera
2. El empleado acerca su celular al del conductor (o el conductor escanea el QR)
3. Check-in hecho, la barrera se abre
4. A la salida, el mismo proceso: acercar, pagar, salir
5. Pago instantaneo por el celular

Funciona para estacionamientos de centros comerciales, estadios, aeropuertos, eventos. En estacionamientos grandes (tipo Disney, festivales), el flujo es rapido: varias barreras al mismo tiempo, cada empleado con un celular haciendo Touch a los conductores.

Para ti como dueno:
- Sin maquinas de tarjeta
- Sin cambio
- Control de lugares en tiempo real
- Reporte de facturacion automatico
- Funciona parcialmente offline (Touch es por sonido, no necesita internet al momento de la conexion)`
  },

  // ── PRECO / CUSTO ──
  {
    id: 'pricing',
    keywords: ['preco', 'price', 'precio', 'custo', 'cost', 'costo', 'quanto custa', 'how much', 'cuanto cuesta', 'gratis', 'free', 'gratuito', 'plano', 'plan', 'assinatura', 'subscription', 'suscripcion', 'pagar', 'cobrar'],
    weight: 2,
    pt: `O Touch? tem opcoes pra todos os tamanhos:

Pra estabelecimentos:
- Starter (gratis): ate 100 check-ins/mes, funcionalidades basicas
- Pro ($29/mes): ate 1.000 check-ins, cardapio digital, pedidos
- Business ($99/mes): ate 10.000, analytics avancado, multi-funcionarios
- Enterprise ($999/mes): ate 100.000, API, customizacao total

Pra consumidores (usuarios finais):
- Usar e gratis! Abrir o Touch?, fazer check-in, ver cardapio, pagar
- Touch Coins pra conexoes entre pessoas: pacotes a partir de $0.99

Pra DJs e eventos (Touch? Live):
- Pay-per-event a partir de $29 (ate 500 celulares)
- Planos mensais pra venues que fazem eventos regulares

A unica coisa que o estabelecimento precisa investir: uma caixa de som bluetooth (que a maioria ja tem). Zero hardware especial.`,
    en: `Touch? has options for all sizes:

For businesses:
- Starter (free): up to 100 check-ins/month, basic features
- Pro ($29/month): up to 1,000 check-ins, digital menu, orders
- Business ($99/month): up to 10,000, advanced analytics, multi-staff
- Enterprise ($999/month): up to 100,000, API, full customization

For consumers (end users):
- Using it is free! Open Touch?, check in, view menu, pay
- Touch Coins for connections between people: packs starting at $0.99

For DJs and events (Touch? Live):
- Pay-per-event starting at $29 (up to 500 phones)
- Monthly plans for venues with regular events

The only thing the business needs to invest: a bluetooth speaker (which most already have). Zero special hardware.`,
    es: `Touch? tiene opciones para todos los tamanos:

Para establecimientos:
- Starter (gratis): hasta 100 check-ins/mes, funcionalidades basicas
- Pro ($29/mes): hasta 1,000 check-ins, menu digital, pedidos
- Business ($99/mes): hasta 10,000, analytics avanzado, multi-empleados
- Enterprise ($999/mes): hasta 100,000, API, personalizacion total

Para consumidores (usuarios finales):
- Usar es gratis! Abrir Touch?, hacer check-in, ver menu, pagar
- Touch Coins para conexiones entre personas: paquetes desde $0.99

Para DJs y eventos (Touch? Live):
- Pago por evento desde $29 (hasta 500 celulares)
- Planes mensuales para venues con eventos regulares

Lo unico que el establecimiento necesita invertir: un altavoz bluetooth (que la mayoria ya tiene). Cero hardware especial.`
  },

  // ── COMO COMECAR / SETUP ──
  {
    id: 'setup',
    keywords: ['comecar', 'start', 'empezar', 'setup', 'configurar', 'configure', 'instalar', 'install', 'registrar', 'register', 'cadastro', 'signup', 'criar conta', 'create account', 'primeiro passo', 'first step'],
    weight: 2,
    pt: `Comecar com o Touch? e super simples. Dois minutos:

1. Acesse touch-irl.com no celular
2. Crie uma conta (nickname, email, data de nascimento)
3. Se voce e dono de negocio: clique em "Operador" e crie seu estabelecimento
4. No painel do operador, ative os modulos que precisa (cardapio, checkin, etc.)
5. Na aba "Materiais", baixe o QR code e o audio ultrassonico
6. Coloque o QR na entrada e o audio tocando na caixa de som
7. Pronto! Clientes ja podem se conectar

Nao precisa baixar app (funciona no navegador), nao precisa de hardware especial, nao precisa de tecnico pra instalar. Voce mesmo faz em 2 minutos.`,
    en: `Getting started with Touch? is super simple. Two minutes:

1. Go to touch-irl.com on your phone
2. Create an account (nickname, email, date of birth)
3. If you're a business owner: click "Operator" and create your establishment
4. In the operator panel, activate the modules you need (menu, checkin, etc.)
5. In the "Materials" tab, download your QR code and ultrasonic audio
6. Place the QR at the entrance and play the audio on your speaker
7. Done! Customers can now connect

No app download needed (works in the browser), no special hardware, no technician needed. You do it yourself in 2 minutes.`,
    es: `Empezar con Touch? es super simple. Dos minutos:

1. Accede a touch-irl.com en tu celular
2. Crea una cuenta (nickname, email, fecha de nacimiento)
3. Si eres dueno de negocio: haz clic en "Operador" y crea tu establecimiento
4. En el panel del operador, activa los modulos que necesitas (menu, checkin, etc.)
5. En la pestana "Materiales", descarga tu codigo QR y el audio ultrasonico
6. Coloca el QR en la entrada y reproduce el audio en tu altavoz
7. Listo! Los clientes ya pueden conectarse

No necesitas descargar app (funciona en el navegador), ni hardware especial, ni tecnico para instalar. Tu mismo lo haces en 2 minutos.`
  },

  // ── SEGURANCA ──
  {
    id: 'security',
    keywords: ['seguranca', 'security', 'seguridad', 'seguro', 'safe', 'privacidade', 'privacy', 'privacidad', 'dados', 'data', 'datos', 'roubo', 'theft', 'hack', 'lgpd', 'gdpr'],
    weight: 2,
    pt: `A seguranca no Touch? e levada a serio:

- O som ultrassonico so carrega um ID anonimo, nunca dados pessoais
- Conexao criptografada (HTTPS + WebSocket seguro)
- Nenhum dado financeiro e armazenado no nosso servidor (processado por Stripe/MercadoPago)
- Voce controla quem ve suas informacoes (sistema de "reveal" -- so mostra nome real se voce autorizar)
- Verificacao de idade (18+ obrigatorio)
- Conformidade com LGPD (Brasil) e GDPR (Europa)
- O celular so emite som quando voce autoriza (permissao de microfone/alto-falante)
- Sem rastreamento de localizacao -- a conexao e por som, nao por GPS

Se a caixa de som for roubada: o dono desassocia pelo painel e o QR/audio daquela caixa para de funcionar instantaneamente.`,
    en: `Security at Touch? is taken seriously:

- Ultrasonic sound only carries an anonymous ID, never personal data
- Encrypted connection (HTTPS + secure WebSocket)
- No financial data stored on our server (processed by Stripe)
- You control who sees your information ("reveal" system -- only shows real name if you authorize)
- Age verification (18+ required)
- GDPR compliant
- Phone only emits sound when you authorize (microphone/speaker permission)
- No location tracking -- connection is by sound, not GPS

If the speaker is stolen: the owner unlinks it from the panel and that QR/audio stops working instantly.`,
    es: `La seguridad en Touch? se toma en serio:

- El sonido ultrasonico solo transporta un ID anonimo, nunca datos personales
- Conexion encriptada (HTTPS + WebSocket seguro)
- Ningun dato financiero se almacena en nuestro servidor (procesado por Stripe/MercadoPago)
- Tu controlas quien ve tu informacion (sistema de "reveal" -- solo muestra nombre real si autorizas)
- Verificacion de edad (18+ obligatorio)
- Conformidad con GDPR
- El celular solo emite sonido cuando autorizas (permiso de microfono/altavoz)
- Sin rastreo de ubicacion -- la conexion es por sonido, no por GPS

Si el altavoz es robado: el dueno lo desvincula desde el panel y ese QR/audio deja de funcionar instantaneamente.`
  },

  // ── QR CODE ──
  {
    id: 'qrcode',
    keywords: ['qr', 'qr code', 'codigo qr', 'escanear', 'scan', 'escanear', 'camera', 'camara', 'sem app', 'without app', 'sin app', 'navegador', 'browser', 'navegador'],
    weight: 2,
    pt: `O QR code e a porta de entrada universal do Touch?. Funciona pra quem nunca usou antes:

1. A pessoa escaneia o QR com a camera normal do celular
2. Abre o Touch? no navegador (sem baixar nada)
3. Escolhe um nickname
4. Ja esta conectada! Pode usar tudo: cardapio, pedidos, pagamento, check-in

Nao precisa de cadastro completo na hora. O cadastro completo pode ser feito depois, quando a pessoa quiser salvar o historico.

Cada estabelecimento tem seu QR code unico. O dono baixa no painel do operador e pode imprimir: banner pra entrada, tent cards pra mesa, adesivos, cartoes de visita. Tudo com a marca Touch? e o QR personalizado dele.`,
    en: `The QR code is Touch?'s universal entry point. Works for first-time users:

1. Person scans the QR with their normal phone camera
2. Opens Touch? in the browser (no download needed)
3. Chooses a nickname
4. Already connected! Can use everything: menu, orders, payment, check-in

No full registration needed right away. Full signup can be done later, when the person wants to save their history.

Each business has their unique QR code. The owner downloads it from the operator panel and can print: entrance banner, table tent cards, stickers, business cards. All with Touch? branding and their personalized QR.`,
    es: `El codigo QR es la puerta de entrada universal de Touch?. Funciona para quien nunca lo uso antes:

1. La persona escanea el QR con la camara normal de su celular
2. Se abre Touch? en el navegador (sin descargar nada)
3. Elige un nickname
4. Ya esta conectada! Puede usar todo: menu, pedidos, pago, check-in

No necesita registro completo en el momento. El registro completo se puede hacer despues, cuando la persona quiera guardar su historial.

Cada establecimiento tiene su codigo QR unico. El dueno lo descarga del panel del operador y puede imprimir: banner para la entrada, tent cards para las mesas, adhesivos, tarjetas de visita. Todo con la marca Touch? y su QR personalizado.`
  },

  // ── CONEXAO ENTRE PESSOAS ──
  {
    id: 'connect-people',
    keywords: ['conectar', 'connect', 'conectar', 'pessoa', 'people', 'gente', 'amigo', 'friend', 'amigo', 'contato', 'contact', 'contacto', 'conhecer', 'meet', 'conocer', 'paquera', 'flirt', 'coqueteo', 'namoro', 'dating', 'rede social', 'social network'],
    weight: 2,
    pt: `O Touch? tambem conecta pessoas entre si. Nao e so pra negocios!

Como funciona entre duas pessoas:
1. Ambos abrem o Touch? no celular
2. Colocam os celulares tela contra tela (screen-to-screen)
3. Os alto-falantes conversam por som ultrassonico
4. Uma conexao nasce! Ambos aparecem um no perfil do outro

O legal e que comecar e anonimo: voce so mostra o nickname. Se quiser revelar nome real, foto, redes sociais, voce escolhe quando e pra quem. E um sistema de "reveal" progressivo.

Touch Coins: cada conexao custa um minimo de 10 coins. Quem inicia o Touch (quem "chegou perto") e quem paga os coins. Isso evita spam e valoriza cada conexao.

O gesto e o diferencial: nao e like, nao e swipe. E um gesto real, presencial, que exige coragem e proximidade.`,
    en: `Touch? also connects people to each other. It's not just for businesses!

How it works between two people:
1. Both open Touch? on their phones
2. Place phones screen-to-screen (facing each other)
3. The speakers communicate via ultrasonic sound
4. A connection is born! Both appear on each other's profile

The cool part is that it starts anonymous: you only show your nickname. If you want to reveal your real name, photo, social media, you choose when and to whom. It's a progressive "reveal" system.

Touch Coins: each connection costs a minimum of 10 coins. Whoever initiates the Touch (whoever "came close") pays the coins. This prevents spam and values each connection.

The gesture is the differentiator: it's not a like, not a swipe. It's a real, in-person gesture that requires courage and proximity.`,
    es: `Touch? tambien conecta personas entre si. No es solo para negocios!

Como funciona entre dos personas:
1. Ambos abren Touch? en su celular
2. Colocan los celulares pantalla contra pantalla (una frente a la otra)
3. Los altavoces conversan por sonido ultrasonico
4. Una conexion nace! Ambos aparecen en el perfil del otro

Lo genial es que comienza anonimo: solo muestras tu nickname. Si quieres revelar tu nombre real, foto, redes sociales, tu eliges cuando y a quien. Es un sistema de "reveal" progresivo.

Touch Coins: cada conexion cuesta un minimo de 10 coins. Quien inicia el Touch (quien "se acerco") es quien paga los coins. Esto evita spam y valora cada conexion.

El gesto es el diferenciador: no es un like, no es un swipe. Es un gesto real, presencial, que requiere coraje y proximidad.`
  },

  // ── MATERIAL DE MARKETING / KIT ──
  {
    id: 'marketing-kit',
    keywords: ['material', 'kit', 'impressao', 'print', 'imprimir', 'banner', 'flyer', 'adesivo', 'sticker', 'cartao', 'card', 'tarjeta', 'poster', 'download'],
    weight: 2,
    pt: `No painel do operador, voce baixa um kit completo de materiais de marketing com sua marca:

- Banner roll-up (80x200cm) pra entrada
- Tent cards pra mesas (10x15cm)
- Poster A3 pra parede
- Adesivos circulares pra superficies
- Adesivos de vitrine pra porta de vidro
- Placa de parede rigida
- Cartoes de visita
- Display de balcao

Todos os materiais ja vem com seu QR code personalizado embutido. Voce baixa em alta resolucao e manda pra grafica. O design e padrao Touch? (preto, laranja, minimalista) pra ficar profissional.

Acesse pelo painel do operador > aba "Materiais".`,
    en: `In the operator panel, you download a complete marketing materials kit with your branding:

- Roll-up banner (80x200cm) for entrance
- Table tent cards (10x15cm)
- A3 wall poster
- Round stickers for surfaces
- Window decals for glass doors
- Rigid wall sign
- Business cards
- Counter displays

All materials come with your personalized QR code embedded. You download in high resolution and send to the printer. The design is standard Touch? (black, orange, minimalist) to look professional.

Access through operator panel > "Materials" tab.`,
    es: `En el panel del operador, descargas un kit completo de materiales de marketing con tu marca:

- Banner roll-up (80x200cm) para la entrada
- Tent cards para mesas (10x15cm)
- Poster A3 para pared
- Adhesivos circulares para superficies
- Adhesivos de vitrina para puertas de vidrio
- Placa de pared rigida
- Tarjetas de visita
- Display de mostrador

Todos los materiales vienen con tu codigo QR personalizado integrado. Descargas en alta resolucion y envias a la imprenta. El diseno es estandar Touch? (negro, naranja, minimalista) para verse profesional.

Accede por el panel del operador > pestana "Materiales".`
  },

  // ── FALLBACK ──
  {
    id: 'fallback',
    keywords: [],
    weight: 0,
    pt: `Boa pergunta! Eu sou o assistente do Touch? e posso te ajudar com qualquer duvida sobre a plataforma.

Posso te explicar sobre:
- Como funciona o Touch? (som ultrassonico, QR code)
- Solucoes pra seu negocio (restaurante, bar, barbearia, academia, igreja, food truck, estacionamento)
- Shows e eventos (Touch? Live, controle de luzes)
- Sistema de gorjetas digitais
- Conexao entre pessoas
- Precos e planos
- Seguranca e privacidade
- Como comecar (setup em 2 minutos)
- Kit de materiais de marketing

Pode perguntar qualquer coisa!`,
    en: `Great question! I'm the Touch? assistant and I can help you with any questions about the platform.

I can explain about:
- How Touch? works (ultrasonic sound, QR code)
- Solutions for your business (restaurant, bar, barbershop, gym, church, food truck, parking)
- Shows and events (Touch? Live, light control)
- Digital tipping system
- Connecting people
- Pricing and plans
- Security and privacy
- How to get started (2-minute setup)
- Marketing materials kit

Feel free to ask anything!`,
    es: `Buena pregunta! Soy el asistente de Touch? y puedo ayudarte con cualquier duda sobre la plataforma.

Puedo explicarte sobre:
- Como funciona Touch? (sonido ultrasonico, codigo QR)
- Soluciones para tu negocio (restaurante, bar, barberia, gimnasio, iglesia, food truck, estacionamiento)
- Shows y eventos (Touch? Live, control de luces)
- Sistema de propinas digitales
- Conexion entre personas
- Precios y planes
- Seguridad y privacidad
- Como empezar (configuracion en 2 minutos)
- Kit de materiales de marketing

Pregunta lo que quieras!`
  }
];

// ── FUNCAO DE MATCHING ──
function findBestAnswer(question, lang) {
  const q = question.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let bestMatch = null;
  let bestScore = 0;

  for (const topic of KNOWLEDGE) {
    if (topic.id === 'fallback') continue;
    let score = 0;

    for (const kw of topic.keywords) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (q.includes(kwNorm)) {
        score += topic.weight + kwNorm.length;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = topic;
    }
  }

  // Se nao achou nada relevante, usa fallback
  if (!bestMatch || bestScore < 2) {
    bestMatch = KNOWLEDGE.find(t => t.id === 'fallback');
  }

  const validLang = ['pt', 'en', 'es'].includes(lang) ? lang : 'pt';
  return {
    topicId: bestMatch.id,
    answer: bestMatch[validLang],
    score: bestScore
  };
}

// Mensagem de boas-vindas
function getWelcome(lang) {
  const w = {
    pt: `Ola! Eu sou o assistente do Touch?. Estou aqui pra te ajudar a entender como a plataforma pode transformar seu negocio ou sua experiencia.

Me conta: qual e o seu tipo de negocio? Ou o que voce gostaria de saber? Aqui vao algumas ideias:

- "Tenho um food truck, pra que serve?"
- "Como funciona pra barbearia?"
- "Quanto custa?"
- "Como comeco a usar?"
- "O que e o som ultrassonico?"`,
    en: `Hi! I'm the Touch? assistant. I'm here to help you understand how the platform can transform your business or experience.

Tell me: what's your type of business? Or what would you like to know? Here are some ideas:

- "I have a food truck, what's it for?"
- "How does it work for barbershops?"
- "How much does it cost?"
- "How do I get started?"
- "What is ultrasonic sound?"`,
    es: `Hola! Soy el asistente de Touch?. Estoy aqui para ayudarte a entender como la plataforma puede transformar tu negocio o experiencia.

Cuentame: cual es tu tipo de negocio? O que te gustaria saber? Aqui van algunas ideas:

- "Tengo un food truck, para que sirve?"
- "Como funciona para barberias?"
- "Cuanto cuesta?"
- "Como empiezo a usar?"
- "Que es el sonido ultrasonico?"`
  };
  return w[lang] || w.pt;
}

module.exports = { findBestAnswer, getWelcome, KNOWLEDGE };
