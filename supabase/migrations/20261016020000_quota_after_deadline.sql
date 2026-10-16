-- Owner's rule of 15/10: a quota is accepted while there is still time to make the games for the draw, so the agreed
-- deadline (deadlineAt) no longer refuses a quota confirmation, a plan application or a pool lock. The real cut is the lock:
-- a quota can only be confirmed on a pool that is still a draft. A pool still needs a deadline set before a quota is
-- confirmed or a plan applied (those checks stay), the manifest still freezes deadlineAt, and deadlineAt stays frozen while an
-- active confirmed quota exists.
-- Re-created from their last definitions with only the "clock >= deadlineAt" rejections removed:
--   private.financial_decide_base   from 20261007010000_financial.sql (public.review_decide, renamed in 20261008000000_planning.sql):
--     the late-quota refusal and the "deadline ended during the review" refusal of quota_confirm;
--   private.current_plan_error      from 20261008000000_planning.sql: the plan_apply/pool_lock refusal after the deadline and the
--     refusal of rights whose quota was confirmed after it;
--   public.planning_decide          from 20261008000000_planning.sql: the "deadline ended during the review" refusal.
-- create or replace keeps the existing grants.
create or replace function private.financial_decide_base(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_key uuid; v_group_id uuid; v_receipt_id uuid := gen_random_uuid();
  v_saved public.financial_command_receipts; v_group public.groups; v_group_record public.draft_records;
  v_proposal public.draft_records; v_pool public.draft_records; v_person public.draft_records; v_quota public.draft_records;
  v_payment public.received_payments; v_statute public.statute_versions; v_allocation public.payment_allocations;
  v_action jsonb; v_item jsonb; v_type text; v_error text; v_status text := 'accepted';
  v_revision bigint; v_money numeric; v_allocated numeric; v_due numeric; v_bank text; v_payment_id uuid;
  v_statute_id uuid; v_allocation_id uuid; v_now timestamptz; v_result jsonb; v_event jsonb; v_previous_hash text;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 65536 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey')
    or not private.json_uuid(p_command -> 'groupId') or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991)
    then raise exception 'invalid_financial_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group_id := (p_command ->> 'groupId')::uuid;
  v_action := p_command -> 'action'; v_type := v_action ->> 'type';
  perform pg_advisory_xact_lock(hashtextextended('finance:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.financial_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'groupId',v_group_id,'status','rejected',
      'groupRevision',0,'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text,0));
  select * into v_group from public.groups where id = v_group_id for update;
  if not found or not private.can_manage_group(v_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  v_revision := v_group.revision; v_now := clock_timestamp();
  v_error := private.financial_action_error(v_action);
  if v_error is null and (p_command ->> 'expectedRevision')::numeric <> v_revision then
    v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize os dados e aprove novamente.';
  end if;
  select * into v_group_record from public.draft_records where group_id = v_group_id and id = v_group_id and kind = 'group';
  if v_error is null and not found then v_error := 'Sincronize o cadastro do grupo antes de confirmar operações.'; end if;
  if v_error is null and v_revision >= 9007199254740991 then v_error := 'Limite de revisão atingido.'; end if;

  if v_error is null then
    case v_type
    when 'statute_publish' then
      if v_group_record.version <> (v_action ->> 'groupVersion')::numeric then
        v_status := 'conflict'; v_error := 'A versão do grupo mudou; revise o texto do estatuto.';
      elsif not private.json_text(v_group_record.data -> 'statute',12000,true) or private.js_trim(v_group_record.data ->> 'statute') = '' then
        v_error := 'Escreva as regras do grupo antes de publicar o estatuto.';
      elsif exists (select 1 from public.statute_versions where group_id = v_group_id and source_group_version = v_group_record.version) then
        v_error := 'Esta versão do grupo já possui um estatuto publicado.';
      else
        select * into v_statute from public.statute_versions where group_id = v_group_id order by version desc limit 1;
        if found and v_statute.text = v_group_record.data ->> 'statute' then v_error := 'O texto atual do estatuto já foi publicado.'; end if;
      end if;
    when 'statute_accept' then
      select * into v_statute from public.statute_versions where group_id = v_group_id and id = (v_action ->> 'statuteId')::uuid;
      if not found then v_error := 'Estatuto não encontrado neste grupo.'; end if;
      select * into v_person from public.draft_records where group_id = v_group_id and id = (v_action ->> 'personId')::uuid and kind = 'person';
      if v_error is null and not found then v_error := 'Pessoa não encontrada neste grupo.'; end if;
      if v_error is null and exists (select 1 from public.statute_acceptances where group_id = v_group_id
        and statute_id = v_statute.id and person_id = v_person.id) then v_error := 'O aceite desta pessoa já foi registrado para esse estatuto.'; end if;
    when 'payment_confirm' then
      select * into v_proposal from public.draft_records where group_id = v_group_id and id = (v_action ->> 'proposalId')::uuid and kind = 'payment-proposal';
      if not found then v_error := 'Proposta de pagamento não encontrada neste grupo.';
      elsif v_proposal.version <> (v_action ->> 'proposalVersion')::numeric then v_status := 'conflict'; v_error := 'A proposta mudou; revise o recebimento.';
      elsif v_proposal.data ->> 'status' = 'rejected' then v_error := 'A proposta está rejeitada; revise-a antes de confirmar um recebimento.';
      elsif exists (select 1 from public.received_payments where group_id = v_group_id and source_proposal_id = v_proposal.id) then
        v_error := 'Esta proposta já gerou um recebimento.';
      end if;
      if v_error is null then
        select * into v_pool from public.draft_records where group_id = v_group_id and id = (v_proposal.data ->> 'poolId')::uuid and kind = 'pool';
        if not found or v_pool.data ->> 'status' <> 'draft' then v_error := 'O bolão de origem precisa estar em rascunho.'; end if;
        select * into v_person from public.draft_records where group_id = v_group_id and id = (v_proposal.data ->> 'personId')::uuid and kind = 'person';
        if v_error is null and not found then v_error := 'Pessoa não encontrada neste grupo.'; end if;
        v_bank := case when v_action -> 'bankReference' = 'null'::jsonb then null else private.js_trim(v_action ->> 'bankReference') end;
        if v_bank is not null and exists (select 1 from public.received_payments where group_id = v_group_id and bank_reference = v_bank) then
          v_error := 'Esta referência bancária já foi registrada neste grupo.';
        end if;
        v_money := (v_proposal.data ->> 'amountCents')::numeric;
        select coalesce(sum((value ->> 'amountCents')::numeric),0) into v_allocated from jsonb_array_elements(v_action -> 'allocations');
        if v_error is null and v_allocated > v_money then v_error := 'As alocações excedem o valor recebido.'; end if;
        for v_item in select value from jsonb_array_elements(v_action -> 'allocations') loop
          if not exists (select 1 from public.draft_records where group_id = v_group_id and id = (v_item ->> 'poolId')::uuid
            and kind = 'pool' and data ->> 'status' = 'draft') then v_error := 'Toda alocação precisa de um bolão em rascunho deste grupo.'; end if;
        end loop;
      end if;
    when 'payment_allocate' then
      select * into v_payment from public.received_payments where group_id = v_group_id and id = (v_action ->> 'paymentId')::uuid;
      if not found then v_error := 'Recebimento não encontrado neste grupo.';
      elsif exists (select 1 from public.financial_movements where payment_id = v_payment.id and kind = 'payment-reversed') then
        v_error := 'Um recebimento estornado não pode receber novas alocações.';
      end if;
      if v_error is null then
        select * into v_pool from public.draft_records where group_id = v_group_id and id = (v_action ->> 'poolId')::uuid and kind = 'pool';
        if not found or v_pool.data ->> 'status' <> 'draft' then v_error := 'O destino precisa ser um bolão em rascunho deste grupo.'; end if;
        select coalesce(sum(amount_cents),0) into v_allocated from public.financial_movements
          where group_id = v_group_id and payment_id = v_payment.id and kind in ('payment-allocated','allocation-reversed');
        if v_error is null and v_allocated + (v_action ->> 'amountCents')::numeric > v_payment.amount_cents then
          v_error := 'A alocação excede o saldo não alocado deste recebimento.';
        end if;
      end if;
    when 'payment_reverse' then
      select * into v_payment from public.received_payments where group_id = v_group_id and id = (v_action ->> 'paymentId')::uuid;
      if not found then v_error := 'Recebimento não encontrado neste grupo.';
      elsif exists (select 1 from public.financial_movements where payment_id = v_payment.id and kind = 'payment-reversed') then
        v_error := 'Este recebimento já foi estornado.';
      elsif exists (select 1 from public.payment_allocations a left join public.draft_records p on p.group_id = a.group_id and p.id = a.pool_id
        where a.group_id = v_group_id and a.payment_id = v_payment.id and (p.kind = 'pool' and p.data ->> 'status' = 'draft') is not true) then
        v_error := 'O estorno exige que todos os bolões com alocações ainda estejam em rascunho.';
      end if;
    when 'quota_confirm' then
      select * into v_quota from public.draft_records where group_id = v_group_id and id = (v_action ->> 'quotaId')::uuid and kind = 'quota';
      if not found then v_error := 'Cota de rascunho não encontrada neste grupo.';
      elsif v_quota.version <> (v_action ->> 'quotaVersion')::numeric then v_status := 'conflict'; v_error := 'A cota mudou; revise os direitos antes de confirmar.'; end if;
      if v_error is null then
        select * into v_pool from public.draft_records where group_id = v_group_id and id = (v_quota.data ->> 'poolId')::uuid and kind = 'pool';
        if not found or v_pool.data ->> 'status' <> 'draft' then v_error := 'A cota só pode ser confirmada em um bolão em rascunho.';
        elsif v_pool.data -> 'deadlineAt' = 'null'::jsonb then v_error := 'Defina o prazo do bolão antes de confirmar uma cota.'; end if;
        select * into v_person from public.draft_records where group_id = v_group_id and id = (v_quota.data ->> 'personId')::uuid and kind = 'person';
        if v_error is null and (not found or v_person.data -> 'adultDeclared' is distinct from 'true'::jsonb) then
          v_error := 'A pessoa precisa ter a declaração de maioridade registrada.';
        end if;
        select * into v_statute from public.statute_versions where group_id = v_group_id order by version desc limit 1;
        if v_error is null and (not found or v_statute.id <> (v_action ->> 'statuteId')::uuid) then
          v_error := 'A confirmação exige a versão atual do estatuto publicado.';
        end if;
        if v_error is null and not exists (select 1 from public.statute_acceptances where group_id = v_group_id and statute_id = v_statute.id and person_id = v_person.id) then
          v_error := 'Registre a evidência de aceite do estatuto atual antes de confirmar a cota.';
        end if;
        v_due := (v_pool.data ->> 'quotaPriceCents')::numeric * (v_quota.data ->> 'units')::numeric / 100;
        if v_error is null and (v_due <> trunc(v_due) or v_due not between 1 and 9007199254740991) then
          v_error := 'O custo da cota precisa ser um valor válido em centavos inteiros.';
        end if;
        if v_error is null and exists (select 1 from public.confirmed_quotas q where q.group_id = v_group_id
          and q.pool_id = v_pool.id and q.person_id = v_person.id and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
          v_error := 'Esta pessoa já possui uma cota confirmada ativa neste bolão.';
        end if;
        if v_error is null and private.person_pool_funding(v_group_id,v_person.id,v_pool.id) < v_due then
          v_error := 'A cota exige pagamento integral confirmado e alocado para esta pessoa neste bolão.';
        end if;
      end if;
    end case;
  end if;
  v_now := clock_timestamp();
  if v_error is not null and v_status = 'accepted' then v_status := 'rejected'; end if;

  if v_status = 'accepted' then
    case v_type
    when 'statute_publish' then
      v_statute_id := gen_random_uuid();
      insert into public.statute_versions(id,group_id,version,text,source_group_version,published_at,receipt_id)
        values(v_statute_id,v_group_id,coalesce(v_statute.version,0)+1,v_group_record.data ->> 'statute',v_group_record.version,v_now,v_receipt_id);
    when 'statute_accept' then
      insert into public.statute_acceptances(id,group_id,statute_id,person_id,evidence,accepted_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_statute.id,v_person.id,v_action ->> 'evidence',v_now,v_receipt_id);
    when 'payment_confirm' then
      v_payment_id := gen_random_uuid();
      insert into public.received_payments(id,group_id,person_id,source_proposal_id,source_proposal_version,amount_cents,bank_reference,declared_received_at,confirmed_at,receipt_id)
        values(v_payment_id,v_group_id,v_person.id,v_proposal.id,v_proposal.version,v_money::bigint,v_bank,(v_action ->> 'declaredReceivedAt')::timestamptz,v_now,v_receipt_id);
      insert into public.financial_movements(id,group_id,payment_id,person_id,pool_id,allocation_id,kind,amount_cents,reason,created_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_payment_id,v_person.id,null,null,'payment-received',v_money::bigint,'',v_now,v_receipt_id);
      for v_item in select value from jsonb_array_elements(v_action -> 'allocations') loop
        v_allocation_id := gen_random_uuid();
        insert into public.payment_allocations(id,group_id,payment_id,person_id,pool_id,amount_cents,allocated_at,receipt_id)
          values(v_allocation_id,v_group_id,v_payment_id,v_person.id,(v_item ->> 'poolId')::uuid,(v_item ->> 'amountCents')::bigint,v_now,v_receipt_id);
        insert into public.financial_movements(id,group_id,payment_id,person_id,pool_id,allocation_id,kind,amount_cents,reason,created_at,receipt_id)
          values(gen_random_uuid(),v_group_id,v_payment_id,v_person.id,(v_item ->> 'poolId')::uuid,v_allocation_id,'payment-allocated',(v_item ->> 'amountCents')::bigint,'',v_now,v_receipt_id);
      end loop;
    when 'payment_allocate' then
      v_allocation_id := gen_random_uuid();
      insert into public.payment_allocations(id,group_id,payment_id,person_id,pool_id,amount_cents,allocated_at,receipt_id)
        values(v_allocation_id,v_group_id,v_payment.id,v_payment.person_id,v_pool.id,(v_action ->> 'amountCents')::bigint,v_now,v_receipt_id);
      insert into public.financial_movements(id,group_id,payment_id,person_id,pool_id,allocation_id,kind,amount_cents,reason,created_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_payment.id,v_payment.person_id,v_pool.id,v_allocation_id,'payment-allocated',(v_action ->> 'amountCents')::bigint,'',v_now,v_receipt_id);
    when 'payment_reverse' then
      insert into public.financial_movements(id,group_id,payment_id,person_id,pool_id,allocation_id,kind,amount_cents,reason,created_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_payment.id,v_payment.person_id,null,null,'payment-reversed',-v_payment.amount_cents,v_action ->> 'reason',v_now,v_receipt_id);
      for v_allocation in select * from public.payment_allocations where group_id = v_group_id and payment_id = v_payment.id loop
        insert into public.financial_movements(id,group_id,payment_id,person_id,pool_id,allocation_id,kind,amount_cents,reason,created_at,receipt_id)
          values(gen_random_uuid(),v_group_id,v_payment.id,v_payment.person_id,v_allocation.pool_id,v_allocation.id,'allocation-reversed',-v_allocation.amount_cents,v_action ->> 'reason',v_now,v_receipt_id);
      end loop;
      insert into public.quota_revocations(id,group_id,quota_id,reason,revoked_at,receipt_id)
        select gen_random_uuid(),v_group_id,q.id,v_action ->> 'reason',v_now,v_receipt_id
        from public.confirmed_quotas q where q.group_id = v_group_id and q.person_id = v_payment.person_id
          and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)
          and private.person_pool_funding(v_group_id,q.person_id,q.pool_id) < q.due_cents;
    when 'quota_confirm' then
      insert into public.confirmed_quotas(id,group_id,pool_id,person_id,source_quota_id,source_quota_version,units,due_cents,statute_id,confirmed_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_pool.id,v_person.id,v_quota.id,v_quota.version,(v_quota.data ->> 'units')::numeric::integer,v_due::bigint,v_statute.id,v_now,v_receipt_id);
    end case;
    update public.groups set revision = revision + 1 where id = v_group_id returning revision into v_revision;
    -- Financial revisions carry a canonical group marker without rewriting its entity version.
    insert into public.group_changes(group_id,revision,entity_id,record)
      values(v_group_id,v_revision,v_group_id,private.record_json(v_group_record));
    select event_hash into v_previous_hash from public.audit_events where group_id = v_group_id order by revision desc limit 1;
    v_previous_hash := coalesce(v_previous_hash,repeat('0',64));
    v_event := jsonb_build_object('action',v_type,'groupRevision',v_revision,'actorId',v_actor,'idempotencyKey',v_key,'receiptId',v_receipt_id);
    insert into public.audit_events(group_id,revision,actor_id,idempotency_key,event,previous_hash,event_hash)
      values(v_group_id,v_revision,v_actor,v_key,v_event,v_previous_hash,encode(sha256(convert_to(v_previous_hash || v_event::text,'UTF8')),'hex'));
  end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'groupId',v_group_id,'status',v_status,
    'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
    'snapshot',private.finance_snapshot(v_group_id));
  insert into public.financial_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt_id,v_actor,v_key,v_group_id,p_command,v_result,v_now);
  return v_result;
end;
$$;

create or replace function private.current_plan_error(p_group uuid,p_pool uuid,p_plan jsonb,p_exact_pool_version boolean default true) returns text
language plpgsql set search_path = '' as $$
declare v_pool public.draft_records; v_source public.draft_records; v_quota public.confirmed_quotas;
  v_right jsonb; v_bet jsonb; v_expected jsonb; v_sources jsonb; v_error text; v_first public.pool_manifests;
begin
  v_error := private.prepared_plan_error(p_plan);
  if v_error is not null then return v_error; end if;
  if (p_plan ->> 'groupId')::uuid <> p_group or (p_plan ->> 'poolId')::uuid <> p_pool then return 'O plano pertence a outro grupo ou bolão.'; end if;
  select * into v_pool from public.draft_records where group_id = p_group and id = p_pool and kind = 'pool';
  if not found or v_pool.data ->> 'status' not in ('draft','locked') then return 'O bolão não permite aplicação ou revisão de plano neste estado.'; end if;
  if p_exact_pool_version and v_pool.version <> (p_plan ->> 'poolVersion')::bigint then return 'A versão do bolão mudou; gere e revise o plano novamente.'; end if;
  if (p_plan ->> 'poolVersion')::bigint > v_pool.version then return 'O plano usa uma versão futura do bolão.'; end if;
  if v_pool.data -> 'contestNumber' = 'null'::jsonb or v_pool.data -> 'deadlineAt' = 'null'::jsonb
    or v_pool.data ->> 'participationMode' = 'undecided' then return 'Defina concurso, prazo e tipo de participação antes de aplicar um plano.'; end if;
  if v_pool.data ->> 'lotteryId' <> p_plan ->> 'lotteryId' or v_pool.data -> 'contestNumber' <> p_plan -> 'contestNumber'
    or v_pool.data ->> 'participationMode' <> p_plan ->> 'participationMode' then return 'Modalidade, concurso ou participação divergem do bolão atual.'; end if;
  if private.pool_funding(p_group,p_pool) < (p_plan ->> 'budgetCents')::numeric then return 'O orçamento excede o dinheiro líquido confirmado e alocado neste bolão.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('quotaId',q.id,'sourceQuotaId',q.source_quota_id,
    'sourceQuotaVersion',q.source_quota_version,'personId',q.person_id,'units',q.units,'dueCents',q.due_cents::text,'statuteId',q.statute_id) order by q.id),'[]'::jsonb)
    into v_expected from public.confirmed_quotas q where q.group_id = p_group and q.pool_id = p_pool
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id);
  if v_expected <> (select jsonb_agg(value order by (value ->> 'quotaId')::uuid) from jsonb_array_elements(p_plan -> 'rights')) then
    return 'O plano precisa incluir exatamente todos os direitos confirmados atuais.';
  end if;
  for v_right in select value from jsonb_array_elements(p_plan -> 'rights') loop
    select * into v_quota from public.confirmed_quotas where group_id = p_group and id = (v_right ->> 'quotaId')::uuid;
    select * into v_source from public.draft_records where group_id = p_group and id = v_quota.source_quota_id and kind = 'quota';
    if not found or v_source.version <> v_quota.source_quota_version or (v_source.data ->> 'poolId')::uuid <> p_pool
      or (v_source.data ->> 'personId')::uuid <> v_quota.person_id or (v_source.data ->> 'units')::numeric <> v_quota.units
      then return 'Um direito confirmado diverge da sua cota de origem.'; end if;
    if (v_pool.data ->> 'quotaPriceCents')::numeric * v_quota.units / 100 <> v_quota.due_cents then return 'O preço atual diverge dos direitos confirmados.'; end if;
    if private.person_pool_funding(p_group,v_quota.person_id,p_pool) < v_quota.due_cents then return 'Todos os participantes precisam estar integralmente financiados.'; end if;
    if not exists (select 1 from public.draft_records where group_id = p_group and id = v_quota.person_id
      and kind = 'person' and data -> 'adultDeclared' = 'true'::jsonb) then return 'Todos os participantes precisam ter maioridade declarada.'; end if;
    if not exists (select 1 from public.statute_acceptances where group_id = p_group and person_id = v_quota.person_id and statute_id = v_quota.statute_id)
      then return 'Um direito não possui evidência de aceite do estatuto congelado.'; end if;
  end loop;
  if exists (select 1 from public.draft_records d join public.draft_records p on p.group_id = d.group_id and p.id = (d.data ->> 'personId')::uuid
    where d.group_id = p_group and d.kind = 'quota' and (d.data ->> 'poolId')::uuid = p_pool and p.kind = 'person'
      and p.data -> 'adultDeclared' = 'true'::jsonb and not exists (select 1 from public.confirmed_quotas q where q.group_id = p_group
        and q.pool_id = p_pool and q.source_quota_id = d.id and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id))) then
    return 'Há cotas preparadas elegíveis ainda sem confirmação integral; revise as pendências.';
  end if;
  if exists (select 1 from public.draft_records d where d.group_id = p_group and d.kind = 'payment-proposal'
    and (d.data ->> 'poolId')::uuid = p_pool and d.data ->> 'status' in ('pending','needs-review')
    and not exists (select 1 from public.received_payments p where p.group_id = p_group and p.source_proposal_id = d.id)) then
    return 'Há propostas de pagamento pendentes neste bolão; confirme ou revise antes do plano.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version) order by id),'[]'::jsonb) into v_sources
    from public.draft_records where group_id = p_group and kind = 'bet' and (data ->> 'poolId')::uuid = p_pool;
  if v_sources <> coalesce((select jsonb_agg(value order by (value ->> 'id')::uuid) from jsonb_array_elements(p_plan -> 'sourceBets')),'[]'::jsonb) then
    return 'O plano precisa preservar todos os jogos sincronizados e suas versões atuais.';
  end if;
  if jsonb_array_length(p_plan -> 'sourceBets') <> (select count(*) from jsonb_array_elements(p_plan -> 'bets') where value -> 'sourceBetId' <> 'null'::jsonb) then
    return 'O plano omite um jogo fixo sincronizado.';
  end if;
  for v_bet in select value from jsonb_array_elements(p_plan -> 'bets') loop
    if v_bet -> 'sourceBetId' <> 'null'::jsonb then
      select * into v_source from public.draft_records where group_id = p_group and id = (v_bet ->> 'sourceBetId')::uuid
        and kind = 'bet' and (data ->> 'poolId')::uuid = p_pool;
      if not found or v_source.version <> (v_bet ->> 'sourceBetVersion')::bigint
        or v_source.data -> 'numbers' <> v_bet -> 'numbers' or v_source.data -> 'authorIds' <> v_bet -> 'authorIds'
        or v_source.data -> 'seed' <> v_bet -> 'seed' or v_source.data -> 'generationAlgorithmVersion' <> v_bet -> 'generationAlgorithmVersion' then
        return 'Um jogo fixo foi alterado, movido ou deixou de corresponder à versão revisada.';
      end if;
    end if;
    if exists (select 1 from jsonb_array_elements(v_bet -> 'authorIds') a where not exists (select 1 from public.draft_records
      where group_id = p_group and id = (a.value #>> '{}')::uuid and kind = 'person')) then return 'Autor não encontrado neste grupo.'; end if;
  end loop;
  select * into v_first from public.pool_manifests where group_id = p_group and pool_id = p_pool order by version limit 1;
  if found then
    if (p_plan -> 'rights') <> v_first.content -> 'plan' -> 'rights' or p_plan -> 'budgetCents' <> v_first.content -> 'plan' -> 'budgetCents' then
      return 'Uma revisão de bolão fechado precisa preservar os direitos e o orçamento inicial.';
    end if;
    if exists (select 1 from jsonb_array_elements(p_plan -> 'bets') b cross join lateral jsonb_array_elements(b.value -> 'authorIds') a
      where not exists (select 1 from jsonb_array_elements(v_first.content -> 'persons') p where (p.value ->> 'id')::uuid = (a.value #>> '{}')::uuid)) then
      return 'Uma revisão não pode acrescentar responsáveis ou autores fora das pessoas congeladas.';
    end if;
  elsif v_pool.data ->> 'status' = 'locked' then return 'Não há manifesto inicial para revisar este bolão; verifique o estado registrado.'; end if;
  return null;
end;
$$;

create or replace function public.planning_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_key uuid; v_group_id uuid; v_pool_id uuid; v_receipt_id uuid := gen_random_uuid();
  v_saved public.planning_command_receipts; v_group public.groups; v_pool public.draft_records;
  v_applied public.pool_plan_versions; v_first public.pool_manifests; v_latest public.pool_manifests;
  v_action jsonb; v_plan jsonb; v_responsible jsonb; v_persons jsonb; v_content jsonb; v_canonical text; v_financial jsonb;
  v_error text; v_status text := 'accepted'; v_revision bigint; v_version bigint; v_now timestamptz;
  v_applied_id uuid; v_event jsonb; v_previous_hash text; v_result jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey')
    or not private.json_uuid(p_command -> 'groupId') or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991)
    then raise exception 'invalid_planning_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group_id := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('planning:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.planning_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group_id,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text,0));
  select * into v_group from public.groups where id = v_group_id for update;
  if not found or not private.can_manage_group(v_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  v_revision := v_group.revision;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then
    v_status := 'conflict'; v_error := 'A revisão do grupo mudou; sincronize e revise o plano novamente.';
  elsif v_revision >= 9007199254740991 then v_error := 'Limite de revisão atingido.'; end if;
  if v_error is null then
    if v_action ->> 'type' = 'plan_apply' then
      if private.exact_keys(v_action,array['type','plan']) is not true then v_error := 'Aplicação de plano inválida.';
      else
        v_plan := v_action -> 'plan';
        v_error := private.prepared_plan_error(v_plan);
        if v_error is null then
          v_plan := private.normalize_prepared_plan(v_plan);
          v_pool_id := (v_plan ->> 'poolId')::uuid;
          select * into v_pool from public.draft_records where group_id = v_group_id and id = v_pool_id and kind = 'pool';
          if not found then v_error := 'Bolão não encontrado neste grupo.';
          elsif (v_plan ->> 'groupRevision')::numeric <> v_revision or (v_plan ->> 'poolVersion')::numeric <> v_pool.version then
            v_status := 'conflict'; v_error := 'A revisão ou versão usada para preparar o plano mudou; gere novamente sem ajustar só a revisão.';
          else v_error := private.current_plan_error(v_group_id,v_pool_id,v_plan); end if;
        end if;
      end if;
    elsif v_action ->> 'type' = 'pool_lock' then
      if private.exact_keys(v_action,array['type','poolId','poolVersion','appliedPlanId','responsible']) is not true
        or not private.json_uuid(v_action -> 'poolId') or not private.json_uuid(v_action -> 'appliedPlanId')
        or not private.json_integer(v_action -> 'poolVersion',1,9007199254740991)
        or private.exact_keys(v_action -> 'responsible',array['registrarPersonId','ticketHolderPersonId']) is not true
        or not private.json_uuid(v_action -> 'responsible' -> 'registrarPersonId')
        or (v_action -> 'responsible' -> 'ticketHolderPersonId' <> 'null'::jsonb and not private.json_uuid(v_action -> 'responsible' -> 'ticketHolderPersonId')) then
        v_error := 'Trava inválida; escolha os responsáveis explicitamente.';
      else
        v_pool_id := (v_action ->> 'poolId')::uuid;
        select * into v_pool from public.draft_records where group_id = v_group_id and id = v_pool_id and kind = 'pool';
        if not found then v_error := 'Bolão não encontrado neste grupo.';
        elsif (v_action ->> 'poolVersion')::numeric <> v_pool.version then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a trava.';
        else
          select * into v_applied from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id and id = (v_action ->> 'appliedPlanId')::uuid;
          if not found then v_error := 'Plano aplicado não encontrado neste bolão.';
          elsif v_applied.version <> (select max(version) from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id) then
            v_error := 'A trava exige a versão mais recente do plano aplicado.';
          else
            v_plan := v_applied.prepared_plan;
            v_error := private.current_plan_error(v_group_id,v_pool_id,v_plan,false);
          end if;
        end if;
        if v_error is null then
          if (v_plan ->> 'leftoverCents')::numeric > 0 and v_plan ->> 'leftoverPolicy' = 'unassigned' then v_error := 'Escolha o destino autorizado da sobra antes da trava.'; end if;
          if not exists (select 1 from public.draft_records where group_id = v_group_id and kind = 'person'
            and id = (v_action -> 'responsible' ->> 'registrarPersonId')::uuid and data -> 'adultDeclared' = 'true'::jsonb) then
            v_error := 'O registrador precisa ser uma pessoa adulta deste grupo.';
          end if;
          if v_plan ->> 'participationMode' = 'internal' then
            if not exists (select 1 from public.draft_records where group_id = v_group_id and kind = 'person'
              and id = (v_action -> 'responsible' ->> 'ticketHolderPersonId')::uuid and data -> 'adultDeclared' = 'true'::jsonb) then
              v_error := 'O acordo interno exige um titular adulto do bilhete neste grupo.';
            end if;
          elsif v_action -> 'responsible' -> 'ticketHolderPersonId' <> 'null'::jsonb then
            v_error := 'No modo oficial, os titulares serão informados pelos recibos; não escolha um titular informal.';
          end if;
          select * into v_first from public.pool_manifests where group_id = v_group_id and pool_id = v_pool_id order by version limit 1;
          select * into v_latest from public.pool_manifests where group_id = v_group_id and pool_id = v_pool_id order by version desc limit 1;
          if v_first.id is not null and (v_first.content -> 'responsible' -> 'registrarPersonId' <> v_action -> 'responsible' -> 'registrarPersonId'
            or v_first.content -> 'responsible' -> 'ticketHolderPersonId' <> v_action -> 'responsible' -> 'ticketHolderPersonId') then
            v_error := 'Uma revisão precisa preservar os responsáveis do manifesto inicial.';
          end if;
        end if;
      end if;
    else v_error := 'Ação de planejamento não suportada.';
    end if;
  end if;
  if v_error is null and v_action ->> 'type' = 'plan_apply' then
    select coalesce(max(version),0)+1 into v_version from public.pool_plan_versions where group_id = v_group_id and pool_id = v_pool_id;
    if v_version > 9007199254740991 or (select count(*) from public.pool_plan_versions where group_id = v_group_id) >= 10000 then v_error := 'Limite de versões de plano atingido.'; end if;
  elsif v_error is null then
    v_version := coalesce(v_latest.version,0)+1;
    if v_version > 9007199254740991 or v_pool.version >= 9007199254740991 or (select count(*) from public.pool_manifests where group_id = v_group_id) >= 10000 then v_error := 'Limite de versões de manifesto ou bolão atingido.'; end if;
  end if;
  v_now := clock_timestamp();
  if v_error is not null and v_status = 'accepted' then v_status := 'rejected'; end if;
  if v_status = 'accepted' then
    if v_action ->> 'type' = 'plan_apply' then
      v_applied_id := gen_random_uuid();
      insert into public.pool_plan_versions(id,group_id,pool_id,version,prepared_plan,budget_cents,total_cost_cents,applied_at,receipt_id)
        values(v_applied_id,v_group_id,v_pool_id,v_version,v_plan,(v_plan ->> 'budgetCents')::bigint,(v_plan ->> 'totalCostCents')::bigint,v_now,v_receipt_id);
    else
      update public.draft_records set data = jsonb_set(data,'{status}','"locked"'),version = version+1,updated_at = v_now
        where group_id = v_group_id and id = v_pool_id returning * into v_pool;
      v_financial := case when v_first.id is not null then v_first.content -> 'financial' else private.finance_snapshot(v_group_id) end;
      v_applied_id := v_applied.id;
    end if;
    update public.groups set revision = revision+1 where id = v_group_id returning revision into v_revision;
    if v_action ->> 'type' = 'pool_lock' then
      if v_first.id is not null then
        v_responsible := v_first.content -> 'responsible'; v_persons := v_first.content -> 'persons';
      else
        v_responsible := jsonb_build_object('organizerUserId',v_actor,'registrarPersonId',v_action -> 'responsible' -> 'registrarPersonId',
          'ticketHolderPersonId',v_action -> 'responsible' -> 'ticketHolderPersonId');
        select jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'data',p.data) order by p.id) into v_persons
          from public.draft_records p where p.group_id = v_group_id and p.kind = 'person' and p.id in (
            select (value ->> 'personId')::uuid from jsonb_array_elements(v_plan -> 'rights')
            union select (a.value #>> '{}')::uuid from jsonb_array_elements(v_plan -> 'bets') b cross join lateral jsonb_array_elements(b.value -> 'authorIds') a
            union select (v_responsible ->> 'registrarPersonId')::uuid
            union select (v_responsible ->> 'ticketHolderPersonId')::uuid where v_responsible -> 'ticketHolderPersonId' <> 'null'::jsonb);
      end if;
      v_content := jsonb_build_object('schemaVersion','pool-manifest-v1','responsible',v_responsible,
        'catalog',private.planning_catalog_json(v_plan ->> 'lotteryId'),
        'pool',jsonb_build_object('id',v_pool.id,'version',v_pool.version,'data',jsonb_set(v_pool.data,'{deadlineAt}',to_jsonb(private.utc_json((v_pool.data ->> 'deadlineAt')::timestamptz)))),
        'plan',v_plan,'persons',v_persons,'financial',v_financial);
      v_canonical := private.canonical_json(v_content);
      insert into public.pool_manifests(id,group_id,pool_id,version,applied_plan_id,previous_manifest_id,content,canonical,sha256,locked_at,receipt_id)
        values(gen_random_uuid(),v_group_id,v_pool_id,v_version,v_applied_id,v_latest.id,v_content,v_canonical,encode(sha256(convert_to(v_canonical,'UTF8')),'hex'),v_now,v_receipt_id);
    end if;
    insert into public.group_changes(group_id,revision,entity_id,record) values(v_group_id,v_revision,v_pool_id,private.record_json(v_pool));
    select event_hash into v_previous_hash from public.audit_events where group_id = v_group_id order by revision desc limit 1;
    v_previous_hash := coalesce(v_previous_hash,repeat('0',64));
    v_event := jsonb_build_object('action',v_action ->> 'type','groupRevision',v_revision,'poolId',v_pool_id,'version',v_version,
      'actorId',v_actor,'idempotencyKey',v_key,'receiptId',v_receipt_id,'appliedPlanId',v_applied_id);
    insert into public.audit_events(group_id,revision,actor_id,idempotency_key,event,previous_hash,event_hash)
      values(v_group_id,v_revision,v_actor,v_key,v_event,v_previous_hash,encode(sha256(convert_to(v_previous_hash || v_event::text,'UTF8')),'hex'));
  end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt_id else null end,'groupId',v_group_id,'status',v_status,'groupRevision',v_revision,
    'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,'snapshot',private.planning_snapshot(v_group_id));
  insert into public.planning_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt_id,v_actor,v_key,v_group_id,p_command,v_result,v_now);
  return v_result;
end;
$$;
