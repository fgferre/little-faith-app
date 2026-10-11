-- Human financial decisions. The foundation migration remains immutable.
-- The live account classification is authoritative even before an old JWT expires.
create or replace function private.is_human_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and coalesce(auth.jwt() ->> 'session_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'false'
    and not (auth.jwt() ? 'client_id')
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'actor_type', 'human') = 'human'
    and exists (select 1 from auth.users u where u.id = auth.uid()
      and coalesce(u.raw_app_meta_data ->> 'actor_type', 'human') = 'human');
$$;

create table public.financial_command_receipts (
  id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  group_id uuid not null references public.groups(id) on delete restrict,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null,
  unique (actor_id, idempotency_key)
);

create table public.statute_versions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  version bigint not null check (version between 1 and 9007199254740991),
  text text not null check (char_length(btrim(text)) between 1 and 12000),
  source_group_version bigint not null check (source_group_version between 1 and 9007199254740991),
  published_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  unique (group_id, id),
  unique (group_id, version),
  unique (group_id, source_group_version)
);

create table public.statute_acceptances (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  statute_id uuid not null,
  person_id uuid not null,
  evidence text not null check (char_length(btrim(evidence)) between 1 and 2000),
  accepted_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, statute_id) references public.statute_versions(group_id, id) on delete restrict,
  foreign key (group_id, person_id) references public.draft_records(group_id, id) on delete restrict,
  unique (group_id, person_id, statute_id)
);

create table public.received_payments (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  person_id uuid not null,
  source_proposal_id uuid not null,
  source_proposal_version bigint not null check (source_proposal_version between 1 and 9007199254740991),
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  bank_reference text check (char_length(bank_reference) between 1 and 200),
  declared_received_at timestamptz,
  confirmed_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, person_id) references public.draft_records(group_id, id) on delete restrict,
  foreign key (group_id, source_proposal_id) references public.draft_records(group_id, id) on delete restrict,
  unique (group_id, id),
  unique (group_id, id, person_id),
  unique (group_id, source_proposal_id)
);
create unique index received_payments_bank_reference_idx on public.received_payments(group_id, bank_reference) where bank_reference is not null;

create table public.payment_allocations (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  payment_id uuid not null,
  person_id uuid not null,
  pool_id uuid not null,
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  allocated_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, payment_id, person_id) references public.received_payments(group_id, id, person_id) on delete restrict,
  foreign key (group_id, pool_id) references public.draft_records(group_id, id) on delete restrict,
  unique (group_id, id, payment_id, person_id, pool_id)
);
create index payment_allocations_payment_idx on public.payment_allocations(group_id, payment_id);
create index payment_allocations_funding_idx on public.payment_allocations(group_id, person_id, pool_id);

create table public.financial_movements (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  payment_id uuid not null,
  person_id uuid not null,
  pool_id uuid,
  allocation_id uuid,
  kind text not null check (kind in ('payment-received','payment-allocated','payment-reversed','allocation-reversed')),
  amount_cents bigint not null check (amount_cents between -9007199254740991 and 9007199254740991 and amount_cents <> 0),
  reason text not null check (char_length(reason) <= 2000),
  created_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, payment_id, person_id) references public.received_payments(group_id, id, person_id) on delete restrict,
  foreign key (group_id, allocation_id, payment_id, person_id, pool_id)
    references public.payment_allocations(group_id, id, payment_id, person_id, pool_id) on delete restrict,
  check (
    (kind = 'payment-received' and pool_id is null and allocation_id is null and amount_cents > 0)
    or (kind = 'payment-allocated' and pool_id is not null and allocation_id is not null and amount_cents > 0)
    or (kind = 'payment-reversed' and pool_id is null and allocation_id is null and amount_cents < 0 and char_length(btrim(reason)) > 0)
    or (kind = 'allocation-reversed' and pool_id is not null and allocation_id is not null and amount_cents < 0 and char_length(btrim(reason)) > 0)
  )
);
create unique index financial_movement_payment_once_idx on public.financial_movements(payment_id, kind) where kind in ('payment-received','payment-reversed');
create unique index financial_movement_allocation_once_idx on public.financial_movements(allocation_id, kind) where allocation_id is not null;
create index financial_movements_funding_idx on public.financial_movements(group_id, person_id, pool_id);

