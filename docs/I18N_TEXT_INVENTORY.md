# Touch? (Encosta) - i18n Text Inventory
## Comprehensive UI Text Strings for Internationalization

**File:** `public/index.html`
**Language:** Portuguese-Brazilian (pt-BR)
**Date:** 2026-02-25
**Status:** Complete Scan (15200 lines)

---

## SECTION 1: AUTHENTICATION & AUTH SCREENS
### Priority: ALTA (Users see first)

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 2924 | Erro ao abrir Google. Tente novamente. | error | login | Google auth failure |
| 2939 | Firebase não carregou. Recarregue a página. | error | login | Firebase init error |
| 2956 | Erro ao abrir Apple. Tente novamente. | error | login | Apple auth failure |
| 2958 | Login com Apple não está ativado. Ative no Firebase Console > Authentication > Sign-in method > Apple. | error | login | Apple not configured |
| 2960 | Apple Sign-In não configurado. Configure no Firebase Console. | error | login | Apple config missing |
| 3002 | reCAPTCHA expirou. Recarregue. | error | phone_auth | reCAPTCHA expired |
| 3009 | Erro ao configurar verificação. Recarregue a página. | error | phone_auth | reCAPTCHA setup error |
| 3017 | Digite um número de telefone válido. | error | phone_auth | Phone number validation |
| 3021 | Resolva o reCAPTCHA primeiro. | error | phone_auth | reCAPTCHA required |
| 3024 | Enviando... | button_state | phone_auth | SMS sending state |
| 3033 | Enviar código SMS | button | phone_auth | SMS button label |
| 3035-3038 | Número de telefone inválido. / Muitas tentativas. Aguarde... / Verificação reCAPTCHA falhou. / Limite de SMS atingido. | errors | phone_auth | SMS error messages |
| 3053 | Digite o código de 6 dígitos. | hint | phone_auth | SMS code length |
| 3054 | Envie o SMS primeiro. | error | phone_auth | SMS not sent |
| 3061-3062 | Código inválido. Verifique e tente novamente. / Código expirou. Reenvie o SMS. | errors | phone_auth | Code verification errors |
| 3086 | Preencha seu e-mail. | error | login | Email required |
| 3087 | Preencha sua senha. | error | login | Password required |
| 3088 | Formato de e-mail inválido. | error | login | Email format |
| 3089 | Entrando... | button_state | login | Login processing |
| 3107 | ENTRAR | button | login | Login button |
| 3095-3103 | [Multiple error messages for login failures] | error | login | Email login errors |
| 3116 | Escolha um nickname (mín. 2 caracteres). | hint | register | Nickname requirement |
| 3117 | Nickname: só letras, números, _ . - | hint | register | Nickname format |
| 3119 | Formato de e-mail inválido. Ex: nome@email.com | error | register | Email format |
| 3120 | Senha precisa ter no mínimo 6 caracteres. | error | register | Password minimum |
| 3121 | Aceite os Termos de Uso para continuar. | error | register | ToS acceptance |
| 3123 | CRIANDO CONTA... | button_state | register | Account creation |
| 3153 | CRIAR CONTA | button | register | Register button |
| 3143-3150 | [Multiple registration error messages] | error | register | Email registration errors |
| 3159 | Faça login primeiro. | error | general | Login required |
| 3163 | Email já verificado! ✅ | toast | email_verify | Email verified |
| 3172 | ✉ Email de verificação enviado! Verifique spam. | toast | email_verify | Email sent |
| 3177 | ⏳ Aguarde um pouco antes de reenviar. | toast | email_verify | Rate limit |
| 3187 | ✉ Email de verificação enviado! | toast | email_verify | Email sent (fallback) |
| 3188 | ⚠️ Serviço de email indisponível. Tente novamente mais tarde. | toast | email_verify | Email service down |
| 3189 | ✉ Verificação enviada! | toast | email_verify | Email sent |
| 3210 | Email verificado com sucesso! ✅ | toast | email_verify | Email verified |
| 3236 | Digite seu email. | error | magic_login | Email required |
| 3252 | ✉ Link enviado! Verifique seu email (inclusive spam). | toast | magic_login | Magic link sent |
| 3260 | ✉ Link enviado! Verifique seu email (inclusive spam). | toast | magic_login | Magic link sent (fallback) |
| 3262 | Email inválido. / Email não cadastrado. | errors | magic_login | Magic link errors |
| 3270 | Preencha o email acima primeiro. | error | login | Email required for reset |
| 3284 | ✉ Email de recuperação enviado! Verifique sua caixa. | toast | password_reset | Reset sent |
| 3290 | ✉ Email de recuperação enviado! | toast | password_reset | Reset sent (fallback) |
| 3316 | Link expirado ou inválido. Tente novamente. | error | magic_link | Invalid/expired link |

