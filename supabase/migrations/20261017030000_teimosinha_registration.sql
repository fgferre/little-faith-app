-- Owner's decision of 17/10 (teimosinha, step 4 of PLAN-teimosinha.md): a registration receipt says how many consecutive contests
-- it covers. The observed ticket may carry contestCount, an integer from 1 to 12 or null while it is not legible; an absent key
-- means 1, so reports written before this migration keep meaning one contest and are never rewritten. The check flags a count
-- different from the plan's, prices the legible games at the catalog price times the observed count, and freezes the calendar of
-- the plan's first contest, as packages/core/src/registration.ts now does. A pool of one contest behaves exactly as before.
--   private.registration_items_error      re-created from 20261008010000_registration_results.sql (never redefined since): the
--     observed ticket may also carry contestCount, null or an integer from 1 to 12;
--   private.registration_comparison       re-created from 20261008010000_registration_results.sql (never redefined since): an absent
--     contestCount reads as 1, contestCount joins the missing fields right after contestNumber, a count different from the plan's
--     is a contest-count-mismatch divergence, and the official price of the legible games is multiplied by the observed count;
--   public.registration_decide            re-created from 20261008010000_registration_results.sql (never redefined since): the
--     frozen calendar is the latest of the plan's first contest, no longer the latest calendar of the pool;
--   private.financial_draft_guard_error   wraps the previous one (renamed private.financial_draft_guard_error_single_count), as
--     20261008010000_registration_results.sql did: a pool draft cannot lower contestCount while a contest that would leave the
--     range already has a result or calendar version.
-- create or replace keeps the existing grants; the new wrapper gets the same revoke as the one it replaces.
create or replace function private.registration_items_error(p_items jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_o jsonb; v_id jsonb; v_numbers jsonb; v_assignment jsonb; v_error text; v_seen boolean := false;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 1000 then return 'Checklist inválido.'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if private.exact_keys(v_item,array['plannedTicketKey','evidenceIds','observed','reason']) is not true
      or jsonb_typeof(v_item -> 'plannedTicketKey') <> 'string' or v_item ->> 'plannedTicketKey' !~ '^[A-Za-z0-9_-]{1,80}$'
      or jsonb_typeof(v_item -> 'evidenceIds') <> 'array' or jsonb_array_length(v_item -> 'evidenceIds') > 100
      or not private.json_text(v_item -> 'reason',2000) then return 'Item ou justificativa do checklist inválidos.'; end if;
    for v_id in select value from jsonb_array_elements(v_item -> 'evidenceIds') loop if not private.json_uuid(v_id) then return 'Identificador do original inválido.'; end if; end loop;
    if (select count(distinct (value #>> '{}')::uuid) from jsonb_array_elements(v_item -> 'evidenceIds')) <> jsonb_array_length(v_item -> 'evidenceIds') then return 'Original repetido na mesma cartela.'; end if;
    v_o := v_item -> 'observed';
    if v_o = 'null'::jsonb then continue; end if;
    v_seen := true;
    if jsonb_array_length(v_item -> 'evidenceIds') = 0 then return 'Um registro observado exige ao menos um original selado.'; end if;
    if private.exact_keys(case when jsonb_typeof(v_o) = 'object' and v_o ? 'contestCount' then v_o - 'contestCount' else v_o end,array['lotteryId','contestNumber','betNumbers','betCostCents','feeCents','officialQuotaCount','officialAssignments','registeredAt']) is not true
      or (v_o -> 'lotteryId' <> 'null'::jsonb and v_o ->> 'lotteryId' not in ('mega-sena','lotofacil','quina'))
      or (v_o -> 'contestNumber' <> 'null'::jsonb and not private.json_integer(v_o -> 'contestNumber',1,999999))
      or (v_o -> 'betCostCents' <> 'null'::jsonb and not private.json_money(v_o -> 'betCostCents'))
      or (v_o -> 'feeCents' <> 'null'::jsonb and not private.json_money(v_o -> 'feeCents'))
      or (v_o -> 'officialQuotaCount' <> 'null'::jsonb and not private.json_integer(v_o -> 'officialQuotaCount',0,1000000))
      or (v_o -> 'registeredAt' <> 'null'::jsonb and not private.json_timestamp(v_o -> 'registeredAt'))
      or (v_o ? 'contestCount' and v_o -> 'contestCount' <> 'null'::jsonb and not private.json_integer(v_o -> 'contestCount',1,12)) then return 'Dados observados inválidos; use null para o que ainda não foi legível.'; end if;
    if v_o -> 'betNumbers' <> 'null'::jsonb then
      if jsonb_typeof(v_o -> 'betNumbers') <> 'array' or jsonb_array_length(v_o -> 'betNumbers') not between 1 and 10 then return 'Jogos observados inválidos.'; end if;
      for v_numbers in select value from jsonb_array_elements(v_o -> 'betNumbers') loop
        if jsonb_typeof(v_numbers) <> 'array' or jsonb_array_length(v_numbers) not between 5 and 20
          or exists (select 1 from jsonb_array_elements(v_numbers) where not private.json_integer(value,1,80))
          or (select count(distinct value) from jsonb_array_elements(v_numbers)) <> jsonb_array_length(v_numbers) then return 'Dezenas observadas incompletas ou repetidas.'; end if;
        if v_o -> 'lotteryId' <> 'null'::jsonb then
          v_error := private.draft_validation_error('bet',jsonb_build_object('poolId','00000000-0000-4000-8000-000000000001','lotteryId',v_o -> 'lotteryId',
            'numbers',v_numbers,'authorIds','[]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null));
          if v_error is not null then return v_error; end if;
        end if;
      end loop;
    end if;
    if v_o -> 'officialAssignments' <> 'null'::jsonb then
      if jsonb_typeof(v_o -> 'officialAssignments') <> 'array' or jsonb_array_length(v_o -> 'officialAssignments') > 200 then return 'Correspondência oficial inválida.'; end if;
      for v_assignment in select value from jsonb_array_elements(v_o -> 'officialAssignments') loop
        if private.exact_keys(v_assignment,array['quotaId','personId','officialQuotas']) is not true or not private.json_uuid(v_assignment -> 'quotaId')
          or not private.json_uuid(v_assignment -> 'personId') or not private.json_integer(v_assignment -> 'officialQuotas',1,1000000) then return 'Correspondência da cota oficial inválida.'; end if;
      end loop;
      if (select count(distinct (value ->> 'quotaId')::uuid) from jsonb_array_elements(v_o -> 'officialAssignments')) <> jsonb_array_length(v_o -> 'officialAssignments')
        or (select count(distinct (value ->> 'personId')::uuid) from jsonb_array_elements(v_o -> 'officialAssignments')) <> jsonb_array_length(v_o -> 'officialAssignments') then return 'Pessoa ou direito oficial repetido.'; end if;
    end if;
  end loop;
  if not v_seen then return 'Confirmação exige ao menos um registro efetivamente observado.'; end if;
  if (select count(distinct value -> 'plannedTicketKey') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then return 'Cartela repetida no checklist.'; end if;
  return null;
end;
$$;

create or replace function private.registration_comparison(p_manifest public.pool_manifests,p_items jsonb,p_calendar jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_plan jsonb := p_manifest.content -> 'plan'; v_item jsonb; v_actual jsonb; v_ticket jsonb; v_key text;
  v_issues jsonb := '[]'; v_numbers jsonb; v_missing text[]; v_total_cost numeric := 0; v_total_fee numeric := 0; v_count integer := 0;
  v_price numeric; v_quota_count numeric; v_cost numeric; v_rule public.lottery_pool_catalog_rules; v_rule_bad boolean;
begin
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_key := v_item ->> 'plannedTicketKey'; v_actual := v_item -> 'observed';
    select value into v_ticket from jsonb_array_elements(v_plan -> 'tickets') where value ->> 'key' = v_key;
    if exists (select 1 from jsonb_array_elements(v_item -> 'evidenceIds') i join public.evidence_originals e on e.id = (i.value #>> '{}')::uuid
      where e.uploaded_at >= (p_manifest.content -> 'pool' -> 'data' ->> 'deadlineAt')::timestamptz) then
      v_issues := v_issues || private.registration_issue(v_key,'evidence-after-internal-deadline','notice','Original apresentado após o prazo interno de participação.');
    end if;
    if v_actual = 'null'::jsonb then
      v_issues := v_issues || private.registration_issue(v_key,case when jsonb_array_length(v_item -> 'evidenceIds') > 0 then 'unreadable-receipt' else 'missing-receipt' end,'incomplete','Comprovante ausente ou ainda não conferido.');
      v_total_cost := null; v_total_fee := null; continue;
    end if;
    v_count := v_count+1;
    if not (v_actual ? 'contestCount') then v_actual := v_actual || '{"contestCount":1}'::jsonb; end if;
    v_missing := array[]::text[];
    if jsonb_array_length(v_item -> 'evidenceIds') = 0 then v_issues := v_issues || private.registration_issue(v_key,'missing-receipt','incomplete','Dados informados ainda não têm original enviado.'); end if;
    foreach v_key in array array['lotteryId','contestNumber','contestCount','betNumbers','betCostCents','feeCents','registeredAt'] loop
      if v_actual -> v_key = 'null'::jsonb then v_missing := array_append(v_missing,v_key); end if;
    end loop;
    if v_plan ->> 'participationMode' = 'official' then
      foreach v_key in array array['officialQuotaCount','officialAssignments'] loop if v_actual -> v_key = 'null'::jsonb then v_missing := array_append(v_missing,v_key); end if; end loop;
    end if;
    v_key := v_item ->> 'plannedTicketKey';
    if cardinality(v_missing) > 0 then v_issues := v_issues || private.registration_issue(v_key,'missing-field','incomplete','Campos do comprovante ainda desconhecidos: ' || array_to_string(v_missing,', ') || '.'); end if;
    if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'lotteryId' <> v_plan -> 'lotteryId' then v_issues := v_issues || private.registration_issue(v_key,'lottery-mismatch','divergence','Modalidade registrada diverge do plano.'); end if;
    if v_actual -> 'contestNumber' <> 'null'::jsonb and v_actual -> 'contestNumber' <> v_plan -> 'contestNumber' then v_issues := v_issues || private.registration_issue(v_key,'contest-mismatch','divergence','Concurso registrado diverge do plano.'); end if;
    if v_actual -> 'contestCount' <> 'null'::jsonb and (v_actual ->> 'contestCount')::numeric <> coalesce((v_plan ->> 'contestCount')::numeric,1) then v_issues := v_issues || private.registration_issue(v_key,'contest-count-mismatch','divergence','Quantidade de concursos registrada diverge do plano.'); end if;
    select jsonb_agg(b.value -> 'numbers') into v_numbers from jsonb_array_elements(v_plan -> 'bets') b where exists (select 1 from jsonb_array_elements(v_ticket -> 'betKeys') k where k.value #>> '{}' = b.value ->> 'key');
    if v_actual -> 'betNumbers' <> 'null'::jsonb and private.registration_game_set(v_actual -> 'betNumbers') <> private.registration_game_set(v_numbers) then v_issues := v_issues || private.registration_issue(v_key,'numbers-mismatch','divergence','Jogos registrados divergem dos jogos planejados.'); end if;
    v_price := null;
    -- A teimosinha receipt bills every legible game once per contest it covers.
    if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'betNumbers' <> 'null'::jsonb and v_actual -> 'contestCount' <> 'null'::jsonb then
      select sum(r.elementary_combinations * r.simple_price_cents) * (v_actual ->> 'contestCount')::numeric into v_price from jsonb_array_elements(v_actual -> 'betNumbers') b join public.lottery_pool_catalog_rules r
        on r.lottery_id = v_actual ->> 'lotteryId' and r.catalog_version = 'caixa-pools-2026-10-08-v1' and r.number_count = jsonb_array_length(b.value);
    end if;
    if v_actual -> 'betCostCents' <> 'null'::jsonb and (v_actual -> 'betCostCents' <> v_ticket -> 'betCostCents'
      or (v_price is not null and (v_actual ->> 'betCostCents')::numeric <> v_price)) then v_issues := v_issues || private.registration_issue(v_key,'bet-cost-mismatch','divergence','Custo observado diverge da cartela ou do preço oficial dos jogos legíveis.'); end if;
    v_total_cost := v_total_cost + (v_actual ->> 'betCostCents')::numeric; v_total_fee := v_total_fee + (v_actual ->> 'feeCents')::numeric;
    if v_plan ->> 'participationMode' = 'official' then
      if v_actual -> 'officialQuotaCount' <> 'null'::jsonb and v_actual -> 'officialQuotaCount' <> v_ticket -> 'officialQuotaCount' then v_issues := v_issues || private.registration_issue(v_key,'official-quota-mismatch','divergence','Quantidade de cotas oficiais diverge do plano.'); end if;
      if v_actual -> 'officialAssignments' <> 'null'::jsonb and private.registration_assignment_set(v_actual -> 'officialAssignments') <> private.registration_assignment_set(v_ticket -> 'assignments') then v_issues := v_issues || private.registration_issue(v_key,'official-assignment-mismatch','divergence','Recibos de cotas oficiais não correspondem aos direitos congelados.'); end if;
      if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'betNumbers' <> 'null'::jsonb and v_actual -> 'betCostCents' <> 'null'::jsonb and v_actual -> 'officialQuotaCount' <> 'null'::jsonb then
        select * into v_rule from public.lottery_pool_catalog_rules where lottery_id = v_actual ->> 'lotteryId' and number_count = jsonb_array_length(v_actual -> 'betNumbers' -> 0) and catalog_version = 'caixa-pools-2026-10-08-v1';
        v_quota_count := (v_actual ->> 'officialQuotaCount')::numeric; v_cost := (v_actual ->> 'betCostCents')::numeric;
        v_rule_bad := exists (select 1 from jsonb_array_elements(v_actual -> 'betNumbers') b where jsonb_array_length(b.value) <> v_rule.number_count)
          or v_quota_count not between v_rule.min_quotas and v_rule.max_quotas or jsonb_array_length(v_actual -> 'betNumbers') > v_rule.max_games_per_receipt
          or v_cost not between v_rule.min_pool_cents and v_rule.max_pool_cents;
        if not v_rule_bad then v_rule_bad := mod(v_cost,v_quota_count) <> 0 or v_cost / v_quota_count < v_rule.min_quota_cents; end if;
        if v_actual -> 'feeCents' <> 'null'::jsonb and (v_actual ->> 'feeCents')::numeric * 100 > v_cost * 35 then v_rule_bad := true; end if;
        if v_rule_bad then v_issues := v_issues || private.registration_issue(v_key,'official-rule-mismatch','divergence','Dados observados não atendem às regras oficiais da cartela e suas cotas.'); end if;
      end if;
    else
      if v_actual -> 'officialQuotaCount' <> 'null'::jsonb then v_issues := v_issues || private.registration_issue(v_key,'official-quota-mismatch','divergence','Acordo interno planejado não tinha cotas oficiais.'); end if;
      if v_actual -> 'officialAssignments' <> 'null'::jsonb then v_issues := v_issues || private.registration_issue(v_key,'official-assignment-mismatch','divergence','Correspondência oficial observada não existia no acordo interno.'); end if;
    end if;
    if v_actual -> 'registeredAt' <> 'null'::jsonb and (v_actual ->> 'registeredAt')::timestamptz < private.utc_json(p_manifest.locked_at)::timestamptz then v_issues := v_issues || private.registration_issue(v_key,'registered-before-lock','divergence','Registro externo anterior ao manifesto congelado.'); end if;
    if v_actual -> 'registeredAt' <> 'null'::jsonb and p_calendar -> 'registrationClosesAt' <> 'null'::jsonb
      and (v_actual ->> 'registeredAt')::timestamptz >= (p_calendar ->> 'registrationClosesAt')::timestamptz then v_issues := v_issues || private.registration_issue(v_key,'registration-after-channel-close','divergence','Horário observado posterior ao encerramento configurado do canal.'); end if;
  end loop;
  if v_total_fee is not null and v_total_fee <> (v_plan ->> 'feeCents')::numeric then v_issues := v_issues || private.registration_issue(null,'fee-mismatch','divergence','Soma das taxas observadas diverge da taxa autorizada no plano.'); end if;
  return jsonb_build_object('status',case when exists (select 1 from jsonb_array_elements(v_issues) where value ->> 'severity' = 'divergence') then 'divergent'
    when exists (select 1 from jsonb_array_elements(v_issues) where value ->> 'severity' = 'incomplete') then 'partial' else 'complete' end,
    'observedTicketCount',v_count,'missingTicketCount',jsonb_array_length(p_items)-v_count,'observedBetCostCents',v_total_cost::text,'observedFeeCents',v_total_fee::text,'issues',v_issues);
end;
$$;

create or replace function public.registration_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid();
  v_saved public.registration_command_receipts; v_pool public.draft_records; v_manifest public.pool_manifests; v_calendar public.contest_calendar_versions;
  v_action jsonb; v_items jsonb; v_comparison jsonb; v_calendar_json jsonb; v_error text; v_status text := 'accepted';
  v_revision bigint; v_version bigint; v_now timestamptz; v_report_id uuid := gen_random_uuid(); v_result jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_registration_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('registration:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.registration_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de conferir o registro.';
  elsif private.exact_keys(v_action,array['type','poolId','poolVersion','manifestId','items','reason']) is not true or (v_action ->> 'type' = 'registration_confirm') is not true
    or not private.json_uuid(v_action -> 'poolId') or not private.json_uuid(v_action -> 'manifestId') or not private.json_integer(v_action -> 'poolVersion',1,9007199254740991)
    or not private.json_text(v_action -> 'reason',2000) then v_error := 'Comando de conferência de registro inválido.';
  else v_error := private.registration_items_error(v_action -> 'items'); end if;
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; reveja o checklist.';
    elsif v_pool.data ->> 'status' not in ('locked','registered') then v_error := 'O registro exige um manifesto travado e preserva esse fechamento.';
    else
      select * into v_manifest from public.pool_manifests where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      if not found or v_manifest.id <> (v_action ->> 'manifestId')::uuid then v_error := 'Confira o último manifesto efetivamente travado; a fonte não pode ser trocada silenciosamente.'; end if;
      if exists (select 1 from public.registration_reports where group_id = v_group and pool_id = v_pool_id and manifest_id <> v_manifest.id) then v_error := 'O primeiro registro sela o manifesto original para todas as revisões.'; end if;
    end if;
  end if;
  if v_error is null then
    v_items := private.normalize_registration_items(v_action -> 'items');
    if jsonb_array_length(v_items) <> jsonb_array_length(v_manifest.content -> 'plan' -> 'tickets')
      or exists (select 1 from jsonb_array_elements(v_items) i where not exists (select 1 from jsonb_array_elements(v_manifest.content -> 'plan' -> 'tickets') t where t.value ->> 'key' = i.value ->> 'plannedTicketKey'))
      then v_error := 'Checklist deve conter exatamente todas as cartelas do manifesto, inclusive as ausentes.';
    elsif exists (select 1 from jsonb_array_elements(v_items) i cross join lateral jsonb_array_elements(i.value -> 'evidenceIds') e
      where not exists (select 1 from public.evidence_originals o where o.group_id = v_group and o.pool_id = v_pool_id and o.id = (e.value #>> '{}')::uuid))
      then v_error := 'Cada comprovante precisa estar selado neste grupo e bolão.';
    end if;
  end if;
  select coalesce(max(version),0)+1 into v_version from public.registration_reports where group_id = v_group and pool_id = v_pool_id;
  if v_error is null and (v_pool.version >= 9007199254740991 or v_version > 9007199254740991 or (select count(*) from public.registration_reports where group_id = v_group) >= 10000)
    then v_error := 'Limite de versões do registro ou bolão atingido.'; end if;
  v_now := clock_timestamp();
  if v_error is null then
    if exists (select 1 from jsonb_array_elements(v_items) i where i.value -> 'observed' -> 'registeredAt' <> 'null'::jsonb
      and (i.value -> 'observed' ->> 'registeredAt')::timestamptz > v_now) then v_error := 'Um evento futuro não pode ser confirmado como registro observado.'; end if;
    select * into v_calendar from public.contest_calendar_versions where group_id = v_group and pool_id = v_pool_id
      and contest_number = (v_manifest.content -> 'plan' ->> 'contestNumber')::bigint order by version desc limit 1;
    v_calendar_json := case when v_calendar.id is not null then private.calendar_version_json(v_calendar) else null end;
    v_comparison := private.registration_comparison(v_manifest,v_items,v_calendar_json);
    if (v_comparison ->> 'observedBetCostCents')::numeric > 9007199254740991 or (v_comparison ->> 'observedFeeCents')::numeric > 9007199254740991 then v_error := 'Somas observadas excedem o limite de centavos deste contrato.'; end if;
    if (v_version > 1 or exists (select 1 from jsonb_array_elements(v_comparison -> 'issues') where value -> 'plannedTicketKey' = 'null'::jsonb and value ->> 'severity' = 'divergence'))
      and private.js_trim(v_action ->> 'reason') = '' then v_error := 'Revisão ou divergência global exige justificativa humana.'; end if;
    if exists (select 1 from jsonb_array_elements(v_items) i where private.js_trim(i.value ->> 'reason') = '' and exists (
      select 1 from jsonb_array_elements(v_comparison -> 'issues') e where e.value ->> 'plannedTicketKey' = i.value ->> 'plannedTicketKey' and e.value ->> 'severity' = 'divergence'))
      then v_error := 'Uma cartela divergente exige justificativa humana própria.'; end if;
  end if;
  if v_error is null then
    insert into public.registration_reports(id,group_id,pool_id,version,pool_version,manifest_id,calendar,items,reason,comparison,confirmed_at,receipt_id)
      values(v_report_id,v_group,v_pool_id,v_version,v_pool.version,v_manifest.id,v_calendar_json,v_items,v_action ->> 'reason',v_comparison,v_now,v_receipt);
    update public.draft_records set data = jsonb_set(data,'{status}','"registered"'),version = version+1,updated_at = v_now where group_id = v_group and id = v_pool_id;
    v_revision := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,'registration_confirm',jsonb_build_object('receiptId',v_receipt,'reportId',v_report_id,'manifestId',v_manifest.id,'version',v_version));
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
    'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
    'snapshot',private.registration_snapshot(v_group));
  insert into public.registration_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,v_result,v_now);
  return v_result;
end;
$$;

alter function private.financial_draft_guard_error(uuid,uuid,text,jsonb) rename to financial_draft_guard_error_single_count;
create function private.financial_draft_guard_error(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns text
language plpgsql set search_path = '' as $$
declare v_old public.draft_records;
begin
  select * into v_old from public.draft_records where group_id = p_group and id = p_id;
  if p_kind = 'pool' and v_old.id is not null and v_old.data -> 'contestNumber' <> 'null'::jsonb
    and coalesce((p_data ->> 'contestCount')::numeric,1) < coalesce((v_old.data ->> 'contestCount')::numeric,1)
    and (exists (select 1 from public.contest_result_versions where group_id = p_group and pool_id = p_id
        and contest_number >= (v_old.data ->> 'contestNumber')::numeric + coalesce((p_data ->> 'contestCount')::numeric,1))
      or exists (select 1 from public.contest_calendar_versions where group_id = p_group and pool_id = p_id
        and contest_number >= (v_old.data ->> 'contestNumber')::numeric + coalesce((p_data ->> 'contestCount')::numeric,1))) then
    return 'Um concurso que já tem resultado ou calendário não pode sair da teimosinha; preserve a quantidade de concursos.';
  end if;
  return private.financial_draft_guard_error_single_count(p_group,p_id,p_kind,p_data);
end;
$$;
revoke all on function private.financial_draft_guard_error(uuid,uuid,text,jsonb),private.financial_draft_guard_error_single_count(uuid,uuid,text,jsonb) from public,anon,authenticated;
