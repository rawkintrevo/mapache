"use strict";

function registerRunnerSignals({runnerLifecycle, budgetMs, processImpl = process, logger = console}) {
  let shutdown;
  const handleSignal = (signal) => {
    if (shutdown) return shutdown;
    logger.log("session runner signal shutdown started", {signal, budgetMs});
    shutdown = Promise.resolve().then(() => runnerLifecycle.shutdownWithBudget({reason: signal, budgetMs}))
        .then(() => logger.log("session runner signal shutdown completed", {signal}))
        .catch((error) => logger.error(`session runner ${signal} shutdown failed`, error))
        .finally(() => processImpl.exit(0));
    return shutdown;
  };
  processImpl.once("SIGTERM", () => { void handleSignal("SIGTERM"); });
  processImpl.once("SIGINT", () => { void handleSignal("SIGINT"); });
}

module.exports = {registerRunnerSignals};
