// Range sounds, synthesised so the project needs no audio assets.
//
// Everything is a short shaped tone. A shot needs feedback inside about 50 ms
// or it stops feeling connected to the trigger, and loading a sample file is a
// slower and less reliable way to get there than generating one.

let ctx = null;

function context() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

// Browsers keep audio suspended until a user gesture. Call this from a click.
export function unlock() {
  const c = context();
  if (c.state === 'suspended') c.resume();
  return c.state;
}

function tone({ freq, duration, type = 'sine', gain = 0.25, sweepTo = null }) {
  const c = context();
  if (c.state === 'suspended') return;
  const osc = c.createOscillator();
  const amp = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (sweepTo != null) {
    osc.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + duration);
  }

  // A short attack and exponential decay; a raw gate would click audibly.
  amp.gain.setValueAtTime(0.0001, c.currentTime);
  amp.gain.exponentialRampToValueAtTime(gain, c.currentTime + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);

  osc.connect(amp).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + duration + 0.02);
}

function noise(duration = 0.12, gain = 0.3) {
  const c = context();
  if (c.state === 'suspended') return;
  const frames = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }
  const src = c.createBufferSource();
  const amp = c.createGain();
  amp.gain.value = gain;
  src.buffer = buf;
  src.connect(amp).connect(c.destination);
  src.start();
}

export const sfx = {
  beep: () => tone({ freq: 880, duration: 0.16, type: 'square', gain: 0.22 }),
  start: () => tone({ freq: 1200, duration: 0.35, type: 'square', gain: 0.3 }),
  hit: () => noise(0.1, 0.35),
  headshot: () => { tone({ freq: 1400, duration: 0.1, type: 'triangle' }); noise(0.09, 0.3); },
  miss: () => tone({ freq: 220, duration: 0.1, type: 'sine', gain: 0.14 }),
  // Deliberately unpleasant: a no-shoot hit should not be mistaken for a score.
  penalty: () => tone({ freq: 320, duration: 0.55, type: 'sawtooth', gain: 0.3, sweepTo: 90 }),
  win: () => { tone({ freq: 660, duration: 0.14, type: 'square' });
               setTimeout(() => tone({ freq: 990, duration: 0.3, type: 'square' }), 130); },
  lose: () => tone({ freq: 300, duration: 0.7, type: 'sawtooth', gain: 0.28, sweepTo: 70 }),
};
