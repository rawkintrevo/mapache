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

test("allows a fresh noVNC connection after the supervised VNC socket is replaced", () => {
  const sockets = [];
  const bridge = createVncBridge({
    net: {connect: () => {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; };
      sockets.push(socket);
      return socket;
    }},
  });
  const first = new EventEmitter();
  first.readyState = 1;
  first.close = () => {};
  bridge.attach(first);
  sockets[0].emit("error", new Error("x11vnc restarted"));

  const second = new EventEmitter();
  second.readyState = 1;
  second.close = () => {};
  bridge.attach(second);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].destroyed, true);
  assert.equal(sockets[1].destroyed, false);
});
