-- Settlement assertions use synthetic human sessions; no real prize, bank transfer or bet is made.
begin;
create function pg_temp.assert_true(p_condition boolean,p_label text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.draft(p_group uuid,p_id uuid,p_kind text,p_data jsonb,p_version bigint default 0) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
  'entityId',p_id,'kind',p_kind,'expectedVersion',p_version,'data',p_data,'createdAt','2026-10-08T12:00:00.000Z'); $$;
create function pg_temp.command(p_group uuid,p_action jsonb,p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',p_key,'groupId',p_group,
  'expectedRevision',coalesce(p_revision,(select revision from public.groups where id = p_group)),'action',p_action); $$;
create temporary table settlement_contract_samples(label text,kind text,data jsonb);
grant all on settlement_contract_samples to authenticated,service_role;

-- Same fixture as registration/results: four known games, 2:1 rights, two internal pools and one official pool (the official one and pool 3 keep their leftover as group credit; pool 3 also freezes a prize limit).
-- p_contests > 1 is a teimosinha: the plan carries contestCount and every catalog cost is multiplied by it.
create function pg_temp.prepared(p_group uuid,p_pool uuid,p_policy text default 'refund-pro-rata',p_limit text default null,p_contests integer default 1) returns jsonb language plpgsql as $$
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
        'betCostCents',(600*p_contests)::text,'officialQuotaCount',null,'officialQuotaValueCents',null,'assignments','[]'::jsonb)); end loop;
  else
    select jsonb_agg(jsonb_build_object('quotaId',value -> 'quotaId','personId',value -> 'personId','officialQuotas',(value ->> 'units')::integer / 50)) into v_assignments from jsonb_array_elements(v_rights);
    v_tickets := jsonb_build_array(jsonb_build_object('key','ticket-1','numberCount',6,'betKeys','["fixed-1","generated-1","generated-2","generated-3"]'::jsonb,
      'betCostCents',(2400*p_contests)::text,'officialQuotaCount',3,'officialQuotaValueCents',(800*p_contests)::text,'assignments',v_assignments));
  end if;
  return jsonb_build_object('id',gen_random_uuid(),'groupId',p_group,'poolId',p_pool,'poolVersion',v_pool.version,
    'groupRevision',(select revision from public.groups where id = p_group),'lotteryId','mega-sena','contestNumber',42,'participationMode',v_pool.data -> 'participationMode',
    'strategy','balanced','seed',repeat('ab',32),'catalogVersion','caixa-pools-2026-10-08-v1','sourceBets',jsonb_build_array(jsonb_build_object('id',v_source.id,'version',v_source.version)),
    'rights',v_rights,'budgetCents',v_budget::text,'betCostCents',(2400*p_contests)::text,'feeCents','0','feeLabel','','totalCostCents',(2400*p_contests)::text,
    'leftoverCents',(v_budget-2400*p_contests)::text,'leftoverPolicy',p_policy,'bets',v_bets,'tickets',v_tickets,'explanation','Plano privado de apuração 🙂.')
    || case when p_limit is null then '{}'::jsonb else jsonb_build_object('groupPrizeLimitCents',p_limit) end
    || case when p_contests = 1 then '{}'::jsonb else jsonb_build_object('contestCount',p_contests) end;
end;
$$;
create function pg_temp.observed_items(p_pool uuid) returns jsonb
language plpgsql as $$
declare m public.pool_manifests; t jsonb; games jsonb; items jsonb := '[]'; proof uuid;
begin
  select * into m from public.pool_manifests where pool_id = p_pool order by version desc limit 1;
  select id into proof from public.evidence_originals where pool_id = p_pool order by uploaded_at,id limit 1;
  for t in select value from jsonb_array_elements(m.content -> 'plan' -> 'tickets') loop
    select jsonb_agg(b.value -> 'numbers' order by k.ordinality) into games
      from jsonb_array_elements(t -> 'betKeys') with ordinality k(value,ordinality)
      join lateral jsonb_array_elements(m.content -> 'plan' -> 'bets') b on b.value -> 'key' = k.value;
    items := items || jsonb_build_array(jsonb_build_object('plannedTicketKey',t -> 'key','evidenceIds',jsonb_build_array(proof),
      'observed',jsonb_build_object('lotteryId','mega-sena','contestNumber',42,'betNumbers',games,'betCostCents',t -> 'betCostCents','feeCents','0',
        'officialQuotaCount',t -> 'officialQuotaCount','officialAssignments',case when m.content -> 'plan' ->> 'participationMode' = 'official' then t -> 'assignments' else 'null'::jsonb end,
        'registeredAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'reason',''));
  end loop;
  return items;
end;
$$;
create function pg_temp.settle(p_action jsonb,p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$ select pg_temp.command('a1000000-0000-4000-8000-000000000001',p_action,p_key,p_revision); $$;
create function pg_temp.pool_version(p_pool uuid) returns bigint language sql as $$ select version from public.draft_records where id = p_pool; $$;
create function pg_temp.now_json() returns text language sql as $$ select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); $$;

insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000971','settlement-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000972','settlement-b@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{}}',true);

do $$ declare v_group uuid := 'a1000000-0000-4000-8000-000000000001'; v_pool uuid; v_person uuid; v_statute uuid; v_result jsonb; plan_id uuid; i integer; j integer; begin
  perform public.sync_push(pg_temp.draft(v_group,v_group,'group','{"name":"Apuração privada","statute":"Regras privadas de rateio 🙂"}'));
  for i in 1..3 loop
    v_person := ('a3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    perform public.sync_push(pg_temp.draft(v_group,v_person,'person',jsonb_build_object('name','Pessoa ' || i,'nickname','','adultDeclared',true)));
  end loop;
  for i in 1..3 loop
    v_pool := ('a4000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    perform public.sync_push(pg_temp.draft(v_group,v_pool,'pool',jsonb_build_object('title','Bolão ' || i,'lotteryId','mega-sena','contestNumber',42,
      'deadlineAt','2099-01-01T00:00:00Z','quotaPriceCents','2500','participationMode',case when i = 2 then 'official' else 'internal' end,'status','draft')));
    perform public.sync_push(pg_temp.draft(v_group,('a7000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'bet',jsonb_build_object('poolId',v_pool,
      'lotteryId','mega-sena','numbers','[1,2,3,4,5,6]'::jsonb,'authorIds','["a3000000-0000-4000-8000-000000000001"]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null)));
    for j in 1..2 loop
      v_person := ('a3000000-0000-4000-8000-' || lpad(j::text,12,'0'))::uuid;
      perform public.sync_push(pg_temp.draft(v_group,('a5000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'quota',
        jsonb_build_object('poolId',v_pool,'personId',v_person,'units',case when j = 1 then 100 else 50 end)));
      perform public.sync_push(pg_temp.draft(v_group,('a6000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'payment-proposal',
        jsonb_build_object('poolId',v_pool,'personId',v_person,'amountCents',case when j = 1 then '2500' else '1250' end,'note','','status','pending')));
    end loop;
  end loop;
  perform public.review_decide(pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":1}'));
  select id into v_statute from public.statute_versions where group_id = v_group;
  for j in 1..2 loop
    v_person := ('a3000000-0000-4000-8000-' || lpad(j::text,12,'0'))::uuid;
    perform public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','statute_accept','statuteId',v_statute,'personId',v_person,'evidence','Aceite privado confirmado pelo organizador')));
  end loop;
  for i in 1..3 loop
    v_pool := ('a4000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    for j in 1..2 loop
      v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_confirm','proposalId',
        ('a6000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'proposalVersion',1,'bankReference',null,'declaredReceivedAt',null,
        'allocations',jsonb_build_array(jsonb_build_object('poolId',v_pool,'amountCents',case when j = 1 then '2500' else '1250' end)))));
      perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','settlement funded fixture received');
      v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId',
        ('a5000000-0000-4000-8000-' || lpad((i*10+j)::text,12,'0'))::uuid,'quotaVersion',1,'statuteId',v_statute)));
      perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','settlement quota fixture confirmed');
    end loop;
    v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(v_group,v_pool,case when i = 1 then 'refund-pro-rata' else 'group-credit' end,case when i = 3 then '5000000' end))));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','settlement fixture plan applied');
    select id into plan_id from public.pool_plan_versions where pool_id = v_pool order by version desc limit 1;
    v_result := public.planning_decide(pg_temp.command(v_group,jsonb_build_object('type','pool_lock','poolId',v_pool,'poolVersion',pg_temp.pool_version(v_pool),'appliedPlanId',plan_id,
      'responsible',jsonb_build_object('registrarPersonId','a3000000-0000-4000-8000-000000000003','ticketHolderPersonId',case when i <> 2 then 'a3000000-0000-4000-8000-000000000003' else null end))));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','settlement fixture manifest locked');
  end loop;