create table public.confirmed_quotas (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  person_id uuid not null,
  source_quota_id uuid not null,
  source_quota_version bigint not null check (source_quota_version between 1 and 9007199254740991),
  units integer not null check (units between 1 and 1000000),
  due_cents bigint not null check (due_cents between 1 and 9007199254740991),
  statute_id uuid not null,
  confirmed_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, pool_id) references public.draft_records(group_id, id) on delete restrict,
  foreign key (group_id, person_id) references public.draft_records(group_id, id) on delete restrict,
  foreign key (group_id, source_quota_id) references public.draft_records(group_id, id) on delete restrict,
  foreign key (group_id, statute_id) references public.statute_versions(group_id, id) on delete restrict,
  unique (group_id, id)
);
create index confirmed_quotas_person_pool_idx on public.confirmed_quotas(group_id, person_id, pool_id);
create index confirmed_quotas_source_idx on public.confirmed_quotas(group_id, source_quota_id);

create table public.quota_revocations (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  quota_id uuid not null unique,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  revoked_at timestamptz not null,
  receipt_id uuid not null references public.financial_command_receipts(id) deferrable initially deferred,
  foreign key (group_id, quota_id) references public.confirmed_quotas(group_id, id) on delete restrict
);

-- Facts and receipts are append only. A reversal creates compensating facts.
create trigger financial_receipts_append_only before update or delete on public.financial_command_receipts for each row execute function private.prevent_mutation();
create trigger statutes_append_only before update or delete on public.statute_versions for each row execute function private.prevent_mutation();
create trigger acceptances_append_only before update or delete on public.statute_acceptances for each row execute function private.prevent_mutation();
create trigger received_payments_append_only before update or delete on public.received_payments for each row execute function private.prevent_mutation();
create trigger allocations_append_only before update or delete on public.payment_allocations for each row execute function private.prevent_mutation();
create trigger movements_append_only before update or delete on public.financial_movements for each row execute function private.prevent_mutation();
create trigger quotas_append_only before update or delete on public.confirmed_quotas for each row execute function private.prevent_mutation();
create trigger quota_revocations_append_only before update or delete on public.quota_revocations for each row execute function private.prevent_mutation();

