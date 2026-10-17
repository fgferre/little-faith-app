-- Responder pelo cartão (owner's decision of 2026-10-16): from the personal card the person answers "Estou dentro",
-- "Desta vez estou fora" or "Já paguei" with the amount and, if they want, the proof (photo or PDF). An answer is a server
-- record, append-only, per person and pool, tied to the link it came through (the PIN and the revocation apply); the latest
-- one stands. Every answer carries an idempotency key chosen by the device, so a retry never doubles it and a device that
-- never got the reply can ask again. An answer never creates a quota nor moves money: the treasurer adds the quota and
-- confirms the Pix through the paths that already exist. Answers are accepted while the pool is a draft and the draw of its
-- contest has not passed (the same cut as the quota, 20261016020000); afterwards the card shows the answer read-only.
-- The card now also lists the open draft pools where the person has no quota yet, with the question to answer.
-- The proof goes to a private bucket of its own with the limits of the registration evidence; only the organizer reads it,
-- and the card never carries a path. The organizer also records when they reminded someone ("lembrado ontem" on every device).

-- 1. One way to open a link: hash, revocation and PIN rules shared by the card, the PIN change and the answers.
create function private.participant_link_open(p_token_hash text,p_pin text,out o_link public.participant_links,out o_pin_set boolean,out o_error jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v_pin public.participant_link_pins;
begin
  o_pin_set := false;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then o_error := jsonb_build_object('error','link_unknown'); return; end if;
  select * into o_link from public.participant_links where token_hash = p_token_hash;
  if not found then o_error := jsonb_build_object('error','link_unknown'); return; end if;
  if o_link.revoked_at is not null then o_error := jsonb_build_object('error','link_revoked'); return; end if;
  select * into v_pin from public.participant_link_pins where link_id = o_link.id for update;
  if not found then return; end if;
  o_pin_set := true;
  if v_pin.locked_until > clock_timestamp() then o_error := jsonb_build_object('error','pin_locked','retryAt',private.utc_json(v_pin.locked_until)); return; end if;
  if p_pin is null then o_error := jsonb_build_object('error','pin_required'); return; end if;
  if p_pin !~ '^[0-9]{4}$' or private.participant_pin_digest(v_pin.pin_salt,p_pin) <> v_pin.pin_hash then
    o_error := private.participant_pin_miss(o_link.id,v_pin.failed_attempts); return;
  end if;
  if v_pin.failed_attempts <> 0 or v_pin.locked_until is not null then
    update public.participant_link_pins set failed_attempts = 0, locked_until = null, updated_at = clock_timestamp() where link_id = o_link.id;
  end if;
end;
$$;
revoke all on function private.participant_link_open(text,text) from public,anon,authenticated;

create or replace function public.participant_card_open(p_token_hash text,p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v record;
begin
  select * into v from private.participant_link_open(p_token_hash,p_pin);
  if v.o_error is not null then return v.o_error; end if;
  return public.participant_card(p_token_hash) || jsonb_build_object('pinSet',v.o_pin_set);
end;
$$;

-- An answer fits while the pool is still a draft and the draw of its contest has not passed: the same cut as the quota.
create function private.participant_pool_open(p_pool public.draft_records) returns boolean
language sql stable set search_path = '' as $$
  select p_pool.kind = 'pool' and p_pool.data ->> 'status' = 'draft' and not private.pool_draw_passed(p_pool.group_id,p_pool.id,p_pool.data -> 'contestNumber');
$$;
revoke all on function private.participant_pool_open(public.draft_records) from public,anon,authenticated;

-- 2. The records. A proof and an answer point at the link they came through, which pins them to the same group and person.
alter table public.participant_links add constraint participant_links_id_group_person_key unique (id,group_id,person_id);

create table public.participant_proofs (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  person_id uuid not null,
  link_id uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  storage_path text not null unique,
  uploaded_at timestamptz not null default now(),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (link_id,group_id,person_id) references public.participant_links(id,group_id,person_id) on delete restrict,
  check (storage_path = group_id::text || '/' || id::text || '.' || case mime_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'webp' end)
);

-- seq orders the answers of one person and pool with no tie (created_at is the transaction's clock): the latest stands.
create table public.participant_responses (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  person_id uuid not null,
  link_id uuid not null,
  kind text not null check (kind in ('in','out','paid')),
  amount_cents bigint check (amount_cents between 1 and 9007199254740991),
  proof_id uuid unique references public.participant_proofs(id) on delete restrict,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (link_id,group_id,person_id) references public.participant_links(id,group_id,person_id) on delete restrict,
  check ((kind = 'paid') = (amount_cents is not null)),
  check (kind = 'paid' or proof_id is null),
  unique (link_id,idempotency_key)
);
create index participant_responses_person_idx on public.participant_responses(group_id,pool_id,person_id,seq desc);

create table public.participant_reminders (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete restrict,
  pool_id uuid not null,
  person_id uuid not null,
  reminded_by uuid not null references auth.users(id) on delete restrict,
  reminded_at timestamptz not null default now(),
  foreign key (group_id,pool_id) references public.draft_records(group_id,id) on delete restrict,
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict
);
create index participant_reminders_person_idx on public.participant_reminders(group_id,pool_id,person_id,reminded_at desc);

create trigger participant_proofs_append_only before update or delete on public.participant_proofs for each row execute function private.prevent_mutation();
create trigger participant_responses_append_only before update or delete on public.participant_responses for each row execute function private.prevent_mutation();
create trigger participant_reminders_append_only before update or delete on public.participant_reminders for each row execute function private.prevent_mutation();

alter table public.participant_proofs enable row level security;
alter table public.participant_responses enable row level security;
alter table public.participant_reminders enable row level security;
revoke all on public.participant_proofs,public.participant_responses,public.participant_reminders from public,anon,authenticated;
create policy participant_proofs_read_organizer on public.participant_proofs for select to authenticated using (private.can_manage_group(group_id));
create policy participant_responses_read_organizer on public.participant_responses for select to authenticated using (private.can_manage_group(group_id));
create policy participant_reminders_read_organizer on public.participant_reminders for select to authenticated using (private.can_manage_group(group_id));
grant select on public.participant_proofs,public.participant_responses,public.participant_reminders to authenticated;

create function private.participant_response_json(p_response public.participant_responses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p_response.id,'poolId',p_response.pool_id,'personId',p_response.person_id,'linkId',p_response.link_id,
    'kind',p_response.kind,'amountCents',p_response.amount_cents::text,'proofId',p_response.proof_id,'createdAt',private.utc_json(p_response.created_at));
$$;
revoke all on function private.participant_response_json(public.participant_responses) from public,anon,authenticated;

-- 3. Answering through the api function with the service key. Like the card, a bad link, PIN or pool answers with an error
-- object (the PIN miss must be committed); a malformed answer raises 22023, which the api maps to invalid_request.
-- Before a proof is stored: the link, PIN and pool are checked and the group named, so the object lands under the group's
-- prefix; a replayed idempotency key returns the answer already recorded and nothing is uploaded again.
create function public.participant_proof_context(p_token_hash text,p_pin text,p_pool_id uuid,p_idempotency_key uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v record; v_pool public.draft_records; v_existing public.participant_responses;
begin
  if p_pool_id is null or p_idempotency_key is null then raise exception 'invalid_response' using errcode = '22023'; end if;
  select * into v from private.participant_link_open(p_token_hash,p_pin);
  if v.o_error is not null then return v.o_error; end if;
  select * into v_existing from public.participant_responses where link_id = (v.o_link).id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('repeated',true,'response',private.participant_response_json(v_existing)); end if;
  select * into v_pool from public.draft_records where group_id = (v.o_link).group_id and id = p_pool_id and kind = 'pool';
  if not found then return jsonb_build_object('error','pool_unknown'); end if;
  if not private.participant_pool_open(v_pool) then return jsonb_build_object('error','pool_closed'); end if;
  return jsonb_build_object('groupId',(v.o_link).group_id);
end;
$$;

-- p_proof: {id, sha256, mimeType, byteSize, storagePath} of the object already stored, only with 'paid'; the row and the
-- answer are written together. A replayed key returns the first answer and must carry the same pool, kind and amount.
create function public.participant_respond(p_token_hash text,p_pin text,p_pool_id uuid,p_kind text,p_amount_cents text,p_proof jsonb,p_idempotency_key uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v record; v_pool public.draft_records; v_existing public.participant_responses; v_response public.participant_responses; v_proof_id uuid;
begin
  if p_pool_id is null or p_idempotency_key is null or p_kind is null or p_kind not in ('in','out','paid')
    or (p_kind = 'paid') <> (p_amount_cents is not null) or (p_amount_cents is not null and p_amount_cents !~ '^[1-9][0-9]{0,15}$')
    or (p_proof is not null and (p_kind <> 'paid' or jsonb_typeof(p_proof) <> 'object')) then
    raise exception 'invalid_response' using errcode = '22023';
  end if;
  select * into v from private.participant_link_open(p_token_hash,p_pin);
  if v.o_error is not null then return v.o_error; end if;
  select * into v_existing from public.participant_responses where link_id = (v.o_link).id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.pool_id <> p_pool_id or v_existing.kind <> p_kind or v_existing.amount_cents is distinct from p_amount_cents::bigint then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    return jsonb_build_object('repeated',true,'response',private.participant_response_json(v_existing));
  end if;
  select * into v_pool from public.draft_records where group_id = (v.o_link).group_id and id = p_pool_id and kind = 'pool';
  if not found then return jsonb_build_object('error','pool_unknown'); end if;
  if not private.participant_pool_open(v_pool) then return jsonb_build_object('error','pool_closed'); end if;
  begin
    if p_proof is not null then
      begin
        insert into public.participant_proofs(id,group_id,pool_id,person_id,link_id,sha256,mime_type,byte_size,storage_path)
          values ((p_proof ->> 'id')::uuid,(v.o_link).group_id,p_pool_id,(v.o_link).person_id,(v.o_link).id,p_proof ->> 'sha256',p_proof ->> 'mimeType',
            (p_proof ->> 'byteSize')::integer,p_proof ->> 'storagePath') returning id into v_proof_id;
      exception when check_violation or not_null_violation or invalid_text_representation or unique_violation then
        raise exception 'invalid_proof' using errcode = '22023';
      end;
    end if;
    insert into public.participant_responses(group_id,pool_id,person_id,link_id,kind,amount_cents,proof_id,idempotency_key)
      values ((v.o_link).group_id,p_pool_id,(v.o_link).person_id,(v.o_link).id,p_kind,p_amount_cents::bigint,v_proof_id,p_idempotency_key)
      returning * into v_response;
  exception when unique_violation then
    -- The same key arrived twice at once: the first answer stands, the proof of the second is not kept.
    select * into v_response from public.participant_responses where link_id = (v.o_link).id and idempotency_key = p_idempotency_key;
    return jsonb_build_object('repeated',true,'response',private.participant_response_json(v_response));
  end;
  return jsonb_build_object('repeated',false,'response',private.participant_response_json(v_response));
end;
$$;
revoke all on function public.participant_proof_context(text,text,uuid,uuid),public.participant_respond(text,text,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.participant_proof_context(text,text,uuid,uuid),public.participant_respond(text,text,uuid,text,text,jsonb,uuid) to service_role;

-- 4. The organizer's side: the whole history of answers and reminders of the group (the app keeps the latest per person
-- and pool), the proof's status to download it, and the reminder mark.
create function public.participant_responses_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'responses',coalesce((select jsonb_agg(private.participant_response_json(r) || jsonb_build_object('proof',case when f.id is null then null
        else jsonb_build_object('id',f.id,'sha256',f.sha256,'mimeType',f.mime_type,'byteSize',f.byte_size) end) order by r.seq)
      from public.participant_responses r left join public.participant_proofs f on f.id = r.proof_id where r.group_id = p_group_id),'[]'::jsonb),
    'reminders',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'poolId',m.pool_id,'personId',m.person_id,'remindedAt',private.utc_json(m.reminded_at)) order by m.reminded_at,m.id)
      from public.participant_reminders m where m.group_id = p_group_id),'[]'::jsonb));
end;
$$;

create function public.participant_reminder_mark(p_group_id uuid,p_pool_id uuid,p_person_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_reminder public.participant_reminders;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_pool_id and kind = 'pool') then raise exception 'pool_not_found' using errcode = '22023'; end if;
  if not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_person_id and kind = 'person') then raise exception 'person_not_found' using errcode = '22023'; end if;
  insert into public.participant_reminders(group_id,pool_id,person_id,reminded_by) values (p_group_id,p_pool_id,p_person_id,auth.uid()) returning * into v_reminder;
  return jsonb_build_object('id',v_reminder.id,'poolId',v_reminder.pool_id,'personId',v_reminder.person_id,'remindedAt',private.utc_json(v_reminder.reminded_at));
