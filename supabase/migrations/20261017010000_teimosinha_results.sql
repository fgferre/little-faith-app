-- Owner's decision of 17/10 (teimosinha, step 2 of PLAN-teimosinha.md): a pool covers the consecutive contests contestNumber ..
-- contestNumber + contestCount - 1 (contestCount absent means 1), and its results, result reviews, calendars and collection jobs are
-- kept per (pool, contest), as packages/core/src/results.ts now does. A pool of one contest behaves exactly as before. Prizes per
-- contest are the next step: settlement_pool_balance and the participant card are not changed here.
--   private.pool_contest_in_range            new: whether a contest is one of the pool's contests;
--   contest_result_versions.contest_number   new column, backfilled from data.contestNumber, always equal to it (checked), indexed;
--   result_collection_jobs.contest_number    new column, backfilled from the job's calendar; the primary key becomes (group, pool,
--     contest), so each contest of a teimosinha has its own collection schedule;
--   public.result_collection_context         gains p_contest_number (null means the pool's first contest; a contest outside the range
--     raises contest_out_of_range). The two-argument version stays as a wrapper so its callers and grant keep working; the
--     three-argument version has no default, so a two-argument call (SQL or PostgREST) is never ambiguous;
--   re-created from 20261008010000_registration_results.sql (never redefined since):
--     public.result_collect_seal         the scope accepts any contest of the range and sets contest_number; the calendar compared
--       is the latest of that contest; the duplicate check by sha256 stays per pool;
--     public.result_decide               a manual result or calendar accepts any contest of the range (same messages) and the
--       manual result sets contest_number; a review lists exactly every version of the selected result's contest; the collection
--       job is upserted or deleted for that calendar's contest only;
--     public.result_jobs_due             claims jobs by (group, pool, contest) and reports the job's contest;
--     public.result_collection_attempt   accepts the official URL of any contest of the range and reschedules only that contest's
--       job (without a URL, every job of the pool, as before);
--   private.settlement_eligible_results and private.settlement_current_result (20261010000000_settlement.sql, never redefined
--     since) gain p_contest; null means the pool's lowest contest with a result or calendar, as the core's currentResult without a
--     contest. They are dropped and re-created because a same-named function with an extra defaulted argument would make every
--     two-argument call ambiguous; their callers keep calling them with two arguments.
-- create or replace keeps the existing grants; every new function gets the same revoke (and grant) as the one it extends.
create function private.pool_contest_in_range(p_pool_data jsonb,p_contest jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when private.json_integer(p_pool_data -> 'contestNumber',1,999999) and private.json_integer(p_contest,1,999999)
    then (p_contest #>> '{}')::numeric between (p_pool_data ->> 'contestNumber')::numeric and (p_pool_data ->> 'contestNumber')::numeric
      + case when private.json_integer(p_pool_data -> 'contestCount',1,12) then (p_pool_data ->> 'contestCount')::numeric else 1 end - 1
    else false end;
$$;
revoke all on function private.pool_contest_in_range(jsonb,jsonb) from public,anon,authenticated;

-- Results are append-only: the guard trigger is paused only for this backfill, inside the migration's lock on the table.
alter table public.contest_result_versions add column contest_number bigint check (contest_number between 1 and 999999);
alter table public.contest_result_versions disable trigger results_append_only;
update public.contest_result_versions set contest_number = (data ->> 'contestNumber')::numeric;
alter table public.contest_result_versions enable trigger results_append_only;
alter table public.contest_result_versions alter column contest_number set not null,
  add constraint contest_result_versions_contest_matches_data check (contest_number = (data ->> 'contestNumber')::numeric);
create index contest_result_versions_contest_idx on public.contest_result_versions(group_id,pool_id,contest_number);

alter table public.result_collection_jobs add column contest_number bigint check (contest_number between 1 and 999999);
update public.result_collection_jobs j set contest_number = c.contest_number from public.contest_calendar_versions c
  where c.group_id = j.group_id and c.pool_id = j.pool_id and c.id = j.calendar_id;
alter table public.result_collection_jobs alter column contest_number set not null,
  drop constraint result_collection_jobs_pkey, add primary key (group_id,pool_id,contest_number);

create function public.result_collection_context(p_group_id uuid,p_pool_id uuid,p_contest_number bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_pool public.draft_records;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  select * into v_pool from public.draft_records where group_id = p_group_id and id = p_pool_id and kind = 'pool';
  if not found or not private.json_integer(v_pool.data -> 'contestNumber',1,999999) then raise exception 'contest_not_defined' using errcode = '22023'; end if;
  if p_contest_number is not null and not private.pool_contest_in_range(v_pool.data,to_jsonb(p_contest_number)) then raise exception 'contest_out_of_range' using errcode = '22023'; end if;
  return jsonb_build_object('groupId',p_group_id,'poolId',p_pool_id,'lotteryId',v_pool.data -> 'lotteryId','contestNumber',coalesce(to_jsonb(p_contest_number),v_pool.data -> 'contestNumber'));
end;
$$;
create or replace function public.result_collection_context(p_group_id uuid,p_pool_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return public.result_collection_context(p_group_id,p_pool_id,null::bigint);
end;
$$;
revoke all on function public.result_collection_context(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.result_collection_context(uuid,uuid,bigint) to authenticated;

create or replace function public.result_collect_seal(p_group_id uuid,p_pool_id uuid,p_actor_id uuid,p_parsed jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pool public.draft_records; v_data jsonb; v_result public.contest_result_versions; v_now timestamptz;
  v_raw text; v_hash text; v_url text; v_version bigint; v_calendar_version bigint; v_calendar public.contest_calendar_versions; v_status text; v_contest bigint;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u join public.group_memberships m on m.user_id = u.id where u.id = p_actor_id and m.group_id = p_group_id
    and m.role = 'organizer' and coalesce(u.raw_app_meta_data ->> 'actor_type','human') = 'human') then raise exception 'group_access_denied' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text,0));
  perform 1 from public.groups where id = p_group_id for update;
  v_now := clock_timestamp();
  select * into v_pool from public.draft_records where group_id = p_group_id and id = p_pool_id and kind = 'pool';
  v_data := jsonb_build_object('lotteryId',p_parsed -> 'lotteryId','contestNumber',p_parsed -> 'contestNumber','drawDate',p_parsed -> 'drawDate',
    'drawnNumbers',p_parsed -> 'drawnNumbers','payouts',p_parsed -> 'payouts');
  if not found or private.result_data_error(v_data) is not null or v_data -> 'lotteryId' <> v_pool.data -> 'lotteryId'
    or not private.pool_contest_in_range(v_pool.data,v_data -> 'contestNumber') then raise exception 'invalid_result_scope' using errcode = '22023'; end if;
  v_contest := (v_data ->> 'contestNumber')::numeric;
  v_data := private.normalize_result_data(v_data);
  v_status := case when v_data -> 'drawnNumbers' = 'null'::jsonb then 'waiting'
    when v_data -> 'payouts' <> 'null'::jsonb and not exists (select 1 from jsonb_array_elements(v_data -> 'payouts') where value -> 'prizeCents' = 'null'::jsonb) then 'complete' else 'numbers-only' end;
  v_raw := p_parsed ->> 'rawText'; v_hash := encode(sha256(convert_to(v_raw,'UTF8')),'hex');
  v_url := private.caixa_source_url(v_data ->> 'lotteryId',v_contest);
  if v_raw is null or octet_length(v_raw) not between 1 and 1048576 or v_hash is distinct from p_parsed ->> 'sha256' or p_parsed ->> 'sourceUrl' is distinct from v_url
    or (p_parsed ->> 'status') is distinct from v_status then raise exception 'invalid_official_source' using errcode = '22023'; end if;
  select * into v_result from public.contest_result_versions where group_id = p_group_id and pool_id = p_pool_id and source = 'caixa' and sha256 = v_hash;
  if found then return private.result_snapshot(p_group_id); end if;
  select coalesce(max(version),0)+1 into v_version from public.contest_result_versions where group_id = p_group_id and pool_id = p_pool_id;
  if v_version > 9007199254740991 or (select count(*) from public.contest_result_versions where group_id = p_group_id) >= 10000 then raise exception 'result_version_limit' using errcode = '22023'; end if;
  insert into public.contest_result_versions(id,group_id,pool_id,version,contest_number,data,source,source_url,source_reference,raw_text,sha256,collected_at,status)
    values(gen_random_uuid(),p_group_id,p_pool_id,v_version,v_contest,v_data,'caixa',v_url,v_url,v_raw,v_hash,v_now,p_parsed ->> 'status');
  -- The JSON service establishes a Brasília date, never an inferred draw/channel-close time.
  select * into v_calendar from public.contest_calendar_versions where group_id = p_group_id and pool_id = p_pool_id and contest_number = v_contest order by version desc limit 1;
  if not found or (v_calendar.source = 'caixa' and v_calendar.draw_date is distinct from (v_data ->> 'drawDate')::date) then
    select coalesce(max(version),0)+1 into v_calendar_version from public.contest_calendar_versions where group_id = p_group_id and pool_id = p_pool_id;
    insert into public.contest_calendar_versions(id,group_id,pool_id,version,lottery_id,contest_number,source,source_url,source_reference,raw_text,sha256,collected_at,draw_date)
      values(gen_random_uuid(),p_group_id,p_pool_id,v_calendar_version,v_data ->> 'lotteryId',(v_data ->> 'contestNumber')::bigint,'caixa',v_url,v_url,v_raw,v_hash,v_now,(v_data ->> 'drawDate')::date);
  end if;
  perform private.advance_fact_revision(p_group_id,p_pool_id,p_actor_id,gen_random_uuid(),'results_collect',jsonb_build_object('resultVersion',v_version,'sha256',v_hash));
  return private.result_snapshot(p_group_id);
end;
$$;

create or replace function public.result_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid();
  v_saved public.result_command_receipts; v_pool public.draft_records; v_action jsonb; v_revision bigint; v_version bigint;
  v_error text; v_status text := 'accepted'; v_now timestamptz; v_raw text; v_fact_id uuid; v_observed jsonb; v_contest bigint;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_result_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('result:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.result_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de decidir o resultado.';
  else v_error := private.result_action_error(v_action); end if;
  if v_error is null and ((v_action ->> 'type' = 'result_manual' and (select count(*) from public.contest_result_versions where group_id = v_group) >= 10000)
    or (v_action ->> 'type' = 'result_resolve' and (select count(*) from public.result_selections where group_id = v_group) >= 10000)
    or (v_action ->> 'type' = 'calendar_confirm' and (select count(*) from public.contest_calendar_versions where group_id = v_group) >= 10000)) then
    v_error := 'Limite de versões de resultados ou calendário atingido.';
  end if;
  v_now := clock_timestamp();
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a decisão.';
    elsif v_action ->> 'type' = 'result_manual' and (v_action -> 'data' -> 'lotteryId' <> v_pool.data -> 'lotteryId' or not private.pool_contest_in_range(v_pool.data,v_action -> 'data' -> 'contestNumber'))
      then v_error := 'O resultado manual pertence a outra modalidade ou concurso.';
    elsif v_action ->> 'type' = 'calendar_confirm' and (v_action -> 'lotteryId' <> v_pool.data -> 'lotteryId' or not private.pool_contest_in_range(v_pool.data,v_action -> 'contestNumber'))
      then v_error := 'O calendário pertence a outra modalidade ou concurso.';
    elsif v_action ->> 'type' = 'result_resolve' then
      select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into v_observed from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id
        and contest_number = (select contest_number from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id and id = (v_action ->> 'resultId')::uuid);
      if v_observed <> (select jsonb_agg(value order by (value #>> '{}')::uuid) from jsonb_array_elements(v_action -> 'observedResultIds'))
        or not exists (select 1 from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id and id = (v_action ->> 'resultId')::uuid)
        then v_error := 'Revise exatamente todas as versões atuais do concurso antes de resolver o conflito.'; end if;
    end if;
  end if;
  if v_error is null then
    v_fact_id := gen_random_uuid();
    if v_action ->> 'type' = 'result_manual' then
      select coalesce(max(version),0)+1 into v_version from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id;
      v_raw := private.canonical_json(v_action);
      insert into public.contest_result_versions(id,group_id,pool_id,version,contest_number,data,source,source_reference,raw_text,sha256,collected_at,status,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,(v_action -> 'data' ->> 'contestNumber')::numeric,private.normalize_result_data(v_action -> 'data'),'manual',v_action ->> 'sourceReference',v_raw,encode(sha256(convert_to(v_raw,'UTF8')),'hex'),v_now,'manual',v_receipt);
    elsif v_action ->> 'type' = 'result_resolve' then
      select coalesce(max(version),0)+1 into v_version from public.result_selections where group_id = v_group and pool_id = v_pool_id;
      insert into public.result_selections(id,group_id,pool_id,version,result_id,observed_result_ids,reason,selected_at,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,(v_action ->> 'resultId')::uuid,v_action -> 'observedResultIds',v_action ->> 'reason',v_now,v_receipt);
    else
      select coalesce(max(version),0)+1 into v_version from public.contest_calendar_versions where group_id = v_group and pool_id = v_pool_id;
      v_raw := private.canonical_json(v_action);
      insert into public.contest_calendar_versions(id,group_id,pool_id,version,lottery_id,contest_number,source,source_reference,raw_text,sha256,collected_at,draw_date,expected_draw_at,registration_closes_at,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,v_action ->> 'lotteryId',(v_action ->> 'contestNumber')::bigint,'manual',v_action ->> 'sourceReference',v_raw,
          encode(sha256(convert_to(v_raw,'UTF8')),'hex'),v_now,(v_action ->> 'drawDate')::date,(v_action ->> 'expectedDrawAt')::timestamptz,(v_action ->> 'registrationClosesAt')::timestamptz,v_receipt);
      v_contest := (v_action ->> 'contestNumber')::numeric;
      if v_action -> 'expectedDrawAt' <> 'null'::jsonb then
        insert into public.result_collection_jobs(group_id,pool_id,contest_number,calendar_id,actor_id,expected_draw_at,next_attempt_at,morning_check_at)
          values(v_group,v_pool_id,v_contest,v_fact_id,v_actor,(v_action ->> 'expectedDrawAt')::timestamptz,(v_action ->> 'expectedDrawAt')::timestamptz,
            (((v_action ->> 'expectedDrawAt')::timestamptz at time zone 'America/Sao_Paulo')::date + 1 + time '09:00') at time zone 'America/Sao_Paulo')
          on conflict (group_id,pool_id,contest_number) do update set calendar_id = excluded.calendar_id,actor_id = excluded.actor_id,expected_draw_at = excluded.expected_draw_at,
            next_attempt_at = excluded.next_attempt_at,morning_check_at = excluded.morning_check_at,morning_checked = false;
      else delete from public.result_collection_jobs where group_id = v_group and pool_id = v_pool_id and contest_number = v_contest; end if;
    end if;
    v_revision := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,v_action ->> 'type',jsonb_build_object('receiptId',v_receipt,'factId',v_fact_id,'version',v_version));
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  insert into public.result_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
      'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
      'snapshot',private.result_snapshot(v_group)),v_now) returning response_payload into v_action;
  return v_action;
end;
$$;

create or replace function public.result_jobs_due(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if p_limit not between 1 and 20 then raise exception 'invalid_job_limit' using errcode = '22023'; end if;
  with claimed as (
    update public.result_collection_jobs q set next_attempt_at = clock_timestamp() + interval '5 minutes'
      where (q.group_id,q.pool_id,q.contest_number) in (select group_id,pool_id,contest_number from public.result_collection_jobs where next_attempt_at <= clock_timestamp()
        order by next_attempt_at limit p_limit for update skip locked)
      returning q.*)
    select coalesce(jsonb_agg(jsonb_build_object('groupId',j.group_id,'poolId',j.pool_id,'actorId',j.actor_id,
    'lotteryId',p.data -> 'lotteryId','contestNumber',j.contest_number) order by j.next_attempt_at),'[]'::jsonb) into v_result from claimed j
    join public.draft_records p on p.group_id = j.group_id and p.id = j.pool_id
    join public.group_memberships m on m.group_id = j.group_id and m.user_id = j.actor_id and m.role = 'organizer'
    join auth.users u on u.id = j.actor_id where coalesce(u.raw_app_meta_data ->> 'actor_type','human') = 'human';
  return v_result;
end;
$$;
create or replace function public.result_collection_attempt(p_group_id uuid,p_pool_id uuid,p_outcome text,p_error_code text default '',p_source_url text default null,p_raw_text text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_contest bigint;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  -- The official URL names one contest; it must be exactly the URL of one of the pool's contests.
  v_contest := substring(p_source_url from '/([0-9]{1,6})$')::bigint;
  if p_source_url is not null and (v_contest is null or not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_pool_id
    and private.pool_contest_in_range(data,to_jsonb(v_contest)) and p_source_url = private.caixa_source_url(data ->> 'lotteryId',v_contest))) then raise exception 'invalid_source_url' using errcode = '22023'; end if;
  insert into public.result_collection_attempts(id,group_id,pool_id,attempted_at,outcome,error_code,source_url,raw_text,sha256)
    values(gen_random_uuid(),p_group_id,p_pool_id,v_now,p_outcome,left(p_error_code,100),p_source_url,p_raw_text,encode(sha256(convert_to(p_raw_text,'UTF8')),'hex'));
  update public.result_collection_jobs set last_attempt_at = v_now,
    last_success_at = case when p_outcome = 'success' then v_now else last_success_at end,
    morning_checked = morning_checked or v_now >= morning_check_at,
    next_attempt_at = least(v_now + case when v_now < expected_draw_at + interval '24 hours' then interval '5 minutes' else interval '1 hour' end,
      case when not morning_checked and v_now < morning_check_at then morning_check_at else 'infinity'::timestamptz end)
    where group_id = p_group_id and pool_id = p_pool_id and (v_contest is null or contest_number = v_contest);
end;
$$;

drop function private.settlement_current_result(uuid,uuid);
drop function private.settlement_eligible_results(uuid,uuid);
create function private.settlement_eligible_results(p_group uuid,p_pool uuid,p_contest bigint default null) returns setof public.contest_result_versions
language sql stable set search_path = '' as $$
  with chosen as (select coalesce(p_contest,least(
      (select min(contest_number) from public.contest_result_versions where group_id = p_group and pool_id = p_pool),
      (select min(contest_number) from public.contest_calendar_versions where group_id = p_group and pool_id = p_pool))) as contest),
  selection as (select s.* from public.result_selections s join public.contest_result_versions v on v.group_id = s.group_id and v.pool_id = s.pool_id and v.id = s.result_id
    where s.group_id = p_group and s.pool_id = p_pool and v.contest_number = (select contest from chosen) order by s.version desc limit 1)
  select r.* from public.contest_result_versions r where r.group_id = p_group and r.pool_id = p_pool and r.contest_number = (select contest from chosen)
    and (not exists (select 1 from selection) or r.id = (select result_id from selection)
      or not exists (select 1 from selection s cross join lateral jsonb_array_elements_text(s.observed_result_ids) o where o.value::uuid = r.id));
$$;
create function private.settlement_current_result(p_group uuid,p_pool uuid,p_contest bigint default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_result public.contest_result_versions; v_conflict boolean;
begin
  select exists (select 1 from private.settlement_eligible_results(p_group,p_pool,p_contest) a join private.settlement_eligible_results(p_group,p_pool,p_contest) b on a.id < b.id
    where private.settlement_results_incompatible(a.data,b.data)) into v_conflict;
  select * into v_result from private.settlement_eligible_results(p_group,p_pool,p_contest) r
    order by private.settlement_result_information(r.data) desc,(r.source = 'caixa') desc,r.version desc limit 1;
  return jsonb_build_object('status',case when v_conflict then 'conflict' else coalesce(v_result.status,'waiting') end,
    'result',case when v_result.id is null then null else private.result_version_json(v_result) end);
end;
$$;
revoke all on function private.settlement_eligible_results(uuid,uuid,bigint),private.settlement_current_result(uuid,uuid,bigint) from public,anon,authenticated;
