-- Owner's decision of 17/10 (teimosinha, step 3 of PLAN-teimosinha.md): one prize per contest. A receipt naming contest C also
-- covers the results of C .. C + contestCount - 1; each contest of the pool has its own current result, calculated prize and chain
-- of prize confirmations (the prize belongs to the contest of the result it was confirmed on), and the pool's figures are the sums
-- over the latest confirmation of each contest, as packages/core/src/settlement.ts (projectPool, checkAction) and
-- packages/core/src/registered-prizes.ts now do. A pool of one contest behaves exactly as before.
--   private.settlement_calculated_prize   gains p_contest_count (default 1): a ticket counts when its observed contest C satisfies
--     C <= result contest < C + p_contest_count. Dropped and re-created (from 20261010000000_settlement.sql, never redefined since)
--     because a same-named function with an extra defaulted argument would make every two-argument call ambiguous;
--   private.settlement_pool_contests       new: the contests of a plan or pool record (contestNumber .. + contestCount - 1);
--   private.settlement_latest_prizes       new: the latest prize confirmation of each contest of the pool, by version;
--   private.settlement_latest_prize        new: the latest prize confirmation of one contest;
--   private.settlement_pool_balance        re-created from 20261016050000_settlement_group_prize.sql: gains contests (one entry per
--     contest of the frozen plan), sums calculated and confirmed prizes, rights and the kept prize over the contests, and reports a
--     conflict when any contest conflicts; prizeConfirmationId stays the latest confirmation overall;
--   private.settlement_action_guard_base   re-created from 20261010000000_settlement.sql (renamed in 20261013010000_settlement_close.sql):
--     prize_confirm reviews the contest of the result named (its current result, its latest confirmation, the plan's contestCount);
--     redemption_record accepts any contest's latest confirmation; a prize payment requires every contest's latest confirmation on
--     the current registration report; messages unchanged;
--   private.settlement_action_guard        re-created from 20261013010000_settlement_close.sql: a contest without a confirmed prize
--     joins the open items a closure must explain;
--   public.settlement_decide               re-created from 20261013010000_settlement_close.sql: the stored calculated prize is the one
--     of the contest of the result named, with the plan's contestCount;
--   private.participant_card_pix_base      re-created from 20261016060000_participant_responses.sql: each pool gains draws, one per
--     contest of the pool record ({contestNumber, drawAt, result}); for a teimosinha drawAt is the first contest still undrawn (else
--     the last) and result the last drawn contest's.
-- create or replace keeps the existing grants; every new or re-created-by-drop function gets the same revoke as the one it extends.
-- assessRegisteredPrizes(...).calculatedPrizeCents: legible actual games only; any skipped ticket or unknown tier keeps it null.
-- p_contest_count: a teimosinha receipt (its ticket names the first contest) also covers the next p_contest_count - 1 contests.
drop function private.settlement_calculated_prize(jsonb,jsonb);
create function private.settlement_calculated_prize(p_items jsonb,p_current jsonb,p_contest_count integer default 1) returns numeric
language plpgsql stable set search_path = '' as $$
declare v_result jsonb := p_current -> 'result'; v_item jsonb; v_bet jsonb; v_total numeric := 0; v_games integer := 0; v_skipped integer := 0;
  v_known boolean; v_draw integer; v_hits integer; v_size integer;
begin
  if p_items is null or p_current ->> 'status' = 'conflict' or jsonb_typeof(v_result) is distinct from 'object' then return null; end if;
  if jsonb_typeof(v_result -> 'drawnNumbers') is distinct from 'array' then return null; end if;
  v_known := case when jsonb_typeof(v_result -> 'payouts') = 'array'
    then not exists (select 1 from jsonb_array_elements(v_result -> 'payouts') p where jsonb_typeof(p.value -> 'prizeCents') is distinct from 'string') else false end;
  v_draw := case v_result ->> 'lotteryId' when 'mega-sena' then 6 when 'lotofacil' then 15 else 5 end;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item -> 'evidenceIds') is distinct from 'array' or jsonb_typeof(v_item -> 'observed') is distinct from 'object' then v_skipped := v_skipped+1; continue; end if;
    if jsonb_array_length(v_item -> 'evidenceIds') = 0 or jsonb_typeof(v_item -> 'observed' -> 'betNumbers') is distinct from 'array'
      or v_item -> 'observed' -> 'lotteryId' is distinct from v_result -> 'lotteryId'
      or (case when jsonb_typeof(v_item -> 'observed' -> 'contestNumber') = 'number' and jsonb_typeof(v_result -> 'contestNumber') = 'number'
        then not ((v_result ->> 'contestNumber')::numeric >= (v_item -> 'observed' ->> 'contestNumber')::numeric
          and (v_result ->> 'contestNumber')::numeric < (v_item -> 'observed' ->> 'contestNumber')::numeric + coalesce(p_contest_count,1)) else true end) then
      v_skipped := v_skipped+1; continue;
    end if;
    for v_bet in select value from jsonb_array_elements(v_item -> 'observed' -> 'betNumbers') loop
      v_games := v_games+1;
      if v_known then
        select count(*) into v_hits from jsonb_array_elements(v_bet) n where (v_result -> 'drawnNumbers') @> jsonb_build_array(n.value);
        v_size := jsonb_array_length(v_bet);
        select v_total + coalesce(sum(private.settlement_choose(v_hits,(p.value ->> 'hits')::integer)
          * private.settlement_choose(v_size - v_hits,v_draw - (p.value ->> 'hits')::integer) * (p.value ->> 'prizeCents')::numeric),0)
          into v_total from jsonb_array_elements(v_result -> 'payouts') p;
      end if;
    end loop;
  end loop;
  if v_games = 0 or v_skipped > 0 or not v_known then return null; end if;
  return v_total;
end;
$$;
-- poolContests: the contests a plan (or pool record) covers; none without a contest number.
create function private.settlement_pool_contests(p_plan jsonb) returns bigint[]
language sql immutable set search_path = '' as $$
  select case when private.json_integer(p_plan -> 'contestNumber',1,999999) then array(select (p_plan ->> 'contestNumber')::bigint + i
      from generate_series(0,case when private.json_integer(p_plan -> 'contestCount',1,12) then (p_plan ->> 'contestCount')::integer else 1 end - 1) i order by i)
    else '{}'::bigint[] end;
