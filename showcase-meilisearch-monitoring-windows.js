#!/usr/bin/env node

"use strict";

const { performance } = require("node:perf_hooks");
const cliProgress = require("cli-progress");

const SUPPORT_COUNTS = Object.freeze({
  contacts: 2400,
  chats: 900,
  groups: 500,
});

const INDEX_NAMES = Object.freeze({
  contacts: "monitoring-showcase-contacts",
  chats: "monitoring-showcase-chats",
  groups: "monitoring-showcase-groups",
  messages: "monitoring-showcase-messages",
  controlled: "monitoring-showcase-controlled-task",
});

const DATASET_INDEX_KEYS = Object.freeze(["contacts", "chats", "groups", "messages"]);
const ALL_INDEX_NAMES = Object.freeze([...DATASET_INDEX_KEYS.map((key) => INDEX_NAMES[key]), INDEX_NAMES.controlled]);
const TASK_ORDER_MODES = new Set(["deterministic", "alternating", "randomized"]);
const RUN_MODES = new Set(["full", "index", "query"]);
const DEFAULT_URL = "http://127.0.0.1:7700";
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_FAILED_TASKS = 1;
const DEFAULT_QUERY_ROUNDS = 100;
const DEFAULT_WARMUP_ROUNDS = 10;
const DEFAULT_HITS_PER_PAGE = 100;
const DEFAULT_REQUESTS_PER_USER = 20;
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_SEED = "monitoring-showcase";
const NON_INTERACTIVE_PROGRESS_STEP = 10;
const NON_INTERACTIVE_PROGRESS_INTERVAL_MS = 60000;
const WEBHOOK_SETTLE_MS = 5000;
const SCRIPT_VERSION = "1.1.1";

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseIntegerOption(value, option, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    const qualifier = minimum === 1 ? "a positive integer" : `an integer >= ${minimum}`;
    throw new Error(`${option} must be ${qualifier}`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env) {
  const args = {
    documents: undefined,
    mode: "full",
    keepIndexes: false,
    cleanup: false,
    batchSize: DEFAULT_BATCH_SIZE,
    failedTasks: DEFAULT_FAILED_TASKS,
    taskOrder: "deterministic",
    queryRounds: DEFAULT_QUERY_ROUNDS,
    warmupRounds: DEFAULT_WARMUP_ROUNDS,
    hitsPerPage: DEFAULT_HITS_PER_PAGE,
    concurrentUsers: 0,
    requestsPerUser: DEFAULT_REQUESTS_PER_USER,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    waitForIndexesMs: DEFAULT_TIMEOUT_MS,
    seed: DEFAULT_SEED,
    url: env.MEILI_URL || DEFAULT_URL,
    apiKey: env.MEILI_MASTER_KEY || "",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === "--help" || option === "-h") {
      args.help = true;
      continue;
    }
    if (option === "--keep-indexes") {
      args.keepIndexes = true;
      continue;
    }
    if (option === "--cleanup") {
      args.cleanup = true;
      continue;
    }
    if (option === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    const valueOptions = new Map([
      ["--documents", "documents"],
      ["--mode", "mode"],
      ["--batch-size", "batchSize"],
      ["--failed-tasks", "failedTasks"],
      ["--task-order", "taskOrder"],
      ["--query-rounds", "queryRounds"],
      ["--warmup-rounds", "warmupRounds"],
      ["--hits-per-page", "hitsPerPage"],
      ["--concurrent-users", "concurrentUsers"],
      ["--requests-per-user", "requestsPerUser"],
      ["--timeout-ms", "timeoutMs"],
      ["--wait-for-indexes-ms", "waitForIndexesMs"],
      ["--seed", "seed"],
      ["--url", "url"],
      ["--api-key", "apiKey"],
    ]);

    const property = valueOptions.get(option);
    if (!property) {
      throw new Error(`Unknown option: ${option}`);
    }
    args[property] = requireOptionValue(argv, i, option);
    i += 1;
  }

  if (args.help) return args;

  if (!RUN_MODES.has(args.mode)) {
    throw new Error(`--mode must be one of: ${[...RUN_MODES].join(", ")}`);
  }
  if (args.mode !== "query") {
    args.documents = parseIntegerOption(args.documents, "--documents", { minimum: 1 });
  } else if (args.documents !== undefined) {
    throw new Error("--documents is not valid in query mode");
  }
  args.batchSize = parseIntegerOption(args.batchSize, "--batch-size", { minimum: 1 });
  args.failedTasks = parseIntegerOption(args.failedTasks, "--failed-tasks");
  args.queryRounds = parseIntegerOption(args.queryRounds, "--query-rounds", { minimum: 1 });
  args.warmupRounds = parseIntegerOption(args.warmupRounds, "--warmup-rounds");
  args.hitsPerPage = parseIntegerOption(args.hitsPerPage, "--hits-per-page", { minimum: 1 });
  args.concurrentUsers = parseIntegerOption(args.concurrentUsers, "--concurrent-users");
  args.requestsPerUser = parseIntegerOption(args.requestsPerUser, "--requests-per-user", { minimum: 1 });
  args.timeoutMs = parseIntegerOption(args.timeoutMs, "--timeout-ms", { minimum: 1 });
  args.waitForIndexesMs = parseIntegerOption(args.waitForIndexesMs, "--wait-for-indexes-ms", { minimum: 1 });

  if (args.mode === "query") {
    if (args.keepIndexes || args.cleanup) {
      throw new Error("--keep-indexes and --cleanup are not valid in query mode");
    }
  } else if (args.keepIndexes === args.cleanup) {
    throw new Error("Specify exactly one of --keep-indexes or --cleanup in full or index mode");
  }
  if (!TASK_ORDER_MODES.has(args.taskOrder)) {
    throw new Error(`--task-order must be one of: ${[...TASK_ORDER_MODES].join(", ")}`);
  }
  if (typeof args.seed !== "string" || args.seed.length === 0) {
    throw new Error("--seed must not be empty");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(args.url);
  } catch {
    throw new Error("--url or MEILI_URL must be a valid absolute URL");
  }
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("Meilisearch URL must use http or https");
  }
  args.url = args.url.replace(/\/+$/, "");
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node showcase-meilisearch-monitoring-windows.js --mode full --documents N (--keep-indexes | --cleanup) [options]
  node showcase-meilisearch-monitoring-windows.js --mode index --documents N (--keep-indexes | --cleanup) [options]
  node showcase-meilisearch-monitoring-windows.js --mode query [query options]

Modes:
  --mode full                   Index, create controlled tasks, then query (default)
  --mode index                  Only recreate, configure, and populate indexes/tasks
  --mode query                  Only query existing showcase indexes; performs no writes

Index/full requirements:
  --documents N                 Number of message documents; total indexed is N + 3,800
  --keep-indexes                Keep the four dataset indexes after the run
  --cleanup                     Delete the four dataset indexes after the run

Options:
  --batch-size N                Documents per indexing task (default: ${DEFAULT_BATCH_SIZE})
  --failed-tasks N              Controlled successes and failures of each kind (default: ${DEFAULT_FAILED_TASKS})
  --task-order MODE             deterministic, alternating, or randomized (default: deterministic)
  --query-rounds N              Measured sequential search rounds (default: ${DEFAULT_QUERY_ROUNDS})
  --warmup-rounds N             Warm-up rounds, per worker in concurrent mode (default: ${DEFAULT_WARMUP_ROUNDS})
  --hits-per-page N             Hits requested from each index (default: ${DEFAULT_HITS_PER_PAGE})
  --concurrent-users N          Fixed query workers; 0 uses sequential mode (default: 0)
  --requests-per-user N         Measured searches per concurrent worker (default: ${DEFAULT_REQUESTS_PER_USER})
  --timeout-ms N                Meilisearch request/task timeout (default: ${DEFAULT_TIMEOUT_MS})
  --wait-for-indexes-ms N       Query-mode readiness timeout (default: ${DEFAULT_TIMEOUT_MS})
  --seed VALUE                  Corpus and randomized-order seed (default: ${DEFAULT_SEED})
  --url URL                     Meilisearch URL (default: MEILI_URL or ${DEFAULT_URL})
  --api-key KEY                 API key (prefer MEILI_MASTER_KEY to avoid shell history)
  --dry-run                     Print the plan without connecting to Meilisearch
  --help                        Show this help

Examples (PowerShell):
  node .\\showcase-meilisearch-monitoring-windows.js --mode index --documents 10000 --keep-indexes
  node .\\showcase-meilisearch-monitoring-windows.js --mode query --query-rounds 10000
  node .\\showcase-meilisearch-monitoring-windows.js --mode query --concurrent-users 5 --requests-per-user 1000
`);
}

function createRng(seedText) {
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
  }
  if (seed === 0) seed = 0x12345678;
  return function next() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}

function pick(list, rng, index = 0) {
  return list[(Math.floor(rng() * list.length) + index) % list.length];
}

function repeatText(base, minimum, maximum, rng) {
  const count = minimum + Math.floor(rng() * (maximum - minimum + 1));
  return Array.from({ length: count }, () => base).join(" ");
}

function padId(prefix, index) {
  return `${prefix}-${String(index).padStart(8, "0")}`;
}

function buildCorpus(seedText = DEFAULT_SEED) {
  const rng = createRng(`${seedText}:corpus`);
  const contacts = [];
  const chats = [];
  const groups = [];

  for (let i = 0; i < SUPPORT_COUNTS.contacts; i += 1) {
    contacts.push({
      id: padId("contact", i + 1),
      username: `lorem-contact-${String(i + 1).padStart(4, "0")}`,
    });
  }

  for (let i = 0; i < SUPPORT_COUNTS.chats; i += 1) {
    const isGroup = i % 4 !== 0;
    const memberCount = isGroup ? 3 + ((i + 1) % 5) : 2;
    const selected = Array.from({ length: memberCount }, (_, memberIndex) =>
      contacts[(i * 7 + memberIndex * 11) % contacts.length]
    );
    chats.push({
      id: padId("chat", i + 1),
      ...(isGroup ? { groupName: `lorem ipsum group ${String(i + 1).padStart(4, "0")}` } : {}),
      isGroup,
      participants: selected.map((contact) => contact.id),
      participantNames: selected.map((contact) => contact.username),
      updatedAt: 1700000000000 + i * 1000,
    });
  }

  for (let i = 0; i < SUPPORT_COUNTS.groups; i += 1) {
    const memberCount = 4 + (i % 5);
    const selected = Array.from({ length: memberCount }, (_, memberIndex) =>
      contacts[(i * 13 + memberIndex * 17) % contacts.length]
    );
    groups.push({
      id: padId("group", i + 1),
      participants: selected.map((contact) => contact.id),
      participantNames: selected.map((contact) => contact.username),
      updatedAt: 1701000000000 + i * 1000,
    });
  }

  const messageTemplates = [
    "lorem ipsum dolor sit amet consectetur adipiscing elit",
    "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua",
    "ut enim ad minim veniam quis nostrud exercitation ullamco laboris",
    "nisi ut aliquip ex ea commodo consequat duis aute irure dolor",
    "in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur",
  ];

  function makeMessage(index) {
    const chat = chats[index % chats.length];
    const sender = contacts[(index * 5 + 3) % contacts.length];
    const mediaType = index % 8 === 0
      ? "document"
      : index % 8 === 1
        ? "image"
        : index % 8 === 2
          ? "video"
          : index % 8 === 3
            ? "audio"
            : "";
    const content = index % 9 === 0
      ? ""
      : repeatText(`${pick(messageTemplates, rng, index)} lorem-${String(index % 97).padStart(2, "0")}`, 2, 5, rng);
    return {
      id: padId("message", index + 1),
      content,
      senderId: sender.id,
      chatId: chat.id,
      participants: [...chat.participants],
      mediaType,
      documentName: mediaType === "document" ? `lorem-report-${String(index + 1).padStart(6, "0")}.pdf` : "",
      createdAt: 1702000000000 + index * 1000,
      deliveredTo: chat.participants.slice(1, Math.min(chat.participants.length, 4)),
      readBy: index % 3 === 0 ? chat.participants.slice(0, Math.min(chat.participants.length, 2)) : [],
    };
  }

  return { contacts, chats, groups, makeMessage };
}

function* buildDatasetBatches(corpus, messageCount, batchSize) {
  for (const key of ["contacts", "chats", "groups"]) {
    for (let offset = 0; offset < corpus[key].length; offset += batchSize) {
      yield { key, indexName: INDEX_NAMES[key], docs: corpus[key].slice(offset, offset + batchSize) };
    }
  }
  for (let offset = 0; offset < messageCount; offset += batchSize) {
    const count = Math.min(batchSize, messageCount - offset);
    yield {
      key: "messages",
      indexName: INDEX_NAMES.messages,
      docs: Array.from({ length: count }, (_, relativeIndex) => corpus.makeMessage(offset + relativeIndex)),
    };
  }
}

function seededShuffle(items, seedText) {
  const shuffled = [...items];
  const rng = createRng(seedText);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const swapIndex = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[i]];
  }
  return shuffled;
}

function buildControlledTaskSequence(count, mode, seedText = DEFAULT_SEED) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Controlled task count must be a non-negative integer");
  if (!TASK_ORDER_MODES.has(mode)) throw new Error(`Unknown task order: ${mode}`);

  const successes = Array.from({ length: count }, (_, index) => ({
    kind: "success",
    ordinal: index + 1,
    expectedStatus: "succeeded",
    document: {
      id: `controlled-success-${String(index + 1).padStart(4, "0")}`,
      title: `controlled successful task ${index + 1}`,
    },
  }));
  const failures = Array.from({ length: count }, (_, index) => ({
    kind: "failure",
    ordinal: index + 1,
    expectedStatus: "failed",
    document: { title: `controlled missing primary key ${index + 1}` },
  }));

  if (mode === "deterministic") return [...successes, ...failures];
  if (mode === "alternating") {
    return successes.flatMap((success, index) => [success, failures[index]]);
  }
  return seededShuffle([...successes, ...failures], `${seedText}:controlled-task-order`);
}

function buildSettings(key) {
  if (key === "messages") {
    return {
      searchableAttributes: ["content", "documentName"],
      filterableAttributes: ["chatId", "participants", "createdAt"],
      sortableAttributes: ["createdAt"],
      displayedAttributes: ["id", "content", "documentName", "chatId", "participants", "createdAt", "senderId", "mediaType", "deliveredTo", "readBy"],
    };
  }
  if (key === "chats") {
    return {
      searchableAttributes: ["groupName", "participantNames"],
      filterableAttributes: ["participants"],
      sortableAttributes: ["updatedAt"],
      displayedAttributes: ["id", "groupName", "participantNames", "participants", "updatedAt", "isGroup"],
    };
  }
  if (key === "contacts") {
    return {
      searchableAttributes: ["username"],
      filterableAttributes: [],
      sortableAttributes: [],
      displayedAttributes: ["id", "username"],
    };
  }
  return {
    searchableAttributes: ["participantNames"],
    filterableAttributes: ["participants"],
    sortableAttributes: ["updatedAt"],
    displayedAttributes: ["id", "participantNames", "participants", "updatedAt"],
  };
}

function escapeFilterValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildInstantSearchRequests(searchUserId, hitsPerPage) {
  const filter = `participants = "${escapeFilterValue(searchUserId)}"`;
  return DATASET_INDEX_KEYS.map((key) => ({
    indexName: INDEX_NAMES[key],
    params: {
      query: "lorem",
      hitsPerPage,
      ...(key === "contacts" ? {} : { filters: filter }),
    },
  }));
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function countReturnedHits(response) {
  if (!response || !Array.isArray(response.results)) return 0;
  return response.results.reduce((total, result) => total + (Array.isArray(result?.hits) ? result.hits.length : 0), 0);
}

function isIndexNotFound(error) {
  const codes = [
    error?.code,
    error?.error?.code,
    error?.cause?.code,
    error?.cause?.error?.code,
    error?.taskRecord?.errorCode,
  ];
  return codes.some((code) => ["index_not_found", "index_not_found_error"].includes(code)) ||
    /index .* not found/i.test(error?.message || "");
}

function getTaskUid(task) {
  return task?.uid ?? task?.taskUid ?? null;
}

function taskErrorDetail(task) {
  if (!task?.error) return "";
  return task.error.message || task.error.code || task.error.type || JSON.stringify(task.error);
}

function taskRecord(task, operation, expectedStatus, position = null) {
  const details = task?.details || {};
  return {
    position,
    operation,
    expectedStatus,
    uid: getTaskUid(task),
    type: task?.type || "unknown",
    indexUid: task?.indexUid || "_global",
    status: task?.status || "unknown",
    duration: task?.duration || "n/a",
    receivedDocuments: details.receivedDocuments ?? "n/a",
    indexedDocuments: details.indexedDocuments ?? "n/a",
    errorCode: task?.error?.code || "",
    errorType: task?.error?.type || "",
    error: taskErrorDetail(task),
  };
}

function validateTaskExpectation(record) {
  if (record.status !== record.expectedStatus) {
    const error = new Error(
      `Task ${record.uid ?? "unknown"} for ${record.operation} was ${record.status}; ` +
      `expected ${record.expectedStatus}${record.error ? `: ${record.error}` : ""}`
    );
    error.code = record.errorCode || undefined;
    error.taskRecord = record;
    throw error;
  }
  if (record.expectedStatus === "failed" && !record.error) {
    const error = new Error(`Expected failed task ${record.uid ?? "unknown"} for ${record.operation} did not contain error detail`);
    error.taskRecord = record;
    throw error;
  }
  return record;
}

async function awaitTask(context, taskPromise, operation, expectedStatus = "succeeded", position = null) {
  const enqueuedTask = await taskPromise;
  const task = await context.client.tasks.waitForTask(enqueuedTask);
  const record = taskRecord(task, operation, expectedStatus, position);
  context.taskRecords.push(record);
  validateTaskExpectation(record);
  return task;
}

async function deleteIndexIfPresent(context, indexName, operation, { knownPresent = false } = {}) {
  if (!knownPresent) {
    try {
      await context.client.getIndex(indexName);
    } catch (error) {
      if (isIndexNotFound(error)) return null;
      throw error;
    }
  }
  try {
    return await awaitTask(context, context.client.deleteIndex(indexName), operation);
  } catch (error) {
    // The index can disappear between the existence check and task execution.
    // Treat that race as an already-satisfied idempotent delete.
    if (isIndexNotFound(error)) {
      console.log(`[setup] ${indexName} disappeared before deletion completed; continuing`);
      return null;
    }
    throw error;
  }
}

async function getExistingIndexNames(client) {
  const names = new Set();
  const limit = 1000;
  let offset = 0;
  for (;;) {
    const page = await client.getRawIndexes({ offset, limit });
    const results = Array.isArray(page?.results) ? page.results : [];
    for (const index of results) {
      if (typeof index?.uid === "string") names.add(index.uid);
    }
    offset += results.length;
    if (results.length < limit || (Number.isFinite(page?.total) && offset >= page.total)) break;
  }
  return names;
}

function createProgressReporter(label, total) {
  const interactive = Boolean(process.stdout.isTTY);
  let bar = null;
  let lastLoggedBucket = -NON_INTERACTIVE_PROGRESS_STEP;
  let lastLogAt = 0;

  function stop() {
    if (bar) {
      bar.stop();
      bar = null;
    }
  }

  return {
    update(value, payload = {}) {
      const safeValue = Math.min(value, total);
      if (interactive) {
        if (!bar) {
          bar = new cliProgress.SingleBar({
            format: `[${label}] [{bar}] {percentage}% | {value}/{total} | {detail} | ETA {eta_formatted}`,
            hideCursor: true,
            clearOnComplete: true,
            barsize: Math.max(10, Math.min(30, (process.stdout.columns || 100) - 70)),
          }, cliProgress.Presets.shades_classic);
          bar.start(total, safeValue, { detail: payload.detail || "starting" });
        } else {
          bar.update(safeValue, { detail: payload.detail || "running" });
        }
        return;
      }
      const percent = total === 0 ? 100 : Math.min(100, (safeValue / total) * 100);
      const bucket = Math.floor(percent / NON_INTERACTIVE_PROGRESS_STEP) * NON_INTERACTIVE_PROGRESS_STEP;
      const now = Date.now();
      if (bucket > lastLoggedBucket || now - lastLogAt >= NON_INTERACTIVE_PROGRESS_INTERVAL_MS || safeValue >= total) {
        console.log(`[${label}] ${percent.toFixed(1)}% ${safeValue}/${total} ${payload.detail || ""}`.trim());
        lastLoggedBucket = bucket;
        lastLogAt = now;
      }
    },
    stop,
  };
}

function createMeiliClient(args) {
  const { Meilisearch } = require("meilisearch");
  return new Meilisearch({
    host: args.url,
    apiKey: args.apiKey || undefined,
    timeout: args.timeoutMs,
    defaultWaitOptions: { timeout: args.timeoutMs },
  });
}

async function createSearchClient(args) {
  const { instantMeiliSearch } = await import("@meilisearch/instant-meilisearch");
  return instantMeiliSearch(args.url, args.apiKey || undefined).searchClient;
}

function ensureNotInterrupted(context) {
  if (context.interrupted) {
    const error = new Error("Interrupted by Ctrl+C");
    error.code = "INTERRUPTED";
    throw error;
  }
}

async function recreateDatasetIndexes(context) {
  console.log(`[setup] deleting only fixed showcase indexes: ${ALL_INDEX_NAMES.join(", ")}`);
  const existingIndexes = await getExistingIndexNames(context.client);
  const existingShowcaseIndexes = ALL_INDEX_NAMES.filter((indexName) => existingIndexes.has(indexName));
  console.log(`[setup] existing showcase indexes: ${existingShowcaseIndexes.join(", ") || "none"}`);
  for (const indexName of ALL_INDEX_NAMES) {
    ensureNotInterrupted(context);
    if (!existingIndexes.has(indexName)) continue;
    await deleteIndexIfPresent(
      context,
      indexName,
      `remove pre-existing ${indexName}`,
      { knownPresent: true }
    );
  }
  for (const key of DATASET_INDEX_KEYS) {
    ensureNotInterrupted(context);
    const indexName = INDEX_NAMES[key];
    await awaitTask(context, context.client.createIndex(indexName, { primaryKey: "id" }), `create ${indexName}`);
    context.createdDatasetIndexes.add(indexName);
    await awaitTask(context, context.client.index(indexName).updateSettings(buildSettings(key)), `configure ${indexName}`);
  }
}

function hasRequiredQuerySettings(key, settings) {
  const searchable = Array.isArray(settings?.searchableAttributes) ? settings.searchableAttributes : [];
  const filterable = Array.isArray(settings?.filterableAttributes) ? settings.filterableAttributes : [];
  if (key === "contacts") return searchable.includes("username");
  if (key === "messages") return searchable.includes("content") && filterable.includes("participants");
  return filterable.includes("participants");
}

async function waitForShowcaseIndexes(context) {
  const deadline = Date.now() + context.args.waitForIndexesMs;
  let lastState = "";
  for (;;) {
    ensureNotInterrupted(context);
    const pending = [];
    for (const key of DATASET_INDEX_KEYS) {
      try {
        const settings = await context.client.index(INDEX_NAMES[key]).getSettings();
        if (!hasRequiredQuerySettings(key, settings)) pending.push(`${key}:settings`);
      } catch (error) {
        if (!isIndexNotFound(error)) throw error;
        pending.push(`${key}:missing`);
      }
    }
    if (pending.length === 0) {
      console.log("[query] all showcase indexes and required filter settings are ready");
      return;
    }
    const state = pending.join(",");
    if (state !== lastState) {
      console.log(`[query] waiting for index-mode terminal: ${state}`);
      lastState = state;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out after ${context.args.waitForIndexesMs}ms waiting for query-ready showcase indexes: ${state}`);
    }
    await sleep(Math.min(1000, remainingMs));
  }
}

