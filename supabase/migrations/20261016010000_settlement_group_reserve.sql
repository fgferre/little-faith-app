-- When a pool's frozen plan has leftoverPolicy 'group-credit', the leftover (budget minus confirmed expenses) is not split as
-- refund rights: each person's refund right keeps only the overpayment, and the pool's groupReserveCents carries the leftover
-- ('0' for the other policies, null while expenses are unconfirmed), as in the core's projectPool.
-- private.settlement_pool_balance is re-created from 20261010000000_settlement.sql with only that rule and the new key.
-- private.participant_card_pix_base is re-created from 20261016000000_participant_card_registered_games.sql with only groupReserveCents added to each pool.
-- The rule also reaches facts already recorded: a contribution refund paid on a group-credit pool under the old split would
-- now exceed the person's refund right, the core would reject the group's whole settlement history and every new fact on that
-- pool would be refused. Old closures are rebuilt under the old rule, refunds are not, so this migration stops instead of
-- applying when such a refund exists; it needs a decision before publishing.
do $$
begin
  if exists (select 1 from public.settlement_distributions d
      where d.kind = 'contribution-refund'
        and (select m.content -> 'plan' ->> 'leftoverPolicy' from public.pool_manifests m
          where m.group_id = d.group_id and m.pool_id = d.pool_id order by m.version desc limit 1) = 'group-credit') then
    raise exception 'Há devolução registrada em bolão cuja sobra fica no caixa do grupo; decida o que fazer com ela antes desta migração.';
  end if;
end;
$$;

