"use strict";

// Minimal Marionette client for test setup and native-path inspection.
// Used only by the native harness against an isolated, synthetic profile.

const net = require("node:net");

class Marionette {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.greeting = null;
  }

  connect({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect(this.port, "127.0.0.1");
        socket.once("error", (e) => {
          socket.destroy();
          if (Date.now() > deadline) reject(e);
          else setTimeout(attempt, 300);
        });
        socket.once("connect", () => {
          this.socket = socket;
          socket.on("data", (d) => this._onData(d));
          socket.on("error", (e) => {
            for (const p of this.pending.values()) p.reject(e);
            this.pending.clear();
          });
          this.greeting = new Promise((r) => { this._greet = r; });
          this.greeting.then(() => resolve()).catch(reject);
        });
      };
      attempt();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.buffer.slice(0, colon).toString());
      if (this.buffer.length < colon + 1 + len) return;
      const body = this.buffer.slice(colon + 1, colon + 1 + len).toString("utf8");
      this.buffer = this.buffer.slice(colon + 1 + len);
      const msg = JSON.parse(body);
      if (!Array.isArray(msg)) { this._greet?.(msg); continue; }
      const [, id, error, result] = msg;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (error) p.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace || ""}`));
      else p.resolve(result);
    }
  }

  send(command, params = {}) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify([0, id, command, params]), "utf8");
    this.socket.write(`${payload.length}:`);
    this.socket.write(payload);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async start() {
    await this.send("WebDriver:NewSession", { capabilities: { alwaysMatch: {} } });
    await this.send("Marionette:SetContext", { value: "chrome" });
  }

  // Runs `script` in chrome context. The script body receives `args` and must
  // call `resolve(value)` (async form).
  async run(script, args = [], { timeoutMs = 60000 } = {}) {
    await this.send("WebDriver:SetTimeouts", { script: timeoutMs });
    const wrapped = `const resolve = arguments[arguments.length - 1]; const args = arguments[0];
      (async () => { ${script} })().then(resolve, (e) => resolve({ __error: String(e) + "\\n" + (e && e.stack || "") }));`;
    const result = await this.send("WebDriver:ExecuteAsyncScript", { script: wrapped, args: [args], newSandbox: true });
    const value = result?.value;
    if (value && value.__error) throw new Error(`chrome script failed: ${value.__error}`);
    return value;
  }

  close() {
    try { this.socket?.destroy(); } catch {}
  }
}

module.exports = { Marionette };
