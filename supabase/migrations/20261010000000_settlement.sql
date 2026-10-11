-- Human-confirmed settlement (prize split). Earlier migrations stay immutable.
-- Every derived field reproduces the pure core (buildSettlementFact); the core rebuilds and compares each fact.
create table public.settlement_command_receipts (
  id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  group_id uuid not null references public.groups(id) on delete restrict,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null,
  unique (actor_id,idempotency_key)
);

create table public.settlement_expenses (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  group_revision bigint not null check (group_revision between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  confirmed_at timestamptz not null,
  receipt_id uuid not null unique references public.settlement_command_receipts(id) deferrable initially deferred,
  manifest_id uuid not null,
  registration_report_id uuid not null,
  supersedes_id uuid references public.settlement_expenses(id) on delete restrict,
  bet_cost_cents bigint not null check (bet_cost_cents between 0 and 9007199254740991),
  fee_cents bigint not null check (fee_cents between 0 and 9007199254740991),
  total_cost_cents bigint not null check (total_cost_cents = bet_cost_cents + fee_cents and total_cost_cents <= 9007199254740991),
  evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array'),
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  reason text not null check (char_length(reason) <= 2000),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,pool_id,manifest_id) references public.pool_manifests(group_id,pool_id,id) on delete restrict,
  foreign key (group_id,registration_report_id) references public.registration_reports(group_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,group_revision)
);

create table public.settlement_prizes (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  group_revision bigint not null check (group_revision between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  confirmed_at timestamptz not null,
  receipt_id uuid not null unique references public.settlement_command_receipts(id) deferrable initially deferred,
  manifest_id uuid not null,
  registration_report_id uuid not null,
  result_id uuid not null,
  observed_result_ids jsonb not null check (jsonb_typeof(observed_result_ids) = 'array'),
  result_selection_id uuid references public.result_selections(id) on delete restrict,
  supersedes_id uuid references public.settlement_prizes(id) on delete restrict,
  calculated_prize_cents numeric check (calculated_prize_cents >= 0 and calculated_prize_cents = trunc(calculated_prize_cents)),
  amount_cents bigint not null check (amount_cents between 0 and 9007199254740991),
  official_entitlements jsonb not null check (jsonb_typeof(official_entitlements) = 'array'),
  rights jsonb not null check (jsonb_typeof(rights) = 'array'),
  evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array'),
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  reason text not null check (char_length(reason) <= 2000),
  redemption_deadline jsonb check (jsonb_typeof(redemption_deadline) = 'object'),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,pool_id,manifest_id) references public.pool_manifests(group_id,pool_id,id) on delete restrict,
  foreign key (group_id,registration_report_id) references public.registration_reports(group_id,id) on delete restrict,
  foreign key (group_id,pool_id,result_id) references public.contest_result_versions(group_id,pool_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,group_revision)
);

create table public.settlement_redemptions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  group_revision bigint not null check (group_revision between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  confirmed_at timestamptz not null,
  receipt_id uuid not null unique references public.settlement_command_receipts(id) deferrable initially deferred,
  prize_confirmation_id uuid not null references public.settlement_prizes(id) on delete restrict,
  person_id uuid not null,
  ownership text not null check (ownership in ('organizer','individual')),
  direction text not null check (direction in ('received','reversed')),
  -- One explicit compensation per positive original; nothing is deleted.
  reverses_id uuid unique references public.settlement_redemptions(id) on delete restrict,
  amount_cents bigint not null check (amount_cents between -9007199254740991 and 9007199254740991),
  evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array'),
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  event_at timestamptz not null,
  reason text not null check (char_length(reason) <= 2000),
  check ((direction = 'received' and reverses_id is null and amount_cents > 0) or (direction = 'reversed' and reverses_id is not null and amount_cents < 0)),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,group_revision)
);

create table public.settlement_distributions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  group_revision bigint not null check (group_revision between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  confirmed_at timestamptz not null,
  receipt_id uuid not null unique references public.settlement_command_receipts(id) deferrable initially deferred,
  person_id uuid not null,
  kind text not null check (kind in ('prize-payment','contribution-refund')),
  direction text not null check (direction in ('paid','returned')),
  reverses_id uuid unique references public.settlement_distributions(id) on delete restrict,
  amount_cents bigint not null check (amount_cents between -9007199254740991 and 9007199254740991),
  evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array'),
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  event_at timestamptz not null,
  reason text not null check (char_length(reason) between 1 and 2000),
  check ((direction = 'paid' and reverses_id is null and amount_cents > 0) or (direction = 'returned' and reverses_id is not null and amount_cents < 0)),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,group_revision)
);

