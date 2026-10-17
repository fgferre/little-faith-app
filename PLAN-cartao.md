Responder pelo cartão e próximo sorteio automático (e o gancho da doação) — pedido do dono em 16/10, cartão primeiro.

Estado em 17/10: passos 1, 2, 3 e 5 feitos e commitados (44c678a, e3005ed, 8f3cc85, 808121c), `npm run done` verde; falta o passo 4
(esperando o sim dele ao desenho) e a publicação (ordem no bastão de `docs/PENDENCIAS.md`).

## Por quê, nas palavras dele (16/10)

- "o pulo do gato é o organizador deixar de ser uma pessoa e ser o próprio app"; "o app [...] está só sendo um assistente, friendly
  reminders para pessoa não perder o evento ou para esclarecer que ela não vai participar dessa rodada".
- "tem que responder pelo cartão mesmo [...] fica uma coisa mais automática e simples [...] é da forma que a gente quer transformar o app".
- "Precisamos avisar do prêmio estimado e saber aonde vem essa informação de forma automática".
- Estados são selos curtos: "se você colocar frases completas [...] vai estragar todo o layout do app".
- Desenho aprovado no quadro https://claude.ai/artifact/AfAkydz8o4DtoQjhmRVWFU (versão 16): linha A, "Próximo sorteio", barra lateral.
- Cuidados levantados pelo GPT-6 Astra lendo o repositório: `.tmp/critica/astra-2.md`, itens (c) e (d). Ler antes de começar.

## Decisões já tomadas (não reabrir)

Cartão:
1. O cartão mostra, além dos bolões em que a pessoa tem cota, os bolões do grupo em rascunho (não travados) em que ela ainda não
   respondeu, com a pergunta "Vai entrar nesta rodada?" e dois botões: "Estou dentro" e "Desta vez estou fora".
2. "Já paguei" abre o envio do comprovante (foto ou PDF) com o valor; vira "Pix avisado". Nunca vira dinheiro sozinho: só o
   tesoureiro confirma, pelo caminho que já existe (proposta de pagamento + confirmação na Revisão/Arrecadar).
3. Resposta é registro do servidor, só acréscimo, por pessoa e bolão, ligada ao link (o PIN e o cancelamento valem). A última
   resposta vale. Cada envio tem chave de idempotência; sem internet o cartão diz que não enviou e nunca finge que chegou.
4. "Dentro" não cria cota sozinho nesta rodada: o tesoureiro vê "Dentro" e adiciona a cota com um toque (pré-preenchido). Criar
   rascunho pelo servidor fica para depois (mexe na sincronização local-first).
5. "Fora" depois de pagar aparece como "Fora · pagou R$ X"; o dinheiro segue o caminho que já existe (estorno ou deixar no caixa),
   decidido pelo tesoureiro. A resposta nunca move dinheiro.
6. Respostas só enquanto o bolão está em rascunho; travado, o cartão mostra a resposta como leitura.
7. Selos na linha do tesoureiro: "Dentro", "Pix avisado", "Pago", "Fora", "Sem resposta" (e "Tesoureiro"). "Pago" só com
   pagamento confirmado. Totais só do confirmado. Seção "Conferir pagamento".
8. "Lembrar" reenvia a mensagem do link (já existe, guardada no aparelho); o servidor registra quando alguém lembrou, para
   aparecer "lembrado ontem" em qualquer aparelho do tesoureiro.
9. O comprovante do participante vai para o armazenamento privado, como o do registro; tamanho e tipo limitados; nada de CPF.

Próximo sorteio:
10. Fonte: a API oficial da CAIXA (`RESULT_SOURCE_URLS` em `packages/core/src/caixa-results.ts`, sem número = último concurso),
    buscada pelo aparelho (o servidor leva 403). Campos: `numeroConcursoProximo`, `dataProximoConcurso`,
    `valorEstimadoProximoConcurso`, `acumulado`, `valorAcumuladoConcursoEspecial`, `valorAcumuladoConcurso_0_5` com
    `numeroConcursoFinal_0_5`. Conferido ao vivo em 16/10: 3071, 18/10/2026, R$ 170 mi, acumulado.
11. Uma consulta compartilhada (Início, barra lateral, convite, cartão), guardada no aparelho com a hora da coleta; validade de
    algumas horas; falha mantém o último dado e mostra "Não deu para atualizar agora · dado de <quando>"; sem dado, "Estimativa
    indisponível". Nunca estimativa ausente vira zero. Data sem hora fica data (sem virar meia-noite UTC).
12. Valores especiais separados, sob "Acumulado para concursos especiais"; nunca somados ao prêmio do próximo concurso.
13. Barra lateral: "Acumulou. Dia de fezinha." quando acumulou; "Vai uma fezinha?" nos outros dias. Convite sai com "Acumulou.
    Prêmio estimado: R$ X." e "Responda no seu cartão: dentro ou fora.". Início: o bolão da vez antes do prêmio.

Doação:
14. Grátis, aceita doação pela chave Pix do dono: e-mail fgferre@gmail.com (dita por ele em 16/10); ele prefere QR Code, então o
    botão mostra o QR e o copia e cola, sem valor fixo; recebedor "Felipe Ferreira", cidade "Rio de Janeiro" (correção dele em 16/10; antes tinha dito São Paulo). A chave fica numa configuração. Pix copia e cola sem valor fixo. Lugares: Dados e, raramente, depois de
    encerrar a rodada; nunca descontando prêmio nem insistindo.

## Passos

1. [x] Servidor do cartão: tabela de respostas e de lembretes, funções públicas pelo token (com PIN), rota da API, envio do
   comprovante pelo cartão, leitura para o tesoureiro; testes SQL e da API.
2. [x] Cartão: bolões abertos com "Estou dentro" / "Desta vez estou fora", "Já paguei" com comprovante; estados de envio.
3. [x] Arrecadar: selos da linha A, "Conferir pagamento", total confirmado em destaque, "lembrado em", adicionar cota de quem disse
   "Dentro"; e o convite com "Responda no seu cartão".
4. [ ] Próximo sorteio: leitura dos campos novos no núcleo, consulta compartilhada no aparelho, Início, barra lateral, convite e cartão.
5. [x] Doação com a chave em configuração (escondida sem chave).
6. [ ] `npm run done` verde; telas olhadas em três larguras; quadro atualizado se algo mudar; commits por passo; item 14 com as
   migrações novas na ordem.

## Fora do escopo

Publicar; criar cota pelo servidor; aviso no celular (push) e mensagem automática no grupo; a página de venda dentro do app;
escolher a chave Pix da doação (é dele).