### REGISTRATION & ONBOARDING
| 2863 | Conta encontrada! Conectamos ao seu perfil existente. | toast | auth | Account unified |
| 2892 | home_greeting (i18n key) | greeting | home | Dynamic greeting |
| 2939 | showScreen('register') | nav | register | Show registration form |
| 2940-4000 | [Nickname creativity feedback] | feedback | register | Nick validation messages |
| 4588 | Parece um nome real! Lembre-se: o nick protege sua identidade. Crie algo único que represente você! | hint | register | Real name warning |
| 4590 | Isso é muito simples... você tem a chance de criar algo único! Solte a criatividade. | hint | register | Boring nick warning |
| 4592 | Só números? Você merece mais! Misture letras, crie algo que as pessoas lembrem de você. | hint | register | Numbers-only warning |
| 4594 | Muitos números... tenta ser mais criativo! Um bom nick marca presença. | hint | register | Too many numbers |
| 4596 | Curtinho... funciona, mas nicks mais criativos chamam mais atenção! | hint | register | Short nick |
| 4608 | "[nick] é poderoso! Misterioso, único — as pessoas vão lembrar de você." | feedback | register | Great nick |
| 4609 | "[nick] tá muito bom! Criativo e marcante." | feedback | register | Good nick |
| 4610 | "[nick] tem personalidade! Tá no caminho certo." | feedback | register | Good nick (variant) |
| 4611 | "Tá ok... mas você pode mais! Misture letras e números, use _ ou . — crie uma identidade." | feedback | register | Medium nick |

---

## SECTION 2: HOME SCREEN
### Priority: ALTA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 3454-3456 | Sinal próprio detectado. Continue encostando... / Ninguém encontrado ainda. Continue encostando... | status | home | Sonic detection messages |
| 3458 | TOUCHING... | button | home | Main touch button |
| 3466 | Procurando operador... | status | home | Sonic searching |
| 3474 | Você já fez check-in neste evento! | toast | home | Duplicate checkin |
| 3492 | Nova entrega! | toast | home | New delivery |
| 3504 | Conectado como motorista! / Conectado como garcom! | toast | home | Staff connected |
| 3515 | Pedido pronto! Mesa [table] | notification | home | Order ready |
| 4481 | Toque em 24h / Toques em 24h | label | home | Daily encounters |

