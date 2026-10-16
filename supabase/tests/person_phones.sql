-- Person phones use synthetic numbers and sessions only. Organizers set, list, change and clear; nobody else touches them;
-- the participant card never carries a phone.
begin;
create function pg_temp.assert_true(p_condition boolean,p_label text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.push(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.assert_true(public.sync_push(jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
    'entityId',p_id,'kind',p_kind,'expectedVersion',0,'data',p_data,'createdAt','2026-10-15T12:00:00.000Z')) ->> 'status' = 'accepted','fixture ' || p_kind || ' accepted');
end; $$;
create function pg_temp.hash(p_token text) returns text language sql as $$ select encode(sha256(convert_to(p_token,'UTF8')),'hex'); $$;

-- 981 organizes group 1 (people A and B, one pool where A has a quota); 982 organizes group 2 (person X);
-- 983 is a registrar of group 1 (a member, not an organizer); 984 belongs to no group.
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000981','phones-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000982','phones-b@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000983','phones-c@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000984','phones-d@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.push(g,g,'group','{"name":"Bolão dos contatos","statute":"Regras privadas de rateio"}');
  perform pg_temp.push(g,'d3000000-0000-4000-8000-000000000001','person','{"name":"Pessoa A","nickname":"","adultDeclared":true}');
  perform pg_temp.push(g,'d3000000-0000-4000-8000-000000000002','person','{"name":"Pessoa B","nickname":"","adultDeclared":true}');
  perform pg_temp.push(g,'d4000000-0000-4000-8000-000000000001','pool','{"title":"Mega da virada","lotteryId":"mega-sena","contestNumber":42,
    "deadlineAt":"2099-01-01T00:00:00Z","quotaPriceCents":"1000","participationMode":"internal","status":"draft"}');
  perform pg_temp.push(g,'d5000000-0000-4000-8000-000000000001','quota','{"poolId":"d4000000-0000-4000-8000-000000000001","personId":"d3000000-0000-4000-8000-000000000001","units":100}');
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000002';
begin
  perform pg_temp.push(g,g,'group','{"name":"Outro bolão","statute":"Regras privadas de rateio"}');
  perform pg_temp.push(g,'d3000000-0000-4000-8000-000000000009','person','{"name":"Pessoa X","nickname":"","adultDeclared":true}');
end; $$;
reset role;
insert into public.group_memberships(group_id,user_id,role) values('d1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000983','registrar');

-- The organizer sets, lists, changes and clears; the stored value is digits only, 10 to 15 of them, country code first.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001'; a uuid := 'd3000000-0000-4000-8000-000000000001'; b uuid := 'd3000000-0000-4000-8000-000000000002';
  r jsonb; v_phone text;
begin
  perform pg_temp.assert_true(public.person_phones_pull(g) = '{"phones":[]}'::jsonb,'no phones at first');
  r := public.person_phone_set(g,a,'5511987654321');
  perform pg_temp.assert_true(r = jsonb_build_object('personId',a,'phone','5511987654321'),'set answers the saved phone');
  r := public.person_phone_set(g,b,'551133334444');
  perform pg_temp.assert_true(public.person_phones_pull(g) = jsonb_build_object('phones',jsonb_build_array(
    jsonb_build_object('personId',a,'phone','5511987654321'),jsonb_build_object('personId',b,'phone','551133334444'))),'both phones listed by person');
  r := public.person_phone_set(g,a,'5521999990000');
  perform pg_temp.assert_true(r ->> 'phone' = '5521999990000' and jsonb_array_length(public.person_phones_pull(g) -> 'phones') = 2
    and public.person_phones_pull(g) -> 'phones' -> 0 ->> 'phone' = '5521999990000','changing a phone replaces it, never duplicates it');
  perform pg_temp.assert_true(public.person_phone_set(g,a,'5521999990000') = r,'repeating the same set returns the same answer');
  perform pg_temp.assert_true((select count(*) from public.person_phones) = 2
    and (select updated_by from public.person_phones where person_id = a) = '00000000-0000-4000-8000-000000000981','organizer reads its phones through RLS and is recorded');
  perform public.person_phone_set(g,b,'1234567890');
  perform public.person_phone_set(g,b,'123456789012345');
  perform pg_temp.assert_true((select phone from public.person_phones where person_id = b) = '123456789012345','10 and 15 digits are accepted');
  perform public.person_phone_set(g,b,'551133334444');
  foreach v_phone in array array['','0511987654321','+5511987654321','11 98765-4321','(11) 98765-4321','123456789','1234567890123456','abc','55119876543２１','5511987654321 ',E'5511987654321\n'] loop
    begin perform public.person_phone_set(g,a,v_phone); raise exception 'invalid phone accepted: %',v_phone; exception when invalid_parameter_value then null; end;
  end loop;
  begin perform public.person_phone_set(g,a,null); raise exception 'null phone accepted'; exception when invalid_parameter_value then null; end;
  perform pg_temp.assert_true((select phone from public.person_phones where person_id = a) = '5521999990000','refused phones leave the saved one alone');
  -- A person must be a person of this very group: another group's person, a pool and an unknown id are refused.
  begin perform public.person_phone_set(g,'d3000000-0000-4000-8000-000000000009','5511987654321'); raise exception 'person of another group accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.person_phone_set(g,'d4000000-0000-4000-8000-000000000001','5511987654321'); raise exception 'pool accepted as person';
    exception when invalid_parameter_value then null; end;
  begin perform public.person_phone_set(g,gen_random_uuid(),'5511987654321'); raise exception 'unknown person accepted'; exception when invalid_parameter_value then null; end;
  -- Clients only read through RLS; every write goes through the functions.
  begin insert into public.person_phones(group_id,person_id,phone,updated_at,updated_by) values(g,a,'5511987654321',now(),auth.uid()); raise exception 'direct insert';
    exception when insufficient_privilege then null; end;
  begin update public.person_phones set phone = '5511987654321'; raise exception 'direct update'; exception when insufficient_privilege then null; end;
  begin delete from public.person_phones; raise exception 'direct delete'; exception when insufficient_privilege then null; end;
  -- The organizer opens personal links; the card is built below, after both phones are in place.
  perform public.participant_link_create(g,a,pg_temp.hash('phone-token-a'));
  perform public.participant_link_create(g,b,pg_temp.hash('phone-token-b'));
end; $$;

-- The card is opened by the api function with the service key and never carries a phone.
reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare ca jsonb := public.participant_card(pg_temp.hash('phone-token-a')); cb jsonb := public.participant_card(pg_temp.hash('phone-token-b'));
begin
  perform pg_temp.assert_true(ca -> 'person' ->> 'name' = 'Pessoa A' and jsonb_array_length(ca -> 'pools') = 1 and cb -> 'person' ->> 'name' = 'Pessoa B','both cards open');
  perform pg_temp.assert_true(ca::text !~ '5521999990000|5511987654321' and cb::text !~ '551133334444' and ca::text !~* 'phone|telefone|whatsapp' and cb::text !~* 'phone|telefone|whatsapp',
    'the card carries no phone');
end; $$;
reset role;

-- Clearing removes only that person's phone, and clearing again is harmless.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001'; a uuid := 'd3000000-0000-4000-8000-000000000001'; b uuid := 'd3000000-0000-4000-8000-000000000002';
begin
  perform pg_temp.assert_true(public.person_phone_clear(g,a) = jsonb_build_object('personId',a),'clear answers the person');
  perform pg_temp.assert_true(public.person_phones_pull(g) = jsonb_build_object('phones',jsonb_build_array(jsonb_build_object('personId',b,'phone','551133334444'))),'only B keeps a phone');
  perform pg_temp.assert_true(public.person_phone_clear(g,a) = jsonb_build_object('personId',a) and jsonb_array_length(public.person_phones_pull(g) -> 'phones') = 1,'clearing twice is harmless');
  perform pg_temp.assert_true(public.person_phone_set(g,a,'5511987654321') ->> 'phone' = '5511987654321','a cleared phone can be set again');
end; $$;

-- Another group's organizer cannot list, set or clear here, and sees none of these rows.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000982","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000982","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001'; h uuid := 'd1000000-0000-4000-8000-000000000002'; x uuid := 'd3000000-0000-4000-8000-000000000009';
begin
  begin perform public.person_phones_pull(g); raise exception 'foreign organizer listed phones'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_set(g,'d3000000-0000-4000-8000-000000000001','5511000000000'); raise exception 'foreign organizer set a phone'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_clear(g,'d3000000-0000-4000-8000-000000000001'); raise exception 'foreign organizer cleared a phone'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true((select count(*) from public.person_phones) = 0,'RLS hides group 1 phones from group 2 organizer');
  perform pg_temp.assert_true(public.person_phones_pull(h) = '{"phones":[]}'::jsonb,'group 2 has no phones yet');
  perform public.person_phone_set(h,x,'5531988887777');
  perform pg_temp.assert_true(public.person_phones_pull(h) = jsonb_build_object('phones',jsonb_build_array(jsonb_build_object('personId',x,'phone','5531988887777'))),'group 2 lists only its own phone');
  begin perform public.person_phone_set(h,'d3000000-0000-4000-8000-000000000001','5511987654321'); raise exception 'person of group 1 set in group 2';
    exception when invalid_parameter_value then null; end;
end; $$;

-- A member who is not an organizer is refused, and so is an account with no group.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000983","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000983","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001'; a uuid := 'd3000000-0000-4000-8000-000000000001';
begin
  begin perform public.person_phones_pull(g); raise exception 'registrar listed phones'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_set(g,a,'5511000000000'); raise exception 'registrar set a phone'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_clear(g,a); raise exception 'registrar cleared a phone'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true((select count(*) from public.person_phones) = 0,'RLS hides phones from a registrar');
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000984","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000984","app_metadata":{}}',true);
do $$ declare g uuid := 'd1000000-0000-4000-8000-000000000001'; a uuid := 'd3000000-0000-4000-8000-000000000001';
begin
  begin perform public.person_phones_pull(g); raise exception 'non-member listed phones'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_set(g,a,'5511000000000'); raise exception 'non-member set a phone'; exception when insufficient_privilege then null; end;
  begin perform public.person_phone_clear(g,a); raise exception 'non-member cleared a phone'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true((select count(*) from public.person_phones) = 0,'RLS hides phones from a non-member');
end; $$;
-- An anonymous or machine session is refused too.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000981","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000981","is_anonymous":true,"app_metadata":{}}',true);
do $$ begin
  begin perform public.person_phones_pull('d1000000-0000-4000-8000-000000000001'); raise exception 'anonymous session listed phones'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.person_phones_pull('d1000000-0000-4000-8000-000000000001'); raise exception 'anon role listed phones'; exception when insufficient_privilege then null; end;
  begin perform count(*) from public.person_phones; raise exception 'anon role read the table'; exception when insufficient_privilege then null; end;
end; $$;
rollback;
