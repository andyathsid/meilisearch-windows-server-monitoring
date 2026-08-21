#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Meilisearch } = require("meilisearch");

const PHASES = new Set(["create", "reject", "replay", "cleanup"]);
const CREATE_PHASES = new Set(["create", "reject"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const DEFAULT_MEILI_URL = "http://127.0.0.1:7700";
const DEFAULT_FIXTURE = "convoy-idempotency-fixture.json";
const DEFAULT_SOURCE_ID = "windows-primary";
const DEFAULT_GENERATION = "1";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SETTLE_MS = 3000;
const DEFAULT_REPLAY_COPIES = 2;
const SCRIPT_VERSION = "1.1.0";

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, option, { allowZero = false } = {}) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${option} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env) {
  const args = {
    phase: "",
    meiliUrl: env.MEILI_URL || DEFAULT_MEILI_URL,
    apiKey: env.MEILI_MASTER_KEY || "",
    webhookUrl: env.MEILI_TASK_WEBHOOK_URL || "",
    authorizationHeader: env.MEILI_TASK_WEBHOOK_AUTHORIZATION_HEADER || "",
    sourceId: env.MEILISEARCH_SOURCE_ID || DEFAULT_SOURCE_ID,
    generation: env.MEILISEARCH_SOURCE_GENERATION || DEFAULT_GENERATION,
    input: DEFAULT_FIXTURE,
    output: DEFAULT_FIXTURE,
    index: "",
    copies: DEFAULT_REPLAY_COPIES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === "--help" || option === "-h") {
      args.help = true;
      continue;
    }
    if (option === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    const valueOptions = new Map([
      ["--phase", "phase"],
      ["--url", "meiliUrl"],
      ["--input", "input"],
      ["--output", "output"],
      ["--index", "index"],
      ["--copies", "copies"],
      ["--timeout-ms", "timeoutMs"],
      ["--settle-ms", "settleMs"],
      ["--source-id", "sourceId"],
      ["--generation", "generation"],
    ]);
    const property = valueOptions.get(option);
    if (!property) {
      throw new Error(`Unknown option: ${option}`);
    }
    args[property] = requireOptionValue(argv, i, option);
    i += 1;
  }

  if (args.help) return args;
  if (!PHASES.has(args.phase)) {
    throw new Error(`--phase must be one of: ${[...PHASES].join(", ")}`);
  }

  args.copies = parsePositiveInteger(args.copies, "--copies");
  args.timeoutMs = parsePositiveInteger(args.timeoutMs, "--timeout-ms");
  args.settleMs = parsePositiveInteger(args.settleMs, "--settle-ms", { allowZero: true });
  args.meiliUrl = validateHttpUrl(args.meiliUrl, "--url or MEILI_URL");
  validateIdentitySegment(args.sourceId, "--source-id or MEILISEARCH_SOURCE_ID");
  validateIdentitySegment(args.generation, "--generation or MEILISEARCH_SOURCE_GENERATION");

  if (CREATE_PHASES.has(args.phase) || args.phase === "cleanup") {
    if (!args.apiKey && !args.dryRun) {
      throw new Error(
        "MEILI_MASTER_KEY is required for create, reject, and cleanup phases"
      );
    }
  }
  if (args.phase === "replay") {
    args.webhookUrl = validateHttpUrl(
      args.webhookUrl,
      "MEILI_TASK_WEBHOOK_URL"
    );
    if (!args.authorizationHeader && !args.dryRun) {
      throw new Error(
        "MEILI_TASK_WEBHOOK_AUTHORIZATION_HEADER is required for replay"
      );
    }
    if (
      args.authorizationHeader &&
      !/^Basic\s+\S+$/i.test(args.authorizationHeader)
    ) {
      throw new Error(
        "MEILI_TASK_WEBHOOK_AUTHORIZATION_HEADER must be an HTTP Basic Authorization value"
      );
    }
  }
  if (args.phase === "cleanup" && !args.index && !args.input) {
    throw new Error("cleanup requires --index or --input");
  }

  args.input = path.resolve(args.input);
  args.output = path.resolve(args.output);
  return args;
}

function validateHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  return value.replace(/\/+$/, "");
}

function validateIdentitySegment(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}`);
  }
}

function printHelp() {
  console.log(`
Usage:
  node showcase-webhook-idempotency.js --phase create [options]
  node showcase-webhook-idempotency.js --phase reject [options]
  node showcase-webhook-idempotency.js --phase replay [options]
  node showcase-webhook-idempotency.js --phase cleanup [options]

Phases:
  create    Create one real Meilisearch index task and save its terminal task
            payload as a JSON fixture. Meilisearch sends its normal webhook.
  reject    Create one real task while the profile-only Vector rejector
            temporarily replaces Vector Receiver at the same internal URL.
            Convoy should record its synchronous HTTP 503 and schedule a retry.
            This phase does not start or stop Droplet services.
  replay    POST the saved terminal task to the configured public Vector
            adapter multiple times to demonstrate Convoy deduplication.
  cleanup   Delete the showcase index. This creates one additional legitimate
            Meilisearch task and webhook.

