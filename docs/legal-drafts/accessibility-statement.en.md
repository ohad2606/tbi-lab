> **DRAFT — lawyer review required / טיוטה — נדרשת בדיקת עורך דין**
> This text is not in force and must not be published before review by an Israeli accessibility specialist or lawyer. It does **not** claim that any site or product conforms to any standard. Items marked **[LAWYER]** are open legal questions. Items marked **[TBD]** are placeholders.

# Accessibility Statement — TBI Lab

## 1. Status of this text
This draft is for the future public site. It will be updated before publication so that it reflects the site as it actually is on that day.

## 2. Our commitment and target
We aim to build the public site and the Lab to **WCAG 2.2 level AA**. We also aim to meet the Israeli standard **IS 5568** at level AA. **[LAWYER]** Which edition of IS 5568 and which WCAG base to cite, and the legal duties that apply to TBI (including any exemption).

A target is not a result. **We do not claim that the site or the Lab conforms to WCAG 2.2 AA or to IS 5568.**

## 3. Current conformance status
- The public site: **[NOT YET REVIEWED]**. It has not yet been built and audited.
- The Lab (the engineering workspace): partly accessible, with significant known gaps listed below.
- Automated checks cover only part of the requirements. They do not prove conformance.
- We have not yet verified behaviour with screen readers such as NVDA, JAWS, VoiceOver or TalkBack. **[TBD]** Which assistive technologies and browsers will be tested.
- An independent expert review is planned before the public launch. **[PROPOSED]**

## 4. What we do [PROPOSED — planned practices, site not yet built]
- Semantic page structure, visible labels, keyboard operation and visible focus are engineering requirements for the public site.
- Pages in Hebrew and English set the language and the text direction. Technical terms such as `ESP32` stay left-to-right.
- No CAPTCHA or puzzle on our side of the application flow.
- We do **not** use an accessibility overlay or widget.

## 5. Known limitations
Based on an internal review of a pre-public release (date: [DATE OF LAST REVIEW TBD]). As of that review, these were **not yet fixed**:

**Circuit editor**
- You cannot create wires between parts using the keyboard alone. Terminals are not reachable by keyboard, and there is no alternative yet.
- The connections of a circuit are not exposed to assistive technology. A screen-reader user can hear the list of parts but not how they are connected. A text alternative (a connections list) is planned but not yet available. Screen-reader support of the circuit canvas is not promised.
- Moving parts and panning require dragging, with no single-pointer alternative.

**Code editor**
- Tab inserts spaces. To leave the editor with the keyboard, press Escape and then Tab. This is not yet explained in the interface.
- Error locations are not announced to screen readers in full, and there is no next-error shortcut.

**Appearance and layout**
- The keyboard focus indicator has lower contrast than required on several surfaces.
- Some text, such as code line numbers, has insufficient contrast.
- The Lab needs a window at least 1024 pixels wide. Zooming in a lot, or a small screen, causes two-dimensional scrolling, and the Lab shows a "not supported on phones" note.
- Some small controls are below the minimum target size.

**Sign-in**
- Sign-in error pages are in English only, block pinch zoom, and hide the reason behind a control that cannot be used by keyboard. Fixing this is planned.

**Language**
- Some Hebrew text has display or terminology issues, for example a mixed-direction label and two different Hebrew terms for the same action.

This list is not complete, because the review did not cover everything (for example the in-Lab administration dialog and a step-by-step keyboard walk of the 3D view). **[TBD]** Keep this list in sync with the current status before publication, with fix dates only when real.

## 6. Third-party content [PROPOSED]
Sign-in uses Google account pages. These are run by Google and are outside our control. We use our own link to start sign-in, not Google's embedded button. **[LAWYER]** How to describe third-party parts under the regulations.

## 7. Alternatives and help
If you cannot use a part of the service, tell us. We will try to offer another way, for example help with an application by contact. **[TBD]** Exact alternatives, response time, and available formats.

## 8. Contact for accessibility
Accessibility contact: [CONTACT TBD] (name, phone, email, postal address). **[LAWYER]** Whether TBI must appoint a formal accessibility coordinator.
Response time: [TBD].

## 9. Date and updates
Date of this statement: [DATE TBD]. Date of last review: [DATE OF LAST REVIEW TBD]. We will update the statement after each relevant change.
