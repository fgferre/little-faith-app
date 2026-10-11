import type { LotteryId } from './types';
import type { ExactPortfolioProbability, SimulationCheckpoint, SimulationEstimate, SimulationInput, SimulationResult } from './planning-types';
import { choose, lotteryRule, validateBet } from './lotteries';
import { createSeededRandom } from './generation';
import { canonicalJSON, sha256Hex } from './canonical';
import { planningInt, planningInvalid, planningList, planningOption, planningRecord, planningSeed, planningShape } from './prepared-plans';

export const DEFAULT_EXACT_ENUMERATION_LIMIT=200_000;
export const MAX_EXACT_ENUMERATION_LIMIT=1_000_000;
export const SIMULATION_ALGORITHM_VERSION='chacha20-draw-fisher-yates-wilson-v1';
export const MIN_SIMULATION_SAMPLES=200_000;
export const MAX_SIMULATION_SAMPLES=1_000_000;
export const MAX_SIMULATION_BATCH_SIZE=10_000;
const tiers:Readonly<Record<LotteryId, readonly number[]>>={'mega-sena':[6,5,4],lotofacil:[15,14,13,12,11],quina:[5,4,3,2]};
export function lotteryPrizeTiers(lotteryId: LotteryId): readonly number[] { lotteryRule(lotteryId); return tiers[lotteryId]; }

