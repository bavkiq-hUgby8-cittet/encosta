# MODELO DE NEGOCIO -- Touch? Live

## O PROBLEMA

Cada celular conectado no Touch? Live e um device recebendo e enviando
dados em tempo real. 50.000 celulares num show = 50.000 conexoes Socket.IO
simultâneas + broadcast ultrassonico + animacoes renderizadas + tipping.

Isso custa: servidor, bandwidth, processamento, infraestrutura.
Alguem tem que pagar a conta. E tem que sobrar lucro.

---

## QUEM USA (nao e so DJ)

| Quem | Exemplo | Escala |
|------|---------|--------|
| DJs / Artistas | Alok, Coldplay, DJ local | 500 a 100.000 phones |
| Bandas / Cantores | Show de rock, sertanejo, gospel | 1.000 a 80.000 |
| Venues / Casas noturnas | Club, balada, bar grande | 200 a 5.000 |
| Festivais | Lollapalooza, Rock in Rio, Tomorrowland | 20.000 a 100.000 |
| Igrejas | Culto, missa, evento religioso | 100 a 10.000 |
| Eventos corporativos | Lancamento de produto, conferencia | 200 a 5.000 |
| Times esportivos | Estadio, jogo, torcida | 10.000 a 80.000 |
| Formaturas / Casamentos | Festa privada | 50 a 500 |
| Teatros / Cinema | Estreia, evento especial | 200 a 3.000 |
| Politicos / Campanhas | Comicio, convenção | 1.000 a 50.000 |

---

## CUSTOS REAIS (o que precisamos cobrir)

### Por evento:
- **Socket.IO em tempo real**: ~$0.001 por device por minuto de conexao
- **Servidor/Infra**: instancia dedicada por evento grande (>5K devices)
- **Bandwidth**: broadcast de comandos + respostas dos devices
- **CDN**: servir animacoes (CSS/WebGL) pra todos os devices
- **Processamento tipping**: gateway de pagamento (Stripe ~2.9% + $0.30)

### Estimativa de custo por evento:

| Escala | Devices | Duracao | Custo infra estimado |
|--------|---------|---------|---------------------|
| Pequeno | 200 | 2h | ~$5 |
| Medio | 2.000 | 3h | ~$30 |
| Grande | 20.000 | 4h | ~$200 |
| Mega | 50.000 | 5h | ~$500 |
| Massive | 100.000 | 6h | ~$1.200 |

Ou seja: mesmo o maior evento do mundo custa ~$1.200 de infra.
O modelo de negocio precisa cobrar MUITO mais que isso.

---

## MODELO DE RECEITA

### 1. ASSINATURA MENSAL (Painel de Controle)

Quem quer USAR o painel pra controlar devices paga mensalidade.

| Plano | Preco/mes | Limite devices | Pra quem |
|-------|-----------|---------------|----------|
| **Starter** | Gratis | 100 devices | Bar, festa pequena, teste |
| **Pro** | $49/mes | 2.000 devices | Club, igreja, evento corporativo |
| **Business** | $199/mes | 20.000 devices | Venue grande, festival regional |
| **Enterprise** | $999/mes | 100.000 devices | Festival, estadio, turnê |
| **Custom** | Sob consulta | Ilimitado | Tomorrowland, olimpiadas |

**Por que funciona**: o DJ/venue paga uma vez por mes e usa em quantos
eventos quiser. O custo de infra e coberto com folga. Um club que paga
$49/mes e faz 4 eventos = $12 por evento pra controlar 2.000 celulares.

### 2. COMISSAO SOBRE GORJETAS (Tipping)

Toda gorjeta que passa pelo Touch? Live tem comissao.

| Volume mensal de tips | Comissao Touch? |
|-----------------------|-----------------|
| Ate $1.000 | 10% |
| $1.001 - $10.000 | 8% |
| $10.001 - $50.000 | 6% |
| $50.001+ | 5% |

**Exemplo real**: um DJ faz 4 shows por mes, recebe $12.000 em tips.
Touch? fica com 8% = $960/mes. So de UM DJ.

**Exemplo festival**: Tomorrowland, 3 dias, 60K pessoas/dia.
Se 10% das pessoas dao $5 de tip por dia: 6.000 x $5 x 3 = $90.000.
Touch? fica com 6% = $5.400 em um fim de semana.

### 3. TAXA POR EVENTO (Pay-per-Event)

