-- Draft replication foundation. There is intentionally no financial confirmation RPC.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.groups (
  id uuid primary key,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  min_available_revision bigint not null default 0 check (min_available_revision between 0 and revision),
  created_at timestamptz not null default now()
);

create table public.group_memberships (
  group_id uuid not null references public.groups(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('organizer', 'participant', 'registrar')),
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_memberships_user_idx on public.group_memberships(user_id, group_id);

create table public.draft_records (
  group_id uuid not null references public.groups(id) on delete restrict,
  id uuid not null,
  kind text not null check (kind in ('group', 'person', 'pool', 'quota', 'bet', 'payment-proposal')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  version bigint not null check (version between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, id),
  check (kind <> 'group' or id = group_id)
);
create index draft_records_kind_idx on public.draft_records(group_id, kind);
create index draft_records_pool_idx on public.draft_records(group_id, (data ->> 'poolId'));

create table public.group_changes (
  group_id uuid not null references public.groups(id) on delete restrict,
  revision bigint not null check (revision between 1 and 9007199254740991),
  entity_id uuid not null,
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  created_at timestamptz not null default now(),
  primary key (group_id, revision)
);

create table public.command_receipts (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  -- No FK: an invalid group-creation command still has a durable rejection receipt.
  group_id uuid not null,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, idempotency_key)
);

create table public.audit_events (
  group_id uuid not null references public.groups(id) on delete restrict,
  revision bigint not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  event jsonb not null,
  previous_hash text not null,
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (group_id, revision),
  foreign key (group_id, revision) references public.group_changes(group_id, revision) on delete restrict
);

-- Future review_decide will write here transactionally. sync_push cannot write here.
create table public.confirmed_payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  person_id uuid not null,
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid not null references auth.users(id) on delete restrict,
  receipt_id uuid not null unique references public.command_receipts(id) on delete restrict,
  foreign key (group_id, pool_id) references public.draft_records(group_id, id) on delete restrict,
  foreign key (group_id, person_id) references public.draft_records(group_id, id) on delete restrict
);

create function private.is_human_session() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and coalesce(auth.jwt() ->> 'session_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'false'
    and not (auth.jwt() ? 'client_id')
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'actor_type', 'human') = 'human';
$$;

create function private.require_human() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not private.is_human_session() then
    raise exception 'human_session_required' using errcode = '42501';
  end if;
end;
$$;

