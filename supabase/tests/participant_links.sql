-- Participant links and cards use synthetic sessions only; no real prize, transfer or bet is made.
-- The runner rebuilds the same settlement with the real core (computeSettlement) and compares every card share.
begin;
create function pg_temp.assert_true(p_condition boolean,p_label text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.draft(p_group uuid,p_id uuid,p_kind text,p_data jsonb,p_version bigint default 0) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
  'entityId',p_id,'kind',p_kind,'expectedVersion',p_version,'data',p_data,'createdAt','2026-10-08T12:00:00.000Z'); $$;
create function pg_temp.command(p_group uuid,p_action jsonb,p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',p_key,'groupId',p_group,
  'expectedRevision',coalesce(p_revision,(select revision from public.groups where id = p_group)),'action',p_action); $$;
create temporary table participant_samples(label text,kind text,data jsonb);
grant all on participant_samples to authenticated,service_role;

-- Same plan fixture as settlement.sql: one known game plus three generated ones, one ticket per game in the internal agreement.
-- Same fixture as registration/results: four known games, 2:1 rights, one internal and one official pool.
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
    'leftoverCents',(v_budget-2400)::text,'leftoverPolicy','refund-pro-rata','bets',v_bets,'tickets',v_tickets,'explanation','Plano privado de apuração 🙂.');
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
create function pg_temp.settle(p_action jsonb) returns jsonb
language sql as $$ select pg_temp.command('c1000000-0000-4000-8000-000000000001',p_action); $$;
create function pg_temp.pool_version(p_pool uuid) returns bigint language sql as $$ select version from public.draft_records where id = p_pool; $$;
create function pg_temp.now_json() returns text language sql as $$ select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); $$;

-- Scenario (internal agreement, quota price 1000 cents; units are hundredths of a quota):
--   A = 1 quota (100), B = 1 quota (100), C = 2 quotas (200), all paid in full and confirmed.
--   A registers and holds the tickets. Bets cost 2400; prize confirmed 100000; A redeems 100000; A passes 25000 to B.
--   Prize right = 100000 split 100:100:200 → A 25000, B 25000, C 50000.
--   Leftover 4000 − 2400 = 1600 split 100:100:200 → A 400, B 400, C 800; B already got its 400 back.
-- A newer draft pool (A and D, quota price 1000, 1 quota = 100 units each) shows pools newest first. The server only confirms a
-- fully paid quota, so there the due amount is price × units / 100 = 1000 × 100 / 100 = 1000: A paid 0 and D paid 500, both unpaid.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000981','participant-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000982','participant-b@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);

do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001'; p_old uuid := 'c4000000-0000-4000-8000-000000000002'; p_new uuid := 'c4000000-0000-4000-8000-000000000001';
  v_statute uuid; v_result jsonb; plan_id uuid; i integer; v_units integer[] := array[100,100,200,100]; v_paid integer[] := array[1000,1000,2000,500];
