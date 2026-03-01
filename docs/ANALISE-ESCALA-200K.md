# ANALISE DE ESCALA -- Touch? para 200.000 Usuarios

**Data:** 01/03/2026 | **server.js:** ~14.333 linhas | **index.html:** ~19.960 linhas

---

## RESUMO EXECUTIVO

O Touch? funciona bem para o tamanho atual (centenas de usuarios). Para escalar a 200.000 usuarios ativos em 1 mes, existem 3 problemas criticos que precisam ser resolvidos, 5 problemas serios e 7 otimizacoes recomendadas.

Custo estimado para 200K usuarios: R$2.500-15.000/mes em infraestrutura.

---

## STATUS ATUAL -- TUDO FUNCIONANDO

- server.js: sintaxe OK (validado com node -c)
- index.html: sintaxe OK (todos os blocos JS validados)
- operator.html: sintaxe OK
- GitHub: 100% sincronizado (zero diferenca local vs remote)
- Todos os docs atualizados
- render.yaml e .env.example criados e trackeados

---

## PROBLEMAS CRITICOS (bloqueiam 200K)

### 1. BANCO DE DADOS NA MEMORIA

Todo o Firebase RTDB e carregado na RAM do servidor no startup. Com 200K usuarios, isso seria ~34-42 GB de dados, mas um servidor Node.js suporta no maximo 2-4 GB. O app simplesmente nao inicia. Crash imediato.

Solucao: Migrar para PostgreSQL ou MongoDB com queries sob demanda. Estimativa: 3-4 semanas.

Limite atual: ~20.000-50.000 usuarios antes de estourar a memoria.

### 2. PROCESSO UNICO (Sem Clustering)

O server.js roda em 1 unico processo Node.js. Socket.IO suporta ~3.000-5.000 conexoes simultaneas por processo. Com 200K usuarios e 5% online = 10.000 conexoes. O servidor trava.

Solucao: PM2 cluster mode + Redis para compartilhar estado. Estimativa: 1 semana.

### 3. FIREBASE RTDB -- LIMITES E CUSTOS

O plano Spark (gratuito) suporta apenas 100 conexoes simultaneas e 1 GB de storage. Cada restart le tudo do Firebase. Em escala, custo: ~$500-1000/mes so em writes.

Solucao: Migrar para banco proprio (PostgreSQL). Custo: ~$50-150/mes. Firebase fica apenas para Auth.

---

## PROBLEMAS SERIOS (degradam performance)

### 4. SCANS O(n) EM TODAS AS COLLECTIONS

187 chamadas .filter() e 166 chamadas Object.values(db.*) que varrem collections inteiras. Dashboard financeiro, constelacao, TopTag recalculation -- tudo faz full table scan. Com 200K usuarios, cada request leva 500ms-2s em vez de 1-5ms.

### 5. index.html DE 1.2 MB SEM COMPRESSAO

~20.000 linhas, ~1.2 MB. Sem gzip, sem code-splitting, sem lazy loading. 200K usuarios = 240 GB de bandwidth/mes so para o arquivo principal.

Solucao rapida: compression middleware (1 linha). Reduz para ~200-300 KB.

### 6. SOCKET.IO SEM RATE LIMITING

Eventos de socket (send-message, typing, game-move) sem rate limiting. Usuario malicioso pode enviar milhares de eventos/segundo.

### 7. ENDPOINTS SEM PAGINACAO

/api/messages/:relationId retorna TODAS as mensagens (pode ser 10.000+). /api/relations/:userId retorna TODAS as relacoes com enrich completo.

### 8. BROADCAST GLOBAL NO MURAL

_broadcastMuralOnline() envia mural-channel-counts para TODOS os clientes conectados toda vez que alguem entra/sai. Com 10K online = milhoes de mensagens.

---

## OTIMIZACOES RAPIDAS (1-2 dias)

