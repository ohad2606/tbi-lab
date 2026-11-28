> **DRAFT — lawyer review required / טיוטה — נדרשת בדיקת עורך דין**
> This text is not in force and must not be published before review by an Israeli accessibility specialist or lawyer. It does **not** claim that any site or product conforms to any standard. Items marked **[LAWYER]** are open legal questions. Items marked **[TBD]** are placeholders.

# Accessibility Statement — TBI Lab

## 1. Status of this text
This draft is for the future public site. It will be updated before publication so that it reflects the site as it actually is on that day.

## 2. Our commitment and target
We aim to build the public site and the Lab to **WCAG 2.2 level AA**. We also aim to meet the Israeli standard **IS 5568** at level AA. **[LAWYER]** Which edition of IS 5568 and which WCAG base to cite, and the legal duties that apply to TBI (including any exemption).

A target is not a result. **We do not claim that the site or the Lab conforms to WCAG 2.2 AA or to IS 5568.**

## 3. Current conformance status
- The public site: **[NOT YET REVIEWED]**. Its code (Hebrew and English pages) exists and has automated checks: axe-core, page language and text direction, keyboard order (checked on the English home page) and skip link, and reflow at a width of 320 pixels. It has not had an independent audit and has not been tested with screen readers. Our own sign-up page is built but switched off in the current code. **[TBD]** Which version of the site is published on the date of this statement.
- The Lab (the engineering workspace): partly accessible, with significant known gaps listed below.
- Automated checks cover only part of the requirements. They do not prove conformance.
- We have not yet verified behaviour with screen readers such as NVDA, JAWS, VoiceOver or TalkBack. **[TBD]** Which assistive technologies and browsers will be tested.
- An independent expert review is planned before the public launch. **[PROPOSED]**

## 4. What we do [PROPOSED — practices to be confirmed before publication]
- Semantic page structure, visible labels, keyboard operation and visible focus are engineering requirements for the public site.
- Pages in Hebrew and English set the language and the text direction. Technical terms such as `ESP32` stay left-to-right.
- Our own sign-up page (not yet switched on) uses no CAPTCHA or puzzle.
- We do **not** use an accessibility overlay or widget.

## 5. Known limitations
Based on an internal review of a pre-public release and a later check of the current development code and its automated tests (date: [DATE OF LAST REVIEW TBD]). The published version may differ. **[TBD]** Confirm against the published version. As of that check, these limitations and open checks **remain**:

**Circuit editor and other views**
- You can create, select, delete and reconnect wires with the keyboard, and a "Wires" list lets you select a wire. A new wire made with the keyboard starts at a part's pin. Moving the end of an existing wire with the keyboard can only move it to a pin. A single segment of a wire's route can be moved one grid step at a time with buttons in Properties.
- An existing wire junction can be selected in a "Junctions" list, moved with the Move buttons in Properties, and deleted. The arrow keys move a selection only while the circuit view has focus. Adding bends while drawing a wire requires a pointer.
- A "Connections (text list)" panel lists the parts and which pins are connected together. It does not announce changes to the connections. This panel, keyboard wiring, the "Junctions" list and the controls for moving a wire segment have not been tested with screen readers. Screen-reader support of the circuit drawing itself is not promised.
- A selected part can be moved without dragging: with the arrow keys while the circuit view has focus, or one grid step per click with the Move buttons in Properties. The same Move buttons move several selected parts and junctions together; wires alone may not move. Several items can be selected without dragging: in the circuit view, Shift+Enter on a focused part, Ctrl+A (Cmd+A) for everything, or the "Select several items" button. While several-selection is on, the buttons in the "Wires" and "Junctions" lists add a particular wire or junction to the selection or take it out. By keyboard, parts can be added or removed one at a time in the circuit view, and wires and junctions one at a time through those lists; Ctrl+A (Cmd+A) takes every part, wire and junction. This has not been tested with screen readers.

**Code editor**
- When a build fails, the list of errors and their line numbers is not announced automatically to screen readers. Moving to an error does not announce the line, and there is no next-error shortcut.

**Appearance and layout**
- The keyboard focus indicator and the colour of the code line numbers were changed to improve contrast. Our automated checks measure them on selected controls and screens only. We have not checked the contrast of every text, control border and state; some button and field borders are faint.
- The Lab is built for windows at least 1024 pixels wide. Zooming in a lot, or a small screen, can cause two-dimensional scrolling. The Lab then shows a note asking for a wider window, or saying that phones and screens this small are not supported, even when the cause is zoom.
- Some small controls are below the minimum target size, for example the button that removes a measurement probe. We have not measured every control.

**Sign-in**
- Sign-in error pages are in English only, block pinch zoom, and hide the reason behind a control that cannot be used by keyboard. Fixing this is planned. These pages are outside the Lab's code and were not re-checked after the internal review.

**Language**
- Some Hebrew screens have display or terminology issues. For example, in the code view the name `Arduino C++` and the Hebrew message in the empty serial output have no text direction of their own and may display in the wrong order, and two different Hebrew labels are used for the Build action.

This list is not complete, because the checks did not cover everything (for example the in-Lab administration dialog and a step-by-step keyboard walk of the 3D view). **[TBD]** Keep this list in sync with the current status before publication, with fix dates only when real.

## 6. Third-party content [PROPOSED]
Sign-in uses Google account pages. These are run by Google and are outside our control. We use our own link to start sign-in, not Google's embedded button. **[LAWYER]** How to describe third-party parts under the regulations.

## 7. Alternatives and help
If you cannot use a part of the service, tell us. We will try to offer another way, for example help with an application by contact. **[TBD]** Exact alternatives, response time, and available formats.

## 8. Contact for accessibility
Accessibility contact: [CONTACT TBD] (name, phone, email, postal address). **[LAWYER]** Whether TBI must appoint a formal accessibility coordinator.
Response time: [TBD].

## 9. Date and updates
Date of this statement: [DATE TBD]. Date of last review: [DATE OF LAST REVIEW TBD]. We will update the statement after each relevant change.
