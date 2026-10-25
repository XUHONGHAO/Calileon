// Calileon brand pages, built as separate Vite entries (see vite.config.mts).
// The trailing slash matches nginx's `try_files $uri $uri/` directory lookup,
// so the production image needs no extra rewrite rule.
export const BRAND_PAGE_URLS = {
  app: "/",
  plus: "/plus/",
  security: "/security/",
} as const;
