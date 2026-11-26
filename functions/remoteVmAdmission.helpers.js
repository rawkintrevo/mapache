"use strict";

const REMOTE_VM_ADMISSION_ENABLED_ENV = "REMOTE_VM_ADMISSION_ENABLED";

function isRemoteVmAdmissionEnabled(env = process.env) {
  return String(env?.[REMOTE_VM_ADMISSION_ENABLED_ENV] || "").trim().toLowerCase() === "true";
}

module.exports = {
  REMOTE_VM_ADMISSION_ENABLED_ENV,
  isRemoteVmAdmissionEnabled,
};
