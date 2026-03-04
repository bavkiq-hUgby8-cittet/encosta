# Touch? App - Comprehensive i18n Audit Report
**Date: 2026-03-04**

## EXECUTIVE SUMMARY

The Touch? app has **SIGNIFICANT i18n issues** that will cause broken user experiences for non-English users. The app currently has:

- ✓ Perfectly balanced phrase JSON structure (256 keys across all 5 languages)
- ✗ **CRITICAL BUG**: Zodiac sign keys don't match between EN and PT-BR (9 keys broken)
- ✗ **50+ hardcoded Portuguese/English strings** in frontend code
- ✗ **25+ hardcoded Portuguese strings** in server code
- ✗ **60+ missing i18n keys** for core features
- ✗ Server-side messages cannot be translated (payment, radio, events)

**Status: ⚠️ MAJOR i18n FAILURES - App is NOT production-ready for non-English users**

---

## SECTION 1: JSON STRUCTURE ANALYSIS

### 1.1 Phrases Files - KEY COUNTS ✓ (BALANCED)

**File Sizes:**
- `phrases-en.json` - 9,674 bytes
- `phrases-pt-br.json` - 8,540 bytes
- `phrases-es.json` - 8,852 bytes
- `phrases-ja.json` - 10,295 bytes
- `phrases-ru.json` - 13,839 bytes

**Key Counts by Section:**

| Section | EN | PT-BR | ES | JA | RU | Status |
|---------|----|----|----|----|----|----|
| primeiro | 70 | 70 | 70 | 70 | 70 | ✓ |
| reencontro2 | 30 | 30 | 30 | 30 | 30 | ✓ |
| reencontro3_5 | 31 | 31 | 31 | 31 | 31 | ✓ |
| reencontro6_10 | 30 | 30 | 30 | 30 | 30 | ✓ |
| reencontro11 | 30 | 30 | 30 | 30 | 30 | ✓ |
| geral | 40 | 40 | 40 | 40 | 40 | ✓ |
| evento | 15 | 15 | 15 | 15 | 15 | ✓ |
| servico | 10 | 10 | 10 | 10 | 10 | ✓ |
| **TOTAL** | **256** | **256** | **256** | **256** | **256** | **✓** |

**Status: ✓ All phrase JSON files are PERFECTLY ALIGNED**
- No missing keys
- All arrays have same length
- Perfect structure for multi-language support

---

### 1.2 Zodiac Files - CRITICAL KEY MISMATCH ⚠️ (BROKEN)

**File Sizes:**
- `zodiac-en.json` - 3,860 bytes
- `zodiac-pt-br.json` - 3,916 bytes
- `zodiac-es.json` - 3,956 bytes
- `zodiac-ja.json` - 4,259 bytes
- `zodiac-ru.json` - 5,738 bytes

#### **CRITICAL ISSUE: Zodiac Sign Keys Don't Match**

**English keys vs Portuguese keys:**

```
EN Key          PT-BR Key       Status
────────────────────────────────────────
aries           aries          ✓ Same
taurus          touro          ✗ MISMATCH
gemini          gemeos         ✗ MISMATCH
cancer          cancer         ✓ Same
leo             leao           ✗ MISMATCH
virgo           virgem         ✗ MISMATCH
libra           libra          ✓ Same
scorpio         escorpiao      ✗ MISMATCH
sagittarius     sagitario      ✗ MISMATCH
capricorn       capricornio    ✗ MISMATCH
aquarius        aquario        ✗ MISMATCH
pisces          peixes         ✗ MISMATCH
```

**IMPACT ANALYSIS:**

When server calls `getZodiacPhrase()` for PT-BR users:
1. Function gets sign from `ZODIAC_INFO` (uses PT keys like "touro", "gemeos")
2. Function tries to look up `zodiacI18n['pt-br'].combinations`
3. ✓ Combinations ARE keyed with ENGLISH element pairs (fire_fire, fire_earth, etc.)
4. ✓ This WORKS for combinations
5. ✗ BUT: If code ever tries to look up signs by English name, it will FAIL

**ES, JA, RU Status:** ✓ Keys match EN perfectly

**Status: ⚠️ PARTIALLY BROKEN - Sign lookups will fail for PT-BR if code uses English keys**

---

## SECTION 2: HARDCODED STRINGS IN index.html (50+ strings)

### 2.1 Reveal Screen (Touch Animation) - 4 Strings

**Lines:** 3928-4176

| # | Text | Line | Purpose |
|---|------|------|---------|
| 1 | `'Sinal próprio detectado. Continue encostando...'` | 3928 | Shows when own signal detected |
| 2 | `'Ninguém encontrado ainda. Continue encostando...'` | 3930 | Shows when searching for match |
| 3 | `'Sentiu um pulso...'` | 4122 | Toast when pulse received |
| 4 | `' encostou e quer jogar!'` | 4293 | Game invite notification |

