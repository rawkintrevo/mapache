import {describe, expect, test} from "vitest";
import {buildPiChatSocketUrl, derivePiChatSocketUrl, piChatSocketUrl} from "./piChat.js";

describe("Pi Chat socket URL", () => {
  test("converts HTTPS terminal URLs to WSS and preserves only access", () => {
    const terminalUrl = "https://runner.example/terminal?replay=1&mapache_access=signed.token&view=terminal#ignored";
    expect(derivePiChatSocketUrl(terminalUrl, {chat: true})).toBe(
        "wss://runner.example/chat?mapache_access=signed.token",
    );
  });

  test("converts local HTTP URLs to WS", () => {
    expect(buildPiChatSocketUrl({
      terminalUrl: "http://127.0.0.1:8080/?mapache_access=local-token",
      capabilities: {chat: true},
    })).toBe("ws://127.0.0.1:8080/chat?mapache_access=local-token");
  });

  test("returns null for missing capability or invalid URLs", () => {
    expect(derivePiChatSocketUrl("https://runner.example/?mapache_access=token", {chat: false})).toBeNull();
    expect(piChatSocketUrl("not a URL", {chat: true})).toBeNull();
    expect(derivePiChatSocketUrl("ftp://runner.example/", {chat: true})).toBeNull();
  });
});