end; $$;

reset role;
insert into storage.objects(bucket_id,name) values
  ('evidence','a1000000-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000001.pdf'),
  ('evidence','a1000000-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000002.pdf'),
  ('evidence','a1000000-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000003.pdf');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare i integer; begin
  for i in 1..3 loop
    perform public.evidence_seal(jsonb_build_object('id',('a8000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'groupId','a1000000-0000-4000-8000-000000000001',
      'poolId',('a4000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'sha256',encode(sha256(convert_to('%PDF-settlement','UTF8')),'hex'),
      'mimeType','application/pdf','byteSize',15,'originalName','Comprovante privado ' || i || '.pdf'),'00000000-0000-4000-8000-000000000971');
  end loop;
end; $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{}}',true);

-- Registered pools with a complete checklist and a manual result carrying known payouts (pool 1 also selected explicitly).
do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p uuid; r jsonb; rid uuid; i integer;
begin
  for i in 1..3 loop
    p := ('a4000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    r := public.registration_decide(pg_temp.command(g,jsonb_build_object('type','registration_confirm','poolId',p,'poolVersion',pg_temp.pool_version(p),
      'manifestId',(select id from public.pool_manifests where pool_id = p order by version desc limit 1),'items',pg_temp.observed_items(p),'reason','')));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select comparison ->> 'status' from public.registration_reports where pool_id = p order by version desc limit 1) = 'complete','settlement fixture registered complete');
    r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_manual','poolId',p,'poolVersion',pg_temp.pool_version(p),
      'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',42,'drawDate','2026-10-08','drawnNumbers','[1,2,3,4,5,7]'::jsonb,
        'payouts','[{"hits":6,"winnerCount":"0","prizeCents":"0"},{"hits":5,"winnerCount":"10","prizeCents":"5000000"},{"hits":4,"winnerCount":"1000","prizeCents":"100000"}]'::jsonb),
      'sourceReference','Resultado oficial conferido pelo organizador','reason','Rateio publicado e conferido.')));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','settlement fixture result recorded');
  end loop;
  p := 'a4000000-0000-4000-8000-000000000001';
  rid := (select id from public.contest_result_versions where pool_id = p order by version desc limit 1);
  r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_resolve','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'resultId',rid,'observedResultIds',jsonb_build_array(rid),'reason','Fonte escolhida para a apuração.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','settlement fixture result selected');
end; $$;

do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p1 uuid := 'a4000000-0000-4000-8000-000000000001'; p2 uuid := 'a4000000-0000-4000-8000-000000000002';
  ev1 uuid := 'a8000000-0000-4000-8000-000000000001'; ev2 uuid := 'a8000000-0000-4000-8000-000000000002';
  person1 uuid := 'a3000000-0000-4000-8000-000000000001'; person2 uuid := 'a3000000-0000-4000-8000-000000000002'; holder uuid := 'a3000000-0000-4000-8000-000000000003';
  report1 uuid; report2 uuid; result1 uuid; result2 uuid; prize1 uuid; prize2 uuid; paid uuid; redeemed uuid; cmd jsonb; r jsonb; original jsonb; rev bigint; entitlements jsonb; deadline jsonb; closure1 uuid; expense1 uuid; closure2 uuid; expense2 uuid; payment jsonb;
