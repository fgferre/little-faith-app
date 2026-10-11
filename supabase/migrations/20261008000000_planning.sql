-- Human-only plans and pool manifests. Prior migrations remain unchanged.
-- Canonical JSON for this domain: sorted ASCII keys, ordered arrays, safe integers and strings.
create function private.canonical_json(p_value jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_result text; v_number numeric;
begin
  case jsonb_typeof(p_value)
  when 'object' then
    if exists (select 1 from jsonb_object_keys(p_value) k where k !~ '^[ -~]*$') then
      raise exception 'manifest_keys_must_be_ascii' using errcode = '22023';
    end if;
    select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || private.canonical_json(value),',' order by key collate "C"),'') || '}'
      into v_result from jsonb_each(p_value);
    return v_result;
  when 'array' then
    select '[' || coalesce(string_agg(private.canonical_json(value),',' order by ordinality),'') || ']'
      into v_result from jsonb_array_elements(p_value) with ordinality;
    return v_result;
  when 'number' then
    v_number := (p_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) or v_number not between -9007199254740991 and 9007199254740991 then
      raise exception 'manifest_number_must_be_safe_integer' using errcode = '22023';
    end if;
    return trunc(v_number)::text;
  when 'string','boolean','null' then return p_value::text;
  else raise exception 'manifest_value_invalid' using errcode = '22023';
  end case;
end;
$$;
revoke all on function private.canonical_json(jsonb) from public,anon,authenticated;

create table public.planning_command_receipts (
  id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  group_id uuid not null references public.groups(id) on delete restrict,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null,
  unique (actor_id,idempotency_key)
);

create table public.pool_plan_versions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  prepared_plan jsonb not null check (jsonb_typeof(prepared_plan) = 'object'),
  budget_cents bigint not null check (budget_cents between 1 and 9007199254740991),
  total_cost_cents bigint not null check (total_cost_cents between 1 and 9007199254740991 and total_cost_cents <= budget_cents),
  applied_at timestamptz not null,
  receipt_id uuid not null references public.planning_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  unique (group_id,pool_id,version),
  unique (group_id,pool_id,id)
);

create table public.pool_manifests (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  applied_plan_id uuid not null,
  previous_manifest_id uuid references public.pool_manifests(id) on delete restrict,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  canonical text not null check (canonical = private.canonical_json(content)),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$' and sha256 = encode(sha256(convert_to(canonical,'UTF8')),'hex')),
  locked_at timestamptz not null,
  receipt_id uuid not null references public.planning_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id,applied_plan_id) references public.pool_plan_versions(group_id,pool_id,id) on delete restrict,
  unique (group_id,pool_id,version)
);
create index pool_manifests_pool_idx on public.pool_manifests(group_id,pool_id,version desc);

create trigger planning_receipts_append_only before update or delete on public.planning_command_receipts for each row execute function private.prevent_mutation();
create trigger pool_plans_append_only before update or delete on public.pool_plan_versions for each row execute function private.prevent_mutation();
create trigger pool_manifests_append_only before update or delete on public.pool_manifests for each row execute function private.prevent_mutation();

create function private.planning_snapshot(p_group_id uuid) returns jsonb
language sql set search_path = '' as $$
  select jsonb_build_object('groupId',g.id,'groupRevision',g.revision,
    'appliedPlans',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'groupId',p.group_id,'poolId',p.pool_id,'version',p.version,'plan',p.prepared_plan,
      'appliedAt',private.utc_json(p.applied_at),'receiptId',p.receipt_id) order by p.applied_at,p.pool_id,p.version)
      from public.pool_plan_versions p where p.group_id = g.id),'[]'::jsonb),
    'manifests',coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'groupId',m.group_id,'poolId',m.pool_id,'version',m.version,'appliedPlanId',m.applied_plan_id,
      'content',m.content,'canonical',m.canonical,'sha256',m.sha256,'lockedAt',private.utc_json(m.locked_at),'receiptId',m.receipt_id)
      order by m.locked_at,m.pool_id,m.version) from public.pool_manifests m where m.group_id = g.id),'[]'::jsonb))
  from public.groups g where g.id = p_group_id;
$$;

