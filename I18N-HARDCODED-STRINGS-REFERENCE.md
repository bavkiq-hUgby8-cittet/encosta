# Touch? App - Hardcoded Strings Reference
**Complete list of all 75+ hardcoded Portuguese/English strings**

---

## FILE: /public/index.html (50+ strings)

### REVEAL SCREEN (Lines 3928-4293)

```javascript
// Line 3928 - Own signal detected
sts.textContent = 'Sinal próprio detectado. Continue encostando...';

// Line 3930 - No match found yet
sts.textContent = 'Ninguém encontrado ainda. Continue encostando...';

// Line 4122 - Pulse received notification
showToast('Sentiu um pulso...');

// Line 4293 - Game invite
showToast(name + ' encostou e quer jogar!');
```

### AUTHENTICATION - GOOGLE LOGIN (Lines 3393-3395)

```javascript
// Line 3393
$('loginErr').textContent = 'Erro ao abrir Google. Tente novamente.';

// Line 3395
$('loginErr').textContent = 'Erro: ' + (e.message || 'tente novamente');
```

### AUTHENTICATION - FIREBASE (Line 3408)

```javascript
// Line 3408
$('loginErr').textContent = 'Firebase não carregou. Recarregue a página.';
```

### AUTHENTICATION - APPLE LOGIN (Lines 3425-3431)

```javascript
// Line 3425
$('loginErr').textContent = 'Erro ao abrir Apple. Tente novamente.';

// Line 3427
$('loginErr').textContent = 'Login com Apple não está ativado. ' +
  'Ative no Firebase Console > Authentication > Sign-in method > Apple.';

// Line 3429
$('loginErr').textContent = 'Apple Sign-In não configurado. ' +
  'Configure no Firebase Console.';

// Line 3431
$('loginErr').textContent = 'Erro Apple: ' + (e.message || 'tente novamente');
```

### AUTHENTICATION - PHONE VERIFICATION (Lines 3471-3533)

```javascript
// Line 3471
$('phoneErr').textContent = 'reCAPTCHA expirou. Recarregue.';

// Line 3478
$('phoneErr').textContent = 'Erro ao configurar verificação. Recarregue a página.';

// Line 3486
$('phoneErr').textContent = 'Digite um número de telefone válido.';

// Line 3490
$('phoneErr').textContent = 'Resolva o reCAPTCHA primeiro.';

// Line 3493
$('phoneSendBtn').textContent = 'Enviando...';

// Line 3502
$('phoneSendBtn').textContent = 'Enviar código SMS';

// Line 3509
$('phoneErr').textContent = msgs[e.code] || ('Erro: ' + (e.message || 'tente novamente'));

// Line 3522
$('phoneErr').textContent = 'Digite o código de 6 dígitos.';

// Line 3523
$('phoneErr').textContent = 'Envie o SMS primeiro.';

// Line 3533
$('phoneErr').textContent = msgs[e.code] || ('Erro: ' + (e.message || 'código inválido'));
```

### AUTHENTICATION - LOGIN (Lines 3555-3576)

```javascript
// Line 3555
$('loginErr').textContent = 'Preencha seu e-mail.';

// Line 3556
$('loginErr').textContent = 'Preencha sua senha.';

// Line 3574
$('loginErr').textContent = msgs[e.code] || ('Erro: ' + (e.message || 'tente novamente'));

// Line 3576
btn.textContent = 'ENTRAR';
```

### AUTHENTICATION - REGISTRATION (Lines 3585-3622)

```javascript
// Line 3585
$('regErr').textContent = 'Escolha um nickname (mín. 2 caracteres).';

// Line 3587
$('regErr').textContent = 'Preencha seu e-mail.';

// Line 3589
$('regErr').textContent = 'Senha precisa ter no mínimo 6 caracteres.';

// Line 3590
$('regErr').textContent = 'Aceite os Termos de Uso para continuar.';

// Line 3620
$('regErr').textContent = msgs[e.code] || ('Erro: ' + (e.message || 'tente novamente'));

// Line 3622
btn.textContent = 'CRIAR CONTA';
```

### AUTHENTICATION - MAGIC LINK & RECOVERY (Lines 3697-3785)

