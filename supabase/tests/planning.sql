-- Planning assertions use synthetic human sessions and roll back every fixture.
begin;
create function pg_temp.assert_true(p_condition boolean,p_label text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.draft(p_group uuid,p_id uuid,p_kind text,p_data jsonb,p_version bigint default 0) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
  'entityId',p_id,'kind',p_kind,'expectedVersion',p_version,'data',p_data,'createdAt','2026-10-08T12:00:00.000Z'); $$;
create function pg_temp.command(p_group uuid,p_action jsonb,p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',p_key,'groupId',p_group,
  'expectedRevision',coalesce(p_revision,(select revision from public.groups where id = p_group)),'action',p_action); $$;
create temporary table planning_contract_samples(label text,kind text,data jsonb);
grant all on planning_contract_samples to authenticated;

-- This fixture intentionally uses four known games and independently known prices/2:1 rights.
create function pg_temp.prepared(p_group uuid,p_pool uuid) returns jsonb language plpgsql as $$
declare v_pool public.draft_records; v_source public.draft_records; v_rights jsonb; v_budget bigint;
  v_bets jsonb; v_tickets jsonb := '[]'; v_bet jsonb; v_assignments jsonb; i integer;
begin
  select * into v_pool from public.draft_records where group_id = p_group and id = p_pool;
  select * into v_source from public.draft_records where group_id = p_group and kind = 'bet' and (data ->> 'poolId')::uuid = p_pool order by id limit 1;
  select jsonb_agg(jsonb_build_object('quotaId',q.id,'sourceQuotaId',q.source_quota_id,'sourceQuotaVersion',q.source_quota_version,
    'personId',q.person_id,'units',q.units,'dueCents',q.due_cents::text,'statuteId',q.statute_id) order by q.id),sum(due_cents) into v_rights,v_budget
    from public.confirmed_quotas q where q.group_id = p_group and q.pool_id = p_pool and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id);
  v_bets := jsonb_build_array(jsonb_build_object('key','fixed-1','sourceBetId',v_source.id,'sourceBetVersion',v_source.version,
    'numbers',v_source.data -> 'numbers','authorIds',v_source.data -> 'authorIds','seed',v_source.data -> 'seed','generationAlgorithmVersion',v_source.data -> 'generationAlgorithmVersion'));
  for i in 1..3 loop v_bets := v_bets || jsonb_build_array(jsonb_build_object('key','generated-' || i,'sourceBetId',null,'sourceBetVersion',null,
    'numbers',jsonb_build_array(i+6,i+7,i+8,i+9,i+10,i+11),'authorIds','[]'::jsonb,'seed',repeat('ab',32),'generationAlgorithmVersion','chacha20-lexicographic-rank-v1')); end loop;
  if v_pool.data ->> 'participationMode' = 'internal' then
    i := 0;
    for v_bet in select value from jsonb_array_elements(v_bets) loop i := i+1;
      v_tickets := v_tickets || jsonb_build_array(jsonb_build_object('key','ticket-' || i,'numberCount',6,'betKeys',jsonb_build_array(v_bet -> 'key'),
        'betCostCents','600','officialQuotaCount',null,'officialQuotaValueCents',null,'assignments','[]'::jsonb)); end loop;
  else
    select jsonb_agg(jsonb_build_object('quotaId',value -> 'quotaId','personId',value -> 'personId','officialQuotas',(value ->> 'units')::integer / 50)) into v_assignments from jsonb_array_elements(v_rights);
    v_tickets := jsonb_build_array(jsonb_build_object('key','ticket-1','numberCount',6,'betKeys','["fixed-1","generated-1","generated-2","generated-3"]'::jsonb,
      'betCostCents','2400','officialQuotaCount',3,'officialQuotaValueCents','800','assignments',v_assignments));
  end if;
  return jsonb_build_object('id',gen_random_uuid(),'groupId',p_group,'poolId',p_pool,'poolVersion',v_pool.version,
    'groupRevision',(select revision from public.groups where id = p_group),'lotteryId','mega-sena','contestNumber',42,'participationMode',v_pool.data -> 'participationMode',
    'strategy','balanced','seed',repeat('ab',32),'catalogVersion','caixa-pools-2026-10-08-v1','sourceBets',jsonb_build_array(jsonb_build_object('id',v_source.id,'version',v_source.version)),
    'rights',v_rights,'budgetCents',v_budget::text,'betCostCents','2400','feeCents','0','feeLabel','','totalCostCents','2400',
    'leftoverCents',(v_budget-2400)::text,'leftoverPolicy','refund-pro-rata','bets',v_bets,'tickets',v_tickets,'explanation','Plano privado São João 🙂 com jogos fixos preservados.');