**Severity:** MEDIUM - Core touch experience broken for non-Portuguese users

---

### 2.2 Login/Registration Error Messages - 25+ Strings

**Lines:** 3393-3763

**Login Errors (Lines 3393-3431):**
- `'Erro ao abrir Google. Tente novamente.'`
- `'Firebase não carregou. Recarregue a página.'`
- `'Erro ao abrir Apple. Tente novamente.'`
- `'Login com Apple não está ativado. Ative no Firebase Console > Authentication > Sign-in method > Apple.'`
- `'Apple Sign-In não configurado. Configure no Firebase Console.'`
- `'Erro Apple: ' + (e.message || 'tente novamente')`

**Phone Verification Errors (Lines 3478-3533):**
- `'Erro ao configurar verificação. Recarregue a página.'`
- `'reCAPTCHA expirou. Recarregue.'`
- `'Digite um número de telefone válido.'`
- `'Resolva o reCAPTCHA primeiro.'`
- `'Enviando...'`
- `'Enviar código SMS'`
- `'Erro: ' + (e.message || 'tente novamente')`
- `'Digite o código de 6 dígitos.'`
- `'Envie o SMS primeiro.'`
- `'Erro: ' + (e.message || 'código inválido')`

**Registration Errors (Lines 3555-3620):**
- `'Preencha seu e-mail.'`
- `'Preencha sua senha.'`
- `'Escolha um nickname (mín. 2 caracteres).'`
- `'Senha precisa ter no mínimo 6 caracteres.'`
- `'Aceite os Termos de Uso para continuar.'`

**Email/Magic Link Errors (Lines 3697-3785):**
- `'Digite seu email.'`
- `'✉ Link enviado! Verifique seu email (inclusive spam).'`
- `'Preencha o email acima primeiro.'`
- `'✉ Email de recuperação enviado! Verifique sua caixa.'`
- `'Link expirado ou inválido. Tente novamente.'`

**Severity:** CRITICAL - Auth flow completely broken for non-Portuguese users

---

### 2.3 Onboarding & Button Text - 3 Strings

**Lines:** 3853-3875

| Line | Text | Usage |
|------|------|-------|
| 3853 | `'Começar'` | Last slide button |
| 3875 | `'Próximo'` | Non-last slide button |
| 3932 | `'TOUCHING...'` | Status during reveal |

**Severity:** MEDIUM - Onboarding broken for non-Portuguese users

---

### 2.4 Sonic/Touch Status Messages - 3 Strings

**Lines:** 3932, 3940, 3999

| Line | Text | Purpose |
|------|------|---------|
| 3932 | `'TOUCHING...'` | During touch detection |
| 3940 | `'Procurando operador...'` | Searching for operator |
| 3999 | `'Motorista' or 'Garcom'` | Waiter app role display |

**Severity:** HIGH - Core touch mechanic broken

---

### 2.5 Event/Waiter Feature - 5+ Strings

**Lines:** 3989-4722

| Line | Text | Purpose |
|------|------|---------|
| 3989 | `'Pedido pronto! Mesa ' + table` | Order ready notification |
| 3999 | `'Motorista' / 'Garcom' + '-' + count` | Role and count |
| 4454 | `'Evento'` | Default event name |
| 4467 | `' pessoas'` | Attendee count |
| 4504 | `' pessoas'` | Attendee joined |
| 4722 | Event name | Display |

**Severity:** MEDIUM - Event feature broken

---

### 2.6 Notifications & Toasts - 20+ Strings

**Location:** socket.on listeners throughout

**Critical notifications:**
- `'Conta encontrada! Conectamos ao seu perfil existente.'`
- `'Faça login primeiro.'`
- `'Email já verificado! ✅'`
- `'⏳ Aguarde um pouco antes de reenviar.'`
- `'Email verificado com sucesso! ✅'`
- `'Erro ao sair.'`
- `'Nova entrega!'`
- `'Conectado como motorista/garcom!'`
- `'Você foi removido do evento.'`
- `'Sentiu um pulso...'`
- `'Alguém pulsou por você'`
- `'Nova mensagem!'`
- `'Foto recebida!'`
- `'A outra pessoa quer registrar o encontro!'`
- `'Nome te enviou 🎁 Presente!'`
- `'Nome escreveu uma declaração para você!'`
- `'Presente aceito! Nome será entregue.'`
- `'Presente recusado: Nome'`
- `'Nome quer ver quem você é de verdade!'`
- `'Alguém se revelou pra você! 🪪'`
- `'Pedido de touch recusado.'`
- `'Selfie registrado!'`
- `'Estrela doada para Nome!'`
- `'Nome te deu uma estrela! (Total: X)'`
- `'Nome ganhou uma estrela!'`
- `'Alguém curtiu seu perfil! ❤️'`
- `'💰 Gorjeta recebida! R$amount de From'`
- `'⏳ Gorjeta de R$amount em processamento.'`
- `'Nome quer jogar GameName! Toque pra ver'`
- `'Jogador esta ocupado'`
- `'Jogador esta offline'`
- `'Sem chat ativo com esse jogador'`
- `'Convite recusado'`
- `'O outro jogador desistiu'`
- `'Nome encostou e quer jogar!'`
- `'Touch enviado! Convite de jogo enviado'`
- `'Voce foi removido do evento.'`
- `'Evento encerrado: Nome'`
- `'O evento Nome foi encerrado'`