create function public.plan_pull(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return private.planning_snapshot(p_group_id);
end;
$$;

create function public.plan_command_status(p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_receipt public.planning_command_receipts;
begin
  perform private.require_human();
  select * into v_receipt from public.planning_command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if not private.can_manage_group(v_receipt.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return v_receipt.response_payload;
end;
$$;

create function private.pool_funding(p_group uuid,p_pool uuid) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(amount_cents),0) from public.financial_movements
  where group_id = p_group and pool_id = p_pool and kind in ('payment-allocated','allocation-reversed');
$$;

create function private.pool_commitment(p_group uuid,p_pool uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce((select budget_cents from public.pool_plan_versions where group_id = p_group and pool_id = p_pool order by version desc limit 1),0);
$$;

create table public.lottery_pool_catalog_rules (
  catalog_version text not null,
  lottery_id text not null check (lottery_id in ('mega-sena','lotofacil','quina')),
  number_count integer not null,
  elementary_combinations bigint not null check (elementary_combinations > 0),
  simple_price_cents integer not null check (simple_price_cents > 0),
  min_quotas integer not null,
  max_quotas integer not null check (max_quotas >= min_quotas),
  min_quota_cents bigint not null check (min_quota_cents > 0),
  min_pool_cents bigint not null check (min_pool_cents > 0),
  max_pool_cents bigint not null check (max_pool_cents >= min_pool_cents),
  max_games_per_receipt integer not null check (max_games_per_receipt between 1 and 10),
  verified_at date not null,
  source_url text not null,
  primary key (catalog_version,lottery_id,number_count)
);
create trigger planning_catalog_append_only before update or delete on public.lottery_pool_catalog_rules for each row execute function private.prevent_mutation();

insert into public.lottery_pool_catalog_rules(catalog_version,lottery_id,number_count,elementary_combinations,simple_price_cents,
  min_quotas,max_quotas,min_quota_cents,min_pool_cents,max_pool_cents,max_games_per_receipt,verified_at,source_url)
select 'caixa-pools-2026-10-08-v1','mega-sena',n,combinations,600,min_q,max_q,min_quota,min_pool,max_pool,max_games,'2026-10-08'::date,
  'https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx'
from (values (6,1,2,8,700,1800,6000,10),(7,7,2,50,800,4200,42000,10),(8,28,2,100,800,16800,168000,10),
  (9,84,2,100,800,50400,504000,10),(10,210,2,100,1260,126000,1260000,10),(11,462,2,100,2772,277200,2772000,10),
  (12,924,2,100,5544,554400,5544000,10),(13,1716,2,100,10296,1029600,10296000,10),
  (14,3003,2,100,18018,1801800,18018000,10),(15,5005,2,100,30030,3003000,21021000,7),
  (16,8008,2,100,48048,4804800,19219200,4),(17,12376,2,100,74256,7425600,22276800,3),
  (18,18564,2,100,111384,11138400,22276800,2),(19,27132,2,100,162792,16279200,16279200,1),
  (20,38760,2,100,232560,23256000,23256000,1)) r(n,combinations,min_q,max_q,min_quota,min_pool,max_pool,max_games);
insert into public.lottery_pool_catalog_rules(catalog_version,lottery_id,number_count,elementary_combinations,simple_price_cents,
  min_quotas,max_quotas,min_quota_cents,min_pool_cents,max_pool_cents,max_games_per_receipt,verified_at,source_url)
select 'caixa-pools-2026-10-08-v1','lotofacil',n,combinations,350,min_q,max_q,min_quota,min_pool,max_pool,max_games,'2026-10-08'::date,
  'https://loterias.caixa.gov.br/Paginas/Lotofacil.aspx'
from (values (15,1,2,7,450,1400,3500,10),(16,16,2,35,450,5600,56000,10),(17,136,2,40,1190,47600,476000,10),
  (18,816,2,50,5712,285600,2856000,10),(19,3876,2,85,15960,1356600,12209400,9),
  (20,15504,2,100,54264,5426400,21705600,4)) r(n,combinations,min_q,max_q,min_quota,min_pool,max_pool,max_games);
insert into public.lottery_pool_catalog_rules(catalog_version,lottery_id,number_count,elementary_combinations,simple_price_cents,
  min_quotas,max_quotas,min_quota_cents,min_pool_cents,max_pool_cents,max_games_per_receipt,verified_at,source_url)
select 'caixa-pools-2026-10-08-v1','quina',n,combinations,300,min_q,max_q,min_quota,min_pool,max_pool,max_games,'2026-10-08'::date,
  'https://loterias.caixa.gov.br/Paginas/Quina.aspx'
from (values (5,1,2,7,400,1500,3000,10),(6,6,2,25,400,1800,18000,10),(7,21,2,50,400,6300,63000,10),
  (8,56,2,50,400,16800,168000,10),(9,126,2,50,756,37800,378000,10),(10,252,2,50,1512,75600,756000,10),
  (11,462,2,50,2772,138600,1386000,10),(12,792,2,50,4752,237600,2376000,10),
  (13,1287,2,50,7722,386100,3861000,10),(14,2002,2,50,12012,600600,6006000,10),
  (15,3003,2,50,18018,900900,9009000,10)) r(n,combinations,min_q,max_q,min_quota,min_pool,max_pool,max_games);

create function private.planning_catalog_json(p_lottery text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('lotteryId',r.lottery_id,'version',r.catalog_version,'verifiedAt',r.verified_at::text,
    'sourceUrl',r.source_url,'maxLotteryServiceFeeBasisPoints',3500,
    'rules',(select jsonb_object_agg(number_count::text,jsonb_build_object('numberCount',number_count,
      'elementaryCombinations',elementary_combinations::text,'betPriceCents',(elementary_combinations * simple_price_cents)::text,
      'minQuotas',min_quotas,'maxQuotas',max_quotas,'minQuotaCents',min_quota_cents::text,'minPoolCents',min_pool_cents::text,
      'maxPoolCents',max_pool_cents::text,'maxGamesPerReceipt',max_games_per_receipt))
      from public.lottery_pool_catalog_rules where catalog_version = r.catalog_version and lottery_id = r.lottery_id))
  from public.lottery_pool_catalog_rules r where r.catalog_version = 'caixa-pools-2026-10-08-v1' and r.lottery_id = p_lottery limit 1;
$$;

create function private.prepared_plan_error(p_plan jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_item jsonb; v_bet jsonb; v_ticket jsonb; v_assignment jsonb; v_right jsonb; v_key jsonb;
  v_rule public.lottery_pool_catalog_rules; v_total numeric := 0; v_ticket_cost numeric; v_units numeric;
  v_universe integer; v_min integer; v_max integer; v_count integer; v_seen text[] := '{}';
begin
  if private.exact_keys(p_plan,array['id','groupId','poolId','poolVersion','groupRevision','lotteryId','contestNumber',
    'participationMode','strategy','seed','catalogVersion','sourceBets','rights','budgetCents','betCostCents',
    'feeCents','feeLabel','totalCostCents','leftoverCents','leftoverPolicy','bets','tickets','explanation']) is not true
    or not private.json_uuid(p_plan -> 'id') or not private.json_uuid(p_plan -> 'groupId') or not private.json_uuid(p_plan -> 'poolId')
    or not private.json_integer(p_plan -> 'poolVersion',1,9007199254740991) or not private.json_integer(p_plan -> 'groupRevision',0,9007199254740991)
    or not private.json_integer(p_plan -> 'contestNumber',1,999999)
    or (p_plan ->> 'participationMode' in ('internal','official')) is not true
    or (p_plan ->> 'strategy' in ('spread','balanced','concentrated')) is not true
    or (jsonb_typeof(p_plan -> 'seed') = 'string' and p_plan ->> 'seed' ~* '^[0-9a-f]{64}$') is not true
    or (p_plan ->> 'catalogVersion' = 'caixa-pools-2026-10-08-v1') is not true
    or not private.json_money(p_plan -> 'budgetCents',true) or not private.json_money(p_plan -> 'betCostCents',true)
    or not private.json_money(p_plan -> 'feeCents') or not private.json_money(p_plan -> 'totalCostCents',true)
    or not private.json_money(p_plan -> 'leftoverCents') or not private.json_text(p_plan -> 'feeLabel',200)
    or not private.json_text(p_plan -> 'explanation',2000,true) or private.js_trim(p_plan ->> 'explanation') = ''
    or (p_plan ->> 'leftoverPolicy' in ('unassigned','refund-pro-rata','group-credit')) is not true
    or jsonb_typeof(p_plan -> 'sourceBets') is distinct from 'array' or jsonb_typeof(p_plan -> 'rights') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'bets') is distinct from 'array' or jsonb_typeof(p_plan -> 'tickets') is distinct from 'array' then
    return 'Plano inválido ou catálogo não vigente; gere e revise novamente.';
  end if;
  if (p_plan ->> 'feeCents')::numeric > 0 and private.js_trim(p_plan ->> 'feeLabel') = '' then return 'Descreva a taxa externa do plano.'; end if;
  if (p_plan ->> 'betCostCents')::numeric + (p_plan ->> 'feeCents')::numeric <> (p_plan ->> 'totalCostCents')::numeric
    or (p_plan ->> 'totalCostCents')::numeric + (p_plan ->> 'leftoverCents')::numeric <> (p_plan ->> 'budgetCents')::numeric then
    return 'Custos, taxas e sobra não reconciliam com o orçamento.';
  end if;
  case p_plan ->> 'lotteryId'
    when 'mega-sena' then v_min := 6; v_max := 20; v_universe := 60;
    when 'lotofacil' then v_min := 15; v_max := 20; v_universe := 25;
    when 'quina' then v_min := 5; v_max := 15; v_universe := 80;
    else return 'Modalidade inválida.';
  end case;
  if jsonb_array_length(p_plan -> 'sourceBets') > 1000 or jsonb_array_length(p_plan -> 'rights') not between 1 and 200
    or jsonb_array_length(p_plan -> 'bets') not between 1 and 1000 or jsonb_array_length(p_plan -> 'tickets') not between 1 and 1000 then
    return 'O plano precisa de direitos, jogos e cartelas dentro dos limites operacionais.';
  end if;
  for v_item in select value from jsonb_array_elements(p_plan -> 'sourceBets') loop
    if private.exact_keys(v_item,array['id','version']) is not true or not private.json_uuid(v_item -> 'id')
      or not private.json_integer(v_item -> 'version',1,9007199254740991) then return 'Origem dos jogos inválida.'; end if;
  end loop;
  if (select count(*) <> count(distinct (value ->> 'id')::uuid) from jsonb_array_elements(p_plan -> 'sourceBets')) then return 'Jogo de origem repetido.'; end if;
  for v_right in select value from jsonb_array_elements(p_plan -> 'rights') loop
    if private.exact_keys(v_right,array['quotaId','sourceQuotaId','sourceQuotaVersion','personId','units','dueCents','statuteId']) is not true
      or not private.json_uuid(v_right -> 'quotaId') or not private.json_uuid(v_right -> 'sourceQuotaId')
      or not private.json_uuid(v_right -> 'personId') or not private.json_uuid(v_right -> 'statuteId')
      or not private.json_integer(v_right -> 'sourceQuotaVersion',1,9007199254740991)
      or not private.json_integer(v_right -> 'units',1,1000000) or not private.json_money(v_right -> 'dueCents',true) then return 'Direito confirmado inválido.'; end if;
  end loop;
  if (select count(*) <> count(distinct (value ->> 'quotaId')::uuid) or count(*) <> count(distinct (value ->> 'personId')::uuid)
    or count(*) <> count(distinct (value ->> 'sourceQuotaId')::uuid)
    from jsonb_array_elements(p_plan -> 'rights')) then return 'Direitos repetidos por pessoa ou cota.'; end if;
  if (select sum((value ->> 'dueCents')::numeric) from jsonb_array_elements(p_plan -> 'rights')) <> (p_plan ->> 'budgetCents')::numeric then
    return 'O orçamento precisa corresponder ao custo dos direitos confirmados.';
  end if;
  select sum((value ->> 'units')::numeric) into v_units from jsonb_array_elements(p_plan -> 'rights');
  for v_bet in select value from jsonb_array_elements(p_plan -> 'bets') loop
    if private.exact_keys(v_bet,array['key','sourceBetId','sourceBetVersion','numbers','authorIds','seed','generationAlgorithmVersion']) is not true
      or (jsonb_typeof(v_bet -> 'key') = 'string' and v_bet ->> 'key' ~ '^[A-Za-z0-9_-]{1,80}$') is not true or jsonb_typeof(v_bet -> 'numbers') is distinct from 'array'
      or jsonb_typeof(v_bet -> 'authorIds') is distinct from 'array'
      or (v_bet -> 'sourceBetId' = 'null'::jsonb and v_bet -> 'sourceBetVersion' <> 'null'::jsonb)
      or (v_bet -> 'sourceBetId' <> 'null'::jsonb and (not private.json_uuid(v_bet -> 'sourceBetId') or not private.json_integer(v_bet -> 'sourceBetVersion',1,9007199254740991)))
      or (v_bet -> 'seed' <> 'null'::jsonb and (jsonb_typeof(v_bet -> 'seed') <> 'string' or v_bet ->> 'seed' !~* '^[0-9a-f]{64}$'
        or (v_bet ->> 'generationAlgorithmVersion' = 'chacha20-lexicographic-rank-v1') is not true))
      or (v_bet -> 'seed' = 'null'::jsonb and v_bet -> 'generationAlgorithmVersion' <> 'null'::jsonb)
      then return 'Jogo do plano inválido.'; end if;
    if v_bet -> 'sourceBetId' = 'null'::jsonb and (v_bet -> 'seed' = 'null'::jsonb
      or lower(v_bet ->> 'seed') <> lower(p_plan ->> 'seed') or jsonb_array_length(v_bet -> 'authorIds') <> 0) then
      return 'Jogo gerado exige a semente do plano e não cria autoria ou direitos.';
    end if;
    if jsonb_array_length(v_bet -> 'numbers') not between v_min and v_max or jsonb_array_length(v_bet -> 'authorIds') > 200 then return 'Quantidade de números ou autores inválida.'; end if;
    for v_item in select value from jsonb_array_elements(v_bet -> 'numbers') loop
      if not private.json_integer(v_item,1,v_universe) then return 'Dezena fora do intervalo.'; end if;
    end loop;
    if (select count(*) <> count(distinct (value #>> '{}')::integer) from jsonb_array_elements(v_bet -> 'numbers'))
      or (select jsonb_agg((value #>> '{}')::integer order by (value #>> '{}')::integer) from jsonb_array_elements(v_bet -> 'numbers')) <> v_bet -> 'numbers' then
      return 'As dezenas precisam ser únicas e ordenadas.';
    end if;
    for v_item in select value from jsonb_array_elements(v_bet -> 'authorIds') loop
      if not private.json_uuid(v_item) then return 'Autor inválido.'; end if;
    end loop;
    if (select count(*) <> count(distinct (value #>> '{}')::uuid) from jsonb_array_elements(v_bet -> 'authorIds')) then return 'Autor repetido.'; end if;
    select * into v_rule from public.lottery_pool_catalog_rules where catalog_version = p_plan ->> 'catalogVersion'
      and lottery_id = p_plan ->> 'lotteryId' and number_count = jsonb_array_length(v_bet -> 'numbers');
    if not found then return 'Regras de preço indisponíveis para este jogo.'; end if;
    v_total := v_total + v_rule.elementary_combinations * v_rule.simple_price_cents;
  end loop;
  if v_total <> (p_plan ->> 'betCostCents')::numeric then return 'O custo dos jogos diverge dos preços do catálogo.'; end if;
  if (select count(*) <> count(distinct value ->> 'key') or count(*) <> count(distinct value -> 'numbers') from jsonb_array_elements(p_plan -> 'bets')) then return 'Chaves ou jogos repetidos no plano.'; end if;
  if (select count(*) <> count(distinct value ->> 'sourceBetId') from jsonb_array_elements(p_plan -> 'bets') where value -> 'sourceBetId' <> 'null'::jsonb) then return 'Jogo fixo incluído duas vezes.'; end if;
  for v_ticket in select value from jsonb_array_elements(p_plan -> 'tickets') loop
    if private.exact_keys(v_ticket,array['key','numberCount','betKeys','betCostCents','officialQuotaCount','officialQuotaValueCents','assignments']) is not true
      or (jsonb_typeof(v_ticket -> 'key') = 'string' and v_ticket ->> 'key' ~ '^[A-Za-z0-9_-]{1,80}$') is not true or not private.json_integer(v_ticket -> 'numberCount',v_min,v_max)
      or not private.json_money(v_ticket -> 'betCostCents',true) or jsonb_typeof(v_ticket -> 'betKeys') is distinct from 'array'
      or jsonb_typeof(v_ticket -> 'assignments') is distinct from 'array' or jsonb_array_length(v_ticket -> 'betKeys') not between 1 and 10 then return 'Cartela inválida.'; end if;
    v_ticket_cost := 0;
    for v_key in select value from jsonb_array_elements(v_ticket -> 'betKeys') loop
      if (jsonb_typeof(v_key) = 'string' and v_key #>> '{}' ~ '^[A-Za-z0-9_-]{1,80}$') is not true or (v_key #>> '{}') = any(v_seen) then return 'Cada jogo deve aparecer exatamente uma vez nas cartelas.'; end if;
      select value into v_bet from jsonb_array_elements(p_plan -> 'bets') where value -> 'key' = v_key;
      if not found or jsonb_array_length(v_bet -> 'numbers') <> (v_ticket ->> 'numberCount')::integer then return 'Jogo ausente ou cartela com quantidades diferentes de dezenas.'; end if;
      v_seen := array_append(v_seen,v_key #>> '{}');
      select * into v_rule from public.lottery_pool_catalog_rules where catalog_version = p_plan ->> 'catalogVersion'
        and lottery_id = p_plan ->> 'lotteryId' and number_count = (v_ticket ->> 'numberCount')::integer;
      v_ticket_cost := v_ticket_cost + v_rule.elementary_combinations * v_rule.simple_price_cents;
    end loop;
    if v_ticket_cost <> (v_ticket ->> 'betCostCents')::numeric then return 'O custo da cartela diverge dos jogos.'; end if;
    if p_plan ->> 'participationMode' = 'internal' then
      if jsonb_array_length(v_ticket -> 'betKeys') <> 1 or v_ticket -> 'officialQuotaCount' <> 'null'::jsonb
        or v_ticket -> 'officialQuotaValueCents' <> 'null'::jsonb or jsonb_array_length(v_ticket -> 'assignments') <> 0 then
        return 'Acordo interno não emite cotas ou recibos oficiais.';
      end if;
    else
      if not private.json_integer(v_ticket -> 'officialQuotaCount',v_rule.min_quotas,v_rule.max_quotas)
        or not private.json_money(v_ticket -> 'officialQuotaValueCents',true) then return 'Quantidade ou valor de cotas oficiais inválidos.'; end if;
      v_count := (v_ticket ->> 'officialQuotaCount')::integer;
      if jsonb_array_length(v_ticket -> 'betKeys') > v_rule.max_games_per_receipt or v_ticket_cost not between v_rule.min_pool_cents and v_rule.max_pool_cents
        or v_ticket_cost % v_count <> 0 or v_ticket_cost / v_count < v_rule.min_quota_cents
        or v_ticket_cost / v_count <> (v_ticket ->> 'officialQuotaValueCents')::numeric then return 'Cartela fora dos limites oficiais ou com fração de centavo.'; end if;
      if jsonb_array_length(v_ticket -> 'assignments') <> jsonb_array_length(p_plan -> 'rights') then return 'Correspondência incompleta de direitos oficiais.'; end if;
      for v_assignment in select value from jsonb_array_elements(v_ticket -> 'assignments') loop
        if private.exact_keys(v_assignment,array['quotaId','personId','officialQuotas']) is not true
          or not private.json_uuid(v_assignment -> 'quotaId') or not private.json_uuid(v_assignment -> 'personId')
          or not private.json_integer(v_assignment -> 'officialQuotas',1,v_count) then return 'Correspondência oficial inválida.'; end if;
        select value into v_right from jsonb_array_elements(p_plan -> 'rights') where (value ->> 'quotaId')::uuid = (v_assignment ->> 'quotaId')::uuid;
        if not found or (v_right ->> 'personId')::uuid <> (v_assignment ->> 'personId')::uuid
          or (v_assignment ->> 'officialQuotas')::numeric * v_units <> v_count * (v_right ->> 'units')::numeric then return 'A cota oficial altera o direito econômico do participante.'; end if;
      end loop;
      if (select count(*) <> count(distinct (value ->> 'quotaId')::uuid) from jsonb_array_elements(v_ticket -> 'assignments')) then return 'Correspondência de cota oficial repetida.'; end if;
    end if;
  end loop;
  if cardinality(v_seen) <> jsonb_array_length(p_plan -> 'bets') then return 'Há jogo do plano fora das cartelas.'; end if;
  if (select count(*) <> count(distinct value ->> 'key') from jsonb_array_elements(p_plan -> 'tickets')) then return 'Chave de cartela repetida.'; end if;
  return null;
end;
$$;

create function private.normalize_prepared_plan(p_plan jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_plan jsonb := p_plan; v_right jsonb; v_bet jsonb; v_ticket jsonb; v_field text;
  v_rights jsonb := '[]'; v_bets jsonb := '[]'; v_tickets jsonb := '[]'; v_values jsonb;
begin
  foreach v_field in array array['id','groupId','poolId','seed'] loop
    v_plan := jsonb_set(v_plan,array[v_field],to_jsonb(lower(v_plan ->> v_field)));
  end loop;
  select coalesce(jsonb_agg(jsonb_set(value,'{id}',to_jsonb(lower(value ->> 'id'))) order by ordinality),'[]'::jsonb)
    into v_values from jsonb_array_elements(v_plan -> 'sourceBets') with ordinality;
  v_plan := jsonb_set(v_plan,'{sourceBets}',v_values);
  for v_right in select value from jsonb_array_elements(v_plan -> 'rights') loop
    foreach v_field in array array['quotaId','sourceQuotaId','personId','statuteId'] loop
      v_right := jsonb_set(v_right,array[v_field],to_jsonb(lower(v_right ->> v_field)));
    end loop;
    v_rights := v_rights || jsonb_build_array(v_right);
  end loop;
  for v_bet in select value from jsonb_array_elements(v_plan -> 'bets') loop
    if v_bet -> 'sourceBetId' <> 'null'::jsonb then v_bet := jsonb_set(v_bet,'{sourceBetId}',to_jsonb(lower(v_bet ->> 'sourceBetId'))); end if;
    if v_bet -> 'seed' <> 'null'::jsonb then v_bet := jsonb_set(v_bet,'{seed}',to_jsonb(lower(v_bet ->> 'seed'))); end if;
    select coalesce(jsonb_agg(to_jsonb(lower(value #>> '{}')) order by ordinality),'[]'::jsonb) into v_values
      from jsonb_array_elements(v_bet -> 'authorIds') with ordinality;
    v_bet := jsonb_set(v_bet,'{authorIds}',v_values);
    v_bets := v_bets || jsonb_build_array(v_bet);
  end loop;
  for v_ticket in select value from jsonb_array_elements(v_plan -> 'tickets') loop
    select coalesce(jsonb_agg(jsonb_set(jsonb_set(value,'{quotaId}',to_jsonb(lower(value ->> 'quotaId'))),
      '{personId}',to_jsonb(lower(value ->> 'personId'))) order by ordinality),'[]'::jsonb) into v_values
      from jsonb_array_elements(v_ticket -> 'assignments') with ordinality;
    v_tickets := v_tickets || jsonb_build_array(jsonb_set(v_ticket,'{assignments}',v_values));
  end loop;
  return jsonb_set(jsonb_set(jsonb_set(v_plan,'{rights}',v_rights),'{bets}',v_bets),'{tickets}',v_tickets);
end;
$$;

create function private.current_plan_error(p_group uuid,p_pool uuid,p_plan jsonb,p_exact_pool_version boolean default true) returns text
language plpgsql set search_path = '' as $$
declare v_pool public.draft_records; v_source public.draft_records; v_quota public.confirmed_quotas;
  v_right jsonb; v_bet jsonb; v_expected jsonb; v_sources jsonb; v_error text; v_first public.pool_manifests;
begin
  v_error := private.prepared_plan_error(p_plan);
  if v_error is not null then return v_error; end if;
  if (p_plan ->> 'groupId')::uuid <> p_group or (p_plan ->> 'poolId')::uuid <> p_pool then return 'O plano pertence a outro grupo ou bolão.'; end if;
  select * into v_pool from public.draft_records where group_id = p_group and id = p_pool and kind = 'pool';
  if not found or v_pool.data ->> 'status' not in ('draft','locked') then return 'O bolão não permite aplicação ou revisão de plano neste estado.'; end if;
  if p_exact_pool_version and v_pool.version <> (p_plan ->> 'poolVersion')::bigint then return 'A versão do bolão mudou; gere e revise o plano novamente.'; end if;
  if (p_plan ->> 'poolVersion')::bigint > v_pool.version then return 'O plano usa uma versão futura do bolão.'; end if;
  if v_pool.data -> 'contestNumber' = 'null'::jsonb or v_pool.data -> 'deadlineAt' = 'null'::jsonb
    or v_pool.data ->> 'participationMode' = 'undecided' then return 'Defina concurso, prazo e tipo de participação antes de aplicar um plano.'; end if;
  if v_pool.data ->> 'lotteryId' <> p_plan ->> 'lotteryId' or v_pool.data -> 'contestNumber' <> p_plan -> 'contestNumber'
    or v_pool.data ->> 'participationMode' <> p_plan ->> 'participationMode' then return 'Modalidade, concurso ou participação divergem do bolão atual.'; end if;
  if clock_timestamp() >= (v_pool.data ->> 'deadlineAt')::timestamptz then return 'O prazo do bolão terminou; o plano ou a trava não foram confirmados.'; end if;
  if private.pool_funding(p_group,p_pool) < (p_plan ->> 'budgetCents')::numeric then return 'O orçamento excede o dinheiro líquido confirmado e alocado neste bolão.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('quotaId',q.id,'sourceQuotaId',q.source_quota_id,
    'sourceQuotaVersion',q.source_quota_version,'personId',q.person_id,'units',q.units,'dueCents',q.due_cents::text,'statuteId',q.statute_id) order by q.id),'[]'::jsonb)
    into v_expected from public.confirmed_quotas q where q.group_id = p_group and q.pool_id = p_pool
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id);
  if v_expected <> (select jsonb_agg(value order by (value ->> 'quotaId')::uuid) from jsonb_array_elements(p_plan -> 'rights')) then
    return 'O plano precisa incluir exatamente todos os direitos confirmados atuais.';
  end if;
  for v_right in select value from jsonb_array_elements(p_plan -> 'rights') loop
    select * into v_quota from public.confirmed_quotas where group_id = p_group and id = (v_right ->> 'quotaId')::uuid;
    select * into v_source from public.draft_records where group_id = p_group and id = v_quota.source_quota_id and kind = 'quota';
    if not found or v_source.version <> v_quota.source_quota_version or (v_source.data ->> 'poolId')::uuid <> p_pool
      or (v_source.data ->> 'personId')::uuid <> v_quota.person_id or (v_source.data ->> 'units')::numeric <> v_quota.units
      then return 'Um direito confirmado diverge da sua cota de origem.'; end if;
    if (v_pool.data ->> 'quotaPriceCents')::numeric * v_quota.units / 100 <> v_quota.due_cents then return 'O preço atual diverge dos direitos confirmados.'; end if;
    if private.person_pool_funding(p_group,v_quota.person_id,p_pool) < v_quota.due_cents then return 'Todos os participantes precisam estar integralmente financiados.'; end if;
    if not exists (select 1 from public.draft_records where group_id = p_group and id = v_quota.person_id
      and kind = 'person' and data -> 'adultDeclared' = 'true'::jsonb) then return 'Todos os participantes precisam ter maioridade declarada.'; end if;
    if not exists (select 1 from public.statute_acceptances where group_id = p_group and person_id = v_quota.person_id and statute_id = v_quota.statute_id)
      then return 'Um direito não possui evidência de aceite do estatuto congelado.'; end if;
    if v_quota.confirmed_at >= (v_pool.data ->> 'deadlineAt')::timestamptz then return 'Uma cota foi confirmada depois do prazo do bolão.'; end if;
  end loop;
  if exists (select 1 from public.draft_records d join public.draft_records p on p.group_id = d.group_id and p.id = (d.data ->> 'personId')::uuid
    where d.group_id = p_group and d.kind = 'quota' and (d.data ->> 'poolId')::uuid = p_pool and p.kind = 'person'
      and p.data -> 'adultDeclared' = 'true'::jsonb and not exists (select 1 from public.confirmed_quotas q where q.group_id = p_group
        and q.pool_id = p_pool and q.source_quota_id = d.id and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id))) then
    return 'Há cotas preparadas elegíveis ainda sem confirmação integral; revise as pendências.';
  end if;
  if exists (select 1 from public.draft_records d where d.group_id = p_group and d.kind = 'payment-proposal'
    and (d.data ->> 'poolId')::uuid = p_pool and d.data ->> 'status' in ('pending','needs-review')
    and not exists (select 1 from public.received_payments p where p.group_id = p_group and p.source_proposal_id = d.id)) then
    return 'Há propostas de pagamento pendentes neste bolão; confirme ou revise antes do plano.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]'::jsonb) into v_sources
    from public.draft_records where group_id = p_group and kind = 'bet' and (data ->> 'poolId')::uuid = p_pool;
  if v_sources <> coalesce((select jsonb_agg(value order by (value ->> 'id')::uuid) from jsonb_array_elements(p_plan -> 'sourceBets')),'[]'::jsonb) then
    return 'O plano precisa preservar todos os jogos sincronizados e suas versões atuais.';
  end if;
  if jsonb_array_length(p_plan -> 'sourceBets') <> (select count(*) from jsonb_array_elements(p_plan -> 'bets') where value -> 'sourceBetId' <> 'null'::jsonb) then
    return 'O plano omite um jogo fixo sincronizado.';
  end if;
  for v_bet in select value from jsonb_array_elements(p_plan -> 'bets') loop
    if v_bet -> 'sourceBetId' <> 'null'::jsonb then
      select * into v_source from public.draft_records where group_id = p_group and id = (v_bet ->> 'sourceBetId')::uuid
        and kind = 'bet' and (data ->> 'poolId')::uuid = p_pool;
      if not found or v_source.version <> (v_bet ->> 'sourceBetVersion')::bigint
        or v_source.data -> 'numbers' <> v_bet -> 'numbers' or v_source.data -> 'authorIds' <> v_bet -> 'authorIds'
        or v_source.data -> 'seed' <> v_bet -> 'seed' or v_source.data -> 'generationAlgorithmVersion' <> v_bet -> 'generationAlgorithmVersion' then
        return 'Um jogo fixo foi alterado, movido ou deixou de corresponder à versão revisada.';
      end if;
    end if;
    if exists (select 1 from jsonb_array_elements(v_bet -> 'authorIds') a where not exists (select 1 from public.draft_records
      where group_id = p_group and id = (a.value #>> '{}')::uuid and kind = 'person')) then return 'Autor não encontrado neste grupo.'; end if;
  end loop;
  select * into v_first from public.pool_manifests where group_id = p_group and pool_id = p_pool order by version limit 1;
  if found then
    if (p_plan -> 'rights') <> v_first.content -> 'plan' -> 'rights' or p_plan -> 'budgetCents' <> v_first.content -> 'plan' -> 'budgetCents' then
      return 'Uma revisão de bolão fechado precisa preservar os direitos e o orçamento inicial.';
    end if;
    if exists (select 1 from jsonb_array_elements(p_plan -> 'bets') b cross join lateral jsonb_array_elements(b.value -> 'authorIds') a
      where not exists (select 1 from jsonb_array_elements(v_first.content -> 'persons') p where (p.value ->> 'id')::uuid = (a.value #>> '{}')::uuid)) then
      return 'Uma revisão não pode acrescentar responsáveis ou autores fora das pessoas congeladas.';
    end if;
  elsif v_pool.data ->> 'status' = 'locked' then return 'Não há manifesto inicial para revisar este bolão; verifique o estado registrado.'; end if;
  return null;
end;
$$;

create function public.planning_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_key uuid; v_group_id uuid; v_pool_id uuid; v_receipt_id uuid := gen_random_uuid();
  v_saved public.planning_command_receipts; v_group public.groups; v_pool public.draft_records;
  v_applied public.pool_plan_versions; v_first public.pool_manifests; v_latest public.pool_manifests;
  v_action jsonb; v_plan jsonb; v_responsible jsonb; v_persons jsonb; v_content jsonb; v_canonical text; v_financial jsonb;
  v_error text; v_status text := 'accepted'; v_revision bigint; v_version bigint; v_now timestamptz;
  v_applied_id uuid; v_event jsonb; v_previous_hash text; v_result jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey')
    or not private.json_uuid(p_command -> 'groupId') or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991)
    then raise exception 'invalid_planning_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group_id := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('planning:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.planning_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group_id,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text,0));
  select * into v_group from public.groups where id = v_group_id for update;
  if not found or not private.can_manage_group(v_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  v_revision := v_group.revision;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then
    v_status := 'conflict'; v_error := 'A revisão do grupo mudou; sincronize e revise o plano novamente.';
  elsif v_revision >= 9007199254740991 then v_error := 'Limite de revisão atingido.'; end if;
  if v_error is null then
    if v_action ->> 'type' = 'plan_apply' then
      if private.exact_keys(v_action,array['type','plan']) is not true then v_error := 'Aplicação de plano inválida.';
      else
        v_plan := v_action -> 'plan';
        v_error := private.prepared_plan_error(v_plan);
        if v_error is null then
          v_plan := private.normalize_prepared_plan(v_plan);
          v_pool_id := (v_plan ->> 'poolId')::uuid;
          select * into v_pool from public.draft_records where group_id = v_group_id and id = v_pool_id and kind = 'pool';
          if not found then v_error := 'Bolão não encontrado neste grupo.';
          elsif (v_plan ->> 'groupRevision')::numeric <> v_revision or (v_plan ->> 'poolVersion')::numeric <> v_pool.version then
            v_status := 'conflict'; v_error := 'A revisão ou versão usada para preparar o plano mudou; gere novamente sem ajustar só a revisão.';
          else v_error := private.current_plan_error(v_group_id,v_pool_id,v_plan); end if;
        end if;
      end if;
    elsif v_action ->> 'type' = 'pool_lock' then
      if private.exact_keys(v_action,array['type','poolId','poolVersion','appliedPlanId','responsible']) is not true
        or not private.json_uuid(v_action -> 'poolId') or not private.json_uuid(v_action -> 'appliedPlanId')
        or not private.json_integer(v_action -> 'poolVersion',1,9007199254740991)
        or private.exact_keys(v_action -> 'responsible',array['registrarPersonId','ticketHolderPersonId']) is not true
        or not private.json_uuid(v_action -> 'responsible' -> 'registrarPersonId')
        or (v_action -> 'responsible' -> 'ticketHolderPersonId' <> 'null'::jsonb and not private.json_uuid(v_action -> 'responsible' -> 'ticketHolderPersonId')) then
        v_error := 'Trava inválida; escolha os responsáveis explicitamente.';
      else
        v_pool_id := (v_action ->> 'poolId')::uuid;
        select * into v_pool from public.draft_records where group_id = v_group_id and id = v_pool_id and kind = 'pool';
        if not found then v_error := 'Bolão não encontrado neste grupo.';
        elsif (v_action ->> 'poolVersion')::numeric <> v_pool.version then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a trava.';
        else
          select * into v_applied from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id and id = (v_action ->> 'appliedPlanId')::uuid;
          if not found then v_error := 'Plano aplicado não encontrado neste bolão.';
          elsif v_applied.version <> (select max(version) from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id) then
            v_error := 'A trava exige a versão mais recente do plano aplicado.';
          else
            v_plan := v_applied.prepared_plan;
            v_error := private.current_plan_error(v_group_id,v_pool_id,v_plan,false);
          end if;
        end if;
        if v_error is null then
          if (v_plan ->> 'leftoverCents')::numeric > 0 and v_plan ->> 'leftoverPolicy' = 'unassigned' then v_error := 'Escolha o destino autorizado da sobra antes da trava.'; end if;
          if not exists (select 1 from public.draft_records where group_id = v_group_id and kind = 'person'
            and id = (v_action -> 'responsible' ->> 'registrarPersonId')::uuid and data -> 'adultDeclared' = 'true'::jsonb) then
            v_error := 'O registrador precisa ser uma pessoa adulta deste grupo.';
          end if;
          if v_plan ->> 'participationMode' = 'internal' then
            if not exists (select 1 from public.draft_records where group_id = v_group_id and kind = 'person'
              and id = (v_action -> 'responsible' ->> 'ticketHolderPersonId')::uuid and data -> 'adultDeclared' = 'true'::jsonb) then
              v_error := 'O acordo interno exige um titular adulto do bilhete neste grupo.';
            end if;
          elsif v_action -> 'responsible' -> 'ticketHolderPersonId' <> 'null'::jsonb then
            v_error := 'No modo oficial, os titulares serão informados pelos recibos; não escolha um titular informal.';
          end if;
          select * into v_first from public.pool_manifests where group_id = v_group_id and pool_id = v_pool_id order by version limit 1;
          select * into v_latest from public.pool_manifests where group_id = v_group_id and pool_id = v_pool_id order by version desc limit 1;
          if v_first.id is not null and (v_first.content -> 'responsible' -> 'registrarPersonId' <> v_action -> 'responsible' -> 'registrarPersonId'
            or v_first.content -> 'responsible' -> 'ticketHolderPersonId' <> v_action -> 'responsible' -> 'ticketHolderPersonId') then
            v_error := 'Uma revisão precisa preservar os responsáveis do manifesto inicial.';
          end if;
        end if;
      end if;
    else v_error := 'Ação de planejamento não suportada.';
    end if;
  end if;
  if v_error is null and v_action ->> 'type' = 'plan_apply' then
    select coalesce(max(version),0)+1 into v_version from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id;
    if v_version > 9007199254740991 or (select count(*) from public.pool_plan_versions where group_id = v_group_id) >= 10000 then v_error := 'Limite de versões de plano atingido.'; end if;
  elsif v_error is null then
    v_version := coalesce(v_latest.version,0)+1;
    if v_version > 9007199254740991 or v_pool.version >= 9007199254740991 or (select count(*) from public.pool_manifests where group_id = v_group_id) >= 10000 then v_error := 'Limite de versões de manifesto ou bolão atingido.'; end if;
  end if;
  v_now := clock_timestamp();
  if v_error is null and v_now >= (v_pool.data ->> 'deadlineAt')::timestamptz then v_error := 'O prazo terminou durante a revisão; a decisão não foi confirmada.'; end if;
  if v_error is not null and v_status = 'accepted' then v_status := 'rejected'; end if;
  if v_status = 'accepted' then
    if v_action ->> 'type' = 'plan_apply' then
      v_applied_id := gen_random_uuid();
      insert into public.pool_plan_versions(id,group_id,pool_id,version,prepared_plan,budget_cents,total_cost_cents,applied_at,receipt_id)
        values(v_applied_id,v_group_id,v_pool_id,v_version,v_plan,(v_plan ->> 'budgetCents')::bigint,(v_plan ->> 'totalCostCents')::bigint,v_now,v_receipt_id);
    else
      update public.draft_records set data = jsonb_set(data,'{status}','"locked"'),version = version+1,updated_at = v_now
        where group_id = v_group_id and id = v_pool_id returning * into v_pool;
      v_financial := case when v_first.id is not null then v_first.content -> 'financial' else private.finance_snapshot(v_group_id) end;
      v_applied_id := v_applied.id;
    end if;
    update public.groups set revision = revision+1 where id = v_group_id returning revision into v_revision;
    if v_action ->> 'type' = 'pool_lock' then
      if v_first.id is not null then
        v_responsible := v_first.content -> 'responsible'; v_persons := v_first.content -> 'persons';
      else
        v_responsible := jsonb_build_object('organizerUserId',v_actor,'registrarPersonId',v_action -> 'responsible' -> 'registrarPersonId',
          'ticketHolderPersonId',v_action -> 'responsible' -> 'ticketHolderPersonId');
        select jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'data',p.data) order by p.id) into v_persons
          from public.draft_records p where p.group_id = v_group_id and p.kind = 'person' and p.id in (
            select (value ->> 'personId')::uuid from jsonb_array_elements(v_plan -> 'rights')
            union select (a.value #>> '{}')::uuid from jsonb_array_elements(v_plan -> 'bets') b cross join lateral jsonb_array_elements(b.value -> 'authorIds') a
            union select (v_responsible ->> 'registrarPersonId')::uuid
            union select (v_responsible ->> 'ticketHolderPersonId')::uuid where v_responsible -> 'ticketHolderPersonId' <> 'null'::jsonb);
      end if;
      v_content := jsonb_build_object('schemaVersion','pool-manifest-v1','responsible',v_responsible,
        'catalog',private.planning_catalog_json(v_plan ->> 'lotteryId'),
        'pool',jsonb_build_object('id',v_pool.id,'version',v_pool.version,'data',jsonb_set(v_pool.data,'{deadlineAt}',to_jsonb(private.utc_json((v_pool.data ->> 'deadlineAt')::timestamptz)))),
        'plan',v_plan,'persons',v_persons,'financial',v_financial);
      v_canonical := private.canonical_json(v_content);
      insert into public.pool_manifests(id,group_id,pool_id,version,applied_plan_id,previous_manifest_id,content,canonical,sha256,locked_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_pool_id,v_version,v_applied_id,v_latest.id,v_content,v_canonical,encode(sha256(convert_to(v_canonical,'UTF8')),'hex'),v_now,v_receipt_id);
    end if;
    insert into public.group_changes(group_id,revision,entity_id,record) values(v_group_id,v_revision,v_pool_id,private.record_json(v_pool));
    select event_hash into v_previous_hash from public.audit_events where group_id = v_group_id order by revision desc limit 1;
    v_previous_hash := coalesce(v_previous_hash,repeat('0',64));
    v_event := jsonb_build_object('action',v_action ->> 'type','groupRevision',v_revision,'poolId',v_pool_id,'version',v_version,
      'actorId',v_actor,'idempotencyKey',v_key,'receiptId',v_receipt_id,'appliedPlanId',v_applied_id);
    insert into public.audit_events(group_id,revision,actor_id,idempotency_key,event,previous_hash,event_hash)
      values(v_group_id,v_revision,v_actor,v_key,v_event,v_previous_hash,encode(sha256(convert_to(v_previous_hash || v_event::text,'UTF8')),'hex'));
  end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt_id else null end,'groupId',v_group_id,'status',v_status,'groupRevision',v_revision,
    'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,'snapshot',private.planning_snapshot(v_group_id));
  insert into public.planning_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt_id,v_actor,v_key,v_group_id,p_command,v_result,v_now);
  return v_result;
end;
$$;

-- Both the draft RPC and its table guard call this shared rule before modifying facts.
create or replace function private.financial_draft_guard_error(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns text
language plpgsql set search_path = '' as $$
declare v_old public.draft_records;
begin
  select * into v_old from public.draft_records where group_id = p_group and id = p_id;
  if p_kind in ('bet','quota','payment-proposal') and exists (
    select 1 from public.draft_records p where p.group_id = p_group and p.kind = 'pool' and p.data ->> 'status' <> 'draft'
      and (p.id = (p_data ->> 'poolId')::uuid or p.id = (v_old.data ->> 'poolId')::uuid)) then
    return 'Os jogos, cotas e propostas de um bolão fechado estão congelados; não podem ser editados ou movidos.';
  end if;
  if p_kind = 'person' and exists (select 1 from public.pool_manifests m cross join lateral jsonb_array_elements(m.content -> 'persons') p
    where m.group_id = p_group and (p.value ->> 'id')::uuid = p_id) and p_data is distinct from v_old.data then
    return 'A pessoa faz parte de um manifesto congelado; seus dados e declaração estão preservados.';
  end if;
  if v_old.id is null then return null; end if;
  if p_kind = 'pool' and v_old.data ->> 'status' <> 'draft' and p_data is distinct from v_old.data then
    return 'Todos os dados do bolão fechado estão congelados; a revisão não reabre o rascunho.';
  end if;
  if p_kind = 'payment-proposal' and exists (select 1 from public.received_payments where group_id = p_group and source_proposal_id = p_id) then
    return 'A proposta já gerou um recebimento e está preservada; use o estorno para corrigir o lançamento.';
  end if;
  if p_kind = 'quota' and exists (select 1 from public.confirmed_quotas q where q.group_id = p_group and q.source_quota_id = p_id
    and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
    return 'Uma cota confirmada ativa não pode ser editada; preserve os direitos já aprovados.';
  end if;
  if p_kind = 'person' and p_data -> 'adultDeclared' is distinct from 'true'::jsonb and exists (
    select 1 from public.confirmed_quotas q where q.group_id = p_group and q.person_id = p_id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
    return 'A declaração de maioridade sustenta uma cota ativa e não pode ser retirada neste estado.';
  end if;
  if p_kind = 'pool' and exists (select 1 from public.confirmed_quotas q where q.group_id = p_group and q.pool_id = p_id
    and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id))
    and (v_old.data -> 'quotaPriceCents' is distinct from p_data -> 'quotaPriceCents'
      or v_old.data -> 'deadlineAt' is distinct from p_data -> 'deadlineAt'
      or v_old.data -> 'lotteryId' is distinct from p_data -> 'lotteryId'
      or (v_old.data -> 'contestNumber' is distinct from p_data -> 'contestNumber'
        and not (v_old.data ->> 'status' = 'draft' and v_old.data -> 'contestNumber' = 'null'::jsonb
          and private.json_integer(p_data -> 'contestNumber',1,9007199254740991)
          and not exists (select 1 from public.pool_plan_versions where group_id = p_group and pool_id = p_id)))
      or (v_old.data -> 'participationMode' is distinct from p_data -> 'participationMode'
        and not (v_old.data ->> 'status' = 'draft' and v_old.data ->> 'participationMode' = 'undecided'
          and p_data ->> 'participationMode' in ('internal','official')
          and not exists (select 1 from public.pool_plan_versions where group_id = p_group and pool_id = p_id)))) then
    return 'Preço, prazo, modalidade, concurso e tipo de participação estão vinculados a cotas confirmadas ativas.';
  end if;
  return null;
end;
$$;

create or replace function private.guard_financial_drafts() returns trigger
language plpgsql set search_path = '' as $$
declare v_error text;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.group_id is distinct from old.group_id or new.kind is distinct from old.kind then
      raise exception 'A identidade e o grupo de uma entidade não podem ser alterados.' using errcode = '23514';
    end if;
    v_error := private.financial_draft_guard_error(old.group_id,old.id,old.kind,new.data);
  else
    v_error := private.financial_draft_guard_error(old.group_id,old.id,old.kind,old.data);
    if old.kind = 'person' and exists (select 1 from public.pool_manifests m cross join lateral jsonb_array_elements(m.content -> 'persons') p
      where m.group_id = old.group_id and (p.value ->> 'id')::uuid = old.id) then
      v_error := 'Uma pessoa preservada em manifesto não pode ser excluída.';
    end if;
    if old.kind = 'pool' and (exists (select 1 from public.pool_plan_versions where group_id = old.group_id and pool_id = old.id)
      or exists (select 1 from public.confirmed_quotas q where q.group_id = old.group_id and q.pool_id = old.id
        and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id))) then
      v_error := 'Um bolão com plano aplicado ou cotas confirmadas ativas não pode ser excluído.';
    end if;
  end if;
  if v_error is not null then raise exception '%',v_error using errcode = '23514'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create function private.guard_planning_insert() returns trigger
language plpgsql set search_path = '' as $$
declare v_error text;
begin
  v_error := private.financial_draft_guard_error(new.group_id,new.id,new.kind,new.data);
  if v_error is not null then raise exception '%',v_error using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger planning_drafts_insert_guard before insert on public.draft_records for each row execute function private.guard_planning_insert();

create function private.guard_planning_funding() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.pool_id is not null then
    if exists (select 1 from public.draft_records where group_id = new.group_id and id = new.pool_id
      and kind = 'pool' and data ->> 'status' <> 'draft') then
      raise exception 'O financiamento de um bolão fechado está congelado.' using errcode = '23514';
    end if;
    if new.amount_cents < 0 and private.pool_funding(new.group_id,new.pool_id) + new.amount_cents < private.pool_commitment(new.group_id,new.pool_id) then
      raise exception 'O estorno reduziria o financiamento abaixo do orçamento comprometido pelo plano.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger planning_finance_guard before insert on public.financial_movements for each row execute function private.guard_planning_funding();

-- Keep financial receipts durable when a new planning commitment prevents a reversal.
alter function public.review_decide(jsonb) set schema private;
alter function private.review_decide(jsonb) rename to financial_decide_base;
revoke all on function private.financial_decide_base(jsonb) from public,anon,authenticated;
create function public.review_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_group uuid; v_key uuid; v_revision bigint; v_result jsonb; v_actor uuid := auth.uid();
begin
  perform private.require_human();
  if private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey')
    or not private.json_uuid(p_command -> 'groupId') or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991)
    or octet_length(p_command::text) > 65536 then return private.financial_decide_base(p_command); end if;
  v_group := (p_command ->> 'groupId')::uuid; v_key := (p_command ->> 'idempotencyKey')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('finance:' || v_actor::text || ':' || v_key::text,0));
  if exists (select 1 from public.financial_command_receipts where actor_id = v_actor and idempotency_key = v_key) then
    return private.financial_decide_base(p_command);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if v_revision = (p_command ->> 'expectedRevision')::numeric and private.financial_action_error(p_command -> 'action') is null
    and p_command -> 'action' ->> 'type' = 'payment_reverse'
    and exists (select 1 from public.received_payments where group_id = v_group and id = (p_command -> 'action' ->> 'paymentId')::uuid)
    and not exists (select 1 from public.financial_movements where group_id = v_group and payment_id = (p_command -> 'action' ->> 'paymentId')::uuid and kind = 'payment-reversed')
    and not exists (select 1 from public.payment_allocations a join public.draft_records p on p.group_id = a.group_id and p.id = a.pool_id
      where a.group_id = v_group and a.payment_id = (p_command -> 'action' ->> 'paymentId')::uuid and p.data ->> 'status' <> 'draft')
    and exists (select 1 from public.payment_allocations a where a.group_id = v_group and a.payment_id = (p_command -> 'action' ->> 'paymentId')::uuid
      group by a.pool_id having private.pool_funding(v_group,a.pool_id) - sum(a.amount_cents) < private.pool_commitment(v_group,a.pool_id)) then
    v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'groupId',v_group,'status','rejected','groupRevision',v_revision,
      'message','O estorno reduziria o financiamento abaixo do orçamento comprometido pelo plano.','confirmedAt',null,'snapshot',private.finance_snapshot(v_group));
    insert into public.financial_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
      values(gen_random_uuid(),v_actor,v_key,v_group,p_command,v_result,clock_timestamp());
    return v_result;
  end if;
  return private.financial_decide_base(p_command);
end;
$$;

alter table public.planning_command_receipts enable row level security;
alter table public.pool_plan_versions enable row level security;
alter table public.pool_manifests enable row level security;
alter table public.lottery_pool_catalog_rules enable row level security;
create policy planning_receipts_read_self on public.planning_command_receipts for select to authenticated using (actor_id = auth.uid() and private.can_manage_group(group_id));
create policy pool_plans_read_organizer on public.pool_plan_versions for select to authenticated using (private.can_manage_group(group_id));
create policy pool_manifests_read_organizer on public.pool_manifests for select to authenticated using (private.can_manage_group(group_id));
create policy planning_catalog_read_human on public.lottery_pool_catalog_rules for select to authenticated using (private.is_human_session());
revoke all on public.planning_command_receipts,public.pool_plan_versions,public.pool_manifests,public.lottery_pool_catalog_rules from anon,authenticated;
grant select on public.planning_command_receipts,public.pool_plan_versions,public.pool_manifests,public.lottery_pool_catalog_rules to authenticated;
revoke all on function private.planning_snapshot(uuid),private.pool_funding(uuid,uuid),private.pool_commitment(uuid,uuid),
  private.planning_catalog_json(text),private.prepared_plan_error(jsonb),private.normalize_prepared_plan(jsonb),
  private.current_plan_error(uuid,uuid,jsonb,boolean),private.guard_planning_insert(),private.guard_planning_funding() from public,anon,authenticated;
revoke all on function public.planning_decide(jsonb),public.plan_pull(uuid),public.plan_command_status(uuid),public.review_decide(jsonb) from public,anon;
grant execute on function public.planning_decide(jsonb),public.plan_pull(uuid),public.plan_command_status(uuid),public.review_decide(jsonb) to authenticated;
