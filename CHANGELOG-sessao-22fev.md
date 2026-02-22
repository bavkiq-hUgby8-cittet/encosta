# Touch? (Encosta) — Changelog da Sessao 22/02/2026

## Resumo

Sessao intensa de desenvolvimento com 12 commits cobrindo audio, autenticacao,
design do chat, filtros da rede e simulador de economia de estrelas.

---

## Commits (ordem cronologica)

### 1. `102de12` — AudioContext antes de await
Corrigido bug onde o AudioContext era criado depois de awaits, perdendo o contexto
do gesto do usuario em mobile.

### 2. `a1c9de7` — Apple login com feedback
Adicionado loading state e mensagens de erro detalhadas para login Apple.

### 3. `04db083` — Desativa Apple Sign-In
Removido botao Apple (requer conta Developer $99/ano). Pode ser reativado futuramente.

### 4. `b62777a` — Unificacao de contas + mascaras + CPF
Sistema completo de unificacao: busca por firebaseUid > email > phone.
Mascaras de input (telefone, CPF), validacao CPF com algoritmo oficial,
deteccao de duplicatas, mensagens de erro em portugues.

### 5. `1e873eb` — Revelar ID exige nome real
Corrigido bug do Eduardo: agora exige `realName` preenchido antes de revelar.
canSee agora inclui nickname e telefone.

### 6. `8026b0c` — Forcar unlock de audio
Solucao definitiva para mobile: toca buffer silencioso + micro-oscilador
diretamente no gesto do click para forcar desbloqueio do pipeline de audio.

### 7. `96355fa` — Impedir auto-deteccao ultrassonica
Zona de exclusao de 200Hz ao redor da propria frequencia.
Feedback mudou de "Encontramos alguem!" para "Verificando..." ate servidor confirmar.
Servidor emite `sonic-no-match` quando nao ha match valido.

### 8. `fa58911` — Filtros Minha Rede em HTML
Substitui a pill bar desenhada no canvas por botoes HTML (elog-filter).

### 9. `b21960f` — Filtros flutuantes com legenda
Moveu filtros para `position:absolute;bottom:12px` sobre o canvas.
Bolinhas coloridas como legenda (verde=revelados, vermelho=anonimos, azul=eventos).

### 10. `c3f7119` — Redesign completo do chat (UI/UX premium)
Refatoracao total da tela de chat:
- Header mais escuro e limpo
- Mensagens com bordas sutis (sem gradientes pesados)
- Input com cantos arredondados menores
- Plus menu: 8 icones SVG vetoriais substituindo emojis
- ID bar: botoes com SVGs (cartao, olho, check)
- Reveal cards: layout limpo com icone SVG
- Streak: display minimalista com SVG stars
- Quick phrases: chips com design discreto
- ZERO emojis no chat inteiro

### 11. `9e14e82` — Simulador de economia de estrelas
Arquivo HTML independente com:
- Aquario animado de particulas (bolinhas anonimas, reveladas, eventos, estrelas)
- Painel de controle com 7 sliders
- 4 cenarios rapidos (1K a 1M usuarios)
- Curva de dificuldade progressiva (6 fases)
- Metricas: estrelas totais, media per capita, minimo Top 1000/100/10
- Tabela de distribuicao Pareto
- Regras da economia (streaks, eventos, revelacoes, conquistas)

---

## Arquivos principais

- `public/index.html` — App principal (chat, constellation, auth, sonic)
- `server.js` — Backend (API, Socket.IO, IDX indexes)
- `simulador-estrelas.html` — Ferramenta de balanceamento

## Pendencias para proxima sessao

- [ ] Testar chat redesenhado em dispositivos reais
- [ ] Calibrar simulador de estrelas com dados reais
- [ ] Implementar sistema de estrelas no servidor
- [ ] Firebase Console: habilitar Phone Auth para SMS funcionar
- [ ] Considerar reativar Apple Sign-In quando tiver conta Developer
