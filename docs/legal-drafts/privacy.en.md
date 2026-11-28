> **DRAFT — lawyer review required / טיוטה — נדרשת בדיקת עורך דין**
> This text is not in force, is not legal advice, and must not be published before review by a qualified Israeli lawyer. Items marked **[PROPOSED]** are not decided (the retention periods and data fields below are proposals pending owner and lawyer approval). Items marked **[LAWYER]** are open legal questions. Items marked **[TBD]** are placeholders.

# Privacy Notice — TBI Lab public site and Alpha application

## 1. Status of this text
This draft describes the data handling of the public site, sign-up and the invite-only Alpha. The descriptions were checked against the development code on 26 November 2026 (the email-confirmation parts on 28 November 2026), not against the running service. Three states are used:
- **In use:** part of today's public site or invite-only Alpha. Today you apply through a form on Google Forms.
- **Built, switched off:** in the code but not offered or not enabled by default. This includes our own sign-up page, email confirmation of sign-ups, automatic approval, usage-plan simulation limits, the idle timeout, the daily counters and the AI assistant.
- **To be confirmed:** depends on how the service is deployed, which the code alone does not show.

Existing Alpha testers are not migrated into the application database. **[PROPOSED]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the sign-up code has no application database; it stores each request as a file in a sign-up store.]**

## 2. Who is responsible
[COMPANY LEGAL NAME TBD], [REGISTRATION NUMBER TBD], [REGISTERED ADDRESS TBD]. Privacy contact: [CONTACT TBD]. **[LAWYER]** Whether a database registration, a privacy officer, or an EU/UK representative is required.

## 3. What we collect
### 3.1 Applying [PROPOSED]
**Today (in use):** you apply through a form on Google Forms, which includes the question "How did you hear about us?". Google stores the answers. **[TBD]** Check the full list of questions against the live form.

**Our own sign-up page (built, switched off)** sends us:
- your name;
- your email address, as you type it (there is no Google sign-in at this step);
- your role (student, maker or hobbyist, engineer or technician, teacher or instructor, other);
- the language of the page (Hebrew or English);
- your confirmation of consent, stored only as a yes value;
- optionally, how you heard about us: free text of up to 80 characters. Please do not write sensitive information in it.

We need the email only to approve you and add you to the access list.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the code also uses the email address to detect duplicate requests (a hash of it), sends it to Resend with the approval email, keeps it in the tester account record, and writes it to the sign-in log (sections 3.2, 6 and 8). With email confirmation (below, built, switched off), it also sends a confirmation email to the address and keeps further hashes of it.]**

The page also asks you to confirm that you are 18 or older, or that a parent approved your sign-up. This answer is checked in the browser and is not stored.

**Processing of sign-up requests on our server (built; whether it is running is to be confirmed):** for each request we store the details received, a request number, its status (pending, approved, rejected, approval email queued, sent or failed), times, the number of email attempts, an error type if something failed, and whether it came from our own page. We also keep a one-way fingerprint (hash) of the email address to detect duplicates, and a log of actions on requests (time, request number, action, result). The server code can also accept requests forwarded from the Google Form (name, email, role, language, consent).

To limit abuse, our sign-up service briefly uses your network address to count requests. It keeps that count in memory and does not store it with your request.

