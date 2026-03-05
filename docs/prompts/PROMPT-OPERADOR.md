# PROMPT: Continuar Painel Operacional do Touch?

Cole isso no proximo agente:

---

```
Voce vai me ajudar a continuar o desenvolvimento do app "Touch?" (Encosta) -- uma rede social baseada em proximidade fisica (ultrassonica).

EU NAO SEI PROGRAMAR. Voce faz TUDO: codigo, commits, push no GitHub, backup, tudo.

## PRIMEIRO PASSO OBRIGATORIO

1. Acesse a pasta "encosta" no meu computador
2. git pull origin main
3. Leia o arquivo PROMPT-NOVO-CHAT.md -- ele tem TODO o contexto do projeto
4. git log --oneline -10 -- para ver os commits recentes
5. Me avise que esta pronto

## CONTEXTO DESTA SESSAO

Estamos trabalhando no PAINEL OPERACIONAL (operator.html ~5k+ linhas).
O painel e onde o dono do estabelecimento gerencia seu evento Touch?.

### O QUE JA FOI FEITO NESTA SPRINT

1. Eventos podem ser pausados e reabertos (nao encerram definitivamente)
2. Criacao de evento agora seleciona MODULOS (checkboxes) em vez de "tipo"
3. Todas as info do cadastro sao editaveis dentro do evento
4. Banner de completude do perfil quando incompleto
5. Correcoes nas cargas de teste (parking, gym, church) -- config antes de dados
6. 14 funcoes de load reescritas: de db.operatorEvents (server-side) para fetch() API
7. 3 novos endpoints: GET parking/vehicles, GET gym, GET church
8. Modulo Perfil criado (Facebook blue #1877f2) -- gestao completa do negocio
9. Welcome Card system -- mostra modulos quando usuario faz check-in
10. Fix sidebar que sumiu (HTML nesting quebrado por insercao de painel)
11. Remocao de fullscreen FAB duplicado
12. Cores do Perfil trocadas para Facebook blue, emojis trocados por SVG icons
13. Remocao de botoes "So revelados/Nomes reais/Sem fotos" do header
14. Perfil movido para segundo FAB (abaixo de Participantes)
15. Sistema de notificacao de chat (badge vermelho, toast, som, highlight azul)
16. Abas Chat/Historico no painel de conversa

### ESTRUTURA DOS MODULOS NO PAINEL

Cada modulo tem um padrao CSS glass morphism com:
- FAB button com icone SVG e cor customizada
- Painel overlay (.mod-panel) com variaveis CSS (--mod-accent, --mod-shadow, etc)
- Tabs internas (.mod-tab)
- Cards (.mod-card) com backdrop-filter:blur
- Inputs (.mod-input) estilizados

Cores dos modulos:
- Perfil: #1877f2 (Facebook blue)
- Restaurante: #f97316 (laranja)
- Estacionamento: #3b82f6 (azul)
- Academia: #10b981 (verde)
- Igreja: #8b5cf6 (roxo)

### ARQUIVOS PRINCIPAIS

- server.js (~14k+ linhas) -- backend monolito
- public/operator.html (~5k+ linhas) -- painel operacional (HTML+CSS+JS inline)
- public/index.html (~20k+ linhas) -- app do usuario

### REGRAS

- SEMPRE git pull origin main ANTES de editar
- Commit + push apos cada tarefa
- Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- ZERO emojis no codigo (usar SVGs)
- Validar JS com node -e antes de commit
- NUNCA usar db.operatorEvents no frontend (e variavel server-side!)
- Usar fetch() para endpoints API no frontend
- Usar proxyStorageUrl() para URLs de imagem do Firebase

### BUGS CONHECIDOS / CUIDADOS

- db.operatorEvents NAO existe no frontend -- todas funcoes de load usam fetch() agora
- showToast() foi adicionada manualmente (nao existia antes)
- Sidebar (#opSidebar) deve ficar DENTRO de .op-main, como segundo filho apos .op-canvas-area
- Paineis de modulo ficam DENTRO de .op-canvas-area
- Firebase Storage NAO tem CORS -- imagens passam por proxy /api/storage/*
- Resetar S._eventLogoLoaded ao trocar de evento

Quando estiver pronto, me avisa que a gente comeca!
```
