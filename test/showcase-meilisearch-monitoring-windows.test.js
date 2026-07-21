"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALL_INDEX_NAMES,
  DATASET_INDEX_KEYS,
  INDEX_NAMES,
  SUPPORT_COUNTS,
  buildControlledTaskSequence,
  buildCorpus,
  buildDatasetBatches,
  buildInstantSearchRequests,
  countReturnedHits,
  deleteIndexIfPresent,
  getExistingIndexNames,
  hasRequiredQuerySettings,
  parseArgs,
  percentile,
  recreateDatasetIndexes,
  runControlledTasks,
  taskRecord,
  validateTaskExpectation,
} = require("../showcase-meilisearch-monitoring-windows");

test("parseArgs requires documents and exactly one lifecycle choice", () => {
  assert.throws(() => parseArgs([], {}), /--documents/);
  assert.throws(() => parseArgs(["--documents", "10"], {}), /exactly one/);
  assert.throws(
    () => parseArgs(["--documents", "10", "--keep-indexes", "--cleanup"], {}),
    /exactly one/
  );

  const args = parseArgs([
    "--documents", "10",
    "--keep-indexes",
    "--batch-size", "4",
    "--failed-tasks", "3",
    "--task-order", "alternating",
    "--concurrent-users", "5",
    "--requests-per-user", "7",
  ], { MEILI_URL: "http://localhost:7700/", MEILI_MASTER_KEY: "secret" });

  assert.equal(args.documents, 10);
  assert.equal(args.keepIndexes, true);
  assert.equal(args.cleanup, false);
  assert.equal(args.batchSize, 4);
  assert.equal(args.failedTasks, 3);
  assert.equal(args.taskOrder, "alternating");
  assert.equal(args.concurrentUsers, 5);
  assert.equal(args.requestsPerUser, 7);
  assert.equal(args.url, "http://localhost:7700");
  assert.equal(args.apiKey, "secret");
});

test("parseArgs rejects invalid numeric, URL, and ordering options", () => {
  const base = ["--documents", "10", "--keep-indexes"];
  assert.throws(() => parseArgs([...base, "--batch-size", "0"], {}), /positive integer/);
  assert.throws(() => parseArgs([...base, "--failed-tasks", "-1"], {}), />= 0/);
  assert.throws(() => parseArgs([...base, "--task-order", "surprise"], {}), /must be one of/);
  assert.throws(() => parseArgs([...base, "--url", "localhost:7700"], {}), /http or https/);
});

test("query mode requires neither documents nor index lifecycle authority", () => {
  const args = parseArgs([
    "--mode", "query",
    "--query-rounds", "10000",
    "--wait-for-indexes-ms", "30000",
  ], {});
  assert.equal(args.mode, "query");
  assert.equal(args.documents, undefined);
  assert.equal(args.keepIndexes, false);
  assert.equal(args.cleanup, false);
  assert.equal(args.queryRounds, 10000);
  assert.equal(args.waitForIndexesMs, 30000);

  assert.throws(
    () => parseArgs(["--mode", "query", "--documents", "10"], {}),
    /not valid in query mode/
  );
  assert.throws(
    () => parseArgs(["--mode", "query", "--keep-indexes"], {}),
    /not valid in query mode/
  );
  assert.throws(
    () => parseArgs(["--mode", "index", "--documents", "10"], {}),
    /exactly one/
  );
  assert.throws(
    () => parseArgs(["--mode", "unknown"], {}),
    /--mode must be one of/
  );
});

test("corpus uses the exact benchmark support counts and valid references", () => {
  const first = buildCorpus("test-seed");
  const second = buildCorpus("test-seed");

  assert.equal(first.contacts.length, SUPPORT_COUNTS.contacts);
  assert.equal(first.chats.length, SUPPORT_COUNTS.chats);
  assert.equal(first.groups.length, SUPPORT_COUNTS.groups);
  assert.deepEqual(first.makeMessage(0), second.makeMessage(0));

  const contactIds = new Set(first.contacts.map((contact) => contact.id));
  const chatIds = new Set(first.chats.map((chat) => chat.id));
  for (const chat of first.chats) {
    assert.ok(chat.participants.every((id) => contactIds.has(id)));
  }
  const message = first.makeMessage(1);
  assert.ok(contactIds.has(message.senderId));
  assert.ok(chatIds.has(message.chatId));
  assert.ok(message.participants.every((id) => contactIds.has(id)));
});

test("dataset batches cover support and exact message target without crossing indexes", () => {
  const corpus = buildCorpus("batch-test");
  const batches = [...buildDatasetBatches(corpus, 7, 1000)];
  const counts = Object.fromEntries(DATASET_INDEX_KEYS.map((key) => [key, 0]));
  const ids = new Set();

  for (const batch of batches) {
    assert.equal(batch.indexName, INDEX_NAMES[batch.key]);
    assert.ok(batch.docs.length > 0 && batch.docs.length <= 1000);
    counts[batch.key] += batch.docs.length;
    for (const document of batch.docs) {
      assert.equal(ids.has(document.id), false, `duplicate ${document.id}`);
      ids.add(document.id);
    }
  }

  assert.deepEqual(counts, { contacts: 2400, chats: 900, groups: 500, messages: 7 });
  assert.equal(ids.size, 3807);
});