Options:
  --input FILE       Fixture to replay or use for cleanup
                     (default: ${DEFAULT_FIXTURE})
  --output FILE      Fixture written by create or reject
                     (default: ${DEFAULT_FIXTURE})
  --index NAME       Explicit index name for create, reject, or cleanup
  --copies N         Replay copies sent sequentially (default: ${DEFAULT_REPLAY_COPIES})
  --url URL          Meilisearch URL (default: MEILI_URL or ${DEFAULT_MEILI_URL})
  --source-id VALUE  Expected Vector source identity
                     (default: MEILISEARCH_SOURCE_ID or ${DEFAULT_SOURCE_ID})
  --generation VALUE Expected Vector source generation
                     (default: MEILISEARCH_SOURCE_GENERATION or ${DEFAULT_GENERATION})
  --timeout-ms N     Meilisearch and webhook request timeout
                     (default: ${DEFAULT_TIMEOUT_MS})
  --settle-ms N      Wait after create/reject/replay before exiting
                     (default: ${DEFAULT_SETTLE_MS})
  --dry-run          Validate configuration and print the intended operation
  --help             Show this help

Required environment:
  create/reject/cleanup: MEILI_MASTER_KEY
  replay:                MEILI_TASK_WEBHOOK_URL
                         MEILI_TASK_WEBHOOK_AUTHORIZATION_HEADER

The script never prints either secret.
`);
}

function createUniqueIndexName(prefix, now = new Date()) {
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:TZ]/g, "")
    .toLowerCase();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${timestamp}-${suffix}`;
}

function createDefaultIndexName(now = new Date()) {
  return createUniqueIndexName("monitoring-convoy-showcase", now);
}

function createRejectionIndexName(now = new Date()) {
  return createUniqueIndexName("monitoring-convoy-rejection-showcase", now);
}

function getTaskUid(task) {
  return task?.uid ?? task?.taskUid ?? null;
}

function expectedEventId(sourceId, generation, uid) {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("A non-negative integer task UID is required");
  }
  return `meilisearch:${sourceId}:${generation}:${uid}`;
}

