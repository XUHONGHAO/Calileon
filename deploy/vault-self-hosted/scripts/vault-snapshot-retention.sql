-- Vault snapshot-update retention.
--
-- `vault_snapshot_updates` is an idempotency ledger, not an archive. Before
-- inserting, `cas_vault_snapshot` looks a row up by
-- (vault_id, room_id, update_id) so that a retried update returns success
-- instead of creating a second generation. Rows therefore only matter while a
-- retry is still plausible, and without a policy the table grows without bound:
-- one full encrypted envelope per autosave, up to 50 MiB per row.
--
-- Deleting an old row is safe. A retry that no longer finds its row either runs
-- as a benign duplicate (same content, newer generation) or fails the
-- generation check with VAULT_SNAPSHOT_CONFLICT, which the client resolves by
-- re-reading and merging. Neither outcome loses data.
--
-- Retention, per (vault_id, room_id):
--   * always keep the newest 50 rows, and
--   * keep older rows until the cumulative ciphertext size would exceed 256 MiB.
--
-- Capping bytes rather than row count matters because a single row may be up to
-- 50 MiB: a row count alone would bound nothing. Worst case per room is
-- therefore 50 x the row cap, which is documented in the README.
--
-- To change either value, edit the two literals in the job below and re-run the
-- migrate profile; the job is upserted by name.
--
-- This file adds nothing to the `public` schema, so the frozen Vault schema
-- contract is untouched.
--
-- Tolerance: `pg_cron` can only be installed in the database named by
-- `cron.database_name`, so this is best-effort. A restore drill reconciles an
-- isolated database in the same cluster and must not fail here. A missing job is
-- not silent though: `schema-smoke` fails when the job is absent.

do $$
begin
  execute 'create extension if not exists pg_cron';

  perform cron.schedule(
    'vault-snapshot-updates-retention',
    '17 3 * * *',
    $job$
    with ranked as (
      select
        vault_id,
        room_id,
        update_id,
        row_number() over (
          partition by vault_id, room_id
          order by generation desc, created_at desc, update_id desc
        ) as row_from_newest,
        sum(ciphertext_bytes) over (
          partition by vault_id, room_id
          order by generation desc, created_at desc, update_id desc
          rows between unbounded preceding and current row
        ) as bytes_from_newest
      from public.vault_snapshot_updates
    )
    delete from public.vault_snapshot_updates as stale
    using ranked
    where stale.vault_id = ranked.vault_id
      and stale.room_id = ranked.room_id
      and stale.update_id = ranked.update_id
      and ranked.row_from_newest > 50
      and ranked.bytes_from_newest > 268435456
    $job$
  );

  raise notice 'vault snapshot-update retention scheduled (newest 50 rows, 256 MiB per room)';
exception when others then
  raise warning 'vault snapshot-update retention NOT scheduled here: %', sqlerrm;
end;
$$;
