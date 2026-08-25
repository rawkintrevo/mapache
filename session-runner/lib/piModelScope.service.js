"use strict";

const fs = require("fs");
const path = require("path");
const {execFile} = require("child_process");

function createPiModelScopeService({admin, config, db}) {
  const settingsPath = path.join(config.piAgentDir, "settings.json");
  let lastPersistedScope = null;

  function enabled() {
    return (config.harnessId || config.terminalKind) === "pi" && Boolean(config.workspaceId && config.sessionId && config.piAgentDir);
  }

  function sessionRef() {
    return db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId);
  }

  async function restore() {
    if (!enabled()) return {ok: true, skipped: true};
    const ref = sessionRef();
    const snap = await ref.get();
    const session = snap.exists ? snap.data() || {} : {};
    const settings = await readSettings(settingsPath);
    const hasSessionScope = Object.prototype.hasOwnProperty.call(session, "piScopedModels");
    const scopedModels = hasSessionScope ?
      normalizeScopedModels(session.piScopedModels) :
      [];

    await writeScopedModels(settingsPath, settings, scopedModels);
    if (!hasSessionScope) {
      await ref.set({
        piScopedModels: scopedModels,
        piScopedModelsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }
    lastPersistedScope = scopedModels;
    return {ok: true, scopedModelCount: scopedModels.length, initialized: !hasSessionScope};
  }

  async function persist() {
    if (!enabled()) return {ok: true, skipped: true};
    const settings = await readSettings(settingsPath);
    const scopedModels = normalizeScopedModels(settings.enabledModels);
    if (lastPersistedScope && sameStrings(lastPersistedScope, scopedModels)) {
      return {ok: true, scopedModelCount: scopedModels.length, unchanged: true};
    }
    await sessionRef().set({
      piScopedModels: scopedModels,
      piScopedModelsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    lastPersistedScope = scopedModels;
    return {ok: true, scopedModelCount: scopedModels.length};
  }

  async function listModels() {
    if (!enabled()) return {models: [], scopedModels: []};
    const stdout = await execFileOutput("pi", ["--list-models"], {
      cwd: config.workspaceDir,
      env: {...process.env, NO_COLOR: "1"},
      timeout: 30000,
    });
    const settings = await readSettings(settingsPath);
    return {
      models: parsePiModelList(stdout),
      scopedModels: normalizeScopedModels(settings.enabledModels),
    };
  }

  async function save(scopedModels) {
    if (!enabled()) return {models: [], scopedModels: []};
    const normalized = normalizeScopedModels(scopedModels);
    const settings = await readSettings(settingsPath);
    await writeScopedModels(settingsPath, settings, normalized);
    await persist();
    return {ok: true, scopedModels: normalized};
  }

  async function readModelsFile() {
    const filePath = path.join(config.piAgentDir, "models.json");
    const content = await fs.promises.readFile(filePath, "utf8").catch((error) => {
      if (error && error.code === "ENOENT") return "{}\n";
      throw error;
    });
    return {name: "models.json", path: "~/.pi/agent/models.json", content};
  }

  async function saveModelsFile(content) {
    const normalized = String(content || "");
    if (Buffer.byteLength(normalized, "utf8") > 1024 * 1024) throw new Error("models_file_too_large");
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models_file_must_be_object");
    const filePath = path.join(config.piAgentDir, "models.json");
    await fs.promises.mkdir(path.dirname(filePath), {recursive: true});
    const formatted = `${JSON.stringify(parsed, null, 2)}\n`;
    await fs.promises.writeFile(filePath, formatted, {mode: 0o600});
    await fs.promises.chmod(filePath, 0o600).catch(() => {});
    return {name: "models.json", path: "~/.pi/agent/models.json", content: formatted};
  }

  return {listModels, persist, readModelsFile, restore, save, saveModelsFile};
}

function execFileOutput(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {...options, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error) {
        error.message = String(stderr || error.message || "pi model list failed").trim();
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function parsePiModelList(output) {
  const lines = String(output || "").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex((line) => /^provider\s{2,}model\s{2,}/i.test(line));
  if (headerIndex < 0) return [];
  return lines.slice(headerIndex + 1).reduce((models, line) => {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 6) return models;
    const [provider, model, context, maxOutput, thinking, images] = columns;
    if (!provider || !model) return models;
    models.push({
      id: `${provider}/${model}`,
      provider,
      model,
      context,
      maxOutput,
      reasoning: thinking === "yes",
      images: images === "yes",
    });
    return models;
  }, []);
}

async function readSettings(settingsPath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeScopedModels(settingsPath, settings, scopedModels) {
  const next = {...settings};
  if (scopedModels.length) next.enabledModels = scopedModels;
  else delete next.enabledModels;
  await fs.promises.mkdir(path.dirname(settingsPath), {recursive: true});
  await fs.promises.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
  await fs.promises.chmod(settingsPath, 0o600).catch(() => {});
}

function normalizeScopedModels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
      .map((model) => String(model || "").trim().slice(0, 512))
      .filter(Boolean))]
      .slice(0, 512);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

module.exports = {
  createPiModelScopeService,
  normalizeScopedModels,
  parsePiModelList,
};
