-- Answers through the card use synthetic sessions, links and proofs only; no real money moves. The person answers by the
-- link token (hashed, with the PIN when set); the treasurer reads the answers, the proof and marks reminders.
begin;
create function pg_temp.assert_true(p_condition boolean,p_label text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.push(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.assert_true(public.sync_push(jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
    'entityId',p_id,'kind',p_kind,'expectedVersion',0,'data',p_data,'createdAt','2026-10-16T12:00:00.000Z')) ->> 'status' = 'accepted','fixture ' || p_kind || ' accepted');
end; $$;
create function pg_temp.hash(p_token text) returns text language sql as $$ select encode(sha256(convert_to(p_token,'UTF8')),'hex'); $$;
create function pg_temp.proof(p_group uuid,p_id uuid) returns jsonb language sql as $$
  select jsonb_build_object('id',p_id,'sha256',repeat('ab',32),'mimeType','image/jpeg','byteSize',1234,'storagePath',p_group::text || '/' || p_id::text || '.jpg'); $$;

-- 981 organizes group 1: people A and B; pool 1 (draft, A has a quota, B has none), pool 2 (locked, A has a quota),
-- pool 3 (draft whose draw already passed, nobody in it). 982 organizes group 2 with its own pool. 984 belongs to no group.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000981','answers-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000982','answers-b@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000984','answers-d@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'e1000000-0000-4000-8000-000000000001'; r jsonb;
begin
  perform pg_temp.push(g,g,'group','{"name":"Confraria da fezinha","statute":"Regras privadas de rateio"}');
  perform pg_temp.push(g,'e3000000-0000-4000-8000-000000000001','person','{"name":"Pessoa A","nickname":"","adultDeclared":true}');
  perform pg_temp.push(g,'e3000000-0000-4000-8000-000000000002','person','{"name":"Pessoa B","nickname":"","adultDeclared":true}');
  perform pg_temp.push(g,'e4000000-0000-4000-8000-000000000001','pool','{"title":"Mega de sábado","lotteryId":"mega-sena","contestNumber":42,
    "deadlineAt":"2099-01-01T00:00:00Z","quotaPriceCents":"5000","participationMode":"internal","status":"draft"}');
  perform pg_temp.push(g,'e4000000-0000-4000-8000-000000000002','pool','{"title":"Mega travada","lotteryId":"mega-sena","contestNumber":41,
    "deadlineAt":"2099-01-01T00:00:00Z","quotaPriceCents":"5000","participationMode":"internal","status":"draft"}');
  perform pg_temp.push(g,'e4000000-0000-4000-8000-000000000003','pool','{"title":"Mega que já correu","lotteryId":"mega-sena","contestNumber":40,
    "deadlineAt":"2099-01-01T00:00:00Z","quotaPriceCents":"5000","participationMode":"internal","status":"draft"}');
  perform pg_temp.push(g,'e5000000-0000-4000-8000-000000000001','quota','{"poolId":"e4000000-0000-4000-8000-000000000001","personId":"e3000000-0000-4000-8000-000000000001","units":100}');
  perform pg_temp.push(g,'e5000000-0000-4000-8000-000000000002','quota','{"poolId":"e4000000-0000-4000-8000-000000000002","personId":"e3000000-0000-4000-8000-000000000001","units":100}');
  r := public.participant_link_create(g,'e3000000-0000-4000-8000-000000000001',pg_temp.hash('answer-a'));
  r := public.participant_link_create(g,'e3000000-0000-4000-8000-000000000001',pg_temp.hash('answer-a-old'));
  r := public.participant_link_revoke(g,(r ->> 'id')::uuid);
  r := public.participant_link_create(g,'e3000000-0000-4000-8000-000000000002',pg_temp.hash('answer-b'));
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ declare g uuid := 'e1000000-0000-4000-8000-000000000002';
begin
  perform pg_temp.push(g,g,'group','{"name":"Outro bolão","statute":"Regras privadas de rateio"}');
  perform pg_temp.push(g,'e4000000-0000-4000-8000-000000000009','pool','{"title":"Mega alheia","lotteryId":"mega-sena","contestNumber":42,
    "deadlineAt":"2099-01-01T00:00:00Z","quotaPriceCents":"5000","participationMode":"internal","status":"draft"}');
end; $$;
reset role;
-- Pool 2 is locked (the lock itself is planning_decide's job, tested in planning.sql); pool 3's contest was drawn a minute ago.
update public.draft_records set data = jsonb_set(data,'{status}','"locked"') where id = 'e4000000-0000-4000-8000-000000000002';
insert into public.contest_calendar_versions(id,group_id,pool_id,version,lottery_id,contest_number,source,source_url,source_reference,raw_text,sha256,collected_at,expected_draw_at)
  values('e9000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000003',1,'mega-sena',40,'caixa','https://servicebus2.caixa.gov.br/',
    'Calendário de teste','{}',encode(sha256(convert_to('{}','UTF8')),'hex'),now(),now() - interval '1 minute');

-- The api function answers with the service key (the stub role gets the reads the platform's service key has). B protects the card with a PIN first.
grant select on public.participant_responses,public.participant_proofs,public.participant_link_pins to service_role;
alter role service_role bypassrls;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare g uuid := 'e1000000-0000-4000-8000-000000000001'; p1 uuid := 'e4000000-0000-4000-8000-000000000001'; p2 uuid := 'e4000000-0000-4000-8000-000000000002';
  p3 uuid := 'e4000000-0000-4000-8000-000000000003'; k1 uuid := gen_random_uuid(); k2 uuid := gen_random_uuid(); k3 uuid := gen_random_uuid();
  proof uuid := 'e7000000-0000-4000-8000-000000000001'; r jsonb; again jsonb; card jsonb; pool jsonb;
begin
  perform pg_temp.assert_true(public.participant_pin_set(pg_temp.hash('answer-b'),'1234',null) = '{"pinSet":true}'::jsonb,'B sets a PIN');
  -- Bad links and pools answer with error objects, like the card.
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-none'),null,p1,'in',null,null,k1) = '{"error":"link_unknown"}'::jsonb,'unknown link cannot answer');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-a-old'),null,p1,'in',null,null,k1) = '{"error":"link_revoked"}'::jsonb,'revoked link cannot answer');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-a'),null,gen_random_uuid(),'in',null,null,k1) = '{"error":"pool_unknown"}'::jsonb,'unknown pool');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-a'),null,'e4000000-0000-4000-8000-000000000009','in',null,null,k1) = '{"error":"pool_unknown"}'::jsonb,'pool of another group is unknown');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-a'),null,p2,'in',null,null,k1) = '{"error":"pool_closed"}'::jsonb,'locked pool takes no answer');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-a'),null,p3,'in',null,null,k1) = '{"error":"pool_closed"}'::jsonb,'drawn contest takes no answer');
  perform pg_temp.assert_true(public.participant_proof_context(pg_temp.hash('answer-a'),null,p2,k1) = '{"error":"pool_closed"}'::jsonb,'no proof for a locked pool');
  -- A says "in", then retries with the same key: one row, the same answer.
  r := public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in',null,null,k1);
  perform pg_temp.assert_true(r -> 'repeated' = 'false'::jsonb and r -> 'response' ->> 'kind' = 'in' and r -> 'response' -> 'amountCents' = 'null'::jsonb
    and r -> 'response' -> 'proofId' = 'null'::jsonb and r -> 'response' ->> 'poolId' = p1::text and r -> 'response' ->> 'personId' = 'e3000000-0000-4000-8000-000000000001'
    and r -> 'response' ? 'createdAt','A is in');
  again := public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in',null,null,k1);
  perform pg_temp.assert_true(again -> 'repeated' = 'true'::jsonb and again -> 'response' = r -> 'response','retry returns the same answer');
  perform pg_temp.assert_true((select count(*) from public.participant_responses) = 1,'retry wrote nothing');
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'out',null,null,k1); raise exception 'key reused for another answer';
    exception when invalid_parameter_value then null; end;
  perform pg_temp.assert_true(public.participant_proof_context(pg_temp.hash('answer-a'),null,p1,k1) = jsonb_build_object('repeated',true,'response',r -> 'response'),'replayed key uploads nothing');
  -- Malformed answers raise, so the api maps them to invalid_request.
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid',null,null,k2); raise exception 'paid without amount'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid','0',null,k2); raise exception 'paid zero'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid','50,00',null,k2); raise exception 'paid with a decimal'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in','5000',null,k2); raise exception 'in with an amount'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in',null,pg_temp.proof(g,proof),k2); raise exception 'in with a proof'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'maybe',null,null,k2); raise exception 'unknown kind'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in',null,null,null); raise exception 'no key'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid','5000',jsonb_build_object('id',proof,'sha256','x','mimeType','image/jpeg','byteSize',1,'storagePath','x'),k2);
    raise exception 'malformed proof'; exception when invalid_parameter_value then null; end;
  perform pg_temp.assert_true((select count(*) from public.participant_proofs) = 0 and (select count(*) from public.participant_responses) = 1,'malformed answers wrote nothing');
  -- "Já paguei" with the proof: the context names the group for the object, then the row and the answer are written together.
  perform pg_temp.assert_true(public.participant_proof_context(pg_temp.hash('answer-a'),null,p1,k2) = jsonb_build_object('groupId',g),'proof context names the group');
  r := public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid','5000',pg_temp.proof(g,proof),k2);
  perform pg_temp.assert_true(r -> 'repeated' = 'false'::jsonb and r -> 'response' ->> 'kind' = 'paid' and r -> 'response' ->> 'amountCents' = '5000'
    and r -> 'response' ->> 'proofId' = proof::text,'A paid with a proof');
  perform pg_temp.assert_true((select storage_path from public.participant_proofs where id = proof) = g::text || '/' || proof::text || '.jpg','proof stored under the group');
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'paid','5000',pg_temp.proof(g,proof),k3); raise exception 'proof id reused';
    exception when invalid_parameter_value then null; end;
  -- B needs the PIN: without it or with a wrong one nothing is recorded, and the miss counts like on the card.
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-b'),null,p1,'out',null,null,k3) = '{"error":"pin_required"}'::jsonb,'B without PIN');
  perform pg_temp.assert_true(public.participant_respond(pg_temp.hash('answer-b'),'9999',p1,'out',null,null,k3) = '{"error":"pin_wrong","attemptsLeft":4}'::jsonb,'B wrong PIN counts');
  perform pg_temp.assert_true(public.participant_card_open(pg_temp.hash('answer-b'),'9999') = '{"error":"pin_wrong","attemptsLeft":3}'::jsonb,'the card shares the counter');
  r := public.participant_respond(pg_temp.hash('answer-b'),'1234',p1,'out',null,null,k3);
  perform pg_temp.assert_true(r -> 'response' ->> 'kind' = 'out' and r -> 'response' ->> 'personId' = 'e3000000-0000-4000-8000-000000000002','B is out');
  perform pg_temp.assert_true((select failed_attempts from public.participant_link_pins) = 0,'right PIN resets the counter');
  -- The cards: A sees pools 1 and 2 (quota) with the latest answer; B sees pool 1 as an invitation (no quota); pool 3 shows nowhere.
  card := public.participant_card_open(pg_temp.hash('answer-a'),null);
  perform pg_temp.assert_true(card -> 'pinSet' = 'false'::jsonb and jsonb_array_length(card -> 'pools') = 2,'A card lists two pools');
  select value into pool from jsonb_array_elements(card -> 'pools') where value ->> 'id' = p1::text;
  perform pg_temp.assert_true(pool -> 'responseOpen' = 'true'::jsonb and pool -> 'response' ->> 'kind' = 'paid' and pool -> 'response' ->> 'amountCents' = '5000'
    and pool -> 'response' -> 'proofSent' = 'true'::jsonb and pool -> 'response' ? 'at' and pool -> 'quota' ->> 'units' = '100' and pool -> 'quota' ->> 'dueCents' = '5000'
    and pool::text not like '%storagePath%','A card carries the latest answer and the quota');
  select value into pool from jsonb_array_elements(card -> 'pools') where value ->> 'id' = p2::text;
  perform pg_temp.assert_true(pool -> 'responseOpen' = 'false'::jsonb and pool -> 'response' = 'null'::jsonb and pool -> 'quota' ->> 'units' = '100','locked pool reads only');
  card := public.participant_card_open(pg_temp.hash('answer-b'),'1234');
  perform pg_temp.assert_true(card -> 'pinSet' = 'true'::jsonb and jsonb_array_length(card -> 'pools') = 1,'B card lists the open invitation only');
  pool := card -> 'pools' -> 0;
  perform pg_temp.assert_true(pool ->> 'id' = p1::text and pool -> 'quota' = 'null'::jsonb and pool -> 'responseOpen' = 'true'::jsonb and pool -> 'response' ->> 'kind' = 'out'
    and pool -> 'response' -> 'proofSent' = 'false'::jsonb and pool -> 'share' = 'null'::jsonb,'invitation pool has no quota and keeps the answer');