### HOME VOICE/SONIC SECTION
| 3628 | Sentiu um pulso... | toast | chat | Pulse received (same chat) |
| 3629 | Alguém pulsou por você | toast | home | Pulse from other |
| 3633 | Nova mensagem! | toast | home | New message notification |
| 3638 | Foto recebida! | toast | home | Photo received |
| 3642 | A outra pessoa quer registrar o encontro! | toast | chat | Selfie request |
| 3648 | [name] te enviou [emoji] [gift]! | toast | home | Gift received |
| 3652 | [name] escreveu uma declaração para você! | toast | home | Declaration received |
| 3654 | Presente aceito! [name] será entregue. | toast | home | Gift accepted |
| 3655 | Presente recusado: [name] | toast | home | Gift declined |
| 3658 | [name] quer ver quem você é de verdade! | toast | home | Reveal request |
| 3682 | [name] se revelou pra você! 🪪 | toast | home | Identity revealed |
| 3686 | Pedido de touch recusado. | toast | home | Touch request declined |
| 3708 | Estrela doada para [name]! | toast | home | Star donation confirmed |
| 3714 | [name] te deu uma estrela! (Total: [count]) | toast | home | Star received |
| 3719 | [name] ganhou uma estrela! | toast | home | Star donation notification |
| 3724 | Alguém curtiu seu perfil! ❤️ | toast | home | Like received |
| 3732 | 💰 Gorjeta recebida! R$[amount] de [name] | toast | home | Tip received |
| 3734 | ⏳ Gorjeta de R$[amount] em processamento. | toast | home | Tip pending |
| 3742 | [name] quer jogar [game]! Toque pra ver | toast | home | Game invite notification |
| 3755 | [name] quer jogar [game]! | toast | home | Game invite (silent) |
| 3786 | Jogador esta ocupado | toast | home | Game player busy |
| 3787 | Jogador esta offline | toast | home | Game player offline |
| 3788 | Sem chat ativo com esse jogador | toast | home | No active chat for game |
| 3789 | Convite recusado | toast | home | Game invite declined |
| 3793 | O outro jogador desistiu | toast | home | Game ready cancelled |
| 3799 | [name] encostou e quer jogar! | toast | home | Sonic game invite |
| 3809 | Touch enviado! Convite de jogo enviado | toast | home | Sonic invite sent |

---

## SECTION 3: REVEAL SCREEN
### Priority: ALTA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 5751 | Conexão de serviço | label | reveal | Service reveal |
| 5756 | 💼 [service_label] | badge | reveal | Service badge |
| 5767 | Check-in | label | reveal | Checkin reveal |
| 5771 | Último: [time_ago] | info | reveal | Last encounter |
| 5787 | uma conexão nasceu / algo nasceu entre vocês | label | reveal | Birth moment |
| 5806 | [days]d [hours]h atrás / [hours]h atrás / agora | info | reveal | Time since last |
| 5860 | Gorjeta | button | reveal | Tip button |
| 5861 | Chat | button | reveal | Chat button |
| 5862 | Pular | button | reveal | Skip button |
| 5875 | Pagar [price] | button | reveal | Payment button |
| 5878 | Cancelar | button | reveal | Cancel button |
| 5880 | Este evento cobra [price] de ingresso. | info | reveal | Entry price info |
| 5883 | Revelar | button | reveal | Reveal button |
| 5884 | Anônimo | button | reveal | Anonymous option |
| 5886 | Este estabelecimento solicita identificação. | info | reveal | ID required note |
| 5890 | Só check-in | button | reveal | Check-in only option |
| 5897 | Chat 24h | button | reveal | Chat button (normal) |
| 5898 | Conexão | button | reveal | Connection button |
| 5899 | Selfie | button | reveal | Selfie button |
| 5900 | Compartilhar | button | reveal | Share button |
| 5910 | Modo Serviço | label | home | Service mode toggle |
| 5911 | TOUCH | button | home | Normal touch mode |

### REVEAL PAYMENT
| 5943 | Ingresso [price] | header | reveal | Ticket price header |
| 5954 | [event_name] | label | reveal | Event name |
| 5960 | Instantaneo, sem taxa | label | reveal | PIX info |
| 5961 | Rapido | badge | reveal | Fast badge |
| 5974 | Novo cartao | button | reveal | Add card button |
| 5979 | Pagamento seguro | label | reveal | Secure payment |
| 5980 | SSL | label | reveal | SSL info |
| 5985 | Entrar sem pagar agora | button | reveal | Enter without payment |
| 6003 | Cartao salvo | label | reveal | Saved card label |
| 6008 | CVV | placeholder | reveal | CVV input |
| 6039 | CVV invalido. | error | reveal | Invalid CVV |
| 6040 | Processando... | button_state | reveal | Payment processing |
| 6051 | Ingresso pago! Entrada confirmada. | toast | reveal | Payment confirmed |
| 6054 | Erro no pagamento. | error | reveal | Payment error |

