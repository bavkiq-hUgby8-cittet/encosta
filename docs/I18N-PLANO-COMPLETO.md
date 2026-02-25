# Touch? (Encosta) - Plano Completo de Internacionalizacao (i18n)

## FASE 1: INVENTARIO -- RESUMO EXECUTIVO

Data: 2026-02-25
Arquivos varridos: 22 arquivos
Idiomas alvo: English (US), Portugues (BR), Espanol (LATAM), Japanese

---

### CONTAGEM TOTAL DE STRINGS

| Fonte | Strings | Prioridade |
|-------|---------|------------|
| index.html (app principal) | ~365 | ALTA |
| server.js (frases + erros) | ~380 | ALTA |
| site.html (landing page) | ~150 | ALTA |
| termos.html (termos de uso) | ~100 | BAIXA |
| operator.html | ~50 | MEDIA |
| operator-restaurant.html | ~45 | MEDIA |
| admin.html | ~40 | BAIXA |
| va-test.html | ~30 | MEDIA |
| va-admin.html | ~25 | BAIXA |
| games/index.html (lobby) | ~35 | MEDIA |
| 11 jogos individuais | ~220 | MEDIA |
| **TOTAL** | **~1440** | -- |

---

### CATEGORIAS PRINCIPAIS

**1. FRASES POETICAS (server.js) -- 205 frases**
A alma do app. Precisam de adaptacao CRIATIVA, nao literal.

- Primeiro encontro: 70 frases
- Reencontro 2 (segundo encontro): 28 frases
- Reencontro 3-5 (amigos formando): 31 frases
- Reencontro 6-10 (melhores amigos): 30 frases
- Reencontro 11+ (lendarios): 30 frases
- Geral/criativas (misturadas 20% do tempo): 40 frases
- Evento (check-in): 15 frases
- Servico (gorjeta): 10 frases

Exemplos:
- "Presenca aceita." / "Dois mundos, um gesto." / "O acaso tem bom gosto."
- "Universos se tocaram." / "Timing perfeito."
- "Isso aqui ja e familia." / "Dupla imbativel."

**2. FRASES ZODIACAIS (server.js) -- 54 frases**
9 combinacoes de elementos x 6 frases cada. Tom poetico/astrologico.

- Fogo+Fogo, Fogo+Ar, Fogo+Terra, Fogo+Agua
- Terra+Terra, Terra+Ar, Terra+Agua
- Ar+Ar, Ar+Agua
- Agua+Agua

Exemplos:
- "duas chamas que se reconhecem no escuro."
- "a agua nutre. a terra acolhe."
- "ar encontra ar -- liberdade compartilhada."

**3. UI DO APP PRINCIPAL (index.html) -- 365 strings**
Telas mapeadas: auth, home, chat, reveal, profile, constellation, stars, gifts,
boarding pass, events, subscriptions, voice agent, games, notifications.

- Botoes: ENTRAR, CRIAR CONTA, TOUCHING, Revelar, Chat 24h, Gorjeta, etc.
- Toasts: ~80 mensagens de feedback
- Erros: ~60 mensagens de erro (auth, pagamento, validacao)
- Labels: ~120 rotulos de interface
- Placeholders: ~30 textos de input
- Modais: ~40 textos de confirmacao/dialogo
- Dinamicos: ~35 textos com variaveis (nomes, valores, datas)

**4. LANDING PAGE (site.html) -- 150 strings**
Marketing, explicacao do app, FAQ, footer.

**5. JOGOS (11 arquivos) -- 220 strings**
Nomes, instrucoes, botoes, scores, game over.

Jogos: 2048, Campo Minado, Cor Errada, Dama, Empilha, Impostor,
Memory, Rali, Reflexo, Speed Tap, Xadrez

Padrao reutilizavel: "Novo Jogo", "Desistir", "Jogar Novamente" (11x cada)

**6. PAINEIS OPERADOR/ADMIN -- ~160 strings**
Menus, formularios, dashboards de gestao.

**7. TERMOS DE USO -- ~100 strings**
Texto legal que precisa de revisao juridica por idioma.

---

### TEXTOS QUE PRECISAM DE DECISAO DE BRANDING

