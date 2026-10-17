import type { AppliedPlan, ManifestContent, PlanningAction, PlanningCommand, PlanningReceipt, PlanningSnapshot, PoolManifest, PreparedPlan } from './planning-types';
import type { FinancialSnapshot } from './financial-types';
import { createFinancialView, validateFinancialSnapshot } from './financial';
import { canonicalJSON, sha256Hex } from './canonical';
import { PLANNING_CATALOG } from './planning-catalog';
import { validateEntityData } from './validation';
import { quotaCost } from './money';
import { assertConfirmedPlanSources, validatePreparedPlan, planningInt, planningInvalid, planningList, planningOption, planningRecord, planningShape, planningText, planningUid } from './prepared-plans';

export const MAX_PLANNING_COMMAND_BYTES=1_048_576;
function time(value: unknown, field: string): string {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return planningInvalid(field,'Horário UTC inválido.');
  const parsed=new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString()!==value.replace(/Z$/,value.includes('.')?'Z':'.000Z')) return planningInvalid(field,'Horário UTC inválido.');
  return parsed.toISOString();
}
function uniqueIds<T extends {id:string}>(values:T[],field:string):T[] {
  if (new Set(values.map((v)=>v.id)).size!==values.length) planningInvalid(field,'Fato imutável repetido.');
  return values;
}
/** Confirmed excess without a right is deliberately unavailable to the plan. */
export function validatePlanFunding(plan: PreparedPlan, financial: FinancialSnapshot): void {
  const view=createFinancialView(financial);
  if (financial.groupId!==plan.groupId) planningInvalid('financial','Financiamento pertence a outro grupo.');
  const active=financial.quotas.filter((q)=>q.poolId===plan.poolId && view.isQuotaActive(q.id));
  const byId=new Map(active.map((q)=>[q.id,q]));
  if (active.length!==plan.rights.length) planningInvalid('rights','Plano deve conter todos os direitos integrais confirmados do bolão.');
  for (const right of plan.rights) {
    const quota=byId.get(right.quotaId);
    if (!quota || quota.sourceQuotaId!==right.sourceQuotaId || quota.sourceQuotaVersion!==right.sourceQuotaVersion || quota.personId!==right.personId || quota.units!==right.units || quota.dueCents!==right.dueCents || quota.statuteId!==right.statuteId) planningInvalid('rights','Direito não corresponde ao fato financeiro confirmado.');
  }
  if (BigInt(plan.budgetCents)>BigInt(view.finance.pools[plan.poolId]?.allocatedCents??'0')) planningInvalid('budgetCents','Dinheiro líquido destinado ao bolão é insuficiente.');
}
export function validatePlanningCommand(input: unknown): PlanningCommand {
  const source=planningRecord(input,'command'); planningShape(source,['apiVersion','idempotencyKey','groupId','expectedRevision','action'],'command');
  if (source.apiVersion!=='v1') planningInvalid('apiVersion','Versão da API não suportada.');
  const groupId=planningUid(source.groupId,'groupId');
  const expectedRevision=planningInt(source.expectedRevision,'expectedRevision');
  const action=planningRecord(source.action,'action');
  let validated:PlanningAction;
  if (action.type==='plan_apply') {
    planningShape(action,['type','plan'],'action');
    const plan=validatePreparedPlan(action.plan);
    assertConfirmedPlanSources(plan);
    if (plan.groupId!==groupId || plan.groupRevision!==expectedRevision) planningInvalid('plan','Plano deve corresponder ao grupo e revisão aprovados.');
    validated={type:'plan_apply',plan};
  } else if (action.type==='pool_lock') {
    planningShape(action,['type','poolId','poolVersion','appliedPlanId','responsible'],'action');
    const responsible=planningRecord(action.responsible,'responsible');planningShape(responsible,['registrarPersonId','ticketHolderPersonId'],'responsible');
    validated={type:'pool_lock',poolId:planningUid(action.poolId,'poolId'),poolVersion:planningInt(action.poolVersion,'poolVersion',1),appliedPlanId:planningUid(action.appliedPlanId,'appliedPlanId'),responsible:{registrarPersonId:planningUid(responsible.registrarPersonId,'registrarPersonId'),ticketHolderPersonId:responsible.ticketHolderPersonId===null?null:planningUid(responsible.ticketHolderPersonId,'ticketHolderPersonId')}};
  } else return planningInvalid('action','Ação de planejamento não suportada.');
  const command:PlanningCommand={apiVersion:'v1',idempotencyKey:planningUid(source.idempotencyKey,'idempotencyKey'),groupId,expectedRevision,action:validated};
  if (new TextEncoder().encode(JSON.stringify(command)).length>MAX_PLANNING_COMMAND_BYTES) planningInvalid('command','Comando de planejamento excede 1 MiB.');
  return command;
}
export function validateManifestContent(input: unknown): ManifestContent {
  const source=planningRecord(input,'manifest.content'); planningShape(source,['schemaVersion','catalog','responsible','pool','plan','persons','financial'],'manifest.content');
  if (source.schemaVersion!=='pool-manifest-v1') planningInvalid('schemaVersion','Formato de manifesto não suportado.');
  const plan=validatePreparedPlan(source.plan);
  assertConfirmedPlanSources(plan);
  if (canonicalJSON(source.catalog)!==canonicalJSON(PLANNING_CATALOG[plan.lotteryId])) planningInvalid('catalog','Regras e preços congelados não correspondem à versão oficial do plano.');
  const pool=planningRecord(source.pool,'pool');planningShape(pool,['id','version','data'],'pool');
  const data=validateEntityData('pool',pool.data);
  const poolId=planningUid(pool.id,'pool.id');
  const poolVersion=planningInt(pool.version,'pool.version',1);
  if (poolId!==plan.poolId || data.status!=='locked' || data.lotteryId!==plan.lotteryId || data.contestNumber!==plan.contestNumber || (data.contestCount??1)!==(plan.contestCount??1) || data.participationMode!==plan.participationMode || !data.deadlineAt) planningInvalid('pool','Manifesto deve congelar o bolão travado, modalidade, concurso, participação e prazo do plano.');
  if (poolVersion<=plan.poolVersion) planningInvalid('pool.version','Trava deve avançar a versão observada do bolão.');
  const financial=validateFinancialSnapshot(source.financial);
  validatePlanFunding(plan,financial);
  if (plan.rights.some((right)=>quotaCost(data.quotaPriceCents,right.units)!==right.dueCents)) planningInvalid('rights','Preço congelado do bolão diverge dos direitos confirmados.');
  const persons=uniqueIds(planningList(source.persons,'persons',200_202).map((inputPerson)=>{
    const person=planningRecord(inputPerson,'person');planningShape(person,['id','version','data'],'person');
    return {id:planningUid(person.id,'person.id'),version:planningInt(person.version,'person.version',1),data:validateEntityData('person',person.data)};
  }),'persons');
  const byPerson=new Map(persons.map((person)=>[person.id,person]));
  for (const right of plan.rights) if (!byPerson.get(right.personId)?.data.adultDeclared) planningInvalid('persons','Participante precisa existir com declaração de maioridade congelada.');
  for (const bet of plan.bets) for (const authorId of bet.authorIds) if (!byPerson.has(authorId)) planningInvalid('persons','Autoria do jogo não possui pessoa congelada.');
  const responsible=planningRecord(source.responsible,'responsible');planningShape(responsible,['organizerUserId','registrarPersonId','ticketHolderPersonId'],'responsible');
  const registrarPersonId=planningUid(responsible.registrarPersonId,'registrarPersonId');
  const ticketHolderPersonId=responsible.ticketHolderPersonId===null?null:planningUid(responsible.ticketHolderPersonId,'ticketHolderPersonId');
  if (!byPerson.get(registrarPersonId)?.data.adultDeclared || (plan.participationMode==='internal' && (!ticketHolderPersonId || !byPerson.get(ticketHolderPersonId)?.data.adultDeclared)) || (plan.participationMode==='official' && ticketHolderPersonId!==null)) planningInvalid('responsible','Registrador adulto e titular conforme o modo de participação são obrigatórios.');
  if (BigInt(plan.leftoverCents)>0n && plan.leftoverPolicy==='unassigned') planningInvalid('leftoverPolicy','Trava exige destino explícito para a sobra, ainda pendente de execução.');
  return {schemaVersion:'pool-manifest-v1',catalog:PLANNING_CATALOG[plan.lotteryId],responsible:{organizerUserId:planningUid(responsible.organizerUserId,'organizerUserId'),registrarPersonId,ticketHolderPersonId},pool:{id:poolId,version:poolVersion,data},plan,persons,financial};
}
export function canonicalManifest(content: ManifestContent): string { return canonicalJSON(validateManifestContent(content)); }
export async function hashManifest(content: ManifestContent): Promise<string> {
  const bytes=new TextEncoder().encode(canonicalManifest(content));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}
