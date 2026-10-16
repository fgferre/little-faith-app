-- Optional 4-digit PIN on the personal card (owner's decision of 2026-10-15). The link token alone still identifies the person;
-- the PIN is a second step for someone who shares a phone or a chat history, so the owner decides per card whether to use one.
-- The server keeps only a salted SHA-256 of the PIN (4 digits are guessable offline, so the real protection is the lock:
-- 5 wrong tries lock the card for 15 minutes). The counter is committed on every miss, which is why these functions never raise
-- for a wrong, missing or locked PIN; they answer with an error object, like participant_card. Earlier migrations stay immutable.
create table public.participant_link_pins (
  link_id uuid primary key references public.participant_links(id) on delete restrict,
  pin_salt text not null,
  pin_hash text not null check (pin_hash ~ '^[0-9a-f]{64}$'),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 4),
  locked_until timestamptz,
  updated_at timestamptz not null
);
alter table public.participant_link_pins enable row level security;
revoke all on public.participant_link_pins from public,anon,authenticated;

create function private.participant_pin_digest(p_salt text,p_pin text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_salt || ':' || p_pin,'UTF8')),'hex');
$$;

-- One wrong try: the fifth locks the link for 15 minutes and starts the next round from zero.
create function private.participant_pin_miss(p_link_id uuid,p_failed integer) returns jsonb
language plpgsql set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_until timestamptz := clock_timestamp() + interval '15 minutes';
begin
  if p_failed + 1 >= 5 then
    update public.participant_link_pins set failed_attempts = 0, locked_until = v_until, updated_at = v_now where link_id = p_link_id;
    return jsonb_build_object('error','pin_locked','retryAt',private.utc_json(v_until));
  end if;
  update public.participant_link_pins set failed_attempts = p_failed + 1, updated_at = v_now where link_id = p_link_id;
  return jsonb_build_object('error','pin_wrong','attemptsLeft',5 - (p_failed + 1));
end;
$$;

create function public.participant_card_open(p_token_hash text,p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_card jsonb := public.participant_card(p_token_hash); v_link_id uuid; v_pin public.participant_link_pins;
begin
  if v_card ? 'error' then return v_card; end if;
  select id into v_link_id from public.participant_links where token_hash = p_token_hash;
  select * into v_pin from public.participant_link_pins where link_id = v_link_id for update;
  if not found then return v_card || jsonb_build_object('pinSet',false); end if;
  if v_pin.locked_until > clock_timestamp() then return jsonb_build_object('error','pin_locked','retryAt',private.utc_json(v_pin.locked_until)); end if;
  if p_pin is null then return jsonb_build_object('error','pin_required'); end if;
  if p_pin !~ '^[0-9]{4}$' or private.participant_pin_digest(v_pin.pin_salt,p_pin) <> v_pin.pin_hash then
    return private.participant_pin_miss(v_link_id,v_pin.failed_attempts);
  end if;
  if v_pin.failed_attempts <> 0 or v_pin.locked_until is not null then
    update public.participant_link_pins set failed_attempts = 0, locked_until = null, updated_at = clock_timestamp() where link_id = v_link_id;
  end if;
  return v_card || jsonb_build_object('pinSet',true);
end;
$$;

-- First visit: no current PIN needed. Afterwards the current PIN is required to change or remove it (p_pin null removes).
create function public.participant_pin_set(p_token_hash text,p_pin text,p_current_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_link public.participant_links; v_pin public.participant_link_pins; v_salt text := gen_random_uuid()::text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error','link_unknown'); end if;
  -- The link row is the lock that serializes two first PINs set at the same time.
  select * into v_link from public.participant_links where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('error','link_unknown'); end if;
  if v_link.revoked_at is not null then return jsonb_build_object('error','link_revoked'); end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then return jsonb_build_object('error','pin_invalid'); end if;
  select * into v_pin from public.participant_link_pins where link_id = v_link.id for update;
  if found then
    if v_pin.locked_until > clock_timestamp() then return jsonb_build_object('error','pin_locked','retryAt',private.utc_json(v_pin.locked_until)); end if;
    if p_current_pin is null then return jsonb_build_object('error','pin_required'); end if;
    if p_current_pin !~ '^[0-9]{4}$' or private.participant_pin_digest(v_pin.pin_salt,p_current_pin) <> v_pin.pin_hash then
      return private.participant_pin_miss(v_link.id,v_pin.failed_attempts);
    end if;
    if p_pin is null then
      delete from public.participant_link_pins where link_id = v_link.id;
    else
      update public.participant_link_pins set pin_salt = v_salt, pin_hash = private.participant_pin_digest(v_salt,p_pin),
        failed_attempts = 0, locked_until = null, updated_at = clock_timestamp() where link_id = v_link.id;
    end if;
    return jsonb_build_object('pinSet',p_pin is not null);
  end if;
  if p_pin is null then return jsonb_build_object('pinSet',false); end if;
  insert into public.participant_link_pins(link_id,pin_salt,pin_hash,updated_at)
    values(v_link.id,v_salt,private.participant_pin_digest(v_salt,p_pin),clock_timestamp());
  return jsonb_build_object('pinSet',true);
end;
$$;

-- participant_links_pull from 20261011000000_participant_links.sql, with hasPin added to each link so the organizer sees which cards have one.
create or replace function public.participant_links_pull(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if not private.can_manage_group(p_group_id) then raise exception 'group_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('links',coalesce((select jsonb_agg(private.participant_link_json(l)
      || jsonb_build_object('hasPin',exists(select 1 from public.participant_link_pins p where p.link_id = l.id)) order by l.created_at,l.id)
    from public.participant_links l where l.group_id = p_group_id),'[]'::jsonb));
end;
$$;

revoke all on function private.participant_pin_digest(text,text),private.participant_pin_miss(uuid,integer) from public,anon,authenticated;
-- Reached only through the api function with the service key, after it hashes the token from the link.
revoke all on function public.participant_card_open(text,text),public.participant_pin_set(text,text,text) from public,anon,authenticated;
grant execute on function public.participant_card_open(text,text),public.participant_pin_set(text,text,text) to service_role;
