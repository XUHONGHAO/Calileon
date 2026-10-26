-- ============================================================================
-- Calileon self-hosted backend - camera recordings stay private (ADR 0035)
-- ----------------------------------------------------------------------------
-- Run after schema_shares.sql and schema_embeds.sql, as a superuser, with psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema_video_privacy_smoke.sql
--
-- Share and embed links never see the owner's camera recordings (assets rows
-- with type 'video'): the load RPCs leave them out, and the asset upsert RPCs
-- neither register a video nor repoint an existing video row.
--
-- Everything happens in one transaction that always rolls back. A failed check
-- raises "video privacy smoke FAIL: ..." and stops; the last statement prints
-- "video privacy smoke: PASS" only when every check before it passed.
-- ============================================================================

begin;

create function pg_temp.vp_as(p_who text)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if p_who = 'anon' then
    perform set_config('role', 'anon', true);
  end if;
end;
$$;

create function pg_temp.vp_assert(p_ok boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'video privacy smoke FAIL: %', p_what;
  end if;
end;
$$;

-- Runs p_sql as the current role and requires it to raise exactly p_code.
create function pg_temp.vp_expect(p_sql text, p_code text, p_what text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm = p_code then
      return;
    end if;
    raise exception 'video privacy smoke FAIL: % (got %, want %)', p_what, sqlerrm, p_code;
  end;
  raise exception 'video privacy smoke FAIL: % (succeeded, want %)', p_what, p_code;
end;
$$;

-- file ids of the assets a load RPC result hands out
create function pg_temp.vp_files(p_loaded jsonb)
returns text[]
language sql
as $$
  select coalesce(array_agg(e ->> 'file_id' order by e ->> 'file_id'), '{}')
  from jsonb_array_elements(coalesce(p_loaded -> 'assets', '[]'::jsonb)) e
$$;

-- 1) Structure ------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'load_shared_scene(text)',
    'upsert_shared_asset(text,text,text,text,text,bigint)',
    'load_embedded_scene(text,text)',
    'upsert_embedded_asset(text,text,text,text,text,text,bigint)'
  ] loop
    perform pg_temp.vp_assert(to_regprocedure('public.' || v_sig) is not null, 'missing function ' || v_sig);
    perform pg_temp.vp_assert(
      (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.' || v_sig)),
      'not SECURITY DEFINER: ' || v_sig
    );
    perform pg_temp.vp_assert(has_function_privilege('anon', 'public.' || v_sig, 'execute'), 'anon cannot execute ' || v_sig);
  end loop;
end;
$$;

-- 2) Fixture: one owner, one scene with an image and a camera recording, a
--    write share and a write embed ------------------------------------------------
insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
values ('d0000000-0000-4000-8000-0000000000b0', 'authenticated', 'authenticated', 'vp-owner@example.invalid', '',
        '{}', now(), now());

insert into public.scenes (id, owner_id, title, payload_kind, payload, version)
values ('d0000000-0000-4000-8000-0000000000c0', 'd0000000-0000-4000-8000-0000000000b0', 'video privacy smoke',
        'plain', '{"elements":[],"appState":{}}', 1);

insert into public.assets (owner_id, scene_id, file_id, type, storage_path, mime_type, bytes)
values
  ('d0000000-0000-4000-8000-0000000000b0', 'd0000000-0000-4000-8000-0000000000c0', 'vp-image', 'image',
   'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-image', 'image/png', 4),
  ('d0000000-0000-4000-8000-0000000000b0', 'd0000000-0000-4000-8000-0000000000c0', 'vp-video', 'video',
   'd0000000-0000-4000-8000-0000000000b0/private-video/d0000000-0000-4000-8000-0000000000c0/vp-video',
   'video/mp4', 8);

insert into public.shares (owner_id, scene_id, mode, token)
values ('d0000000-0000-4000-8000-0000000000b0', 'd0000000-0000-4000-8000-0000000000c0', 'write', 'vp-smoke-share');

