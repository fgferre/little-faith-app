-- Registration/result assertions use synthetic human sessions; no external bet is made.
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
create temporary table stage5_contract_samples(label text,kind text,data jsonb);
grant all on stage5_contract_samples to authenticated,service_role;

create function pg_temp.observed_items(p_pool uuid,p_count integer default 1000,p_mismatch boolean default false,p_at text default null) returns jsonb
language plpgsql as $$
declare m public.pool_manifests; t jsonb; games jsonb; items jsonb := '[]'; o jsonb; i integer := 0; proof uuid;
begin
  select * into m from public.pool_manifests where pool_id = p_pool order by version desc limit 1;
  select id into proof from public.evidence_originals where pool_id = p_pool order by uploaded_at,id limit 1;
  for t in select value from jsonb_array_elements(m.content -> 'plan' -> 'tickets') loop
    i := i+1; o := null;
    if i <= p_count then
      select jsonb_agg(b.value -> 'numbers' order by k.ordinality) into games
        from jsonb_array_elements(t -> 'betKeys') with ordinality k(value,ordinality)
        join lateral jsonb_array_elements(m.content -> 'plan' -> 'bets') b on b.value -> 'key' = k.value;
      o := jsonb_build_object('lotteryId','mega-sena','contestNumber',case when p_mismatch then 43 else 42 end,
        'betNumbers',games,'betCostCents',t -> 'betCostCents','feeCents','0','officialQuotaCount',t -> 'officialQuotaCount',
        'officialAssignments',case when m.content -> 'plan' ->> 'participationMode' = 'official' then t -> 'assignments' else 'null'::jsonb end,
        'registeredAt',coalesce(p_at,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    end if;
    items := items || jsonb_build_array(jsonb_build_object('plannedTicketKey',t -> 'key','evidenceIds',case when o is null then '[]'::jsonb else jsonb_build_array(proof) end,
      'observed',o,'reason',case when p_mismatch or p_at is not null then 'Divergência observada e preservada no original.' else '' end));
  end loop;
  return items;
end;
$$;
create function pg_temp.registration(p_pool uuid,p_items jsonb,p_reason text default '',p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$
  select pg_temp.command('91000000-0000-4000-8000-000000000001',jsonb_build_object('type','registration_confirm','poolId',p_pool,
    'poolVersion',(select version from public.draft_records where id = p_pool),'manifestId',(select id from public.pool_manifests where pool_id = p_pool order by version desc limit 1),
    'items',p_items,'reason',p_reason),p_key,p_revision);
$$;

do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid; r jsonb; plan_id uuid; i integer;
begin
  insert into stage5_contract_samples values('empty registration','registration-snapshot',public.registration_pull(g)),('empty results','result-snapshot',public.results_pull(g));
  for i in 1..2 loop
    p := ('94000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(g,p))));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','registration fixture plan applied');
    select id into plan_id from public.pool_plan_versions where pool_id = p order by version desc limit 1;
    r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','pool_lock','poolId',p,'poolVersion',1,'appliedPlanId',plan_id,
      'responsible',jsonb_build_object('registrarPersonId','93000000-0000-4000-8000-000000000003','ticketHolderPersonId',case when i = 1 then '93000000-0000-4000-8000-000000000003' else null end))));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','registration fixture latest manifest locked');
  end loop;
  -- A pending replacement plan does not silently replace the last actually locked list.
  r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(g,'94000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','later plan pending without a replacement manifest');
end; $$;

reset role;
insert into storage.objects(bucket_id,name) values
  ('evidence','91000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000001.pdf'),
  ('evidence','91000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000002.pdf');
do $$ begin
  begin update storage.objects set name = name || '.pdf' where bucket_id = 'evidence'; raise exception 'original update unexpectedly allowed'; exception when insufficient_privilege then null; end;
  begin delete from storage.objects where bucket_id = 'evidence'; raise exception 'original deletion unexpectedly allowed'; exception when insufficient_privilege then null; end;
