/**
 * All public-site copy, one object per language. Templates (build.mjs) only look keys up; they
 * never branch on the language. `[[TOKEN]]` marks a technical token that is rendered dir="ltr".
 * Page shape: { title, description, h1, lead?, sections: [{ id, h, p?: [], ul?: [] }] }.
 * Honest scope: every capability named here comes from docs/product/V1-PRODUCT-SCOPE.md.
 * No legal text lives here: privacy, terms and accessibility statement are placeholders.
 */
export const LANGS = ['he', 'en'];
export const DEFAULT_LANG = 'he';
export const PAGES = ['home', 'product', 'alpha', 'faq', 'privacy', 'terms', 'accessibility'];
export const NAV_PAGES = ['home', 'product', 'alpha', 'faq'];
export const FOOTER_PAGES = ['privacy', 'terms', 'accessibility'];

const en = {
  lang: 'en',
  dir: 'ltr',
  langName: 'English',
  siteName: 'TBI Lab',
  brand: 'TBI',
  logoAlt: 'TBI Lab logo',
  descriptor: 'Electronics Engineering Workspace',
  descriptorLang: 'en',
  skip: 'Skip to main content',
  navLabel: 'Main',
  footerLabel: 'Legal and contact',
  switchLabel: 'Language',
  switchTo: 'עברית',
  switchToLang: 'he',
  navNames: { home: 'Home', product: 'Product', alpha: 'Alpha program', faq: 'FAQ' },
  footerNames: {
    privacy: 'Privacy',
    terms: 'Terms',
    accessibility: 'Accessibility statement',
  },
  contactLabel: 'Contact',
  contact: '[contact details to be added at publication]',
  applyPending: 'Apply for Alpha (applications open soon)',
  applyHint: 'Applications are not open yet. This link explains how applying will work.',
  desktopNote: 'Desktop or tablet required (screen width of at least 1024 px).',
  draftNote: 'Draft — will be published after legal review',
  companyLine: 'Company: [COMPANY LEGAL NAME TBD]',
  pages: {
    home: {
      title: 'TBI Lab — Electronics Engineering Workspace',
      description:
        'TBI Lab is an electronics engineering workspace in the browser: build circuits, write [[ESP32]] firmware, build and run it. Early access program, limited cohort.',
      h1: 'TBI Lab',
      lead: 'Electronics Engineering Workspace',
      sections: [
        {
          id: 'what',
          h: 'What it is',
          p: [
            'TBI Lab is a laboratory in the browser. You build a DC circuit, power it from a laboratory power supply, run it and see voltages and currents that come from a real solver, not from an animation.',
            'You can add a classic [[ESP32]] DevKit to the circuit, write firmware for it in Arduino C++ or MicroPython, build it and run it in the browser against your circuit.',
          ],
        },
        {
          id: 'who',
          h: 'Who it is for',
          p: [
            'Students, teachers, makers and technicians at beginner and intermediate level. It is not a replacement for professional PCB or CAD suites.',
          ],
        },
        {
          id: 'platform',
          h: 'What you need',
          ul: [
            'Desktop or tablet required (screen width of at least 1024 px).',
            'A Chromium-family desktop browser.',
            'Hebrew and English interface.',
          ],
        },
        {
          id: 'status',
          h: 'Early access',
          p: [
            'TBI Lab is in an early access program with a limited cohort. Applications are not open yet. Read how the program works on the Alpha program page.',
          ],
        },
      ],
    },
    product: {
      title: 'Product — TBI Lab',
      description:
        'What TBI Lab does today: DC circuits, a classic [[ESP32]], build and run in the browser, Hebrew and English.',
      h1: 'Product',
      lead: 'What the workspace does, and what it deliberately does not.',
      sections: [
        {
          id: 'circuits',
          h: 'Circuits',
          ul: [
            'A schematic workspace with standard symbols: place, move, rotate, wire, undo and redo.',
            'DC operating point and limited time-domain simulation of capacitor circuits, with the results shown next to the circuit.',
            'A laboratory power supply with voltage setpoint and current limit.',
            'When something cannot be modeled reliably, the workspace says so instead of showing a made-up result.',
          ],
        },
        {
          id: 'esp32',
          h: 'Microcontroller',
          ul: [
            'The original ([[classic]]) [[ESP32]] DevKit with its real pin names, for example [[GPIO2]] and [[3V3]]. Other ESP32 variants are not supported.',
            'Firmware in Arduino C++ or MicroPython; the build runs on a service and the firmware runs against your circuit.',
            'Serial output is shown in a read-only monitor.',
          ],
        },
        {
          id: 'projects',
          h: 'Projects and languages',
          ul: [
            'Projects are saved in your browser as you work.',
            'The interface is available in Hebrew and English. Switching language never changes the circuit.',
            'Keyboard and mouse are both first-class ways to work.',
          ],
        },
        {
          id: 'limits',
          h: 'Limits',
          ul: [
            'Desktop or tablet only (at least 1024 px wide); no phone interface.',
            'Building and running firmware needs a connection to the service; editing a circuit does not.',
            'No PCB design and no AC simulation.',
          ],
        },
      ],
    },
    alpha: {
      title: 'Alpha program — TBI Lab',
      description:
        'The TBI Lab early access program: a limited cohort, free of charge, no service level, data may be reset.',
      h1: 'Alpha program',
      lead: 'Early access for a limited group of testers.',
      sections: [
        {
          id: 'terms',
          h: 'What the Alpha is',
          ul: [
            'A limited cohort of testers.',
            'Free of charge.',
            'No SLA: the service can be slow, unavailable or change without notice.',
            'Data may be reset: projects stored in the service, and possibly in your browser, can be lost. Keep your own copies.',
            'Testers are expected to report problems and give feedback.',
          ],
        },
        {
          id: 'selection',
          h: 'How selection works',
          ul: [
            'Applying does not give access.',
            'Applications are reviewed manually.',
            'Places are limited, and you may be placed on a waiting list.',
            'Only approved accounts can sign in to the Lab.',
          ],
        },
        {
          id: 'how-to-apply',
          h: 'How to apply',
          p: [
            'Applications are not open yet. There is no form on this site and nothing to send yet.',
            'When applications open, this page will explain the steps. Until then, please check back later.',
          ],
        },
      ],
    },
    faq: {
      title: 'FAQ — TBI Lab',
      description: 'Short answers about TBI Lab and the Alpha program.',
      h1: 'Frequently asked questions',
      sections: [
        {
          id: 'q-free',
          h: 'Is it free?',
          p: ['The Alpha program is free of charge.'],
        },
        {
          id: 'q-access',
          h: 'If I apply, do I get access?',
          p: [
            'No. Applying does not give access. Applications are reviewed manually, places are limited and a waiting list is possible. Only approved accounts can sign in.',
          ],
        },
        {
          id: 'q-device',
          h: 'Can I use it on a phone?',
          p: ['No. Desktop or tablet is required (screen width of at least 1024 px).'],
        },
        {
          id: 'q-board',
          h: 'Which boards are supported?',
          p: ['The original [[ESP32]] DevKit (classic). Other ESP32 variants are not supported.'],
        },
        {
          id: 'q-data',
          h: 'Is my work safe?',
          p: [
            'Projects are saved in your browser while you work. During the Alpha, data may be reset, so keep your own copies of anything important.',
          ],
        },
        {
          id: 'q-lang',
          h: 'Which languages are available?',
          p: ['Hebrew and English.'],
        },
      ],
    },
    privacy: {
      title: 'Privacy — TBI Lab',
      description: 'Privacy policy placeholder.',
      h1: 'Privacy',
      sections: [],
    },
    terms: {
      title: 'Terms — TBI Lab',
      description: 'Terms placeholder.',
      h1: 'Terms',
      sections: [],
    },
    accessibility: {
      title: 'Accessibility statement — TBI Lab',
      description: 'Accessibility statement placeholder.',
      h1: 'Accessibility statement',
      sections: [],
    },
  },
};