-- SECURITY DEFINER avoids recursive membership policies; all callers are checked.
create function private.is_member(p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_human_session() and exists (
    select 1 from public.group_memberships m
    where m.group_id = p_group_id and m.user_id = auth.uid()
  );
$$;

create function private.can_manage_group(p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_human_session() and exists (
    select 1 from public.group_memberships m
    where m.group_id = p_group_id and m.user_id = auth.uid() and m.role = 'organizer'
  );
$$;

create function private.can_read_receipt(p_actor_id uuid, p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_human_session() and p_actor_id = auth.uid() and
    (private.can_manage_group(p_group_id) or not exists (select 1 from public.groups where id = p_group_id));
$$;

create function private.exact_keys(p_data jsonb, p_keys text[]) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_data) = 'object' then
    (select count(*) = cardinality(p_keys) and bool_and(k = any(p_keys)) from jsonb_object_keys(p_data) as keys(k))
    else false end;
$$;

create function private.json_text(p_value jsonb, p_max integer, p_nonempty boolean default false) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value) = 'string'
    -- Match JavaScript UTF-16 string.length, including supplementary Unicode characters.
    and (select coalesce(sum(case when ascii(ch) > 65535 then 2 else 1 end),0)
      from regexp_split_to_table(p_value #>> '{}', '') as chars(ch)) <= p_max
    and (not p_nonempty or char_length(btrim(p_value #>> '{}')) > 0), false);
$$;

create function private.json_uuid(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
$$;

create function private.json_integer(p_value jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'number' then
    (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
    and (p_value #>> '{}')::numeric between p_min and p_max
    else false end;
$$;

create function private.json_money(p_value jsonb, p_positive boolean default false) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if not private.json_text(p_value, 16) or (p_value #>> '{}') !~ '^(0|[1-9][0-9]*)$' then return false; end if;
  return (p_value #>> '{}')::numeric between (case when p_positive then 1 else 0 end) and 9007199254740991;
end;
$$;

create function private.json_timestamp(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_time timestamptz;
begin
  if not private.json_text(p_value, 40) or (p_value #>> '{}') !~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$'
    then return false; end if;
  v_time := (p_value #>> '{}')::timestamptz;
  return isfinite(v_time) and to_char(v_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') = substring(p_value #>> '{}',1,19);
exception when invalid_datetime_format or datetime_field_overflow then return false;
end;
$$;

create function private.draft_validation_error(p_kind text, p_data jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_min integer; v_max integer; v_universe integer; v_item jsonb;
begin
  case p_kind
  when 'group' then
    if private.exact_keys(p_data, array['name','statute']) is not true
      or not private.json_text(p_data -> 'name', 120, true)
      or not private.json_text(p_data -> 'statute', 12000) then return 'Grupo inválido.'; end if;
  when 'person' then
    if private.exact_keys(p_data, array['name','nickname','adultDeclared']) is not true
      or not private.json_text(p_data -> 'name', 120, true)
      or not private.json_text(p_data -> 'nickname', 80)
      or jsonb_typeof(p_data -> 'adultDeclared') is distinct from 'boolean' then return 'Pessoa inválida.'; end if;
  when 'pool' then
    if private.exact_keys(p_data, array['title','lotteryId','contestNumber','deadlineAt','quotaPriceCents','participationMode','status']) is not true
      or not private.json_text(p_data -> 'title', 160, true)
      or (p_data ->> 'lotteryId' in ('mega-sena','lotofacil','quina')) is not true
      or (p_data ->> 'participationMode' in ('undecided','internal','official')) is not true
      or (p_data ->> 'status' = 'draft') is not true
      or not private.json_money(p_data -> 'quotaPriceCents', true)
      or (p_data -> 'contestNumber' <> 'null'::jsonb and not private.json_integer(p_data -> 'contestNumber', 1, 9007199254740991))
      or (p_data -> 'deadlineAt' <> 'null'::jsonb and not private.json_timestamp(p_data -> 'deadlineAt'))
      then return 'Bolão inválido; sincronização aceita apenas rascunhos.'; end if;
  when 'quota' then
    if private.exact_keys(p_data, array['poolId','personId','units']) is not true
      or not private.json_uuid(p_data -> 'poolId') or not private.json_uuid(p_data -> 'personId')
      or not private.json_integer(p_data -> 'units', 1, 1000000) then return 'Cota de rascunho inválida.'; end if;
  when 'payment-proposal' then
    if private.exact_keys(p_data, array['poolId','personId','amountCents','note','status']) is not true
      or not private.json_uuid(p_data -> 'poolId') or not private.json_uuid(p_data -> 'personId')
      or not private.json_money(p_data -> 'amountCents', true) or not private.json_text(p_data -> 'note', 2000)
      or (p_data ->> 'status' in ('pending','needs-review','rejected')) is not true
      then return 'Proposta inválida; nenhum pagamento é confirmado pela sincronização.'; end if;
  when 'bet' then
    if private.exact_keys(p_data, array['poolId','lotteryId','numbers','authorIds','catalogVersion','seed','generationAlgorithmVersion']) is not true
      or not private.json_uuid(p_data -> 'poolId')
      or (p_data ->> 'catalogVersion' = 'caixa-basic-2026-10-07-v1') is not true
      or (p_data -> 'seed' <> 'null'::jsonb and (jsonb_typeof(p_data -> 'seed') <> 'string' or (p_data ->> 'seed') !~ '^[0-9a-fA-F]{64}$'
        or (p_data ->> 'generationAlgorithmVersion' = 'chacha20-lexicographic-rank-v1') is not true))
      or (p_data -> 'seed' = 'null'::jsonb and p_data -> 'generationAlgorithmVersion' <> 'null'::jsonb)
      or jsonb_typeof(p_data -> 'numbers') is distinct from 'array'
      or jsonb_typeof(p_data -> 'authorIds') is distinct from 'array' then return 'Jogo inválido.'; end if;
    case p_data ->> 'lotteryId'
      when 'mega-sena' then v_min := 6; v_max := 20; v_universe := 60;
      when 'lotofacil' then v_min := 15; v_max := 20; v_universe := 25;
      when 'quina' then v_min := 5; v_max := 15; v_universe := 80;
      else return 'Modalidade inválida.';
    end case;
    if jsonb_array_length(p_data -> 'numbers') not between v_min and v_max
      or jsonb_array_length(p_data -> 'authorIds') > 200 then return 'Quantidade de números ou autores inválida.'; end if;
    for v_item in select value from jsonb_array_elements(p_data -> 'numbers') loop
      if not private.json_integer(v_item, 1, v_universe) then return 'Número fora do intervalo.'; end if;
    end loop;
    if (select count(*) <> count(distinct (value #>> '{}')::numeric::integer) from jsonb_array_elements(p_data -> 'numbers')) then
      return 'Jogo com números repetidos.';
    end if;
    for v_item in select value from jsonb_array_elements(p_data -> 'authorIds') loop
      if not private.json_uuid(v_item) then return 'Autor inválido.'; end if;
    end loop;
    if (select count(*) <> count(distinct (value #>> '{}')::uuid) from jsonb_array_elements(p_data -> 'authorIds')) then
      return 'Autor repetido.';
    end if;
  else return 'Tipo de rascunho inválido.';
  end case;
  return null;
end;
$$;

create function private.record_json(p_record public.draft_records) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_record.id, 'groupId', p_record.group_id, 'kind', p_record.kind,
    'data', p_record.data, 'localVersion', p_record.version, 'serverVersion', p_record.version, 'state', 'synced',
    'createdAt', to_char(p_record.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(p_record.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;

create function private.prevent_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'append_only_record' using errcode = '42501'; end;
$$;
create trigger receipts_append_only before update or delete on public.command_receipts for each row execute function private.prevent_mutation();
create trigger changes_append_only before update or delete on public.group_changes for each row execute function private.prevent_mutation();
create trigger audit_append_only before update or delete on public.audit_events for each row execute function private.prevent_mutation();
create trigger confirmed_payments_append_only before update or delete on public.confirmed_payments for each row execute function private.prevent_mutation();

create function public.sync_push(p_operation jsonb) returns jsonb
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

create function public.sync_pull(p_group_id uuid, p_cursor bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_group public.groups; v_changes jsonb; v_next bigint; v_count integer;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  select * into v_group from public.groups where id = p_group_id;
  if p_cursor is null or p_cursor < 0 or p_cursor > v_group.revision then raise exception 'invalid_cursor' using errcode = '22023'; end if;
  if p_cursor < v_group.min_available_revision then raise exception 'cursor_expired_reload_required' using errcode = 'P0001'; end if;
  -- The captured committed head bounds later statements; never return a half revision.
  with page as (
    select revision, record from public.group_changes where group_id = p_group_id and revision > p_cursor and revision <= v_group.revision
    order by revision limit 201
  ), visible as (select * from page order by revision limit 200)
  select coalesce((select jsonb_agg(jsonb_build_object('groupRevision', revision, 'record', record) order by revision) from visible), '[]'::jsonb),
    coalesce((select max(revision) from visible), p_cursor), (select count(*) from page)
    into v_changes, v_next, v_count;
  return jsonb_build_object('groupId', p_group_id, 'changes', v_changes, 'nextCursor', v_next, 'hasMore', v_count > 200);
end;
$$;

create function public.command_status(p_idempotency_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_receipt public.command_receipts;
begin
  perform private.require_human();
  select * into v_receipt from public.command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if exists (select 1 from public.groups where id = v_receipt.group_id) and not private.can_manage_group(v_receipt.group_id) then
    raise exception 'group_access_denied' using errcode = '42501';
  end if;
  return v_receipt.response_payload;
end;
$$;

create function public.sync_groups() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  return jsonb_build_object('groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
    'role', m.role, 'groupRevision', g.revision) order by g.created_at, g.id)
    from public.groups g join public.group_memberships m on m.group_id = g.id where m.user_id = auth.uid()), '[]'::jsonb));
end;
$$;

alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;
alter table public.draft_records enable row level security;
alter table public.group_changes enable row level security;
alter table public.command_receipts enable row level security;
alter table public.audit_events enable row level security;
alter table public.confirmed_payments enable row level security;

-- Roles other than organizer have no private-record access until scoped invitation views exist.
create policy groups_read_member on public.groups for select to authenticated using (private.is_member(id));
create policy memberships_read_self on public.group_memberships for select to authenticated using (private.is_human_session() and user_id = auth.uid());
create policy drafts_read_organizer on public.draft_records for select to authenticated using (private.can_manage_group(group_id));
create policy changes_read_organizer on public.group_changes for select to authenticated using (private.can_manage_group(group_id));
create policy audit_read_organizer on public.audit_events for select to authenticated using (private.can_manage_group(group_id));
create policy payments_read_organizer on public.confirmed_payments for select to authenticated using (private.can_manage_group(group_id));
create policy receipts_read_self on public.command_receipts for select to authenticated using (private.can_read_receipt(actor_id, group_id));

-- All mutations go through checked RPCs. Do not grant users blanket table writes.
revoke all on public.groups, public.group_memberships, public.draft_records, public.group_changes,
  public.command_receipts, public.audit_events, public.confirmed_payments from anon, authenticated;
grant select on public.groups, public.group_memberships, public.draft_records, public.group_changes,
  public.command_receipts, public.audit_events, public.confirmed_payments to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_human_session(), private.is_member(uuid), private.can_manage_group(uuid), private.can_read_receipt(uuid,uuid) to authenticated;
revoke all on function public.sync_push(jsonb), public.sync_pull(uuid,bigint), public.command_status(uuid), public.sync_groups() from public, anon;
grant execute on function public.sync_push(jsonb), public.sync_pull(uuid,bigint), public.command_status(uuid), public.sync_groups() to authenticated;

-- Private immutable originals. Object key: <group UUID>/<file UUID>.<allowed extension>.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values('evidence', 'evidence', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf']);

create function private.evidence_group(p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp|pdf)$' then return null; end if;
  return split_part(p_name, '/', 1)::uuid;
end;
$$;
revoke all on function private.evidence_group(text) from public, anon;
grant execute on function private.evidence_group(text) to authenticated;
create policy evidence_read_organizer on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and private.can_manage_group(private.evidence_group(name)));
create policy evidence_upload_organizer on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and private.can_manage_group(private.evidence_group(name)));
-- No UPDATE or DELETE policy: uploaded originals cannot be replaced through a browser.
