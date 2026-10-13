-- Pix receiver of the group (owner's decision of 2026-10-12): whoever keeps the group's money registers a Pix key, and the app
-- builds the "Pix copia e cola" and the QR with each person's exact amount (packages/core/src/pix.ts, on the device).
-- The app never talks to a bank; payments are still confirmed by hand. The shared group page never shows the key
-- (docs/ESPECIFICACAO.md); the personal card opened by link is individual and now carries it so the person can pay.

-- SQL mirror of the core's validatePixReceiver normal form: groups store only the normalized receiver.
create function private.pix_receiver_valid(p_pix jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_key text; v_sum integer; v_size integer; v_rest integer; i integer;
begin
  if p_pix = 'null'::jsonb then return true; end if;
  if private.exact_keys(p_pix, array['key','keyType','name','city']) is not true
    or not private.json_text(p_pix -> 'key', 77, true) or not private.json_text(p_pix -> 'name', 25, true)
    or not private.json_text(p_pix -> 'city', 15, true) or jsonb_typeof(p_pix -> 'keyType') is distinct from 'string'
    -- Printable ASCII without accents, trimmed, single spaces: what pixText produces.
    or (p_pix ->> 'name') !~ '^[!-~]+( [!-~]+)*$' or (p_pix ->> 'city') !~ '^[!-~]+( [!-~]+)*$' then return false; end if;
  v_key := p_pix ->> 'key';
  case p_pix ->> 'keyType'
  when 'cpf' then
    if v_key !~ '^[0-9]{11}$' or v_key = repeat(left(v_key,1),11) then return false; end if;
    foreach v_size in array array[9,10] loop
      v_sum := 0;
      for i in 1..v_size loop v_sum := v_sum + (ascii(substr(v_key,i,1)) - 48) * (v_size + 2 - i); end loop;
      if v_sum * 10 % 11 % 10 <> ascii(substr(v_key,v_size + 1,1)) - 48 then return false; end if;
    end loop;
  when 'cnpj' then
    -- Also the alphanumeric CNPJ: each character counts as its ASCII code minus 48.
    if v_key !~ '^[0-9A-Z]{12}[0-9]{2}$' or v_key = repeat(left(v_key,1),14) then return false; end if;
    foreach v_size in array array[12,13] loop
      v_sum := 0;
      for i in 1..v_size loop v_sum := v_sum + (ascii(substr(v_key,i,1)) - 48) * ((v_size - i) % 8 + 2); end loop;
      v_rest := v_sum % 11;
      if (case when v_rest < 2 then 0 else 11 - v_rest end) <> ascii(substr(v_key,v_size + 1,1)) - 48 then return false; end if;
    end loop;
  when 'email' then
    if v_key !~ '^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' then return false; end if;
  when 'phone' then
    if v_key !~ '^\+55[1-9]{2}9[0-9]{8}$' then return false; end if;
  when 'random' then
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  else return false;
  end case;
  return true;
end;
$$;

-- The group record gains the optional "pix" field (absent or null when nobody registered a key); every other kind is unchanged.
alter function private.draft_validation_error(text,jsonb) rename to draft_validation_error_pix_base;
create function private.draft_validation_error(p_kind text, p_data jsonb) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_kind = 'group' and jsonb_typeof(p_data) = 'object' and p_data ? 'pix' then
    if not private.pix_receiver_valid(p_data -> 'pix') then return 'Chave Pix do grupo inválida.'; end if;
    return private.draft_validation_error_pix_base(p_kind, p_data - 'pix');
  end if;
  return private.draft_validation_error_pix_base(p_kind, p_data);
end;
$$;

-- The card adds group.pix (null without a key); the amount and the code are built on the device from dueCents - paidCents.
alter function public.participant_card(text) set schema private;
alter function private.participant_card(text) rename to participant_card_pix_base;
create function public.participant_card(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_card jsonb := private.participant_card_pix_base(p_token_hash); v_group uuid;
begin
  if v_card ? 'error' then return v_card; end if;
  select group_id into v_group from public.participant_links where token_hash = p_token_hash;
  return jsonb_set(v_card,'{group,pix}',coalesce((select r.data -> 'pix' from public.draft_records r
    where r.group_id = v_group and r.id = v_group and r.kind = 'group'),'null'::jsonb));
end;
$$;

revoke all on function private.pix_receiver_valid(jsonb),private.draft_validation_error(text,jsonb),
  private.draft_validation_error_pix_base(text,jsonb),private.participant_card_pix_base(text) from public,anon,authenticated;
revoke all on function public.participant_card(text) from public,anon,authenticated;
grant execute on function public.participant_card(text) to service_role;