```javascript
// Line 3705
$('magicErr').textContent = 'Digite seu email.';

// Line 3721, 3729
$('magicErr').textContent = '✉ Link enviado! Verifique seu email (inclusive spam).';

// Line 3732
$('magicErr').textContent = msgs[e2.code] ||
  ('Erro: ' + (e2.message || e.message || 'tente novamente'));

// Line 3739
$('loginErr').textContent = 'Preencha o email acima primeiro.';

// Line 3753
$('loginErr').textContent = '✉ Email de recuperação enviado! Verifique sua caixa.';

// Line 3759
$('loginErr').textContent = '✉ Email de recuperação enviado!';

// Line 3763
$('loginErr').textContent = msgs[e2.code] ||
  ('Erro: ' + (e2.message || e.message || ''));

// Line 3785
errEl.textContent = 'Link expirado ou inválido. Tente novamente.';
```

### ONBOARDING (Lines 3853-3875)

```javascript
// Line 3853 - Last slide button
$('onbNextBtn').textContent = 'Começar';

// Line 3875 - Other slides button
$('onbNextBtn').textContent = 'Próximo';

// Line 3932 - Status during reveal
txt.textContent = 'TOUCHING...';
```

### TOUCH STATUS (Lines 3932-3940)

```javascript
// Line 3932
txt.textContent = 'TOUCHING...';

// Line 3940
sts.textContent = 'Procurando operador...';
```

### WAITER APP (Line 3999)

```javascript
// Line 3999
$('wvRole').textContent = (_waiterState.role === 'driver' ? 'Motorista' : 'Garcom') +
  ' - ' + _waiterState.tables.length + ' mesas';
```

### EVENTS (Lines 3989-4722)

```javascript
// Line 3989
notif.textContent = 'Pedido pronto! Mesa ' + (d.order.table || '?');

// Line 4454
$('evViewName').textContent = eventName || 'Evento';

// Line 4467
$('evViewCount').textContent = (d.attendees || []).length + ' pessoas';

// Line 4504
$('evViewCount').textContent = evNodes.length + ' pessoas';

// Line 4722
$('floatingEventName').textContent = eventName;
```

### NOTIFICATIONS - ACCOUNT & AUTH (Lines 3319-4218)

```javascript
// Line 3319
showToast('Conta encontrada! Conectamos ao seu perfil existente.');

// Search socket handlers
socket.on('need-deliver', d => {
  if(!fbUser) return showToast('Faça login primeiro.');
  // ...
});

// Email verification
socket.on('email-verified', () => {
  showToast('Email já verificado! ✅');
});

socket.on('email-verification-sent', d => {
  if(d.sent) showToast('✉ Email de verificação enviado! Verifique spam.');
  else if(d.useClientFallback) showToast('⚠️ Serviço de email indisponível. Tente novamente mais tarde.');
  else showToast('✉ Verificação enviada!');
});

// Email send error
showToast('Erro ao enviar verificação: ' + (e2.message || 'tente novamente'));

// Email verified success
showToast('Email verificado com sucesso! ✅');

// Logout error
showToast('Erro ao sair.');

// Profile liked
if(liked) showToast('Alguém curtiu seu perfil! ❤️');
```

### NOTIFICATIONS - GIFTS & DECLARATIONS

```javascript
// Line 4218+
if(d.message) showToast(d.message);

// Delivery order
showToast('Conectado como ' + (d.role === 'driver' ? 'motorista' : 'garcom') + '!');
showToast('Nova entrega!');

// Events
socket.on('event-attendee-left', d => {
  if(d.userId === state.userId) {
    showToast('Voce foi removido do evento.');
  }
});

// Gifts
showToast(gift.fromName + ' te enviou ' + gift.emoji + ' ' + gift.giftName + '!');

// Declarations
showToast(declaration.fromName + ' escreveu uma declaração para você!');

socket.on('gift-address-accepted', ({giftName}) => {
  showToast('Presente aceito! ' + giftName + ' será entregue.');
});

socket.on('gift-address-declined', ({giftName}) => {
  showToast('Presente recusado: ' + giftName);
});
```

### NOTIFICATIONS - REVEALS & CONTACTS

