import {fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {RemoteHostsPage} from "./RemoteHostsPage.jsx";

const baseState = {remoteHosts: {attempted: true, loading: false, saving: false, testing: false, removing: false, error: "", message: "", hosts: [], pendingFingerprint: null}};

function renderPage(overrides = {}) {
  const props = {
    state: {...baseState, ...overrides.state},
    onConfirmFingerprint: vi.fn(),
    onLoad: vi.fn(),
    onRegisterHost: vi.fn().mockResolvedValue({id: "host-1"}),
    onRemoveHost: vi.fn(),
    onTestHost: vi.fn(),
  };
  return {props, ...render(<RemoteHostsPage {...props} />)};
}

describe("RemoteHostsPage", () => {
  test("registers a host without asking for a private key", () => {
    const {props} = renderPage();
    fireEvent.change(screen.getByLabelText("Display name"), {target: {value: "Home machine"}});
    fireEvent.change(screen.getByLabelText("Public hostname or IP"), {target: {value: "home.example.com"}});
    fireEvent.click(screen.getByRole("button", {name: "Register remote host"}));

    expect(props.onRegisterHost).toHaveBeenCalledWith({
      displayName: "Home machine",
      address: "home.example.com",
      port: 22,
      managedUsername: "mapache",
    });
    expect(screen.queryByLabelText(/private key/i)).not.toBeInTheDocument();
  });

  test("shows setup directions and an explicit fingerprint confirmation", () => {
    const host = {
      id: "host-1",
      displayName: "Home machine",
      address: "home.example.com",
      port: 22,
      managedUsername: "mapache",
      appPublicKey: "ssh-ed25519 AAAA mapache-remote-host",
      setupDirections: ["Run sudo python3 install.py"],
      status: "awaiting_host_key",
      ready: false,
    };
    const {props} = renderPage({state: {remoteHosts: {...baseState.remoteHosts, hosts: [host], pendingFingerprint: {hostId: "host-1", fingerprint: "SHA256/observed"}}}});

    expect(screen.getByText(host.appPublicKey)).toBeInTheDocument();
    expect(screen.getByText("SHA256/observed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Trust fingerprint and test"}));
    expect(props.onConfirmFingerprint).toHaveBeenCalledWith("host-1", "SHA256/observed");
  });

  test("uses the requested host id for testing and removal", () => {
    const host = {id: "host-1", displayName: "Home", address: "home.example.com", port: 22, managedUsername: "mapache", setupDirections: [], status: "ready", ready: true};
    const {props} = renderPage({state: {remoteHosts: {...baseState.remoteHosts, hosts: [host]}}});
    fireEvent.click(screen.getByRole("button", {name: "Test again"}));
    fireEvent.click(screen.getByRole("button", {name: "Remove host"}));
    expect(props.onTestHost).toHaveBeenCalledWith("host-1");
    expect(props.onRemoveHost).toHaveBeenCalledWith("host-1");
  });
});
