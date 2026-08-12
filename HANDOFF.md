# Steering Match — Project Handoff

> Drop this in the repo root. Rename to `CLAUDE.md` if you want Claude Code to auto-load it as project context.

## What we're building

A father-and-kid car game, **single iPhone only**.

Parent drives the real car. Kid sits in the passenger seat, holds the phone **landscape, upright, like a steering wheel**, and tries to mimic the car's actual steering. The game scores how closely the kid's phone motion tracks the car's real turns, over rounds of increasing length (1 min, then 2 min, etc.).

The magic is that it's tied to the **real drive on the real road** — not a generated track. That constraint is non-negotiable; it's the whole point.

## Hard constraints (already decided, don't relitigate)

- **One phone.** No second device on the wheel (can't mount it, blocks the road view). No camera (hands block the field of view).
- **The car's own turning is the "truth" signal.** A single passenger-held phone senses the car's yaw when the car corners. That's what the kid is matching against.
- **Must run over HTTPS** — iOS Safari refuses motion sensor data otherwise.
- **iOS 13+ needs a user-gesture permission tap** (`DeviceMotionEvent.requestPermission()`), already handled in the prototype.

## The one open question that gates everything

**Can the car's yaw be separated from the kid's hand steering, using one phone?**

Both motions hit the same sensor. The working hypothesis: they differ in character — the **car's turns are slow and smooth (low frequency)**, the **kid's hand movements are faster and jerkier (higher frequency)**. So a low-pass filter should isolate the car component. This has NOT been validated yet. Validating it is the immediate objective. If they can't be separated, the concept needs a rethink.

## Current state

One file: `steering-prototype.html` — a dependency-free "Axis Finder" (already deployed via GitHub Pages).

What it does:
- Reads `DeviceMotionEvent.rotationRate` (angular velocity, °/s) on all three axes: **alpha, beta, gamma**.
- Shows three live left/right bars, one per axis, each with a running peak.
- Records to memory and exports **CSV**: `t_sec, alpha, beta, gamma, orientation, mark`.
- "Mark Turn" button flags the current sample (`mark=1`) so real corners are findable in the data.
- Logs screen orientation per row (portrait/landscape).
- Screen wake-lock so it won't sleep mid-drive.

## Key technical findings (learned the hard way)

1. **Sensor axes are locked to the physical device and do NOT remap when you rotate to landscape.** This is why an early version that hard-labeled "roll = gamma, yaw = alpha" broke the moment the phone went landscape. Solution: don't assume an axis mapping — measure it empirically per holding posture.
2. **Use `rotationRate` (angular velocity), NOT `DeviceOrientation` tilt angles.** The absolute tilt angles (beta/gamma) suffer gimbal lock and go haywire when the phone is held near-vertical, which is exactly the game posture. Angular velocity has no gimbal-lock problem.
3. **`FULL` constant (currently 40 °/s)** in the prototype just scales the bar display; tune to taste, it doesn't affect recorded data.

## Immediate next steps (in order)

1. **Find the two axes.** Parked, hold the phone in game posture. Steer it like a wheel → note which axis bar dominates (= player signal). Then rotate the whole car / take a slow corner → note which axis jumps (= car signal). They should be different axes. Record a short real drive and export the CSV.
2. **Analyze the CSV** with `plot_signal.py` (included). Confirm the car's corners produce clear, separable spikes on one axis, and that a low-pass filter cleanly isolates the car component from hand jitter.
3. **Go / no-go decision** on the browser approach based on that data.

## Roadmap after signal is validated

- **Signal processing:** low-pass filter to extract the car-yaw "ground truth" in real time; high-pass or raw for the kid's input.
- **Scoring:** sliding-window correlation between the kid's motion and the car's turn signal → a live match score (0–100).
- **Game loop:** timed rounds of increasing duration, live feedback, end-of-round score, simple progression.
- **Platform decision:**
  - *Browser PWA* (fastest iteration, deploy on Vercel/GitHub Pages): good enough if the signal survives Safari's sample rate.
  - *Native Swift + CoreMotion*: `CMMotionManager` device-motion gives higher-rate, gravity-separated data and a proper attitude reference frame — much better for isolating true yaw. Go here if the browser signal is too noisy. Needs Xcode + a free Apple dev account to sideload for testing.
- **Localization:** Hebrew + English (Israeli market).

## Repo & deploy

- GitHub repo: `games` (user `assafshafran`).
- Served via **GitHub Pages** over HTTPS: `https://assafshafran.github.io/games/steering-prototype.html`.
- Iteration loop right now is manual re-upload via GitHub web UI (no laptop on hand). If iterating a lot, a GitHub Actions deploy workflow is worth setting up.

## Stack notes / conventions

- Owner normally works in **Next.js on Vercel, React, Supabase** (this is the mikum.me stack).
- **Deliberately keep the prototype a single dependency-free HTML file** until the signal is proven. Do NOT add build tooling, frameworks, or npm just to test physics. Graduate to Next.js PWA (Vercel) or native Swift only after go/no-go.
- Owner prefers terse, practical, copy-paste-ready output over long explanations.

## Working agreement for Claude Code

- Read `steering-prototype.html` first.
- Don't add dependencies or a build step until the signal question is answered.
- When you change the prototype, keep it one self-contained file so it can be dropped straight onto GitHub Pages.
- Preserve the CSV schema (`t_sec, alpha, beta, gamma, orientation, mark`) so old logs stay comparable.