| Termo PT-BR | Sugestao EN | Decisao Necessaria |
|-------------|-------------|-------------------|
| Touch? | Touch? | Manter em todos os idiomas |
| Constelacao | Constellation | Funciona bem |
| Boarding Pass | Boarding Pass | Ja e ingles |
| Touch Plus | Touch Plus | Manter |
| Selo | Seal / Badge / Verified | Precisa decidir |
| Estrelas | Stars | Funciona |
| Campo Minado | Minesweeper | Nome classico |
| Cor Errada | Wrong Color | Funciona |
| Empilha | Stack Up | Sugestao |
| Dama | Checkers | Nome classico |
| Impostor | Impostor | Igual |
| Rali | Rally | Similar |
| Reflexo | Reflex | Similar |
| Speed Tap | Speed Tap | Ja e ingles |

---

## FASE 2: PROPOSTA DE ARQUITETURA i18n

### OPCAO RECOMENDADA: Dicionario JSON + funcao t()

Considerando que o app e um SPA monolitico com JS inline, a abordagem mais leve e eficiente e:

**Frontend (index.html e demais HTMLs):**

```
// 1. Arquivo de traducoes separado por idioma
// /public/i18n/en.json, /public/i18n/pt-br.json, /public/i18n/es.json, /public/i18n/ja.json

// 2. Funcao global de traducao
function t(key, params) {
  let text = window._i18n[key] || key;
  if (params) {
    Object.keys(params).forEach(k => {
      text = text.replace('{' + k + '}', params[k]);
    });
  }
  return text;
}

// 3. Uso no codigo
// ANTES: "Ninguem encontrado ainda. Continue encostando..."
// DEPOIS: t('sonic.nobody_found')

// 4. Com parametros dinamicos
// ANTES: name + " te deu uma estrela!"
// DEPOIS: t('notification.star_received', { name: name })
```

**Backend (server.js):**

```
// 1. Arquivo de frases por idioma
// /i18n/phrases-en.json, /i18n/phrases-pt-br.json, etc.

// 2. O servidor recebe o idioma do usuario via header Accept-Language
//    ou campo 'lang' no perfil do usuario (salvo no Firebase)

// 3. Funcao getPhrase(category, lang) retorna frase no idioma correto

// 4. API responses incluem textos no idioma do usuario
```

**Estrutura dos arquivos JSON:**

```
/public/i18n/
  en.json        (~1200 chaves -- UI do app)
  pt-br.json     (~1200 chaves -- base atual)
  es.json        (~1200 chaves)
  ja.json        (~1200 chaves)

/i18n/
  phrases-en.json    (~205 frases poeticas)
  phrases-pt-br.json (~205 frases poeticas)
  phrases-es.json    (~205 frases poeticas)
  phrases-ja.json    (~205 frases poeticas)
  zodiac-en.json     (~54 frases zodiacais)
  zodiac-pt-br.json  (~54 frases zodiacais)
  zodiac-es.json     (~54 frases zodiacais)
  zodiac-ja.json     (~54 frases zodiacais)
  errors-en.json     (~65 mensagens de erro)
  errors-pt-br.json  (~65 mensagens de erro)
  errors-es.json     (~65 mensagens de erro)
  errors-ja.json     (~65 mensagens de erro)
```

### COMO O USUARIO TROCA O IDIOMA

1. **Tela de Perfil (home):** Novo item "Language" com bandeiras
   - US (English) / BR (Portugues) / LATAM (Espanol) / JP (Japanese)
2. **Salva no Firebase** campo `lang` no perfil do usuario
3. **Aplica imediatamente** sem recarregar (troca todas as strings via JS)
4. **Persiste entre sessoes** -- ao logar, carrega o idioma salvo
5. **Default por regiao:** Na primeira vez, detecta via `navigator.language`
   - en-* = English / pt-* = Portugues / es-* = Espanol / ja = Japanese

### POR QUE ESSA ABORDAGEM

| Criterio | Score |
|----------|-------|
| Leveza (nao pesa carregamento) | Cada JSON ~30-50KB, carrega 1 por vez |
| Simplicidade de implementacao | Funcao t() e direta, sem framework |
| Compativel com SPA monolitico | Sim, nao precisa refatorar |
| Troca sem recarregar | Sim, via JS puro |
| Backend tambem traduz | Sim, frases poeticas vem traduzidas |
| Facil de manter | Adicionar novo idioma = novo JSON |

### ALTERNATIVAS CONSIDERADAS (e por que nao)

1. **i18next (framework):** Muito pesado para um SPA sem build system
2. **Atributos data-i18n no HTML:** Precisaria reescrever todo o HTML
3. **Traducao inline (duplicar HTML):** Multiplicaria o tamanho do arquivo por 4x
4. **Google Translate widget:** Qualidade ruim, especialmente para frases poeticas

