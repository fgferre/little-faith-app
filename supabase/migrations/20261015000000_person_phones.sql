-- WhatsApp phones, one per person of a group, so the organizer can open each personal link in that person's chat.
-- They live apart from the person draft on purpose: a locked pool freezes its persons, and manifests, exports,
-- the shared page and the participant card must never carry a phone. Only organizers read or write them. Earlier migrations stay immutable.
create table public.person_phones (
  group_id uuid not null,
  person_id uuid not null,
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  updated_at timestamptz not null,
  updated_by uuid not null references auth.users(id) on delete restrict,
  primary key (group_id,person_id),
  foreign key (group_id,person_id) references public.draft_records(group_id,id) on delete restrict
);

create function public.person_phones_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('phones',coalesce((select jsonb_agg(jsonb_build_object('personId',p.person_id,'phone',p.phone) order by p.person_id)
    from public.person_phones p where p.group_id = p_group_id),'[]'::jsonb));
end;
$$;

-- Inserts or changes the person's phone; repeating the same call leaves the same state, so a lost reply is safe to retry.
create function public.person_phone_set(p_group_id uuid,p_person_id uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_phone public.person_phones;
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  if p_phone is null or p_phone !~ '^[1-9][0-9]{9,14}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  if not exists (select 1 from public.draft_records where group_id = p_group_id and id = p_person_id and kind = 'person') then
    raise exception 'person_not_found' using errcode = '22023';
  end if;
  insert into public.person_phones(group_id,person_id,phone,updated_at,updated_by)
    values(p_group_id,p_person_id,p_phone,clock_timestamp(),auth.uid())
    on conflict (group_id,person_id) do update set phone = excluded.phone,updated_at = excluded.updated_at,updated_by = excluded.updated_by
    returning * into v_phone;
  return jsonb_build_object('personId',v_phone.person_id,'phone',v_phone.phone);
end;
$$;

-- Clearing a phone that is not there is not an error, for the same retry reason.
create function public.person_phone_clear(p_group_id uuid,p_person_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  delete from public.person_phones where group_id = p_group_id and person_id = p_person_id;
  return jsonb_build_object('personId',p_person_id);
end;
$$;

alter table public.person_phones enable row level security;
create policy person_phones_read_organizer on public.person_phones for select to authenticated using (private.can_manage_group(group_id));
revoke all on public.person_phones from anon,authenticated;
grant select on public.person_phones to authenticated;
revoke all on function public.person_phones_pull(uuid),public.person_phone_set(uuid,uuid,text),public.person_phone_clear(uuid,uuid) from public,anon;
grant execute on function public.person_phones_pull(uuid),public.person_phone_set(uuid,uuid,text),public.person_phone_clear(uuid,uuid) to authenticated;