Pra quem nao quer assinatura. Paga por evento.

| Escala | Preco por evento |
|--------|-----------------|
| Ate 500 devices | $29 |
| 501 - 2.000 | $99 |
| 2.001 - 10.000 | $299 |
| 10.001 - 50.000 | $799 |
| 50.001+ | $1.999 |

**Quando usar**: casamento, formatura, evento unico, conferencia.

### 4. PATROCINIOS / BRANDED MOMENTS

Marcas pagam pra aparecer nos celulares da plateia.

| Formato | Preco sugerido |
|---------|---------------|
| Logo da marca como animacao (30s) | $0.05 por device |
| Cor exclusiva da marca no show (ex: Heineken verde) | $0.03 por device |
| Tela de produto entre animacoes | $0.10 por device |
| "Momento patrocinado" (ex: "Budweiser presents the Drop") | $0.20 por device |

**Exemplo**: Heineken patrocina a onda verde num festival de 50K pessoas.
50.000 x $0.03 = $1.500 por uma animacao de 30s.

**Exemplo premium**: Red Bull patrocina o "Drop Moment" no Tomorrowland.
60.000 x $0.20 = $12.000 por 30 segundos no celular de todo mundo.

### 5. DADOS E ANALYTICS (pos-evento)

Vender insights anonimizados pro venue/artista/marca.

| Relatorio | Preco |
|-----------|-------|
| Relatorio basico (devices, picos, setores) | Incluso no plano |
| Mapa de calor da plateia | $49 por evento |
| Analytics de engagement (tempo ativo, interacoes) | $99 por evento |
| Comparativo entre eventos (historico) | $29/mes |
| API de dados pra integracao | $199/mes |

### 6. LICENCIAMENTO DE ANIMACOES

Pacotes de animacoes premium que o DJ/venue compra.

| Pacote | Preco |
|--------|-------|
| Pack basico (4 animacoes: pulse, solid, flash, wave) | Gratis |
| Pack Pro (12 animacoes: fire, ocean, galaxy, aurora...) | Incluso no Pro+ |
| Pack Festival (efeitos exclusivos, confetti digital) | $49 unico |
| Animacao customizada (designer cria pro artista) | $499 unico |
| Pack de time esportivo (cores, escudo, canticos) | $99/temporada |

---

## PROJECAO DE RECEITA

### Cenario conservador (Ano 1):

| Fonte | Premissa | Receita/mes |
|-------|----------|-------------|
| 50 planos Pro ($49) | Clubs, igrejas, bares | $2.450 |
| 10 planos Business ($199) | Venues grandes | $1.990 |
| 2 planos Enterprise ($999) | Festivais | $1.998 |
| Tips: $80K/mes passando (8%) | DJs e artistas | $6.400 |
| 20 eventos pay-per-event | Casamentos, formaturas | $2.000 |
| 5 patrocinios/mes | Marcas regionais | $3.000 |
| **TOTAL** | | **$17.838/mes** |
| **ANUAL** | | **~$214.000/ano** |

### Cenario otimista (Ano 2, com parcerias):

| Fonte | Premissa | Receita/mes |
|-------|----------|-------------|
| 300 planos Pro | Expansao nacional | $14.700 |
| 50 planos Business | Venues + igrejas grandes | $9.950 |
| 10 planos Enterprise | Festivais + estadios | $9.990 |
| Tips: $500K/mes (7%) | DJs nacionais e internacionais | $35.000 |
| 100 eventos pay-per-event | Corporativo + festas | $15.000 |
| 20 patrocinios/mes | Marcas nacionais | $20.000 |
| Analytics | 50 clientes | $5.000 |
| **TOTAL** | | **$109.640/mes** |
| **ANUAL** | | **~$1.3M/ano** |

---

## ESTRATEGIA DE PRECO POR SEGMENTO

### DJs e Artistas
- **Gancho**: "Controle 50K celulares de graca no plano Starter"
- **Conversao**: quando passa de 100 devices, precisa do Pro ($49)
- **Upsell**: tips (comissao automatica), animacoes premium
- **Retencao**: quanto mais shows, mais dados, mais dificil sair

### Venues / Casas noturnas
- **Gancho**: "Check-in automatico + controle de lotacao gratis"
- **Conversao**: quando quer animacoes + tipping = Pro ($49)
- **Upsell**: Business ($199) pra eventos maiores, patrocinios
- **Retencao**: integrado no fluxo operacional do venue

