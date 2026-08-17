"use strict";

const STORAGE_HELPERS = `
function readLocalSetting(name) {
    try {
        return window.localStorage.getItem(name);
    } catch (error) {
        return null;
    }
}

function writeLocalSetting(name, value) {
    try {
        window.localStorage.setItem(name, value);
    } catch (error) {
        // Cross-site browser frames can deny persistent storage. The in-memory
        // settings cache remains authoritative for the current page.
    }
}

function removeLocalSetting(name) {
    try {
        window.localStorage.removeItem(name);
    } catch (error) {
        // See writeLocalSetting().
    }
}
`;

function patchNoVncWebUtil(source) {
  let patched = String(source || "");
  const marker = "/*\n * Setting handling.\n */";
  if (!patched.includes(marker)) throw new Error("noVNC settings marker not found");
  patched = replaceOnce(patched, "localStorage.setItem(name, value);", "writeLocalSetting(name, value);");
  patched = replaceOnce(patched, "value = localStorage.getItem(name);", "value = readLocalSetting(name);");
  patched = replaceOnce(patched, "localStorage.removeItem(name);", "removeLocalSetting(name);");
  patched = patched.replace(marker, `${STORAGE_HELPERS}\n${marker}`);
  return patched;
}

function replaceOnce(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`unexpected noVNC storage expression: ${expected}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

module.exports = {patchNoVncWebUtil};