begin
  insert into settlement_contract_samples values('registered before settlement','snapshot',public.settlement_pull(g));
  select id into report1 from public.registration_reports where pool_id = p1 order by version desc limit 1;
  select id into report2 from public.registration_reports where pool_id = p2 order by version desc limit 1;
  select id into result1 from public.contest_result_versions where pool_id = p1 order by version desc limit 1;
  select id into result2 from public.contest_result_versions where pool_id = p2 order by version desc limit 1;

  -- Actual expenses from the observed receipts; equal to the checklist so no extra reason is needed.
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p1,'poolVersion',pg_temp.pool_version(p1),
    'registrationReportId',report1,'supersedesId',null,'betCostCents','2400','feeCents','0','evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Comprovantes originais conferidos','reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'expenses' -> 0 ->> 'totalCostCents' = '2400'
    and (r -> 'snapshot' -> 'expenses' -> 0 ->> 'groupRevision')::bigint = (r ->> 'groupRevision')::bigint,'expense confirmed with server-derived total');
  insert into settlement_contract_samples values('expense confirmed','receipt',r);

  -- Internal prize: a differing amount needs a reason; the calculated amount splits 2:1 by largest remainder.
  deadline := jsonb_build_object('ruleVersion','caixa-redemption-90-days-2026-10-08-v1','sourceUrl','https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx',
    'verifiedAt','2026-10-08','drawDate','2026-10-08','deadlineDate',to_char(date '2026-10-08' + 90,'YYYY-MM-DD'),'exception',null);
  cmd := jsonb_build_object('type','prize_confirm','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'registrationReportId',report1,'resultId',result1,
    'supersedesId',null,'amountCents','4999999','officialEntitlements','[]'::jsonb,'evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Resultado selecionado e bilhetes conferidos','reason','','redemptionDeadline',deadline);
  r := public.settlement_decide(pg_temp.settle(cmd));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and (select count(*) from public.settlement_prizes) = 0,'prize differing from calculation without reason rejected');
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('amountCents','5000000','poolVersion',pg_temp.pool_version(p1))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'prizes' -> 0 ->> 'calculatedPrizeCents' = '5000000'
    and r -> 'snapshot' -> 'prizes' -> 0 ->> 'resultSelectionId' is not null
    and (select string_agg(value ->> 'amountCents',',' order by value ->> 'personId') from jsonb_array_elements(r -> 'snapshot' -> 'prizes' -> 0 -> 'rights')) = '3333333,1666667',
    'internal prize rights split by largest remainder');
  insert into settlement_contract_samples values('internal prize confirmed','receipt',r);
  select id into prize1 from public.settlement_prizes where pool_id = p1 order by version desc limit 1;

  -- Organizer redemption belongs to the frozen ticket holder.
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),
    'prizeConfirmationId',prize1,'personId',person1,'amountCents','5000000','evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Resgate na agência','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','internal redemption by non-holder rejected');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),
    'prizeConfirmationId',prize1,'personId',holder,'amountCents','5000000','evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Resgate na agência','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and r -> 'snapshot' -> 'redemptions' -> 0 ->> 'ownership' = 'organizer','organizer redemption recorded');
  insert into settlement_contract_samples values('organizer redemption','receipt',r);

  -- Prize payment within the person's right; a lost reply repeats the original receipt.
  cmd := pg_temp.settle(jsonb_build_object('type','distribution_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'personId',person1,
    'kind','prize-payment','amountCents','3333333','evidenceIds',jsonb_build_array(ev1),'sourceReference','Transferência identificada','eventAt',pg_temp.now_json(),
    'reason','Pagamento integral do direito.'));
  r := public.settlement_decide(cmd); original := r;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','prize payment within rights accepted');
  insert into settlement_contract_samples values('prize payment within rights','receipt',r);
  select revision into rev from public.groups where id = g;
  perform pg_temp.assert_true(public.settlement_decide(cmd) = original and (select revision from public.groups where id = g) = rev
    and (select count(*) from public.settlement_distributions) = 1,'idempotent repeat returns the original receipt');
  r := public.settlement_decide(jsonb_set(cmd,'{action,reason}','"Conteúdo alterado."'));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r -> 'snapshot' = 'null'::jsonb
    and public.settlement_command_status((cmd ->> 'idempotencyKey')::uuid) = original,'same key with different content rejected');
  insert into settlement_contract_samples values('same key different content','receipt',r);
  select id into paid from public.settlement_distributions where pool_id = p1 order by version desc limit 1;

  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'personId',person2,
    'kind','prize-payment','amountCents','1666668','evidenceIds',jsonb_build_array(ev1),'sourceReference','Transferência identificada','eventAt',pg_temp.now_json(),
    'reason','Pagamento acima do direito.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and (select count(*) from public.settlement_distributions) = 1,'distribution exceeding rights rejected');
  insert into settlement_contract_samples values('distribution exceeding rights','receipt',r);

  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'personId',person2,
    'kind','contribution-refund','amountCents','450','evidenceIds',jsonb_build_array(ev1),'sourceReference','Devolução identificada','eventAt',pg_temp.now_json(),
    'reason','Sobra proporcional após a despesa.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','contribution refund within own surplus accepted');
  insert into settlement_contract_samples values('contribution refund','receipt',r);

  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_reverse','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'distributionId',paid,
    'evidenceIds',jsonb_build_array(ev1),'sourceReference','Estorno bancário','eventAt',pg_temp.now_json(),'reason','Transferência devolvida pelo banco.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'distributions') d
    where d.value ->> 'reversesId' = paid::text and d.value ->> 'amountCents' = '-3333333'),'distribution reversal fully compensates the payment');
  insert into settlement_contract_samples values('distribution reversed','receipt',r);
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_reverse','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'distributionId',paid,
    'evidenceIds',jsonb_build_array(ev1),'sourceReference','Estorno bancário','eventAt',pg_temp.now_json(),'reason','Segunda compensação.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','a payment is compensated only once');

  -- Expense corrections supersede explicitly and re-split refund rights; they cannot strand a refund already paid.
  cmd := jsonb_build_object('type','expense_confirm','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'registrationReportId',report1,
    'supersedesId',(select id from public.settlement_expenses where pool_id = p1),'betCostCents','2400','feeCents','100','evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Tarifa observada no comprovante','reason','Tarifa bancária identificada depois.');
  r := public.settlement_decide(pg_temp.settle(cmd));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and (select count(*) from public.settlement_expenses) = 1,'correction leaving a refund above the new right rejected');
  insert into settlement_contract_samples values('expense correction rejected','receipt',r);
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('betCostCents','2300','feeCents','0','poolVersion',pg_temp.pool_version(p1))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select count(*) from public.settlement_expenses) = 2,'expense correction supersedes the last confirmation');
  insert into settlement_contract_samples values('expense corrected','receipt',r);

  -- Official pool: entitlements mirror the observed receipts; each person redeems at most their own right.
  select jsonb_agg(jsonb_build_object('plannedTicketKey',i.value ->> 'plannedTicketKey','quotaId',a.value ->> 'quotaId','personId',a.value ->> 'personId',
    'officialQuotas',a.value -> 'officialQuotas','amountCents',case when (a.value ->> 'personId')::uuid = person1 then '3333334' else '1666666' end,'evidenceIds',jsonb_build_array(ev2)))
    into entitlements from public.registration_reports rr cross join lateral jsonb_array_elements(rr.items) i
    cross join lateral jsonb_array_elements(i.value -> 'observed' -> 'officialAssignments') a where rr.id = report2;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','prize_confirm','poolId',p2,'poolVersion',pg_temp.pool_version(p2),'registrationReportId',report2,
    'resultId',result2,'supersedesId',null,'amountCents','5000000','officialEntitlements',entitlements,'evidenceIds',jsonb_build_array(ev2),
    'sourceReference','Recibos individuais conferidos','reason','','redemptionDeadline',null)));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'prizes') p
    where p.value ->> 'poolId' = p2::text and p.value -> 'resultSelectionId' = 'null'::jsonb and jsonb_array_length(p.value -> 'rights') = 2),'official prize confirmed from receipts');
  insert into settlement_contract_samples values('official prize confirmed','receipt',r);
  select id into prize2 from public.settlement_prizes where pool_id = p2 order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p2,'poolVersion',pg_temp.pool_version(p2),
    'prizeConfirmationId',prize2,'personId',person1,'amountCents','3333334','evidenceIds',jsonb_build_array(ev2),
    'sourceReference','Resgate individual','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'redemptions') x
    where x.value ->> 'poolId' = p2::text and x.value ->> 'ownership' = 'individual'),'individual redemption recorded');
  insert into settlement_contract_samples values('individual redemption','receipt',r);
  select id into redeemed from public.settlement_redemptions where pool_id = p2 order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p2,'poolVersion',pg_temp.pool_version(p2),
    'prizeConfirmationId',prize2,'personId',person2,'amountCents','1666667','evidenceIds',jsonb_build_array(ev2),
    'sourceReference','Resgate individual','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected','individual redemption above own right rejected');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_reverse','poolId',p2,'poolVersion',pg_temp.pool_version(p2),'redemptionId',redeemed,
    'evidenceIds',jsonb_build_array(ev2),'sourceReference','Recibo cancelado','eventAt',pg_temp.now_json(),'reason','Resgate registrado por engano.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'redemptions') x
    where x.value ->> 'reversesId' = redeemed::text and x.value ->> 'amountCents' = '-3333334'),'redemption reversal recorded');
  insert into settlement_contract_samples values('redemption reversed','receipt',r);

  -- Stale observation and a recovered receipt.
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p2,'poolVersion',pg_temp.pool_version(p2),
    'registrationReportId',report2,'supersedesId',null,'betCostCents','2400','feeCents','0','evidenceIds',jsonb_build_array(ev2),
    'sourceReference','Comprovantes originais conferidos','reason',''),gen_random_uuid(),0));
  perform pg_temp.assert_true(r ->> 'status' = 'conflict' and r ->> 'receiptId' is null,'stale expected revision is an explicit conflict');
  insert into settlement_contract_samples values('stale revision conflict','receipt',r);
  -- Closing mirrors the core: current ids, open items explained, and only a human reopening unlocks the pool again.
  select id into expense1 from public.settlement_expenses where pool_id = p1 order by version desc limit 1;
  cmd := jsonb_build_object('type','pool_settle','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'registrationReportId',report1,
    'prizeConfirmationId',prize1,'expenseConfirmationId',expense1,'leftoverDisposition','group-reserve','pendingExplanation','','reason','Encerramento do bolão.');
  r := public.settlement_decide(pg_temp.settle(cmd));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.'
    and (select count(*) from public.settlement_closures) = 0,'closing with a prize still to pay needs an explanation');
  insert into settlement_contract_samples values('pool settle unexplained','receipt',r);
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('prizeConfirmationId',null,'pendingExplanation','Prêmio a pagar.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Encerramento exige as versões atuais de registro, despesas e prêmio.'
    and (select count(*) from public.settlement_closures) = 0,'closing needs the current prize');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','pool_settle','poolId',p2,'poolVersion',pg_temp.pool_version(p2),'registrationReportId',report2,
    'prizeConfirmationId',prize2,'expenseConfirmationId',null,'leftoverDisposition','pending-refund','pendingExplanation','Custo e resgates ainda abertos.','reason','Pausa da apuração.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from public.settlement_closures where pool_id = p2 and direction = 'closed'
    and leftover_disposition = 'pending-refund' and pending_explanation = 'Custo e resgates ainda abertos.' and reconciliation ->> 'expenseConfirmationPending' = 'true'),
    'an explained pending closure keeps its explanation');
  insert into settlement_contract_samples values('pool settled with pending','receipt',r);
  -- Pool 2 has a group-credit plan: budget 2500 + 1250 = 3750 funded, 2400 spent, so the leftover 3750 - 2400 = 1350 is the group reserve and nobody holds a refund right.
  select id into closure2 from public.settlement_closures where pool_id = p2 order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','pool_reopen','poolId',p2,'poolVersion',pg_temp.pool_version(p2),'closureId',closure2,'reason','Custo confirmado.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','pool 2 reopened to confirm its cost');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p2,'poolVersion',pg_temp.pool_version(p2),
    'registrationReportId',report2,'supersedesId',null,'betCostCents','2400','feeCents','0','evidenceIds',jsonb_build_array(ev2),
    'sourceReference','Comprovantes originais conferidos','reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','pool 2 expense confirmed');
  select id into expense2 from public.settlement_expenses where pool_id = p2 order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','pool_settle','poolId',p2,'poolVersion',pg_temp.pool_version(p2),'registrationReportId',report2,
    'prizeConfirmationId',prize2,'expenseConfirmationId',expense2,'leftoverDisposition','group-reserve','pendingExplanation','Prêmio a pagar.','reason','Sobra no caixa do grupo.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from public.settlement_closures where pool_id = p2 and direction = 'closed' and expense_confirmation_id = expense2
    and reconciliation ->> 'contributionSurplusCents' = '1350' and reconciliation ->> 'groupReserveCents' = '1350' and reconciliation ->> 'refundPendingCents' = '0'
    and (select string_agg(x.value ->> 'refundRightCents',',') from jsonb_array_elements(reconciliation -> 'persons') x) = '0,0'),
    'a group-credit leftover is the group reserve and no refund right');
  insert into settlement_contract_samples values('pool settled with group reserve','receipt',r);
  -- Pay the remaining prize and refunds so pool 1 has nothing open.
  for payment in select value from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('personId',person1,'kind','prize-payment','amountCents','3333333'),jsonb_build_object('personId',person2,'kind','prize-payment','amountCents','1666667'),
      jsonb_build_object('personId',person1,'kind','contribution-refund','amountCents','967'),jsonb_build_object('personId',person2,'kind','contribution-refund','amountCents','33'))) loop
    r := public.settlement_decide(pg_temp.settle(payment || jsonb_build_object('type','distribution_record','poolId',p1,'poolVersion',pg_temp.pool_version(p1),
      'evidenceIds',jsonb_build_array(ev1),'sourceReference','Transferência identificada','eventAt',pg_temp.now_json(),'reason','Acerto final.')));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','final payment before closing accepted');
  end loop;
  cmd := pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p1)));
  r := public.settlement_decide(cmd); original := r;
  select id into closure1 from public.settlement_closures where pool_id = p1;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and closure1 is not null and exists (select 1 from public.settlement_closures where id = closure1
    and direction = 'closed' and version = 1 and previous_closure_id is null and leftover_disposition = 'group-reserve' and pending_explanation = ''
    and expense_confirmation_id = expense1 and reconciliation ->> 'closed' = 'false' and reconciliation ->> 'refundPendingCents' = '0'),'closing without open items accepted');
  insert into settlement_contract_samples values('pool settled','receipt',r);
  perform pg_temp.assert_true(public.settlement_decide(cmd) = original and (select count(*) from public.settlement_closures where pool_id = p1) = 1,
    'repeating the closing returns the original receipt');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p1,'poolVersion',pg_temp.pool_version(p1),
    'registrationReportId',report1,'supersedesId',expense1,'betCostCents','2300','feeCents','0','evidenceIds',jsonb_build_array(ev1),
    'sourceReference','Comprovantes originais conferidos','reason','Revisão depois do encerramento.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Bolão encerrado exige reabertura humana antes de nova alteração financeira.','a closed pool takes no new money fact');
  cmd := jsonb_build_object('type','pool_reopen','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'closureId',gen_random_uuid(),'reason','Correção do custo.');
  r := public.settlement_decide(pg_temp.settle(cmd));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Reabertura exige o encerramento ativo observado.'
    and (select count(*) from public.settlement_closures where pool_id = p1) = 1,'reopening needs the active closure');
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('closureId',closure1)));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from public.settlement_closures where pool_id = p1 and direction = 'reopened'
    and version = 2 and previous_closure_id = closure1 and leftover_disposition = 'group-reserve' and reconciliation ->> 'closed' = 'true'),'reopening the active closure accepted');
  insert into settlement_contract_samples values('pool reopened','receipt',r);
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p1),'closureId',closure1)));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Reabertura exige o encerramento ativo observado.','an open pool cannot be reopened');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','pool_settle','poolId',p1,'poolVersion',pg_temp.pool_version(p1),'registrationReportId',report1,
    'prizeConfirmationId',prize1,'expenseConfirmationId',expense1,'leftoverDisposition','pending-refund','pendingExplanation','','reason','Encerramento revisado.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from public.settlement_closures where pool_id = p1 and direction = 'closed'
    and version = 3 and previous_closure_id = (select id from public.settlement_closures where pool_id = p1 and version = 2) and leftover_disposition = 'pending-refund'),
    'closing again after a reopening accepted');
  insert into settlement_contract_samples values('pool settled again','receipt',r);
  perform pg_temp.assert_true(public.settlement_command_status(gen_random_uuid()) is null,'unknown key has no receipt');
  insert into settlement_contract_samples values('final settlement','snapshot',public.settlement_pull(g));
  r := public.sync_pull(g,0);
  perform pg_temp.assert_true((r ->> 'nextCursor')::bigint = (select revision from public.groups where id = g),'settlement facts advance the shared cursor');
