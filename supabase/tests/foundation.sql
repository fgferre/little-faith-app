-- Run against an isolated Supabase database with psql -v ON_ERROR_STOP=1 -f this-file.
-- Test users and all data are synthetic; the transaction always rolls back.
begin;

create function pg_temp.assert_true(p_condition boolean, p_label text) returns void
language plpgsql as $$ begin
  if p_condition is not true then raise exception 'Assertion failed: %', p_label; end if;
end; $$;
create function pg_temp.operation(p_key uuid, p_group uuid, p_id uuid, p_kind text, p_data jsonb, p_version bigint default 0) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',p_key,'groupId',p_group,
  'entityId',p_id,'kind',p_kind,'expectedVersion',p_version,'data',p_data,'createdAt','2026-10-07T12:00:00.000Z'); $$;

insert into auth.users(id, email, raw_app_meta_data, raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000001','organizer-a@example.invalid','{}','{}'),
 ('00000000-0000-4000-8000-000000000002','organizer-b@example.invalid','{}','{}'),
 ('00000000-0000-4000-8000-000000000003','participant@example.invalid','{}','{}');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000001","is_anonymous":false,"app_metadata":{}}', true);

do $$ declare v_op jsonb; v_first jsonb; v_repeated jsonb; begin
  v_op := pg_temp.operation('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001','group','{"name":"Grupo A","statute":"Regras A"}');
  v_first := public.sync_push(v_op); v_repeated := public.sync_push(v_op);
  perform pg_temp.assert_true(v_first ->> 'status' = 'accepted', 'group bootstrap accepted');
  perform pg_temp.assert_true(v_first = v_repeated, 'retry returns exact original receipt');
  perform pg_temp.assert_true(public.command_status('20000000-0000-4000-8000-000000000001') = v_first, 'lost response recovered');
  perform pg_temp.assert_true((select revision = 1 from public.groups where id = '10000000-0000-4000-8000-000000000001'), 'retry does not advance revision');
  perform pg_temp.assert_true((select count(*) = 1 from public.group_changes), 'retry does not duplicate change');
  perform pg_temp.assert_true(v_first -> 'record' ->> 'state' = 'synced' and v_first -> 'record' ->> 'serverVersion' = '1', 'server record contract');
  perform pg_temp.assert_true(v_first -> 'record' ->> 'createdAt' like '%Z', 'server timestamps are UTC');
  perform pg_temp.assert_true(public.sync_push(jsonb_set(v_op, '{data,name}', '"Changed"')) ->> 'status' = 'rejected', 'same key different content rejected');
  perform pg_temp.assert_true(public.command_status('20000000-0000-4000-8000-000000000001') = v_first, 'key reuse preserves original status');
end; $$;

do $$ declare v_result jsonb; begin
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','person','{"name":"Pessoa A","nickname":"A","adultDeclared":true}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'person draft accepted');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001','pool','{"title":"Bolão A","lotteryId":"mega-sena","contestNumber":null,"deadlineAt":null,"quotaPriceCents":"2500","participationMode":"undecided","status":"draft"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'pool draft accepted');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001','quota','{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","units":100}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'quota draft accepted');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001','payment-proposal','{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","amountCents":"2500","note":"Evidência a revisar","status":"pending"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'payment proposal accepted');
  perform pg_temp.assert_true((select count(*) = 0 from public.confirmed_payments), 'proposal never creates confirmed money');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001','bet','{"poolId":"40000000-0000-4000-8000-000000000001","lotteryId":"mega-sena","numbers":[6,5,4,3,2,1],"authorIds":["30000000-0000-4000-8000-000000000001"],"catalogVersion":"caixa-basic-2026-10-07-v1","seed":null,"generationAlgorithmVersion":null}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'bet draft accepted');
  perform pg_temp.assert_true(v_result -> 'record' -> 'data' -> 'numbers' = '[1,2,3,4,5,6]', 'number order canonicalized');
end; $$;