end;
$$;

insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000951','planning-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000952','planning-b@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","app_metadata":{}}',true);

do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid; v_person uuid; v_statute uuid; v_result jsonb; i integer; j integer; begin
  perform public.sync_push(pg_temp.draft(v_group,v_group,'group','{"name":"Planejamento privado","statute":"Regras privadas de São João 🙂"}'));
  for i in 1..3 loop
    v_person := ('93000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    perform public.sync_push(pg_temp.draft(v_group,v_person,'person',jsonb_build_object('name','Pessoa ' || i,'nickname','','adultDeclared',true)));
  end loop;
  for i in 1..2 loop
    v_pool := ('94000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    perform public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_build_object('title','Bolão ' || i,'lotteryId','mega-sena','contestNumber',42,
      'deadlineAt','2099-01-01T00:00:00Z','quotaPriceCents','2500','participationMode',case when i = 1 then 'internal' else 'official' end,'status','draft')));
    perform public.sync_push(pg_temp.draft(v_group,('97000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'bet',jsonb_build_object('poolId',v_pool,
      'lotteryId','mega-sena','numbers','[1,2,3,4,5,6]'::jsonb,'authorIds','["93000000-0000-4000-8000-000000000001"]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null)));
    for j in 1..2 loop
      v_person := ('93000000-0000-4000-8000-' || lpad(j::text,12,'0'))::uuid;
      perform public.sync_push(pg_temp.draft(v_group,('95000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'quota',
        jsonb_build_object('poolId',v_pool,'personId',v_person,'units',case when j = 1 then 100 else 50 end)));
      perform public.sync_push(pg_temp.draft(v_group,('96000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'payment-proposal',
        jsonb_build_object('poolId',v_pool,'personId',v_person,'amountCents',case when j = 1 then '2500' else '1250' end,'note','','status','pending')));
    end loop;
  end loop;
  perform public.review_decide(pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":1}'));
  select id into v_statute from public.statute_versions where group_id = v_group;
  for j in 1..2 loop
    v_person := ('93000000-0000-4000-8000-' || lpad(j::text,12,'0'))::uuid;
    perform public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','statute_accept','statuteId',v_statute,'personId',v_person,'evidence','Aceite privado confirmado pelo organizador')));
  end loop;
  for i in 1..2 loop
    v_pool := ('94000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    for j in 1..2 loop
      v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_confirm','proposalId',
        ('96000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'proposalVersion',1,'bankReference',null,'declaredReceivedAt',null,
        'allocations',jsonb_build_array(jsonb_build_object('poolId',v_pool,'amountCents',case when j = 1 then '2500' else '1250' end)))));
      perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','planning funded fixture received');
      v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId',
        ('95000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'quotaVersion',1,'statuteId',v_statute)));
      perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','planning quota fixture confirmed');
    end loop;
  end loop;
  insert into planning_contract_samples values('empty planning snapshot','snapshot',public.plan_pull(v_group));
end; $$;

-- A mode initially left undecided can be chosen once, after funding and before any plan.
do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid := '94000000-0000-4000-8000-000000000003';
  v_statute uuid; v_data jsonb; v_result jsonb; begin
  v_data := jsonb_build_object('title','Escolha antes do plano','lotteryId','mega-sena','contestNumber',null,
    'deadlineAt','2099-01-01T00:00:00.000Z','quotaPriceCents','2500','participationMode','undecided','status','draft');
  perform public.sync_push(pg_temp.draft(v_group,v_pool,'pool',v_data));
  perform public.sync_push(pg_temp.draft(v_group,'95000000-0000-4000-8000-000000000031','quota',
    jsonb_build_object('poolId',v_pool,'personId','93000000-0000-4000-8000-000000000001','units',100)));
  perform public.sync_push(pg_temp.draft(v_group,'96000000-0000-4000-8000-000000000031','payment-proposal',
    jsonb_build_object('poolId',v_pool,'personId','93000000-0000-4000-8000-000000000001','amountCents','2500','note','','status','pending')));
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_confirm','proposalId','96000000-0000-4000-8000-000000000031',
    'proposalVersion',1,'bankReference',null,'declaredReceivedAt',null,'allocations',jsonb_build_array(jsonb_build_object('poolId',v_pool,'amountCents','2500')))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','undecided pool funded');
  select id into v_statute from public.statute_versions where group_id = v_group;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','95000000-0000-4000-8000-000000000031','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','legacy undecided pool can have confirmed right');
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_set(jsonb_set(v_data,'{participationMode}','"internal"'),'{quotaPriceCents}','"3000"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','first mode choice cannot change confirmed economics');
  v_data := jsonb_set(jsonb_set(v_data,'{participationMode}','"internal"'),'{contestNumber}','42');
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',v_data,1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','first participation choice allowed before any applied plan');
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_set(v_data,'{participationMode}','"official"'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','chosen mode cannot subsequently change with active rights');
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_set(v_data,'{contestNumber}','43'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','chosen contest cannot subsequently change with active rights');
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_set(v_data,'{contestNumber}','null'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','chosen contest cannot revert to undefined');
end; $$;

reset role;
do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid := '94000000-0000-4000-8000-000000000001';
  v_plan jsonb; v_result jsonb; begin
  perform public.sync_push(pg_temp.draft(v_group,'95000000-0000-4000-8000-000000000090','quota',
    jsonb_build_object('poolId',v_pool,'personId','93000000-0000-4000-8000-000000000003','units',100)));
  v_plan := pg_temp.prepared(v_group,v_pool);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%cotas preparadas%','eligible pending quota cannot be omitted from closing');
  delete from public.draft_records where id = '95000000-0000-4000-8000-000000000090';
  perform public.sync_push(pg_temp.draft(v_group,'96000000-0000-4000-8000-000000000090','payment-proposal',
    jsonb_build_object('poolId',v_pool,'personId','93000000-0000-4000-8000-000000000003','amountCents','2500','note','','status','pending')));
  v_plan := pg_temp.prepared(v_group,v_pool);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%propostas%','unreviewed payment proposal prevents plan application');
  delete from public.draft_records where id = '96000000-0000-4000-8000-000000000090';
end; $$;
set local role authenticated;

do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid := '94000000-0000-4000-8000-000000000001';
  v_plan jsonb; v_cmd jsonb; v_result jsonb; v_original jsonb; v_applied uuid; v_payment uuid; v_revision bigint; v_data jsonb; v_cash numeric; begin
  v_plan := pg_temp.prepared(v_group,v_pool); v_revision := (select revision from public.groups where id = v_group);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{catalogVersion}','"old-catalog"'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result -> 'receiptId' = 'null','old catalog rejected without fact receipt');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{sourceBets}','[]'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','omitted source bet rejected');
  v_data := jsonb_set(v_plan,'{rights,0,statuteId}',to_jsonb(gen_random_uuid()));
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_data)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','invented confirmed right rejected');
  v_data := jsonb_set(v_plan,'{bets,1,seed}',to_jsonb(repeat('cd',32)));
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_data)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','generated seed differs from approved plan');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{tickets,0,betCostCents}','"1"'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','invented ticket price rejected');
  for v_data in select jsonb_set(v_plan,'{groupPrizeLimitCents}',bad) from unnest(array['"0"','"-5"','"1.5"','"01"','""','"9007199254740992"','1500','{}']::jsonb[]) bad loop
    v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_data)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like 'Plano inválido%','invalid group prize limit rejected: ' || (v_data -> 'groupPrizeLimitCents')::text);
  end loop;
  perform pg_temp.assert_true((select count(*) = 0 from public.pool_plan_versions) and (select revision = v_revision from public.groups where id = v_group),'rejected plans leave versions and revision intact');
  insert into planning_contract_samples values('bad price receipt','receipt',v_result);

  v_data := (select data from public.draft_records where group_id = v_group and id = v_group);
  perform public.sync_push(pg_temp.draft(v_group,v_group,'group',jsonb_set(v_data,'{name}','"Grupo atualizado"'),1));
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan),gen_random_uuid(),v_revision));
  perform pg_temp.assert_true(v_result ->> 'status' = 'conflict','stale group approval is explicit conflict');
  insert into planning_contract_samples values('stale planning receipt','receipt',v_result);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'conflict','refreshing only envelope cannot rebase the old prepared plan');
  v_plan := pg_temp.prepared(v_group,v_pool); v_cash := (select sum(amount_cents) from public.financial_movements where kind in ('payment-received','payment-reversed'));
  v_cmd := pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan));
  v_original := public.planning_decide(v_cmd);
  perform pg_temp.assert_true(v_original ->> 'status' = 'accepted' and v_original ->> 'receiptId' <> v_cmd ->> 'idempotencyKey','applied fact uses a server receipt UUID');
  perform pg_temp.assert_true(public.planning_decide(v_cmd) = v_original and public.plan_command_status((v_cmd ->> 'idempotencyKey')::uuid) = v_original,'lost planning reply idempotently recovered');
  perform pg_temp.assert_true(public.planning_decide(jsonb_set(v_cmd,'{action,plan,explanation}','"Mudou"')) ->> 'status' = 'rejected'
    and public.plan_command_status((v_cmd ->> 'idempotencyKey')::uuid) = v_original,'changed key reuse preserves original planning receipt');
  perform pg_temp.assert_true((select count(*) = 1 from public.pool_plan_versions) and (select version = 1 from public.pool_plan_versions),'first immutable plan version');
  perform pg_temp.assert_true((select count(*) = 2 from public.draft_records where kind = 'bet'),'generated plan games do not become fixed drafts');
  perform pg_temp.assert_true(v_cash = (select sum(amount_cents) from public.financial_movements where kind in ('payment-received','payment-reversed')),'plan commitment does not duplicate cash');
  insert into planning_contract_samples values('applied plan receipt','receipt',v_original);
  select id into v_payment from public.received_payments where source_proposal_id = '96000000-0000-4000-8000-000000000011';
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_reverse','paymentId',v_payment,'reason','Tentativa de desfazer orçamento')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%comprometido%','draft plan commitment protects funded budget before lock');
  perform pg_temp.assert_true((select count(*) = 0 from public.quota_revocations),'failed reversal preserves rights');

  v_data := (select data from public.draft_records where id = '97000000-0000-4000-8000-000000000001');
  perform public.sync_push(pg_temp.draft(v_group,'97000000-0000-4000-8000-000000000001','bet',jsonb_set(v_data,'{authorIds}','["93000000-0000-4000-8000-000000000002"]'),1));
  select id into v_applied from public.pool_plan_versions where pool_id = v_pool;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',1,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId','93000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','changed fixed game forces reapplication before lock');
  v_plan := jsonb_set(pg_temp.prepared(v_group,v_pool),'{groupPrizeLimitCents}','"1500"');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted' and (select max(version) = 2 from public.pool_plan_versions where pool_id = v_pool),'reapplication appends a new plan version');
  perform pg_temp.assert_true((select prepared_plan ->> 'groupPrizeLimitCents' = '1500' and not (select prepared_plan ? 'groupPrizeLimitCents' from public.pool_plan_versions where pool_id = v_pool and version = 1)
    from public.pool_plan_versions where pool_id = v_pool and version = 2),'plan accepted with and without the group prize limit key');
  select id into v_applied from public.pool_plan_versions where pool_id = v_pool order by version desc limit 1;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',1,
    'appliedPlanId',(select id from public.pool_plan_versions where pool_id = v_pool and version = 1),
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId','93000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%mais recente%','only latest applied version can lock');
  v_cmd := pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',1,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId',null)));
  v_result := public.planning_decide(v_cmd);
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','informal mode requires explicit adult ticket holder');
  v_cmd := jsonb_set(v_cmd,'{idempotencyKey}',to_jsonb(gen_random_uuid()));
  v_cmd := jsonb_set(v_cmd,'{action,responsible,ticketHolderPersonId}','"93000000-0000-4000-8000-000000000001"');
  v_original := public.planning_decide(v_cmd);
  perform pg_temp.assert_true(v_original ->> 'status' = 'accepted','human lock confirmed');
  perform pg_temp.assert_true(public.planning_decide(v_cmd) = v_original,'lock retry returns original manifest');
  perform pg_temp.assert_true((select version = 2 and data ->> 'status' = 'locked' from public.draft_records where id = v_pool),'lock advances pool version/status');
  perform pg_temp.assert_true((select sha256 = encode(sha256(convert_to(canonical,'UTF8')),'hex') and content -> 'responsible' ->> 'organizerUserId' = '00000000-0000-4000-8000-000000000951' from public.pool_manifests where pool_id = v_pool),'canonical SHA and organizer come from server');
  perform pg_temp.assert_true((select jsonb_array_length(content -> 'persons') = 3 and content -> 'financial' -> 'groupRevision' < v_original -> 'groupRevision' from public.pool_manifests where pool_id = v_pool),'snapshot freezes people and historical financial revision');
  perform pg_temp.assert_true((select content -> 'plan' ->> 'groupPrizeLimitCents' = '1500' and canonical like '%"groupPrizeLimitCents":"1500"%' from public.pool_manifests where pool_id = v_pool and version = 1),'manifest freezes the group prize limit');
  insert into planning_contract_samples values('initial lock receipt','receipt',v_original);