-- Created for the contract; closing and reopening are not available in this release.
create table public.settlement_closures (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  group_revision bigint not null check (group_revision between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  confirmed_at timestamptz not null,
  receipt_id uuid not null unique references public.settlement_command_receipts(id) deferrable initially deferred,
  direction text not null check (direction in ('closed','reopened')),
  previous_closure_id uuid references public.settlement_closures(id) on delete restrict,
  registration_report_id uuid not null,
  prize_confirmation_id uuid references public.settlement_prizes(id) on delete restrict,
  expense_confirmation_id uuid references public.settlement_expenses(id) on delete restrict,
  observed_result_ids jsonb not null check (jsonb_typeof(observed_result_ids) = 'array'),
  result_selection_id uuid references public.result_selections(id) on delete restrict,
  leftover_disposition text not null check (leftover_disposition in ('group-reserve','pending-refund')),
  reconciliation jsonb not null check (jsonb_typeof(reconciliation) = 'object'),
  pending_explanation text not null check (char_length(pending_explanation) <= 2000),
  reason text not null check (char_length(reason) between 1 and 2000),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,registration_report_id) references public.registration_reports(group_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,group_revision)
);
create trigger settlement_receipts_append_only before update or delete on public.settlement_command_receipts for each row execute function private.prevent_mutation();
create trigger settlement_expenses_append_only before update or delete on public.settlement_expenses for each row execute function private.prevent_mutation();
create trigger settlement_prizes_append_only before update or delete on public.settlement_prizes for each row execute function private.prevent_mutation();
create trigger settlement_redemptions_append_only before update or delete on public.settlement_redemptions for each row execute function private.prevent_mutation();
create trigger settlement_distributions_append_only before update or delete on public.settlement_distributions for each row execute function private.prevent_mutation();
create trigger settlement_closures_append_only before update or delete on public.settlement_closures for each row execute function private.prevent_mutation();

