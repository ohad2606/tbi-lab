/**
 * Controlled electrical terminology per locale: the single source of truth for these terms
 * (CLAUDE.md "Professional terminology"). Message bundles reference them as [[term]] and
 * never spell them out, so a term changes in exactly one place.
 *
 * Hebrew V1 glossary (PM, Sprint 3): circuit ground is "אדמה (GND)", the circuit reference,
 * NOT "הארקה" (protective earth wiring).
 */

export const GLOSSARY_TERMS = [
  'ground',
  'net',
  'terminal',
  'junction',
  'component',
  'components',
  'pin',
  'diode',
  'pushButton',
  'toggleSwitch',
  'probe',
  'relay',
  'photoresistor',
  'buzzer',
  'transistor',
  'logicGate',
  'potentiometer',
  'wiper',
] as const;

export type GlossaryTerm = (typeof GLOSSARY_TERMS)[number];

export const GLOSSARY: Record<string, Record<GlossaryTerm, string>> = {
  en: {
    ground: 'Ground (GND)',
    net: 'net',
    terminal: 'terminal',
    junction: 'junction',
    component: 'component',
    components: 'components',
    pin: 'pin',
    diode: 'Diode',
    pushButton: 'Push button',
    toggleSwitch: 'Toggle switch',
    probe: 'probe',
    relay: 'Relay',
    photoresistor: 'Photoresistor (LDR)',
    buzzer: 'Buzzer',
    transistor: 'Transistor',
    logicGate: 'Logic gate',
    potentiometer: 'Potentiometer',
    wiper: 'wiper',
  },
  he: {
    ground: 'אדמה (GND)',
    net: 'רשת',
    terminal: 'הדק',
    junction: 'צומת',
    component: 'רכיב',
    components: 'רכיבים',
    pin: 'פין',
    diode: 'דיודה',
    pushButton: 'לחצן',
    toggleSwitch: 'מתג',
    probe: 'נקודת מדידה',
    relay: 'ממסר',
    photoresistor: 'נגד תלוי אור (LDR)',
    buzzer: 'זמזם',
    transistor: 'טרנזיסטור',
    logicGate: 'שער לוגי',
    potentiometer: 'פוטנציומטר',
    wiper: 'זרוע',
  },
};

/** Replace every [[term]] with the locale's glossary entry. Unknown terms throw at load. */
export function applyGlossary<T extends Record<string, string>>(
  messages: T,
  terms: Record<GlossaryTerm, string>,
): T {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(messages)) {
    out[key] = text.replace(/\[\[(\w+)\]\]/g, (_, term: string) => {
      if (!(term in terms)) throw new Error(`Unknown glossary term [[${term}]] in ${key}`);
      return terms[term as GlossaryTerm];
    });
  }
  return out as T;
}
