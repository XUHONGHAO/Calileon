-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4C collab persistence smoke
-- ----------------------------------------------------------------------------
-- Run after schema_collab_persistence.sql. Use "Run without RLS" in Supabase
-- SQL Editor. The script creates temporary room bindings and cleans them up.
-- ============================================================================

drop table if exists phase4c_collab_persistence_smoke_results;

create temp table phase4c_collab_persistence_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

delete from public.collab_room_assets
where room_id like 'phase4c-smoke-%';
delete from public.collab_room_snapshots
where room_id like 'phase4c-smoke-%';
delete from public.collab_rooms
where room_id like 'phase4c-smoke-%';

create or replace function pg_temp.run_phase4c_collab_persistence_smoke()
returns void
language plpgsql
as $phase4c_collab_persistence_smoke$
declare
  v_scene_id uuid;
  v_owner_id uuid;
  v_room_id text := 'phase4c-smoke-' || gen_random_uuid()::text;
  v_snapshot jsonb;
  v_asset public.collab_room_assets;
  v_version integer;
  v_visible_count integer;
  v_access text;
  v_other_user_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
begin
  select s.id, s.owner_id
    into v_scene_id, v_owner_id
  from public.scenes s
  where s.deleted_at is null
  order by s.updated_at desc
  limit 1;

  if v_scene_id is null then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'cloud scene fixture', 'FAIL', 'No non-deleted cloud scene found. Save one cloud whiteboard first.');
    return;
  end if;

  if v_other_user_id = v_owner_id then
    v_other_user_id := '00000000-0000-0000-0000-000000000002'::uuid;
  end if;

  insert into public.collab_rooms (
    owner_id,
    scene_id,
    room_id,
    status
  )
  values (
    v_owner_id,
    v_scene_id,
    v_room_id,
    'active'
  );

  insert into phase4c_collab_persistence_smoke_results
    (sort_order, check_name, result, details)
  values
    (
      0,
      'cloud scene fixture',
      'INFO',
      'Using scene ' || v_scene_id::text || ' with room ' || v_room_id
    );

  begin
    select version
      into v_version
    from public.save_collab_room_snapshot(
      v_room_id,
      jsonb_build_object(
        'version',
        1,
        'iv',
        'phase4c-smoke-iv',
        'ciphertext',
        'phase4c-smoke-ciphertext'
      )
    );

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'snapshot can be saved',
        case when v_version = 1 then 'PASS' else 'FAIL' end,
        'version = ' || coalesce(v_version::text, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (1, 'snapshot can be saved', 'FAIL', 'save failed: ' || sqlerrm);
  end;

  begin
    select public.load_collab_room_snapshot(v_room_id)
      into v_snapshot;

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'snapshot can be loaded',
        case when v_snapshot is not null then 'PASS' else 'FAIL' end,
        'snapshot = ' || coalesce(v_snapshot::text, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (2, 'snapshot can be loaded', 'FAIL', 'load failed: ' || sqlerrm);
  end;

  begin
    select *
      into v_asset
    from public.register_collab_room_asset(
      v_room_id,
      'file-1',
      'collab/' || v_room_id || '/file-1',
      'image/png',
      42
    );

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'collab asset can be registered',
        case when v_asset.id is not null then 'PASS' else 'FAIL' end,
        'asset id = ' || coalesce(v_asset.id::text, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (3, 'collab asset can be registered', 'FAIL', 'asset insert failed: ' || sqlerrm);
  end;

  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select count(*)
      into v_visible_count
    from public.collab_room_snapshots
    where room_id = v_room_id;

    execute 'reset role';

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'anon cannot enumerate collab snapshots',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'anon visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'anon cannot enumerate collab snapshots',
        'PASS',
        'anon query was blocked: ' || sqlerrm
      );
  end;

  begin
    select public.get_collab_room_access(v_room_id)
      into v_access;

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'active collab room access is active',
        case when v_access = 'active' then 'PASS' else 'FAIL' end,
        'access = ' || coalesce(v_access, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (5, 'active collab room access is active', 'FAIL', 'access check failed: ' || sqlerrm);
  end;

  begin
    update public.collab_rooms
    set status = 'revoked',
        revoked_at = now()
    where room_id = v_room_id;

    select public.get_collab_room_access(v_room_id)
      into v_access;

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        6,
        'revoked collab room access is revoked',
        case when v_access = 'revoked' then 'PASS' else 'FAIL' end,
        'access = ' || coalesce(v_access, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (6, 'revoked collab room access is revoked', 'FAIL', 'access check failed: ' || sqlerrm);
  end;

  begin
    select public.get_collab_room_access('phase4c-unknown-room')
      into v_access;

    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        7,
        'unknown collab room access is unknown',
        case when v_access = 'unknown' then 'PASS' else 'FAIL' end,
        'access = ' || coalesce(v_access, 'null')
      );
  exception when others then
    insert into phase4c_collab_persistence_smoke_results
      (sort_order, check_name, result, details)
    values
      (7, 'unknown collab room access is unknown', 'FAIL', 'access check failed: ' || sqlerrm);
  end;
end;
$phase4c_collab_persistence_smoke$;

select pg_temp.run_phase4c_collab_persistence_smoke();

delete from public.collab_room_assets
where room_id like 'phase4c-smoke-%';
delete from public.collab_room_snapshots
where room_id like 'phase4c-smoke-%';
delete from public.collab_rooms
where room_id like 'phase4c-smoke-%';

select
  case
    when exists (
      select 1
      from phase4c_collab_persistence_smoke_results
      where result = 'FAIL'
    )
    then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase4c_collab_persistence_smoke_results
order by sort_order;
