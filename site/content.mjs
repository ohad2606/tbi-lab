/**
 * All public-site copy, one object per language. Templates (build.mjs) only look keys up; they
 * never branch on the language. `[[TOKEN]]` marks a technical token that is rendered dir="ltr".
 * Page shape: { title, description, h1, lead?, sections: [{ id, h, p?: [], ul?: [] }] }.
 * Honest scope: every capability named here comes from docs/product/V1-PRODUCT-SCOPE.md and the tester guide.
 * Privacy text is an interim notice (marked as such); there is no Terms page until a lawyer reviews one.
 */
export const LANGS = ['he', 'en'];
export const DEFAULT_LANG = 'he';
export const PAGES = ['home', 'product', 'alpha', 'faq', 'privacy', 'accessibility'];
export const NAV_PAGES = ['home', 'product', 'alpha', 'faq'];
export const FOOTER_PAGES = ['privacy', 'accessibility'];
/** Pages that are plain text documents (rendered with the interim/legal template). */
export const LEGAL_PAGES = ['privacy', 'accessibility'];

/** Sign-up form (Google Forms). Empty = applications not open: the CTA keeps its "opens soon" state. https only. */
export const APPLY_URL = 'https://forms.gle/iSfCbg4BwWF7HqDCA';
/** Approved testers sign in here. */
export const LAB_URL = 'https://lab.tbi-tech.net/';
/** The one public contact address. */
export const CONTACT_EMAIL = 'support@tbi-tech.net';
/**
 * Product screenshots for the Home page (slice B). Empty = the section is not rendered.
 * Item shape: { src, width, height, alt: { he, en }, caption: { he, en } }.
 * Captured by site/scripts/capture-screenshots.mjs from built-in example projects (static, not running;
 * the app UI in the images is English).
 */
