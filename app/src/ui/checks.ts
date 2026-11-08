import { CATALOG, checkCircuit, type CheckIssue, type ProjectDocument } from '@tbi-lab/domain';
import { catalogText, isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';

/**
 * Circuit checks computed once per document version and shared by the canvas markers and the
 * inspector list. Documents are immutable (every edit produces a new object), so the object
 * itself is the cache key. Run/Stop never recomputes them (Sprint 4 perf finding).
 */
const cache = new WeakMap<ProjectDocument, CheckIssue[]>();

export function checksFor(doc: ProjectDocument): CheckIssue[] {
  let issues = cache.get(doc);
  if (!issues) {
    issues = checkCircuit(doc);
    cache.set(doc, issues);
  }
  return issues;
}

/**
 * The localized sentence for one editor-check issue (the inspector's list; Sprint 27: also the
 * circuit debugger, which shows exactly the product's own wording for a check).
 */
export function checkIssueText(
  locale: LocaleInfo,
  doc: ProjectDocument,
  issue: CheckIssue,
): string {
  const t = (key: MessageKey, params?: Record<string, string>) => translate(locale, key, params);
  const list = (ids: string[]) => isolateLtr(ids.join(', '));
  const termName = (component: string, term: string) => {
    const c = doc.components.find((x) => x.id === component);
    const def = c ? CATALOG[c.type].terminals.find((x) => x.id === term) : undefined;
    return def ? catalogText(locale, def.labelKey) : term;
  };
  return ((i: CheckIssue): string => {
    const component = isolateLtr(i.components[0] ?? '');
    switch (i.code) {
      case 'partially_wired':
        return t('checks.partially_wired', {
          component,
          terminals: (i.terminals ?? []).map((x) => termName(i.components[0]!, x)).join(', '),
        });
      case 'wire_over_terminal':
        return t('checks.wire_over_terminal', {
          component,
          terminal: termName(i.components[0]!, i.terminals?.[0] ?? ''),
        });
      case 'terminals_touching':
        return t('checks.terminals_touching', {
          component,
          terminal: termName(i.components[0]!, i.terminals?.[0] ?? ''),
          other: isolateLtr(i.components[1] ?? ''),
          otherTerminal: termName(i.components[1]!, i.terminals?.[1] ?? ''),
        });
      case 'psu_shorted_by_wire':
        return t('checks.psu_shorted_by_wire', { component });
      // Sprint 21: the owner's as-drawn circuit (GND on V_CC's net; nothing across the supply).
      case 'supply_pins_shorted':
        return t('checks.supply_pins_shorted', { component });
      case 'psu_no_load':
        return t('checks.psu_no_load', { component });
      // Sprint 24 (M2): an input the program reads, with nothing holding its level.
      case 'gpio_input_floating': {
        const terminal = termName(i.components[0]!, i.terminals?.[0] ?? '');
        const switches = i.components.slice(1);
        return switches.length
          ? t('checks.gpio_input_floating', { component, terminal, switches: list(switches) })
          : t('checks.gpio_input_floating_always', { component, terminal });
      }
      case 'gpio_input_unconnected':
        return t('checks.gpio_input_unconnected', {
          component,
          terminal: termName(i.components[0]!, i.terminals?.[0] ?? ''),
        });
      case 'no_ground':
        return t('checks.no_ground');
      default:
        return t(`checks.${i.code}`, { components: list(i.components) });
    }
  })(issue);
}