end; $$;

do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid := '94000000-0000-4000-8000-000000000001';
  v_data jsonb; v_result jsonb; v_plan jsonb; v_applied uuid; v_first jsonb; v_revision bigint; begin
  v_revision := (select revision from public.groups where id = v_group);
  v_data := (select data from public.draft_records where id = '97000000-0000-4000-8000-000000000001');
  v_result := public.sync_push(pg_temp.draft(v_group,'97000000-0000-4000-8000-000000000001','bet',jsonb_set(v_data,'{poolId}','"94000000-0000-4000-8000-000000000002"'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','source bet cannot move away from locked pool');
  v_result := public.sync_push(pg_temp.draft(v_group,'97000000-0000-4000-8000-000000000090','bet',v_data));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','new draft bet cannot enter locked pool');
  v_data := (select data from public.draft_records where id = v_pool);
  v_result := public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_set(jsonb_set(v_data,'{status}','"draft"'),'{title}','"Mudança indevida"'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','locked pool cannot change title or reopen');
  v_data := (select data from public.draft_records where id = '93000000-0000-4000-8000-000000000003');
  v_result := public.sync_push(pg_temp.draft(v_group,'93000000-0000-4000-8000-000000000003','person',jsonb_set(v_data,'{adultDeclared}','false'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','frozen registrar cannot withdraw adulthood');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_reverse','paymentId',
    (select id from public.received_payments where source_proposal_id = '96000000-0000-4000-8000-000000000011'),'reason','Estorno depois da trava')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','locked financing cannot be reversed');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'frozen draft and finance attempts leave revision intact');
  v_first := (select content from public.pool_manifests where pool_id = v_pool and version = 1);
  v_plan := pg_temp.prepared(v_group,v_pool);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','locked pool supports safe plan revision before registration/deadline');
  select id into v_applied from public.pool_plan_versions where pool_id = v_pool order by version desc limit 1;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',2,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000001','ticketHolderPersonId','93000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','manifest revision cannot change original registrar');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',2,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId','93000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','manifest revision appends a new immutable version');
  perform pg_temp.assert_true((select count(*) = 2 from public.pool_manifests where pool_id = v_pool),'both manifest versions retained');
  perform pg_temp.assert_true((select content -> 'financial' = v_first -> 'financial' and content -> 'persons' = v_first -> 'persons'
    and content -> 'responsible' = v_first -> 'responsible' and content -> 'pool' ->> 'version' = '3' from public.pool_manifests where pool_id = v_pool and version = 2),'revision preserves funding/persons/responsible and advances pool version');
  perform pg_temp.assert_true((select not (content -> 'plan' ? 'groupPrizeLimitCents') and canonical not like '%groupPrizeLimitCents%' from public.pool_manifests where pool_id = v_pool and version = 2),'plan without the key locks without inventing it');
  insert into planning_contract_samples values('revised lock receipt','receipt',v_result);
  v_pool := '94000000-0000-4000-8000-000000000002'; v_plan := pg_temp.prepared(v_group,v_pool);
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{tickets,0,officialQuotaCount}','100'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','number-count specific official quota maximum enforced');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{groupPrizeLimitCents}','"1500"'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' = 'O limite de prêmio para o caixa do grupo só vale no combinado interno.','group prize limit refused on official participation');
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',jsonb_set(v_plan,'{groupPrizeLimitCents}','null'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','2:1 rights fit exact official count/value, with a null group prize limit');
  select id into v_applied from public.pool_plan_versions where pool_id = v_pool order by version desc limit 1;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',1,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId',null))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','official planning lock does not fabricate ticket holder or receipt');
  perform pg_temp.assert_true((select content #> '{plan,groupPrizeLimitCents}' = 'null'::jsonb from public.pool_manifests where pool_id = v_pool and version = 1),'manifest keeps an explicit null group prize limit');
  insert into planning_contract_samples values('official lock receipt','receipt',v_result);
  insert into planning_contract_samples values('complete planning snapshot','snapshot',public.plan_pull(v_group));
  begin insert into public.pool_manifests(id,group_id,pool_id,version,applied_plan_id,content,canonical,sha256,locked_at,receipt_id)
    values(gen_random_uuid(),v_group,v_pool,99,v_applied,'{}','{}',repeat('0',64),now(),gen_random_uuid()); raise exception 'browser manifest insert accepted'; exception when insufficient_privilege then null; end;
end; $$;

reset role;
do $$ begin
  begin update public.pool_plan_versions set budget_cents = 1; raise exception 'immutable plan update accepted'; exception when insufficient_privilege then null; end;
  begin delete from public.pool_manifests; raise exception 'immutable manifest delete accepted'; exception when insufficient_privilege then null; end;
  begin update public.planning_command_receipts set response_payload = '{}'; raise exception 'immutable planning receipt update accepted'; exception when insufficient_privilege then null; end;
  begin delete from public.draft_records where id = '93000000-0000-4000-8000-000000000003'; raise exception 'frozen registrar delete accepted'; exception when check_violation then null; end;
end; $$;

-- Administrative temporary states exercise boundaries that draft clients cannot manufacture.
do $$ declare v_group uuid := '91000000-0000-4000-8000-000000000001'; v_pool uuid := '94000000-0000-4000-8000-000000000001';
  v_data jsonb; v_plan jsonb; v_result jsonb; v_applied uuid; v_revision bigint; v_pull jsonb; begin
  v_data := (select data from public.draft_records where id = v_pool);
  v_revision := (select revision from public.groups where id = v_group);
  v_plan := pg_temp.prepared(v_group,v_pool);
  alter table public.draft_records disable trigger financial_drafts_guard;
  update public.draft_records set data = jsonb_set(v_data,'{deadlineAt}','null') where id = v_pool;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','missing deadline cannot apply');
  update public.draft_records set data = jsonb_set(v_data,'{status}','"registered"') where id = v_pool;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','registered pool cannot revise plan');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'deadline/state rejections do not advance group');
  update public.draft_records set data = jsonb_set(v_data,'{deadlineAt}','"2000-01-01T00:00:00.000Z"') where id = v_pool;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',v_plan)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','server accepts a plan revision after the deadline while the pool is not registered');
  select id into v_applied from public.pool_plan_versions where pool_id = v_pool order by version desc limit 1;
  v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',3,'appliedPlanId',v_applied,
    'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId','93000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','server accepts a revision lock after the deadline');
  v_revision := (select revision from public.groups where id = v_group);
  update public.draft_records set data = v_data where id = v_pool;
  alter table public.draft_records enable trigger financial_drafts_guard;
  v_pull := public.sync_pull(v_group,0);
  perform pg_temp.assert_true(v_pull -> 'hasMore' = 'false' and (v_pull ->> 'nextCursor')::bigint = v_revision,'draft cursor reaches current head including financial and planning markers');
  perform pg_temp.assert_true(jsonb_array_length(v_pull -> 'changes') = v_revision,'every accepted draft/finance/planning action occupies one feed revision');
