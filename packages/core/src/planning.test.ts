import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FinancialSnapshot, ManifestContent, PlanBet, PlanRight, PlanningSnapshot, SuggestPlansInput } from './index';
import { CATALOG_VERSION, PLANNING_CATALOG, PLANNING_CATALOG_VERSION, SIMULATION_ALGORITHM_VERSION, auditPlanningCatalog, betCost, canonicalJSON, canonicalManifest, choose, createSeededRandom, createSimulationCheckpoint, exactCombinationUnion, exactPortfolioProbability, hashManifest, officialPoolRule, packPlanTickets, runSimulationBatch, sha256Hex, simulationResult, suggestPlans, validatePlanTickets, validatePlanningCommand, validatePlanningReceipt, validatePlanningSnapshot, validatePoolManifest, validatePreparedPlan, validateSimulationCheckpoint, verifyManifest, wilsonEstimate } from './index';

const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const GROUP=id(1),POOL=id(2),STATUTE=id(3),SEED='00'.repeat(32);
const EARLY='2026-10-08T12:00:00.000Z',CONFIRMED='2026-10-08T13:00:00.000Z',LOCKED='2026-10-08T14:00:00.000Z';
function input(amount='1500',mode:'internal'|'official'='internal',units=[100,100]):SuggestPlansInput {
  const financial:FinancialSnapshot={groupId:GROUP,groupRevision:10,statutes:[{id:STATUTE,groupId:GROUP,version:1,text:'Sobras devem ter destino autorizado.',sourceGroupVersion:1,publishedAt:EARLY,receiptId:id(100)}],acceptances:[],payments:[],allocations:[],movements:[],quotas:[],revocations:[]};
  for (let i=0;i<units.length;i++) {
    const personId=id(20+i),paymentId=id(200+i),allocationId=id(300+i),receiptId=id(400+i),quotaId=id(500+i);
    financial.acceptances.push({id:id(600+i),groupId:GROUP,statuteId:STATUTE,personId,evidence:'Aceite explícito.',acceptedAt:EARLY,receiptId:id(700+i)});
    financial.payments.push({id:paymentId,groupId:GROUP,personId,sourceProposalId:id(800+i),sourceProposalVersion:1,amountCents:amount,bankReference:null,declaredReceivedAt:null,confirmedAt:CONFIRMED,receiptId});
    financial.allocations.push({id:allocationId,groupId:GROUP,paymentId,personId,poolId:POOL,amountCents:amount,allocatedAt:CONFIRMED,receiptId});
    financial.movements.push({id:id(900+i),groupId:GROUP,paymentId,personId,poolId:null,allocationId:null,kind:'payment-received',amountCents:amount,reason:'',createdAt:CONFIRMED,receiptId},{id:id(1000+i),groupId:GROUP,paymentId,personId,poolId:POOL,allocationId,kind:'payment-allocated',amountCents:amount,reason:'',createdAt:CONFIRMED,receiptId});
    financial.quotas.push({id:quotaId,groupId:GROUP,poolId:POOL,personId,sourceQuotaId:id(1100+i),sourceQuotaVersion:1,units:units[i]!,dueCents:(BigInt(amount)*BigInt(units[i]!)/100n).toString(),statuteId:STATUTE,confirmedAt:CONFIRMED,receiptId:id(1200+i)});
  }
  return {groupId:GROUP,groupRevision:10,pool:{id:POOL,groupId:GROUP,kind:'pool',data:{title:'Bolão de teste',lotteryId:'mega-sena',contestNumber:3000,deadlineAt:'2026-10-08T16:00:00.000Z',quotaPriceCents:amount,participationMode:mode,status:'draft'},localVersion:1,serverVersion:1,state:'synced',createdAt:EARLY,updatedAt:EARLY},sourceBets:[],financial,seed:SEED,feeCents:'0',feeLabel:'',leftoverPolicy:'group-credit'};
}
function right(n:number,units=100):PlanRight {return {quotaId:id(500+n),sourceQuotaId:id(1100+n),sourceQuotaVersion:1,personId:id(20+n),units,dueCents:'1500',statuteId:STATUTE};}
function bet(n:number,size=6):PlanBet { return {key:`bet-${n}`,sourceBetId:id(1500+n),sourceBetVersion:1,numbers:Array.from({length:size},(_,i)=>i+1),authorIds:[],seed:null,generationAlgorithmVersion:null}; }
function frozen(plan=suggestPlans(input()).plans[0]!,financial=input().financial):ManifestContent {
  return {schemaVersion:'pool-manifest-v1',catalog:PLANNING_CATALOG[plan.lotteryId],responsible:{organizerUserId:id(999),registrarPersonId:id(20),ticketHolderPersonId:plan.participationMode==='internal'?id(20):null},pool:{id:POOL,version:2,data:{...input().pool.data,participationMode:plan.participationMode,status:'locked'}},plan,persons:[{id:id(20),version:1,data:{name:'Pessoa A',nickname:'A',adultDeclared:true}},{id:id(21),version:1,data:{name:'Pessoa B',nickname:'B',adultDeclared:true}}],financial};
}
function manifest(content=frozen(),version=1) {
  const canonical=canonicalManifest(content);
  return {id:id(2000+version),groupId:GROUP,poolId:POOL,version,appliedPlanId:id(2100+version),content,canonical,sha256:sha256Hex(canonical),lockedAt:LOCKED,receiptId:id(2200+version)};
}
function snapshot():PlanningSnapshot {
  const m=manifest();
  return {groupId:GROUP,groupRevision:12,appliedPlans:[{id:m.appliedPlanId,groupId:GROUP,poolId:POOL,version:1,plan:m.content.plan,appliedAt:CONFIRMED,receiptId:id(2300)}],manifests:[m]};
}