create function private.js_trim(p_value text) returns text
language sql immutable set search_path = '' as $$
  select btrim(p_value, chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
    chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
$$;

create function private.utc_json(p_time timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create function private.financial_action_error(p_action jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_type text;
begin
  if jsonb_typeof(p_action) is distinct from 'object' then return 'Ação financeira inválida.'; end if;
  v_type := p_action ->> 'type';
  case v_type
  when 'statute_publish' then
    if private.exact_keys(p_action,array['type','groupVersion']) is not true
      or not private.json_integer(p_action -> 'groupVersion',1,9007199254740991) then return 'Versão do grupo inválida.'; end if;
  when 'statute_accept' then
    if private.exact_keys(p_action,array['type','statuteId','personId','evidence']) is not true
      or not private.json_uuid(p_action -> 'statuteId') or not private.json_uuid(p_action -> 'personId')
      or not private.json_text(p_action -> 'evidence',2000,true) or private.js_trim(p_action ->> 'evidence') = ''
      then return 'Informe o estatuto, a pessoa e a evidência do aceite.'; end if;
  when 'payment_confirm' then
    if private.exact_keys(p_action,array['type','proposalId','proposalVersion','bankReference','declaredReceivedAt','allocations']) is not true
      or not private.json_uuid(p_action -> 'proposalId') or not private.json_integer(p_action -> 'proposalVersion',1,9007199254740991)
      or (p_action -> 'bankReference' <> 'null'::jsonb and (not private.json_text(p_action -> 'bankReference',200,true) or private.js_trim(p_action ->> 'bankReference') = ''))
      or (p_action -> 'declaredReceivedAt' <> 'null'::jsonb and not private.json_timestamp(p_action -> 'declaredReceivedAt'))
      or jsonb_typeof(p_action -> 'allocations') is distinct from 'array' then return 'Dados do recebimento inválidos.'; end if;
    if jsonb_array_length(p_action -> 'allocations') > 100 then return 'Informe no máximo 100 alocações por recebimento.'; end if;
    for v_item in select value from jsonb_array_elements(p_action -> 'allocations') loop
      if private.exact_keys(v_item,array['poolId','amountCents']) is not true or not private.json_uuid(v_item -> 'poolId')
        or not private.json_money(v_item -> 'amountCents',true) then return 'Alocação inválida.'; end if;
    end loop;
    if (select count(*) <> count(distinct (value ->> 'poolId')::uuid) from jsonb_array_elements(p_action -> 'allocations')) then
      return 'Cada bolão deve aparecer apenas uma vez nas alocações do recebimento.';
    end if;
  when 'payment_allocate' then
    if private.exact_keys(p_action,array['type','paymentId','poolId','amountCents']) is not true
      or not private.json_uuid(p_action -> 'paymentId') or not private.json_uuid(p_action -> 'poolId')
      or not private.json_money(p_action -> 'amountCents',true) then return 'Dados da alocação inválidos.'; end if;
  when 'payment_reverse' then
    if private.exact_keys(p_action,array['type','paymentId','reason']) is not true or not private.json_uuid(p_action -> 'paymentId')
      or not private.json_text(p_action -> 'reason',2000,true) or private.js_trim(p_action ->> 'reason') = ''
      then return 'Informe o recebimento e o motivo do estorno.'; end if;
  when 'quota_confirm' then
    if private.exact_keys(p_action,array['type','quotaId','quotaVersion','statuteId']) is not true
      or not private.json_uuid(p_action -> 'quotaId') or not private.json_integer(p_action -> 'quotaVersion',1,9007199254740991)
      or not private.json_uuid(p_action -> 'statuteId') then return 'Dados da confirmação de cota inválidos.'; end if;
  else return 'Ação financeira não suportada.';
  end case;
  return null;
end;
$$;

create function private.person_pool_funding(p_group uuid,p_person uuid,p_pool uuid) returns numeric
language sql set search_path = '' as $$
  select coalesce(sum(amount_cents),0)::numeric from public.financial_movements
    where group_id = p_group and person_id = p_person and pool_id = p_pool and kind in ('payment-allocated','allocation-reversed');
$$;

create function private.finance_snapshot(p_group uuid) returns jsonb
language sql set search_path = '' as $$
  -- One SQL statement gives the revision and every array the same MVCC snapshot.
  select jsonb_build_object('groupId',g.id,'groupRevision',g.revision,
    'statutes',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'groupId',s.group_id,'version',s.version,'text',s.text,'sourceGroupVersion',s.source_group_version,
      'publishedAt',private.utc_json(s.published_at),'receiptId',s.receipt_id) order by s.version)
      from public.statute_versions s where s.group_id = p_group),'[]'::jsonb),
    'acceptances',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'groupId',a.group_id,'statuteId',a.statute_id,'personId',a.person_id,'evidence',a.evidence,
      'acceptedAt',private.utc_json(a.accepted_at),'receiptId',a.receipt_id) order by a.accepted_at,a.id)
      from public.statute_acceptances a where a.group_id = p_group),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'groupId',p.group_id,'personId',p.person_id,'sourceProposalId',p.source_proposal_id,
      'sourceProposalVersion',p.source_proposal_version,'amountCents',p.amount_cents::text,'bankReference',p.bank_reference,
      'declaredReceivedAt',private.utc_json(p.declared_received_at),'confirmedAt',private.utc_json(p.confirmed_at),'receiptId',p.receipt_id) order by p.confirmed_at,p.id)
      from public.received_payments p where p.group_id = p_group),'[]'::jsonb),
    'allocations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'groupId',a.group_id,'paymentId',a.payment_id,'personId',a.person_id,'poolId',a.pool_id,
      'amountCents',a.amount_cents::text,'allocatedAt',private.utc_json(a.allocated_at),'receiptId',a.receipt_id) order by a.allocated_at,a.id)
      from public.payment_allocations a where a.group_id = p_group),'[]'::jsonb),
    'movements',coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'groupId',m.group_id,'paymentId',m.payment_id,'personId',m.person_id,'poolId',m.pool_id,'allocationId',m.allocation_id,
      'kind',m.kind,'amountCents',m.amount_cents::text,'reason',m.reason,'createdAt',private.utc_json(m.created_at),'receiptId',m.receipt_id) order by m.created_at,m.id)
      from public.financial_movements m where m.group_id = p_group),'[]'::jsonb),
    'quotas',coalesce((select jsonb_agg(jsonb_build_object(
      'id',q.id,'groupId',q.group_id,'poolId',q.pool_id,'personId',q.person_id,'sourceQuotaId',q.source_quota_id,
      'sourceQuotaVersion',q.source_quota_version,'units',q.units,'dueCents',q.due_cents::text,'statuteId',q.statute_id,
      'confirmedAt',private.utc_json(q.confirmed_at),'receiptId',q.receipt_id) order by q.confirmed_at,q.id)
      from public.confirmed_quotas q where q.group_id = p_group),'[]'::jsonb),
    'revocations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'groupId',r.group_id,'quotaId',r.quota_id,'reason',r.reason,'revokedAt',private.utc_json(r.revoked_at),'receiptId',r.receipt_id) order by r.revoked_at,r.id)
      from public.quota_revocations r where r.group_id = p_group),'[]'::jsonb)
  ) from public.groups g where g.id = p_group;