end; $$;

-- Pool 3 (internal, group-credit) froze groupPrizeLimitCents = 5000000: its 5000000 prize is exactly at the limit, so nobody holds a right to it and it joins the reserve.
-- Reserve = leftover (budget 2500 + 1250 = 3750 funded, 2400 spent: 1350) + kept prize 5000000 = 5001350.
-- Owed to no one: unpaid = 5000000 - 0 paid - 5000000 kept = 0, so once the holder redeems 5000000 (5000000 - 5000000 = 0 left) the pool closes with no explanation.
do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p3 uuid := 'a4000000-0000-4000-8000-000000000003'; ev3 uuid := 'a8000000-0000-4000-8000-000000000003';
  report3 uuid; expense3 uuid; prize3 uuid; r jsonb; cmd jsonb;
begin
  select id into report3 from public.registration_reports where pool_id = p3 order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p3,'poolVersion',pg_temp.pool_version(p3),
    'registrationReportId',report3,'supersedesId',null,'betCostCents','2400','feeCents','0','evidenceIds',jsonb_build_array(ev3),
    'sourceReference','Comprovantes originais conferidos','reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','pool 3 expense confirmed');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','prize_confirm','poolId',p3,'poolVersion',pg_temp.pool_version(p3),'registrationReportId',report3,
    'resultId',(select id from public.contest_result_versions where pool_id = p3 order by version desc limit 1),'supersedesId',null,'amountCents','5000000',
    'officialEntitlements','[]'::jsonb,'evidenceIds',jsonb_build_array(ev3),'sourceReference','Resultado e bilhetes conferidos','reason','','redemptionDeadline',null)));
  select id into prize3 from public.settlement_prizes where pool_id = p3 order by version desc limit 1;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select count(*) = 2 and bool_and(x.value ->> 'amountCents' = '0') from public.settlement_prizes p
    cross join lateral jsonb_array_elements(p.rights) x where p.id = prize3),'a prize at the group limit splits to rights of zero');
  select id into expense3 from public.settlement_expenses where pool_id = p3 order by version desc limit 1;
  cmd := jsonb_build_object('type','pool_settle','poolId',p3,'registrationReportId',report3,'prizeConfirmationId',prize3,'expenseConfirmationId',expense3,
    'leftoverDisposition','group-reserve','pendingExplanation','','reason','Combinado antes.');
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p3))));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and (select count(*) from public.settlement_closures where pool_id = p3) = 0,'the kept prize still to redeem needs an explanation to close');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p3,'poolVersion',pg_temp.pool_version(p3),
    'prizeConfirmationId',prize3,'personId','a3000000-0000-4000-8000-000000000003','amountCents','5000000','evidenceIds',jsonb_build_array(ev3),
    'sourceReference','Resgate na agência','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','kept prize redeemed into the group cash');
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p3))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from public.settlement_closures where pool_id = p3 and direction = 'closed'
    and reconciliation ->> 'confirmedPrizeCents' = '5000000' and reconciliation ->> 'contributionSurplusCents' = '1350' and reconciliation ->> 'groupReserveCents' = '5001350'
    and reconciliation ->> 'unpaidPrizeCents' = '0' and reconciliation ->> 'unredeemedPrizeCents' = '0' and pending_explanation = ''
    and (select string_agg(x.value ->> 'prizeRightCents',',') from jsonb_array_elements(reconciliation -> 'persons') x) = '0,0'),
    'a prize at the group limit joins the reserve and gives no one a right');
  insert into settlement_contract_samples values('pool settled with kept prize','receipt',r);
  insert into settlement_contract_samples values('kept prize snapshot','snapshot',public.settlement_pull(g));
