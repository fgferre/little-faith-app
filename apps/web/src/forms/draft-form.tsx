import { useState } from "react";
import type { FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import {
  betCost,
  betSignature,
  formatBRL,
  formatQuotaUnits,
  LOTTERIES,
  parseBRL,
  quotaCost,
  quotaUnits,
  validateBet,
  validatePixReceiver,
} from "@bolao/core";
import type { LocalRecord, LotteryId, PixKeyType } from "@bolao/core";
import { Modal } from "../components";
import { createSeed, generateInWorker } from "../generation";
import { errorMessage } from "../app-shared";
import { ampliado, Balls, Button, Chip, MoneyInput } from "../ui";
import type { FormKind, GenerationRun, SaveRecord } from "../app-shared";
import { parsePastedGames } from "./paste-games";

const localDateInput = (value: string | null) => {
  if (!value) return "";
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const PIX_KEY_LABELS: Record<PixKeyType, string> = {
  phone: "Celular",
  cpf: "CPF",
  email: "E-mail",
  random: "Chave aleatória",
  cnpj: "CNPJ",
};

export function DraftForm(
  {
    kind,
    group,
    pool,
    repeatOf,
    persons,
    quotas,
    bets,
    onClose,
    save,
    saveGenerated,
    onPoolCreated,
    financeEnabled,
    onReviewPayment,
  }: {
    kind: FormKind;
    group: LocalRecord<"group"> | undefined;
    pool: LocalRecord<"pool"> | undefined;
    /** "Repetir com a mesma turma": o novo bolão começa com nome, modalidade, preço, concurso seguinte e forma de participação deste, e leva (na mesma modalidade) os jogos; as pessoas entram pela chamada em Arrecadar. */
    repeatOf?: LocalRecord<"pool"> | undefined;
    persons: LocalRecord<"person">[];
    quotas: LocalRecord<"quota">[];
    bets: LocalRecord<"bet">[];
    onClose: () => void;
    onPoolCreated: (id: string) => void;
    financeEnabled: boolean;
    onReviewPayment: (id: string) => void;
    save: SaveRecord;
    saveGenerated: (run: GenerationRun, generated: number[][]) => Promise<void>;
  },
) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyWarned, setCopyWarned] = useState(false);
  const startLottery = repeatOf?.data.lotteryId ?? pool?.data.lotteryId ??
    "mega-sena";
  const [lotteryId, setLotteryId] = useState<LotteryId>(startLottery);
  const [selected, setSelected] = useState<number[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [personId, setPersonId] = useState(persons[0]?.id ?? "");
  const entityFormKind = kind === "edit-group"
    ? "group"
    : kind === "edit-pool"
    ? "pool"
    : kind;
  const editing = kind === "edit-group" || kind === "edit-pool";
  const priceFrom = editing ? pool : repeatOf;
  const rule = LOTTERIES[lotteryId];
  const pasted = kind === "paste"
    ? parsePastedGames(pastedText, rule, bets.map((b) => b.data.numbers))
    : [];
  const pastedGames = pasted.flatMap((g) => "numbers" in g ? [g.numbers] : []);
  const pastedCost = pastedGames.reduce(
    (sum, numbers) => sum + BigInt(betCost(lotteryId, numbers)),
    0n,
  );
  // Jogo que já está no bolão só fica de fora; linha com erro precisa ser corrigida.
  const pasteReady = pastedGames.length > 0 &&
    pasted.every((g) => !("error" in g));
  const titles = {
    group: "Um grupo para chamar de nosso",
    "edit-group": "Editar grupo e combinados",
    pool: "Preparar um novo bolão",
    "edit-pool": "Editar o bolão",
    person: "Mais uma pessoa na turma",
    quota: "Preparar a cota",
    payment: "Anotar um pagamento",
    bet: "Os números da turma",
    paste: "Colar os jogos da turma",
    generate: "Deixe os números com a gente",
  };
  const descriptions = {
    group: "Fica salvo neste aparelho. Cada grupo tem o seu próprio caixa.",
    "edit-group":
      "Fica salvo neste aparelho. Para os combinados novos valerem, publique de novo na Revisão e registre os aceites.",
    pool: "Fica salvo neste aparelho até sincronizar.",
    "edit-pool":
      "Preço, prazo, modalidade e concurso ficam travados quando já há cotas confirmadas.",
    person: "Cadastrar alguém não cria conta. Quem dá direito ao prêmio é a cota.",
    quota:
      "Uma cota inteira ou uma parte, como 1 ou 1,5. Ela só vale depois de conferida com internet.",
    payment: "Anotar um valor não confirma o pagamento nem mexe no caixa.",
    bet: "O jogo fica neste aparelho. A aposta de verdade é feita na lotérica ou no site da Caixa.",
    paste:
      "Os jogos ficam neste aparelho. A aposta de verdade é feita na lotérica ou no site da Caixa.",
    generate:
      "Os jogos são sorteados neste aparelho, sem repetir. Nenhum jeito de escolher aumenta a chance de ganhar.",
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const fields = new FormData(event.currentTarget);
    const text = (name: string) => String(fields.get(name) ?? "").trim();
    let copyWarning: string | null = null;
    try {
      if (entityFormKind === "group") {
        if (!text("name")) throw new Error("Dê um nome ao grupo.");
        // Sem chave, o grupo fica sem recebedor Pix; com chave, os quatro campos valem juntos.
        const pix = text("pixKey")
          ? validatePixReceiver({
            keyType: text("pixKeyType"),
            key: text("pixKey"),
            name: text("pixName"),
            city: text("pixCity"),
          })
          : null;
        await save(
          "group",
          { name: text("name"), statute: text("statute"), pix },
          editing ? group?.id : undefined,
        );
      } else if (entityFormKind === "pool") {
        const contest = text("contest") ? Number(text("contest")) : null;
        if (
          contest !== null &&
          (!Number.isSafeInteger(contest) || contest < 1 || contest > 999_999)
        ) throw new Error("Informe um concurso inteiro positivo.");
        // Teimosinha: os mesmos jogos por N concursos seguidos; 1 é o bolão de sempre e não grava a chave.
        const contestCount = Number(text("contestCount") || "1");
        if (!Number.isInteger(contestCount) || contestCount < 1 || contestCount > 12) {
          throw new Error("A teimosinha vai de 1 a 12 concursos seguidos.");
        }
        const deadlineAt = editing &&
            text("deadline") === localDateInput(pool?.data.deadlineAt ?? null)
          ? pool?.data.deadlineAt ?? null
          : text("deadline")
          ? new Date(text("deadline")).toISOString()
          : null;
        const created = await save("pool", {
          title: text("name"),
          lotteryId,
          contestNumber: contest,
          ...(contestCount > 1 ? { contestCount } : {}),
          deadlineAt,
          quotaPriceCents: parseBRL(text("price")),
          participationMode: text("mode") as
            | "undecided"
            | "internal"
            | "official",
          status: "draft",
        }, editing ? pool?.id : undefined);
        if (repeatOf && !editing) {
          // Cada save é uma transação própria: uma falha não desfaz o bolão nem as outras cópias.
          let failedBets = 0;
          if (lotteryId === repeatOf.data.lotteryId) {
            for (const b of bets) {
              try {
                await save("bet", {
                  poolId: created.id,
                  lotteryId,
                  numbers: b.data.numbers,
                  authorIds: b.data.authorIds,
                  catalogVersion: rule.catalogVersion,
                  seed: null,
                  generationAlgorithmVersion: null,
                });
              } catch {
                failedBets += 1;
              }
            }
          }
          if (failedBets) {
            copyWarning = `O bolão foi criado, mas ${
              failedBets === 1
                ? "1 jogo não foi copiado"
                : `${failedBets} jogos não foram copiados`
            }.`;
          }
        }
        onPoolCreated(created.id);
      } else if (kind === "person") {
        await save("person", {
          name: text("name"),
          nickname: text("nickname"),
          adultDeclared: fields.get("adult") === "on",
        });
      } else {
        if (!pool) throw new Error("Crie ou selecione um bolão primeiro.");
        if (kind === "quota") {
          if (!personId) throw new Error("Adicione uma pessoa primeiro.");
          const person = persons.find((p) => p.id === personId);
          if (!person?.data.adultDeclared) {
            throw new Error(
              "Registre a declaração de maioridade antes de preparar uma cota.",
            );
          }
          const existing = quotas.find((q) => q.data.personId === personId);
          const units = quotaUnits(text("units"));
          // A draft must never leave the UI with a due amount that cannot be expressed in cents.
          quotaCost(pool.data.quotaPriceCents, units);
          if (!existing && quotas.length >= 200) {
            throw new Error("Este bolão já tem 200 participantes.");
          }
          await save(
            "quota",
            { poolId: pool.id, personId, units },
            existing?.id,
          );
        } else if (kind === "payment") {
          if (!personId) throw new Error("Adicione uma pessoa primeiro.");
          const amountCents = parseBRL(text("amount"));
          if (BigInt(amountCents) <= 0n) {
            throw new Error("O pagamento deve ter valor maior que zero.");
          }
          const proposal = await save("payment-proposal", {
            poolId: pool.id,
            personId,
            amountCents,
            note: text("note"),
            status: "pending",
          });
          if (fields.get("reviewNow") === "on") onReviewPayment(proposal.id);
        } else if (kind === "bet" || kind === "paste") {
          if (kind === "paste") {
            if (!pasteReady) {
              throw new Error("Corrija ou apague as linhas marcadas.");
            }
            if (bets.length + pastedGames.length > 1_000) {
              throw new Error(
                "O limite de 1.000 jogos seria passado. Revise o lote.",
              );
            }
          }
          for (const picked of kind === "paste" ? pastedGames : [selected]) {
            const numbers = validateBet(lotteryId, picked);
            if (
              bets.some((b) =>
                betSignature(b.data.lotteryId, b.data.numbers) ===
                  betSignature(lotteryId, numbers)
              )
            ) {
              throw new Error(
                "Este jogo já está no bolão. A duplicata não foi adicionada.",
              );
            }
            await save("bet", {
              poolId: pool.id,
              lotteryId,
              numbers,
              authorIds: text("author") ? [text("author")] : [],
              catalogVersion: rule.catalogVersion,
              seed: null,
              generationAlgorithmVersion: null,
            });
          }
        } else if (kind === "generate") {
          const count = Number(text("count"));
          const numberCount = Number(text("numberCount"));
          if (
            !Number.isInteger(count) || count < 1 || count + bets.length > 1_000
          ) {
            throw new Error(
              "Prepare entre 1 e 1.000 jogos, respeitando o total do bolão.",
            );
          }
          const seed = createSeed();
          const run = {
            poolId: pool.id,
            lotteryId,
            count,
            numberCount,
            seed,
            existing: bets.map((b) => b.data.numbers),
          };
          const generated = await generateInWorker(run);
          await saveGenerated(run, generated);
        }
      }
      if (copyWarning) {
        setError(copyWarning);
        setCopyWarned(true);
      } else onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const authorField = (
    <label>
      Autoria <span className="muted">(não altera o direito ao prêmio)</span>
      <select name="author">
        <option value="">Jogo do grupo</option>
        {persons.map((p) => (
          <option value={p.id} key={p.id}>{p.data.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal
      title={titles[kind]}
      description={descriptions[kind]}
      dirty={!copyWarned &&
        (selected.length > 0 || pastedText.trim() !== "" ||
          lotteryId !== startLottery)}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {repeatOf && kind === "pool" && (
          <p className="ui-sec form-note">
            {lotteryId === repeatOf.data.lotteryId
              ? `Vão junto: ${plural(bets.length, "jogo", "jogos")}.`
              : "Os jogos não vão: a modalidade mudou."}{" "}
            As pessoas entram em Arrecadar conforme responderem.
          </p>
        )}
        {(entityFormKind === "group" || entityFormKind === "pool" ||
          kind === "person") && (
          <label>
            Nome{entityFormKind === "group"
              ? " do grupo"
              : entityFormKind === "pool"
              ? " do bolão"
              : ""}
            <input
              name="name"
              required
              autoFocus
              maxLength={120}
              defaultValue={editing
                ? entityFormKind === "group"
                  ? group?.data.name
                  : pool?.data.title
                : kind === "pool"
                ? repeatOf?.data.title ?? ""
                : ""}
              placeholder={entityFormKind === "group"
                ? "Ex.: Amigos de longa data"
                : entityFormKind === "pool"
                ? "Ex.: Mega de sábado"
                : "Como a pessoa se chama?"}
            />
          </label>
        )}
        {entityFormKind === "group" && (
          <label>
            Combinados do grupo<textarea
              name="statute"
              rows={4}
              maxLength={10_000}
              defaultValue={editing
                ? group?.data.statute
                : "Participação válida após pagamento integral confirmado, até o bolão travar. Autoria dos números não altera o direito ao prêmio. Sobras permanecem identificadas até destino autorizado."}
            />
          </label>
        )}
        {entityFormKind === "group" && (
          <>
            <h3 className="pix-head">
              Quem recebe o dinheiro <span className="muted">(opcional)</span>
            </h3>
            <p className="ui-sec form-note">
              O app monta o código Pix com o valor de cada um. Quem paga ainda
              precisa pagar no banco; você marca que recebeu.
            </p>
            <label>
              Tipo de chave<select
                name="pixKeyType"
                defaultValue={editing ? group?.data.pix?.keyType : undefined}
              >
                {Object.entries(PIX_KEY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              Chave Pix<input
                name="pixKey"
                maxLength={77}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                defaultValue={editing ? group?.data.pix?.key : ""}
                placeholder="Deixe vazio para não usar Pix"
              />
            </label>
            <label>
              Nome de quem recebe<input
                name="pixName"
                maxLength={25}
                defaultValue={editing ? group?.data.pix?.name : ""}
                placeholder="Como está no banco"
              />
            </label>
            <label>
              Cidade<input
                name="pixCity"
                maxLength={15}
                defaultValue={editing ? group?.data.pix?.city : ""}
                placeholder="Ex.: São Paulo"
              />
            </label>
          </>
        )}
        {kind === "person" && (
          <>
            <label>
              Apelido <span className="muted">(opcional)</span>
              <input
                name="nickname"
                maxLength={80}
                placeholder="Como a turma conhece essa pessoa"
              />
            </label>
            <label className="checkbox-label">
              <input name="adult" type="checkbox" required />
              <span>
                Registrei a declaração de que esta pessoa tem 18 anos ou mais.
              </span>
            </label>
          </>
        )}
        {entityFormKind === "pool" && (
          <>
            <fieldset className="form-mods">
              <legend>Modalidade</legend>
              <div className="form-mods-list">
                {Object.values(LOTTERIES).map((l) => (
                  <label className={`form-mod mod-${l.id}`} key={l.id}>
                    <input
                      type="radio"
                      name="lottery"
                      value={l.id}
                      checked={lotteryId === l.id}
                      onChange={() => setLotteryId(l.id)}
                    />
                    <i aria-hidden="true" />
                    <span>
                      {l.label}
                      <small>{l.minNumbers} de {l.universeSize}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="form-columns">
              <label>
                Concurso <span className="muted">(opcional)</span>
                <input
                  name="contest"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="A definir"
                  defaultValue={editing
                    ? pool?.data.contestNumber ?? ""
                    : repeatOf?.data.contestNumber != null
                    ? repeatOf.data.contestNumber + 1
                    : ""}
                />
              </label>
              <label>
                Teimosinha <span className="muted">(os mesmos jogos em sorteios seguidos)</span>
                <select
                  name="contestCount"
                  defaultValue={String(
                    (editing ? pool?.data.contestCount : repeatOf?.data.contestCount) ?? 1,
                  )}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? "Não, só esta vez" : `${n} sorteios seguidos`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Valor por cota<MoneyInput
                  name="price"
                  required
                  defaultValue={priceFrom
                    ? formatBRL(priceFrom.data.quotaPriceCents).replace(
                      "R$",
                      "",
                    ).trim()
                    : "30,00"}
                />
              </label>
            </div>
            <label>
              Pagar até <span className="muted">(opcional)</span>
              <input
                name="deadline"
                type="datetime-local"
                defaultValue={editing
                  ? localDateInput(pool?.data.deadlineAt ?? null)
                  : ""}
              />
            </label>
            <label>
              Forma de participação<select
                name="mode"
                defaultValue={editing
                  ? pool?.data.participationMode
                  : repeatOf?.data.participationMode ?? "undecided"}
              >
                <option value="undecided">Decidir depois</option>
                <option value="internal">Combinado entre a turma</option>
                <option value="official">Cotas oficiais da Caixa</option>
              </select>
            </label>
            <p className="ui-sec form-note">
              Depois do prazo, os lembretes param. Quem pagar ainda entra até
              o bolão travar. O horário das apostas e do sorteio vem da Caixa,
              a cada concurso.
            </p>
          </>
        )}
        {(kind === "quota" || kind === "payment") && (
          <label>
            Pessoa<select
              name="person"
              required
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              {!persons.length && (
                <option value="">Adicione uma pessoa primeiro</option>
              )}
              {persons.map((p) => (
                <option key={p.id} value={p.id}>{p.data.name}</option>
              ))}
            </select>
          </label>
        )}
        {kind === "quota" && (
          <>
            <label>
              Quantidade de cotas<input
                name="units"
                inputMode="decimal"
                required
                defaultValue={formatQuotaUnits(
                  quotas.find((q) => q.data.personId === personId)?.data
                    .units ?? 100,
                )}
              />
              <small>
                Preparar de novo troca a cota desta pessoa.
              </small>
            </label>
            <p className="ui-sec form-note">
              Meia cota é um combinado da turma, não uma cota oficial da Caixa.
              Pagar só uma parte não diminui a cota sozinho.
            </p>
          </>
        )}
        {kind === "payment" && (
          <>
            <label>
              Valor informado<MoneyInput
                name="amount"
                required
                placeholder="0,00"
              />
            </label>
            <label>
              Origem e observações<textarea
                name="note"
                rows={3}
                maxLength={2_000}
                placeholder="Ex.: a pessoa avisou na conversa; falta ver no banco."
              />
            </label>
            <p className="ui-sec form-note">
              O comprovante ajuda a conferir. Até lá, este valor fica fora do
              caixa.
            </p>
            <label className="checkbox-label">
              <input
                name="reviewNow"
                type="checkbox"
                disabled={!financeEnabled}
              />
              <span>
                Conferir o recebimento agora, depois de sincronizar.
              </span>
            </label>
          </>
        )}
        {kind === "bet" && (
          <>
            <div className="number-picker-heading">
              <Chip modality={lotteryId}>{rule.label}</Chip>
              <strong>
                {selected.length} de {rule.minNumbers}–{rule.maxNumbers} dezenas
              </strong>
            </div>
            {selected.length > rule.minNumbers && (
              <p className="ui-sec" aria-live="polite">
                {ampliado(lotteryId, selected.length)}
              </p>
            )}
            <div className={`number-picker ${lotteryId}`}>
              {Array.from({ length: rule.universeSize }, (_, i) => i + 1).map((
                n,
              ) => (
                <button
                  type="button"
                  aria-pressed={selected.includes(n)}
                  aria-label={`Dezena ${n}`}
                  className={selected.includes(n) ? "chosen" : ""}
                  key={n}
                  onClick={() =>
                    setSelected((values) =>
                      values.includes(n)
                        ? values.filter((v) => v !== n)
                        : values.length < rule.maxNumbers
                        ? [...values, n]
                        : values
                    )}
                >
                  {String(n).padStart(2, "0")}
                </button>
              ))}
            </div>
            {authorField}
            <div className="cost-preview">
              Custo deste jogo<strong>
                {selected.length >= rule.minNumbers
                  ? formatBRL(betCost(lotteryId, selected))
                  : "Selecione as dezenas"}
              </strong>
            </div>
          </>
        )}
        {kind === "paste" && (
          <>
            <div className="number-picker-heading">
              <Chip modality={lotteryId}>{rule.label}</Chip>
              <strong>{rule.minNumbers}–{rule.maxNumbers} dezenas por jogo</strong>
            </div>
            <label>
              Jogos, um por linha
              <textarea
                name="games"
                rows={6}
                value={pastedText}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPastedText(e.target.value)}
              />
              <small>
                Cole as dezenas como estão no bilhete ou na conversa.
              </small>
            </label>
            {authorField}
            {pasted.length > 0 && (
              <ul className="paste-preview">
                {pasted.map((g, i) => (
                  <li key={i} className="paste-line">
                    {"numbers" in g
                      ? (
                        <Balls
                          numbers={g.numbers}
                          size="sm"
                          detail={ampliado(lotteryId, g.numbers.length)}
                        />
                      )
                      : (
                        <>
                          <span className="paste-text">{g.text}</span>
                          {"error" in g
                            ? <span className="paste-error">{g.error}</span>
                            : <span className="ui-sec">{g.skipped}</span>}
                        </>
                      )}
                  </li>
                ))}
              </ul>
            )}
            <div className="cost-preview">
              Custo dos jogos<strong>
                {pastedGames.length
                  ? `${plural(pastedGames.length, "jogo", "jogos")} · ${
                    formatBRL(pastedCost.toString())
                  }`
                  : "Cole os jogos"}
              </strong>
            </div>
          </>
        )}
        {kind === "generate" && (
          <>
            <p className="number-picker-heading">
              <Chip modality={lotteryId}>{rule.label}</Chip>
            </p>
            <div className="form-columns">
              <label>
                Quantidade de jogos<input
                  name="count"
                  type="number"
                  min="1"
                  max={1_000 - bets.length}
                  defaultValue="5"
                  required
                />
              </label>
              <label>
                Dezenas por jogo<select name="numberCount">
                  {Array.from(
                    { length: rule.maxNumbers - rule.minNumbers + 1 },
                    (_, i) => i + rule.minNumbers,
                  ).map((n) => <option value={n} key={n}>{n} dezenas</option>)}
                </select>
              </label>
            </div>
            <p className="ui-sec form-note">
              Os jogos que já estão no bolão continuam e nenhum jogo se repete.
            </p>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {copyWarned ? "Fechar" : "Cancelar"}
          </Button>
          <Button
            type="submit"
            disabled={busy || copyWarned ||
              ((kind === "payment" || kind === "quota") && !persons.length) ||
              (kind === "paste" && !pasteReady)}
            icon={busy
              ? <LoaderCircle aria-hidden="true" className="spin" />
              : <Check aria-hidden="true" />}
          >
            {busy
              ? "Salvando…"
              : kind === "generate"
              ? "Gerar e salvar jogos"
              : kind === "paste" && pastedGames.length
              ? `Salvar ${plural(pastedGames.length, "jogo", "jogos")} neste aparelho`
              : kind === "payment"
              ? "Salvar para revisão"
              : "Salvar neste aparelho"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