-- Shape validation identical to (or stricter than) validateSettlementCommand.
create function private.settlement_text(p_value jsonb,p_required boolean) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(private.json_text(p_value,2000) and (not p_required or private.js_trim(p_value #>> '{}') <> ''),false);
$$;
create function private.settlement_time(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string' or (p_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$' then return false; end if;
  return private.json_timestamp(p_value);
end;
$$;
create function private.settlement_ids_valid(p_value jsonb,p_max integer) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_value) > p_max then return false; end if;
  if exists (select 1 from jsonb_array_elements(p_value) where not private.json_uuid(value)) then return false; end if;
  return (select count(distinct lower(value #>> '{}')) from jsonb_array_elements(p_value)) = jsonb_array_length(p_value);
end;
$$;
create function private.settlement_ids(p_value jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(lower(value #>> '{}')) order by ordinality),'[]'::jsonb) from jsonb_array_elements(p_value) with ordinality;
$$;
create function private.settlement_lottery_url(p_lottery text) returns text
language sql immutable set search_path = '' as $$
  select case p_lottery when 'mega-sena' then 'https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx'
    when 'lotofacil' then 'https://loterias.caixa.gov.br/Paginas/Lotofacil.aspx' when 'quina' then 'https://loterias.caixa.gov.br/Paginas/Quina.aspx' end;
$$;
create function private.settlement_deadline_valid(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_exception jsonb; v_draw date;
begin
  if p_value = 'null'::jsonb then return true; end if;
  if private.exact_keys(p_value,array['ruleVersion','sourceUrl','verifiedAt','drawDate','deadlineDate','exception']) is not true
    or jsonb_typeof(p_value -> 'sourceUrl') is distinct from 'string'
    or (p_value ->> 'sourceUrl') not in (private.settlement_lottery_url('mega-sena'),private.settlement_lottery_url('lotofacil'),private.settlement_lottery_url('quina'))
    or p_value -> 'ruleVersion' is distinct from '"caixa-redemption-90-days-2026-10-08-v1"'::jsonb
    or p_value -> 'verifiedAt' is distinct from '"2026-10-08"'::jsonb or not private.json_calendar_date(p_value -> 'drawDate') then return false; end if;
  v_draw := (p_value ->> 'drawDate')::date; v_exception := p_value -> 'exception';
  if v_exception = 'null'::jsonb then return p_value -> 'deadlineDate' = to_jsonb(to_char(v_draw + 90,'YYYY-MM-DD')); end if;
  if private.exact_keys(v_exception,array['deadlineDate','sourceReference','reason']) is not true or not private.json_calendar_date(v_exception -> 'deadlineDate')
    or not private.settlement_text(v_exception -> 'sourceReference',true) or not private.settlement_text(v_exception -> 'reason',true) then return false; end if;
  if (v_exception ->> 'deadlineDate')::date < v_draw then return false; end if;
  return p_value -> 'deadlineDate' = v_exception -> 'deadlineDate';
end;
$$;
create function private.settlement_entitlements_valid(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb;
begin
  if jsonb_typeof(p_value) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_value) > 100000 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_value) loop
    if private.exact_keys(v_item,array['plannedTicketKey','quotaId','personId','officialQuotas','amountCents','evidenceIds']) is not true
      or jsonb_typeof(v_item -> 'plannedTicketKey') is distinct from 'string' or (v_item ->> 'plannedTicketKey') !~ '^[A-Za-z0-9_-]{1,80}$'
      or not private.json_uuid(v_item -> 'quotaId') or not private.json_uuid(v_item -> 'personId')
      or not private.json_integer(v_item -> 'officialQuotas',1,1000000) or not private.json_money(v_item -> 'amountCents')
      or not private.settlement_ids_valid(v_item -> 'evidenceIds',100) then return false; end if;
  end loop;
  return (select count(distinct (value ->> 'plannedTicketKey') || ':' || lower(value ->> 'quotaId')) from jsonb_array_elements(p_value)) = jsonb_array_length(p_value);
end;
$$;
create function private.settlement_entitlements(p_value jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('plannedTicketKey',value -> 'plannedTicketKey','quotaId',lower(value ->> 'quotaId'),'personId',lower(value ->> 'personId'),
    'officialQuotas',to_jsonb(trunc((value ->> 'officialQuotas')::numeric)::bigint),'amountCents',value -> 'amountCents','evidenceIds',private.settlement_ids(value -> 'evidenceIds'))
    order by ordinality),'[]'::jsonb) from jsonb_array_elements(p_value) with ordinality;
$$;
create function private.settlement_action_error(p_action jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_type text; v_common text[] := array['type','poolId','poolVersion'];
begin
  if jsonb_typeof(p_action) is distinct from 'object' then return 'Ação de apuração inválida.'; end if;
  if not private.json_uuid(p_action -> 'poolId') or not private.json_integer(p_action -> 'poolVersion',1,9007199254740991) then return 'Informe bolão e versão observada da decisão.'; end if;
  v_type := p_action ->> 'type';
  if v_type = 'expense_confirm' then
    if private.exact_keys(p_action,v_common || array['registrationReportId','supersedesId','betCostCents','feeCents','evidenceIds','sourceReference','reason']) is not true
      or not private.json_uuid(p_action -> 'registrationReportId') or not (p_action -> 'supersedesId' = 'null'::jsonb or private.json_uuid(p_action -> 'supersedesId'))
      or not private.json_money(p_action -> 'betCostCents') or not private.json_money(p_action -> 'feeCents')
      or not private.settlement_ids_valid(p_action -> 'evidenceIds',100) or not private.settlement_text(p_action -> 'sourceReference',true)
      or not private.settlement_text(p_action -> 'reason',false) then return 'Confirmação de despesa inválida.'; end if;
    if (p_action ->> 'betCostCents')::numeric + (p_action ->> 'feeCents')::numeric > 9007199254740991 then return 'Custo total fora do limite operacional.'; end if;
  elsif v_type = 'prize_confirm' then
    if private.exact_keys(p_action,v_common || array['registrationReportId','resultId','supersedesId','amountCents','officialEntitlements','evidenceIds','sourceReference','reason','redemptionDeadline']) is not true
      or not private.json_uuid(p_action -> 'registrationReportId') or not private.json_uuid(p_action -> 'resultId')
      or not (p_action -> 'supersedesId' = 'null'::jsonb or private.json_uuid(p_action -> 'supersedesId')) or not private.json_money(p_action -> 'amountCents')
      or not private.settlement_entitlements_valid(p_action -> 'officialEntitlements') or not private.settlement_ids_valid(p_action -> 'evidenceIds',100)
      or not private.settlement_text(p_action -> 'sourceReference',true) or not private.settlement_text(p_action -> 'reason',false)
      or not private.settlement_deadline_valid(p_action -> 'redemptionDeadline') then return 'Confirmação de prêmio inválida.'; end if;
  elsif v_type = 'redemption_record' then
    if private.exact_keys(p_action,v_common || array['prizeConfirmationId','personId','amountCents','evidenceIds','sourceReference','eventAt','reason']) is not true
      or not private.json_uuid(p_action -> 'prizeConfirmationId') or not private.json_uuid(p_action -> 'personId') or not private.json_money(p_action -> 'amountCents',true)
      or not private.settlement_ids_valid(p_action -> 'evidenceIds',100) or not private.settlement_text(p_action -> 'sourceReference',true)
      or not private.settlement_time(p_action -> 'eventAt') or not private.settlement_text(p_action -> 'reason',false) then return 'Registro de resgate inválido.'; end if;
  elsif v_type = 'redemption_reverse' then
    if private.exact_keys(p_action,v_common || array['redemptionId','evidenceIds','sourceReference','eventAt','reason']) is not true
      or not private.json_uuid(p_action -> 'redemptionId') or not private.settlement_ids_valid(p_action -> 'evidenceIds',100)
      or not private.settlement_text(p_action -> 'sourceReference',true) or not private.settlement_time(p_action -> 'eventAt')
      or not private.settlement_text(p_action -> 'reason',true) then return 'Compensação de resgate inválida.'; end if;
  elsif v_type = 'distribution_record' then
    if private.exact_keys(p_action,v_common || array['personId','kind','amountCents','evidenceIds','sourceReference','eventAt','reason']) is not true
      or not private.json_uuid(p_action -> 'personId') or (p_action ->> 'kind' in ('prize-payment','contribution-refund') and jsonb_typeof(p_action -> 'kind') = 'string') is not true
      or not private.json_money(p_action -> 'amountCents',true) or not private.settlement_ids_valid(p_action -> 'evidenceIds',100)
      or not private.settlement_text(p_action -> 'sourceReference',true) or not private.settlement_time(p_action -> 'eventAt')
      or not private.settlement_text(p_action -> 'reason',true) then return 'Registro de pagamento ou devolução inválido.'; end if;
  elsif v_type = 'distribution_reverse' then
    if private.exact_keys(p_action,v_common || array['distributionId','evidenceIds','sourceReference','eventAt','reason']) is not true
      or not private.json_uuid(p_action -> 'distributionId') or not private.settlement_ids_valid(p_action -> 'evidenceIds',100)
      or not private.settlement_text(p_action -> 'sourceReference',true) or not private.settlement_time(p_action -> 'eventAt')
      or not private.settlement_text(p_action -> 'reason',true) then return 'Retorno de pagamento inválido.'; end if;
  else return 'Ação de apuração ou encerramento não suportada.'; end if;
  return null;
end;
$$;

-- Current result exactly as createResultView/selectCurrent: last selection, unreviewed versions, conflicts, information rank.
create function private.settlement_results_incompatible(p_a jsonb,p_b jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select (jsonb_typeof(p_a -> 'drawDate') = 'string' and jsonb_typeof(p_b -> 'drawDate') = 'string' and p_a -> 'drawDate' <> p_b -> 'drawDate')
    or (jsonb_typeof(p_a -> 'drawnNumbers') = 'array' and jsonb_typeof(p_b -> 'drawnNumbers') = 'array' and p_a -> 'drawnNumbers' <> p_b -> 'drawnNumbers')
    or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_a -> 'payouts') = 'array' then p_a -> 'payouts' else '[]'::jsonb end) x
      join jsonb_array_elements(case when jsonb_typeof(p_b -> 'payouts') = 'array' then p_b -> 'payouts' else '[]'::jsonb end) y on x.value -> 'hits' = y.value -> 'hits'
      where (jsonb_typeof(x.value -> 'prizeCents') = 'string' and jsonb_typeof(y.value -> 'prizeCents') = 'string' and x.value -> 'prizeCents' <> y.value -> 'prizeCents')
        or (jsonb_typeof(x.value -> 'winnerCount') = 'string' and jsonb_typeof(y.value -> 'winnerCount') = 'string' and x.value -> 'winnerCount' <> y.value -> 'winnerCount'));
$$;
create function private.settlement_result_information(p_data jsonb) returns integer
language sql immutable set search_path = '' as $$
  select (case when jsonb_typeof(p_data -> 'drawnNumbers') = 'array' then 1000 else 0 end) + (case when jsonb_typeof(p_data -> 'drawDate') = 'string' then 1 else 0 end)
    + coalesce((select sum((case when jsonb_typeof(value -> 'prizeCents') = 'string' then 10 else 0 end) + (case when jsonb_typeof(value -> 'winnerCount') = 'string' then 1 else 0 end))
      from jsonb_array_elements(case when jsonb_typeof(p_data -> 'payouts') = 'array' then p_data -> 'payouts' else '[]'::jsonb end)),0)::integer;
$$;
create function private.settlement_eligible_results(p_group uuid,p_pool uuid) returns setof public.contest_result_versions
language sql stable set search_path = '' as $$
  with selection as (select * from public.result_selections where group_id = p_group and pool_id = p_pool order by version desc limit 1)
  select r.* from public.contest_result_versions r where r.group_id = p_group and r.pool_id = p_pool
    and (not exists (select 1 from selection) or r.id = (select result_id from selection)
      or not exists (select 1 from selection s cross join lateral jsonb_array_elements_text(s.observed_result_ids) o where o.value::uuid = r.id));
$$;
create function private.settlement_current_result(p_group uuid,p_pool uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_result public.contest_result_versions; v_conflict boolean;
begin
  select exists (select 1 from private.settlement_eligible_results(p_group,p_pool) a join private.settlement_eligible_results(p_group,p_pool) b on a.id < b.id
    where private.settlement_results_incompatible(a.data,b.data)) into v_conflict;
  select * into v_result from private.settlement_eligible_results(p_group,p_pool) r
    order by private.settlement_result_information(r.data) desc,(r.source = 'caixa') desc,r.version desc limit 1;
  return jsonb_build_object('status',case when v_conflict then 'conflict' else coalesce(v_result.status,'waiting') end,
    'result',case when v_result.id is null then null else private.result_version_json(v_result) end);
end;
$$;
create function private.settlement_choose(p_n integer,p_k integer) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v_result numeric := 1; v_count integer; i integer;
begin
  if p_n < 0 or p_k < 0 then raise exception 'settlement_combination_invalid' using errcode = '22023'; end if;
  if p_k > p_n then return 0; end if;
  v_count := least(p_k,p_n-p_k);
  for i in 1..v_count loop v_result := div(v_result * (p_n - v_count + i),i); end loop;
  return v_result;
end;
$$;
-- assessRegisteredPrizes(...).calculatedPrizeCents: legible actual games only; any skipped ticket or unknown tier keeps it null.
create function private.settlement_calculated_prize(p_items jsonb,p_current jsonb) returns numeric
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
      or v_item -> 'observed' -> 'contestNumber' is distinct from v_result -> 'contestNumber' then v_skipped := v_skipped+1; continue; end if;
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
-- distributeCents: floor shares, then largest remainder with ties broken by ascending id; result sorted by id. Null when the core would throw.
create function private.settlement_split(p_total numeric,p_shares jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_result jsonb;
begin
  if p_total is null or p_total < 0 or jsonb_typeof(p_shares) is distinct from 'array' then return null; end if;
  if jsonb_array_length(p_shares) = 0 then return case when p_total = 0 then '[]'::jsonb end; end if;
  if exists (select 1 from jsonb_array_elements(p_shares) where jsonb_typeof(value -> 'id') is distinct from 'string' or not private.json_integer(value -> 'units',1,9007199254740991))
    then return null; end if;
  if (select count(distinct value ->> 'id') from jsonb_array_elements(p_shares)) <> jsonb_array_length(p_shares) then return null; end if;
  with shares as (select value ->> 'id' as id,(value ->> 'units')::numeric as units from jsonb_array_elements(p_shares)),
    total as (select sum(units) as units from shares),
    floors as (select s.id,div(p_total * s.units,t.units) as cents,mod(p_total * s.units,t.units) as remainder from shares s cross join total t),
    ranked as (select f.*,row_number() over (order by f.remainder desc,f.id collate "C") as position,p_total - sum(f.cents) over () as residual from floors f)
  select jsonb_agg(jsonb_build_object('id',r.id,'amountCents',(r.cents + case when r.position <= r.residual then 1 else 0 end)::text) order by r.id collate "C")
    into v_result from ranked r;
  return v_result;
end;
$$;
-- confirmedRights: internal splits the confirmed amount by frozen units; official mirrors observed receipts exactly.
create function private.settlement_prize_rights(p_content jsonb,p_items jsonb,p_amount numeric,p_entitlements jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_split jsonb; v_rights jsonb; v_mismatch boolean;
begin
  if p_content -> 'plan' ->> 'participationMode' = 'internal' then
    if jsonb_array_length(p_entitlements) > 0 then return jsonb_build_object('error','Acordo interno não inventa recibos oficiais.'); end if;
    v_split := private.settlement_split(p_amount,coalesce((select jsonb_agg(jsonb_build_object('id',value ->> 'personId','units',value -> 'units') order by ordinality)
      from jsonb_array_elements(p_content -> 'plan' -> 'rights') with ordinality),'[]'::jsonb));
    if v_split is null then return jsonb_build_object('error','O rateio do manifesto exige uma única cota por pessoa.'); end if;
    select coalesce(jsonb_agg(jsonb_build_object('personId',s.value ->> 'id','quotaId',(select r.value ->> 'quotaId'
        from jsonb_array_elements(p_content -> 'plan' -> 'rights') with ordinality r(value,ordinality) where r.value ->> 'personId' = s.value ->> 'id' order by r.ordinality desc limit 1),
      'amountCents',s.value ->> 'amountCents') order by s.ordinality),'[]'::jsonb) into v_rights from jsonb_array_elements(v_split) with ordinality s(value,ordinality);
    return jsonb_build_object('rights',v_rights);
  end if;
  if p_items is null or exists (select 1 from jsonb_array_elements(p_items) i where case when jsonb_typeof(i.value -> 'observed') = 'object'
      and jsonb_typeof(i.value -> 'observed' -> 'officialAssignments') = 'array' then jsonb_array_length(i.value -> 'observed' -> 'officialAssignments') = 0
      or i.value -> 'observed' -> 'officialQuotaCount' = 'null'::jsonb else true end) then
    return jsonb_build_object('error','Prêmio oficial exige titulares e cotas efetivamente conferidos em todas as cartelas.');
  end if;
  with expected as (select i.value ->> 'plannedTicketKey' as key,(a.value ->> 'quotaId')::uuid as quota_id,(a.value ->> 'personId')::uuid as person_id,(a.value ->> 'officialQuotas')::numeric as quotas
      from jsonb_array_elements(p_items) i cross join lateral jsonb_array_elements(i.value -> 'observed' -> 'officialAssignments') a),
    official as (select value ->> 'plannedTicketKey' as key,(value ->> 'quotaId')::uuid as quota_id,(value ->> 'personId')::uuid as person_id,(value ->> 'officialQuotas')::numeric as quotas
      from jsonb_array_elements(p_entitlements))
  select (select count(*) from expected) <> (select count(*) from official) or exists (select 1 from expected e where not exists (select 1 from official o
    where o.key = e.key and o.quota_id = e.quota_id and o.person_id = e.person_id and o.quotas = e.quotas)) into v_mismatch;
  if v_mismatch then return jsonb_build_object('error','Valores oficiais exigem correspondência completa e exata com os recibos observados.'); end if;
  if (select coalesce(sum((value ->> 'amountCents')::numeric),0) from jsonb_array_elements(p_entitlements)) <> p_amount then
    return jsonb_build_object('error','Prêmio oficial deve somar exatamente os valores dos recibos individuais.');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('personId',x.person_id,'quotaId',x.quota_id,'amountCents',x.amount::text) order by x.person_id collate "C",x.quota_id collate "C"),'[]'::jsonb)
    into v_rights from (select lower(value ->> 'personId') as person_id,lower(value ->> 'quotaId') as quota_id,sum((value ->> 'amountCents')::numeric) as amount
      from jsonb_array_elements(p_entitlements) group by 1,2) x;
  return jsonb_build_object('rights',v_rights);
end;
$$;

-- projectPool: one pool's balance in the core's PoolSettlementBalance shape. Null when the core could not split the frozen rights.
create function private.settlement_pool_balance(p_group uuid,p_pool uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_manifest public.pool_manifests; v_plan jsonb; v_mode text; v_report public.registration_reports; v_expense public.settlement_expenses;
  v_prize public.settlement_prizes; v_closure public.settlement_closures; v_current jsonb; v_calculated numeric; v_contributed numeric; v_expenses numeric;
  v_organizer numeric; v_individual numeric; v_paid numeric; v_refunded numeric; v_cash numeric; v_amount numeric; v_shares jsonb; v_persons jsonb; v_refund_pending numeric;
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
    v_shares := private.settlement_split(greatest((v_plan ->> 'budgetCents')::numeric - v_expenses,0),coalesce((select jsonb_agg(jsonb_build_object('id',value ->> 'personId','units',value -> 'units')
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
    'unredeemedPrizeCents',(v_amount - v_organizer - v_individual)::text,
    'unpaidPrizeCents',(v_amount - case when v_mode = 'official' then v_individual else v_paid end)::text,
    'refundPendingCents',case when v_expenses is null then null else coalesce(v_refund_pending,0)::text end,
    'resultConflict',v_current ->> 'status' = 'conflict','registrationIncomplete',v_report.id is null or v_report.comparison ->> 'status' is distinct from 'complete',
    'closed',coalesce(v_closure.direction = 'closed',false),'persons',v_persons);
end;
$$;
-- financeProjection(...).organizerCashCents: group cash plus every pool's organizer receipts minus confirmed costs, payments and refunds.
create function private.settlement_group_cash(p_group uuid) returns numeric
language sql stable set search_path = '' as $$
  select coalesce((select sum(amount_cents) from public.financial_movements where group_id = p_group and kind in ('payment-received','payment-reversed')),0)
    + coalesce((select sum(amount_cents) from public.settlement_redemptions where group_id = p_group and ownership = 'organizer'),0)
    - coalesce((select sum(e.total_cost_cents) from public.settlement_expenses e where e.group_id = p_group
      and e.version = (select max(x.version) from public.settlement_expenses x where x.group_id = e.group_id and x.pool_id = e.pool_id)),0)
    - coalesce((select sum(amount_cents) from public.settlement_distributions where group_id = p_group),0);
$$;
create function private.settlement_proof_error(p_group uuid,p_pool uuid,p_ids jsonb,p_now timestamptz,p_required boolean) returns text
language plpgsql stable set search_path = '' as $$
begin
  if p_required and jsonb_array_length(p_ids) = 0 then return 'Movimento confirmado exige original privado enviado.'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_ids) i where not exists (select 1 from public.evidence_originals e
    where e.group_id = p_group and e.id = i.value::uuid and e.pool_id = p_pool and date_trunc('milliseconds',e.uploaded_at) <= p_now)) then
    return 'Evidência precisa pertencer ao bolão e existir antes da confirmação.';
  end if;
  return null;
end;
$$;
-- checkAction. Timestamps compare at the contract's millisecond precision.
create function private.settlement_action_guard(p_group uuid,p_action jsonb,p_now timestamptz) returns text
language plpgsql stable set search_path = '' as $$
declare v_type text := p_action ->> 'type'; v_pool uuid := (p_action ->> 'poolId')::uuid; v_pool_version numeric := (p_action ->> 'poolVersion')::numeric;
  v_manifest public.pool_manifests; v_plan jsonb; v_mode text; v_report public.registration_reports; v_expense public.settlement_expenses;
  v_prize public.settlement_prizes; v_balance jsonb; v_current jsonb; v_rights jsonb; v_amount numeric; v_person jsonb; v_item jsonb; v_error text;
  v_redemption public.settlement_redemptions; v_distribution public.settlement_distributions;
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
    v_current := private.settlement_current_result(p_group,v_pool);
    if (p_action ->> 'registrationReportId')::uuid <> v_report.id or (p_action ->> 'supersedesId')::uuid is distinct from v_prize.id
      or v_current ->> 'status' = 'conflict' or jsonb_typeof(v_current -> 'result') is distinct from 'object' then
      return 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.';
    end if;
    if jsonb_typeof(v_current -> 'result' -> 'drawnNumbers') is distinct from 'array' or (v_current -> 'result' ->> 'id')::uuid <> (p_action ->> 'resultId')::uuid
      or (v_current -> 'result' ->> 'collectedAt')::timestamptz > p_now then
      return 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.';
    end if;
    v_amount := (p_action ->> 'amountCents')::numeric;
    if (v_prize.id is not null or private.settlement_calculated_prize(v_report.items,v_current) is distinct from v_amount) and private.js_trim(p_action ->> 'reason') = '' then
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
      if v_prize.registration_report_id <> v_report.id or v_amount > (v_person ->> 'prizePendingCents')::numeric
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
-- checkBalances after the new fact is applied.
create function private.settlement_balance_error(p_group uuid,p_pool uuid) returns text
language plpgsql stable set search_path = '' as $$
declare v_b jsonb := private.settlement_pool_balance(p_group,p_pool);
begin
  if v_b is null then return 'O rateio do manifesto exige uma única cota por pessoa.'; end if;
  if (v_b ->> 'redeemedCents')::numeric < 0 or (v_b ->> 'prizePaidCents')::numeric < 0 or (v_b ->> 'refundedCents')::numeric < 0
    or (v_b ->> 'prizePaidCents')::numeric > (v_b ->> 'organizerRedeemedCents')::numeric then
    return 'Recebimentos/pagamentos não reconciliam com o prêmio confirmado e resgate.';
  end if;
  if v_b -> 'confirmedPrizeCents' <> 'null'::jsonb then
    if (v_b ->> 'redeemedCents')::numeric > (v_b ->> 'confirmedPrizeCents')::numeric then return 'Recebimentos/pagamentos não reconciliam com o prêmio confirmado e resgate.'; end if;
  end if;
  if exists (select 1 from jsonb_array_elements(v_b -> 'persons') p where (p.value ->> 'prizeReceivedCents')::numeric < 0 or (p.value ->> 'refundedCents')::numeric < 0
    or coalesce((p.value ->> 'prizePendingCents')::numeric < 0,false) or coalesce((p.value ->> 'refundPendingCents')::numeric < 0,false)) then
    return 'Correção não pode deixar pagamentos acima do direito da pessoa.';
  end if;
  if v_b -> 'contributionSurplusCents' <> 'null'::jsonb then
    if (v_b ->> 'refundedCents')::numeric > (v_b ->> 'contributionSurplusCents')::numeric then return 'Devoluções ultrapassam a sobra real de contribuições.'; end if;
  end if;
  if (v_b ->> 'cashDeficitCents')::numeric > 0 and ((v_b ->> 'prizePaidCents')::numeric > 0 or (v_b ->> 'refundedCents')::numeric > 0) then
    return 'Correção não pode consumir caixa já pago ou devolvido.';
  end if;
  return null;
end;
$$;

-- One cut: financial, registration and results builders read the same group revision as the settlement facts.
create function private.settlement_snapshot(p_group uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('groupId',g.id,'groupRevision',g.revision,
    'financial',private.finance_snapshot(p_group),'registration',private.registration_snapshot(p_group),'results',private.result_snapshot(p_group),
    'expenses',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'groupId',e.group_id,'poolId',e.pool_id,'version',e.version,'groupRevision',e.group_revision,
      'poolVersion',e.pool_version,'confirmedAt',private.utc_json(e.confirmed_at),'receiptId',e.receipt_id,'manifestId',e.manifest_id,'registrationReportId',e.registration_report_id,
      'supersedesId',e.supersedes_id,'betCostCents',e.bet_cost_cents::text,'feeCents',e.fee_cents::text,'totalCostCents',e.total_cost_cents::text,
      'evidenceIds',e.evidence_ids,'sourceReference',e.source_reference,'reason',e.reason) order by e.pool_id,e.version)
      from public.settlement_expenses e where e.group_id = p_group),'[]'::jsonb),
    'prizes',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'groupId',p.group_id,'poolId',p.pool_id,'version',p.version,'groupRevision',p.group_revision,
      'poolVersion',p.pool_version,'confirmedAt',private.utc_json(p.confirmed_at),'receiptId',p.receipt_id,'manifestId',p.manifest_id,'registrationReportId',p.registration_report_id,
      'resultId',p.result_id,'observedResultIds',p.observed_result_ids,'resultSelectionId',p.result_selection_id,'supersedesId',p.supersedes_id,
      'calculatedPrizeCents',p.calculated_prize_cents::text,'amountCents',p.amount_cents::text,'officialEntitlements',p.official_entitlements,'rights',p.rights,
      'evidenceIds',p.evidence_ids,'sourceReference',p.source_reference,'reason',p.reason,'redemptionDeadline',p.redemption_deadline) order by p.pool_id,p.version)
      from public.settlement_prizes p where p.group_id = p_group),'[]'::jsonb),
    'redemptions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'groupId',r.group_id,'poolId',r.pool_id,'version',r.version,'groupRevision',r.group_revision,
      'poolVersion',r.pool_version,'confirmedAt',private.utc_json(r.confirmed_at),'receiptId',r.receipt_id,'prizeConfirmationId',r.prize_confirmation_id,'personId',r.person_id,
      'ownership',r.ownership,'direction',r.direction,'reversesId',r.reverses_id,'amountCents',r.amount_cents::text,'evidenceIds',r.evidence_ids,
      'sourceReference',r.source_reference,'eventAt',private.utc_json(r.event_at),'reason',r.reason) order by r.pool_id,r.version)
      from public.settlement_redemptions r where r.group_id = p_group),'[]'::jsonb),
    'distributions',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'groupId',d.group_id,'poolId',d.pool_id,'version',d.version,'groupRevision',d.group_revision,
      'poolVersion',d.pool_version,'confirmedAt',private.utc_json(d.confirmed_at),'receiptId',d.receipt_id,'personId',d.person_id,'kind',d.kind,'direction',d.direction,
      'reversesId',d.reverses_id,'amountCents',d.amount_cents::text,'evidenceIds',d.evidence_ids,'sourceReference',d.source_reference,
      'eventAt',private.utc_json(d.event_at),'reason',d.reason) order by d.pool_id,d.version)
      from public.settlement_distributions d where d.group_id = p_group),'[]'::jsonb),
    'closures',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'groupId',c.group_id,'poolId',c.pool_id,'version',c.version,'groupRevision',c.group_revision,
      'poolVersion',c.pool_version,'confirmedAt',private.utc_json(c.confirmed_at),'receiptId',c.receipt_id,'direction',c.direction,'previousClosureId',c.previous_closure_id,
      'registrationReportId',c.registration_report_id,'prizeConfirmationId',c.prize_confirmation_id,'expenseConfirmationId',c.expense_confirmation_id,
      'observedResultIds',c.observed_result_ids,'resultSelectionId',c.result_selection_id,'leftoverDisposition',c.leftover_disposition,'reconciliation',c.reconciliation,
      'pendingExplanation',c.pending_explanation,'reason',c.reason) order by c.pool_id,c.version)
      from public.settlement_closures c where c.group_id = p_group),'[]'::jsonb))
  from public.groups g where g.id = p_group;