do $$ declare v_result jsonb; v_conflict jsonb; v_op jsonb; begin
  v_op := pg_temp.operation('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','person','{"name":"Pessoa A","nickname":"stale","adultDeclared":true}',0);
  v_conflict := public.sync_push(v_op);
  perform pg_temp.assert_true(v_conflict ->> 'status' = 'conflict', 'stale edit explicit conflict');
  perform pg_temp.assert_true(v_conflict -> 'record' -> 'data' ->> 'nickname' = 'A', 'conflict includes authorized current record');
  perform pg_temp.assert_true(v_conflict ->> 'groupRevision' = '6', 'conflict creates no revision');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001','person','{"name":"Pessoa A","nickname":"updated","adultDeclared":true}',1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted' and v_result ->> 'serverVersion' = '2', 'current edit advances entity version');
  perform pg_temp.assert_true(public.sync_push(v_op) = v_conflict, 'conflict receipt retry stays stable after later edit');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002','bet','{"poolId":"40000000-0000-4000-8000-000000000001","lotteryId":"mega-sena","numbers":[6,5,4,3,2,1],"authorIds":[],"catalogVersion":"caixa-basic-2026-10-07-v1","seed":null,"generationAlgorithmVersion":null}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'duplicate numbers rejected within pool');
end; $$;

do $$ declare v_result jsonb; begin
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001','pool','{"title":"Bolão A","lotteryId":"mega-sena","contestNumber":1,"deadlineAt":null,"quotaPriceCents":"2500","participationMode":"internal","status":"locked"}',1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'sync cannot lock pool');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002','payment-proposal','{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","amountCents":"2500","note":"","status":"confirmed"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'sync cannot confirm payment');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000003','payment-proposal','{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","amountCents":"25.00","note":"","status":"pending"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'decimal money rejected');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000004','payment-proposal','{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","amountCents":"9007199254740992","note":"","status":"pending"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'unsafe money rejected');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000003','bet','{"poolId":"40000000-0000-4000-8000-000000000001","lotteryId":"mega-sena","numbers":[1,2,3,4,5,61],"authorIds":[],"catalogVersion":"caixa-basic-2026-10-07-v1","seed":null,"generationAlgorithmVersion":null}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'number range validation');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000004','person','{"name":"Injected","nickname":"","adultDeclared":true,"confirmedBalanceCents":"10000"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'unrecognized data fields rejected');
  begin
    perform public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000016','10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001','person','{}') || '{"actorId":"00000000-0000-4000-8000-000000000002"}');
    raise exception 'identity injection was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.sync_pull('10000000-0000-4000-8000-000000000001',999);
    raise exception 'future cursor was accepted';
  exception when invalid_parameter_value then null; end;
end; $$;

do $$ declare v_data jsonb; v_result jsonb; v_op jsonb; begin
  v_data := '{"poolId":"40000000-0000-4000-8000-000000000001","lotteryId":"mega-sena","numbers":[7,8,9,10,11,12],"authorIds":[],"catalogVersion":"caixa-basic-2026-10-07-v1","seed":null,"generationAlgorithmVersion":null}';
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'bet',jsonb_set(v_data,'{catalogVersion}','"old"')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'SQL catalog matches shared core');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'bet',jsonb_set(v_data,'{generationAlgorithmVersion}','"chacha20-lexicographic-rank-v1"')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'manual bet cannot claim generated version');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'bet',jsonb_set(v_data,'{seed}',to_jsonb(repeat('a',64)))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'generated bet requires matching algorithm version');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'person',
    jsonb_build_object('name','Unicode','nickname',repeat('😀',41),'adultDeclared',true)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'SQL UTF-16 nickname length matches core');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',gen_random_uuid(),'quota',
    '{"poolId":"40000000-0000-4000-8000-000000000001","personId":"30000000-0000-4000-8000-000000000001","units":1000001}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'SQL operational quota limit matches core');
  v_op := pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000009','group','{"name":"","statute":""}');
  v_result := public.sync_push(v_op);
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'invalid bootstrap rejected without group creation');
  perform pg_temp.assert_true(public.sync_push(v_op) = v_result, 'invalid bootstrap retry has durable receipt');
  perform pg_temp.assert_true(public.command_status((v_op ->> 'idempotencyKey')::uuid) = v_result, 'rejected bootstrap status recovers receipt');
  begin
    perform public.sync_push(jsonb_set(v_op,'{createdAt}','"2026-10-07T24:00:00Z"'));
    raise exception 'normalized next-day timestamp accepted';
  exception when invalid_parameter_value then null; end;
end; $$;

