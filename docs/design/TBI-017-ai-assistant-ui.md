# TBI-017 — AI assistant in the UI (design note)

Status: DESIGN 2026-11-19 (branch `co/20261119-aiui`); slice 1 built 2026-11-22 (see §12). Inactive everywhere until the owner decides.

## 0. What already exists (do not rebuild)
- `packages/assist`: Engineering Context (format `tbi-lab.engineering-context` v1, bounded), deterministic `diagnose()` findings
  (id, severity, certainty verified/conservative/indeterminate, evidence refs, `ActionId` advice), `AssistGateway` (timeouts, retries,
  rate, strict response validation: only known findings, cites must be own evidence, every number must appear in evidence, plain text
  only), mock provider. Contract: `tbi-lab.assist.explain/1`. No write action (AI origin rejected; dry-run only).
- `runtime/assist` (service, unix socket behind the gate, `/assist/v1/*`): `GET status`, `POST preview`, `POST explain`. Inactive
  by default (needs provider+model, data terms, spend cap, security review, owner activation, pilot principal). Findings are
  recomputed server-side; the client cannot add text. Data categories: `DATA_SENT` / `DATA_NEVER_SENT`.
- `app/src/assist` (DEV-Lab build only, `VITE_TBI_ENV==='dev'`, chunk excluded from other builds): top-bar "Analyze circuit" button,
  non-modal `AssistPanel` (heading focus on open, Esc closes, focus returns to trigger, `role=status` while running, stale banner),
  deterministic "Simulator findings" section first, then "Explanation" (labelled template text when not live), then `PilotSection`
  (status, exact payload preview, consent, send, error keys `assist.pilot.error.*`). E2E: `app/e2e/s27-assist.spec.ts`.