end;
$$;

create function public.participant_proof_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_proof public.participant_proofs;
begin
  perform private.require_human();
  select * into v_proof from public.participant_proofs where id = p_id and private.can_manage_group(group_id);
  if not found then return null; end if;
  return jsonb_build_object('id',v_proof.id,'groupId',v_proof.group_id,'poolId',v_proof.pool_id,'personId',v_proof.person_id,'sha256',v_proof.sha256,
    'mimeType',v_proof.mime_type,'byteSize',v_proof.byte_size,'storagePath',v_proof.storage_path,'uploadedAt',private.utc_json(v_proof.uploaded_at));
end;
$$;
revoke all on function public.participant_responses_pull(uuid),public.participant_reminder_mark(uuid,uuid,uuid),public.participant_proof_status(uuid) from public,anon;
grant execute on function public.participant_responses_pull(uuid),public.participant_reminder_mark(uuid,uuid,uuid),public.participant_proof_status(uuid) to authenticated;

-- 5. Private proofs: same key shape as the evidence (<group UUID>/<file UUID>.<extension>), read by organizers only.
-- No INSERT policy: only the api function, with the service key, stores a proof, after checking the link and the PIN.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('participant-proofs','participant-proofs',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf']);
create policy participant_proofs_read_organizer on storage.objects for select to authenticated
  using (bucket_id = 'participant-proofs' and private.can_manage_group(private.evidence_group(name)));
create policy participant_proofs_no_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'participant-proofs') with check (bucket_id <> 'participant-proofs');
create policy participant_proofs_no_delete on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'participant-proofs');
create or replace function private.guard_sealed_original() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (old.bucket_id in ('evidence','participant-proofs') and private.evidence_group(old.name) is not null)
    or (tg_op = 'UPDATE' and new.bucket_id in ('evidence','participant-proofs') and private.evidence_group(new.name) is not null) then
    raise exception 'O original privado não pode ser substituído ou excluído, inclusive antes do selo.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- 6. The card: open draft pools without a quota join the list (quota null, so the person can answer), each pool says
