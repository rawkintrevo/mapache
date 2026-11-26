"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REMOTE_VM_ADMISSION_ENABLED_ENV,
  isRemoteVmAdmissionEnabled,
} = require("./remoteVmAdmission.helpers");

test("remote VM admission is disabled unless the exact flag is enabled", () => {
  assert.equal(isRemoteVmAdmissionEnabled({}), false);
  assert.equal(isRemoteVmAdmissionEnabled({[REMOTE_VM_ADMISSION_ENABLED_ENV]: "false"}), false);
  assert.equal(isRemoteVmAdmissionEnabled({[REMOTE_VM_ADMISSION_ENABLED_ENV]: "TRUE"}), true);
  assert.equal(isRemoteVmAdmissionEnabled({[REMOTE_VM_ADMISSION_ENABLED_ENV]: " true "}), true);
  assert.equal(isRemoteVmAdmissionEnabled({[REMOTE_VM_ADMISSION_ENABLED_ENV]: "1"}), false);
});
