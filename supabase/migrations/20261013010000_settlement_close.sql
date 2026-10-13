-- Closing and reopening a pool, mirroring the core's checkAction/buildFact for pool_settle and pool_reopen.
-- Earlier migrations stay immutable: the shape and guard checks wrap their previous bodies, and the decision is replaced whole.
alter function private.settlement_action_error(jsonb) rename to settlement_action_error_base;
create function private.settlement_action_error(p_action jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_common text[] := array['type','poolId','poolVersion'];
begin
  if (p_action ->> 'type' in ('pool_settle','pool_reopen')) is not true then return private.settlement_action_error_base(p_action); end if;
  if not private.json_uuid(p_action -> 'poolId') or not private.json_integer(p_action -> 'poolVersion',1,9007199254740991) then return 'Informe bolão e versão observada da decisão.'; end if;
  if p_action ->> 'type' = 'pool_settle' then
    if private.exact_keys(p_action,v_common || array['registrationReportId','prizeConfirmationId','expenseConfirmationId','leftoverDisposition','pendingExplanation','reason']) is not true
      or not private.json_uuid(p_action -> 'registrationReportId')
      or not (p_action -> 'prizeConfirmationId' = 'null'::jsonb or private.json_uuid(p_action -> 'prizeConfirmationId'))
      or not (p_action -> 'expenseConfirmationId' = 'null'::jsonb or private.json_uuid(p_action -> 'expenseConfirmationId'))
      or (p_action ->> 'leftoverDisposition' in ('group-reserve','pending-refund') and jsonb_typeof(p_action -> 'leftoverDisposition') = 'string') is not true
      or not private.settlement_text(p_action -> 'pendingExplanation',false) or not private.settlement_text(p_action -> 'reason',true) then return 'Encerramento do bolão inválido.'; end if;
  elsif private.exact_keys(p_action,v_common || array['closureId','reason']) is not true
    or not private.json_uuid(p_action -> 'closureId') or not private.settlement_text(p_action -> 'reason',true) then return 'Reabertura do bolão inválida.';
  end if;
  return null;
end;
$$;

-- checkAction for pool_settle/pool_reopen: same preamble as the other actions, then the closure rules; messages are the core's.
alter function private.settlement_action_guard(uuid,jsonb,timestamptz) rename to settlement_action_guard_base;
create function private.settlement_action_guard(p_group uuid,p_action jsonb,p_now timestamptz) returns text
language plpgsql stable set search_path = '' as $$
declare v_type text := p_action ->> 'type'; v_pool uuid := (p_action ->> 'poolId')::uuid; v_pool_version numeric := (p_action ->> 'poolVersion')::numeric;
  v_report public.registration_reports; v_expense public.settlement_expenses; v_prize public.settlement_prizes; v_closure public.settlement_closures; v_balance jsonb;
begin
  if v_type not in ('pool_settle','pool_reopen') then return private.settlement_action_guard_base(p_group,p_action,p_now); end if;
  if not exists (select 1 from public.pool_manifests where group_id = p_group and pool_id = v_pool) then return 'Apuração exige manifesto confirmado.'; end if;
  v_balance := private.settlement_pool_balance(p_group,v_pool);
  if v_balance is null then return 'O rateio do manifesto exige uma única cota por pessoa.'; end if;
  select * into v_report from public.registration_reports where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if v_report.id is null or date_trunc('milliseconds',v_report.confirmed_at) > p_now or v_report.pool_version >= v_pool_version then
    return 'Apuração exige registro humano já confirmado e versão atual observada do bolão.';
  end if;
  if exists (select 1 from (select pool_version,confirmed_at from public.settlement_expenses where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_prizes where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_redemptions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_distributions where group_id = p_group and pool_id = v_pool
      union all select pool_version,confirmed_at from public.settlement_closures where group_id = p_group and pool_id = v_pool) f
    where f.pool_version >= v_pool_version or date_trunc('milliseconds',f.confirmed_at) > p_now) then
    return 'Versão observada precisa avançar decisões anteriores deste bolão.';
  end if;
  select * into v_closure from public.settlement_closures where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if v_type = 'pool_reopen' then
    if not (v_balance ->> 'closed')::boolean or v_closure.id is distinct from (p_action ->> 'closureId')::uuid then
      return 'Reabertura exige o encerramento ativo observado.';
    end if;
    return null;
  end if;
  if (v_balance ->> 'closed')::boolean then return 'Bolão encerrado exige reabertura humana antes de nova alteração financeira.'; end if;
  select * into v_expense from public.settlement_expenses where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  select * into v_prize from public.settlement_prizes where group_id = p_group and pool_id = v_pool order by version desc limit 1;
  if (p_action ->> 'registrationReportId')::uuid <> v_report.id or (p_action ->> 'prizeConfirmationId')::uuid is distinct from v_prize.id
    or (p_action ->> 'expenseConfirmationId')::uuid is distinct from v_expense.id then
    return 'Encerramento exige as versões atuais de registro, despesas e prêmio.';
  end if;
  -- pending(pool): any open item keeps the closure explained.
  if ((v_balance ->> 'expenseConfirmationPending')::boolean or v_balance -> 'confirmedPrizeCents' = 'null'::jsonb
      or coalesce((v_balance ->> 'resultConflict')::boolean,false) or (v_balance ->> 'registrationIncomplete')::boolean
      or exists (select 1 from unnest(array['cashDeficitCents','unredeemedPrizeCents','unpaidPrizeCents','refundPendingCents']) k
        where v_balance ->> k is not null and (v_balance ->> k)::numeric <> 0))
    and private.js_trim(p_action ->> 'pendingExplanation') = '' then
    return 'Pendências, reserva, prêmio ausente ou despesa desconhecida precisam permanecer explicados.';
  end if;
  return null;
end;
$$;

-- The decision as before, without the release block and with the closure fact (buildFact: reconciliation is the balance just before it).
create or replace function public.settlement_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid(); v_fact_id uuid := gen_random_uuid();
  v_saved public.settlement_command_receipts; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_redemption public.settlement_redemptions; v_distribution public.settlement_distributions; v_action jsonb; v_type text; v_rights jsonb; v_current jsonb;
  v_error text; v_status text := 'accepted'; v_revision bigint; v_version bigint; v_now timestamptz; v_result jsonb; v_count bigint;
  v_closure public.settlement_closures; v_reconciliation jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_settlement_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action'; v_type := v_action ->> 'type';
  perform pg_advisory_xact_lock(hashtextextended('settlement:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.settlement_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de decidir a apuração.';
  elsif v_revision >= 9007199254740991 then v_error := 'Limite de revisão atingido.';
  else v_error := private.settlement_action_error(v_action); end if;
  v_now := date_trunc('milliseconds',clock_timestamp());
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a decisão.';
    elsif v_pool.version >= 9007199254740991 then v_error := 'Limite de versões do bolão atingido.';
    else
      v_count := case when v_type = 'expense_confirm' then (select count(*) from public.settlement_expenses where group_id = v_group)
        when v_type = 'prize_confirm' then (select count(*) from public.settlement_prizes where group_id = v_group)
        when v_type like 'redemption_%' then (select count(*) from public.settlement_redemptions where group_id = v_group)
        when v_type like 'pool_%' then (select count(*) from public.settlement_closures where group_id = v_group)
        else (select count(*) from public.settlement_distributions where group_id = v_group) end;
      if v_count >= 10000 then v_error := 'Limite de fatos de apuração atingido.';
      else v_error := private.settlement_action_guard(v_group,v_action,v_now); end if;
    end if;
  end if;
  if v_error is null then
    -- The fact and the entity version change roll back together when the resulting balance would not reconcile.
    begin
      select * into v_manifest from public.pool_manifests where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      select * into v_report from public.registration_reports where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      if v_type = 'expense_confirm' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_expenses where group_id = v_group and pool_id = v_pool_id;
        insert into public.settlement_expenses(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,manifest_id,registration_report_id,supersedes_id,
          bet_cost_cents,fee_cents,total_cost_cents,evidence_ids,source_reference,reason)
          values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_manifest.id,(v_action ->> 'registrationReportId')::uuid,
            (v_action ->> 'supersedesId')::uuid,(v_action ->> 'betCostCents')::bigint,(v_action ->> 'feeCents')::bigint,
            (v_action ->> 'betCostCents')::bigint + (v_action ->> 'feeCents')::bigint,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',v_action ->> 'reason');
      elsif v_type = 'prize_confirm' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_prizes where group_id = v_group and pool_id = v_pool_id;
        v_current := private.settlement_current_result(v_group,v_pool_id);
        v_rights := private.settlement_prize_rights(v_manifest.content,v_report.items,(v_action ->> 'amountCents')::numeric,v_action -> 'officialEntitlements');
        insert into public.settlement_prizes(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,manifest_id,registration_report_id,result_id,
          observed_result_ids,result_selection_id,supersedes_id,calculated_prize_cents,amount_cents,official_entitlements,rights,evidence_ids,source_reference,reason,redemption_deadline)
          values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_manifest.id,(v_action ->> 'registrationReportId')::uuid,(v_action ->> 'resultId')::uuid,
            (select coalesce(jsonb_agg(to_jsonb(r.id::text) order by r.version),'[]'::jsonb) from public.contest_result_versions r where r.group_id = v_group and r.pool_id = v_pool_id),
            (select s.id from public.result_selections s where s.group_id = v_group and s.pool_id = v_pool_id order by s.version desc limit 1),
            (v_action ->> 'supersedesId')::uuid,private.settlement_calculated_prize(v_report.items,v_current),(v_action ->> 'amountCents')::bigint,
            private.settlement_entitlements(v_action -> 'officialEntitlements'),v_rights -> 'rights',private.settlement_ids(v_action -> 'evidenceIds'),
            v_action ->> 'sourceReference',v_action ->> 'reason',nullif(v_action -> 'redemptionDeadline','null'::jsonb));
      elsif v_type like 'redemption_%' then
        select coalesce(max(version),0)+1 into v_version from public.settlement_redemptions where group_id = v_group and pool_id = v_pool_id;
        if v_type = 'redemption_record' then
          insert into public.settlement_redemptions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,prize_confirmation_id,person_id,ownership,
            direction,reverses_id,amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,(v_action ->> 'prizeConfirmationId')::uuid,(v_action ->> 'personId')::uuid,
              case when v_manifest.content -> 'plan' ->> 'participationMode' = 'internal' then 'organizer' else 'individual' end,'received',null,(v_action ->> 'amountCents')::bigint,
              private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        else
          select * into v_redemption from public.settlement_redemptions where group_id = v_group and id = (v_action ->> 'redemptionId')::uuid;
          insert into public.settlement_redemptions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,prize_confirmation_id,person_id,ownership,
            direction,reverses_id,amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_redemption.prize_confirmation_id,v_redemption.person_id,v_redemption.ownership,
              'reversed',v_redemption.id,-v_redemption.amount_cents,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',
              (v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        end if;
      elsif v_type like 'pool_%' then
        select * into v_closure from public.settlement_closures where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
        v_reconciliation := private.settlement_pool_balance(v_group,v_pool_id);
        insert into public.settlement_closures(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,direction,previous_closure_id,
          registration_report_id,prize_confirmation_id,expense_confirmation_id,observed_result_ids,result_selection_id,leftover_disposition,reconciliation,
          pending_explanation,reason)
          values(v_fact_id,v_group,v_pool_id,coalesce(v_closure.version,0)+1,v_revision+1,v_pool.version,v_now,v_receipt,
            case when v_type = 'pool_settle' then 'closed' else 'reopened' end,v_closure.id,v_report.id,
            (select id from public.settlement_prizes where group_id = v_group and pool_id = v_pool_id order by version desc limit 1),
            (select id from public.settlement_expenses where group_id = v_group and pool_id = v_pool_id order by version desc limit 1),
            (select coalesce(jsonb_agg(to_jsonb(r.id::text) order by r.version),'[]'::jsonb) from public.contest_result_versions r where r.group_id = v_group and r.pool_id = v_pool_id),
            (select s.id from public.result_selections s where s.group_id = v_group and s.pool_id = v_pool_id order by s.version desc limit 1),
            case when v_type = 'pool_settle' then v_action ->> 'leftoverDisposition' else v_closure.leftover_disposition end,
            v_reconciliation,
            case when v_type = 'pool_settle' then v_action ->> 'pendingExplanation' else v_closure.pending_explanation end,v_action ->> 'reason');
        v_version := coalesce(v_closure.version,0)+1;
      else
        select coalesce(max(version),0)+1 into v_version from public.settlement_distributions where group_id = v_group and pool_id = v_pool_id;
        if v_type = 'distribution_record' then
          insert into public.settlement_distributions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,person_id,kind,direction,reverses_id,
            amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,(v_action ->> 'personId')::uuid,v_action ->> 'kind','paid',null,
              (v_action ->> 'amountCents')::bigint,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        else
          select * into v_distribution from public.settlement_distributions where group_id = v_group and id = (v_action ->> 'distributionId')::uuid;
          insert into public.settlement_distributions(id,group_id,pool_id,version,group_revision,pool_version,confirmed_at,receipt_id,person_id,kind,direction,reverses_id,
            amount_cents,evidence_ids,source_reference,event_at,reason)
            values(v_fact_id,v_group,v_pool_id,v_version,v_revision+1,v_pool.version,v_now,v_receipt,v_distribution.person_id,v_distribution.kind,'returned',v_distribution.id,
              -v_distribution.amount_cents,private.settlement_ids(v_action -> 'evidenceIds'),v_action ->> 'sourceReference',(v_action ->> 'eventAt')::timestamptz,v_action ->> 'reason');
        end if;
      end if;
      -- Each settlement fact observes and advances the pool version, as registration does.
      update public.draft_records set version = version+1,updated_at = v_now where group_id = v_group and id = v_pool_id;
      v_error := private.settlement_balance_error(v_group,v_pool_id);
      if v_error is not null then raise exception 'settlement_balance_rejected'; end if;
    exception when raise_exception then
      if v_error is null then raise; end if;
    end;
  end if;
  if v_error is null then
    v_version := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,v_type,jsonb_build_object('receiptId',v_receipt,'factId',v_fact_id,'version',v_version));
    if v_version <> v_revision+1 then raise exception 'settlement_revision_mismatch' using errcode = '40001'; end if;
    v_revision := v_version;
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
    'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
    'snapshot',private.settlement_snapshot(v_group));
  insert into public.settlement_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,v_result,v_now);
  return v_result;
end;
$$;


revoke all on function private.settlement_action_error(jsonb),private.settlement_action_error_base(jsonb),
  private.settlement_action_guard(uuid,jsonb,timestamptz),private.settlement_action_guard_base(uuid,jsonb,timestamptz) from public,anon,authenticated;
