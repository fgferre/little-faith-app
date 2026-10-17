-- Owner's decision of 17/10 (teimosinha): a pool may be played with the same games for several consecutive contests, paid
-- once. The pool record and the plan may carry contestCount, an integer from 1 to 12; absent means 1, so pools and plans written
-- before this migration keep meaning one contest and are never rewritten. The plan's game costs are the catalog price times
-- contestCount, a plan must carry the same contestCount as its pool, and contestCount is frozen together with price, deadline,
-- lottery, contest and participation mode while an active confirmed quota exists. A pool's contestNumber is also capped at
-- 999999 here, as plans and results already were.
--   private.draft_validation_error   wraps the previous one (renamed private.draft_validation_error_single_contest), as
--     20261013000000_group_pix.sql did for "pix": checks the optional pool contestCount and the contestNumber cap;
--   private.prepared_plan_error      re-created from 20261016040000_plan_group_prize_limit.sql, changing only the exact-keys
--     check, the contestCount value check and the two cost sums (each game's and each ticket's catalog price times contestCount);
--   private.current_plan_error       re-created from 20261016020000_quota_after_deadline.sql with one added refusal when the
--     plan's contestCount differs from the pool's;
--   private.financial_draft_guard_error_registration_base   re-created from 20261008000000_planning.sql (renamed to this name
--     and wrapped by private.financial_draft_guard_error in 20261008010000_registration_results.sql): contestCount joins the
--     pool fields frozen by active confirmed quotas, and the message names it.
-- create or replace keeps the existing grants; the new wrapper gets the same revoke as the one it replaces.
alter function private.draft_validation_error(text,jsonb) rename to draft_validation_error_single_contest;
create function private.draft_validation_error(p_kind text, p_data jsonb) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_kind = 'pool' and jsonb_typeof(p_data) = 'object' then
    if (p_data ? 'contestCount' and not private.json_integer(p_data -> 'contestCount', 1, 12))
      or (p_data -> 'contestNumber' <> 'null'::jsonb and not private.json_integer(p_data -> 'contestNumber', 1, 999999)) then
      return 'Bolão inválido; sincronização aceita apenas rascunhos.';
    end if;
    return private.draft_validation_error_single_contest(p_kind, p_data - 'contestCount');
  end if;
  return private.draft_validation_error_single_contest(p_kind, p_data);
end;
$$;
revoke all on function private.draft_validation_error(text,jsonb),private.draft_validation_error_single_contest(text,jsonb) from public,anon,authenticated;

create or replace function private.prepared_plan_error(p_plan jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_item jsonb; v_bet jsonb; v_ticket jsonb; v_assignment jsonb; v_right jsonb; v_key jsonb;
  v_rule public.lottery_pool_catalog_rules; v_total numeric := 0; v_ticket_cost numeric; v_units numeric;
  v_universe integer; v_min integer; v_max integer; v_count integer; v_seen text[] := '{}'; v_contests numeric;
begin
  if private.exact_keys(case when jsonb_typeof(p_plan) = 'object' then p_plan - 'groupPrizeLimitCents' - 'contestCount' else p_plan end,array['id','groupId','poolId','poolVersion','groupRevision','lotteryId','contestNumber',
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
    or (p_plan ? 'groupPrizeLimitCents' and jsonb_typeof(p_plan -> 'groupPrizeLimitCents') <> 'null'
      and not private.json_money(p_plan -> 'groupPrizeLimitCents',true))
    or (p_plan ? 'contestCount' and not private.json_integer(p_plan -> 'contestCount',1,12))
    or jsonb_typeof(p_plan -> 'sourceBets') is distinct from 'array' or jsonb_typeof(p_plan -> 'rights') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'bets') is distinct from 'array' or jsonb_typeof(p_plan -> 'tickets') is distinct from 'array' then
    return 'Plano inválido ou catálogo não vigente; gere e revise novamente.';
  end if;
  v_contests := coalesce((p_plan ->> 'contestCount')::numeric,1);
  if p_plan ? 'groupPrizeLimitCents' and jsonb_typeof(p_plan -> 'groupPrizeLimitCents') <> 'null'
    and p_plan ->> 'participationMode' = 'official' then
    return 'O limite de prêmio para o caixa do grupo só vale no combinado interno.';
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
    v_total := v_total + v_rule.elementary_combinations * v_rule.simple_price_cents * v_contests;
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
      v_ticket_cost := v_ticket_cost + v_rule.elementary_combinations * v_rule.simple_price_cents * v_contests;
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

create or replace function private.current_plan_error(p_group uuid,p_pool uuid,p_plan jsonb,p_exact_pool_version boolean default true) returns text
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
  if private.pool_draw_passed(p_group,p_pool,v_pool.data -> 'contestNumber') then return 'O sorteio deste concurso já passou; o plano ou a trava não foram confirmados.'; end if;
  if v_pool.data ->> 'lotteryId' <> p_plan ->> 'lotteryId' or v_pool.data -> 'contestNumber' <> p_plan -> 'contestNumber'
    or v_pool.data ->> 'participationMode' <> p_plan ->> 'participationMode' then return 'Modalidade, concurso ou participação divergem do bolão atual.'; end if;
  if coalesce((v_pool.data ->> 'contestCount')::numeric,1) <> coalesce((p_plan ->> 'contestCount')::numeric,1) then
    return 'A quantidade de concursos da teimosinha diverge do bolão atual.';
  end if;
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

create or replace function private.financial_draft_guard_error_registration_base(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns text
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
      or coalesce(v_old.data -> 'contestCount','1'::jsonb) is distinct from coalesce(p_data -> 'contestCount','1'::jsonb)
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
    return 'Preço, prazo, modalidade, concurso, quantidade de concursos e tipo de participação estão vinculados a cotas confirmadas ativas.';
  end if;
  return null;
end;
$$;
