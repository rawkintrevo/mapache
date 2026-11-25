import {describe, expect, test, vi} from "vitest";
import {createRemoteHostsController} from "./remoteHostsController.js";
import {createInitialState} from "../state/initialState.js";

function makeState(uid = "owner-a") {
  const state = createInitialState();
  state.user = {uid};
  return state;
}

const host = {
  id: "host-1",
  hostId: "host-1",
  displayName: "Home",
  address: "home.example.com",
  port: 22,
  managedUsername: "mapache",
  appPublicKey: "ssh-ed25519 AAAA mapache-remote-host",
  setupDirections: ["sudo python3 install.py"],
  status: "pending_setup",
  ready: false,
};

describe("remote hosts controller", () => {
  test("registers an owner-scoped host and exposes setup state", async () => {
    const state = makeState();
    const api = {registerRemoteHost: vi.fn().mockResolvedValue({host})};
    const controller = createRemoteHostsController({state, api});

    const result = await controller.registerHost({displayName: "Home", address: "home.example.com", port: 22});

    expect(result).toEqual(host);
    expect(api.registerRemoteHost).toHaveBeenCalledWith({displayName: "Home", address: "home.example.com", port: 22});
    expect(state.remoteHosts.hosts).toEqual([host]);
    expect(state.remoteHosts.message).toContain("Follow the setup directions");
  });

  test("fences a stale load after the account is cleared", async () => {
    const state = makeState();
    let resolve;
    const api = {getRemoteHosts: vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }))};
    const controller = createRemoteHostsController({state, api});

    const request = controller.load();
    controller.clear();
    resolve({hosts: [host]});
    await request;

    expect(state.remoteHosts.hosts).toEqual([]);
    expect(state.remoteHosts.attempted).toBe(false);
  });

  test("holds a newly observed fingerprint for explicit confirmation", async () => {
    const state = makeState();
    state.remoteHosts.hosts = [host];
    const api = {
      testRemoteHost: vi.fn().mockResolvedValue({
        ready: false,
        requiresHostKeyConfirmation: true,
        observedHostKeyFingerprint: "SHA256/observed",
        host: {...host, status: "awaiting_host_key"},
      }),
    };
    const controller = createRemoteHostsController({state, api});

    await controller.testHost("host-1");

    expect(state.remoteHosts.pendingFingerprint).toEqual({hostId: "host-1", fingerprint: "SHA256/observed"});
    expect(state.remoteHosts.hosts[0].status).toBe("awaiting_host_key");
  });

  test("settles saving after fingerprint confirmation triggers a second test", async () => {
    const state = makeState();
    state.remoteHosts.hosts = [host];
    const api = {
      updateRemoteHost: vi.fn().mockResolvedValue({host: {...host, hostKeyFingerprint: "SHA256/observed", status: "awaiting_host_key"}}),
      testRemoteHost: vi.fn().mockResolvedValue({ready: true, host: {...host, status: "ready", ready: true}}),
    };
    const controller = createRemoteHostsController({state, api});

    await controller.confirmFingerprint("host-1", "SHA256/observed");

    expect(api.updateRemoteHost).toHaveBeenCalledWith("host-1", {hostKeyFingerprint: "SHA256/observed", confirmHostKey: true});
    expect(api.testRemoteHost).toHaveBeenCalledWith("host-1");
    expect(state.remoteHosts.saving).toBe(false);
    expect(state.remoteHosts.hosts[0].status).toBe("ready");
  });

  test("clears a host only after the server confirms removal", async () => {
    const state = makeState();
    state.remoteHosts.hosts = [host];
    const api = {removeRemoteHost: vi.fn().mockResolvedValue({removed: true})};
    const controller = createRemoteHostsController({state, api});

    expect(await controller.removeHost("host-1")).toBe(true);
    expect(api.removeRemoteHost).toHaveBeenCalledWith("host-1");
    expect(state.remoteHosts.hosts).toEqual([]);
  });
});
