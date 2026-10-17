# BACKLOG — visto e não feito (máx. 30 linhas)

- (11/10) O caminho do recibo da divisão no aparelho (executar/recuperar comando) não tem teste próprio; os fluxos de navegador da E5/E6 devem cobri-lo.
- (11/10) Sobras da E5b-1: o componente `Step` e os estilos `.step`/`.step-number` em components.tsx ficaram sem uso; `.tabs` em registration.css é CSS morto; o aviso offline em App.tsx ainda diz "rascunhos".
- (11/10) Na divisão, pagar acima do direito é barrado no aparelho antes de chegar ao servidor; o caminho de rejeição do servidor só é exercitado no SQL, não no navegador.
- (11/10) Os diálogos de finanças, planejamento e registro não bloqueiam quando há um comando da divisão pendente (só a Revisão conta).
- (11/10) Saiu das telas a lista de alertas 30/15/7/1 do resgate (o núcleo ainda calcula); o demonstrativo voltou a Dividir em 15/10.
- (11/10) `DivisaoPendente` em bolao-dividir-decisao.tsx ficou sem uso depois da Revisão nova; a regra `.pool-card h2` encolhe títulos para 19 px dentro dos cartões do bolão (parece não intencional).
- (11/10) Na lista de Bolões, "Encerrados" não sabe se ainda há prêmio por pagar (só olha resultado e cotas); cruzar com a divisão.
- (11/10) A rota pública do cartão do participante (`GET /v1/participant_card`) não tem limite de taxa; o token tem 256 bits, mas convém um limite por IP antes de abrir para muita gente.
- (11/10) O cartão do participante não mostra a foto do bilhete (spec: imagem original fora de página compartilhada); se o dono quiser, usar URL temporária.
- (12/10) Em Sorteio a 1440 px, `medir.mjs` acusa seis bolas de jogos com texto #1b1446 em contraste 1,15 (as de "Ver mais jogos"?); já acontecia antes do redesign; conferir se é bola dobrada/escondida ou cor de fato.
- (12/10) Visto no teste real: a Revisão diz "Nada para revisar" no topo enquanto há "Combinados pendentes" logo abaixo; as revisões de trava e conferência mostram horário cru ("2026-10-14T01:00:00.000Z"); "1 jogos em 1 cartela" sem singular; o formulário de pagamento não tem a opção "Pix" (vai nas observações).
- (12/10) Editar a chave Pix do grupo sobe a versão do grupo e deixa "Publicar nova versão" dos combinados clicável sem mudança de texto; o servidor recusa. Também: num bolão encerrado, os outros botões de Dividir continuam ligados e só o servidor recusa.
- (13/10) Ao repetir, o formulário sugere "concurso anterior + 1" enquanto o botão do Sorteio e a chamada usam o número que a CAIXA publicou; podem divergir quando a CAIXA pula número.
- (13/10) A mensagem "Avisar a turma" do Sorteio só mostra a parte de cada pessoa quando as cotas são iguais; o núcleo já calcula o direito de cada um (usado em Dividir).
- (13/10) O teste SQL do cartão do participante confere `redemptionDeadlineDate`/`prizeRedeemed` só no caso já resgatado; falta o caso com prêmio por resgatar, e o conferidor PGlite não cruza esses campos com o núcleo.
- (13/10) Movimento: a seta de "Ver conta" só gira de volta quando o recolher termina (open sai no fim); em Dividir, "ir para Registrar" troca de tela e a janela some seca; na gaveta "Avisar a turma", compartilhar/copiar/baixar fecham seco de propósito (o aviso tem que aparecer por cima).
- (17/10) Comprovante pelo cartão: se o registro da resposta falhar depois do upload, o arquivo fica órfão no bucket `participant-proofs` (ninguém o lê; nada apaga lá); um contador de órfãos ou uma limpeza no servidor resolveria.
