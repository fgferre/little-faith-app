# Implementação · fundação, finanças e planejamento

> **Checkpoint de 10/10/2026:** este documento descreve a base anterior. A etapa
> 5 avançou e a etapa 6 está parcial. Consulte [PENDENCIAS.md](PENDENCIAS.md) para o
> estado atual, falhas conhecidas e ordem de retomada. O sucesso de `npm run done`
> registrado ao final é histórico e não aprova o checkout atual.

Fundação iniciada em 07/10/2026; finanças, planejamento e verificação atualizados em
08/10/2026.

Esta versão inicia o plano. **A entrega A ainda não está completa.** A especificação
está em
`docs/ESPECIFICACAO.md`.

## Implementado e verificado localmente

- Monorepo npm, TypeScript estrito, lockfile, lint e comando `npm run done`.
- Interface inicial: Início, Bolões, Pessoas e cotas, Jogos, Planejador,
  Revisão, Histórico e Dados.
- Criação de grupos, pessoas e bolões; preparação de cotas e pagamentos.
- Edição de grupo/combinados e dos detalhes do bolão antes de congelar direitos.
- Bancos independentes para demonstração, rascunhos locais e cada conta
  autenticada.
- IndexedDB/Dexie com rascunho e comando gravados juntos, fila persistente e
  recibos.
- Reconexão, descoberta de grupos, paginação, idempotência, edição durante
  sincronização e preservação de conflitos.
- Transporte vinculado à conta que iniciou a sincronização, inclusive quando
  outra conta entra durante uma requisição.
- Dinheiro e cotas exatos, maiores restos e desempate estável no núcleo.
- Catálogo básico das três modalidades, validação, custo combinatório,
  probabilidades individuais e multiplicidades de prêmios.
- Geração determinística em worker; semente de 256 bits, versão do algoritmo e
  parâmetros locais de reprodução. Lotes gerados são gravados atomicamente.
- Aplicação estática com base relativa, rotas por hash e shell offline restrito
  ao caminho de instalação.
- HTML e arquivos públicos permanecem na mesma versão enquanto a atualização
  aguarda a liberação das abas abertas, inclusive durante o uso offline.
- Interface em 320, 390, 768 e 1.440 px, foco de formulários e movimento
  reduzido.
- Estatutos publicados em versões imutáveis e aceites por pessoa com evidência.
- Recebimentos confirmados pelo organizador online, separados das propostas.
- Alocações do mesmo recebimento a vários bolões do grupo, sem duplicar caixa.
- Participações confirmadas somente com pagamento integral destinado à pessoa e
  bolão, maioridade, aceite da versão atual e prazo validado no servidor.
- Estornos integrais com compensação das alocações e revogação dos direitos que
  perderem o pagamento integral. Originais e histórico continuam preservados.
- Decisões financeiras persistidas antes de enviar e fora da fila de rascunhos.
  Reconexão não as reenvia. A consulta do recibo precede qualquer reenvio
  explícito, que mantém o resumo, conteúdo e chave originais.
- Aprovação humana invalidada quando os dados apresentados mudam; conflitos e
  rejeições ficam acessíveis depois de recarregar a página.
- Catálogo completo das três modalidades, com 32 regras por quantidade de
  dezenas, preços e limites de cartelas/cotas oficiais.
- Até três planos heurísticos, preservando números/autoria dos jogos fixos;
  orçamento limitado a direitos integralmente financiados no próprio bolão.
- Cartelas oficiais com proporções inteiras por recibo, valor facial em centavos
  e explicação quando uma estrutura não cabe nas regras.
- Chance principal por união de combinações distintas, sem somar sobreposições.
  Acima de 200 mil expansões, a interface informa que o cálculo exato não está
  disponível; o núcleo permite configurar até 1 milhão.
- Monte Carlo em worker com semente, versão, entradas, 200 mil amostras,
  refinamento para 1 milhão, intervalo de 95% e checkpoints persistentes.
  Cancelamento, reabertura offline e retomada não repetem amostras salvas.
- Aplicação de plano e trava humanas online, com versões imutáveis,
  responsáveis explícitos e manifesto canônico privado com SHA-256.
- Revisão de jogos antes do registro externo conserva financiamento, pessoas e
  responsáveis da primeira trava, mantendo ambas as versões do manifesto.
- Revisão humana combina registros, finanças e planos da mesma revisão do grupo;
  alterações durante a leitura exigem atualizar os dados apresentados.
- Primeira definição de concurso/modo pendente permitida em bolão financiado
  antes do primeiro plano; definições posteriores continuam protegidas.

## Backend preparado

Migrations PostgreSQL e API Hono implementam sincronização de **rascunhos** e
decisões financeiras e de planejamento humanas em transações separadas,
membership, RLS, revisão
monotônica por grupo, recibos imutáveis e trilha de alterações. Fatos
financeiros possuem tabelas próprias e não podem ser criados pela fila de
rascunhos nem por gravação direta do cliente. Sessões de agentes são recusadas,
inclusive tokens antigos de contas reclassificadas no Auth.

