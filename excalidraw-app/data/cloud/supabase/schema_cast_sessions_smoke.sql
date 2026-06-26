-- ============================================================================
-- Excalidraw self-hosted backend - Phase 3B cast session/export RLS smoke test
-- ----------------------------------------------------------------------------
-- Run after schema_cast_sessions.sql.
--
-- Usage:
--   1. Make sure at least one cloud whiteboard exists in public.scenes.
--   2. Open Supabase SQL Editor.
--   3. Paste this whole file and run it.
--   4. Check the final result table:
--      - overall_result = PASS means the RLS smoke passed.
--      - Any FAIL row includes details.
--
-- This script picks the most recently updated non-deleted scene automatically.
-- It inserts temporary metadata-only assets/sessions/exports and deletes them
-- before finishing. It does not upload Storage objects.
-- ============================================================================

drop table if exists phase3b_cast_smoke_results;

create temp table phase3b_cast_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

delete from public.cast_exports
where label like 'phase3b rls smoke:%';

delete from public.cast_sessions
where title like 'phase3b rls smoke:%';

delete from public.assets
where file_id like 'phase3b-rls-smoke-%';

create or replace function pg_temp.run_phase3b_cast_smoke()
returns void
language plpgsql
as $phase3b_cast_smoke$
declare
  v_scene_id uuid;
  v_owner_id uuid;
  v_script_asset_id uuid;
  v_export_asset_id uuid;
  v_seed_session_id uuid;
  v_seed_export_id uuid;
  v_owner_session_id uuid;
  v_owner_export_id uuid;
  v_visible_count integer;
  v_other_user_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
