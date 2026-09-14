export function friendlyRepoPickerError(error) {
  const message = error.message || "Could not load connected repositories.";
  if (message === "github_app_not_configured") return "github_app_not_configured";
  if (message === "github_oauth_not_configured") return "GitHub OAuth is not configured.";
  if (message === "github_connect_url_unavailable") return "Could not start GitHub connection.";
  return message;
}

export function friendlyGlobalError(error) {
  const message = error.message || "Request failed";
  if (message === "app_access_not_allowed") {
    return "This account is not on the Mapache Tools allow list.";
  }
  return message;
}

export function friendlyWorkspaceError(error) {
  const message = error.message || "Could not create workspace.";
  if (message === "missing_github_repo_url") return "Enter a GitHub repository URL.";
  if (message === "invalid_github_repo_url") return "Enter a valid GitHub repository URL, for example https://github.com/owner/repo.";
  if (message === "github_repo_url_must_use_https") return "Use an https:// GitHub repository URL.";
  if (message === "github_repo_url_must_not_include_credentials") return "Remove credentials from the GitHub repository URL.";
  if (message === "unsupported_github_repo_host") return "Only github.com repository URLs are supported.";
  if (message === "github_connected_repo_forbidden") return "That repository is not available through your GitHub connection.";
  if (message === "github_installation_forbidden") return "Reconnect GitHub before creating a workspace from that repository.";
  if (message === "github_app_not_configured") return "GitHub workspace creation is not configured on the server.";
  if (message === "invalid_workspace_source_commit") return "Use a valid 7-40 character Git commit SHA.";
  return message;
}

export function friendlyMcpConfigError(error) {
  const message = error.message || "Could not update MCP servers.";
  if (message === "invalid_mcp_server_name") return "Use a lowercase MCP server name with letters, numbers, underscores, or hyphens.";
  if (message === "missing_mcp_server_transport") return "Enter either a command or a URL for the MCP server.";
  if (message === "multiple_mcp_server_transports") return "Choose command or URL, not both.";
  if (message === "invalid_mcp_args") return "MCP server args must be a list of strings.";
  if (message === "invalid_mcp_env") return "MCP environment variables must use valid names.";
  if (message === "invalid_mcp_headers") return "MCP headers must use valid names.";
  if (message === "too_many_mcp_servers") return "Remove an MCP server before adding another one.";
  return message;
}

export function friendlyPiAuthError(error) {
  const message = error.message || "Could not update authentication.";
  if (message === "invalid_pi_auth_provider") return "Choose a supported API key provider.";
  if (message === "invalid_pi_auth_key") return "Enter a valid API key value.";
  if (message === "invalid_pi_auth_entry") return "Choose a saved authentication entry.";
  if (message === "auth_selection_unsupported") return "Choose a Pi session before managing session auth.";
  return message;
}