end; $$;

-- The organizer reads the whole history with the proof, marks reminders and gets the proof's status; nobody else does.
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'e1000000-0000-4000-8000-000000000001'; p1 uuid := 'e4000000-0000-4000-8000-000000000001'; r jsonb; m jsonb;
begin
  r := public.participant_responses_pull(g);
  perform pg_temp.assert_true(jsonb_array_length(r -> 'responses') = 3 and r -> 'responses' -> 0 ->> 'kind' = 'in' and r -> 'responses' -> 1 ->> 'kind' = 'paid'
    and r -> 'responses' -> 2 ->> 'kind' = 'out' and r -> 'reminders' = '[]'::jsonb,'history in order');
  perform pg_temp.assert_true(r -> 'responses' -> 1 -> 'proof' ->> 'sha256' = repeat('ab',32) and r -> 'responses' -> 1 -> 'proof' ->> 'mimeType' = 'image/jpeg'
    and r -> 'responses' -> 1 -> 'proof' -> 'byteSize' = '1234'::jsonb and r -> 'responses' -> 0 -> 'proof' = 'null'::jsonb and r::text not like '%storagePath%','proof summary without the path');
  m := public.participant_reminder_mark(g,p1,'e3000000-0000-4000-8000-000000000002');
  perform pg_temp.assert_true(m ->> 'poolId' = p1::text and m ->> 'personId' = 'e3000000-0000-4000-8000-000000000002' and m ? 'remindedAt','reminder marked');
  perform pg_temp.assert_true(public.participant_responses_pull(g) -> 'reminders' -> 0 = m,'reminder listed');
  begin perform public.participant_reminder_mark(g,gen_random_uuid(),'e3000000-0000-4000-8000-000000000002'); raise exception 'reminder for an unknown pool'; exception when invalid_parameter_value then null; end;
  begin perform public.participant_reminder_mark(g,p1,p1); raise exception 'reminder for a non-person'; exception when invalid_parameter_value then null; end;
  r := public.participant_proof_status('e7000000-0000-4000-8000-000000000001');
  perform pg_temp.assert_true(r ->> 'storagePath' = g::text || '/e7000000-0000-4000-8000-000000000001.jpg' and r ->> 'mimeType' = 'image/jpeg' and r ->> 'groupId' = g::text,'proof status for download');
  perform pg_temp.assert_true(public.participant_proof_status(gen_random_uuid()) is null,'unknown proof');
  perform pg_temp.assert_true((select count(*) from public.participant_responses) = 3 and (select count(*) from public.participant_reminders) = 1,'organizer reads its rows through RLS');
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,p1,'in',null,null,gen_random_uuid()); raise exception 'organizer session answered directly';
    exception when insufficient_privilege then null; end;
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ declare g uuid := 'e1000000-0000-4000-8000-000000000001';
begin
  begin perform public.participant_responses_pull(g); raise exception 'other organizer read the answers'; exception when insufficient_privilege then null; end;
  begin perform public.participant_reminder_mark(g,'e4000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000002'); raise exception 'other organizer marked a reminder';
    exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true(public.participant_proof_status('e7000000-0000-4000-8000-000000000001') is null,'other organizer gets no proof');
  perform pg_temp.assert_true((select count(*) from public.participant_responses) = 0 and (select count(*) from public.participant_proofs) = 0,'RLS hides the rows');
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000984","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000984","app_metadata":{}}',true);
do $$ begin
  begin perform public.participant_responses_pull('e1000000-0000-4000-8000-000000000001'); raise exception 'non-member read the answers'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.participant_respond(pg_temp.hash('answer-a'),null,'e4000000-0000-4000-8000-000000000001','in',null,null,gen_random_uuid()); raise exception 'anonymous client answered';
    exception when insufficient_privilege then null; end;
  begin perform public.participant_responses_pull('e1000000-0000-4000-8000-000000000001'); raise exception 'anon role listed answers'; exception when insufficient_privilege then null; end;