**Email confirmation of sign-ups (built, switched off).** With it switched on, our sign-up page and server also do the following:
- The form asks for the email address of your Google account. The sign-up code checks the form of the address, not that it belongs to a Google account.
- For a new request from our page we send a confirmation email through Resend. It has a general greeting, fixed text and a link, with no name or other detail from the form. The link works for 24 hours.
- The link carries a signed code made of the request number, a link number, an expiry time, a random value and a signature. It does not contain your email address. The code is in the part of the link after `#`, which the browser does not send to the server when it opens the page.
- The confirmation page removes the code from the address bar and sends it to our server only when you press the confirm button. If the request is still waiting for confirmation, the sign-up server then stores an empty marker file named with the request number and part of the code's hash, until it is processed.
- If you ask for a new link, the page sends the email address you type. A new link is considered only if a request from our page with that address is waiting for confirmation; the answer on screen is the same for every address. Sending the sign-up form again for such a request has the same effect.
- In a folder separate from the sign-up store, used by the administration service, we keep for each request: hashes of the link codes (not the codes), link numbers, expiry and sending times, an identifier of the signing key, the number of links, the time of confirmation, and one-way fingerprints (SHA-256 hashes) of the address each link was sent to, of the confirmed address and of the address an access account was added for. The request itself also records when a link was sent and when the address was confirmed.
- A confirmation counts only while the address in the request matches the confirmed one.
- To limit sending (by default in the code: 50 confirmation emails a day; for one address 3 in 7 days, at least 10 minutes apart; 5 per request, of which at most 3 unexpired), we keep a daily count and, per address hash, the sending times. Entries older than 7 days are removed only when a later confirmation email is prepared or the clean-up of unconfirmed requests runs, so they can stay longer. Where limits on all applicant emails are configured, we also keep sending times, without addresses; times older than 30 days are dropped when that record is next updated.
- As described above, the sign-up server briefly uses your network address, in memory, to limit confirmation and new-link requests.
- If automatic approval of confirmed requests is also switched on, a request from our page is approved automatically only after its address is confirmed. We can still approve a request manually.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: an unconfirmed request is deleted early only if a separate setting is configured (`TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS`, 1 to 90 days). The code has no default for it; the project runbook gives 7 days as an example. When set, it covers requests from our page created after the confirmation start time, counted from creation, checked about hourly (a request can be deleted up to an hour early); it does not run while confirmation emails are held because the email limits are missing, and it keeps a request whose confirmation state cannot be read. When not set, an unconfirmed request follows the 90-day limit in section 7. [TBD] Confirm the value to be used.]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the code stores consent only as a yes value, with no version or hash of the notice and no separate consent time (only the time the request was created); an earlier draft listed "records of the policy versions you agreed to, and when".]**

Providing these details is voluntary, but we cannot review an application without the required fields. **[LAWYER]** Confirm which fields must be marked mandatory.

### 3.2 Your tester account and use of the Lab (in use, details to be confirmed)
- When you sign in with Google, we receive your email address and your Google account identifier.
- The tester account record holds your email address, an optional display name (your name from the sign-up request, or one set by us), the Google account identifier, the account status, the date added, and the first sign-in, last sign-in, number of sign-ins and when the service last saw you. Disabling an account keeps this record.
- The Lab's services identify you by a pseudonymous code derived from your Google account identifier.
- We keep daily usage figures per tester: sign-ins, builds, firmware uploads, simulation runs, simulation time and refused requests. The administration screen reads up to 400 days. **[TBD]** Actual retention.
- Service logs record actions such as builds and runs, their result and the pseudonymous code.

### 3.3 Your projects, building code and running simulations (in use)
- Projects are saved in your browser's own storage (IndexedDB). The code has no server-side saving or synchronisation of projects. Clearing browser data can delete them. You can export a copy.
- Electrical simulation without a microcontroller runs in your browser.
- When you build `ESP32` code (Arduino or MicroPython), your source files and the list of libraries are sent to our server. The files are built in a temporary folder that is deleted after the build. The service also keeps a record of each recent build in memory, including the source code you submitted. By default in the code, a finished build's record is removed after 24 hours, but only when the next new build is submitted, so it can stay longer; a restart of the service clears it.
- We store the built firmware and the build result, linked to your pseudonymous code. The build messages may quote parts of your code. In the tester configuration in the code, the firmware and build result are removed after 30 days without use, or earlier to stay within a storage quota.
- Some configurations also let you upload a ready-made firmware file. It is stored for your account on the same terms. This option can be switched off.
- When you run a microcontroller simulation, the browser sends a technical description of the circuit, the pin connections and your commands (for example a button press) to our server. The session's temporary files are deleted when it ends.

### 3.4 Problem reports and feedback (optional; available only where switched on)
A report sends: your description (up to 1,000 characters), the type of report, and, depending on the type, the area, whether it blocks you or the name of a requested component; the interface language, the screen you were on, the app version, the simulation status and its error code, the session number, and your browser name, version and operating system. We add the time, the server version, the status of your own simulation session and your pseudonymous code. Technical details (runtime version, device type, project identifier) are included unless you clear that checkbox. Your project, circuit, code and screenshots are not attached. In the current code, reports are deleted after 90 days by default (the period is configurable).

### 3.5 Daily counters (built, switched off)
Counts per day of sign-up form openings, requests sent and requests approved. They hold a date, an event name and a number, with no personal details, and are kept for up to 400 days.

