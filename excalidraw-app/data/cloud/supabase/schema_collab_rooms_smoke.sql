-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4B collab_rooms RLS smoke test
-- ----------------------------------------------------------------------------
-- Run after schema_collab_rooms.sql. Use "Run without RLS" in Supabase SQL
-- Editor. The script picks the latest non-deleted cloud scene automatically.
-- ============================================================================

drop table if exists phase4b_collab_rooms_smoke_results;

create temp table phase4b_collab_rooms_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

delete from public.collab_rooms
where room_id like 'phase4b-smoke-%';

create or replace function pg_temp.run_phase4b_collab_rooms_smoke()
returns void
language plpgsql
as $phase4b_collab_rooms_smoke$
declare
  v_scene_id uuid;
  v_owner_id uuid;
  v_room_id uuid;
  v_owner_room_id uuid;
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
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'cloud scene fixture', 'FAIL', 'No non-deleted cloud scene found. Save one cloud whiteboard first.');
    return;
  end if;

  if v_other_user_id = v_owner_id then
    v_other_user_id := '00000000-0000-0000-0000-000000000002'::uuid;
  end if;

  insert into phase4b_collab_rooms_smoke_results
    (sort_order, check_name, result, details)
  values
    (
      0,
      'cloud scene fixture',
      'INFO',
      'Using latest scene ' || v_scene_id::text || ' owned by ' || v_owner_id::text
    );

  insert into public.collab_rooms (
    owner_id,
    scene_id,
    room_id,
    status
  )
  values (
    v_owner_id,
    v_scene_id,
    'phase4b-smoke-seed-' || gen_random_uuid()::text,
    'active'
  )
  returning id into v_room_id;

  -- 1) anon cannot enumerate owner room bindings.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select count(*)
      into v_visible_count
    from public.collab_rooms
    where id = v_room_id;

    execute 'reset role';

    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read collab room metadata',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'anon visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read collab room metadata',
        'PASS',
        'anon query was blocked: ' || sqlerrm
      );
  end;

  -- 2) owner can read own binding.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.collab_rooms
    where id = v_room_id;

    execute 'reset role';

    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own collab room metadata',
        case when v_visible_count = 1 then 'PASS' else 'FAIL' end,
        'owner visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own collab room metadata',
        'FAIL',
        'owner query failed: ' || sqlerrm
      );
  end;

  -- 3) owner can insert and revoke own binding.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.collab_rooms (
      owner_id,
      scene_id,
      room_id,
      status
    )
    values (
      v_owner_id,
      v_scene_id,
      'phase4b-smoke-owner-' || gen_random_uuid()::text,
      'active'
    )
    returning id into v_owner_room_id;

    update public.collab_rooms
       set status = 'revoked',
           revoked_at = now()
     where id = v_owner_room_id;

    execute 'reset role';

    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can create and revoke own collab room',
        case when v_owner_room_id is not null then 'PASS' else 'FAIL' end,
        'room binding id = ' || coalesce(v_owner_room_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can create and revoke own collab room',
        'FAIL',
        'owner write failed: ' || sqlerrm
      );
  end;

  -- 4) another authenticated user cannot read owner binding.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.collab_rooms
    where id = v_room_id;

    execute 'reset role';

    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'other user cannot read owner collab room',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'other user visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'other user cannot read owner collab room',
        'PASS',
        'other user query was blocked: ' || sqlerrm
      );
  end;

  -- 5) another authenticated user cannot insert a binding for owner scene.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.collab_rooms (
      owner_id,
      scene_id,
      room_id,
      status
    )
    values (
      v_other_user_id,
      v_scene_id,
      'phase4b-smoke-other-' || gen_random_uuid()::text,
      'active'
    );

    execute 'reset role';

    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'other user cannot insert owner scene collab room',
        'FAIL',
        'other user insert unexpectedly succeeded'
      );
  exception when others then
    execute 'reset role';
    insert into phase4b_collab_rooms_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'other user cannot insert owner scene collab room',
        'PASS',
        'other user insert was blocked: ' || sqlerrm
      );
  end;
end;
$phase4b_collab_rooms_smoke$;

select pg_temp.run_phase4b_collab_rooms_smoke();

delete from public.collab_rooms
where room_id like 'phase4b-smoke-%';

select
  case
    when exists (
      select 1
      from phase4b_collab_rooms_smoke_results
      where result = 'FAIL'
    )
    then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase4b_collab_rooms_smoke_results
order by sort_order;
