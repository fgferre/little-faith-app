-- Private original evidence and human observed registration. Earlier migrations stay immutable.
create table public.evidence_originals (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  original_name text not null check (char_length(original_name) between 1 and 200 and position('/' in original_name) = 0 and position(chr(92) in original_name) = 0),
  storage_path text not null unique,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  uploaded_at timestamptz not null,
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  unique (group_id,id),
  unique (group_id,pool_id,id)
);
create trigger evidence_originals_append_only before update or delete on public.evidence_originals for each row execute function private.prevent_mutation();

create table public.registration_command_receipts (
  id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  group_id uuid not null references public.groups(id) on delete restrict,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null,
  unique (actor_id,idempotency_key)
);
create trigger registration_receipts_append_only before update or delete on public.registration_command_receipts for each row execute function private.prevent_mutation();

create unique index pool_manifests_group_pool_id_idx on public.pool_manifests(group_id,pool_id,id);
create table public.registration_reports (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  pool_version bigint not null check (pool_version between 1 and 9007199254740991),
  manifest_id uuid not null,
  items jsonb not null,
  reason text not null check (char_length(reason) <= 2000),
  calendar jsonb,
  comparison jsonb not null,
  confirmed_at timestamptz not null,
  receipt_id uuid not null references public.registration_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,pool_id,manifest_id) references public.pool_manifests(group_id,pool_id,id) on delete restrict,
  unique (group_id,id),
  unique (group_id,pool_id,version)
);
create trigger registration_reports_append_only before update or delete on public.registration_reports for each row execute function private.prevent_mutation();

create table public.result_command_receipts (
  id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  group_id uuid not null references public.groups(id) on delete restrict,
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null,
  unique (actor_id,idempotency_key)
);
create table public.contest_result_versions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  data jsonb not null,
  source text not null check (source in ('caixa','manual')),
  source_url text,
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  raw_text text not null check (octet_length(raw_text) between 1 and 1048576),
  sha256 text not null check (sha256 = encode(sha256(convert_to(raw_text,'UTF8')),'hex')),
  collected_at timestamptz not null,
  status text not null check (status in ('waiting','numbers-only','complete','manual')),
  receipt_id uuid references public.result_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  check ((source = 'manual' and receipt_id is not null and source_url is null and status = 'manual') or (source = 'caixa' and receipt_id is null and source_url is not null and status <> 'manual')),
  unique (group_id,pool_id,id),
  unique (group_id,pool_id,version)
);
create table public.result_selections (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  result_id uuid not null,
  observed_result_ids jsonb not null,
  reason text not null check (char_length(reason) between 1 and 2000),
  selected_at timestamptz not null,
  receipt_id uuid not null references public.result_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id,result_id) references public.contest_result_versions(group_id,pool_id,id) on delete restrict,
  unique (group_id,pool_id,version)
);
create table public.contest_calendar_versions (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  lottery_id text not null check (lottery_id in ('mega-sena','lotofacil','quina')),
  contest_number bigint not null check (contest_number between 1 and 999999),
  source text not null check (source in ('caixa','manual')),
  source_url text,
  source_reference text not null check (char_length(source_reference) between 1 and 2000),
  raw_text text not null check (octet_length(raw_text) between 1 and 1048576),
  sha256 text not null check (sha256 = encode(sha256(convert_to(raw_text,'UTF8')),'hex')),
  collected_at timestamptz not null,
  time_zone text not null default 'America/Sao_Paulo' check (time_zone = 'America/Sao_Paulo'),
  draw_date date,
  expected_draw_at timestamptz,
  registration_closes_at timestamptz,
  receipt_id uuid references public.result_command_receipts(id) deferrable initially deferred,
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  check ((source = 'manual' and receipt_id is not null and source_url is null) or (source = 'caixa' and receipt_id is null and source_url is not null)),
  unique (group_id,pool_id,id),
  unique (group_id,pool_id,version)
);
create table public.result_collection_jobs (
  group_id uuid not null,
  pool_id uuid not null,
  calendar_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  expected_draw_at timestamptz not null,
  next_attempt_at timestamptz not null,
  morning_check_at timestamptz not null,
  morning_checked boolean not null default false,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  primary key (group_id,pool_id),
  foreign key (group_id,pool_id,calendar_id) references public.contest_calendar_versions(group_id,pool_id,id) on delete restrict
);
create table public.result_collection_attempts (
  id uuid primary key,
  group_id uuid not null,
  pool_id uuid not null,
  attempted_at timestamptz not null,
  outcome text not null check (outcome in ('success','http-error','invalid-source','unavailable')),
  error_code text not null check (char_length(error_code) <= 100),
  source_url text,
  raw_text text check (octet_length(raw_text) <= 1048576),
  sha256 text check (sha256 = encode(sha256(convert_to(raw_text,'UTF8')),'hex')),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict
);
create trigger result_receipts_append_only before update or delete on public.result_command_receipts for each row execute function private.prevent_mutation();
create trigger results_append_only before update or delete on public.contest_result_versions for each row execute function private.prevent_mutation();
create trigger result_selections_append_only before update or delete on public.result_selections for each row execute function private.prevent_mutation();
create trigger calendars_append_only before update or delete on public.contest_calendar_versions for each row execute function private.prevent_mutation();
create trigger collection_attempts_append_only before update or delete on public.result_collection_attempts for each row execute function private.prevent_mutation();

create function private.advance_fact_revision(p_group uuid,p_pool uuid,p_actor uuid,p_key uuid,p_action text,p_extra jsonb default '{}') returns bigint
language plpgsql set search_path = '' as $$
declare v_revision bigint; v_record jsonb; v_previous text; v_event jsonb;
begin
  update public.groups set revision = revision+1 where id = p_group and revision < 9007199254740991 returning revision into v_revision;
  if v_revision is null then raise exception 'group_revision_exhausted' using errcode = '22023'; end if;
  select private.record_json(d) into v_record from public.draft_records d where group_id = p_group and id = p_pool and kind = 'pool';
  insert into public.group_changes(group_id,revision,entity_id,record) values(p_group,v_revision,p_pool,v_record);
  select event_hash into v_previous from public.audit_events where group_id = p_group order by revision desc limit 1;
  v_previous := coalesce(v_previous,repeat('0',64));
  v_event := jsonb_build_object('action',p_action,'groupRevision',v_revision,'poolId',p_pool,'actorId',p_actor,'idempotencyKey',p_key) || p_extra;
  insert into public.audit_events(group_id,revision,actor_id,idempotency_key,event,previous_hash,event_hash)
    values(p_group,v_revision,p_actor,p_key,v_event,v_previous,encode(sha256(convert_to(v_previous || v_event::text,'UTF8')),'hex'));
  return v_revision;
end;
$$;

create function private.evidence_json(p_evidence public.evidence_originals) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id',p_evidence.id,'groupId',p_evidence.group_id,'poolId',p_evidence.pool_id,'sha256',p_evidence.sha256,
    'mimeType',p_evidence.mime_type,'byteSize',p_evidence.byte_size,'originalName',p_evidence.original_name,
    'storagePath',p_evidence.storage_path,'uploadedByUserId',p_evidence.uploaded_by,'uploadedAt',private.utc_json(p_evidence.uploaded_at));
$$;
create function private.evidence_request_error(p_metadata jsonb) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if private.exact_keys(p_metadata,array['id','groupId','poolId','sha256','mimeType','byteSize','originalName']) is not true
    or not private.json_uuid(p_metadata -> 'id') or not private.json_uuid(p_metadata -> 'groupId') or not private.json_uuid(p_metadata -> 'poolId')
    or jsonb_typeof(p_metadata -> 'sha256') <> 'string' or p_metadata ->> 'sha256' !~* '^[0-9a-f]{64}$'
    or (p_metadata ->> 'mimeType' in ('application/pdf','image/jpeg','image/png','image/webp')) is not true
    or not private.json_integer(p_metadata -> 'byteSize',1,10485760)
    or not private.json_text(p_metadata -> 'originalName',200,true) or private.js_trim(p_metadata ->> 'originalName') = ''
    or position('/' in (p_metadata ->> 'originalName')) > 0 or position(chr(92) in (p_metadata ->> 'originalName')) > 0
    or p_metadata ->> 'originalName' ~ '[[:cntrl:]]' or private.js_trim(p_metadata ->> 'originalName') in ('.','..')
    then return 'Metadados do original inválidos.'; end if;
  return null;
end;
$$;
create function private.evidence_path(p_metadata jsonb) returns text
language sql immutable set search_path = '' as $$
  select lower(p_metadata ->> 'groupId') || '/' || lower(p_metadata ->> 'id') ||
    case p_metadata ->> 'mimeType' when 'application/pdf' then '.pdf' when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/webp' then '.webp' end;
$$;

