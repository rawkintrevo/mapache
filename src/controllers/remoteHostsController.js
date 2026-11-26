import {createRemoteHostsState} from "../state/initialState.js";
import {friendlyRemoteHostError} from "../utils/friendlyErrors.js";

export function createRemoteHostsController({state, render = () => {}, api} = {}) {
  if (!state) throw new Error("Remote hosts controller requires app state.");

  let epoch = 0;
  let userId = state.user?.uid || "";
  let requestSequence = 0;

  return {
    clear,
    getState: () => state.remoteHosts,
    load,
    registerHost,
    removeHost,
    confirmFingerprint,
    testHost,
    setIdentity,
  };

  function getApi() {
    const client = api || state.api;
    if (!client) throw new Error("Authentication is required for remote host requests.");
    return client;
  }

  function setIdentity(uid = "") {
    const nextUserId = String(uid || "");
    if (nextUserId === userId) return;
    userId = nextUserId;
    clear();
  }

  async function load() {
    const context = currentContext();
    state.remoteHosts = {...state.remoteHosts, loading: true, error: "", message: ""};
    render();
    try {
      const data = await getApi().getRemoteHosts();
      if (!isCurrent(context)) return null;
      state.remoteHosts = {
        ...state.remoteHosts,
        loading: false,
        attempted: true,
        remoteVmAdmissionEnabled: data?.remoteVmAdmissionEnabled === true,
        hosts: Array.isArray(data?.hosts) ? data.hosts : [],
        error: "",
      };
      return state.remoteHosts;
    } catch (error) {
      if (isCurrent(context)) {
        state.remoteHosts = {
          ...state.remoteHosts,
          loading: false,
          attempted: true,
          remoteVmAdmissionEnabled: false,
          error: friendlyRemoteHostError(error),
        };
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function registerHost(payload = {}) {
    const context = currentContext();
    state.remoteHosts = {...state.remoteHosts, saving: true, error: "", message: ""};
    render();
    try {
      const data = await getApi().registerRemoteHost(payload);
      if (!isCurrent(context)) return null;
      const host = data?.host || data;
      state.remoteHosts = {
        ...state.remoteHosts,
        saving: false,
        attempted: true,
        hosts: host ? [host] : state.remoteHosts.hosts,
        message: "Host registered. Follow the setup directions, then test the connection.",
        error: "",
        pendingFingerprint: null,
      };
      return host;
    } catch (error) {
      if (isCurrent(context)) {
        state.remoteHosts = {...state.remoteHosts, saving: false, error: friendlyRemoteHostError(error)};
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function testHost(hostId) {
    const id = String(hostId || "");
    if (!id) return null;
    const context = {...currentContext(), hostId: id};
    state.remoteHosts = {...state.remoteHosts, testing: true, error: "", message: ""};
    render();
    try {
      const data = await getApi().testRemoteHost(id);
      if (!isCurrent(context)) return null;
      const host = data?.host;
      if (host) replaceHost(host);
      state.remoteHosts = {
        ...state.remoteHosts,
        testing: false,
        pendingFingerprint: data?.requiresHostKeyConfirmation && data.observedHostKeyFingerprint ? {
          hostId: id,
          fingerprint: data.observedHostKeyFingerprint,
        } : null,
        message: data?.ready ? "Connection verified. The host is ready for remote VM workspaces." : "Connection reached the host. Verify its fingerprint to continue.",
        error: "",
      };
      return data;
    } catch (error) {
      if (isCurrent(context)) {
        state.remoteHosts = {...state.remoteHosts, testing: false, error: friendlyRemoteHostError(error)};
        await refreshAfterMutation(context);
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function confirmFingerprint(hostId, fingerprint) {
    const id = String(hostId || "");
    if (!id || !fingerprint) return null;
    const context = {...currentContext(), hostId: id};
    state.remoteHosts = {...state.remoteHosts, saving: true, error: "", message: ""};
    render();
    try {
      const data = await getApi().updateRemoteHost(id, {
        hostKeyFingerprint: fingerprint,
        confirmHostKey: true,
      });
      if (!isCurrent(context)) return null;
      const host = data?.host || data;
      if (host) replaceHost(host);
      state.remoteHosts = {...state.remoteHosts, saving: false, pendingFingerprint: null, message: "Fingerprint saved. Testing the host again...", error: ""};
      await testHost(id);
      if (isOwnerCurrent(context)) {
        state.remoteHosts = {...state.remoteHosts, saving: false};
        render();
      }
      return host;
    } catch (error) {
      if (isOwnerCurrent(context)) {
        state.remoteHosts = {...state.remoteHosts, saving: false, error: friendlyRemoteHostError(error)};
        render();
      }
      return null;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function removeHost(hostId) {
    const id = String(hostId || "");
    if (!id) return false;
    const context = {...currentContext(), hostId: id};
    state.remoteHosts = {...state.remoteHosts, removing: true, error: "", message: ""};
    render();
    try {
      await getApi().removeRemoteHost(id);
      if (!isCurrent(context)) return false;
      state.remoteHosts = {...state.remoteHosts, removing: false, hosts: state.remoteHosts.hosts.filter((host) => host.id !== id && host.hostId !== id), pendingFingerprint: null, message: "Remote host removed. Its generated access key is no longer stored.", error: ""};
      return true;
    } catch (error) {
      if (isCurrent(context)) state.remoteHosts = {...state.remoteHosts, removing: false, error: friendlyRemoteHostError(error)};
      return false;
    } finally {
      if (isCurrent(context)) render();
    }
  }

  async function refreshAfterMutation(context) {
    try {
      const data = await getApi().getRemoteHosts();
      if (!isCurrent(context)) return;
      state.remoteHosts.remoteVmAdmissionEnabled = data?.remoteVmAdmissionEnabled === true;
      state.remoteHosts.hosts = Array.isArray(data?.hosts) ? data.hosts : [];
    } catch {
      // Keep the original connection error visible when the status refresh fails.
      if (isCurrent(context)) state.remoteHosts.remoteVmAdmissionEnabled = false;
    }
  }

  function replaceHost(host) {
    const id = host.id || host.hostId;
    state.remoteHosts.hosts = state.remoteHosts.hosts.map((current) => (current.id === id || current.hostId === id ? host : current));
  }

  function currentContext() {
    return {epoch, userId, requestUserId: state.user?.uid || "", requestId: ++requestSequence};
  }

  function isCurrent(context) {
    return isOwnerCurrent(context) && context.requestId === requestSequence;
  }

  function isOwnerCurrent(context) {
    return context.epoch === epoch && context.userId === userId && context.requestUserId === (state.user?.uid || "");
  }

  function clear() {
    epoch += 1;
    requestSequence += 1;
    state.remoteHosts = createRemoteHostsState();
    render();
  }
}