$$;
create function public.settlement_pull(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  -- Every writer holds this key exclusively, so the shared lock keeps all source families at one revision.
  perform pg_advisory_xact_lock_shared(hashtextextended('group:' || p_group_id::text,0));
  return private.settlement_snapshot(p_group_id);
end;
$$;
create function public.settlement_command_status(p_idempotency_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_saved public.settlement_command_receipts;
begin
  perform private.require_human();
  select * into v_saved from public.settlement_command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return v_saved.response_payload;
end;
$$;

create function public.settlement_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid(); v_fact_id uuid := gen_random_uuid();
  v_saved public.settlement_command_receipts; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_redemption public.settlement_redemptions; v_distribution public.settlement_distributions; v_action jsonb; v_type text; v_rights jsonb; v_current jsonb;
  v_error text; v_status text := 'accepted'; v_revision bigint; v_version bigint; v_now timestamptz; v_result jsonb; v_count bigint;
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
  if v_type in ('pool_settle','pool_reopen') then v_error := 'Encerramento e reabertura ainda não estão disponíveis.';
  elsif (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de decidir a apuração.';
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
        v_current := private.settlement_current_result(v_group,v_pool_id);
        v_rights := private.settlement_prize_rights(v_manifest.content,v_report.items,(v_action ->> 'amountCents')::numeric,v_action -> 'officialEntitlements');
        insert into public.settlement_prizes(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,manifest_id,registration_report_id,result_id,
          observed_result_ids,result_selection_id,supersedes_id,calculated_prize_cents,amount_cents,official_entitlements,rights,evidence_ids,source_reference,reason,redemption_deadline)
          values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_manifest.id,(v_action ->> 'registrationReportId')::uuid,(v_action ->> 'resultId')::uuid,
            (select coalesce(jsonb_agg(to_jsonb(r.id::text) order by r.version),'[]'::jsonb) from public.contest_result_versions r where r.group_id = v_group and r.pool_id = v_pool_id),
            (select s.id from public.result_selections s where s.group_id = v_group and s.pool_id = v_pool_id order by s.version desc limit 1),
            (v_action ->> 'supersedesId')::uuid,private.settlement_calculated_prize(v_report.items,v_current),(v_action ->> 'amountCents')::bigint,
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

alter table public.settlement_command_receipts enable row level security;
create policy settlement_receipts_read_self on public.settlement_command_receipts for select to authenticated using (actor_id = auth.uid() and private.can_manage_group(group_id));
do $$ declare v_table text; begin
  foreach v_table in array array['settlement_expenses','settlement_prizes','settlement_redemptions','settlement_distributions','settlement_closures'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('create policy %I on public.%I for select to authenticated using (private.can_manage_group(group_id))',v_table || '_read_organizer',v_table);
  end loop;
end; $$;
revoke all on public.settlement_command_receipts,public.settlement_expenses,public.settlement_prizes,public.settlement_redemptions,public.settlement_distributions,
  public.settlement_closures from anon,authenticated;
grant select on public.settlement_command_receipts,public.settlement_expenses,public.settlement_prizes,public.settlement_redemptions,public.settlement_distributions,
  public.settlement_closures to authenticated;
revoke all on function private.settlement_text(jsonb,boolean),private.settlement_time(jsonb),private.settlement_ids_valid(jsonb,integer),private.settlement_ids(jsonb),
  private.settlement_lottery_url(text),private.settlement_deadline_valid(jsonb),private.settlement_entitlements_valid(jsonb),private.settlement_entitlements(jsonb),
  private.settlement_action_error(jsonb),private.settlement_results_incompatible(jsonb,jsonb),private.settlement_result_information(jsonb),
  private.settlement_eligible_results(uuid,uuid),private.settlement_current_result(uuid,uuid),private.settlement_choose(integer,integer),
  private.settlement_calculated_prize(jsonb,jsonb),private.settlement_split(numeric,jsonb),private.settlement_prize_rights(jsonb,jsonb,numeric,jsonb),
  private.settlement_pool_balance(uuid,uuid),private.settlement_group_cash(uuid),private.settlement_proof_error(uuid,uuid,jsonb,timestamptz,boolean),
  private.settlement_action_guard(uuid,jsonb,timestamptz),private.settlement_balance_error(uuid,uuid),private.settlement_snapshot(uuid) from public,anon,authenticated;
revoke all on function public.settlement_pull(uuid),public.settlement_command_status(uuid),public.settlement_decide(jsonb) from public,anon;
grant execute on function public.settlement_pull(uuid),public.settlement_command_status(uuid),public.settlement_decide(jsonb) to authenticated;