describe('complete official catalog and receipt packing',()=>{
  it('preserves basic drafts while freezing all 32 number-count prices and rules',()=>{
    expect(CATALOG_VERSION).toBe('caixa-basic-2026-10-07-v1');
    expect(PLANNING_CATALOG_VERSION).toBe('caixa-pools-2026-10-08-v1');
    expect(Object.values(PLANNING_CATALOG).reduce((sum,c)=>sum+Object.keys(c.rules).length,0)).toBe(32);
    expect(auditPlanningCatalog()).toBe(true);
    for (const catalog of Object.values(PLANNING_CATALOG)) for (const row of Object.values(catalog.rules)) expect(row.betPriceCents).toBe(betCost(catalog.lotteryId,Array.from({length:row.numberCount},(_,i)=>i+1)));
    expect(officialPoolRule('mega-sena',20)).toMatchObject({maxGamesPerReceipt:1,betPriceCents:'23256000',maxQuotas:100});
    expect(officialPoolRule('lotofacil',19).maxGamesPerReceipt).toBe(9);
    expect(officialPoolRule('quina',5).maxQuotas).toBe(7);
  });
  it('repacks the tail instead of producing one invalid remaining simple Mega game',()=>{
    const bets=Array.from({length:11},(_,i)=>bet(i));
    const tickets=packPlanTickets('mega-sena',bets,[right(0),right(1)],'official');
    expect(tickets.map((t)=>t.betKeys.length)).toEqual([8,3]);
    expect(tickets.map((t)=>t.betCostCents)).toEqual(['4800','1800']);
    validatePlanTickets('mega-sena',bets,[right(0),right(1)],'official',tickets);
  });
  it('represents internal fractions as whole official quota counts on every receipt',()=>{
    const rights=[right(0,25),right(1,50)];
    const tickets=packPlanTickets('mega-sena',[bet(1),bet(2),bet(3),bet(4)],rights,'official');
    expect(tickets[0]).toMatchObject({officialQuotaCount:3,officialQuotaValueCents:'800',assignments:[{officialQuotas:1},{officialQuotas:2}]});
    expect(()=>packPlanTickets('mega-sena',[bet(1),bet(2),bet(3)],rights,'official')).toThrow('não cabem');
  });
  it('does not label an internal agreement or its fractions as official quotas',()=>{
    const tickets=packPlanTickets('mega-sena',[bet(1)], [right(0,17),right(1,100)],'internal');
    expect(tickets[0]).toMatchObject({officialQuotaCount:null,officialQuotaValueCents:null,assignments:[]});
    expect(()=>packPlanTickets('mega-sena',[bet(1)], [right(0,17),right(1,100)],'official')).toThrow();
  });
  it('checks receipt membership, face value and every person’s economic ratio',()=>{
    const bets=[bet(1),bet(2),bet(3),bet(4)];const rights=[right(0),right(1)];
    const tickets=packPlanTickets('mega-sena',bets,rights,'official');
    const tampered=structuredClone(tickets);tampered[0]!.assignments[0]!.officialQuotas++;
    expect(()=>validatePlanTickets('mega-sena',bets,rights,'official',tampered)).toThrow('proporção');
    const repeated=structuredClone(tickets);repeated[0]!.betKeys[1]=repeated[0]!.betKeys[0]!;
    expect(()=>validatePlanTickets('mega-sena',bets,rights,'official',repeated)).toThrow('exatamente');
  });
});