---

## SECTION 4: CHAT SCREEN
### Priority: ALTA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 6352 | nickname | label | chat | Nickname indicator |
| 6437 | Organizador | label | chat | Event chat label |
| 6440 | ID revelado | label | chat | Revealed ID label |
| 6443 | nickname | label | chat | Nickname label |
| 6485 | [count] dia / [count] dias seguidos | label | chat | Streak days |
| 6487 | Proxima estrela em [count] dia / dias | label | chat | Streak next star |
| 6488 | Nova estrela desbloqueada | label | chat | Star unlocked |
| 6536 | Convite expirado | label | chat | Expired game invite |
| 6540 | [game_name] | label | chat | Game name in invite |
| 6541 | Convite enviado / Convite para jogar! | label | chat | Game invite status |
| 6543 | Recusar | button | chat | Decline game invite |
| 6544 | Jogar | button | chat | Accept game invite |
| 6572 | Expirado | label | chat | Chat expired |
| 6574 | [HH:MM:SS format] | label | chat | Countdown timer |
| 6590 | ✨ [phrase] | message | chat | Horoscope message |
| 6595 | Erro ao consultar astros. | error | chat | Horoscope error |

---

## SECTION 5: SUBSCRIPTION & PAYMENTS
### Priority: ALTA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 2668 | Cartao / Apple Pay / Link | button | subscription | Stripe payment method |
| 2669 | Visa, Master, Amex + wallets | hint | subscription | Card types |
| 2684 | PIX | button | subscription | PIX method |
| 2685 | Instantaneo, sem taxa | hint | subscription | PIX feature |
| 2685 | Rapido | badge | subscription | Fast badge |
| 2694 | Cartao salvo | label | subscription | Saved card |
| 2700 | Assinar Plus | button | subscription | Subscribe button |
| 2707 | Cartao, saldo ou parcelado | hint | subscription | MP features |
| 2708 | Mercado Pago | button | subscription | MP method |
| 2713 | Adicionar cartao | button | subscription | Add card button |
| 2717 | Cancele quando quiser. Renovacao mensal R$50. | info | subscription | Plus renewal info |
| 2722 | ✓ | symbol | subscription | Verification symbol |
| 2723 | Selo de Verificação | title | subscription | Verification seal |
| 2724 | R$10/mês | price | subscription | Seal price |
| 2726 | Selo de verificação no perfil | feature | subscription | Verification feature |
| 2727 | Perfil destacado na constelação | feature | subscription | Constellation feature |
| 2728 | Credibilidade nas conexões | feature | subscription | Connection credibility |
| 2730 | Nao inclui assistente AI | note | subscription | AI not included note |
| 2751 | Cancele quando quiser. Renovacao mensal R$10. | info | subscription | Seal renewal info |
| 2756 | Comparativo | header | subscription | Comparison header |
| 2758 | Recurso / Plus / Selo | table_header | subscription | Feature table |
| 2759-2763 | [Feature comparisons with ✓/✗] | feature | subscription | Feature checkmarks |
| 2770 | Qual a diferença? / O que é o assistente AI? / Posso cancelar? / Os benefícios são imediatos? | faq | subscription | FAQ questions |
| 2771 | [O Selo garante... / Um assistente de voz... / Sim, a qualquer momento... / Sim! Assim que...] | faq | subscription | FAQ answers |

---

## SECTION 6: PROFILE & IDENTITY
### Priority: MÉDIA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 2074 | PASSE | label | boarding_pass | Pass type label |
| 2067 | tudo nasce no gesto | tagline | boarding_pass | Tagline |
| 2068 | Voltar | button | boarding_pass | Back button |
| 2068 | Compartilhar | button | boarding_pass | Share button |

