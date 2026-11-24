"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {reconcilePendingLifecycleOperations} = require("./vmLifecycle.functions");

function documentSnapshot(id, data) {
  return {id, data: () => data};
}

function pagedDb(pages) {
  const queries = [];
  function queryFor(pageIndex) {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      startAfter: (cursor) => {
        assert.equal(cursor, pages[pageIndex]?.at(-1));
        return queryFor(pageIndex + 1);
      },
      get: async () => {
        queries.push(pageIndex);
        return {docs: pages[pageIndex] || []};
      },
    };
    return query;
  }
  return {
    db: {collection: () => queryFor(0)},
    queries,
  };
}

test("reconciliation paginates past claimed operations to find an eligible batch", async () => {
  const firstPage = Array.from({length: 100}, (_, index) => documentSnapshot(`claimed-${index}`, {
    claim: {expiresAt: 10_000},
  }));
  const secondPage = [
    documentSnapshot("ready-1", {}),
    documentSnapshot("ready-2", {nextAttemptAtMs: 0}),
    documentSnapshot("ready-3", {}),
    documentSnapshot("ready-4", {}),
    documentSnapshot("ready-5", {}),
  ];
  const {db, queries} = pagedDb([firstPage, secondPage]);
  const stepped = [];
  const result = await reconcilePendingLifecycleOperations({
    firestore: db,
    lifecycle: {step: async id => stepped.push(id)},
    now: () => 100,
  });

  assert.deepEqual(queries, [0, 1]);
  assert.deepEqual(stepped, ["ready-1", "ready-2", "ready-3", "ready-4"]);
  assert.deepEqual({...result, results: undefined}, {
    pages: 2,
    scanned: 105,
    selected: 4,
    succeeded: 4,
    failed: 0,
    results: undefined,
  });
});

test("reconciliation remains bounded when every scanned operation is delayed", async () => {
  const pages = Array.from({length: 3}, (_, page) => Array.from({length: 100}, (_, index) =>
    documentSnapshot(`${page}-${index}`, {nextAttemptAtMs: 101})));
  const {db, queries} = pagedDb(pages);
  const result = await reconcilePendingLifecycleOperations({
    firestore: db,
    lifecycle: {step: async () => assert.fail("delayed operation was selected")},
    now: () => 100,
    maxPages: 2,
  });

  assert.deepEqual(queries, [0, 1]);
  assert.equal(result.pages, 2);
  assert.equal(result.scanned, 200);
  assert.equal(result.selected, 0);
});

test("reconciliation records failed phase attempts without abandoning the batch", async () => {
  const {db} = pagedDb([[documentSnapshot("failed", {}), documentSnapshot("succeeded", {})]]);
  const result = await reconcilePendingLifecycleOperations({
    firestore: db,
    lifecycle: {step: async id => {
      if (id === "failed") throw Object.assign(new Error("phase_failed"), {code: "phase_failed"});
    }},
    now: () => 100,
  });

  assert.equal(result.selected, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].status, "rejected");
  assert.equal(result.results[1].status, "fulfilled");
});
