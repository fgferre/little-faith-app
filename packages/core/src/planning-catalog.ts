import type { LotteryId } from './types';
import type { PlanBet, PlanParticipationMode, PlanRight, PlanTicket } from './planning-types';
import { betCost, choose, lotteryRule, validateBet } from './lotteries';

/** Official per-number-count pool tables verified directly on the three CAIXA product pages. */
export const PLANNING_CATALOG_VERSION = 'caixa-pools-2026-10-08-v1';
export const PLANNING_CATALOG_VERIFIED_AT = '2026-10-08';
export interface OfficialPoolRule {
  numberCount: number;
  elementaryCombinations: string;
  betPriceCents: string;
  minQuotas: number;
  maxQuotas: number;
  minQuotaCents: string;
  minPoolCents: string;
  maxPoolCents: string;
  maxGamesPerReceipt: number;
}
export interface PlanningLotteryCatalog {
  lotteryId: LotteryId;
  version: string;
  verifiedAt: string;
  sourceUrl: string;
  maxLotteryServiceFeeBasisPoints: number;
  rules: Readonly<Record<number, Readonly<OfficialPoolRule>>>;
}
type CatalogRow = readonly [number, number, number, number, number, number, number, number];
// n, elementary combinations, minimum quotas, maximum quotas, minimum quota cents,
// minimum pool cents, maximum pool cents, maximum games on a pool receipt.
const rows: Readonly<Record<LotteryId, readonly CatalogRow[]>> = {
  'mega-sena': [
    [6,1,2,8,700,1800,6000,10], [7,7,2,50,800,4200,42000,10],
    [8,28,2,100,800,16800,168000,10], [9,84,2,100,800,50400,504000,10],
    [10,210,2,100,1260,126000,1260000,10], [11,462,2,100,2772,277200,2772000,10],
    [12,924,2,100,5544,554400,5544000,10], [13,1716,2,100,10296,1029600,10296000,10],
    [14,3003,2,100,18018,1801800,18018000,10], [15,5005,2,100,30030,3003000,21021000,7],
    [16,8008,2,100,48048,4804800,19219200,4], [17,12376,2,100,74256,7425600,22276800,3],
    [18,18564,2,100,111384,11138400,22276800,2], [19,27132,2,100,162792,16279200,16279200,1],
    [20,38760,2,100,232560,23256000,23256000,1],
  ],
  lotofacil: [
    [15,1,2,7,450,1400,3500,10], [16,16,2,35,450,5600,56000,10],
    [17,136,2,40,1190,47600,476000,10], [18,816,2,50,5712,285600,2856000,10],
    [19,3876,2,85,15960,1356600,12209400,9], [20,15504,2,100,54264,5426400,21705600,4],
  ],
  quina: [
    [5,1,2,7,400,1500,3000,10], [6,6,2,25,400,1800,18000,10],
    [7,21,2,50,400,6300,63000,10], [8,56,2,50,400,16800,168000,10],
    [9,126,2,50,756,37800,378000,10], [10,252,2,50,1512,75600,756000,10],
    [11,462,2,50,2772,138600,1386000,10], [12,792,2,50,4752,237600,2376000,10],
    [13,1287,2,50,7722,386100,3861000,10], [14,2002,2,50,12012,600600,6006000,10],
    [15,3003,2,50,18018,900900,9009000,10],
  ],
};
function makeCatalog(lotteryId: LotteryId): Readonly<PlanningLotteryCatalog> {
  const lottery = lotteryRule(lotteryId);
  const rules: Record<number, Readonly<OfficialPoolRule>> = {};
  for (const [numberCount, combinations, minQuotas, maxQuotas, minQuota, minPool, maxPool, maxGamesPerReceipt] of rows[lotteryId]) {
    rules[numberCount] = Object.freeze({
      numberCount, elementaryCombinations: combinations.toString(),
      betPriceCents: (BigInt(combinations) * BigInt(lottery.simplePriceCents)).toString(),
      minQuotas, maxQuotas, minQuotaCents: minQuota.toString(), minPoolCents: minPool.toString(),
      maxPoolCents: maxPool.toString(), maxGamesPerReceipt,
    });
  }
  return Object.freeze({lotteryId,version:PLANNING_CATALOG_VERSION,verifiedAt:PLANNING_CATALOG_VERIFIED_AT,
    sourceUrl:lottery.sourceUrl,maxLotteryServiceFeeBasisPoints:3500,rules:Object.freeze(rules)});
}
export const PLANNING_CATALOG: Readonly<Record<LotteryId, Readonly<PlanningLotteryCatalog>>> = Object.freeze({
  'mega-sena':makeCatalog('mega-sena'), lotofacil:makeCatalog('lotofacil'), quina:makeCatalog('quina'),
});
export function officialPoolRule(lotteryId: LotteryId, numberCount: number): Readonly<OfficialPoolRule> {
  lotteryRule(lotteryId);
  const rule = PLANNING_CATALOG[lotteryId].rules[numberCount];
  if (!rule) throw new Error('Quantidade de dezenas sem regra oficial neste catálogo.');
  return rule;
}
function gcd(a: number, b: number): number {
  while (b) [a,b] = [b,a%b];
  return a;
}
/** Reduced integer counts preserve every internal share on every receipt. */
export function officialQuotaRatio(rights: readonly Pick<PlanRight, 'quotaId'|'personId'|'units'>[]): { total: number; counts: number[] } {
  if (!rights.length || rights.length > 200) throw new Error('Informe de 1 a 200 direitos confirmados.');
  const quotaIds = new Set<string>();
  const personIds = new Set<string>();
  let divisor = 0;
  for (const right of rights) {
    if (!Number.isSafeInteger(right.units) || right.units <= 0 || right.units > 1_000_000) throw new Error('Direito com unidades inválidas.');
    if (quotaIds.has(right.quotaId) || personIds.has(right.personId)) throw new Error('Direitos precisam ser únicos por pessoa e cota.');
    quotaIds.add(right.quotaId); personIds.add(right.personId);
    divisor = gcd(divisor, right.units);
  }
  const counts = rights.map((right) => right.units / divisor);
  return {total:counts.reduce((sum,count)=>sum+count,0),counts};
}
/**
 * Conservative certification: the official quota face value must be an exact number of cents.
 * No undocumented rounding rule or fractional official quota is inferred from internal shares.
 */
