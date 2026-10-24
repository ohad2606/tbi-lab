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
  'topbar.signOut': 'יציאה',
  'deployment.preview': 'תצוגה מקדימה {name} · ניסיונית',
  'deployment.previewNote':
    'תצוגה מקדימה ניסיונית, נפרדת מהסביבה המאומתת. הפרויקטים שלה נשמרים בנפרד.',
  'menu.button': 'תפריט',
  'menu.newProject': 'פרויקט חדש…',
  'menu.export': 'ייצוא פרויקט',
  'home.import.lead': 'או המשיכו מקובץ ⁦.tbilab⁩:',

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
  'canvas.routeLimit':
    'הפרויקט גדול מאוד: {count} חוטים משורטטים בצורה פשוטה (הם עשויים לעבור קרוב לפינים או לחוטים אחרים). החיבורים הם בדיוק כפי שהם משורטטים.',
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
  'model.led.vishay_tlhy5400': 'צהובה 5 מ"מ (Vishay TLHY5400)',
  'model.led.vishay_tlhg4900': 'ירוקה 3 מ"מ (Vishay TLHG4900)',

  // ---- Sprint 10: approved component families (PM-6 revision) ----
  'component.component.rgb_led.name': 'נורית RGB',
  'component.component.photoresistor.name': '[[photoresistor]]',
  'component.component.buzzer.name': '[[buzzer]]',
  'component.component.relay.name': '[[relay]]',
  'terminal.red': 'אנודה אדומה (R)',
  'terminal.green': 'אנודה ירוקה (G)',
  'terminal.blue': 'אנודה כחולה (B)',
  'terminal.commonCathode': 'קתודה משותפת (K)',
  'terminal.coil1': 'סליל (A1)',
  'terminal.coil2': 'סליל (A2)',
  'terminal.com': 'משותף (COM)',
  'terminal.no': 'פתוח במנוחה (NO)',
  'terminal.nc': 'סגור במנוחה (NC)',
  'param.illuminance': 'אור על התא (עוצמת הארה)',
  'model.rgb_led.kingbright_wp154a4sureqbfzgc': 'קתודה משותפת 5 מ"מ (Kingbright WP154A4SUREQBFZGC)',
  'model.ldr.senba_gl5528': 'תא CdS 5 מ"מ (GL5528)',
  'model.buzzer.cui_cem_1205_ic': 'אקטיבי 5 V, 12 מ"מ (CUI Devices CEM-1205-IC)',
  'model.relay.songle_srd_05vdc_sl_c': 'סליל 5 V, SPDT (Songle SRD-05VDC-SL-C)',
  'component.logic.gate_and.name': 'שער AND',
  'component.logic.gate_nand.name': 'שער NAND',
  'component.logic.gate_or.name': 'שער OR',
  'component.logic.gate_not.name': 'שער NOT (מהפך)',
  'model.logic.sn74lvc1g08': 'TI SN74LVC1G08, SOT-23-5 על כרטיס מתאם',
  'model.logic.sn74lvc1g00': 'TI SN74LVC1G00, SOT-23-5 על כרטיס מתאם',
  'model.logic.sn74lvc1g32': 'TI SN74LVC1G32, SOT-23-5 על כרטיס מתאם',
  'model.logic.sn74lvc1g04': 'TI SN74LVC1G04, SOT-23-5 על כרטיס מתאם',
  'terminal.logic_a': 'כניסה A',
  'terminal.logic_b': 'כניסה B',
  'terminal.logic_y': 'יציאה Y',
  'terminal.logic_gnd': '[[ground]]',
  // Exploration Foundation L3: רכיב לוגי במארז (TI SN74LVC08A, ארבעה שערי AND בעלי שתי כניסות).
  'component.logic.quad_and.name': 'רכיב ארבעה שערי AND (‏4 × 2 כניסות)',
  'model.logic.sn74lvc08a': 'TI SN74LVC08A, SOIC-14 על כרטיס מתאם',
  'terminal.logic_a1': 'שער 1 כניסה A (1A)',
  'terminal.logic_b1': 'שער 1 כניסה B (1B)',
  'terminal.logic_y1': 'שער 1 יציאה Y (1Y)',
  'terminal.logic_a2': 'שער 2 כניסה A (2A)',
  'terminal.logic_b2': 'שער 2 כניסה B (2B)',
  'terminal.logic_y2': 'שער 2 יציאה Y (2Y)',
  'terminal.logic_a3': 'שער 3 כניסה A (3A)',
  'terminal.logic_b3': 'שער 3 כניסה B (3B)',
  'terminal.logic_y3': 'שער 3 יציאה Y (3Y)',
  'terminal.logic_a4': 'שער 4 כניסה A (4A)',
  'terminal.logic_b4': 'שער 4 כניסה B (4B)',
  'terminal.logic_y4': 'שער 4 יציאה Y (4Y)',
  'sim.part.current.a1': 'כניסה 1A',
  'sim.part.current.b1': 'כניסה 1B',
  'sim.part.current.y1': 'זרם יציאה (1Y)',
  'sim.part.current.a2': 'כניסה 2A',
  'sim.part.current.b2': 'כניסה 2B',
  'sim.part.current.y2': 'זרם יציאה (2Y)',
  'sim.part.current.a3': 'כניסה 3A',
  'sim.part.current.b3': 'כניסה 3B',
  'sim.part.current.y3': 'זרם יציאה (3Y)',
  'sim.part.current.a4': 'כניסה 4A',
  'sim.part.current.b4': 'כניסה 4B',
  'sim.part.current.y4': 'זרם יציאה (4Y)',
  'palette.group.logic': 'לוגיקה',
  'library.examples.category.logic': 'לוגיקה ספרתית',
  'sim.part.state.gateOutput': 'יציאה',
  'sim.part.state.gateOutput.high': 'HIGH',
  'sim.part.state.gateOutput.low': 'LOW',
  'sim.part.state.gateOutput.x': 'לא ידוע (X)',
  'sim.part.state.gateOutput.off': 'כבוי (ללא הזנה)',
  'sim.part.state.input_a': 'כניסה A',
  'sim.part.state.input_a.high': 'HIGH',
  'sim.part.state.input_a.low': 'LOW',
  'sim.part.state.input_a.x': 'לא ידוע (X): בין V_IL ל-V_IH',
  'sim.part.state.input_b': 'כניסה B',
  'sim.part.state.input_b.high': 'HIGH',
  'sim.part.state.input_b.low': 'LOW',
  'sim.part.state.input_b.x': 'לא ידוע (X): בין V_IL ל-V_IH',
  'sim.part.state.supplyV': 'מתח הזנה (V_CC − GND)',
  'sim.part.state.outputModel': 'אופיין היציאה',
  'sim.part.state.outputModel.tabulated': 'מובטח (נקודות הבדיקה של גיליון הנתונים במתח זה)',
  'sim.part.state.outputModel.ranged': 'מובטח רק עד 100 µA במתח זה',
  'sim.part.state.outputModel.class':
    'חסם תחתון מובטח: נקודות גיליון הנתונים של 3 V על פני תחום 3.3 V ± 0.3 V (רכיב אמיתי מספק לפחות זאת)',
  'sim.part.state.outputValidA': 'מאופיין עד',
  'sim.part.state.iccMaxA': 'זרם הזנה במנוחה (מקסימום בגיליון הנתונים, לא כלול למעלה)',
  'sim.part.current.y': 'זרם יציאה (Y)',
  'sim.part.current.vcc': 'זרם בפין ההזנה (V_CC)',
  'sim.part.current.gnd': 'זרם בפין האדמה (GND)',
  'sim.results.unknown':
    'לא ידוע: רמה לוגית לא מוגדרת מגיעה לרכיב הזה, ולכן לא מוצג ערך. בדקו את הכניסות הלוגיות המסומנות כלא ידועות (X).',
  'sim.error.logic_input_floating':
    '{components}: דבר אינו מזין את כניסה {pin}: שום מסלול נגדי או מקור אינו מגיע אליה. ייתכן שאינה מחוברת, או שהיא מחוברת רק דרך רכיבים שאינם קובעים רמה (נורית LED, דיודה, צומת של טרנזיסטור, זמזם או קבל). לכניסת CMOS צפה אין רמה מוגדרת. חברו אותה לאות, ל-V_CC או ל-GND, או דרך נגד pull-up או pull-down.',
  'sim.error.logic_supply_missing':
    '{components}: ‏V_CC או GND אינם מחוברים. [[logicGate]] צריך שפיני ההזנה שלו יהיו מחוברים.',
  'sim.error.logic_supply_uncharacterized':
    '{components}: מתח ההזנה הוא {supply}, וגיליון הנתונים אינו מאפיין אותו (‎1.65–1.95 V, ‏2.3–2.7 V, ‏3.0–3.6 V או 4.5–5.5 V). הסימולטור אינו ממציא ספים בין שורות גיליון הנתונים.',
  'sim.error.logic_output_uncharacterized':
    '{components}: במתח {supply} גיליון הנתונים מבטיח את היציאה רק עד {limit}, והעומס הזה צורך {current}, או שהיציאה נדחפת מעבר לפס ההזנה שלה. השתמשו בעומס קל יותר, או במתח שבו היציאה מאופיינת לעומסים אמיתיים (1.65 V, ‏2.3 V או 4.5 V בדיוק, או 3.0–3.6 V).',
  'sim.error.logic_feedback_unsupported':
    '{components}: יציאה לוגית מוזנת חזרה לרשת שלה (נעילה או מתנד). התנהגותה תלויה בהשהיית ההתפשטות, שגרסה זו אינה מדמה.',
  'sim.error.logic_unknown_state':
    '{components}: רמה לוגית לא מוגדרת מגיעה אל {pin}, שחייב להיות לו ערך מוגדר. בדקו את הכניסות הלוגיות המסומנות כלא ידועות (X).',
  'sim.error.logic_unpowered_uncharacterized':
    '{components}: ‏V_CC הוא 0 V (ללא הזנה). גיליון הנתונים של רכיב זה אינו נותן מפרט למצב ללא הזנה (אין I_off), ולכן רכיב ללא הזנה אינו מדומה. הפעילו את ההזנה שלו.',
  'sim.error.logic_input_undefined':
    '{components}: כניסה {pin} נמצאת ב-{voltage}, בין {vil} ל-{vih} ‏({vccEq}). גיליון הנתונים אינו נותן רמה לוגית ואינו נותן זרם הזנה לכניסה במצב זה, ולכן המעגל אינו מדומה. הביאו את הכניסה לרמה תקפה (V_IL ומטה, או V_IH ומעלה).',
  'sim.error.logic_input_out_of_range':
    '{components}: כניסה {pin} נמצאת ב-{voltage}, מחוץ לתחום הכניסה המומלץ 0–5.5 V, שבו גיליון הנתונים אינו מפרט את התנהגות הרכיב.',
  'sim.error.logic_input_floating.sn74lvc08a':
    '{components}: דבר אינו מזין את כניסה {pin}: שום מסלול נגדי או מקור אינו מגיע אליה (ייתכן שאינה מחוברת, או שהיא מחוברת רק דרך נורית LED, דיודה, צומת של טרנזיסטור, זמזם או קבל). גיליון הנתונים של SN74LVC08A דורש שכל כניסה שאינה בשימוש, כולל כניסות של שערים שאינם בשימוש, תוחזק ב-V_CC או ב-GND. חברו אותה לאות, ל-V_CC או ל-GND, או דרך נגד pull-up או pull-down.',
  'sim.error.logic_supply_uncharacterized.sn74lvc08a':
    '{components}: מתח ההזנה הוא {supply}, וגיליון הנתונים של SN74LVC08A אינו מאפיין אותו (‎1.65–1.95 V או 2.3–3.6 V). הסימולטור אינו ממציא ספים בין שורות גיליון הנתונים.',
  'sim.error.logic_output_uncharacterized.sn74lvc08a':
    '{components}: במתח {supply} גיליון הנתונים של SN74LVC08A מבטיח את יציאה {pin} רק עד {limit}, היוצא מיציאה במצב HIGH או נכנס ליציאה במצב LOW; כאן עובר בה {current}, או שהיא נדחפת מעבר לפס ההזנה שלה. עומסים אמיתיים מאופיינים רק ב-1.65 V, ‏2.3 V, ‏2.7 V או 3.0 V בדיוק.',
  // L2: בדיקת מצב לוגי / טבלת אמת.
  'logic.inspect.title': 'לוגיקה: טבלת אמת ומצב הפינים',
  'logic.inspect.thresholds':
    '{part} ב-{supply}: ‏HIGH מ-{vih} ומעלה, ‏LOW עד {vil} (גיליון הנתונים; היכן ששתי שורות נפגשות, המחמירה). ביניהם: לא מוגדר.',
  'logic.inspect.noRow': '{part}: אין בגיליון הנתונים ספי כניסה במתח הזנה זה.',
  'logic.inspect.pin': 'פין',
  'logic.inspect.level': 'רמה',
  'logic.inspect.voltage': 'מתח ביחס לפין GND',
  'logic.inspect.level.high': 'HIGH',
  'logic.inspect.level.low': 'LOW',
  'logic.inspect.level.off': 'כבוי (ללא הזנה)',
  'logic.inspect.level.undefined': 'לא מוגדר (בין V_IL ל-V_IH)',
  'logic.inspect.level.unknown': 'לא ידוע (X)',
  'logic.inspect.truthTable': 'טבלת אמת ({fn})',
  'logic.inspect.gatesHere': 'שערים במצב זה',
  'logic.inspect.note':
    'הרמות והמתחים הם של הסימולציה, נמדדים ביחס לפין ה-GND של הרכיב עצמו. השורה המודגשת היא של השער הנבחר. כניסה מחוץ לתחומים המוגדרים דוחה את ההרצה; היא לעולם אינה מוצגת כרמה.',
  'logic.controls.hold': '{id} ב-{pin}: החזיקו כדי ללחוץ',
  'logic.controls.toggleOpen': '{id} ב-{pin}: פתוח (לחצו לסגירה)',
  'logic.controls.toggleClosed': '{id} ב-{pin}: סגור (לחצו לפתיחה)',
  'logic.controls.mcu': '{pin}: מוזנת מה-ESP32 ‏({gpio}) לפי הקושחה.',
  'logic.controls.heading': 'הפעלת הכניסות',
  'logic.why.idle': 'הפעילו את הסימולציה כדי לראות את הרמה והמתח של הפין הזה.',
  'logic.why.waiting': 'ממתין לנקודת העבודה הראשונה.',
  'logic.why.refusedElsewhere': 'לא מדומה: ההרצה נדחתה (ראו את ההודעה למעלה).',
  'logic.why.outputUncharacterized':
    'העומס דורש יותר מזרם היציאה המובטח ({limit}, ‏{vcc}), או דוחף את היציאה מעבר לפס ההזנה: אין אופיין, ולכן הסימולציה נדחית.',
  'logic.why.outOfRange':
    '{v}: מחוץ לתחום הכניסה המומלץ 0–5.5 V, שבו גיליון הנתונים אינו מפרט את הרכיב. הסימולציה נדחית.',
  'logic.why.floatingPads':
    'דבר אינו מזין את הכניסה הזו: המקור האפשרי היחיד ברשת שלה (ישירות או דרך נגדים) הוא {pads}, פין של ESP32 במצב כניסה (עכבה גבוהה). הסימולציה נדחית. הוסיפו נגד pull-down או pull-up ‏(10 kΩ).',
  'logic.why.floatingPadsMany':
    'דבר אינו מזין את הכניסה הזו: המקורות האפשריים היחידים ברשת שלה (ישירות או דרך נגדים) הם {pads}, פינים של ESP32 במצב כניסה (עכבה גבוהה). הסימולציה נדחית. הוסיפו נגד pull-down או pull-up ‏(10 kΩ).',
  'logic.why.floating':
    'דבר אינו מזין את הכניסה הזו: שום מסלול נגדי או מקור אינו מגיע אליה (לא מחוברת, או רק דרך נורית LED, דיודה, צומת של טרנזיסטור, זמזם או קבל, שאינם קובעים רמה). לכניסת CMOS צפה אין רמה מוגדרת, ולכן הסימולציה נדחית.',
  'logic.why.undefined':
    '{v}: בין {vil} ל-{vih} ‏({vcc}). גיליון הנתונים אינו נותן שם רמה, ולכן הסימולציה נדחית.',
  'logic.why.unknown': 'רמה לא מוגדרת מגיעה לפין הזה: לא מוצגים רמה ומתח.',
  'logic.why.off': '‏V_CC הוא 0 V: היציאות מנותקות (I_off).',
  'logic.why.offInput':
    'הרכיב ללא הזנה (V_CC = 0 V): לכניסות שלו אין ספים בגיליון הנתונים, ולכן לא ניתנת רמה; המתח המוצג הוא המתח שחושב.',
  'logic.why.out': '{fn} של הכניסות ({ins}) = {out}, לפי טבלת הפונקציה בגיליון הנתונים.',
  'logic.why.inLow': '{cmp} ‏({vcc}): ‏LOW.',
  'logic.why.inHigh': '{cmp} ‏({vcc}): ‏HIGH.',
  'logic.inspect.level.idle': '—',
  'logic.inspect.level.notSimulated': 'לא מדומה',
  'logic.inspect.level.unsupported': 'לא מאופיין',
  'logic.inspect.level.outOfRange': 'מחוץ ל-0–5.5 V',
  'logic.inspect.level.floating': 'צפה (לא מוזנת)',
  'logic.inspect.noteIdle':
    'עדיין לא מדומה: זו טבלת הפונקציה מגיליון הנתונים. מתחים ורמות מוצגים בזמן שהסימולציה רצה.',
  'logic.inspect.rowsCaption':
    'ספי הכניסה מגיליון הנתונים לפי מתח ההזנה (V_CC). בין השורות הסימולטור דוחה במקום להמציא סף.',
  'logic.inspect.gateN': 'שער {n}',
  'logic.inspect.gates': 'שערים',
  'logic.inspect.idle':
    '{part}: טבלת הפונקציה וספי הכניסה מגיליון הנתונים. הפעילו את הסימולציה כדי לראות את הרמה והמתח של כל פין.',
  'sim.part.current.red': 'זרם הערוץ האדום',
  'sim.part.current.green': 'זרם הערוץ הירוק',
  'sim.part.current.blue': 'זרם הערוץ הכחול',
  'sim.part.current.coil': 'זרם הסליל',
  'sim.part.current.contact': 'זרם המגע (COM)',
  'sim.part.state.energized': '[[relay]] מופעל',
  'sim.part.state.contact': 'COM מחובר אל',
  'sim.part.state.contact.no': 'NO (פתוח במנוחה)',
  'sim.part.state.contact.nc': 'NC (סגור במנוחה)',
  'sim.part.state.sounding': 'משמיע צליל',
  'sim.part.state.resistance': 'התנגדות בעוצמת האור הנוכחית',
  'component.component.bjt_npn.name': '[[transistor]] NPN',
  'terminal.collector': 'קולקטור (C)',
  'terminal.base': 'בסיס (B)',
  'terminal.emitter': 'אמיטר (E)',
  'model.bjt.fairchild_2n3904': '2N3904 לשימוש כללי (מודל SPICE של Fairchild)',
  'sim.part.current.collector': 'זרם קולקטור',
  'sim.part.current.base': 'זרם בסיס',
  'sim.part.current.emitter': 'זרם אמיטר',
  'sim.part.current.vce': 'קולקטור–אמיטר',
  'sim.part.current.vcb': 'קולקטור–בסיס',
  'sim.part.current.veb': 'אמיטר–בסיס (הפוך)',
  'sim.part.state.region': 'אזור עבודה',
  'sim.part.state.region.cutoff': 'קטעון',
  'sim.part.state.region.active': 'פעיל קדמי (הגברה)',
  'sim.part.state.region.saturation': 'רוויה (מופעל כמתג)',
  'sim.part.state.region.reverse': 'פעיל הפוך',
  'sim.part.short.collector': 'I_C',
  'sim.part.short.base': 'I_B',
  'sim.part.short.emitter': 'I_E',
  'sim.part.voltage.component.bjt_npn': 'מתח קולקטור–אמיטר (V_CE)',
  'component.sensor.pir_hc_sr501.name': 'חיישן תנועה PIR',
  'terminal.moduleGnd': 'אדמה (GND)',
  'terminal.out': 'יציאה (OUT)',
  'terminal.vcc': 'הזנה (VCC)',
  'param.motion': 'תנועה מול החיישן',
  'model.pir.hc_sr501': 'מודול HC-SR501 (BISS0001, יציאה 3.3 V)',
  'sim.part.current.supply': 'זרם הזנה',
  'sim.part.current.output': 'זרם יציאה',
  'sim.part.state.powered': 'מוזן (הזנה 4.5–20 V)',
  'sim.part.state.output': 'יציאה',
  'sim.part.state.output.high': 'HIGH (זוהתה תנועה)',
  'sim.part.state.output.low': 'LOW',
  'component.display.led_matrix_8x8.name': 'מטריצת LED 8×8',
  'model.led_matrix.oasis_1088as': 'אדומה, נקודות 3 מ"מ, 32 מ"מ (1088AS)',
  'sim.part.state.lit': 'נקודות דולקות',
  'terminal.row1': 'שורה 1 (קתודות)',
  'terminal.row2': 'שורה 2 (קתודות)',
  'terminal.row3': 'שורה 3 (קתודות)',
  'terminal.row4': 'שורה 4 (קתודות)',
  'terminal.row5': 'שורה 5 (קתודות)',
  'terminal.row6': 'שורה 6 (קתודות)',
  'terminal.row7': 'שורה 7 (קתודות)',
  'terminal.row8': 'שורה 8 (קתודות)',
  'terminal.col1': 'עמודה 1 (אנודות)',
  'terminal.col2': 'עמודה 2 (אנודות)',
  'terminal.col3': 'עמודה 3 (אנודות)',
  'terminal.col4': 'עמודה 4 (אנודות)',
  'terminal.col5': 'עמודה 5 (אנודות)',
  'terminal.col6': 'עמודה 6 (אנודות)',
  'terminal.col7': 'עמודה 7 (אנודות)',
  'terminal.col8': 'עמודה 8 (אנודות)',
  'component.component.capacitor.name': 'קבל',
  'param.capacitance': 'קיבול',
  'param.ratedVoltage': 'מתח נקוב',
  'sim.part.state.charge': 'מטען אגור (קולון)',
  'sim.part.state.energy': 'אנרגיה אגורה (ג׳אול)',
  // ---- Sprint 12: R2 sensors and the R3 I2C display ----
  'component.sensor.hc_sr04.name': 'חיישן מרחק אולטרסוני',
  'component.sensor.dht22.name': 'חיישן טמפרטורה ולחות',
  'component.display.lcd1602_i2c.name': 'צג LCD תווי 16×2 (I2C)',
  'terminal.trig': 'כניסת הפעלה (TRIG)',
  'terminal.echo': 'יציאת הד (ECHO)',
  'terminal.vdd': 'הזנה (VDD)',
  'terminal.data': 'נתונים (DATA)',
  'terminal.notConnected': 'לא מחובר (NC)',
  'terminal.sda': 'נתוני I2C (SDA)',
  'terminal.scl': 'שעון I2C (SCL)',
  'param.distance': 'מרחק מהמטרה',
  'param.airTemperature': 'טמפרטורת האוויר',
  'param.temperature': 'טמפרטורה',
  'param.humidity': 'לחות יחסית',
  'param.i2cAddress': 'כתובת I2C',
  'model.ultrasonic.hc_sr04': 'מודול HC-SR04 (5 V, 40 kHz)',
  'model.humidity.am2302': 'חיישן DHT22 / AM2302 (Aosong, 3.3–6 V)',
  'model.lcd.lcd1602_pcf8574': 'HD44780 16×2 עם מתאם I2C (PCF8574)',
  'i2c.0x20': '0x20',
  'i2c.0x21': '0x21',
  'i2c.0x22': '0x22',
  'i2c.0x23': '0x23',
  'i2c.0x24': '0x24',
  'i2c.0x25': '0x25',
  'i2c.0x26': '0x26',
  'i2c.0x27': '0x27',
  'sim.part.state.output.off': 'לא פעילה (ללא הזנה)',
  'sim.part.state.output.released': 'משוחרר (החיישן אינו מושך את הקו)',
  'sim.part.state.sensor.hc_sr04.powered': 'מוזן (הזנה של 4.5 V לפחות)',
  'sim.part.state.sensor.hc_sr04.output': 'יציאת ECHO',
  'sim.part.state.sensor.hc_sr04.output.high': 'HIGH (פולס הד)',
  'sim.part.state.sensor.dht22.powered': 'מוזן (הזנה של 3.3 V לפחות)',
  'sim.part.state.sensor.dht22.output': 'קו DATA (מצד החיישן)',
  'sim.part.state.sensor.dht22.output.low': 'LOW (החיישן מושך את הקו לנמוך)',
  'sim.part.state.display.lcd1602_i2c.powered': 'מוזן',
  'sim.part.state.backlight': 'תאורה אחורית דולקת',
  'sim.part.state.displayOn': 'התצוגה פעילה',
  'sim.part.state.line1': 'שורה 1',
  'sim.part.state.line2': 'שורה 2',
  'lcd.screen': 'תוכן התצוגה, שורה 1: {line1}; שורה 2: {line2}',
  'lcd.blank': 'התצוגה ריקה',
  // ---- Sprint 15 (R4): the SG90 servo and PWM (LEDC) outputs ----
  'component.component.servo_sg90.name': 'מנוע סרוו SG90',
  'terminal.servoSignal': 'אות בקרה (PWM)',
  'model.servo.sg90': 'TowerPro SG90',
  'sim.results.notModelled': 'לא ממודל',
  'sim.part.state.component.servo_sg90.powered': 'מוזן (הזנה של 4.8–6.0 V)',
  'sim.part.state.angleDeg': 'זווית הציר',
  'sim.part.state.commandedDeg': 'זווית מבוקשת',
  'sim.part.state.signal': 'אות הבקרה',
  'sim.part.state.signal.none': 'אין פולסים',
  'sim.part.state.signal.pulses': 'פולסי סרוו',
  'sim.part.state.signal.static': 'רמה קבועה (ללא פולסים)',
  'sim.part.state.signal.undefined': 'לא רמה לוגית תקינה (אין פולס תקין)',
  'sim.part.state.pulseUs': 'רוחב הפולס האחרון',
  'sim.results.outsideModel.component.servo_sg90':
    'ההזנה מחוץ לטווח הממודל של 4.8–6.0 V: הסרוו מוצג כנשאר במקומו; סרוו אמיתי עשוי להתנהג אחרת.',
  'sim.results.servoCurrentExcluded':
    'אינו כולל את הזרם ש־{components} צורך: זרם ההזנה של סרוו SG90 לא ממודל.',
  'sim.results.pwmAverage': '{label}, ממוצע (PWM)',
  'sim.results.pwmPeak': '{label}, שיא (PWM)',
  'sim.results.pwmNote':
    'מונע ב־PWM: הערכים שלמעלה הם ממוצעים בזמן לאורך צורת הגל; בדיקת הדירוגים משתמשת בזרם השיא.',
  'sim.results.pwmPower': 'לא מוצג תחת PWM (מכפלת המתח הממוצע בזרם הממוצע אינה ההספק הממוצע)',
  'unit.hertz.symbol': 'Hz',
  'unit.second.symbol': 's',
  'unit.percent.symbol': '%',
  'unit.degree.symbol': '°',
  'mcu.pwm.wave': 'PWM {frequency} · {duty}',
  'mcu.pwm.zero': 'PWM · מחזור עבודה 0 (רמת היציאה לא אומתה)',
  'mcu.pwm.static': 'PWM · {level} (קבוע)',
  'mcu.pwm.unsupported': 'PWM · לא נתמך',
  'mcu.pwm.levelUnknown': 'המתח לא ידוע',
  'mcu.pwm.average': 'ממוצע {voltage}',
  'mcu.warning.servo_signal_undefined':
    '{component}: אות הבקרה אינו ברמה לוגית תקינה (או שכמה יציאות PWM פועלות עליו); הסרוו אינו מקבל פולס תקין.',
  'sim.time': 't = {time}',
  'sim.timeNote': 'זמן מדומה מאז ההרצה (צעדים של 1 ms). הקבלים מתחילים פרוקים בכל הרצה.',
  'sim.timeBehind': 'רץ לאט יותר מהזמן האמיתי',
  'sim.part.short.red': 'R',
  'sim.part.short.green': 'G',
  'sim.part.short.blue': 'B',
  'rating.row.current': 'זרם: {value} (מקסימום {limit})',
  'rating.row.voltage': 'מתח: {value} (מקסימום {limit})',
  'rating.channel': '{channel} — {row}',

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',
  'unit.lux.symbol': 'lx',
  'unit.farad.symbol': 'F',
  'unit.metre.symbol': 'm',
  'unit.celsius.symbol': '°C',
  'unit.percent_rh.symbol': '%RH',

  'sim.run': 'הרצה',
  'sim.stop': 'עצירה',
  'sim.controls': 'סימולציה',
  'sim.status.prefix': 'מצב:',
  'sim.status.stopped': 'עצור',
  'sim.status.starting': 'מתחיל…',
  'sim.status.running': 'רץ',
  'sim.status.failed': 'נכשל',
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
  'sim.error.no_steady_state':
    'למעגל אין מצב יציב: {components} ממשיך להדליק ולכבות את עצמו (ממסר שמנתק את הסליל של עצמו מרטט). סימולציית DC אינה יכולה להציג אחד ממצבי המעבר שלו.',
  'sim.error.mcu_component_unsupported':
    'סימולטור ה־ESP32 עדיין אינו תומך ב־{components}. רכיבים אלה מדומים במעגלים ללא ESP32; לשילובם עם הלוח נדרש עדכון של סביבת הריצה.',
  'sim.error.mcu_component_time_dependent':
    'ההתנהגות של {components} תלויה בזמן, וסימולטור ה־ESP32 אינו מקדם זמן מדומה. הם מדומים רק במעגלים ללא ESP32.',
  'sim.error.internal': 'אירעה שגיאה פנימית בסימולציה. הפרויקט לא נפגע.',
  'sim.error.worker_crashed':
    'הסימולציה נעצרה באופן בלתי צפוי. הפרויקט לא נפגע. לחצו על הרצה כדי לנסות שוב.',
  'sim.error.timeout':
    'הסימולציה לא הגיבה בזמן ונעצרה. הפרויקט לא נפגע. לחצו על הרצה כדי לנסות שוב.',
  'sim.notConnected': 'לא מחוברים ולכן לא מדומים: {components}',
  'sound.off': 'צליל: כבוי',
  'sound.on': 'צליל: פועל',
  'sound.off.hint': 'השמעת זמזמים פעילים (הצגה בלבד; כבוי כברירת מחדל)',
  'sound.on.hint': 'השתקת הזמזמים',
  'sim.part.yes': 'כן',
  'sim.part.no': 'לא',
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
  'sim.results.ledLit':
    'בהירות סמל ה-LED היא רמז חזותי הנגזר מהזרם המחושב, לא מדידת אור. תחת PWM היא עוקבת אחר הזרם הממוצע.',
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
  'psu.currentAverage': 'ממוצע (PWM)',
  'psu.ccNote': 'הגבלת זרם היא התנהגות תקינה של ספק, לא תקלה.',
  'checks.heading': 'בדיקות מעגל',
  'checks.none': 'לא נמצאו בעיות.',
  'checks.not_connected': 'לא מחוברים ולא ידומו: {components}.',
  'checks.partially_wired': '{component}: {terminals} לא מחובר.',
  'checks.wire_over_terminal':
    'חוט עובר מעל {component} {terminal} בלי להתחבר אליו. חוטים מתחברים רק בהדקים ובנקודות צומת.',
  'checks.terminals_touching':
    '{component} {terminal} נוגע ב-{other} {otherTerminal} אבל אינו מחובר אליו. הזיזו אחד הרכיבים והחזירו אותו כדי לחבר, או ציירו חוט.',
  'checks.floating_island': 'אין מסלול ל-GND: {components}.',
  'checks.no_ground': 'למעגל אין GND. הוסיפו [[ground]] וחברו אותה למעגל.',
  'checks.psu_shorted_by_wire': '{component}: הדקי היציאה מחוברים זה לזה בחוט.',
  'history.undo': 'ביטול',
  'history.redo': 'ביצוע מחדש',
  'sim.results.contact': 'מגע',
  'inspector.environment': 'סביבה מדומה',
  'inspector.environmentNote':
    'מה שהרכיב חש סביבו. בקרת סימולציה, לא תכונה של הרכיב; ניתן לשנותה גם בזמן ריצה.',
  'inspector.heading': 'מאפיינים',
  'inspector.empty': 'לא נבחר דבר. בחרו רכיב כדי לראות ולערוך את מאפייניו.',
  'inspector.multi': '{count} פריטים נבחרו',
  'inspector.reference': 'מזהה',
  'inspector.type': 'סוג',
  'inspector.rotate': 'סיבוב 90°',
  'inspector.delete': 'מחיקה',
  'inspector.wire': 'חוט',
  'inspector.junction': '[[junction]]',
  'inspector.wireRoute': 'מסלול',
  'wireRoute.auto': 'אוטומטי: עוקב אחרי הרכיבים כשהם זזים',
  'wireRoute.manual': 'ידני: הכיפופים שלך נשמרים',
  'wireRoute.makeAuto': 'נתב אוטומטית',
  'inspector.wireColor': 'צבע חוט',
  'wireColor.auto': 'אוטומטי',
  'wireColor.autoIs': 'אוטומטי ({color})',
  'wireColor.red': 'אדום',
  'wireColor.black': 'שחור',
  'wireColor.orange': 'כתום',
  'wireColor.blue': 'כחול',
  'wireColor.green': 'ירוק',
  'wireColor.purple': 'סגול',
  'wireColor.yellow': 'צהוב',
  'wireColor.teal': 'טורקיז',
  'wireColor.brown': 'חום',
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
  'library.examples.search': 'חיפוש דוגמאות',
  'library.examples.searchHint': 'למשל: נורית, חיישן, ESP32 LCD, LDR',
  'library.examples.categories': 'קטגוריות',
  'library.examples.category.basic': 'מעגלים בסיסיים',
  'library.examples.category.sensors': 'חיישנים',
  'library.examples.category.lighting': 'תאורה ותצוגות',
  'library.examples.category.controllers': 'בקרים ותכנות',
  'library.examples.category.switching': 'מיתוג ובקרה',
  'library.examples.count': 'מוצגות {shown} מתוך {total} דוגמאות',
  'library.examples.empty': 'אין דוגמה מתאימה. נסו פחות מילים או מילים אחרות, או נקו את הסינון.',
  'library.examples.clear': 'ניקוי הסינון',
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
  'example.rgb-mixer.title': 'נורית RGB: ערבוב צבע בעזרת זרמים',
  'example.rgb-mixer.summary':
    'נורית RGB עם קתודה משותפת, כל ערוץ דרך מתג ונגד משלו. הפכו את המתגים בזמן ריצה: הצבע הוא שילוב הזרמים שהמעגל מספק.',
  'example.light-sensor.title': 'חיישן אור: מחלק מתח עם נגד תלוי אור',
  'example.light-sensor.summary':
    'נגד תלוי אור GL5528 מעל נגד 10 kΩ מספק 9 V. שנו באינספקטור את האור המדומה על התא וצפו במתח המחלק משתנה בהתאם.',
  'example.relay-load.title': 'ממסר: זרם קטן מפעיל עומס נפרד',
  'example.relay-load.summary':
    'לחצו על הלחצן כדי להפעיל את סליל הממסר (כ־71 mA). המגעים עוברים מ־NC (זמזם) ל־NO (נורית): הסליל והעומס הם מעגלים נפרדים.',
  'example.night-light.title': 'מנורת לילה: טרנזיסטור שמופעל על ידי אור',
  'example.night-light.summary':
    'מחלק מתח עם נגד תלוי אור מטה טרנזיסטור 2N3904. הנמיכו את האור המדומה על התא: מתח הבסיס עולה, הטרנזיסטור נפתח והנורית בקולקטור נדלקת.',
  'example.pir-alarm.title': 'אזעקת PIR: תנועה מפעילה זמזם',
  'example.pir-alarm.summary':
    'חיישן תנועה HC-SR501 מפעיל טרנזיסטור 2N3904 שמפעיל זמזם. הריצו, ואז לחצו על כיפת החיישן (או סמנו את תיבת התנועה) כדי ליצור תנועה מולו.',
  'example.led-matrix.title': 'מטריצת LED: שורות ועמודות',
  'example.led-matrix.summary':
    'שתי עמודות מוזנות מ־5 V דרך 220 Ω; מתגים מחברים שתי שורות לאדמה. נקודה נדלקת רק במפגש של עמודה מוזנת ושורה מחוברת לאדמה: העיקרון שמאחורי סריקת מטריצה.',
  'example.rc-fade.title': 'תזמון RC: נורית שדועכת',
  'example.rc-fade.summary':
    'קבל של 2200 µF נטען דרך 1 kΩ ומזין נורית. הריצו: הנורית מתבהרת בהדרגה בזמן שהקבל נטען. פתחו את המתג: היא דועכת בזמן שהקבל נפרק. הזמן המדומה נספר מרגע ההרצה.',
  'example.led-colours.title': 'צבעי LED: אותו נגד, זרמים שונים',
  'example.led-colours.summary':
    'נוריות LED אדומה, צהובה וירוקה, כל אחת מ־⁦5 V⁩ דרך ⁦180 Ω⁩. לכל צבע מתח קדמי משלו (בערך ⁦2.0 V⁩ באדומה, ⁦2.4 V⁩ בצהובה ובירוקה), ולכן אותו נגד קובע בערך ⁦16.7 mA⁩ באדומה ו־⁦14.5 mA⁩ באחרות.',
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
  'palette.unavailable.part_needs_runtime': 'דורש תמיכת Runtime שעדיין אינה זמינה ל־ESP32.',
  'palette.unavailable.board_needs_runtime':
    'לא זמין כל עוד בפרויקט יש רכיבים שה־Runtime של ESP32 עדיין אינו תומך בהם.',
  'palette.unavailable.part_time_dependent': 'רכיבים תלויי־זמן מדומים רק במעגלים ללא ESP32.',
  'palette.unavailable.board_time_dependent':
    'לא זמין כל עוד בפרויקט יש רכיבים תלויי־זמן (הם מדומים רק ללא ESP32).',
  'palette.group.sensors': 'חיישנים',
  'palette.group.output': 'צליל, תצוגה ותנועה',
  'palette.group.switches': 'מתגים',
  'inspector.shortcutsHeading': 'קיצורי מקלדת',
  'unit.watt.symbol': 'W',
  'sim.results.power': 'הספק',
  'brand.logoAlt': 'TBI Lab: חושבים, מפיחים חיים ברעיונות, ממציאים',
  'home.subtitle': 'המעגלים מדומים ונשמרים כאן, בדפדפן שלכם. התחילו מדוגמה, או צרו פרויקט משלכם.',
  'app.narrowScreen': 'TBI Lab מיועד למסכי מחשב ברוחב של 1024 פיקסלים לפחות.',
  'rating.heading': 'חריגה מדירוגי הרכיב',
  'rating.atRisk': '{component} עלול להינזק',
  'rating.row.forward_current': 'זרם: {value} (מקסימום {limit})',
  'rating.row.reverse_voltage': 'מתח הפוך: {value} (מקסימום {limit})',
  'rating.row.power': 'הספק: {value} (מקסימום {limit})',
  'rating.row.resistance_outside_series':
    'אין דירוג הספק: ערך של {value} אינו מיוצר בסדרה שנבחרה (הטווח שלה מסתיים ב-{limit})',
  'rating.row.gpio_source_current': '{pin} ביציאה HIGH מספק {value} (הנעה טיפוסית {limit})',
  'rating.row.gpio_sink_current': '{pin} ביציאה LOW בולע {value} (הנעה טיפוסית {limit})',
  'rating.row.gpio_contention':
    '{pin} ו־{other} מניעים רמות הפוכות על אותו נט: {value} זורם ביניהם (הנעה טיפוסית {limit})',
  'rating.row.gpio_short_ground':
    '{pin} ביציאה HIGH מחובר ישירות ל־GND: {value} (הנעה טיפוסית {limit})',
  'rating.row.gpio_short_supply':
    '{pin} ביציאה LOW מחובר ישירות ל־+ של ספק: {value} (הנעה טיפוסית {limit})',
  'rating.row.gpio_input_overvoltage':
    '{pin} בכניסה נמצא ב־{value}, מחוץ לטווח הכניסה המוגדר של הפין (גבול {limit}); פיני ESP32 אינם מוגדרים ל־5 V',
  'rating.row.gpio_output_overvoltage':
    '{pin} ביציאה נדחף ל־{value} על ידי המעגל (גבול {limit}); זרם נדחף לתוך מעגל ההנעה של הפין',
  'rating.note': 'הסימולציה ממשיכה להציג את הערכים המחושבים ואינה מדמה נזק לרכיב.',

  // ---- Sprint 6: Classic ESP32 through the R2 Session Host ----
  'component.board.esp32_devkitc_wroom32.name': 'ESP32 DevKitC (ESP32 קלאסי)',
  'param.firmware': 'קושחה',
  'firmware.tbi-gpio-proof.name': 'הבהוב GPIO2/GPIO18, דיווח GPIO5',
  'firmware.tbi-gpio-proof.description':
    'קושחת בדיקה מוכנה מראש: מפעילה את GPIO2 ואת GPIO18 בתבנית חוזרת של 800 ms ומדפיסה את רמת GPIO5 בפלט הטורי.',
  'firmware.tbi-banks.name': 'העתקת כניסות ליציאות (GPIO34→GPIO4, GPIO35→GPIO33)',
  'firmware.tbi-banks.description':
    'קושחת בדיקה מוכנה מראש: מפעילה פעם אחת בעלייה את GPIO4, 16, 25, 27, 32 ו-33, ואז מעתיקה את GPIO34 ל-GPIO4 ואת GPIO35 ל-GPIO33 ומדפיסה כל שינוי.',
  'sim.status.runningMcu': 'רץ · ESP32',
  'sim.status.stopping': 'עוצר…',
  'firmware.program': 'הקוד שלו (בנייה ואז הרצה)',
  'sim.error.mcu_no_program': 'ללוח {components} אין קוד להרצה.',
  'sim.error.mcu_build_required': 'נדרשת בנייה: בנו את הקוד של {components} ואז לחצו על הרצה.',
  'sim.error.mcu_unsupported_features':
    'הקוד של {components} משתמש ביכולות שהסימולטור אינו מדמה: {features}. ההרצה נחסמה.',
  'program.language': 'שפת תכנות',
  'program.language.arduino-cpp': 'Arduino C++',
  'program.language.micropython': 'MicroPython',
  'program.language.confirm':
    'החלפת השפה פותחת תוכנית חדשה בשפה הזו; הקוד הנוכחי אינו מתורגם. להחליף אותו? (ביטול פעולה משחזר אותו.)',
  'program.tab.circuit': 'מעגל',
  'program.tab.code': 'קוד',
  // Sprint 9: generated views of the same circuit.
  'view.tabs': 'תצוגות הפרויקט',
  'view.tab.schematic': 'סכמה',
  // The full product term; the tab shows the short form, its accessible name and tooltip this.
  'view.name.schematic': 'סכמה חשמלית',
  'view.tab.3d': 'תלת־ממד',
  'view.loading': 'טוען…',
  'view.loadFailed': 'לא ניתן לטעון את התצוגה הזו. שאר התצוגות פועלות כרגיל.',
  'schematic.aria': 'סכמה חשמלית של {name}',
  'schematic.controls': 'פקדי תצוגת הסכמה החשמלית',
  'schematic.note': 'נוצרה מהמעגל. העריכה נעשית בתצוגת המעגל.',
  'view3d.aria': 'תצוגת תלת־ממד של {name}',
  'view3d.controls': 'פקדי תצוגת התלת־ממד',
  'version.aria': 'גרסת בנייה {version}: הצגת פרטים',
  'version.product': 'מוצר',
  'version.version': 'גרסה',
  'version.environment': 'סביבה',
  'version.commit': 'Commit',
  'version.builtAt': 'נבנתה',
  'version.runtime': 'מזהה Runtime',
  'version.runtimeUnknown': 'לא מדווח על ידי השרת',
  'version.graphics': 'גרפיקת תלת־ממד',
  'version.tierFull': 'איכות מלאה',
  'version.tierReduced': 'איכות מופחתת',
  'version.noWebgl': 'WebGL אינו זמין',
  'footer.aria': 'מידע על המוצר והבנייה',
  'footer.developedBy': 'פותח על ידי אוהד דוד',
  'footer.rights': 'כל הזכויות שמורות.',
  'footer.supportLabel': 'שליחת דוא״ל לתמיכה: {email}',
  'update.available': 'גרסה חדשה זמינה',
  'update.reload': 'טעינה מחדש',
  'update.later': 'אחר כך',
  'update.busySimulation': 'יש לעצור את הסימולציה כדי לטעון מחדש.',
  'update.busyBuild': 'אפשר לטעון מחדש בסיום הבנייה.',
  'update.busySaving': 'השינויים נשמרים…',
  // 3D rendering diagnostics (development readout, opened with #diag3d).
  'view3d.diag.gpu': 'מעבד WebGL',
  'view3d.diag.class': 'גרפיקה',
  'view3d.diag.software': 'תוכנה (ללא GPU)',
  'view3d.diag.hardware': 'GPU חומרתי',
  'view3d.diag.tier': 'רמת איכות',
  'view3d.diag.dpr': 'יחס פיקסלים',
  'view3d.diag.drawCalls': 'קריאות ציור',
  'view3d.diag.triangles': 'משולשים',
  'view3d.diag.materials': 'חומרים',
  'view3d.diag.textures': 'טקסטורות',
  'view3d.diag.geometries': 'גאומטריות',
  'view3d.diag.gpuMemory': 'זיכרון GPU (הערכה)',
  'view3d.diag.frame': 'פריים אחרון (CPU)',
  'view3d.diag.mode': 'מצב תצוגה',
  'view3d.diag.dof': 'עומק שדה',
  'view3d.presets': 'מבטים קבועים',
  // 3D visualization layers (layers.ts): the physical scene plus optional engineering layers.
  'view3d.layers': 'שכבות',
  'view3d.layers.aria': 'שכבות תצוגה',
  'view3d.preset.realistic': 'מציאותית',
  'view3d.preset.engineering': 'הנדסית',
  'view3d.preset.custom': 'מותאמת',
  'view3d.layer.labels': 'תוויות',
  'view3d.layer.grid': 'רשת',
  'view3d.layer.dof': 'עומק שדה',
  'view3d.layers.lens': 'מצלמה',
  'view3d.dof.unavailable': 'דורש מאיץ גרפי (GPU)',
  'view3d.mode': 'מצב תצוגה',
  'view3d.view.top': 'מלמעלה',
  'view3d.view.front': 'חזית',
  'view3d.view.side': 'צד',
  'view3d.view.rear': 'אחור',
  'view3d.reset': 'איפוס המצלמה',
  'view3d.rotateLeft': 'סיבוב שמאלה',
  'view3d.rotateRight': 'סיבוב ימינה',
  'view3d.loading': 'טוען את תצוגת התלת־ממד…',
  'view3d.unavailable':
    'תצוגת התלת־ממד דורשת WebGL, שאינו זמין בדפדפן או במכשיר הזה. תצוגות המעגל, הסכמה החשמלית והקוד פועלות כרגיל.',
  'view3d.loadFailed': 'לא ניתן לטעון את תצוגת התלת־ממד. שאר התצוגות פועלות כרגיל.',
  'view3d.control.toggle': 'מתג {id}, {state}',
  'view3d.control.momentary': 'לחצן {id}, {state}',
  'view3d.control.stopped': 'הפעילו את הסימולציה כדי להפעיל אותו.',
  'view3d.controlsHint':
    'בזמן ריצה: לחיצה על ידית מחליפה את מצב המתג; לחיצה ממושכת על לחצן מחזיקה אותו לחוץ.',
  'view3d.note':
    'הדמיה של המעגל: גרירה או ← → לסיבוב; גרירה בלחצן הימני, Shift+גרירה או Shift+חצים להזזה; גלילה או + − לזום. העריכה נעשית בתצוגת המעגל.',
  'view3d.overlap':
    'חלק מהרכיבים גדולים בתלת־ממד מהסמל שלהם ועדיין נוגעים זה בזה כאן ({parts}). אפשר להרחיק אותם בתצוגת המעגל.',
  'view3d.routeLimit':
    'חלק מהחוטים לא ניתן היה לפרוש בצורה נקייה בתלת־ממד ({wires}): במקומות אלה הם עלולים להיראות כאילו הם נוגעים בחוט אחר או עוברים דרך רכיב. החיבורים הם בדיוק כפי שהם משורטטים בתצוגת המעגל.',
  'program.editor.label': 'קוד המקור (Arduino) של {board}',
  'program.position': 'שורה {line}, עמודה {column}',
  'program.size': '{used} מתוך {max}',
  'build.button': 'בנייה',
  'toolbar.build': 'בנה קוד',
  'toolbar.build.group': 'בניית הקוד',
  'toolbar.build.readOnly': 'הפרויקט לקריאה בלבד: אי אפשר לבנות אותו כאן.',
  'toolbar.build.error': 'הבנייה לא הושלמה',
  'toolbar.build.showProblems': 'הצגת הבעיות',
  'build.phase.required': 'נדרשת בנייה',
  'build.phase.building': 'בונה…',
  'build.phase.queued': 'ממתין לבנייה ({position} לפניך)',
  'build.phase.current': 'נבנה',
  'build.phase.failed': 'הבנייה נכשלה',
  'build.elapsed': '{seconds} שנ׳',
  'build.stale': 'הקוד השתנה מאז הבנייה האחרונה.',
  // Sprint 13 OS-08: Run is not available during a build or without a current build.
  'run.blocked.building': 'אי אפשר להריץ בזמן שבנייה מתבצעת.',
  'run.blocked.buildRequired':
    'יש לבנות קודם את הקוד של {components}: הוא לא נבנה, או שהשתנה מאז הבנייה האחרונה.',
  'run.blocked.buildFailed': 'הבנייה האחרונה של הקוד של {components} נכשלה. תקנו אותו ובנו מחדש.',
  'build.olderRunning':
    'בנייה של גרסה קודמת של הקוד הזה עדיין מתבצעת. בנו את הגרסה הנוכחית כשהיא תסתיים.',
  // Sprint 13 OS-04: component bodies may not overlap (Circuit view and its 3D view).
  'edit.overlap.circuit': '{a} יחפוף את {b}. מקמו אותו במקום שבו הרכיבים אינם מכסים זה את זה.',
  'edit.overlap.3d':
    '{a} יחפוף את {b} בגודלם האמיתי (כפי שתצוגת התלת־ממד מציגה אותם). השאירו יותר מקום ביניהם.',
  'edit.overlap.both': '{a} יחפוף את {b}. מקמו אותו במקום שבו הרכיבים אינם מכסים זה את זה.',
  // Sprint 13 Task D: the project changed or was deleted in another tab or window.
  'save.error.conflictBanner':
    'הפרויקט שונה או נמחק בלשונית או בחלון אחרים, ולכן השינויים כאן לא נשמרו. כדי לשמור אותם, ייצאו עכשיו; לאחר מכן טענו מחדש כדי להמשיך עם הגרסה השמורה.',
  'save.reload': 'טעינה מחדש',
  'auth.expired': 'תוקף ההתחברות פג. הפרויקטים שלך שמורים בדפדפן הזה. יש להתחבר מחדש כדי להמשיך.',
  'auth.signInAgain': 'התחברות מחדש',
  // Sprint 13 Task D: wire routes adjusted when a project opened (layout only).
  'open.routesAdjusted':
    'חלק מנתיבי החוטים שורטטו מחדש כדי שלא יעברו מעל פינים או צגים. החיבורים לא השתנו. ביטול הפעולה האחרונה מחזיר את הנתיבים הקודמים.',
  // Sprint 13 a11y: the slider's own accessible name (distinct from its value field).
  'valueControl.slider': '{label}, מחוון',
  'build.blockedRunning': 'אפשר לבנות אחרי עצירה. הסשן שרץ ממשיך עם הקושחה שאיתה התחיל.',
  'build.unavailable': 'שירות הבנייה אינו זמין כאן.',
  'build.error.unreachable': 'לא ניתן היה להתחבר לשירות הבנייה. הקוד שלכם שמור; נסו שוב.',
  'build.error.busy': 'שירות הבנייה עמוס. נסו שוב בעוד רגע.',
  'build.error.quota': 'כבר יש לך בנייה בתהליך ובנייה ממתינה. המתינו לסיומן.',
  'build.error.rate_limited': 'יותר מדי בניות בזמן קצר. נסו שוב בעוד כמה דקות.',
  'build.error.cooldown': 'כמה בניות נכשלו ברצף. המתינו כמה דקות לפני בנייה נוספת.',
  'build.error.storage_quota':
    'הבניות השמורות שלך הגיעו למגבלה וכולן בשימוש. עצרו את הריצה ונסו לבנות שוב.',
  'build.error.capability_disabled': 'הרצת קובץ בינארי מוכן אינה זמינה בחשבון שלך.',
  'build.error.refused': 'שירות הבנייה דחה את הבקשה.',
  'build.error.too_large': 'הקוד גדול מדי לבנייה (המגבלה היא 64 KiB).',
  'build.error.not_an_image': 'שירות הבנייה לא יכול היה להשתמש בקובץ הזה.',
  'build.error.protocol': 'תשובה לא צפויה משירות הבנייה. נסו שוב או טענו מחדש את הדף.',
  'build.failure.timeout': 'הבנייה ארכה יותר ממגבלת הזמן ונעצרה.',
  'build.failure.storage_limit': 'הבנייה השתמשה ביותר מדי אחסון זמני ונעצרה.',
  'build.failure.unsupported_input': 'אי אפשר לבנות את הקוד הזה בסביבה הזו.',
  'build.failure.internal': 'בשירות הבנייה אירעה תקלה פנימית. נסו שוב.',
  'build.failure.capacity_timeout': 'הבנייה המתינה יותר מדי לשירות הבנייה ולא התחילה. נסו שוב.',
  'build.diagnostics.heading': 'בעיות',
  'build.severity.error': 'שגיאה',
  'build.severity.warning': 'אזהרה',
  'build.severity.note': 'הערה',
  'build.details': 'פרטי הבנייה',
  'build.artifact': 'תמונת קושחה {id}',
  'build.sizes': 'תוכנית {program} מתוך {programMax} בתים · RAM {data} מתוך {dataMax} בתים',
  'build.features.note': 'הקוד משתמש ביכולות שהסימולטור אינו מדמה, ולכן ההרצה חסומה עד שיוסרו:',
  'build.feature.internal_pull': 'נגד Pull-up/Pull-down פנימי',
  'build.feature.interrupt': 'פסיקות GPIO',
  'build.feature.restart': 'אתחול השבב',
  'build.feature.cpu_frequency': 'שינוי תדר המעבד (setCpuFrequencyMhz)',
  'build.feature.wifi': 'תקשורת Wi-Fi',
  'build.feature.bluetooth': "בלוטות'",
  'build.feature.adc': 'כניסה אנלוגית (ADC)',
  'build.feature.pwm': 'יציאת PWM/LEDC',
  'build.feature.pwm_advanced':
    'עמעום חומרתי של LEDC או היפוך היציאה (ledcFade,‏ ledcOutputInvert)',
  'build.feature.dac': 'יציאה אנלוגית (DAC)',
  'build.feature.touch': 'חישת מגע',
  'build.feature.sleep': 'מצבי שינה',
  'build.feature.drive_strength': 'בחירת עוצמת ההנעה של פין (gpio_set_drive_capability)',
  'build.feature.i2c': 'אפיק I2C',
  'build.feature.spi': 'אפיק SPI',
  'build.feature.library': 'ספרייה {name}',
  'mcu.runs.program': 'מריץ את הקוד שלו. ערכו אותו בלשונית "קוד", בנו ואז הריצו.',
  'mcu.runs.reference': 'מריץ את קושחת הייחוס „{name}”.',
  'mcu.runs.useProgram': 'להשתמש בקוד שלו במקום',
  'mcu.advanced.heading': 'מתקדם',
  'mcu.advanced.runPrebuilt': 'הרצת קובץ בינארי מוכן…',
  'mcu.advanced.note':
    'לתמונה שנבנתה מחוץ ל-TBI Lab: תמונת Flash ממוזגת בגודל 4MB של ESP32 קלאסי (‎.bin). היא לא נבדקת, ולכן יכולות שהסימולטור אינו מדמה מתגלות רק בזמן הריצה. היא לא נשמרת בפרויקט.',
  'mcu.advanced.error.not_an_image': 'הקובץ אינו תמונת Flash ממוזגת בגודל 4MB של ESP32 קלאסי.',
  'mcu.advanced.error.too_large': 'הקובץ גדול מתמונת Flash בגודל 4MB.',
  'mcu.advanced.error.unreachable': 'לא ניתן היה להתחבר לשירות הבנייה כדי להעלות את התמונה.',
  'mcu.advanced.error.busy': 'שירות הבנייה עמוס. נסו שוב בעוד רגע.',
  'mcu.advanced.error.refused': 'שירות הבנייה דחה את התמונה.',
  'mcu.advanced.error.protocol': 'תשובה לא צפויה משירות הבנייה.',
  'sim.error.mcu_multiple': 'בגרסה זו ניתן להריץ לוח ESP32 אחד לכל פרויקט. נמצאו: {components}.',
  'sim.error.mcu_unknown_firmware':
    'הקושחה שנבחרה עבור {components} אינה זמינה בגרסה זו. בחרו קושחה אחרת.',
  'sim.error.mcu_ground_unconnected':
    'חברו את פין ה-GND של {components} ל[[ground]], ואז לחצו על הרצה.',
  'sim.error.mcu_pin_without_circuit':
    '{pins} של {components} מחוברים רק לפינים אחרים של הלוח. חברו אותם דרך רכיב במעגל (למשל נגד).',
  'sim.error.runtime.session_create_failed':
    'לא ניתן להפעיל סשן ESP32: שירות הריצה אינו זמין. הפרויקט לא נפגע.',
  'sim.error.runtime.runtime_busy':
    'שירות הריצה של ESP32 עמוס כרגע. נסו שוב בעוד רגע. הפרויקט לא נפגע.',
  'sim.error.runtime.session_quota':
    'כבר יש לך ריצת ESP32 פעילה. עצרו אותה לפני שתתחילו אחרת. הפרויקט לא נפגע.',
  'sim.error.runtime.rate_limited':
    'הופעלו יותר מדי ריצות ESP32 בזמן קצר. נסו שוב בעוד כמה דקות. הפרויקט לא נפגע.',
  'sim.error.runtime.firmware_unavailable':
    'הקושחה שנבחרה אינה זמינה בשירות הריצה. הפרויקט לא נפגע.',
  'sim.error.unmodelled':
    'התוכנית התחילה להשתמש ב{feature}, שהסימולטור אינו ממדל. הסימולציה נעצרה ברגע זה, במקום להציג תוצאה מתה או קריסה.',
  'sim.error.runtime.unsupported_feature':
    'הקושחה משתמשת ביכולת שהסימולטור אינו תומך בה בגרסה זו (Pull-up/Pull-down פנימי או פסיקות GPIO).',
  'sim.error.runtime.inverted_output':
    'הקושחה הופכת את האות ביציאה של פין מחובר דרך מטריצת ה־GPIO. הסימולטור אינו מדמה יציאות הפוכות.',
  'sim.error.runtime.invalid_attachment': 'פין ESP32 מחובר אינו זמין לשימוש בסימולטור.',
  'sim.error.runtime.startup_failed':
    'לא ניתן היה להפעיל את ה-ESP32. הפרויקט לא נפגע. לחצו על הרצה כדי לנסות שוב.',
  'sim.error.runtime.runtime_crashed':
    'שירות הריצה של ESP32 נעצר באופן בלתי צפוי והסשן הסתיים. הפרויקט לא נפגע.',
  'sim.error.runtime.guest_reset':
    'הקושחה ביקשה איפוס של השבב, והסימולטור אינו תומך בכך. הסשן הסתיים; לחצו על הרצה להתחלה חדשה.',
  'sim.error.runtime.stalled': 'ה-ESP32 הפסיק להתקדם (למשל, קובץ הקושחה אינו עולה). הסשן הסתיים.',
  'sim.error.runtime.session_lost':
    'סשן ה-ESP32 אבד (החיבור נותק או שהסשן פג). הפרויקט בטוח; לחצו על הרצה לסשן חדש.',
  'sim.runtime.expiring':
    'סשן ה-ESP32 יסתיים בתוך דקה (סשן נמשך לכל היותר {minutes} דק׳). הפרויקט שמור; אחר כך לחצו על הרצה לסשן חדש.',
  'sim.error.runtime.session_expired':
    'סשן ה-ESP32 הגיע למשך המרבי שלו והסתיים. לחצו על הרצה לסשן חדש.',
  'sim.error.runtime.mirror_failed':
    'סשן ה-ESP32 הפעיל לא הצליח להחיל את השינוי שלכם ולכן נעצר. הפרויקט שומר על השינוי.',
  'sim.error.runtime.command_refused':
    'סביבת הריצה של ESP32 דחתה שינוי חי שאינה תומכת בו (ייתכן שהיא ישנה מהאפליקציה), ולכן הסשן נעצר. הפרויקט שומר את השינוי.',
  'sim.error.runtime.commands_rate_limited':
    'שינויים חיים נשלחו מהר יותר ממה שסביבת הריצה של ESP32 מקבלת, ולכן הסשן נעצר. הפרויקט שומר את השינוי; לחצו Run כדי להמשיך.',
  'sim.error.runtime.pwm_unsupported':
    'נעשה שימוש ביציאת PWM באופן שהסימולטור אינו יכול לשחזר נאמנה, והסשן הסתיים.',
  'sim.error.pwm.pwm_duty_zero_unverified':
    '{pins} מוציא PWM במחזור עבודה 0, והמעגל מגיב לפין הזה ({components}). הרמה ש־ESP32 אמיתי מוציא במחזור עבודה 0 עדיין לא אומתה, ולכן הסימולטור עוצר במקום לנחש. לכיבוי היציאה, השתמשו ב־ledcDetach()‎ ו־digitalWrite(pin, LOW)‎.',
  'sim.error.pwm.pwm_unsupported_mode': '{pins} משתמש במצב LEDC שהסימולטור אינו תומך בו: {why}.',
  'sim.error.pwm.pwm_load_unsupported':
    'PWM ב־{pins} מגיע אל {components}, שאינו מגיב מיד לאות ממותג. רק נגדים, נורות LED, דיודות ומתגים ניתנים למיצוע נאמן.',
  'sim.error.pwm.pwm_input_unsupported':
    'PWM ב־{pins} מגיע אל כניסת ה־ESP32 ‏{inputs}. קריאת אות PWM אינה מדומה.',
  'sim.error.pwm.pwm_outputs_interact':
    'יציאות ה־PWM ‏{pins} חולקות עומס ({components}). ההשפעה המשולבת שלהן תלויה בחפיפה בין צורות הגל, וזו אינה מדומה.',
  'sim.error.pwm.pwm_supply_limited':
    'ה־PWM ב־{pins} מביא את {components} למגבלת הזרם שלו בחלק מכל מחזור. האופן שבו ספק מעבדה מווסת עומס ממותג בגבול הזרם אינו מדומה, ולכן הסשן נעצר. העלו את מגבלת הזרם של הספק או הקטינו את העומס.',
  'sim.error.pwm.pwm_rate_exceeded':
    'הסקיצה משנה לעיתים קרובות כל כך אילו מבין {pins} ממותגים (או נעצרים על 0% או 100%), שהסימולטור היה צריך יותר מ־1000 פתרונות מעגל לשנייה מדומה, שזו המגבלה שלו. הסשן נעצר במקום להאט או לקרב. שינוי מחזור העבודה בלבד של יציאת PWM פעילה אינו עולה דבר; העבירו יציאות בין PWM לרמה קבועה בתדירות נמוכה יותר.',
  'sim.pwm.why.open-drain': 'יציאת PWM מסוג Open-drain',
  'sim.pwm.why.inverted': 'יציאת PWM הפוכה (היפוך במטריצת ה־GPIO)',
  'sim.pwm.why.low-speed': 'ערוץ איטי (יותר מ־8 ערוצי PWM)',
  'sim.pwm.why.interrupt': 'פסיקות LEDC',
  'sim.pwm.why.dither': 'מחזור עבודה שברי (Dithering)',
  'sim.pwm.why.fade': 'עמעום חומרתי',
  'sim.pwm.why.hpoint': 'היסט מופע שמגיע לסוף המחזור',
  'sim.pwm.why.timer-reset': 'הטיימר שלו מוחזק באיפוס',
  'sim.pwm.why.timer-paused': 'הטיימר שלו מושהה',
  'sim.pwm.why.timer-resolution': 'רזולוציית טיימר מחוץ לטווח 1 עד 20 ביט',
  'sim.pwm.why.timer-apb-clock': 'שעון מעבד מתחת ל־80 MHz, שמשנה את שעון ה־PWM באמצע מחזור',
  'sim.pwm.why.timer-divider': 'מחלק טיימר קטן מ־1',
  'sim.error.runtime.protocol_error':
    'שירות הריצה שלח תשובה בלתי צפויה והסשן הסתיים. הפרויקט לא נפגע.',
  'mcu.heading': 'ריצת ESP32',
  'mcu.notRunning': 'לחצו על הרצה כדי לראות רמות פינים ופלט טורי בזמן אמת.',
  'mcu.pins.heading': 'פינים',
  'mcu.pins.pin': 'פין',
  'mcu.pins.support': 'תמיכת הסימולטור',
  'mcu.pins.state': 'חי',
  'mcu.support.digital-io': 'קלט/פלט דיגיטלי',
  'mcu.support.digital-input': 'קלט בלבד',
  'mcu.support.none': 'לא זמין',
  'mcu.caveat.strapping': 'פין Strapping: רמת האתחול אינה נדגמת; תמיד עולה מהזיכרון',
  'mcu.caveat.flash': 'מחובר לזיכרון ה-Flash של המודול',
  'mcu.caveat.console': 'קונסולה טורית (UART0)',
  'mcu.caveat.inputOnly': 'ללא דוחף יציאה, ללא Pull פנימי',
  'mcu.caveat.power': 'פין הזנה',
  'mcu.caveat.enable': 'הפעלת השבב: איפוס אינו מדומה',
  'mcu.note.unsupported':
    'לא מדומה בגרסה זו: Pull-up/Pull-down פנימי, פסיקות GPIO, איפוס שבב, אנלוגי, Wi-Fi.',
  'mcu.level.high': 'HIGH',
  'mcu.level.low': 'LOW',
  'mcu.mode.output': 'יציאה',
  'mcu.mode.input': 'כניסה',
  'mcu.serial.heading': 'פלט טורי',
  'mcu.serial.empty': 'אין פלט עדיין.',
  'mcu.serial.dropped': 'פלט ישן יותר קוצץ ({count} תווים).',
  'mcu.terminal.heading': 'מסוף ESP32',
  'mcu.terminal.idle':
    'לחצו על "הרצה" כדי להפעיל את ה־ESP32. הפלט של המסוף הטורי שלו יופיע כאן, כבר מהאתחול.',
  'mcu.terminal.simTime': '{time} של סימולציה',
  'mcu.terminal.state.idle': 'לא פועל',
  'mcu.terminal.state.starting': 'מתחיל סשן…',
  'mcu.terminal.state.booting': 'מאתחל…',
  'mcu.terminal.state.running': 'רץ',
  'mcu.terminal.state.reconnecting': 'מתחבר מחדש…',
  'mcu.terminal.state.stopping': 'עוצר…',
  'mcu.terminal.state.failed': 'הסשן נכשל',
  'mcu.terminal.state.ended': 'הסשן הסתיים (הפלט האחרון)',
  'mcu.warnings.heading': 'אזהרות ריצה',
  'mcu.warning.output_on_input_only_pad':
    'GPIO{gpio} הוא קלט בלבד: הקושחה ניסתה להפעיל אותו כיציאה, והוא נשאר קלט.',
  'mcu.warning.transient_rejected': 'לחיצה על לחצן לא נמסרה לסשן הפעיל.',
  // Sprint 13 OS-09: I2C diagnostics, specific and actionable.
  'mcu.warning.i2c_wiring.supply_pin':
    '{component}: {gpio} ({line}) מחובר לפין {terminal} של המודול ולא ל־{line}. בדקו את פיני המודול: ייתכן ש־VCC ו־{line} הוחלפו. המודול אינו מגיב.',
  'mcu.warning.i2c_wiring.swapped':
    '{component}: ‏SDA ו־SCL הוחלפו ({sda} מחובר ל־SCL, {scl} ל־SDA). המודול אינו מגיב.',
  'mcu.warning.i2c_no_pullup':
    '{component}: ל־{lines} אין נגד Pull-up, ולכן הקו אינו נח במצב גבוה. הוסיפו Pull-up לכל קו.',
  'mcu.warning.i2c_logic_level':
    '{component}: {lines} נח ברמה שהמודול או ה־ESP32 אינם קוראים כגבוהה. משכו את הקווים למתח ששניהם מקבלים (סף הכניסה של המודול הוא ⁦0.7 ×⁩ מתח האספקה שלו).',
  'mcu.warning.i2c_rate_exceeded':
    'תעבורת ה־I2C חורגת ממה שהסימולטור מעבד בשנייה מדומה; העברות נוספות אינן מאושרות.',
  'mcu.warning.generic': 'אזהרת ריצה: {code}',
  'mcu.connection.reconnecting': 'מתחבר מחדש לסשן ה-ESP32…',
  'mcu.resync': '{count} עדכוני ריצה לא התקבלו בזמן ההתחברות מחדש. הערכים יתעדכנו בשינוי הבא.',
  'mcu.firmware.label': 'קושחה',
  'example.esp32-blink.title': 'ESP32: הבהוב נורית LED',
  'example.esp32-blink.summary':
    'ESP32 קלאסי מריץ קושחה מוכנה מראש שמדליקה ומכבה את GPIO2; נורית ה-LED על GPIO2 מהבהבת. רץ בשירות הריצה של ESP32.',
  'example.esp32-input-echo.title': 'ESP32: מתג בכניסה, LED ביציאה',
  'example.esp32-input-echo.summary':
    'סגרו את המתג או החזיקו את הלחצן: ‏3.3 V מגיעים ל-GPIO34, הקושחה מעתיקה אותו ל-GPIO4 ונורית ה-LED נדלקת. רץ בשירות הריצה של ESP32.',
  'example.esp32-bench.title': 'שולחן ESP32: כניסות ונוריות חיווי',
  'example.esp32-bench.summary':
    'המעגל של מתג בכניסה ו-LED ביציאה על שולחן עבודה מלא יותר: נורית LED אדומה המונעת מ-GPIO4, ונוריות חיווי צהובה (מאחורי דיודת 1N4148) וירוקה המוזנות ישירות מספק ה-‏3.3 V. רץ בשירות הריצה של ESP32.',
  'example.esp32-motion-relay.title': 'ESP32: אזעקת תנועה דרך ממסר',
  'example.esp32-motion-relay.summary':
    'חיישן תנועה PIR על GPIO34; הקושחה מעתיקה אותו ל-GPIO4, שמפעיל טרנזיסטור 2N3904 וממסר ‏5 V (עם דיודת Flyback). מגע הממסר מפעיל את הזמזם ומדליק את נורית האזעקה. לחצו על כיפת החיישן בזמן ריצה כדי ליצור תנועה מולו. רץ בשירות הריצה של ESP32.',
  'example.esp32-night-light.title': 'ESP32: מנורת לילה RGB עם חיישן אור',
  'example.esp32-night-light.summary':
    'מחלק מתח עם חיישן אור על GPIO34, הנקרא כרמה דיגיטלית (ללא ADC): בחושך (מתחת לכ-‏3 lx) הוא נקרא HIGH והקושחה מדליקה את שלושת ערוצי ה-RGB דרך GPIO4: אור לבן. באור (מעל כ-‏110 lx) הוא נקרא LOW; בין הספים הכניסה שומרת על הרמה האחרונה. שנו את עוצמת האור בחלונית המאפיינים בזמן ריצה. רץ בשירות הריצה של ESP32.',
  'example.esp32-distance-alarm.title': 'ESP32: התראת מרחק אולטרסונית',
  'example.esp32-distance-alarm.summary':
    'חיישן HC-SR04 מודד את המרחק למטרה: GPIO5 שולח פולס הפעלה של 10 מיקרו-שניות, ופולס ההד חוזר אל GPIO18 דרך מחלק מתח של 1 kΩ / 2 kΩ (המודול מוזן מ-‏5 V). הסקיצה מדפיסה את המרחק (רוחב הפולס במיקרו-שניות חלקי 58 = ס"מ); במרחק קטן מ-‏20 ס"מ, GPIO2 מדליק את נורית ה-LED האדומה. שנו את המרחק למטרה בחלונית המאפיינים בזמן ריצה. רץ בשירות הריצה של ESP32.',
  'example.esp32-thermo-hygrometer.title': 'ESP32: טמפרטורה ולחות (DHT22)',
  'example.esp32-thermo-hygrometer.summary':
    'חיישן DHT22 / AM2302 על GPIO4, עם נגד Pull-up של 10 kΩ שקו הנתונים היחיד שלו דורש, נקרא בשגרה קצרה ללא ספרייה לפי התזמון שבגיליון הנתונים. הפלט הטורי מציג את הטמפרטורה ואת הלחות היחסית כל 2.5 שניות. שנו את שתיהן בחלונית המאפיינים בזמן ריצה. רץ בשירות הריצה של ESP32.',
  'example.esp32-led-fade.title': 'ESP32: עמעום נורת LED ב־PWM',
  'example.esp32-led-fade.summary':
    'analogWrite מניע את GPIO18 באות PWM של 1 kHz; הזרם הממוצע של ה־LED, ואיתו הבהירות, עוקבים אחר מחזור העבודה. העמעום נשאר בין 1 ל־255: מחזור עבודה 0 עדיין אינו מדומה.',
  'example.esp32-logic-and.title': 'ESP32: שער AND עם קריאה חוזרת',
  'example.esp32-logic-and.summary':
    'יציאה של ESP32 ולחצן מזינים שער AND מדגם SN74LVC1G08 שמוזן ב-3.0 V. השער מדליק נורית LED וה-ESP32 קורא בחזרה את היציאה שלו. לחצו לחיצה ממושכת על הלחצן ועקבו אחרי הפלט הטורי; כשמשחררים, הנורית נשארת כבויה.',
  'example.esp32-logic-quad-and.title': 'ESP32: רכיב ארבעה שערי AND שמדליק נוריות',
  'example.esp32-logic-quad-and.summary':
    'שתי יציאות של ESP32 ולחצן מזינים SN74LVC08A (ארבעה שערי AND במארז אחד, הזנה משותפת אחת) שמוזן ב-3.0 V. שער 1 מדליק נורית LED, שער 2 משרשר את שער 1 עם הלחצן ומדליק נורית שנייה; כניסות השערים שאינם בשימוש מחוברות ל-GND. פתחו את הרכיב במפקח כדי לראות את מצב כל שער ואת טבלת האמת.',
  // Sprint 20 logic examples.
  'example.logic-and-switches.title': 'לוגיקה: שער AND עם שני מתגים',
  'example.logic-and-switches.summary':
    'שני מתגים, לכל אחד נגד pull-down של 10 kΩ, מזינים שער AND מדגם SN74LVC1G08 שמוזן ב-3.0 V; נורית ה-LED נדלקת רק כששניהם סגורים. בחרו את השער כדי לראות את טבלת האמת, את הרמה והמתח של כל פין, ולהחליף את מצב הכניסות מתוך המפקח.',
  'example.logic-cascade.title': 'לוגיקה: שערים בשרשור, (A·B·C) + D',
  'example.logic-cascade.summary':
    'ארבעה מתגים עם נגדי pull-down. בתוך SN74LVC08A אחד, שער 1 מחשב A·B ומזין את שער 2, שמוסיף את C; בין מארזים, שער OR מדגם SN74LVC1G32 משלב את התוצאה עם מתג D, מתג עקיפה, ומדליק את הנורית. הכול ב-3.0 V; כניסות השערים שאינם בשימוש מחוברות ל-GND.',
  'example.esp32-logic-override.title': 'ESP32: שער OR עם עקיפה ידנית',
  'example.esp32-logic-override.summary':
    'יציאה של ESP32 ומתג מזינים שער OR מדגם SN74LVC1G32 שמוזן ב-3.0 V; לשתי הכניסות נגדי pull-down של 10 kΩ. הנורית מהבהבת עם ה-ESP32 עד שסוגרים את המתג, שמשאיר אותה דולקת; ה-ESP32 קורא בחזרה את יציאת השער ומדווח על העקיפה בפלט הטורי.',
  'example.esp32-servo-sweep.title': 'ESP32: סריקה של סרוו SG90 ב־PWM',
  'example.esp32-servo-sweep.summary':
    'אות LEDC של 50 Hz ב־GPIO18 עם פולסים של 1.0,‏ 2.0 ו־1.5 ms מזיז את הסרוו ל־0°,‏ 180° ו־90°. הסרוו מוזן מספק המעבדה של 5 V.',
  'example.esp32-lcd-hello.title': 'ESP32: שלום על צג LCD ‏16×2 ב-I2C',
  'example.esp32-lcd-hello.summary':
    'הסקיצה מפעילה את הצג דרך מתאם ה-I2C שלו (PCF8574) בכתיבות Wire פשוטות: שורה 1 אומרת שלום, ושורה 2 סופרת שניות. המודול מוזן מ-‏4.5 V כדי שנגדי ה-Pull-up של הקו (שני נגדים של 4.7 kΩ לספק שני של 3.3 V) ייקראו HIGH בכניסותיו (‏0.7 × 4.5 V = 3.15 V). רץ בשירות הריצה של ESP32.',
  'palette.group.mcu': 'בקר (מיקרו-בקר)',
  // Board pin silkscreen names (Sprint 6): technical tokens, verbatim in every locale.
  'pin.gpio36': 'VP',
  'pin.gpio39': 'VN',
  'pin.gpio34': 'IO34',
  'pin.gpio35': 'IO35',
  'pin.gpio32': 'IO32',
  'pin.gpio33': 'IO33',
  'pin.gpio25': 'IO25',
  'pin.gpio26': 'IO26',
  'pin.gpio27': 'IO27',
  'pin.gpio14': 'IO14',
  'pin.gpio12': 'IO12',
  'pin.gpio13': 'IO13',
  'pin.gnd': 'GND',
  'pin.gpio23': 'IO23',
  'pin.gpio22': 'IO22',
  'pin.gpio21': 'IO21',
  'pin.gpio19': 'IO19',
  'pin.gpio18': 'IO18',
  'pin.gpio5': 'IO5',
  'pin.gpio17': 'IO17',
  'pin.gpio16': 'IO16',
  'pin.gpio4': 'IO4',
  'pin.gpio0': 'IO0',
  'pin.gpio2': 'IO2',
  'pin.gpio15': 'IO15',
  // Sprint 13 H1: what runs on the ESP32 (packages/domain/src/capabilities.ts).
  'menu.capabilities': 'מה רץ על ה־ESP32',
  'capabilities.title': 'מה רץ על ה־ESP32 ב־TBI Lab',
  'capabilities.intro':
    'TBI Lab מריץ את הסקיצ׳ שלכם על ESP32 קלאסי מדומה (ESP32 DevKitC, ‏WROOM-32) ומדמה את המעגל סביבו. הרשימה מפרטת בדיוק מה מדומה, מה מוגבל ומה נדחה. יכולת שנדחית לעולם אינה רצה בשקט: המוצר מודיע על כך לפני הרצה.',
  'capabilities.close': 'סגירה',
  'capabilities.learnMore': 'מה רץ על ה־ESP32?',
  'capabilities.section.firmware': 'יכולות קושחה',
  'capabilities.section.parts': 'רכיבים לצד ESP32',
  'capabilities.section.timing': 'תזמון',
  'capabilities.section.limits': 'מגבלות השירות המשותף',
  'capabilities.status.supported': 'נתמך',
  'capabilities.status.limited': 'נתמך עם מגבלות',
  'capabilities.status.unsupported': 'לא נתמך',
  'capabilities.facility.digital_io.name': 'כניסות ויציאות דיגיטליות',
  'capabilities.facility.digital_io.body':
    'pinMode,‏ digitalWrite ו־digitalRead על הפינים שתרשים הלוח מסמן כזמינים. הרמות והזרמים מגיעים מסימולציית המעגל.',
  'capabilities.facility.serial.name': 'צג טורי (UART0)',
  'capabilities.facility.serial.body':
    'Serial.print ו־Serial.read דרך מסוף ה־ESP32. הטקסט מדויק; תזמון הביטים בקו אינו מדומה.',
  'capabilities.facility.preferences.name': 'Preferences (זיכרון בלתי נדיף)',
  'capabilities.facility.preferences.body':
    'ספריית Preferences פועלת בתוך הרצה אחת. דבר אינו נשמר אחרי עצירה.',
  'capabilities.facility.i2c.name': 'אפיק I2C ‏(Wire)',
  'capabilities.facility.i2c.body':
    'Wire כבקר מול רכיבי ה־I2C הנתמכים, עם כתובות, אישורים (ACK) ורמות Pull-up אמיתיים. משך כל העברה באפיק אינו מדומה.',
  'capabilities.facility.timing.name': 'millis,‏ micros,‏ delay,‏ delayMicroseconds,‏ pulseIn',
  'capabilities.facility.timing.body': 'רצים בזמן מדומה. המגבלות המדויקות מפורטות בסעיף תזמון.',
  'capabilities.facility.dual_core.name': 'שתי ליבות המעבד (משימות FreeRTOS)',
  'capabilities.facility.dual_core.body':
    'משימות רצות על שתי הליבות. סקיצ׳ שמעסיק את ליבה 0 ברציפות עלול לעכב קוד בליבה 1 עד כ־1 ms, ולכן תזמון ברמת מיקרו־שניות אינו נתמך בסקיצ׳ים כאלה.',
  'capabilities.facility.pwm.name': 'יציאת PWM / LEDC ‏(analogWrite,‏ ledcWrite)',
  'capabilities.facility.pwm.body':
    'ערוצי LEDC מהירים, עם תדר ומחזור עבודה מדויקים. המעגל רואה את הממוצע בזמן (נורות LED מתעמעמות; בדיקת הדירוגים משתמשת בזרם השיא). נדחה בהרצה, עם הסיבה: מחזור עבודה 0 שמניע עומס (הרמה שלו בחומרה אמיתית עדיין לא אומתה), עומסים שאינם מגיבים מיד (רק נגדים, נורות LED, דיודות ומתגים מגיבים כך), כניסת ESP32 שקוראת את אות ה־PWM, ויותר מ־8 ערוצים.',
  'capabilities.facility.pwm_advanced.name':
    'עמעום חומרתי והיפוך יציאה של LEDC ‏(ledcFade,‏ ledcOutputInvert)',
  'capabilities.facility.pwm_advanced.body':
    'אינם מדומים. סקיצ׳ שמשתמש בהם נדחה בבנייה. לעמעום, קראו ל־ledcWrite בצעדים.',
  'capabilities.facility.interrupt.name': 'פסיקות GPIO ‏(attachInterrupt)',
  'capabilities.facility.interrupt.body': 'אינן מדומות. במקומן, קראו את הפין ב־digitalRead.',
  'capabilities.facility.internal_pull.name':
    'Pull-up / Pull-down פנימיים (INPUT_PULLUP,‏ INPUT_PULLDOWN)',
  'capabilities.facility.internal_pull.body': 'אינם מדומים. הוסיפו נגד חיצוני למעגל.',
  'capabilities.facility.adc.name': 'כניסה אנלוגית (analogRead,‏ ADC)',
  'capabilities.facility.adc.body': 'אינה מדומה. חיישני אור וחיישנים אחרים נקראים כרמות דיגיטליות.',
  'capabilities.facility.dac.name': 'יציאה אנלוגית (dacWrite)',
  'capabilities.facility.dac.body': 'אינה מדומה.',
  'capabilities.facility.touch.name': 'חישת מגע',
  'capabilities.facility.touch.body': 'אינה מדומה.',
  'capabilities.facility.spi.name': 'אפיק SPI',
  'capabilities.facility.spi.body': 'אינו מדומה.',
  'capabilities.facility.wifi.name': 'רשת Wi-Fi',
  'capabilities.facility.wifi.body': 'אינה מדומה. סקיצ׳ים שמשתמשים ב־Wi-Fi נדחים לפני הרצה.',
  'capabilities.facility.bluetooth.name': 'Bluetooth',
  'capabilities.facility.bluetooth.body': 'אינו מדומה.',
  'capabilities.facility.sleep.name': 'מצבי שינה',
  'capabilities.facility.sleep.body': 'אינם מדומים.',
  'capabilities.facility.drive_strength.name': 'עוצמת ההנעה של פין (gpio_set_drive_capability)',
  'capabilities.facility.drive_strength.body':
    'אינה מדומה: הפינים פועלים בעוצמת ההנעה של ברירת המחדל. קוד שבוחר עוצמה אחרת נדחה בבנייה.',
  'capabilities.facility.restart.name': 'אתחול השבב (ESP.restart)',
  'capabilities.facility.restart.body': 'אינו מדומה. לחצו עצירה ואז הרצה כדי להתחיל מחדש.',
  'capabilities.facility.cpu_frequency.name': 'שינויי תדר המעבד (setCpuFrequencyMhz)',
  'capabilities.facility.cpu_frequency.body':
    'אינם מדומים: ה־ESP32 פועל ב־240 MHz. קוד שמשנה את תדר המעבד נדחה בבנייה.',
  'capabilities.facility.library.name': 'ספריות Arduino',
  'capabilities.facility.library.body':
    'רצות רק ספריות מובנות של ליבת ה־ESP32 שמופיעות כאן (Preferences; ‏Wire מול רכיבי ה־I2C). ספריות אחרות, כמו DHT או LiquidCrystal_I2C, נדחות; הדוגמאות המוכנות מראות את אותם רכיבים בלעדיהן.',
  'capabilities.timing.electrical_exact':
    'אותות שהרכיבים המדומים שולחים (למשל הד של חיישן) ורמות הפינים שהסקיצ׳ כותב ממוקמים בזמן המדומה המדויק שלהם.',
  'capabilities.timing.polling':
    'הסקיצ׳ מזהה שינוי בכניסה בקריאה הבאה של הפין. בכל מילי־שנייה מדומה יש מרווחים קצרים, עד כ־13 µs, שבהם הליבה המדומה אינה יכולה לרוץ, ולכן שינוי עלול להתגלות מאוחר בשיעור זה.',
  'capabilities.timing.outputs_longer':
    'פולסים שהסקיצ׳ מתזמן ב־delayMicroseconds עשויים לצאת ארוכים עד כ־12 µs, לעולם לא קצרים יותר.',
  'capabilities.timing.busy_core0':
    'אם משימה מעסיקה את ליבה 0 ברציפות, קוד בליבה 1 עלול להתעכב עד כ־1 ms. תזמון ברמת מיקרו־שניות אינו נתמך בסקיצ׳ים כאלה.',
  'capabilities.timing.delay_phase':
    'delay() שומר על אורכו במדויק; היקיצה הראשונה עשויה להגיע עד כ־0.5 ms מאוחר יותר מאשר בלוח אמיתי.',
  'capabilities.timing.pulsein':
    'קריאות pulseIn נמצאות בטווח של מיקרו־שנייה אחת מהרוחב האמיתי; כשקצה נופל לאחד המרווחים הקצרים שלמעלה, קריאה עשויה לסטות עד כ־13.5 µs (כ־2 מ״מ ב־HC-SR04).',
  'capabilities.timing.no_us_claim':
    'TBI Lab אינו מתחייב לתזמון בלתי מוגבל ברמת מיקרו־שניות. אם תזמון מדויק חשוב לפרויקט שלכם, בדקו אותו על לוח אמיתי.',
  'capabilities.limit.runtime_busy':
    'סימולטור ה־ESP32 המשותף מלא כרגע. הפרויקט שלכם לא נפגע; נסו להריץ שוב בעוד רגע.',
  'capabilities.limit.session_quota':
    'כל משתמש מריץ סימולציית ESP32 אחת בכל פעם. עצרו קודם את האחרת.',
  'capabilities.limit.rate_limited':
    'הופעלו יותר מדי הרצות בזמן קצר. המתינו את הזמן המוצג ונסו שוב.',
  'capabilities.limit.session_expired':
    'הרצה מסתיימת אחרי 30 דקות או כשהדף מפסיק להגיב. לחצו הרצה כדי להתחיל חדשה.',
  'capabilities.limit.commands_rate_limited':
    'פקדי הרכיבים שונו מהר מדי בזמן ההרצה; חלק מהשינויים נדחו. שנו אותם לאט יותר.',
  'capabilities.parts.supported': 'מדומה לצד ה־ESP32.',
  'capabilities.board.power':
    'איך הלוח מוזן: לוח ה־ESP32 פועל מספק פנימי של 3.3 V, כאילו הוא מוזן דרך מחבר ה־USB שלו. הפינים 3V3 ו־5V שלו אינם חלק מהמעגל המדומה ואי אפשר לחבר אליהם חוטים; חברו את ה־GND שלו לאדמה של המעגל. הרכיבים לידו מקבלים מתח מספק הכוח המעבדתי.',
  // Sprint 13 H2: outside the specified operating range; damage threshold unknown (not "safe").
  'rating.operating.heading': 'מחוץ לתנאי ההפעלה המוגדרים',
  'rating.operating.summary': '{component} מחוץ לטווח ההפעלה המוגדר שלו',
  'rating.operating.row.voltage': 'אספקה: {value} (מקסימום הפעלה מוגדר {limit})',
  'rating.operating.note':
    'מחוץ לטווח ההפעלה המומלץ אך בתוך הערך המקסימלי המוחלט שפורסם: האמינות והתוצאה המדומה אינן מובטחות. השאירו את הרכיב בתוך טווח ההפעלה שלו.',
  // Sprint 13 P2: a value from a pad beyond its characterized point is not a physical value.
  'rating.value.uncharacterized': 'זרם לא ידוע (מחוץ לתחום שהיצרן אפיין)',
  'rating.unrated.summary': '{component} מחוץ לטווח המוגדר שלו; לא פורסם סף נזק',
  'rating.unrated.note':
    'היצרן אינו מפרסם סף נזק למצב זה: הסיכון אינו ידוע, אך אינו אפס. התייחסו אליו כלא בטוח; התוצאה המדומה עשויה שלא להתאים לרכיב אמיתי.',
  'rating.row.gpio_cumulative_current':
    'כל פיני היציאה של ה־ESP32 יחד מספקים {value} (מקסימום מוחלט {limit})',
  // Sprint 13 H2: model limitations (packages/domain/src/capabilities.ts MODEL_LIMITATIONS).
  'limitation.psu_ideal':
    'ספק מעבדה אידיאלי: ללא עכבת מוצא וללא דינמיקה של לולאת הבקרה, והוא אינו יכול לבלוע זרם.',
  'limitation.resistor_ideal': 'ערך מדויק: סבולת ומקדם טמפרטורה אינם ממודלים.',
  'limitation.dc_25c': 'נקודת עבודה DC ב־25 °C: ללא השפעות תרמיות או התחממות עצמית.',
  'limitation.led_card_range':
    'מדויק בטווח הזרמים של עקומות גיליון הנתונים; מחוץ לו התוצאה מסומנת כמחוץ למודל.',
  'limitation.no_breakdown':
    'פריצה בממתח הפוך אינה ממודלת; במקומה נבדק דירוג המתח ההפוך ומוצגת אזהרה.',
  'limitation.switch_ideal': 'מגע אידיאלי: ללא התנגדות מגע וללא ריטוט.',
  'limitation.ldr_typical': 'GL5528 טיפוסי (מרכז מחלקת ההתנגדות שלו), לא רכיב שנמדד.',
  'limitation.ldr_extrapolated': 'מחוץ לטווח 1–100 lx חוק האור מוחצן, והתוצאה מציינת זאת.',
  'limitation.ldr_digital_esp32': 'לצד ESP32 הוא נקרא כרמה דיגיטלית: כניסה אנלוגית אינה נתמכת.',
  'limitation.ldr_no_dynamics': 'זמן התגובה ותלות הטמפרטורה אינם ממודלים.',
  'limitation.buzzer_curve':
    'הזרם עוקב אחר עקומת גיליון הנתונים בטווח 3–6 V; מחוץ לו התוצאה מסומנת כמחוץ למודל.',
  'limitation.buzzer_dc': 'זמזם אקטיבי ב־DC: מדומה האם הוא מזמזם, אך לא הטון ועוצמת הקול.',
  'limitation.relay_thresholds':
    'משיכה ושחרור משתמשים בגבולות המובטחים של גיליון הנתונים (3.75 V / 0.5 V), לא ברכיב מסוים.',
  'limitation.relay_no_inductance':
    'השראות הסליל אינה ממודלת, ולכן קוץ המתח בכיבוי אינו מדומה: השתמשו בדיודת Flyback כמו בלוח אמיתי.',
  'limitation.relay_ideal_contacts':
    'מגעים אידיאליים: התנגדות מגע, ריטוט וזמני הפעלה ושחרור אינם ממודלים.',
  'limitation.bjt_dc': 'מודל טרנזיסטור DC ב־25 °C: ללא קיבולים, זמני מעבר או התחממות עצמית.',
  'limitation.bjt_no_breakdown': 'פריצה אינה ממודלת; במקומה נבדקים דירוגי המתח ומוצגת אזהרה.',
  'limitation.pir_static':
    'התנועה היא פקד שאתם קובעים. זמן ההשהיה, זמן החסימה, דקת החימום, הטווח, הזווית והרגישות אינם ממודלים.',
  'limitation.matrix_window':
    'כל נקודה נפתרת מהמעגל; תצוגה סורקת מוצגת לפי מצבה האחרון בכל חלון של 10 ms (ללא התמדת ראייה).',
  'limitation.matrix_no_esp32': 'עדיין אינה זמינה לצד ESP32.',
  'limitation.capacitor_ideal': 'קבל אידיאלי: ללא ESR, זליגה, בליעה דיאלקטרית או קוטביות.',
  'limitation.capacitor_no_esp32': 'רכיבים תלויי־זמן רצים רק במעגלים ללא ESP32.',
  'limitation.hcsr04_target':
    'מטרה שטוחה אחת במרחק שנקבע, באוויר דומם בטמפרטורה שנקבעה; מחוץ לטווח המודול אין הד.',
  'limitation.hcsr04_output': 'התנגדות המוצא של ECHO‏ (100 Ω) היא הנחה: אף מקור אינו מציין אותה.',
  'limitation.hcsr04_retrigger': 'הפעלה חדשה מתעלמת כל עוד ממתין הד.',
  'limitation.supply_below_min':
    'מתחת למתח האספקה המינימלי המודול מוצג ככבוי; מודול אמיתי במצב זה עלול להתנהג באופן בלתי צפוי, והתוצאה מסומנת כמחוץ למודל.',
  'limitation.dht22_tgo':
    'השהיית התגובה של החיישן היא 30 µs, אמצע הטווח 20–40 µs שבגיליון הנתונים.',
  'limitation.dht22_current': 'זרם המדידה של 1–1.5 mA (כ־5 ms לכל קריאה) אינו כלול בתוצאת ה־DC.',
  'limitation.dht22_output':
    'התנגדות מוצא ברמה נמוכה של DATA‏ (100 Ω) היא הנחה: גיליונות הנתונים אינם מציינים אותה.',
  'limitation.lcd_backlight':
    'התאורה האחורית ממודלת לפי 20 mA שבגיליון הנתונים: שרטוט כרטיס המתאם לא נמצא.',
  'limitation.lcd_bus_timing': 'I2C מדומה ברמת העברה: משך ההעברה ורמות הקווים במהלכה אינם מדומים.',
  'limitation.lcd_pullups': 'המודול ממודל ללא נגדי Pull-up על הכרטיס: המעגל חייב לספק אותם.',
  'limitation.esp32_timing': 'התזמון כפוף לחוזה התזמון של V1 (ראו מה רץ על ה־ESP32).',
  'limitation.esp32_pulls': 'נגדי Pull-up ו־Pull-down פנימיים אינם מדומים.',
  'limitation.esp32_drive':
    'כל מניע פין משתמש במאפיין ההנעה בעוצמה המרבית מגיליון הנתונים (40 mA ב־2.64 V); קוד רץ בעוצמת ההנעה של ברירת המחדל, החלשה יותר, וגיליון הנתונים מציין 20 mA עבור GPIO16 ו־GPIO17. מעבר למאפיין זה (פין בעומס יתר או בקצר) הזרם אינו ידוע ואינו מוצג כערך.',
  'limitation.lcd_input_clamp':
    'דיודות ההגנה בכניסות של לוח המתאם אינן ממודלות: SDA או SCL מעל מתח האספקה של המודול ⁦+ 0.5 V⁩ מסומנים (מקסימום מוחלט), והזרם שהיה זורם לתוך הפין אינו מדומה.',
  'sim.part.current.sda': 'כניסת SDA',
  'sim.part.current.scl': 'כניסת SCL',
  'limitation.esp32_input_clamp':
    'דיודות ההגנה בכניסה אינן ממודלות: פין מחוץ לטווח המוגדר שלו מסומן, והזרם המדומה לתוכו אינו אמין.',
  // Sprint 15 (R4): PWM averages, the SG90 servo and the ESP32's LEDC outputs.
  'limitation.pwm_average':
    'כשהרכיב מונע ב־PWM, הערכים המוצגים הם ממוצעים בזמן לאורך צורת הגל (מדויקים לרכיב הזה); בדיקת הדירוגים משתמשת בזרם השיא. הבהירות הנתפסת מקורבת לפי הזרם הממוצע.',
  'limitation.logic_guaranteed_output':
    'היציאה משתמשת באופיין המובטח (המקרה הגרוע) מגיליון הנתונים, לא בערכים טיפוסיים: יציאה של רכיב אמיתי קרובה בדרך כלל יותר לפסי ההזנה.',
  'limitation.logic_supply_rows':
    'ספים ורמות יציאה רק היכן שגיליון הנתונים מפרט אותם (‎1.65–1.95 V, ‏2.3–2.7 V, ‏3.0–3.6 V, ‏4.5–5.5 V). עומסים אמיתיים רק ב-1.65, ‏2.3 או 4.5 V בדיוק (נקודות הבדיקה של היציאה) ועל פני 3.0–3.6 V (נקודות 3 V כחסם, החלטת בעלים PM-1); במתחים אחרים עד 100 µA.',
  'limitation.logic_unknown':
    'כניסה בין V_IL ל-V_IH, מחוץ ל-0–5.5 V, צפה, או מוזנת רק מפין של ESP32 במצב כניסה — נדחית: שום רמה אינה מנוחשת, ולא מניחים "כניסה שולטת". זרם ההזנה במנוחה (I_CC ≤ 10 µA) אינו חלק מהפתרון ומפורט רק כשכל הכניסות ב-5.5 V או ב-GND.',
  'limitation.logic_breakout':
    'מארז ה-SOT-23-5 מוצג על כרטיס מתאם מייצג, כדי שיתאים למטריצה; פריסת הכרטיס להמחשה.',
  'sim.part.state.iccCondition': 'זרם הזנה במנוחה',
  'sim.part.state.deltaIccA': 'ΔI_CC מגיליון הנתונים לכל כניסה ב-V_CC − 0.6 V (מרבי)',
  'limitation.logic_1g04_no_delay':
    'DC בלבד: השהיית ההתפשטות אינה מדומה (גיליון הנתונים של SN74LVC1G04 ‏§5.6: ‏t_pd ‏0.7–3.3 ns ב-V_CC ‏3.3 V ± 0.3 V, ‏C_L = 15 pF, ‏−40 °C עד 85 °C). מעגלים שתלויים בה נדחים: משוב בין שערים (נעילות, מתנדים), PWM לתוך שער, שעונים.',
  'limitation.logic_1g32_no_delay':
    'DC בלבד: השהיית ההתפשטות אינה מדומה (גיליון הנתונים של SN74LVC1G32 ‏§5.6: ‏t_pd ‏0.9–3.6 ns ב-V_CC ‏3.3 V ± 0.3 V, ‏C_L = 15 pF, ‏−40 °C עד 85 °C). מעגלים שתלויים בה נדחים: משוב בין שערים (נעילות, מתנדים), PWM לתוך שער, שעונים.',
  'limitation.logic_1g00_no_delay':
    'DC בלבד: השהיית ההתפשטות אינה מדומה (גיליון הנתונים של SN74LVC1G00 ‏§5.6: ‏t_pd ‏0.8–3.8 ns ב-V_CC ‏3.3 V ± 0.3 V, ‏C_L = 15 pF, ‏−40 °C עד 85 °C). מעגלים שתלויים בה נדחים: משוב בין שערים (נעילות, מתנדים), PWM לתוך שער, שעונים.',
  'limitation.logic_1g08_no_delay':
    'DC בלבד: השהיית ההתפשטות אינה מדומה (גיליון הנתונים של SN74LVC1G08 ‏§5.6: ‏t_pd ‏0.8–3.6 ns ב-V_CC ‏3.3 V ± 0.3 V, ‏C_L = 15 pF, ‏−40 °C עד 85 °C). מעגלים שתלויים בה נדחים: משוב בין שערים (נעילות, מתנדים), PWM לתוך שער, שעונים.',
  'sim.part.state.iccCondition.notSupply': 'לא מאופיין במתח הזנה זה (לא נכלל למעלה)',
  'sim.part.state.iccCondition.notInputs':
    'לא מאופיין: כניסה אינה במתח הבדיקה של I_CC בגיליון הנתונים (לא נכלל למעלה)',
  'sim.error.logic_input_floating.mcu_input':
    '{components}: דבר אינו מזין את כניסה {pin}. המקור האפשרי היחיד ברשת שלה (ישירות או דרך נגדים) הוא {pads}, פין של ESP32 במצב כניסה (עכבה גבוהה), למשל לפני ש-setup() של הקושחה הופך אותו ליציאה. לכניסת CMOS שאינה מוזנת אין רמה מוגדרת (גיליון הנתונים: אין להשאיר כניסות CMOS צפות). הוסיפו נגד pull-down או pull-up ‏(TI ממליצה על 10 kΩ) כדי שהכניסה תהיה מוגדרת כשהפין אינו מזין.',
  'sim.error.logic_input_floating.mcu_inputs':
    '{components}: דבר אינו מזין את כניסה {pin}. המקורות האפשריים היחידים ברשת שלה (ישירות או דרך נגדים) הם {pads}, פינים של ESP32 במצב כניסה (עכבה גבוהה), למשל לפני ש-setup() של הקושחה הופך אותם ליציאות. לכניסת CMOS שאינה מוזנת אין רמה מוגדרת (גיליון הנתונים: אין להשאיר כניסות CMOS צפות). הוסיפו נגד pull-down או pull-up ‏(TI ממליצה על 10 kΩ) כדי שהכניסה תהיה מוגדרת כשהפינים אינם מזינים.',
  'limitation.logic_package_dc_no_delay':
    'DC בלבד: השהיית ההתפשטות (בגיליון הנתונים 1–4.1 ns ב-3.3 V) אינה מדומה. מעגלים שתלויים בה נדחים: משוב בין שערים (נעילות, מתנדים), PWM לתוך שער, שעונים.',
  'limitation.logic_package_input_band':
    'כניסה בין V_IL ל-V_IH, מחוץ ל-0–5.5 V, צפה, או מוזנת רק מפין של ESP32 במצב כניסה — נדחית: גיליון הנתונים אינו נותן שם רמה ואינו נותן זרם הזנה. זרם ההזנה במנוחה (I_CC ≤ 10 µA) אינו חלק מהפתרון ומפורט רק ב-V_CC = 3.6 V כשכל הכניסות ב-V_CC או ב-GND.',
  'limitation.logic_package_supply_rows':
    'ספים ורמות יציאה רק היכן שגיליון הנתונים של SN74LVC08A מציג אותם (‎1.65–1.95 V, ‏2.3–3.6 V). עומסים אמיתיים רק ב-1.65, ‏2.3, ‏2.7 או 3.0 V בדיוק, היכן שנקודות הבדיקה של היציאה; בכל מתח אחר (כולל 3.3 V) עד 100 µA. החסם של מחלקת 3.3 V שמשמש לשערים הבודדים אינו מוחל: גיליון נתונים זה אינו מצהיר על הנעה ב-3.3 V.',
  'limitation.logic_package_unused_inputs':
    'גיליון הנתונים דורש שכל כניסה שאינה בשימוש תוחזק ב-V_CC או ב-GND: כניסה צפה, גם של שער שאינו בשימוש, נדחית.',
  'limitation.logic_package_unpowered':
    'אין בגיליון הנתונים מפרט למצב ללא הזנה (I_off): כש-V_CC הוא 0 V הרכיב נדחה, ואינו מדומה ככבוי.',
  'limitation.logic_package_breakout':
    'מארז ה-SOIC-14 מוצג על כרטיס מתאם מייצג, כדי שיתאים למטריצה; פריסת הכרטיס להמחשה. הספק הפיזור (500 mW, תלוי טמפרטורה) אינו נבדק; מגבלת ‎±100 mA בפיני ההזנה נבדקת.',
  'param.powerRating': 'הספק נקוב',
  'model.resistor.koa_cf_1_4': 'פחם ¼ W (KOA CF1/4)',
  'model.resistor.koa_cfs_1_2': 'פחם ½ W (KOA CFS1/2)',
  'limitation.resistor_rating':
    'ההספק הנקוב מגיליון הנתונים של הסדרה שנבחרה (KOA CF1/4 ‏¼ W או CFS1/2 ‏½ W ב-70 °C, בהפחתה עד 0 W ב-155 °C), בטמפרטורת סביבה של 25 °C. מעליו התוצאה מחוץ לתנאים המפורטים; לא מוסק נזק. ההתנגדות קבועה: סחיפה בגלל התחממות עצמית אינה ממודלת.',
  'limitation.servo_supply_current':
    'זרם ההזנה אינו ממודל: ספק חלש או פין 3.3 V אינם מוצגים כשוקעים תחת עומס הסרוו.',
  'limitation.servo_thresholds':
    'TowerPro אינה מציינת את ספי הרמה הלוגית של האות; המודל מניח 2.0 V לרמה גבוהה ו־0.8 V לרמה נמוכה.',
  'limitation.servo_supply_range': 'מדומה רק בהזנה של 4.8–6.0 V; מחוץ לטווח הזה הסרוו נשאר במקומו.',
  'limitation.servo_mapping':
    'פולסים של 1.0–2.0 ms ממופים ל־0–180°; יחידות SG90 אמיתיות שונות זו מזו (חלקן נעות כ־150°). אזור מת של 10 µs, ‏600°/s, ללא מומנט או עומס.',
  'limitation.servo_frames':
    'פולסים של 400–2600 µs מתקבלים כשהמרווח בין מסגרות הוא עד 50 ms; התגובה למסגרות קצרות בהרבה מ־20 ms אינה מוגדרת על ידי היצרן.',
  'limitation.esp32_pwm':
    'PWM ‏(LEDC): מחזור עבודה 0 שמניע עומס, יותר מ־8 ערוצים, עמעום חומרתי והיפוך יציאה נדחים; זמני הרמה הגבוהה מדויקים עד מחזור שעון LEDC אחד.',
  'inspector.limitations': 'מגבלות המודל',
  // Sprint 13 H4: first-run guide.
  'onboarding.heading': 'צעדים ראשונים',
  'onboarding.intro': 'TBI Lab מדמה את ה־ESP32 הקלאסי ואת המעגל סביבו, כאן בדפדפן שלכם.',
  'onboarding.step1': 'פתחו אחת מדוגמאות ה־ESP32 שלמטה, למשל אזעקת המרחק.',
  'onboarding.step2': 'בלשונית הקוד, לחצו בנייה. הבנייה הראשונה עשויה להימשך כדקה.',
  'onboarding.step3':
    'לחצו הרצה. בזמן ההרצה, בחרו רכיב ושנו את מה שהוא חש (מרחק, טמפרטורה, אור, תנועה): הקושחה והמעגל מגיבים.',
  'onboarding.note':
    'הפרויקטים נשמרים בדפדפן הזה בלבד: השתמשו בייצוא כדי לשמור עותק. סימולטור ה־ESP32 משותף לבודקי האלפא; אם הוא תפוס, נסו שוב בעוד רגע.',
  'onboarding.dismiss': 'הבנתי',
  'onboarding.show': 'הצגת צעדים ראשונים',
  // Sprint 13 H7 (shown only when a deployment configures the form).
  'menu.feedback': 'שליחת משוב',
  // Sprint 14: in-app problem reports (shown only when a deployment enables them).
  'menu.reportProblem': 'דיווח על בעיה…',
  'report.title': 'דיווח על בעיה',
  'report.intro': 'ספרו לנו מה השתבש. תיאור קצר של מה שעשיתם ומה ציפיתם שיקרה עוזר יותר מכול.',
  'report.description.label': 'מה קרה?',
  'report.counter.label': '{count} מתוך {max} תווים',
  'report.category.legend': 'תחום',
  'report.category.simulation': 'סימולציה',
  'report.category.build': 'בנייה',
  'report.category.editor': 'עורך',
  'report.category.other': 'משהו אחר',
  'report.blocking': 'הבעיה מונעת ממני להמשיך',
  'report.disclosure.heading': 'מה נשלח',
  'report.disclosure.sent':
    'התיאור שלכם, התחום והאם הבעיה חוסמת אתכם; גרסת האפליקציה ושפת הממשק; מצב הסימולציה הנוכחית, אם יש; שם הדפדפן, הגרסה שלו ומערכת ההפעלה. הדיווח מקושר לחשבון שאיתו נכנסתם.',
  'report.disclosure.notSent':
    'הפרויקט, המעגל, הקוד וצילומי מסך אינם נשלחים. נא לא לכלול מידע אישי.',
  'report.disclosure.retention': 'הדיווחים נמחקים לאחר 90 יום לכל היותר.',
  'report.problem.descriptionRequired': 'תארו את הבעיה.',
  'report.problem.descriptionTooLong': 'קצרו את התיאור ל־{max} תווים לכל היותר.',
  'report.problem.categoryRequired': 'בחרו תחום.',
  'report.send': 'שליחת הדיווח',
  'report.sending': 'בשליחה…',
  'report.cancel': 'ביטול',
  'report.close': 'סגירה',
  'report.sent.heading': 'הדיווח התקבל',
  'report.sent.body': 'תודה. הדיווח התקבל ונשמר. אם תפנו אלינו לגביו, ציינו את המזהה:',
  'report.failed.rate_limited':
    'שלחתם כמה דיווחים לאחרונה. הטקסט שלכם נשמר כאן: נסו שוב בעוד {minutes} דק׳.',
  'report.failed.unavailable':
    'לא ניתן לקבל דיווחים כרגע. הטקסט שלכם נשמר כאן: נסו שוב מאוחר יותר.',
  'report.failed.signed_out': 'פג תוקף הכניסה שלכם. העתיקו את הטקסט, היכנסו שוב ושלחו אותו.',
  'report.failed.rejected': 'לא ניתן היה לקבל את הדיווח. בדקו את הטקסט ונסו שוב.',
  'report.failed.network':
    'השרת לא אישר את הדיווח, ולכן ייתכן שלא התקבל. הטקסט שלכם נשמר כאן: אפשר לשלוח אותו שוב.',
};