insert into public.embeds (owner_id, scene_id, mode, token, allowed_origins)
values ('d0000000-0000-4000-8000-0000000000b0', 'd0000000-0000-4000-8000-0000000000c0', 'write', 'vp-smoke-embed',
        array['https://vp.example.invalid']);

-- 3) Load RPCs leave the recording out ------------------------------------------------
select pg_temp.vp_as('anon');
select pg_temp.vp_assert(
  pg_temp.vp_files(public.load_shared_scene('vp-smoke-share')) = array['vp-image'],
  'load_shared_scene hands out ' || array_to_string(pg_temp.vp_files(public.load_shared_scene('vp-smoke-share')), ',')
);
select pg_temp.vp_assert(
  pg_temp.vp_files(public.load_embedded_scene('vp-smoke-embed', 'https://vp.example.invalid')) = array['vp-image'],
  'load_embedded_scene hands out the recording'
);
-- a scene whose only asset is a recording still loads, with no assets
select pg_temp.vp_as('admin');
update public.assets set deleted_at = now() where file_id = 'vp-image';
select pg_temp.vp_as('anon');
select pg_temp.vp_assert(
  (public.load_shared_scene('vp-smoke-share') -> 'assets') = '[]'::jsonb,
  'load_shared_scene with only a recording'
);
select pg_temp.vp_as('admin');
update public.assets set deleted_at = null where file_id = 'vp-image';

-- 4) Upsert RPCs never register or repoint a recording ------------------------------
select pg_temp.vp_as('anon');
select pg_temp.vp_expect(
  $q$select public.upsert_shared_asset('vp-smoke-share', 'vp-new-video', 'video',
       'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-new-video', 'video/mp4', 8)$q$,
  'cloud-share-forbidden', 'share link registers a video'
);
select pg_temp.vp_expect(
  $q$select public.upsert_shared_asset('vp-smoke-share', 'vp-video', 'image',
       'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-video', 'image/png', 4)$q$,
  'cloud-share-forbidden', 'share link repoints the recording row'
);
select pg_temp.vp_expect(
  $q$select public.upsert_embedded_asset('vp-smoke-embed', 'https://vp.example.invalid', 'vp-new-video', 'video',
       'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-new-video', 'video/mp4', 8)$q$,
  'cloud-embed-forbidden', 'embed registers a video'
);
select pg_temp.vp_expect(
  $q$select public.upsert_embedded_asset('vp-smoke-embed', 'https://vp.example.invalid', 'vp-video', 'image',
       'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-video', 'image/png', 4)$q$,
  'cloud-embed-forbidden', 'embed repoints the recording row'
);

-- regular uploads through links still work, new and repeated
select pg_temp.vp_assert(
  (select (public.upsert_shared_asset('vp-smoke-share', 'vp-share-image', 'image',
     'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-share-image', 'image/png', 4)).id
   is not null),
  'share link cannot register an image'
);
select pg_temp.vp_assert(
  (select (public.upsert_shared_asset('vp-smoke-share', 'vp-image', 'image',
     'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-image', 'image/png', 5)).bytes = 5),
  'share link cannot update an image'
);
select pg_temp.vp_assert(
  (select (public.upsert_embedded_asset('vp-smoke-embed', 'https://vp.example.invalid', 'vp-embed-image', 'image',
     'd0000000-0000-4000-8000-0000000000b0/d0000000-0000-4000-8000-0000000000c0/vp-embed-image', 'image/png', 4)).id
   is not null),
  'embed cannot register an image'
);

select pg_temp.vp_as('admin');
select pg_temp.vp_assert(
  (select type = 'video' and mime_type = 'video/mp4' and bytes = 8 and deleted_at is null
          and storage_path like '%/private-video/%'
     from public.assets where file_id = 'vp-video'),
  'recording row changed'
);
select pg_temp.vp_assert(
  not exists (select 1 from public.assets where file_id = 'vp-new-video'),
  'a video row was registered through a link'
);

select 'video privacy smoke: PASS' as result;

rollback;
