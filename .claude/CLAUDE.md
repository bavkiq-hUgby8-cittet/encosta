eu nao sei programar entao faca tudo, pense em tudo... subir repositorio no github e tudo..
SEMPRE rode git pull origin main ANTES de editar qualquer arquivo — o agente DEV no Render tambem faz commits e sem pull voce sobrescreve o trabalho dele.
sempre commit e push depois de cada tarefa.
Use Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> nos commits.
ZERO emojis no codigo.
NUNCA commitar tokens, API keys, secrets ou credenciais no repositorio. Tudo via process.env e .env (que ja esta no .gitignore). Se precisar de uma chave nova, adiciona no .env.example sem o valor real.
Leia PROMPT-NOVO-CHAT.md na raiz do projeto ANTES de qualquer coisa — ele tem todo o contexto.

## CONTEXTO RAPIDO (pra nao ter que ler tudo se ja conhece o projeto)

Touch? e um app de conexao por proximidade usando som ultrassonico.
Dois celulares se aproximam TELA CONTRA TELA (screen-to-screen), os speakers conversam, e uma conexao nasce.
Funciona no browser (sem download). Stack: Node.js + Express + Socket.IO + Firebase.
Deploy: Render (touch-irl.com via Cloudflare).

## POSICAO DOS CELULARES (TODO AGENTE PRECISA SABER)

Os celulares ficam COM AS TELAS VIRADAS UMA PARA A OUTRA (screen-to-screen).
Cada pessoa segura na vertical, tela apontando pro celular do outro.
Costas dos celulares viradas pra fora. Alto-falantes na parte de baixo.
Como se os celulares estivessem "se olhando". NAO e topo-com-topo.

## ESTRATEGIA DE LANCAMENTO

- Lancamento nos EUA primeiro (100% remoto, Ramon mora no Brasil)
- Foco inicial: gorjetas digitais ($50B+/ano mercado)
- Marketing: 100% IA (videos Veo 3, imagens Gemini, textos Claude)
- 3 idiomas: EN, PT, ES
- Trafego pago: TikTok 60%, Instagram 30%, YouTube 10%
- Case viral: "1 pessoa que nao sabe programar + IA = app de pagamentos em 20 dias"
- Cadastro: nickname + nascimento + email + senha (18+ obrigatorio)

## ARQUIVOS IMPORTANTES DE ESTRATEGIA

- PROMPT-NOVO-CHAT.md -- contexto COMPLETO do projeto e estrategia
- PROMPTS-VEO3-BATCH1.md -- 16 prompts de video pro Veo 3
- PROMPTS-IMAGENS-GEMINI.md -- 12 prompts de imagem pro Gemini
- GTM-GORJETA-USA.docx -- go-to-market tipping nos EUA
- docs/ARQUITETURA.md -- mapa tecnico completo
- docs/SEGURANCA.md -- auditoria de seguranca