```javascript
// Reveal requests
showToast(fromName + ' quer ver quem você é de verdade!');

socket.on('identity-revealed', ({fromUserId, realName, ...}) => {
  showToast((realName || 'Alguém') + ' se revelou pra você! 🪪');
});

// Contact requests
socket.on('encosta-declined', () => {
  showToast('Pedido de touch recusado.');
});

socket.on('contact-request', data => {
  showToast(data.value);
});

socket.on('contact-declined', ({contactType}) => {
  showToast('Pedido de ' + contactType + ' recusado.');
});

socket.on('selfie-taken', ({relationId}) => {
  showToast('Selfie registrado!');
});
```

### NOTIFICATIONS - STARS & TIPS

```javascript
// Stars
showToast('Estrela doada para ' + toName + '!');
showToast(fromName + ' te deu uma estrela! (Total: ' + total + ')');
showToast(recipientName + ' ganhou uma estrela!');

// Tips
socket.on('tip-received', d => {
  showToast('💰 Gorjeta recebida! R$' + amount.toFixed(2).replace('.', ',') + ' de ' + from);
});

socket.on('tip-processing', d => {
  showToast('⏳ Gorjeta de R$' + amount.toFixed(2).replace('.', ',') + ' em processamento.');
});
```

### NOTIFICATIONS - GAMES

```javascript
// Game invites
showToast(name + ' quer jogar ' + data.gameName + '! Toque pra ver');
showToast(name + ' quer jogar ' + (data.gameName || '') + '!');

socket.on('game-target-busy', () => {
  showToast('Jogador esta ocupado');
});

socket.on('game-target-offline', () => {
  showToast('Jogador esta offline');
});

socket.on('game-no-relation', () => {
  showToast('Sem chat ativo com esse jogador');
});

socket.on('game-declined', () => {
  showToast('Convite recusado');
});

socket.on('game-player-quit', () => {
  showToast('O outro jogador desistiu');
});

socket.on('game-invite-received', ({name, data}) => {
  showToast(name + ' encostou e quer jogar!');
});

socket.on('game-invite-sent', () => {
  showToast('Touch enviado! Convite de jogo enviado');
});

socket.on('event-attendee-left', d => {
  if(d.userId === state.userId) {
    showToast('Voce foi removido do evento.');
  }
});

socket.on('event-ended', d => {
  showToast('Evento encerrado: ' + (d.name || ''));
});

// Mural
showToast('O evento ' + esc(eventName) + ' foi encerrado');
```

### AGENT/VA ASSISTANT (Lines 10032-10241)

```javascript
// Line 10032
showToast('Consultando ' + agentType + '...');

// Line 10049
showToast('Erro ao consultar agente.');

// Line 10153
showToast('Buscando com ' + (agentId || 'reporter') + '...');

// Line 10216
showToast('Erro ao carregar agentes.');

// Line 10241
showToast('Erro ao alternar agente.');
```

### RADIO FEATURE (Lines 9003-9080)

```javascript
// Line 9003
showToast('Sintonizando Radio Touch...');

// Line 9023
showToast('Radio desligada.');

// Line 9054
showToast('Radio indisponivel no momento.');

// Line 9076
showToast('Erro na Radio. Tente novamente mais tarde.');

// Line 9080
showToast('Carregando radio...');
```

---

## FILE: /server.js (25+ strings)

### AUTHENTICATION (Lines 1242, 1270)

```javascript
// Line 1242
const msgs = {
  'auth/user-not-found': 'Email não cadastrado. Crie uma conta primeiro.'
};

// Line 1270
const msgs = {
  'auth/user-not-found': 'Email não cadastrado.',
  'auth/invalid-email': 'Email inválido.'
};
```

### EVENTS (Line 6293)

```javascript
// Line 6293
{ error: 'Você já fez check-in neste evento!' }
```

### MESSAGE HANDLING (Line 2524)

```javascript
// Line 2524
lastMsg.type === 'ephemeral' ? '✨ ' + (lastMsg.text || '').slice(0, 40)
  : (lastMsg.text || '').startsWith('[game-invite:')
  ? 'Convite para jogar'
  : (lastMsg.text || '').slice(0, 40)
```

### PAYMENT - PIX ERRORS (Lines 8005, 9188, 12121, 12578)

```javascript
// Multiple locations
res.status(500).json({
  error: 'Erro ao gerar PIX: ' + (e.message || 'tente novamente')
});
```

### PAYMENT - CREDIT CARD ERRORS (Line 8861)