do $$ declare v_pull jsonb; begin
  v_pull := public.sync_pull('10000000-0000-4000-8000-000000000001',0);
  perform pg_temp.assert_true(jsonb_array_length(v_pull -> 'changes') = 7 and v_pull ->> 'nextCursor' = '7', 'new device downloads all committed revisions');
  perform pg_temp.assert_true((public.sync_pull('10000000-0000-4000-8000-000000000001',7) -> 'changes') = '[]', 'persisted cursor gives empty tail');
  perform pg_temp.assert_true(jsonb_array_length(public.sync_groups() -> 'groups') = 1, 'group discovery only lists own membership');
  begin
    insert into public.draft_records(group_id,id,kind,data,version) values('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000009','person','{}',1);
    raise exception 'direct draft write was accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.group_memberships(group_id,user_id,role) values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','organizer');
    raise exception 'membership self-escalation was accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.confirmed_payments(group_id,pool_id,person_id,amount_cents,confirmed_by,receipt_id)
      values('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',2500,
      '00000000-0000-4000-8000-000000000001',(select id from public.command_receipts limit 1));
    raise exception 'browser financial write was accepted';
  exception when insufficient_privilege then null; end;
end; $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000002","is_anonymous":false,"app_metadata":{}}', true);
do $$ declare v_result jsonb; begin
  perform pg_temp.assert_true((select count(*) = 0 from public.draft_records), 'another account sees no private drafts');
  perform pg_temp.assert_true((select count(*) = 0 from public.command_receipts), 'another account sees no receipts');
  perform pg_temp.assert_true(public.command_status('20000000-0000-4000-8000-000000000001') is null, 'another account cannot retrieve receipt by key');
  begin perform public.sync_pull('10000000-0000-4000-8000-000000000001',0); raise exception 'cross-group pull accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000007','person','{"name":"Intruder","nickname":"","adultDeclared":true}')); raise exception 'cross-group push accepted';
  exception when insufficient_privilege then null; end;
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000021','10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002','group','{"name":"Grupo B","statute":""}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'second owner creates separate group');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000022','10000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002','pool','{"title":"Bolão B","lotteryId":"mega-sena","contestNumber":null,"deadlineAt":null,"quotaPriceCents":"2500","participationMode":"undecided","status":"draft"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'second group pool');
  v_result := public.sync_push(pg_temp.operation('20000000-0000-4000-8000-000000000023','10000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000008','payment-proposal','{"poolId":"40000000-0000-4000-8000-000000000002","personId":"30000000-0000-4000-8000-000000000001","amountCents":"2500","note":"","status":"pending"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'reference to another group person rejected');
end; $$;

-- Participant membership is set by the test admin, never by an ordinary client.
reset role;
insert into public.group_memberships(group_id,user_id,role) values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','participant');
insert into storage.objects(bucket_id,name) values('evidence','10000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000001.png');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000003","app_metadata":{}}', true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 1 from public.groups), 'participant has group metadata only');
  perform pg_temp.assert_true((select count(*) = 0 from public.draft_records), 'participant cannot see other people private records');
  perform pg_temp.assert_true((select count(*) = 0 from storage.objects), 'participant cannot see original evidence');
  begin perform public.sync_pull('10000000-0000-4000-8000-000000000001',0); raise exception 'participant broad pull accepted';
  exception when insufficient_privilege then null; end;
end; $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000001","app_metadata":{}}', true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 1 from storage.objects), 'organizer can access own evidence');
  insert into storage.objects(bucket_id,name) values('evidence','10000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000002.pdf');
  begin insert into storage.objects(bucket_id,name) values('evidence','10000000-0000-4000-8000-000000000002/80000000-0000-4000-8000-000000000003.pdf'); raise exception 'cross-group upload accepted';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects(bucket_id,name) values('evidence','../80000000-0000-4000-8000-000000000003.pdf'); raise exception 'invalid storage path accepted';
  exception when insufficient_privilege then null; end;
  update storage.objects set name = 'replacement.pdf' where name like '%000000000001.png';
  delete from storage.objects where name like '%000000000001.png';
  perform pg_temp.assert_true((select count(*) = 2 from storage.objects), 'original evidence cannot be replaced or deleted');
end; $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000001","client_id":"90000000-0000-4000-8000-000000000001","app_metadata":{}}', true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.draft_records), 'delegated OAuth token denied by RLS');
  perform pg_temp.assert_true((select count(*) = 0 from public.groups), 'delegated OAuth cannot discover groups');
  perform pg_temp.assert_true((select count(*) = 0 from storage.objects), 'delegated OAuth cannot read evidence');
  begin perform public.sync_groups(); raise exception 'agent RPC accepted'; exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000001","app_metadata":{"actor_type":"agent"}}', true);
do $$ begin
  begin perform public.sync_pull('10000000-0000-4000-8000-000000000001',0); raise exception 'marked agent accepted'; exception when insufficient_privilege then null; end;
end; $$;

-- A revoked membership also removes access to old command receipts.
reset role;
delete from public.group_memberships where group_id = '10000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000001","app_metadata":{}}', true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.command_receipts where group_id = '10000000-0000-4000-8000-000000000001'), 'revoked owner cannot read old receipt snapshots');
  begin perform public.command_status('20000000-0000-4000-8000-000000000001'); raise exception 'revoked status lookup accepted'; exception when insufficient_privilege then null; end;
