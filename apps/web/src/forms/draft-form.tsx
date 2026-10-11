import { useState } from "react";
import type { FormEvent } from "react";
import {
  Check,
  Clock3,
  Dices,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
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
} from "@bolao/core";
import type { LocalRecord, LotteryId } from "@bolao/core";
import { LotteryBadge, Modal } from "../components";
import { createSeed, generateInWorker } from "../generation";
import { errorMessage } from "../app-shared";
import type { FormKind, GenerationRun, SaveRecord } from "../app-shared";

const localDateInput = (value: string | null) => {
  if (!value) return "";
  const instant = new Date(value);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
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
    /** "Repetir com a mesma turma": o novo bolão começa com nome, modalidade e preço deste. */
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
  const [lotteryId, setLotteryId] = useState<LotteryId>(
    repeatOf?.data.lotteryId ?? pool?.data.lotteryId ?? "mega-sena",
  );
  const [selected, setSelected] = useState<number[]>([]);
  const [personId, setPersonId] = useState(persons[0]?.id ?? "");
  const entityFormKind = kind === "edit-group"
    ? "group"
    : kind === "edit-pool"
    ? "pool"
    : kind;
  const editing = kind === "edit-group" || kind === "edit-pool";
  const priceFrom = editing ? pool : repeatOf;
  const rule = LOTTERIES[lotteryId];
  const titles = {
    group: "Um grupo para chamar de nosso",
    "edit-group": "Editar grupo e combinados",
    pool: "Preparar um novo bolão",
    "edit-pool": "Editar dados do bolão",
    person: "Mais uma pessoa na turma",
    quota: "Preparar participação",
    payment: "Registrar pagamento a conferir",
    bet: "Os números da turma",
    generate: "Deixe os números com a gente",
  };
  const descriptions = {
    group:
      "Os dados serão salvos neste aparelho. Cada grupo tem seu próprio caixa.",
    "edit-group":
      "A mudança fica salva neste aparelho. Publique uma nova versão na revisão para registrar novos aceites.",
    pool: "Defina os detalhes iniciais. Tudo fica salvo neste aparelho até sincronizar.",
    "edit-pool":
      "Preço, prazo, modalidade e concurso ficam protegidos quando há participações confirmadas.",
    person:
      "Cadastrar uma pessoa não cria uma conta nem um direito financeiro.",
    quota:
      "Até duas casas decimais. A participação precisa ser confirmada online antes de valer.",
    payment: "Informar um valor não confirma recebimento e não altera o caixa.",
    bet: "Jogos preparados ficam locais. O registro é feito externamente.",
    generate:
      "Os jogos são gerados neste aparelho, de forma verificável. Nenhum método melhora a chance de um jogo.",
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const fields = new FormData(event.currentTarget);
    const text = (name: string) => String(fields.get(name) ?? "").trim();
    try {
      if (entityFormKind === "group") {
        if (!text("name")) throw new Error("Dê um nome ao grupo.");
        await save(
          "group",
          { name: text("name"), statute: text("statute") },
          editing ? group?.id : undefined,
        );
      } else if (entityFormKind === "pool") {
        const contest = text("contest") ? Number(text("contest")) : null;
        if (
          contest !== null && (!Number.isSafeInteger(contest) || contest < 1)
        ) throw new Error("Informe um concurso inteiro positivo.");
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
          deadlineAt,
          quotaPriceCents: parseBRL(text("price")),
          participationMode: text("mode") as
            | "undecided"
            | "internal"
            | "official",
          status: "draft",
        }, editing ? pool?.id : undefined);
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
        } else if (kind === "bet") {
          const numbers = validateBet(lotteryId, selected);
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
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={titles[kind]}
      description={descriptions[kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
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
                : "Participação válida após pagamento integral confirmado no prazo. Autoria dos números não altera o direito ao prêmio. Sobras permanecem identificadas até destino autorizado."}
            />
          </label>
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
            <label>
              Modalidade<select
                name="lottery"
                value={lotteryId}
                onChange={(e) => setLotteryId(e.target.value as LotteryId)}
              >
                {Object.values(LOTTERIES).map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </label>
            <div className="form-columns">
              <label>
                Concurso <span className="muted">(opcional)</span>
                <input
                  name="contest"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="A definir"
                  defaultValue={editing ? pool?.data.contestNumber ?? "" : ""}
                />
              </label>
              <label>
                Valor por cota (R$)<input
                  name="price"
                  required
                  inputMode="decimal"
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
              Prazo interno <span className="muted">(seu fuso local)</span>
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
                  : "undecided"}
              >
                <option value="undecided">Definir antes do fechamento</option>
                <option value="internal">Acordo interno do grupo</option>
                <option value="official">
                  Cotas oficiais — verificar compatibilidade
                </option>
              </select>
            </label>
            <div className="inline-note">
              <Clock3 size={16} />
              <span>
                Este prazo é do grupo. O encerramento das apostas e o sorteio
                precisam de informação oficial por concurso.
              </span>
            </div>
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
                Cota inteira ou fração, como 1 ou 1,5. Preparar de novo substitui
                a cota desta pessoa.
              </small>
            </label>
            <div className="inline-note">
              <Users size={17} />
              <span>
                Frações internas não são cotas oficiais fracionadas. Pagamento
                parcial não reduz automaticamente a participação.
              </span>
            </div>
          </>
        )}
        {kind === "payment" && (
          <>
            <label>
              Valor informado (R$)<input
                name="amount"
                required
                inputMode="decimal"
                placeholder="0,00"
              />
            </label>
            <label>
              Origem e observações<textarea
                name="note"
                rows={3}
                maxLength={2_000}
                placeholder="Ex.: valor informado na conversa. Ainda falta conferir o recebimento."
              />
            </label>
            <div className="inline-note">
              <ShieldCheck size={17} />
              <span>
                Um comprovante é evidência para conferir. Este valor permanecerá
                fora do saldo confirmado.
              </span>
            </div>
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
              <LotteryBadge lotteryId={lotteryId} />
              <strong>
                {selected.length} de {rule.minNumbers}–{rule.maxNumbers} dezenas
              </strong>
            </div>
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
            <label>
              Autoria{" "}
              <span className="muted">(não altera o direito ao prêmio)</span>
              <select name="author">
                <option value="">Jogo do grupo</option>
                {persons.map((p) => (
                  <option value={p.id} key={p.id}>{p.data.name}</option>
                ))}
              </select>
            </label>
            <div className="cost-preview">
              Custo deste jogo<strong>
                {selected.length >= rule.minNumbers
                  ? formatBRL(betCost(lotteryId, selected))
                  : "Selecione as dezenas"}
              </strong>
            </div>
          </>
        )}
        {kind === "generate" && (
          <>
            <div className="generator-heading">
              <span className={`pool-icon ${lotteryId}`}>
                <Dices size={25} />
              </span>
              <div>
                <strong>{rule.label}</strong>
                <small>Geração determinística em segundo plano</small>
              </div>
            </div>
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
            <div className="inline-note">
              <Sparkles size={17} />
              <span>
                Os jogos são gerados de forma verificável. Dezenas existentes
                são preservadas e jogos repetidos são evitados.
              </span>
            </div>
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy ||
              ((kind === "payment" || kind === "quota") && !persons.length)}
          >
            {busy
              ? <LoaderCircle size={17} className="spin" />
              : <Check size={17} />}
            {busy
              ? "Salvando…"
              : kind === "generate"
              ? "Gerar e salvar jogos"
              : kind === "payment"
              ? "Salvar para revisão"
              : "Salvar neste aparelho"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
