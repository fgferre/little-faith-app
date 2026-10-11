-- Personal participant links: the token lives only with the participant; the server keeps its SHA-256.
-- The card is assembled at every opening, so a revocation takes effect immediately. Earlier migrations stay immutable.
create table public.participant_links (
  group_id uuid not null references public.groups(id) on delete restrict,
  id uuid primary key,
  person_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null,
  revoked_at timestamptz check (revoked_at >= created_at),
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict,
  unique (group_id,id)
);
create index participant_links_person_idx on public.participant_links(group_id,person_id);

-- A link is never deleted or rewritten; the only change is the one-way revocation.
create function private.guard_participant_link() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.revoked_at is not null or new.revoked_at is null
    or (new.group_id,new.id,new.person_id,new.token_hash,new.created_by,new.created_at)
      is distinct from (old.group_id,old.id,old.person_id,old.token_hash,old.created_by,old.created_at) then
    raise exception 'append_only_record' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger participant_links_revoke_only before update or delete on public.participant_links for each row execute function private.guard_participant_link();

create function private.participant_link_json(p_link public.participant_links) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id',p_link.id,'personId',p_link.person_id,'createdAt',private.utc_json(p_link.created_at),'revokedAt',private.utc_json(p_link.revoked_at));
$$;

create function public.participant_link_create(p_group_id uuid,p_person_id uuid,p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_link public.participant_links;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_token_hash' using errcode = '22023'; end if;
  if not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_person_id and kind = 'person') then
    raise exception 'person_not_found' using errcode = '22023';
  end if;
  insert into public.participant_links(group_id,id,person_id,token_hash,created_by,created_at)
    values(p_group_id,gen_random_uuid(),p_person_id,p_token_hash,auth.uid(),clock_timestamp()) returning * into v_link;
  return jsonb_build_object('id',v_link.id,'personId',v_link.person_id,'createdAt',private.utc_json(v_link.created_at));
end;
$$;

-- Repeating a revocation returns the original moment, so a lost reply is safe to retry.
create function public.participant_link_revoke(p_group_id uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_link public.participant_links;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  select * into v_link from public.participant_links where group_id = p_group_id and id = p_id for update;
  if not found then raise exception 'link_not_found' using errcode = '22023'; end if;
  if v_link.revoked_at is null then
    update public.participant_links set revoked_at = clock_timestamp() where id = v_link.id returning * into v_link;
  end if;
  return jsonb_build_object('id',v_link.id,'revokedAt',private.utc_json(v_link.revoked_at));
end;
$$;

create function public.participant_links_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('links',coalesce((select jsonb_agg(private.participant_link_json(l) order by l.created_at,l.id)
    from public.participant_links l where l.group_id = p_group_id),'[]'::jsonb));
end;
$$;

-- ParticipantCard (packages/core/src/participant-types.ts). Only the person's own values; money comes from
-- private.settlement_pool_balance, the SQL mirror of the core's computeSettlement, so the card cannot drift from Dividir.
-- Never includes phones, documents, Pix keys, nicknames, bet authors, other people's values or storage paths.
create function public.participant_card(p_token_hash text) returns jsonb
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
      and exists (select 1 from public.draft_records q where q.group_id = p.group_id and q.kind = 'quota'
        and (q.data ->> 'poolId')::uuid = p.id and (q.data ->> 'personId')::uuid = v_link.person_id)
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
    -- Games without owners: the frozen plan once locked, the draft bets before that.
    if v_manifest.id is not null then
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.value -> 'numbers') order by b.ordinality),'[]'::jsonb) into v_games
        from jsonb_array_elements(v_manifest.content -> 'plan' -> 'bets') with ordinality b(value,ordinality);
    else
      select coalesce(jsonb_agg(jsonb_build_object('numbers',b.data -> 'numbers') order by b.created_at,b.id),'[]'::jsonb) into v_games
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
      'quota',jsonb_build_object('units',v_units,'dueCents',v_due::text,'paidCents',v_funding::text,'paid',v_funding >= v_due),
      'games',v_games,
      'registration',case when v_manifest.id is null then null else jsonb_build_object(
        'status',case v_report.comparison ->> 'status' when 'complete' then 'registered' when 'partial' then 'partial' when 'divergent' then 'divergent' else 'planned' end,
        'ticketHolderName',v_holder) end,
      'result',case when v_drawn is null then null else jsonb_build_object('drawnNumbers',v_drawn,
        'prizeCalculatedCents',v_balance ->> 'calculatedPrizeCents','prizeConfirmedCents',v_prize.amount_cents::text) end,
      'share',case when v_own is null then null else jsonb_build_object('rightCents',v_own ->> 'prizeRightCents','receivedCents',v_own ->> 'prizeReceivedCents',
        'pendingCents',v_own ->> 'prizePendingCents','paidByName',case when v_mode = 'internal' then v_holder end,
        'refundRightCents',v_own ->> 'refundRightCents','refundedCents',v_own ->> 'refundedCents') end,
      'closed',coalesce((v_balance ->> 'closed')::boolean,false)));
  end loop;
  return jsonb_build_object('version',1,'generatedAt',private.utc_json(clock_timestamp()),
    'group',jsonb_build_object('name',(select g.name from public.groups g where g.id = v_link.group_id)),
    'person',jsonb_build_object('id',v_link.person_id,'name',(select p.data ->> 'name' from public.draft_records p where p.group_id = v_link.group_id and p.id = v_link.person_id)),
    'pools',v_pools);
end;
$$;

alter table public.participant_links enable row level security;
create policy participant_links_read_organizer on public.participant_links for select to authenticated using (private.can_manage_group(group_id));
revoke all on public.participant_links from anon,authenticated;
-- The token hash is never readable by clients, not even by the organizer.
grant select (group_id,id,person_id,created_by,created_at,revoked_at) on public.participant_links to authenticated;
revoke all on function private.guard_participant_link(),private.participant_link_json(public.participant_links) from public,anon,authenticated;
revoke all on function public.participant_link_create(uuid,uuid,text),public.participant_link_revoke(uuid,uuid),public.participant_links_pull(uuid) from public,anon;
grant execute on function public.participant_link_create(uuid,uuid,text),public.participant_link_revoke(uuid,uuid),public.participant_links_pull(uuid) to authenticated;
-- Reached only through the api function with the service key, after it hashes the token from the link.
revoke all on function public.participant_card(text) from public,anon,authenticated;
grant execute on function public.participant_card(text) to service_role;