export function packPlanTickets(lotteryId: LotteryId, bets: readonly PlanBet[], rights: readonly PlanRight[], mode: PlanParticipationMode): PlanTicket[] {
  if (!Array.isArray(bets) || bets.length < 1 || bets.length > 1_000) throw new Error('Empacote de 1 a 1.000 jogos.');
  const bySize = new Map<number, PlanBet[]>();
  const keys = new Set<string>();
  for (const bet of bets) {
    const numbers = validateBet(lotteryId, bet.numbers);
    if (keys.has(bet.key)) throw new Error('Chave de jogo repetida.');
    keys.add(bet.key);
    const group = bySize.get(numbers.length) ?? [];
    group.push(bet); bySize.set(numbers.length, group);
  }
  const tickets: PlanTicket[] = [];
  const ratio = officialQuotaRatio(rights);
  for (const [numberCount, group] of [...bySize].sort(([a],[b]) => a-b)) {
    const rule = officialPoolRule(lotteryId, numberCount);
    const price = BigInt(rule.betPriceCents);
    if (mode === 'internal') {
      // One independently registrable bet per entry: no unverified non-pool receipt capacity.
      for (const bet of group) tickets.push({key:`ticket-${tickets.length+1}`,numberCount,betKeys:[bet.key],betCostCents:price.toString(),officialQuotaCount:null,officialQuotaValueCents:null,assignments:[]});
      continue;
    }
    if (mode !== 'official') throw new Error('Escolha explicitamente a modalidade de participação.');
    const feasible = new Map<number, number>();
    for (let count = 1; count <= rule.maxGamesPerReceipt; count++) {
      const cost = price * BigInt(count);
      if (cost < BigInt(rule.minPoolCents) || cost > BigInt(rule.maxPoolCents)) continue;
      for (let quotas = Math.ceil(rule.minQuotas / ratio.total) * ratio.total; quotas <= rule.maxQuotas; quotas += ratio.total) {
        if (cost % BigInt(quotas) === 0n && cost / BigInt(quotas) >= BigInt(rule.minQuotaCents)) {
          feasible.set(count, quotas); break;
        }
      }
    }
    // Exact dynamic packing avoids an invalid short tail after a full receipt.
    const minimum = new Array<number>(group.length+1).fill(Infinity);
    const part = new Array<number>(group.length+1).fill(0);
    minimum[0] = 0;
    const sizes = [...feasible.keys()].sort((a,b) => b-a);
    for (let total=1; total<=group.length; total++) for (const size of sizes) {
      if (size<=total && minimum[total-size]!+1 < minimum[total]!) {
        minimum[total]=minimum[total-size]!+1; part[total]=size;
      }
    }
    if (!Number.isFinite(minimum[group.length])) throw new Error(`Os ${group.length} jogos com ${numberCount} dezenas não cabem em recibos oficiais que preservem os direitos e centavos exatos.`);
    let remaining=group.length;
    let offset=0;
    while (remaining) {
      const count=part[remaining]!;
      const quotas=feasible.get(count)!;
      const cost=price*BigInt(count);
      tickets.push({key:`ticket-${tickets.length+1}`,numberCount,betKeys:group.slice(offset,offset+count).map((bet)=>bet.key),betCostCents:cost.toString(),
        officialQuotaCount:quotas,officialQuotaValueCents:(cost/BigInt(quotas)).toString(),
        assignments:rights.map((right,index)=>({quotaId:right.quotaId,personId:right.personId,officialQuotas:ratio.counts[index]!*(quotas/ratio.total)}))});
      remaining-=count; offset+=count;
    }
  }
  return tickets;
}
/** Independent defensive validation; the serialized ticket fields are never trusted. */
export function validatePlanTickets(lotteryId: LotteryId, bets: readonly PlanBet[], rights: readonly PlanRight[], mode: PlanParticipationMode, tickets: readonly PlanTicket[]): void {
  const betMap = new Map(bets.map((bet) => [bet.key,bet]));
  const seen = new Set<string>();
  const ticketKeys = new Set<string>();
  const ratio = officialQuotaRatio(rights);
  if (!Array.isArray(tickets) || tickets.length<1 || tickets.length>1_000) throw new Error('Cartelas ausentes ou em excesso.');
  for (const ticket of tickets as readonly PlanTicket[]) {
    if (ticketKeys.has(ticket.key)) throw new Error('Chave de cartela repetida.');
    ticketKeys.add(ticket.key);
    if (!ticket.betKeys.length) throw new Error('Cartela vazia.');
    let cost=0n;
    for (const key of ticket.betKeys) {
      const bet=betMap.get(key);
      if (!bet || seen.has(key)) throw new Error('Cartelas devem conter cada jogo exatamente uma vez.');
      seen.add(key);
      if (bet.numbers.length!==ticket.numberCount) throw new Error('Uma cartela precisa ter a mesma quantidade de dezenas em todos os jogos.');
      cost+=BigInt(betCost(lotteryId,bet.numbers));
    }
    if (cost.toString()!==ticket.betCostCents) throw new Error('Custo da cartela divergente.');
    if (mode==='internal') {
      if (ticket.betKeys.length!==1 || ticket.officialQuotaCount!==null || ticket.officialQuotaValueCents!==null || ticket.assignments.length) throw new Error('Acordo interno não emite cotas oficiais.');
      continue;
    }
    const rule=officialPoolRule(lotteryId,ticket.numberCount);
    const count=ticket.officialQuotaCount;
    if (count===null || !Number.isInteger(count) || count<rule.minQuotas || count>rule.maxQuotas || count%ratio.total!==0) throw new Error('Quantidade de cotas oficiais incompatível com os direitos.');
    if (ticket.betKeys.length>rule.maxGamesPerReceipt || cost<BigInt(rule.minPoolCents) || cost>BigInt(rule.maxPoolCents)) throw new Error('Cartela fora dos limites oficiais.');
    if (cost%BigInt(count)!==0n || ticket.officialQuotaValueCents!==(cost/BigInt(count)).toString() || cost/BigInt(count)<BigInt(rule.minQuotaCents)) throw new Error('Valor da cota oficial fora dos limites ou com centavo fracionado.');
    if (ticket.assignments.length!==rights.length) throw new Error('Correspondência incompleta de cotas oficiais.');
    const assignments = new Map(ticket.assignments.map((a)=>[a.quotaId,a]));
    if (assignments.size!==rights.length) throw new Error('Correspondência repetida de cota oficial.');
    rights.forEach((right,index)=>{
      const assignment=assignments.get(right.quotaId);
      if (!assignment || assignment.personId!==right.personId || assignment.officialQuotas!==ratio.counts[index]!*(count/ratio.total)) throw new Error('Cota oficial altera a proporção econômica do participante.');
    });
  }
  if (seen.size!==bets.length) throw new Error('Há jogo fora das cartelas.');
}

/** Useful catalog audit without trusting transcribed elementary counts. */
export function auditPlanningCatalog(): boolean {
  return Object.values(PLANNING_CATALOG).every((catalog)=>Object.values(catalog.rules).every((rule)=>choose(rule.numberCount,lotteryRule(catalog.lotteryId).drawSize).toString()===rule.elementaryCombinations));
}