describe('confirmed-budget plan heuristics and contracts',()=>{
  it('produces three deterministic feasible approaches without overspending',()=>{
    const first=suggestPlans(input('30000'));
    expect(first.plans.map((p)=>p.strategy)).toEqual(['spread','balanced','concentrated']);
    expect(suggestPlans(input('30000'))).toEqual(first);
    expect(new Set(first.plans.map((p)=>p.id)).size).toBe(3);
    expect(first.plans[0]!.bets.every((b)=>b.numbers.length===6)).toBe(true);
    expect(first.plans[2]!.bets.some((b)=>b.numbers.length>7)).toBe(true);
    for (const plan of first.plans) {
      expect(BigInt(plan.totalCostCents)+BigInt(plan.leftoverCents)).toBe(BigInt(plan.budgetCents));
      expect(new Set(plan.bets.map((b)=>b.numbers.join(','))).size).toBe(plan.bets.length);
      expect(validatePreparedPlan(plan)).toEqual(plan);
    }
  });
  it('preserves fixed origin, author and numbers in every suggested strategy',()=>{
    const value=input('6000');
    value.sourceBets=[{id:id(50),groupId:GROUP,kind:'bet',data:{poolId:POOL,lotteryId:'mega-sena',numbers:[1,2,3,4,5,6],authorIds:[id(20)],catalogVersion:CATALOG_VERSION,seed:null,generationAlgorithmVersion:null},serverVersion:2,localVersion:2,state:'synced',createdAt:EARLY,updatedAt:EARLY}];
    for (const plan of suggestPlans(value).plans) {
      expect(plan.sourceBets).toEqual([{id:id(50),version:2}]);
      expect(plan.bets[0]).toMatchObject({sourceBetId:id(50),sourceBetVersion:2,numbers:[1,2,3,4,5,6],authorIds:[id(20)]});
    }
  });
  it('compares and simulates fixed unsynchronized games offline while refusing their confirmation',()=>{
    const value=input('6000');value.pool.serverVersion=0;
    value.sourceBets=[{id:id(50),groupId:GROUP,kind:'bet',data:{poolId:POOL,lotteryId:'mega-sena',numbers:[1,2,3,4,5,6],authorIds:[],catalogVersion:CATALOG_VERSION,seed:null,generationAlgorithmVersion:null},serverVersion:0,localVersion:1,state:'local',createdAt:EARLY,updatedAt:EARLY}];
    const plan=suggestPlans(value).plans[0]!;
    expect(plan.poolVersion).toBe(0);expect(plan.sourceBets).toEqual([{id:id(50),version:0}]);
    expect(validatePreparedPlan(plan)).toEqual(plan);
    const simulation={lotteryId:plan.lotteryId,bets:plan.bets.map((bet)=>bet.numbers),seed:SEED,targetSamples:200_000};
    expect(runSimulationBatch(simulation,createSimulationCheckpoint(simulation),10).processedSamples).toBe(10);
    expect(()=>validatePlanningCommand({apiVersion:'v1',idempotencyKey:id(99),groupId:GROUP,expectedRevision:10,action:{type:'plan_apply',plan}})).toThrow('sincronizados');
    expect(()=>canonicalManifest(frozen(plan))).toThrow('sincronizados');
  });
  it('ignores confirmed excess without an entitled quota, rejects missing funding and explains infeasible fixed costs',()=>{
    const value=input();value.pool.data.quotaPriceCents='1000';value.financial.quotas.forEach((q)=>q.dueCents='1000');
    expect(suggestPlans(value).plans[0]!.budgetCents).toBe('2000');
    value.financial.quotas=[];expect(()=>suggestPlans(value)).toThrow('direitos');
    const tiny=input('100');tiny.sourceBets=[{id:id(50),groupId:GROUP,kind:'bet',data:{poolId:POOL,lotteryId:'mega-sena',numbers:[1,2,3,4,5,6],authorIds:[],catalogVersion:CATALOG_VERSION,seed:null,generationAlgorithmVersion:null},serverVersion:1,localVersion:1,state:'synced',createdAt:EARLY,updatedAt:EARLY}];
    expect(suggestPlans(tiny).unavailable).toHaveLength(3);
  });
  it('never fabricates an official plan when the internal ratios cannot fit receipt limits',()=>{
    const impossible=suggestPlans(input('1500','official',[17,100]));
    expect(impossible.plans).toEqual([]);expect(impossible.unavailable).toHaveLength(3);
    const possible=suggestPlans(input('1500','official'));
    expect(possible.plans.length).toBeGreaterThan(0);
    for (const plan of possible.plans) validatePlanTickets(plan.lotteryId,plan.bets,plan.rights,plan.participationMode,plan.tickets);
  });
  it('does not accept client costs, omitted fixed bets, duplicate rights or forged authority',()=>{
    const plan=suggestPlans(input()).plans[0]!;
    expect(()=>validatePreparedPlan({...plan,betCostCents:'1'})).toThrow('Custo');
    expect(()=>validatePreparedPlan({...plan,rights:[plan.rights[0],plan.rights[0]]})).toThrow('repetido');
    expect(()=>validatePreparedPlan({...plan,sourceBets:[{id:id(50),version:1}]})).toThrow('preservados');
    expect(()=>validatePlanningCommand({apiVersion:'v1',idempotencyKey:id(99),groupId:GROUP,expectedRevision:11,action:{type:'plan_apply',plan}})).toThrow('revisão');
    expect(()=>validatePlanningCommand({apiVersion:'v1',idempotencyKey:id(99),groupId:GROUP,expectedRevision:10,action:{type:'plan_apply',plan},actorId:id(20)})).toThrow('Campo');
  });
  it('accepts the group prize limit absent, null or valid and rejects an invalid one or one on official participation',()=>{
    const plan=suggestPlans(input()).plans[0]!;expect('groupPrizeLimitCents' in plan).toBe(false);
    const legacy:Record<string,unknown>={...plan};delete legacy.groupPrizeLimitCents;
    expect(validatePreparedPlan(legacy)).toEqual(legacy);expect('groupPrizeLimitCents' in validatePreparedPlan(legacy)).toBe(false);
    expect(validatePreparedPlan({...plan,groupPrizeLimitCents:null}).groupPrizeLimitCents).toBeNull();
    const limited=suggestPlans({...input(),groupPrizeLimitCents:'2500'}).plans;
    expect(limited.length).toBeGreaterThan(0);expect(limited.every((p)=>p.groupPrizeLimitCents==='2500')).toBe(true);
    expect(validatePreparedPlan({...plan,groupPrizeLimitCents:'9007199254740991'}).groupPrizeLimitCents).toBe('9007199254740991');
    for (const bad of ['0','-5','1.5','01','','9007199254740992',2500,undefined]) expect(()=>validatePreparedPlan({...plan,groupPrizeLimitCents:bad})).toThrow();
    expect(()=>suggestPlans({...input(),groupPrizeLimitCents:'0'})).toThrow();
    const official=suggestPlans(input('1500','official')).plans[0]!;expect('groupPrizeLimitCents' in official).toBe(false);
    expect(validatePreparedPlan({...official,groupPrizeLimitCents:null}).groupPrizeLimitCents).toBeNull();
    expect(()=>validatePreparedPlan({...official,groupPrizeLimitCents:'2500'})).toThrow('só vale no combinado interno');
    expect(()=>suggestPlans({...input('1500','official'),groupPrizeLimitCents:'2500'})).toThrow('só vale no combinado interno');
  });
  it('preserves external fees and a residual cent without manufacturing an official service charge',()=>{
    const value=input();value.feeCents='1';value.feeLabel='Despesa externa autorizada';
    const plan=suggestPlans(value).plans[0]!;
    expect(plan).toMatchObject({betCostCents:'2400',feeCents:'1',totalCostCents:'2401',leftoverCents:'599'});
    value.feeLabel='';expect(()=>suggestPlans(value)).toThrow('Texto');
  });
});

