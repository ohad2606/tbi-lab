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
/**
 * Own sign-up page (BETA-G1 s9). While the flag is false the page and its script are not built at all (only the
 * e2e/preview build `--signup-preview` adds them, noindex and unlinked). The owner flips it when the intake endpoint is
 * live; then the page is built, the nav link appears, the home/alpha CTAs point to the page instead of APPLY_URL, and
 * the privacy page switches to its own-form text. The flag does not touch noindex (SIGNUP_NOINDEX).
 */
export const SIGNUP_PAGE_ENABLED = false;
/**
 * BETA-G1 G1-AUTO-VERIFY, the owner's flip: true puts the email confirmation (new sign-up copy, confirm view, resend
 * form) into the sign-up pages of the published build, and switches the home, alpha, FAQ and accessibility pages to the
 * matching copy (`signupVerify.pages`). It needs SIGNUP_PAGE_ENABLED = true; the build refuses
 * otherwise. No environment variable changes it.
 */
export const SIGNUP_VERIFY_ENABLED = false;
/**
 * DEC-07: the sign-up pages carry `noindex` whatever SIGNUP_PAGE_ENABLED says. Set to false on the public launch day
 * (15.12) only, never as part of the flip.
 */
export const SIGNUP_NOINDEX = true;
/** Base of the intake routes: GET <base>/form-token, POST <base>/web. Relative = same origin (proxied by the web server). */
export const SIGNUP_API_BASE = '/signup';
/** Stable values sent to the server (admin reads these); the visible labels live in each language below, same order. */
export const SIGNUP_ROLE_VALUES = [
  'Student',
  'Maker or hobbyist',
  'Engineer or technician',
  'Teacher or instructor',
  'Other',
];
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
  navNames: {
    home: 'Home',
    product: 'Product',
    alpha: 'Alpha program',
    faq: 'FAQ',
    signup: 'Sign up',
  },
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
  signup: {
    required: 'All fields are required except the one marked (optional).',
    name: 'Name',
    email: 'Email address',
    emailHint: 'We will write to this address when we approve your request.',
    role: 'Which best describes you?',
    rolePick: 'Choose one',
    roles: [
      'Student',
      'Maker or hobbyist',
      'Engineer or technician',
      'Teacher or instructor',
      'Other',
    ],
    heard: 'How did you hear about us?',
    heardHint: 'Up to 80 characters.',
    optional: '(optional)',
    age: 'I am 18 or older, or a parent has approved my sign-up.',
    consentBefore: 'I have read the ',
    consentLink: 'privacy notice',
    consentAfter:
      ', and I agree that TBI may use my details to handle my request and give me access.',
    submit: 'Send my request',
    newTab: '(opens in a new tab)',
    nojs: 'The sign-up form could not load. It needs [[JavaScript]]. Please turn it on in your browser and reload the page, or write to us at support@tbi-tech.net.',
    honeypot: 'Leave this field empty',
    privacyH: 'What we do with your details',
    privacy: [
      'We use the details in this form to review your request, give you access to the Alpha and update you about it. We will not sell your details or pass them on to others.',
      'Requests that are not approved are deleted within 90 days. Other requests are kept for up to 12 months. To see or delete your details, write to support@tbi-tech.net.',
    ],
    errName: 'Enter your name.',
    errEmail: 'Enter a valid email address. Use English letters, digits and symbols.',
    errRole: 'Choose the option that describes you best.',
    errHeard: 'Use at most 80 characters.',
    errAge: 'Confirm that you are 18 or older, or that a parent approved your sign-up.',
    errConsent: 'Confirm that you have read the privacy notice and agree.',
    summaryFieldsH: 'Please fix these before sending:',
    summaryFailH: 'We could not send your request',
    statusSending: 'Sending your request…',
    statusErrors: 'Your request was not sent. Some fields need attention.',
    msgInvalid: 'Some of the details were not accepted. Please check the fields and send again.',
    msgTooFast: 'That was very quick. Please wait a few seconds and send again.',
    msgRate:
      'There have been too many requests from your connection. Please wait a few minutes and try again.',
    msgUnavailable:
      'Sign-up is temporarily unavailable. Your details were not sent. Please try again in a little while.',
    msgNetwork:
      'We did not get an answer from the server. Check your connection and send again. Nothing you typed was lost.',
    msgForbidden:
      'We could not accept this request from this page. Please reload the page and try again.',
    msgGeneric:
      'Something went wrong and your request was not sent. Please try again in a little while.',
    msgSession: 'The form session was renewed. Please send again.',
    successH: 'Thank you. We received your request.',
    successP: [
      'Places in the Alpha are limited, so we approve requests gradually. When we approve yours, we will email you the link to the lab.',
      'If you have a question, write to us at support@tbi-tech.net.',
    ],
  },
  /**
   * BETA-G1 G1-AUTO-VERIFY slice 3: used only with the `signupVerify` build option (off until the owner's flip).
   * `email` .. `successP` and `lead` replace the sign-up copy; `pages` changes the other public pages; the rest is the
   * confirm view and the resend form. The privacy wording is not here: it changes with the lawyer's text (G4).
   */
  signupVerify: {
    descriptions: {
      accessibility:
        'Accessibility of TBI Lab: the known limitations, and what was checked on the public site and what was not.',
    },
    lead: 'TBI Lab is an electronics lab in your browser. You build a circuit, write Arduino code and run it on a simulated classic [[ESP32]]. The Alpha is free and places are limited. Sign up, confirm your email, and you are in. On busy days it may take longer. You need a computer with Chrome or Edge and a screen at least 1024 pixels wide. The lab is not designed for phones.',
    email: 'The email address of your Google account',
    emailHint:
      'During the Alpha you sign in with a Google account, using exactly this address. We will send a confirmation link to it.',
    successH: 'Check your email to confirm',
    successP: [
      'We received your details. We will send a confirmation email to the address you entered. Open the link in it and press the confirm button.',
      'After you confirm, we set up your access and email you when you can sign in. We have limited capacity, so on busy days it may take longer.',
      'No email? Check your spam folder, or reload this page and send the form again. Questions? Write to us at support@tbi-tech.net.',
    ],
    confirmTitle: 'Confirm your email — TBI Lab',
    confirmH: 'Confirm your email address',
    nojsConfirm: 'To confirm your email, turn on JavaScript and reload the page.',
    confirmP:
      'Press the button to confirm that this email address is yours. If you reload this page or change language, open the email link again.',
    confirmButton: 'Confirm my email address',
    confirmSending: 'Sending your confirmation…',
    resultReceivedH: 'We received your confirmation',
    resultReceivedP:
      'We will email you when your access is ready. On busy days it may take longer. You can close this page.',
    resultExpiredH: 'This link has expired',
    resultExpiredP: 'A confirmation link works for 24 hours. You can ask for a new one below.',
    resultInvalidH: 'This link did not work',
    resultInvalidP:
      'It may be incomplete. Open the link in our latest email again, or ask for a new one below.',
    resultRateH: 'Too many attempts',
    resultRateP:
      'There have been too many requests from your connection. Please wait a few minutes and press the confirm button again.',
    resultNetworkH: 'We did not get an answer from the server',
    resultNetworkP: 'Check your connection and press the confirm button again.',
    resultUnavailableH: 'We could not confirm your address right now',
    resultUnavailableP:
      'Please press the confirm button again in a little while. If it keeps happening, write to us at support@tbi-tech.net.',
    resendH: 'Ask for a new link',
    resendButton: 'Send me a new link',
    resendSending: 'Sending your request for a new link…',
    resultSentH: 'Check your email',
    resultSentP:
      'If a sign-up for this address is waiting for confirmation, we will send a new link to it. On busy days it may take longer.',
    resultFailH: 'We could not send your request',
    resendUnavailable:
      'We cannot send a new link right now. Your request was not sent. Please try again in a little while.',
    resendInvalid:
      'Your request for a new link was not accepted. Check the email address and ask again.',
    resendNetwork: 'Check your connection and ask for a new link again.',
    /**
     * Changes to the other public pages, by page and section id (build.mjs, verifySections): the fields given replace
     * that section's own, `next` adds sections after it and `false` drops it. The privacy page is not here: it changes
     * with the lawyer's text (G4).
     */
    pages: {
      home: {
        status: {
          p: [
            'TBI Lab is in an early access program. It is free and places are limited. Sign up, confirm your email, and you are in. On busy days it may take longer. Read how it works on the Alpha program page.',
          ],
        },
      },
      alpha: {
        selection: {
          h: 'How you get access',
          ul: [
            'Sending the form is not enough: you also confirm your email address with a link we send you.',
            'After you confirm, we set up your access and email you when you can sign in.',
            'Places are limited. On busy days it may take longer.',
            'Only accounts that we have activated can sign in to the Lab.',
          ],
        },
        'how-to-apply': {
          h: 'How to sign up',
          pOpenOwn: [
            'Fill in the sign-up form on this site with the button below, using the email address of your Google account.',
            'Sign up, confirm your email, and you are in. On busy days it may take longer. We will email you when you can sign in.',
          ],
        },
      },
      faq: {
        'q-access': {
          h: 'How do I get access?',
          p: [
            'Fill in the sign-up form with the email address of your Google account, open the link we email you and press the confirm button. Then we set up your access and email you when you can sign in. Places are limited, and on busy days it may take longer. Only activated accounts can sign in.',
          ],
          next: [
            {
              id: 'q-no-email',
              h: 'I didn’t get the confirmation email. What can I do?',
              p: [
                'Check your spam folder. Then reload the sign-up page and send the form again with the same address. A confirmation link works for 24 hours.',
              ],
            },
          ],
        },
      },
      accessibility: {
        /** `p`, `ul`, `pEnd`: the wording the owner approved (directive 2026-11-27 07:40, item 2). */
        scope: {
          id: 'statement',
          h: 'Accessibility of TBI Lab',
          p: [
            'We develop TBI Lab according to the [[WCAG 2.2]] guidelines at level [[AA]]. The full check is not yet complete.',
            'Known limitations right now:',
          ],
          ul: [
            'A screen at least 1024 pixels wide is required.',
            'Testing with a screen reader has not yet been done.',
          ],
          pEnd: [
            'Encountered a barrier? Write to support@tbi-tech.net and we will take care of it.',
          ],
        },
        checked: { h: 'What was checked on this website' },
        'not-checked': { h: 'What was not checked on this website' },
        // The approved wording ends with the same request.
        contact: false,
      },
    },
  },
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
            'DC operating point simulation, with the results shown next to the circuit.',
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
          /** Used instead of pOpen when the own sign-up page is enabled (SIGNUP_PAGE_ENABLED). */
          pOpenOwn: [
            'Fill in the sign-up form on this site with the button below.',
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
    signup: {
      title: 'Sign up for early access — TBI Lab',
      description:
        'Request a place in the free TBI Lab Alpha: an electronics and classic [[ESP32]] lab in your browser. Places are limited.',
      h1: 'Sign up for early access (Alpha)',
      lead: 'TBI Lab is an electronics lab in your browser. You build a circuit, write Arduino code and run it on a simulated classic [[ESP32]]. The Alpha is free and places are limited. We approve requests gradually and let you know by email. You need a computer with Chrome or Edge and a screen at least 1024 pixels wide. The lab is not designed for phones.',
      sections: [],
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
          /** Used instead of p when the own sign-up page is enabled. Draft, lawyer review required. */
          pOwn: [
            'This website sets no cookies, uses no analytics or advertising trackers, and loads no third-party scripts, fonts or images.',
            'We ask for personal details on this website in one place: the sign-up form. When you open the sign-up page or send the form, we also briefly use your network address to limit abuse. What we collect and how we use it is described below, under “Signing up for the Alpha”.',
          ],
        },
        {
          id: 'signup',
          h: 'Signing up for the Alpha',
          p: [
            'To apply you fill in a form hosted on Google Forms. TBI collects the details in the form to review your request, give you access to the Alpha and update you about it. The form is run by Google and is also subject to Google’s own terms.',
            'We will not sell your details or pass them on to others.',
          ],
          /** Used instead of p when the own sign-up page is enabled (SIGNUP_PAGE_ENABLED). Draft, lawyer review required. */
          pOwn: [
            'To apply, you fill in the sign-up form on this website. We collect your name, email address, role, the language of the page, your answer to “How did you hear about us?” (optional), and your confirmation that you have read this notice. The details are stored on our own server. We use them only to review your request and to send you the email about it.',
            'The sign-up form does not use cookies, analytics or advertising trackers, and loads no third-party scripts. Your browser sends the form directly to us. To limit abuse, we briefly use your network address to count requests. We keep that count in memory only and do not store it with your request.',
            'We use two service providers to run the process. When a request arrives, we send ourselves a [[Telegram]] message with your name and role only. If we approve your request, we send you an email through [[Resend]]. Those providers handle the data they receive under their own terms.',
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
  navNames: {
    home: 'דף הבית',
    product: 'המוצר',
    alpha: 'תוכנית אלפא',
    faq: 'שאלות נפוצות',
    signup: 'הרשמה',
  },
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
  signup: {
    required: 'כל השדות חובה, חוץ מהשדה שמסומן (לא חובה).',
    name: 'שם',
    email: 'כתובת אימייל',
    emailHint: 'לכתובת הזאת נכתוב כשנאשר את הבקשה.',
    role: 'מה מתאר אתכם הכי טוב?',
    rolePick: 'בחרו אפשרות',
    roles: ['סטודנט/ית', 'מייקר/ית או תחביב', 'מהנדס/ת או טכנאי/ת', 'מורה או מדריך/ה', 'אחר'],
    heard: 'איך הגעת אלינו?',
    heardHint: 'עד 80 תווים.',
    optional: '(לא חובה)',
    age: 'אני בן/בת 18 ומעלה, או שהורה אישר לי להירשם.',
    consentBefore: 'קראתי את ',
    consentLink: 'הודעת הפרטיות',
    consentAfter: ', ואני מסכים/ה ש-[[TBI]] תשתמש בפרטים כדי לטפל בבקשה ולתת גישה.',
    submit: 'שליחת הבקשה',
    newTab: '(נפתח בלשונית חדשה)',
    nojs: 'טופס ההרשמה לא נטען. הוא דורש [[JavaScript]]. הפעילו אותו בדפדפן וטענו את הדף מחדש, או כתבו לנו ל-support@tbi-tech.net.',
    honeypot: 'השאירו שדה זה ריק',
    privacyH: 'מה אנחנו עושים עם הפרטים',
    privacy: [
      'אנחנו משתמשים בפרטים בטופס כדי לבחון את הבקשה, לתת גישה לאלפא ולעדכן אתכם לגביה. לא נמכור את הפרטים ולא נעביר אותם לאחרים.',
      'בקשות שלא אושרו יימחקו בתוך 90 יום, ושאר הבקשות יישמרו עד 12 חודשים. לעיון או למחיקה כתבו לנו ל-support@tbi-tech.net.',
    ],
    errName: 'הזינו את השם שלכם.',
    errEmail: 'הזינו כתובת אימייל תקינה. השתמשו באותיות באנגלית, בספרות ובסימנים.',
    errRole: 'בחרו את האפשרות שמתארת אתכם הכי טוב.',
    errHeard: 'כתבו עד 80 תווים.',
    errAge: 'אשרו שאתם בני 18 ומעלה, או שהורה אישר לכם להירשם.',
    errConsent: 'אשרו שקראתם את הודעת הפרטיות ושאתם מסכימים.',
    summaryFieldsH: 'יש לתקן לפני השליחה:',
    summaryFailH: 'לא הצלחנו לשלוח את הבקשה',
    statusSending: 'שולחים את הבקשה…',
    statusErrors: 'הבקשה לא נשלחה. יש שדות שדורשים תיקון.',
    msgInvalid: 'חלק מהפרטים לא התקבלו. בדקו את השדות ושלחו שוב.',
    msgTooFast: 'זה היה מהיר מאוד. המתינו כמה שניות ושלחו שוב.',
    msgRate: 'היו יותר מדי בקשות מהחיבור שלכם. המתינו כמה דקות ונסו שוב.',
    msgUnavailable: 'ההרשמה אינה זמינה זמנית. הפרטים לא נשלחו. נסו שוב בעוד זמן קצר.',
    msgNetwork: 'לא קיבלנו תשובה מהשרת. בדקו את החיבור ושלחו שוב. מה שהקלדתם לא אבד.',
    msgForbidden: 'לא הצלחנו לקבל את הבקשה מהדף הזה. טענו את הדף מחדש ונסו שוב.',
    msgGeneric: 'משהו השתבש והבקשה לא נשלחה. נסו שוב בעוד זמן קצר.',
    msgSession: 'חיבור הטופס חודש. שלחו שוב.',
    successH: 'תודה. קיבלנו את הבקשה.',
    successP: [
      'מספר המקומות באלפא מוגבל, ולכן אנחנו מאשרים בקשות בהדרגה. כשנאשר את הבקשה שלכם, נשלח אליכם במייל את הקישור למעבדה.',
      'יש שאלה? כתבו לנו ל-support@tbi-tech.net.',
    ],
  },
  /** BETA-G1 G1-AUTO-VERIFY slice 3: used only with the `signupVerify` build option; see the English object. */
  signupVerify: {
    descriptions: {
      accessibility: 'נגישות TBI Lab: המגבלות הידועות, ומה נבדק באתר הציבורי ומה עדיין לא.',
    },
    lead: '[[TBI Lab]] היא מעבדת אלקטרוניקה בדפדפן. בונים מעגל, כותבים קוד [[Arduino]] ומריצים אותו על [[ESP32]] קלאסי מדומה. ה-[[Alpha]] חינמי, ומספר המקומות מוגבל. נרשמים, מאשרים את המייל ונכנסים. בימים עמוסים זה עלול לקחת יותר זמן. דרוש מחשב עם דפדפן [[Chrome]] או [[Edge]], ומסך ברוחב 1024 פיקסלים לפחות. המעבדה לא מיועדת לטלפון.',
    email: 'כתובת המייל של חשבון [[Google]] שלכם',
    emailHint:
      'ב-[[Alpha]] נכנסים עם חשבון [[Google]] בלבד, עם הכתובת הזו בדיוק. נשלח אליה קישור לאישור.',
    successH: 'בדקו את המייל כדי לאשר',
    successP: [
      'קיבלנו את הפרטים. נשלח מייל אישור לכתובת שהזנתם. פתחו את הקישור שבו ולחצו על כפתור האישור.',
      'אחרי האישור נפעיל לכם את הגישה ונשלח מייל כשאפשר להיכנס. הקיבולת שלנו מוגבלת, ולכן בימים עמוסים זה עלול לקחת יותר זמן.',
      'המייל לא הגיע? בדקו בתיקיית הספאם, או טענו את הדף מחדש ושלחו שוב את הטופס. יש שאלה? כתבו לנו ל-support@tbi-tech.net.',
    ],
    confirmTitle: 'אישור כתובת המייל — TBI Lab',
    confirmH: 'אישור כתובת המייל',
    nojsConfirm: 'כדי לאשר את המייל, הפעילו [[JavaScript]] וטענו את הדף מחדש.',
    confirmP:
      'לחצו על הכפתור כדי לאשר שכתובת המייל הזו שלכם. אם טוענים את הדף מחדש או מחליפים שפה, פתחו שוב את הקישור שבמייל.',
    confirmButton: 'אישור כתובת המייל שלי',
    confirmSending: 'שולחים את האישור…',
    resultReceivedH: 'קיבלנו את האישור',
    resultReceivedP:
      'נשלח אליכם מייל כשהגישה תהיה מוכנה. בימים עמוסים זה עלול לקחת יותר זמן. אפשר לסגור את הדף.',
    resultExpiredH: 'תוקף הקישור פג',
    resultExpiredP: 'קישור אישור תקף ל-24 שעות. אפשר לבקש כאן למטה קישור חדש.',
    resultInvalidH: 'הקישור לא עבד',
    resultInvalidP:
      'ייתכן שהוא לא שלם. פתחו שוב את הקישור שבמייל האחרון ששלחנו, או בקשו קישור חדש כאן למטה.',
    resultRateH: 'יותר מדי ניסיונות',
    resultRateP: 'היו יותר מדי בקשות מהחיבור שלכם. המתינו כמה דקות ולחצו שוב על כפתור האישור.',
    resultNetworkH: 'לא קיבלנו תשובה מהשרת',
    resultNetworkP: 'בדקו את החיבור ולחצו שוב על כפתור האישור.',
    resultUnavailableH: 'לא הצלחנו לאשר את הכתובת כרגע',
    resultUnavailableP:
      'לחצו שוב על כפתור האישור בעוד זמן קצר. אם זה חוזר, כתבו לנו ל-support@tbi-tech.net.',
    resendH: 'בקשת קישור חדש',
    resendButton: 'שלחו לי קישור חדש',
    resendSending: 'שולחים את הבקשה לקישור חדש…',
    resultSentH: 'בדקו את תיבת המייל',
    resultSentP:
      'אם יש הרשמה לכתובת הזו שמחכה לאישור, נשלח אליה קישור חדש. בימים עמוסים זה עלול לקחת יותר זמן.',
    resultFailH: 'לא הצלחנו לשלוח את הבקשה',
    resendUnavailable: 'אי אפשר לשלוח קישור חדש כרגע. הבקשה לא נשלחה. נסו שוב בעוד זמן קצר.',
    resendInvalid: 'הבקשה לקישור חדש לא התקבלה. בדקו את כתובת המייל ובקשו שוב.',
    resendNetwork: 'בדקו את החיבור ובקשו שוב קישור חדש.',
    pages: {
      home: {
        status: {
          p: [
            'TBI Lab נמצא בתוכנית גישה מוקדמת. זה ללא עלות ומספר המקומות מוגבל. נרשמים, מאשרים את המייל ונכנסים. בימים עמוסים זה עלול לקחת יותר זמן. איך זה עובד מוסבר בעמוד תוכנית אלפא.',
          ],
        },
      },
      alpha: {
        selection: {
          h: 'איך מקבלים גישה',
          ul: [
            'שליחת הטופס לבדה לא מספיקה: צריך גם לאשר את כתובת המייל בקישור שנשלח אליכם.',
            'אחרי האישור נפעיל לכם את הגישה ונשלח מייל כשאפשר להיכנס.',
            'מספר המקומות מוגבל. בימים עמוסים זה עלול לקחת יותר זמן.',
            'רק חשבונות שהפעלנו יכולים להיכנס למעבדה.',
          ],
        },
        'how-to-apply': {
          h: 'איך נרשמים',
          pOpenOwn: [
            'ממלאים את טופס ההרשמה באתר בכפתור שלמטה, עם כתובת המייל של חשבון [[Google]] שלכם.',
            'נרשמים, מאשרים את המייל ונכנסים. בימים עמוסים זה עלול לקחת יותר זמן. נשלח מייל כשאפשר להיכנס.',
          ],
        },
      },
      faq: {
        'q-access': {
          h: 'איך מקבלים גישה?',
          p: [
            'ממלאים את טופס ההרשמה עם כתובת המייל של חשבון [[Google]] שלכם, פותחים את הקישור שנשלח למייל ולוחצים על כפתור האישור. אחר כך נפעיל לכם את הגישה ונשלח מייל כשאפשר להיכנס. מספר המקומות מוגבל, ובימים עמוסים זה עלול לקחת יותר זמן. רק חשבונות שהופעלו יכולים להיכנס.',
          ],
          next: [
            {
              id: 'q-no-email',
              h: 'לא קיבלתי את מייל האישור. מה עושים?',
              p: [
                'בדקו בתיקיית הספאם. אם לא נמצא, טענו מחדש את דף ההרשמה ושלחו שוב את הטופס עם אותה כתובת. קישור אישור תקף ל-24 שעות.',
              ],
            },
          ],
        },
      },
      accessibility: {
        /** Verbatim from the owner (directive 2026-11-27 07:40, item 2). Change only with the owner's approval. */
        scope: {
          id: 'statement',
          h: 'נגישות [[TBI Lab]]',
          p: [
            'אנחנו מפתחים את [[TBI Lab]] לפי הנחיות [[WCAG 2.2]] ברמה [[AA]]. הבדיקה המלאה עדיין לא הושלמה.',
            'מגבלות ידועות כרגע:',
          ],
          ul: ['נדרש מסך ברוחב 1024 פיקסלים לפחות.', 'בדיקה עם קורא מסך עדיין לא בוצעה.'],
          pEnd: ['נתקלתם בחסם? כתבו ל-support@tbi-tech.net ונטפל בזה.'],
        },
        checked: { h: 'מה נבדק באתר הזה' },
        'not-checked': { h: 'מה לא נבדק באתר הזה' },
        contact: false,
      },
    },
  },
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
            'סימולציה של נקודת עבודה בזרם ישר, עם התוצאות לצד המעגל.',
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
          /** Used instead of pOpen when the own sign-up page is enabled. */
          pOpenOwn: [
            'ממלאים את טופס ההרשמה באתר הזה בכפתור שלמטה.',
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
    signup: {
      title: 'הרשמה לגישה מוקדמת — TBI Lab',
      description:
        'בקשה למקום באלפא החינמית של TBI Lab: מעבדת אלקטרוניקה ו-[[ESP32]] קלאסי בדפדפן. מספר המקומות מוגבל.',
      h1: 'הרשמה לגישה מוקדמת ([[Alpha]])',
      lead: '[[TBI Lab]] היא מעבדת אלקטרוניקה בדפדפן. בונים מעגל, כותבים קוד [[Arduino]] ומריצים אותו על [[ESP32]] קלאסי מדומה. ה-[[Alpha]] חינמי, ומספר המקומות מוגבל. אנחנו מאשרים בקשות בהדרגה ונשלח הודעה במייל. דרוש מחשב עם דפדפן [[Chrome]] או [[Edge]], ומסך ברוחב 1024 פיקסלים לפחות. המעבדה לא מיועדת לטלפון.',
      sections: [],
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
          /** Used instead of p when the own sign-up page is enabled. Draft, lawyer review required. */
          pOwn: [
            'האתר הזה לא מציב עוגיות, לא משתמש בכלי ניתוח או בעוקבי פרסום, ולא טוען סקריפטים, גופנים או תמונות מצדדים שלישיים.',
            'אנחנו מבקשים פרטים אישיים באתר במקום אחד: טופס ההרשמה. כשפותחים את דף ההרשמה או שולחים את הטופס, אנחנו משתמשים לזמן קצר גם בכתובת הרשת שלכם כדי להגביל ניצול לרעה. מה אנחנו אוספים ואיך אנחנו משתמשים בזה מפורט בהמשך, בסעיף "הרשמה לאלפא".',
          ],
        },
        {
          id: 'signup',
          h: 'הרשמה לאלפא',
          p: [
            'להגשת מועמדות ממלאים טופס שמנוהל ב-Google Forms. TBI אוספת את הפרטים בטופס כדי לבחון את הבקשה, לתת גישה לאלפא ולעדכן אותך לגביה. הטופס מופעל על ידי גוגל וכפוף גם לתנאים של גוגל.',
            'לא נמכור את הפרטים ולא נעביר אותם לאחרים.',
          ],
          /** Used instead of p when the own sign-up page is enabled. Draft, lawyer review required. */
          pOwn: [
            'להגשת מועמדות ממלאים את טופס ההרשמה באתר הזה. אנחנו אוספים את השם, כתובת האימייל, התפקיד, שפת הדף, התשובה לשאלה "איך הגעת אלינו?" (לא חובה) ואת האישור שקראתם את ההודעה הזאת. הפרטים נשמרים בשרת שלנו. אנחנו משתמשים בהם רק כדי לבחון את הבקשה ולשלוח לכם את המייל בעניינה.',
            'בטופס ההרשמה אין עוגיות, אין כלי ניתוח או מעקב פרסומי, ואין סקריפטים של צד שלישי. הדפדפן שולח את הטופס ישירות אלינו. כדי להגביל ניצול לרעה אנחנו משתמשים לזמן קצר בכתובת הרשת שלכם כדי לספור בקשות. הספירה נשמרת בזיכרון בלבד ואינה נשמרת יחד עם הבקשה.',
            'אנחנו נעזרים בשני נותני שירות להפעלת התהליך. כשמגיעה בקשה אנחנו שולחים לעצמנו הודעה ב-[[Telegram]] עם השם והתפקיד בלבד. אם נאשר את הבקשה, נשלח לכם מייל באמצעות [[Resend]]. נותני השירות האלה מטפלים במידע שהם מקבלים לפי התנאים שלהם.',
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
