import type { IncomingMessage, ServerResponse } from "node:http";

export type GatewayCapability =
  | "image-generation"
  | "remote-image"
  | "video-submit"
  | "video-poll"
  | "text-agent"
  | "vision-agent";

export type GatewayIdentity = Readonly<{
  issuer: string;
  subject: string;
  email?: string;
  source: "jwt" | "device";
}>;

export type GatewayQuotaPolicy = Readonly<{
  id: string;
  dailyCredits: number;
  monthlyCredits: number;
  requestsPerMinute: number;
  maxConcurrency: number;
}>;

export type GatewayOperationConfig = Readonly<{
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: Readonly<Record<string, string>>;
  queryParams?: readonly string[];
  maxRequestBytes?: number;
  replayable?: boolean;
}>;

export type GatewayCredentialHeader =
  | "authorization-bearer"
  | "x-goog-api-key"
  | "x-api-key"
  | "api-key"
  | "none";

export type GatewayRouteCandidate = Readonly<{
  id: string;
  baseUrl: string;
  /** Optional assertion used when route files are generated externally. */
  wireProtocol?: string;
  credentialId?: string;
  credentialHeader: GatewayCredentialHeader;
}>;

export type GatewayRouteConfig = Readonly<{
  id: string;
  label: string;
  capability: GatewayCapability;
  wireProtocol: string;
  model: string;
  costUnits: number;
  operations: Readonly<Record<string, GatewayOperationConfig>>;
  candidates: readonly GatewayRouteCandidate[];
}>;

export type GatewayDeclarativeConfig = Readonly<{
  version: 1;
  defaultPolicy: string;
  policies: readonly GatewayQuotaPolicy[];
  routes: readonly GatewayRouteConfig[];
}>;

export type GatewayCatalogEntry = Readonly<{
  id: string;
  label: string;
  capability: GatewayCapability;
  wireProtocol: string;
  model: string;
  costUnits: number;
  operations: readonly string[];
}>;

export type GatewayQuotaSnapshot = Readonly<{
  policyId: string;
  daily: { used: number; limit: number };
  monthly: { used: number; limit: number };
  activeRequests: number;
  maxConcurrency: number;
}>;

export type GatewayUsageRecord = Readonly<{
  requestId: string;
  routeId: string;
  operation: string;
  status: string;
  costUnits: number;
  providerAttempts: number;
  responseBytes: number;
  durationMs: number;
  errorCode: string | null;
  createdAt: number;
}>;

export type EncryptedEnvelope = Readonly<{
  provider: "aws-kms" | "local-kek";
  keyId: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}>;

export type StoredCredential = Readonly<{
  id: string;
  envelope: EncryptedEnvelope;
  version: number;
  updatedAt: number;
}>;

export type AuditRecord = Readonly<{
  id: string;
  requestId: string | null;
  routeId: string;
  contentBytes: number;
  createdAt: number;
  expiresAt: number;
}>;

export type DeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}>;

export type GatewayReservation = Readonly<{
  requestId: string;
  policy: GatewayQuotaPolicy;
  snapshot: GatewayQuotaSnapshot;
}>;

export type GatewayStore = {
  checkReady(): Promise<boolean>;
  migrate?(sql: string): Promise<void>;
  close(): Promise<void>;
  getCredential(id: string): Promise<StoredCredential | null>;
  putCredential(id: string, envelope: EncryptedEnvelope): Promise<number>;
  removeCredential(id: string): Promise<void>;
  assignPolicy(identity: GatewayIdentity, policyId: string): Promise<void>;
  getPolicy?(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ): Promise<GatewayQuotaPolicy>;
  reserve(input: {
    identity: GatewayIdentity;
    requestId: string;
    routeId: string;
    operation: string;
    costUnits: number;
    defaultPolicy: GatewayQuotaPolicy;
    policies: readonly GatewayQuotaPolicy[];
    leaseMs: number;
  }): Promise<GatewayReservation>;
  /**
   * Moves a reservation into the running state. The boolean is important:
   * providers must not receive request bytes when the lease was released or
   * expired while the connection was being established.
   */
  markDispatched(requestId: string): Promise<boolean>;
  finish(input: {
    requestId: string;
    status: "succeeded" | "failed" | "aborted";
    providerAttempts: number;
    responseBytes: number;
    durationMs: number;
    errorCode?: string;
  }): Promise<void>;
  release(requestId: string, errorCode: string): Promise<void>;
  getQuota(
    identity: GatewayIdentity,
    defaultPolicy: GatewayQuotaPolicy,
    policies: readonly GatewayQuotaPolicy[],
  ): Promise<GatewayQuotaSnapshot>;
  listUsage(
    identity: GatewayIdentity,
    limit: number,
  ): Promise<GatewayUsageRecord[]>;
  getAuditConsent(identity: GatewayIdentity): Promise<boolean>;
  setAuditConsent(identity: GatewayIdentity, enabled: boolean): Promise<void>;
  createAudit(input: {
    identity: GatewayIdentity;
    routeId: string;
    envelope: EncryptedEnvelope;
    contentBytes: number;
    expiresAt: number;
  }): Promise<string>;
  bindAudit(
    identity: GatewayIdentity,
    auditId: string,
    requestId: string,
    routeId: string,
  ): Promise<boolean>;
  listAudits(identity: GatewayIdentity, limit: number): Promise<AuditRecord[]>;
  getAuditRecord?(
    identity: GatewayIdentity,
    auditId: string,
  ): Promise<AuditRecord | null>;
  getAuditEnvelope(
    identity: GatewayIdentity,
    auditId: string,
  ): Promise<EncryptedEnvelope | null>;
  deleteAudit(identity: GatewayIdentity, auditId: string): Promise<void>;
  /** Remove all user-owned gateway data without touching deployment credentials. */
  deleteIdentityData?(identity: GatewayIdentity): Promise<void>;
  recordAuditAccess(input: {
    auditId: string;
    reason: string;
    operator: string;
  }): Promise<void>;
  getAuditForAdmin?(auditId: string): Promise<{
    identity: GatewayIdentity;
    routeId: string;
    envelope: EncryptedEnvelope;
  } | null>;
  createDeviceAuthorization(input: {
    deviceCodeHash: string;
    userCodeHash: string;
    userCode: string;
    expiresAt: number;
    intervalSeconds: number;
  }): Promise<void>;
  approveDeviceAuthorization(input: {
    userCodeHash: string;
    identity: GatewayIdentity;
  }): Promise<boolean>;
  exchangeDeviceAuthorization(input: {
    deviceCodeHash: string;
    tokenHash: string;
    tokenExpiresAt: number;
  }): Promise<"pending" | "expired" | "approved">;
  resolveDeviceToken(tokenHash: string): Promise<GatewayIdentity | null>;
  purgeExpired(now: number): Promise<number>;
};

export type GatewayInvocationResult = Readonly<{
  candidateId: string;
  providerAttempts: number;
  response: IncomingMessage;
}>;

export type GatewayHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;
