-- Owner's decision of 15/10 (PLAN-decisoes.md item 6, "Combinado antes"): a plan may carry groupPrizeLimitCents, a positive
-- amount in cents (string) up to which a confirmed prize stays in the group cash instead of being split; null means no limit.
-- It is agreed before the lock and frozen in the manifest with the rest of the plan. Plans applied before this migration do
-- not have the key, so the key is optional here (absent is read as null) and an applied plan or manifest is never rewritten.
-- It only makes sense in the internal agreement: a non-null limit on an official plan is refused with the same message as core.
-- Re-created from its last definition (20261008000000_planning.sql, never redefined since), changing only the exact-keys check,
-- the value check and the official refusal:
--   private.prepared_plan_error   (used by private.current_plan_error and public.planning_decide, which pick it up unchanged)
-- create or replace keeps the existing grants.
create or replace function private.prepared_plan_error(p_plan jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_item jsonb; v_bet jsonb; v_ticket jsonb; v_assignment jsonb; v_right jsonb; v_key jsonb;
  v_rule public.lottery_pool_catalog_rules; v_total numeric := 0; v_ticket_cost numeric; v_units numeric;
  v_universe integer; v_min integer; v_max integer; v_count integer; v_seen text[] := '{}';
begin
  if private.exact_keys(case when jsonb_typeof(p_plan) = 'object' then p_plan - 'groupPrizeLimitCents' else p_plan end,array['id','groupId','poolId','poolVersion','groupRevision','lotteryId','contestNumber',
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
    or jsonb_typeof(p_plan -> 'sourceBets') is distinct from 'array' or jsonb_typeof(p_plan -> 'rights') is distinct from 'array'
    or jsonb_typeof(p_plan -> 'bets') is distinct from 'array' or jsonb_typeof(p_plan -> 'tickets') is distinct from 'array' then
    return 'Plano inválido ou catálogo não vigente; gere e revise novamente.';
  end if;
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
