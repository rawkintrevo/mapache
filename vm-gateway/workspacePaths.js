"use strict";

// Public namespaces keep each workspace's browser cookie out of other tabs.
// Only the gateway strips this prefix; the resolver sees and authorizes it.
function workspacePath(pathname) {
  if (!pathname.startsWith("/workspaces/")) return {prefix: "", privatePath: pathname};
  const match = pathname.match(/^\/workspaces\/([A-Za-z0-9_-]{1,128})(\/agent(?:\/.*)?|\/runner\/health)$/);
  if (!match) throw new Error("not_found");
  return {prefix: `/workspaces/${match[1]}`, privatePath: match[2]};
}

function entryHtml(input) {
  return Boolean(input.prefix) && ["/agent/", "/agent/index.html"].includes(input.privatePath);
}

function rewriteEntryHtml(html, prefix) {
  // Rewrite the built entry document, never API bodies or previews.
  // Relative imports and upstream appUrl/appWsUrl then use document.baseURI.
  return html.replace(/\b(src|href)=(['"])\/agent\//g, `$1=$2${prefix}/agent/`)
      .replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<base href="${prefix}/agent/">`);
}

function assetModule(input) {
  return Boolean(input.prefix) && /^\/agent\/assets\/[A-Za-z0-9_.-]+\.js$/.test(input.privatePath);
}

function assetStyle(input) {
  return Boolean(input.prefix) && /^\/agent\/assets\/[A-Za-z0-9_.-]+\.css$/.test(input.privatePath);
}

function rewriteAssetStyle(source, prefix) {
  return source.replace(/url\(\s*(["']?)\/agent\//g, `url($1${prefix}/agent/`);
}

function rewriteAssetModule(source, prefix) {
  // Vite's production preload helper embeds its build-time absolute base even
  // though appUrl/appWsUrl use document.baseURI. Scope only that return-prefix
  // expression; do not replace arbitrary /agent/ text (e.g. ~/.pi/agent paths).
  return source.replace(/\breturn\s*(["'`])\/agent\/\1\s*\+\s*([A-Za-z_$][\w$]*)/g,
      (_match, quote, value) => `return ${quote}${prefix}/agent/${quote}+${value}`);
}

function publicLocation(location, prefix) {
  return prefix && typeof location === "string" && /^\/agent(?:[/?#]|$)/.test(location) ?
    `${prefix}${location}` : location;
}

module.exports = {workspacePath, entryHtml, rewriteEntryHtml, assetModule, rewriteAssetModule,
  assetStyle, rewriteAssetStyle, publicLocation};
