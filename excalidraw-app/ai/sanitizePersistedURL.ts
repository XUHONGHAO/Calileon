export const sanitizePersistedURL = (value: string): string => {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return value;
    }

    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
};
