-- Isolated financial integration assertions. All synthetic fixtures roll back.
begin;

create function pg_temp.assert_true(p_condition boolean,p_label text) returns void
language plpgsql as $$ begin if p_condition is not true then raise exception 'Assertion failed: %',p_label; end if; end; $$;
create function pg_temp.draft(p_group uuid,p_id uuid,p_kind text,p_data jsonb,p_version bigint default 0) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',gen_random_uuid(),'groupId',p_group,
  'entityId',p_id,'kind',p_kind,'expectedVersion',p_version,'data',p_data,'createdAt','2026-10-07T12:00:00.000Z'); $$;
create function pg_temp.command(p_group uuid,p_action jsonb,p_key uuid default gen_random_uuid(),p_revision bigint default null) returns jsonb
language sql as $$ select jsonb_build_object('apiVersion','v1','idempotencyKey',p_key,'groupId',p_group,
  'expectedRevision',coalesce(p_revision,(select revision from public.groups where id = p_group)),'action',p_action); $$;
create temporary table financial_contract_samples(label text,kind text,data jsonb);
grant all on financial_contract_samples to authenticated;

insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000901','finance-a@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-000000000902','finance-b@example.invalid','{}','{}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000901","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000901","app_metadata":{}}',true);

do $$ declare v_result jsonb; v_id uuid; v_pool_data jsonb; i integer; begin
  v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','group','{"name":"Finance A","statute":"Regras da versão um"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','financial fixture group');
  for i in 1..2 loop
    v_id := ('83000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001',v_id,'person',jsonb_build_object('name','Pessoa ' || i::text,'nickname','','adultDeclared',true)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','financial fixture person');
  end loop;
  v_pool_data := '{"title":"Bolão financeiro","lotteryId":"mega-sena","contestNumber":1,"deadlineAt":"2099-01-01T00:00:00.000Z","quotaPriceCents":"2500","participationMode":"internal","status":"draft"}';
  for i in 1..4 loop
    v_id := ('84000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001',v_id,'pool',
      case when i = 3 then jsonb_set(v_pool_data,'{deadlineAt}','null')
        when i = 4 then jsonb_set(v_pool_data,'{deadlineAt}','"2000-01-01T00:00:00.000Z"') else v_pool_data end));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','financial fixture pool');
    v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001',
      ('85000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'quota',jsonb_build_object('poolId',v_id,'personId','83000000-0000-4000-8000-000000000001','units',100)));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','financial fixture quota');
  end loop;
  for i in 1..4 loop
    v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001',
      ('86000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'payment-proposal',
      jsonb_build_object('poolId','84000000-0000-4000-8000-000000000001','personId','83000000-0000-4000-8000-000000000001',
        'amountCents',case when i = 2 then '4000' when i = 3 then '2500' else '1000' end,'note','','status','pending')));
    perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','financial fixture proposal');
  end loop;
  insert into financial_contract_samples values('empty complete snapshot','snapshot',public.finance_pull('81000000-0000-4000-8000-000000000001'));
end; $$;

