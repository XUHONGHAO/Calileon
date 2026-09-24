import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { GatewayError } from "./errors.js";

import type {
  AuditRecord,
  EncryptedEnvelope,
  GatewayIdentity,
  GatewayQuotaPolicy,
  GatewayQuotaSnapshot,
  GatewayReservation,
  GatewayStore,
  GatewayUsageRecord,
  StoredCredential,
} from "./types.js";

type QueryResult<Row extends Record<string, any> = Record<string, any>> = {
  rows: Row[];
  rowCount: number | null;
};

export type GatewayPoolClient = {
  query<Row extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
};

export type GatewayPool = {
  query<Row extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  connect(): Promise<GatewayPoolClient>;
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);

const createPool = (databaseUrl: string): GatewayPool => {
  const moduleName = "pg";
  const pg = require(moduleName) as {
    Pool: new (options: {
      connectionString: string;
      max: number;
    }) => GatewayPool;
  };
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
};

const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const monthKey = (date: Date) => `${date.toISOString().slice(0, 7)}-01`;
const identityLockKey = (identity: GatewayIdentity) =>
  `${identity.issuer}\n${identity.subject}`;

const getPolicy = (policies: readonly GatewayQuotaPolicy[], policyId: string) =>
  policies.find((policy) => policy.id === policyId);

const toEnvelope = (value: unknown): EncryptedEnvelope =>
  value as EncryptedEnvelope;

const isUniqueViolation = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === "23505";

export class PostgresGatewayStore implements GatewayStore {
  private readonly pool: GatewayPool;

  constructor(databaseUrl: string, pool?: GatewayPool) {
    this.pool = pool || createPool(databaseUrl);
  }