$$;

create function public.finance_pull(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return private.finance_snapshot(p_group_id);
end;
$$;

create function public.finance_command_status(p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_receipt public.financial_command_receipts;
begin
  perform private.require_human();
  select * into v_receipt from public.financial_command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if not private.can_manage_group(v_receipt.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return v_receipt.response_payload;
end;
$$;

create function public.review_decide(p_command jsonb) returns jsonb
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
        elsif v_pool.data -> 'deadlineAt' = 'null'::jsonb then v_error := 'Defina o prazo do bolão antes de confirmar uma cota.';
        elsif v_now >= (v_pool.data ->> 'deadlineAt')::timestamptz then v_error := 'O prazo do bolão já terminou; recebimentos tardios não criam uma cota.'; end if;
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
  if v_error is null and v_type = 'quota_confirm' and v_now >= (v_pool.data ->> 'deadlineAt')::timestamptz then
    v_error := 'O prazo do bolão terminou durante a revisão; a cota não foi confirmada.';
  end if;
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

create function private.financial_draft_guard_error(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns text
language plpgsql set search_path = '' as $$
declare v_old public.draft_records;
begin
  select * into v_old from public.draft_records where group_id = p_group and id = p_id;
  if not found then return null; end if;
  if p_kind = 'payment-proposal' and exists (select 1 from public.received_payments where group_id = p_group and source_proposal_id = p_id) then
    return 'A proposta já gerou um recebimento e está preservada; use o estorno para corrigir o lançamento.';
  end if;
  if p_kind = 'quota' and exists (select 1 from public.confirmed_quotas q where q.group_id = p_group and q.source_quota_id = p_id
    and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
    return 'Uma cota confirmada ativa não pode ser editada; preserve os direitos já aprovados.';
  end if;
  if p_kind = 'person' and p_data -> 'adultDeclared' is distinct from 'true'::jsonb and exists (
    select 1 from public.confirmed_quotas q where q.group_id = p_group and q.person_id = p_id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
    return 'A declaração de maioridade sustenta uma cota ativa e não pode ser retirada neste estado.';
  end if;
  if p_kind = 'pool' then
    if v_old.data ->> 'status' <> 'draft' and p_data ->> 'status' = 'draft' then return 'Um bolão travado não pode ser reaberto pela sincronização de rascunhos.'; end if;
    if exists (select 1 from public.confirmed_quotas q where q.group_id = p_group and q.pool_id = p_id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id))
      and (v_old.data -> 'quotaPriceCents' is distinct from p_data -> 'quotaPriceCents'
        or v_old.data -> 'deadlineAt' is distinct from p_data -> 'deadlineAt'
        or v_old.data -> 'lotteryId' is distinct from p_data -> 'lotteryId'
        or v_old.data -> 'contestNumber' is distinct from p_data -> 'contestNumber'
        or v_old.data -> 'participationMode' is distinct from p_data -> 'participationMode') then
      return 'Preço, prazo, modalidade, concurso e tipo de participação estão vinculados a cotas confirmadas ativas.';
    end if;
  end if;
  return null;
end;
$$;

create function private.guard_financial_drafts() returns trigger
language plpgsql set search_path = '' as $$
declare v_error text;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.group_id is distinct from old.group_id or new.kind is distinct from old.kind then
      raise exception 'A identidade e o grupo de uma entidade não podem ser alterados.' using errcode = '23514';
    end if;
    v_error := private.financial_draft_guard_error(old.group_id,old.id,old.kind,new.data);
  else
    v_error := private.financial_draft_guard_error(old.group_id,old.id,old.kind,old.data);
    if old.kind = 'pool' and exists (select 1 from public.confirmed_quotas q where q.group_id = old.group_id and q.pool_id = old.id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id)) then
      v_error := 'Um bolão com cotas confirmadas ativas não pode ser excluído.';
    end if;
  end if;
  if v_error is not null then raise exception '%',v_error using errcode = '23514'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger financial_drafts_guard before update or delete on public.draft_records for each row execute function private.guard_financial_drafts();

alter table public.financial_command_receipts enable row level security;
alter table public.statute_versions enable row level security;
alter table public.statute_acceptances enable row level security;
alter table public.received_payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.financial_movements enable row level security;
alter table public.confirmed_quotas enable row level security;
alter table public.quota_revocations enable row level security;
create policy financial_receipts_read_self on public.financial_command_receipts for select to authenticated
  using (actor_id = auth.uid() and private.can_manage_group(group_id));
create policy statutes_read_organizer on public.statute_versions for select to authenticated using (private.can_manage_group(group_id));
create policy acceptances_read_organizer on public.statute_acceptances for select to authenticated using (private.can_manage_group(group_id));
create policy received_payments_read_organizer on public.received_payments for select to authenticated using (private.can_manage_group(group_id));
create policy allocations_read_organizer on public.payment_allocations for select to authenticated using (private.can_manage_group(group_id));
create policy movements_read_organizer on public.financial_movements for select to authenticated using (private.can_manage_group(group_id));
create policy confirmed_quotas_read_organizer on public.confirmed_quotas for select to authenticated using (private.can_manage_group(group_id));
create policy revocations_read_organizer on public.quota_revocations for select to authenticated using (private.can_manage_group(group_id));
revoke all on public.financial_command_receipts,public.statute_versions,public.statute_acceptances,public.received_payments,
  public.payment_allocations,public.financial_movements,public.confirmed_quotas,public.quota_revocations from anon,authenticated;
grant select on public.financial_command_receipts,public.statute_versions,public.statute_acceptances,public.received_payments,
  public.payment_allocations,public.financial_movements,public.confirmed_quotas,public.quota_revocations to authenticated;
revoke all on function private.js_trim(text),private.utc_json(timestamptz),private.financial_action_error(jsonb),
  private.person_pool_funding(uuid,uuid,uuid),private.finance_snapshot(uuid),
  private.financial_draft_guard_error(uuid,uuid,text,jsonb),private.guard_financial_drafts() from public,anon,authenticated;
revoke all on function public.review_decide(jsonb),public.finance_pull(uuid),public.finance_command_status(uuid) from public,anon;
grant execute on function public.review_decide(jsonb),public.finance_pull(uuid),public.finance_command_status(uuid) to authenticated;

-- Preserve draft receipts, returning a durable rejection before frozen facts are mutated.
create or replace function public.sync_push(p_operation jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_key uuid; v_group_id uuid; v_entity_id uuid; v_kind text; v_expected bigint;
  v_group public.groups; v_record public.draft_records; v_saved public.command_receipts;
  v_pool public.draft_records; v_person public.draft_records;
  v_data jsonb; v_result jsonb; v_error text; v_status text := 'accepted'; v_version bigint := 0;
  v_revision bigint := 0; v_record_json jsonb := null; v_bootstrap boolean; v_event jsonb; v_previous_hash text;
begin
  perform private.require_human();
  if octet_length(p_operation::text) > 65536 or private.exact_keys(p_operation,
    array['apiVersion','idempotencyKey','groupId','entityId','kind','expectedVersion','data','createdAt']) is not true
    or (p_operation ->> 'apiVersion' = 'v1') is not true
    or not private.json_uuid(p_operation -> 'idempotencyKey') or not private.json_uuid(p_operation -> 'groupId')
    or not private.json_uuid(p_operation -> 'entityId') or not private.json_integer(p_operation -> 'expectedVersion', 0, 9007199254740991)
    or not private.json_timestamp(p_operation -> 'createdAt')
    or (p_operation ->> 'kind' in ('group','person','pool','quota','bet','payment-proposal')) is not true
    then raise exception 'invalid_operation_envelope' using errcode = '22023'; end if;
  v_key := (p_operation ->> 'idempotencyKey')::uuid; v_group_id := (p_operation ->> 'groupId')::uuid;
  v_entity_id := (p_operation ->> 'entityId')::uuid; v_kind := p_operation ->> 'kind';
  v_expected := (p_operation ->> 'expectedVersion')::numeric::bigint; v_data := p_operation -> 'data';
  -- Serialize the absent receipt as well as an existing one. Hash collisions only serialize extra work.
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text || ':' || v_key::text, 0));
  select * into v_saved from public.command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if exists (select 1 from public.groups where id = v_saved.group_id) and not private.can_manage_group(v_saved.group_id) then
      raise exception 'group_access_denied' using errcode = '42501';
    end if;
    if v_saved.request_payload = p_operation then return v_saved.response_payload; end if;
    -- Preserve the original receipt; status lookup still returns that original operation.
    return jsonb_build_object('idempotencyKey', v_key, 'status', 'rejected', 'entityId', v_entity_id,
      'serverVersion', 0, 'groupRevision', 0, 'message', 'Chave de idempotência já usada com outro conteúdo.', 'record', null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group_id::text, 0));
  select * into v_group from public.groups where id = v_group_id for update;
  v_bootstrap := not found and v_kind = 'group' and v_entity_id = v_group_id and v_expected = 0;
  if v_group.id is null and not v_bootstrap then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if v_group.id is not null then
    if not private.can_manage_group(v_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    v_revision := v_group.revision;
  end if;
  select * into v_record from public.draft_records where group_id = v_group_id and id = v_entity_id;
  if found then v_version := v_record.version; end if;
  v_error := private.draft_validation_error(v_kind, v_data);
  if v_error is null and v_kind = 'group' and v_entity_id <> v_group_id then v_error := 'O identificador do grupo precisa corresponder ao grupo.'; end if;
  if v_error is null and v_record.id is not null and v_record.kind <> v_kind then v_error := 'O tipo de uma entidade não pode ser alterado.'; end if;
  if v_error is null and v_expected <> v_version then
    v_status := 'conflict'; v_error := 'A versão mudou em outro aparelho; revise a alteração.';
    if v_record.id is not null then v_record_json := private.record_json(v_record); end if;
  end if;
  if v_error is null then v_error := private.financial_draft_guard_error(v_group_id,v_entity_id,v_kind,v_data); end if;
  if v_error is null and v_kind in ('quota','bet','payment-proposal') then
    v_data := jsonb_set(v_data, '{poolId}', to_jsonb(((v_data ->> 'poolId')::uuid)::text));
    if v_kind in ('quota','payment-proposal') then
      v_data := jsonb_set(v_data, '{personId}', to_jsonb(((v_data ->> 'personId')::uuid)::text));
    end if;
    select * into v_pool from public.draft_records
      where group_id = v_group_id and id = (v_data ->> 'poolId')::uuid and kind = 'pool';
    if not found or v_pool.data ->> 'status' <> 'draft' then v_error := 'Bolão de rascunho não encontrado neste grupo.'; end if;
    if v_error is null and v_kind in ('quota','payment-proposal') then
      select * into v_person from public.draft_records
        where group_id = v_group_id and id = (v_data ->> 'personId')::uuid and kind = 'person';
      if not found then v_error := 'Pessoa não encontrada neste grupo.'; end if;
    end if;
    if v_error is null and v_kind = 'bet' then
      if v_pool.data ->> 'lotteryId' <> v_data ->> 'lotteryId' then v_error := 'Modalidade diferente da modalidade do bolão.'; end if;
      if exists (select 1 from jsonb_array_elements(v_data -> 'authorIds') a where not exists (
        select 1 from public.draft_records where group_id = v_group_id and id = (a.value #>> '{}')::uuid and kind = 'person'
      )) then v_error := 'Autor não encontrado neste grupo.'; end if;
      v_data := jsonb_set(v_data, '{numbers}', (select jsonb_agg((value #>> '{}')::numeric::integer order by (value #>> '{}')::numeric::integer) from jsonb_array_elements(v_data -> 'numbers')));
      v_data := jsonb_set(v_data, '{authorIds}', (select coalesce(jsonb_agg(((value #>> '{}')::uuid)::text order by ordinality), '[]'::jsonb)
        from jsonb_array_elements(v_data -> 'authorIds') with ordinality));
      if v_data -> 'seed' <> 'null'::jsonb then v_data := jsonb_set(v_data, '{seed}', to_jsonb(lower(v_data ->> 'seed'))); end if;
      if exists (select 1 from public.draft_records where group_id = v_group_id and kind = 'bet' and id <> v_entity_id
        and (data ->> 'poolId')::uuid = (v_data ->> 'poolId')::uuid and data -> 'numbers' = v_data -> 'numbers') then v_error := 'Jogo já existente neste bolão; associe os autores ao jogo existente.'; end if;
      if v_record.id is null and (select count(*) from public.draft_records where group_id = v_group_id and kind = 'bet'
        and (data ->> 'poolId')::uuid = (v_data ->> 'poolId')::uuid) >= 1000 then v_error := 'Limite operacional de 1.000 jogos por bolão atingido.'; end if;
    end if;
    if v_error is null and v_kind = 'quota' and exists (
      select 1 from public.draft_records where group_id = v_group_id and kind = 'quota' and id <> v_entity_id
        and (data ->> 'poolId')::uuid = (v_data ->> 'poolId')::uuid and (data ->> 'personId')::uuid = (v_data ->> 'personId')::uuid
    ) then v_error := 'Pessoa já possui uma cota de rascunho neste bolão.'; end if;
    if v_error is null and v_kind = 'quota' then
      if v_person.data -> 'adultDeclared' is distinct from 'true'::jsonb then
        v_error := 'A pessoa precisa ter a declaração de maioridade registrada antes de receber uma cota.';
      elsif ((v_pool.data ->> 'quotaPriceCents')::numeric * (v_data ->> 'units')::numeric) % 100 <> 0 then
        v_error := 'Essa fração de cota resulta em uma fração de centavo; ajuste o preço ou a cota.';
      elsif (select count(*) from public.draft_records where group_id = v_group_id and kind = 'quota' and id <> v_entity_id
        and (data ->> 'poolId')::uuid = (v_data ->> 'poolId')::uuid) >= 200 then
        -- Excluding the current entity allows edits at capacity and checks moves to another pool.
        v_error := 'Limite operacional de 200 participantes por bolão atingido.';
      end if;
    end if;
  end if;
  if v_error is null and v_kind = 'pool' and v_record.id is not null
    and v_record.data ->> 'lotteryId' <> v_data ->> 'lotteryId' and exists (
      select 1 from public.draft_records where group_id = v_group_id and kind = 'bet' and (data ->> 'poolId')::uuid = v_entity_id
    ) then v_error := 'Um bolão com jogos não pode mudar de modalidade.'; end if;
  if v_error is null and v_kind = 'pool' and v_record.id is not null
    and v_record.data ->> 'quotaPriceCents' <> v_data ->> 'quotaPriceCents' and exists (
      select 1 from public.draft_records where group_id = v_group_id and kind = 'quota'
        and (data ->> 'poolId')::uuid = v_entity_id
        and ((v_data ->> 'quotaPriceCents')::numeric * (data ->> 'units')::numeric) % 100 <> 0
    ) then v_error := 'O novo preço gera frações de centavo nas cotas existentes; revise o preço ou as cotas.'; end if;
  if v_error is null and (v_version >= 9007199254740991 or v_revision >= 9007199254740991) then v_error := 'Limite de versão atingido.'; end if;
  if v_error is not null and v_status = 'accepted' then v_status := 'rejected'; end if;
  if v_status = 'accepted' then
    if v_bootstrap then
      insert into public.groups(id, name, created_by) values(v_group_id, v_data ->> 'name', v_actor);
      insert into public.group_memberships(group_id, user_id, role) values(v_group_id, v_actor, 'organizer');
    end if;
    update public.groups set revision = revision + 1, name = case when v_kind = 'group' then v_data ->> 'name' else name end
      where id = v_group_id returning revision into v_revision;
    insert into public.draft_records(group_id, id, kind, data, version) values(v_group_id, v_entity_id, v_kind, v_data, v_version + 1)
      on conflict (group_id, id) do update set data = excluded.data, version = excluded.version, updated_at = now()
      returning * into v_record;
    v_version := v_record.version; v_record_json := private.record_json(v_record);
    insert into public.group_changes(group_id, revision, entity_id, record) values(v_group_id, v_revision, v_entity_id, v_record_json);
    select event_hash into v_previous_hash from public.audit_events where group_id = v_group_id order by revision desc limit 1;
    v_previous_hash := coalesce(v_previous_hash, repeat('0', 64));
    v_event := jsonb_build_object('action', 'draft-upsert', 'entityId', v_entity_id, 'kind', v_kind,
      'entityVersion', v_version, 'groupRevision', v_revision, 'actorId', v_actor, 'idempotencyKey', v_key);
    insert into public.audit_events(group_id, revision, actor_id, idempotency_key, event, previous_hash, event_hash)
      values(v_group_id, v_revision, v_actor, v_key, v_event, v_previous_hash,
        encode(sha256(convert_to(v_previous_hash || v_event::text, 'UTF8')), 'hex'));
  end if;
  v_result := jsonb_build_object('idempotencyKey', v_key, 'status', v_status, 'entityId', v_entity_id,
    'serverVersion', v_version, 'groupRevision', v_revision, 'message', v_error, 'record', v_record_json);
  insert into public.command_receipts(actor_id, idempotency_key, group_id, request_payload, response_payload)
    values(v_actor, v_key, v_group_id, p_operation, v_result);
  return v_result;
end;
$$;