-- whether answers are still open and carries the person's latest answer. Re-created from 20261016050000.
create or replace function private.participant_card_pix_base(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_link public.participant_links; v_pool public.draft_records; v_manifest public.pool_manifests; v_report public.registration_reports;
  v_quota public.confirmed_quotas; v_prize public.settlement_prizes; v_balance jsonb; v_own jsonb; v_current jsonb; v_result jsonb; v_drawn jsonb; v_draw_at text;
  v_units bigint; v_due numeric; v_funding numeric; v_games jsonb; v_holder text; v_mode text; v_pools jsonb := '[]'::jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','link_unknown'); end if;
  select * into v_link from public.participant_links where token_hash = p_token_hash;
  if not found then return jsonb_build_object('error','link_unknown'); end if;
  if v_link.revoked_at is not null then return jsonb_build_object('error','link_revoked'); end if;
  for v_pool in select p.* from public.draft_records p where p.group_id = v_link.group_id and p.kind = 'pool'
      and (exists (select 1 from public.draft_records q where q.group_id = p.group_id and q.kind = 'quota'
        and (q.data ->> 'poolId')::uuid = p.id and (q.data ->> 'personId')::uuid = v_link.person_id) or private.participant_pool_open(p))
      order by p.created_at desc,p.id desc loop
    v_mode := v_pool.data ->> 'participationMode';
    select * into v_quota from public.confirmed_quotas q where q.group_id = v_link.group_id and q.pool_id = v_pool.id and q.person_id = v_link.person_id
      and not exists (select 1 from public.quota_revocations r where r.quota_id = q.id) order by q.confirmed_at desc limit 1;
    v_units := coalesce(v_quota.units,(select sum((q.data ->> 'units')::bigint) from public.draft_records q where q.group_id = v_link.group_id
      and q.kind = 'quota' and (q.data ->> 'poolId')::uuid = v_pool.id and (q.data ->> 'personId')::uuid = v_link.person_id));
    -- Before confirmation the due amount is quotaCost(quotaPriceCents, units), the same division the confirmation uses.
    v_due := coalesce(v_quota.due_cents,((v_pool.data ->> 'quotaPriceCents')::numeric * v_units / 100)::bigint);
    v_funding := private.person_pool_funding(v_link.group_id,v_link.person_id,v_pool.id);
    select * into v_manifest from public.pool_manifests where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
    select * into v_report from public.registration_reports where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
    select * into v_prize from public.settlement_prizes where group_id = v_link.group_id and pool_id = v_pool.id order by version desc limit 1;
    -- Games without owners: per ticket, the receipt's legible numbers once registered, else the planned bets; the draft bets before the lock.
    if v_manifest.id is not null and v_report.id is not null then
      with plan as (select v_manifest.content -> 'plan' as p),
        legible as (select i.value ->> 'plannedTicketKey' as key,i.value -> 'observed' -> 'betNumbers' as numbers
          from jsonb_array_elements(v_report.items) i,plan
          where jsonb_typeof(i.value -> 'evidenceIds') = 'array' and i.value -> 'evidenceIds' <> '[]'::jsonb
            and jsonb_typeof(i.value -> 'observed' -> 'betNumbers') = 'array'
            and i.value -> 'observed' -> 'lotteryId' = plan.p -> 'lotteryId' and i.value -> 'observed' -> 'contestNumber' = plan.p -> 'contestNumber'),
        tks as (select t.value,t.ordinality from plan,jsonb_array_elements(plan.p -> 'tickets') with ordinality t(value,ordinality))
      select coalesce(jsonb_agg(g.game order by g.t,g.b),'[]'::jsonb) into v_games from (
        select tks.ordinality as t,o.ordinality as b,jsonb_build_object('numbers',o.value,'registered',true) as game
          from tks join legible l on l.key = tks.value ->> 'key'
          cross join lateral jsonb_array_elements(l.numbers) with ordinality o(value,ordinality)
        union all
        select tks.ordinality,b.ordinality,jsonb_build_object('numbers',b.value -> 'numbers','registered',false)
          from tks cross join plan cross join lateral jsonb_array_elements(plan.p -> 'bets') with ordinality b(value,ordinality)
          where (tks.value -> 'betKeys') ? (b.value ->> 'key') and not exists (select 1 from legible l where l.key = tks.value ->> 'key')) g;
    elsif v_manifest.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.value -> 'numbers','registered',false) order by b.ordinality),'[]'::jsonb) into v_games
        from jsonb_array_elements(v_manifest.content -> 'plan' -> 'bets') with ordinality b(value,ordinality);
    else
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.data -> 'numbers','registered',false) order by b.created_at,b.id),'[]'::jsonb) into v_games
        from public.draft_records b where b.group_id = v_link.group_id and b.kind = 'bet' and (b.data ->> 'poolId')::uuid = v_pool.id;
    end if;
    v_holder := (select h.data ->> 'name' from public.draft_records h where h.group_id = v_link.group_id and h.kind = 'person'
      and h.id::text = v_manifest.content -> 'responsible' ->> 'ticketHolderPersonId');
    v_balance := case when v_manifest.id is null then null else private.settlement_pool_balance(v_link.group_id,v_pool.id) end;
    select value into v_own from jsonb_array_elements(coalesce(v_balance -> 'persons','[]'::jsonb)) where value ->> 'personId' = v_link.person_id::text;
    -- Drawn numbers: the result the prize was confirmed on; before that, the core's current result unless sources conflict.
    if v_prize.id is not null then
      select r.data into v_result from public.contest_result_versions r where r.group_id = v_link.group_id and r.id = v_prize.result_id;
    else
      v_current := private.settlement_current_result(v_link.group_id,v_pool.id);
      v_result := case when v_current ->> 'status' = 'conflict' then null else v_current -> 'result' end;
    end if;
    v_drawn := case when jsonb_typeof(v_result -> 'drawnNumbers') = 'array' and jsonb_array_length(v_result -> 'drawnNumbers') > 0 then v_result -> 'drawnNumbers' end;
    select coalesce(private.utc_json(c.expected_draw_at),to_char(c.draw_date,'YYYY-MM-DD')) into v_draw_at from public.contest_calendar_versions c
      where c.group_id = v_link.group_id and c.pool_id = v_pool.id order by c.version desc limit 1;
    v_pools := v_pools || jsonb_build_array(jsonb_build_object('id',v_pool.id,'title',v_pool.data ->> 'title','modality',v_pool.data ->> 'lotteryId',
      'contest',coalesce(v_pool.data -> 'contestNumber','null'::jsonb),'drawAt',coalesce(v_draw_at,v_result ->> 'drawDate'),
      'status',v_pool.data ->> 'status','participationMode',v_mode,
      'quota',case when v_units is null then null else jsonb_build_object('units',v_units,'dueCents',v_due::text,'paidCents',v_funding::text,'paid',v_funding >= v_due) end,
      'responseOpen',private.participant_pool_open(v_pool),
      'response',(select jsonb_build_object('kind',r.kind,'amountCents',r.amount_cents::text,'proofSent',r.proof_id is not null,'at',private.utc_json(r.created_at))
        from public.participant_responses r where r.group_id = v_link.group_id and r.pool_id = v_pool.id and r.person_id = v_link.person_id
        order by r.seq desc limit 1),
      'games',v_games,
      'registration',case when v_manifest.id is null then null else jsonb_build_object(
        'status',case v_report.comparison ->> 'status' when 'complete' then 'registered' when 'partial' then 'partial' when 'divergent' then 'divergent' else 'planned' end,
        'ticketHolderName',v_holder) end,
      'result',case when v_drawn is null then null else jsonb_build_object('drawnNumbers',v_drawn,
        'prizeCalculatedCents',v_balance ->> 'calculatedPrizeCents','prizeConfirmedCents',v_prize.amount_cents::text,
        'redemptionDeadlineDate',v_prize.redemption_deadline ->> 'deadlineDate',
        'prizeRedeemed',coalesce(v_prize.amount_cents > 0 and (v_balance ->> 'unredeemedPrizeCents')::numeric <= 0,false)) end,
      'share',case when v_own is null then null else jsonb_build_object('rightCents',v_own ->> 'prizeRightCents','receivedCents',v_own ->> 'prizeReceivedCents',
        'pendingCents',v_own ->> 'prizePendingCents','paidByName',case when v_mode = 'internal' then v_holder end,
        'refundRightCents',v_own ->> 'refundRightCents','refundedCents',v_own ->> 'refundedCents') end,
      'groupReserveCents',v_balance ->> 'groupReserveCents',
      'groupPrizeLimitCents',v_manifest.content -> 'plan' ->> 'groupPrizeLimitCents',
      'closed',coalesce((v_balance ->> 'closed')::boolean,false)));
  end loop;
  return jsonb_build_object('version',1,'generatedAt',private.utc_json(clock_timestamp()),
    'group',jsonb_build_object('name',(select g.name from public.groups g where g.id = v_link.group_id)),
    'person',jsonb_build_object('id',v_link.person_id,'name',(select p.data ->> 'name' from public.draft_records p where p.group_id = v_link.group_id and p.id = v_link.person_id)),
    'pools',v_pools);
end;
$$;