  async checkReady() {
    try {
      const result = await this.pool.query(
        "select version from ai_gateway.schema_migrations where version = $1",
        ["0001_ai_gateway"],
      );
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async migrate(sql: string) {
    await this.pool.query(sql);
  }

  async close() {
    await this.pool.end();
  }

  async getCredential(id: string): Promise<StoredCredential | null> {
    const result = await this.pool.query(
      "select id, envelope, version, updated_at from ai_gateway.credentials where id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          envelope: toEnvelope(row.envelope),
          version: Number(row.version),
          updatedAt: new Date(row.updated_at).getTime(),
        }
      : null;
  }

  async putCredential(id: string, envelope: EncryptedEnvelope) {
    const result = await this.pool.query(
      `insert into ai_gateway.credentials (id, envelope)
       values ($1, $2::jsonb)
       on conflict (id) do update
       set envelope = excluded.envelope,
           version = ai_gateway.credentials.version + 1,
           updated_at = now()
       returning version`,
      [id, JSON.stringify(envelope)],
    );
    return Number(result.rows[0].version);
  }

  async removeCredential(id: string) {
    await this.pool.query("delete from ai_gateway.credentials where id = $1", [
      id,
    ]);
  }

  async assignPolicy(identity: GatewayIdentity, policyId: string) {
    await this.pool.query(
      `insert into ai_gateway.policy_assignments (issuer, subject, policy_id)
       values ($1, $2, $3)
       on conflict (issuer, subject) do update
       set policy_id = excluded.policy_id, updated_at = now()`,
      [identity.issuer, identity.subject, policyId],
    );
  }

  private async resolvePolicy(
    client: GatewayPoolClient | GatewayPool,
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ) {
    const result = await client.query(
      "select policy_id from ai_gateway.policy_assignments where issuer = $1 and subject = $2",
      [identity.issuer, identity.subject],
    );
    const policyId = result.rows[0]?.policy_id || defaultPolicy.id;
    const policy = getPolicy(policies, policyId);
    if (!policy) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
        message: "The assigned quota policy is not configured.",
      });
    }
    return policy;
  }

  async getPolicy(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ) {
    return this.resolvePolicy(this.pool, identity, defaultPolicy, policies);
  }

  private async usedUnits(
    client: GatewayPoolClient | GatewayPool,
    identity: GatewayIdentity,
    kind: "day" | "month",
    start: string,
  ) {
    const result = await client.query(
      `select used_units from ai_gateway.usage_buckets
       where issuer = $1 and subject = $2 and period_kind = $3 and period_start = $4`,
      [identity.issuer, identity.subject, kind, start],
    );
    return Number(result.rows[0]?.used_units || 0);
  }

  async reserve(input: {
    identity: GatewayIdentity;
    requestId: string;
    routeId: string;
    operation: string;
    costUnits: number;
    defaultPolicy: GatewayQuotaPolicy;
    policies: readonly GatewayQuotaPolicy[];
    leaseMs: number;
  }): Promise<GatewayReservation> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        identityLockKey(input.identity),
      ]);
      const policy = await this.resolvePolicy(
        client,
        input.identity,
        input.defaultPolicy,
        input.policies,
      );
      const now = new Date();
      const day = dateKey(now);
      const month = monthKey(now);
      const activeResult = await client.query(
        `select count(*)::integer as count from ai_gateway.requests
         where issuer = $1 and subject = $2
           and status in ('reserved', 'running') and lease_expires_at > now()`,
        [input.identity.issuer, input.identity.subject],
      );
      const activeRequests = Number(activeResult.rows[0].count);
      if (activeRequests >= policy.maxConcurrency) {
        throw new GatewayError("AI_GATEWAY_CONCURRENCY_EXCEEDED", 429, {
          retryable: true,
        });
      }
      const minuteResult = await client.query(
        `select count(*)::integer as count from ai_gateway.requests
         where issuer = $1 and subject = $2 and created_at >= now() - interval '1 minute'`,
        [input.identity.issuer, input.identity.subject],
      );
      if (Number(minuteResult.rows[0].count) >= policy.requestsPerMinute) {
        throw new GatewayError("AI_GATEWAY_RATE_LIMITED", 429, {
          retryable: true,
        });
      }
      const dailyUsed = await this.usedUnits(
        client,
        input.identity,
        "day",
        day,
      );
      const monthlyUsed = await this.usedUnits(
        client,
        input.identity,
        "month",
        month,
      );
      if (
        dailyUsed + input.costUnits > policy.dailyCredits ||
        monthlyUsed + input.costUnits > policy.monthlyCredits
      ) {
        throw new GatewayError("AI_GATEWAY_QUOTA_EXCEEDED", 429, {
          retryable: false,
        });
      }
      for (const [kind, start] of [
        ["day", day],
        ["month", month],
      ] as const) {
        await client.query(
          `insert into ai_gateway.usage_buckets
             (issuer, subject, period_kind, period_start, used_units)
           values ($1, $2, $3, $4, $5)
           on conflict (issuer, subject, period_kind, period_start) do update
           set used_units = ai_gateway.usage_buckets.used_units + excluded.used_units,
               updated_at = now()`,
          [
            input.identity.issuer,
            input.identity.subject,
            kind,
            start,
            input.costUnits,
          ],
        );
      }
      await client.query(
        `insert into ai_gateway.requests
          (request_id, issuer, subject, route_id, operation, cost_units, status, lease_expires_at)
         values ($1, $2, $3, $4, $5, $6, 'reserved', now() + ($7 * interval '1 millisecond'))`,
        [
          input.requestId,
          input.identity.issuer,
          input.identity.subject,
          input.routeId,
          input.operation,
          input.costUnits,
          input.leaseMs,
        ],
      );
      await client.query("commit");
      return {
        requestId: input.requestId,
        policy,
        snapshot: {
          policyId: policy.id,
          daily: {
            used: dailyUsed + input.costUnits,
            limit: policy.dailyCredits,
          },
          monthly: {
            used: monthlyUsed + input.costUnits,
            limit: policy.monthlyCredits,
          },
          activeRequests: activeRequests + 1,
          maxConcurrency: policy.maxConcurrency,
        },
      };
    } catch (error) {
      await client.query("rollback");
      if (isUniqueViolation(error)) {
        throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
          message: "The request ID has already been used.",
          retryable: false,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markDispatched(requestId: string) {
    const result = await this.pool.query(
      `update ai_gateway.requests set status = 'running', updated_at = now()
       where request_id = $1 and status = 'reserved' and lease_expires_at > now()`,
      [requestId],
    );
    return result.rowCount === 1;
  }

  async finish(input: {
    requestId: string;
    status: "succeeded" | "failed" | "aborted";
    providerAttempts: number;
    responseBytes: number;
    durationMs: number;
    errorCode?: string;
  }) {
    await this.pool.query(
      `update ai_gateway.requests
       set status = $2, provider_attempts = $3, response_bytes = $4,
           duration_ms = $5, error_code = $6, updated_at = now()
       where request_id = $1 and status in ('reserved', 'running')`,
      [
        input.requestId,
        input.status,
        input.providerAttempts,
        input.responseBytes,
        input.durationMs,
        input.errorCode || null,
      ],
    );
  }

  async release(requestId: string, errorCode: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `select issuer, subject, cost_units, created_at, status
         from ai_gateway.requests where request_id = $1 for update`,
        [requestId],
      );
      const row = result.rows[0];
      if (row?.status === "reserved") {
        const createdAt = new Date(row.created_at);
        for (const [kind, start] of [
          ["day", dateKey(createdAt)],
          ["month", monthKey(createdAt)],
        ] as const) {
          await client.query(
            `update ai_gateway.usage_buckets
             set used_units = greatest(0, used_units - $5), updated_at = now()
             where issuer = $1 and subject = $2 and period_kind = $3 and period_start = $4`,
            [row.issuer, row.subject, kind, start, row.cost_units],
          );
        }
        await client.query(
          `update ai_gateway.requests
           set status = 'released', error_code = $2, updated_at = now()
           where request_id = $1`,
          [requestId, errorCode],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getQuota(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ): Promise<GatewayQuotaSnapshot> {
    const policy = await this.resolvePolicy(
      this.pool,
      identity,
      defaultPolicy,
      policies,
    );
    const now = new Date();
    const [daily, monthly, active] = await Promise.all([
      this.usedUnits(this.pool, identity, "day", dateKey(now)),
      this.usedUnits(this.pool, identity, "month", monthKey(now)),
      this.pool.query(
        `select count(*)::integer as count from ai_gateway.requests
         where issuer = $1 and subject = $2
           and status in ('reserved', 'running') and lease_expires_at > now()`,
        [identity.issuer, identity.subject],
      ),
    ]);
    return {
      policyId: policy.id,
      daily: { used: daily, limit: policy.dailyCredits },
      monthly: { used: monthly, limit: policy.monthlyCredits },
      activeRequests: Number(active.rows[0].count),
      maxConcurrency: policy.maxConcurrency,
    };
  }

  async listUsage(identity: GatewayIdentity, limit: number) {
    const result = await this.pool.query(
      `select request_id, route_id, operation, status, cost_units,
              provider_attempts, response_bytes, duration_ms, error_code, created_at
       from ai_gateway.requests where issuer = $1 and subject = $2
       order by created_at desc limit $3`,
      [identity.issuer, identity.subject, limit],
    );
    return result.rows.map(
      (row): GatewayUsageRecord => ({
        requestId: row.request_id,
        routeId: row.route_id,
        operation: row.operation,
        status: row.status,
        costUnits: Number(row.cost_units),
        providerAttempts: Number(row.provider_attempts),
        responseBytes: Number(row.response_bytes),
        durationMs: Number(row.duration_ms),
        errorCode: row.error_code,
        createdAt: new Date(row.created_at).getTime(),
      }),
    );
  }

  async getAuditConsent(identity: GatewayIdentity) {
    const result = await this.pool.query(
      "select enabled from ai_gateway.audit_consents where issuer = $1 and subject = $2",
      [identity.issuer, identity.subject],
    );
    return result.rows[0]?.enabled === true;
  }

  async setAuditConsent(identity: GatewayIdentity, enabled: boolean) {
    await this.pool.query(
      `insert into ai_gateway.audit_consents (issuer, subject, enabled)
       values ($1, $2, $3)
       on conflict (issuer, subject) do update
       set enabled = excluded.enabled, updated_at = now()`,
      [identity.issuer, identity.subject, enabled],
    );
  }

  async createAudit(input: {
    identity: GatewayIdentity;
    routeId: string;
    envelope: EncryptedEnvelope;
    contentBytes: number;
    expiresAt: number;
  }) {
    const id = randomUUID();
    await this.pool.query(
      `insert into ai_gateway.audit_records
         (id, issuer, subject, route_id, content_bytes, envelope, expires_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp($7 / 1000.0))`,
      [
        id,
        input.identity.issuer,
        input.identity.subject,
        input.routeId,
        input.contentBytes,
        JSON.stringify(input.envelope),
        input.expiresAt,
      ],
    );
    return id;
  }

  async bindAudit(
    identity: GatewayIdentity,
    auditId: string,
    requestId: string,
    routeId: string,
  ) {
    const result = await this.pool.query(
      `update ai_gateway.audit_records set request_id = $4
       where id = $1 and issuer = $2 and subject = $3 and deleted_at is null
         and expires_at > now() and request_id is null and route_id = $5`,
      [auditId, identity.issuer, identity.subject, requestId, routeId],
    );
    return result.rowCount === 1;
  }

  async listAudits(identity: GatewayIdentity, limit: number) {
    const result = await this.pool.query(
      `select id, request_id, route_id, content_bytes, created_at, expires_at
       from ai_gateway.audit_records
       where issuer = $1 and subject = $2 and deleted_at is null and expires_at > now()
       order by created_at desc limit $3`,
      [identity.issuer, identity.subject, limit],
    );
    return result.rows.map(
      (row): AuditRecord => ({
        id: row.id,
        requestId: row.request_id,
        routeId: row.route_id,
        contentBytes: Number(row.content_bytes),
        createdAt: new Date(row.created_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      }),
    );
  }

  async getAuditRecord(identity: GatewayIdentity, auditId: string) {
    const result = await this.pool.query(
      `select id, request_id, route_id, content_bytes, created_at, expires_at
       from ai_gateway.audit_records
       where id = $1 and issuer = $2 and subject = $3
         and deleted_at is null and expires_at > now()`,
      [auditId, identity.issuer, identity.subject],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          requestId: row.request_id,
          routeId: row.route_id,
          contentBytes: Number(row.content_bytes),
          createdAt: new Date(row.created_at).getTime(),
          expiresAt: new Date(row.expires_at).getTime(),
        }
      : null;
  }

  async getAuditEnvelope(identity: GatewayIdentity, auditId: string) {
    const result = await this.pool.query(
      `select envelope from ai_gateway.audit_records
       where id = $1 and issuer = $2 and subject = $3
         and deleted_at is null and expires_at > now()`,
      [auditId, identity.issuer, identity.subject],
    );
    return result.rows[0] ? toEnvelope(result.rows[0].envelope) : null;
  }

  async deleteAudit(identity: GatewayIdentity, auditId: string) {
    await this.pool.query(
      `update ai_gateway.audit_records
       set deleted_at = now(), envelope = '{}'::jsonb, content_bytes = 0
       where id = $1 and issuer = $2 and subject = $3 and deleted_at is null`,
      [auditId, identity.issuer, identity.subject],
    );
  }

  async deleteIdentityData(identity: GatewayIdentity) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // audit_access_events has no cascade because operator records are
      // intentionally append-only. Remove the events belonging to this
      // account before deleting the encrypted audit rows.
      await client.query(
        `delete from ai_gateway.audit_access_events
         where audit_id in (
           select id from ai_gateway.audit_records
           where issuer = $1 and subject = $2
         )`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.audit_records
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.device_sessions
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.device_authorizations
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.requests
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.usage_buckets
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.policy_assignments
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query(
        `delete from ai_gateway.audit_consents
         where issuer = $1 and subject = $2`,
        [identity.issuer, identity.subject],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAuditAccess(input: {
    auditId: string;
    reason: string;
    operator: string;
  }) {
    await this.pool.query(
      `insert into ai_gateway.audit_access_events (audit_id, reason, operator)
       values ($1, $2, $3)`,
      [input.auditId, input.reason, input.operator],
    );
  }

  async getAuditForAdmin(auditId: string) {
    const result = await this.pool.query(
      `select issuer, subject, route_id, envelope
       from ai_gateway.audit_records
       where id = $1 and deleted_at is null and expires_at > now()`,
      [auditId],
    );
    const row = result.rows[0];
    return row
      ? {
          identity: {
            issuer: row.issuer,
            subject: row.subject,
            source: "jwt" as const,
          },
          routeId: row.route_id,
          envelope: toEnvelope(row.envelope),
        }
      : null;
  }

  async createDeviceAuthorization(input: {
    deviceCodeHash: string;
    userCodeHash: string;
    userCode: string;
    expiresAt: number;
    intervalSeconds: number;
  }) {
    await this.pool.query(
      `insert into ai_gateway.device_authorizations
         (device_code_hash, user_code_hash, expires_at, interval_seconds)
       values ($1, $2, to_timestamp($3 / 1000.0), $4)`,
      [
        input.deviceCodeHash,
        input.userCodeHash,
        input.expiresAt,
        input.intervalSeconds,
      ],
    );
  }

  async approveDeviceAuthorization(input: {
    userCodeHash: string;
    identity: GatewayIdentity;
  }) {
    const result = await this.pool.query(
      `update ai_gateway.device_authorizations
       set issuer = $2, subject = $3, email = $4, approved_at = now()
       where user_code_hash = $1 and expires_at > now()
         and approved_at is null and exchanged_at is null`,
      [
        input.userCodeHash,
        input.identity.issuer,
        input.identity.subject,
        input.identity.email || null,
      ],
    );
    return result.rowCount === 1;
  }

  async exchangeDeviceAuthorization(input: {
    deviceCodeHash: string;
    tokenHash: string;
    tokenExpiresAt: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `select issuer, subject, email, approved_at, exchanged_at, expires_at
         from ai_gateway.device_authorizations
         where device_code_hash = $1 for update`,
        [input.deviceCodeHash],
      );
      const row = result.rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query("rollback");
        return "expired" as const;
      }
      if (!row.approved_at || row.exchanged_at) {
        await client.query("rollback");
        return "pending" as const;
      }
      await client.query(
        `insert into ai_gateway.device_sessions
           (token_hash, issuer, subject, email, expires_at)
         values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))`,
        [
          input.tokenHash,
          row.issuer,
          row.subject,
          row.email,
          input.tokenExpiresAt,
        ],
      );
      await client.query(
        "update ai_gateway.device_authorizations set exchanged_at = now() where device_code_hash = $1",
        [input.deviceCodeHash],
      );
      await client.query("commit");
      return "approved" as const;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveDeviceToken(tokenHash: string) {
    const result = await this.pool.query(
      `select issuer, subject, email from ai_gateway.device_sessions
       where token_hash = $1 and expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row
      ? Object.freeze({
          issuer: row.issuer,
          subject: row.subject,
          ...(row.email ? { email: row.email } : {}),
          source: "device" as const,
        })
      : null;
  }

  async purgeExpired(now: number) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const expired = await client.query(
        `select request_id, issuer, subject, cost_units, created_at, status
         from ai_gateway.requests
         where status in ('reserved', 'running') and lease_expires_at <= to_timestamp($1 / 1000.0)
         for update`,
        [now],
      );
      for (const row of expired.rows) {
        if (row.status !== "reserved") {
          continue;
        }
        const createdAt = new Date(row.created_at);
        for (const [kind, start] of [
          ["day", dateKey(createdAt)],
          ["month", monthKey(createdAt)],
        ] as const) {
          await client.query(
            `update ai_gateway.usage_buckets
             set used_units = greatest(0, used_units - $5), updated_at = now()
             where issuer = $1 and subject = $2 and period_kind = $3 and period_start = $4`,
            [row.issuer, row.subject, kind, start, row.cost_units],
          );
        }
      }
      if (expired.rowCount) {
        await client.query(
          `update ai_gateway.requests set status = case when status = 'reserved' then 'released' else 'failed' end,
             error_code = 'AI_GATEWAY_RESERVATION_EXPIRED', updated_at = now()
           where status in ('reserved', 'running') and lease_expires_at <= to_timestamp($1 / 1000.0)`,
          [now],
        );
      }
      const result = await client.query(
        `with audits as (
         update ai_gateway.audit_records
         set deleted_at = now(), envelope = '{}'::jsonb, content_bytes = 0
         where deleted_at is null and expires_at <= to_timestamp($1 / 1000.0)
         returning 1
       ), authorizations as (
         delete from ai_gateway.device_authorizations
         where expires_at <= to_timestamp($1 / 1000.0) returning 1
       ), sessions as (
         delete from ai_gateway.device_sessions
         where expires_at <= to_timestamp($1 / 1000.0) returning 1
       )
       select
         (select count(*) from audits) +
         (select count(*) from authorizations) +
         (select count(*) from sessions) as count`,
        [now],
      );
      await client.query("commit");
      return Number(result.rows[0].count) + Number(expired.rowCount || 0);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

type MemoryRequest = {
  identity: GatewayIdentity;
  routeId: string;
  operation: string;
  costUnits: number;
  status: string;
  providerAttempts: number;
  responseBytes: number;
  durationMs: number;
  errorCode: string | null;
  createdAt: number;
  leaseExpiresAt: number;
};

export class MemoryGatewayStore implements GatewayStore {
  credentials = new Map<string, StoredCredential>();
  assignments = new Map<string, string>();
  requests = new Map<string, MemoryRequest>();
  consents = new Map<string, boolean>();
  audits = new Map<
    string,
    AuditRecord & { identity: GatewayIdentity; envelope: EncryptedEnvelope }
  >();
  devices = new Map<
    string,
    {
      userCodeHash: string;
      identity?: GatewayIdentity;
      expiresAt: number;
      exchanged: boolean;
    }
  >();
  sessions = new Map<
    string,
    { identity: GatewayIdentity; expiresAt: number }
  >();
  auditAccessEvents: Array<{
    auditId: string;
    reason: string;
    operator: string;
  }> = [];

  private key(identity: GatewayIdentity) {
    return `${identity.issuer}\n${identity.subject}`;
  }

  async checkReady() {
    return true;
  }
  async close() {}
  async getCredential(id: string) {
    return this.credentials.get(id) || null;
  }
  async putCredential(id: string, envelope: EncryptedEnvelope) {
    const version = (this.credentials.get(id)?.version || 0) + 1;
    this.credentials.set(id, { id, envelope, version, updatedAt: Date.now() });
    return version;
  }
  async removeCredential(id: string) {
    this.credentials.delete(id);
  }
  async assignPolicy(identity: GatewayIdentity, policyId: string) {
    this.assignments.set(this.key(identity), policyId);
  }
  private policy(
    identity: GatewayIdentity,
    fallback: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ) {
    const assigned = this.assignments.get(this.key(identity));
    if (assigned) {
      const policy = getPolicy(policies, assigned);
      if (!policy) {
        throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
          message: "The assigned quota policy is not configured.",
        });
      }
      return policy;
    }
    return fallback;
  }
  async getPolicy(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ) {
    return this.policy(identity, defaultPolicy, policies);
  }
  private snapshot(
    identity: GatewayIdentity,
    policy: GatewayQuotaPolicy,
  ): GatewayQuotaSnapshot {
    const requests = [...this.requests.values()].filter(
      (request) => this.key(request.identity) === this.key(identity),
    );
    const now = new Date();
    const daily = requests
      .filter(
        (request) =>
          dateKey(new Date(request.createdAt)) === dateKey(now) &&
          request.status !== "released",
      )
      .reduce((sum, request) => sum + request.costUnits, 0);
    const monthly = requests
      .filter(
        (request) =>
          monthKey(new Date(request.createdAt)) === monthKey(now) &&
          request.status !== "released",
      )
      .reduce((sum, request) => sum + request.costUnits, 0);
    const active = requests.filter(
      (request) =>
        ["reserved", "running"].includes(request.status) &&
        request.leaseExpiresAt > Date.now(),
    ).length;
    return {
      policyId: policy.id,
      daily: { used: daily, limit: policy.dailyCredits },
      monthly: { used: monthly, limit: policy.monthlyCredits },
      activeRequests: active,
      maxConcurrency: policy.maxConcurrency,
    };
  }
  async reserve(input: Parameters<GatewayStore["reserve"]>[0]) {
    if (this.requests.has(input.requestId)) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
        message: "The request ID has already been used.",
        retryable: false,
      });
    }
    const policy = this.policy(
      input.identity,
      input.defaultPolicy,
      input.policies,
    );
    const snapshot = this.snapshot(input.identity, policy);
    const recent = [...this.requests.values()].filter(
      (request) =>
        this.key(request.identity) === this.key(input.identity) &&
        request.createdAt >= Date.now() - 60_000,
    ).length;
    if (recent >= policy.requestsPerMinute) {
      throw new GatewayError("AI_GATEWAY_RATE_LIMITED", 429);
    }
    if (snapshot.activeRequests >= policy.maxConcurrency) {
      throw new GatewayError("AI_GATEWAY_CONCURRENCY_EXCEEDED", 429);
    }
    if (
      snapshot.daily.used + input.costUnits > policy.dailyCredits ||
      snapshot.monthly.used + input.costUnits > policy.monthlyCredits
    ) {
      throw new GatewayError("AI_GATEWAY_QUOTA_EXCEEDED", 429);
    }
    this.requests.set(input.requestId, {
      identity: input.identity,
      routeId: input.routeId,
      operation: input.operation,
      costUnits: input.costUnits,
      status: "reserved",
      providerAttempts: 0,
      responseBytes: 0,
      durationMs: 0,
      errorCode: null,
      createdAt: Date.now(),
      leaseExpiresAt: Date.now() + input.leaseMs,
    });
    return {
      requestId: input.requestId,
      policy,
      snapshot: this.snapshot(input.identity, policy),
    };
  }
  async markDispatched(requestId: string) {
    const request = this.requests.get(requestId);
    if (request?.status === "reserved" && request.leaseExpiresAt > Date.now()) {
      request.status = "running";
      return true;
    }
    return false;
  }
  async finish(input: Parameters<GatewayStore["finish"]>[0]) {
    const request = this.requests.get(input.requestId);
    if (request && ["reserved", "running"].includes(request.status)) {
      Object.assign(request, {
        status: input.status,
        providerAttempts: input.providerAttempts,
        responseBytes: input.responseBytes,
        durationMs: input.durationMs,
        errorCode: input.errorCode || null,
      });
    }
  }
  async release(requestId: string, errorCode: string) {
    const request = this.requests.get(requestId);
    if (request?.status === "reserved") {
      request.status = "released";
      request.errorCode = errorCode;
    }
  }
  async getQuota(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ) {
    const policy = this.policy(identity, defaultPolicy, policies);
    return this.snapshot(identity, policy);
  }
  async listUsage(identity: GatewayIdentity, limit: number) {
    return [...this.requests.entries()]
      .filter(
        ([, request]) => this.key(request.identity) === this.key(identity),
      )
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(
        ([requestId, request]): GatewayUsageRecord => ({
          requestId,
          routeId: request.routeId,
          operation: request.operation,
          status: request.status,
          costUnits: request.costUnits,
          providerAttempts: request.providerAttempts,
          responseBytes: request.responseBytes,
          durationMs: request.durationMs,
          errorCode: request.errorCode,
          createdAt: request.createdAt,
        }),
      );
  }
  async getAuditConsent(identity: GatewayIdentity) {
    return this.consents.get(this.key(identity)) === true;
  }
  async setAuditConsent(identity: GatewayIdentity, enabled: boolean) {
    this.consents.set(this.key(identity), enabled);
  }
  async createAudit(input: Parameters<GatewayStore["createAudit"]>[0]) {
    const id = randomUUID();
    this.audits.set(id, {
      id,
      requestId: null,
      routeId: input.routeId,
      contentBytes: input.contentBytes,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      identity: input.identity,
      envelope: input.envelope,
    });
    return id;
  }
  async bindAudit(
    identity: GatewayIdentity,
    auditId: string,
    requestId: string,
    routeId: string,
  ) {
    const audit = this.audits.get(auditId);
    if (
      audit &&
      this.key(audit.identity) === this.key(identity) &&
      audit.routeId === routeId &&
      audit.expiresAt > Date.now() &&
      audit.requestId === null
    ) {
      this.audits.set(auditId, { ...audit, requestId });
      return true;
    }
    return false;
  }
  async listAudits(identity: GatewayIdentity, limit: number) {
    return [...this.audits.values()]
      .filter(
        (audit) =>
          this.key(audit.identity) === this.key(identity) &&
          audit.expiresAt > Date.now(),
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(({ identity: _identity, envelope: _envelope, ...audit }) => audit);
  }
  async getAuditRecord(identity: GatewayIdentity, auditId: string) {
    const audit = this.audits.get(auditId);
    return audit &&
      this.key(audit.identity) === this.key(identity) &&
      audit.expiresAt > Date.now()
      ? {
          id: audit.id,
          requestId: audit.requestId,
          routeId: audit.routeId,
          contentBytes: audit.contentBytes,
          createdAt: audit.createdAt,
          expiresAt: audit.expiresAt,
        }
      : null;
  }
  async getAuditEnvelope(identity: GatewayIdentity, auditId: string) {
    const audit = this.audits.get(auditId);
    return audit &&
      this.key(audit.identity) === this.key(identity) &&
      audit.expiresAt > Date.now()
      ? audit.envelope
      : null;
  }
  async deleteAudit(identity: GatewayIdentity, auditId: string) {
    const audit = this.audits.get(auditId);
    if (audit && this.key(audit.identity) === this.key(identity)) {
      this.audits.delete(auditId);
    }
  }
  async deleteIdentityData(identity: GatewayIdentity) {
    const identityKey = this.key(identity);
    const deletedAuditIds = new Set<string>();
    for (const [requestId, request] of this.requests) {
      if (this.key(request.identity) === identityKey) {
        this.requests.delete(requestId);
      }
    }
    for (const [auditId, audit] of this.audits) {
      if (this.key(audit.identity) === identityKey) {
        deletedAuditIds.add(auditId);
        this.audits.delete(auditId);
      }
    }
    for (const [deviceCode, device] of this.devices) {
      if (device.identity && this.key(device.identity) === identityKey) {
        this.devices.delete(deviceCode);
      }
    }
    for (const [tokenHash, session] of this.sessions) {
      if (this.key(session.identity) === identityKey) {
        this.sessions.delete(tokenHash);
      }
    }
    this.assignments.delete(identityKey);
    this.consents.delete(identityKey);
    this.auditAccessEvents = this.auditAccessEvents.filter(
      (event) => !deletedAuditIds.has(event.auditId),
    );
  }
  async recordAuditAccess(input: {
    auditId: string;
    reason: string;
    operator: string;
  }) {
    this.auditAccessEvents.push(input);
  }
  async getAuditForAdmin(auditId: string) {
    const audit = this.audits.get(auditId);
    return audit && audit.expiresAt > Date.now()
      ? {
          identity: audit.identity,
          routeId: audit.routeId,
          envelope: audit.envelope,
        }
      : null;
  }
  async createDeviceAuthorization(
    input: Parameters<GatewayStore["createDeviceAuthorization"]>[0],
  ) {
    this.devices.set(input.deviceCodeHash, {
      userCodeHash: input.userCodeHash,
      expiresAt: input.expiresAt,
      exchanged: false,
    });
  }
  async approveDeviceAuthorization(
    input: Parameters<GatewayStore["approveDeviceAuthorization"]>[0],
  ) {
    const device = [...this.devices.values()].find(
      (value) => value.userCodeHash === input.userCodeHash,
    );
    if (
      !device ||
      device.expiresAt <= Date.now() ||
      device.exchanged ||
      device.identity
    ) {
      return false;
    }
    device.identity = input.identity;
    return true;
  }
  async exchangeDeviceAuthorization(
    input: Parameters<GatewayStore["exchangeDeviceAuthorization"]>[0],
  ) {
    const device = this.devices.get(input.deviceCodeHash);
    if (!device || device.expiresAt <= Date.now()) {
      return "expired" as const;
    }
    if (!device.identity || device.exchanged) {
      return "pending" as const;
    }
    device.exchanged = true;
    this.sessions.set(input.tokenHash, {
      identity: { ...device.identity, source: "device" },
      expiresAt: input.tokenExpiresAt,
    });
    return "approved" as const;
  }
  async resolveDeviceToken(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    return session && session.expiresAt > Date.now() ? session.identity : null;
  }
  async purgeExpired(now: number) {
    let count = 0;
    for (const request of this.requests.values()) {
      if (
        ["reserved", "running"].includes(request.status) &&
        request.leaseExpiresAt <= now
      ) {
        request.status = request.status === "reserved" ? "released" : "failed";
        request.errorCode = "AI_GATEWAY_RESERVATION_EXPIRED";
        count += 1;
      }
    }
    for (const [id, audit] of this.audits) {
      if (audit.expiresAt <= now) {
        this.audits.delete(id);
        count += 1;
      }
    }
    for (const [id, device] of this.devices) {
      if (device.expiresAt <= now) {
        this.devices.delete(id);
        count += 1;
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        count += 1;
      }
    }
    return count;
  }
}