describe('exact distinct combination union',()=>{
  it('matches exhaustive draws for overlapping small sets and contained duplicates',()=>{
    const bets=[[1,2,3,4],[3,4,5,6],[1,2,3],[1,2,3,4]];
    const result=exactCombinationUnion(bets,3,7);
    const outcomes:number[][]=[];
    for(let a=1;a<=7;a++)for(let b=a+1;b<=7;b++)for(let c=b+1;c<=7;c++) if(bets.some((bet)=>[a,b,c].every((n)=>bet.includes(n)))) outcomes.push([a,b,c]);
    expect(result).toMatchObject({status:'exact',distinctCombinations:outcomes.length.toString(),denominator:'35',probability:outcomes.length/35});
    expect(result.distinctCombinations).toBe('8');
  });
  it('counts shared jackpot outcomes once for expanded actual lotteries',()=>{
    const result=exactPortfolioProbability('mega-sena',[[1,2,3,4,5,6,7],[2,3,4,5,6,7,8],[1,2,3,4,5,6]]);
    expect(result).toMatchObject({elementaryCombinations:'15',distinctCombinations:'13',denominator:'50063860',probability:13/50063860});
  });
  it('reports an explicit unavailable result instead of truncated expansion or sums',()=>{
    const result=exactPortfolioProbability('mega-sena',[Array.from({length:20},(_,i)=>i+1)],{enumerationLimit:100});
    expect(result).toMatchObject({status:'unavailable',distinctCombinations:null,probability:null,enumerationLimit:100});
    expect(result.reason).toContain('38760');
    expect(exactCombinationUnion([],3,7).probability).toBe(0);
  });
});

