# Alpha — native Hebrew review checklist (owner, O-6)

The automated journey (`app/e2e/s13-journey-real.spec.ts`) proves that switching language never
changes the project or a result, and that technical content stays left-to-right. What it cannot
judge is whether the Hebrew reads naturally and uses the right professional terms. Please review
on https://dev-lab.tbi-tech.net/ (after the hardening deploy) with the language set to עברית, and
note the screen, the text and the suggested wording.

| # | Screen / surface | What to check |
|---|---|---|
| 1 | Projects screen, examples list | example names and descriptions, "new project", import |
| 2 | Editor top bar, application menu | menu items, including **"מה רץ על ה־ESP32"** |
| 3 | **"מה רץ על ה־ESP32" panel** (new) | the intro, the four section titles, every facility name and explanation, the timing contract items (µs units, "ליבה 0"), the service limits |
| 4 | Palette | part names (HC-SR04, DHT22, LCD keep their technical names), the refusal notes and the "מה רץ על ה־ESP32?" link |
| 5 | Inspector | parameter names, "סביבה מדומה", **"מגבלות המודל"** (new) for every part |
| 6 | Run errors | runtime busy, quotas, unsupported features and parts |
| 7 | Warnings (new wording) | "עלול להינזק" (damage, absolute maximum), **"מחוץ לתנאי ההפעלה המוגדרים"** with its two notes: within the absolute maximum, and "לא פורסם סף נזק … הסיכון אינו ידוע, אך אינו אפס" |
| 8 | ESP32 pin warnings | "הנעה טיפוסית", "אינם מוגדרים ל־5 V" |
| 9 | Code editor, serial monitor | stay left-to-right; numbers and units correct |
| 10 | 3D view and schematic | tab names, notes; identifiers (R1, IO2) left-to-right |

Terminology rule (CLAUDE.md): GPIO, PWM, I2C, Pull-up, Flyback, LCD stay in English where that is
the natural professional usage.