create function public.evidence_upload_context(p_metadata jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_existing public.evidence_originals; v_group uuid; v_pool uuid;
begin
  perform private.require_human();
  if private.evidence_request_error(p_metadata) is not null then raise exception 'invalid_evidence_metadata' using errcode = '22023'; end if;
  v_group := (p_metadata ->> 'groupId')::uuid; v_pool := (p_metadata ->> 'poolId')::uuid;
  if not private.can_manage_group(v_group) or not exists (select 1 from public.draft_records where group_id = v_group and id = v_pool and kind = 'pool')
    then raise exception 'group_access_denied' using errcode = '42501'; end if;
  select * into v_existing from public.evidence_originals where id = (p_metadata ->> 'id')::uuid;
  if found then
    if v_existing.group_id <> v_group or v_existing.pool_id <> v_pool or v_existing.sha256 <> lower(p_metadata ->> 'sha256')
      or v_existing.mime_type <> p_metadata ->> 'mimeType' or v_existing.byte_size <> (p_metadata ->> 'byteSize')::integer
      or v_existing.original_name <> p_metadata ->> 'originalName' or v_existing.uploaded_by <> auth.uid()
      then raise exception 'evidence_id_payload_mismatch' using errcode = '22023'; end if;
    return jsonb_build_object('storagePath',v_existing.storage_path,'evidence',private.evidence_json(v_existing));
  end if;
  return jsonb_build_object('storagePath',private.evidence_path(p_metadata),'evidence',null);
end;
$$;

-- Only a trusted server can attest bytes. A human RPC cannot forge the verified hash.
create function public.evidence_seal(p_metadata jsonb,p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_existing public.evidence_originals; v_group uuid; v_pool uuid; v_path text;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if private.evidence_request_error(p_metadata) is not null then raise exception 'invalid_evidence_metadata' using errcode = '22023'; end if;
  v_group := (p_metadata ->> 'groupId')::uuid; v_pool := (p_metadata ->> 'poolId')::uuid; v_path := private.evidence_path(p_metadata);
  if not exists (select 1 from auth.users u join public.group_memberships m on m.user_id = u.id
    where u.id = p_actor_id and m.group_id = v_group and m.role = 'organizer' and coalesce(u.raw_app_meta_data ->> 'actor_type','human') = 'human')
    or not exists (select 1 from public.draft_records where group_id = v_group and id = v_pool and kind = 'pool') then raise exception 'group_access_denied' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('evidence:' || (p_metadata ->> 'id')::uuid::text,0));
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  perform 1 from public.groups where id = v_group for update;
  select * into v_existing from public.evidence_originals where id = (p_metadata ->> 'id')::uuid;
  if found then
    if v_existing.group_id <> v_group or v_existing.pool_id <> v_pool or v_existing.sha256 <> lower(p_metadata ->> 'sha256')
      or v_existing.mime_type <> p_metadata ->> 'mimeType' or v_existing.byte_size <> (p_metadata ->> 'byteSize')::integer
      or v_existing.original_name <> p_metadata ->> 'originalName' or v_existing.uploaded_by <> p_actor_id
      then raise exception 'evidence_id_payload_mismatch' using errcode = '22023'; end if;
    return private.evidence_json(v_existing);
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'evidence' and name = v_path) then raise exception 'original_missing_in_storage' using errcode = '22023'; end if;
  if (select count(*) from public.evidence_originals where group_id = v_group) >= 10000 then raise exception 'evidence_count_limit' using errcode = '22023'; end if;
  insert into public.evidence_originals(id,group_id,pool_id,sha256,mime_type,byte_size,original_name,storage_path,uploaded_by,uploaded_at)
    values((p_metadata ->> 'id')::uuid,v_group,v_pool,lower(p_metadata ->> 'sha256'),p_metadata ->> 'mimeType',(p_metadata ->> 'byteSize')::integer,
      p_metadata ->> 'originalName',v_path,p_actor_id,clock_timestamp()) returning * into v_existing;
  perform private.advance_fact_revision(v_group,v_pool,p_actor_id,v_existing.id,'evidence_upload',jsonb_build_object('evidenceId',v_existing.id,'sha256',v_existing.sha256));
  return private.evidence_json(v_existing);
end;
$$;
create function public.evidence_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_existing public.evidence_originals;
begin
  perform private.require_human();
  select * into v_existing from public.evidence_originals where id = p_id and private.can_manage_group(group_id);
  if not found then return null; end if;
  return private.evidence_json(v_existing);
end;
$$;

create function private.guard_sealed_original() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (old.bucket_id = 'evidence' and private.evidence_group(old.name) is not null)
    or (tg_op = 'UPDATE' and new.bucket_id = 'evidence' and private.evidence_group(new.name) is not null) then
    raise exception 'O original privado não pode ser substituído ou excluído, inclusive antes do selo.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger sealed_evidence_objects_guard before update or delete on storage.objects for each row execute function private.guard_sealed_original();
create policy evidence_no_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'evidence') with check (bucket_id <> 'evidence');
create policy evidence_no_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'evidence');

