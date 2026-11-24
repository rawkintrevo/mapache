#!/usr/bin/env node
// Live proof for the synthetic VM automation-agent boundary only.
// It never sends a model prompt and never prints credential-bearing values.
import {createRequire} from "node:module";
import {mkdir, writeFile} from "node:fs/promises";
import {createHmac, randomUUID} from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const admin = require("../functions/node_modules/firebase-admin");

export const PROJECT_ID = "pi-agents-cloud";
export const WORKSPACE_ID = "vm-proof-605";
export const FUNCTIONS_BASE = `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;
const VM_RUNTIME_COLLECTION = "vmRuntimes_v2";
const VM_CREDENTIALS_COLLECTION = "vmRuntimeCredentials_v2";
const API_QA_FIELD = "apiQaRunId";
const TOKEN_TTL_SECONDS = 15 * 60;

export function makeBrowserAccessToken({sessionId, generation, secret, now = Date.now} = {}) {
  const value = String(secret || "");
  if (!sessionId || !generation || !value) throw new Error("browser_access_inputs_required");
  const millis = typeof now === "function" ? now() : now;
  const exp = Math.floor(Number(millis) / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({sid: sessionId, aud: "agent", gen: generation, exp})).toString("base64url");
  return `${payload}.${createHmac("sha256", value).update(payload).digest("base64url")}`;
}

export function summarizeModelCatalog(body = {}) {
  const models = Array.isArray(body.models) ? body.models : [];
  return {
    modelCount: models.length,
    availableCount: models.filter((model) => model?.available === true).length,
  };
}

export async function runProof({db, fetchImpl = globalThis.fetch, now = Date.now, artifactDir} = {}) {
  if (!db || typeof db.doc !== "function") throw new Error("firestore_required");
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("fetch_required");

  const workspaceRef = db.doc(`${VM_RUNTIME_COLLECTION}/${WORKSPACE_ID}`);
  const runtimeSnapshot = await workspaceRef.get();
  const runtime = runtimeSnapshot.data() || {};
  const sessionId = String(runtime.currentSessionId || "");
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  const credentialsRef = db.doc(`${VM_CREDENTIALS_COLLECTION}/${sessionId}`);
  const [sessionSnapshot, credentialsSnapshot] = await Promise.all([sessionRef.get(), credentialsRef.get()]);
  const session = sessionSnapshot.data() || {};
  const credentials = credentialsSnapshot.data() || {};

  assert.equal(runtime.ownerUid, "vm-proof-owner");
  assert.equal(runtime.backend, "compute-engine");
  assert.equal(runtime.state, "active");
  assert.equal(runtime.apiEnabled, false);
  assert.ok(!runtime.activeOperationId && !runtime[API_QA_FIELD]);
  assert.ok(sessionId && credentials.shutdownToken && credentials.browserToken);
  assert.equal(session.ownerUid, runtime.ownerUid);
  assert.equal(session.generation, runtime.generation);
  assert.equal(session.bootId, runtime.bootId);

  const nonce = randomUUID();
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.get(workspaceRef)).data() || {};
    assert.equal(current.ownerUid, runtime.ownerUid);
    assert.equal(current.apiEnabled, false);
    assert.ok(!current.activeOperationId && !current[API_QA_FIELD]);
    transaction.update(workspaceRef, {apiEnabled: true, [API_QA_FIELD]: nonce});
  });

  let result;
  try {
    const tokenResponse = await fetcher(`${FUNCTIONS_BASE}/automationAgentToken`, {
      method: "POST",
      headers: {"content-type": "application/json", "x-shutdown-token": credentials.shutdownToken},
      body: JSON.stringify({workspaceId: WORKSPACE_ID, sessionId}),
      signal: AbortSignal.timeout(30_000),
    });
    const tokenBody = await jsonBody(tokenResponse);
    assert.equal(tokenResponse.status, 200);
    assert.equal(typeof tokenBody.accessToken, "string");
    const claims = JSON.parse(Buffer.from(tokenBody.accessToken.split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims.workspaceId, WORKSPACE_ID);
    assert.equal(claims.sessionId, sessionId);
    assert.equal(String(claims.generation), String(runtime.generation));
    assert.equal(claims.bootInstanceId, runtime.bootId);

    const agentApiResponse = await fetcher(`${FUNCTIONS_BASE}/api/agent/workspace-requests/targets`, {
      headers: {authorization: `Bearer ${tokenBody.accessToken}`},
      signal: AbortSignal.timeout(30_000),
    });
    const agentApiBody = await jsonBody(agentApiResponse);
    assert.equal(agentApiResponse.status, 200);
    assert.ok(Array.isArray(agentApiBody.targets));

    const browserToken = makeBrowserAccessToken({
      sessionId,
      generation: runtime.generation,
      secret: credentials.browserToken,
      now,
    });
    const modelUrl = new URL("/workspace/models", `https://${runtime.gatewayHost}`);
    modelUrl.searchParams.set("mapache_access", browserToken);
    const modelResponse = await fetcher(modelUrl, {
      headers: {"x-shutdown-token": credentials.shutdownToken},
      signal: AbortSignal.timeout(120_000),
    });
    const modelBody = await jsonBody(modelResponse);
    assert.equal(modelResponse.status, 200);
    const modelSummary = summarizeModelCatalog(modelBody);
    assert.ok(modelSummary.modelCount >= 0);

    result = {
      ok: true,
      workspaceId: WORKSPACE_ID,
      sessionId,
      generation: String(runtime.generation),
      token: {status: tokenResponse.status, claims: {
        workspaceId: claims.workspaceId,
        sessionId: claims.sessionId,
        generation: claims.generation,
        bootInstanceId: claims.bootInstanceId,
      }},
      agentApi: {status: agentApiResponse.status, targetCount: agentApiBody.targets.length},
      modelCatalog: {status: modelResponse.status, ...modelSummary},
    };
  } finally {
    await db.runTransaction(async (transaction) => {
      const current = (await transaction.get(workspaceRef)).data() || {};
      if (current.ownerUid === runtime.ownerUid && current[API_QA_FIELD] === nonce) {
        transaction.update(workspaceRef, {
          apiEnabled: false,
          [API_QA_FIELD]: admin.firestore.FieldValue.delete(),
        });
      }
    });
  }

  const outputDir = path.resolve(artifactDir || path.join("artifacts", "qa", "vm-automation-agent"));
  await mkdir(outputDir, {recursive: true});
  await writeFile(path.join(outputDir, "proof.json"), `${JSON.stringify({...result, temporaryAdmissionRestored: true}, null, 2)}\n`);
  return {...result, artifactDir: outputDir, temporaryAdmissionRestored: true};
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    admin.initializeApp({projectId: PROJECT_ID});
    const result = await runProof({db: admin.firestore()});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`VM automation-agent proof failed: ${error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
