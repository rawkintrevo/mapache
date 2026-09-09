"use strict";

function registerGitRoutes({app, compactErrorMessage, config, git, hasRunnerAccess}) {
  app.get("/git/status", async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    if (git.isBlankWorkspace()) {
      res.json({ok: true, git: false, sourceType: config.workspaceSourceMode, reason: "not_git_workspace"});
      return;
    }

    try {
      res.json(await git.getGitStatusSummary());
    } catch (error) {
      console.error("git status failed", error);
      res.status(500).json({error: "git_status_failed"});
    }
  });

  app.post("/git/pull", async (req, res) => {
    await handleGitAction(req, res, "git pull failed", "git_pull_failed", () => git.pullGitAction(), config, git, hasRunnerAccess, {
      statusCode: 500,
    });
  });

  app.post("/git/stage", async (req, res) => {
    await handleGitAction(req, res, "git stage failed", "git_stage_failed", () => git.stageGitPaths(req.body || {}), config, git, hasRunnerAccess);
  });

  app.post("/git/unstage", async (req, res) => {
    await handleGitAction(req, res, "git unstage failed", "git_unstage_failed", () => git.unstageGitPaths(req.body || {}), config, git, hasRunnerAccess);
  });

  app.post("/git/commit", async (req, res) => {
    await handleGitAction(req, res, "git commit failed", "git_commit_failed", () => git.commitGitChanges(req.body || {}), config, git, hasRunnerAccess, {
      compactError: true,
    });
  });

  app.post("/git/push", async (req, res) => {
    await handleGitAction(req, res, "git push failed", "git_push_failed", () => git.pushGitChanges(req.body || {}), config, git, hasRunnerAccess, {
      compactError: true,
    });
  });

  app.post("/git/open-pr", async (req, res) => {
    await handleGitAction(
        req,
        res,
        "git open pr prepare failed",
        "git_open_pr_failed",
        () => git.prepareGitPullRequest(req.body || {}),
        config,
        git,
        hasRunnerAccess,
        {compactError: true},
    );
  });
}

async function handleGitAction(req, res, logMessage, fallbackCode, action, config, git, hasRunnerAccess, options = {}) {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (git.isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: config.workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await action());
  } catch (error) {
    console.error(logMessage, error);
    const responseCode = options.compactError ? compactErrorMessage(error.message || error) || fallbackCode : fallbackCode;
    res.status(options.statusCode || 400).json({error: responseCode});
  }
}

module.exports = {registerGitRoutes};
