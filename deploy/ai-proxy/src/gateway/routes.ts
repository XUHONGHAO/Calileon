import { GatewayError } from "./errors.js";

import type {
  GatewayDeclarativeConfig,
  GatewayOperationConfig,
  GatewayRouteCandidate,
  GatewayRouteConfig,
} from "./types.js";

export class CircuitBreaker {
  private readonly failures = new Map<
    string,
    { failures: number; openUntil: number }
  >();

  isAvailable(key: string, now = Date.now()) {
    return (this.failures.get(key)?.openUntil || 0) <= now;
  }

  success(key: string) {
    this.failures.delete(key);
  }

  failure(key: string, now = Date.now()) {
    const current = this.failures.get(key) || { failures: 0, openUntil: 0 };
    const failures = current.failures + 1;
    this.failures.set(key, {
      failures,
      openUntil: failures >= 3 ? now + 30_000 : 0,
    });
  }
}

const applyPathParams = (
  operation: GatewayOperationConfig,
  params: Record<string, string>,
) => {
  let path = operation.path;
  const configuredParams = operation.params || {};
  for (const [name, pattern] of Object.entries(configuredParams)) {
    const value = params[name];
    if (
      typeof value !== "string" ||
      !new RegExp(`^(?:${pattern})$`).test(value)
    ) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
        message: `Invalid operation parameter: ${name}.`,
        retryable: false,
      });
    }
    path = path.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  if (/\{[a-zA-Z0-9._-]+\}/.test(path)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
      message: "A required operation parameter is missing.",
      retryable: false,
    });
  }
  return path;
};

export class GatewayRouter {
  private readonly routes: Map<string, GatewayRouteConfig>;

  constructor(
    config: GatewayDeclarativeConfig,
    private readonly circuitBreaker = new CircuitBreaker(),
  ) {
    this.routes = new Map(config.routes.map((route) => [route.id, route]));
  }

  getRoute(id: string) {
    const route = this.routes.get(id);
    if (!route) {
      throw new GatewayError("AI_GATEWAY_ROUTE_NOT_FOUND", 404, {
        retryable: false,
      });
    }
    return route;
  }

  getOperation(route: GatewayRouteConfig, name: string) {
    if (!Object.prototype.hasOwnProperty.call(route.operations, name)) {
      throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
        retryable: false,
      });
    }
    return route.operations[name];
  }

  candidates(route: GatewayRouteConfig) {
    const available = route.candidates.filter((candidate) =>
      this.circuitBreaker.isAvailable(`${route.id}:${candidate.id}`),
    );
    return available.length ? available : [route.candidates[0]];
  }

  buildTarget(
    candidate: GatewayRouteCandidate,
    operation: GatewayOperationConfig,
    params: Record<string, string>,
    query: URLSearchParams,
    defaults: Record<string, string> = {},
  ) {
    const target = new URL(
      applyPathParams(operation, { ...params, ...defaults }),
      `${candidate.baseUrl}/`,
    );
    for (const name of operation.queryParams || []) {
      for (const value of query.getAll(name)) {
        target.searchParams.append(name, value);
      }
    }
    return target.toString();
  }

  markSuccess(route: GatewayRouteConfig, candidate: GatewayRouteCandidate) {
    this.circuitBreaker.success(`${route.id}:${candidate.id}`);
  }

  markFailure(route: GatewayRouteConfig, candidate: GatewayRouteCandidate) {
    this.circuitBreaker.failure(`${route.id}:${candidate.id}`);
  }
}
