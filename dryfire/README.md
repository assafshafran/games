# Dryfire Range

A laser dry fire training simulator for a projector, a USB camera and a laser
training cartridge. It runs entirely in the browser: no Java, no install, no
build step.

It exists because the obvious existing option no longer works. ShootOFF, the
project most people are pointed at, was last developed around 2017 and cannot
be built today: its dependencies came from JCenter and Bintray, both shut down
in 2021, and it needs Oracle JDK 8 with bundled JavaFX. Splatt2 is alive and
good, but it solves a different problem: a camera mounted on the barrel,
watching a printed target, with shots triggered by the sound of the action.
Neither does projected branching scenarios.

## What it does

The camera watches the projected image. When the laser flashes, the shot is
located in the camera frame, mapped onto the projected arena, and scored
against whatever is on screen at that instant.

Scenarios are a branching state machine, not a list of targets. A stage places
hit regions and lists transitions; an outcome sends the run somewhere else. A
head shot ends the hostage drill one way, a hit on the hostage ends it another,
and running out of time ends it a third.

## Hardware

| | |
|---|---|
| Projector | Any. Short throw helps, it is not required. |
| Camera | Any USB webcam. 60fps is better than 30fps but 30 works. |
| Laser | A red or green laser training cartridge or laser trainer. |
| Computer | Anything that runs a current Chrome or Safari. |

**Before every session, confirm the firearm is unloaded and no live ammunition
is in the room.**

## Running it on macOS

The camera needs a secure context, so opening the file directly will not work.
Serve it over localhost:

