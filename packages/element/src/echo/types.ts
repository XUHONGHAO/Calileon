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