-- projectPool: one pool's balance in the core's PoolSettlementBalance shape. Null when the core could not split the frozen rights.
create or replace function private.settlement_pool_balance(p_group uuid,p_pool uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_manifest public.pool_manifests; v_plan jsonb; v_mode text; v_report public.registration_reports; v_expense public.settlement_expenses;
  v_prize public.settlement_prizes; v_closure public.settlement_closures; v_current jsonb; v_calculated numeric; v_contributed numeric; v_expenses numeric;
  v_organizer numeric; v_individual numeric; v_paid numeric; v_refunded numeric; v_cash numeric; v_amount numeric; v_shares jsonb; v_persons jsonb; v_refund_pending numeric; v_surplus numeric;
begin
  select * into v_manifest from public.pool_manifests where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  if not found then return null; end if;
  v_plan := v_manifest.content -> 'plan'; v_mode := v_plan ->> 'participationMode';
  select * into v_report from public.registration_reports where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_expense from public.settlement_expenses where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_prize from public.settlement_prizes where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  select * into v_closure from public.settlement_closures where group_id = p_group and pool_id = p_pool order by version desc limit 1;
  v_current := private.settlement_current_result(p_group,p_pool);
  v_calculated := case when v_report.id is null then null else private.settlement_calculated_prize(v_report.items,v_current) end;
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
    awarded as (select value ->> 'personId' as person_id,value ->> 'quotaId' as quota_id,(value ->> 'amountCents')::numeric as amount
      from jsonb_array_elements(coalesce(v_prize.rights,'[]'::jsonb))),
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
  v_amount := v_prize.amount_cents;
  return jsonb_build_object('poolId',p_pool,'participationMode',v_mode,'manifestId',v_manifest.id,'registrationReportId',v_report.id,
    'expenseConfirmationId',v_expense.id,'prizeConfirmationId',v_prize.id,'calculatedPrizeCents',v_calculated::text,'confirmedPrizeCents',v_amount::text,
    'contributedCents',v_contributed::text,'confirmedExpenseCents',v_expenses::text,
    'expenseConfirmationPending',v_expense.id is null or v_expense.registration_report_id is distinct from v_report.id,
    'redeemedCents',(v_organizer + v_individual)::text,'organizerRedeemedCents',v_organizer::text,'individualRedeemedCents',v_individual::text,
    'prizePaidCents',v_paid::text,'refundedCents',v_refunded::text,'organizerCashCents',v_cash::text,'cashDeficitCents',greatest(-v_cash,0)::text,
    'contributionSurplusCents',case when v_expenses is null then null else greatest(v_contributed - v_expenses,0)::text end,
    'groupReserveCents',(case when v_expenses is null then null when v_plan ->> 'leftoverPolicy' = 'group-credit' then v_surplus else 0 end)::text,
    'unredeemedPrizeCents',(v_amount - v_organizer - v_individual)::text,
    'unpaidPrizeCents',(v_amount - case when v_mode = 'official' then v_individual else v_paid end)::text,
    'refundPendingCents',case when v_expenses is null then null else coalesce(v_refund_pending,0)::text end,
    'resultConflict',v_current ->> 'status' = 'conflict','registrationIncomplete',v_report.id is null or v_report.comparison ->> 'status' is distinct from 'complete',
    'closed',coalesce(v_closure.direction = 'closed',false),'persons',v_persons);
end;
$$;

create or replace function private.participant_card_pix_base(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_link public.participant_links; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_quota public.confirmed_quotas; v_prize public.settlement_prizes; v_balance jsonb; v_own jsonb; v_current jsonb; v_result jsonb; v_drawn jsonb; v_draw_at text;
  v_units bigint; v_due numeric; v_funding numeric; v_games jsonb; v_holder text; v_mode text; v_pools jsonb := '[]'::jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','link_unknown'); end if;
  select * into v_link from public.participant_links where token_hash = p_token_hash;
  if not found then return jsonb_build_object('error','link_unknown'); end if;
  if v_link.revoked_at is not null then return jsonb_build_object('error','link_revoked'); end if;
  for v_pool in select p.* from public.draft_records p where p.group_id = v_link.group_id and p.kind = 'pool'
      and exists (select 1 from public.draft_records q where q.group_id = p.group_id and q.kind = 'quota'
        and (q.data ->> 'poolId')::uuid = p.id and (q.data ->> 'personId')::uuid = v_link.person_id)
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
    select * into v_prize from public.settlement_prizes where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
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
    -- Drawn numbers: the result the prize was confirmed on; before that, the core's current result unless sources conflict.
    if v_prize.id is not null then
      select r.data into v_result from public.contest_result_versions r where r.group_id = v_link.group_id and r.id = v_prize.result_id;
    else
      v_current := private.settlement_current_result(v_link.group_id,v_pool.id);
      v_result := case when v_current ->> 'status' = 'conflict' then null else v_current -> 'result' end;
    end if;
    v_drawn := case when jsonb_typeof(v_result -> 'drawnNumbers') = 'array' and jsonb_array_length(v_result -> 'drawnNumbers') > 0 then v_result -> 'drawnNumbers' end;
    select coalesce(private.utc_json(c.expected_draw_at),to_char(c.draw_date,'YYYY-MM-DD')) into v_draw_at from public.contest_calendar_versions c
      where c.group_id = v_link.group_id and c.pool_id = v_pool.id order by c.version desc limit 1;
    v_pools := v_pools || jsonb_build_array(jsonb_build_object('id',v_pool.id,'title',v_pool.data ->> 'title','modality',v_pool.data ->> 'lotteryId',
      'contest',coalesce(v_pool.data -> 'contestNumber','null'::jsonb),'drawAt',coalesce(v_draw_at,v_result ->> 'drawDate'),
      'status',v_pool.data ->> 'status','participationMode',v_mode,
      'quota',jsonb_build_object('units',v_units,'dueCents',v_due::text,'paidCents',v_funding::text,'paid',v_funding >= v_due),
      'games',v_games,
      'registration',case when v_manifest.id is null then null else jsonb_build_object(
        'status',case v_report.comparison ->> 'status' when 'complete' then 'registered' when 'partial' then 'partial' when 'divergent' then 'divergent' else 'planned' end,
        'ticketHolderName',v_holder) end,
      'result',case when v_drawn is null then null else jsonb_build_object('drawnNumbers',v_drawn,
        'prizeCalculatedCents',v_balance ->> 'calculatedPrizeCents','prizeConfirmedCents',v_prize.amount_cents::text,
        'redemptionDeadlineDate',v_prize.redemption_deadline ->> 'deadlineDate',
        'prizeRedeemed',coalesce(v_prize.amount_cents > 0 and (v_balance ->> 'unredeemedPrizeCents')::numeric <= 0,false)) end,
      'share',case when v_own is null then null else jsonb_build_object('rightCents',v_own ->> 'prizeRightCents','receivedCents',v_own ->> 'prizeReceivedCents',
        'pendingCents',v_own ->> 'prizePendingCents','paidByName',case when v_mode = 'internal' then v_holder end,
        'refundRightCents',v_own ->> 'refundRightCents','refundedCents',v_own ->> 'refundedCents') end,
      'groupReserveCents',v_balance ->> 'groupReserveCents',
      'closed',coalesce((v_balance ->> 'closed')::boolean,false)));
  end loop;
  return jsonb_build_object('version',1,'generatedAt',private.utc_json(clock_timestamp()),
    'group',jsonb_build_object('name',(select g.name from public.groups g where g.id = v_link.group_id)),
    'person',jsonb_build_object('id',v_link.person_id,'name',(select p.data ->> 'name' from public.draft_records p where p.group_id = v_link.group_id and p.id = v_link.person_id)),
    'pools',v_pools);
end;
$$;

revoke all on function private.participant_card_pix_base(text) from public,anon,authenticated;
