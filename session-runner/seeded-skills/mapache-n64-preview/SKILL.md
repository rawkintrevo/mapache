---
name: mapache-n64-preview
description: Use the Mapache pi-n64 browser emulator preview contract for ROM artifacts.
---

Use this skill after building a Nintendo 64 homebrew ROM in a Mapache pi-n64 session.

## Contract

- Preview URL: $MAPACHE_PREVIEW_URL
- Status endpoint: $MAPACHE_RUNNER_URL/preview/status
- Browser log endpoint: $MAPACHE_RUNNER_URL/preview/logs
- ROM endpoint: $MAPACHE_RUNNER_URL/preview/rom.z64
- Expected ROM file: /workspace/build/game.z64
- The Preview tab loads the ROM through the Mapache EmulatorJS shell when the ROM exists.

## Preview Steps

1. Confirm /workspace/build/game.z64 exists.
2. Check status: curl "$MAPACHE_RUNNER_URL/preview/status"
3. Open $MAPACHE_PREVIEW_URL to run the ROM in the browser emulator shell.
4. Check browser-side emulator shell logs: curl "$MAPACHE_RUNNER_URL/preview/logs"
5. Use $MAPACHE_RUNNER_URL/preview/rom.z64 as the stable ROM URL for downloads or external emulator checks.

## Optional Preview Config

Write /workspace/.mapache/preview.json to override the ROM path or emulator core:

```json
{
  "mode": "n64",
  "rom": "build/custom.z64",
  "core": "mupen64plus_next"
}
```

Accepted core values are "n64", "mupen64plus_next", and "parallel-n64". The older "parallel_n64" spelling is accepted and normalized to EmulatorJS's documented "parallel-n64" core id. Use "n64" first for broad browser compatibility; it lets EmulatorJS select the default N64 core.

## Notes

The browser preview is useful for fast iteration, but it does not claim hardware accuracy. Validate serious compatibility with a modern native N64 emulator or real hardware.