end; $$;

-- Feed pagination and hash continuity use committed whole revisions.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000002","app_metadata":{}}', true);
do $$ declare i integer; v_result jsonb; v_page jsonb; v_tail jsonb; begin
  for i in 0..204 loop
    v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),'10000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000002','person',jsonb_build_object('name','Pessoa B','nickname',i::text,'adultDeclared',true),i));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'paginated edits accepted');
  end loop;
  v_page := public.sync_pull('10000000-0000-4000-8000-000000000002',0);
  perform pg_temp.assert_true(jsonb_array_length(v_page -> 'changes') = 200 and (v_page ->> 'hasMore')::boolean, 'first feed page bounded');
  v_tail := public.sync_pull('10000000-0000-4000-8000-000000000002',(v_page ->> 'nextCursor')::bigint);
  perform pg_temp.assert_true(jsonb_array_length(v_tail -> 'changes') = 7 and not (v_tail ->> 'hasMore')::boolean, 'second feed page complete');
  perform pg_temp.assert_true(v_tail ->> 'nextCursor' = '207', 'cursor tracks complete group revision');
  perform pg_temp.assert_true((select count(*) = 207 from public.audit_events), 'accepted commands append audit in same transaction');
  perform pg_temp.assert_true((select bool_and(event_hash = encode(sha256(convert_to(previous_hash || event::text, 'UTF8')), 'hex')) from public.audit_events), 'audit hashes verify');
  perform pg_temp.assert_true((select bool_and(previous_hash = coalesce(previous_event_hash,repeat('0',64))) from
    (select previous_hash,lag(event_hash) over (order by revision) previous_event_hash from public.audit_events) chain), 'audit chain has no gaps');
end; $$;

-- Quota arithmetic, adulthood and per-pool capacity are transactional dependencies.
do $$ declare
  v_group uuid := '10000000-0000-4000-8000-000000000010';
  v_pool uuid := '40000000-0000-4000-8000-000000000010';
  v_other_pool uuid := '40000000-0000-4000-8000-000000000011';
  v_adult uuid := gen_random_uuid(); v_minor uuid := gen_random_uuid(); v_extra_person uuid := gen_random_uuid();
  v_first_quota uuid := gen_random_uuid(); v_minor_quota uuid := gen_random_uuid(); v_extra_quota uuid := gen_random_uuid();
  v_person uuid; v_result jsonb; v_op jsonb; v_pool_data jsonb; v_revision bigint; i integer;
