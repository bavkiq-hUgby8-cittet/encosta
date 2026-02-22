# PROMPT PARA INICIAR NOVO CHAT — Touch? (Encosta)

Copie e cole o texto abaixo ao iniciar um novo chat com outro agente:

---

## O Prompt:

```
Você vai me ajudar a continuar o desenvolvimento do app "Touch?" (Encosta) — uma rede social baseada em proximidade física (ultrassônica).

EU NÃO SEI PROGRAMAR. Você faz TUDO: código, commits, push no GitHub, backup, tudo.

## ACESSO AO PROJETO

1. PASTA NA MÁQUINA (selecione quando o Cowork pedir):
   → A pasta "encosta" no meu computador

2. GITHUB:
   → https://github.com/bavkiq-hUgby8-cittet/encosta.git
   → O token de acesso está configurado no remote do git local (git remote -v)
   → Se precisar reconfigurar, me pergunte

3. GIT CONFIG:
   → Email: ramonnvc@hotmail.com
   → Nome: Ramon

## ESTRUTURA DO PROJETO

- `public/index.html` → Frontend completo (SPA, ~10.000+ linhas)
- `server.js` → Backend Node.js + Express + Socket.IO (~6.000+ linhas)
- `package.json` → Dependências
- `simulador-estrelas.html` → Simulador da economia de estrelas
- `docs/` → Documentação técnica
- `CHANGELOG-sessao-*.md` → Changelogs por sessão

## O QUE FAZER PRIMEIRO

1. Acesse a pasta encosta na minha máquina
2. Leia o `git log --oneline -20` para ver o histórico recente
3. Leia os primeiros ~200 lines do server.js (tem comentários do projeto)
4. Leia o CHANGELOG mais recente
5. Me diga em que pé está o projeto e pergunte o que preciso

## REGRAS DE TRABALHO

- Sempre faça commit com mensagem descritiva em português
- Sempre faça push para o GitHub após cada commit
- Sempre sincronize: o git da máquina deve estar no mesmo commit do GitHub
- Se eu pedir backup, verifique que git status está clean e push foi feito
- Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits
- ZERO emojis no código — usamos SVGs vetoriais para ícones

## CONTEXTO RÁPIDO DO APP

Touch? é um app de conexão por proximidade. As pessoas se aproximam fisicamente,
o celular detecta via ultrassom, e cria uma relação anônima de 24h (chat efêmero).
Podem se revelar, dar estrelas, fazer check-in em eventos, enviar presentes digitais.

Funcionalidades principais: ultrassom, chat 24h, reveal de identidade, constelação
(mapa de conexões), eventos com check-in, economia de estrelas (zero-sum),
painel de operador/restaurante, boarding pass, selfie no reveal, presentes digitais.

Quando estiver pronto, me avisa que a gente começa.
```

---

**Dica:** Depois de colar esse prompt, o agente vai estudar o projeto e te perguntar o que precisa. Aí é só mandar o que quer fazer!
