#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const options = parseArguments(process.argv.slice(2));
const usage = 'Usage: node scripts/load/http-workload.mjs --base-url <https://staging.example> --scenario-file <private.json> --duration-seconds <n> --concurrency <n> --i-confirm-non-production';

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--i-confirm-non-production') {
      result.confirmNonProduction = true;
      continue;
    }
    if (!name.startsWith('--') || index + 1 >= args.length) {
      throw new Error(usage);
    }
    const key = name.slice(2);
    if (!['base-url', 'scenario-file', 'duration-seconds', 'concurrency', 'timeout-ms', 'max-error-rate', 'max-p95-ms'].includes(key)) {
      throw new Error('Unknown option: ' + name);
    }
    result[key] = args[index + 1];
    index += 1;
  }
  return result;
}

function positiveInteger(value, name, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(name + ' must be a positive whole number no greater than ' + maximum + '.');
  }
  return parsed;
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return values[index];
}

function chooseScenario(scenarios, totalWeight) {
  const selection = Math.random() * totalWeight;
  let boundary = 0;
  for (const scenario of scenarios) {
    boundary += scenario.weight;
    if (selection < boundary) return scenario;
  }
  return scenarios[scenarios.length - 1];
}

function expandBody(body, runId, sequence) {
  return body
    .replaceAll('{{runId}}', runId)
    .replaceAll('{{sequence}}', String(sequence))
    .replaceAll('{{uuid}}', randomUUID());
}

async function readPrivateScenarioFile(filePath) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('Secure no-follow scenario-file opening is unavailable on this platform.');
  }

  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('Scenario file must not be a symbolic link.');
    }
    throw new Error('Scenario file could not be opened securely.');
  }

  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
      throw new Error('Scenario file must be a private regular file with no hard links (0600 or stricter).');
    }
    if (before.size > 1024n * 1024n) {
      throw new Error('Scenario file must not exceed 1 MiB.');
    }

    const contents = await file.readFile({ encoding: 'utf8' });
    const after = await file.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error('Scenario file changed while it was being read.');
    }
    return contents;
  } finally {
    await file.close();
  }
}

async function loadScenarios(filePath, baseUrl) {
  let document;
  let contents;
  try {
    contents = await readPrivateScenarioFile(filePath);
  } catch (error) {
    throw error instanceof Error ? error : new Error('Scenario file could not be read securely.');
  }
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error('Scenario file is not valid JSON.');
  }
  if (!Array.isArray(document?.scenarios) || document.scenarios.length === 0 || document.scenarios.length > 50) {
    throw new Error('Scenario file must contain between 1 and 50 scenarios.');
  }

  const scenarioNames = new Set();
  const scenarios = document.scenarios.map((item, index) => {
    const name = item?.name;
    const method = item?.method;
    const path = item?.path;
    const weight = item?.weight ?? 1;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || scenarioNames.has(name)) {
      throw new Error('Scenario ' + index + ' has an invalid or duplicate name.');
    }
    scenarioNames.add(name);
    if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(method)) {
      throw new Error('Scenario ' + name + ' has an unsupported method.');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Scenario ' + name + ' must use a relative absolute-path URL.');
    }
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin || url.username || url.password) {
      throw new Error('Scenario ' + name + ' escapes the configured target origin.');
    }
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) {
      throw new Error('Scenario ' + name + ' has an invalid weight.');
    }
    const headers = item.headers ?? {};
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error('Scenario ' + name + ' headers must be an object.');
    }
    const normalizedHeaders = {};
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (
        typeof headerValue !== 'string' ||
        !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName) ||
        /[\r\n]/.test(headerValue) ||
        headerName.toLowerCase() === 'host' ||
        headerName.toLowerCase() === 'content-length'
      ) {
        throw new Error('Scenario ' + name + ' contains an invalid header.');
      }
      normalizedHeaders[headerName] = headerValue;
    }
    if (item.body !== undefined && typeof item.body !== 'string') {
      throw new Error('Scenario ' + name + ' body must be a string template.');
    }
    if (['GET', 'HEAD'].includes(method) && item.body !== undefined) {
      throw new Error('Scenario ' + name + ' cannot send a body with ' + method + '.');
    }
    return {
      name,
      method,
      url,
      weight,
      headers: normalizedHeaders,
      body: item.body,
    };
  });
  return {
    scenarios,
    totalWeight: scenarios.reduce((total, scenario) => total + scenario.weight, 0),
  };
}