end; $$;
reset role;

-- Nothing is rewritten or deleted, and the stored proof is read by its organizer only and never replaced through a browser.
do $$ begin
  begin update public.participant_responses set kind = 'in'; raise exception 'answer rewritten'; exception when insufficient_privilege then null; end;
  begin delete from public.participant_responses; raise exception 'answer deleted'; exception when insufficient_privilege then null; end;
  begin delete from public.participant_proofs; raise exception 'proof row deleted'; exception when insufficient_privilege then null; end;
  begin delete from public.participant_reminders; raise exception 'reminder deleted'; exception when insufficient_privilege then null; end;
end; $$;
insert into storage.objects(bucket_id,name) values('participant-proofs','e1000000-0000-4000-8000-000000000001/e7000000-0000-4000-8000-000000000001.jpg');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) from storage.objects where bucket_id = 'participant-proofs') = 1,'organizer reads the proof object');
  begin insert into storage.objects(bucket_id,name) values('participant-proofs','e1000000-0000-4000-8000-000000000001/e7000000-0000-4000-8000-000000000002.jpg');
    raise exception 'organizer uploaded a proof'; exception when insufficient_privilege then null; end;
  -- Without an UPDATE or DELETE policy the browser's attempt touches no row (RLS filters silently); the guard trigger stops even the service key below.
  delete from storage.objects where bucket_id = 'participant-proofs';
  update storage.objects set name = 'x' where bucket_id = 'participant-proofs';
  perform pg_temp.assert_true((select count(*) from storage.objects where bucket_id = 'participant-proofs' and name like 'e1000000-%/e7000000-%.jpg') = 1,'proof object untouched by the organizer');
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) from storage.objects where bucket_id = 'participant-proofs') = 0,'other organizer sees no proof object');
end; $$;
reset role;
do $$ begin
  begin delete from storage.objects where bucket_id = 'participant-proofs'; raise exception 'proof object deleted'; exception when insufficient_privilege then null; end;
  begin update storage.objects set name = 'x' where bucket_id = 'participant-proofs'; raise exception 'proof object renamed'; exception when insufficient_privilege then null; end;
end; $$;
rollback;
