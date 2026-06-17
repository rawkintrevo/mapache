"use strict";

const fs = require("fs");
const path = require("path");
const {compactErrorMessage} = require("./utils");

function createGithubWorkspaceRestoreService({archives, config, git, syncWorktreeDown}) {
  async function prepareWorkspaceSource() {
    await emptyWorkspaceDir(config.workspaceDir);

    let restoredGitArchive = false;
    try {
      restoredGitArchive = await restoreGithubGitArchiveIfPresent();
      if (!restoredGitArchive) {
        await git.cloneGithubWorkspace();
      }
    } catch (error) {
      const handler = restoredGitArchive ? git.recordGithubSyncFailure : git.recordGithubCloneFailure;
      await handler(error);
      const label = restoredGitArchive ?
        "GitHub workspace cache restore failed" :
        "GitHub workspace startup failed";
      throw new Error(`${label}: ${compactErrorMessage(error.message || error)}`);
    }

    try {
      await syncWorktreeDown();
      await archives.syncArchivesDown({excludeModes: ["workspaceGit"]});
      const resolved = await git.resolveGitHead();
      console.log(`github workspace ready at ${resolved.commit}${resolved.branch ? ` on ${resolved.branch}` : ""}`);
      await git.publishGithubResolvedMetadata(resolved);
    } catch (error) {
      await git.recordGithubSyncFailure(error);
      throw new Error(`GitHub workspace cache restore failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function restoreGithubGitArchiveIfPresent() {
    const target = archives.archiveSyncTargets.find((item) => item.mode === "workspaceGit");
    if (!target || !config.bucketName || !config.prefix) return false;

    const file = archives.archiveFile(target);
    const [exists] = await file.exists();
    if (!exists) {
      console.log("no cached .git archive found; falling back to clone");
      return false;
    }

    console.log("restoring cached .git archive");
    try {
      await fs.promises.mkdir(target.localPath, {recursive: true});
      await archives.extractStorageArchive(file, target);
      if (await hasValidGithubGitArchiveRestore()) {
        return true;
      }
      console.warn("cached .git archive did not restore a valid repository; falling back to clone");
      await fs.promises.rm(target.localPath, {recursive: true, force: true});
      return false;
    } catch (error) {
      throw new Error(`git archive restore failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function hasValidGithubGitArchiveRestore() {
    try {
      const gitDir = await git.runGitCommand(["rev-parse", "--git-dir"], {captureStdout: true});
      const head = await git.runGitCommand(["rev-parse", "--verify", "HEAD"], {captureStdout: true});
      return Boolean(gitDir && head);
    } catch {
      return false;
    }
  }

  async function emptyWorkspaceDir(dir) {
    const entries = await fs.promises.readdir(dir, {withFileTypes: true}).catch((error) => {
      if (error && error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(entries.map((entry) => (
      fs.promises.rm(path.join(dir, entry.name), {recursive: true, force: true})
    )));
  }

  return {
    emptyWorkspaceDir,
    hasValidGithubGitArchiveRestore,
    prepareWorkspaceSource,
    restoreGithubGitArchiveIfPresent,
  };
}

module.exports = {
  createGithubWorkspaceRestoreService,
};