end; $$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000952","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000952","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.pool_manifests),'other account cannot read private manifests');
  begin perform public.plan_pull('91000000-0000-4000-8000-000000000001'); raise exception 'cross-account plan pull accepted'; exception when insufficient_privilege then null; end;
  begin perform public.planning_decide(pg_temp.command('91000000-0000-4000-8000-000000000001','{"type":"plan_apply","plan":{}}',gen_random_uuid(),0)); raise exception 'cross-account planning write accepted'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","client_id":"90000000-0000-4000-8000-000000000951","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.pool_manifests),'delegated agent cannot read manifests');
  begin perform public.planning_decide(pg_temp.command('91000000-0000-4000-8000-000000000001','{"type":"plan_apply","plan":{}}',gen_random_uuid(),0)); raise exception 'agent planning approval accepted'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
update auth.users set raw_app_meta_data = '{"actor_type":"agent"}' where id = '00000000-0000-4000-8000-000000000951';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.pool_manifests),'old human JWT cannot read after account marked agent');
  begin perform public.planning_decide(pg_temp.command('91000000-0000-4000-8000-000000000001','{"type":"plan_apply","plan":{}}',gen_random_uuid(),0)); raise exception 'old human token planning accepted'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
select label,kind,data from planning_contract_samples order by label;
rollback;