async function indexDataset(context, corpus) {
  const total = Object.values(SUPPORT_COUNTS).reduce((sum, value) => sum + value, 0) + context.args.documents;
  const progress = createProgressReporter("index", total);
  context.activeProgress = progress;
  let indexed = 0;
  progress.update(0, { detail: "waiting for first indexing task" });
  try {
    for (const batch of buildDatasetBatches(corpus, context.args.documents, context.args.batchSize)) {
      ensureNotInterrupted(context);
      const task = await awaitTask(
        context,
        context.client.index(batch.indexName).addDocuments(batch.docs),
        `index ${batch.docs.length} documents into ${batch.indexName}`
      );
      indexed += batch.docs.length;
      progress.update(indexed, {
        detail: `${batch.key} batch=${batch.docs.length} task=${getTaskUid(task) ?? "unknown"}`,
      });
    }
  } finally {
    progress.stop();
    context.activeProgress = null;
  }
  console.log(`[index] complete indexed=${indexed} messages=${context.args.documents} support=${total - context.args.documents}`);
}

async function runControlledTasks(context) {
  const { failedTasks, taskOrder, seed } = context.args;
  if (failedTasks === 0) {
    console.log("[tasks] controlled task scenario skipped (--failed-tasks 0)");
    return;
  }

  const sequence = buildControlledTaskSequence(failedTasks, taskOrder, seed);
  console.log(`[tasks] planned order mode=${taskOrder} sequence=${sequence.map((entry) => entry.kind).join(" -> ")}`);
  await awaitTask(
    context,
    context.client.createIndex(INDEX_NAMES.controlled, { primaryKey: "id" }),
    `create ${INDEX_NAMES.controlled}`
  );

  let sequenceError = null;
  try {
    for (let index = 0; index < sequence.length; index += 1) {
      ensureNotInterrupted(context);
      const entry = sequence[index];
      const position = index + 1;
      const task = await awaitTask(
        context,
        context.client.index(INDEX_NAMES.controlled).addDocuments([entry.document]),
        `controlled ${entry.kind} ${entry.ordinal}`,
        entry.expectedStatus,
        position
      );
      console.log(`[tasks] position=${position}/${sequence.length} planned=${entry.kind} uid=${getTaskUid(task)} actual=${task.status}`);
    }
  } catch (error) {
    sequenceError = error;
  }

  try {
    await deleteIndexIfPresent(
      context,
      INDEX_NAMES.controlled,
      `delete ${INDEX_NAMES.controlled}`,
      { knownPresent: true }
    );
  } catch (cleanupError) {
    if (!sequenceError) sequenceError = cleanupError;
    else console.error(`[tasks] controlled index cleanup also failed: ${cleanupError.message}`);
  }
  if (sequenceError) throw sequenceError;
}