test("showcase index names are fixed and isolated", () => {
  assert.deepEqual(ALL_INDEX_NAMES, [
    "monitoring-showcase-contacts",
    "monitoring-showcase-chats",
    "monitoring-showcase-groups",
    "monitoring-showcase-messages",
    "monitoring-showcase-controlled-task",
  ]);
});

test("controlled deterministic mode groups equal success and failure counts", () => {
  const sequence = buildControlledTaskSequence(3, "deterministic", "seed");
  assert.deepEqual(sequence.map((entry) => entry.kind), [
    "success", "success", "success", "failure", "failure", "failure",
  ]);
  assert.ok(sequence.slice(0, 3).every((entry) => entry.document.id));
  assert.ok(sequence.slice(3).every((entry) => !("id" in entry.document)));
});

test("controlled alternating mode interleaves equal task counts", () => {
  const sequence = buildControlledTaskSequence(3, "alternating", "seed");
  assert.deepEqual(sequence.map((entry) => entry.kind), [
    "success", "failure", "success", "failure", "success", "failure",
  ]);
});

test("controlled randomized mode is seeded, reproducible, and balanced", () => {
  const first = buildControlledTaskSequence(10, "randomized", "same-seed");
  const second = buildControlledTaskSequence(10, "randomized", "same-seed");
  const different = buildControlledTaskSequence(10, "randomized", "different-seed");

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.equal(first.filter((entry) => entry.kind === "success").length, 10);
  assert.equal(first.filter((entry) => entry.kind === "failure").length, 10);
  assert.deepEqual(buildControlledTaskSequence(0, "randomized", "seed"), []);
});

test("task expectation accepts detailed planned failures and rejects mismatches", () => {
  const failed = taskRecord({
    uid: 42,
    type: "documentAdditionOrUpdate",
    indexUid: INDEX_NAMES.controlled,
    status: "failed",
    duration: "PT0.001S",
    details: { receivedDocuments: 1, indexedDocuments: 0 },
    error: { code: "missing_document_id", message: "Document does not have a primary key" },
  }, "controlled failure 1", "failed", 1);

  assert.equal(validateTaskExpectation(failed), failed);
  assert.throws(
    () => validateTaskExpectation({ ...failed, status: "succeeded" }),
    /expected failed/
  );
  assert.throws(
    () => validateTaskExpectation({ ...failed, error: "" }),
    /did not contain error detail/
  );
});

test("first-run deletion skips indexes that do not exist without enqueueing failed tasks", async () => {
  let deleteCalls = 0;
  const context = {
    taskRecords: [],
    client: {
      async getIndex() {
        throw Object.assign(new Error("Index not found"), { code: "index_not_found" });
      },
      deleteIndex() {
        deleteCalls += 1;
        return Promise.resolve({ taskUid: 1 });
      },
    },
  };

  const result = await deleteIndexIfPresent(context, INDEX_NAMES.contacts, "remove missing index");
  assert.equal(result, null);
  assert.equal(deleteCalls, 0);
  assert.deepEqual(context.taskRecords, []);
});

test("server inventory returns only index names reported by Meilisearch", async () => {
  const calls = [];
  const names = await getExistingIndexNames({
    async getRawIndexes(options) {
      calls.push(options);
      return {
        results: [
          { uid: "application-products" },
          { uid: INDEX_NAMES.messages },
        ],
        total: 2,
      };
    },
  });

  assert.deepEqual(calls, [{ offset: 0, limit: 1000 }]);
  assert.deepEqual([...names], ["application-products", INDEX_NAMES.messages]);
});

test("clean first run creates showcase indexes without submitting deletion tasks", async () => {
  let nextUid = 1;
  let deleteCalls = 0;
  const queued = new Map();
  function enqueue(type, indexUid) {
    const taskUid = nextUid;
    nextUid += 1;
    queued.set(taskUid, { uid: taskUid, taskUid, status: "succeeded", type, indexUid, details: {} });
    return Promise.resolve({ taskUid });
  }

  const context = {
    interrupted: false,
    taskRecords: [],
    createdDatasetIndexes: new Set(),
    client: {
      async getRawIndexes() {
        return { results: [], total: 0 };
      },
      deleteIndex() {
        deleteCalls += 1;
        return enqueue("indexDeletion", "unexpected");
      },
      createIndex(indexUid) {
        return enqueue("indexCreation", indexUid);
      },
      index(indexUid) {
        return {
          updateSettings() {
            return enqueue("settingsUpdate", indexUid);
          },
        };
      },
      tasks: {
        async waitForTask(enqueued) {
          return queued.get(enqueued.taskUid);
        },
      },
    },
  };

  await recreateDatasetIndexes(context);
  assert.equal(deleteCalls, 0);
  assert.deepEqual([...context.createdDatasetIndexes], DATASET_INDEX_KEYS.map((key) => INDEX_NAMES[key]));
  assert.equal(context.taskRecords.length, 8);
  assert.ok(context.taskRecords.every((record) => record.status === "succeeded"));
});

