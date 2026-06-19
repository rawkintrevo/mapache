---
name: mapache-preview-build
description: Build static web output where the Mapache preview canvas can serve it.
---

Use this skill when building a static website or static frontend bundle in a Mapache preview-capable session.

## Contract

- The preview gateway serves static files from /workspace/build by default.
- The preview is ready when /workspace/build/index.html exists.
- Static apps must use relative asset URLs so bundled JavaScript, CSS, fonts, and images resolve under /preview/.
- The browser preview URL is available as $MAPACHE_PREVIEW_URL.
- The local runner control URL is available as $MAPACHE_RUNNER_URL.

## Build Steps

1. Configure the project to emit its final browser-loadable output into /workspace/build.
2. Configure the project to use relative asset bases, such as ./, rather than root-relative / asset paths.
3. Build or copy the final static site into /workspace/build.
4. Make sure the entry point is /workspace/build/index.html.
5. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"
6. Open or QA the site at $MAPACHE_PREVIEW_URL.

## Common Frameworks

For Vite, prefer:

```bash
npm run build -- --outDir build --base ./
```

or set both base and build.outDir in vite.config.js:

```js
export default defineConfig({
  base: "./",
  build: {outDir: "build"},
});
```

For other frameworks, use the equivalent settings for:

- output directory: /workspace/build
- public/base path: ./ or another relative asset base

## Rules

- Do not put source files only in build; put the generated browser-loadable output there.
- Do not assume dist, out, or public is visible in the preview.
- Do not leave built HTML pointing at root-relative asset URLs like /assets/app.js or /assets/app.css.