### 3.6 AI assistant (built, switched off)
If it is ever switched on, using it would send data about your open project to an outside AI provider after you agree: circuit data (components, values and connections), simulation results and checks, pin states and errors reported by a run, program information (board, language, file names and sizes, libraries), build status, compiler messages and detected features, and short excerpts of your source code around lines that an error or a check points to. In the code, comments and the contents of text strings are masked in these excerpts, and the project name and your identity are not included. **[TBD]** This notice must be extended before that.

## 4. What we do not collect
- no phone number, postal address or date of birth;
- no advertising pixels or trackers (including Facebook or Instagram pixels) **[PROPOSED]**;
- no third-party scripts and no CAPTCHA on the public site **[PROPOSED]**;
- no tracking identifiers in the "how you heard about us" answer.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the code shows only part of this. Our sign-up page has no field for a phone number, postal address or date of birth, but its free-text answer could contain anything you type, and the full Google Form question list has not been checked. Our own public pages load no third-party scripts and use no CAPTCHA, while the Google Form used today is a Google page. Our code adds no tracking identifier to the "how you heard about us" answer.]**

## 5. Why we use it
- to review applications and manage the limited places and the waiting list;
- to add approved people to the access list;
- to prevent duplicate applications and abuse;
- to keep proof of the terms and notices you accepted; **[לבדיקת עו"ד / FOR LAWYER REVIEW: the code keeps only a yes value, not which version was accepted.]**
- to secure and operate the service.

**[LAWYER]** Legal basis for each purpose (consent, contract, legitimate interest), and whether product-update messages will be sent. No outgoing email is planned in the first phase; the status is shown on a status page after sign-in. **[PROPOSED]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: in the sign-up code, an approval email is sent to you when your request is approved, and there is no status page. With email confirmation (section 3.1, built, switched off), a confirmation email is also sent before that.]**

## 6. Who sees it and who we share it with
- Google, for the application form used today and for sign-in to the Lab. Google's own terms and privacy policy apply to those parts.
- Resend, an email delivery service, in our sign-up processing: it receives your email address and the approval email, which may greet you by first name. With email confirmation (built, switched off), it also receives the confirmation email with its link; where confirmation is required for automatic approval, the approval email has a general greeting without your name.
- Telegram, a messaging service, for notices to ourselves. A new sign-up notice contains your name and role, not your email address. An optional summary mode (built, switched off) replaces these per-request notices with daily summaries and alerts made of counts and fixed text. The project documentation also describes notices about account changes (with a partly hidden email address) and about new problem reports (report number and category details, without your text). **[TBD]** Confirm which notices are active.
- Hosting and infrastructure providers **[HOSTING PROVIDER AND LOCATION TBD]**.
- The program owner reviews applications. Access to application data is limited to the owner. **[PROPOSED]**
- We do not sell your data and do not share it for advertising.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: in the code, the administration screens for application and account data are limited to the owner, but application data also reaches the services listed above (for example Google, Resend and Telegram), and server access depends on deployment. Automatic approval of applications is built but switched off.]**

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