- TBI-018 (branches plans-s1..s3, drafts #24/#25/#27): metering behind `metering.enabled=false`. Refusals return
  `{error, limit:{code,messageKey,params}, message:{he,en}}`; codes `credits_out`, `credits_out_free`, `daily`, `rate`, `global_off`
  (503), `too_long` (413), `deep_not_in_plan` (403), `system_unavailable` (503, "not charged"). Request carries `mode: standard|deep`.

So TBI-017 is mostly: (a) three actions instead of one, (b) consent persisted properly, (c) limit/credits states, (d) promote from
"owner pilot" to a user-facing feature behind a flag, (e) a11y/i18n hardening and e2e.

## 1. Placement and keyboard access
- Keep the non-modal side panel (circuit stays visible). Inline-end side in both directions (right in LTR, left in RTL; logical CSS).
- Entry points: top-bar button "AI assistant" (replaces "Analyze circuit" when the flag is on); context buttons "Why is this wrong?" next
  to a failed check / build error (opens the panel with that action preselected, never auto-sends); command in the shortcuts registry
  (TBI-020) only after the owner decides the WCAG 2.1.4 question for single-key shortcuts — until then no shortcut.
- Focus: opening moves focus to the panel heading (existing); Esc closes unless a dialog is open; focus returns to the trigger. Tab order:
  action chooser, Ask, status, findings, AI answer, feedback, close. The panel never traps focus.
- Narrow screens: panel becomes a bottom sheet with the same order; target >= 24 px; no drag-only resizing (none planned).

## 2. Consent flow (what is sent)
- Consent is per consent-version (service `consentVersion`; request carries `consent:{version, accepted:true}`).
- First use (or version change): a modal `<dialog>` "Send to the AI?" listing `DATA_SENT` (instructions, language, findings, circuit part
  types/values/connections, checks and results, build status <= 20 messages, <= 8 code excerpts of +-2 lines with comments/strings masked
  and secrets redacted) and `DATA_NEVER_SENT` (identity/email, project name, net names, comments and strings, serial output, screenshots,
  whole files), plus provider/model and retention (`auditRetentionDays`; provider retention from data terms).
- "Show exactly what would be sent" calls `POST /preview` (no consent needed, nothing sent) and shows the payload in an LTR `<pre>` with
  a text size. Buttons: "Agree and send" / "Cancel" (default focus = Cancel-safe heading, not the agree button).
- Consent is stored client-side per account+version (localStorage key with version) AND sent on every request (service is the authority).
  "Withdraw consent" in the panel footer clears it. Nothing is sent on open, on action switch, or on language change.
- Open: whether consent must be remembered server-side (owner/legal Q2).

## 3. The three actions (one contract, one request)
All three use `POST /v1/explain`; the findings are recomputed server-side. Slice 1 ships only action A on the existing contract.
- A. "Explain this circuit": context of the whole project; answer = summary + per-finding explanations (existing contract).
- B. "Why is this wrong?": same context focused on the selected failed check/finding/rule; needs `focus` (a finding key) — a NEW
  optional request field, requires service change (`tbi-lab.assist.explain/2`, additive). Until then the client selects the finding in the UI
  and the answer scrolls to it.
- C. "Help with the code": program excerpts + build diagnostics; needs the code-excerpt category to be present (else the button explains
  why it is disabled: no program / not built). Suggestions are text only; a code block in an answer is a labelled, copyable, never
  auto-applied snippet (needs contract/2 `snippets`; until then plain text). Out of scope: AI writes to the project (ADR needed).

## 4. Result layout (order is fixed)
1. "Simulator findings" (deterministic, from the engine; heading note: "These come from the simulation, not from AI"). Always shown first,
   even when the AI fails, is off, or credits are out. This is the product's truth.
2. "AI explanation" with a visible label on the section and in text, not colour only: "AI-generated, may be wrong. Check it against the
   findings above." Each statement lists its evidence links (existing cites). Model name and cost line (small).
3. Unexplained/declined findings keep the existing messages. Feedback buttons "Helpful / Not helpful" (optional, slice 4; no text sent).
- The AI answer never changes the circuit, never claims numbers not in evidence (gateway rejects), is never read as electrical truth.

## 5. States (every one has text, none is colour-only)
| State | UI | Announcement |
|---|---|---|
| idle | action chooser + intro | none |
| not available (flag off / service disabled / not pilot-or-plan) | findings-only mode: deterministic panel stays usable; one sentence why | `role=status` once on open |
| consent needed | dialog (section 2) | dialog label |
| sending | "Asking the AI…" + Cancel (abort -> service cancels) ; UI never blocked, no spinner-only | polite status, once |
| success | answer section | polite "Answer ready. N findings explained." (not the answer text) |
| error (timeout, provider_error, invalid_response, busy, rate_limited, context_too_large, internal, offline) | inline error with Retry (if safe) ; findings stay | `role=alert` once |
| limit reached (TBI-018) | message from service `message[lang]` (fallback: client key `assist.limit.<code>` with `params`); shows reset/upgrade info only when the plan feature exists; never blank | `role=alert` once |
| credits left | small line "Credits left: N" under the Ask button, from `status`/response (new additive field `credits:{balance,mode cost}` — TBI-018 hook) ; `deep` mode shown only when `deep_not_in_plan` is not the plan | updated in the status region on change, not on every render |
| stale | existing banner when project changed after the answer | polite |
- Failed request is not charged (service releases the reservation); text says so when the code is `system_unavailable`.
- Client never retries on its own for 429/503 (shows `retryAfterMs` as a seconds hint, Retry button re-enabled after it).

## 6. Live regions
One persistent visually-hidden `role=status aria-live=polite` region in the panel (created at mount, text swapped) for sending/success/stale/
credits; a separate `role=alert` only for errors/limits. Never announce streamed text. Answer is a static `section` with a heading; focus
moves to it only on user request ("Jump to answer" link), not automatically.

## 7. i18n / RTL
- All strings are keys in `messages.en.ts` and `messages.he.ts` (`assist.*`, new `assist.action.*`, `assist.consent.*`, `assist.limit.*`,
  `assist.ai.label`); parity test already covers the files. No `lang===` branches. Request `locale` = UI locale code; the answer is rendered
  in `lang` of the locale with `dir` on the panel.
- Technical tokens LTR via `isolateLtr`/`<bdi dir=ltr>`: part ids, pins (GPIO4), values with units, finding codes, evidence ids, file:line,
  code blocks and the preview payload (`dir=ltr`, `unicode-bidi: isolate`). Free-form AI sentences use `dir=auto`.
- HE text for limit messages comes from the service (`message.he`), already tested in TBI-018 s2; client keys are the fallback only.

## 8. Feature flag
- Build-time `VITE_TBI_ENV==='dev'` stays the hard gate (chunk not in other builds, check-dist). New runtime flag `assist.ui` read from the
  service `status` (`state:'active'` and `pilot` or plan allows), default OFF. No Alpha activation: Alpha build and service stay as is;
  enabling any of it on Alpha = RED, owner approval, separate release.
- Without the flag the existing "Analyze circuit" deterministic debugger behaves as today (findings only).

## 9. API client contract (browser -> `/assist/v1`, via `gateFetch`, same-origin, no keys in browser)
Extract a typed `app/src/assist/client.ts` from `pilot.tsx` (which today does ad-hoc `fetch` + casts):
```
status(signal) -> {kind:'unavailable'} | {kind:'ok', state:'active'|'disabled', reasons?, mode?, provider?, model?, pilot,
                   consentVersion, data:{sent[], neverSent[], auditRetentionDays}}          // GET /status
preview(ctx, locale, signal) -> {payload}                                                  // POST /preview
explain({contract:'tbi-lab.assist.explain/1', locale, consent:{version,accepted:true}, context}, signal)
  -> ok {findings, response:{explanations[], summary?, declined?}, unexplained, accounting}
   | err {status, error: 'unauthenticated'|'not_pilot'|'pilot_disabled'|'consent_required'|'bad_request'|'context_too_large'|
          'rate_limited'|'busy'|'daily_limit'|'spend_cap'|'token_ceiling'|'cancelled'|'timeout'|'provider_error'|'invalid_response'|
          'internal' | TBI-018 codes, retryAfterMs?, limit?:{code,messageKey,params}, message?:{he,en}}
```
Rules: any non-JSON/unknown shape -> `unavailable`/`other` (never throws to the UI); AbortSignal on every call; 128 KB body cap respected
(client pre-checks via `buildEngineeringContext` bounds); unknown error codes map to `assist.error.other`. Mock service for tests: the
existing `AssistGateway` + mock provider, or a Playwright route fulfilling these shapes.

## 10. Accessibility checklist (WCAG 2.2 AA)
Keyboard: open, choose action, consent dialog, send, cancel, close, links to evidence — all without mouse. Visible focus on every control.
Names/roles: `aside` labelled by heading; action chooser = `radiogroup` or buttons with `aria-pressed`; dialog uses `<dialog>` with
label+description; AI label is text. Status vs alert as section 6. Contrast 4.5:1 text / 3:1 UI incl. the "AI may be wrong" badge and
disabled state. Targets >= 24 px. 2.5.7: no drag. 3.3.x: errors have text + how to retry. Reflow/zoom 200% in bottom-sheet. Reduced motion:
no animation. Needs manual SR test (NVDA+Firefox, VoiceOver) in HE: reading order of mixed LTR tokens, status announcement timing.

## 11. Test plan
- vitest: client (shapes, unknown codes, abort, non-JSON), consent store (version bump re-asks), limit-message selection (service text vs
  fallback key), message parity for all new keys, status->UI state reducer.
- Playwright `app/e2e/a11y-assist-*.spec.ts` (mock service by route): keyboard-only flow incl. consent; focus return; findings before AI in
  DOM and visual order; AI label present; live-region texts (status once, alert on error/limit); HE+EN, RTL layout, LTR tokens;
  limit reached HE/EN; flag off = no button on non-dev build; no request before consent (assert zero network calls); 320 px and 200% zoom.
- Existing `s27-assist.spec.ts` stays green.

## 12. Slices
1. **Smallest vertical slice**: `client.ts` (typed, vitest) + Playwright mock service + flag from `status` + consent dialog (version-keyed) +
   action A only + states idle/sending/success/error + AI label + live regions. DEV build, flag off by default. (~1 night, frontend)
   **Status 2026-11-22: built on `co/20261122-aiui-s1` (local commit, not pushed; QA/a11y-reviewer pending).**
   - Files: `app/src/assist/client.ts` (typed status/preview/explain, AbortSignal, error mapping, strict shapes),
     `app/src/assist/consent.ts` (consent store), `app/src/assist/pilot.tsx` (rewritten: state machine
     `useAiController`, `AiControls`, `AiResult`, `AiNotAvailable`, `AiFooter`, `ConsentDialog`), `AssistPanel.tsx`
     (status on open, one polite live region, AI flow wiring), `assist.ai.*` keys EN+HE, `assist.findings.notAi`.
   - Tests: `app/tests/assist-client.test.ts`, `app/tests/assist-consent.test.ts`, `app/e2e/a11y-ai-assistant.spec.ts`
     (mock service by route interception, own browser contexts). `s27-assist.spec.ts` unchanged except a
     `TBI_E2E_DEV_URL` port override.
   - Decisions taken in this slice:
     a. Flag = `status.state==='active' && status.pilot` (no plan check yet); any other answer (none, HTML, 404,
        wrong protocol/shape) = OFF. Build-time `VITE_TBI_ENV==='dev'` gate unchanged (chunk still DEV-only).
     b. Visible names unchanged (owner Q7): top bar "Analyze circuit", panel "Circuit Debugger". The new action is
        a button "Explain this circuit" (`assist.ai.action.explain`); the "AI assistant" rename is NOT applied.
        All new text is in renamable `assist.ai.*` keys (not `assist.action.*`/`assist.limit.*`, which already hold the
        findings' advice and limitations).
     c. Account for the consent key: the browser does not know the account. The client uses the service's
        optional opaque `status.account` (additive field, NOT sent by the service today; only `[A-Za-z0-9._-]{1,64}`
        accepted, so never an email) and otherwise `browser`. Today the remembered consent is therefore per browser
        (+ deployment namespace) and per version; the service stays the authority (consent sent on every request,
        `consent_required` drops the remembered copy). Server-side memory remains owner/legal Q2.
     d. Opening the panel does one `GET /status` (no project data). "Explain this circuit" runs the local analysis
        first when there is none / it is stale, then the dialog (if no consent), then one `POST /explain`.
        "Show exactly what would be sent" POSTs the context to the TBI service `/preview` (not to a provider),
        only on that explicit click.
     e. With the AI on, the template "Explanation" section is hidden (one explanation section: the AI one). With the
        AI off the deterministic panel is exactly as before plus one sentence why.
     f. Ask stays in place while sending (`aria-disabled`, no focus loss); Cancel next to it; when Cancel/Withdraw/
        the dialog goes away focus goes to Ask. Retry = the same button ("Try again"); for `retryAfterMs` it stays
        `aria-disabled` until the wait is over. No client retries.
     g. Cancel is a polite status ("The request was cancelled…"), not an alert; errors are `role=alert`, re-mounted
        per occurrence so a repeated error is announced again. The status region is cleared then set (120 ms) so a
        repeated message is re-announced.
     h. TBI-018 `limit`/`message` are parsed by the client but not shown yet (slice 2); unknown codes show
        `assist.ai.error.other`.
   - Not done here: action chooser (only A exists), limits/credits UI, feedback, "Jump to answer" link, bottom
     sheet, manual SR test.
2. Limit/credits states from the TBI-018 shapes (mock first; works on s2 branch with `metering.enabled`), HE/EN limit text, credits line.
3. Actions B/C: contract/2 `focus` + code excerpts gating (runtime-dev), context entry points.
4. Feedback buttons, withdraw consent, a11y-reviewer pass, SR session.
5. Quality eval (<= 5 USD, owner-approved) then model choice; ops activation on DEV only; Alpha = separate owner decision.

## 13. Open owner questions
1. Who gets it first on DEV: owner only (pilot list) or all signed-in DEV users? On Alpha: never until approved?
2. Consent: remember per browser, per account on the server, or ask each session? Legal wording/data-terms text owner/lawyer reviewed?
3. Provider and model, monthly cap, provider retention (needed for the consent text) — after eval.
4. Free plan: how many AI credits, is `deep` mode offered in V1, what does "limit reached" offer (wait, buy pack, upgrade)? (TBI-018 gap list)
5. Is AI allowed to propose code snippets, and may it ever write to the project (we say no for V1)?
6. Single-key shortcut for the panel: allowed given WCAG 2.1.4 (TBI-020 open item)?
7. Is the user-visible name "AI assistant" (and HE "עוזר בינה מלאכותית") approved, or keep "Circuit Debugger"?
