export const REQUEST_GRANT_PERMISSIONS = Object.freeze([
  {id: "discover", label: "Discover target"},
  {id: "submit", label: "Submit requests"},
  {id: "read", label: "Read results"},
  {id: "reply", label: "Reply or clarify"},
  {id: "cancel", label: "Cancel requests"},
]);

export function createRequestGrantsState(overrides = {}) {
  return {
    loading: false,
    saving: false,
    error: "",
    message: "",
    grants: [],
    targetWorkspaceId: "",
    permissions: [],
    ...overrides,
  };
}