$$;
-- latestPrizes: the latest confirmation of each contest of the pool, by version; a prize belongs to the contest of its result.
create function private.settlement_latest_prizes(p_group uuid,p_pool uuid) returns setof public.settlement_prizes
language sql stable set search_path = '' as $$
  select distinct on (r.contest_number) p.* from public.settlement_prizes p
    left join public.contest_result_versions r on r.group_id = p.group_id and r.id = p.result_id
    where p.group_id = p_group and p.pool_id = p_pool order by r.contest_number,p.version desc;
$$;
-- latestPrize: the latest confirmation of one contest of the pool; null when that contest has none.
create function private.settlement_latest_prize(p_group uuid,p_pool uuid,p_contest bigint) returns public.settlement_prizes
language sql stable set search_path = '' as $$
  select p.* from public.settlement_prizes p join public.contest_result_versions r on r.group_id = p.group_id and r.id = p.result_id
    where p.group_id = p_group and p.pool_id = p_pool and r.contest_number = p_contest order by p.version desc limit 1;
$$;
revoke all on function private.settlement_calculated_prize(jsonb,jsonb,integer),private.settlement_pool_contests(jsonb),
  private.settlement_latest_prizes(uuid,uuid),private.settlement_latest_prize(uuid,uuid,bigint) from public,anon,authenticated;

