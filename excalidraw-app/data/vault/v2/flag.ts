/**
 * Vault v2 feature gate (W6). Dependency-light on purpose: the App imports it
 * statically, everything else of v2 (Yjs included) is loaded on demand.
 */
import { isVaultV2Link } from "./link";

/** default OFF: only the exact string "true" enables v2 */
export const isVaultV2Enabled = (
  env: { VITE_APP_VAULT_V2_ENABLED?: string } = import.meta.env,
) => env.VITE_APP_VAULT_V2_ENABLED === "true";

/** true when the flag is on and the URL carries a `vault=2` link */
export const isVaultV2Route = (
  href: string,
  env?: { VITE_APP_VAULT_V2_ENABLED?: string },
) => isVaultV2Enabled(env) && isVaultV2Link(href);
