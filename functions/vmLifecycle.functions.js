"use strict";
const {onRequest} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {db} = require("./backendContext");
const {createVmLifecycleAdapter} = require("./vmLifecycle.adapter");
const {OPERATIONS} = require("./vmLifecycle.service");
const logger = require("firebase-functions/logger");
const serviceAccount = "mapache-api@pi-agents-cloud.iam.gserviceaccount.com";
const service = createVmLifecycleAdapter({db});
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 10;
const RECONCILE_BATCH_SIZE = 4;

/**
 * Find a bounded batch of pending operations, walking past claimed or delayed
 * records so one busy page cannot starve later operations indefinitely.
 *
 * The cursor is the last Firestore document in the page. A page cap keeps the
 * scheduled function bounded; the next tick resumes from the beginning and
 * can continue through the remaining cohort.
 */
async function reconcilePendingLifecycleOperations({
  firestore = db,
  lifecycle = service,
  now = Date.now,
  pageSize = RECONCILE_PAGE_SIZE,
  maxPages = RECONCILE_MAX_PAGES,
  batchSize = RECONCILE_BATCH_SIZE,
} = {}) {
  const time = now();
  let query = firestore.collection(OPERATIONS)
      .where("status", "==", "pending");
  if (typeof query.orderBy === "function") query = query.orderBy("__name__");

  const selected = [];
  let pages = 0;
  let scanned = 0;
  let cursor = null;
  while (pages < maxPages && selected.length < batchSize) {
    const pageQuery = typeof query.limit === "function" ? query.limit(pageSize) : query;
    const snapshot = await pageQuery.get();
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    pages++;
    scanned += docs.length;
    for (const doc of docs) {
      const operation = doc.data() || {};
      if (!(operation.claim?.expiresAt > time) && !(operation.nextAttemptAtMs > time)) selected.push(doc);
      if (selected.length >= batchSize) break;
    }

    if (selected.length >= batchSize || docs.length < pageSize || typeof query.startAfter !== "function") break;
    const nextCursor = docs[docs.length - 1];
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    query = query.startAfter(nextCursor);
  }

  const results = await Promise.allSettled(selected.slice(0, batchSize).map(doc => lifecycle.step(doc.id)));
  return {
    pages,
    scanned,
    selected: results.length,
    succeeded: results.filter(result => result.status === "fulfilled").length,
    failed: results.filter(result => result.status === "rejected").length,
    results,
  };
}

// Operator-only until Firebase-owner admission and migration integration land.
// Only pre-registered lifecycleEnabled VM records can receive operations.
exports.vmLifecycle_v2 = onRequest({invoker: "private", serviceAccount, timeoutSeconds: 60}, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({error: "method_not_allowed"}); return; }
  try {
    if (req.body?.action === "status") {
      const id = req.body.operationId;
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) { res.status(400).json({error: "invalid_operation_id"}); return; }
      const op = (await db.collection(OPERATIONS).doc(id).get()).data();
      if (!op) { res.status(404).json({error: "not_found"}); return; }
      res.json({operationId: id, workspaceId: op.workspaceId, status: op.status, phase: op.phase,
        generation: op.descriptor.generation, lastError: op.lastError || null, quiesceResult: op.quiesceResult || null});
      return;
    }
    res.status(202).json(await service.request(req.body || {}));
  } catch (error) {
    res.status(error.status || 503).json({error: error.publicMessage || "vm_lifecycle_unavailable"});
  }
});

exports.vmLifecycleWorker_v2 = onDocumentWritten({document: `${OPERATIONS}/{operationId}`,
  serviceAccount, timeoutSeconds: 540, memory: "512MiB", concurrency: 1, maxInstances: 4, retry: true}, async event => {
  const after = event.data?.after?.data();
  const before = event.data?.before?.data();
  if (!after || after.status !== "pending" || after.claim || after.nextAttemptAtMs > Date.now() ||
      (before && before.phase === after.phase)) return;
  try {
    await service.step(event.params.operationId);
  } catch (error) {
    // Gaxios errors may contain instance bootstrap metadata and credentials.
    // Never hand those objects to the platform's automatic error serializer.
    throw new Error(`vm_lifecycle_worker_failed:${error.publicMessage || error.code || "operation_failed"}`);
  }
});

exports.vmLifecycleReconcile_v2 = onSchedule({schedule: "every 1 minutes", serviceAccount,
  timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
  const reconciliation = await reconcilePendingLifecycleOperations();
  for (const result of reconciliation.results) {
    if (result.status === "rejected") logger.error("VM lifecycle reconciliation failed", {
      code: result.reason?.publicMessage || result.reason?.code || "vm_operation_failed",
    });
  }
  logger.info("VM lifecycle reconciliation complete", {
    pages: reconciliation.pages,
    scanned: reconciliation.scanned,
    selected: reconciliation.selected,
    succeeded: reconciliation.succeeded,
    failed: reconciliation.failed,
  });
});

exports.reconcilePendingLifecycleOperations = reconcilePendingLifecycleOperations;