---

## FASE 3: TEXTOS ESPECIAIS -- ABORDAGEM CRIATIVA

### Principios para traducao das frases poeticas:

**INGLES (US):**
- Tom: Sofisticado, minimalista, tipo copy de startup premium
- Referencia: Be Real, Locket, mas com mais profundidade
- Frases curtas, impactantes, sem ser "corporate"
- Exemplo: "Presenca aceita" -> "Presence acknowledged." (nao "Nice to meet you")
- Exemplo: "O acaso tem bom gosto" -> "Chance has taste." (nao "What a coincidence")

**ESPANHOL (LATAM):**
- Tom: Calor latino com elegancia, nunca cafona
- Evitar regionalismos extremos (funcionar em Mexico, Colombia, Argentina)
- Exemplo: "Dois mundos, um gesto" -> "Dos mundos, un gesto."
- Manter a poesia mas com o calor natural do espanhol

**JAPONES:**
- Tom: Respeito, sutileza, privacidade
- Frases podem ser mais curtas ainda (japones e naturalmente conciso)
- Usar registros formais mas acolhedores (desu/masu, nao keigo excessivo)
- Exemplo: "Presenca aceita" -> Algo como "Presenca confirmada" em tom respeitoso

### Nomes de jogos por idioma:

| PT-BR | EN (US) | ES (LATAM) | JA |
|-------|---------|------------|-----|
| Campo Minado | Minesweeper | Buscaminas | Mainsuiipaa |
| Cor Errada | Wrong Color | Color Errado | Machigatta Iro |
| Empilha | Stack Up | Apila | Tsumi Kasane |
| Dama | Checkers | Damas | Chekkaa |
| Impostor | Impostor | Impostor | Inpostaa |
| Memory | Memory | Memoria | Memori |
| Rali | Rally | Rally | Rarii |
| Reflexo | Reflex | Reflejo | Hansha |
| Speed Tap | Speed Tap | Speed Tap | Supiido Tappu |
| Xadrez | Chess | Ajedrez | Chesu |
| 2048 | 2048 | 2048 | 2048 |

---

## FASE 4: ORDEM DE EXECUCAO (apos aprovacao)

### Sprint 1 -- Infraestrutura + English (Prioridade #1)
1. Criar estrutura de pastas /public/i18n/ e /i18n/
2. Extrair todas as strings do index.html para pt-br.json
3. Implementar funcao t() no frontend
4. Substituir todos os textos hardcoded por t('chave')
5. Criar en.json com todas as traducoes em ingles
6. Implementar seletor de idioma na tela de perfil
7. Implementar deteccao automatica de idioma (navigator.language)
8. Traduzir frases poeticas para ingles (adaptacao criativa)
9. Traduzir frases zodiacais para ingles
10. Implementar i18n no server.js (frases, erros, zodiac)

### Sprint 2 -- Landing Page + Termos
11. Traduzir site.html para ingles
12. Traduzir termos.html para ingles (revisao legal necessaria)

### Sprint 3 -- Jogos + Paineis
13. Traduzir todos os 11 jogos
14. Traduzir games/index.html (lobby)
15. Traduzir operator.html e operator-restaurant.html
16. Traduzir va-test.html e va-admin.html
17. Traduzir admin.html

### Sprint 4 -- Espanol (LATAM)
18. Criar es.json (UI completa)
19. Traduzir frases poeticas para espanhol
20. Traduzir landing page e termos

### Sprint 5 -- Japanese
21. Criar ja.json (UI completa)
22. Traduzir frases poeticas para japones
23. Traduzir landing page e termos

### Sprint 6 -- Validacao
24. Verificar que NENHUM texto hardcoded ficou para tras
25. Testar troca de idioma sem quebrar layout
26. Verificar frases poeticas soam naturais
27. Validar termos legais em cada idioma

---

## INVENTARIOS DETALHADOS

Os inventarios completos com TODAS as strings, linha por linha, estao em:

- `I18N_INVENTORY.md` -- Frases poeticas + zodiac + erros do server.js (380+ strings)
- `I18N-INVENTORY.md` -- Arquivos secundarios: site, termos, operator, admin, jogos (450+ strings)
- `docs/I18N_TEXT_INVENTORY.md` -- UI do index.html completa (365+ strings)
- `I18N_STRINGS_REFERENCE.csv` -- CSV pesquisavel com todas as strings

---

Aguardando aprovacao para iniciar a FASE 4 (execucao).
