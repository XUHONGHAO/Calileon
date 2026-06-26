-- ============================================================================
-- Excalidraw self-hosted backend - Phase 3A activity_log RLS smoke test
-- ----------------------------------------------------------------------------
-- Run after schema_activity_log.sql.
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
-- It inserts temporary smoke rows and deletes them before finishing.
-- ============================================================================

drop table if exists phase3a_activity_log_smoke_results;

create temp table phase3a_activity_log_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

delete from public.activity_log
where summary like 'phase3a rls smoke:%';

create or replace function pg_temp.run_phase3a_activity_log_smoke()
returns void
language plpgsql
as $phase3a_activity_log_smoke$
declare
  v_scene_id uuid;
  v_owner_id uuid;
  v_seed_activity_id uuid;
  v_owner_insert_id uuid;
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
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'cloud scene fixture', 'FAIL', 'No non-deleted cloud scene found. Save one cloud whiteboard first.');
    return;
  end if;

  if v_other_user_id = v_owner_id then
    v_other_user_id := '00000000-0000-0000-0000-000000000002'::uuid;
  end if;

  insert into phase3a_activity_log_smoke_results
    (sort_order, check_name, result, details)
  values
    (
      0,
      'cloud scene fixture',
      'INFO',
      'Using latest scene ' || v_scene_id::text || ' owned by ' || v_owner_id::text
    );

  insert into public.activity_log (
    owner_id,
    scene_id,
    element_id,
    actor_id,
    op_type,
    summary
  )
  values (
    v_owner_id,
    v_scene_id,
    'phase3a-rls-smoke-seed',
    v_owner_id::text,
    'update',
    'phase3a rls smoke: seed row'
  )
  returning id into v_seed_activity_id;

  -- 1) anon cannot enumerate owner activity.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'anon', true);
    execute 'set local role anon';

    select count(*)
      into v_visible_count
    from public.activity_log
    where id = v_seed_activity_id;

    execute 'reset role';

    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read activity_log',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'anon visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        1,
        'anon cannot read activity_log',
        'PASS',
        'anon query was blocked: ' || sqlerrm
      );
  end;

  -- 2) owner can read own activity.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.activity_log
    where id = v_seed_activity_id;

    execute 'reset role';

    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own activity_log',
        case when v_visible_count = 1 then 'PASS' else 'FAIL' end,
        'owner visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'owner can read own activity_log',
        'FAIL',
        'owner query failed: ' || sqlerrm
      );
  end;

  -- 3) owner can insert activity for their own scene.
  begin
    perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.activity_log (
      owner_id,
      scene_id,
      element_id,
      actor_id,
      op_type,
      summary
    )
    values (
      v_owner_id,
      v_scene_id,
      'phase3a-rls-smoke-owner-insert',
      v_owner_id::text,
      'update',
      'phase3a rls smoke: owner insert'
    )
    returning id into v_owner_insert_id;

    execute 'reset role';

    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can insert own scene activity',
        case when v_owner_insert_id is not null then 'PASS' else 'FAIL' end,
        'inserted activity id = ' || coalesce(v_owner_insert_id::text, 'null')
      );
  exception when others then
    execute 'reset role';
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'owner can insert own scene activity',
        'FAIL',
        'owner insert failed: ' || sqlerrm
      );
  end;

  -- 4) another authenticated user cannot read owner activity.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    select count(*)
      into v_visible_count
    from public.activity_log
    where id = v_seed_activity_id;

    execute 'reset role';

    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'other user cannot read owner activity',
        case when v_visible_count = 0 then 'PASS' else 'FAIL' end,
        'other user visible rows = ' || v_visible_count::text
      );
  exception when others then
    execute 'reset role';
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        4,
        'other user cannot read owner activity',
        'PASS',
        'other user query was blocked: ' || sqlerrm
      );
  end;

  -- 5) another authenticated user cannot insert activity for owner scene.
  begin
    perform set_config('request.jwt.claim.sub', v_other_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    execute 'set local role authenticated';

    insert into public.activity_log (
      owner_id,
      scene_id,
      element_id,
      actor_id,
      op_type,
      summary
    )
    values (
      v_other_user_id,
      v_scene_id,
      'phase3a-rls-smoke-other-insert',
      v_other_user_id::text,
      'update',
      'phase3a rls smoke: other insert'
    );

    execute 'reset role';

    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'other user cannot insert owner scene activity',
        'FAIL',
        'other user insert unexpectedly succeeded'
      );
  exception when others then
    execute 'reset role';
    insert into phase3a_activity_log_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        5,
        'other user cannot insert owner scene activity',
        'PASS',
        'other user insert was blocked: ' || sqlerrm
      );
  end;
end;
$phase3a_activity_log_smoke$;

select pg_temp.run_phase3a_activity_log_smoke();

delete from public.activity_log
where summary like 'phase3a rls smoke:%';

select
  case
    when exists (
      select 1
      from phase3a_activity_log_smoke_results
      where result = 'FAIL'
    )
    then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase3a_activity_log_smoke_results
order by sort_order;