export async function verifyManifest(manifest: PoolManifest): Promise<boolean> {
  try { const normalized=validatePoolManifest(manifest); return await hashManifest(normalized.content)===normalized.sha256; } catch { return false; }
}
export function validatePoolManifest(input: unknown): PoolManifest {
  const source=planningRecord(input,'manifest');planningShape(source,['id','groupId','poolId','version','appliedPlanId','content','canonical','sha256','lockedAt','receiptId'],'manifest');
  const content=validateManifestContent(source.content);
  const groupId=planningUid(source.groupId,'groupId');
  const poolId=planningUid(source.poolId,'poolId');
  const canonical=planningText(source.canonical,'canonical',Number.MAX_SAFE_INTEGER,true);
  if (groupId!==content.plan.groupId || poolId!==content.plan.poolId || canonical!==canonicalJSON(content)) planningInvalid('canonical','Manifesto e texto canônico divergentes.');
  if (typeof source.sha256!=='string' || !/^[0-9a-f]{64}$/.test(source.sha256) || sha256Hex(canonical)!==source.sha256) planningInvalid('sha256','SHA-256 do manifesto não confere.');
  const lockedAt=time(source.lockedAt,'lockedAt');
  if (content.financial.statutes.some((s)=>s.publishedAt>lockedAt) || content.financial.acceptances.some((a)=>a.acceptedAt>lockedAt) || content.financial.movements.some((m)=>m.createdAt>lockedAt) || content.financial.quotas.some((q)=>q.confirmedAt>lockedAt) || content.financial.revocations.some((r)=>r.revokedAt>lockedAt)) planningInvalid('lockedAt','Manifesto contém fatos posteriores à trava.');
  return {id:planningUid(source.id,'id'),groupId,poolId,version:planningInt(source.version,'version',1),appliedPlanId:planningUid(source.appliedPlanId,'appliedPlanId'),content,canonical,sha256:source.sha256,lockedAt,receiptId:planningUid(source.receiptId,'receiptId')};
}
export function validatePlanningSnapshot(input: unknown): PlanningSnapshot {
  const source=planningRecord(input,'snapshot');planningShape(source,['groupId','groupRevision','appliedPlans','manifests'],'snapshot');
  const groupId=planningUid(source.groupId,'groupId'),groupRevision=planningInt(source.groupRevision,'groupRevision');
  const appliedPlans=uniqueIds(planningList(source.appliedPlans,'appliedPlans',10_000).map((inputApplied):AppliedPlan=>{
    const applied=planningRecord(inputApplied,'appliedPlan');planningShape(applied,['id','groupId','poolId','version','plan','appliedAt','receiptId'],'appliedPlan');
    const plan=validatePreparedPlan(applied.plan);
    assertConfirmedPlanSources(plan);
    const appliedGroup=planningUid(applied.groupId,'groupId'),poolId=planningUid(applied.poolId,'poolId');
    if (appliedGroup!==groupId || plan.groupId!==groupId || plan.poolId!==poolId || plan.groupRevision>=groupRevision) planningInvalid('appliedPlans','Plano aplicado pertence a outro grupo/bolão ou revisão futura.');
    return {id:planningUid(applied.id,'id'),groupId,poolId,version:planningInt(applied.version,'version',1),plan,appliedAt:time(applied.appliedAt,'appliedAt'),receiptId:planningUid(applied.receiptId,'receiptId')};
  }),'appliedPlans');
  const manifests=uniqueIds(planningList(source.manifests,'manifests',10_000).map(validatePoolManifest),'manifests');
  const appliedById=new Map(appliedPlans.map((plan)=>[plan.id,plan]));
  const plansByPool=new Map<string,AppliedPlan[]>(),manifestsByPool=new Map<string,PoolManifest[]>();
  for (const applied of appliedPlans) {
    const versions=plansByPool.get(applied.poolId)??[];versions.push(applied);plansByPool.set(applied.poolId,versions);
  }
  for (const versions of plansByPool.values()) {
    versions.sort((a,b)=>a.version-b.version);
    versions.forEach((version,i)=>{
      const previous=versions[i-1];
      if (version.version!==i+1 || (previous && (version.appliedAt<previous.appliedAt || version.plan.groupRevision<=previous.plan.groupRevision))) planningInvalid('appliedPlans','Versões dos planos devem ser contínuas e cronológicas por bolão.');
    });
  }
  for (const manifest of manifests) {
    const applied=appliedById.get(manifest.appliedPlanId);
    if (manifest.groupId!==groupId || !applied || applied.poolId!==manifest.poolId || canonicalJSON(applied.plan)!==canonicalJSON(manifest.content.plan) || applied.appliedAt>manifest.lockedAt || manifest.content.financial.groupRevision>=groupRevision) planningInvalid('manifests','Trava precisa referenciar o plano aplicado e financiamento histórico coerente deste grupo.');
    const versions=manifestsByPool.get(manifest.poolId)??[];versions.push(manifest);manifestsByPool.set(manifest.poolId,versions);
  }
  for (const versions of manifestsByPool.values()) {
    versions.sort((a,b)=>a.version-b.version);
    versions.forEach((manifest,i)=>{
      const previous=versions[i-1];
      if (manifest.version!==i+1 || (previous && (manifest.lockedAt<previous.lockedAt || manifest.content.pool.version<=previous.content.pool.version))) planningInvalid('manifests','Versões dos manifestos devem ser contínuas e cronológicas.');
      if (previous && (canonicalJSON(previous.content.financial)!==canonicalJSON(manifest.content.financial) || canonicalJSON(previous.content.persons)!==canonicalJSON(manifest.content.persons) || canonicalJSON(previous.content.responsible)!==canonicalJSON(manifest.content.responsible))) planningInvalid('manifests','Revisão de jogos deve preservar pessoas, responsáveis e fatos financeiros da primeira trava.');
    });
  }
  return {groupId,groupRevision,appliedPlans,manifests};
}
export function validatePlanningReceipt(input: unknown): PlanningReceipt {
  const source=planningRecord(input,'receipt');planningShape(source,['apiVersion','idempotencyKey','receiptId','groupId','status','groupRevision','message','confirmedAt','snapshot'],'receipt');
  if (source.apiVersion!=='v1') planningInvalid('apiVersion','Versão da API não suportada.');
  const groupId=planningUid(source.groupId,'groupId'),groupRevision=planningInt(source.groupRevision,'groupRevision');
  const status=planningOption(source.status,['accepted','conflict','rejected'],'status');
  const receiptId=source.receiptId===null?null:planningUid(source.receiptId,'receiptId');
  const snapshot=source.snapshot===null?null:validatePlanningSnapshot(source.snapshot);
  const confirmedAt=source.confirmedAt===null?null:time(source.confirmedAt,'confirmedAt');
  if (snapshot && (snapshot.groupId!==groupId || snapshot.groupRevision!==groupRevision)) planningInvalid('snapshot','Recibo e retrato de planejamento devem ter mesmo grupo e revisão.');
  if (status==='accepted' && (!snapshot || !confirmedAt || !receiptId)) planningInvalid('status','Confirmação aceita exige retrato, recibo e horário do servidor.');
  if (status!=='accepted' && (confirmedAt!==null || receiptId!==null)) planningInvalid('confirmedAt','Confirmação rejeitada não tem recibo nem horário de aceite.');
  if (snapshot && confirmedAt && (snapshot.appliedPlans.some((p)=>p.appliedAt>confirmedAt) || snapshot.manifests.some((m)=>m.lockedAt>confirmedAt))) planningInvalid('confirmedAt','Recibo contém fatos posteriores à confirmação.');
  if (status==='accepted' && snapshot && confirmedAt && receiptId) {
    const matching=snapshot.appliedPlans.filter((p)=>p.receiptId===receiptId && p.appliedAt===confirmedAt).length+snapshot.manifests.filter((m)=>m.receiptId===receiptId && m.lockedAt===confirmedAt).length;
    if (matching!==1) planningInvalid('receiptId','Confirmação deve identificar exatamente um fato novo pelo recibo do servidor.');
  }
  return {apiVersion:'v1',idempotencyKey:planningUid(source.idempotencyKey,'idempotencyKey'),receiptId,groupId,status,groupRevision,message:source.message===null?null:planningText(source.message,'message',2_000),confirmedAt,snapshot};
}