end; $$;

-- Teimosinha (owner's decision of 17/10): pool 4 plays the same four games in contests 42 and 43, paid once.
-- Quota price 5000: 5000 + 2500 = 7500 funded; plan cost = 4 games x 600 x 2 contests = 4800, leftover 2700.
-- The receipts name contest 42 and cost 1200 each (both contests); the registration check still prices one contest (600), so each
-- ticket is a bet-cost-mismatch divergence explained by a human reason, and the report stays divergent (registrationIncomplete).
-- Contest 42 drawn [1,2,3,4,5,7]: the known game hits 5 -> 5000000. Contest 43 drawn [7,8,9,10,11,60]: generated-1 [7..12] hits 5
-- -> 3000000 and generated-2 [8..13] hits 4 -> 80000, so 3080000. One prize per contest; the pool's confirmed prize is 8080000.
-- Rights 2:1 by largest remainder: 5000000 -> 3333333/1666667, 3080000 -> 2053333/1026667, so 5386666/2693334.
do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p4 uuid := 'a4000000-0000-4000-8000-000000000004'; v_person uuid; v_statute uuid; r jsonb; plan_id uuid; j integer;
begin
  r := public.sync_push(pg_temp.draft(g,p4,'pool',jsonb_build_object('title','Bolão 4','lotteryId','mega-sena','contestNumber',42,'contestCount',2,
    'deadlineAt','2099-01-01T00:00:00Z','quotaPriceCents','5000','participationMode','internal','status','draft')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha pool covers contests 42 and 43');
  perform public.sync_push(pg_temp.draft(g,'a7000000-0000-4000-8000-000000000004','bet',jsonb_build_object('poolId',p4,
    'lotteryId','mega-sena','numbers','[1,2,3,4,5,6]'::jsonb,'authorIds','["a3000000-0000-4000-8000-000000000001"]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null)));
  select id into v_statute from public.statute_versions where group_id = g;
  for j in 1..2 loop
    v_person := ('a3000000-0000-4000-8000-' || lpad(j::text,12,'0'))::uuid;
    perform public.sync_push(pg_temp.draft(g,('a5000000-0000-4000-8000-' || lpad((40+j)::text,12,'0'))::uuid,'quota',
      jsonb_build_object('poolId',p4,'personId',v_person,'units',case when j = 1 then 100 else 50 end)));
    perform public.sync_push(pg_temp.draft(g,('a6000000-0000-4000-8000-' || lpad((40+j)::text,12,'0'))::uuid,'payment-proposal',
      jsonb_build_object('poolId',p4,'personId',v_person,'amountCents',case when j = 1 then '5000' else '2500' end,'note','','status','pending')));
    r := public.review_decide(pg_temp.command(g,jsonb_build_object('type','payment_confirm','proposalId',
      ('a6000000-0000-4000-8000-' || lpad((40+j)::text,12,'0'))::uuid,'proposalVersion',1,'bankReference',null,'declaredReceivedAt',null,
      'allocations',jsonb_build_array(jsonb_build_object('poolId',p4,'amountCents',case when j = 1 then '5000' else '2500' end)))));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha funded');
    r := public.review_decide(pg_temp.command(g,jsonb_build_object('type','quota_confirm','quotaId',
      ('a5000000-0000-4000-8000-' || lpad((40+j)::text,12,'0'))::uuid,'quotaVersion',1,'statuteId',v_statute)));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha quota confirmed');
  end loop;
  r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(g,p4,'refund-pro-rata',null,2))));
  select id into plan_id from public.pool_plan_versions where pool_id = p4 order by version desc limit 1;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select prepared_plan ->> 'contestCount' = '2' and prepared_plan ->> 'betCostCents' = '4800' and prepared_plan ->> 'leftoverCents' = '2700'
    and (select bool_and(t.value ->> 'betCostCents' = '1200') from jsonb_array_elements(prepared_plan -> 'tickets') t) from public.pool_plan_versions where id = plan_id),
    'teimosinha plan carries contestCount 2 and doubled costs');
  r := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','pool_lock','poolId',p4,'poolVersion',pg_temp.pool_version(p4),'appliedPlanId',plan_id,
    'responsible',jsonb_build_object('registrarPersonId','a3000000-0000-4000-8000-000000000003','ticketHolderPersonId','a3000000-0000-4000-8000-000000000003'))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha manifest locked');