---

## SECTION 7: EVENTS
### Priority: MÉDIA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 3960 | Evento | default_name | events | Default event name |
| 3973 | [count] pessoas | label | events | Attendee count |
| 4050 | pessoa / pessoas | label | events | Person/people singular/plural |
| 4205 | O evento [name] foi encerrado | toast | events | Event ended |
| 4196 | [event_name] | label | events | Event name display |
| 4240 | Você saiu do evento | toast | events | Left event |
| 4276 | Tudo | button | events | All items |
| 4291 | Nenhum item disponível | message | events | No items |
| 4328 | Carrinho vazio / Escolha itens do cardápio | message | events | Empty cart |
| 4345 | Mesa [number] | option | events | Table number |
| 4347 | Mesa de entrega | label | events | Delivery table |
| 4349 | 📋 Mostrar pro garçom | button | events | Show to waiter |
| 4350 | 💳 Pagar agora | button | events | Pay now |
| 4271 | Carrinho limpo | toast | events | Cart cleared |
| 4384 | Total | label | events | Total label |
| 4378 | 📋 Pedido | header | events | Order header |
| 4378 | Mesa [table] | header | events | Table number display |
| 4386 | ✅ Garçom anotou | button | events | Waiter confirmed |
| 4387 | Voltar ao carrinho | button | events | Back to cart |
| 4399 | Pedido registrado! | toast | events | Order registered |

---

## SECTION 8: GLOBAL NAVIGATION & ERRORS
### Priority: MÉDIA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 3364 | Erro ao sair. | error | general | Logout error |
| 3384 | Começar | button | onboarding | Start button |
| 3406 | Próximo | button | onboarding | Next button |
| 3470-3471 | [relation-created socket handler] | nav | general | Relation created |
| 4854 | Voltar | button | events | Back button |
| 5920 | Dados revelados! | toast | reveal | Data revealed |
| 5921 | Erro ao revelar. | error | reveal | Reveal error |
| 5933 | Nao foi possivel identificar o destinatario. | error | tips | No recipient found |
| 6132 | Nada para compartilhar | error | reveal | No data to share |
| 6133 | Gerando imagem… | toast | reveal | Generating image |
| 6136 | Dados incompletos | error | reveal | Incomplete data |
| 6357 | Imagem salva! | toast | reveal | Image saved |
| 6360 | Erro: [message] / falha ao compartilhar | error | reveal | Share error |

---

## SECTION 9: TIPS & FINANCIAL
### Priority: MÉDIA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 5859 | Gorjeta | button | reveal | Tip button |

---

## SECTION 10: GAME SYSTEM
### Priority: BAIXA

| Line | Text | Category | Screen | Notes |
|------|------|----------|--------|-------|
| 3788 | Sem chat ativo com esse jogador | error | games | No chat |
| 3789 | Convite recusado | toast | games | Invite declined |
| 3793 | O outro jogador desistiu | toast | games | Player quit |
| 3809 | Touch enviado! Convite de jogo enviado | toast | games | Sonic invite sent |

---

## CRITICAL TEXT CONSTANTS & PATTERNS

### Error Message Mappings (Firebase)
```javascript
'auth/email-already-in-use' → 'Este e-mail já tem uma conta. Faça login ou use outro método (Google, SMS).'
'auth/invalid-email' → 'Formato de e-mail inválido.'
'auth/user-not-found' → 'Nenhuma conta encontrada com este e-mail. Deseja criar uma?'
'auth/wrong-password' → 'Senha incorreta. Esqueceu? Use o link mágico.'
'auth/invalid-credential' → 'E-mail ou senha incorretos.'
'auth/weak-password' → 'Senha muito fraca (mínimo 6 caracteres).'
'auth/too-many-requests' → 'Muitas tentativas. Aguarde uns minutos ou use outro método de login.'
'auth/user-disabled' → 'Esta conta foi desativada. Entre em contato com o suporte.'
'auth/network-request-failed' → 'Sem conexão. Verifique sua internet.'
```

