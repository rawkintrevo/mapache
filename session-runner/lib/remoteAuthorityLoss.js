"use strict";

// The guest supervisor restarts failed runners. Never restart pi-web-ui in the
// old process: startup must acquire fresh broker authority before serving it.
function createRemoteAuthorityLossHandler({stop, exit = (code) => process.exit(code),
  logger = console, timeoutMs = 5000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout}) {
  let shutdown;
  return () => {
    if (shutdown) return shutdown;
    shutdown = new Promise((resolve) => {
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        exit(1);
        resolve();
      };
      const timer = setTimeoutFn(finish, timeoutMs);
      Promise.resolve().then(stop)
          .catch(() => logger.error("remote agent stop failed after authority loss"))
          .finally(() => { clearTimeoutFn(timer); finish(); });
    });
    return shutdown;
  };
}

module.exports = {createRemoteAuthorityLossHandler};