begin
  select s.id, s.owner_id
    into v_scene_id, v_owner_id
  from public.scenes s
  where s.deleted_at is null
  order by s.updated_at desc
  limit 1;

  if v_scene_id is null then
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'cloud scene fixture', 'FAIL', 'No non-deleted cloud scene found. Save one cloud whiteboard first.');
    return;
  end if;

  if v_other_user_id = v_owner_id then
    v_other_user_id := '00000000-0000-0000-0000-000000000002'::uuid;
  end if;

  insert into phase3b_cast_smoke_results
    (sort_order, check_name, result, details)
  values
    (
      0,
      'cloud scene fixture',
      'INFO',
      'Using latest scene ' || v_scene_id::text || ' owned by ' || v_owner_id::text
    );

  insert into public.assets (
    owner_id,
    scene_id,
    file_id,
    type,
    storage_path,
    mime_type,
    bytes
  )
  values (
    v_owner_id,
    v_scene_id,
    'phase3b-rls-smoke-script',
    'recording',
    v_owner_id::text || '/' || v_scene_id::text || '/phase3b-rls-smoke-script.json',
    'application/json',
    64
  )
  returning id into v_script_asset_id;

  insert into public.assets (
    owner_id,
    scene_id,
    file_id,
    type,
    storage_path,
    mime_type,
    bytes
  )
  values (
    v_owner_id,
    v_scene_id,
    'phase3b-rls-smoke-export',
    'export',
    v_owner_id::text || '/' || v_scene_id::text || '/phase3b-rls-smoke-export.json',
    'application/json',
    128
  )
  returning id into v_export_asset_id;

  insert into public.cast_sessions (
    owner_id,
    scene_id,
    title,
    status,
    script_asset_id,
    duration_ms
  )
  values (
    v_owner_id,
    v_scene_id,
    'phase3b rls smoke: seed session',
    'ready',
    v_script_asset_id,
    1200
  )
  returning id into v_seed_session_id;

  insert into public.cast_exports (
    owner_id,
    scene_id,
    session_id,
    asset_id,
    type,
    label,
    mime_type,
    bytes
  )
  values (
    v_owner_id,
    v_scene_id,
    v_seed_session_id,
    v_export_asset_id,
    'interactive',
    'phase3b rls smoke: seed export',
    'application/json',
    128
  )
  returning id into v_seed_export_id;

  -- 1) anon cannot enumerate owner cast sessions/exports.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select
      (
        select count(*)
        from public.cast_sessions
        where id = v_seed_session_id
      )
      + (
        select count(*)
        from public.cast_exports
        where id = v_seed_export_id
      )
      into v_visible_count;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read cast metadata',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'anon visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read cast metadata',
        'PASS',
        'anon query was blocked: ' || sqlerrm
      );
  end;

  -- 2) owner can read own cast sessions/exports.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select
      (
        select count(*)
        from public.cast_sessions
        where id = v_seed_session_id
      )
      + (
        select count(*)
        from public.cast_exports
        where id = v_seed_export_id
      )
      into v_visible_count;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own cast metadata',
        case when v_visible_count = 2 then 'PASS' else 'FAIL' end,
        'owner visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own cast metadata',
        'FAIL',
        'owner query failed: ' || sqlerrm
      );
  end;

  -- 3) owner can create a cast session for their own scene.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.cast_sessions (
      owner_id,
      scene_id,
      title,
      status
    )
    values (
      v_owner_id,
      v_scene_id,
      'phase3b rls smoke: owner session',
      'draft'
    )
    returning id into v_owner_session_id;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can create own scene cast session',
        case when v_owner_session_id is not null then 'PASS' else 'FAIL' end,
        'inserted session id = ' || coalesce(v_owner_session_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can create own scene cast session',
        'FAIL',
        'owner insert failed: ' || sqlerrm
      );
  end;

  -- 4) owner can attach a JSON recording asset.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    update public.cast_sessions
    set
      status = 'ready',
      script_asset_id = v_script_asset_id,
      duration_ms = 1200
    where id = v_owner_session_id
    returning id into v_owner_session_id;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'owner can attach recording asset',
        case when v_owner_session_id is not null then 'PASS' else 'FAIL' end,
        'attached script asset id = ' || coalesce(v_script_asset_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'owner can attach recording asset',
        'FAIL',
        'owner update failed: ' || sqlerrm
      );
  end;

  -- 5) owner can register an export artifact.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.cast_exports (
      owner_id,
      scene_id,
      session_id,
      asset_id,
      type,
      label,
      mime_type,
      bytes
    )
    values (
      v_owner_id,
      v_scene_id,
      v_owner_session_id,
      v_export_asset_id,
      'interactive',
      'phase3b rls smoke: owner export',
      'application/json',
      128
    )
    returning id into v_owner_export_id;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'owner can register cast export',
        case when v_owner_export_id is not null then 'PASS' else 'FAIL' end,
        'inserted export id = ' || coalesce(v_owner_export_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'owner can register cast export',
        'FAIL',
        'owner export insert failed: ' || sqlerrm
      );
  end;

  -- 6) another authenticated user cannot read owner cast metadata.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select
      (
        select count(*)
        from public.cast_sessions
        where id = v_seed_session_id
      )
      + (
        select count(*)
        from public.cast_exports
        where id = v_seed_export_id
      )
      into v_visible_count;

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        6,
        'other user cannot read owner cast metadata',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'other user visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        6,
        'other user cannot read owner cast metadata',
        'PASS',
        'other user query was blocked: ' || sqlerrm
      );
  end;

  -- 7) another authenticated user cannot insert a session for owner scene.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.cast_sessions (
      owner_id,
      scene_id,
      title,
      status
    )
    values (
      v_other_user_id,
      v_scene_id,
      'phase3b rls smoke: other session',
      'draft'
    );

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        7,
        'other user cannot insert owner scene cast session',
        'FAIL',
        'other user session insert unexpectedly succeeded'
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        7,
        'other user cannot insert owner scene cast session',
        'PASS',
        'other user insert was blocked: ' || sqlerrm
      );
  end;

  -- 8) another authenticated user cannot register an export for owner session.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.cast_exports (
      owner_id,
      scene_id,
      session_id,
      asset_id,
      type,
      label,
      mime_type,
      bytes
    )
    values (
      v_other_user_id,
      v_scene_id,
      v_seed_session_id,
      v_export_asset_id,
      'interactive',
      'phase3b rls smoke: other export',
      'application/json',
      128
    );

    execute 'reset role';

    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        8,
        'other user cannot insert owner cast export',
        'FAIL',
        'other user export insert unexpectedly succeeded'
      );
  exception when others then
    execute 'reset role';
    insert into phase3b_cast_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        8,
        'other user cannot insert owner cast export',
        'PASS',
        'other user export insert was blocked: ' || sqlerrm
      );
  end;
end;
$phase3b_cast_smoke$;

select pg_temp.run_phase3b_cast_smoke();

delete from public.cast_exports
where label like 'phase3b rls smoke:%';

delete from public.cast_sessions
where title like 'phase3b rls smoke:%';

delete from public.assets
where file_id like 'phase3b-rls-smoke-%';

select
  case
    when exists (
      select 1
      from phase3b_cast_smoke_results
      where result = 'FAIL'
    )
    then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase3b_cast_smoke_results
order by sort_order;