Os testes SQL foram executados com PostgreSQL WASM/PGlite e stubs locais de
Auth/Storage. Os testes de contrato/Edge usam Deno. Isso não substitui verificar
a configuração, os serviços reais e o login do Supabase.

## Próxima etapa do plano

| Etapa                   | Estado desta versão                  | Trabalho que falta                                                                                                |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1. Fundação             | Base local implementada              | Configurar e verificar Google OAuth no Supabase real                                                              |
| 2. Sincronização        | Motor, RPCs e fixtures implementados | Piloto com dois aparelhos, Realtime, revogação, nova carga e migração explícita de rascunhos locais               |
| 3. Administração        | Fluxo financeiro testado localmente  | Validar servidor real, convites/visões individuais, despesas, taxas e reservas e demais operações administrativas |
| 4. Jogos e planos       | Planos, simulação e trava testados localmente | Verificar servidor e aparelhos reais; filtros opcionais e melhorias das heurísticas                         |
| 5. Registro e resultado | Pendente                             | Evidências privadas, checklist, divergências e consulta CAIXA                                                     |
| 6. Distribuição         | Núcleo de rateio disponível          | Resgate, distribuição, demonstrativos e encerramento auditável                                                    |
| 7. Agente e importação  | Pendente                             | OAuth específico, MCP/CLI e WhatsApp pelo fluxo de revisão                                                        |
| 8. Recuperação e piloto | Shell offline disponível             | Ícones/installabilidade final, backup AES-256, restauração com arquivos e bolão real completo                     |
| 9–10. Entregas B e C    | Pendentes                            | Administração ampliada e expansão descritas no plano                                                              |

## Limites visíveis

Este checkout ainda está sem Supabase conectado. Nenhum pagamento real foi
confirmado durante o desenvolvimento; todos os testes usam dados sintéticos. O
fluxo implementado exige configuração do servidor, login humano e uma decisão
online. Recebimentos tardios podem ser registrados, mas não criam participação.
Um prazo não definido impede a confirmação da participação.

Aplicação e trava dependem do servidor e da confirmação humana online. Registro
externo e encerramento financeiro ainda são as etapas seguintes. O saldo real
começa em zero; propostas nunca o aumentam. Comparações offline com fontes ainda
não sincronizadas precisam ser geradas novamente após receber versões do servidor.

O caixa atual reúne recebimentos e estornos. Alocações mostram o dinheiro de
cada pessoa em cada bolão; despesas, taxas, reservas, resgates e distribuições
ainda não fazem parte desse saldo. Não há conciliação bancária automática.

Não há backup completo disponível na interface. O pacote local oferece um
snapshot de emergência para desenvolvimento, sem criptografia, que não é
apresentado como recuperação completa. O manifesto baixável é privado e inclui
o retrato financeiro do grupo; não é a página compartilhada para participantes.
Arquivos, links compartilhados e deploy ainda são etapas seguintes.

O Supabase e GitHub Pages não foram configurados nem publicados neste trabalho.
Segredos e credenciais necessários permanecem sob controle do responsável pela
instalação.

## Verificação concluída

`npm run done` passou em 08/10/2026: TypeScript, lint, 133 testes de núcleo e
persistência, 7 testes da API Deno, build e 23 testes de navegador. As duas
migrations também passaram nas verificações SQL; 15 respostas reais do SQL
foram conferidas pelo validador compartilhado.

Os testes já cobrem núcleo/persistência, API Deno, SQL de
RLS/idempotência/limites e finanças em PGlite e navegador. O runner compara
recibos e snapshots do SQL com o validador compartilhado. Os cenários de
interface usam RPCs reais no PostgreSQL embarcado com Auth/Storage locais
simulados; não testam Google OAuth nem Edge↔PostgREST real.

Os fluxos verificam fechamento e reabertura offline, proposta sem efeito no
saldo, pagamento parcial, destinação a dois bolões, confirmação integral,
estorno e revogação, nova versão dos combinados, respostas perdidas, reenvio com
o mesmo conteúdo, conflito concorrente e renovação da aprovação após alterações.
Também verificam duplicatas, fração de centavo, troca de grupo, foco e os quatro
tamanhos de tela. A publicação em subdiretório é simulada com servidor estático
sem fallback de rotas; o worker e a geração funcionam offline dentro do caminho
da aplicação. Uma atualização disponível mantém a versão ativa coerente online
e offline até que o novo service worker possa assumir a aplicação.

`npm audit` não encontrou vulnerabilidades nas dependências npm instaladas.
Capturas de computador e celular foram inspecionadas. Google OAuth, integração
com Supabase real, concorrência entre conexões reais e publicação final
continuam pendentes conforme o quadro acima.