-- projectPool: one pool's balance in the core's PoolSettlementBalance shape. Null when the core could not split the frozen rights.
-- One result, one calculated prize and one confirmed prize per contest of the frozen plan; the pool's figures are their sums.
create or replace function private.settlement_pool_balance(p_group uuid,p_pool uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_manifest public.pool_manifests; v_plan jsonb; v_mode text; v_report public.registration_reports; v_expense public.settlement_expenses;
  v_prize public.settlement_prizes; v_closure public.settlement_closures; v_current jsonb; v_calculated numeric; v_contributed numeric; v_expenses numeric;
  v_organizer numeric; v_individual numeric; v_paid numeric; v_refunded numeric; v_cash numeric; v_amount numeric; v_shares jsonb; v_persons jsonb; v_refund_pending numeric; v_surplus numeric; v_limit text; v_kept numeric := 0;
  v_contest bigint; v_contest_calculated numeric; v_contest_prize public.settlement_prizes; v_contests jsonb := '[]'::jsonb; v_conflict boolean := false;
begin
  select * into v_manifest from public.pool_manifests where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  if not found then return null; end if;
  v_plan := v_manifest.content -> 'plan'; v_mode := v_plan ->> 'participationMode';
  select * into v_report from public.registration_reports where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_expense from public.settlement_expenses where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_prize from public.settlement_prizes where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_closure from public.settlement_closures where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  foreach v_contest in array private.settlement_pool_contests(v_plan) loop
    v_current := private.settlement_current_result(p_group,p_pool,v_contest);
    v_contest_calculated := case when v_report.id is null then null
      else private.settlement_calculated_prize(v_report.items,v_current,coalesce((v_plan ->> 'contestCount')::integer,1)) end;
    v_contest_prize := private.settlement_latest_prize(p_group,p_pool,v_contest);
    v_conflict := v_conflict or v_current ->> 'status' = 'conflict';
    v_calculated := case when v_contest_calculated is null then v_calculated else coalesce(v_calculated,0) + v_contest_calculated end;
    v_contests := v_contests || jsonb_build_array(jsonb_build_object('contestNumber',v_contest,'resultId',v_current -> 'result' -> 'id',
      'resultConflict',v_current ->> 'status' = 'conflict','calculatedPrizeCents',v_contest_calculated::text,
      'prizeConfirmationId',v_contest_prize.id,'confirmedPrizeCents',v_contest_prize.amount_cents::text));
  end loop;
  v_contributed := private.pool_funding(p_group,p_pool);
  v_expenses := v_expense.total_cost_cents;
  select coalesce(sum(amount_cents) filter (where ownership = 'organizer'),0),coalesce(sum(amount_cents) filter (where ownership = 'individual'),0)
    into v_organizer,v_individual from public.settlement_redemptions where group_id = p_group and pool_id = p_pool;
  select coalesce(sum(amount_cents) filter (where kind = 'prize-payment'),0),coalesce(sum(amount_cents) filter (where kind = 'contribution-refund'),0)
    into v_paid,v_refunded from public.settlement_distributions where group_id = p_group and pool_id = p_pool;
  v_cash := v_contributed + v_organizer - coalesce(v_expenses,0) - v_paid - v_refunded;
  if v_expenses is not null then
    v_surplus := greatest((v_plan ->> 'budgetCents')::numeric - v_expenses,0);
    v_shares := private.settlement_split(case when v_plan ->> 'leftoverPolicy' = 'group-credit' then 0 else v_surplus end,coalesce((select jsonb_agg(jsonb_build_object('id',value ->> 'personId','units',value -> 'units')
      order by ordinality) from jsonb_array_elements(v_plan -> 'rights') with ordinality),'[]'::jsonb));
    if v_shares is null then return null; end if;
  end if;
  with rights as (select value ->> 'personId' as person_id,value ->> 'quotaId' as quota_id,(value ->> 'dueCents')::numeric as due,ordinality
      from jsonb_array_elements(v_plan -> 'rights') with ordinality),
    awarded as (select r.value ->> 'personId' as person_id,r.value ->> 'quotaId' as quota_id,(r.value ->> 'amountCents')::numeric as amount
      from private.settlement_latest_prizes(p_group,p_pool) lp cross join lateral jsonb_array_elements(coalesce(lp.rights,'[]'::jsonb)) r),
    shares as (select value ->> 'id' as person_id,(value ->> 'amountCents')::numeric as amount from jsonb_array_elements(coalesce(v_shares,'[]'::jsonb))),
    people as (select a.person_id::text as person_id from public.payment_allocations a where a.group_id = p_group and a.pool_id = p_pool
      union select person_id from rights union select person_id from awarded),
    calc as (select p.person_id,private.person_pool_funding(p_group,p.person_id::uuid,p_pool) as funding,
        (select r.quota_id from rights r where r.person_id = p.person_id order by r.ordinality desc limit 1) as own_quota,
        (select r.due from rights r where r.person_id = p.person_id order by r.ordinality desc limit 1) as own_due,
        (select case when count(distinct w.quota_id) = 1 then min(w.quota_id) end from awarded w where w.person_id = p.person_id) as prize_quota,
        case when v_prize.id is null then null else (select coalesce(sum(w.amount),0) from awarded w where w.person_id = p.person_id) end as prize_right,
        case when v_mode = 'official' then (select coalesce(sum(x.amount_cents),0) from public.settlement_redemptions x
            where x.group_id = p_group and x.pool_id = p_pool and x.person_id = p.person_id::uuid)
          else (select coalesce(sum(x.amount_cents),0) from public.settlement_distributions x
            where x.group_id = p_group and x.pool_id = p_pool and x.person_id = p.person_id::uuid and x.kind = 'prize-payment') end as received,
        (select coalesce(sum(x.amount_cents),0) from public.settlement_distributions x
          where x.group_id = p_group and x.pool_id = p_pool and x.person_id = p.person_id::uuid and x.kind = 'contribution-refund') as returned,
        (select s.amount from shares s where s.person_id = p.person_id) as share
      from people p),
    final as (select c.*,case when v_expenses is null then null else greatest(c.funding - coalesce(c.own_due,0),0) + coalesce(c.share,0) end as refund_right from calc c)
  select coalesce(jsonb_agg(jsonb_build_object('personId',f.person_id,'quotaId',coalesce(f.own_quota,f.prize_quota),'contributedCents',f.funding::text,
      'prizeRightCents',f.prize_right::text,'prizeReceivedCents',f.received::text,'prizePendingCents',(f.prize_right - f.received)::text,
      'refundRightCents',f.refund_right::text,'refundedCents',f.returned::text,'refundPendingCents',(f.refund_right - f.returned)::text) order by f.person_id collate "C"),'[]'::jsonb),
    sum(f.refund_right - f.returned)
    into v_persons,v_refund_pending from final f;
  v_limit := v_plan ->> 'groupPrizeLimitCents';
  select sum(lp.amount_cents),coalesce(sum(case when v_mode = 'internal' and v_limit is not null and lp.amount_cents > 0 and lp.amount_cents <= v_limit::numeric
      then lp.amount_cents else 0 end),0) into v_amount,v_kept from private.settlement_latest_prizes(p_group,p_pool) lp;
  return jsonb_build_object('poolId',p_pool,'participationMode',v_mode,'manifestId',v_manifest.id,'registrationReportId',v_report.id,
    'expenseConfirmationId',v_expense.id,'prizeConfirmationId',v_prize.id,'calculatedPrizeCents',v_calculated::text,'confirmedPrizeCents',v_amount::text,
    'contributedCents',v_contributed::text,'confirmedExpenseCents',v_expenses::text,
    'expenseConfirmationPending',v_expense.id is null or v_expense.registration_report_id is distinct from v_report.id,
    'redeemedCents',(v_organizer + v_individual)::text,'organizerRedeemedCents',v_organizer::text,'individualRedeemedCents',v_individual::text,
    'prizePaidCents',v_paid::text,'refundedCents',v_refunded::text,'organizerCashCents',v_cash::text,'cashDeficitCents',greatest(-v_cash,0)::text,
    'contributionSurplusCents',case when v_expenses is null then null else greatest(v_contributed - v_expenses,0)::text end,
    'groupReserveCents',(case when v_expenses is null then null when v_plan ->> 'leftoverPolicy' = 'group-credit' then v_surplus + v_kept else v_kept end)::text,
    'unredeemedPrizeCents',(v_amount - v_organizer - v_individual)::text,
    'unpaidPrizeCents',(case when v_kept > 0 then greatest(v_amount - v_paid - v_kept,0) else v_amount - case when v_mode = 'official' then v_individual else v_paid end end)::text,
    'refundPendingCents',case when v_expenses is null then null else coalesce(v_refund_pending,0)::text end,
    'resultConflict',v_conflict,'contests',v_contests,'registrationIncomplete',v_report.id is null or v_report.comparison ->> 'status' is distinct from 'complete',
    'closed',coalesce(v_closure.direction = 'closed',false),'persons',v_persons);
end;
$$;


-- checkAction. Timestamps compare at the contract's millisecond precision.
create or replace function private.settlement_action_guard_base(p_group uuid,p_action jsonb,p_now timestamptz) returns text
language plpgsql stable set search_path = '' as $$
declare v_type text := p_action ->> 'type'; v_pool uuid := (p_action ->> 'poolId')::uuid; v_pool_version numeric := (p_action ->> 'poolVersion')::numeric;
  v_manifest public.pool_manifests; v_plan jsonb; v_mode text; v_report public.registration_reports; v_expense public.settlement_expenses;
  v_prize public.settlement_prizes; v_balance jsonb; v_current jsonb; v_rights jsonb; v_amount numeric; v_person jsonb; v_item jsonb; v_error text;
  v_redemption public.settlement_redemptions; v_distribution public.settlement_distributions; v_contest bigint;
begin
  select * into v_manifest from public.pool_manifests where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if not found then return 'Apuração exige manifesto confirmado.'; end if;
  v_plan := v_manifest.content -> 'plan'; v_mode := v_plan ->> 'participationMode';
  v_balance := private.settlement_pool_balance(p_group,v_pool);
  if v_balance is null then return 'O rateio do manifesto exige uma única cota por pessoa.'; end if;
  select * into v_report from public.registration_reports where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if v_report.id is null or date_trunc('milliseconds',v_report.confirmed_at) > p_now or v_report.pool_version >= v_pool_version then
    return 'Apuração exige registro humano já confirmado e versão atual observada do bolão.';
  end if;
  select * into v_expense from public.settlement_expenses where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  select * into v_prize from public.settlement_prizes where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if exists (select 1 from (select pool_version,confirmed_at from public.settlement_expenses where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_prizes where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_redemptions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_distributions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_closures where group_id = p_group and pool_id = v_pool) f
    where f.pool_version >= v_pool_version or date_trunc('milliseconds',f.confirmed_at) > p_now) then
    return 'Versão observada precisa avançar decisões anteriores deste bolão.';
  end if;
  if (v_balance ->> 'closed')::boolean then return 'Bolão encerrado exige reabertura humana antes de nova alteração financeira.'; end if;
  if p_action ? 'eventAt' then
    if (p_action ->> 'eventAt')::timestamptz > p_now then return 'Evento não pode ser futuro à confirmação.'; end if;
  end if;
  v_error := private.settlement_proof_error(p_group,v_pool,p_action -> 'evidenceIds',p_now,v_type <> 'prize_confirm' or (p_action ->> 'amountCents')::numeric > 0);
  if v_error is not null then return v_error; end if;
  if v_type = 'expense_confirm' then
    if (p_action ->> 'registrationReportId')::uuid <> v_report.id or (p_action ->> 'supersedesId')::uuid is distinct from v_expense.id then
      return 'Despesa exige relatório atual e revisão explícita da última confirmação.';
    end if;
    if (v_expense.id is not null or p_action -> 'betCostCents' is distinct from v_report.comparison -> 'observedBetCostCents'
      or p_action -> 'feeCents' is distinct from v_report.comparison -> 'observedFeeCents') and private.js_trim(p_action ->> 'reason') = '' then
      return 'Correção ou custo diferente/desconhecido no comprovante exige razão humana.';
    end if;
  elsif v_type = 'prize_confirm' then
    -- The contest is the one of the result named: each contest of a teimosinha has its own chain of confirmations, so v_prize
    -- becomes the latest confirmation of that contest.
    select r.contest_number into v_contest from public.contest_result_versions r where r.group_id = p_group and r.pool_id = v_pool and r.id = (p_action ->> 'resultId')::uuid;
    if v_contest is null then return 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.'; end if;
    v_current := private.settlement_current_result(p_group,v_pool,v_contest);
    v_prize := private.settlement_latest_prize(p_group,v_pool,v_contest);
    if (p_action ->> 'registrationReportId')::uuid <> v_report.id or (p_action ->> 'supersedesId')::uuid is distinct from v_prize.id
      or v_current ->> 'status' = 'conflict' or jsonb_typeof(v_current -> 'result') is distinct from 'object' then
      return 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.';
    end if;
    if jsonb_typeof(v_current -> 'result' -> 'drawnNumbers') is distinct from 'array' or (v_current -> 'result' ->> 'id')::uuid <> (p_action ->> 'resultId')::uuid
      or (v_current -> 'result' ->> 'collectedAt')::timestamptz > p_now then
      return 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.';
    end if;
    v_amount := (p_action ->> 'amountCents')::numeric;
    if (v_prize.id is not null or private.settlement_calculated_prize(v_report.items,v_current,coalesce((v_plan ->> 'contestCount')::integer,1)) is distinct from v_amount) and private.js_trim(p_action ->> 'reason') = '' then
      return 'Correção ou prêmio diferente/indisponível no cálculo exige razão humana.';
    end if;
    v_rights := private.settlement_prize_rights(v_manifest.content,v_report.items,v_amount,p_action -> 'officialEntitlements');
    if v_rights ? 'error' then return v_rights ->> 'error'; end if;
    for v_item in select value from jsonb_array_elements(p_action -> 'officialEntitlements') loop
      v_error := private.settlement_proof_error(p_group,v_pool,v_item -> 'evidenceIds',p_now,(v_item ->> 'amountCents')::numeric > 0);
      if v_error is not null then return v_error; end if;
    end loop;
    if p_action -> 'redemptionDeadline' <> 'null'::jsonb and (p_action -> 'redemptionDeadline' ->> 'sourceUrl' is distinct from private.settlement_lottery_url(v_plan ->> 'lotteryId')
      or p_action -> 'redemptionDeadline' -> 'drawDate' is distinct from v_current -> 'result' -> 'drawDate') then
      return 'Prazo precisa referenciar modalidade e data do resultado aprovado.';
    end if;
  elsif v_type = 'redemption_record' then
    -- Any contest's latest confirmation can be redeemed; v_prize becomes the one named.
    select * into v_prize from private.settlement_latest_prizes(p_group,v_pool) lp where lp.id = (p_action ->> 'prizeConfirmationId')::uuid;
    if v_prize.id is null or (v_balance ->> 'resultConflict')::boolean then return 'Resgate exige prêmio atual confirmado e fontes conferidas sem conflito.'; end if;
    if (p_action ->> 'prizeConfirmationId')::uuid <> v_prize.id or v_prize.registration_report_id <> v_report.id then
      return 'Resgate exige prêmio atual confirmado e fontes conferidas sem conflito.';
    end if;
    if v_mode = 'internal' and ((p_action ->> 'personId')::uuid is distinct from (v_manifest.content -> 'responsible' ->> 'ticketHolderPersonId')::uuid) then
      return 'Resgate interno pertence ao titular congelado.';
    end if;
    if v_mode = 'official' and not exists (select 1 from jsonb_array_elements(v_prize.rights) r where (r.value ->> 'personId')::uuid = (p_action ->> 'personId')::uuid) then
      return 'Resgate individual exige direito oficial observado.';
    end if;
    if (p_action ->> 'eventAt')::timestamptz < v_prize.confirmed_at then return 'Confirme o prêmio antes do evento de resgate registrado.'; end if;
  elsif v_type = 'redemption_reverse' then
    select * into v_redemption from public.settlement_redemptions where group_id = p_group and pool_id = v_pool and id = (p_action ->> 'redemptionId')::uuid and direction = 'received';
    if v_redemption.id is null then return 'Compensação exige recebimento positivo anterior ainda não compensado.'; end if;
    if exists (select 1 from public.settlement_redemptions where group_id = p_group and reverses_id = v_redemption.id)
      or (p_action ->> 'eventAt')::timestamptz < v_redemption.event_at then return 'Compensação exige recebimento positivo anterior ainda não compensado.'; end if;
  elsif v_type = 'distribution_record' then
    v_amount := (p_action ->> 'amountCents')::numeric;
    if (v_balance ->> 'resultConflict')::boolean and p_action ->> 'kind' = 'prize-payment' then return 'Conflito de resultado exige revisão antes de distribuir prêmio.'; end if;
    select value into v_person from jsonb_array_elements(v_balance -> 'persons') where (value ->> 'personId')::uuid = (p_action ->> 'personId')::uuid;
    if v_person is null then return 'Pagamento exige pessoa com direito ou contribuição identificada.'; end if;
    if p_action ->> 'kind' = 'prize-payment' then
      if v_mode = 'official' or v_prize.id is null or v_person -> 'prizePendingCents' = 'null'::jsonb then return 'Pagamento não pode exceder direito e resgate interno disponíveis.'; end if;
      if exists (select 1 from private.settlement_latest_prizes(p_group,v_pool) lp where lp.registration_report_id <> v_report.id)
        or v_amount > (v_person ->> 'prizePendingCents')::numeric
        or v_amount > (v_balance ->> 'organizerRedeemedCents')::numeric - (v_balance ->> 'prizePaidCents')::numeric then
        return 'Pagamento não pode exceder direito e resgate interno disponíveis.';
      end if;
    else
      if (v_balance ->> 'expenseConfirmationPending')::boolean or v_person -> 'refundPendingCents' = 'null'::jsonb or v_balance -> 'contributionSurplusCents' = 'null'::jsonb then
        return 'Devolução exige despesa atual confirmada e sobra própria disponível.';
      end if;
      if v_amount > (v_person ->> 'refundPendingCents')::numeric or v_amount > (v_balance ->> 'contributionSurplusCents')::numeric - (v_balance ->> 'refundedCents')::numeric then
        return 'Devolução exige despesa atual confirmada e sobra própria disponível.';
      end if;
    end if;
    if v_amount > (v_balance ->> 'organizerCashCents')::numeric or v_amount > private.settlement_group_cash(p_group) then
      return 'Pagamento não pode consumir caixa inexistente ou dinheiro de outro bolão.';
    end if;
  elsif v_type = 'distribution_reverse' then
    select * into v_distribution from public.settlement_distributions where group_id = p_group and pool_id = v_pool and id = (p_action ->> 'distributionId')::uuid and direction = 'paid';
    if v_distribution.id is null then return 'Retorno exige pagamento positivo anterior ainda não compensado.'; end if;
    if exists (select 1 from public.settlement_distributions where group_id = p_group and reverses_id = v_distribution.id)
      or (p_action ->> 'eventAt')::timestamptz < v_distribution.event_at then return 'Retorno exige pagamento positivo anterior ainda não compensado.'; end if;
  else return 'Ação de apuração ou encerramento não suportada.'; end if;
  return null;
end;
$$;

-- checkAction for pool_settle/pool_reopen: same preamble as the other actions, then the closure rules; messages are the core's.
create or replace function private.settlement_action_guard(p_group uuid,p_action jsonb,p_now timestamptz) returns text
language plpgsql stable set search_path = '' as $$
declare v_type text := p_action ->> 'type'; v_pool uuid := (p_action ->> 'poolId')::uuid; v_pool_version numeric := (p_action ->> 'poolVersion')::numeric;
  v_report public.registration_reports; v_expense public.settlement_expenses; v_prize public.settlement_prizes; v_closure public.settlement_closures; v_balance jsonb;
begin
  if v_type not in ('pool_settle','pool_reopen') then return private.settlement_action_guard_base(p_group,p_action,p_now); end if;
  if not exists (select 1 from public.pool_manifests where group_id = p_group and pool_id = v_pool) then return 'Apuração exige manifesto confirmado.'; end if;
  v_balance := private.settlement_pool_balance(p_group,v_pool);
  if v_balance is null then return 'O rateio do manifesto exige uma única cota por pessoa.'; end if;
  select * into v_report from public.registration_reports where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if v_report.id is null or date_trunc('milliseconds',v_report.confirmed_at) > p_now or v_report.pool_version >= v_pool_version then
    return 'Apuração exige registro humano já confirmado e versão atual observada do bolão.';
  end if;
  if exists (select 1 from (select pool_version,confirmed_at from public.settlement_expenses where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_prizes where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_redemptions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_distributions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_closures where group_id = p_group and pool_id = v_pool) f
    where f.pool_version >= v_pool_version or date_trunc('milliseconds',f.confirmed_at) > p_now) then
    return 'Versão observada precisa avançar decisões anteriores deste bolão.';
  end if;
  select * into v_closure from public.settlement_closures where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if v_type = 'pool_reopen' then
    if not (v_balance ->> 'closed')::boolean or v_closure.id is distinct from (p_action ->> 'closureId')::uuid then
      return 'Reabertura exige o encerramento ativo observado.';
    end if;
    return null;
  end if;
  if (v_balance ->> 'closed')::boolean then return 'Bolão encerrado exige reabertura humana antes de nova alteração financeira.'; end if;
  select * into v_expense from public.settlement_expenses where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  select * into v_prize from public.settlement_prizes where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if (p_action ->> 'registrationReportId')::uuid <> v_report.id or (p_action ->> 'prizeConfirmationId')::uuid is distinct from v_prize.id
    or (p_action ->> 'expenseConfirmationId')::uuid is distinct from v_expense.id then
    return 'Encerramento exige as versões atuais de registro, despesas e prêmio.';
  end if;
  -- pending(pool): any open item keeps the closure explained, including a contest without a confirmed prize.
  if ((v_balance ->> 'expenseConfirmationPending')::boolean or v_balance -> 'confirmedPrizeCents' = 'null'::jsonb
      or exists (select 1 from jsonb_array_elements(v_balance -> 'contests') c where c.value -> 'prizeConfirmationId' = 'null'::jsonb)
      or coalesce((v_balance ->> 'resultConflict')::boolean,false) or (v_balance ->> 'registrationIncomplete')::boolean
      or exists (select 1 from unnest(array['cashDeficitCents','unredeemedPrizeCents','unpaidPrizeCents','refundPendingCents']) k
        where v_balance ->> k is not null and (v_balance ->> k)::numeric <> 0))
    and private.js_trim(p_action ->> 'pendingExplanation') = '' then
    return 'Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.';
  end if;
  return null;
end;
$$;

-- The decision as before, without the release block and with the closure fact (buildFact: reconciliation is the balance just before it).
create or replace function public.settlement_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid(); v_fact_id uuid := gen_random_uuid();
  v_saved public.settlement_command_receipts; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_redemption public.settlement_redemptions; v_distribution public.settlement_distributions; v_action jsonb; v_type text; v_rights jsonb; v_current jsonb;
  v_error text; v_status text := 'accepted'; v_revision bigint; v_version bigint; v_now timestamptz; v_result jsonb; v_count bigint;
  v_closure public.settlement_closures; v_reconciliation jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_settlement_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action'; v_type := v_action ->> 'type';
  perform pg_advisory_xact_lock(hashtextextended('settlement:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.settlement_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de decidir a apuração.';
  elsif v_revision >= 9007199254740991 then v_error := 'Limite de revisão atingido.';
  else v_error := private.settlement_action_error(v_action); end if;
  v_now := date_trunc('milliseconds',clock_timestamp());
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a decisão.';
    elsif v_pool.version >= 9007199254740991 then v_error := 'Limite de versões do bolão atingido.';
    else
      v_count := case when v_type = 'expense_confirm' then (select count(*) from public.settlement_expenses where group_id = v_group)
        when v_type = 'prize_confirm' then (select count(*) from public.settlement_prizes where group_id = v_group)
        when v_type like 'redemption_%' then (select count(*) from public.settlement_redemptions where group_id = v_group)
        when v_type like 'pool_%' then (select count(*) from public.settlement_closures where group_id = v_group)
        else (select count(*) from public.settlement_distributions where group_id = v_group) end;
      if v_count >= 10000 then v_error := 'Limite de fatos de apuração atingido.';
      else v_error := private.settlement_action_guard(v_group,v_action,v_now); end if;
    end if;
  end if;
  if v_error is null then
    -- The fact and the entity version change roll back together when the resulting balance would not reconcile.
    begin
      select * into v_manifest from public.pool_manifests where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      select * into v_report from public.registration_reports where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      if v_type = 'expense_confirm' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_expenses where group_id = v_group and pool_id = v_pool_id;
        insert into public.settlement_expenses(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,manifest_id,registration_report_id,supersedes_id,
          bet_cost_cents,fee_cents,total_cost_cents,evidence_ids,source_reference,reason)
          values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_manifest.id,(v_action ->> 'registrationReportId')::uuid,
            (v_action ->> 'supersedesId')::uuid,(v_action ->> 'betCostCents')::bigint,(v_action ->> 'feeCents')::bigint,
            (v_action ->> 'betCostCents')::bigint + (v_action ->> 'feeCents')::bigint,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',v_action ->> 'reason');
      elsif v_type = 'prize_confirm' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_prizes where group_id = v_group and pool_id = v_pool_id;
        -- The calculated prize of the contest of the result named (the guard checked it is this pool's), with the plan's contestCount.
        v_current := private.settlement_current_result(v_group,v_pool_id,(select r.contest_number from public.contest_result_versions r
          where r.group_id = v_group and r.pool_id = v_pool_id and r.id = (v_action ->> 'resultId')::uuid));
        v_rights := private.settlement_prize_rights(v_manifest.content,v_report.items,(v_action ->> 'amountCents')::numeric,v_action -> 'officialEntitlements');
        insert into public.settlement_prizes(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,manifest_id,registration_report_id,result_id,
          observed_result_ids,result_selection_id,supersedes_id,calculated_prize_cents,amount_cents,official_entitlements,rights,evidence_ids,source_reference,reason,redemption_deadline)
          values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_manifest.id,(v_action ->> 'registrationReportId')::uuid,(v_action ->> 'resultId')::uuid,
            (select coalesce(jsonb_agg(to_jsonb(r.id::text) order by r.version),'[]'::jsonb) from public.contest_result_versions r where r.group_id = v_group and r.pool_id = v_pool_id),
            (select s.id from public.result_selections s where s.group_id = v_group and s.pool_id = v_pool_id order by s.version desc limit 1),
            (v_action ->> 'supersedesId')::uuid,private.settlement_calculated_prize(v_report.items,v_current,coalesce((v_manifest.content -> 'plan' ->> 'contestCount')::integer,1)),(v_action ->> 'amountCents')::bigint,
            private.settlement_entitlements(v_action -> 'officialEntitlements'),v_rights -> 'rights',private.settlement_ids(v_action -> 'evidenceIds'),
            v_action ->> 'sourceReference',v_action ->> 'reason',nullif(v_action -> 'redemptionDeadline','null'::jsonb));
      elsif v_type like 'redemption_%' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_redemptions where group_id = v_group and pool_id = v_pool_id;
        if v_type = 'redemption_record' then
          insert into public.settlement_redemptions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,prize_confirmation_id,person_id,ownership,
            direction,reverses_id,amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,(v_action ->> 'prizeConfirmationId')::uuid,(v_action ->> 'personId')::uuid,
              case when v_manifest.content -> 'plan' ->> 'participationMode' = 'internal' then 'organizer' else 'individual' end,'received',null,(v_action ->> 'amountCents')::bigint,
              private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        else
          select * into v_redemption from public.settlement_redemptions where group_id = v_group and id = (v_action ->> 'redemptionId')::uuid;
          insert into public.settlement_redemptions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,prize_confirmation_id,person_id,ownership,
            direction,reverses_id,amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_redemption.prize_confirmation_id,v_redemption.person_id,v_redemption.ownership,
              'reversed',v_redemption.id,-v_redemption.amount_cents,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',
              (v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        end if;
      elsif v_type like 'pool_%' then
        select * into v_closure from public.settlement_closures where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
        v_reconciliation := private.settlement_pool_balance(v_group,v_pool_id);
        insert into public.settlement_closures(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,direction,previous_closure_id,
          registration_report_id,prize_confirmation_id,expense_confirmation_id,observed_result_ids,result_selection_id,leftover_disposition,reconciliation,
          pending_explanation,reason)
          values(v_fact_id,v_group,v_pool_id,coalesce(v_closure.version,0)+1,v_revision+1,v_pool.version,v_now,v_receipt,
            case when v_type = 'pool_settle' then 'closed' else 'reopened' end,v_closure.id,v_report.id,
            (select id from public.settlement_prizes where group_id = v_group and pool_id = v_pool_id order by version desc limit 1),
            (select id from public.settlement_expenses where group_id = v_group and pool_id = v_pool_id order by version desc limit 1),
            (select coalesce(jsonb_agg(to_jsonb(r.id::text) order by r.version),'[]'::jsonb) from public.contest_result_versions r where r.group_id = v_group and r.pool_id = v_pool_id),
            (select s.id from public.result_selections s where s.group_id = v_group and s.pool_id = v_pool_id order by s.version desc limit 1),
            case when v_type = 'pool_settle' then v_action ->> 'leftoverDisposition' else v_closure.leftover_disposition end,
            v_reconciliation,
            case when v_type = 'pool_settle' then v_action ->> 'pendingExplanation' else v_closure.pending_explanation end,v_action ->> 'reason');
        v_version := coalesce(v_closure.version,0)+1;
      else
        select coalesce(max(version),0)+1 into v_version from public.settlement_distributions where group_id = v_group and pool_id = v_pool_id;
        if v_type = 'distribution_record' then
          insert into public.settlement_distributions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,person_id,kind,direction,reverses_id,
            amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,(v_action ->> 'personId')::uuid,v_action ->> 'kind','paid',null,
              (v_action ->> 'amountCents')::bigint,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        else
          select * into v_distribution from public.settlement_distributions where group_id = v_group and id = (v_action ->> 'distributionId')::uuid;
          insert into public.settlement_distributions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,person_id,kind,direction,reverses_id,
            amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_distribution.person_id,v_distribution.kind,'returned',v_distribution.id,
              -v_distribution.amount_cents,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        end if;
      end if;
      -- Each settlement fact observes and advances the pool version, as registration does.
      update public.draft_records set version = version+1,updated_at = v_now where group_id = v_group and id = v_pool_id;
      v_error := private.settlement_balance_error(v_group,v_pool_id);
      if v_error is not null then raise exception 'settlement_balance_rejected'; end if;
    exception when raise_exception then
      if v_error is null then raise; end if;
    end;
  end if;
  if v_error is null then
    v_version := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,v_type,jsonb_build_object('receiptId',v_receipt,'factId',v_fact_id,'version',v_version));
    if v_version <> v_revision+1 then raise exception 'settlement_revision_mismatch' using errcode = '40001'; end if;
    v_revision := v_version;
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
    'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
    'snapshot',private.settlement_snapshot(v_group));
  insert into public.settlement_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,v_result,v_now);
  return v_result;
end;
$$;

-- The card: each pool gains draws, one per contest of the pool record, each with its draw instant or date and its result as the pool's
-- result (that contest's confirmed prize, or its current result unless sources conflict). For a teimosinha the pool's drawAt is the first
-- contest not drawn yet (else the last) and its result is the last drawn contest's. Re-created from 20261016060000.
create or replace function private.participant_card_pix_base(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_link public.participant_links; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_quota public.confirmed_quotas; v_prize public.settlement_prizes; v_balance jsonb; v_own jsonb; v_current jsonb; v_result jsonb; v_drawn jsonb; v_draw_at text;
  v_units bigint; v_due numeric; v_funding numeric; v_games jsonb; v_holder text; v_mode text; v_pools jsonb := '[]'::jsonb;
  v_contest bigint; v_draw jsonb; v_draws jsonb; v_open jsonb; v_last jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','link_unknown'); end if;
  select * into v_link from public.participant_links where token_hash = p_token_hash;
  if not found then return jsonb_build_object('error','link_unknown'); end if;
  if v_link.revoked_at is not null then return jsonb_build_object('error','link_revoked'); end if;
  for v_pool in select p.* from public.draft_records p where p.group_id = v_link.group_id and p.kind = 'pool'
      and (exists (select 1 from public.draft_records q where q.group_id = p.group_id and q.kind = 'quota'
        and (q.data ->> 'poolId')::uuid = p.id and (q.data ->> 'personId')::uuid = v_link.person_id) or private.participant_pool_open(p))
      order by p.created_at desc,p.id desc loop
    v_mode := v_pool.data ->> 'participationMode';
    select * into v_quota from public.confirmed_quotas q where q.group_id = v_link.group_id and q.pool_id = v_pool.id and q.person_id = v_link.person_id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id) order by q.confirmed_at desc limit 1;
    v_units := coalesce(v_quota.units,(select sum((q.data ->> 'units')::bigint) from public.draft_records q where q.group_id = v_link.group_id
      and q.kind = 'quota' and (q.data ->> 'poolId')::uuid = v_pool.id and (q.data ->> 'personId')::uuid = v_link.person_id));
    -- Before confirmation the due amount is quotaCost(quotaPriceCents, units), the same division the confirmation uses.
    v_due := coalesce(v_quota.due_cents,((v_pool.data ->> 'quotaPriceCents')::numeric * v_units / 100)::bigint);
    v_funding := private.person_pool_funding(v_link.group_id,v_link.person_id,v_pool.id);
    select * into v_manifest from public.pool_manifests where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
    select * into v_report from public.registration_reports where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
    -- Games without owners: per ticket, the receipt's legible numbers once registered, else the planned bets; the draft bets before the lock.
    if v_manifest.id is not null and v_report.id is not null then
      with plan as (select v_manifest.content -> 'plan' as p),
        legible as (select i.value ->> 'plannedTicketKey' as key,i.value -> 'observed' -> 'betNumbers' as numbers
          from jsonb_array_elements(v_report.items) i,plan
          where jsonb_typeof(i.value -> 'evidenceIds') = 'array' and i.value -> 'evidenceIds' <> '[]'::jsonb
            and jsonb_typeof(i.value -> 'observed' -> 'betNumbers') = 'array'
            and i.value -> 'observed' -> 'lotteryId' = plan.p -> 'lotteryId' and i.value -> 'observed' -> 'contestNumber' = plan.p -> 'contestNumber'),
        tks as (select t.value,t.ordinality from plan,jsonb_array_elements(plan.p -> 'tickets') with ordinality t(value,ordinality))
      select coalesce(jsonb_agg(g.game order by g.t,g.b),'[]'::jsonb) into v_games from (
        select tks.ordinality as t,o.ordinality as b,jsonb_build_object('numbers',o.value,'registered',true) as game
          from tks join legible l on l.key = tks.value ->> 'key'
          cross join lateral jsonb_array_elements(l.numbers) with ordinality o(value,ordinality)
        union all
        select tks.ordinality,b.ordinality,jsonb_build_object('numbers',b.value -> 'numbers','registered',false)
          from tks cross join plan cross join lateral jsonb_array_elements(plan.p -> 'bets') with ordinality b(value,ordinality)
          where (tks.value -> 'betKeys') ? (b.value ->> 'key') and not exists (select 1 from legible l where l.key = tks.value ->> 'key')) g;
    elsif v_manifest.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.value -> 'numbers','registered',false) order by b.ordinality),'[]'::jsonb) into v_games
        from jsonb_array_elements(v_manifest.content -> 'plan' -> 'bets') with ordinality b(value,ordinality);
    else
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.data -> 'numbers','registered',false) order by b.created_at,b.id),'[]'::jsonb) into v_games
        from public.draft_records b where b.group_id = v_link.group_id and b.kind = 'bet' and (b.data ->> 'poolId')::uuid = v_pool.id;
    end if;
    v_holder := (select h.data ->> 'name' from public.draft_records h where h.group_id = v_link.group_id and h.kind = 'person'
      and h.id::text = v_manifest.content -> 'responsible' ->> 'ticketHolderPersonId');
    v_balance := case when v_manifest.id is null then null else private.settlement_pool_balance(v_link.group_id,v_pool.id) end;
    select value into v_own from jsonb_array_elements(coalesce(v_balance -> 'persons','[]'::jsonb)) where value ->> 'personId' = v_link.person_id::text;
    -- Per contest, drawn numbers: the result its latest prize was confirmed on; before that, the core's current result unless sources conflict.
    v_draws := '[]'::jsonb; v_open := null; v_last := null;
    foreach v_contest in array private.settlement_pool_contests(v_pool.data) loop
      v_prize := private.settlement_latest_prize(v_link.group_id,v_pool.id,v_contest);
      if v_prize.id is not null then
        select r.data into v_result from public.contest_result_versions r where r.group_id = v_link.group_id and r.id = v_prize.result_id;
      else
        v_current := private.settlement_current_result(v_link.group_id,v_pool.id,v_contest);
        v_result := case when v_current ->> 'status' = 'conflict' then null else v_current -> 'result' end;
      end if;
      v_drawn := case when jsonb_typeof(v_result -> 'drawnNumbers') = 'array' and jsonb_array_length(v_result -> 'drawnNumbers') > 0 then v_result -> 'drawnNumbers' end;
      select coalesce(private.utc_json(c.expected_draw_at),to_char(c.draw_date,'YYYY-MM-DD')) into v_draw_at from public.contest_calendar_versions c
        where c.group_id = v_link.group_id and c.pool_id = v_pool.id and c.contest_number = v_contest order by c.version desc limit 1;
      v_draw := jsonb_build_object('contestNumber',v_contest,'drawAt',coalesce(v_draw_at,v_result ->> 'drawDate'),
        'result',case when v_drawn is null then null else jsonb_build_object('drawnNumbers',v_drawn,
          'prizeCalculatedCents',(select c.value ->> 'calculatedPrizeCents' from jsonb_array_elements(coalesce(v_balance -> 'contests','[]'::jsonb)) c
            where (c.value ->> 'contestNumber')::numeric = v_contest),'prizeConfirmedCents',v_prize.amount_cents::text,
          'redemptionDeadlineDate',v_prize.redemption_deadline ->> 'deadlineDate',
          'prizeRedeemed',coalesce(v_prize.amount_cents > 0 and (v_balance ->> 'unredeemedPrizeCents')::numeric <= 0,false)) end);
      v_draws := v_draws || jsonb_build_array(v_draw);
      if v_drawn is not null then v_last := v_draw; elsif v_open is null then v_open := v_draw; end if;
    end loop;
    v_pools := v_pools || jsonb_build_array(jsonb_build_object('id',v_pool.id,'title',v_pool.data ->> 'title','modality',v_pool.data ->> 'lotteryId',
      'contest',coalesce(v_pool.data -> 'contestNumber','null'::jsonb),'drawAt',coalesce(v_open,v_draws -> -1) ->> 'drawAt',
      'status',v_pool.data ->> 'status','participationMode',v_mode,
      'quota',case when v_units is null then null else jsonb_build_object('units',v_units,'dueCents',v_due::text,'paidCents',v_funding::text,'paid',v_funding >= v_due) end,
      'responseOpen',private.participant_pool_open(v_pool),
      'response',(select jsonb_build_object('kind',r.kind,'amountCents',r.amount_cents::text,'proofSent',r.proof_id is not null,'at',private.utc_json(r.created_at))
        from public.participant_responses r where r.group_id = v_link.group_id and r.pool_id = v_pool.id and r.person_id = v_link.person_id
        order by r.seq desc limit 1),
      'games',v_games,
      'registration',case when v_manifest.id is null then null else jsonb_build_object(
        'status',case v_report.comparison ->> 'status' when 'complete' then 'registered' when 'partial' then 'partial' when 'divergent' then 'divergent' else 'planned' end,
        'ticketHolderName',v_holder) end,
      'result',v_last -> 'result','draws',v_draws,
      'share',case when v_own is null then null else jsonb_build_object('rightCents',v_own ->> 'prizeRightCents','receivedCents',v_own ->> 'prizeReceivedCents',
        'pendingCents',v_own ->> 'prizePendingCents','paidByName',case when v_mode = 'internal' then v_holder end,
        'refundRightCents',v_own ->> 'refundRightCents','refundedCents',v_own ->> 'refundedCents') end,
      'groupReserveCents',v_balance ->> 'groupReserveCents',
      'groupPrizeLimitCents',v_manifest.content -> 'plan' ->> 'groupPrizeLimitCents',
      'closed',coalesce((v_balance ->> 'closed')::boolean,false)));
  end loop;
  return jsonb_build_object('version',1,'generatedAt',private.utc_json(clock_timestamp()),
    'group',jsonb_build_object('name',(select g.name from public.groups g where g.id = v_link.group_id)),
    'person',jsonb_build_object('id',v_link.person_id,'name',(select p.data ->> 'name' from public.draft_records p where p.group_id = v_link.group_id and p.id = v_link.person_id)),
    'pools',v_pools);
end;
$$;