begin
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_group,'group','{"name":"Grupo de cotas","statute":""}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'quota test group');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_adult,'person','{"name":"Pessoa adulta","nickname":"","adultDeclared":true}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'adult person fixture');
  v_pool_data := '{"title":"Teste de cotas","lotteryId":"mega-sena","contestNumber":null,"deadlineAt":null,"quotaPriceCents":"3001","participationMode":"internal","status":"draft"}';
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_pool,'pool',v_pool_data));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'fraction test pool');
  v_op := pg_temp.operation(gen_random_uuid(),v_group,v_first_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_adult,'units',25));
  v_result := public.sync_push(v_op);
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', '3001 cents times 25 units rejects a fractional cent');
  perform pg_temp.assert_true(v_result ->> 'message' like '%fração de centavo%', 'fraction rejection explains correction');
  perform pg_temp.assert_true(not exists (select 1 from public.draft_records where group_id = v_group and id = v_first_quota), 'invalid fractional quota creates no entity');
  perform pg_temp.assert_true((select revision = 3 from public.groups where id = v_group), 'fraction rejection does not advance revision');
  perform pg_temp.assert_true((select count(*) = 3 from public.group_changes where group_id = v_group), 'fraction rejection creates no feed change');
  perform pg_temp.assert_true(public.command_status((v_op ->> 'idempotencyKey')::uuid) = v_result, 'fraction rejection has real durable receipt');

  v_pool_data := jsonb_set(v_pool_data,'{quotaPriceCents}','"3000"');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_pool,'pool',v_pool_data,1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'price correction accepted');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_first_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_adult,'units',25)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'fractional quota with exact cents accepted');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_pool,'pool',jsonb_set(v_pool_data,'{quotaPriceCents}','"3001"'),2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'price change cannot invalidate existing fractional quota');
  perform pg_temp.assert_true((select data ->> 'quotaPriceCents' = '3000' and version = 2 from public.draft_records where group_id = v_group and id = v_pool), 'rejected price retains current pool');
  perform pg_temp.assert_true((select revision = 5 from public.groups where id = v_group), 'rejected price creates no revision');
  v_pool_data := jsonb_set(v_pool_data,'{quotaPriceCents}','"3200"');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_pool,'pool',v_pool_data,2));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'valid price change with existing quotas allowed');

  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_minor,'person','{"name":"Sem declaração","nickname":"","adultDeclared":false}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'person without declaration may be drafted');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_minor_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_minor,'units',100)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'quota requires adult declaration');
  perform pg_temp.assert_true(v_result ->> 'message' like '%declaração de maioridade%', 'adult rejection explains requirement');
  perform pg_temp.assert_true(not exists (select 1 from public.draft_records where group_id = v_group and id = v_minor_quota), 'undeclared quota creates no entity');
  perform pg_temp.assert_true((select revision = 7 from public.groups where id = v_group), 'undeclared quota creates no revision');

  for i in 2..200 loop
    v_person := gen_random_uuid();
    v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_person,'person',jsonb_build_object('name','Pessoa ' || i::text,'nickname','','adultDeclared',true)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'capacity person created');
    v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,gen_random_uuid(),'quota',jsonb_build_object('poolId',v_pool,'personId',v_person,'units',100)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'quota accepted within 200 participant capacity');
  end loop;
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_extra_person,'person','{"name":"Pessoa excedente","nickname":"","adultDeclared":true}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'extra person fixture does not itself create participation');
  select revision into v_revision from public.groups where id = v_group;
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_extra_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_extra_person,'units',100)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', '201st distinct quota rejected');
  perform pg_temp.assert_true(v_result ->> 'message' like '%200 participantes%', 'capacity rejection explains limit');
  perform pg_temp.assert_true(not exists (select 1 from public.draft_records where group_id = v_group and id = v_extra_quota), 'over-capacity quota creates no entity');
  perform pg_temp.assert_true((select count(*) = 200 from public.draft_records where group_id = v_group and kind = 'quota' and (data ->> 'poolId')::uuid = v_pool), 'capacity remains exactly 200');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group), 'capacity rejection creates no revision');
  perform pg_temp.assert_true((select count(*) = v_revision from public.group_changes where group_id = v_group), 'rejections create no feed entries');
  perform pg_temp.assert_true((select count(*) = v_revision from public.audit_events where group_id = v_group), 'rejections create no accepted-command audit entries');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_first_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_adult,'units',50),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'existing quota can be updated at capacity');

  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_other_pool,'pool',v_pool_data));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'separate pool has separate capacity');
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_extra_quota,'quota',jsonb_build_object('poolId',v_other_pool,'personId',v_extra_person,'units',100)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted', 'extra person may participate in another pool');
  select revision into v_revision from public.groups where id = v_group;
  v_result := public.sync_push(pg_temp.operation(gen_random_uuid(),v_group,v_extra_quota,'quota',jsonb_build_object('poolId',v_pool,'personId',v_extra_person,'units',100),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected', 'moving existing quota cannot bypass destination capacity');
  perform pg_temp.assert_true((select (data ->> 'poolId')::uuid = v_other_pool and version = 1 from public.draft_records where group_id = v_group and id = v_extra_quota), 'rejected move retains original quota');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group), 'rejected move creates no revision');
end; $$;

set local role anon;
do $$ begin
  begin perform public.sync_groups(); raise exception 'anonymous RPC accepted'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.draft_records limit 1; raise exception 'anonymous select accepted'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
do $$ begin
  begin update public.audit_events set event = '{}'; raise exception 'audit rewrite accepted'; exception when insufficient_privilege then null; end;
  begin delete from public.command_receipts; raise exception 'receipt deletion accepted'; exception when insufficient_privilege then null; end;
end; $$;

rollback;