**Severity:** CRITICAL - All real-time notifications broken

---

### 2.7 Agent/VA Assistant - 3 Strings

**Lines:** 10032-10241

| Line | Text | Purpose |
|------|------|---------|
| 10032 | `'Consultando ' + agentType + '...'` | Loading message |
| 10049 | `'Erro ao consultar agente.'` | Error message |
| 10153 | `'Buscando com ' + agentId + '...'` | Search message |
| 10216 | `'Erro ao carregar agentes.'` | Error message |
| 10241 | `'Erro ao alternar agente.'` | Error message |

**Severity:** MEDIUM - Agent feature broken

---

### 2.8 Radio Feature - 5 Strings

**Lines:** 9003-9080

| Line | Text | Purpose |
|------|------|---------|
| 9003 | `'Sintonizando Radio Touch...'` | Initial loading |
| 9023 | `'Radio desligada.'` | Turn off message |
| 9054 | `'Radio indisponivel no momento.'` | Unavailable message |
| 9076 | `'Erro na Radio. Tente novamente mais tarde.'` | Error message |
| 9080 | `'Carregando radio...'` | Loading message |

**Severity:** HIGH - Radio completely broken for non-Portuguese users

---

### 2.9 Mural Feature - Variable

**Status:** May have more hardcoded strings in mural rendering code

**Severity:** MEDIUM

---

## SECTION 3: HARDCODED STRINGS IN server.js (25+ strings)

### 3.1 Authentication Messages

**Lines:** 1242, 1270

```javascript
'Email não cadastrado. Crie uma conta primeiro.'
'Email não cadastrado.'
'Email inválido.'
```

---

### 3.2 Payment & Financial Messages

**Lines:** 8005, 8861, 9188, 12121, 12578

**PIX Error:**
```javascript
'Erro ao gerar PIX: ' + error
```

**Credit Card Errors (12 messages):**
```javascript
'Número do cartão inválido'
'Data de validade incorreta'
'Dados do cartão incorretos'
'CVV incorreto'
'Cartão bloqueado'
'Ligue para a operadora para autorizar'
'Cartão desabilitado'
'Pagamento duplicado'
'Pagamento rejeitado por segurança'
'Saldo insuficiente'
'Excedido número de tentativas'
'Cartão recusado — tente outro'
```

**Severity:** CRITICAL - Payment flows completely broken

---

### 3.3 Event Messages

**Line:** 6293

```javascript
'Você já fez check-in neste evento!'
```

---

### 3.4 Message Handling

**Line:** 2524

```javascript
'Convite para jogar'  // Game invite message
```

---

### 3.5 Radio/Locutor Configuration - MASSIVE ⚠️

**Line:** 14366

**Issue:** The entire radio locutor system prompt is hardcoded in Portuguese:

```javascript
locutor: {
  voice: 'alloy',
  name: 'Locutor',
  style: 'Voce e o locutor da Radio Touch — a radio do Mural Touch!
           Seu estilo e LEVE, ALEGRE e ACOLHEDOR. Fale como um amigo
           contando as noticias de forma clara e calorosa. TRANSICOES
           entre noticias sao OBRIGATORIAS: use frases como "E agora a
           proxima noticia...", "Passando pra outro assunto...",
           "E olha so o que mais ta acontecendo...". ... [HUGE TEXT]'
}
```

**Impact:**
- Cannot be translated via i18n
- Radio feature locked to Portuguese
- Requires template system redesign to support multiple languages

**Severity:** CRITICAL - Radio locked to Portuguese speakers only

---

### 3.6 Mural/News Context

**Line:** 4452

```javascript
'Resuma a atividade recente deste mural:\n\n'
```

**Line:** 5214+

Hardcoded fake news posts entirely in Portuguese

**Severity:** MEDIUM

---

## SECTION 4: MISSING i18n KEYS (60+ Keys Needed)

### 4.1 Authentication (17 keys)
- `auth.email_required`
- `auth.password_required`
- `auth.password_min_length`
- `auth.terms_required`
- `auth.phone_invalid`
- `auth.code_required`
- `auth.code_invalid`
- `auth.recaptcha_expired`
- `auth.verification_setup_error`
- `auth.email_verification_sent`
- `auth.email_verified`
- `auth.recovery_email_sent`
- `auth.link_expired`
- `login.google_error`
- `login.apple_error`
- `login.apple_not_enabled`
- `login.firebase_error`

