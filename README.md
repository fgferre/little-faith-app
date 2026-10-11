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
demonstração. **Criar meu grupo** abre um espaço vazio para seus próprios
rascunhos.

Para testar a versão com abertura offline:

```sh
npm run build
npm run preview
```

O service worker é gerado apenas no build de produção. Depois da primeira
abertura online, ele mantém os arquivos públicos da aplicação disponíveis
offline. Os dados ficam no IndexedDB; apagar os dados do navegador também apaga
os rascunhos locais.

## O que funciona

- Grupos separados, combinados iniciais e pessoas sem conta obrigatória.
- Rascunhos de bolões, cotas fracionadas e pagamentos propostos.
- Mega-Sena, Lotofácil e Quina: validação, preço e geração de jogos em Web
  Worker.
- Dinheiro em centavos, probabilidades individuais exatas, múltiplos prêmios e
  rateio no núcleo.
- Persistência entre sessões, fila transacional, idempotência e revisão de
  conflitos.
- Layout para computador e celular, tema escuro, teclado e movimento reduzido.
- Base Supabase com autenticação humana, RLS, revisão por grupo, recibos e API
  de sincronização de rascunhos.
- Publicação de combinados versionados e aceites com evidência.
- Conferência humana online de recebimentos, destinação a vários bolões,
  confirmação de participações integralmente pagas e estornos compensatórios.
- Caixa do grupo separado do dinheiro destinado a cada bolão, com histórico
  imutável e revogação de participações que perderem o pagamento integral.
- Decisões financeiras persistidas antes de enviar, consulta de respostas
  perdidas e reenvio explícito com o mesmo conteúdo e chave.
- Comparação de planos espalhados, equilibrados e concentrados, preservando
  jogos fixos e usando participações integralmente financiadas.
- Catálogo completo de preços e limites de cartelas/cotas por modalidade e
  quantidade de dezenas; correspondência exata de direitos no modo oficial.
- Chance principal por união de combinações e simulação em worker, com 200 mil
  sorteios, refinamento para 1 milhão, intervalo de 95% e retomada offline.
- Aplicação humana de plano e trava online com manifesto privado versionado,
  direitos congelados e SHA-256 verificado ao baixar.

**Pagamentos propostos não entram no caixa.** As confirmações implementadas
exigem Supabase configurado, sessão humana, conexão e uma decisão explícita.
Este checkout ainda não está conectado a um projeto remoto. Registro de
apostas, resultados, distribuição, MCP/CLI e recuperação completa são as
etapas seguintes. Os recebimentos visíveis na demonstração são exemplos
identificados, restritos ao banco demonstrativo.

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
Usar rascunhos locais**. Migração explícita entre esses espaços faz parte da
próxima etapa.

## Arquitetura

| Diretório        | Responsabilidade                                         |
| ---------------- | -------------------------------------------------------- |
| `apps/web`       | React, Vite, interface, Google OAuth e Web Worker        |
| `packages/core`  | Tipos v1, validação e cálculos puros compartilhados      |
| `packages/local` | Dexie, operações persistentes, sincronização e conflitos |
| `supabase`       | PostgreSQL, RLS, RPCs transacionais e API Hono           |
| `tests/e2e`      | Fluxos reais de navegador, offline e tamanhos de tela    |

[Decisões e fronteiras de arquitetura](docs/ARCHITECTURE.md).

## Verificar

```sh
npx playwright install chromium
npm run done
```

`done` verifica tipos, lint, testes de núcleo/persistência, SQL em PGlite, API
em Deno, build e fluxos Playwright. PGlite e Deno são dependências de
desenvolvimento locais, instaladas pelo npm. Os testes não substituem a
integração com os serviços reais do Supabase; detalhes em
[docs/SUPABASE.md](docs/SUPABASE.md). CI verifica o projeto; publicação
permanece manual e não acontece por commit.

Os testes financeiros de navegador usam a interface com os RPCs SQL reais em
PGlite e stubs locais de Auth/Storage, em portas exclusivas de testes. Cobrem
pagamento parcial, dois bolões, estorno e revogação, versões dos combinados,
resposta perdida, reconexão e aprovação invalidada por alterações concorrentes.
Também cobrem aplicação de planos, trava, manifesto privado verificado,
preservação de versões e revisão coerente com o mesmo estado do servidor.

O catálogo básico é versionado e referencia as páginas oficiais da
[Mega-Sena](https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx),
[Lotofácil](https://loterias.caixa.gov.br/Paginas/Lotofacil.aspx) e
[Quina](https://loterias.caixa.gov.br/Paginas/Quina.aspx). Compatibilidade de
cotas e cartelas oficiais é verificada pelo catálogo completo versionado do
planejamento. Taxas e sobras aprovadas ainda são compromissos; não representam
despesas pagas, devoluções ou crédito de carteira executados.
