# PRODUTO: CAIXA DE SOM TOUCH? (Hardware + Pendrive)

## A IDEIA

Vender uma caixa de som Bluetooth pronta com:
- QR code ja impresso na caixa
- Pendrive com som ultrassonico pre-gravado

O dono do estabelecimento compra no Mercado Livre ou Amazon.
Chega na casa dele. Ele liga a caixa, pluga o pendrive, e PRONTO.
A caixa fica tocando o som ultrassonico em loop (inaudivel).
Qualquer cliente que abrir o Touch? perto da caixa faz check-in automatico.
O dono NAO precisa de celular ligado, NAO precisa de internet na caixa,
NAO precisa de app aberto. So a caixa ligada com o pendrive.

Pra associar: o dono escaneia o QR da caixa com o celular dele UMA VEZ.
O sistema pergunta "Esse e seu estabelecimento?" Ele confirma.
O QR daquela caixa agora aponta pro negocio dele. Pra sempre.
Feito. Nunca mais precisa mexer.

---

## COMO FUNCIONA O PENDRIVE

### O que tem no pendrive:
- Um arquivo de audio MP3/WAV com a frequencia ultrassonica (18-22 kHz)
- O som e INAUDIVEL pro ouvido humano
- O arquivo toca em loop infinito
- Pode ser um arquivo de 1-5 minutos que repete

### O que o som faz:
- Emite continuamente um "handshake" ultrassonico
- Qualquer celular com Touch? aberto dentro do alcance detecta
- O celular reconhece a frequencia e faz check-in automatico
- O som carrega um ID unico daquela caixa (codificado na frequencia)

### Por que funciona sem internet na caixa:
- A caixa so emite som. Nao precisa de wifi, nao precisa de bluetooth pareado
- O CELULAR DO CLIENTE e quem tem internet
- O celular detecta o som, identifica o ID da caixa, manda pro servidor
- O servidor sabe qual caixa e de qual estabelecimento (associacao feita antes)
- Check-in registrado. Cardapio aberto. Tudo no celular do cliente.

### Por que funciona sem celular do dono:
- O dono so precisa do celular UMA VEZ: pra associar o QR ao negocio dele
- Depois disso, a caixa funciona sozinha 24/7
- O dono pode ver o dashboard de qualquer lugar (celular, computador)
- Mas a caixa NAO depende do celular dele pra funcionar

---

## O QR CODE PRE-IMPRESSO

### Como funciona a associacao:
1. Cada caixa sai de fabrica com um QR code UNICO impresso nela
2. O QR code aponta pra touch-irl.com/box/[CODIGO-UNICO]
3. Quando alguem escaneia esse QR pela primeira vez, o sistema pergunta:
   "Essa caixa ainda nao tem dono. Quer associar ao seu negocio?"
4. O dono faz login (ou cria conta rapido) e associa
5. A partir dai, QUALQUER PESSOA que escanear esse QR e redirecionada
   pro negocio do dono (cardapio, check-in, servicos, etc.)
6. Se a pessoa ja usa Touch?, escanear o QR abre direto o estabelecimento
7. Se e primeira vez, escanear mostra: "Escolha um nick" → entra

### Seguranca:
- So quem associou (o dono) pode desassociar
- Se a caixa for roubada, o dono desassocia pelo app e o QR fica inativo
- QR code tem checksum pra evitar falsificacao
- Um QR so pode estar associado a UM negocio por vez

---

## PRODUTO FISICO

### O que vem na caixa:

1. **Caixa de som Bluetooth** (preta fosca, cilindrica, anel LED laranja)
   - Qualquer modelo basico serve (JBL Go, Xiaomi, generico)
   - Pode ser generico com branding Touch? (mais barato)
   - Bateria OU cabo USB (pra ficar ligada o dia todo)
   - QR code impresso na superficie da caixa (serigrafia ou adesivo premium)

