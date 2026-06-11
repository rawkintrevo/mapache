export function friendlyRepoPickerError(error) {
  const message = error.message || "Could not load connected repositories.";
  if (message === "github_app_not_configured") return "github_app_not_configured";
  if (message === "github_oauth_not_configured") return "GitHub OAuth is not configured.";
  if (message === "github_connect_url_unavailable") return "Could not start GitHub connection.";
  return message;
}

export function friendlyPiPackageError(error) {
  const message = error.message || "Could not load extensions.";
  if (message === "no_active_session" || message === "session_not_running") return "Start an active pi-basic session to inspect workspace extensions.";
  if (message === "runner_package_listing_unsupported") return "This session runner does not support extension listing yet. Restart or recreate the session after deployment.";
  if (message === "runner_package_list_unavailable") return "The session runner is unavailable. Try refreshing after the terminal is ready.";
  if (message === "pi_package_read_failed" || message === "pi_package_list_failed") return "The runner could not read workspace Pi package settings.";
  return message;
}

export function friendlyPiInstallError(error) {
  const message = error.message || "Could not install extension.";
  if (message === "invalid_package_source" || message === "unsupported_package_source") return "Enter a supported npm: or git package source.";
  if (message === "package_operation_busy") return "Another package operation is already running. Try again in a moment.";
  if (message === "runner_package_install_unsupported") return "This session runner does not support extension installs yet. Restart or recreate the session after deployment.";
  if (message === "runner_package_install_unavailable") return "The session runner is unavailable. Try again after the terminal is ready.";
  if (message === "pi_package_install_failed") return "Pi could not install that package source.";
  return message;
}

export function friendlyPiRemoveError(error) {
  const message = error.message || "Could not remove extension.";
  if (message === "invalid_package_source" || message === "unsupported_package_source") return "That package source is not valid for removal.";
  if (message === "package_operation_busy") return "Another package operation is already running. Try again in a moment.";
  if (message === "runner_package_remove_unsupported") return "This session runner does not support extension removal yet. Restart or recreate the session after deployment.";
  if (message === "runner_package_remove_unavailable") return "The session runner is unavailable. Try again after the terminal is ready.";
  if (message === "pi_package_remove_failed") return "Pi could not remove that package source.";
  return message;
}

export function friendlyPiUpdateError(error) {
  const message = error.message || "Could not update extension.";
  if (message === "invalid_package_source" || message === "unsupported_package_source") return "That package source is not valid for update.";
  if (message === "package_operation_busy") return "Another package operation is already running. Try again in a moment.";
  if (message === "runner_package_update_unsupported") return "This session runner does not support extension updates yet. Restart or recreate the session after deployment.";
  if (message === "runner_package_update_unavailable") return "The session runner is unavailable. Try again after the terminal is ready.";
  if (message === "pi_package_update_failed") return "Pi could not update the selected package source.";
  return message;
}

export function friendlyPiAuthError(error) {
  const message = error.message || "Could not update Pi authentication.";
  if (message === "invalid_pi_auth_provider") return "Choose a supported API key provider.";
  if (message === "invalid_pi_auth_key") return "Enter a valid API key value.";
  return message;
}

export function friendlyFilesError(error) {
  const message = error.message || "Could not load files.";
  if (message === "not_found") return "Files API is not deployed yet.";
  return message;
}

export function friendlyGitStatusError(error) {
  const message = error.message || "Could not load Git status.";
  if (message === "runner_git_status_unavailable") return "Git status is temporarily unavailable.";
  if (message === "runner_git_push_unavailable") return "Git push is temporarily unavailable.";
  if (message === "runner_git_open_pr_unavailable") return "Pull request creation is temporarily unavailable.";
  if (message === "github_auth_not_configured") return "GitHub auth is not configured for push.";
  if (message === "github_pr_requires_connected_repo") return "Pull requests are only supported for connected GitHub repositories.";
  if (message === "missing_pr_branch_description") return "Add a short branch description before opening a PR from the default branch.";
  if (message === "git_pr_branch_name_conflict") return "That mapache/<description> branch name already exists. Choose a different description.";
  if (message === "session_not_running") return "Git status is available once the session is running.";
  return message;
}