end; $$;
reset role;
insert into storage.objects(bucket_id,name) values('evidence','a1000000-0000-4000-8000-000000000001/a8000000-0000-4000-8000-000000000004.pdf');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.evidence_seal(jsonb_build_object('id','a8000000-0000-4000-8000-000000000004','groupId','a1000000-0000-4000-8000-000000000001',
  'poolId','a4000000-0000-4000-8000-000000000004','sha256',encode(sha256(convert_to('%PDF-teimosinha','UTF8')),'hex'),
  'mimeType','application/pdf','byteSize',15,'originalName','Comprovante da teimosinha.pdf'),'00000000-0000-4000-8000-000000000971') is not null as sealed;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{}}',true);
do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p4 uuid := 'a4000000-0000-4000-8000-000000000004'; ev4 uuid := 'a8000000-0000-4000-8000-000000000004';
  items jsonb; report4 uuid; result42 uuid; result43 uuid; prize42 uuid; r jsonb; cmd jsonb; c integer;
begin
  select jsonb_agg(i.value || jsonb_build_object('reason','O comprovante da teimosinha cobre os dois concursos.') order by i.ordinality) into items
    from jsonb_array_elements(pg_temp.observed_items(p4)) with ordinality i(value,ordinality);
  r := public.registration_decide(pg_temp.command(g,jsonb_build_object('type','registration_confirm','poolId',p4,'poolVersion',pg_temp.pool_version(p4),
    'manifestId',(select id from public.pool_manifests where pool_id = p4 order by version desc limit 1),'items',items,'reason','')));
  select id into report4 from public.registration_reports where pool_id = p4 order by version desc limit 1;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and (select comparison ->> 'status' = 'divergent' and comparison ->> 'observedBetCostCents' = '4800'
    and (select count(*) = 4 and bool_and(e.value ->> 'code' = 'bet-cost-mismatch') from jsonb_array_elements(comparison -> 'issues') e)
    from public.registration_reports where id = report4),'teimosinha receipts registered with the known one-contest price gap explained');
  foreach c in array array[42,43] loop
    r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_manual','poolId',p4,'poolVersion',pg_temp.pool_version(p4),
      'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',c,'drawDate',case c when 42 then '2026-10-08' else '2026-10-10' end,
        'drawnNumbers',case c when 42 then '[1,2,3,4,5,7]' else '[7,8,9,10,11,60]' end::jsonb,
        'payouts',case c when 42 then '[{"hits":6,"winnerCount":"0","prizeCents":"0"},{"hits":5,"winnerCount":"10","prizeCents":"5000000"},{"hits":4,"winnerCount":"1000","prizeCents":"100000"}]'
          else '[{"hits":6,"winnerCount":"0","prizeCents":"0"},{"hits":5,"winnerCount":"20","prizeCents":"3000000"},{"hits":4,"winnerCount":"2000","prizeCents":"80000"}]' end::jsonb),
      'sourceReference','Resultado oficial do concurso ' || c,'reason','Rateio publicado e conferido.')));
    perform pg_temp.assert_true(r ->> 'status' = 'accepted','teimosinha result recorded for contest ' || c);
  end loop;
  select id into result42 from public.contest_result_versions where pool_id = p4 and contest_number = 42;
  select id into result43 from public.contest_result_versions where pool_id = p4 and contest_number = 43;

  -- One prize per contest: the 42 confirmation starts its own chain.
  cmd := jsonb_build_object('type','prize_confirm','poolId',p4,'registrationReportId',report4,'resultId',result42,'supersedesId',null,'amountCents','5000000',
    'officialEntitlements','[]'::jsonb,'evidenceIds',jsonb_build_array(ev4),'sourceReference','Resultado do concurso 42 e bilhetes conferidos','reason','','redemptionDeadline',null);
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p4))));
  select id into prize42 from public.settlement_prizes where pool_id = p4 and result_id = result42;
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and prize42 is not null and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'prizes') p
    where p.value ->> 'id' = prize42::text and p.value ->> 'calculatedPrizeCents' = '5000000' and p.value -> 'supersedesId' = 'null'::jsonb),'teimosinha prize of contest 42 confirmed');
  insert into settlement_contract_samples values('teimosinha prize contest 42','receipt',r);
  -- Contest 43 has no confirmation yet: naming the 42 prize as the one revised is not an explicit revision of 43.
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p4),'resultId',result43,'supersedesId',prize42,
    'amountCents','3080000','sourceReference','Resultado do concurso 43 e bilhetes conferidos','reason','Prêmio do segundo concurso.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Prêmio exige relatório atual, fonte atual sem conflito e revisão explícita.'
    and (select count(*) from public.settlement_prizes where pool_id = p4) = 1,'a contest prize cannot supersede another contest''s prize');
  insert into settlement_contract_samples values('teimosinha prize superseding another contest','receipt',r);
  -- Closing while contest 43 has no prize needs an explanation (the divergent report and the unpaid prize also stay open).
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','pool_settle','poolId',p4,'poolVersion',pg_temp.pool_version(p4),'registrationReportId',report4,
    'prizeConfirmationId',prize42,'expenseConfirmationId',null,'leftoverDisposition','pending-refund','pendingExplanation','','reason','Encerramento antes do segundo concurso.')));
  perform pg_temp.assert_true(r ->> 'status' = 'rejected' and r ->> 'message' = 'Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.'
    and not exists (select 1 from public.settlement_closures where pool_id = p4),'a teimosinha with a contest still unconfirmed does not close unexplained');
  insert into settlement_contract_samples values('teimosinha pool settle unexplained','receipt',r);
  r := public.settlement_decide(pg_temp.settle(cmd || jsonb_build_object('poolVersion',pg_temp.pool_version(p4),'resultId',result43,'amountCents','3080000',
    'sourceReference','Resultado do concurso 43 e bilhetes conferidos')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted' and exists (select 1 from jsonb_array_elements(r -> 'snapshot' -> 'prizes') p
    where p.value ->> 'poolId' = p4::text and p.value ->> 'resultId' = result43::text and p.value ->> 'calculatedPrizeCents' = '3080000' and p.value -> 'supersedesId' = 'null'::jsonb
      and (select string_agg(x.value ->> 'amountCents',',' order by x.value ->> 'personId') from jsonb_array_elements(p.value -> 'rights') x) = '2053333,1026667'),
    'teimosinha prize of contest 43 confirmed from the receipt naming contest 42');
  insert into settlement_contract_samples values('teimosinha prize contest 43','receipt',r);
  insert into settlement_contract_samples values('teimosinha snapshot','snapshot',public.settlement_pull(g));
  perform public.participant_link_create(g,'a3000000-0000-4000-8000-000000000001',encode(sha256(convert_to('teimosinha-card','UTF8')),'hex'));
