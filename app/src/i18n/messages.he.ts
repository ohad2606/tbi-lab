import type { MessageKey } from './messages.en.js';

/**
 * Hebrew message catalogue. Typed against the English key set, so a missing key is a compile
 * error as well as a test failure. Technical terms and unit symbols stay as used
 * professionally in Hebrew (Ω, V, A, Esc, R, Delete).
 */
export const he: Record<MessageKey, string> = {
  'app.loading': 'טוען…',
  'app.storageUnavailable': 'האחסון המקומי אינו זמין בדפדפן זה, ולכן לא ניתן לשמור פרויקטים.',

  'home.title': 'פרויקטים',
  'home.new.heading': 'פרויקט חדש',
  'home.new.nameLabel': 'שם הפרויקט',
  'home.new.defaultName': 'פרויקט ללא שם',
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

  'palette.heading': 'רכיבים',
  'palette.hint': 'בחרו רכיב ולחצו על משטח השרטוט כדי למקם אותו.',

  'canvas.label': 'משטח השרטוט',
  'canvas.zoomIn': 'הגדלה',
  'canvas.zoomOut': 'הקטנה',
  'canvas.zoomFit': 'התאמה לתצוגה',
  'canvas.hint.idle': 'לחצו על הדק כדי להתחיל חוט. גררו על שטח ריק כדי לבחור.',
  'canvas.hint.placing': 'לחצו על משטח השרטוט כדי למקם. Esc לביטול.',
  'canvas.hint.wiring':
    'לחצו על הדק, צומת או חוט כדי לסיים. לחיצה על שטח ריק מוסיפה פינה. Esc לביטול.',
  'canvas.componentLabel': '{ref}, {type}',
  'canvas.junctionLabel': 'צומת {id}',

  'component.instrument.lab_psu.name': 'ספק כוח מעבדתי',
  'component.component.ground.name': 'הארקה',
  'component.component.resistor.name': 'נגד',
  'component.component.led.name': 'נורית LED',

  'terminal.positive': 'חיובי (+)',
  'terminal.negative': 'שלילי (−)',
  'terminal.ref': 'ייחוס',
  'terminal.a': 'הדק a',
  'terminal.b': 'הדק b',
  'terminal.anode': 'אנודה',
  'terminal.cathode': 'קתודה',

  'param.setpointVoltage': 'מתח מכוון',
  'param.currentLimit': 'הגבלת זרם',
  'param.outputEnabled': 'יציאה פעילה',
  'param.resistance': 'התנגדות',
  'param.model': 'דגם',
  'model.led.vishay_tlhr5400': 'אדומה 5 מ"מ (Vishay TLHR5400)',

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',

  'inspector.heading': 'מאפיינים',
  'inspector.empty': 'לא נבחר דבר. בחרו רכיב כדי לראות ולערוך את מאפייניו.',
  'inspector.multi': '{count} פריטים נבחרו',
  'inspector.reference': 'מזהה',
  'inspector.type': 'סוג',
  'inspector.rotate': 'סיבוב 90°',
  'inspector.delete': 'מחיקה',
  'inspector.wire': 'חוט',
  'inspector.junction': 'צומת',
  'inspector.net': 'רשת',
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

  'open.error.invalid': 'הפרויקט פגום ולא ניתן לפתוח אותו.',
  'open.error.unmigratable': 'הפרויקט שמור בפורמט ישן שלא ניתן להמיר.',
  'open.error.missing': 'הפרויקט כבר אינו קיים בדפדפן זה.',
  'readonly.newer':
    'הפרויקט נשמר בגרסה חדשה יותר של TBI Lab (פורמט {version}). הוא פתוח לקריאה בלבד והשינויים אינם נשמרים.',
  'readonly.unreadable':
    'הפרויקט נשמר בגרסה חדשה יותר של TBI Lab (פורמט {version}) ולא ניתן להציג אותו בגרסה זו.',
};
