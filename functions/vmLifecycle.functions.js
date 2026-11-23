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
  const pending = await db.collection(OPERATIONS).where("status", "==", "pending").limit(100).get();
  // Bounded canary controller. More than 100 concurrent pending operations is
  // not yet admitted; paginated cohort reconciliation remains a release gate.
  const eligible = pending.docs.filter(doc => {
    const op = doc.data(); return !(op.claim?.expiresAt > Date.now()) && !(op.nextAttemptAtMs > Date.now());
  }).slice(0, 4);
  const results = await Promise.allSettled(eligible.map(doc => service.step(doc.id)));
  for (const result of results) if (result.status === "rejected") logger.error("VM lifecycle reconciliation failed", {code: result.reason?.publicMessage || result.reason?.code || "vm_operation_failed"});
});