async function performSearch(searchClient, requests) {
  searchClient.clearCache?.();
  const startedAt = performance.now();
  const response = await searchClient.search(requests);
  return { durationMs: performance.now() - startedAt, hits: countReturnedHits(response) };
}

function summarizeLatencies(label, latencies, elapsedMs, hits, errors, logicalRequests) {
  const rate = elapsedMs > 0 ? logicalRequests / (elapsedMs / 1000) : 0;
  console.log(
    `[query] mode=${label} requests=${logicalRequests} subqueries=${logicalRequests * DATASET_INDEX_KEYS.length} ` +
    `hits=${hits} errors=${errors} elapsed=${elapsedMs.toFixed(2)}ms rate=${rate.toFixed(2)}req/s ` +
    `p50=${percentile(latencies, 50).toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms ` +
    `p99=${percentile(latencies, 99).toFixed(2)}ms`
  );
}

async function runSequentialQueries(context, corpus) {
  const client = await createSearchClient(context.args);
  const requests = buildInstantSearchRequests(corpus.contacts[0].id, context.args.hitsPerPage);
  let warmupErrors = 0;
  console.log(`[query] warming up sequential client rounds=${context.args.warmupRounds}`);
  for (let round = 0; round < context.args.warmupRounds; round += 1) {
    ensureNotInterrupted(context);
    try {
      await performSearch(client, requests);
    } catch (error) {
      warmupErrors += 1;
      console.error(`[query] warmup round=${round + 1} failed: ${error.message}`);
    }
  }

  const progress = createProgressReporter("query", context.args.queryRounds);
  context.activeProgress = progress;
  const latencies = [];
  const errors = [];
  let hits = 0;
  const startedAt = performance.now();
  progress.update(0, { detail: "starting measured searches" });
  try {
    for (let round = 0; round < context.args.queryRounds; round += 1) {
      ensureNotInterrupted(context);
      try {
        const result = await performSearch(client, requests);
        latencies.push(result.durationMs);
        hits += result.hits;
      } catch (error) {
        errors.push(error);
      }
      progress.update(round + 1, { detail: `errors=${errors.length}` });
    }
  } finally {
    progress.stop();
    context.activeProgress = null;
  }
  const elapsedMs = performance.now() - startedAt;
  summarizeLatencies("sequential", latencies, elapsedMs, hits, errors.length, context.args.queryRounds);
  if (warmupErrors > 0 || errors.length > 0) {
    throw new Error(`Query workload had ${warmupErrors} warm-up errors and ${errors.length} measured errors`);
  }
}

