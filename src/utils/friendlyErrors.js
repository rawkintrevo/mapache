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
  if (message === "browser_egress_gateway_unavailable") {
    return "No enabled SSH gateway is available for this workspace.";
  }
  if (message === "browser_egress_gateway_selection_required") {
    return "Choose one SSH gateway for this workspace from SSH Gateways first.";
  }
  if (message === "browser_egress_ambiguous_route") {
    return "This workspace has multiple SSH gateways assigned. Remove the extra assignment from SSH Gateways first.";
  }
  return message;
}

export function friendlyRemoteHostError(error) {
  const message = error?.message || "Remote host request failed.";
  const messages = {
    remote_host_limit_reached: "Only one remote host can be configured in v1. Remove the existing host before adding another.",
    remote_host_display_name_required: "Enter a name for this remote host.",
    remote_host_address_invalid: "Enter a valid public hostname or IP address.",
    remote_host_address_disallowed: "Use a public host address; loopback, private-network, and metadata addresses are not allowed.",
    remote_host_port_invalid: "Enter an SSH port between 1 and 65535.",
    remote_host_username_invalid: "Use the managed Linux account name created by the setup script.",
    remote_host_host_key_required: "Verify the host fingerprint before testing the connection.",
    remote_host_key_confirmation_required: "Confirm the SSH host fingerprint before saving it.",
    remote_host_key_mismatch: "The host fingerprint changed. Verify the new fingerprint out of band, then remove and register this host again if the rotation was expected.",
    remote_host_key_revoked: "The host access key was revoked. Register the host again to create a new key.",
    remote_host_dns_failed: "The host name could not be resolved. Check DNS and try again.",
    remote_host_unreachable: "SSH could not reach this host. Check port 22, the address, and the setup account/key.",
    remote_host_connection_unavailable: "Remote host testing is temporarily unavailable. Try again shortly.",
    remote_host_referenced: "This host is still referenced by a workspace or pending operation. Remove those references before deleting it.",
    remote_host_not_found: "That remote host is no longer available. Refresh the host list.",
  };
  return messages[message] || message;
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
  if (message === "remote_host_required") return "Choose a configured remote host before creating this workspace.";
  if (message === "remote_host_not_ready") return "The remote host is not ready. Finish setup and verify its SSH connection before creating a VM.";
  if (message === "remote_host_not_found") return "That remote host is no longer available. Refresh host setup and try again.";
  if (message === "remote_host_service_unavailable") return "Remote VM host setup is temporarily unavailable. Try again shortly.";
  if (message === "remote_vm_admission_disabled") return "Remote VM workspace creation is not enabled yet.";
  if (message === "remote_vm_capacity_exhausted") return "The host has insufficient capacity for these resources.";
  if (message === "remote_vm_helper_update_required") return "Update the remote host helper before starting a guest with custom resources.";
  if (message === "remote_vm_configuration_unsupported") return "This remote VM setting is not available in v1. Use the guest's pi-web-ui settings for supported connections.";
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
  if (message === "invalid_custom_provider_endpoint") return "Enter an HTTP(S) server base URL without credentials, a query, or a fragment.";
  if (message === "invalid_pi_auth_provider") return "Choose a supported API key provider.";
  if (message === "invalid_pi_auth_key") return "Enter a valid API key value.";
  if (message === "invalid_pi_auth_entry") return "Choose a saved authentication entry.";
  if (message === "auth_selection_unsupported") return "Choose a Pi session before managing session auth.";
  return message;
}