### Festivais
- **Gancho**: "Elimine pulseiras LED. Use os celulares que ja existem"
- **Conversao**: Enterprise ($999) ou Custom
- **Upsell**: patrocinios de marca, analytics premium
- **Retencao**: contrato anual com desconto

### Igrejas
- **Gancho**: "Dizimo digital sem constrangimento"
- **Conversao**: Pro ($49) -- barato pra uma igreja
- **Upsell**: animacoes especiais pra momentos liturgicos
- **Retencao**: comunidade engajada, dificil trocar

### Esportes / Estadios
- **Gancho**: "Transforme a torcida num show de luz"
- **Conversao**: Enterprise ($999) ou Custom
- **Upsell**: patrocinios de marcas esportivas, pack de time
- **Retencao**: contrato por temporada

### Eventos corporativos
- **Gancho**: "Impressione no lancamento do produto"
- **Conversao**: pay-per-event ($99-$299)
- **Upsell**: branded moments, analytics
- **Retencao**: conveniencia de repetir

### Casamentos / Formaturas
- **Gancho**: "O momento mais magico da festa"
- **Conversao**: pay-per-event ($29-$99)
- **Upsell**: animacao customizada ($499), proposal mode
- **Retencao**: indicacao boca a boca

---

## COMPARATIVO COM CONCORRENTES

| Solucao | Custo pro venue | Escalabilidade | Touch? Live |
|---------|----------------|----------------|-------------|
| Pulseiras LED (Xylobands) | $3-8 POR pulseira | Ruim (logistica) | $0 por pessoa |
| Bastoes de luz | $1-3 POR bastao | Ruim (lixo) | $0 por pessoa |
| App dedicado do festival | $50K-200K desenvolvimento | Media | $999/mes |
| LED panels no venue | $10K-500K instalacao | Fixa | $49-999/mes |
| **Touch? Live** | **$49-999/mes** | **Ilimitada** | **Celular que ja existe** |

**Argumento matador**: pulseiras LED pra 50K pessoas = $150.000-$400.000.
Touch? Live pra 50K pessoas = $999/mes. E os fas levam o celular pra casa
(retencao), a pulseira vai pro lixo (zero retencao).

---

## MODELO DE SPLIT ARTISTA / VENUE / TOUCH?

Quando o artista toca num venue, as gorjetas podem ser divididas:

| Configuracao | Artista | Venue | Touch? |
|-------------|---------|-------|--------|
| Padrao (DJ independente) | 90% | 0% | 10% |
| Em venue parceiro | 80% | 10% | 10% |
| Festival com patrocinio | 85% | 5% | 5% + patrocinio |
| Igreja / sem lucro | 95% | 0% | 5% |

O artista SEMPRE configura o split no painel antes do evento.
Transparencia total: o artista ve quanto o venue e o Touch? ficam.

---

## COMO ESCALAR SEM EXPLODIR O CUSTO

### Infra inteligente:
- Eventos pequenos (<500): servidor compartilhado (custo ~$0)
- Eventos medios (500-5K): instancia dedicada sob demanda (AWS spot)
- Eventos grandes (5K+): cluster auto-scaling (Kubernetes)
- Eventos mega (50K+): edge computing (CDN distribui comandos)

### Otimizacoes:
- Animacoes renderizadas NO CELULAR (CSS/WebGL), nao no servidor
- Servidor so envia COMANDOS leves ("cor: azul", "animacao: fire")
- Broadcast ultrassonico reduz necessidade de internet (som faz o trabalho)
- Cache de animacoes no celular (baixa uma vez, roda localmente)
- Compressao de comandos via Socket.IO (batch updates)

### Custo real vs receita:
- Evento de 50K devices, 5h: custo ~$500, receita minima $999 (Enterprise)
- Margem bruta: ~50% nos planos, ~90% nas comissoes de tip
- Break-even: ~30 clientes pagantes

---

## PITCH RESUMO

"Touch? Live transforma qualquer celular em um pixel que voce controla.
Sem pulseiras, sem hardware, sem app pra baixar. So o som e o celular.
Pra DJs: controle 50K celulares e receba gorjetas direto.
Pra venues: check-in automatico e show de luz sem investimento.
Pra marcas: 50K telas mostrando seu logo por 30 segundos.
Pra fas: a experiencia mais magica de um show, no celular que voce ja tem.
A partir de $49/mes."