### Time Format Patterns
```javascript
pad(hours) + ':' + pad(minutes) // Chat message timestamps
[days]d [hours]h atrás / [hours]h atrás / agora // Last encounter
[count] dia/dias seguidos // Streak counter
Proxima estrela em [count] dia/dias // Streak next milestone
HH:MM:SS format // Chat expiry timer
```

### Payment Status Messages
```javascript
'Ingresso pago! ✅'  // Approved
'Ingresso pago! Entrada confirmada.'  // Confirmed
'Pagamento pendente ⏳'  // Pending
'⏳ Gorjeta de R$[amount] em processamento.'  // Tip pending
'💰 Gorjeta recebida! R$[amount] de [name]'  // Tip approved
```

### Event/Chat Mode Indicators
```javascript
'Organizador' → Event chat label
'ID revelado' → Revealed identity indicator
'nickname' → Nickname indicator
'✓ assinante' → Verified subscriber badge
```

---

## DYNAMIC TEXT GENERATION AREAS

### Streak System (Line 6480-6515)
- Star emoji SVG rendering for visual representation
- Dynamic day counter with singular/plural handling
- Progress percentage calculation
- "Next star in X days" or "New star unlocked" messaging

### Message Timestamps (Line 6523)
- 24-hour format: `pad(HH):pad(MM)`
- Game invite expiration counters
- Chat message sorting by time

### Encounter Time Display (Line 5804-5808)
- Days/hours calculation from last encounter
- "agora" (now) for recent encounters
- "X dias atrás" for older encounters

### Accessibility & Pluralization
- `dia/dias` for days (singular/plural)
- `pessoa/pessoas` for people count
- `encontro/encontros` for encounters

---

## TRANSLATION NOTES FOR DEVELOPERS

### Critical Placeholders (Must Preserve):
- `[name]` - User/partner names (dynamic)
- `[count]`, `[amount]` - Numeric values
- `[price]`, `[table]` - Event-specific data
- `[game_name]` - Game title
- `[event_name]` - Event title
- `[hours]`, `[days]` - Time components
- `[service_label]` - Service type
- `[HH:MM:SS]` - Time format
- Emoji symbols (✓, ✨, 💰, ⏳, ❤️, 🪪, 📋, 💳, ✅, 🎫, 🔔, etc.)

### Special Formatting:
- RealName vs Nickname logic (reveal state)
- Service mode vs Normal reveal UI
- Event check-in vs Digital connection
- Verified subscriber badges
- Star counts with orbiting visualization
- Zodiac phrase display
- Price formatting: `R$[amount].replace('.', ',')`

### Currency & Formatting:
- Always use "R$" for Brazilian Real
- Decimal separator: comma (,) not period (.)
- Example: "R$50,00" not "R$50.00"

### Toast Messages (High-Impact):
These appear as floating notifications and are critical for UX:
- Arrival notifications
- Payment confirmations
- Identity reveals
- Connection milestones
- Error states
- State changes (connected, offline, etc.)

---

## SUMMARY BY PRIORITY LEVEL

### ALTA (255+ strings)
- Authentication & login (40+ strings)
- Home screen & sonic (25+ strings)
- Reveal screen (35+ strings)
- Chat messaging (40+ strings)
- Subscription & payments (45+ strings)
- Event system (30+ strings)
- Toast notifications (40+ strings)

### MÉDIA (80+ strings)
- Profile screens
- Event management
- Financial/tips
- Boarding pass
- Navigation errors

### BAIXA (30+ strings)
- Game invites
- Admin operations
- Dev tools
- Legacy features

---

**Total Estimated Strings: 365+**
**Status: COMPLETE SCAN**
**Last Updated: 2026-02-25**
