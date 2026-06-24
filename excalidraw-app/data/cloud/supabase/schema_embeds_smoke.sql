-- ============================================================================
-- Excalidraw self-hosted backend - Phase 3C embed RLS/RPC smoke test
-- ----------------------------------------------------------------------------
-- Run after schema_embeds.sql.
--
-- Usage:
--   1. Make sure at least one cloud whiteboard exists in public.scenes.
--   2. Open Supabase SQL Editor.
--   3. Paste this whole file and run it with "Run without RLS".
--   4. Check the final result table:
--      - overall_result = PASS means the smoke passed.
--      - Any FAIL row includes details.
--
-- This script creates a temporary smoke scene owned by the latest scene owner,
-- then removes all smoke rows before finishing.
-- ============================================================================

drop table if exists phase3c_embed_smoke_results;

create temp table phase3c_embed_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

delete from public.assets
where file_id like 'phase3c-rls-smoke-%';

delete from public.embeds
where token like 'phase3c-rls-smoke-%';

delete from public.scenes
where title like 'phase3c rls smoke:%';

create or replace function pg_temp.run_phase3c_embed_smoke()
returns void
language plpgsql
as $phase3c_embed_smoke$
declare
  v_fixture_scene_id uuid;
  v_owner_id uuid;
  v_smoke_scene_id uuid;
  v_read_embed_id uuid;
  v_write_embed_id uuid;
  v_owner_embed_id uuid;
  v_visible_count integer;
  v_loaded jsonb;
  v_saved_version integer;
  v_asset_id uuid;
  v_other_user_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_allowed_origin text := 'http://127.0.0.1:4313';
  v_blocked_origin text := 'http://127.0.0.1:4314';
