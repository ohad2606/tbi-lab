/**
 * TBI-018 slice 1: user-facing texts for limit refusals, as { he, en } data. The server returns
 * code + params only; the client renders. The client message files (messages.he.ts / messages.en.ts)
 * take these in a later slice. Dates are dd.mm.yyyy; numbers inside Hebrew text are shown with dir="ltr".
 */
import type { LimitError } from './limits.js';

export type Lang = 'he' | 'en';

// FABLE-REVIEW 14: the Hebrew register is plural ("שלכם", "הגעתם", "רוצים", "יש לכם"), matching the
// company voice "we". The sim queue, daily and pause texts are identical to the app copies (sim.limit.*)
// and offer no purchase, upgrade or priority. Native-speaker review of the Hebrew is still pending.
// The texts that offer to buy extra credits / hours or to upgrade (ai.credits_out*,
// ai.deep_not_in_plan, pack.needs_plan, sim.minutes_out*) are kept as they were: whether that offer may
// be shown is the PR #43 / tbi-docs decision, to be taken BEFORE these texts are wired to a screen.
export const MESSAGES: Record<Lang, Record<string, string>> = {
  he: {
    'limit.ai.credits_out':
      'נגמרו קרדיטי ה-AI שלכם לחודש הזה. הם יתחדשו ב-{date}. הסימולטור וכל ההסברים ממשיכים לעבוד. אפשר לרכוש חבילת קרדיטים או לשדרג מסלול.',
    'limit.ai.credits_out_free':
      'נגמרו קרדיטי ה-AI החינמיים שלכם לחודש הזה. הם יתחדשו ב-{date}. הסימולטור וכל ההסברים ממשיכים לעבוד. רוצים עוד? אפשר לשדרג למסלול מתקדם.',
    'limit.ai.daily':
      'הגעתם למגבלה היומית של עזרת ה-AI. היא תתאפס מחר. הסימולטור ממשיך לעבוד כרגיל.',
    'limit.ai.rate': 'יותר מדי בקשות בזמן קצר. אפשר לנסות שוב בעוד {n} שניות.',
    'limit.ai.too_long':
      'הבקשה ארוכה מדי לעוזר ה-AI. הקטינו את הקוד או בחרו חלק מהמעגל ונסו שוב. לא נשלח כלום.',
    'limit.ai.global_off':
      'עוזר ה-AI נח כרגע ויחזור בהקדם. הסימולטור וכל ההסברים ממשיכים לעבוד. הקרדיטים שלכם לא נוצלו.',
    'limit.system.unavailable': 'השירות זמנית לא זמין ולא חויבתם. נסו שוב בעוד רגע.',
    'limit.ai.deep_not_in_plan':
      'מצב העומק זמין במסלול מתקדם ומעלה. אפשר לשאול שאלה רגילה, או לשדרג מסלול.',
    'limit.pack.needs_plan':
      'אפשר לרכוש חבילת קרדיטים רק עם מסלול מתקדם או Pro פעיל. אפשר לשדרג מסלול קודם.',
    'limit.sim.minutes_out':
      'נגמרו דקות הסימולציה שלכם לחודש הזה. הן יתחדשו ב-{date}. עדיין אפשר לערוך, לחבר רכיבים ולהריץ את הפותר המקומי בדפדפן. אפשר לרכוש שעות נוספות או לשדרג מסלול.',
    'limit.sim.minutes_out_free':
      'נגמרו דקות הסימולציה החינמיות שלכם לחודש הזה. הן יתחדשו ב-{date}. עדיין אפשר לערוך ולחבר רכיבים. רוצים יותר זמן הרצה? אפשר לשדרג למסלול מתקדם.',
    'limit.sim.daily':
      'הגעתם למגבלה היומית של דקות הסימולציה. היא תתאפס מחר. עדיין אפשר לערוך ולחבר רכיבים.',
    'limit.sim.queue':
      'כל מקומות ההרצה תפוסים כרגע. אתם במקום {n} בתור. ההרצה תתחיל אוטומטית כשיתפנה מקום. אפשר להמשיך לערוך בינתיים.',
    'limit.sim.queue_timeout': 'לא התפנה מקום הרצה בזמן סביר. נסו שוב בעוד כמה דקות.',
    'limit.sim.cooldown': 'אפשר להתחיל הרצה חינמית חדשה בעוד {n} שניות. אפשר להמשיך לערוך בינתיים.',
    'limit.sim.queue_full': 'תור ההרצה מלא כרגע. נסו שוב בעוד כמה דקות.',
    'limit.sim.concurrent':
      'כבר יש לכם הרצה פעילה. אפשר לעצור אותה או לחכות שתסתיים, ואז להתחיל הרצה חדשה.',
    'limit.sim.queue_replaced':
      'המקום שלכם בתור הועבר ללשונית אחרת. אפשר לסגור את הלשונית הזו ולחזור ללשונית השנייה.',
    'limit.sim.free_paused':
      'הרצות חדשות מושהות כרגע. נסו שוב מאוחר יותר. אפשר להמשיך לערוך ולחבר רכיבים בינתיים.',
  },
  en: {
    'limit.ai.credits_out':
      'You have used all your AI credits for this month. They renew on {date}. The simulator and all explanations keep working. You can buy a credit pack or upgrade your plan.',
    'limit.ai.credits_out_free':
      'You have used your free AI credits for this month. They renew on {date}. The simulator and all explanations keep working. Want more? You can upgrade to Advanced.',
    'limit.ai.daily':
      "You have reached today's AI assistant limit. It resets tomorrow. The simulator keeps working as usual.",
    'limit.ai.rate': 'Too many requests in a short time. Please try again in {n} seconds.',
    'limit.ai.too_long':
      'This request is too long for the AI assistant. Shorten the code or select part of the circuit and try again. Nothing was sent.',
    'limit.ai.global_off':
      'The AI assistant is resting for now and will be back soon. The simulator and all explanations keep working. Your credits were not used.',
    'limit.system.unavailable':
      'The service is temporarily unavailable and you were not charged. Please try again shortly.',
    'limit.ai.deep_not_in_plan':
      'Deep mode is available on the Advanced plan and above. You can ask a standard question, or upgrade your plan.',
    'limit.pack.needs_plan':
      'Credit packs can only be bought with an active Advanced or Pro plan. You can upgrade your plan first.',
    'limit.sim.minutes_out':
      'You have used all your ESP32 simulation minutes for this month. They renew on {date}. You can still edit, wire parts and use the in-browser solver. You can buy extra hours or upgrade your plan.',
    'limit.sim.minutes_out_free':
      'You have used your free ESP32 simulation minutes for this month. They renew on {date}. You can still edit and wire parts. Want more run time? You can upgrade to Advanced.',
    'limit.sim.daily':
      'You have reached the daily limit of simulation minutes. It resets tomorrow. You can still edit and wire parts.',
    'limit.sim.queue':
      'All run slots are busy right now. You are number {n} in the queue. The run starts automatically when a slot is free. You can keep editing meanwhile.',
    'limit.sim.queue_timeout':
      'No run slot became free in a reasonable time. Try again in a few minutes.',
    'limit.sim.cooldown':
      'You can start a new free run in {n} seconds. You can keep editing meanwhile.',
    'limit.sim.queue_full': 'The run queue is full right now. Please try again in a few minutes.',
    'limit.sim.concurrent':
      'You already have a run in progress. Stop it or wait until it ends, then start a new run.',
    'limit.sim.queue_replaced':
      'Your place in the queue is now held by another tab. Close this tab or return to the other one.',
    'limit.sim.free_paused':
      'New runs are paused right now. Please try again later. You can keep editing and wiring parts meanwhile.',
  },
};

export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1] as string).sort();
}

/** Render a refusal; unknown key or missing param is an error (never a blank or a guessed text). */
export function renderLimit(lang: Lang, err: LimitError): string {
  if (!err.messageKey) throw new Error(`limit code ${err.code} has no user message`);
  const text = MESSAGES[lang][err.messageKey];
  if (text === undefined) throw new Error(`missing message ${err.messageKey} (${lang})`);
  return text.replace(/\{([A-Za-z_]+)\}/g, (_m, k: string) => {
    const v = err.params[k];
    if (v === undefined) throw new Error(`missing param ${k} for ${err.messageKey}`);
    return String(v);
  });
}
