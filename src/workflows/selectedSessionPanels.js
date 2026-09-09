export async function loadSelectedSessionPanelsConcurrently(loaders = {}) {
  const requests = Object.values(loaders)
    .filter((loader) => typeof loader === "function")
    .map((loader) => Promise.resolve().then(loader));

  return Promise.allSettled(requests);
}