describe('deterministic Monte Carlo checkpoints and confidence intervals',()=>{
  const simulation={lotteryId:'quina' as const,bets:[[1,2,3,4,5]],seed:SEED,targetSamples:200_000};
  it('seeks directly to any ChaCha block while retaining the existing generator stream',()=>{
    const original=createSeededRandom(SEED);const words=Array.from({length:90},()=>original.nextWord());
    for (const offset of [0,1,15,16,17,63,77]) {
      const resumed=createSeededRandom(SEED,offset);
      expect(Array.from({length:5},()=>resumed.nextWord())).toEqual(words.slice(offset,offset+5));
      expect(resumed.getWordOffset()).toBe(offset+5);
    }
  });
  it('matches uninterrupted work when paused, serialized and resumed with different batch sizes',()=>{
    const initial=createSimulationCheckpoint(simulation);
    const whole=runSimulationBatch(simulation,initial,4000);
    const partial=runSimulationBatch(simulation,initial,137);
    const resumed=runSimulationBatch(simulation,JSON.parse(JSON.stringify(partial)) as typeof partial,3863);
    expect(resumed).toEqual(whole);expect(initial.processedSamples).toBe(0);
    const refined={...simulation,targetSamples:1_000_000};
    const carried={...whole,inputSignature:createSimulationCheckpoint(refined).inputSignature};
    expect(runSimulationBatch(refined,carried,50).hitsByTier).toEqual(runSimulationBatch(simulation,whole,50).hitsByTier);
  });
  it('finishes 200,000 draws and contains the known simple Quina duque probability in its 95% interval',()=>{
    let state=createSimulationCheckpoint(simulation);
    for (let i=0;i<20;i++) state=runSimulationBatch(simulation,state,10_000);
    const result=simulationResult(simulation,state);
    const exact=Number(choose(5,2)*choose(75,3))/Number(choose(80,5));
    expect(result.complete).toBe(true);expect(result.samples).toBe(200_000);
    expect(result.tiers['2']!.lower95).toBeLessThan(exact);expect(result.tiers['2']!.upper95).toBeGreaterThan(exact);
    expect(result.tiers['5']!.hits).toBe(0);expect(result.tiers['5']!.upper95).toBeGreaterThan(0);
    expect(result.zeroHitsMeaning).toBe('not-proof-of-zero-probability');
    expect(runSimulationBatch(simulation,state,100)).toEqual(state);
  });
  it('does not add duplicate or simultaneous tier events into a joint probability',()=>{
    const duplicate={...simulation,bets:[simulation.bets[0]!,simulation.bets[0]!]};
    const one=runSimulationBatch(simulation,createSimulationCheckpoint(simulation),1000);
    const twice=runSimulationBatch(duplicate,createSimulationCheckpoint(duplicate),1000);
    expect(twice.anyPrizeHits).toBe(one.anyPrizeHits);expect(twice.hitsByTier).toEqual(one.hitsByTier);
    const expanded={...simulation,bets:[Array.from({length:15},(_,i)=>i+1)]};
    const events=runSimulationBatch(expanded,createSimulationCheckpoint(expanded),10_000);
    expect(Object.values(events.hitsByTier).reduce((a,b)=>a+b,0)).toBeGreaterThan(events.anyPrizeHits);
  });
  it('rejects changed seeds, corruption, algorithm mismatches and unbounded sample requests',()=>{
    const checkpoint=createSimulationCheckpoint(simulation);
    expect(()=>validateSimulationCheckpoint({...simulation,seed:'ff'.repeat(32)},checkpoint)).toThrow('Checkpoint');
    expect(()=>validateSimulationCheckpoint(simulation,{...checkpoint,algorithmVersion:'fake'})).toThrow();
    expect(()=>validateSimulationCheckpoint(simulation,{...checkpoint,processedSamples:1})).toThrow('Posição');
    expect(()=>createSimulationCheckpoint({...simulation,targetSamples:10_000_000})).toThrow();
    expect(checkpoint.algorithmVersion).toBe(SIMULATION_ALGORITHM_VERSION);
    expect(wilsonEstimate(0,200_000).upper95).toBeGreaterThan(0);
    expect(wilsonEstimate(200_000,200_000).lower95).toBeLessThan(1);
  });
});