end; $$;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; meta jsonb; r jsonb; rev bigint; i integer;
begin
  for i in 1..2 loop
    meta := jsonb_build_object('id',('98000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'groupId',g,
      'poolId',('94000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'sha256',encode(sha256(convert_to('%PDF-fixture','UTF8')),'hex'),
      'mimeType','application/pdf','byteSize',12,'originalName','Original privado São João.pdf');
    r := public.evidence_seal(meta,'00000000-0000-4000-8000-000000000951');
    insert into stage5_contract_samples values('immutable original ' || i,'evidence',r);
    perform pg_temp.assert_true(public.evidence_seal(meta,'00000000-0000-4000-8000-000000000951') = r,'same original retry preserves metadata');
    begin perform public.evidence_seal(meta || '{"originalName":"alterado.pdf"}','00000000-0000-4000-8000-000000000951'); raise exception 'changed metadata unexpectedly allowed'; exception when invalid_parameter_value then null; end;
  end loop;
end; $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","app_metadata":{}}',true);

do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid := '94000000-0000-4000-8000-000000000001'; cmd jsonb; r jsonb; original jsonb; rev bigint; before_count bigint;
begin
  begin perform public.evidence_seal('{}','00000000-0000-4000-8000-000000000951'); raise exception 'human sealing unexpectedly allowed'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true(public.evidence_status('98000000-0000-4000-8000-000000000001') is not null,'human reads private metadata');
  select count(*) into before_count from public.registration_reports;
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p,1) - 3));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and (select count(*) from public.registration_reports) = before_count,'omitted planned cartela rejected without report');
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p,1), '',gen_random_uuid(),0));
  perform pg_temp.assert_true(r ->> 'status' = 'conflict','stale registration revision explicit conflict');
  insert into stage5_contract_samples values('registration conflict','registration-receipt',r);
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p,1,false,'2099-01-01T01:00:00.000Z')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','future observed event rejected');
  cmd := pg_temp.registration(p,pg_temp.observed_items(p,1));
  r := public.registration_decide(cmd); original := r;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'reports' -> 0 -> 'comparison' ->> 'status' = 'partial','first partial observation accepted explicitly');
  perform pg_temp.assert_true((select data ->> 'status' from public.draft_records where id = p) = 'registered','partial external observation seals registered');
  select revision into rev from public.groups where id = g;
  perform pg_temp.assert_true(public.registration_decide(cmd) = original and (select revision from public.groups where id = g) = rev,'lost-response registration retry no new fact');
  r := public.registration_decide(jsonb_set(cmd,'{action,reason}','"changed"'));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and public.registration_command_status((cmd ->> 'idempotencyKey')::uuid) = original,'changed key payload cannot replace first receipt');
  insert into stage5_contract_samples values('partial registered','registration-receipt',original);
  r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(g,p))));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','external observation blocks even pending plan revision');
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p,1000,true),'Original contém concurso divergente.'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'reports' -> 1 -> 'comparison' ->> 'status' = 'divergent','divergence recorded without claiming complete');
  insert into stage5_contract_samples values('divergent registered','registration-receipt',r);
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p),'Revisão humana de todas as cartelas originais.'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'reports' -> 2 -> 'comparison' ->> 'status' = 'complete','complete revision preserves historical divergence and seal');
  insert into stage5_contract_samples values('complete registered','registration-receipt',r);
  -- Official receipts require the exact participant allocation, not just a quota count.
  p := '94000000-0000-4000-8000-000000000002';
  r := public.registration_decide(pg_temp.registration(p,jsonb_set(pg_temp.observed_items(p),'{0,observed,officialAssignments}','null')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'reports' -> 3 -> 'comparison' ->> 'status' = 'partial','unknown official assignments remain partial');
  insert into stage5_contract_samples values('official assignments unknown','registration-receipt',r);
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p),'Titulares e cotas conferidos nos originais.'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'reports' -> 4 -> 'comparison' ->> 'status' = 'complete','official participant allocations matched');
  insert into stage5_contract_samples values('official complete','registration-receipt',r);
end; $$;