```bash
cd dryfire
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome. Chrome is the better choice here:
its camera device picker is more reliable and it handles a second display more
predictably. Safari works.

The first time the camera starts, macOS asks for permission. If you refused
once, the browser will not ask again: re-enable it under System Settings,
Privacy & Security, Camera, then reload the page.

## Setting up

**1. Open the arena window.** Press "Open arena window" in the console. Drag
that window onto the projector, click it, and press `F` for fullscreen. If
nothing appears, allow pop-ups for localhost.

**2. Place the camera.** It must see the whole projected image with a margin
around it. Off to one side and tilted is fine, that is what calibration is for.
Do not put it where the shooter will walk in front of it.

**3. Dim the room.** Not because the projector needs it, but because the
detector separates a laser dot from the scene by brightness. A dark room widens
the gap.

**4. Start the camera**, pick your device, and check the preview.

**5. Calibrate.** Press "Auto calibrate". The arena flashes black then white
three times, at different speeds, and the camera frames are differenced.
Everything already lit in the room cancels out, leaving the area the projector
covers; its four corners become the mapping.

Three flashes rather than one because a webcam shown a white screen stops its
exposure down within about a second, which erases the very difference the
method depends on. The fast pass beats auto-exposure, the slow pass suits a
projector with input lag, and only one of them has to work.

Either way you get a diagnostics panel showing the two frames the camera
captured and what changed between them. **Flash strength** is the number to
read first: it is how much brighter the camera saw the room get. Tens of levels
is healthy. Near zero means the camera is not looking at the projection at all,
whatever the other numbers say.

"Set corners by hand" is the fallback. Four handles appear on a frozen camera
frame; drag each onto a corner of the projected image and press "Use these
corners". Clicking anywhere jumps the nearest handle there, and order does not
matter.

**6. Verify.** Press "Verify" and shoot the grid intersections. Markers should
land where you aimed. If they are consistently offset, calibrate again; if they
are offset by a growing amount toward one edge, the camera moved.

**7. Tune detection.** Open "Show what the detector sees". Candidate pixels are
painted magenta. Nothing should light up while the arena is idle. If the
projected image is registering, raise the brightness floor. If your laser is
being missed, lower it. The blob size ceiling is what actually separates a
laser dot from the projector, so keep it well below the size of any bright
patch on screen.

## Scenarios

| Scenario | What it trains |
|---|---|
| Zeroing | Three static plates. Confirms calibration and point of aim. |
| Steel Speed | Five plates against the clock. Transitions and speed. |
| Failure Drill | Two centre, one head. The head only counts after the body. |
| Advancing Threat | A hostile closes and fires at seven seconds. |
| Shoot / No-Shoot | Figures appear one at a time. One wrong shot ends the run. |
| Room Clearing | Three rooms in sequence, mixed hostiles and bystanders. |
| Hostage Rescue | A hostile behind a hostage, head exposed. Branching. |

Target positions are drawn from a fresh seed on every run, so a drill trains
the skill rather than the positions. Every run is logged with per-shot times,
splits, zones and scores, and can be exported as JSON.

To rehearse without a projector, tick "Click the arena to shoot" and click the
arena window directly. Everything scores exactly as it would with a laser.

## Video scenarios

The engine takes branching video as well: a stage plays a clip and places
invisible hit regions that follow what the footage shows, and an outcome cuts
to a different clip. The format is in [scenarios/README.md](scenarios/README.md)
with a worked example. You supply the clips.

This is where the real work is. There is no free library of branching
shoot/no-shoot footage, because filming it with actors and multiple branch cuts
is expensive, which is why the commercial systems keep theirs behind a paywall.
The engine is ready for it whenever you have footage.

## Tests

```bash
node test/logic.mjs                     # 75 checks, no browser, no hardware
npm install && node test/browser.mjs   # 33 checks in real Chromium
```

The logic tests cover the geometry, the detector, calibration against synthetic
camera frames including a dim projection and a rounded blob, and every scenario
at 200 seeds each. The browser tests cover module loading, the two windows
finding each other, canvas rendering, manual corner dragging, and the camera
path using Chromium's fake capture device.

## How it is put together

| File | |
|---|---|
| `js/homography.js` | Maps camera pixels to arena coordinates. |
| `js/detect.js` | Finds the laser dot in a frame. |
| `js/calibrate.js` | Locates the projected area from a black/white pair. |
| `js/geometry.js` | Polygons and keyframed motion. |
| `js/actors.js` | Target archetypes and scoring zones. |
| `js/scenario.js` | The branching state machine. |
| `js/library.js` | The built-in scenarios. |
| `js/arena.js` | The projector window. |
| `js/console.js` | The control window. |
| `js/bus.js` | Messaging between the two. |

The scenario engine lives in the arena window. Rendering needs the full actor
state every frame, and sending that across a channel sixty times a second would
be wasteful, so the console sends shots and commands and gets back a summary.

## Troubleshooting

**The arena window never connects.** Pop-ups are blocked, or the two windows
are on different origins. Both must be served from the same localhost address.

**Calibration says the camera did not see the arena flash.** What changed
between the two frames was scattered noise rather than a screen. Nearly always
one of three things: the arena window is on the laptop screen instead of the
projector, the wrong camera is selected in the dropdown, or the camera is
pointed somewhere other than the projected image. Check flash strength in the
diagnostics; it will be close to zero.

**Calibration says the projection is too small.** It found a real lit
rectangle, just a small one. Move the camera nearer the screen or make the
projected image larger in frame.

**Calibration says the lit area is rounded, or ragged, rather than
rectangular.** Something else is changing brightness along with the projector,
usually a mirror, a window or a glossy wall, or part of the screen is blocked.
The difference image in the diagnostics shows exactly what it found. Move the
camera, or set the corners by hand.

**Auto calibration keeps failing but the projection looks fine.** Use the
manual corner picker. It works from a single lit frame and does not depend on
the flash at all, so it is immune to every auto-exposure problem above.

**Shots register in the wrong place.** Calibration is stale because the camera
or projector moved. Recalibrate.

**Shots register when nobody fired.** The brightness floor is too low or the
blob ceiling too high, and the projected image is triggering it. Turn on the
detector view and raise the floor until the arena contributes nothing.

**Nothing registers.** Check the detector view first. If the laser does not
appear there at all, it is a camera exposure problem, not a threshold problem:
many webcams auto-expose so aggressively for a dark room that a brief laser
pulse never reaches a bright pixel. Lock the exposure low if your camera allows
it.