begin
  perform public.sync_push(pg_temp.draft(g,g,'group','{"name":"Bolão da firma","statute":"Regras privadas de rateio 🙂"}'));
  for i in 1..4 loop
    perform public.sync_push(pg_temp.draft(g,('c3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'person',
      jsonb_build_object('name','Pessoa ' || chr(64+i),'nickname','Apelido secreto ' || i,'adultDeclared',true)));
  end loop;
  perform public.sync_push(pg_temp.draft(g,p_old,'pool',jsonb_build_object('title','Mega da virada','lotteryId','mega-sena','contestNumber',42,
    'deadlineAt','2099-01-01T00:00:00Z','quotaPriceCents','1000','participationMode','internal','status','draft')));
  perform public.sync_push(pg_temp.draft(g,p_new,'pool',jsonb_build_object('title','Bolão novo','lotteryId','mega-sena','contestNumber',43,
    'deadlineAt','2099-01-01T00:00:00Z','quotaPriceCents','1000','participationMode','internal','status','draft')));
  perform public.sync_push(pg_temp.draft(g,'c7000000-0000-4000-8000-000000000002','bet',jsonb_build_object('poolId',p_old,'lotteryId','mega-sena',
    'numbers','[1,2,3,4,5,6]'::jsonb,'authorIds','["c3000000-0000-4000-8000-000000000002"]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null)));
  perform public.sync_push(pg_temp.draft(g,'c7000000-0000-4000-8000-000000000001','bet',jsonb_build_object('poolId',p_new,'lotteryId','mega-sena',
    'numbers','[10,20,30,40,50,60]'::jsonb,'authorIds','["c3000000-0000-4000-8000-000000000003"]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null)));
  perform public.sync_push(pg_temp.draft(g,'c5000000-0000-4000-8000-000000000011','quota',jsonb_build_object('poolId',p_new,'personId','c3000000-0000-4000-8000-000000000001','units',100)));
  for i in 1..4 loop
    perform public.sync_push(pg_temp.draft(g,('c5000000-0000-4000-8000-' || lpad((20+i)::text,12,'0'))::uuid,'quota',
      jsonb_build_object('poolId',case when i = 4 then p_new else p_old end,'personId',('c3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'units',v_units[i])));
    perform public.sync_push(pg_temp.draft(g,('c6000000-0000-4000-8000-' || lpad((20+i)::text,12,'0'))::uuid,'payment-proposal',
      jsonb_build_object('poolId',case when i = 4 then p_new else p_old end,'personId',('c3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'amountCents',v_paid[i]::text,'note','','status','pending')));
  end loop;
  perform public.review_decide(pg_temp.command(g,'{"type":"statute_publish","groupVersion":1}'));
  select id into v_statute from public.statute_versions where group_id = g;
  for i in 1..4 loop
    v_result := public.review_decide(pg_temp.command(g,jsonb_build_object('type','payment_confirm','proposalId',('c6000000-0000-4000-8000-' || lpad((20+i)::text,12,'0'))::uuid,
      'proposalVersion',1,'bankReference',null,'declaredReceivedAt',null,'allocations',jsonb_build_array(jsonb_build_object('poolId',case when i = 4 then p_new else p_old end,'amountCents',v_paid[i]::text)))));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','participant fixture payment received');
    continue when i = 4;
    perform public.review_decide(pg_temp.command(g,jsonb_build_object('type','statute_accept','statuteId',v_statute,
      'personId',('c3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'evidence','Aceite privado confirmado pelo organizador')));
    v_result := public.review_decide(pg_temp.command(g,jsonb_build_object('type','quota_confirm','quotaId',('c5000000-0000-4000-8000-' || lpad((20+i)::text,12,'0'))::uuid,
      'quotaVersion',1,'statuteId',v_statute)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','participant fixture quota confirmed');
  end loop;
  v_result := public.review_decide(pg_temp.command(g,jsonb_build_object('type','statute_accept','statuteId',v_statute,
    'personId','c3000000-0000-4000-8000-000000000004','evidence','Aceite privado confirmado pelo organizador')));
  v_result := public.review_decide(pg_temp.command(g,jsonb_build_object('type','quota_confirm','quotaId','c5000000-0000-4000-8000-000000000024','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','a partly paid quota is never confirmed');
  v_result := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','plan_apply','plan',pg_temp.prepared(g,p_old))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','participant fixture plan applied');
  select id into plan_id from public.pool_plan_versions where pool_id = p_old order by version desc limit 1;
  v_result := public.planning_decide(pg_temp.command(g,jsonb_build_object('type','pool_lock','poolId',p_old,'poolVersion',pg_temp.pool_version(p_old),'appliedPlanId',plan_id,
    'responsible',jsonb_build_object('registrarPersonId','c3000000-0000-4000-8000-000000000001','ticketHolderPersonId','c3000000-0000-4000-8000-000000000001'))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','participant fixture manifest locked');
end; $$;

reset role;
-- Both pools were created in this transaction; age the settled one so "newest first" is observable.
update public.draft_records set created_at = created_at - interval '1 day' where id = 'c4000000-0000-4000-8000-000000000002';
insert into storage.objects(bucket_id,name) values ('evidence','c1000000-0000-4000-8000-000000000001/c8000000-0000-4000-8000-000000000001.pdf');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.evidence_seal(jsonb_build_object('id','c8000000-0000-4000-8000-000000000001','groupId','c1000000-0000-4000-8000-000000000001',
  'poolId','c4000000-0000-4000-8000-000000000002','sha256',encode(sha256(convert_to('%PDF-participant','UTF8')),'hex'),
  'mimeType','application/pdf','byteSize',16,'originalName','Comprovante privado.pdf'),'00000000-0000-4000-8000-000000000981');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);

do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001'; p uuid := 'c4000000-0000-4000-8000-000000000002'; ev uuid := 'c8000000-0000-4000-8000-000000000001';
  a uuid := 'c3000000-0000-4000-8000-000000000001'; b uuid := 'c3000000-0000-4000-8000-000000000002'; r jsonb; report uuid; result uuid; prize uuid;
begin
  r := public.registration_decide(pg_temp.command(g,jsonb_build_object('type','registration_confirm','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'manifestId',(select id from public.pool_manifests where pool_id = p order by version desc limit 1),'items',pg_temp.observed_items(p),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture registered');
  -- Five hits on the known game pay 100000; the generated games hit at most one number, so the calculation is exactly 100000.
  r := public.result_decide(pg_temp.command(g,jsonb_build_object('type','result_manual','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'data',jsonb_build_object('lotteryId','mega-sena','contestNumber',42,'drawDate','2026-10-08','drawnNumbers','[1,2,3,4,5,7]'::jsonb,
      'payouts','[{"hits":6,"winnerCount":"0","prizeCents":"0"},{"hits":5,"winnerCount":"10","prizeCents":"100000"},{"hits":4,"winnerCount":"1000","prizeCents":"1000"}]'::jsonb),
    'sourceReference','Resultado oficial conferido pelo organizador','reason','Rateio publicado e conferido.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture result recorded');
  select id into report from public.registration_reports where pool_id = p order by version desc limit 1;
  select id into result from public.contest_result_versions where pool_id = p order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','expense_confirm','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'registrationReportId',report,'supersedesId',null,'betCostCents','2400','feeCents','0','evidenceIds',jsonb_build_array(ev),
    'sourceReference','Comprovantes originais conferidos','reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture expense confirmed');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','prize_confirm','poolId',p,'poolVersion',pg_temp.pool_version(p),'registrationReportId',report,
    'resultId',result,'supersedesId',null,'amountCents','100000','officialEntitlements','[]'::jsonb,'evidenceIds',jsonb_build_array(ev),
    'sourceReference','Resultado e bilhetes conferidos','reason','','redemptionDeadline',jsonb_build_object('ruleVersion','caixa-redemption-90-days-2026-10-08-v1',
      'sourceUrl','https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx','verifiedAt','2026-10-08','drawDate','2026-10-08','deadlineDate',to_char(date '2026-10-08' + 90,'YYYY-MM-DD'),'exception',null))));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture prize confirmed');
  select id into prize from public.settlement_prizes where pool_id = p order by version desc limit 1;
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','redemption_record','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'prizeConfirmationId',prize,'personId',a,'amountCents','100000','evidenceIds',jsonb_build_array(ev),
    'sourceReference','Resgate na agência','eventAt',pg_temp.now_json(),'reason','')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture redeemed by the ticket holder');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_record','poolId',p,'poolVersion',pg_temp.pool_version(p),'personId',b,
    'kind','prize-payment','amountCents','25000','evidenceIds',jsonb_build_array(ev),'sourceReference','Transferência identificada','eventAt',pg_temp.now_json(),
    'reason','Pagamento integral do direito.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture prize passed to B');
  r := public.settlement_decide(pg_temp.settle(jsonb_build_object('type','distribution_record','poolId',p,'poolVersion',pg_temp.pool_version(p),'personId',b,
    'kind','contribution-refund','amountCents','400','evidenceIds',jsonb_build_array(ev),'sourceReference','Devolução identificada','eventAt',pg_temp.now_json(),
    'reason','Sobra proporcional após a despesa.')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','participant fixture leftover returned to B');
  insert into participant_samples values('settlement after payouts','settlement-snapshot',public.settlement_pull(g));
end; $$;

-- Organizer creates, lists and revokes links; clients never read the token hash.
create function pg_temp.hash(p_token text) returns text language sql as $$ select encode(sha256(convert_to(p_token,'UTF8')),'hex'); $$;
do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001'; r jsonb; again jsonb; revoked uuid; i integer;
begin
  for i in 1..4 loop
    r := public.participant_link_create(g,('c3000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,pg_temp.hash('token-' || i));
    perform pg_temp.assert_true(r ->> 'personId' = 'c3000000-0000-4000-8000-' || lpad(i::text,12,'0') and r ? 'createdAt' and not (r ? 'tokenHash'),'link created without echoing the hash');
  end loop;
  r := public.participant_link_create(g,'c3000000-0000-4000-8000-000000000002',pg_temp.hash('token-old'));
  revoked := (r ->> 'id')::uuid;
  r := public.participant_link_revoke(g,revoked);
  again := public.participant_link_revoke(g,revoked);
  perform pg_temp.assert_true(r ->> 'revokedAt' is not null and again = r,'revocation is final and its retry returns the same moment');
  r := public.participant_links_pull(g);
  perform pg_temp.assert_true(jsonb_array_length(r -> 'links') = 5
    and (select count(*) from jsonb_array_elements(r -> 'links') l where l.value -> 'revokedAt' <> 'null'::jsonb) = 1
    and r::text not like '%' || pg_temp.hash('token-1') || '%' and r::text not like '%tokenHash%','links listed without hashes');
  perform pg_temp.assert_true((select count(*) from public.participant_links) = 5,'organizer reads its links through RLS');
  begin perform (select token_hash from public.participant_links limit 1); raise exception 'token hash readable'; exception when insufficient_privilege then null; end;
  begin perform public.participant_link_create(g,'c4000000-0000-4000-8000-000000000002',pg_temp.hash('token-pool')); raise exception 'link for a non-person accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.participant_link_create(g,'c3000000-0000-4000-8000-000000000001','not-a-hash'); raise exception 'malformed hash accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.participant_link_create(g,'c3000000-0000-4000-8000-000000000001',pg_temp.hash('token-1')); raise exception 'duplicate hash accepted';
    exception when unique_violation then null; end;
  begin perform public.participant_card(pg_temp.hash('token-1')); raise exception 'organizer session opened a card directly'; exception when insufficient_privilege then null; end;
end; $$;

-- Another account (not a member) can neither create, list, revoke nor see links.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001';
begin
  begin perform public.participant_link_create(g,'c3000000-0000-4000-8000-000000000001',pg_temp.hash('token-foreign')); raise exception 'non-organizer created a link';
    exception when insufficient_privilege then null; end;
  begin perform public.participant_links_pull(g); raise exception 'non-organizer listed links'; exception when insufficient_privilege then null; end;
  begin perform public.participant_link_revoke(g,(select gen_random_uuid())); raise exception 'non-organizer revoked a link'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true((select count(*) from public.participant_links) = 0,'RLS hides links from another account');
end; $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.participant_card(pg_temp.hash('token-1')); raise exception 'anonymous client opened a card'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
  begin update public.participant_links set revoked_at = null where revoked_at is not null; raise exception 'revocation undone'; exception when insufficient_privilege then null; end;
  begin update public.participant_links set token_hash = repeat('0',64) where revoked_at is null; raise exception 'hash rewritten'; exception when insufficient_privilege then null; end;
  begin delete from public.participant_links; raise exception 'link deleted'; exception when insufficient_privilege then null; end;
end; $$;

-- The api function opens cards with the service key; expected values follow the scenario at the top of this file.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare a jsonb := public.participant_card(pg_temp.hash('token-1')); b jsonb := public.participant_card(pg_temp.hash('token-2'));
  c jsonb := public.participant_card(pg_temp.hash('token-3')); d jsonb := public.participant_card(pg_temp.hash('token-4')); pool jsonb;
begin
  perform pg_temp.assert_true(public.participant_card(pg_temp.hash('token-unknown')) = '{"error":"link_unknown"}'::jsonb
    and public.participant_card('not-a-hash') = '{"error":"link_unknown"}'::jsonb and public.participant_card(null) = '{"error":"link_unknown"}'::jsonb,'unknown link');
  perform pg_temp.assert_true(public.participant_card(pg_temp.hash('token-old')) = '{"error":"link_revoked"}'::jsonb,'revoked link closes at once');
  perform pg_temp.assert_true(b -> 'version' = '1' and b -> 'group' = '{"name":"Bolão da firma","pix":null}' and b -> 'person' = '{"id":"c3000000-0000-4000-8000-000000000002","name":"Pessoa B"}'
    and jsonb_array_length(b -> 'pools') = 1 and b ->> 'generatedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$','card header');
  pool := b -> 'pools' -> 0;
  perform pg_temp.assert_true(pool ->> 'id' = 'c4000000-0000-4000-8000-000000000002' and pool ->> 'title' = 'Mega da virada' and pool ->> 'modality' = 'mega-sena'
    and pool -> 'contest' = '42' and pool ->> 'drawAt' = '2026-10-08' and pool ->> 'participationMode' = 'internal'
    and pool ->> 'status' = 'registered' and pool -> 'closed' = 'false','B pool facts');
  perform pg_temp.assert_true(pool -> 'quota' = '{"units":100,"dueCents":"1000","paidCents":"1000","paid":true}','B quota paid in full');
  perform pg_temp.assert_true(jsonb_array_length(pool -> 'games') = 4 and pool -> 'games' -> 0 = '{"numbers":[1,2,3,4,5,6],"registered":true}'
    and pool -> 'registration' = '{"status":"registered","ticketHolderName":"Pessoa A"}'
    and pool -> 'result' = '{"drawnNumbers":[1,2,3,4,5,7],"prizeCalculatedCents":"100000","prizeConfirmedCents":"100000",
      "redemptionDeadlineDate":"2027-01-06","prizeRedeemed":true}','B games, registration, result and the official deadline of a prize already redeemed');
  perform pg_temp.assert_true(pool -> 'share' = '{"rightCents":"25000","receivedCents":"25000","pendingCents":"0","paidByName":"Pessoa A","refundRightCents":"400","refundedCents":"400"}','B share received');
  perform pg_temp.assert_true(b::text not like '%Pessoa C%' and b::text not like '%Pessoa D%' and b::text not like '%Apelido%' and b::text not like '%authorIds%'
    and b::text not like '%.pdf%' and b::text not like '%c3000000-0000-4000-8000-000000000003%' and b::text not like '%c8000000%','card carries only B and the ticket holder name');
  pool := c -> 'pools' -> 0;
  perform pg_temp.assert_true(jsonb_array_length(c -> 'pools') = 1 and pool -> 'quota' = '{"units":200,"dueCents":"2000","paidCents":"2000","paid":true}'
    and pool -> 'share' = '{"rightCents":"50000","receivedCents":"0","pendingCents":"50000","paidByName":"Pessoa A","refundRightCents":"800","refundedCents":"0"}','C share pending');
  -- A redeemed the whole prize as ticket holder; like computeSettlement, only prize-payment transfers count as received by A.
  perform pg_temp.assert_true(jsonb_array_length(a -> 'pools') = 2 and a -> 'pools' -> 1 -> 'share' =
    '{"rightCents":"25000","receivedCents":"0","pendingCents":"25000","paidByName":"Pessoa A","refundRightCents":"400","refundedCents":"0"}','A share as ticket holder');
  pool := a -> 'pools' -> 0;
  perform pg_temp.assert_true(pool ->> 'id' = 'c4000000-0000-4000-8000-000000000001' and pool ->> 'status' = 'draft' and pool -> 'contest' = '43' and pool -> 'drawAt' = 'null'
    and pool -> 'quota' = '{"units":100,"dueCents":"1000","paidCents":"0","paid":false}' and pool -> 'games' = '[{"numbers":[10,20,30,40,50,60],"registered":false}]'
    and pool -> 'registration' = 'null' and pool -> 'result' = 'null' and pool -> 'share' = 'null' and pool -> 'closed' = 'false','newest draft pool first, nothing confirmed yet');
  pool := d -> 'pools' -> 0;
  perform pg_temp.assert_true(jsonb_array_length(d -> 'pools') = 1 and pool ->> 'id' = 'c4000000-0000-4000-8000-000000000001'
    and pool -> 'quota' = '{"units":100,"dueCents":"1000","paidCents":"500","paid":false}' and pool -> 'share' = 'null','D paid 500 of 1000, quota not confirmed');
  insert into participant_samples values('card A','participant-card',a),('card B','participant-card',b),('card C','participant-card',c),('card D','participant-card',d);
end; $$;

-- The group's Pix receiver reaches the personal card (owner's decision of 2026-10-12); the amount and code are built on the device.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001'; v_version bigint; begin
  select version into v_version from public.draft_records where group_id = g and id = g;
  perform pg_temp.assert_true(public.sync_push(pg_temp.draft(g,g,'group','{"name":"Bolão da firma","statute":"Regras privadas de rateio 🙂",
    "pix":{"key":"chave@exemplo.com","keyType":"email","name":"Pessoa A","city":"Sao Paulo"}}',v_version)) ->> 'status' = 'accepted','organizer registers the Pix receiver');
end; $$;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ begin
  perform pg_temp.assert_true(public.participant_card(pg_temp.hash('token-2')) -> 'group'
    = '{"name":"Bolão da firma","pix":{"key":"chave@exemplo.com","keyType":"email","name":"Pessoa A","city":"Sao Paulo"}}','card carries the group Pix receiver');
  perform pg_temp.assert_true(public.participant_card(pg_temp.hash('token-old')) = '{"error":"link_revoked"}'::jsonb,'revoked link still closed');
end; $$;
-- The card shows the games of the receipt, not the plan: a new registration reads other numbers on the known game's ticket
-- and has no receipt for the second one. The plan's [1,2,3,4,5,6] would have five hits; the receipt's numbers have none.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'c1000000-0000-4000-8000-000000000001'; p uuid := 'c4000000-0000-4000-8000-000000000002'; items jsonb := pg_temp.observed_items(p); r jsonb;
begin
  items := jsonb_set(jsonb_set(items,'{0,observed,betNumbers}','[[20,21,22,23,24,25]]'),'{0,reason}','"A lotérica registrou outros números"');
  items := jsonb_set(jsonb_set(items,'{1,evidenceIds}','[]'),'{1,observed}','null');
  r := public.registration_decide(pg_temp.command(g,jsonb_build_object('type','registration_confirm','poolId',p,'poolVersion',pg_temp.pool_version(p),
    'manifestId',(select id from public.pool_manifests where pool_id = p order by version desc limit 1),'items',items,'reason','Bilhete conferido de novo')));
  perform pg_temp.assert_true(r ->> 'status' = 'accepted','second registration with other numbers recorded');
end; $$;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare games jsonb := public.participant_card(pg_temp.hash('token-2')) -> 'pools' -> 0 -> 'games';
begin
  perform pg_temp.assert_true(jsonb_array_length(games) = 4 and games -> 0 = '{"numbers":[20,21,22,23,24,25],"registered":true}'
    and games -> 1 -> 'registered' = 'false' and games -> 1 -> 'numbers' <> '[20,21,22,23,24,25]'
    and games -> 2 -> 'registered' = 'true' and games -> 3 -> 'registered' = 'true','card shows the receipt numbers; a ticket without receipt stays planned');
end; $$;
select label,kind,data from participant_samples order by label;
rollback;
