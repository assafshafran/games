# Authoring scenarios

A scenario is a JSON file. Load it with "Custom scenario" in the console. It is
validated before it runs, and rejected with a reason rather than failing in
front of the shooter.

The same format covers drawn scenarios and video scenarios. The engine never
inspects the footage; it tracks time, hit regions and outcomes, so a stage that
plays a clip and a stage that draws figures work identically.

## Shape

```json
{
  "id": "my_scenario",
  "name": "My Scenario",
  "description": "One line, shown in the console list.",
  "difficulty": "standard",
  "tags": ["branching", "video"],
  "start": "first_stage",
  "stages": { "first_stage": { } }
}
```

## Stages

A stage shows something, places hit regions, and says where each outcome leads.

```json
{
  "video": { "src": "clips/contact.mp4", "loop": true },
  "backdrop": "room",
  "caption": "Shown across the top of the arena.",
  "duration": 6500,
  "actors": [],
  "transitions": [],
  "outcome": null
}
```

- `video` plays a clip, scaled to cover the arena. Omit it and `backdrop`
  draws a dim scene instead: `range`, `street` or `room`.
- `duration` is milliseconds. When it elapses, a `timeout` transition fires.
- `outcome` of `win` or `lose` makes the stage terminal and ends the run.

Clip paths are relative to the page, so put `clips/` next to `index.html`.

## Actors

An actor is a hit region with a motion track.

```json
{
  "id": "suspect",
  "type": "video_region",
  "label": "armed suspect",
  "z": 20,
  "fireAt": 6000,
  "downOn": ["head"],
  "track": [
    { "t": 0,    "x": 0.62, "y": 0.90, "scale": 0.52 },
    { "t": 3500, "x": 0.66, "y": 0.91, "scale": 0.56, "visible": true }
  ]
}
```

| Field | |
|---|---|
| `type` | An archetype from the table below. A typo is an error, not a default. |
| `z` | Front-most wins a contested shot. No-shoots default to 10, hostiles to 0. |
| `fireAt` | Milliseconds into the stage at which an unengaged hostile fires. |
| `downOn` | Zones that neutralise it. Omit and any hit does. `[]` means nothing drops it, so the stage ends only through its own transitions. |
| `track` | Keyframes, sorted by `t`. |

### Types

| Type | Role | Notes |
|---|---|---|
| `threat` | shoot | Humanoid. Head scores 10, centre 7, elsewhere 3. |
| `threat_peek` | shoot | Only the head clears cover. Head scores 10. |
| `hostage` | no-shoot | Any hit scores -25. |
| `civilian` | no-shoot | Any hit scores -15. |
| `plate` | shoot | Steel circle, 5 points, no zones. |
| `video_region` | shoot | Invisible box tracking a hostile in footage. |
| `video_noshoot` | no-shoot | Invisible box tracking someone who must not be shot. |

Role comes from the type. There is no `role` field on an actor; setting one is
rejected, because a no-shoot silently becoming shootable is the worst failure
this format could have.

### Tracks

Coordinates are 0..1 across the arena, y downward, and `x`/`y` place the
actor's **feet**, so a figure that walks or grows stays planted. `scale` is
height as a fraction of the arena. Position, scale and rotation interpolate
linearly between keyframes and hold flat outside them.

`visible` does not interpolate. A target is either there or it is not; a
half-present target cannot be scored fairly. Use it for pop-ups:

```json
"track": [
  { "t": 0,    "x": 0.3, "y": 0.94, "scale": 0.7, "visible": false },
  { "t": 900,  "x": 0.3, "y": 0.94, "scale": 0.7, "visible": true },
  { "t": 2600, "x": 0.3, "y": 0.94, "scale": 0.7, "visible": false }
]
```

## Transitions

The first matching transition wins, so order them most specific first.

```json
{ "on": "hit", "actor": "suspect", "zone": "head", "goto": "neutralised" }
{ "on": "noshootHit", "outcome": "lose", "reason": "you hit the teller" }
```

| `on` | Fires when |
|---|---|
| `hit` | A hostile is hit. Narrow with `actor` and `zone`. |
| `noshootHit` | Anything marked no-shoot is hit. |
| `threatFired` | An actor's `fireAt` elapsed while it was still up. |
| `allThreatsDown` | Every hostile in the stage is down. |
| `timeout` | The stage's `duration` elapsed. |

Give either `goto` (another stage) or `outcome` with a `reason`.

Add `requires` to demand a sequence rather than a single shot. It counts hits
already recorded in the run, including the one being judged:

```json
{ "on": "hit", "actor": "hostile", "zone": "head",
  "requires": { "actor": "hostile", "zone": "centre", "count": 2 },
  "outcome": "win" }
```

That is the failure drill: the head shot only ends it once centre mass has been
hit twice. Pair it with `"downOn": []` on the target, or the first hit that
drops the target ends the stage by the default rule below before the sequence
is complete.

With no matching transition, hitting a no-shoot loses, downing the last hostile
wins, and a timeout loses. Those defaults mean a simple drill needs no
transitions at all.

## Timing video

Stage time is measured from the moment the stage begins, and a clip starts at
zero when its stage does, so keyframe times are the clip's own timestamps.
Scrub the clip, note where the subject is at a few moments, and write those
down as keyframes.

Two or three keyframes per second of footage is usually enough. Regions do not
need to be tight: they need to be right at the moment the shooter fires.

## Worked example

[bank-holdup.json](bank-holdup.json) is a five-stage branching video scenario
with an armed suspect and a teller who must not be hit. It references clips
that are not included; supply your own and the scenario runs as written.

To check a scenario without a projector:

```bash
node -e "import('./js/scenario.js').then(async m => {
  const s = JSON.parse(await (await import('node:fs/promises')).readFile('scenarios/mine.json','utf8'));
  console.log(m.validateScenario(s).join('\n') || 'valid');
})"
```

Then load it in the console, tick "Click the arena to shoot", and walk every
branch with the mouse before pointing a laser at it.
