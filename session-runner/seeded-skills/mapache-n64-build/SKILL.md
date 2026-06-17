---
name: mapache-n64-build
description: Build and package Nintendo 64 homebrew ROM artifacts for the pi-n64 preview.
---

Use this skill when creating or updating Nintendo 64 homebrew in a Mapache pi-n64 session.

## Contract

- The workspace uses the libdragon SDK and MIPS N64 toolchain installed in the runner.
- The preview looks for the primary ROM at /workspace/build/game.z64.
- Build commands should run from /workspace unless the project has its own documented subdirectory.
- The local runner control URL is available as $MAPACHE_RUNNER_URL.

## Build Steps

1. Inspect the project Makefile or build script before changing commands.
2. Build the ROM with the project's existing command, usually make.
3. Create /workspace/build if it does not exist.
4. Copy or emit the playable ROM to /workspace/build/game.z64.
5. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"

## New Project Defaults

For a new libdragon project, prefer a small Makefile that includes the installed libdragon n64.mk file and produces a root .z64 ROM, then copy that ROM to /workspace/build/game.z64. Keep source files outside /workspace/build and treat build as generated output. Do not make the primary libdragon ROM target itself live under build/, because libdragon's n64.mk uses BUILD_DIR internally and that can produce paths like build/build/game.elf.

Minimal Makefile shape:

```make
all: game.z64
.PHONY: all

BUILD_DIR = build
include $(N64_INST)/include/n64.mk

OBJS = $(BUILD_DIR)/main.o

game.z64: N64_ROM_TITLE = "Mapache N64"
$(BUILD_DIR)/game.elf: $(OBJS)

preview: game.z64
	mkdir -p /workspace/build
	cp game.z64 /workspace/build/game.z64
.PHONY: preview

clean:
	rm -rf $(BUILD_DIR) *.z64
.PHONY: clean

-include $(wildcard $(BUILD_DIR)/*.d)
```

## Rules

- Build only homebrew ROMs owned by the workspace.
- Do not use proprietary Nintendo SDK files, leaked headers, commercial ROMs, or assets without permission.
- Keep the final ROM path stable so the Preview tab and QA scripts can find it.