-- Manual results/calendar do not create money; clocks and raw decision evidence are append-only.
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid := '94000000-0000-4000-8000-000000000001'; cmd jsonb; r jsonb; original jsonb; rid uuid; ids jsonb; rev bigint;
begin
  cmd := pg_temp.command(g,jsonb_build_object('type','result_manual','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',42,'drawDate','2026-10-08','drawnNumbers','[1,2,3,4,5,6]'::jsonb,'payouts',null),
    'sourceReference','Conferência humana documentada','reason','Fonte externa temporariamente indisponível.'));
  r := public.result_decide(cmd); original := r;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','manual result explicit human decision');
  insert into stage5_contract_samples values('manual result unknown payouts','result-receipt',r);
  select revision into rev from public.groups where id = g;
  perform pg_temp.assert_true(public.result_decide(cmd) = original and (select revision from public.groups where id = g) = rev,'manual result idempotent lost reply');
  perform pg_temp.assert_true(public.result_decide(jsonb_set(cmd,'{action,reason}','"changed"')) ->> 'status' = 'rejected'
    and public.result_command_status((cmd ->> 'idempotencyKey')::uuid) = original,'manual changed payload original intact');
  rid := (r -> 'snapshot' -> 'results' -> 0 ->> 'id')::uuid; ids := jsonb_build_array(rid);
  r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_resolve','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'resultId',rid,'observedResultIds',ids,'reason','Decisão explícita da fonte usada na apuração.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','human selection links complete observed version set');
  insert into stage5_contract_samples values('manual source selected','result-receipt',r);
  r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_manual','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',42,'drawDate','2026-10-08','drawnNumbers','[2,3,4,5,6,7]'::jsonb,'payouts',null),
    'sourceReference','Outra fonte humana','reason','Dezenas divergentes preservadas para resolução.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','new conflicting version preserved');
  insert into stage5_contract_samples values('new conflicting result','result-receipt',r);
  r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_resolve','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'resultId',rid,'observedResultIds',ids,'reason','Conjunto incompleto de fontes.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','selection cannot omit newer conflicting source');
  insert into stage5_contract_samples values('omitted source rejected','result-receipt',r);
  cmd := pg_temp.command(g,jsonb_build_object('type','calendar_confirm','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'lotteryId','mega-sena','contestNumber',42,'drawDate','2026-10-08','expectedDrawAt','2026-10-08T23:00:00.000Z','registrationClosesAt','2026-10-08T22:00:00.000Z',
    'sourceReference','Calendário observado no canal','reason','Horário do concurso em Brasília confirmado explicitamente.'));
  r := public.result_decide(cmd);
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','per-contest manual calendar accepted');
  insert into stage5_contract_samples values('calendar UTC Brasília','result-receipt',r);
  perform pg_temp.assert_true((select count(*) from public.financial_movements) = 8,'registration and all result actions create no cash');
  -- A channel deadline already past is preserved as divergence, never silently turned complete.
  cmd := pg_temp.command(g,jsonb_build_object('type','calendar_confirm','poolId',p,'poolVersion',(select version from public.draft_records where id = p),
    'lotteryId','mega-sena','contestNumber',42,'drawDate','2000-01-01','expectedDrawAt','2000-01-01T23:00:00.000Z','registrationClosesAt','2000-01-01T22:00:00.000Z',
    'sourceReference','Comprovante histórico do canal','reason','Versão corrigida do fechamento externo.'));
  r := public.result_decide(cmd); perform pg_temp.assert_true(r ->> 'status' = 'accepted','historical calendar explicit');
  r := public.registration_decide(pg_temp.registration(p,pg_temp.observed_items(p,1000,false,to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'Registro observado depois do prazo externo; preservar ocorrência.'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select comparison ->> 'status' from public.registration_reports where pool_id = p order by version desc limit 1) = 'divergent','late external registration recorded divergent');
  insert into stage5_contract_samples values('late registration frozen calendar','registration-receipt',r);
end; $$;

-- A teimosinha keeps results, reviews, calendars and collection jobs per contest; any contest of its range is in scope.
create function pg_temp.teimosinha_action(p_action jsonb) returns jsonb
language sql as $$ select pg_temp.command('91000000-0000-4000-8000-000000000001',jsonb_build_object('poolId','94000000-0000-4000-8000-000000000021',
  'poolVersion',(select version from public.draft_records where id = '94000000-0000-4000-8000-000000000021')) || p_action); $$;
create function pg_temp.teimosinha_manual(p_contest integer,p_numbers jsonb) returns jsonb
language sql as $$ select pg_temp.teimosinha_action(jsonb_build_object('type','result_manual','sourceReference','Conferência humana do concurso ' || p_contest,
  'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',p_contest,'drawDate','2026-10-08','drawnNumbers',p_numbers,'payouts',null),
  'reason','Resultado de um dos concursos da teimosinha.')); $$;
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid := '94000000-0000-4000-8000-000000000021'; r jsonb; first_id uuid; ids jsonb;
begin
  r := public.sync_push(pg_temp.draft(g,p,'pool','{"title":"Teimosinha","lotteryId":"mega-sena","contestNumber":42,"contestCount":2,"deadlineAt":null,
    "quotaPriceCents":"2500","participationMode":"undecided","status":"draft"}'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha draft covers contests 42 and 43');
  perform pg_temp.assert_true(public.result_decide(pg_temp.teimosinha_manual(42,'[1,2,3,4,5,6]')) ->> 'status' = 'accepted','manual result of the first contest');
  perform pg_temp.assert_true(public.result_decide(pg_temp.teimosinha_manual(43,'[7,8,9,10,11,12]')) ->> 'status' = 'accepted','manual result of the second contest');
  perform pg_temp.assert_true((select jsonb_agg(contest_number order by version) from public.contest_result_versions where pool_id = p) = '[42,43]','results stored with their contest');
  r := public.result_decide(pg_temp.teimosinha_manual(44,'[1,2,3,4,5,6]'));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'O resultado manual pertence a outra modalidade ou concurso.','contest after the range refused');
  perform pg_temp.assert_true(public.result_decide(pg_temp.teimosinha_manual(43,'[8,9,10,11,12,13]')) ->> 'status' = 'accepted','conflicting version of contest 43 preserved');
  select id into first_id from public.contest_result_versions where pool_id = p and contest_number = 42;
  select jsonb_agg(id order by version) into ids from public.contest_result_versions where pool_id = p and contest_number = 43;
  r := public.result_decide(pg_temp.teimosinha_action(jsonb_build_object('type','result_resolve','resultId',ids -> 1,'observedResultIds',ids || to_jsonb(first_id),
    'reason','Revisão que mistura concursos.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','a review of contest 43 cannot list the version of contest 42');
  r := public.result_decide(pg_temp.teimosinha_action(jsonb_build_object('type','result_resolve','resultId',ids -> 1,'observedResultIds',ids,
    'reason','Fonte do concurso 43 escolhida explicitamente.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','a review lists exactly the versions of one contest');
  insert into stage5_contract_samples values('teimosinha contest resolved','result-receipt',r);
  r := public.result_decide(pg_temp.teimosinha_action('{"type":"calendar_confirm","lotteryId":"mega-sena","contestNumber":42,"drawDate":"2099-01-03",
    "expectedDrawAt":"2099-01-03T23:00:00.000Z","registrationClosesAt":"2099-01-03T22:00:00.000Z","sourceReference":"Calendário do concurso 42","reason":"Sorteio do primeiro concurso."}'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','calendar of the first contest');
  r := public.result_decide(pg_temp.teimosinha_action('{"type":"calendar_confirm","lotteryId":"mega-sena","contestNumber":43,"drawDate":"2099-01-06",
    "expectedDrawAt":"2099-01-06T23:00:00.000Z","registrationClosesAt":"2099-01-06T22:00:00.000Z","sourceReference":"Calendário do concurso 43","reason":"Sorteio do segundo concurso."}'));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted'
    and (select jsonb_agg(jsonb_build_array(j.contest_number,c.contest_number) order by j.contest_number) from public.result_collection_jobs j
      join public.contest_calendar_versions c on c.id = j.calendar_id where j.pool_id = p) = '[[42,42],[43,43]]','calendar of contest 43 adds its own job and keeps the job of 42');
  perform pg_temp.assert_true(public.result_collection_context(g,p,43) ->> 'contestNumber' = '43' and public.result_collection_context(g,p) ->> 'contestNumber' = '42','collection context per contest, first by default');
  begin perform public.result_collection_context(g,p,44); raise exception 'contest outside the range accepted';
  exception when invalid_parameter_value then perform pg_temp.assert_true(sqlerrm = 'contest_out_of_range','collection context refuses a contest outside the range'); end;
end; $$;
reset role;
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid := '94000000-0000-4000-8000-000000000021';
begin
  perform pg_temp.assert_true(private.settlement_current_result(g,p) -> 'result' ->> 'id' = (select id::text from public.contest_result_versions where pool_id = p and contest_number = 42),
    'settlement reads the first contest by default');
  perform pg_temp.assert_true(private.settlement_current_result(g,p,43) ->> 'status' = 'manual'
    and private.settlement_current_result(g,p,43) -> 'result' ->> 'id' = (select result_id::text from public.result_selections where pool_id = p),'settlement reads the resolved version of contest 43');
end; $$;
set local role authenticated;

-- Actual public JSON fixtures were collected read-only; SQL stores exact bytes as UTF-8 text.
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid; i integer; r jsonb; data jsonb;
begin
  for i in 1..3 loop
    p := ('94000000-0000-4000-8000-' || lpad((i+10)::text,12,'0'))::uuid;
    select parsed into data from public.sql_official_fixtures where lottery = case i when 1 then 'mega-sena' when 2 then 'lotofacil' else 'quina' end;
    r := public.sync_push(pg_temp.draft(g,p,'pool',jsonb_build_object('title','Fonte oficial ' || i,'lotteryId',data -> 'lotteryId','contestNumber',data -> 'contestNumber',
      'deadlineAt',null,'quotaPriceCents','2500','participationMode','undecided','status','draft')));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','official-source fixture draft');
  end loop;
end; $$;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid; i integer; r jsonb; data jsonb; original jsonb;
begin
  r := public.result_jobs_due(20);
  perform pg_temp.assert_true(jsonb_array_length(r) = 1,'explicit historical calendar creates a due collection job');
  perform pg_temp.assert_true(jsonb_array_length(public.result_jobs_due(20)) = 0,'durable five-minute claim prevents immediate duplicate collector work');
  for i in 1..3 loop
    p := ('94000000-0000-4000-8000-' || lpad((i+10)::text,12,'0'))::uuid;
    select parsed into data from public.sql_official_fixtures where lottery = case i when 1 then 'mega-sena' when 2 then 'lotofacil' else 'quina' end;
    r := public.result_collect_seal(g,p,'00000000-0000-4000-8000-000000000951',data); original := r;
    perform pg_temp.assert_true(public.result_collect_seal(g,p,'00000000-0000-4000-8000-000000000951',data) = original,'same exact raw collection no duplicate fact');
    insert into stage5_contract_samples values('official original ' || i,'result-snapshot',r);
    begin perform public.result_collect_seal(g,p,'00000000-0000-4000-8000-000000000951',data || '{"sourceUrl":"https://other.invalid"}'); raise exception 'non-allowlisted source accepted'; exception when invalid_parameter_value then null; end;
  end loop;
  perform public.result_collection_attempt(g,'94000000-0000-4000-8000-000000000011','invalid-source','invalid_json',
    'https://servicebus2.caixa.gov.br/portaldeloterias/api/megasena/3000',' {broken} ');
end; $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","app_metadata":{}}',true);
do $$ declare g uuid := '91000000-0000-4000-8000-000000000001'; p uuid := '94000000-0000-4000-8000-000000000011'; r jsonb; d jsonb;
begin
  select data into d from public.draft_records where id = p;
  r := public.sync_push(pg_temp.draft(g,p,'pool',d || '{"contestNumber":3001}',1));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','published contest source freezes contest even without quotas');
  r := public.sync_push(pg_temp.draft(g,p,'pool',d || '{"lotteryId":"quina"}',1));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','published contest source freezes lottery even without quotas');
  r := public.sync_push(pg_temp.draft(g,p,'pool',d || '{"title":"Título novo permitido"}',1));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','unrelated draft title remains editable');
  perform pg_temp.assert_true((select raw_text from public.result_collection_attempts where outcome = 'invalid-source') = ' {broken} ','invalid JSON original retained unchanged');
  perform pg_temp.assert_true((select count(*) from public.contest_result_versions where pool_id = p) = 1,'failed collection preserves last valid source');
  insert into stage5_contract_samples values('final registration','registration-snapshot',public.registration_pull(g)),('final results','result-snapshot',public.results_pull(g));
  r := public.sync_pull(g,0); perform pg_temp.assert_true((r ->> 'nextCursor')::bigint = (select revision from public.groups where id = g) and r ->> 'hasMore' = 'false','all technical/human fact markers advance shared cursor to head');
end; $$;

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000952","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000952","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) from public.registration_reports) = 0 and (select count(*) from public.evidence_originals) = 0
    and (select count(*) from public.contest_result_versions) = 0,'RLS hides all private facts from another account');
  begin perform public.registration_pull('91000000-0000-4000-8000-000000000001'); raise exception 'foreign registration pull allowed'; exception when insufficient_privilege then null; end;
  begin perform public.results_pull('91000000-0000-4000-8000-000000000001'); raise exception 'foreign result pull allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
update auth.users set raw_app_meta_data = '{"actor_type":"agent"}' where id = '00000000-0000-4000-8000-000000000951';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000951","app_metadata":{}}',true);
do $$ begin
  begin perform public.registration_pull('91000000-0000-4000-8000-000000000001'); raise exception 'old human JWT agent registration pull allowed'; exception when insufficient_privilege then null; end;
  begin perform public.results_pull('91000000-0000-4000-8000-000000000001'); raise exception 'old human JWT agent result pull allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
  begin update public.registration_reports set reason = 'rewritten'; raise exception 'report rewrite allowed'; exception when insufficient_privilege then null; end;
  begin delete from public.contest_result_versions; raise exception 'original result deletion allowed'; exception when insufficient_privilege then null; end;
end; $$;
select label,kind,data from stage5_contract_samples order by label;
rollback;
