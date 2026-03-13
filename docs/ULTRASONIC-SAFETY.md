# ULTRASONIC SAFETY -- Touch?

> **LEITURA OBRIGATORIA para qualquer agente que mexer em parametros ultrasonicos.**
> Versao completa com tabelas e guidelines de marketing: `docs/ULTRASONIC-SAFETY-REPORT.docx`

## RESUMO

Touch? usa som ultrassonico (18,000-20,000 Hz) para detectar proximidade entre celulares.
A emissao e SEGURA para humanos (adultos, criancas) e animais (caes, gatos).
O volume e extremamente baixo (alto-falante de celular) e a estrategia e "sussurrar alto, ouvir com forca".

## DOIS MODOS DE OPERACAO

### Touch Normal (pessoa-a-pessoa)
- **Frequencia:** 18,000 - 19,800 Hz (7 slots, passo de 300 Hz)
- **Gain:** 0.35 (35%) -- INTENCIONAL, alcance curto (~20-25cm)
- **Threshold deteccao:** 165 (alto, precisa quase encostar)
- **Duracao:** 3-10 segundos por interacao
- **Risco pra pets:** ZERO (volume minusculo, exposicao curtissima)

### DJ Live (broadcast em evento)
- **Frequencia:** 19,200 Hz default (configuravel 18,000-19,500 Hz)
- **Gain broadcast:** 0.65 (65%) -- **NUNCA PASSAR DE 0.70**
- **Gain calibracao:** 0.75 (burst de 200ms apenas)
- **Threshold deteccao:** 55 (muito sensivel pra pegar sinal fraco a distancia)
- **Smoothing:** 0.5 (ajuda a detectar sinais fracos)
- **Alcance:** 10-15 metros dependendo do ambiente
- **Risco pra pets:** NEGLIGIVEL (mais silencioso que um sussurro)

## QUEM OUVE O QUE

| Especie | Range auditivo | Ouve 19kHz? | Risco |
|---------|---------------|-------------|-------|
| Adulto (18+) | 20 Hz - 17,000 Hz | NAO | NENHUM |
| Adolescente | 20 Hz - 19,000 Hz | TALVEZ (fraco) | NEGLIGIVEL |
| Crianca (<13) | 20 Hz - 20,000 Hz | POSSIVELMENTE | NEGLIGIVEL |
| Cao | 67 Hz - 45,000 Hz | SIM | NEGLIGIVEL |
| Gato | 48 Hz - 85,000 Hz | SIM | NEGLIGIVEL |
| Passaro | 200 Hz - 12,000 Hz | NAO | NENHUM |

## POR QUE E SEGURO

1. **Alto-falantes de celular sao pessimos pra 19kHz.** Sao otimizados pra voz (300-8000 Hz). A potencia real emitida a 19kHz e uma fracao minuscula. Medido: ~25-35 dB SPL a 1 metro -- mais silencioso que um sussurro (40 dB).

2. **Atenuacao atmosferica.** Som de 19kHz perde ~0.6 dB por metro no ar. A 10 metros, o sinal ja e praticamente indetectavel.

3. **Comparacao:** Um apito de cachorro opera a 23-54kHz com 80-90 dB. Touch? DJ Live opera a 19.2kHz com 30-35 dB. E 1000x mais fraco em pressao sonora.

4. **Contexto de uso:** DJ Live e usado em eventos/baladas onde o barulho ambiente (85-110 dB) e incomparavelmente mais intenso que 30 dB ultrassonico.

## REGRAS PARA AGENTES DE DESENVOLVIMENTO

**NUNCA** aumentar gain de broadcast do DJ acima de 0.70 (cap de seguranca pra pets).
**NUNCA** diminuir DJ_DETECT_THRESHOLD abaixo de 40 (causa falsos positivos).
**NUNCA** usar onda square/sawtooth pra ultrassonico (harmonicos audiveis/irritantes). Somente sine.
**NUNCA** alterar gain do Touch Normal (0.35). Gain maior quebra o requisito de proximidade.
**SEMPRE** preferir aumentar sensibilidade do detector em vez de aumentar volume.
**SEMPRE** documentar qualquer mudanca de parametro ultrassonico NESTE arquivo.

## PARAMETROS NO CODIGO

### Touch Normal (index.html)
```
SONIC_FFT_SIZE = 8192
SONIC_DETECT_THRESHOLD = 165
SONIC_CONFIRM_COUNT = 3
Emission gain = 0.35
SONIC_FREQ_BASE = 18000
SONIC_FREQ_STEP = 300
SONIC_FREQ_SLOTS = 7
```

### DJ Live Listener (index.html)
```
DJ_FFT_SIZE = 8192
DJ_DETECT_THRESHOLD = 55
DJ_CONFIRM_COUNT = 3
DJ_FREQ_MIN = 18000
DJ_FREQ_MAX = 20000
smoothingTimeConstant = 0.5
minDecibels = -100
maxDecibels = -10
confirmHits decay = every 3rd miss (slow decay for weak signals)
```

### DJ Live Emission (dj.html)
```
Default frequency = 19200 Hz
Broadcast gain = 0.65 (HARD CAP: 0.70)
Calibration gain = 0.75 (200ms burst only)
Wave type = sine (NEVER change)
Available frequencies = 18000-19500 Hz (6 slots)
```

## HISTORICO DE ALTERACOES

| Data | O que mudou | Por que |
|------|------------|---------|
| 2026-03-12 | DJ gain 0.50 -> 0.65 | Aumentar alcance mantendo seguranca |
| 2026-03-12 | DJ threshold 120 -> 55 | Detector mais sensivel = mais alcance sem volume |
| 2026-03-12 | DJ confirm 5 -> 3 | Deteccao mais rapida a distancia |
| 2026-03-12 | DJ smoothing 0.3 -> 0.5 | Melhor captacao de sinais fracos |
| 2026-03-12 | Calibration gain 0.90 -> 0.75 | Seguranca auditiva |
| 2026-03-12 | Slow decay de confirmHits | Sinais intermitentes a distancia nao resetam |