async function runConcurrentQueries(context, corpus) {
  const workerCount = context.args.concurrentUsers;
  const workers = await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => ({
    client: await createSearchClient(context.args),
    requests: buildInstantSearchRequests(corpus.contacts[workerIndex % corpus.contacts.length].id, context.args.hitsPerPage),
  })));

  let warmupErrors = 0;
  console.log(`[query] warming up workers=${workerCount} roundsPerWorker=${context.args.warmupRounds}`);
  await Promise.all(workers.map(async (worker) => {
    for (let round = 0; round < context.args.warmupRounds; round += 1) {
      try {
        await performSearch(worker.client, worker.requests);
      } catch {
        warmupErrors += 1;
      }
    }
  }));

  const totalRequests = workerCount * context.args.requestsPerUser;
  const progress = createProgressReporter("query", totalRequests);
  context.activeProgress = progress;
  const latencies = [];
  const errors = [];
  let completed = 0;
  let hits = 0;
  const startedAt = performance.now();
  progress.update(0, { detail: `users=${workerCount} errors=0` });
  try {
    await Promise.all(workers.map(async (worker) => {
      for (let requestNumber = 0; requestNumber < context.args.requestsPerUser; requestNumber += 1) {
        ensureNotInterrupted(context);
        try {
          const result = await performSearch(worker.client, worker.requests);
          latencies.push(result.durationMs);
          hits += result.hits;
        } catch (error) {
          errors.push(error);
        }
        completed += 1;
        progress.update(completed, { detail: `users=${workerCount} errors=${errors.length}` });
      }
    }));
  } finally {
    progress.stop();
    context.activeProgress = null;
  }
  const elapsedMs = performance.now() - startedAt;
  summarizeLatencies(`concurrent users=${workerCount}`, latencies, elapsedMs, hits, errors.length, totalRequests);
  if (warmupErrors > 0 || errors.length > 0) {
    throw new Error(`Concurrent query workload had ${warmupErrors} warm-up errors and ${errors.length} measured errors`);
  }
}

