"use strict";

function generationMatchOptions(generation) {
  return {preconditionOpts: {ifGenerationMatch: generation ? String(generation) : 0}};
}

function isStorageGenerationConflict(error) {
  return Boolean(error && (error.code === 412 || error.code === "412"));
}

module.exports = {generationMatchOptions, isStorageGenerationConflict};