2. **Pendrive USB** (com logo Touch?)
   - Arquivo de audio com frequencia ultrassonica pre-gravada
   - O dono pluga na caixa e da play
   - A caixa toca em loop infinito
   - Pendrive de 1GB ja e mais que suficiente

3. **Cabo USB de carga** (pra manter a caixa ligada na tomada)

4. **Cartao de instrucoes rapidas**:
   - "1. Ligue a caixa. 2. Plugue o pendrive. 3. Escaneie o QR com seu celular pra associar ao seu negocio. Pronto!"

5. **3 cartoes QR extras** (pra colocar nas mesas se quiser)
   - Mesmos QR codes que a caixa, em formato de tent card
   - O dono pode pedir mais cartoes pelo site

### Opcoes de produto:

| Modelo | O que inclui | Preco sugerido |
|--------|-------------|---------------|
| **Touch? Starter** | Caixa generica + pendrive + 3 cartoes QR | $29.99 |
| **Touch? Pro** | Caixa premium (design proprio) + pendrive + 10 cartoes QR | $59.99 |
| **Touch? Kit Mesa** | 10 cartoes QR extras (sem caixa) | $9.99 |
| **Touch? Pendrive** | So o pendrive (pra quem ja tem caixa) | $14.99 |
| **Touch? Adesivo** | So o adesivo QR (pra colar na caixa que ja tem) | $4.99 |

---

## PENDRIVE TECNICO

### Geracao do audio:
- O sistema gera um arquivo de audio UNICO por caixa
- A frequencia base e a mesma (18-22 kHz) mas o ID e diferente
- O ID da caixa e codificado como modulacao na frequencia
- Cada pendrive tem um audio diferente (ligado ao QR daquela caixa)
- Geracao pode ser automatizada: pedido entra → sistema gera audio → grava no pendrive

### Formato do arquivo:
- WAV ou MP3, 44.1kHz, 16-bit
- Duracao: 3 minutos em loop
- Tamanho: ~5MB
- Compativel com qualquer caixa que aceite pendrive USB

### O que o som transmite:
- ID unico da caixa (hash de 8 caracteres)
- Tipo de estabelecimento (bar, barbearia, gym, etc.)
- Nada de dado pessoal -- so o ID

### Caixas que aceitam pendrive USB:
- A maioria das caixas Bluetooth de $10-30 tem entrada USB
- JBL Go, JBL Flip, Xiaomi Mi Speaker, genericas da Amazon/Mercado Livre
- Algumas tocam MP3 direto do pendrive (sem bluetooth, sem celular)
- E exatamente isso que queremos: pluga e toca, sem nada mais

---

## FLUXO COMPLETO

### Dono do estabelecimento:
```
1. Compra a caixa Touch? no Mercado Livre ($29.99)
2. Recebe em casa (1-3 dias)
3. Abre a caixa, liga a caixa de som
4. Pluga o pendrive na caixa
5. Escaneio o QR na caixa com o celular
6. Tela: "Associar essa caixa ao seu negocio?"
7. Faz login ou cria conta rapida
8. Seleciona: "Jake's Bar" (ou cria o negocio)
9. Pronto! A caixa agora E o Jake's Bar
10. Coloca a caixa na entrada do bar
11. Distribui os cartoes QR nas mesas (opcional)
12. Nunca mais precisa mexer -- so manter ligada
```

### Cliente (ja usa Touch?):
```
1. Entra no bar
2. O celular detecta o som ultrassonico da caixa
3. Notificacao: "Voce esta no Jake's Bar! Fazer check-in?"
4. Toca em "Sim"
5. Cardapio abre, servicos aparecem, wifi conecta
```

### Cliente (primeira vez):
```
1. Entra no bar, ve a caixa com QR code
2. Escaneia o QR com a camera do celular
3. Abre touch-irl.com/box/ABC123
4. Tela: "Bem-vindo ao Jake's Bar! Escolha um nick:"
5. Digita "Mike" → entra
6. Cardapio abre, pode pedir e pagar
7. Depois: "Quer salvar? Complete seu cadastro"
```

