import {friendlyRepoPickerError} from "../utils/friendlyErrors.js";

export async function loadGithubConnectionState({state, render, silent = false}) {
  if (!state.api || state.githubConnection.loading) return;
  state.githubConnection = {
    ...state.githubConnection,
    loading: true,
    error: silent ? state.githubConnection.error : "",
    attempted: true,
  };
  render();

  try {
    const data = await state.api.getGithubConnection();
    state.githubConnection = {
      ...state.githubConnection,
      loading: false,
      error: "",
      data,
      attempted: true,
    };
  } catch (error) {
    state.githubConnection = {
      ...state.githubConnection,
      loading: false,
      error: friendlyRepoPickerError(error),
      attempted: true,
    };
  }
  render();
}

export async function loadConnectedReposState({state, render, force = false}) {
  if (state.repoPicker.loading || state.repoPicker.attempted && !force) return;
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

export async function refreshGithubRepositoriesState({state, render, loadGithubConnection}) {
  if (!state.api || state.githubConnection.refreshing) return;
  state.githubConnection = {
    ...state.githubConnection,
    refreshing: true,
    error: "",
    message: "",
  };
  render();

  await loadConnectedReposState({state, render, force: true});
  if (loadGithubConnection) {
    await loadGithubConnection({silent: true});
  }
  state.githubConnection = {
    ...state.githubConnection,
    refreshing: false,
    message: state.repoPicker.error ? "" : "Repository access refreshed.",
  };
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

export async function disconnectGithubState({state, render, loadGithubConnection}) {
  if (!state.api || state.githubConnection.disconnecting) return;
  state.githubConnection = {
    ...state.githubConnection,
    disconnecting: true,
    error: "",
    message: "",
  };
  render();

  try {
    const data = await state.api.disconnectGithub();
    state.githubConnection = {
      ...state.githubConnection,
      disconnecting: false,
      error: "",
      message: "GitHub disconnected.",
      data,
      attempted: true,
    };
    state.repoPicker = {loading: false, error: "", repos: [], attempted: false};
  } catch (error) {
    state.githubConnection = {
      ...state.githubConnection,
      disconnecting: false,
      error: friendlyRepoPickerError(error),
    };
  }
  if (loadGithubConnection) {
    await loadGithubConnection({silent: true});
  }
  render();
}