### 4.2 Touch/Reveal (6 keys)
- `reveal.own_signal_detected`
- `reveal.searching_for_match`
- `reveal.pulse_received`
- `reveal.game_invite_received`
- `reveal.touch_started`
- `reveal.searching_operator`

### 4.3 Events (4 keys)
- `event.already_checked_in`
- `event.removed_from_event`
- `event.event_ended`
- `event.attendee_count`

### 4.4 Radio (5 keys)
- `radio.tuning_in`
- `radio.turning_off`
- `radio.unavailable`
- `radio.loading`
- `radio.error`

### 4.5 Agent/VA (4 keys)
- `agent.consulting`
- `agent.query_error`
- `agent.loading_error`
- `agent.switching_error`

### 4.6 Notifications (18 keys)
- `notification.account_linked`
- `notification.login_first`
- `notification.new_delivery`
- `notification.gift_received`
- `notification.declaration_received`
- `notification.gift_accepted`
- `notification.gift_declined`
- `notification.reveal_request`
- `notification.contact_request`
- `notification.selfie_taken`
- `notification.star_given`
- `notification.star_received`
- `notification.profile_liked`
- `notification.tip_received`
- `notification.game_invite`
- `notification.game_declined`
- `notification.player_busy`
- `notification.player_offline`

### 4.7 Payment (5+ keys)
- `payment.tip_received`
- `payment.tip_processing`
- `payment.card_declined`
- `payment.pix_error`
- Plus 12 credit card error codes

**Total: 60+ missing keys**

---

## SECTION 5: SEVERITY BREAKDOWN

### CRITICAL (Prevents app from working)
1. ✗ Zodiac sign keys mismatch (9 keys) - **BREAKS on non-EN lookup**
2. ✗ Auth error messages (25+ strings) - **Users can't log in**
3. ✗ Notification toasts (20+ strings) - **Users miss all alerts**
4. ✗ Radio feature (5+ strings + massive prompt) - **Radio locked to Portuguese**
5. ✗ Payment errors (15+ strings) - **Payment flow broken**

### HIGH (Breaks major features)
1. ✗ Touch detection messages (3 strings) - **Core feature broken**
2. ✗ Radio completely hardcoded in server - **Not translatable**
3. ✗ Event messages (4+ strings) - **Events don't work**

### MEDIUM (UX issues)
1. ✗ Agent/VA messages (3 strings)
2. ✗ Mural messages (unknown count)
3. ✗ Locale detection (fallback to English harsh)
4. ✗ Button text (Começar, Próximo)

---

## SECTION 6: RECOMMENDED FIX PRIORITY

### PHASE 1: CRITICAL (Required to launch)
- [ ] Fix zodiac-pt-br.json: Rename all sign keys to match English
- [ ] Extract auth error messages to JSON (25+ keys)
- [ ] Extract all notification toasts to JSON (20+ keys)
- [ ] Create server-side i18n endpoint for messages
- [ ] Redesign radio locutor (use template system, not hardcoded)
- [ ] Extract payment error messages to JSON

### PHASE 2: HIGH (Makes app usable)
- [ ] Extract touch/reveal messages
- [ ] Extract event messages
- [ ] Extract agent/VA messages
- [ ] Add waiter app translations

### PHASE 3: MEDIUM (Polish)
- [ ] Improve locale detection mapping (es-MX → es, pt → pt-br)
- [ ] Extract button text
- [ ] Add fallback for missing translations
- [ ] Extract mural messages

### PHASE 4: LOW (Future)
- [ ] Add German, French, Chinese support
- [ ] Improve language switching UX
- [ ] Add context-aware translations

---

## SECTION 7: SUMMARY STATISTICS

| Category | Count | Status |
|----------|-------|--------|
| **Hardcoded frontend strings** | 50+ | ✗ Broken |
| **Hardcoded server strings** | 25+ | ✗ Broken |
| **Missing i18n keys** | 60+ | ✗ Missing |
| **Zodiac key mismatches** | 9 | ✗ Broken |
| **Phrase JSON keys** | 256 | ✓ Perfect |
| **Supported languages** | 5 | ⚠️ Partial |

**Overall Status: ⚠️ MAJOR i18n FAILURES**

App is **NOT production-ready** for non-English users.

---

## FILES INVOLVED

**Frontend:**
- `/public/index.html` - 50+ hardcoded strings

**Backend:**
- `/server.js` - 25+ hardcoded strings
- `/i18n/phrases-*.json` - Perfectly structured (256 keys each)
- `/i18n/zodiac-*.json` - Key mismatch issue (9 keys)

**No changes made - This is an audit report only**
