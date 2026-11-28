> **DRAFT — lawyer review required / טיוטה — נדרשת בדיקת עורך דין**
> None of these texts is in force. Do not publish before review by an Israeli lawyer (and an accessibility specialist for the statement).

# Legal drafts for the future TBI Lab public site

Hebrew and English drafts with the same structure (same numbered headings). Technical tokens (`ESP32`, WCAG, IS 5568) stay left-to-right. When rendering the Hebrew files, set `lang="he"` and `dir="rtl"` on the page.

| Document | English | Hebrew |
|---|---|---|
| Terms of Use (Alpha) | [terms.en.md](terms.en.md) | [terms.he.md](terms.he.md) |
| Privacy Notice | [privacy.en.md](privacy.en.md) | [privacy.he.md](privacy.he.md) |
| Accessibility Statement | [accessibility-statement.en.md](accessibility-statement.en.md) | [accessibility-statement.he.md](accessibility-statement.he.md) |

## Markers
- **[PROPOSED]** a proposal, not decided (the data fields, retention periods, no ad pixels, self-delete).
- **[LAWYER]** an open legal question.
- **[לבדיקת עו"ד / FOR LAWYER REVIEW: ...]** the code and the draft wording differ on a promise, a right or a legal choice. Both are stated; neither was chosen.
- **[TBD]** a placeholder to fill. No company details, contact, dates or hosting facts have been invented.

## Placeholders
`[COMPANY LEGAL NAME TBD]`, `[REGISTRATION NUMBER TBD]`, `[REGISTERED ADDRESS TBD]`, `[CONTACT TBD]`, `[HOSTING PROVIDER AND LOCATION TBD]`, `[BACKUP RETENTION TBD]`, `[GOVERNING LAW AND COURT TBD]`, `[DATE TBD]`, `[DATE OF LAST REVIEW TBD]`, `[NOT YET REVIEWED]`, and the limitation-of-liability text.

## Open questions for a lawyer
1. Privacy: is the proposed field set, purpose and legal basis acceptable under the Protection of Privacy Law as amended (Amendment 13)? Is a database registration, privacy officer or representative needed?
2. Retention: the draft table says 90 days for rejected/withdrawn/expired and 12 months for the waitlist; the code deletes pending and rejected requests within 90 days and others within 365 days. Also: consent records, build and report data, usage figures, access logs and backups.
3. The sign-in log contains the email for 30 days: acceptable with notice, or must the log format drop it?
4. Do GDPR or UK GDPR apply, given recruitment through Facebook and Instagram?
5. Minors and minimum age (students).
6. Terms: disclaimer and liability limits valid under Israeli law (including consumer law), licence, user content, governing law and court.
7. Is a published criteria list or duty to give reasons for rejecting applicants needed?
8. Accessibility: which IS 5568 edition and WCAG base to cite; applicable duties and exemptions; whether a formal coordinator is required; how to describe third-party (Google) parts.
9. Use of the Lab (accounts, usage figures, builds, simulations, reports) is now described factually in the Privacy Notice, sections 3.2 to 3.6; its legal basis, purposes, retention and placement are not drafted.

## Accuracy notes
- The data and behaviour descriptions in the Privacy Notice and the related notes in the Terms were checked on 2026-11-26 (the sign-up email-confirmation parts on 2026-11-28) against the development code and project documentation, not against the running service. Items marked [TBD] depend on deployment. Our own sign-up page and its email confirmation are built but switched off.
- The data fields, the retention table, the no-pixel rule and the 30-day sign-in log are proposals from earlier planning; the code does not set the 30-day limit.
- Access-log and backup retention: [TBD].
- The accessibility statement lists known limits from an internal review, updated on 2026-11-26 against the current development code and its tests (automated tests were read, not a new manual or screen-reader review). It makes no conformance claim and its date fields are still [TBD]. The listed limits must be re-checked against the published product at publication time.