```javascript
// Line 8861
const msgs = {
  cc_rejected_bad_filled_card_number: 'Número do cartão inválido',
  cc_rejected_bad_filled_date: 'Data de validade incorreta',
  cc_rejected_bad_filled_other: 'Dados do cartão incorretos',
  cc_rejected_bad_filled_security_code: 'CVV incorreto',
  cc_rejected_blacklist: 'Cartão bloqueado',
  cc_rejected_call_for_authorize: 'Ligue para a operadora para autorizar',
  cc_rejected_card_disabled: 'Cartão desabilitado',
  cc_rejected_duplicated_payment: 'Pagamento duplicado',
  cc_rejected_high_risk: 'Pagamento rejeitado por segurança',
  cc_rejected_insufficient_amount: 'Saldo insuficiente',
  cc_rejected_max_attempts: 'Excedido número de tentativas',
  cc_rejected_other_reason: 'Cartão recusado — tente outro'
};
```

### RADIO - LOCUTOR SYSTEM PROMPT (Line 14366)

```javascript
// Line 14366 - MASSIVE HARDCODED PORTUGUESE PROMPT
locutor: {
  voice: 'alloy',
  name: 'Locutor',
  style: 'Voce e o locutor da Radio Touch — a radio do Mural Touch! ' +
    'Seu estilo e LEVE, ALEGRE e ACOLHEDOR. Fale como um amigo ' +
    'contando as noticias de forma clara e calorosa. TRANSICOES entre ' +
    'noticias sao OBRIGATORIAS: use frases como "E agora a proxima ' +
    'noticia...", "Passando pra outro assunto...", "E olha so o que ' +
    'mais ta acontecendo...". De uma PAUSA natural entre assuntos — ' +
    'nao despeje tudo de uma vez. Fale com clareza e simpatia. NAO ' +
    'faca piadas, trocadilhos ou comentarios engracados sobre as ' +
    'noticias — seja respeitoso com os assuntos. Apenas leia, comente ' +
    'brevemente com empatia e passe para a proxima. Tom acolhedor e ' +
    'natural. Voce CONHECE a galera pelo nome e cumprimenta com carinho. ' +
    'CONECTE os assuntos entre si de forma natural. NUNCA se apresente ' +
    'como DJ — voce e o LOCUTOR da Radio Touch. Slogan: "Radio Touch ' +
    '— todas as noticias resumidas pra voce!" NUNCA use emojis. NUNCA ' +
    'invente noticias — so comente as fornecidas. NUNCA fale a palavra ' +
    '"voce" de forma solta no comeco — sempre contextualize.'
}
```

### MURAL/NEWS CONTEXT (Lines 4452, 5214+)

```javascript
// Line 4452
{ role: 'user',
  content: 'Resuma a atividade recente deste mural:\n\n' + contextLines
}

// Lines 5214+ - Hardcoded fake news in Portuguese
{
  text: 'Brasil avanca em inteligencia artificial e se torna ' +
    'referencia na America Latina\n' +
    'O governo federal anunciou nesta quinta-feira um pacote de ' +
    'investimentos de R$ 23 bilhoes em pesquisa e desenvolvimento ' +
    // ... [MASSIVE TEXT IN PORTUGUESE]
}
```

---

## SUMMARY

**Total hardcoded strings:** 75+

**By file:**
- `/public/index.html`: 50+ strings
- `/server.js`: 25+ strings

**By severity:**
- CRITICAL: 50+ strings (auth, notifications, payment, radio)
- HIGH: 15+ strings (touch, events, waiter)
- MEDIUM: 10+ strings (agent, mural, button text)

---

## RECOMMENDED ACTION

Extract all these strings into `/i18n/` JSON files with structure like:

```json
{
  "auth": {
    "google_error": "Erro ao abrir Google. Tente novamente.",
    "firebase_error": "Firebase não carregou. Recarregue a página.",
    "email_required": "Preencha seu e-mail.",
    ...
  },
  "notification": {
    "account_linked": "Conta encontrada! Conectamos ao seu perfil existente.",
    "pulse_received": "Sentiu um pulso...",
    ...
  },
  "payment": {
    "pix_error": "Erro ao gerar PIX: {error}",
    "card_invalid": "Número do cartão inválido",
    ...
  }
}
```

Then use `t('auth.google_error')` instead of hardcoded strings.

For the radio locutor prompt, create a template system that can be translated
per language instead of a hardcoded Python-style docstring.
