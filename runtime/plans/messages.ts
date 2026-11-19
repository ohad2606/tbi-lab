/**
 * TBI-018 slice 1: user-facing texts for limit refusals, as { he, en } data. The server returns
 * code + params only; the client renders. The client message files (messages.he.ts / messages.en.ts)
 * take these in a later slice. Dates are dd.mm.yyyy; numbers inside Hebrew text are shown with dir="ltr".
 */
import type { LimitError } from './limits.js';

export type Lang = 'he' | 'en';

export const MESSAGES: Record<Lang, Record<string, string>> = {
  he: {
    'limit.ai.credits_out':
      'נגמרו קרדיטי ה-AI שלך לחודש הזה. הם יתחדשו ב-{date}. הסימולטור וכל ההסברים ממשיכים לעבוד. אפשר לרכוש חבילת קרדיטים או לשדרג מסלול.',
    'limit.ai.credits_out_free':
      'נגמרו קרדיטי ה-AI החינמיים שלך לחודש הזה. הם יתחדשו ב-{date}. הסימולטור וכל ההסברים ממשיכים לעבוד. רוצה עוד? אפשר לשדרג למסלול מתקדם.',
    'limit.ai.daily':
      'הגעת למגבלה היומית של עזרת ה-AI. היא תתאפס מחר. הסימולטור ממשיך לעבוד כרגיל.',
    'limit.ai.rate': 'יותר מדי בקשות בזמן קצר. אפשר לנסות שוב בעוד {n} שניות.',
    'limit.ai.too_long':
      'הבקשה ארוכה מדי לעוזר ה-AI. הקטינו את הקוד או בחרו חלק מהמעגל ונסו שוב. לא נשלח כלום.',
    'limit.ai.global_off':
      'עוזר ה-AI נח כרגע ויחזור בהקדם. הסימולטור וכל ההסברים ממשיכים לעבוד. הקרדיטים שלך לא נוצלו.',
    'limit.system.unavailable': 'השירות זמנית לא זמין ולא חויבת. נסו שוב בעוד רגע.',
    'limit.ai.deep_not_in_plan':
      'מצב העומק זמין במסלול מתקדם ומעלה. אפשר לשאול שאלה רגילה, או לשדרג מסלול.',
    'limit.pack.needs_plan':
      'אפשר לרכוש חבילת קרדיטים רק עם מסלול מתקדם או Pro פעיל. אפשר לשדרג מסלול קודם.',
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
