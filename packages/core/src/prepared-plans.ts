import type { LotteryId } from './types';
import type { PlanBet, PlanParticipationMode, PlanRight, PreparedPlan, SuggestPlansInput, PlanSuggestionResult, PlanStrategy } from './planning-types';
import { betCost, betSignature, lotteryRule, validateBet } from './lotteries';
import { GENERATION_ALGORITHM_VERSION, generateBets } from './generation';
import { createFinancialView } from './financial';
import { centsValue, quotaCost } from './money';
import { deterministicId } from './canonical';
import { packPlanTickets, PLANNING_CATALOG_VERSION, validatePlanTickets } from './planning-catalog';
import { DomainValidationError, MAX_OPERATIONAL_CENTS, MAX_QUOTA_UNITS } from './validation';

export function planningInvalid(field: string, message: string): never { throw new DomainValidationError(field,message); }
export function planningRecord(value: unknown, field: string): Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value) as object|null)) return planningInvalid(field,'Objeto simples obrigatório.');
  return value as Record<string,unknown>;
}
export function planningShape(value: Record<string,unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) planningInvalid(`${field}.${key}`,'Campo não suportado.');
  for (const key of keys) if (!Object.hasOwn(value,key)) planningInvalid(`${field}.${key}`,'Campo obrigatório.');
}
export function planningList(value: unknown, field: string, max=1_000): unknown[] {
  if (!Array.isArray(value) || value.length>max) return planningInvalid(field,`Lista obrigatória com até ${max} itens.`);
  return value as unknown[];
}
export function planningUid(value: unknown, field: string): string {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return planningInvalid(field,'UUID inválido.');
  return value.toLowerCase();
}
export function planningInt(value: unknown, field: string, min=0, max=Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || typeof value!=='number' || value<min || value>max) return planningInvalid(field,'Quantidade inteira fora do limite.');
  return value;
}
export function planningText(value: unknown, field: string, max=2_000, required=false): string {
  if (typeof value!=='string' || value.includes('\0') || value.length>max || (required && !value.trim())) return planningInvalid(field,'Texto ausente, inválido ou muito longo.');
  return value;
}
export function planningMoney(value: unknown, field: string, positive=false): string {
  if (typeof value!=='string') return planningInvalid(field,'Centavos devem ser uma string inteira canônica.');
  let cents: bigint;
  try { cents=centsValue(value); } catch { return planningInvalid(field,'Centavos devem ser uma string inteira canônica.'); }
  if (cents<(positive?1n:0n) || cents>BigInt(MAX_OPERATIONAL_CENTS)) return planningInvalid(field,'Valor fora do limite operacional.');
  return value;
}
export function planningOption<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value!=='string' || !values.includes(value as T)) return planningInvalid(field,'Opção não suportada.');
  return value as T;
}
export function planningSeed(value: unknown, field='seed'): string {
  if (typeof value!=='string' || !/^[0-9a-f]{64}$/i.test(value)) return planningInvalid(field,'Semente exige 64 caracteres hexadecimais.');
  return value.toLowerCase();
}
function key(value: unknown, field: string): string {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return planningInvalid(field,'Chave inválida.');
  return value;
}
function unique<T>(values: T[], project: (value:T)=>string, field: string): T[] {
  if (new Set(values.map(project)).size!==values.length) planningInvalid(field,'Identificador repetido.');
  return values;
}
/** Same rule for the plan input and the stored plan: positive cents or null, and only for the internal agreement. */
function planningGroupPrizeLimit(value: unknown, mode: PlanParticipationMode): string|null {
  if (value===null) return null;
  const cents=planningMoney(value,'groupPrizeLimitCents',true);
  if (mode==='official') planningInvalid('groupPrizeLimitCents','O limite de prêmio para o caixa do grupo só vale no combinado interno.');
  return cents;
}
export function validatePreparedPlan(input: unknown): PreparedPlan {
  const source=planningRecord(input,'plan');
  const hasGroupPrizeLimit=Object.hasOwn(source,'groupPrizeLimitCents');
  planningShape(source,[...(hasGroupPrizeLimit?['groupPrizeLimitCents']:[]),'id','groupId','poolId','poolVersion','groupRevision','lotteryId','contestNumber','participationMode','strategy','seed','catalogVersion','sourceBets','rights','budgetCents','betCostCents','feeCents','feeLabel','totalCostCents','leftoverCents','leftoverPolicy','bets','tickets','explanation'],'plan');
  const lotteryId=planningOption<LotteryId>(source.lotteryId,['mega-sena','lotofacil','quina'],'lotteryId');
  const seed=planningSeed(source.seed);
  if (source.catalogVersion!==PLANNING_CATALOG_VERSION) planningInvalid('catalogVersion','Catálogo de planejamento não suportado.');
  const sourceBets=unique(planningList(source.sourceBets,'sourceBets').map((inputBet)=>{
    const bet=planningRecord(inputBet,'sourceBets'); planningShape(bet,['id','version'],'sourceBets');
    return {id:planningUid(bet.id,'sourceBet.id'),version:planningInt(bet.version,'sourceBet.version')};
  }),(bet)=>bet.id,'sourceBets');
  const rights=unique(planningList(source.rights,'rights',200).map((inputRight):PlanRight=>{
    const right=planningRecord(inputRight,'rights'); planningShape(right,['quotaId','sourceQuotaId','sourceQuotaVersion','personId','units','dueCents','statuteId'],'rights');
    return {quotaId:planningUid(right.quotaId,'quotaId'),sourceQuotaId:planningUid(right.sourceQuotaId,'sourceQuotaId'),sourceQuotaVersion:planningInt(right.sourceQuotaVersion,'sourceQuotaVersion',1),personId:planningUid(right.personId,'personId'),units:planningInt(right.units,'units',1,MAX_QUOTA_UNITS),dueCents:planningMoney(right.dueCents,'dueCents',true),statuteId:planningUid(right.statuteId,'statuteId')};
  }),(right)=>right.quotaId,'rights');
  if (!rights.length || new Set(rights.map((r)=>r.personId)).size!==rights.length || new Set(rights.map((r)=>r.sourceQuotaId)).size!==rights.length) planningInvalid('rights','Direitos devem ser únicos por pessoa e cota de origem.');
  const bets=unique(planningList(source.bets,'bets').map((inputBet):PlanBet=>{
    const bet=planningRecord(inputBet,'bets'); planningShape(bet,['key','sourceBetId','sourceBetVersion','numbers','authorIds','seed','generationAlgorithmVersion'],'bets');
    const numbers=validateBet(lotteryId,planningList(bet.numbers,'numbers',20) as number[]);
    if (JSON.stringify(numbers)!==JSON.stringify(bet.numbers)) planningInvalid('numbers','Dezenas do plano precisam estar em ordem canônica.');
    const sourceBetId=bet.sourceBetId===null?null:planningUid(bet.sourceBetId,'sourceBetId');
    const sourceBetVersion=bet.sourceBetVersion===null?null:planningInt(bet.sourceBetVersion,'sourceBetVersion');
    if ((sourceBetId===null)!==(sourceBetVersion===null)) planningInvalid('sourceBetVersion','Origem exige identificador e versão juntos.');
    const authorIds=unique(planningList(bet.authorIds,'authorIds',200).map((a)=>planningUid(a,'authorId')),(a)=>a,'authorIds');
    const betSeed=bet.seed===null?null:planningSeed(bet.seed,'bet.seed');
    if ((betSeed===null && bet.generationAlgorithmVersion!==null) || (betSeed!==null && bet.generationAlgorithmVersion!==GENERATION_ALGORITHM_VERSION)) planningInvalid('generationAlgorithmVersion','Semente e algoritmo de geração incompatíveis.');
    if (sourceBetId===null && (betSeed!==seed || authorIds.length)) planningInvalid('bets','Jogo gerado exige semente do plano e não cria autoria financeira.');
    return {key:key(bet.key,'bet.key'),sourceBetId,sourceBetVersion,numbers,authorIds,seed:betSeed,generationAlgorithmVersion:betSeed===null?null:GENERATION_ALGORITHM_VERSION};
  }),(bet)=>bet.key,'bets');
  if (!bets.length) planningInvalid('bets','Plano sem jogos.');
  if (new Set(bets.map((b)=>betSignature(lotteryId,b.numbers))).size!==bets.length) planningInvalid('bets','Plano contém jogos duplicados; revise os rascunhos fixos.');
  const sourced=bets.filter((bet)=>bet.sourceBetId!==null);
  if (sourced.length!==sourceBets.length || new Set(sourced.map((b)=>b.sourceBetId)).size!==sourced.length || sourceBets.some((s)=>!sourced.some((b)=>b.sourceBetId===s.id && b.sourceBetVersion===s.version))) planningInvalid('sourceBets','Todos os jogos fixos observados devem estar preservados exatamente uma vez.');
  const participationMode=planningOption(source.participationMode,['internal','official'],'participationMode');
  const tickets=unique(planningList(source.tickets,'tickets').map((inputTicket)=>{
    const ticket=planningRecord(inputTicket,'tickets'); planningShape(ticket,['key','numberCount','betKeys','betCostCents','officialQuotaCount','officialQuotaValueCents','assignments'],'tickets');
    return {key:key(ticket.key,'ticket.key'),numberCount:planningInt(ticket.numberCount,'numberCount',1,20),betKeys:planningList(ticket.betKeys,'betKeys',10).map((v)=>key(v,'betKey')),betCostCents:planningMoney(ticket.betCostCents,'ticket.betCostCents',true),officialQuotaCount:ticket.officialQuotaCount===null?null:planningInt(ticket.officialQuotaCount,'officialQuotaCount',2,100),officialQuotaValueCents:ticket.officialQuotaValueCents===null?null:planningMoney(ticket.officialQuotaValueCents,'officialQuotaValueCents',true),assignments:planningList(ticket.assignments,'assignments',200).map((inputAssignment)=>{
      const assignment=planningRecord(inputAssignment,'assignment'); planningShape(assignment,['quotaId','personId','officialQuotas'],'assignment');
      return {quotaId:planningUid(assignment.quotaId,'quotaId'),personId:planningUid(assignment.personId,'personId'),officialQuotas:planningInt(assignment.officialQuotas,'officialQuotas',1,100)};
    })};
  }),(ticket)=>ticket.key,'tickets');
  validatePlanTickets(lotteryId,bets,rights,participationMode,tickets);
  const budgetCents=planningMoney(source.budgetCents,'budgetCents',true);
  const betCostCents=planningMoney(source.betCostCents,'betCostCents',true);
  const feeCents=planningMoney(source.feeCents,'feeCents');
  const totalCostCents=planningMoney(source.totalCostCents,'totalCostCents',true);
  const leftoverCents=planningMoney(source.leftoverCents,'leftoverCents');
  if (rights.reduce((sum,r)=>sum+BigInt(r.dueCents),0n)!==BigInt(budgetCents)) planningInvalid('budgetCents','Orçamento deve ser a soma de todos os direitos confirmados.');
  if (bets.reduce((sum,b)=>sum+BigInt(betCost(lotteryId,b.numbers)),0n)!==BigInt(betCostCents)) planningInvalid('betCostCents','Custo dos jogos divergente dos preços oficiais.');
  if (BigInt(betCostCents)+BigInt(feeCents)!==BigInt(totalCostCents) || BigInt(totalCostCents)+BigInt(leftoverCents)!==BigInt(budgetCents)) planningInvalid('totalCostCents','Custos, taxas e sobra não reconciliam com o orçamento.');
  const feeLabel=planningText(source.feeLabel,'feeLabel',200,BigInt(feeCents)>0n);
  return {id:planningUid(source.id,'id'),groupId:planningUid(source.groupId,'groupId'),poolId:planningUid(source.poolId,'poolId'),poolVersion:planningInt(source.poolVersion,'poolVersion'),groupRevision:planningInt(source.groupRevision,'groupRevision'),lotteryId,contestNumber:planningInt(source.contestNumber,'contestNumber',1,999_999),participationMode,strategy:planningOption(source.strategy,['spread','balanced','concentrated'],'strategy'),seed,catalogVersion:PLANNING_CATALOG_VERSION,sourceBets,rights,budgetCents,betCostCents,feeCents,feeLabel,totalCostCents,leftoverCents,leftoverPolicy:planningOption(source.leftoverPolicy,['unassigned','refund-pro-rata','group-credit'],'leftoverPolicy'),...(hasGroupPrizeLimit?{groupPrizeLimitCents:planningGroupPrizeLimit(source.groupPrizeLimitCents,participationMode)}:{}),bets,tickets,explanation:planningText(source.explanation,'explanation',2_000,true)};
}
export function assertConfirmedPlanSources(plan: PreparedPlan): void {
  if (plan.poolVersion<1 || plan.sourceBets.some((source)=>source.version<1) || plan.bets.some((bet)=>bet.sourceBetVersion!==null && bet.sourceBetVersion<1)) planningInvalid('sourceBets','Confirmação exige bolão e todos os jogos fixos sincronizados com versão positiva.');
}