do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_cmd jsonb; v_result jsonb; v_original jsonb; v_statute uuid; v_payment uuid; v_revision bigint; begin
  v_cmd := pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":1}');
  v_original := public.review_decide(v_cmd);
  perform pg_temp.assert_true(v_original ->> 'status' = 'accepted','statute publication accepted');
  perform pg_temp.assert_true(public.review_decide(v_cmd) = v_original,'financial retry returns original receipt');
  perform pg_temp.assert_true(public.finance_command_status((v_cmd ->> 'idempotencyKey')::uuid) = v_original,'financial lost reply status recovered');
  perform pg_temp.assert_true(public.review_decide(jsonb_set(v_cmd,'{action,groupVersion}','2')) ->> 'status' = 'rejected','financial same key different payload rejected');
  perform pg_temp.assert_true(public.finance_command_status((v_cmd ->> 'idempotencyKey')::uuid) = v_original,'financial key reuse leaves original receipt intact');
  insert into financial_contract_samples values('statute publication receipt','receipt',v_original);
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":1}',gen_random_uuid(),0));
  perform pg_temp.assert_true(v_result ->> 'status' = 'conflict' and v_result -> 'confirmedAt' = 'null','stale approval revision conflicts');
  insert into financial_contract_samples values('revision conflict receipt','receipt',v_result);
  select id into v_statute from public.statute_versions where group_id = v_group and version = 1;

  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000001','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%aceite%','quota requires recorded acceptance evidence');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','statute_accept','statuteId',v_statute,'personId','83000000-0000-4000-8000-000000000001','evidence','Aceite informado pelo organizador com referência à mensagem')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','evidence acceptance accepted');
  insert into financial_contract_samples values('acceptance receipt','receipt',v_result);
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000001","proposalVersion":2,"bankReference":null,"declaredReceivedAt":null,"allocations":[]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'conflict','stale proposal version conflicts');
  perform pg_temp.assert_true((select count(*) = 0 from public.received_payments),'conflict creates no received payment');
  v_cmd := pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000001","proposalVersion":1,"bankReference":"  Pix-A-1  ","declaredReceivedAt":"2026-10-07T12:00:00.000Z","allocations":[{"poolId":"84000000-0000-4000-8000-000000000001","amountCents":"1000"}]}');
  v_original := public.review_decide(v_cmd);
  perform pg_temp.assert_true(v_original ->> 'status' = 'accepted','partial received payment accepted');
  perform pg_temp.assert_true(public.review_decide(v_cmd) = v_original,'received payment idempotent');
  perform pg_temp.assert_true((select count(*) = 1 from public.received_payments),'no duplicate transfer');
  perform pg_temp.assert_true((select count(*) = 1 from public.financial_movements where kind = 'payment-received'),'one received movement per payment');
  perform pg_temp.assert_true((select bank_reference = 'Pix-A-1' from public.received_payments),'bank reference canonical trim');
  perform pg_temp.assert_true((select count(*) = 0 from public.confirmed_quotas),'receiving and allocating do not auto-confirm quota');
  insert into financial_contract_samples values('partial receipt','receipt',v_original);
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000001';
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000001','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%integral%','partial payment does not activate quota');
  insert into financial_contract_samples values('partial quota rejection','receipt',v_result);
  select revision into v_revision from public.groups where id = v_group;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_allocate','paymentId',v_payment,'poolId','84000000-0000-4000-8000-000000000002','amountCents','1')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','cannot overallocate an exhausted transfer');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'over-allocation leaves revision unchanged');
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000004","proposalVersion":1,"bankReference":"Pix-A-1","declaredReceivedAt":null,"allocations":[]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%referência bancária%','duplicate bank transfer rejected in group');
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000002","proposalVersion":1,"bankReference":null,"declaredReceivedAt":null,"allocations":[{"poolId":"84000000-0000-4000-8000-000000000001","amountCents":"4001"}]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','confirmation cannot allocate more than received');
  perform pg_temp.assert_true((select count(*) = 1 from public.received_payments),'invalid confirmation creates no financial facts');

  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000002","proposalVersion":1,"bankReference":"Pix-A-2","declaredReceivedAt":null,"allocations":[{"poolId":"84000000-0000-4000-8000-000000000001","amountCents":"1500"},{"poolId":"84000000-0000-4000-8000-000000000002","amountCents":"1000"}]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','one transfer allocates to multiple pools');
  insert into financial_contract_samples values('multiple allocations receipt','receipt',v_result);
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000002';
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_allocate','paymentId',v_payment,'poolId','84000000-0000-4000-8000-000000000002','amountCents','1500')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','remaining transfer allocated later');
  perform pg_temp.assert_true((select sum(amount_cents) = 5000 from public.financial_movements where kind = 'payment-received'),'allocation never doubles group cash');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000001','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','fully funded accepted adult quota confirmed online');
  perform pg_temp.assert_true((select due_cents = 2500 and units = 100 from public.confirmed_quotas),'confirmed due and units frozen');
  insert into financial_contract_samples values('confirmed first quota receipt','receipt',v_result);
  select revision into v_revision from public.groups where id = v_group;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000001','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','same funding cannot activate two quotas for same person and pool');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'duplicate quota does not advance revision');
end; $$;

