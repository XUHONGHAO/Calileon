#!/usr/bin/env node

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) {
    continue;
  }
  const [name, inline] = value.slice(2).split("=", 2);
  args.set(name, inline ?? process.argv[index + 1]);
  if (inline === undefined) {
    index += 1;
  }
}

const url = args.get("url") || "http://127.0.0.1:3016/healthz";
const requests = Math.max(1, Number(args.get("requests") || 100));
const concurrency = Math.max(
  1,
  Math.min(100, Number(args.get("concurrency") || 10)),
);
const maxP95Ms = Math.max(1, Number(args.get("max-p95-ms") || 1000));

if (!Number.isSafeInteger(requests) || !Number.isSafeInteger(concurrency)) {
  console.error("requests and concurrency must be integers");
  process.exit(2);
}

const samples = [];
const failures = [];
let next = 0;

const worker = async () => {
  while (true) {
    const current = next;
    next += 1;
    if (current >= requests) {
      return;
    }
    const started = performance.now();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      if (!response.ok) {
        failures.push(response.status);
      }
      await response.arrayBuffer();
    } catch (error) {
      failures.push(error instanceof Error ? error.name : "request-error");
    }
  }
};

await Promise.all(
  Array.from({ length: Math.min(concurrency, requests) }, () => worker()),
);

samples.sort((left, right) => left - right);
const percentile = (fraction) =>
  samples.length
    ? samples[
        Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)
      ]
    : 0;
const summary = {
  requests,
  concurrency: Math.min(concurrency, requests),
  successfulResponses: samples.length - failures.length,
  failures: failures.length,
  p50Ms: Math.round(percentile(0.5)),
  p95Ms: Math.round(percentile(0.95)),
  maxMs: Math.round(samples.at(-1) || 0),
};

console.log(JSON.stringify(summary));
if (summary.failures > 0 || summary.p95Ms > maxP95Ms) {
  process.exitCode = 1;
}
