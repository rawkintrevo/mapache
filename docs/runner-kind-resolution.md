# Runner Kind Resolution

## Overview

The Mapache runner behavior (Pi, Codex, Shell, or SSH) is determined by the `terminalKind` configuration. This value is assigned during session creation and informs the `session-runner` how to bootstrap the container.

## Resolution Logic

The `terminalKind` is resolved in `functions/index.js` during the `createSession` function.

### Workflow

1.  **Session Type Determination**:
    The system first determines if the session should be `ssh` or `cloud`.
    ```javascript
    const workspaceSshSource = workspace.source && workspace.source.type === "ssh" ? workspace.source : null;
    const sessionType = cleanName(payload.sessionType || payload.type || (workspaceSshSource ? "ssh" : "cloud")).toLowerCase();
    ```

2.  **Payload Normalization**:
    If `sessionType` is `"ssh"`, the system generates an `sshPayload` using `normalizeCreateSessionSshPayload`.

3.  **Terminal Kind Assignment**:
    The `terminalKind` is assigned based on the determined `sessionType` and the runner image:
    ```javascript
    terminalKind: sshPayload ? "ssh" : (runnerImage.terminalKind || "pi"),
    ```

## Runner Environments

The `session-runner` inside the Cloud Run container reads the `TERMINAL_KIND` environment variable (injected via `functions/cloudRun.service.js`) and branches its startup logic:

*   **`ssh`**: Enables SSH-specific endpoints, requires `SSH_TARGET_HOST`, `SSH_TARGET_USERNAME`, and `SSH_PRIVATE_KEY`.
*   **`pi` / `codex`**: Normal Cloud Run runner, materializes workspace skills, configures Pi/Codex home directories, and sets up preview services.

## Troubleshooting

If a non-SSH runner fails with `SSH sessions require...`, it indicates the session was incorrectly initialized as an `ssh` type. Check:
- Whether the workspace source is incorrectly typed as `ssh`.
- If `payload.sessionType` or `payload.type` is being sent incorrectly in the creation request.