function createClient(args) {
  return new Meilisearch({
    host: args.meiliUrl,
    apiKey: args.apiKey || undefined,
    timeout: args.timeoutMs,
    defaultWaitOptions: { timeout: args.timeoutMs },
  });
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadFixture(filename) {
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON fixture ${filename}: ${error.message}`);
  }
  validateTerminalTask(fixture, filename);
  return fixture;
}

function validateTerminalTask(task, label = "fixture") {
  const uid = getTaskUid(task);
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error(`${label} must contain a non-negative integer uid`);
  }
  if (!TERMINAL_STATUSES.has(task?.status)) {
    throw new Error(
      `${label} status must be one of: ${[...TERMINAL_STATUSES].join(", ")}`
    );
  }
  if (typeof task?.type !== "string" || task.type.length === 0) {
    throw new Error(`${label} must contain a task type`);
  }
}

async function createFixture(args) {
  const operation = args.phase;
  const client = createClient(args);
  const [health, version] = await Promise.all([
    client.health(),
    client.getVersion(),
  ]);
  const indexName =
    args.index ||
    (operation === "reject"
      ? createRejectionIndexName()
      : createDefaultIndexName());
  console.log(
    `[${operation}] Meilisearch health=${health?.status || "unknown"} ` +
      `version=${version?.pkgVersion || version?.commitSha || "unknown"}`
  );
  console.log(`[${operation}] creating empty showcase index ${indexName}`);

  const enqueued = await client.createIndex(indexName, { primaryKey: "id" });
  const task = await client.tasks.waitForTask(enqueued);
  validateTerminalTask(task, "completed Meilisearch task");
  if (task.status !== "succeeded") {
    throw new Error(
      `Index creation task ${getTaskUid(task)} completed as ${task.status}`
    );
  }

  await fs.writeFile(args.output, `${JSON.stringify(task, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });

  const uid = getTaskUid(task);
  console.log(
    `[${operation}] task uid=${uid} status=${task.status} type=${task.type}`
  );
  console.log(`[${operation}] index=${task.indexUid || indexName}`);
  console.log(
    `[${operation}] expected event_id=${expectedEventId(
      args.sourceId,
      args.generation,
      uid
    )}`
  );
  console.log(`[${operation}] fixture=${args.output}`);
  console.log(
    `[${operation}] Meilisearch emitted its configured webhook independently of this fixture file`
  );
  if (args.settleMs > 0) {
    console.log(
      `[${operation}] waiting ${args.settleMs}ms for webhook ingestion`
    );
    await sleep(args.settleMs);
  }
  if (operation === "reject") {
    console.log(
      "[reject] expected receiver result=HTTP 503 from the temporary Vector rejector"
    );
    console.log(
      "[reject] expected Convoy delivery state=Retry with the HTTP status/body visible in the attempt"
    );
    console.log(
      "[reject] restore the real Vector Receiver, then wait for this same delivery to retry successfully"
    );
  }
}

async function postFixture(args, fixture, copy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(args.webhookUrl, {
      method: "POST",
      headers: {
        Authorization: args.authorizationHeader,
        "Content-Type": "application/json",
      },
      body: `${JSON.stringify(fixture)}\n`,
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Replay ${copy} returned HTTP ${response.status}` +
          (responseBody ? `: ${responseBody.slice(0, 500)}` : "")
      );
    }
    console.log(`[replay] copy=${copy}/${args.copies} HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function replayFixture(args) {
  const fixture = await loadFixture(args.input);
  const uid = getTaskUid(fixture);
  console.log(`[replay] fixture=${args.input}`);
  console.log(
    `[replay] expected event_id=${expectedEventId(
      args.sourceId,
      args.generation,
      uid
    )}`
  );
  console.log(
    `[replay] sending ${args.copies} identical copies through the public Vector adapter`
  );
  for (let copy = 1; copy <= args.copies; copy += 1) {
    await postFixture(args, fixture, copy);
  }
  if (args.settleMs > 0) {
    console.log(`[replay] waiting ${args.settleMs}ms for Convoy deduplication`);
    await sleep(args.settleMs);
  }
  console.log(
    "[replay] HTTP success means the copies were accepted; verify Convoy marked them duplicate and created no new deliveries"
  );
}

function isIndexNotFound(error) {
  const codes = [
    error?.code,
    error?.error?.code,
    error?.cause?.code,
    error?.cause?.error?.code,
  ];
  return (
    codes.some((code) =>
      ["index_not_found", "index_not_found_error"].includes(code)
    ) || /index .* not found/i.test(error?.message || "")
  );
}

async function cleanupFixture(args) {
  let indexName = args.index;
  if (!indexName) {
    const fixture = await loadFixture(args.input);
    indexName = fixture.indexUid;
  }
  if (typeof indexName !== "string" || indexName.length === 0) {
    throw new Error("cleanup could not determine the showcase index name");
  }

  const client = createClient(args);
  try {
    const enqueued = await client.deleteIndex(indexName);
    const task = await client.tasks.waitForTask(enqueued);
    if (task.status !== "succeeded") {
      throw new Error(
        `Cleanup task ${getTaskUid(task)} completed as ${task.status}`
      );
    }
    console.log(
      `[cleanup] deleted ${indexName}; delete task uid=${getTaskUid(task)}`
    );
    console.log(
      "[cleanup] this deletion is a new legitimate task and therefore produces one additional webhook event"
    );
  } catch (error) {
    if (isIndexNotFound(error)) {
      console.log(`[cleanup] ${indexName} was already absent`);
      return;
    }
    throw error;
  }
}

function printDryRun(args) {
  console.log(`[dry-run] scriptVersion=${SCRIPT_VERSION} phase=${args.phase}`);
  console.log(
    `[dry-run] expected identity prefix=meilisearch:${args.sourceId}:${args.generation}:`
  );
  if (CREATE_PHASES.has(args.phase)) {
    const operation = args.phase;
    const generatedIndex =
      operation === "reject"
        ? "<generated rejection-showcase name>"
        : "<generated unique name>";
    console.log(
      `[dry-run] would create index=${args.index || generatedIndex}`
    );
    console.log(`[dry-run] would write fixture=${args.output}`);
    if (operation === "reject") {
      console.log(
        "[dry-run] requires the profile-only Vector rejector to replace the real receiver at the same internal URL"
      );
      console.log(
        "[dry-run] expects receiver HTTP 503 and Convoy delivery state Retry"
      );
    }
  } else if (args.phase === "replay") {
    console.log(`[dry-run] would read fixture=${args.input}`);
    console.log(`[dry-run] would send copies=${args.copies}`);
    console.log(`[dry-run] webhook URL configured=${Boolean(args.webhookUrl)}`);
    console.log(
      `[dry-run] authorization configured=${Boolean(args.authorizationHeader)}`
    );
  } else {
    console.log(
      `[dry-run] would delete index=${args.index || `<from ${args.input}>`}`
    );
  }
}

async function run(args) {
  if (args.dryRun) {
    printDryRun(args);
    return;
  }
  if (CREATE_PHASES.has(args.phase)) {
    await createFixture(args);
  } else if (args.phase === "replay") {
    await replayFixture(args);
  } else {
    await cleanupFixture(args);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[convoy-showcase] ${error.message}`);
    console.error("Run with --help for usage.");
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  try {
    await run(args);
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `request exceeded ${args.timeoutMs}ms`
        : error?.stack || error;
    console.error(`[convoy-showcase] failed: ${message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createDefaultIndexName,
  createRejectionIndexName,
  expectedEventId,
  getTaskUid,
  parseArgs,
  validateTerminalTask,
};

if (require.main === module) {
  main();
}
