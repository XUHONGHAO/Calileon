import dns from "node:dns";

import { AIProxyError } from "./errors.js";

import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

export type DNSLookupAll = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export const lookupAllAddresses: DNSLookupAll = async (hostname) => {
  try {
    return await dns.promises.lookup(hostname, {
      all: true,
      verbatim: true,
    });
  } catch (error) {
    throw new AIProxyError("AI_PROXY_DNS_FAILED", 502, { cause: error });
  }
};

export const createPinnedLookup = (
  address: string,
  family: number,
): LookupFunction => {
  return (_hostname, options, callback) => {
    if (typeof options === "number") {
      callback(null, address, family);
      return;
    }

    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };
};