test("delete tolerates an index-not-found task caused by an existence-check race", async () => {
  const context = {
    taskRecords: [],
    client: {
      async getIndex() {
        return { uid: INDEX_NAMES.contacts };
      },
      deleteIndex() {
        return Promise.resolve({ taskUid: 9 });
      },
      tasks: {
        async waitForTask() {
          return {
            uid: 9,
            status: "failed",
            type: "indexDeletion",
            indexUid: INDEX_NAMES.contacts,
            error: { code: "index_not_found", message: `Index ${INDEX_NAMES.contacts} not found` },
          };
        },
      },
    },
  };

  assert.equal(await deleteIndexIfPresent(context, INDEX_NAMES.contacts, "race delete"), null);
  assert.equal(context.taskRecords.length, 1);
  assert.equal(context.taskRecords[0].errorCode, "index_not_found");
});

test("controlled operations are submitted and awaited serially in planned order", async () => {
  let nextUid = 1;
  const queued = new Map();
  const submittedKinds = [];
  let inFlightWaits = 0;
  let maximumInFlightWaits = 0;

  function enqueue(status, type, details = {}, error = null) {
    const taskUid = nextUid;
    nextUid += 1;
    queued.set(taskUid, { taskUid, uid: taskUid, status, type, indexUid: INDEX_NAMES.controlled, details, error });
    return Promise.resolve({ taskUid });
  }

  const context = {
    args: { failedTasks: 3, taskOrder: "alternating", seed: "serial-test" },
    interrupted: false,
    taskRecords: [],
    client: {
      async getIndex() {
        return { uid: INDEX_NAMES.controlled };
      },
      createIndex() {
        return enqueue("succeeded", "indexCreation");
      },
      deleteIndex() {
        return enqueue("succeeded", "indexDeletion");
      },
      index() {
        return {
          addDocuments(documents) {
            const success = Object.hasOwn(documents[0], "id");
            submittedKinds.push(success ? "success" : "failure");
            return enqueue(
              success ? "succeeded" : "failed",
              "documentAdditionOrUpdate",
              { receivedDocuments: 1, indexedDocuments: success ? 1 : 0 },
              success ? null : { message: "Document does not have a primary key" }
            );
          },
        };
      },
      tasks: {
        async waitForTask(enqueued) {
          inFlightWaits += 1;
          maximumInFlightWaits = Math.max(maximumInFlightWaits, inFlightWaits);
          await Promise.resolve();
          inFlightWaits -= 1;
          return queued.get(enqueued.taskUid);
        },
      },
    },
  };

  await runControlledTasks(context);
  assert.deepEqual(submittedKinds, ["success", "failure", "success", "failure", "success", "failure"]);
  assert.equal(maximumInFlightWaits, 1);
  assert.deepEqual(
    context.taskRecords.filter((record) => record.position !== null).map((record) => record.status),
    ["succeeded", "failed", "succeeded", "failed", "succeeded", "failed"]
  );
  assert.equal(context.taskRecords[0].type, "indexCreation");
  assert.equal(context.taskRecords.at(-1).type, "indexDeletion");
});

test("InstantSearch requests target four fixed indexes with membership filters", () => {
  const requests = buildInstantSearchRequests('contact-"quoted"', 25);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.indexName), DATASET_INDEX_KEYS.map((key) => INDEX_NAMES[key]));
  assert.equal(requests[0].params.filters, undefined);
  assert.equal(requests[0].params.hitsPerPage, 25);
  for (const request of requests.slice(1)) {
    assert.match(request.params.filters, /^participants = /);
    assert.match(request.params.filters, /\\"quoted\\"/);
  }
});

test("query readiness requires the searchable and filterable settings used by the workload", () => {
  assert.equal(hasRequiredQuerySettings("contacts", { searchableAttributes: ["username"] }), true);
  assert.equal(hasRequiredQuerySettings("contacts", { searchableAttributes: ["id"] }), false);
  assert.equal(hasRequiredQuerySettings("chats", { filterableAttributes: ["participants"] }), true);
  assert.equal(hasRequiredQuerySettings("groups", { filterableAttributes: [] }), false);
  assert.equal(hasRequiredQuerySettings("messages", {
    searchableAttributes: ["content", "documentName"],
    filterableAttributes: ["participants"],
  }), true);
  assert.equal(hasRequiredQuerySettings("messages", {
    searchableAttributes: ["content"],
    filterableAttributes: ["chatId"],
  }), false);
});

test("latency percentiles and returned hit totals are calculated correctly", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([40, 10, 20, 30], 50), 20);
  assert.equal(percentile([40, 10, 20, 30], 95), 40);
  assert.equal(countReturnedHits({ results: [{ hits: [{}, {}] }, { hits: [{}] }, {}] }), 3);
  assert.equal(countReturnedHits(null), 0);
});
