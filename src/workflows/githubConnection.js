import {friendlyRepoPickerError} from "../utils/friendlyErrors.js";

export async function loadConnectedReposState({state, render}) {
  if (state.repoPicker.loading || state.repoPicker.attempted) return;
  state.repoPicker = {...state.repoPicker, loading: true, attempted: true};
  render();

  try {
    const data = await state.api.getConnectedRepos();
    state.repoPicker = {loading: false, error: "", repos: data.repos || [], attempted: true};
  } catch (error) {
    state.repoPicker = {loading: false, error: friendlyRepoPickerError(error), repos: [], attempted: true};
  }
  render();
}

export async function connectGithubState({state, render, location = window.location}) {
  if (!state.api) return;
  state.repoPicker = {...state.repoPicker, loading: true, error: ""};
  render();

  try {
    const data = await state.api.getGithubConnectUrl();
    if (!data.url) throw new Error("github_connect_url_unavailable");
    location.href = data.url;
  } catch (error) {
    state.repoPicker = {
      loading: false,
      error: friendlyRepoPickerError(error),
      repos: [],
      attempted: true,
    };
    render();
  }
}