export const SCREENSHOTS = [
  {
    src: '/assets/images/distance-alarm-circuit.png',
    width: 1280,
    height: 776,
    alt: {
      en: 'TBI Lab Circuit view of the example "ESP32: ultrasonic distance alarm": an ESP32 wired to a distance sensor, resistors, a power supply and an LED.',
      he: 'TBI Lab, תצוגת המעגל של הדוגמה "ESP32: ultrasonic distance alarm": ESP32 מחובר לחיישן מרחק, נגדים, ספק כוח ונורית LED. הממשק באנגלית.',
    },
    caption: {
      en: 'The Circuit view of a built-in example: an ESP32, a distance sensor and an LED.',
      he: 'תצוגת המעגל בדוגמה מובנית: ESP32, חיישן מרחק ונורית LED. (הממשק בצילום באנגלית)',
    },
  },
  {
    src: '/assets/images/lcd-hello-schematic.png',
    width: 1280,
    height: 776,
    alt: {
      en: 'TBI Lab Schematic view of the example "ESP32: hello on a 16x2 I2C LCD": an ESP32 symbol, two 4.7 kilohm I2C pull-up resistors, power supplies and an LCD.',
      he: 'TBI Lab, תצוגת הסכמה של הדוגמה "ESP32: hello on a 16x2 I2C LCD": סמל ESP32, שני נגדי pull-up של 4.7 קילו-אוהם, ספקי כוח ומסך LCD. הממשק באנגלית.',
    },
    caption: {
      en: 'The Schematic view, generated from the same circuit (I2C LCD example).',
      he: 'תצוגת הסכמה שנוצרת מאותו מעגל (דוגמת מסך LCD ב-I2C). (הממשק בצילום באנגלית)',
    },
  },
  {
    src: '/assets/images/distance-alarm-3d.png',
    width: 1280,
    height: 776,
    alt: {
      en: 'TBI Lab 3D view of the distance alarm example: a 3D model of an ESP32, a blue ultrasonic sensor, resistors, a red LED and wires.',
      he: 'TBI Lab, תצוגה תלת-ממדית של דוגמת התראת המרחק: מודל של ESP32, חיישן אולטרסוני כחול, נגדים, נורית LED אדומה וחוטים. הממשק באנגלית.',
    },
    caption: {
      en: 'The 3D view of the same example.',
      he: 'התצוגה התלת-ממדית של אותה דוגמה. (הממשק בצילום באנגלית)',
    },
  },
];

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
  switchTo: 'עברית',
  switchToLang: 'he',
  navNames: { home: 'Home', product: 'Product', alpha: 'Alpha program', faq: 'FAQ' },
  footerNames: { privacy: 'Privacy', accessibility: 'Accessibility statement' },
  contactLabel: 'Contact',
  signIn: 'Tester sign-in',
  signInHint: 'For approved testers',
  signInNote: 'Already approved? Sign in to the Lab',
  applyPending: 'Join the Alpha',
  applyPendingNote: 'Registration opens soon',
  applyOpen: 'Join the Alpha',
  applyHint: 'Registration is not open yet. This link explains how applying will work.',
  desktopNote: 'Works on a computer with Chrome or Edge.',
  interimNote: 'Interim text. It will be replaced by a reviewed version.',
  screenshotsH: 'See it in the Lab',
  pages: {
    home: {
      title: 'TBI Lab — an electronics engineering lab for the classic ESP32 in your browser',
      description:
        'TBI Lab is an engineering tool in the browser: a deterministic simulation of circuits and the classic [[ESP32]] with Arduino (C++) or MicroPython code, parts flagged beyond their absolute maximum ratings, and wiring errors explained. Free Alpha, limited places.',
      h1: 'An electronics lab for the classic [[ESP32]], in your browser',
      lead: 'Build a circuit, write Arduino (C++) or MicroPython code and run it on a simulated classic [[ESP32]], then see what happens in the circuit. An engineering tool, not a game.',
      featuresH: 'Built for engineering, not for show',
      features: [
        {
          h: 'Deterministic simulation',
          p: 'Voltages and currents are computed by a deterministic DC simulation engine, not drawn by an animation. The same circuit gives the same result every time.',
        },
        {
          h: 'Parts flagged beyond their limits',
          p: 'A part driven past its manufacturer’s absolute maximum ratings is marked as “may be damaged”, so you find out on screen and not on the bench.',
        },
        {
          h: 'Wiring errors explained',
          p: 'A wrong connection is not hidden. You get an explanation of what is wrong and where.',
        },
        {
          h: 'Honest “not supported”',
          p: 'What cannot yet be simulated reliably is stated openly. There are no fake results.',
        },
        {
          h: 'Classic ESP32, Arduino, MicroPython and parts',
          p: 'Arduino (C++) or MicroPython code on a classic [[ESP32]], with an [[HC-SR04]] distance sensor, a temperature sensor and an [[I2C]] LCD.',
        },
        {
          h: '2D and 3D, Hebrew and English',
          p: 'Work in a 2D schematic view or look at the circuit in 3D. The interface is in Hebrew and English, and switching language never changes the circuit.',
        },
      ],
      sections: [
        {
          id: 'who',
          h: 'Who it is for',
          p: [
            'Makers and beginners who want to see why a circuit works, and professionals and engineers who want to check an idea before they solder. It is not a replacement for professional PCB or CAD suites.',
          ],
        },
        {
          id: 'status',
          h: 'Free Alpha, limited places',
          p: [
            'TBI Lab is in an early access program. It is free, places are limited and applications are reviewed manually. Read how it works on the Alpha program page.',
          ],
        },
      ],
    },
    product: {
      title: 'Product — TBI Lab',
      description:
        'What TBI Lab does today: DC circuits, a classic [[ESP32]] with Arduino or MicroPython code, distance and temperature sensors, an [[I2C]] LCD, 2D and 3D views, Hebrew and English.',
      h1: 'Product',
      lead: 'What the workspace does, and what it deliberately does not.',
      sections: [
        {
          id: 'circuits',
          h: 'Circuits',
          ul: [
            'A schematic workspace with standard symbols: place, move, rotate, wire, undo and redo, in a 2D view and a 3D view.',
            'DC operating point and limited time-domain simulation of capacitor circuits, with the results shown next to the circuit.',
            'A laboratory power supply with voltage setpoint and current limit.',
            'Parts driven beyond their absolute maximum ratings are flagged, and wiring errors are explained.',
            'When something cannot be modeled reliably, the workspace says so instead of showing a made-up result.',
          ],
        },
        {
          id: 'esp32',
          h: 'Microcontroller and parts',
          ul: [
            'The original ([[classic]]) [[ESP32]] DevKit with its actual pin names, for example [[GPIO2]] and [[3V3]]. Other ESP32 variants are not supported.',
            'Code is written in Arduino C++ (a single sketch) or MicroPython; the build service compiles it into ESP32 firmware that runs against your circuit.',
            'An [[HC-SR04]] distance sensor, a temperature sensor and an [[I2C]] LCD.',
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
            'You need a computer with Chrome or Edge.',
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
          id: 'what-alpha-is',
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
          pPending: [
            'Registration is not open yet. There is no form on this site and nothing to send yet.',
            'When registration opens, this page will explain the steps. Until then, please check back later.',
          ],
          pOpen: [
            'Fill in the sign-up form with the button below. It is hosted on Google Forms, outside this site.',
            'Applying does not give access. Approved applicants are notified by email.',
          ],
        },
        {
          id: 'tester-sign-in',
          h: 'Already approved?',
          p: ['Approved testers sign in to the Lab with the link below.'],
        },
      ],
    },
    faq: {
      title: 'FAQ — TBI Lab',
      description: 'Short answers about TBI Lab and the Alpha program.',
      h1: 'Frequently asked questions',
      sections: [
        { id: 'q-free', h: 'Is it free?', p: ['The Alpha program is free of charge.'] },
        {
          id: 'q-access',
          h: 'If I apply, do I get access?',
          p: [
            'No. Applying does not give access. Applications are reviewed manually, places are limited and a waiting list is possible. Only approved accounts can sign in.',
          ],
        },
        {
          id: 'q-need',
          h: 'What do I need?',
          p: ['A computer with Chrome or Edge.'],
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
        { id: 'q-lang', h: 'Which languages are available?', p: ['Hebrew and English.'] },
      ],
    },
    privacy: {
      title: 'Privacy — TBI Lab',
      description: 'Interim privacy notice for the TBI Lab public site and Alpha sign-up.',
      h1: 'Privacy',
      sections: [
        {
          id: 'site',
          h: 'This website',
          p: [
            'This website collects no personal data. It sets no cookies, uses no analytics or advertising trackers, and loads no third-party scripts, fonts or images.',
          ],
        },
        {
          id: 'signup',
          h: 'Signing up for the Alpha',
          p: [
            'To apply you fill in a form hosted on Google Forms. TBI collects the details in the form to review your request, give you access to the Alpha and update you about it. The form is run by Google and is also subject to Google’s own terms.',
            'We will not sell your details or pass them on to others.',
          ],
        },
        {
          id: 'retention',
          h: 'How long we keep it',
          p: [
            'Requests that are not approved are deleted within 90 days. Other requests are kept for up to 12 months.',
          ],
        },
        {
          id: 'contact',
          h: 'Access and deletion',
          p: ['To see or delete your details, write to support@tbi-tech.net.'],
        },
      ],
    },
    accessibility: {
      title: 'Accessibility statement — TBI Lab',
      description:
        'What was checked on the TBI Lab public site for accessibility, and what was not.',
      h1: 'Accessibility statement',
      sections: [
        {
          id: 'scope',
          h: 'Scope',
          p: [
            'This statement is about this public website only. The Lab application is a separate product and is not covered here.',
          ],
        },
        {
          id: 'checked',
          h: 'What was checked',
          ul: [
            'Automatic checks with axe-core on every page in Hebrew and English.',
            'Keyboard use: a skip link, a visible focus indicator and every link reachable in a sensible order.',
            'Reflow: the pages fit a 320 pixel wide screen without horizontal scrolling.',
          ],
        },
        {
          id: 'not-checked',
          h: 'What was not checked',
          p: [
            'The site has not yet been tested with screen readers. We do not claim conformance with any accessibility standard or level.',
          ],
        },
        {
          id: 'contact',
          h: 'Report a barrier',
          p: [
            'If you meet a barrier on this site, write to support@tbi-tech.net and say which page it is on.',
          ],
        },
      ],
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
  switchTo: 'English',
  switchToLang: 'en',
  navNames: { home: 'דף הבית', product: 'המוצר', alpha: 'תוכנית אלפא', faq: 'שאלות נפוצות' },
  footerNames: { privacy: 'פרטיות', accessibility: 'הצהרת נגישות' },
  contactLabel: 'יצירת קשר',
  signIn: 'כניסת בודקים',
  signInHint: 'לבודקים שאושרו',
  signInNote: 'כבר אושרתם? כניסה למעבדה',
  applyPending: 'הצטרפו לאלפא',
  applyPendingNote: 'ההרשמה תיפתח בקרוב',
  applyOpen: 'הצטרפו לאלפא',
  applyHint: 'ההרשמה עדיין לא נפתחה. הקישור מסביר איך ההגשה תעבוד.',
  desktopNote: 'עובד במחשב עם Chrome או Edge.',
  interimNote: 'טקסט ביניים. יוחלף בגרסה שנבדקה.',
  screenshotsH: 'ככה זה נראה במעבדה',
  pages: {
    home: {
      title: 'TBI Lab — מעבדת הנדסת אלקטרוניקה ל-ESP32 קלאסי בדפדפן',
      description:
        'TBI Lab הוא כלי הנדסי בדפדפן: סימולציה דטרמיניסטית של מעגלים ושל [[ESP32]] קלאסי עם קוד Arduino (C++) או MicroPython, רכיבים שמסומנים כשהם חורגים מהמגבלות המקסימליות, והסבר על שגיאות חיווט. אלפא חינמית, מספר מקומות מוגבל.',
      h1: 'מעבדת אלקטרוניקה ל-[[ESP32]] קלאסי, בתוך הדפדפן',
      lead: 'מתכננים מעגל, כותבים קוד Arduino (C++) או MicroPython ומריצים אותו על [[ESP32]] קלאסי מדומה, ורואים מה קורה במעגל. כלי הנדסי, לא משחק.',
      featuresH: 'בנוי להנדסה, לא להצגה',
      features: [
        {
          h: 'סימולציה דטרמיניסטית',
          p: 'מתחים וזרמים מחושבים במנוע סימולציה דטרמיניסטי (DC), ולא מצוירים באנימציה. אותו מעגל נותן אותה תוצאה בכל פעם.',
        },
        {
          h: 'רכיבים שחורגים מהמגבלות מסומנים',
          p: 'רכיב שעובר את המגבלות המקסימליות שלו לפי היצרן מסומן כ”עלול להינזק”, ואתם מגלים את זה על המסך ולא על השולחן.',
        },
        {
          h: 'שגיאות חיווט מוסברות',
          p: 'חיבור שגוי לא מוסתר. מקבלים הסבר מה לא בסדר ואיפה.',
        },
        {
          h: '”לא נתמך” בכנות',
          p: 'מה שעדיין אי אפשר לדמות בצורה אמינה נאמר במפורש. אין תוצאות מזויפות.',
        },
        {
          h: 'ESP32 קלאסי, Arduino, MicroPython ורכיבים',
          p: 'קוד Arduino (C++) או MicroPython על [[ESP32]] קלאסי, עם חיישן מרחק [[HC-SR04]], חיישן טמפרטורה ומסך [[I2C]] LCD.',
        },
        {
          h: 'דו-ממד ותלת-ממד, עברית ואנגלית',
          p: 'עובדים בתצוגת סכמה דו-ממדית או מסתכלים על המעגל בתלת-ממד. הממשק בעברית ובאנגלית, והחלפת שפה לא משנה את המעגל.',
        },
      ],
      sections: [
        {
          id: 'who',
          h: 'למי זה מיועד',
          p: [
            'ליוצרים ולמי שרק מתחיל, שרוצים להבין למה מעגל עובד, ולאנשי מקצוע ולמהנדסים שרוצים לבדוק רעיון לפני שמלחימים. זה לא תחליף לסביבות מקצועיות לתכנון מעגלים מודפסים.',
          ],
        },
        {
          id: 'status',
          h: 'אלפא חינמית, מקומות מוגבלים',
          p: [
            'TBI Lab נמצא בתוכנית גישה מוקדמת. זה ללא עלות, מספר המקומות מוגבל והבקשות נבדקות ידנית. איך זה עובד מוסבר בעמוד תוכנית אלפא.',
          ],
        },
      ],
    },
    product: {
      title: 'המוצר — TBI Lab',
      description:
        'מה TBI Lab עושה היום: מעגלי זרם ישר, [[ESP32]] קלאסי עם קוד Arduino או MicroPython, חיישני מרחק וטמפרטורה, מסך [[I2C]] LCD, תצוגות דו-ממד ותלת-ממד, עברית ואנגלית.',
      h1: 'המוצר',
      lead: 'מה סביבת העבודה עושה, ומה היא בכוונה לא עושה.',
      sections: [
        {
          id: 'circuits',
          h: 'מעגלים',
          ul: [
            'סביבת סכמה עם סמלים סטנדרטיים: הצבה, הזזה, סיבוב, חיווט, ביטול וחזרה, בתצוגה דו-ממדית ובתצוגה תלת-ממדית.',
            'נקודת עבודה בזרם ישר וסימולציה מוגבלת בזמן של מעגלי קבלים, עם התוצאות לצד המעגל.',
            'מקור מתח מעבדתי עם הגדרת מתח והגבלת זרם.',
            'רכיבים שעוברים את המגבלות המקסימליות שלהם מסומנים, ושגיאות חיווט מוסברות.',
            'כשאי אפשר לדמות משהו באופן אמין, הסביבה אומרת זאת במקום להציג תוצאה מומצאת.',
          ],
        },
        {
          id: 'esp32',
          h: 'מיקרו-בקר ורכיבים',
          ul: [
            'לוח [[ESP32]] DevKit המקורי ([[classic]]) עם שמות הפינים המקוריים, למשל [[GPIO2]] ו-[[3V3]]. גרסאות ESP32 אחרות אינן נתמכות.',
            'הקוד נכתב ב-Arduino C++ (סקיצה אחת) או ב-MicroPython; שירות הבנייה הופך אותו לקושחת ESP32 שרצה מול המעגל שלכם.',
            'חיישן מרחק [[HC-SR04]], חיישן טמפרטורה ומסך [[I2C]] LCD.',
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
            'צריך מחשב עם Chrome או Edge.',
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
          id: 'what-alpha-is',
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
          pPending: [
            'ההרשמה עדיין לא נפתחה. אין באתר טופס ואין עדיין מה לשלוח.',
            'כשההרשמה תיפתח, העמוד הזה יסביר את השלבים. עד אז, אפשר לחזור מאוחר יותר.',
          ],
          pOpen: [
            'ממלאים את טופס ההרשמה בכפתור שלמטה. הטופס מנוהל ב-Google Forms, מחוץ לאתר הזה.',
            'הגשת מועמדות אינה מקנה גישה. מי שיאושר יקבל הודעה במייל.',
          ],
        },
        {
          id: 'tester-sign-in',
          h: 'כבר אושרתם?',
          p: ['בודקים שאושרו נכנסים למעבדה בקישור שלמטה.'],
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
        { id: 'q-need', h: 'מה צריך?', p: ['מחשב עם Chrome או Edge.'] },
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
      description: 'הודעת פרטיות זמנית לאתר הציבורי של TBI Lab ולהרשמה לאלפא.',
      h1: 'פרטיות',
      sections: [
        {
          id: 'site',
          h: 'האתר הזה',
          p: [
            'האתר הזה לא אוסף מידע אישי. הוא לא מציב עוגיות, לא משתמש בכלי ניתוח או בעוקבי פרסום, ולא טוען סקריפטים, גופנים או תמונות מצדדים שלישיים.',
          ],
        },
        {
          id: 'signup',
          h: 'הרשמה לאלפא',
          p: [
            'להגשת מועמדות ממלאים טופס שמנוהל ב-Google Forms. TBI אוספת את הפרטים בטופס כדי לבחון את הבקשה, לתת גישה לאלפא ולעדכן אותך לגביה. הטופס מופעל על ידי גוגל וכפוף גם לתנאים של גוגל.',
            'לא נמכור את הפרטים ולא נעביר אותם לאחרים.',
          ],
        },
        {
          id: 'retention',
          h: 'כמה זמן נשמור',
          p: ['בקשות שלא אושרו יימחקו בתוך 90 יום. שאר הבקשות יישמרו עד 12 חודשים.'],
        },
        {
          id: 'contact',
          h: 'עיון ומחיקה',
          p: ['לעיון בפרטים או למחיקתם: support@tbi-tech.net.'],
        },
      ],
    },
    accessibility: {
      title: 'הצהרת נגישות — TBI Lab',
      description: 'מה נבדק מבחינת נגישות באתר הציבורי של TBI Lab, ומה עדיין לא.',
      h1: 'הצהרת נגישות',
      sections: [
        {
          id: 'scope',
          h: 'היקף',
          p: [
            'ההצהרה עוסקת באתר הציבורי הזה בלבד. אפליקציית המעבדה היא מוצר נפרד ואינה כלולה כאן.',
          ],
        },
        {
          id: 'checked',
          h: 'מה נבדק',
          ul: [
            'בדיקות אוטומטיות עם axe-core בכל עמוד, בעברית ובאנגלית.',
            'שימוש במקלדת: קישור דילוג, חיווי פוקוס גלוי וכל הקישורים נגישים בסדר הגיוני.',
            'התאמה למסך: העמודים נכנסים למסך ברוחב 320 פיקסלים בלי גלילה אופקית.',
          ],
        },
        {
          id: 'not-checked',
          h: 'מה לא נבדק',
          p: ['האתר עדיין לא נבדק עם קוראי מסך. איננו טוענים לעמידה בתקן או ברמת נגישות כלשהם.'],
        },
        {
          id: 'contact',
          h: 'דיווח על חסם',
          p: ['נתקלתם בחסם באתר? כתבו ל-support@tbi-tech.net וציינו באיזה עמוד.'],
        },
      ],
    },
  },
};

export const content = { he, en };