| # | O que | Impacto | Tempo |
|---|-------|---------|-------|
| 1 | Adicionar compression (gzip) no Express | -80% bandwidth | 10 min |
| 2 | Paginacao em /api/messages e /api/relations | Evita responses gigantes | 2h |
| 3 | Rate limiting nos socket events | Seguranca contra spam | 2h |
| 4 | Usar IDX existentes em vez de filter() | -90% CPU em queries | 4h |
| 5 | Debounce no _broadcastMuralOnline | -95% msgs broadcast | 30 min |
| 6 | Cache HTTP headers para assets estaticos | -50% requests | 30 min |
| 7 | Monitor de memoria no /api/status | Detectar vazamentos | 30 min |

## OTIMIZACOES MEDIAS (1-2 semanas)

| # | O que | Impacto | Tempo |
|---|-------|---------|-------|
| 8 | PM2 cluster mode + Redis sessions | 4-8x capacidade | 1 semana |
| 9 | CDN (Cloudflare) para assets | -90% bandwidth | 2 dias |
| 10 | Code-split do index.html | -70% first load | 1 semana |
| 11 | Minificar HTML/JS/CSS | -40% tamanho | 2 dias |

## OTIMIZACOES GRANDES (2-4 semanas)

| # | O que | Impacto | Tempo |
|---|-------|---------|-------|
| 12 | Migrar Firebase RTDB para PostgreSQL | Remove limite memoria | 3-4 sem |
| 13 | Arquivar mensagens antigas | -80% dados ativos | 1 semana |
| 14 | Geo-spatial index para nearby | O(log n) vs O(n) | 3 dias |

---

## CUSTOS PARA 200K USUARIOS

### Infraestrutura mensal

| Servico | Plano | Custo/mes |
|---------|-------|-----------|
| Render (Web Service) | Pro (4 instancias) | $100-200 |
| PostgreSQL (Cloud SQL) | db-standard-1 | $50-150 |
| Redis (sessoes + cache) | Basic 1GB | $25-50 |
| Firebase Auth (apenas) | Blaze pay-as-you-go | $25-50 |
| Cloudflare CDN | Pro | $20 |
| OpenAI API (Voice Agent) | Pay-as-you-go | $200-500 |
| **TOTAL** | | **$420-970/mes** |

Em reais: R$2.500-6.000/mes (otimista) a R$10.000-15.000/mes (pessimista, muito Voice Agent).

### APIs de IA (custo variavel)

| API | Uso/mes | Custo |
|-----|---------|-------|
| OpenAI Realtime (Voice) | 100K minutos | $300-500 |
| OpenAI TTS (Radio) | 50K requests | $50-100 |
| Perplexity (Mural) | 200K queries | $100-200 |
| Anthropic (UltimateDEV) | 10K requests | $50-100 |

---

## ROADMAP PARA 200K

### Semana 1: Quick Wins
- compression, paginacao, socket rate limiting, IDX, debounce broadcasts, CDN, cache

### Semana 2: Clustering
- PM2 cluster + Redis para sessoes Socket.IO
- Testes de carga (1K, 5K, 10K conexoes)

### Semana 3-4: Migracao de Banco
- Schema PostgreSQL, migracao de dados
- Reescrever queries (SQL em vez de Object.values/filter)

### Semana 5 (buffer): Estabilizacao
- Load testing completo, monitoring, runbook

Realidade: 30 dias e apertado. Recomendo 45-60 dias para fazer com qualidade.

---

## CONCLUSAO

Prioridade #1: Adicionar compression no Express (10 minutos, impacto imenso).

Prioridade #2: Migrar Firebase RTDB para PostgreSQL (3-4 semanas, essencial).

Prioridade #3: PM2 cluster + Redis (1 semana, multiplica capacidade 4-8x).

---

*Analise: 01/03/2026 | Repo: github.com/bavkiq-hUgby8-cittet/encosta | Commit: feb19b2*
