# BACKLOG — visto e não feito (máx. 30 linhas)

- (11/10) O caminho do recibo da divisão no aparelho (executar/recuperar comando) não tem teste próprio; os fluxos de navegador da E5/E6 devem cobri-lo.
- (11/10) Sobras da E5b-1: o componente `Step` e os estilos `.step`/`.step-number` em components.tsx ficaram sem uso; `.tabs` em registration.css é CSS morto; o aviso offline em App.tsx ainda diz "rascunhos".
- (11/10) Na divisão, pagar acima do direito é barrado no aparelho antes de chegar ao servidor; o caminho de rejeição do servidor só é exercitado no SQL, não no navegador.
- (11/10) Os diálogos de finanças, planejamento e registro não bloqueiam quando há um comando da divisão pendente (só a Revisão conta).
- (11/10) Saíram das telas: o download em texto do demonstrativo do grupo e a lista de alertas 30/15/7/1 do resgate (o núcleo ainda os calcula).
- (11/10) `DivisaoPendente` em bolao-dividir-decisao.tsx ficou sem uso depois da Revisão nova; a regra `.pool-card h2` encolhe títulos para 19 px dentro dos cartões do bolão (parece não intencional).
- (11/10) Na lista de Bolões, "Encerrados" não sabe se ainda há prêmio por pagar (só olha resultado e cotas); cruzar com a divisão.
- (11/10) A rota pública do cartão do participante (`GET /v1/participant_card`) não tem limite de taxa; o token tem 256 bits, mas convém um limite por IP antes de abrir para muita gente.
- (11/10) O cartão do participante não mostra a foto do bilhete (spec: imagem original fora de página compartilhada); se o dono quiser, usar URL temporária.