async function cleanupDatasetIndexes(context) {
  const errors = [];
  for (const indexName of [...context.createdDatasetIndexes]) {
    try {
      await deleteIndexIfPresent(context, indexName, `cleanup ${indexName}`, { knownPresent: true });
      context.createdDatasetIndexes.delete(indexName);
    } catch (error) {
      errors.push(`${indexName}: ${error.message}`);
    }
  }
  if (errors.length > 0) throw new Error(`Cleanup failed for ${errors.join("; ")}`);
}

function printTaskSummary(records) {
  console.log(`[tasks] summary count=${records.length}`);
  for (const record of records) {
    console.log(
      `[task] position=${record.position ?? "-"} operation=${JSON.stringify(record.operation)} ` +
      `uid=${record.uid ?? "unknown"} type=${record.type} index=${record.indexUid} ` +
      `expected=${record.expectedStatus} actual=${record.status} duration=${record.duration} ` +
      `received=${record.receivedDocuments} indexed=${record.indexedDocuments}` +
      (record.errorCode ? ` errorCode=${record.errorCode}` : "") +
      (record.error ? ` error=${JSON.stringify(record.error)}` : "")
    );
  }
}

function printDryRun(args) {
  console.log(`[dry-run] scriptVersion=${SCRIPT_VERSION} mode=${args.mode} endpoint=${args.url}`);
  console.log(`[dry-run] indexes=${ALL_INDEX_NAMES.join(",")}`);
  if (args.mode !== "query") {
    const supportTotal = Object.values(SUPPORT_COUNTS).reduce((sum, value) => sum + value, 0);
    const batchCounts = {
      contacts: Math.ceil(SUPPORT_COUNTS.contacts / args.batchSize),
      chats: Math.ceil(SUPPORT_COUNTS.chats / args.batchSize),
      groups: Math.ceil(SUPPORT_COUNTS.groups / args.batchSize),
      messages: Math.ceil(args.documents / args.batchSize),
    };
    const controlled = buildControlledTaskSequence(args.failedTasks, args.taskOrder, args.seed);
    console.log(`[dry-run] lifecycle=${args.cleanup ? "cleanup" : "keep"}`);
    console.log(`[dry-run] documents messages=${args.documents} support=${supportTotal} total=${args.documents + supportTotal}`);
    console.log(`[dry-run] batches=${JSON.stringify(batchCounts)} batchSize=${args.batchSize}`);
    console.log(`[dry-run] controlled mode=${args.taskOrder} sequence=${controlled.map((entry) => entry.kind).join(" -> ") || "skipped"}`);
  }
  if (args.mode !== "index") {
    console.log(`[dry-run] queries mode=${args.concurrentUsers > 0 ? `concurrent users=${args.concurrentUsers} requestsPerUser=${args.requestsPerUser}` : `sequential rounds=${args.queryRounds}`} warmupRounds=${args.warmupRounds}`);
    if (args.mode === "query") console.log(`[dry-run] waitForIndexesMs=${args.waitForIndexesMs} writes=disabled`);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(args) {
  if (args.dryRun) {
    printDryRun(args);
    return;
  }

  const context = {
    args,
    client: createMeiliClient(args),
    taskRecords: [],
    createdDatasetIndexes: new Set(),
    activeProgress: null,
    interrupted: false,
  };
  const handleInterrupt = () => {
    if (!context.interrupted) console.error("\n[showcase] Ctrl+C received; finishing the current request before safe shutdown");
    context.interrupted = true;
    context.activeProgress?.stop();
  };
  process.on("SIGINT", handleInterrupt);

  let runError = null;
  try {
    const [health, version] = await Promise.all([context.client.health(), context.client.getVersion()]);
    console.log(`[showcase] scriptVersion=${SCRIPT_VERSION} endpoint=${args.url} health=${health?.status || "unknown"} version=${version?.pkgVersion || version?.commitSha || "unknown"}`);
    const corpus = buildCorpus(args.seed);
    console.log(`[showcase] mode=${args.mode}`);
    if (args.mode !== "query") {
      console.log(`[showcase] messages=${args.documents} totalDocuments=${args.documents + 3800} batchSize=${args.batchSize} lifecycle=${args.cleanup ? "cleanup" : "keep"}`);
      await recreateDatasetIndexes(context);
      await indexDataset(context, corpus);
      await runControlledTasks(context);
      console.log(`[showcase] waiting ${WEBHOOK_SETTLE_MS / 1000}s for final task webhook delivery`);
      await sleep(WEBHOOK_SETTLE_MS);
    }
    if (args.mode !== "index") {
      if (args.mode === "query") await waitForShowcaseIndexes(context);
      if (args.concurrentUsers > 0) await runConcurrentQueries(context, corpus);
      else await runSequentialQueries(context, corpus);
    }
  } catch (error) {
    runError = error;
  } finally {
    context.activeProgress?.stop();
    if (args.mode !== "query" && args.cleanup) {
      try {
        await cleanupDatasetIndexes(context);
      } catch (cleanupError) {
        if (!runError) runError = cleanupError;
        else console.error(`[cleanup] ${cleanupError.message}`);
      }
    }
    if (context.taskRecords.length > 0) printTaskSummary(context.taskRecords);
    process.off("SIGINT", handleInterrupt);
  }

  if (context.interrupted && !runError) {
    runError = Object.assign(new Error("Interrupted by Ctrl+C"), { code: "INTERRUPTED" });
  }
  if (runError) throw runError;
  if (args.mode === "query") console.log("[showcase] query-only workload complete; no indexes were modified");
  else console.log(`[showcase] ${args.mode} mode complete; dataset indexes ${args.cleanup ? "were deleted" : "remain available"}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[showcase] ${error.message}`);
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
    console.error(`[showcase] failed: ${error?.stack || error}`);
    process.exitCode = error?.code === "INTERRUPTED" ? 130 : 1;
  }
}

module.exports = {
  ALL_INDEX_NAMES,
  DATASET_INDEX_KEYS,
  INDEX_NAMES,
  SUPPORT_COUNTS,
  buildControlledTaskSequence,
  buildCorpus,
  buildDatasetBatches,
  buildInstantSearchRequests,
  buildSettings,
  countReturnedHits,
  createRng,
  deleteIndexIfPresent,
  getExistingIndexNames,
  parseArgs,
  percentile,
  recreateDatasetIndexes,
  seededShuffle,
  taskRecord,
  runControlledTasks,
  hasRequiredQuerySettings,
  waitForShowcaseIndexes,
  validateTaskExpectation,
};

if (require.main === module) {
  main();
}
