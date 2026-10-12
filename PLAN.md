# PLAN.md — Redesign "Noite em boa companhia" (12/10/2026)

Tarefa: aplicar o plano desenhado pelo ChatGPT (cópia em `.tmp/marca/PLAN-chatgpt.md`; proposta em
`.tmp/marca/proposta-chatgpt/`) adaptado ao que o app já tem. Branch `redesign/noite-companhia`; nada de
meio-caminho em `main` (pedido da sessão do piloto, que publica `main` no passo 7). Sessão do piloto é dona de
`docs/PENDENCIAS.md`, `docs/PILOTO.md`, `.env` e `supabase/`; avisar a ela antes de `npm run done`/Playwright.

Escolhas dele (12/10, com imagem): marca **Laço da turma** (quatro fitas; pequeno vira trevo); letra **só Sora**
(sem Fraunces; logo sem Inter também: "tudo na letra atual").

Passos:
1. [x] Comparação de marca fora da produção (`.tmp/marca/comparacao.html`, símbolos em `.tmp/marca/marcas.js`).
2. [x] Favicon `laco.svg`, ícones 192/512/maskable/apple, manifesto, lista offline (`apps/web/public`, `index.html`, `vite.config.ts`).
3. [x] `BrandMark` em SVG (ids únicos por instância: a cópia escondida não pinta gradientes) e o mesmo laço no cartão do WhatsApp (`ui/cartao.ts`).
4. [x] Área ilustrada do Início com a cena 3D do ChatGPT (`src/assets/inicio-companhia-{900,1536}.jpg`), ≤ 280 px no celular, paralaxe ≤ 6 px só com mouse; h1 "Faça sua fezinha…" mantido (teste); `.home-hero` continua no cartão da contagem (teste).
5. [x] Movimento: bolas 70 ms entre dezenas (era 180), prêmio contando em 800 ms (era 1200), botões 180 ms, entrada de tela 360 ms escalonada; tudo desligado com movimento reduzido (CSS global já faz).
6. [x] Conferir 320/360/390/768/1440 (`scripts/visual/foto.mjs`, `medir.mjs`), fluxos de antes e depois.
7. [x] Paleta mais quente/escura como a proposta: antes/depois mostrado e aprovado por ele (12/10, fim da tarde); aplicada em `styles.css` (tokens), `ui.css`, `cartao.ts` (fundo do cartão), `index.html` e manifesto (theme-color), ícones regenerados.
8. [x] `docs/estilo/DIRECAO.md` atualizado; `npm run done` (avisar o piloto); um commit por etapa.

Fora de escopo: APIs, banco, rotas, tokens, formatos financeiros; Sorteio com "Revelar resultado" (o plano proíbe
esconder informação); Inter e Fraunces; imagem 3D de prêmio (fica para depois, sob demanda).

Estado em 12/10, fim da tarde: passos 1–6 e 8 feitos; `npm run done` verde no worktree
`/Users/fgferre/Github/Little Faith App-redesign` (314 unitários, SQL, 16 API, build, 39 fluxos). Paleta aplicada e aprovada; falta a palavra dele para juntar o branch em `main` (o piloto publica `main`). Comparação de marca e capturas desta rodada em `.tmp/marca/` do checkout principal (apagável).
