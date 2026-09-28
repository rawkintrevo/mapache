"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {canRetrySinkDelivery, recordSinkDeliveryAttempt} = require("./workspaceRunDelivery.helpers");

test("sink delivery retries update delivery state without changing agent outcome", () => {
  const run = {status: "succeeded", sinkDelivery: {ticket: {state: "pending", attempts: 0, lastError: null}}};
  const failed = recordSinkDeliveryAttempt(run, "ticket", {state: "failed", error: "temporary"});
  assert.equal(failed.status, "succeeded");
  assert.equal(failed.sinkDelivery.ticket.state, "failed");
  assert.equal(failed.sinkDelivery.ticket.attempts, 1);
  assert.equal(canRetrySinkDelivery(failed, "ticket"), true);
  const delivered = recordSinkDeliveryAttempt(failed, "ticket", {state: "delivered", deliveredAt: "now"});
  assert.equal(delivered.sinkDelivery.ticket.state, "delivered");
  assert.equal(delivered.sinkDelivery.ticket.attempts, 2);
  assert.equal(canRetrySinkDelivery(delivered, "ticket"), false);
});

test("unknown agent outcomes are never sink-retried as if execution succeeded", () => {
  assert.equal(canRetrySinkDelivery({status: "unknown", sinkDelivery: {ticket: {state: "failed"}}}, "ticket"), false);
});