export function exactPortfolioProbability(lotteryId: LotteryId, bets: readonly (readonly number[])[], options: {enumerationLimit?:number}={}): ExactPortfolioProbability {
  const rule=lotteryRule(lotteryId);
  const validated=bets.map((bet)=>validateBet(lotteryId,bet));
  return exactCombinationUnion(validated,rule.drawSize,rule.universeSize,options);
}
/** General bounded union, also permits exhaustive tests on small combinatorial universes. */
export function exactCombinationUnion(bets: readonly (readonly number[])[], drawSize: number, universeSize: number, options: {enumerationLimit?:number}={}): ExactPortfolioProbability {
  planningInt(universeSize,'universeSize',1,80); planningInt(drawSize,'drawSize',1,universeSize);
  const enumerationLimit=planningInt(options.enumerationLimit??DEFAULT_EXACT_ENUMERATION_LIMIT,'enumerationLimit',1,MAX_EXACT_ENUMERATION_LIMIT);
  planningList(bets,'bets',1_000);
  const canonical=bets.map((bet)=>{
    if (!Array.isArray(bet) || bet.length<drawSize || bet.length>universeSize || new Set(bet).size!==bet.length || bet.some((n)=>!Number.isInteger(n)||n<1||n>universeSize)) throw new Error('Conjunto de dezenas inválido.');
    return [...bet].sort((a,b)=>a-b);
  });
  const elementary=canonical.reduce((sum,bet)=>sum+choose(bet.length,drawSize),0n);
  const masks=canonical.map((bet)=>bet.reduce((mask,n)=>mask|(1n<<BigInt(n-1)),0n));
  // Identical or entirely contained entries add cost, but add no principal-prize outcomes.
  const essential=canonical.filter((_,i)=>!masks.some((mask,j)=>j!==i && (masks[i]!&mask)===masks[i] && (masks[i]!==mask||j<i)));
  const work=essential.reduce((sum,bet)=>sum+choose(bet.length,drawSize),0n);
  const denominator=choose(universeSize,drawSize).toString();
  if (work>BigInt(enumerationLimit)) return {status:'unavailable',method:'distinct-combination-union',enumerationLimit,elementaryCombinations:elementary.toString(),distinctCombinations:null,denominator,probability:null,reason:`A expansão necessária (${work}) excede o limite explícito de ${enumerationLimit} combinações; nenhuma soma de probabilidades foi usada.`};
  const union=new Set<bigint>();
  for (const bet of essential) {
    const bits=bet.map((n)=>1n<<BigInt(n-1));
    const visit=(index:number,remaining:number,mask:bigint):void=>{
      if (!remaining) {union.add(mask);return;}
      for (let i=index;i<=bits.length-remaining;i++) visit(i+1,remaining-1,mask|bits[i]!);
    };
    visit(0,drawSize,0n);
  }
  return {status:'exact',method:'distinct-combination-union',enumerationLimit,elementaryCombinations:elementary.toString(),distinctCombinations:union.size.toString(),denominator,probability:union.size/Number(denominator),reason:null};
}
export function validateSimulationInput(input: unknown): SimulationInput {
  const value=planningRecord(input,'simulation'); planningShape(value,['lotteryId','bets','seed','targetSamples'],'simulation');
  const lotteryId=planningOption<LotteryId>(value.lotteryId,['mega-sena','lotofacil','quina'],'lotteryId');
  const bets=planningList(value.bets,'bets').map((bet)=>validateBet(lotteryId,planningList(bet,'numbers',20) as number[]));
  if (!bets.length) planningInvalid('bets','Simulação exige pelo menos um jogo.');
  return {lotteryId,bets,seed:planningSeed(value.seed),targetSamples:planningInt(value.targetSamples,'targetSamples',MIN_SIMULATION_SAMPLES,MAX_SIMULATION_SAMPLES)};
}
function inputSignature(input: SimulationInput): string { return sha256Hex(canonicalJSON({algorithmVersion:SIMULATION_ALGORITHM_VERSION,...input})); }
export function createSimulationCheckpoint(source: SimulationInput): SimulationCheckpoint {
  const input=validateSimulationInput(source);
  return {algorithmVersion:SIMULATION_ALGORITHM_VERSION,inputSignature:inputSignature(input),processedSamples:0,randomWordOffset:0,anyPrizeHits:0,hitsByTier:Object.fromEntries(tiers[input.lotteryId].map((tier)=>[tier.toString(),0]))};
}
export function validateSimulationCheckpoint(source: SimulationInput, candidate: unknown): SimulationCheckpoint {
  const input=validateSimulationInput(source);
  const value=planningRecord(candidate,'checkpoint'); planningShape(value,['algorithmVersion','inputSignature','processedSamples','randomWordOffset','anyPrizeHits','hitsByTier'],'checkpoint');
  if (value.algorithmVersion!==SIMULATION_ALGORITHM_VERSION || value.inputSignature!==inputSignature(input)) planningInvalid('checkpoint','Checkpoint não corresponde ao algoritmo, jogos, meta e semente.');
  const processedSamples=planningInt(value.processedSamples,'processedSamples',0,input.targetSamples);
  const randomWordOffset=planningInt(value.randomWordOffset,'randomWordOffset',0,0x1_0000_0000*16-1);
  if (randomWordOffset<processedSamples*lotteryRule(input.lotteryId).drawSize || (!processedSamples && randomWordOffset!==0)) planningInvalid('randomWordOffset','Posição aleatória inconsistente com as amostras.');
  const anyPrizeHits=planningInt(value.anyPrizeHits,'anyPrizeHits',0,processedSamples);
  const hitRecord=planningRecord(value.hitsByTier,'hitsByTier');
  planningShape(hitRecord,tiers[input.lotteryId].map(String),'hitsByTier');
  const hitsByTier=Object.fromEntries(tiers[input.lotteryId].map((tier)=>[tier.toString(),planningInt(hitRecord[tier.toString()],`hitsByTier.${tier}`,0,anyPrizeHits)]));
  if (Object.values(hitsByTier).reduce((a,b)=>a+b,0)<anyPrizeHits) planningInvalid('anyPrizeHits','Contadores das faixas não justificam o total premiado.');
  return {algorithmVersion:SIMULATION_ALGORITHM_VERSION,inputSignature:value.inputSignature as string,processedSamples,randomWordOffset,anyPrizeHits,hitsByTier};
}
function popcount(word:number):number {
  word-= (word>>>1)&0x55555555;
  word=(word&0x33333333)+((word>>>2)&0x33333333);
  return (((word+(word>>>4))&0x0f0f0f0f)*0x01010101)>>>24;
}
/** Pure bounded work unit: the worker owns scheduling, yielding, cancellation and checkpoint storage. */
export function runSimulationBatch(source: SimulationInput, candidate: SimulationCheckpoint, batchSize: number): SimulationCheckpoint {
  const input=validateSimulationInput(source);
  const checkpoint=validateSimulationCheckpoint(input,candidate);
  planningInt(batchSize,'batchSize',1,MAX_SIMULATION_BATCH_SIZE);
  const count=Math.min(batchSize,input.targetSamples-checkpoint.processedSamples);
  if (!count) return checkpoint;
  const rule=lotteryRule(input.lotteryId);
  const random=createSeededRandom(input.seed,checkpoint.randomWordOffset);
  const masks=input.bets.map((bet)=>{
    const words=[0,0,0];
    for (const n of bet) words[Math.floor((n-1)/32)]! |= 1<<((n-1)%32);
    return words;
  });
  const deck=new Uint8Array(rule.universeSize);
  const tierList=tiers[input.lotteryId];
  const hitsByTier={...checkpoint.hitsByTier};
  let anyPrizeHits=checkpoint.anyPrizeHits;
  for (let sample=0;sample<count;sample++) {
    for (let i=0;i<deck.length;i++) deck[i]=i;
    const drawn=[0,0,0];
    for (let i=0;i<rule.drawSize;i++) {
      const bound=rule.universeSize-i;
      const limit=0x1_0000_0000-(0x1_0000_0000%bound);
      let word:number;
      do {word=random.nextWord();} while (word>=limit);
      const index=i+word%bound;
      const selected=deck[index]!;deck[index]=deck[i]!;deck[i]=selected;
      drawn[Math.floor(selected/32)]! |= 1<<(selected%32);
    }
    const found=new Array<boolean>(tierList.length).fill(false);
    let foundCount=0;
    for (let b=0;b<masks.length;b++) {
      const mask=masks[b]!;
      const hits=popcount(mask[0]!&drawn[0]!)+popcount(mask[1]!&drawn[1]!)+popcount(mask[2]!&drawn[2]!);
      const misses=input.bets[b]!.length-hits;
      for (let t=0;t<tierList.length;t++) if (!found[t] && hits>=tierList[t]! && misses>=rule.drawSize-tierList[t]!) {found[t]=true;foundCount++;}
      if (foundCount===tierList.length) break;
    }
    if (foundCount) anyPrizeHits++;
    for (let t=0;t<tierList.length;t++) if (found[t]) hitsByTier[tierList[t]!.toString()]!++;
  }
  return {algorithmVersion:SIMULATION_ALGORITHM_VERSION,inputSignature:checkpoint.inputSignature,processedSamples:checkpoint.processedSamples+count,randomWordOffset:random.getWordOffset(),anyPrizeHits,hitsByTier};
}
/** Wilson 95% interval remains positive above zero after observing no successes. */
export function wilsonEstimate(hits: number, samples: number): SimulationEstimate {
  planningInt(samples,'samples',0,MAX_SIMULATION_SAMPLES); planningInt(hits,'hits',0,samples);
  if (!samples) return {hits:0,probability:0,lower95:0,upper95:1};
  const z=1.959963984540054,z2=z*z,p=hits/samples,denom=1+z2/samples;
  const center=(p+z2/(2*samples))/denom;
  const half=z*Math.sqrt(p*(1-p)/samples+z2/(4*samples*samples))/denom;
  return {hits,probability:p,lower95:Math.max(0,center-half),upper95:Math.min(1,center+half)};
}
export function simulationResult(source: SimulationInput, candidate: SimulationCheckpoint): SimulationResult {
  const input=validateSimulationInput(source);
  const checkpoint=validateSimulationCheckpoint(input,candidate);
  return {algorithmVersion:SIMULATION_ALGORITHM_VERSION,seed:input.seed,samples:checkpoint.processedSamples,complete:checkpoint.processedSamples===input.targetSamples,anyPrize:wilsonEstimate(checkpoint.anyPrizeHits,checkpoint.processedSamples),tiers:Object.fromEntries(tiers[input.lotteryId].map((tier)=>[tier.toString(),wilsonEstimate(checkpoint.hitsByTier[tier.toString()]!,checkpoint.processedSamples)])),zeroHitsMeaning:'not-proof-of-zero-probability'};
}