create function private.json_calendar_date(p_value jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_date date;
begin
  if jsonb_typeof(p_value) is distinct from 'string' or p_value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  v_date := (p_value #>> '{}')::date;
  return to_char(v_date,'YYYY-MM-DD') = p_value #>> '{}';
exception when others then return false;
end;
$$;
create function private.result_data_error(p_data jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_size integer; v_max integer; v_min_hits integer; v_item jsonb;
begin
  if private.exact_keys(p_data,array['lotteryId','contestNumber','drawDate','drawnNumbers','payouts']) is not true
    or (p_data ->> 'lotteryId' in ('mega-sena','lotofacil','quina')) is not true or not private.json_integer(p_data -> 'contestNumber',1,999999)
    or (p_data -> 'drawDate' <> 'null'::jsonb and not private.json_calendar_date(p_data -> 'drawDate')) then return 'Modalidade, concurso ou data do resultado inválidos.'; end if;
  v_size := case p_data ->> 'lotteryId' when 'mega-sena' then 6 when 'lotofacil' then 15 else 5 end;
  v_max := case p_data ->> 'lotteryId' when 'mega-sena' then 60 when 'lotofacil' then 25 else 80 end;
  v_min_hits := case p_data ->> 'lotteryId' when 'mega-sena' then 4 when 'lotofacil' then 11 else 2 end;
  if p_data -> 'drawnNumbers' <> 'null'::jsonb then
    if jsonb_typeof(p_data -> 'drawnNumbers') <> 'array' or jsonb_array_length(p_data -> 'drawnNumbers') <> v_size
      or exists (select 1 from jsonb_array_elements(p_data -> 'drawnNumbers') where not private.json_integer(value,1,v_max))
      or (select count(distinct value) from jsonb_array_elements(p_data -> 'drawnNumbers')) <> v_size then return 'Dezenas sorteadas incompletas ou inválidas.'; end if;
  end if;
  if p_data -> 'payouts' <> 'null'::jsonb then
    if jsonb_typeof(p_data -> 'payouts') <> 'array' or jsonb_array_length(p_data -> 'payouts') > v_size-v_min_hits+1
      then return 'Informe todas as faixas do rateio, usando null para valores ainda não publicados.'; end if;
    for v_item in select value from jsonb_array_elements(p_data -> 'payouts') loop
      if private.exact_keys(v_item,array['hits','winnerCount','prizeCents']) is not true or not private.json_integer(v_item -> 'hits',v_min_hits,v_size)
        or (v_item -> 'winnerCount' <> 'null'::jsonb and (jsonb_typeof(v_item -> 'winnerCount') <> 'string' or v_item ->> 'winnerCount' !~ '^(0|[1-9][0-9]{0,99})$'))
        or (v_item -> 'prizeCents' <> 'null'::jsonb and (jsonb_typeof(v_item -> 'prizeCents') <> 'string' or v_item ->> 'prizeCents' !~ '^(0|[1-9][0-9]{0,99})$')) then return 'Faixa, ganhadores ou prêmio do rateio inválidos.'; end if;
    end loop;
    if (select count(distinct value -> 'hits') from jsonb_array_elements(p_data -> 'payouts')) <> jsonb_array_length(p_data -> 'payouts') then return 'Uma faixa do rateio foi repetida.'; end if;
  end if;
  return null;
end;
$$;
create function private.normalize_result_data(p_data jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_data jsonb := p_data; v_array jsonb; v_size integer; v_min_hits integer;
begin
  if p_data -> 'drawnNumbers' <> 'null'::jsonb then
    select jsonb_agg(value order by (value #>> '{}')::integer) into v_array from jsonb_array_elements(p_data -> 'drawnNumbers');
    v_data := jsonb_set(v_data,'{drawnNumbers}',v_array);
  end if;
  if p_data -> 'payouts' <> 'null'::jsonb then
    v_size := case p_data ->> 'lotteryId' when 'mega-sena' then 6 when 'lotofacil' then 15 else 5 end;
    v_min_hits := case p_data ->> 'lotteryId' when 'mega-sena' then 4 when 'lotofacil' then 11 else 2 end;
    select jsonb_agg(jsonb_build_object('hits',s.hits,'winnerCount',p.value -> 'winnerCount','prizeCents',p.value -> 'prizeCents') order by s.hits desc)
      into v_array from generate_series(v_size,v_min_hits,-1) s(hits) left join lateral (
        select value from jsonb_array_elements(p_data -> 'payouts') where (value ->> 'hits')::integer = s.hits) p on true;
    v_data := jsonb_set(v_data,'{payouts}',v_array);
  end if;
  return v_data;
end;
$$;
create function private.caixa_source_url(p_lottery text,p_contest bigint) returns text
language sql immutable set search_path = '' as $$
  select 'https://servicebus2.caixa.gov.br/portaldeloterias/api/' ||
    case p_lottery when 'mega-sena' then 'megasena' when 'lotofacil' then 'lotofacil' when 'quina' then 'quina' end || '/' || p_contest::text;
$$;
create function private.result_version_json(p_result public.contest_result_versions) returns jsonb
language sql immutable set search_path = '' as $$
  select p_result.data || jsonb_build_object('id',p_result.id,'groupId',p_result.group_id,'poolId',p_result.pool_id,'version',p_result.version,
    'source',p_result.source,'sourceUrl',p_result.source_url,'sourceReference',p_result.source_reference,'rawText',p_result.raw_text,
    'sha256',p_result.sha256,'collectedAt',private.utc_json(p_result.collected_at),'status',p_result.status,'receiptId',p_result.receipt_id);
$$;
create function private.calendar_version_json(p_calendar public.contest_calendar_versions) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id',p_calendar.id,'groupId',p_calendar.group_id,'poolId',p_calendar.pool_id,'version',p_calendar.version,
    'lotteryId',p_calendar.lottery_id,'contestNumber',p_calendar.contest_number,'source',p_calendar.source,'sourceUrl',p_calendar.source_url,
    'sourceReference',p_calendar.source_reference,'rawText',p_calendar.raw_text,'sha256',p_calendar.sha256,'collectedAt',private.utc_json(p_calendar.collected_at),
    'timeZone',p_calendar.time_zone,'drawDate',to_char(p_calendar.draw_date,'YYYY-MM-DD'),'expectedDrawAt',private.utc_json(p_calendar.expected_draw_at),
    'registrationClosesAt',private.utc_json(p_calendar.registration_closes_at),'receiptId',p_calendar.receipt_id);
$$;
create function private.result_snapshot(p_group uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('groupId',g.id,'groupRevision',g.revision,
    'results',coalesce((select jsonb_agg(private.result_version_json(r) order by r.pool_id,r.version) from public.contest_result_versions r where r.group_id = p_group),'[]'::jsonb),
    'selections',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'groupId',s.group_id,'poolId',s.pool_id,'version',s.version,'resultId',s.result_id,
      'observedResultIds',s.observed_result_ids,'reason',s.reason,'selectedAt',private.utc_json(s.selected_at),'receiptId',s.receipt_id) order by s.pool_id,s.version)
      from public.result_selections s where s.group_id = p_group),'[]'::jsonb),
    'calendarVersions',coalesce((select jsonb_agg(private.calendar_version_json(c) order by c.pool_id,c.version) from public.contest_calendar_versions c where c.group_id = p_group),'[]'::jsonb))
    from public.groups g where g.id = p_group;
$$;
create function public.results_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return private.result_snapshot(p_group_id);
end;
$$;
create function public.result_command_status(p_idempotency_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_receipt public.result_command_receipts;
begin
  perform private.require_human();
  select * into v_receipt from public.result_command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if not private.can_manage_group(v_receipt.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return v_receipt.response_payload;
end;
$$;
create function public.result_collection_context(p_group_id uuid,p_pool_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_pool public.draft_records;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  select * into v_pool from public.draft_records where group_id = p_group_id and id = p_pool_id and kind = 'pool';
  if not found or not private.json_integer(v_pool.data -> 'contestNumber',1,999999) then raise exception 'contest_not_defined' using errcode = '22023'; end if;
  return jsonb_build_object('groupId',p_group_id,'poolId',p_pool_id,'lotteryId',v_pool.data -> 'lotteryId','contestNumber',v_pool.data -> 'contestNumber');
end;
$$;

create function public.result_collect_seal(p_group_id uuid,p_pool_id uuid,p_actor_id uuid,p_parsed jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pool public.draft_records; v_data jsonb; v_result public.contest_result_versions; v_now timestamptz;
  v_raw text; v_hash text; v_url text; v_version bigint; v_calendar_version bigint; v_calendar public.contest_calendar_versions; v_status text;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u join public.group_memberships m on m.user_id = u.id where u.id = p_actor_id and m.group_id = p_group_id
    and m.role = 'organizer' and coalesce(u.raw_app_meta_data ->> 'actor_type','human') = 'human') then raise exception 'group_access_denied' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || p_group_id::text,0));
  perform 1 from public.groups where id = p_group_id for update;
  v_now := clock_timestamp();
  select * into v_pool from public.draft_records where group_id = p_group_id and id = p_pool_id and kind = 'pool';
  v_data := jsonb_build_object('lotteryId',p_parsed -> 'lotteryId','contestNumber',p_parsed -> 'contestNumber','drawDate',p_parsed -> 'drawDate',
    'drawnNumbers',p_parsed -> 'drawnNumbers','payouts',p_parsed -> 'payouts');
  if not found or private.result_data_error(v_data) is not null or v_data -> 'lotteryId' <> v_pool.data -> 'lotteryId'
    or v_data -> 'contestNumber' <> v_pool.data -> 'contestNumber' then raise exception 'invalid_result_scope' using errcode = '22023'; end if;
  v_data := private.normalize_result_data(v_data);
  v_status := case when v_data -> 'drawnNumbers' = 'null'::jsonb then 'waiting'
    when v_data -> 'payouts' <> 'null'::jsonb and not exists (select 1 from jsonb_array_elements(v_data -> 'payouts') where value -> 'prizeCents' = 'null'::jsonb) then 'complete' else 'numbers-only' end;
  v_raw := p_parsed ->> 'rawText'; v_hash := encode(sha256(convert_to(v_raw,'UTF8')),'hex');
  v_url := private.caixa_source_url(v_data ->> 'lotteryId',(v_data ->> 'contestNumber')::bigint);
  if v_raw is null or octet_length(v_raw) not between 1 and 1048576 or v_hash is distinct from p_parsed ->> 'sha256' or p_parsed ->> 'sourceUrl' is distinct from v_url
    or (p_parsed ->> 'status') is distinct from v_status then raise exception 'invalid_official_source' using errcode = '22023'; end if;
  select * into v_result from public.contest_result_versions where group_id = p_group_id and pool_id = p_pool_id and source = 'caixa' and sha256 = v_hash;
  if found then return private.result_snapshot(p_group_id); end if;
  select coalesce(max(version),0)+1 into v_version from public.contest_result_versions where group_id = p_group_id and pool_id = p_pool_id;
  if v_version > 9007199254740991 or (select count(*) from public.contest_result_versions where group_id = p_group_id) >= 10000 then raise exception 'result_version_limit' using errcode = '22023'; end if;
  insert into public.contest_result_versions(id,group_id,pool_id,version,data,source,source_url,source_reference,raw_text,sha256,collected_at,status)
    values(gen_random_uuid(),p_group_id,p_pool_id,v_version,v_data,'caixa',v_url,v_url,v_raw,v_hash,v_now,p_parsed ->> 'status');
  -- The JSON service establishes a Brasília date, never an inferred draw/channel-close time.
  select * into v_calendar from public.contest_calendar_versions where group_id = p_group_id and pool_id = p_pool_id order by version desc limit 1;
  if not found or (v_calendar.source = 'caixa' and v_calendar.draw_date is distinct from (v_data ->> 'drawDate')::date) then
    select coalesce(max(version),0)+1 into v_calendar_version from public.contest_calendar_versions where group_id = p_group_id and pool_id = p_pool_id;
    insert into public.contest_calendar_versions(id,group_id,pool_id,version,lottery_id,contest_number,source,source_url,source_reference,raw_text,sha256,collected_at,draw_date)
      values(gen_random_uuid(),p_group_id,p_pool_id,v_calendar_version,v_data ->> 'lotteryId',(v_data ->> 'contestNumber')::bigint,'caixa',v_url,v_url,v_raw,v_hash,v_now,(v_data ->> 'drawDate')::date);
  end if;
  perform private.advance_fact_revision(p_group_id,p_pool_id,p_actor_id,gen_random_uuid(),'results_collect',jsonb_build_object('resultVersion',v_version,'sha256',v_hash));
  return private.result_snapshot(p_group_id);
end;
$$;

create function private.result_action_error(p_action jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_error text; v_id jsonb;
begin
  if jsonb_typeof(p_action) is distinct from 'object' then return 'Ação de resultado inválida.'; end if;
  if not private.json_uuid(p_action -> 'poolId') or not private.json_integer(p_action -> 'poolVersion',1,9007199254740991)
    or not private.json_text(p_action -> 'reason',2000,true) or private.js_trim(p_action ->> 'reason') = '' then return 'Informe bolão, versão e motivo da decisão.'; end if;
  if p_action ->> 'type' = 'result_manual' then
    if private.exact_keys(p_action,array['type','poolId','poolVersion','data','sourceReference','reason']) is not true
      or not private.json_text(p_action -> 'sourceReference',2000,true) or private.js_trim(p_action ->> 'sourceReference') = '' then return 'Informe a fonte do resultado manual.'; end if;
    v_error := private.result_data_error(p_action -> 'data');
    if v_error is null and p_action -> 'data' -> 'drawnNumbers' = 'null'::jsonb then return 'Um resultado manual exige dezenas efetivamente informadas.'; end if;
    return v_error;
  elsif p_action ->> 'type' = 'result_resolve' then
    if private.exact_keys(p_action,array['type','poolId','poolVersion','resultId','observedResultIds','reason']) is not true
      or not private.json_uuid(p_action -> 'resultId') or jsonb_typeof(p_action -> 'observedResultIds') <> 'array'
      or jsonb_array_length(p_action -> 'observedResultIds') not between 1 and 10000 then return 'Informe a versão escolhida e todas as versões revisadas.'; end if;
    for v_id in select value from jsonb_array_elements(p_action -> 'observedResultIds') loop if not private.json_uuid(v_id) then return 'Versão de resultado inválida.'; end if; end loop;
    if (select count(distinct (value #>> '{}')::uuid) from jsonb_array_elements(p_action -> 'observedResultIds')) <> jsonb_array_length(p_action -> 'observedResultIds') then return 'Uma versão revisada foi repetida.'; end if;
  elsif p_action ->> 'type' = 'calendar_confirm' then
    if private.exact_keys(p_action,array['type','poolId','poolVersion','lotteryId','contestNumber','drawDate','expectedDrawAt','registrationClosesAt','sourceReference','reason']) is not true
      or (p_action ->> 'lotteryId' in ('mega-sena','lotofacil','quina')) is not true or not private.json_integer(p_action -> 'contestNumber',1,999999)
      or not private.json_text(p_action -> 'sourceReference',2000,true) or private.js_trim(p_action ->> 'sourceReference') = ''
      or (p_action -> 'drawDate' <> 'null'::jsonb and not private.json_calendar_date(p_action -> 'drawDate'))
      or (p_action -> 'expectedDrawAt' <> 'null'::jsonb and (not private.json_timestamp(p_action -> 'expectedDrawAt') or p_action ->> 'expectedDrawAt' !~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$'))
      or (p_action -> 'registrationClosesAt' <> 'null'::jsonb and (not private.json_timestamp(p_action -> 'registrationClosesAt') or p_action ->> 'registrationClosesAt' !~ 'T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$')) then return 'Fonte ou horários do calendário inválidos.'; end if;
    if p_action -> 'expectedDrawAt' <> 'null'::jsonb and p_action -> 'drawDate' <> 'null'::jsonb
      and to_char((p_action ->> 'expectedDrawAt')::timestamptz at time zone 'America/Sao_Paulo','YYYY-MM-DD') <> p_action ->> 'drawDate' then return 'A data e o horário precisam corresponder no fuso de Brasília.'; end if;
    if p_action -> 'expectedDrawAt' <> 'null'::jsonb and p_action -> 'registrationClosesAt' <> 'null'::jsonb
      and (p_action ->> 'registrationClosesAt')::timestamptz > (p_action ->> 'expectedDrawAt')::timestamptz then return 'O encerramento do canal não pode ser posterior ao sorteio previsto.'; end if;
  else return 'Ação de resultado não suportada.'; end if;
  return null;
end;
$$;

create function public.result_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid();
  v_saved public.result_command_receipts; v_pool public.draft_records; v_action jsonb; v_revision bigint; v_version bigint;
  v_error text; v_status text := 'accepted'; v_now timestamptz; v_raw text; v_fact_id uuid; v_observed jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_result_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('result:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.result_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de decidir o resultado.';
  else v_error := private.result_action_error(v_action); end if;
  if v_error is null and ((v_action ->> 'type' = 'result_manual' and (select count(*) from public.contest_result_versions where group_id = v_group) >= 10000)
    or (v_action ->> 'type' = 'result_resolve' and (select count(*) from public.result_selections where group_id = v_group) >= 10000)
    or (v_action ->> 'type' = 'calendar_confirm' and (select count(*) from public.contest_calendar_versions where group_id = v_group) >= 10000)) then
    v_error := 'Limite de versões de resultados ou calendário atingido.';
  end if;
  v_now := clock_timestamp();
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; revise a decisão.';
    elsif v_action ->> 'type' = 'result_manual' and (v_action -> 'data' -> 'lotteryId' <> v_pool.data -> 'lotteryId' or v_action -> 'data' -> 'contestNumber' <> v_pool.data -> 'contestNumber')
      then v_error := 'O resultado manual pertence a outra modalidade ou concurso.';
    elsif v_action ->> 'type' = 'calendar_confirm' and (v_action -> 'lotteryId' <> v_pool.data -> 'lotteryId' or v_action -> 'contestNumber' <> v_pool.data -> 'contestNumber')
      then v_error := 'O calendário pertence a outra modalidade ou concurso.';
    elsif v_action ->> 'type' = 'result_resolve' then
      select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into v_observed from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id;
      if v_observed <> (select jsonb_agg(value order by (value #>> '{}')::uuid) from jsonb_array_elements(v_action -> 'observedResultIds'))
        or not exists (select 1 from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id and id = (v_action ->> 'resultId')::uuid)
        then v_error := 'Revise exatamente todas as versões atuais do concurso antes de resolver o conflito.'; end if;
    end if;
  end if;
  if v_error is null then
    v_fact_id := gen_random_uuid();
    if v_action ->> 'type' = 'result_manual' then
      select coalesce(max(version),0)+1 into v_version from public.contest_result_versions where group_id = v_group and pool_id = v_pool_id;
      v_raw := private.canonical_json(v_action);
      insert into public.contest_result_versions(id,group_id,pool_id,version,data,source,source_reference,raw_text,sha256,collected_at,status,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,private.normalize_result_data(v_action -> 'data'),'manual',v_action ->> 'sourceReference',v_raw,encode(sha256(convert_to(v_raw,'UTF8')),'hex'),v_now,'manual',v_receipt);
    elsif v_action ->> 'type' = 'result_resolve' then
      select coalesce(max(version),0)+1 into v_version from public.result_selections where group_id = v_group and pool_id = v_pool_id;
      insert into public.result_selections(id,group_id,pool_id,version,result_id,observed_result_ids,reason,selected_at,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,(v_action ->> 'resultId')::uuid,v_action -> 'observedResultIds',v_action ->> 'reason',v_now,v_receipt);
    else
      select coalesce(max(version),0)+1 into v_version from public.contest_calendar_versions where group_id = v_group and pool_id = v_pool_id;
      v_raw := private.canonical_json(v_action);
      insert into public.contest_calendar_versions(id,group_id,pool_id,version,lottery_id,contest_number,source,source_reference,raw_text,sha256,collected_at,draw_date,expected_draw_at,registration_closes_at,receipt_id)
        values(v_fact_id,v_group,v_pool_id,v_version,v_action ->> 'lotteryId',(v_action ->> 'contestNumber')::bigint,'manual',v_action ->> 'sourceReference',v_raw,
          encode(sha256(convert_to(v_raw,'UTF8')),'hex'),v_now,(v_action ->> 'drawDate')::date,(v_action ->> 'expectedDrawAt')::timestamptz,(v_action ->> 'registrationClosesAt')::timestamptz,v_receipt);
      if v_action -> 'expectedDrawAt' <> 'null'::jsonb then
        insert into public.result_collection_jobs(group_id,pool_id,calendar_id,actor_id,expected_draw_at,next_attempt_at,morning_check_at)
          values(v_group,v_pool_id,v_fact_id,v_actor,(v_action ->> 'expectedDrawAt')::timestamptz,(v_action ->> 'expectedDrawAt')::timestamptz,
            (((v_action ->> 'expectedDrawAt')::timestamptz at time zone 'America/Sao_Paulo')::date + 1 + time '09:00') at time zone 'America/Sao_Paulo')
          on conflict (group_id,pool_id) do update set calendar_id = excluded.calendar_id,actor_id = excluded.actor_id,expected_draw_at = excluded.expected_draw_at,
            next_attempt_at = excluded.next_attempt_at,morning_check_at = excluded.morning_check_at,morning_checked = false;
      else delete from public.result_collection_jobs where group_id = v_group and pool_id = v_pool_id; end if;
    end if;
    v_revision := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,v_action ->> 'type',jsonb_build_object('receiptId',v_receipt,'factId',v_fact_id,'version',v_version));
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  insert into public.result_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
      'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
      'snapshot',private.result_snapshot(v_group)),v_now) returning response_payload into v_action;
  return v_action;
end;
$$;

-- Invocation infrastructure only. No cron schedule is installed by this migration.
create function public.result_jobs_due(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if p_limit not between 1 and 20 then raise exception 'invalid_job_limit' using errcode = '22023'; end if;
  with claimed as (
    update public.result_collection_jobs q set next_attempt_at = clock_timestamp() + interval '5 minutes'
      where (q.group_id,q.pool_id) in (select group_id,pool_id from public.result_collection_jobs where next_attempt_at <= clock_timestamp()
        order by next_attempt_at limit p_limit for update skip locked)
      returning q.*)
    select coalesce(jsonb_agg(jsonb_build_object('groupId',j.group_id,'poolId',j.pool_id,'actorId',j.actor_id,
    'lotteryId',p.data -> 'lotteryId','contestNumber',p.data -> 'contestNumber') order by j.next_attempt_at),'[]'::jsonb) into v_result from claimed j
    join public.draft_records p on p.group_id = j.group_id and p.id = j.pool_id
    join public.group_memberships m on m.group_id = j.group_id and m.user_id = j.actor_id and m.role = 'organizer'
    join auth.users u on u.id = j.actor_id where coalesce(u.raw_app_meta_data ->> 'actor_type','human') = 'human';
  return v_result;
end;
$$;
create function public.result_collection_attempt(p_group_id uuid,p_pool_id uuid,p_outcome text,p_error_code text default '',p_source_url text default null,p_raw_text text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then raise exception 'server_capability_required' using errcode = '42501'; end if;
  if p_source_url is not null and not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_pool_id
    and p_source_url = private.caixa_source_url(data ->> 'lotteryId',(data ->> 'contestNumber')::bigint)) then raise exception 'invalid_source_url' using errcode = '22023'; end if;
  insert into public.result_collection_attempts(id,group_id,pool_id,attempted_at,outcome,error_code,source_url,raw_text,sha256)
    values(gen_random_uuid(),p_group_id,p_pool_id,v_now,p_outcome,left(p_error_code,100),p_source_url,p_raw_text,encode(sha256(convert_to(p_raw_text,'UTF8')),'hex'));
  update public.result_collection_jobs set last_attempt_at = v_now,
    last_success_at = case when p_outcome = 'success' then v_now else last_success_at end,
    morning_checked = morning_checked or v_now >= morning_check_at,
    next_attempt_at = least(v_now + case when v_now < expected_draw_at + interval '24 hours' then interval '5 minutes' else interval '1 hour' end,
      case when not morning_checked and v_now < morning_check_at then morning_check_at else 'infinity'::timestamptz end)
    where group_id = p_group_id and pool_id = p_pool_id;
end;
$$;

alter table public.evidence_originals enable row level security;
alter table public.registration_command_receipts enable row level security;
alter table public.registration_reports enable row level security;
create policy evidence_metadata_read_organizer on public.evidence_originals for select to authenticated using (private.can_manage_group(group_id));
create policy registration_receipts_read_self on public.registration_command_receipts for select to authenticated using (actor_id = auth.uid() and private.can_manage_group(group_id));
create policy registration_reports_read_organizer on public.registration_reports for select to authenticated using (private.can_manage_group(group_id));
revoke all on public.evidence_originals,public.registration_command_receipts,public.registration_reports from anon,authenticated;
grant select on public.evidence_originals,public.registration_command_receipts,public.registration_reports to authenticated;
revoke all on function private.advance_fact_revision(uuid,uuid,uuid,uuid,text,jsonb),private.evidence_json(public.evidence_originals),
  private.evidence_request_error(jsonb),private.evidence_path(jsonb),private.guard_sealed_original() from public,anon,authenticated;
revoke all on function public.evidence_upload_context(jsonb),public.evidence_status(uuid),public.evidence_seal(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.evidence_upload_context(jsonb),public.evidence_status(uuid) to authenticated;
grant execute on function public.evidence_seal(jsonb,uuid) to service_role;

alter table public.result_command_receipts enable row level security;
create policy result_receipts_read_self on public.result_command_receipts for select to authenticated using (actor_id = auth.uid() and private.can_manage_group(group_id));
do $$ declare v_table text; begin
  foreach v_table in array array['contest_result_versions','result_selections','contest_calendar_versions','result_collection_jobs','result_collection_attempts'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('create policy %I on public.%I for select to authenticated using (private.can_manage_group(group_id))',v_table || '_read_organizer',v_table);
  end loop;
end; $$;
revoke all on public.result_command_receipts,public.contest_result_versions,public.result_selections,public.contest_calendar_versions,public.result_collection_jobs,public.result_collection_attempts from anon,authenticated;
grant select on public.result_command_receipts,public.contest_result_versions,public.result_selections,public.contest_calendar_versions,public.result_collection_jobs,public.result_collection_attempts to authenticated;
revoke all on function private.json_calendar_date(jsonb),private.result_data_error(jsonb),private.normalize_result_data(jsonb),private.caixa_source_url(text,bigint),private.result_version_json(public.contest_result_versions),
  private.calendar_version_json(public.contest_calendar_versions),private.result_snapshot(uuid),private.result_action_error(jsonb) from public,anon,authenticated;
revoke all on function public.results_pull(uuid),public.result_command_status(uuid),public.result_collection_context(uuid,uuid),public.result_decide(jsonb),
  public.result_collect_seal(uuid,uuid,uuid,jsonb),public.result_jobs_due(integer),public.result_collection_attempt(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.results_pull(uuid),public.result_command_status(uuid),public.result_collection_context(uuid,uuid),public.result_decide(jsonb) to authenticated;
grant execute on function public.result_collect_seal(uuid,uuid,uuid,jsonb),public.result_jobs_due(integer),public.result_collection_attempt(uuid,uuid,text,text,text,text) to service_role;

alter function private.financial_draft_guard_error(uuid,uuid,text,jsonb) rename to financial_draft_guard_error_registration_base;
create function private.financial_draft_guard_error(p_group uuid,p_id uuid,p_kind text,p_data jsonb) returns text
language plpgsql set search_path = '' as $$
declare v_old public.draft_records;
begin
  select * into v_old from public.draft_records where group_id = p_group and id = p_id;
  if p_kind = 'pool' and v_old.id is not null then
    if (v_old.data -> 'lotteryId' is distinct from p_data -> 'lotteryId' or v_old.data -> 'contestNumber' is distinct from p_data -> 'contestNumber')
      and (exists (select 1 from public.contest_result_versions where group_id = p_group and pool_id = p_id)
        or exists (select 1 from public.contest_calendar_versions where group_id = p_group and pool_id = p_id)) then
      return 'Modalidade e concurso já possuem fonte de resultado ou calendário e estão preservados neste bolão.';
    end if;
    if v_old.data ->> 'status' = 'locked' and p_data ->> 'status' = 'registered'
      and (v_old.data - 'status') = (p_data - 'status')
      and exists (select 1 from public.registration_reports where group_id = p_group and pool_id = p_id and (comparison ->> 'observedTicketCount')::integer > 0) then
      return null;
    end if;
  end if;
  return private.financial_draft_guard_error_registration_base(p_group,p_id,p_kind,p_data);
end;
$$;
revoke all on function private.financial_draft_guard_error(uuid,uuid,text,jsonb),private.financial_draft_guard_error_registration_base(uuid,uuid,text,jsonb) from public,anon,authenticated;

create function private.registration_items_error(p_items jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_o jsonb; v_id jsonb; v_numbers jsonb; v_assignment jsonb; v_error text; v_seen boolean := false;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 1000 then return 'Checklist inválido.'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if private.exact_keys(v_item,array['plannedTicketKey','evidenceIds','observed','reason']) is not true
      or jsonb_typeof(v_item -> 'plannedTicketKey') <> 'string' or v_item ->> 'plannedTicketKey' !~ '^[A-Za-z0-9_-]{1,80}$'
      or jsonb_typeof(v_item -> 'evidenceIds') <> 'array' or jsonb_array_length(v_item -> 'evidenceIds') > 100
      or not private.json_text(v_item -> 'reason',2000) then return 'Item ou justificativa do checklist inválidos.'; end if;
    for v_id in select value from jsonb_array_elements(v_item -> 'evidenceIds') loop if not private.json_uuid(v_id) then return 'Identificador do original inválido.'; end if; end loop;
    if (select count(distinct (value #>> '{}')::uuid) from jsonb_array_elements(v_item -> 'evidenceIds')) <> jsonb_array_length(v_item -> 'evidenceIds') then return 'Original repetido na mesma cartela.'; end if;
    v_o := v_item -> 'observed';
    if v_o = 'null'::jsonb then continue; end if;
    v_seen := true;
    if jsonb_array_length(v_item -> 'evidenceIds') = 0 then return 'Um registro observado exige ao menos um original selado.'; end if;
    if private.exact_keys(v_o,array['lotteryId','contestNumber','betNumbers','betCostCents','feeCents','officialQuotaCount','officialAssignments','registeredAt']) is not true
      or (v_o -> 'lotteryId' <> 'null'::jsonb and v_o ->> 'lotteryId' not in ('mega-sena','lotofacil','quina'))
      or (v_o -> 'contestNumber' <> 'null'::jsonb and not private.json_integer(v_o -> 'contestNumber',1,999999))
      or (v_o -> 'betCostCents' <> 'null'::jsonb and not private.json_money(v_o -> 'betCostCents'))
      or (v_o -> 'feeCents' <> 'null'::jsonb and not private.json_money(v_o -> 'feeCents'))
      or (v_o -> 'officialQuotaCount' <> 'null'::jsonb and not private.json_integer(v_o -> 'officialQuotaCount',0,1000000))
      or (v_o -> 'registeredAt' <> 'null'::jsonb and not private.json_timestamp(v_o -> 'registeredAt')) then return 'Dados observados inválidos; use null para o que ainda não foi legível.'; end if;
    if v_o -> 'betNumbers' <> 'null'::jsonb then
      if jsonb_typeof(v_o -> 'betNumbers') <> 'array' or jsonb_array_length(v_o -> 'betNumbers') not between 1 and 10 then return 'Jogos observados inválidos.'; end if;
      for v_numbers in select value from jsonb_array_elements(v_o -> 'betNumbers') loop
        if jsonb_typeof(v_numbers) <> 'array' or jsonb_array_length(v_numbers) not between 5 and 20
          or exists (select 1 from jsonb_array_elements(v_numbers) where not private.json_integer(value,1,80))
          or (select count(distinct value) from jsonb_array_elements(v_numbers)) <> jsonb_array_length(v_numbers) then return 'Dezenas observadas incompletas ou repetidas.'; end if;
        if v_o -> 'lotteryId' <> 'null'::jsonb then
          v_error := private.draft_validation_error('bet',jsonb_build_object('poolId','00000000-0000-4000-8000-000000000001','lotteryId',v_o -> 'lotteryId',
            'numbers',v_numbers,'authorIds','[]'::jsonb,'catalogVersion','caixa-basic-2026-10-07-v1','seed',null,'generationAlgorithmVersion',null));
          if v_error is not null then return v_error; end if;
        end if;
      end loop;
    end if;
    if v_o -> 'officialAssignments' <> 'null'::jsonb then
      if jsonb_typeof(v_o -> 'officialAssignments') <> 'array' or jsonb_array_length(v_o -> 'officialAssignments') > 200 then return 'Correspondência oficial inválida.'; end if;
      for v_assignment in select value from jsonb_array_elements(v_o -> 'officialAssignments') loop
        if private.exact_keys(v_assignment,array['quotaId','personId','officialQuotas']) is not true or not private.json_uuid(v_assignment -> 'quotaId')
          or not private.json_uuid(v_assignment -> 'personId') or not private.json_integer(v_assignment -> 'officialQuotas',1,1000000) then return 'Correspondência da cota oficial inválida.'; end if;
      end loop;
      if (select count(distinct (value ->> 'quotaId')::uuid) from jsonb_array_elements(v_o -> 'officialAssignments')) <> jsonb_array_length(v_o -> 'officialAssignments')
        or (select count(distinct (value ->> 'personId')::uuid) from jsonb_array_elements(v_o -> 'officialAssignments')) <> jsonb_array_length(v_o -> 'officialAssignments') then return 'Pessoa ou direito oficial repetido.'; end if;
    end if;
  end loop;
  if not v_seen then return 'Confirmação exige ao menos um registro efetivamente observado.'; end if;
  if (select count(distinct value -> 'plannedTicketKey') from jsonb_array_elements(p_items)) <> jsonb_array_length(p_items) then return 'Cartela repetida no checklist.'; end if;
  return null;
end;
$$;

create function private.normalize_registration_items(p_items jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_result jsonb := '[]'; v_item jsonb; v_o jsonb; v_values jsonb;
begin
  for v_item in select value from jsonb_array_elements(p_items) loop
    select coalesce(jsonb_agg(to_jsonb(lower(value #>> '{}')) order by ord),'[]'::jsonb) into v_values from jsonb_array_elements(v_item -> 'evidenceIds') with ordinality a(value,ord);
    v_item := jsonb_set(v_item,'{evidenceIds}',v_values); v_o := v_item -> 'observed';
    if v_o <> 'null'::jsonb then
      if v_o -> 'betNumbers' <> 'null'::jsonb then
        select jsonb_agg((select jsonb_agg(n.value order by (n.value #>> '{}')::integer) from jsonb_array_elements(a.value) n) order by a.ord)
          into v_values from jsonb_array_elements(v_o -> 'betNumbers') with ordinality a(value,ord);
        v_o := jsonb_set(v_o,'{betNumbers}',v_values);
      end if;
      if v_o -> 'registeredAt' <> 'null'::jsonb then v_o := jsonb_set(v_o,'{registeredAt}',to_jsonb(private.utc_json((v_o ->> 'registeredAt')::timestamptz))); end if;
      if v_o -> 'officialAssignments' <> 'null'::jsonb then
        select coalesce(jsonb_agg(value || jsonb_build_object('quotaId',lower(value ->> 'quotaId'),'personId',lower(value ->> 'personId')) order by ord),'[]'::jsonb)
          into v_values from jsonb_array_elements(v_o -> 'officialAssignments') with ordinality a(value,ord);
        v_o := jsonb_set(v_o,'{officialAssignments}',v_values);
      end if;
      v_item := jsonb_set(v_item,'{observed}',v_o);
    end if;
    v_result := v_result || jsonb_build_array(v_item);
  end loop;
  return v_result;
end;
$$;
create function private.registration_issue(p_key text,p_code text,p_severity text,p_message text) returns jsonb
language sql immutable set search_path = '' as $$ select jsonb_build_array(jsonb_build_object('plannedTicketKey',p_key,'code',p_code,'severity',p_severity,'message',p_message)); $$;
create function private.registration_game_set(p_numbers jsonb) returns jsonb
language sql immutable set search_path = '' as $$ select jsonb_agg(value order by private.canonical_json(value) collate "C") from jsonb_array_elements(p_numbers); $$;
create function private.registration_assignment_set(p_assignments jsonb) returns jsonb
language sql immutable set search_path = '' as $$ select coalesce(jsonb_agg(value order by value ->> 'quotaId',value ->> 'personId'),'[]'::jsonb) from jsonb_array_elements(p_assignments); $$;

create function private.registration_comparison(p_manifest public.pool_manifests,p_items jsonb,p_calendar jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_plan jsonb := p_manifest.content -> 'plan'; v_item jsonb; v_actual jsonb; v_ticket jsonb; v_key text;
  v_issues jsonb := '[]'; v_numbers jsonb; v_missing text[]; v_total_cost numeric := 0; v_total_fee numeric := 0; v_count integer := 0;
  v_price numeric; v_quota_count numeric; v_cost numeric; v_rule public.lottery_pool_catalog_rules; v_rule_bad boolean;
begin
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_key := v_item ->> 'plannedTicketKey'; v_actual := v_item -> 'observed';
    select value into v_ticket from jsonb_array_elements(v_plan -> 'tickets') where value ->> 'key' = v_key;
    if exists (select 1 from jsonb_array_elements(v_item -> 'evidenceIds') i join public.evidence_originals e on e.id = (i.value #>> '{}')::uuid
      where e.uploaded_at >= (p_manifest.content -> 'pool' -> 'data' ->> 'deadlineAt')::timestamptz) then
      v_issues := v_issues || private.registration_issue(v_key,'evidence-after-internal-deadline','notice','Original apresentado após o prazo interno de participação.');
    end if;
    if v_actual = 'null'::jsonb then
      v_issues := v_issues || private.registration_issue(v_key,case when jsonb_array_length(v_item -> 'evidenceIds') > 0 then 'unreadable-receipt' else 'missing-receipt' end,'incomplete','Comprovante ausente ou ainda não conferido.');
      v_total_cost := null; v_total_fee := null; continue;
    end if;
    v_count := v_count+1; v_missing := array[]::text[];
    if jsonb_array_length(v_item -> 'evidenceIds') = 0 then v_issues := v_issues || private.registration_issue(v_key,'missing-receipt','incomplete','Dados informados ainda não têm original enviado.'); end if;
    foreach v_key in array array['lotteryId','contestNumber','betNumbers','betCostCents','feeCents','registeredAt'] loop
      if v_actual -> v_key = 'null'::jsonb then v_missing := array_append(v_missing,v_key); end if;
    end loop;
    if v_plan ->> 'participationMode' = 'official' then
      foreach v_key in array array['officialQuotaCount','officialAssignments'] loop if v_actual -> v_key = 'null'::jsonb then v_missing := array_append(v_missing,v_key); end if; end loop;
    end if;
    v_key := v_item ->> 'plannedTicketKey';
    if cardinality(v_missing) > 0 then v_issues := v_issues || private.registration_issue(v_key,'missing-field','incomplete','Campos do comprovante ainda desconhecidos: ' || array_to_string(v_missing,', ') || '.'); end if;
    if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'lotteryId' <> v_plan -> 'lotteryId' then v_issues := v_issues || private.registration_issue(v_key,'lottery-mismatch','divergence','Modalidade registrada diverge do plano.'); end if;
    if v_actual -> 'contestNumber' <> 'null'::jsonb and v_actual -> 'contestNumber' <> v_plan -> 'contestNumber' then v_issues := v_issues || private.registration_issue(v_key,'contest-mismatch','divergence','Concurso registrado diverge do plano.'); end if;
    select jsonb_agg(b.value -> 'numbers') into v_numbers from jsonb_array_elements(v_plan -> 'bets') b where exists (select 1 from jsonb_array_elements(v_ticket -> 'betKeys') k where k.value #>> '{}' = b.value ->> 'key');
    if v_actual -> 'betNumbers' <> 'null'::jsonb and private.registration_game_set(v_actual -> 'betNumbers') <> private.registration_game_set(v_numbers) then v_issues := v_issues || private.registration_issue(v_key,'numbers-mismatch','divergence','Jogos registrados divergem dos jogos planejados.'); end if;
    v_price := null;
    if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'betNumbers' <> 'null'::jsonb then
      select sum(r.elementary_combinations * r.simple_price_cents) into v_price from jsonb_array_elements(v_actual -> 'betNumbers') b join public.lottery_pool_catalog_rules r
        on r.lottery_id = v_actual ->> 'lotteryId' and r.catalog_version = 'caixa-pools-2026-10-08-v1' and r.number_count = jsonb_array_length(b.value);
    end if;
    if v_actual -> 'betCostCents' <> 'null'::jsonb and (v_actual -> 'betCostCents' <> v_ticket -> 'betCostCents'
      or (v_price is not null and (v_actual ->> 'betCostCents')::numeric <> v_price)) then v_issues := v_issues || private.registration_issue(v_key,'bet-cost-mismatch','divergence','Custo observado diverge da cartela ou do preço oficial dos jogos legíveis.'); end if;
    v_total_cost := v_total_cost + (v_actual ->> 'betCostCents')::numeric; v_total_fee := v_total_fee + (v_actual ->> 'feeCents')::numeric;
    if v_plan ->> 'participationMode' = 'official' then
      if v_actual -> 'officialQuotaCount' <> 'null'::jsonb and v_actual -> 'officialQuotaCount' <> v_ticket -> 'officialQuotaCount' then v_issues := v_issues || private.registration_issue(v_key,'official-quota-mismatch','divergence','Quantidade de cotas oficiais diverge do plano.'); end if;
      if v_actual -> 'officialAssignments' <> 'null'::jsonb and private.registration_assignment_set(v_actual -> 'officialAssignments') <> private.registration_assignment_set(v_ticket -> 'assignments') then v_issues := v_issues || private.registration_issue(v_key,'official-assignment-mismatch','divergence','Recibos de cotas oficiais não correspondem aos direitos congelados.'); end if;
      if v_actual -> 'lotteryId' <> 'null'::jsonb and v_actual -> 'betNumbers' <> 'null'::jsonb and v_actual -> 'betCostCents' <> 'null'::jsonb and v_actual -> 'officialQuotaCount' <> 'null'::jsonb then
        select * into v_rule from public.lottery_pool_catalog_rules where lottery_id = v_actual ->> 'lotteryId' and number_count = jsonb_array_length(v_actual -> 'betNumbers' -> 0) and catalog_version = 'caixa-pools-2026-10-08-v1';
        v_quota_count := (v_actual ->> 'officialQuotaCount')::numeric; v_cost := (v_actual ->> 'betCostCents')::numeric;
        v_rule_bad := exists (select 1 from jsonb_array_elements(v_actual -> 'betNumbers') b where jsonb_array_length(b.value) <> v_rule.number_count)
          or v_quota_count not between v_rule.min_quotas and v_rule.max_quotas or jsonb_array_length(v_actual -> 'betNumbers') > v_rule.max_games_per_receipt
          or v_cost not between v_rule.min_pool_cents and v_rule.max_pool_cents;
        if not v_rule_bad then v_rule_bad := mod(v_cost,v_quota_count) <> 0 or v_cost / v_quota_count < v_rule.min_quota_cents; end if;
        if v_actual -> 'feeCents' <> 'null'::jsonb and (v_actual ->> 'feeCents')::numeric * 100 > v_cost * 35 then v_rule_bad := true; end if;
        if v_rule_bad then v_issues := v_issues || private.registration_issue(v_key,'official-rule-mismatch','divergence','Dados observados não atendem às regras oficiais da cartela e suas cotas.'); end if;
      end if;
    else
      if v_actual -> 'officialQuotaCount' <> 'null'::jsonb then v_issues := v_issues || private.registration_issue(v_key,'official-quota-mismatch','divergence','Acordo interno planejado não tinha cotas oficiais.'); end if;
      if v_actual -> 'officialAssignments' <> 'null'::jsonb then v_issues := v_issues || private.registration_issue(v_key,'official-assignment-mismatch','divergence','Correspondência oficial observada não existia no acordo interno.'); end if;
    end if;
    if v_actual -> 'registeredAt' <> 'null'::jsonb and (v_actual ->> 'registeredAt')::timestamptz < private.utc_json(p_manifest.locked_at)::timestamptz then v_issues := v_issues || private.registration_issue(v_key,'registered-before-lock','divergence','Registro externo anterior ao manifesto congelado.'); end if;
    if v_actual -> 'registeredAt' <> 'null'::jsonb and p_calendar -> 'registrationClosesAt' <> 'null'::jsonb
      and (v_actual ->> 'registeredAt')::timestamptz >= (p_calendar ->> 'registrationClosesAt')::timestamptz then v_issues := v_issues || private.registration_issue(v_key,'registration-after-channel-close','divergence','Horário observado posterior ao encerramento configurado do canal.'); end if;
  end loop;
  if v_total_fee is not null and v_total_fee <> (v_plan ->> 'feeCents')::numeric then v_issues := v_issues || private.registration_issue(null,'fee-mismatch','divergence','Soma das taxas observadas diverge da taxa autorizada no plano.'); end if;
  return jsonb_build_object('status',case when exists (select 1 from jsonb_array_elements(v_issues) where value ->> 'severity' = 'divergence') then 'divergent'
    when exists (select 1 from jsonb_array_elements(v_issues) where value ->> 'severity' = 'incomplete') then 'partial' else 'complete' end,
    'observedTicketCount',v_count,'missingTicketCount',jsonb_array_length(p_items)-v_count,'observedBetCostCents',v_total_cost::text,'observedFeeCents',v_total_fee::text,'issues',v_issues);
end;
$$;

create function private.registration_snapshot(p_group uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('groupId',g.id,'groupRevision',g.revision,'manifests',private.planning_snapshot(p_group) -> 'manifests',
    'evidence',coalesce((select jsonb_agg(private.evidence_json(e) order by e.uploaded_at,e.id) from public.evidence_originals e where e.group_id = p_group),'[]'::jsonb),
    'reports',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'groupId',r.group_id,'poolId',r.pool_id,'version',r.version,'poolVersion',r.pool_version,
      'manifestId',r.manifest_id,'calendar',r.calendar,'items',r.items,'reason',r.reason,'comparison',r.comparison,'confirmedAt',private.utc_json(r.confirmed_at),'receiptId',r.receipt_id) order by r.pool_id,r.version)
      from public.registration_reports r where r.group_id = p_group),'[]'::jsonb)) from public.groups g where g.id = p_group;
$$;
create function public.registration_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return private.registration_snapshot(p_group_id);
end;
$$;
create function public.registration_command_status(p_idempotency_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_saved public.registration_command_receipts;
begin
  perform private.require_human();
  select * into v_saved from public.registration_command_receipts where actor_id = auth.uid() and idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return v_saved.response_payload;
end;
$$;

create function public.registration_decide(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_key uuid; v_group uuid; v_pool_id uuid; v_receipt uuid := gen_random_uuid();
  v_saved public.registration_command_receipts; v_pool public.draft_records; v_manifest public.pool_manifests; v_calendar public.contest_calendar_versions;
  v_action jsonb; v_items jsonb; v_comparison jsonb; v_calendar_json jsonb; v_error text; v_status text := 'accepted';
  v_revision bigint; v_version bigint; v_now timestamptz; v_report_id uuid := gen_random_uuid(); v_result jsonb;
begin
  perform private.require_human();
  if octet_length(p_command::text) > 1048576 or private.exact_keys(p_command,array['apiVersion','idempotencyKey','groupId','expectedRevision','action']) is not true
    or (p_command ->> 'apiVersion' = 'v1') is not true or not private.json_uuid(p_command -> 'idempotencyKey') or not private.json_uuid(p_command -> 'groupId')
    or not private.json_integer(p_command -> 'expectedRevision',0,9007199254740991) then raise exception 'invalid_registration_command_envelope' using errcode = '22023'; end if;
  v_key := (p_command ->> 'idempotencyKey')::uuid; v_group := (p_command ->> 'groupId')::uuid; v_action := p_command -> 'action';
  perform pg_advisory_xact_lock(hashtextextended('registration:' || v_actor::text || ':' || v_key::text,0));
  select * into v_saved from public.registration_command_receipts where actor_id = v_actor and idempotency_key = v_key;
  if found then
    if not private.can_manage_group(v_saved.group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
    if v_saved.request_payload = p_command then return v_saved.response_payload; end if;
    return jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',null,'groupId',v_group,'status','rejected','groupRevision',0,
      'message','Chave de idempotência já usada com outro conteúdo.','confirmedAt',null,'snapshot',null);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('group:' || v_group::text,0));
  select revision into v_revision from public.groups where id = v_group for update;
  if not found or not private.can_manage_group(v_group) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if (p_command ->> 'expectedRevision')::numeric <> v_revision then v_status := 'conflict'; v_error := 'A revisão do grupo mudou; atualize antes de conferir o registro.';
  elsif private.exact_keys(v_action,array['type','poolId','poolVersion','manifestId','items','reason']) is not true or (v_action ->> 'type' = 'registration_confirm') is not true
    or not private.json_uuid(v_action -> 'poolId') or not private.json_uuid(v_action -> 'manifestId') or not private.json_integer(v_action -> 'poolVersion',1,9007199254740991)
    or not private.json_text(v_action -> 'reason',2000) then v_error := 'Comando de conferência de registro inválido.';
  else v_error := private.registration_items_error(v_action -> 'items'); end if;
  if v_error is null then
    v_pool_id := (v_action ->> 'poolId')::uuid;
    select * into v_pool from public.draft_records where group_id = v_group and id = v_pool_id and kind = 'pool';
    if not found then v_error := 'Bolão não encontrado neste grupo.';
    elsif v_pool.version <> (v_action ->> 'poolVersion')::numeric then v_status := 'conflict'; v_error := 'A versão do bolão mudou; reveja o checklist.';
    elsif v_pool.data ->> 'status' not in ('locked','registered') then v_error := 'O registro exige um manifesto travado e preserva esse fechamento.';
    else
      select * into v_manifest from public.pool_manifests where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
      if not found or v_manifest.id <> (v_action ->> 'manifestId')::uuid then v_error := 'Confira o último manifesto efetivamente travado; a fonte não pode ser trocada silenciosamente.'; end if;
      if exists (select 1 from public.registration_reports where group_id = v_group and pool_id = v_pool_id and manifest_id <> v_manifest.id) then v_error := 'O primeiro registro sela o manifesto original para todas as revisões.'; end if;
    end if;
  end if;
  if v_error is null then
    v_items := private.normalize_registration_items(v_action -> 'items');
    if jsonb_array_length(v_items) <> jsonb_array_length(v_manifest.content -> 'plan' -> 'tickets')
      or exists (select 1 from jsonb_array_elements(v_items) i where not exists (select 1 from jsonb_array_elements(v_manifest.content -> 'plan' -> 'tickets') t where t.value ->> 'key' = i.value ->> 'plannedTicketKey'))
      then v_error := 'Checklist deve conter exatamente todas as cartelas do manifesto, inclusive as ausentes.';
    elsif exists (select 1 from jsonb_array_elements(v_items) i cross join lateral jsonb_array_elements(i.value -> 'evidenceIds') e
      where not exists (select 1 from public.evidence_originals o where o.group_id = v_group and o.pool_id = v_pool_id and o.id = (e.value #>> '{}')::uuid))
      then v_error := 'Cada comprovante precisa estar selado neste grupo e bolão.';
    end if;
  end if;
  select coalesce(max(version),0)+1 into v_version from public.registration_reports where group_id = v_group and pool_id = v_pool_id;
  if v_error is null and (v_pool.version >= 9007199254740991 or v_version > 9007199254740991 or (select count(*) from public.registration_reports where group_id = v_group) >= 10000)
    then v_error := 'Limite de versões do registro ou bolão atingido.'; end if;
  v_now := clock_timestamp();
  if v_error is null then
    if exists (select 1 from jsonb_array_elements(v_items) i where i.value -> 'observed' -> 'registeredAt' <> 'null'::jsonb
      and (i.value -> 'observed' ->> 'registeredAt')::timestamptz > v_now) then v_error := 'Um evento futuro não pode ser confirmado como registro observado.'; end if;
    select * into v_calendar from public.contest_calendar_versions where group_id = v_group and pool_id = v_pool_id order by version desc limit 1;
    v_calendar_json := case when v_calendar.id is not null then private.calendar_version_json(v_calendar) else null end;
    v_comparison := private.registration_comparison(v_manifest,v_items,v_calendar_json);
    if (v_comparison ->> 'observedBetCostCents')::numeric > 9007199254740991 or (v_comparison ->> 'observedFeeCents')::numeric > 9007199254740991 then v_error := 'Somas observadas excedem o limite de centavos deste contrato.'; end if;
    if (v_version > 1 or exists (select 1 from jsonb_array_elements(v_comparison -> 'issues') where value -> 'plannedTicketKey' = 'null'::jsonb and value ->> 'severity' = 'divergence'))
      and private.js_trim(v_action ->> 'reason') = '' then v_error := 'Revisão ou divergência global exige justificativa humana.'; end if;
    if exists (select 1 from jsonb_array_elements(v_items) i where private.js_trim(i.value ->> 'reason') = '' and exists (
      select 1 from jsonb_array_elements(v_comparison -> 'issues') e where e.value ->> 'plannedTicketKey' = i.value ->> 'plannedTicketKey' and e.value ->> 'severity' = 'divergence'))
      then v_error := 'Uma cartela divergente exige justificativa humana própria.'; end if;
  end if;
  if v_error is null then
    insert into public.registration_reports(id,group_id,pool_id,version,pool_version,manifest_id,calendar,items,reason,comparison,confirmed_at,receipt_id)
      values(v_report_id,v_group,v_pool_id,v_version,v_pool.version,v_manifest.id,v_calendar_json,v_items,v_action ->> 'reason',v_comparison,v_now,v_receipt);
    update public.draft_records set data = jsonb_set(data,'{status}','"registered"'),version = version+1,updated_at = v_now where group_id = v_group and id = v_pool_id;
    v_revision := private.advance_fact_revision(v_group,v_pool_id,v_actor,v_key,'registration_confirm',jsonb_build_object('receiptId',v_receipt,'reportId',v_report_id,'manifestId',v_manifest.id,'version',v_version));
  elsif v_status = 'accepted' then v_status := 'rejected'; end if;
  v_result := jsonb_build_object('apiVersion','v1','idempotencyKey',v_key,'receiptId',case when v_status = 'accepted' then v_receipt else null end,
    'groupId',v_group,'status',v_status,'groupRevision',v_revision,'message',v_error,'confirmedAt',case when v_status = 'accepted' then private.utc_json(v_now) else null end,
    'snapshot',private.registration_snapshot(v_group));
  insert into public.registration_command_receipts(id,actor_id,idempotency_key,group_id,request_payload,response_payload,created_at)
    values(v_receipt,v_actor,v_key,v_group,p_command,v_result,v_now);
  return v_result;
end;
$$;
revoke all on function private.registration_items_error(jsonb),private.normalize_registration_items(jsonb),private.registration_issue(text,text,text,text),
  private.registration_game_set(jsonb),private.registration_assignment_set(jsonb),private.registration_comparison(public.pool_manifests,jsonb,jsonb),private.registration_snapshot(uuid) from public,anon,authenticated;
revoke all on function public.registration_pull(uuid),public.registration_command_status(uuid),public.registration_decide(jsonb) from public,anon;
grant execute on function public.registration_pull(uuid),public.registration_command_status(uuid),public.registration_decide(jsonb) to authenticated;
