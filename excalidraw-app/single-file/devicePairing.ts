export const normalizeDevicePollIntervalSeconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(60, Math.max(1, value))
    : 5;