describe('immutable private manifests and approval protocol',()=>{
  it.each(['','abc','á🦆'.repeat(1000)])('matches independent SHA-256 including UTF-8 and block padding',async(value)=>{
    expect(sha256Hex(value)).toBe(createHash('sha256').update(value,'utf8').digest('hex'));
  });
  it('canonicalizes recursively without relying on object insertion order',()=>{
    expect(canonicalJSON({z:[{b:'2',a:1}],a:true})).toBe('{"a":true,"z":[{"a":1,"b":"2"}]}');
    expect(()=>canonicalJSON({p:1.5})).toThrow();expect(()=>canonicalJSON({p:undefined})).toThrow();
  });
  it('validates an initial lock with a financial revision later than the prepared plan',async()=>{
    const state=snapshot();state.manifests[0]!.content.financial.groupRevision=11;
    const m=state.manifests[0]!;m.canonical=canonicalManifest(m.content);m.sha256=sha256Hex(m.canonical);
    expect(validatePlanningSnapshot(state)).toEqual(state);
    expect(await hashManifest(m.content)).toBe(m.sha256);expect(await verifyManifest(m)).toBe(true);
  });
  it('detects changed content, missing adult rights, unassigned leftovers and invented rules',()=>{
    const m=manifest();expect(validatePoolManifest(m)).toEqual(m);
    expect(()=>validatePoolManifest({...m,sha256:'00'.repeat(32)})).toThrow('SHA');
    const child=structuredClone(m.content);child.persons[0]!.data.adultDeclared=false;
    expect(()=>canonicalManifest(child)).toThrow('maioridade');
    const left=structuredClone(m.content);left.plan.leftoverPolicy='unassigned';left.plan.feeCents='1';left.plan.feeLabel='Taxa externa';left.plan.bets.pop();left.plan.betCostCents='2400';left.plan.totalCostCents='2401';left.plan.leftoverCents='599';left.plan.tickets=packPlanTickets('mega-sena',left.plan.bets,left.plan.rights,'internal');
    expect(()=>canonicalManifest(left)).toThrow('destino');
    const forged=structuredClone(m.content);forged.catalog={...forged.catalog,rules:{...forged.catalog.rules,6:{...forged.catalog.rules[6]!,betPriceCents:'1'}}};
    expect(()=>canonicalManifest(forged)).toThrow('Regras');
  });
  it('freezes the group prize limit in the canonical manifest and still verifies manifests made without it',async()=>{
    const plan=suggestPlans({...input(),groupPrizeLimitCents:'2500'}).plans[0]!;
    const m=manifest(frozen(plan,input().financial));
    expect(m.canonical).toContain('"groupPrizeLimitCents":"2500"');expect(validatePoolManifest(m)).toEqual(m);expect(await verifyManifest(m)).toBe(true);
    const edited=structuredClone(m);edited.content.plan.groupPrizeLimitCents='2600';expect(await verifyManifest(edited)).toBe(false);
    const legacy=structuredClone(manifest().content);delete legacy.plan.groupPrizeLimitCents;
    const old={...manifest(legacy)};expect(old.canonical).not.toContain('groupPrizeLimitCents');
    expect(validatePoolManifest(old)).toEqual(old);expect(await verifyManifest(old)).toBe(true);
  });
  it('rejects incoherent frozen quota prices and missing internal ticket holders',()=>{
    const wrongPrice=frozen();wrongPrice.pool.data.quotaPriceCents='1501';
    expect(()=>canonicalManifest(wrongPrice)).toThrow('Preço');
    const noHolder=frozen();noHolder.responsible.ticketHolderPersonId=null;
    expect(()=>canonicalManifest(noHolder)).toThrow('Registrador');
    const changed=input();changed.pool.data.quotaPriceCents='1501';
    expect(()=>suggestPlans(changed)).toThrow('Preço');
  });
  it('accepts a lock confirmed after the agreed deadline',()=>{
    const late=manifest();late.lockedAt=new Date(Date.parse(late.content.pool.data.deadlineAt!)+86400000).toISOString();
    expect(validatePoolManifest(late)).toEqual(late);
  });
  it('requires versioned chronological facts and immutable financing when revising a locked pool',()=>{
    const first=snapshot();expect(()=>validatePlanningSnapshot({...first,appliedPlans:[]})).toThrow('referenciar');
    const content=structuredClone(first.manifests[0]!.content);content.plan.groupRevision=12;content.plan.poolVersion=2;content.pool.version=3;
    const second=manifest(content,2);second.lockedAt='2026-10-08T15:00:00.000Z';
    expect(validatePoolManifest(second).content.plan).toEqual(content.plan);
    const revised={...first,groupRevision:14,appliedPlans:[...first.appliedPlans,{id:second.appliedPlanId,groupId:GROUP,poolId:POOL,version:2,plan:content.plan,appliedAt:LOCKED,receiptId:id(2301)}],manifests:[...first.manifests,second]};
    expect(validatePlanningSnapshot(revised)).toEqual(revised);
    second.content.persons[0]!.version++;second.canonical=canonicalManifest(second.content);second.sha256=sha256Hex(second.canonical);
    expect(()=>validatePlanningSnapshot(revised)).toThrow('preservar');
  });
  it('requires online human receipt facts without conflating their IDs with the idempotency key',()=>{
    const state=snapshot();
    const receipt={apiVersion:'v1',idempotencyKey:id(99),receiptId:state.manifests[0]!.receiptId,groupId:GROUP,status:'accepted',groupRevision:12,message:null,confirmedAt:LOCKED,snapshot:state};
    expect(validatePlanningReceipt(receipt)).toEqual(receipt);
    expect(()=>validatePlanningReceipt({...receipt,confirmedAt:null})).toThrow('horário');
    expect(()=>validatePlanningReceipt({...receipt,status:'rejected'})).toThrow('horário');
    expect(()=>validatePlanningReceipt({...receipt,receiptId:id(99)})).toThrow('fato novo');
    expect(validatePlanningSnapshot({groupId:GROUP,groupRevision:0,appliedPlans:[],manifests:[]})).toEqual({groupId:GROUP,groupRevision:0,appliedPlans:[],manifests:[]});
  });
});
