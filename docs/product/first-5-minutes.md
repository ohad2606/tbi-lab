# First five minutes (TBI-014): design note

## What a new user sees today
The Projects screen (`app/src/ui/Home.tsx`) opens with a first-run "Getting started" panel
(`GettingStarted.tsx`, Sprint 13) until dismissed; the dismissal is stored per device in the
preference `tbi-lab.onboarding.v1`, and a "Show getting started" link brings it back. Below it: new
project, recent projects, and the example library with search and category filters. The panel's
three steps were ESP32-first (open an ESP32 example, Build, Run), which needs a build (about a
minute) and the shared simulator: a slow, fragile first minute.

## The guided first example
LED current limiting (`led-current`): a lab supply, a 220 ohm resistor and a red LED. It is local,
needs no build and no shared simulator, and runs on the production engine like any project.

## The clear next step (this slice)
A highlighted "Fastest start: no build, no waiting" block at the top of the panel with one primary
button, "Open the LED example". It opens the example through the normal `openExample` path. The
text tells the next two actions: press Run in the top bar, then select the resistor R1 and change
its value; the LED current changes with it. The existing ESP32 steps stay below it.

Success criterion: from first load, a user reaches a running circuit and has changed a value in
one button press plus Run, without reading anything else.

## HE and EN
Keys `onboarding.quick.heading|body|open` in `messages.en.ts` and `messages.he.ts`. The part name
R1 is wrapped in directional isolates in Hebrew so it stays left-to-right.

## Keyboard and screen reader
- The panel is a `section` labelled by its heading (a region named "Getting started").
- Tab order: starter button, Capabilities, "Got it". Focus is never trapped.
- Escape inside the panel, or "Got it", closes it; focus moves to the "Show getting started" button.
- Visible focus uses the app-wide focus ring; targets are at least 24 px; the highlight is a border
  plus a heading, never colour alone. The panel has no animation, so reduced motion needs nothing.

## Deliberately out of scope
No change to the engine, physics or examples. The AI assistant (TBI-017) and component guides
(TBI-019) plug in later: the former as a "ask for a first circuit" action beside the starter
button, the latter as links from the next-step text to part pages.

## Remaining slices
1. An in-editor next-step hint after the example opens (a dismissible strip: "Press Run", then
   "Change R1"), with a live-region announcement when Run succeeds.
2. A success marker (first Run and first value change) kept locally.
3. Axe-based automated checks: the repo has no axe-core; adding it is a dependency decision.
