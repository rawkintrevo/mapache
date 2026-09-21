/**
 * Owner-wide active instance API facade.
 *
 * The inventory endpoint is separate from workspace-scoped session state so
 * the user menu can inspect every active runtime without changing selection.
 */
export function createInstancesApi(apiOrOptions) {
  const api = apiOrOptions?.api || apiOrOptions;
  if (!api) throw new Error("Instances API requires an API client.");

  return {
    list: (query = {}) => api.getActiveInstances(query),
  };
}
