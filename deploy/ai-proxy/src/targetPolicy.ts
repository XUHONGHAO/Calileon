import net from "node:net";

import ipaddr from "ipaddr.js";

import { lookupAllAddresses } from "./dnsPin.js";
import { AIProxyError } from "./errors.js";

import type { DNSLookupAll } from "./dnsPin.js";

const MAX_TARGET_URL_LENGTH = 8 * 1024;

export type ResolvedTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

export type TargetPolicyOptions = {
  production: boolean;
  allowHttpLocalhost: boolean;
  lookupAll?: DNSLookupAll;
};

const stripIPv6Brackets = (hostname: string) => {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
};

const isLocalhostName = (hostname: string) => {
  const normalized = stripIPv6Brackets(hostname).toLowerCase();

  return normalized === "localhost" || normalized.endsWith(".localhost");
};

const isLoopbackAddress = (address: string) => {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "loopback";
  } catch {
    return false;
  }
};

export const isBlockedIPAddress = (address: string): boolean => {
  try {
    const parsed = ipaddr.parse(address);

    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;

      if (ipv6.isIPv4MappedAddress()) {
        return isBlockedIPAddress(ipv6.toIPv4Address().toString());
      }
    }

    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
};

const parseTargetURL = (rawTarget: string, options: TargetPolicyOptions) => {
  if (!rawTarget || rawTarget.length > MAX_TARGET_URL_LENGTH) {
    throw new AIProxyError("AI_PROXY_TARGET_INVALID", 400, {
      retryable: false,
    });
  }

  let url: URL;

  try {
    url = new URL(rawTarget);
  } catch (error) {
    throw new AIProxyError("AI_PROXY_TARGET_INVALID", 400, {
      retryable: false,
      cause: error,
    });
  }

  if (url.username || url.password || url.hash || !url.hostname) {
    throw new AIProxyError("AI_PROXY_TARGET_INVALID", 400, {
      retryable: false,
    });
  }

  const httpLocalhostAllowed =
    !options.production &&
    options.allowHttpLocalhost &&
    url.protocol === "http:" &&
    (isLocalhostName(url.hostname) ||
      isLoopbackAddress(stripIPv6Brackets(url.hostname)));

  if (url.protocol !== "https:" && !httpLocalhostAllowed) {
    throw new AIProxyError("AI_PROXY_TARGET_BLOCKED", 403, {
      retryable: false,
    });
  }

  return { url, httpLocalhostAllowed };
};

export const resolveTarget = async (
  rawTarget: string,
  options: TargetPolicyOptions,
): Promise<ResolvedTarget> => {
  const { url, httpLocalhostAllowed } = parseTargetURL(rawTarget, options);
  const hostname = stripIPv6Brackets(url.hostname);
  const literalFamily = net.isIP(hostname);
  const candidates = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (options.lookupAll || lookupAllAddresses)(hostname);

  if (!candidates.length) {
    throw new AIProxyError("AI_PROXY_DNS_FAILED", 502);
  }

  const normalizedCandidates = candidates.map((candidate) => ({
    address: candidate.address,
    family: candidate.family === 6 ? (6 as const) : (4 as const),
  }));

  if (httpLocalhostAllowed) {
    if (
      !normalizedCandidates.every((candidate) =>
        isLoopbackAddress(candidate.address),
      )
    ) {
      throw new AIProxyError("AI_PROXY_TARGET_BLOCKED", 403, {
        retryable: false,
      });
    }
  } else if (
    normalizedCandidates.some((candidate) =>
      isBlockedIPAddress(candidate.address),
    )
  ) {
    throw new AIProxyError("AI_PROXY_TARGET_BLOCKED", 403, {
      retryable: false,
    });
  }

  const selected = normalizedCandidates[0];

  return {
    url,
    hostname,
    address: selected.address,
    family: selected.family,
  };
};
