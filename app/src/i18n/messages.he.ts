import type { MessageKey } from './messages.en.js';

/**
 * Hebrew message catalogue. Typed against the English key set, so a missing key is a compile
 * error as well as a test failure. Technical terms and unit symbols stay as used
 * professionally in Hebrew (Ω, V, A, Esc, R, Delete).
 */
export const he: Record<MessageKey, string> = {
  'app.loading': 'טוען…',
  'app.storageUnavailable':
    'TBI Lab אינו יכול להשתמש באחסון המקומי של הדפדפן (ייתכן שהוא חסום, למשל בחלון גלישה פרטית), ולכן לא ניתן לשמור כאן פרויקטים. דבר לא שונה. אפשרו אחסון לאתר או השתמשו בחלון רגיל, ואז טענו מחדש.',

  'home.title': 'פרויקטים',
  'home.new.heading': 'פרויקט חדש',
  'home.new.nameLabel': 'שם הפרויקט',
  'home.new.defaultName': 'פרויקט ללא שם',
  'home.new.defaultNameN': 'פרויקט ללא שם {n}',
  'home.new.create': 'יצירת פרויקט',
  'home.recent.heading': 'פרויקטים אחרונים',
  'home.recent.empty': 'אין עדיין פרויקטים. צרו פרויקט כדי להתחיל.',
  'home.recent.updated': 'שונה לאחרונה {date}',
  'home.browserNote': 'הפרויקטים נשמרים בדפדפן זה, במכשיר זה.',

  'topbar.projects': 'פרויקטים',
  'topbar.projectName': 'שם הפרויקט',
  'topbar.language': 'שפה',

  'save.saved': 'כל השינויים נשמרו',
  'save.saving': 'שומר…',
  'save.error': 'השמירה נכשלה',
  'save.retry': 'ניסיון חוזר',
  'notice.dismiss': 'סגירה',

  'palette.heading': '[[components]]',
  'palette.hint': 'בחרו רכיב ולחצו על משטח השרטוט כדי למקם אותו.',

  'canvas.label': 'משטח השרטוט',
  'canvas.zoomIn': 'הגדלה',
  'canvas.zoomOut': 'הקטנה',
  'canvas.zoomFit': 'התאמה לתצוגה',
  'canvas.hint.wire':
    'גררו קטע ישר של החוט כדי להזיז אותו. הקצוות נשארים מחוברים. Delete מוחק אותו.',
  'canvas.hint.idle': 'לחצו על [[terminal]] כדי להתחיל חוט. גררו על שטח ריק כדי לבחור.',
  'canvas.hint.placing': 'לחצו על משטח השרטוט כדי למקם. Esc לביטול.',
  'canvas.hint.wiring':
    'לחצו על הדק, צומת או חוט כדי לסיים. לחיצה על שטח ריק מוסיפה פינה. Esc לביטול.',
  'canvas.hint.running':
    'הסימולציה פועלת: בחרו [[component]] כדי לראות את ערכיו. עצרו כדי לשנות את המעגל.',
  'canvas.componentLabel': '{ref}, {type}',
  'canvas.junctionLabel': '[[junction]] {id}',

  'component.instrument.lab_psu.name': 'ספק כוח מעבדתי',
  'component.component.ground.name': '[[ground]]',
  'component.component.resistor.name': 'נגד',
  'component.component.led.name': 'נורית LED',
  'component.component.diode.name': '[[diode]]',
  'component.component.push_button.name': '[[pushButton]]',
  'component.component.toggle_switch.name': '[[toggleSwitch]]',

  'terminal.positive': 'חיובי (+)',
  'terminal.negative': 'שלילי (−)',
  'terminal.ref': 'ייחוס',
  'terminal.a': '[[terminal]] a',
  'terminal.b': '[[terminal]] b',
  'terminal.anode': 'אנודה',
  'terminal.cathode': 'קתודה',

  'param.setpointVoltage': 'מתח מכוון',
  'param.currentLimit': 'הגבלת זרם',
  'param.outputEnabled': 'יציאה פעילה',
  'param.resistance': 'התנגדות',
  'param.model': 'דגם',
  'param.closed': '[[toggleSwitch]] סגור',
  'model.diode.vishay_1n4148': 'דיודת אות קטן 1N4148 (Vishay)',
  'model.led.vishay_tlhr5400': 'אדומה 5 מ"מ (Vishay TLHR5400)',

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',

  'sim.run': 'הרצה',
  'sim.stop': 'עצירה',
  'sim.controls': 'סימולציה',
  'sim.status.stopped': 'עצור',
  'sim.status.starting': 'מתחיל…',
  'sim.status.running': 'פועל · נקודת עבודה DC',
  'sim.status.failed': 'לא ניתן להריץ',
  'sim.stopToEdit':
    'יש לעצור את הסימולציה כדי לשנות את המעגל. בזמן ריצה מותר להזיז [[components]] ולשנות את הגדרות ספק הכוח.',
  'sim.error.empty_circuit': 'אין עדיין מה לדמות: חברו את ה[[components]] לספק הכוח ול[[ground]].',
  'sim.error.no_ground': 'למעגל אין נקודת ייחוס. הוסיפו [[ground]] וחברו אותה למעגל.',
  'sim.error.floating_circuit':
    'ה[[components]] האלה יוצרים מעגל צף ללא חיבור ל-GND: {components}. חברו אותם למעגל או הסירו אותם.',
  'sim.error.floating_output_off':
    'ה[[components]] האלה מגיעים ל-GND רק דרך {supplies}, שהיציאה שלו כבויה: {components}. הפעילו את היציאה או חברו אותם ל-GND.',
  'sim.error.psu_shorted':
    '{components}: הדקי היציאה מחוברים זה לזה בחוט (קצר). הסירו את החוט כדי להריץ.',
  'sim.error.psu_parallel.title': 'ספקי כוח במקביל עדיין אינם נתמכים',
  'sim.error.psu_parallel':
    '{supplies} מחוברים ישירות במקביל. הסימולטור אינו יכול עדיין לקבוע חלוקת זרם יחידה בין הספקים.',
  'sim.error.psu_parallel.hint': 'השתמשו בספק אחד, או הפרידו בין היציאות באמצעות רכיבי מעגל.',
  'sim.error.invalid_parameter': '{components}: לא ניתן לדמות את הערך של „{param}”.',
  'sim.error.unsupported_component': 'עדיין לא ניתן לדמות את {components}.',
  'sim.error.invalid_attachment': 'פין של המיקרו-בקר מחובר להדק שאינו קיים: {components}.',
  'sim.error.singular_circuit':
    'למעגל אין פתרון יחיד, למשל שני ספקים שכופים מתחים שונים על אותה [[net]]. מעורבים: {components}.',
  'sim.error.no_convergence':
    'הפותר לא מצא נקודת עבודה, ולכן לא מוצגים ערכים. מעורבים: {components}.',
  'sim.error.internal': 'אירעה שגיאה פנימית בסימולציה. הפרויקט לא נפגע.',
  'sim.error.worker_crashed':
    'הסימולציה נעצרה באופן בלתי צפוי. הפרויקט לא נפגע. לחצו על הרצה כדי לנסות שוב.',
  'sim.error.timeout':
    'הסימולציה לא הגיבה בזמן ונעצרה. הפרויקט לא נפגע. לחצו על הרצה כדי לנסות שוב.',
  'sim.notConnected': 'לא מחוברים ולכן לא מדומים: {components}',
  'sim.results.heading': 'תוצאת סימולציה',
  'sim.results.note': 'ערכים מחושבים. הם אינם נשמרים בפרויקט.',
  'sim.results.current': 'זרם',
  'sim.results.voltage': 'מתח על ה[[component]]',
  'sim.results.forwardVoltage': 'מתח קדמי',
  'sim.results.forwardCurrent': 'זרם קדמי',
  'sim.results.outputVoltage': 'מתח יציאה',
  'sim.results.outputCurrent': 'זרם יציאה',
  'sim.results.mode': 'מצב פעולה',
  'sim.results.netVoltage': 'מתח ביחס ל-GND',
  'sim.results.potential': 'פוטנציאל ב{terminal}',
  'sim.results.undefined': 'לא מוגדר',
  'sim.results.notSimulated': 'לא מחובר: לא מדומה.',
  'sim.results.outsideModel':
    'מחוץ לטווח המתועד של מודל ה-LED (‏1–20 mA). הערך נובע מהמודל אך עשוי להיות שונה מרכיב אמיתי.',
  'sim.results.ledLit': 'בהירות סמל ה-LED היא רמז חזותי הנגזר מהזרם המחושב, לא מדידת אור.',
  'sim.mode.cv': 'CV · מתח קבוע',
  'sim.mode.cc': 'CC · הגבלת זרם',
  'sim.mode.off': 'היציאה כבויה',
  'sim.badge.cv': 'CV',
  'sim.badge.cc': 'CC',
  'sim.badge.off': 'כבוי',
  'inspector.stopToChange': 'יש לעצור את הסימולציה כדי לשנות ערך זה.',

  'canvas.hint.probe':
    '[[probe]]: לחצו על [[terminal]] או חוט למתח ביחס ל-GND, או על [[component]] לזרם שלו. Esc לסיום.',
  'probe.tool': '[[probe]]',
  'probe.voltageLabel': 'V({point}) = {value}',
  'probe.currentLabel': 'I({point}) = {value}',
  'probe.noValue': '—',
  'probes.heading': 'נקודות מדידה',
  'probes.empty': 'אין נקודות מדידה. השתמשו בכלי נקודת המדידה במשטח השרטוט כדי להצמיד מתח או זרם.',
  'probes.remove': 'הסרת נקודת המדידה {point}',
  'probes.clear': 'הסרת כל נקודות המדידה',
  'probes.note': 'נקודות מדידה רק קוראות ערכים מחושבים. הן אינן מעמיסות על המעגל ואינן משנות אותו.',
  'switch.state.closed': 'סגור',
  'switch.state.open': 'פתוח',
  'switch.state.pressed': 'לחוץ',
  'switch.state.released': 'משוחרר',
  'switch.button.hint':
    'בזמן ריצה, החזיקו את ה[[pushButton]] במשטח השרטוט, או החזיקו רווח כשהוא בפוקוס. מצב הלחיצה לעולם אינו נשמר.',
  'switch.toggle.hint':
    'לחצו על הידית במשטח השרטוט, או הקישו רווח כשה[[toggleSwitch]] בפוקוס. המצב נשמר עם הפרויקט.',
  'psu.panel.title': 'ספק כוח מעבדתי',
  'psu.measured': 'יציאה (נמדדת)',
  'psu.settings': 'הגדרות',
  'psu.voltage': 'מתח',
  'psu.current': 'זרם',
  'psu.notRunning': 'לא פועל',
  'psu.ccNote': 'הגבלת זרם היא התנהגות תקינה של ספק, לא תקלה.',
  'checks.heading': 'בדיקות מעגל',
  'checks.none': 'לא נמצאו בעיות.',
  'checks.not_connected': 'לא מחוברים ולא ידומו: {components}.',
  'checks.partially_wired': '{component}: {terminals} לא מחובר.',
  'checks.wire_over_terminal':
    'חוט עובר מעל {component} {terminal} בלי להתחבר אליו. חוטים מתחברים רק בהדקים ובנקודות צומת.',
  'checks.floating_island': 'אין מסלול ל-GND: {components}.',
  'checks.no_ground': 'למעגל אין GND. הוסיפו [[ground]] וחברו אותה למעגל.',
  'checks.psu_shorted_by_wire': '{component}: הדקי היציאה מחוברים זה לזה בחוט.',
  'history.undo': 'ביטול',
  'history.redo': 'ביצוע מחדש',
  'sim.results.contact': 'מגע',
  'inspector.heading': 'מאפיינים',
  'inspector.empty': 'לא נבחר דבר. בחרו רכיב כדי לראות ולערוך את מאפייניו.',
  'inspector.multi': '{count} פריטים נבחרו',
  'inspector.reference': 'מזהה',
  'inspector.type': 'סוג',
  'inspector.rotate': 'סיבוב 90°',
  'inspector.delete': 'מחיקה',
  'inspector.wire': 'חוט',
  'inspector.junction': '[[junction]]',
  'inspector.net': '[[net]]',
  'inspector.range': 'טווח מותר: {min} עד {max}',
  'inspector.shortcuts': 'מקלדת: החיצים מזיזים, R מסובב, Delete מוחק, Esc מבטל.',

  'error.parse.empty': 'יש להזין ערך.',
  'error.parse.invalid': 'ערך לא תקין. דוגמאות: 220, 1k, 4k7, 1.5k',
  'error.parse.decimal_comma': 'יש להשתמש בנקודה כמפריד עשרוני, לדוגמה 1.5k.',
  'error.parse.wrong_unit': 'היחידה אינה מתאימה למאפיין זה.',
  'error.range': 'הערך חייב להיות בין {min} לבין {max}.',
  'error.edit.same_endpoint': 'חוט אינו יכול להתחיל ולהסתיים באותה נקודה.',
  'error.edit.not_on_wire': 'הנקודה אינה נמצאת על החוט.',
  'error.edit.name_empty': 'שם הפרויקט אינו יכול להיות ריק.',
  'error.edit.generic': 'לא ניתן היה להחיל את השינוי ({code}).',

  'open.error.invalid': 'הפרויקט פגום ולא ניתן לפתוח אותו. שאר הפרויקטים שלכם אינם מושפעים.',
  'open.error.unmigratable': 'הפרויקט שמור בפורמט ישן שלא ניתן להמיר.',
  'open.error.missing': 'הפרויקט כבר אינו קיים בדפדפן זה.',
  'readonly.newer':
    'הפרויקט נשמר בגרסה חדשה יותר של TBI Lab (פורמט {version}). הוא פתוח לקריאה בלבד והשינויים אינם נשמרים.',
  'readonly.unreadable':
    'הפרויקט נשמר בגרסה חדשה יותר של TBI Lab (פורמט {version}) ולא ניתן להציג אותו בגרסה זו.',
  'app.reload': 'טעינה מחדש',
  'library.examples.heading': 'התחלה מדוגמה',
  'library.examples.intro':
    'כל דוגמה נפתחת כפרויקט חדש משלכם. לחצו על "הרצה" כדי לראות תוצאות אמיתיות.',
  'library.examples.open': 'פתיחת הדוגמה',
  'library.examples.openNamed': 'פתיחת הדוגמה: {name}',
  'library.import.button': 'ייבוא פרויקט…',
  'library.import.label': 'ייבוא קובץ פרויקט של TBI Lab ‏(.tbilab)',
  'library.actions': 'פעולות עבור {name}',
  'library.open': 'פתיחת {name}',
  'library.rename': 'שינוי שם',
  'library.rename.label': 'שם חדש עבור {name}',
  'library.rename.save': 'שמירה',
  'library.rename.cancel': 'ביטול',
  'library.duplicate': 'שכפול',
  'library.export': 'ייצוא',
  'library.delete': 'מחיקה',
  'library.delete.title': 'למחוק את הפרויקט?',
  'library.delete.body':
    'הפרויקט "{name}" יוסר לצמיתות מדפדפן זה. שאר הפרויקטים שלכם אינם מושפעים. לא ניתן לבטל פעולה זו, לכן ייצאו את הפרויקט קודם אם ייתכן שתצטרכו אותו שוב.',
  'library.delete.confirm': 'מחיקת הפרויקט',
  'library.delete.cancel': 'השארת הפרויקט',
  'library.copyName': '{name} (עותק)',
  'library.copyNameN': '{name} (עותק {n})',
  'library.error.nameTaken': 'כבר קיים פרויקט בשם "{name}". בחרו שם אחר.',
  'library.duplicated': 'נוצר "{name}".',
  'library.deleted': 'נמחק "{name}".',
  'library.error.rename': 'לא ניתן היה לשנות את שם הפרויקט. הוא לא השתנה; נסו שוב.',
  'library.error.duplicate': 'לא ניתן היה ליצור את העותק. הפרויקט המקורי לא השתנה; נסו שוב.',
  'library.error.delete': 'לא ניתן היה למחוק את הפרויקט. הוא עדיין ברשימה, ללא שינוי; נסו שוב.',
  'library.error.create': 'לא ניתן היה ליצור את הפרויקט באחסון של הדפדפן. דבר לא שונה; נסו שוב.',
  'library.error.newer':
    'הפרויקט נשמר בגרסה חדשה יותר של TBI Lab, ולא ניתן לשנות או לייצא אותו בגרסה זו.',
  'storage.error.read':
    'TBI Lab לא הצליח לקרוא את אחסון הפרויקטים של הדפדפן. הפרויקטים שלכם לא שונו. טענו את הדף מחדש כדי לנסות שוב.',
  'storage.error.quota':
    'האחסון של TBI Lab בדפדפן זה מלא, ולכן לא ניתן היה לשמור דבר חדש. הפרויקטים הקיימים שלכם בטוחים. ייצאו או מחקו פרויקטים שאינכם צריכים, ונסו שוב.',
  'save.error.banner':
    'השינויים האחרונים שלכם עדיין לא נשמרו. הם עדיין כאן בעורך. נסו שוב, או ייצאו עותק כדי לשמור עליהם.',
  'save.error.quotaBanner':
    'אחסון הדפדפן מלא, ולכן השינויים האחרונים שלכם עדיין לא נשמרו. הם עדיין כאן בעורך. ייצאו עותק או מחקו פרויקטים שאינכם צריכים, ונסו שוב.',
  'export.button': 'ייצוא',
  'export.title': 'שמירת הפרויקט כקובץ נייד ‏.tbilab',
  'export.error': 'לא ניתן היה ליצור את קובץ הפרויקט. הפרויקט עצמו לא השתנה; נסו שוב.',
  'import.done': 'יובא "{name}".',
  'import.doneCopy':
    '"{name}" יובא כעותק חדש, כי פרויקט עם אותה זהות כבר קיים בדפדפן זה. הפרויקט הקיים לא שונה.',
  'import.doneRenamed': 'יובא בשם "{name}", כי כבר קיים בדפדפן זה פרויקט בשם "{original}".',
  'import.doneCopyRenamed':
    'יובא כעותק חדש בשם "{name}", כי הפרויקט כבר קיים בדפדפן זה. הפרויקט הקיים לא שונה.',
  'import.error.too_large': 'הקובץ גדול מ־⁦2 MB⁩, גדול בהרבה מפרויקט של TBI Lab. דבר לא יובא.',
  'import.error.not_package': 'זה אינו קובץ פרויקט של TBI Lab ‏(.tbilab). דבר לא יובא.',
  'import.error.damaged':
    'קובץ הפרויקט פגום או שונה מחוץ ל־TBI Lab, ולכן אי אפשר לסמוך עליו. דבר לא יובא.',
  'import.error.newer':
    'קובץ הפרויקט נוצר בגרסה חדשה יותר של TBI Lab. עדכנו את TBI Lab כדי לפתוח אותו. דבר לא יובא.',
  'import.error.old': 'קובץ הפרויקט שמור בפורמט ישן שלא ניתן להמיר. דבר לא יובא.',
  'import.error.invalid':
    'קובץ הפרויקט מכיל מעגל ש־TBI Lab אינו יכול לקבל (למשל [[component]] לא מוכר או ערך לא תקין). דבר לא יובא.',
  'import.error.read': 'לא ניתן היה לקרוא את הקובץ. דבר לא יובא.',
  'import.error.storage': 'לא ניתן היה לשמור את הפרויקט באחסון של הדפדפן. דבר לא יובא; נסו שוב.',
  'example.error': 'לא ניתן היה לפתוח את הדוגמה.',
  'example.ohms-law.title': 'חוק אוהם',
  'example.ohms-law.summary':
    'ספק של ⁦5 V⁩ על נגד של ⁦1 kΩ⁩. הריצו וקראו ⁦I = V / R = 5 mA⁩, ואז שנו את ההתנגדות והריצו שוב.',
  'example.voltage-divider.title': 'מחלק מתח',
  'example.voltage-divider.summary':
    'שני נגדים מחלקים ⁦9 V⁩. נקודת האמצע היא ⁦9 V × 20 kΩ / (10 kΩ + 20 kΩ) = 6 V⁩; [[probe]] ב־⁦R2.a⁩ מודדת אותה.',
  'example.led-current.title': 'הגבלת זרם לנורית LED',
  'example.led-current.summary':
    'נגד של ⁦220 Ω⁩ קובע את הזרם של נורית LED אדומה מ־⁦5 V⁩. הנורית אינה ליניארית: היא מתייצבת סביב ⁦2 V⁩ ובערך ⁦14 mA⁩.',
  'example.diode-polarity.title': 'קוטביות דיודה',
  'example.diode-polarity.summary':
    'שני ענפים זהים עם [[diode]] ⁦1N4148⁩. ⁦D1⁩ בממתח קדמי ומוליכה כ־⁦4.3 mA⁩; ⁦D2⁩ הפוכה וחוסמת (ננו־אמפרים בודדים).',
  'example.push-button.title': 'לחצן רגעי',
  'example.push-button.summary':
    'לחצו על "הרצה" ואז החזיקו את ⁦SW1⁩: הנורית דולקת רק כל עוד הלחצן לחוץ. הלחיצה אינה משנה את הפרויקט השמור.',
  'example.cc-mode.title': 'הגבלת זרם (מצב CC)',
  'example.cc-mode.summary':
    '⁦5 V⁩ עם הגבלה של ⁦100 mA⁩: נגד של ⁦100 Ω⁩ צורך ⁦50 mA⁩ (CV). בזמן ההרצה סגרו את ⁦SW1⁩ כדי להוסיף ⁦10 Ω⁩. עומס זה היה דורש ⁦550 mA⁩, ולכן הספק מחזיק ⁦100 mA⁩ והמתח שלו יורד (CC). זו התנהגות רגילה, לא תקלה.',
  'palette.group.sources': 'הזנה וייחוס',
  'palette.group.passive': 'נגדים',
  'palette.group.semiconductors': 'דיודות',
  'palette.group.switches': 'מתגים',
  'inspector.shortcutsHeading': 'קיצורי מקלדת',
  'unit.watt.symbol': 'W',
  'sim.results.power': 'הספק',
  'brand.logoAlt': 'TBI: חושבים, מפיחים חיים ברעיונות, ממציאים',
  'home.subtitle': 'המעגלים מדומים ונשמרים כאן, בדפדפן שלכם. התחילו מדוגמה, או צרו פרויקט משלכם.',
  'app.narrowScreen': 'TBI Lab מיועד למסכי מחשב ברוחב של 1024 פיקסלים לפחות.',
  'rating.heading': 'חריגה מדירוגי הרכיב',
  'rating.atRisk': '{component} עלול להינזק',
  'rating.row.forward_current': 'זרם: {value} (מקסימום {limit})',
  'rating.row.reverse_voltage': 'מתח הפוך: {value} (מקסימום {limit})',
  'rating.row.power': 'הספק: {value} (מקסימום {limit})',
  'rating.note': 'הסימולציה ממשיכה להציג את הערכים המחושבים ואינה מדמה נזק לרכיב.',
};
