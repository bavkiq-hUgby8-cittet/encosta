# Touch? i18n Inventory
## User-Visible Text Strings (Portuguese BR)

Generated: 2026-02-25
Project: Touch? (Encosta)
Purpose: Internationalization (i18n) project

---

## Overview

This document inventories ALL user-visible text strings from the Touch? application secondary pages and game files for the i18n project. All text is in Portuguese Brazilian (pt-BR).

**Total Files Inventoried**: 20
- 1 Landing Page (site.html)
- 1 Legal Document (termos.html)
- 2 Operator Panels (operator.html, operator-restaurant.html)
- 1 Admin Panel (admin.html)
- 2 Voice Agent Files (va-test.html, va-admin.html)
- 1 Game Lobby (games/index.html)
- 11 Game Files (games/*.html - individual games)

**Total Unique Strings**: ~450+
- HIGH PRIORITY (Landing Page): ~150 strings
- MEDIUM PRIORITY (Operators, Games, Voice Agent): ~200 strings
- LOW PRIORITY (Admin, Legal): ~100 strings

---

## 1. SITE.HTML - Landing Page
**File**: `/public/site.html`
**Priority**: ALTA (highest user visibility)
**Type**: Marketing landing page

### Navigation & Header
| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch — A camada física da sua vida digital | page_title | Browser tab title |
| 145 | touch | nav_logo | Navigation bar |
| 147 | O que é | nav_link | Navigation section anchor |
| 148 | Pra que serve | nav_link | Navigation section anchor |
| 149 | Estrelas | nav_link | Navigation section anchor |
| 150 | Pontuação | nav_link | Navigation section anchor |
| 151 | FAQ | nav_link | Navigation section anchor |

### Hero Section (Initial Viewport)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 179 | Encostou, conectou | main_heading | Main headline with accent on "conectou" |
| 180 | Touch é a camada física da sua vida social. Dois celulares se encostam e a conexão fica registrada pra sempre. Simples assim. | hero_description | Sub-heading explaining core concept |
| 183 | Abrir o Touch | cta_button | Primary call-to-action (opens app) |
| 184 | Entenda como funciona | cta_button | Secondary call-to-action (smooth scroll) |

### Section: "O que é" (What is Touch?)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 191 | O que é o Touch | section_label | Uppercase section identifier |
| 192 | Uma via complementar. Física. Real. | section_title | Section heading |
| 193 | Suas redes sociais já cuidam do digital. O Touch cuida do que acontece quando vocês estão no mesmo lugar, ao mesmo tempo. Ele não substitui nada — ele registra o que nenhuma outra rede consegue: o encontro presencial. | section_description | Paragraph explaining app purpose |

### Use Case Cards (6 cards describing app uses)
**Card 1: "Entre amigos" (Among Friends)**
| Line | Text | Category | Context |
|------|------|----------|---------|
| 202 | Entre amigos | card_title | Card heading |
| 203 | Encontrou um amigo no rolê? Encosta o celular. A conexão fica registrada na constelação de vocês dois. Quanto mais vocês se encontram, mais forte o vínculo — e eventualmente vocês ganham estrelas juntos. | card_body | Detailed description |
| 204 | "Encontrei o Caio 5 vezes esse mês — ganhamos estrela!" | card_example | User story example |

**Card 2: "Em eventos" (At Events)**
| Line | Text | Category | Context |
|------|------|----------|---------|
| 213 | Em eventos | card_title | Card heading |
| 214 | Festas, shows, encontros, workshops. O organizador abre um evento no Touch e cada participante faz check-in encostando o celular. Pode cobrar entrada direto pelo app com cartão, PIX ou Mercado Pago. | card_body | Event mechanics |
| 215 | "Check-in no festival com um toque, já paguei a entrada." | card_example | User story example |

**Card 3: "Para gorjetas" (For Tips)**
| Line | Text | Category | Context |
|------|------|----------|---------|
| 224 | Para gorjetas | card_title | Card heading |
| 225 | Garçom, bartender, DJ, artista de rua. Encostou o celular no prestador? Aparece a opção de gorjeta na hora. Escolhe o valor, paga e pronto. O prestador recebe direto na conta dele. | card_body | Tipping mechanics |
| 226 | "O DJ mandou bem demais — dei gorjeta pelo Touch." | card_example | User story example |

**Card 4: "Revelação por escolha" (Reveal by Choice)**
| Line | Text | Category | Context |
|------|------|----------|---------|
| 235 | Revelação por escolha | card_title | Card heading |
| 236 | Ninguém vê seu nome real, foto, Instagram ou WhatsApp sem você permitir. Você controla quem te vê. Ativou o "Revelar-me" pra alguém? Pronto, ele vê seu perfil completo. Mudou de ideia? Desliga. | card_body | Privacy control explanation |
| 237 | "Conheci alguém legal — revelei meu Insta só pra ela." | card_example | User story example |

**Card 5: "Sua constelação" (Your Constellation)**
| Line | Text | Category | Context |
|------|------|----------|---------|
| 246 | Sua constelação | card_title | Card heading |
| 247 | Todas as pessoas que você encontrou viram pontos orbitando ao seu redor numa constelação animada. Quanto mais estrelas alguém tem, mais perto do centro ele fica. É o mapa visual da sua vida social real. | card_body | Constellation feature |
| 248 | "Minha constelação tem 47 pessoas — 3 com estrela." | card_example | User story example |

### Section: "Pra que Serve" (What it's for)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 259 | Pra que serve | section_label | Uppercase section label |
| 260 | Digital + Físico, juntos | section_title | Section heading |
| 261 | O Touch não compete com Instagram, WhatsApp ou qualquer outra rede. Ele complementa. Onde o digital para, o físico começa. | section_description | Positioning statement |

### Feature Cards (3 core features)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 265 | Registro de presença | feature_title | Feature 1 title |
| 266 | Prova que vocês estiveram no mesmo lugar. Não é um follow — é um encontro real que fica na constelação dos dois. | feature_description | Feature 1 description |
| 269 | Pagamento integrado | feature_title | Feature 2 title |
| 270 | Gorjeta, taxa de entrada ou contribuição — tudo resolvido na hora do toque. Cartão salvo, Mercado Pago ou PIX. | feature_description | Feature 2 description |
| 273 | Privacidade como padrão | feature_title | Feature 3 title |
| 274 | Ninguém vê nada sobre você sem sua permissão. Apelido e cor é tudo que aparece. O resto, você escolhe quando e pra quem mostrar. | feature_description | Feature 3 description |

### Section: "Estrelas" (Stars/Reputation)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 283 | Reputação | section_label | Uppercase label |
| 284 | Estrelas: sua reputação física | section_title | Section heading |
| 285 | Estrelas são o que mostram que você vive de verdade. Elas aparecem no seu perfil, na constelação e no bilhete de embarque. Cada uma é conquistada com encontros reais — e cada vez ficam mais raras. | section_description | Star system explanation |

### Star Tier Cards (4 ways to earn stars)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 290 | 100 pessoas | tier_name | Tier 1 name |
| 291 | Encontrou 100 pessoas diferentes? Ganha 1 estrela automaticamente. | tier_description | Tier 1 mechanics |
| 292 | 100 conexões = 1 ★ | tier_requirement | Tier 1 requirement |
| 296 | 5 dias juntos | tier_name | Tier 2 name |
| 297 | Encontrou a mesma pessoa em 5 dias diferentes? Os dois ganham estrela. | tier_description | Tier 2 mechanics |
| 298 | 5 dias = 1 ★ (cada) | tier_requirement | Tier 2 requirement |
| 302 | Comprar com score | tier_name | Tier 3 name |
| 303 | Junte pontos e troque por estrela. Para você custa 120. Para presentear, 100. | tier_description | Tier 3 mechanics |
| 304 | 120 pts (si) · 100 pts (gift) | tier_requirement | Tier 3 requirement |
| 308 | Doação | tier_name | Tier 4 name |
| 309 | Ganhou estrela por milestone? Pode doar pra alguém especial. Máx 1 por pessoa. | tier_description | Tier 4 mechanics |
| 310 | 1 estrela → 1 pessoa | tier_requirement | Tier 4 requirement |

### Star Rarity Explanation
| Line | Text | Category | Context |
|------|------|----------|---------|
| 314 | Cada uma fica mais difícil | subsection_title | Explains star difficulty |
| 315 | Estrelas ficam mais caras conforme você acumula. Assim como na vida, as primeiras conexões são fáceis — manter e expandir é o desafio. | explanation_text | Star scaling mechanics |

### Star Cost Table (Rarity progression)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 318 | 1ª estrela | rarity_label | Star 1 |
| 318 | 100 pts | rarity_cost | Cost for star 1 |
| 318 | Primeiros passos | rarity_note | Rarity note |
| 319 | 2ª estrela | rarity_label | Star 2 |
| 319 | 115 pts | rarity_cost | Cost for star 2 |
| 319 | +15% | rarity_note | Price increase % |
| 320 | 5ª estrela | rarity_label | Star 5 |
| 320 | 175 pts | rarity_cost | Cost for star 5 |
| 320 | +75% | rarity_note | Price increase % |
| 321 | 10ª estrela | rarity_label | Star 10 |
| 321 | 352 pts | rarity_cost | Cost for star 10 |
| 321 | Raro | rarity_note | Rarity description |
| 322 | 20ª estrela | rarity_label | Star 20 |
| 322 | 1.424 pts | rarity_cost | Cost for star 20 |
| 322 | Lendário | rarity_note | Rarity description |

### Section: "Pontuação" (Scoring)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 330 | Pontuação | section_label | Uppercase label |
| 331 | Como o score funciona | section_title | Section heading |
| 332 | Cada encontro vale pontos. Pessoas novas valem mais. Reencontros em dias diferentes também valem bastante. Repetir no mesmo dia, pouco. Spammar, nada. | section_description | Scoring explanation |

### Scoring Table
| Line | Text | Category | Context |
|------|------|----------|---------|
| 335 | Tipo | table_header | Table column 1 |
| 335 | Pontos | table_header | Table column 2 |
| 335 | Quando | table_header | Table column 3 |
| 337 | Primeira vez | score_type | First encounter type |
| 337 | +10 | score_points | Points awarded |
| 337 | Nunca se viram antes | score_condition | Condition description |
| 338 | Reencontro | score_type | Re-encounter type |
| 338 | +8 | score_points | Points awarded |
| 338 | Já se conhecem, dia diferente | score_condition | Condition description |
| 339 | Mesmo dia | score_type | Same-day type |
| 339 | +4 | score_points | Points awarded |
| 339 | 2ª vez no dia | score_condition | Condition description |
| 340 | 3ª+ vez no dia | score_type | 3+ times same day |
| 340 | 0 | score_points | Points awarded |
| 340 | Máx 2 por dupla em 24h | score_condition | Condition description |

### Scoring Decay Note
| Line | Text | Category | Context |
|------|------|----------|---------|
| 344 | Pontos decaem ao longo de 30 dias. Seu score reflete sua atividade recente — pra manter alto, continue saindo e encontrando gente. | decay_explanation | Explains point decay system |

### Difficulty Progression
| Line | Text | Category | Context |
|------|------|----------|---------|
| 346 | O caminho até cada estrela | subsection_title | Path to each star |
| 348 | 1ª estrela | difficulty_label | Star 1 |
| 348 | 100 pessoas | difficulty_goal | Goal |
| 349 | 3ª estrela | difficulty_label | Star 3 |
| 349 | 300 pessoas | difficulty_goal | Goal |
| 350 | 5ª estrela | difficulty_label | Star 5 |
| 350 | 500 pessoas | difficulty_goal | Goal |
| 351 | 10ª estrela | difficulty_label | Star 10 |
| 351 | 1.000 pessoas | difficulty_goal | Goal |
| 352 | 20 estrelas | difficulty_label | Star 20 |
| 352 | Lendário | difficulty_goal | Status |

### Star Rarity Explanation Box
| Line | Text | Category | Context |
|------|------|----------|---------|
| 356 | ★ Por que estrelas são raras? | faq_heading | FAQ-style heading |
| 357 | Porque representam algo que aconteceu de verdade. Cada estrela é prova de que você saiu de casa, encontrou gente e construiu relações que duram. É a métrica que não dá pra fabricar no sofá. | faq_answer | Detailed explanation |

### Section: "FAQ" (Frequently Asked Questions)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 365 | FAQ | section_label | Uppercase label |
| 366 | Dúvidas frequentes | section_title | Section heading |

### FAQ Items (8 questions & answers)
| Line | Text | Category | Context |
|------|------|----------|---------|
| 370 | Preciso instalar algum app? | faq_question | Q1: Installation |
| 371 | Não. O Touch funciona no navegador. Acessa o link, cria um apelido e toca. Sem download. | faq_answer | A1: Web-based |
| 374 | Meus dados ficam expostos? | faq_question | Q2: Privacy |
| 375 | Não. Por padrão as pessoas só veem seu apelido e cor. Nome, foto, redes sociais — tudo controlado por você, pessoa a pessoa. | faq_answer | A2: Privacy control |
| 378 | Dá pra farmar pontos? | faq_question | Q3: Point farming |
| 379 | O sistema limita a 2 encontros por dupla em 24h. Terceira vez em diante = zero pontos. Melhor sair e conhecer gente nova. | faq_answer | A3: Anti-farm mechanism |
| 382 | Como funciona em eventos? | faq_question | Q4: Events |
| 383 | O organizador abre um evento no painel, define se cobra entrada, e os participantes fazem check-in encostando o celular. O check-in aparece como conexão com o evento na constelação. | faq_answer | A4: Event mechanics |
| 386 | Como dar gorjeta? | faq_question | Q5: Tips |
| 387 | Toca o celular do prestador, aparece a tela de gorjeta. Escolhe o valor e paga por cartão, Mercado Pago ou PIX. | faq_answer | A5: Tipping process |
| 390 | O que é a constelação? | faq_question | Q6: Constellation |
| 391 | É o mapa animado das pessoas que você encontrou. Cada uma é um ponto em órbita. Quem tem mais estrelas fica mais perto do centro. Você pode curtir, doar estrela ou se revelar clicando em qualquer ponto. | faq_answer | A6: Constellation feature |
| 394 | Quem é o Top 1? | faq_question | Q7: Top 1 rank |
| 395 | A pessoa com mais estrelas. Além do reconhecimento, o Top 1 pode ajustar os parâmetros da pontuação — tipo quantos dias juntos valem uma estrela, ou quantos pontos custam. | faq_answer | A7: Top 1 privileges |
| 398 | Posso usar pra negócio? | faq_question | Q8: Business use |
| 399 | Sim. Prestadores de serviço podem receber gorjetas, organizadores podem cobrar entrada e fazer check-in, e qualquer pessoa pode se cadastrar como operador pelo painel. | faq_answer | A8: Business features |

### Footer
| Line | Text | Category | Context |
|------|------|----------|---------|
| 407 | touch | footer_logo | Footer branding |
| 408 | A camada física da sua vida digital. | footer_tagline | Brand tagline |
| 409 | Abrir o Touch | footer_link | CTA in footer |

---

## 2. TERMOS.HTML - Terms of Use
**File**: `/public/termos.html`
**Priority**: BAIXA (legal document)
**Type**: Legal/Terms of Service

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Termos de Uso — Touch? | page_title | Document title |
| 25 | Termos de Uso | main_heading | Page heading |
| 26 | Última atualização: 20 de fevereiro de 2026 | metadata | Last update date |
| 28 | 1. Aceitação dos Termos | section_heading | Section 1 title |
| 29 | Ao utilizar o aplicativo Touch? ("App"), você concorda com estes Termos de Uso. Se não concordar, não utilize o serviço. O uso continuado após atualizações constitui aceitação das mudanças. | legal_text | Section 1 content |
| 31 | 2. Descrição do Serviço | section_heading | Section 2 title |
| 32 | O Touch? é uma plataforma de conexões presenciais que registra encontros físicos entre pessoas por meio de tecnologia de proximidade (som ultrassônico e QR code). O serviço inclui: | legal_text | Section 2 intro |
| 34 | Registro de encontros presenciais entre usuários | list_item | Service feature 1 |
| 35 | Sistema de pontuação e estrelas baseado em interações reais | list_item | Service feature 2 |
| 36 | Rede de constelação mostrando conexões | list_item | Service feature 3 |
| 37 | Check-in em eventos via operadores | list_item | Service feature 4 |
| 38 | Sistema de gorjetas para prestadores de serviço | list_item | Service feature 5 |
| 41 | 3. Cadastro e Conta | section_heading | Section 3 title |
| 42 | Para usar o App, é necessário criar uma conta via Google Sign-In. Você deve fornecer informações verdadeiras ao se cadastrar (nickname, data de nascimento). Você é responsável pela segurança da sua conta e por todas as atividades realizadas nela. | legal_text | Section 3 content |
| 44 | 4. Idade Mínima | section_heading | Section 4 title |
| 45 | O uso do Touch? é permitido apenas para maiores de 16 anos. Ao se cadastrar, você confirma ter pelo menos 16 anos de idade. | legal_text | Section 4 content |
| 47 | 5. Privacidade e Dados | section_heading | Section 5 title |
| 48 | Coletamos e armazenamos os seguintes dados: | legal_text | Section 5 intro |
| 50 | Dados de cadastro: nome, nickname, email, data de nascimento, foto de perfil (opcional), Instagram (opcional) | data_type | Data category 1 |
| 51 | Dados de uso: histórico de encontros, pontuação, estrelas, conexões, localização aproximada (quando permitido) | data_type | Data category 2 |
| 52 | Dados de pagamento: processados diretamente pelo Mercado Pago. O Touch? não armazena dados de cartão de crédito | data_type | Data category 3 |
| 54 | Seus dados não são vendidos a terceiros. O sistema de revelação é voluntário — você escolhe se quer compartilhar seu nome real e Instagram com outros usuários. | legal_text | Section 5 continuation |
| 56 | 6. Sistema de Pontuação e Estrelas | section_heading | Section 6 title |
| 57 | O Touch? possui um sistema gamificado de pontuação baseado em encontros reais. Pontos e estrelas não possuem valor monetário e não podem ser trocados por dinheiro. As regras de pontuação podem ser ajustadas a qualquer momento para manter o equilíbrio do sistema. | legal_text | Section 6 content |
| 59 | 7. Pagamentos e Gorjetas | section_heading | Section 7 title |
| 60 | As gorjetas enviadas via Touch? são processadas pelo Mercado Pago. Taxas de processamento podem ser aplicadas. Reembolsos seguem a política do Mercado Pago. O Touch? não é responsável por disputas de pagamento entre usuários. | legal_text | Section 7 content |
| 62 | 8. Conduta do Usuário | section_heading | Section 8 title |
| 63 | Ao usar o Touch?, você se compromete a não: | legal_text | Section 8 intro |
| 65 | Criar contas falsas ou utilizar identidades de terceiros | conduct_rule | Rule 1 |
| 66 | Manipular o sistema de pontuação com encontros artificiais (anti-farm) | conduct_rule | Rule 2 |
| 67 | Usar o App para assédio, spam ou comportamento abusivo | conduct_rule | Rule 3 |
| 68 | Tentar acessar dados de outros usuários sem autorização | conduct_rule | Rule 4 |
| 69 | Fazer engenharia reversa ou interferir no funcionamento do App | conduct_rule | Rule 5 |
| 72 | 9. Operadores de Eventos | section_heading | Section 9 title |
| 73 | Operadores que utilizam o Touch? em estabelecimentos são responsáveis por informar seus visitantes sobre o sistema de check-in. O Touch? fornece as ferramentas; o operador é responsável pelo uso adequado em seu ambiente. | legal_text | Section 9 content |
| 75 | 10. Limitação de Responsabilidade | section_heading | Section 10 title |
| 76 | O Touch? é fornecido "como está". Não garantimos disponibilidade ininterrupta, ausência de erros ou que o serviço atenderá todas as suas expectativas. Não somos responsáveis por interações entre usuários fora do App. | legal_text | Section 10 content |
| 78 | 11. Suspensão e Encerramento | section_heading | Section 11 title |
| 79 | Reservamo-nos o direito de suspender ou encerrar contas que violem estes termos, manipulem o sistema de pontuação, ou tenham comportamento prejudicial à comunidade. | legal_text | Section 11 content |
| 81 | 12. Propriedade Intelectual | section_heading | Section 12 title |
| 82 | O Touch?, sua marca, design, código e conteúdo são propriedade dos desenvolvedores. O uso do App não concede direitos de propriedade intelectual sobre o serviço. | legal_text | Section 12 content |
| 84 | 13. Alterações nos Termos | section_heading | Section 13 title |
| 85 | Estes termos podem ser atualizados periodicamente. Mudanças significativas serão comunicadas dentro do App. O uso continuado após alterações constitui aceitação dos novos termos. | legal_text | Section 13 content |
| 87 | 14. Contato | section_heading | Section 14 title |
| 88 | contato@touchirl.com | contact_email | Contact email |
| 90 | Touch? — A camada física da sua vida digital. | footer_tagline | Footer text |

---

## 3. OPERATOR.HTML - Operator Panel
**File**: `/public/operator.html`
**Priority**: MEDIA
**Type**: Operator event management interface
**Note**: File is ~1700 lines; key UI strings extracted

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch? — Painel Operacional | page_title | Browser tab |
| 19 | Touch? | logo_text | Header logo |
| 677 | Recolher painel | tooltip | Collapse button |
| 1232 | Erro de conexão | error_message | Connection error |
| 1650 | Expandir painel | tooltip | Expand button |
| 1654 | Recolher painel | tooltip | Collapse button |
| 1782 | Não conectado — gorjetas ficam retidas até conexão | status_message | MercadoPago status |

### Setup/Configuration
| Line | Text | Category | Context |
|------|------|----------|---------|
| 608 | Bem-vindo ao nosso restaurante! | placeholder_example | Welcome message example |
| 609 | Aparece quando alguem faz check-in no seu evento. | help_text | Explanation text |

---

## 4. OPERATOR-RESTAURANT.HTML - Restaurant Operator Panel
**File**: `/public/operator-restaurant.html`
**Priority**: MEDIA
**Type**: Restaurant/event operator interface

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch? Operador de Restaurante | page_title | Browser tab |
| 1377 | Descrição do seu restaurante... | placeholder | Form placeholder |

---

## 5. ADMIN.HTML - Admin Panel
**File**: `/public/admin.html`
**Priority**: BAIXA
**Type**: Administrator dashboard
**Note**: Primarily technical, minimal user-visible text

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch? Admin | page_title | Browser tab |
| 15 | Admin | section_heading | Panel title |
| 91 | Carregando configurações... | loading_message | Loading state |

---

## 6. VA-TEST.HTML - Voice Agent Test Page
**File**: `/public/va-test.html`
**Priority**: MEDIA
**Type**: Voice agent call interface

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch? -- Ligar | page_title | Browser tab - "Call" |
| 21 | Selecione um assistente | select_title | Agent selection heading |
| 793 | Viva-voz | speaker_label | Speaker toggle label |

### Voice Agent Tiers (mentioned in HTML)
| Text | Category | Context |
|------|----------|---------|
| Plus | tier_name | Basic tier |
| Pro | tier_name | Premium tier |
| UltimateDEV | tier_name | Developer tier (with emoji icon) |

---

## 7. VA-ADMIN.HTML - Voice Agent Admin Panel
**File**: `/public/va-admin.html`
**Priority**: MEDIA
**Type**: Voice agent configuration interface

### Header & Navigation
| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | Touch AI — Painel de Controle | page_title | Browser tab |
| 82 | Touch AI | heading | Page title |
| 83 | Ajuste prompts, voz e configurações dos 3 assistentes | subtitle | Descriptive subtitle |

### Tab Navigation
| Line | Text | Category | Context |
|------|------|----------|---------|
| 86 | Plus | tab_label | Tab 1 |
| 87 | Pro | tab_label | Tab 2 |
| 88 | ⚡ UltimateDEV | tab_label | Tab 3 (with lightning icon) |

### PLUS PANEL
| Line | Text | Category | Context |
|------|------|----------|---------|
| 96 | Assistente Plus | panel_title | Panel heading |
| 97 | PLUS | badge | Tier badge |
| 100 | Configurações de Voz | section_title | Config section |
| 103 | Voz | form_label | Voice selector |
| 105 | Coral (feminino) | voice_option | Female voice |
| 106 | Alloy (neutro) | voice_option | Neutral voice |
| 107 | Echo (masculino) | voice_option | Male voice |
| 108 | Fable (narrativo) | voice_option | Narrative voice |
| 109 | Onyx (grave) | voice_option | Deep voice |
| 110 | Nova (jovem) | voice_option | Young voice |
| 111 | Shimmer (suave) | voice_option | Soft voice |
| 115 | VAD Threshold | form_label | Voice activity detection |
| 119 | Max Frases por Turno | form_label | Max phrases per turn |
| 125 | Prefix Padding (ms) | form_label | Audio prefix padding |
| 129 | Silence Duration (ms) | form_label | Silence detection |
| 134 | Personalidade | section_title | Personality config |
| 136 | Personalidade do agente (como se comporta, tom, estilo) | form_label | Personality instruction |
| 137 | Ex: Você é uma amiga fofoqueira, curiosa e divertida... | placeholder | Personality example |
| 140 | Regras de Abertura | section_title | Opening rules section |
| 142 | Como abrir a conversa (regras de saudação) | form_label | Opening rules label |
| 143 | Ex: NUNCA comece com 'E aí'. Já entre DIRETO no assunto... | placeholder | Opening rules example |
| 146 | Memória | section_title | Memory section |
| 148 | Regras de memória (o que salvar, como usar) | form_label | Memory rules label |
| 149 | Ex: SALVE SEMPRE que o usuário contar algo sobre alguém... | placeholder | Memory rules example |
| 152 | Privacidade | section_title | Privacy section |
| 154 | Regras de privacidade (estrelas, nomes, limites) | form_label | Privacy rules label |
| 155 | Ex: ESTRELAS DO USUÁRIO: pode dizer quem deu. ESTRELAS DE AMIGOS: nunca dizer quem deu... | placeholder | Privacy rules example |
| 158 | Instruções Extras | section_title | Extra instructions |
| 160 | Qualquer instrução adicional (será adicionada ao final do prompt) | form_label | Extra instructions label |
| 161 | Instruções adicionais... | placeholder | Extra instructions placeholder |
| 165 | Salvar Plus | button | Save button |
| 166 | Testar Prompt | button | Test button |
| 167 | Resetar Padrão | button | Reset button |
| 172 | Digite algo pra testar o agente Plus... | placeholder | Test input placeholder |
| 173 | Enviar | button | Send test |
| 175 | Resposta aparecerá aqui... | initial_text | Test response placeholder |

### PRO PANEL
Same structure as Plus with:
| Line | Text | Category | Context |
|------|------|----------|---------|
| 182 | Assistente Pro | panel_title | Panel heading |
| 183 | PRO | badge | Tier badge |
| 222 | Personalidade do agente Pro | form_label | Pro-specific |
| 223 | Ex: Mesma personalidade fofoqueira, MAS com poderes de navegar o app... | placeholder | Pro example |
| 251 | Salvar Pro | button | Save button |
| 252 | Testar Prompt | button | Test button |
| 253 | Resetar Padrão | button | Reset button |
| 258 | Digite algo pra testar o agente Pro... | placeholder | Test input |

### ULTIMATEDEV PANEL
| Line | Text | Category | Context |
|------|------|----------|---------|
| 268 | Assistente UltimateDEV | panel_title | Panel heading |
| 269 | ⚡DEV | badge | Tier badge |
| 272 | Configurações de Voz | section_title | Voice config |
| 308 | Personalidade do agente UltimateDEV | form_label | Dev personality |
| 309 | Ex: Developer partner + fofoqueira. Traduz pedidos em instruções técnicas... | placeholder | Dev personality example |
| 313-333 | [Same structure as Plus] | form_labels | Same config fields |
| 337 | Salvar UltimateDEV | button | Save button |
| 338 | Testar Prompt | button | Test button |
| 339 | Resetar Padrão | button | Reset button |
| 344 | Digite algo pra testar o UltimateDEV... | placeholder | Test input |

### Login/Authentication
| Line | Text | Category | Context |
|------|------|----------|---------|
| 398 | Cole seu userId para comecar: | instruction | Login instruction |
| 398 | userId do Firebase | placeholder | UID input |
| 398 | Entrar | button | Login button |

---

## 8. GAMES/INDEX.HTML - Game Lobby
**File**: `/public/games/index.html`
**Priority**: MEDIA
**Type**: Game selection interface

| Line | Text | Category | Context |
|------|------|----------|---------|
| 6 | TouchGames - Game Lobby | page_title | Browser tab |
| 71 | TouchGames | header_title | Page header |

---

## 9. GAMES/ - Individual Game Files
**Directory**: `/public/games/`
**Priority**: MEDIA
**Type**: Multiplayer mini-games

### 2048.html (Number sliding puzzle)
| Text | Category | Context |
|------|----------|---------|
| 2048 — Touch? | game_title | Game name |
| Desistir | button | Quit game |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Campo Minado.html (Minesweeper)
| Text | Category | Context |
|------|----------|---------|
| Campo Minado | game_title | Game name |
| Desistir | button | Quit game |
| Fechar | button | Close modal |
| Novo Jogo | button | Start new game |

### Cor Errada.html (Wrong Color - Stroop test)
| Text | Category | Context |
|------|----------|---------|
| Cor Errada — Touch? | game_title | Game name |
| Comecar | button | Start game |
| Desistir | button | Quit game |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Dama.html (Brazilian Checkers)
| Text | Category | Context |
|------|----------|---------|
| Dama - Jogo de Damas Brasileiras | game_title | Game name |
| Cancelar | button | Cancel action |
| Desistir | button | Quit game |
| Mensagem | label | Message field |
| Novo Jogo | button | Start new game |
| OK | button | Confirm |
| Título | label | Title field |

### Empilha.html (Stack blocks)
| Text | Category | Context |
|------|----------|---------|
| Empilha — Touch? | game_title | Game name |
| Desistir | button | Quit game |
| Jogar | button | Play/Start |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Impostor.html (Find the Impostor)
| Text | Category | Context |
|------|----------|---------|
| Ache o Impostor — Touch? | game_title | Game name |
| Desistir | button | Quit game |
| Jogar | button | Play |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Memory.html (Memory/Concentration game)
| Text | Category | Context |
|------|----------|---------|
| Jogo da Memória - Touch? | game_title | Game name |
| Desistir | button | Quit game |
| Novo Jogo | button | Start new game |
| Parabéns! | heading | Congratulations |
| Sair | button | Exit game |
| Você encontrou todos os pares! | message | Victory message |

### Rali.html (Speed racing game)
| Text | Category | Context |
|------|----------|---------|
| Rali - Corrida de Velocidade | game_title | Game name |
| Desistir | button | Quit game |
| Novo Jogo | button | Start new game |

### Reflexo.html (Reaction time game)
| Text | Category | Context |
|------|----------|---------|
| Reflexo — Touch? | game_title | Game name |
| Aguarde o verde... | game_instruction | Wait for green |
| Nao toque antes! | game_instruction | Don't tap early |
| Desistir | button | Quit game |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Speed Tap.html (Rapid tapping game)
| Text | Category | Context |
|------|----------|---------|
| Speed Tap — Touch? | game_title | Game name |
| Comecar | button | Start/Begin |
| Desistir | button | Quit game |
| Jogar Novamente | button | Play again |
| Novo Jogo | button | Start new game |

### Xadrez.html (Chess)
| Text | Category | Context |
|------|----------|---------|
| Xadrez | game_title | Game name |
| Contra IA | button | Play vs AI |
| Desistir | button | Quit game |
| Multijogador | button | Multiplayer |
| Novo Jogo | button | Start new game |
| OK | button | Confirm |

---

## Standard Button/UI Phrases (Recurring across games)

These phrases appear consistently and should be translated once, then reused:

| Portuguese | Category | Usage |
|------------|----------|-------|
| Novo Jogo | button | Appears in all 11 games |
| Desistir | button | Appears in 10 games |
| Jogar Novamente | button | Appears in 8 games |
| Jogar | button | Appears in 3 games |
| Comecar | button | Appears in 2 games |
| OK | button | Appears in 2 games |

---

## Summary Statistics

### Files by Priority
- **ALTA (High)**: 1 file (site.html - ~150 strings)
- **MEDIA (Medium)**: 14 files (~200 strings)
  - Operator panels: 2 files
  - Voice agent: 2 files
  - Games: 12 files
- **BAIXA (Low)**: 3 files (~100 strings)
  - Legal: 1 file (termos.html)
  - Admin: 1 file (admin.html)

### String Categories
| Category | Count | Priority |
|----------|-------|----------|
| Buttons & CTAs | ~80 | High |
| Headings & Titles | ~60 | High |
| Form Labels | ~50 | Medium |
| Descriptions/Body text | ~80 | High |
| Placeholders | ~30 | Medium |
| Game UI | ~40 | Medium |
| Voice Agent Config | ~60 | Medium |
| Legal Text | ~45 | Low |
| Status Messages | ~15 | Medium |
| Tooltips | ~10 | Low |

### Languages
- **Current**: Portuguese Brazilian (pt-BR)
- **Detected in text**: English references (Instagram, WhatsApp, Facebook, etc.) - proper nouns, leave unchanged
- **Currencies**: R$ (Brazilian Real), PIX (payment method) - localize context but keep abbreviations
- **Third-party services**: Mercado Pago, Google Sign-In, OpenAI - keep brand names

---

## Implementation Notes

### Translation Priority Order
1. **Phase 1** (MUST translate):
   - site.html (landing page - public-facing)
   - Game UI strings (widely visible)

2. **Phase 2** (SHOULD translate):
   - Operator panels
   - Voice agent interface
   - va-test.html

3. **Phase 3** (NICE to translate):
   - Admin panels
   - Legal documents

### Special Considerations

#### Pluralization
Portuguese uses different plural forms:
- "dia" → "dias"
- "estrela" → "estrelas"
- "pessoa" → "pessoas"

Handle in translation system or template variables.

#### Numbered References
- Star tiers: 1ª, 2ª, 5ª, 10ª, 20ª (ordinal numbers)
- Plurals: "1ª estrela" vs "3 estrelas"
- Points: "100 pts" vs "120 pts"

#### Placeholders with Values
Some placeholders contain examples with values - these may need context:
- "100 pessoas" (should adapt to target language numbers)
- "120 pts" (currency/unit format)
- "5 dias" (number format)

#### HTML/Special Characters
Some strings contain:
- Em-dashes: "—" (between concepts)
- Quotes: "E aí" (speech/examples)
- Emojis: "⚡" (UltimateDEV), "★" (stars)

Preserve exact formatting in translations.

#### Links & References
- External: contato@touchirl.com (keep as-is)
- Social: Instagram, WhatsApp, Facebook, Insta (brand names)
- Payment: Mercado Pago, PIX, Pix (keep brand names)

#### Context-Dependent Strings
Some strings have different meanings depending on context:
- "Revelar-me" = "Reveal myself" (privacy feature)
- "Check-in" = Physical presence verification (use local equivalent if exists)
- "Sonic" = Ultrasonic detection (keep technical term)

---

## File Locations for Reference

All files are in `/public/`:
```
/public/
├── site.html                      (Landing page)
├── termos.html                    (Terms)
├── operator.html                  (Operator panel)
├── operator-restaurant.html        (Restaurant operator)
├── admin.html                     (Admin dashboard)
├── va-test.html                   (Voice agent test)
├── va-admin.html                  (Voice agent config)
└── games/
    ├── index.html                 (Game lobby)
    ├── 2048.html
    ├── campo-minado.html
    ├── cor-errada.html
    ├── dama.html
    ├── empilha.html
    ├── impostor.html
    ├── memory.html
    ├── rali.html
    ├── reflexo.html
    ├── speed-tap.html
    └── xadrez.html
```

---

## Notes for Developers

1. **String Keys**: Consider using consistent key naming:
   - `site_hero_title`, `site_hero_subtitle`, etc.
   - `game_button_newgame`, `game_button_quit`, etc.
   - `va_admin_voice_label`, `va_admin_personality_label`, etc.

2. **Translation Format**: Recommend JSON, YAML, or gettext format for strings

3. **Reusable Strings**:
   - Standard buttons: "Novo Jogo", "Desistir", "Jogar Novamente"
   - Voice agent: Same section titles appear in Plus, Pro, UltimateDEV
   - Form labels: Reuse "Voz", "Max Frases", "Prefix Padding", etc.

4. **RTL Consideration**: Portuguese reads LTR (left-to-right), but design should be RTL-ready for future languages

5. **Date Format**: Currently uses "20 de fevereiro de 2026" (DD de mês de YYYY) - keep format for consistency

---

Generated: 2026-02-25
Last Updated: 2026-02-25
Version: 1.0