end; $$;
reset role;
do $$ declare g uuid := 'a1000000-0000-4000-8000-000000000001'; p4 uuid := 'a4000000-0000-4000-8000-000000000004'; b jsonb := private.settlement_pool_balance(g,p4);
  prizes jsonb;
begin
  select jsonb_agg(jsonb_build_object('contestNumber',r.contest_number,'prizeConfirmationId',p.id::text) order by r.contest_number) into prizes
    from public.settlement_prizes p join public.contest_result_versions r on r.id = p.result_id where p.pool_id = p4;
  perform pg_temp.assert_true(jsonb_array_length(b -> 'contests') = 2 and jsonb_array_length(prizes) = 2
    and (select jsonb_agg(jsonb_build_object('contestNumber',(c.value ->> 'contestNumber')::integer,'prizeConfirmationId',c.value ->> 'prizeConfirmationId') order by c.ordinality)
      from jsonb_array_elements(b -> 'contests') with ordinality c(value,ordinality)) = prizes,'balance lists both contests with their own prize');
  perform pg_temp.assert_true(b -> 'contests' -> 0 ->> 'calculatedPrizeCents' = '5000000' and b -> 'contests' -> 0 ->> 'confirmedPrizeCents' = '5000000'
    and b -> 'contests' -> 1 ->> 'calculatedPrizeCents' = '3080000' and b -> 'contests' -> 1 ->> 'confirmedPrizeCents' = '3080000'
    and b ->> 'calculatedPrizeCents' = '8080000' and b ->> 'confirmedPrizeCents' = '8080000' and b ->> 'prizeConfirmationId' = prizes -> 1 ->> 'prizeConfirmationId'
    and b ->> 'registrationIncomplete' = 'true'
    and (select string_agg(x.value ->> 'prizeRightCents',',') from jsonb_array_elements(b -> 'persons') x) = '5386666,2693334','teimosinha figures are the sums over its contests');
