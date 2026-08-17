"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {EventEmitter} = require("node:events");
const {createVncBridge} = require("./vncBridge");

test("bridges binary WebSocket traffic to the loopback VNC socket", () => {
  const tcp = new EventEmitter();
  tcp.destroyed = false;
  tcp.writes = [];
  tcp.write = (chunk) => tcp.writes.push(chunk);
  tcp.destroy = () => { tcp.destroyed = true; };
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (chunk) => ws.sent.push(chunk);
  ws.close = () => ws.emit("closed");
  const bridge = createVncBridge({
    host: "127.0.0.1",
    port: 5900,
    net: {connect: ({host, port}) => {
      assert.equal(host, "127.0.0.1");
      assert.equal(port, 5900);
      return tcp;
    }},
  });

  const connection = bridge.attach(ws);
  const outbound = Buffer.from([1, 2, 3]);
  ws.emit("message", outbound);
  assert.deepEqual(tcp.writes, [outbound]);
  tcp.emit("data", Buffer.from([4, 5]));
  assert.deepEqual(ws.sent, [Buffer.from([4, 5])]);
  connection.close();
  assert.equal(tcp.destroyed, true);
});

test("closes both bridge sides when the VNC socket fails", () => {
  const tcp = new EventEmitter();
  tcp.destroyed = false;
  tcp.destroy = () => { tcp.destroyed = true; };
  const ws = new EventEmitter();
  ws.readyState = 1;
  let closed = 0;
  ws.close = () => { closed += 1; };
  createVncBridge({net: {connect: () => tcp}}).attach(ws);
  tcp.emit("error", new Error("closed"));
  assert.equal(tcp.destroyed, true);
  assert.equal(closed, 1);
});
