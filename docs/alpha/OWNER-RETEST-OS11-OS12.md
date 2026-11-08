# Owner retest: OS-11 (sign-in recovery) and OS-12 (example search)

**Where:** `https://dev-lab.tbi-tech.net`, desktop Chrome. The version at the bottom right must read **`71b40fb`**. If it doesn't, this release is not deployed yet.

**Before you start:** if you want a backup, export one project (Projects → Export). Nothing here should touch your projects.

**Privacy:** never paste a URL that contains `code=` or `state=`, or any cookie value, into a report or a chat. A screenshot of the page is enough.

OS-11 and OS-12 stay **open** until you sign below.

## OS-11: sign-in

### 1. Expired-session recovery (the reported problem)

1. Sign in normally and open a project. Make a small change (e.g. rename it).
2. Simulate an expired sign-in. You don't need to wait 8 hours:
   1. Press F12, then open **Application → Storage → Cookies → `https://dev-lab.tbi-tech.net`**.
   2. Right-click **`__Host-tbi_dev_lab`** → Delete. Leave the `…_csrf` cookies alone.
   3. Close DevTools.
3. Switch to another window, then back to the TBI Lab tab. Within a second or two, a yellow banner must appear: **"Your sign-in has expired. Your projects are saved in this browser. Sign in again to continue."** (Hebrew: "תוקף ההתחברות פג…").
4. Press **Sign in again**.
5. Google's account chooser appears; choose your account.

**Expected:**
- You end on **the app**: the address is **not** `/oauth2/callback`.
- There is no 403 page.
- Your project and the change from step 1 are there.

### 2. Background requests do not start a login

1. Repeat step 1.2 (delete the session cookie). Keep DevTools open on **Network**, filtered by `version.json`.
2. Switch windows and back, a few times.

**Expected:**
- Each `version.json` request shows status **401**.
- Its response headers have **no** `set-cookie`.
- There is **no** request to `accounts.google.com`.
- Under **Application → Cookies**, **no** new `__Host-tbi_dev_lab_csrf` cookie appears until you press **Sign in again**.

### 3. Several tabs (gate change G1, live since 2026-10-13 11:40 UTC)

1. Open the app in **two tabs** and delete the session cookie (step 1.2). Both tabs show the banner once you switch to them.
2. Press **Sign in again** in tab A, then **immediately** in tab B, **before** finishing Google in either.
3. Finish Google in tab A, then in tab B.

**Expected:**
- **Both** tabs end in the app, signed in. No 403 page.
- Under **Application → Cookies** you may see cookies named `__Host-tbi_dev_lab_…_csrf` (one per sign-in in progress); they disappear when each sign-in finishes or after 15 minutes.

If a 403 appears anyway, note the time (not the URL) and report it: that would be a G1 regression.

### 4. A stale callback

After a successful sign-in, press the browser's **Back** button until you would reach the sign-in pages.

**Expected:** you are never left on an error page with no way out. If a 403 page appears, its **Sign in** link starts a fresh sign-in that ends in the app.

## OS-12: examples on the Projects screen

### 5. Search, in English and Hebrew

On **Projects → Start from an example**, check each query against what should appear:

| Interface | Type | Expected |
|---|---|---|
| English | `ESP32 LCD` | exactly **one** card (the LCD example); "Showing 1 of 22 examples" |
| English | `LDR` | the light-sensor examples |
| English | `PIR` | the motion examples |
| English | `HC-SR04` (also `hcsr04`) | the distance alarm |
| English | `I2C` | the LCD example |
| English | `ממסר` (Hebrew, in the English UI) | the relay examples |
| Hebrew (language menu) | `חיישן` | all seven sensor examples |
| Hebrew | `ESP32 LCD` (English, in the Hebrew UI) | the LCD example |
| Hebrew | `zzz` | an empty-state message and **ניקוי הסינון** (clear filters) |

**Also expected:**
- Results change as you type, with no page reload.
- In Hebrew the layout is right-to-left, and nothing scrolls sideways.

### 6. Categories

1. Click **Sensors**: only sensor examples; the button shows a check mark.
2. Also click **Controllers and programming**: the list **grows**. Categories add up; they never hide what is already shown.
3. Click **Basic circuits**, then type `ESP32`: an empty state (no basic circuit uses the ESP32).
4. Press **Clear filters**: all 22 examples are back, and the cursor is in the search field.
5. **Keyboard only:** click into the search field, press **Tab** to reach the first category, **Space** to toggle it, Tab/Shift+Tab to move.

**Expected:** a visible focus outline on each control.

### 7. Opening a filtered example

1. Type `HC-SR04`, then press **Open example** on the card.

**Expected:** the example opens as a new project in the editor, exactly as before.

## Gate G1 security checks (real Google accounts)

### 8. The gate still refuses what it must

1. **Not on the allowlist** (only if you have a second Google account that is NOT allowed): in a private window, open the app and choose that account. **Expected:** a 403 page, and the app never loads.
2. **Replay:** after a successful sign-in, copy nothing; press **Back** until the browser revisits the Google step, then **Forward**. **Expected:** you are either still in the app or see a 403 whose **Sign in** link works; you are never signed in as anyone else.
3. **Normal sign-in still works:** close all tabs, delete the session cookie, open the app once. **Expected:** one Google account chooser, then the app.

## Sign-off

| Item | Result (pass / fail + note) |
|---|---|
| 1 Expired-session recovery | |
| 2 Background requests | |
| 3 Several tabs, at the same time (G1) | |
| 4 Stale callback | |
| 5 Search EN/HE | |
| 6 Categories and keyboard | |
| 7 Opening a filtered example | |
| 8 Gate refusals (allowlist, replay, normal sign-in) | |

Owner: ______________________ Date: ____________
