> **DRAFT — lawyer review required / טיוטה — נדרשת בדיקת עורך דין**
> This text is not in force, is not legal advice, and must not be published before review by a qualified Israeli lawyer. Items marked **[PROPOSED]** are not decided (the retention periods and data fields below are proposals pending owner and lawyer approval). Items marked **[LAWYER]** are open legal questions. Items marked **[TBD]** are placeholders.

# Privacy Notice — TBI Lab public site and Alpha application

## 1. Status of this text
This draft describes the **planned** application flow for the Alpha. The application service does not exist yet, so the data below is what we intend to collect, not what we collect today. Existing Alpha testers are not migrated into the application database. **[PROPOSED]**

## 2. Who is responsible
[COMPANY LEGAL NAME TBD], [REGISTRATION NUMBER TBD], [REGISTERED ADDRESS TBD]. Privacy contact: [CONTACT TBD]. **[LAWYER]** Whether a database registration, a privacy officer, or an EU/UK representative is required.

## 3. What we collect (application) [PROPOSED]
When you apply with Google:
- a pseudonymous identifier derived from your Google account (it does not contain your email);
- your email address as asserted by Google, and whether Google marked it verified. We need the email only to approve you and add you to the access list;
- a one-way tag derived from the email, used to detect duplicates;
- your display name;
- your language (Hebrew or English);
- your role (student, hobbyist, engineer, educator, other) and experience level (none, basic, intermediate, advanced), chosen from lists;
- your interests, chosen from a list;
- optionally, a short free-text motivation (up to 500 characters). Please do not write sensitive information in it;
- optionally, how you heard about us (Facebook, Instagram, a friend, other);
- the status of your application and its history (submitted, waitlisted, approved, rejected, withdrawn, expired), with a reason code;
- records of the policy versions you agreed to, and when.

Providing these details is voluntary, but we cannot review an application without the required fields. **[LAWYER]** Confirm which fields must be marked mandatory.

## 4. What we do not collect
- no phone number, postal address or date of birth;
- no advertising pixels or trackers (including Facebook or Instagram pixels) **[PROPOSED]**;
- no third-party scripts and no CAPTCHA on the public site **[PROPOSED]**;
- no tracking identifiers in the "how you heard about us" answer.

## 5. Why we use it
- to review applications and manage the limited places and the waiting list;
- to add approved people to the access list;
- to prevent duplicate applications and abuse;
- to keep proof of the terms and notices you accepted;
- to secure and operate the service.

**[LAWYER]** Legal basis for each purpose (consent, contract, legitimate interest), and whether product-update messages will be sent. No outgoing email is planned in the first phase; the status is shown on a status page after sign-in. **[PROPOSED]**

## 6. Who sees it and who we share it with
- Google, for sign-in. Google's own privacy policy applies to that part.
- Hosting and infrastructure providers **[HOSTING PROVIDER AND LOCATION TBD]**.
- The program owner reviews applications. Access to application data is limited to the owner. **[PROPOSED]**
- We do not sell your data and do not share it for advertising.

**[LAWYER]** Processor agreements and any disclosure duties.

## 7. How long we keep it and how to delete it [PROPOSED]
| Data | Proposed retention |
|---|---|
| Rejected, withdrawn or expired applications | Personal details removed after 90 days. Status-history rows are kept without personal details. |
| Waitlisted applications | Expire after 12 months, with a notice on the status page. Then treated as expired. |
| Approved applications | A minimal link to the tester record is kept for as long as the tester account exists. |
| Consent records | Kept as long as needed to prove consent. **[LAWYER]** Period. |
| Approval audit records | Kept in an administrative audit log for 365 days. |
| Backups | **[BACKUP RETENTION TBD]** Application data is backed up nightly. |

You can withdraw your application and delete your application data at any time with a button on the status page. After deletion, your identity record is reduced to a marker with no personal details. **[PROPOSED]**

## 8. Logs
- Our sign-in component writes an authentication log that **contains your email address** each time you sign in. These logs are kept for 30 days. **[LAWYER]** Whether this is acceptable or the log format should drop the email (an engineering alternative under consideration).
- Our web server logs redact sign-in codes, cookies and authorization headers.
- Our logs are meant not to contain free-text answers. **[PROPOSED]**

## 9. Cookies and third parties
- The public pages need no cookies. **[PROPOSED]**
- After you choose to apply, a strictly necessary sign-in session cookie is set. It is short-lived and not used for tracking. **[PROPOSED]** (about one hour)
- The Google account pages are run by Google, not by us.

## 10. Security
Planned measures **[PROPOSED]**: application data is stored in a dedicated database with restricted permissions, access is limited, and status changes are kept in an append-only history. We cannot guarantee absolute security. **[LAWYER]** Required security level under the Israeli Privacy Protection (Data Security) Regulations, 2017.

## 11. Your rights
Under Israeli law you may ask to see, correct or delete data we hold about you. Use the status page for withdrawal and deletion, or write to [CONTACT TBD]. **[LAWYER]** Response times and verification of identity. If you are in the EU or UK, further rights may apply. **[LAWYER]** Does GDPR or UK GDPR apply, given that recruitment is partly through social media?

## 12. International transfers
**[HOSTING LOCATION TBD]**. Google may process sign-in data outside Israel. **[LAWYER]**

## 13. Children
The Alpha is intended for adults. **[LAWYER]** Minimum age and handling of minors (for example students).

## 14. Changes to this notice
Versions are kept with a number and a hash, and consent is recorded per version. **[PROPOSED]** **[LAWYER]** How to notify changes.

## 15. Contact
[CONTACT TBD]. Complaints may also be made to the Israeli Privacy Protection Authority. **[LAWYER]** Confirm wording.

---
Not covered here: privacy of using the Lab itself (projects, usage data). **[LAWYER]** A separate section or notice is needed before the Alpha uses the public site.