**[לבדיקת עו"ד / FOR LAWYER REVIEW: there is no status page and no self-service withdraw or delete button. Deletion is on request: where sign-up administration is switched on, the administration screen can delete a stored sign-up request, which removes the request and its email fingerprint and leaves a log line with the request number only. While email confirmation is switched on, deletion also removes the request's confirmation state (section 3.1); if it has been switched off again, that state is not removed by this action. The address hashes in the sending-limit counts are not removed by it. It does not remove a tester account (disabling keeps the record), the Google Form answers, the Telegram notice or other copies; those need separate manual steps.]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the sign-up store deletes pending and rejected requests within 90 days of creation, and all other requests within 365 days of creation (both configurable to shorter periods). It has no withdrawn, expired or waitlisted status, so a request waiting for a place is deleted after 90 days, while the table says 12 months. An approved request is deleted within 365 days even if the account continues. It keeps no separate consent record, and the code never deletes the request action log. The table says otherwise on these points. A 365-day audit log and nightly backups could not be confirmed from the code; retention of backups and access logs: [TBD]. Google Form answers are not deleted by this code. With email confirmation, a request's confirmation state is removed with the request while confirmation is switched on, and unconfirmed requests may have a shorter period (section 3.1).]**

## 8. Logs
- The sign-in component writes an authentication log that **contains your email address** when you sign in. These logs are kept for 30 days. **[LAWYER]** Whether this is acceptable or the log format should drop the email (an engineering alternative under consideration).
- Its request log records your network address, browser identification, the requested address and the time. The configuration in the code leaves the sign-in return address (which carries sign-in codes) out of that log and filters out log lines that would contain those codes or cookies. **[TBD]** Confirm for the running service.
- The configuration prepared for our own sign-up page writes no web access log (built, not in use).
- Our web server logs redact sign-in codes, cookies and authorization headers.
- Our logs are meant not to contain free-text answers. **[PROPOSED]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the redaction statement matches a web server configuration in the repository (a deployment template, `deploy/dev-lab/g2/Caddyfile.g2-candidate`), not a checked running service. There, error log lines drop the sign-in code and state from the logged address, and the Cookie and Authorization headers. The sign-in callback log drops the same items and the Set-Cookie response header, and still records details such as the path and browser identification (User-Agent). The base configuration file (`deploy/dev-lab/Caddyfile`) has no such filter. [TBD] Confirm which configuration runs.]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: no 30-day limit is set by the code reviewed. Retention of access logs and backups: [TBD].]**

## 9. Cookies, browser storage and third parties
- The public pages need no cookies. **[PROPOSED]**
- When you sign in to the Lab, a strictly necessary sign-in session cookie is set. It is short-lived and not used for tracking. **[PROPOSED]** In the configuration in the code it lasts up to 8 hours. A second short-lived cookie (15 minutes) protects the sign-in step. **[TBD]** Confirm for the running service.
- The Lab also uses your browser's storage for your projects and for preferences and notices (for example display and sound settings).
- The Google Form and the Google account pages are run by Google, not by us.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: an earlier draft said the cookie is set after you choose to apply and lasts about one hour. In the code, our own sign-up page sets no cookie; the cookie is set at sign-in to the Lab and the configuration allows up to 8 hours.]**

## 10. Security
Planned measures **[PROPOSED]**: application data is stored in a dedicated database with restricted permissions, access is limited, and status changes are kept in an append-only history. We cannot guarantee absolute security. **[LAWYER]** Required security level under the Israeli Privacy Protection (Data Security) Regulations, 2017.

**What the sign-up code does today:** each request is stored as a separate file in a private folder with restricted permissions, and actions on requests are added to a log.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the code differs from the planned measures: there is no dedicated database and no full append-only status history for applications.]**

## 11. Your rights
Under Israeli law you may ask to see, correct or delete data we hold about you. Use the status page for withdrawal and deletion, or write to [CONTACT TBD]. **[לבדיקת עו"ד / FOR LAWYER REVIEW: there is no status page; withdrawal and deletion are by request only.]** **[LAWYER]** Response times and verification of identity. If you are in the EU or UK, further rights may apply. **[LAWYER]** Does GDPR or UK GDPR apply, given that recruitment is partly through social media?

## 12. International transfers
**[HOSTING LOCATION TBD]**. Google may process sign-in data outside Israel. **[LAWYER]**

**[לבדיקת עו"ד / FOR LAWYER REVIEW: data also goes to Resend and Telegram (section 6); their processing locations have not been checked.]**

## 13. Children
The Alpha is intended for adults. **[LAWYER]** Minimum age and handling of minors (for example students).

**[לבדיקת עו"ד / FOR LAWYER REVIEW: our own sign-up page also accepts a person under 18 who confirms that a parent approved; the confirmation is not stored. The draft says the Alpha is for adults.]**

## 14. Changes to this notice
Versions are kept with a number and a hash, and consent is recorded per version. **[PROPOSED]** **[LAWYER]** How to notify changes.

**[לבדיקת עו"ד / FOR LAWYER REVIEW: the code keeps no notice version or hash and does not record consent per version.]**

## 15. Contact
[CONTACT TBD]. Complaints may also be made to the Israeli Privacy Protection Authority. **[LAWYER]** Confirm wording.

---
Sections 3.2 to 3.6 describe use of the Lab as found in the code. **[LAWYER]** A separate section or notice is needed before the Alpha uses the public site. Decide whether sections 3.2 to 3.6 meet this or belong in a separate notice, and what legal basis, purposes and retention apply to them.