/** Feasible heuristics, not a global optimum or a guarantee of a prize. */
export function suggestPlans(input: SuggestPlansInput): PlanSuggestionResult {
  const groupId=planningUid(input.groupId,'groupId');
  const groupRevision=planningInt(input.groupRevision,'groupRevision');
  const pool=input.pool;
  if (pool.kind!=='pool' || pool.groupId!==groupId) planningInvalid('pool','Bolão de outro grupo.');
  const poolId=planningUid(pool.id,'poolId');
  const poolVersion=planningInt(pool.serverVersion,'poolVersion');
  const lottery=lotteryRule(pool.data.lotteryId);
  const mode=pool.data.participationMode;
  if (mode==='undecided') planningInvalid('participationMode','Escolha participação interna ou oficial antes de planejar.');
  if (!['draft','locked'].includes(pool.data.status)) planningInvalid('status','Bolão registrado não pode receber outro plano.');
  const contestNumber=planningInt(pool.data.contestNumber,'contestNumber',1,999_999);
  const seed=planningSeed(input.seed);
  const financial=createFinancialView(input.financial);
  if (input.financial.groupId!==groupId || input.financial.groupRevision!==groupRevision) planningInvalid('financial','Retrato financeiro precisa corresponder ao grupo e revisão observados.');
  const rights:PlanRight[]=input.financial.quotas.filter((q)=>q.poolId===poolId && financial.isQuotaActive(q.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map((q)=>({quotaId:q.id,sourceQuotaId:q.sourceQuotaId,sourceQuotaVersion:q.sourceQuotaVersion,personId:q.personId,units:q.units,dueCents:q.dueCents,statuteId:q.statuteId}));
  if (rights.some((right)=>quotaCost(pool.data.quotaPriceCents,right.units)!==right.dueCents)) planningInvalid('rights','Preço do bolão diverge dos direitos confirmados.');
  const budget=rights.reduce((sum,r)=>sum+BigInt(r.dueCents),0n);
  if (!rights.length || budget===0n || budget>BigInt(financial.finance.pools[poolId]?.allocatedCents??'0')) planningInvalid('budgetCents','Planejamento exige direitos integrais e dinheiro confirmado destinado ao bolão.');
  planningMoney(budget.toString(),'budgetCents',true);
  const feeCents=planningMoney(input.feeCents,'feeCents');
  const feeLabel=planningText(input.feeLabel,'feeLabel',200,BigInt(feeCents)>0n);
  const leftoverPolicy=planningOption(input.leftoverPolicy,['unassigned','refund-pro-rata','group-credit'],'leftoverPolicy');
  const groupPrizeLimitCents=planningGroupPrizeLimit(input.groupPrizeLimitCents??null,mode);
  const fixed:PlanBet[]=input.sourceBets.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map((record,index)=>{
    if (record.kind!=='bet' || record.groupId!==groupId || record.data.poolId!==poolId || record.data.lotteryId!==lottery.id) planningInvalid('sourceBets','Jogo de outro grupo, bolão ou modalidade.');
    return {key:`fixed-${index+1}`,sourceBetId:planningUid(record.id,'sourceBetId'),sourceBetVersion:planningInt(record.serverVersion,'sourceBetVersion'),numbers:validateBet(lottery.id,record.data.numbers),authorIds:record.data.authorIds.slice(),seed:record.data.seed,generationAlgorithmVersion:record.data.generationAlgorithmVersion};
  });
  if (fixed.length>1_000 || new Set(fixed.map((b)=>b.sourceBetId)).size!==fixed.length || new Set(fixed.map((b)=>betSignature(lottery.id,b.numbers))).size!==fixed.length) planningInvalid('sourceBets','Revise jogos fixos repetidos ou em excesso.');
  const fixedCost=fixed.reduce((sum,b)=>sum+BigInt(betCost(lottery.id,b.numbers)),0n);
  const available=budget-BigInt(feeCents);
  if (fixedCost>available) return {plans:[],unavailable:(['spread','balanced','concentrated'] as PlanStrategy[]).map((strategy)=>({strategy,reason:'Jogos fixos e taxas excedem o orçamento confirmado.'}))};
  const result:PlanSuggestionResult={plans:[],unavailable:[]};
  for (const strategy of ['spread','balanced','concentrated'] as const) {
    try {
      const bets=fixed.map((b)=>({...b,numbers:b.numbers.slice(),authorIds:b.authorIds.slice()}));
      let cost=fixedCost;
      const append=(n:number,count:number):void=>{
        const generated=generateBets({lotteryId:lottery.id,count,numberCount:n,seed,existing:bets.map((b)=>b.numbers)});
        for (const numbers of generated) bets.push({key:`generated-${bets.length-fixed.length+1}`,sourceBetId:null,sourceBetVersion:null,numbers,authorIds:[],seed,generationAlgorithmVersion:GENERATION_ALGORITHM_VERSION});
        cost+=BigInt(betCost(lottery.id,Array.from({length:n},(_,i)=>i+1)))*BigInt(count);
      };
      // Complete each fixed number-count group before adding a differently sized receipt.
      if (mode==='official') for (const n of new Set(fixed.map((b)=>b.numbers.length))) {
        const group=bets.filter((b)=>b.numbers.length===n);
        let padding=-1;
        for (let extra=0;extra<=10;extra++) {
          if (bets.length+extra>1_000) break;
          const price=BigInt(betCost(lottery.id,group[0]!.numbers));
          if (cost+price*BigInt(extra)>available) break;
          const probe=[...group,...Array.from({length:extra},(_,i)=>({...group[0]!,key:`probe-${i}`}))];
          try { packPlanTickets(lottery.id,probe,rights,mode); padding=extra;break; } catch { /* Try another complete receipt size. */ }
        }
        if (padding<0) throw new Error('Não há orçamento para completar os recibos oficiais dos jogos fixos.');
        append(n,padding);
      }
      const addAffordable=(n:number,spend:bigint):void=>{
        const price=BigInt(betCost(lottery.id,Array.from({length:n},(_,i)=>i+1)));
        let count=Math.min(1_000-bets.length,Number((available-cost<spend?available-cost:spend)/price));
        if (mode==='official') {
          const current=bets.filter((b)=>b.numbers.length===n);
          while (count>0) {
            const probe=[...current,...Array.from({length:count},(_,i)=>({key:`probe-${i}`,sourceBetId:null,sourceBetVersion:null,numbers:Array.from({length:n},(_,j)=>j+1),authorIds:[],seed,generationAlgorithmVersion:GENERATION_ALGORITHM_VERSION}))];
            try { packPlanTickets(lottery.id,probe,rights,mode);break; } catch { count--; }
          }
        }
        append(n,count);
      };
      if (strategy==='spread') addAffordable(lottery.minNumbers,available-cost);
      if (strategy==='balanced') {
        addAffordable(lottery.minNumbers+1,(available-cost)/2n);
        addAffordable(lottery.minNumbers,available-cost);
      }
      if (strategy==='concentrated') {
        for (let n=lottery.maxNumbers;n>=lottery.minNumbers;n--) {
          const price=BigInt(betCost(lottery.id,Array.from({length:n},(_,i)=>i+1)));
          if (price<=available-cost) { addAffordable(n,available-cost); if (cost>fixedCost) break; }
        }
      }
      const explanation=strategy==='spread'?'Prioriza jogos simples distintos dentro do orçamento.':strategy==='balanced'?'Combina jogos ampliados menores e jogos simples quando o orçamento permite.':'Prioriza jogos com mais dezenas que cabem no orçamento.';
      const draft:Omit<PreparedPlan,'id'>={groupId,poolId,poolVersion,groupRevision,lotteryId:lottery.id,contestNumber,participationMode:mode,strategy,seed,catalogVersion:PLANNING_CATALOG_VERSION,sourceBets:fixed.map((b)=>({id:b.sourceBetId!,version:b.sourceBetVersion!})),rights,budgetCents:budget.toString(),betCostCents:cost.toString(),feeCents,feeLabel,totalCostCents:(cost+BigInt(feeCents)).toString(),leftoverCents:(available-cost).toString(),leftoverPolicy,groupPrizeLimitCents,bets,tickets:packPlanTickets(lottery.id,bets,rights,mode),explanation};
      result.plans.push(validatePreparedPlan({id:deterministicId(draft),...draft}));
    } catch (error) { result.unavailable.push({strategy,reason:error instanceof Error?error.message:'Plano indisponível.'}); }
  }
  return result;
}
