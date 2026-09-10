// Messaging between the control console and the arena window.
//
// The two run as separate browser windows so the arena can sit fullscreen on
// the projector while the console stays on the laptop. BroadcastChannel keeps
// them in step without a server.
//
// The scenario engine lives in the arena window, not here. Rendering needs the
// full actor state every frame, and shipping that across a channel sixty times
// a second would be wasteful; the console sends shots and commands, and gets
// back a small summary for its readouts.

const CHANNEL = 'dryfire';

export class Bus {
  constructor(role) {
    this.role = role;
    this.handlers = new Map();
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.from === this.role) return;
      for (const fn of this.handlers.get(msg.type) ?? []) fn(msg.payload, msg);
      for (const fn of this.handlers.get('*') ?? []) fn(msg.payload, msg);
    };
  }

  send(type, payload = {}) {
    this.channel.postMessage({ type, payload, from: this.role, t: Date.now() });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  close() {
    this.channel.close();
  }
}