---

## POR QUE O PENDRIVE E MELHOR QUE CELULAR DO DONO

| | Celular do dono | Pendrive na caixa |
|--|----------------|-------------------|
| Precisa estar ligado? | Sim, 24/7 | Nao, so a caixa |
| Precisa de internet? | Sim | Nao (a caixa so toca som) |
| Precisa de app aberto? | Sim | Nao |
| Bateria? | Gasta rapido | Caixa na tomada = infinito |
| Se o dono sair? | Para de funcionar | Continua funcionando |
| Se o celular desligar? | Para | Continua |
| Custo? | Celular caro | Pendrive $2 |
| Manutencao? | Alta | Zero |

---

## CANAL DE VENDA

### Mercado Livre (Brasil + LATAM):
- Titulo: "Touch? Caixa de Som para Comercio - Check-in e Pagamento Automatico"
- Categoria: Tecnologia > Acessorios para Comercio
- Envio: Mercado Envios (1-3 dias)
- Preco: R$149,90 (Starter) / R$299,90 (Pro)

### Amazon (EUA):
- Titulo: "Touch? Business Speaker - Instant Customer Check-in & Payment System"
- Categoria: Office Products > Point of Sale
- Envio: FBA ou direct
- Preco: $29.99 (Starter) / $59.99 (Pro)

### Site proprio (touch-irl.com/shop):
- Sem comissao de marketplace
- Frete via Correios/USPS
- Desconto pra quem ja tem conta Touch?

### Margem estimada:

| Item | Custo | Preco venda | Margem |
|------|-------|-------------|--------|
| Caixa generica (China) | $5-8 | -- | -- |
| Pendrive 1GB | $1 | -- | -- |
| Adesivo QR premium | $0.50 | -- | -- |
| Embalagem + cartoes | $1 | -- | -- |
| **Total Starter** | **~$10** | **$29.99** | **~$20 (66%)** |
| **Total Pro** | **~$18** | **$59.99** | **~$42 (70%)** |

---

## ESCALA

### Fase 1 (Manual, primeiros 100):
- Compra caixas genericas no AliExpress em lote
- Cola adesivos QR manualmente
- Grava pendrives com ferramenta automatizada
- Embala em casa, envia via Correios/USPS
- Vende no Mercado Livre e site proprio

### Fase 2 (Semi-automatizado, 100-1.000):
- Fornecedor na China faz branding na caixa (serigrafia)
- QR codes gerados em batch e impressos em fabrica
- Pendrives gravados em lote (script automatizado)
- Estoque em fulfillment (Mercado Envios Full / FBA)

### Fase 3 (Escala, 1.000+):
- Caixa com design proprio (molde custom)
- QR code gravado a laser na superficie
- Pendrive integrado na caixa (slot interno)
- Ou: caixa com memoria interna que toca o audio direto
- Producao em fabrica na China, envio pra depositos no BR e EUA

---

## FUTURO: CAIXA INTELIGENTE (sem pendrive)

A evolucao final e uma caixa que ja vem com o audio DENTRO dela,
sem precisar de pendrive. Tipo um dispositivo IoT simples:

- Chip ESP32 ou similar (~$2)
- Memoria flash interna com o audio
- Liga na tomada e ja emite o som ultrassonico
- Wi-Fi opcional pra receber atualizacoes de firmware
- LED laranja indica que ta funcionando
- Custo de producao: ~$12-15
- Preco de venda: $49.99

Mas isso e Fase 3. Pra comecar, pendrive + caixa generica resolve.

---

## RESUMO

O que o dono compra: uma caixa de som com QR code + pendrive.
O que o dono faz: liga, pluga, escaneia uma vez. Pronto.
O que acontece: clientes se conectam ao negocio dele automaticamente.
Custo pro dono: $29.99 uma vez.
Custo de operacao: zero (caixa na tomada, pendrive tocando).
Celular do dono: so precisa pra ver o dashboard, nao pra operar.