end; $$;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare card jsonb := public.participant_card(encode(sha256(convert_to('teimosinha-card','UTF8')),'hex')); pool jsonb;
begin
  select value into pool from jsonb_array_elements(card -> 'pools') where value ->> 'id' = 'a4000000-0000-4000-8000-000000000004';
  perform pg_temp.assert_true(jsonb_array_length(pool -> 'draws') = 2 and pool -> 'draws' -> 0 ->> 'contestNumber' = '42' and pool -> 'draws' -> 1 ->> 'contestNumber' = '43'
    and pool -> 'draws' -> 0 -> 'result' ->> 'prizeConfirmedCents' = '5000000' and pool -> 'draws' -> 1 -> 'result' ->> 'prizeConfirmedCents' = '3080000'
    and pool -> 'draws' -> 1 -> 'result' ->> 'prizeCalculatedCents' = '3080000' and pool -> 'result' = pool -> 'draws' -> 1 -> 'result'
    and pool -> 'result' -> 'drawnNumbers' = '[7,8,9,10,11,60]'::jsonb,'teimosinha card shows one draw per contest and the last drawn result');
end; $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{}}',true);

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000972","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) from public.settlement_prizes) = 0 and (select count(*) from public.settlement_distributions) = 0
    and (select count(*) from public.settlement_command_receipts) = 0,'RLS hides settlement facts from another account');
  begin perform public.settlement_pull('a1000000-0000-4000-8000-000000000001'); raise exception 'foreign settlement pull allowed'; exception when insufficient_privilege then null; end;
  begin perform public.settlement_decide(pg_temp.settle('{"type":"pool_settle"}'::jsonb,gen_random_uuid(),1)); raise exception 'foreign settlement decision allowed'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{"actor_type":"agent"}}',true);
do $$ begin
  begin perform public.settlement_pull('a1000000-0000-4000-8000-000000000001'); raise exception 'agent token settlement pull allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
update auth.users set raw_app_meta_data = '{"actor_type":"agent"}' where id = '00000000-0000-4000-8000-000000000971';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000971","app_metadata":{}}',true);
do $$ begin
  begin perform public.settlement_pull('a1000000-0000-4000-8000-000000000001'); raise exception 'old human JWT agent settlement pull allowed'; exception when insufficient_privilege then null; end;
  begin perform public.settlement_decide(pg_temp.settle('{"type":"pool_settle"}'::jsonb,gen_random_uuid(),1)); raise exception 'agent settlement decision allowed'; exception when insufficient_privilege then null; end;
  begin perform public.settlement_command_status(gen_random_uuid()); raise exception 'agent settlement status allowed'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
  begin update public.settlement_prizes set reason = 'rewritten'; raise exception 'prize rewrite allowed'; exception when insufficient_privilege then null; end;
  begin delete from public.settlement_distributions; raise exception 'distribution deletion allowed'; exception when insufficient_privilege then null; end;
  begin delete from public.settlement_command_receipts; raise exception 'receipt deletion allowed'; exception when insufficient_privilege then null; end;
end; $$;
select label,kind,data from settlement_contract_samples order by label;
rollback;
