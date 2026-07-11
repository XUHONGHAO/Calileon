export type EchoStatus = "todo" | "in-progress" | "blocked" | "done" | null;

export type EchoDataV1 = {
  version: 1;
  anchorId: string;
  name: string;
  status: EchoStatus;
  revision: number;
  mutationId?: string;
  updatedByElementId?: string;
};

export type EchoField = "text" | "status" | "backgroundColor";

export type EchoFieldRevision = {
  revision: number;
  mutationId: string;
  updatedByElementId: string;
};

export type EchoDataV2 = {
  version: 2;
  anchorId: string;
  name: string;
  status: EchoStatus;
  fields: Record<EchoField, EchoFieldRevision>;
};

export type EchoData = EchoDataV2;

export type EchoConflict = {
  anchorId: string;
  field: EchoField;
  revision: number;
  localMutationId: string;
  remoteMutationId: string;
};
