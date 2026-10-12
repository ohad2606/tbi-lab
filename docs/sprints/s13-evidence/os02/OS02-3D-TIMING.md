# OS-02: 3D view open time on a minimal circuit, profiled and measured (2026-10-12)

**Owner report:** 5–7 s to render the 3D view of a minimal circuit. The owner's observation and
machine details have been requested; see the register.

## Method

- **Instrumentation.** `ThreeView` `data-open-ms` gives the ms from opening for each phase: renderer chunk, glTF assets, viewer creation, scene derivation, scene build (`update`), and the first rendered frame.
- **Spec.** `app/e2e/s13-3d-timing.spec.ts`, enabled with `TBI_3D_TIMING=1`.
- **Runs.** Every run is cold: a fresh browser context, with nothing cached.
- **Circuits:**
  - `ohms-law`: supply and resistor.
  - `esp32-blink`: the board is the largest asset.
- **Tiers.** Both render tiers are forced:
  - `full`: the tier a real GPU gets.
  - `reduced`: the tier this host gets automatically.
- **Host limitation.** This host has **no GPU**. Chromium renders with software WebGL (SwiftShader), so the `full` numbers here are far slower than on a GPU. They show the *structure* of the cost and the *relative* effect of a fix, not the owner's seconds.

## Profile: where the time goes (before)

CPU profile of a cold `full` open of `ohms-law` (`os02-profile.txt`):

| Time | Where |
|---|---|
| 47.4 s | native: GL calls blocking on shader compilation and software rasterisation |
| 4.3 s | JS: three.js `WebGLProgram` first-use check, which waits **synchronously** for each program's link status (`debug.checkShaderErrors`) |
| < 0.5 s | all scene derivation, asset loading and building together |

The `full` tier compiles 21 shader programs for this two-part circuit, and 30 with the ESP32 board: PBR with environment, VSM shadows, GTAO and depth of field. The `reduced` tier compiles 3–5.

**Bottleneck: shader-program compilation, done synchronously on the main thread during the first frames.** On a GPU, 21–30 such programs compiled one after another (100–250 ms each on common Windows drivers) is consistent with the reported 5–7 s. That last figure is an inference, not a measurement on this host.

## Fix

In `app/src/views/scene3d/renderer.ts`:

1. The first scene's programs are compiled with `renderer.compileAsync`. This is parallel and does not block the page where `KHR_parallel_shader_compile` is available, which includes Chrome/ANGLE. The first frame is then drawn once.
2. The first build no longer renders twice (`resize` draws, then `render`).
3. Production builds skip three.js's synchronous per-program error query. That is three.js's own advice; development keeps the check.

**Rejected variant B.** Variant B applied (2) and (3) without (1), and measured no better than before. Only parallel compilation moves the time.

## Results (medians of cold runs)

| Circuit | Tier | Before: first frame | After: first frame | Before: until UI updated | After: until UI updated | Programs before/after |
|---|---|---|---|---|---|---|
| ohms-law | full | 37.9 s | **15.8 s** (−58 %) | 44.9 s | **34.3 s** (−24 %) | 21 / 31 |
| esp32-blink | full | 56.9 s | **22.4 s** (−61 %) | 65.6 s | **53.5 s** (−18 %) | 30 / 49 |
| ohms-law | reduced | 1.33 s | **0.57 s** (−57 %) | 1.71 s | **1.65 s** (−4 %) | 3 / 4 |
| esp32-blink | reduced | 2.35 s | **0.78 s** (−67 %) | 2.92 s | **2.57 s** (−12 %) | 5 / 7 |

"Until UI updated" is the test's wall time from the click to the page reflecting the first frame. On software WebGL each later full-tier frame still costs seconds, which is why this column improves less.

**Cost of the fix.** `compileAsync` compiles more program variants (21 → 31) than the first frame uses. On parallel GPU compilation that is cheap. Here it is visible.

## Open items

1. **Owner retest on the owner's machine (GPU) is required** to confirm the 5–7 s is gone. The measurement here cannot show GPU seconds.
2. **If still > 2 s, the next step is fewer shader programs in the full tier.** That means sharing material variants and depth materials, and making GTAO and depth of field opt-in. This is a structural change to the 3D stage, and it needs a PM decision.