-- Protect the actual source records, preserving edits that do not transfer economic rights.
do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_data jsonb; v_result jsonb; v_revision bigint; begin
  select revision into v_revision from public.groups where id = v_group;
  select data into v_data from public.draft_records where id = '86000000-0000-4000-8000-000000000001';
  v_result := public.sync_push(pg_temp.draft(v_group,'86000000-0000-4000-8000-000000000001','payment-proposal',jsonb_set(v_data,'{personId}','"83000000-0000-4000-8000-000000000002"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','received proposal cannot transfer payer');
  select data into v_data from public.draft_records where id = '85000000-0000-4000-8000-000000000001';
  v_result := public.sync_push(pg_temp.draft(v_group,'85000000-0000-4000-8000-000000000001','quota',jsonb_set(v_data,'{units}','200'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','active quota cannot rewrite rights');
  select data into v_data from public.draft_records where id = '84000000-0000-4000-8000-000000000001';
  v_result := public.sync_push(pg_temp.draft(v_group,'84000000-0000-4000-8000-000000000001','pool',jsonb_set(v_data,'{quotaPriceCents}','"3000"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','active quota freezes pool price');
  v_result := public.sync_push(pg_temp.draft(v_group,'84000000-0000-4000-8000-000000000001','pool',jsonb_set(v_data,'{participationMode}','"official"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','active quota freezes participation mode');
  v_result := public.sync_push(pg_temp.draft(v_group,'84000000-0000-4000-8000-000000000001','pool',jsonb_set(v_data,'{deadlineAt}','"2100-01-01T00:00:00.000Z"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','active quota freezes deadline');
  select data into v_data from public.draft_records where id = '83000000-0000-4000-8000-000000000001';
  v_result := public.sync_push(pg_temp.draft(v_group,'83000000-0000-4000-8000-000000000001','person',jsonb_set(v_data,'{adultDeclared}','false'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','active quota preserves adulthood');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'frozen draft rejections leave group and financial state unchanged');
  insert into financial_contract_samples values('frozen draft snapshot','snapshot',public.finance_pull(v_group));
end; $$;

do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_result jsonb; v_old_statute uuid; v_new_statute uuid; v_data jsonb; begin
  select id into v_old_statute from public.statute_versions where group_id = v_group and version = 1;
  select data into v_data from public.draft_records where group_id = v_group and id = v_group;
  v_result := public.sync_push(pg_temp.draft(v_group,v_group,'group',jsonb_set(v_data,'{statute}','"Regras da versão dois"'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','new draft statute does not rewrite old published rules');
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":1}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'conflict','publication requires current source group version');
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"statute_publish","groupVersion":2}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','new statute published as immutable next version');
  perform pg_temp.assert_true((select text = 'Regras da versão um' from public.statute_versions where id = v_old_statute),'old statute unchanged');
  select id into v_new_statute from public.statute_versions where group_id = v_group and version = 2;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000002','quotaVersion',1,'statuteId',v_old_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','new quota cannot use outdated statute');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','statute_accept','statuteId',v_new_statute,'personId','83000000-0000-4000-8000-000000000001','evidence','Aceite da nova regra informado')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','new statute requires new acceptance');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000002','quotaVersion',1,'statuteId',v_new_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','second pool quota confirmed under new statute');
  perform pg_temp.assert_true((select statute_id = v_old_statute from public.confirmed_quotas where pool_id = '84000000-0000-4000-8000-000000000001'),'previous quota retains frozen statute');
  insert into financial_contract_samples values('two statute versions snapshot','snapshot',public.finance_pull(v_group));
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000003','quotaVersion',1,'statuteId',v_new_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%prazo%','quota cannot be confirmed without a deadline');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000004','quotaVersion',1,'statuteId',v_new_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%integral%','a past deadline is not the reason to refuse; the unfunded quota still is');
end; $$;

-- A locked state is a test-admin fixture; no pool_lock endpoint is claimed here.
reset role;
update public.draft_records set data = jsonb_set(data,'{status}','"locked"') where id = '84000000-0000-4000-8000-000000000002';
do $$ begin
  begin update public.draft_records set data = jsonb_set(data,'{amountCents}','"5000"') where id = '86000000-0000-4000-8000-000000000001'; raise exception 'received proposal rewrite accepted';
  exception when check_violation then null; end;
  begin update public.statute_versions set text = 'rewrite'; raise exception 'published statute rewrite accepted';
  exception when insufficient_privilege then null; end;
  begin delete from public.financial_movements; raise exception 'financial movement deletion accepted';
  exception when insufficient_privilege then null; end;
  begin update public.financial_command_receipts set response_payload = '{}'; raise exception 'receipt rewrite accepted';
  exception when insufficient_privilege then null; end;
end; $$;
set local role authenticated;
do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_payment uuid; v_result jsonb; v_revision bigint; begin
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000002';
  select revision into v_revision from public.groups where id = v_group;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_reverse','paymentId',v_payment,'reason','Correção do lançamento')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%rascunho%','reversal blocked after allocated pool locked');
  perform pg_temp.assert_true((select count(*) = 0 from public.quota_revocations),'locked rejection revokes no rights');
  perform pg_temp.assert_true((select revision = v_revision from public.groups where id = v_group),'locked reversal writes no revision');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000002','quotaVersion',1,'statuteId',(select id from public.statute_versions where group_id = v_group and version = 2))));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%rascunho%','a quota on a locked pool is refused');
end; $$;
reset role;
alter table public.draft_records disable trigger financial_drafts_guard;
update public.draft_records set data = jsonb_set(data,'{status}','"draft"') where id = '84000000-0000-4000-8000-000000000002';
alter table public.draft_records enable trigger financial_drafts_guard;
set local role authenticated;

do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_payment uuid; v_result jsonb; v_statute uuid; v_cmd jsonb; begin
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000001';
  v_cmd := pg_temp.command(v_group,jsonb_build_object('type','payment_reverse','paymentId',v_payment,'reason','Estorno integral da primeira transferência'));
  v_result := public.review_decide(v_cmd);
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','integral reversal accepted');
  perform pg_temp.assert_true(public.review_decide(v_cmd) = v_result,'reversal itself is idempotent');
  perform pg_temp.assert_true((select amount_cents = -1000 from public.financial_movements where payment_id = v_payment and kind = 'payment-reversed'),'full negative payment counter');
  perform pg_temp.assert_true((select count(*) = 1 from public.quota_revocations),'only insufficiently funded quota revoked');
  perform pg_temp.assert_true((select q.pool_id = '84000000-0000-4000-8000-000000000001' from public.quota_revocations r join public.confirmed_quotas q on q.id = r.quota_id),'other fully funded pool retains rights');
  insert into financial_contract_samples values('first reversal receipt','receipt',v_result);
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_allocate','paymentId',v_payment,'poolId','84000000-0000-4000-8000-000000000001','amountCents','1')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','cannot allocate after reversal');
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000002';
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','payment_reverse','paymentId',v_payment,'reason','Estorno integral das três alocações')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','multiple allocations reversed together');
  perform pg_temp.assert_true((select count(*) = 3 from public.financial_movements where payment_id = v_payment and kind = 'allocation-reversed'),'every allocation compensated exactly once');
  perform pg_temp.assert_true((select sum(amount_cents) = 0 from public.financial_movements),'all cash and reservations reconcile after full reversals');
  perform pg_temp.assert_true((select count(*) = 2 from public.quota_revocations),'both original quotas now revoked');
  insert into financial_contract_samples values('all allocations reversal receipt','receipt',v_result);
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000003","proposalVersion":1,"bankReference":"Pix-A-3","declaredReceivedAt":null,"allocations":[{"poolId":"84000000-0000-4000-8000-000000000001","amountCents":"2500"}]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','new transfer funds revoked source quota again');
  perform pg_temp.assert_true((select count(*) = 2 from public.confirmed_quotas),'refunding does not auto-confirm rights');
  select id into v_statute from public.statute_versions where group_id = v_group order by version desc limit 1;
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000001','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','human can reconfirm after revocation with current funding');
  perform pg_temp.assert_true((select count(*) = 3 from public.confirmed_quotas),'reconfirmation preserves historical quota facts');
  insert into financial_contract_samples values('reconfirmed quota receipt','receipt',v_result);
end; $$;

do $$ declare v_group uuid := '81000000-0000-4000-8000-000000000001'; v_result jsonb; v_statute uuid; v_data jsonb; v_payment uuid; begin
  select id into v_statute from public.statute_versions where group_id = v_group order by version desc limit 1;
  v_result := public.sync_push(pg_temp.draft(v_group,'85000000-0000-4000-8000-000000000005','quota','{"poolId":"84000000-0000-4000-8000-000000000001","personId":"83000000-0000-4000-8000-000000000002","units":100}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','second person quota draft');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','statute_accept','statuteId',v_statute,'personId','83000000-0000-4000-8000-000000000002','evidence','Aceite informado da segunda pessoa')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','second person accepts current statute');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000005','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%integral%','another payer funding cannot activate person quota');
  select data into v_data from public.draft_records where id = '83000000-0000-4000-8000-000000000002';
  v_result := public.sync_push(pg_temp.draft(v_group,'83000000-0000-4000-8000-000000000002','person',jsonb_set(v_data,'{adultDeclared}','false'),1));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','unconfirmed person can correct declaration');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000005','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected' and v_result ->> 'message' like '%maioridade%','server rechecks current adulthood at confirmation');
  v_result := public.sync_push(pg_temp.draft(v_group,'86000000-0000-4000-8000-000000000005','payment-proposal','{"poolId":"84000000-0000-4000-8000-000000000004","personId":"83000000-0000-4000-8000-000000000001","amountCents":"2500","note":"Tardio","status":"pending"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','late proposal drafted');
  v_result := public.review_decide(pg_temp.command(v_group,'{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000005","proposalVersion":1,"bankReference":"Pix-late","declaredReceivedAt":"1999-01-01T00:00:00.000Z","allocations":[{"poolId":"84000000-0000-4000-8000-000000000004","amountCents":"2500"}]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','late payment can be received and allocated');
  v_result := public.review_decide(pg_temp.command(v_group,jsonb_build_object('type','quota_confirm','quotaId','85000000-0000-4000-8000-000000000004','quotaVersion',1,'statuteId',v_statute)));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted' and exists (select 1 from public.confirmed_quotas where source_quota_id = '85000000-0000-4000-8000-000000000004'),'quota funded after the deadline is confirmed while the pool is a draft');
  insert into financial_contract_samples values('late payment current snapshot','snapshot',public.finance_pull(v_group));
  begin insert into public.financial_movements(id,group_id,payment_id,person_id,kind,amount_cents,reason,created_at,receipt_id)
    values(gen_random_uuid(),v_group,gen_random_uuid(),'83000000-0000-4000-8000-000000000001','payment-received',1000,'',now(),gen_random_uuid()); raise exception 'direct browser ledger insert accepted';
  exception when insufficient_privilege then null; end;
end; $$;

-- An unrelated organizer cannot read finance, recover receipts or allocate another group's payment.
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000902","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000902","app_metadata":{}}',true);
do $$ declare v_result jsonb; begin
  perform pg_temp.assert_true((select count(*) = 0 from public.received_payments),'unrelated account sees no payments');
  perform pg_temp.assert_true((select count(*) = 0 from public.financial_command_receipts),'unrelated account sees no financial receipts');
  begin perform public.finance_pull('81000000-0000-4000-8000-000000000001'); raise exception 'cross-group finance pull accepted'; exception when insufficient_privilege then null; end;
  begin perform public.review_decide(pg_temp.command('81000000-0000-4000-8000-000000000001','{"type":"statute_publish","groupVersion":2}',gen_random_uuid(),0)); raise exception 'cross-group financial decision accepted'; exception when insufficient_privilege then null; end;
  v_result := public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000002','group','{"name":"Finance B","statute":"Regras B"}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','other group fixture');
  perform public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000002','83000000-0000-4000-8000-000000000010','person','{"name":"Pessoa B","nickname":"","adultDeclared":true}'));
  perform public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000010','pool','{"title":"Bolão B","lotteryId":"mega-sena","contestNumber":1,"deadlineAt":"2099-01-01T00:00:00.000Z","quotaPriceCents":"2500","participationMode":"internal","status":"draft"}'));
  perform public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000002','86000000-0000-4000-8000-000000000010','payment-proposal','{"poolId":"84000000-0000-4000-8000-000000000010","personId":"83000000-0000-4000-8000-000000000010","amountCents":"2500","note":"","status":"pending"}'));
  v_result := public.review_decide(pg_temp.command('81000000-0000-4000-8000-000000000002','{"type":"payment_confirm","proposalId":"86000000-0000-4000-8000-000000000010","proposalVersion":1,"bankReference":"Pix-A-1","declaredReceivedAt":null,"allocations":[]}'));
  perform pg_temp.assert_true(v_result ->> 'status' = 'accepted','bank-reference uniqueness scoped by group');
  insert into financial_contract_samples values('other group receipt','receipt',v_result);
end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000901","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000901","app_metadata":{}}',true);
do $$ declare v_result jsonb; v_payment uuid; begin
  select id into v_payment from public.received_payments where source_proposal_id = '86000000-0000-4000-8000-000000000003';
  v_result := public.review_decide(pg_temp.command('81000000-0000-4000-8000-000000000001',jsonb_build_object('type','payment_allocate','paymentId',v_payment,'poolId','84000000-0000-4000-8000-000000000010','amountCents','1')));
  perform pg_temp.assert_true(v_result ->> 'status' = 'rejected','allocation cannot reference another group pool');
  perform pg_temp.assert_true((select bool_and(event_hash = encode(sha256(convert_to(previous_hash || event::text,'UTF8')),'hex')) from public.audit_events),'financial and draft audit hashes verify');
  perform pg_temp.assert_true((select bool_and(previous_hash = coalesce(prior_hash,repeat('0',64))) from
    (select previous_hash,lag(event_hash) over (order by revision) prior_hash from public.audit_events) chain),'shared audit chain continuous');
  perform pg_temp.assert_true((select g.revision = (select count(*) from public.group_changes c where c.group_id = g.id) from public.groups g where id = '81000000-0000-4000-8000-000000000001'),'financial markers preserve complete revision cursor');
  perform pg_temp.assert_true((select version = 2 from public.draft_records where id = '81000000-0000-4000-8000-000000000001'),'financial markers do not increment draft group entity version');
end; $$;
-- A JWT issued while the account was human cannot bypass a later server-side agent classification.
reset role;
update auth.users set raw_app_meta_data = '{"actor_type":"agent"}' where id = '00000000-0000-4000-8000-000000000901';
set local role authenticated;
do $$ begin
  perform pg_temp.assert_true(private.is_human_session() is false,'current account classification overrides old human JWT');
  perform pg_temp.assert_true((select count(*) = 0 from public.financial_movements),'reclassified account loses ledger visibility with old JWT');
  begin perform public.review_decide('{"apiVersion":"v1","idempotencyKey":"90000000-0000-4000-8000-000000000998","groupId":"81000000-0000-4000-8000-000000000001","expectedRevision":0,"action":{"type":"statute_publish","groupVersion":2}}');
    raise exception 'reclassified account financial approval accepted'; exception when insufficient_privilege then null; end;
  begin perform public.sync_push(pg_temp.draft('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','group','{"name":"Alteração indevida","statute":""}',2));
    raise exception 'reclassified account draft write accepted'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
update auth.users set raw_app_meta_data = '{}' where id = '00000000-0000-4000-8000-000000000901';
set local role authenticated;
do $$ begin perform pg_temp.assert_true(private.is_human_session(),'human access restored only by trusted account metadata'); end; $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000901","role":"authenticated","session_id":"00000000-0000-4000-8000-100000000901","client_id":"90000000-0000-4000-8000-000000000901","app_metadata":{}}',true);
do $$ begin
  perform pg_temp.assert_true((select count(*) = 0 from public.financial_movements),'OAuth agent cannot read private ledger');
  begin perform public.finance_pull('81000000-0000-4000-8000-000000000001'); raise exception 'agent financial pull accepted'; exception when insufficient_privilege then null; end;
  begin perform public.review_decide('{"apiVersion":"v1","idempotencyKey":"90000000-0000-4000-8000-000000000999","groupId":"81000000-0000-4000-8000-000000000001","expectedRevision":0,"action":{"type":"statute_publish","groupVersion":2}}'); raise exception 'agent self-approval accepted'; exception when insufficient_privilege then null; end;
end; $$;
set local role anon;
do $$ begin
  begin perform public.finance_pull('81000000-0000-4000-8000-000000000001'); raise exception 'anonymous financial read accepted'; exception when insufficient_privilege then null; end;
  begin perform public.review_decide('{}'); raise exception 'anonymous financial write accepted'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
-- Returned samples are also validated against the actual TypeScript financial core by the runner.
select label,kind,data from financial_contract_samples order by label;
rollback;
