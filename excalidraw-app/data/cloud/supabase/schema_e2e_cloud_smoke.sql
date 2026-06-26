-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4D E2E cloud storage smoke
-- ----------------------------------------------------------------------------
-- Run after schema_e2e_cloud.sql. Use "Run without RLS" in Supabase SQL Editor.
-- This validates encrypted payload shape constraints without storing plaintext.
-- ============================================================================

drop table if exists phase4d_e2e_cloud_smoke_results;

create temp table phase4d_e2e_cloud_smoke_results (
  sort_order integer not null,
  check_name text not null,
  result text not null check (result in ('INFO', 'PASS', 'FAIL')),
  details text not null
);

create or replace function pg_temp.run_phase4d_e2e_cloud_smoke()
returns void
language plpgsql
as $phase4d_e2e_cloud_smoke$
declare
  v_owner_id uuid;
  v_scene_id uuid;
  v_payload jsonb := jsonb_build_object(
    'version',
    1,
    'algorithm',
    'AES-GCM',
    'iv',
    'phase4d-smoke-iv',
    'ciphertext',
    'phase4d-smoke-ciphertext'
  );
begin
  select s.owner_id
    into v_owner_id
  from public.scenes s
  where s.deleted_at is null
  order by s.updated_at desc
  limit 1;

  if v_owner_id is null then
    insert into phase4d_e2e_cloud_smoke_results
      (sort_order, check_name, result, details)
    values
      (0, 'owner fixture', 'FAIL', 'No existing owner found. Save one cloud whiteboard first.');
    return;
  end if;

  insert into phase4d_e2e_cloud_smoke_results
    (sort_order, check_name, result, details)
  values
    (0, 'owner fixture', 'INFO', 'Using owner ' || v_owner_id::text);

  insert into phase4d_e2e_cloud_smoke_results
    (sort_order, check_name, result, details)
  select
    1,
    'asset bucket accepts encrypted octet-stream',
    case
      when exists (
        select 1
        from storage.buckets b
        where b.id = 'excalidraw-assets'
          and 'application/octet-stream' = any(coalesce(b.allowed_mime_types, array[]::text[]))
      )
      then 'PASS'
      else 'FAIL'
    end,
    coalesce(
      (
        select array_to_string(b.allowed_mime_types, ', ')
        from storage.buckets b
        where b.id = 'excalidraw-assets'
      ),
      'missing excalidraw-assets bucket'
    );

  begin
    insert into public.scenes (
      owner_id,
      title,
      payload_kind,
      payload
    )
    values (
      v_owner_id,
      'phase4d e2e smoke',
      'encrypted',
      v_payload
    )
    returning id into v_scene_id;

    insert into phase4d_e2e_cloud_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'encrypted payload v1 is accepted',
        'PASS',
        'inserted scene id = ' || v_scene_id::text
      );
  exception when others then
    insert into phase4d_e2e_cloud_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        2,
        'encrypted payload v1 is accepted',
        'FAIL',
        'insert failed: ' || sqlerrm
      );
  end;

  begin
    insert into public.scenes (
      owner_id,
      title,
      payload_kind,
      payload
    )
    values (
      v_owner_id,
      'phase4d invalid e2e smoke',
      'encrypted',
      jsonb_build_object('plaintext', 'this should fail')
    );

    insert into phase4d_e2e_cloud_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'invalid encrypted payload is rejected',
        'FAIL',
        'invalid encrypted payload unexpectedly inserted'
      );
  exception when others then
    insert into phase4d_e2e_cloud_smoke_results
      (sort_order, check_name, result, details)
    values
      (
        3,
        'invalid encrypted payload is rejected',
        'PASS',
        'invalid payload was blocked: ' || sqlerrm
      );
  end;
end;
$phase4d_e2e_cloud_smoke$;

select pg_temp.run_phase4d_e2e_cloud_smoke();

delete from public.scenes
where title in ('phase4d e2e smoke', 'phase4d invalid e2e smoke');

select
  case
    when exists (
      select 1
      from phase4d_e2e_cloud_smoke_results
      where result = 'FAIL'
    )
    then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  result,
  details
from phase4d_e2e_cloud_smoke_results
order by sort_order;
