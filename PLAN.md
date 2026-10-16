Quadro de desenho: a linha da pessoa em Arrecadar e a página de venda — pedido do dono em 15/10.

## Por quê, nas palavras dele (15/10)

- Sobre a linha da pessoa em Arrecadar: "Acho que temos uma grande oportunidade de design nesse cartão. Aliás o que é
  pessoa financeira?!? Confuso isso demais. Parece português inventado por máquinas". ("Pessoa financeira" é o nome de
  teste das fixtures; a foto que ele viu saiu de um teste.)
- Sobre a página de venda: "faz falta é um landing page [...] qual que é o passo 1, 2, 3 [...] como que a gente vende esse
  produto, para que dor que ele veio, o que que ele está resolvendo [...] é tão fácil quanto 1, 2, 3 [...] Eu não sei se a
  gente já chegou lá, nesse fluxo simples e bacana e fácil e com marketing bom e vendedor claro."
- A dor do apostador: "não sabe que números que apostou nos últimos, não sabe gerar de forma automática novas apostas,
  né, dependendo da regra, dependendo do número de apostas por jogo."

## Passos

1. Antes de desenhar, perguntar a ele as duas coisas em aberto (com opções e uma recomendação):
   a) a página fala primeiro com quem organiza ou com quem aposta? (recomendação: organizador na manchete; números e
   confiança como apoio);
   b) a página promete o que o app faz hoje ou o fluxo que queremos? (se for o fluxo, ela só vai ao ar com os buracos
   fechados).
2. Criar um quadro novo do tipo Design (Artifact) "Linha da pessoa e página de venda", na régua do app (cores, Sora/Inter/
   Fraunces, bolas de prata e ouro; ver `apps/web/src/styles.css :root` e `apps/web/src/ui/ui.css`).
3. Linha da pessoa (hoje em `apps/web/src/screens/bolao-arrecadar.tsx`, `linkRow` e a lista `pool-people`): a tela de hoje
   ao lado de 2 ou 3 versões, no celular (390) e no computador. Nomes de verdade da Confraria (o quadro é privado dele).
   Estados: pagou; pagou parte; mandou comprovante a conferir; valor não bate; sem WhatsApp; com WhatsApp; link já enviado.
   Problemas vistos: "pagou R$ 0,00" ao lado de "enviou R$ 30,00 · falta R$ 60,00"; alerta vermelho grande para diferença
   de valor; botões soltos (comprovante, WhatsApp, link). Regra dele: fileira de botões não quebra nem estica.
4. Página de venda: duas versões (manchete no organizador; manchete nos números), cada uma com as três dores
   (organizador: trabalho de cobrar, conferir e dividir; participante: confiança; apostador: lembrar e repetir números,
   gerar jogos dentro da regra, simples ou ampliado) e o passo 1, 2, 3. Embaixo de cada passo, um bilhete com o que o
   app ainda exige hoje:
   - Passo 1 (monte e chame a turma): combinados, aceite de cada pessoa, trava com duas confirmações.
   - Passo 2 (cada um paga e vê seu cartão): cada pagamento pede duas janelas e espera do servidor; quem confirma é o
     organizador.
   - Passo 3 (o sorteio confere sozinho): a CAIXA barra a busca do servidor; conferência do registro com vários campos por
     bilhete; "sem prêmio" ainda se confirma à mão.
   Pontos fortes que já existem e ninguém vê: "Gerar jogos" e "Comparar alternativas" (planos dentro do orçamento, com
   custo e chance, ex. "1 em 611 mil"); a regra explicada em cada jogo ("7 dezenas · vale 7 jogos · R$ 42,00").
   Falta: ver os números jogados nas últimas rodadas; repetir os números (teimosinha, fila 8).
5. Mostrar lado a lado e esperar a escolha dele antes de qualquer código.

## Decisões já tomadas

- Nada é publicado antes do sim dele (item 14 de `docs/PENDENCIAS.md`).
- A página não promete o que o app não faz sem marcar o que falta.

## Fora do escopo

Código do app, publicar, a sobra marcada como reserva do grupo que a divisão ignora (item 15; mexe com dinheiro, decidir
com ele), e o envio automático pelo WhatsApp (decisão dele de 13/10).