async function main() {
  if (!options.confirmNonProduction) {
    throw new Error('Load runs require --i-confirm-non-production and must target an isolated non-production environment.');
  }
  if (typeof options['base-url'] !== 'string' || typeof options['scenario-file'] !== 'string') {
    throw new Error(usage);
  }
  const baseUrl = new URL(options['base-url']);
  if (baseUrl.username || baseUrl.password || baseUrl.hash) {
    throw new Error('Load target URL cannot contain credentials or a fragment.');
  }
  const localTarget = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
  if (!['https:', 'http:'].includes(baseUrl.protocol) || (baseUrl.protocol !== 'https:' && !localTarget)) {
    throw new Error('Load target must use HTTPS, except for a loopback development target.');
  }

  const durationSeconds = positiveInteger(options['duration-seconds'], '--duration-seconds', 60, 3600);
  const concurrency = positiveInteger(options.concurrency, '--concurrency', 20, 500);
  const timeoutMs = positiveInteger(options['timeout-ms'], '--timeout-ms', 15000, 60000);
  const maxErrorRate = options['max-error-rate'] === undefined ? 2 : Number(options['max-error-rate']);
  const maxP95Ms = options['max-p95-ms'] === undefined ? 1500 : Number(options['max-p95-ms']);
  if (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 100) {
    throw new Error('--max-error-rate must be between 0 and 100.');
  }
  if (!Number.isFinite(maxP95Ms) || maxP95Ms < 1) {
    throw new Error('--max-p95-ms must be a positive number.');
  }

  const { scenarios, totalWeight } = await loadScenarios(options['scenario-file'], baseUrl);
  const runId = randomUUID();
  const startedAt = new Date();
  const deadline = Date.now() + durationSeconds * 1000;
  const counts = new Map(scenarios.map((scenario) => [scenario.name, { total: 0, success: 0, failure: 0, statuses: {} }]));
  const latencies = [];
  const maximumLatencySamples = 250_000;
  let sequence = 0;
  let total = 0;
  let successful = 0;
  let failed = 0;
  let timeoutCount = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const scenario = chooseScenario(scenarios, totalWeight);
      const currentSequence = ++sequence;
      const started = performance.now();
      let status = 'error';
      let failure = false;
      try {
        const response = await fetch(scenario.url, {
          method: scenario.method,
          headers: scenario.headers,
          ...(scenario.body === undefined ? {} : {
            body: expandBody(scenario.body, runId, currentSequence),
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = String(response.status);
        await response.body?.cancel().catch(() => undefined);
        failure = response.status < 200 || response.status >= 300;
      } catch (error) {
        status = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error';
        failure = true;
        if (status === 'timeout') timeoutCount += 1;
      }

      const elapsed = performance.now() - started;
      if (latencies.length < maximumLatencySamples) {
        latencies.push(elapsed);
      } else {
        const replacement = Math.floor(Math.random() * total);
        if (replacement < maximumLatencySamples) latencies[replacement] = elapsed;
      }
      const metric = counts.get(scenario.name);
      metric.total += 1;
      metric.statuses[status] = (metric.statuses[status] ?? 0) + 1;
      total += 1;
      if (failure) {
        metric.failure += 1;
        failed += 1;
      } else {
        metric.success += 1;
        successful += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  latencies.sort((left, right) => left - right);
  const endedAt = new Date();
  const elapsedSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  const p95Ms = percentile(latencies, 0.95);
  const failureRatePercent = total === 0 ? 100 : (failed / total) * 100;
  const report = {
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    targetOrigin: baseUrl.origin,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    concurrency,
    totalRequests: total,
    requestsPerSecond: Number((total / elapsedSeconds).toFixed(2)),
    successful,
    failed,
    timeoutCount,
    failureRatePercent: Number(failureRatePercent.toFixed(3)),
    latencyMs: {
      samples: latencies.length,
      p50: percentile(latencies, 0.5) === null ? null : Number(percentile(latencies, 0.5).toFixed(2)),
      p95: p95Ms === null ? null : Number(p95Ms.toFixed(2)),
      p99: percentile(latencies, 0.99) === null ? null : Number(percentile(latencies, 0.99).toFixed(2)),
      max: latencies.length === 0 ? null : Number(latencies[latencies.length - 1].toFixed(2)),
    },
    scenarios: Object.fromEntries(counts),
    thresholds: { maxErrorRatePercent: maxErrorRate, maxP95Ms },
    passed: failureRatePercent <= maxErrorRate && (p95Ms ?? Infinity) <= maxP95Ms,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Load run failed.') + '\n');
  process.exitCode = 1;
}
