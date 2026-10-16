-- The card shows the games the prize is calculated on. Once a registration is confirmed, each planned ticket shows the
-- numbers read from its receipt (registered: true) when, as in private.settlement_calculated_prize and assessRegisteredPrizes,
-- it has evidence and legible numbers for this plan's lottery and contest; a ticket without them keeps its planned bets
-- (registered: false). Before a registration, the frozen plan; before the lock, the draft bets; both registered: false.
-- The card used to show the frozen plan even after registration, so a receipt with other numbers could look like a win.
-- private.participant_card_pix_base is re-created from 20261013020000_participant_card_deadline.sql with only the games changed.
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
      'closed',coalesce((v_balance ->> 'closed')::boolean,false)));
  end loop;
  return jsonb_build_object('version',1,'generatedAt',private.utc_json(clock_timestamp()),
    'group',jsonb_build_object('name',(select g.name from public.groups g where g.id = v_link.group_id)),
    'person',jsonb_build_object('id',v_link.person_id,'name',(select p.data ->> 'name' from public.draft_records p where p.group_id = v_link.group_id and p.id = v_link.person_id)),
    'pools',v_pools);
end;
$$;

revoke all on function private.participant_card_pix_base(text) from public,anon,authenticated;
