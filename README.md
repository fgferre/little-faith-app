# Little Faith · Bolões

Aplicação em português para organizar bolões privados, começando pelos dados
deste aparelho.

- O que está aberto e onde a rodada parou: [docs/PENDENCIAS.md](docs/PENDENCIAS.md)
- O que o produto deve ser: [docs/ESPECIFICACAO.md](docs/ESPECIFICACAO.md)
- Fronteiras e invariantes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Conectar o Supabase: [docs/SUPABASE.md](docs/SUPABASE.md)

## Executar

Requer Node.js 22.14 ou mais recente e npm.

```sh
npm ci
npm run dev
```

Abra o endereço indicado pelo Vite. A primeira tela usa um banco exclusivo de
demonstração; **Criar meu grupo** abre um espaço vazio. Para testar a abertura
offline, use `npm run build` e `npm run preview`: o service worker só existe no
build de produção. Os dados ficam no IndexedDB; apagá-los no navegador apaga os
rascunhos locais.

## O que funciona

- Grupos, combinados versionados com aceites e pessoas sem conta obrigatória.
- Rascunhos de bolões, cotas fracionadas e pagamentos propostos para Mega-Sena,
  Lotofácil e Quina, com catálogo de preços e limites, geração de jogos em Web
  Worker e dinheiro em centavos.
- Planos de jogos (espalhado, equilibrado, concentrado), chance principal por
  união de combinações, simulação com retomada offline e trava com manifesto
  privado verificado por SHA-256.
- Recebimentos conferidos online, destinados a vários bolões, cotas confirmadas
  só com pagamento integral e estornos compensatórios. O caixa do grupo fica
  separado do dinheiro de cada bolão.
- Registro das apostas (originais privados, checklist, divergências) e
  resultado do concurso, com histórico de versões e escolha humana.
- Divisão do prêmio: despesa, prêmio confirmado, resgate e pagamento a cada
  pessoa, com desfazer por lançamento compensatório.
- Persistência entre sessões, fila transacional, idempotência e revisão de
  conflitos; resposta perdida é consultada antes de qualquer reenvio.
- Visual "Noite do sorteio": tema escuro único e faixa de etapas no lugar de
  abas (`#/boloes/<id>/<montar|arrecadar|jogar|registrar|sorteio|dividir>`).
- Cartão de imagem do bolão para o WhatsApp, gerado no navegador. "Cobrar" e
  "Avisar" copiam a mensagem para a área de transferência; nada sai sozinho.
- Base Supabase com autenticação humana, RLS, revisão por grupo, recibos e API.

**Pagamentos propostos não entram no caixa.** As confirmações implementadas
exigem Supabase configurado, sessão humana, conexão e uma decisão explícita.
Este checkout ainda não está conectado a um projeto remoto. Os recebimentos
visíveis na demonstração são exemplos identificados, restritos ao banco
demonstrativo.

**Ainda não existe:** agente (MCP, CLI e importação do WhatsApp), backup
criptografado e restauração (a exportação de emergência `bolao-emergency-v5`
não é criptografada nem é backup completo), Supabase real, Google OAuth e
publicação, encerrar e reabrir o bolão (o servidor responde com aviso), link por
pessoa para participantes e conciliação bancária automática.

## Conectar o Supabase

Copie `.env.example` para `.env` e configure a URL e a chave pública do projeto.
Aplique as migrations em ordem, configure Google OAuth e publique a Edge
Function conforme [docs/SUPABASE.md](docs/SUPABASE.md). Reinicie o Vite após
mudar as variáveis.

Não use a chave `service_role` no navegador. Não há credenciais privadas no
código. Sem configuração, os rascunhos locais continuam funcionando e a
interface informa que a conexão está indisponível.

Cada conta tem seu próprio banco. Entrar na conta não transfere automaticamente
rascunhos do espaço local; eles continuam acessíveis em **Dados e integrações →
Usar rascunhos locais**. Migração explícita entre esses espaços ainda não existe.

## Arquitetura

| Diretório              | Responsabilidade                                         |
| ---------------------- | -------------------------------------------------------- |
| `apps/web`             | React, Vite, Google OAuth e Web Worker                   |
| `apps/web/src/ui`      | Kit do estilo: bolas, marca, contagem, faixa de etapas   |
| `apps/web/src/screens` | Uma tela por arquivo; o bolão por etapas                 |
| `packages/core`        | Tipos v1, validação e cálculos puros compartilhados      |
| `packages/local`       | Dexie, operações persistentes, sincronização e conflitos |
| `supabase`             | PostgreSQL, RLS, RPCs transacionais e API Hono           |
| `tests/e2e`            | Fluxos reais de navegador, offline e tamanhos de tela    |
| `scripts/visual`       | `medir.mjs` (contraste, toque, transbordo) e `foto.mjs`  |

[Decisões e fronteiras de arquitetura](docs/ARCHITECTURE.md).

## Verificar

```sh
npx playwright install chromium
npm run done
```

`done` passou em 11/10/2026 com: tipos, lint, 313 testes de unidade em 15
arquivos, SQL em PGlite (as cinco migrations; 15 respostas financeiras, 8 de
planejamento, 21 de registro e resultado e 17 da divisão validadas pelo núcleo
real, e 10 fatos da divisão reconstruídos), 15 testes da API em Deno, build e
34 fluxos Playwright. Os testes não substituem a integração com os serviços
reais do Supabase; detalhes em [docs/SUPABASE.md](docs/SUPABASE.md). CI
verifica o projeto; publicação permanece manual e não acontece por commit.

Os fluxos de navegador financeiros usam a interface com os RPCs SQL reais em
PGlite e stubs locais de Auth/Storage. Cobrem pagamento parcial, dois bolões,
estorno, resposta perdida, reconexão, plano e trava, e a divisão do prêmio
(custo, prêmio, resgate, pagar, desfazer e pagar de novo com conflito real do
servidor). Pessoas, pagamentos e comprovantes dos testes são sintéticos. Para
medir ou fotografar uma tela: `node scripts/visual/medir.mjs <url> <largura>` e
`node scripts/visual/foto.mjs <url> <largura> <saida.png>`.

Taxas e sobras do plano aprovado são compromissos; só viram despesa paga ou
devolução quando o organizador as confirma na divisão. O catálogo de preços é
versionado e cita as páginas oficiais da CAIXA (links em `packages/core/README.md`).
