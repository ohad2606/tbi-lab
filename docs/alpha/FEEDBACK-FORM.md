# Alpha feedback form — specification (H7; prepared, NOT enabled)

**Status: disabled.** External data collection starts only after owner approval (PM, Sprint 13).
No feedback backend is built. The product shows a "Send feedback" menu item **only** when a
deployment is built with `VITE_FEEDBACK_URL` (an https form address); no build sets it today
(unit test `app/tests/deployment.test.ts`).

## Provider (zero cost)

A free online form under the owner's account, for example Google Forms (no cost, responses in the
owner's Google Drive). The owner creates the form; engineering only receives its address and the
prefill parameter name of the "Version" question.

## Questions

| # | Question | Type | Required |
|---|---|---|---|
| 1 | What were you trying to do? | paragraph | yes |
| 2 | What did you expect to happen? | paragraph | yes |
| 3 | What actually happened? | paragraph | yes |
| 4 | Severity | single choice: **Blocker** (cannot continue) · **Major** (wrong result or broken feature) · **Minor** (works with a workaround) · **Cosmetic / wording** · **Suggestion** | yes |
| 5 | Steps to reproduce | paragraph | no |
| 6 | Version (prefilled from the app, e.g. `v0.10-dev ba0f4a6…`) | short text | yes |
| 7 | Project file (export `.tbilab` and attach, or paste its name) | file upload / short text | no |
| 8 | Language you used | single choice: English · עברית | yes |
| 9 | Browser and operating system | short text | no |
| 10 | May we contact you about this report? | yes / no | yes |

Privacy note on the form: "We collect only what you write here and the app version. Do not
include passwords or personal data in project files or descriptions."

## Enabling (after approval)

1. The owner creates the form and gets a prefill link for question 6 (e.g. `entry.123456789`).
2. Frontend build for the alpha deployment with
   `VITE_FEEDBACK_URL=https://docs.google.com/forms/d/e/<id>/viewform?usp=pp_url` and
   `VITE_FEEDBACK_VERSION_PARAM=entry.123456789`, through the normal release gate.
3. Verify: the menu shows "Send feedback"; the link opens the form with the version filled in.
4. Triage: responses reviewed daily during the alpha; Blocker/Major reproduced and tracked.