begin
  select s.id, s.owner_id
    into v_fixture_scene_id, v_owner_id
  from public.scenes s
  where s.deleted_at is null
  order by s.updated_at desc
  limit 1;

  if v_fixture_scene_id is null then
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'cloud scene fixture', 'FAIL', 'No non-deleted cloud scene found. Save one cloud whiteboard first.');
    return;
  end if;

  if v_other_user_id = v_owner_id then
    v_other_user_id := '00000000-0000-0000-0000-000000000002'::uuid;
  end if;

  insert into phase3c_embed_smoke_results
    (sort_order, check_name, result, details)
  values
    (
      0,
      'cloud scene fixture',
      'INFO',
      'Using owner ' || v_owner_id::text || ' from scene ' || v_fixture_scene_id::text
    );

  insert into public.scenes (
    owner_id,
    title,
    payload_kind,
    payload,
    version
  )
  values (
    v_owner_id,
    'phase3c rls smoke: temporary scene',
    'plain',
    '{"elements":[],"appState":{}}'::jsonb,
    1
  )
  returning id into v_smoke_scene_id;

  insert into public.embeds (
    owner_id,
    scene_id,
    mode,
    token,
    allowed_origins,
    theme,
    size
  )
  values (
    v_owner_id,
    v_smoke_scene_id,
    'read',
    'phase3c-rls-smoke-read',
    array[v_allowed_origin],
    'system',
    'responsive'
  )
  returning id into v_read_embed_id;

  insert into public.embeds (
    owner_id,
    scene_id,
    mode,
    token,
    allowed_origins,
    theme,
    size
  )
  values (
    v_owner_id,
    v_smoke_scene_id,
    'write',
    'phase3c-rls-smoke-write',
    array[v_allowed_origin],
    'light',
    'wide'
  )
  returning id into v_write_embed_id;

  -- 1) anon cannot enumerate owner embeds.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select count(*)
      into v_visible_count
    from public.embeds
    where scene_id = v_smoke_scene_id;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        10,
        'anon cannot read embed metadata',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'anon visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (10, 'anon cannot read embed metadata', 'FAIL', sqlerrm);
  end;

  -- 2) owner can read own embed metadata.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.embeds
    where scene_id = v_smoke_scene_id;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        20,
        'owner can read own embed metadata',
        case when v_visible_count = 2 then 'PASS' else 'FAIL' end,
        'owner visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (20, 'owner can read own embed metadata', 'FAIL', sqlerrm);
  end;

  -- 3) owner can create own scene embed.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.embeds (
      owner_id,
      scene_id,
      mode,
      token,
      allowed_origins
    )
    values (
      v_owner_id,
      v_smoke_scene_id,
      'read',
      'phase3c-rls-smoke-owner-create',
      array[v_allowed_origin]
    )
    returning id into v_owner_embed_id;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        30,
        'owner can create own scene embed',
        'PASS',
        'inserted embed id = ' || v_owner_embed_id::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (30, 'owner can create own scene embed', 'FAIL', sqlerrm);
  end;

  -- 4) allowed origin can load through anonymous RPC.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select public.load_embedded_scene(
      'phase3c-rls-smoke-read',
      v_allowed_origin
    )
      into v_loaded;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        40,
        'allowed origin can load embedded scene',
        case when v_loaded is not null then 'PASS' else 'FAIL' end,
        coalesce('loaded mode = ' || (v_loaded ->> 'mode'), 'load returned null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (40, 'allowed origin can load embedded scene', 'FAIL', sqlerrm);
  end;

  -- 5) blocked origin cannot load.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select public.load_embedded_scene(
      'phase3c-rls-smoke-read',
      v_blocked_origin
    )
      into v_loaded;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        50,
        'blocked origin cannot load embedded scene',
        case when v_loaded is null then 'PASS' else 'FAIL' end,
        case when v_loaded is null then 'blocked origin returned null' else 'blocked origin loaded data' end
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (50, 'blocked origin cannot load embedded scene', 'FAIL', sqlerrm);
  end;

  -- 6) read embed cannot save.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    perform public.save_embedded_scene(
      'phase3c-rls-smoke-read',
      v_allowed_origin,
      '{"elements":[],"appState":{"smoke":"read"}}'::jsonb,
      'phase3c rls smoke: should not save',
      1,
      null
    );

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (60, 'read embed cannot save scene', 'FAIL', 'read token unexpectedly saved');
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        60,
        'read embed cannot save scene',
        case when sqlerrm like '%cloud-embed-forbidden%' then 'PASS' else 'FAIL' end,
        'read save was blocked: ' || sqlerrm
      );
  end;

  -- 7) write embed can save.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select version
      into v_saved_version
    from public.save_embedded_scene(
      'phase3c-rls-smoke-write',
      v_allowed_origin,
      '{"elements":[],"appState":{"smoke":"write"}}'::jsonb,
      'phase3c rls smoke: temporary scene',
      1,
      null
    );

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        70,
        'write embed can save scene',
        case when v_saved_version = 2 then 'PASS' else 'FAIL' end,
        'saved version = ' || coalesce(v_saved_version::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (70, 'write embed can save scene', 'FAIL', sqlerrm);
  end;

  -- 8) write embed can register asset metadata.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select id
      into v_asset_id
    from public.upsert_embedded_asset(
      'phase3c-rls-smoke-write',
      v_allowed_origin,
      'phase3c-rls-smoke-file',
      'image',
      v_owner_id::text || '/' || v_smoke_scene_id::text || '/phase3c-rls-smoke-file',
      'image/png',
      4
    );

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        80,
        'write embed can register asset',
        case when v_asset_id is not null then 'PASS' else 'FAIL' end,
        'asset id = ' || coalesce(v_asset_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (80, 'write embed can register asset', 'FAIL', sqlerrm);
  end;

  -- 9) other user cannot read or insert owner embed metadata.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.embeds
    where scene_id = v_smoke_scene_id;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        90,
        'other user cannot read owner embeds',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'other user visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (90, 'other user cannot read owner embeds', 'FAIL', sqlerrm);
  end;

  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.embeds (
      owner_id,
      scene_id,
      mode,
      token,
      allowed_origins
    )
    values (
      v_owner_id,
      v_smoke_scene_id,
      'read',
      'phase3c-rls-smoke-other-insert',
      array[v_allowed_origin]
    );

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (100, 'other user cannot insert owner scene embed', 'FAIL', 'other user insert unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        100,
        'other user cannot insert owner scene embed',
        case when sqlerrm like '%row-level security%' then 'PASS' else 'FAIL' end,
        'other user insert was blocked: ' || sqlerrm
      );
  end;

  -- 10) revoked token cannot load.
  begin
    update public.embeds
       set revoked = true
     where id = v_write_embed_id;

    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select public.load_embedded_scene(
      'phase3c-rls-smoke-write',
      v_allowed_origin
    )
      into v_loaded;

    execute 'reset role';

    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        110,
        'revoked embed cannot load',
        case when v_loaded is null then 'PASS' else 'FAIL' end,
        case when v_loaded is null then 'revoked token returned null' else 'revoked token loaded data' end
      );
  exception when others then
    execute 'reset role';
    insert into phase3c_embed_smoke_results
      (sort_order, check_name, result, details)
    values
      (110, 'revoked embed cannot load', 'FAIL', sqlerrm);
  end;

  delete from public.assets
  where file_id like 'phase3c-rls-smoke-%';

  delete from public.embeds
  where token like 'phase3c-rls-smoke-%';

  delete from public.scenes
  where id = v_smoke_scene_id;
end;
$phase3c_embed_smoke$;

select pg_temp.run_phase3c_embed_smoke();

select
  case
    when exists (
      select 1
      from phase3c_embed_smoke_results
      where result = 'FAIL'
    ) then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase3c_embed_smoke_results
order by sort_order, check_name;