const he = {
  lang: 'he',
  dir: 'rtl',
  langName: 'עברית',
  siteName: 'TBI Lab',
  brand: 'TBI',
  logoAlt: 'הלוגו של TBI Lab',
  descriptor: 'Electronics Engineering Workspace',
  descriptorLang: 'en',
  skip: 'דילוג לתוכן הראשי',
  navLabel: 'ראשי',
  footerLabel: 'משפטי ויצירת קשר',
  switchLabel: 'שפה',
  switchTo: 'English',
  switchToLang: 'en',
  navNames: { home: 'דף הבית', product: 'המוצר', alpha: 'תוכנית אלפא', faq: 'שאלות נפוצות' },
  footerNames: {
    privacy: 'פרטיות',
    terms: 'תנאי שימוש',
    accessibility: 'הצהרת נגישות',
  },
  contactLabel: 'יצירת קשר',
  contact: '[פרטי יצירת קשר יתווספו בעת הפרסום]',
  applyPending: 'הגשת מועמדות לאלפא (ההרשמה תיפתח בקרוב)',
  applyHint: 'ההרשמה עדיין לא נפתחה. הקישור מסביר איך ההגשה תעבוד.',
  desktopNote: 'נדרש מחשב שולחני או טאבלט (רוחב מסך של 1024 פיקסלים לפחות).',
  draftNote: 'טיוטה — תפורסם לאחר בדיקה משפטית',
  companyLine: 'החברה: [COMPANY LEGAL NAME TBD]',
  pages: {
    home: {
      title: 'TBI Lab — Electronics Engineering Workspace',
      description:
        'TBI Lab הוא סביבת עבודה להנדסת אלקטרוניקה בדפדפן: בונים מעגלים, כותבים קושחה ל-[[ESP32]], בונים ומריצים. תוכנית גישה מוקדמת, קבוצה מוגבלת.',
      h1: 'TBI Lab',
      lead: 'Electronics Engineering Workspace',
      sections: [
        {
          id: 'what',
          h: 'מה זה',
          p: [
            'TBI Lab הוא מעבדה בדפדפן. בונים מעגל זרם ישר, מזינים אותו ממקור מתח מעבדתי, מריצים ורואים מתחים וזרמים שמגיעים מפותר אמיתי ולא מאנימציה.',
            'אפשר להוסיף למעגל לוח [[ESP32]] DevKit קלאסי, לכתוב לו קושחה ב-Arduino C++ או ב-MicroPython, לבנות אותה ולהריץ אותה בדפדפן מול המעגל שלכם.',
          ],
        },
        {
          id: 'who',
          h: 'למי זה מיועד',
          p: [
            'סטודנטים, מורים, יוצרים וטכנאים ברמת מתחילים ומתקדמים-בינוניים. זה לא תחליף לסביבות מקצועיות לתכנון מעגלים מודפסים.',
          ],
        },
        {
          id: 'platform',
          h: 'מה צריך',
          ul: [
            'נדרש מחשב שולחני או טאבלט (רוחב מסך של 1024 פיקסלים לפחות).',
            'דפדפן שולחני ממשפחת Chromium.',
            'ממשק בעברית ובאנגלית.',
          ],
        },
        {
          id: 'status',
          h: 'גישה מוקדמת',
          p: [
            'TBI Lab נמצא בתוכנית גישה מוקדמת עם קבוצה מוגבלת. ההרשמה עדיין לא נפתחה. איך התוכנית עובדת מוסבר בעמוד תוכנית אלפא.',
          ],
        },
      ],
    },
    product: {
      title: 'המוצר — TBI Lab',
      description:
        'מה TBI Lab עושה היום: מעגלי זרם ישר, [[ESP32]] קלאסי, בנייה והרצה בדפדפן, עברית ואנגלית.',
      h1: 'המוצר',
      lead: 'מה סביבת העבודה עושה, ומה היא בכוונה לא עושה.',
      sections: [
        {
          id: 'circuits',
          h: 'מעגלים',
          ul: [
            'סביבת סכמה עם סמלים סטנדרטיים: הצבה, הזזה, סיבוב, חיווט, ביטול וחזרה.',
            'נקודת עבודה בזרם ישר וסימולציה מוגבלת בזמן של מעגלי קבלים, עם התוצאות לצד המעגל.',
            'מקור מתח מעבדתי עם הגדרת מתח והגבלת זרם.',
            'כשאי אפשר לדגום משהו באופן אמין, הסביבה אומרת זאת במקום להציג תוצאה מומצאת.',
          ],
        },
        {
          id: 'esp32',
          h: 'מיקרו-בקר',
          ul: [
            'לוח [[ESP32]] DevKit המקורי ([[classic]]) עם שמות הפינים האמיתיים, למשל [[GPIO2]] ו-[[3V3]]. גרסאות ESP32 אחרות אינן נתמכות.',
            'קושחה ב-Arduino C++ או ב-MicroPython; הבנייה מתבצעת בשירות והקושחה רצה מול המעגל שלכם.',
            'פלט טורי מוצג בצג לקריאה בלבד.',
          ],
        },
        {
          id: 'projects',
          h: 'פרויקטים ושפות',
          ul: [
            'פרויקטים נשמרים בדפדפן שלכם תוך כדי עבודה.',
            'הממשק זמין בעברית ובאנגלית. החלפת שפה לא משנה את המעגל.',
            'מקלדת ועכבר הם שניהם דרכי עבודה מלאות.',
          ],
        },
        {
          id: 'limits',
          h: 'מגבלות',
          ul: [
            'מחשב שולחני או טאבלט בלבד (רוחב של 1024 פיקסלים לפחות); אין ממשק לטלפון.',
            'בניית קושחה והרצתה דורשות חיבור לשירות; עריכת מעגל לא דורשת.',
            'אין תכנון מעגלים מודפסים ואין סימולציית זרם חילופין.',
          ],
        },
      ],
    },
    alpha: {
      title: 'תוכנית אלפא — TBI Lab',
      description:
        'תוכנית הגישה המוקדמת של TBI Lab: קבוצה מוגבלת, ללא עלות, ללא התחייבות לרמת שירות, ייתכן איפוס נתונים.',
      h1: 'תוכנית אלפא',
      lead: 'גישה מוקדמת לקבוצה מוגבלת של בודקים.',
      sections: [
        {
          id: 'terms',
          h: 'מהי האלפא',
          ul: [
            'קבוצה מוגבלת של בודקים.',
            'ללא עלות.',
            'ללא SLA: השירות עלול להיות איטי, לא זמין או להשתנות ללא הודעה.',
            'ייתכן איפוס נתונים: פרויקטים שנשמרו בשירות, ואולי גם בדפדפן שלכם, עלולים ללכת לאיבוד. שמרו עותקים משלכם.',
            'מצופה מהבודקים לדווח על תקלות ולתת משוב.',
          ],
        },
        {
          id: 'selection',
          h: 'איך נעשית הבחירה',
          ul: [
            'הגשת מועמדות אינה מקנה גישה.',
            'הבקשות נבדקות ידנית.',
            'מספר המקומות מוגבל, וייתכן שתוצבו ברשימת המתנה.',
            'רק חשבונות שאושרו יכולים להיכנס למעבדה.',
          ],
        },
        {
          id: 'how-to-apply',
          h: 'איך מגישים מועמדות',
          p: [
            'ההרשמה עדיין לא נפתחה. אין באתר טופס ואין עדיין מה לשלוח.',
            'כשההרשמה תיפתח, העמוד הזה יסביר את השלבים. עד אז, אפשר לחזור מאוחר יותר.',
          ],
        },
      ],
    },
    faq: {
      title: 'שאלות נפוצות — TBI Lab',
      description: 'תשובות קצרות על TBI Lab ועל תוכנית אלפא.',
      h1: 'שאלות נפוצות',
      sections: [
        { id: 'q-free', h: 'האם זה בחינם?', p: ['תוכנית אלפא ללא עלות.'] },
        {
          id: 'q-access',
          h: 'אם אגיש מועמדות, אקבל גישה?',
          p: [
            'לא. הגשת מועמדות אינה מקנה גישה. הבקשות נבדקות ידנית, מספר המקומות מוגבל וייתכנה רשימת המתנה. רק חשבונות שאושרו יכולים להיכנס.',
          ],
        },
        {
          id: 'q-device',
          h: 'אפשר להשתמש בטלפון?',
          p: ['לא. נדרש מחשב שולחני או טאבלט (רוחב מסך של 1024 פיקסלים לפחות).'],
        },
        {
          id: 'q-board',
          h: 'אילו לוחות נתמכים?',
          p: ['לוח [[ESP32]] DevKit המקורי (classic). גרסאות ESP32 אחרות אינן נתמכות.'],
        },
        {
          id: 'q-data',
          h: 'העבודה שלי בטוחה?',
          p: [
            'פרויקטים נשמרים בדפדפן שלכם תוך כדי עבודה. במהלך האלפא ייתכן איפוס נתונים, לכן שמרו עותקים משלכם של כל דבר חשוב.',
          ],
        },
        { id: 'q-lang', h: 'באילו שפות זה זמין?', p: ['עברית ואנגלית.'] },
      ],
    },
    privacy: {
      title: 'פרטיות — TBI Lab',
      description: 'מציין מקום למדיניות פרטיות.',
      h1: 'פרטיות',
      sections: [],
    },
    terms: {
      title: 'תנאי שימוש — TBI Lab',
      description: 'מציין מקום לתנאי שימוש.',
      h1: 'תנאי שימוש',
      sections: [],
    },
    accessibility: {
      title: 'הצהרת נגישות — TBI Lab',
      description: 'מציין מקום להצהרת נגישות.',
      h1: 'הצהרת נגישות',
      sections: [],
    },
  },
};

export const content = { he, en };
