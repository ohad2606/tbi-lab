/**
 * Editor-time circuit checks (Sprint 4 validation layer). Pure and language-neutral: each issue
 * is a code with component/terminal/net ids; the app localizes it.
 *
 * These checks never change the circuit. They make visible what the drawing means
 * electrically, before Run: connections come only from explicit wire endpoints (terminals
 * and junction dots), never from geometry. The electrical engine still has the final word at
 * Run (it knows supply outputs and switch states); these checks warn early and conservatively.
 */

import { CATALOG } from './catalog.js';
import { touchingUnconnected } from './contacts.js';
import { terminalPosition, wireRoute, pointOnSegment } from './layout.js';
import { programInputPins } from './inputPins.js';
import { nodeKey, wireGroups } from './nets.js';
import type { ProjectDocument } from './schema.js';

export type CheckCode =
  | 'not_connected'
  | 'partially_wired'
  | 'wire_over_terminal'
  | 'terminals_touching'
  | 'floating_island'
  | 'no_ground'
  | 'psu_shorted_by_wire'
  /** Sprint 21: a part's own V_CC and GND pins are on one net: it can never be powered. */
  | 'supply_pins_shorted'
  /** Sprint 21: nothing connects a supply's + to its −: it can deliver no current to any part. */
  | 'psu_no_load'
  /**
   * Sprint 24 (M2): the board's program reads a GPIO as a digital input, and while a switch on its
   * net is open (or always) nothing holds the pin's level: no pull-up or pull-down. A real ESP32
   * then reads an undefined level; the simulator's input leakage reads LOW. Non-blocking.
   */
  | 'gpio_input_floating';

export interface CheckIssue {
  code: CheckCode;
  /** Info: shown, does not block Run. Warning: likely a mistake; Run may refuse it. */
  severity: 'info' | 'warning';
  components: string[];
  /** Terminal ids of the (first) component the issue is about. */
  terminals?: string[];
  wire?: string;
}

const REF = '\u0000GND';

export function checkCircuit(doc: ProjectDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const netOf = new Map(doc.connections.map((c) => [`${c.component}\u0000${c.terminal}`, c.net]));
  const groundNets = new Set(doc.nets.filter((n) => n.role === 'ground').map((n) => n.id));

  // Not connected / partially wired.
  const wiredParts: string[] = [];
  for (const c of doc.components) {
    const terms = CATALOG[c.type].terminals.map((t) => t.id);
    const unwired = terms.filter((t) => !netOf.has(`${c.id}\u0000${t}`));
    if (c.type === 'component.ground') continue;
    if (unwired.length === terms.length) {
      issues.push({ code: 'not_connected', severity: 'info', components: [c.id] });
      continue;
    }
    wiredParts.push(c.id);
    // A board with unused pins is normal (Sprint 6): only wired pins take part in the circuit.
    // Sprint 10: likewise any terminal the type declares optional (a matrix's unused lines, an
    // RGB LED's unused channel, the relay contact not used).
    const optional = CATALOG[c.type].optionalTerminals;
    const missing = optional === 'all' ? [] : unwired.filter((t) => !(optional ?? []).includes(t));
    if (missing.length) {
      issues.push({
        code: 'partially_wired',
        severity: 'warning',
        components: [c.id],
        terminals: unwired,
      });
    }
  }

  // A supply whose own terminals share a net: shorted by a wire.
  for (const c of doc.components) {
    if (c.type !== 'instrument.lab_psu') continue;
    const p = netOf.get(`${c.id}\u0000positive`);
    if (p !== undefined && p === netOf.get(`${c.id}\u0000negative`)) {
      issues.push({ code: 'psu_shorted_by_wire', severity: 'warning', components: [c.id] });
    }
  }

  // Sprint 21 (DEV-Lab acceptance, the owner's as-drawn circuit): a part whose own supply pins
  // (`vcc` and `gnd`) share one net. Its supply voltage is 0 V whatever the source: it can never
  // be powered (the engine then reports it unpowered, never a level).
  for (const c of doc.components) {
    const ids = CATALOG[c.type].terminals.map((t) => t.id);
    if (!ids.includes('vcc') || !ids.includes('gnd')) continue;
    // Review item 10: every GND symbol is the one reference (two ground nets are one node).
    const at = (t: string) => {
      const n = netOf.get(`${c.id}\u0000${t}`);
      return n === undefined ? undefined : groundNets.has(n) ? REF : n;
    };
    const v = at('vcc');
    if (v !== undefined && v === at('gnd'))
      issues.push({
        code: 'supply_pins_shorted',
        severity: 'warning',
        components: [c.id],
        terminals: ['vcc', 'gnd'],
      });
  }

  // Sprint 21: a supply whose + and − no part connects, even counting every terminal of every
  // part as joined (the most generous reading: a switch closed, a gate conducting): no current
  // can leave it. Only when both terminals are wired (an unwired supply is `not_connected` or
  // `partially_wired` above), and never for a shorted one (above). Conservative, so a normal
  // circuit with any load across the supply never shows it.
  {
    const netAt = (c: string, t: string) => {
      const n = netOf.get(`${c}\u0000${t}`);
      return n === undefined ? undefined : groundNets.has(n) ? REF : n;
    };
    const supplies = doc.components.filter((c) => c.type === 'instrument.lab_psu');
    const supplyNets = (id: string) =>
      ['positive', 'negative'].map((t) => netAt(id, t)).filter((n): n is string => n !== undefined);
    // Review item 9: a fresh union per supply (parts, plus the OTHER supplies conducting), so one
    // supply's own terminals never count as a load for another.
    for (const s of supplies) {
      const nets = supplyNets(s.id);
      if (nets.length !== 2 || nets[0] === nets[1]) continue;
      const parent = new Map<string, string>();
      const find = (k: string): string => {
        if (!parent.has(k)) parent.set(k, k);
        const q = parent.get(k)!;
        if (q === k) return k;
        const r = find(q);
        parent.set(k, r);
        return r;
      };
      const join = (ns: string[]) => {
        for (const n of ns.slice(1)) parent.set(find(ns[0]!), find(n));
      };
      for (const c of doc.components) {
        if (c.type === 'instrument.lab_psu' || c.type === 'component.ground') continue;
        join(
          CATALOG[c.type].terminals
            .map((t) => netAt(c.id, t.id))
            .filter((n): n is string => n !== undefined),
        );
      }
      for (const o of supplies)
        if (o !== s && supplyNets(o.id).length === 2) join(supplyNets(o.id));
      if (find(nets[0]!) !== find(nets[1]!))
        issues.push({ code: 'psu_no_load', severity: 'warning', components: [s.id] });
    }
  }

  // Reference analysis over the drawn topology. Every two-terminal part is treated as
  // possibly conducting (a switch may be closed, a supply switched on): an island that cannot
  // reach GND even then is certainly floating.
  // A wired ground terminal is the circuit reference: the GND symbol, or the GND pin of an
  // MCU board, whose pads the runtime drives against it (Sprint 6).
  const hasGround = doc.components.some((c) => {
    const g = CATALOG[c.type].groundTerminal;
    return g !== undefined && netOf.has(`${c.id}\u0000${g}`);
  });
  if (wiredParts.length && !hasGround) {
    issues.push({ code: 'no_ground', severity: 'warning', components: wiredParts });
  } else if (wiredParts.length) {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      const p = parent.get(k)!;
      if (p === k) return k;
      const r = find(p);
      parent.set(k, r);
      return r;
    };
    const node = (c: string, t: string) => {
      const n = netOf.get(`${c}\u0000${t}`);
      return n === undefined ? `~${c}.${t}` : groundNets.has(n) ? REF : n;
    };
    const isBoard = (c: { type: string }) => c.type === 'board.esp32_devkitc_wroom32';
    // A wired MCU pad is referenced to GND through the MCU (its driver or input leakage), as in
    // the engine's reference analysis.
    for (const c of doc.components.filter(isBoard)) {
      for (const t of CATALOG[c.type].terminals) {
        if (netOf.has(`${c.id}\u0000${t.id}`)) parent.set(find(node(c.id, t.id)), find(REF));
      }
    }
    const two = doc.components.filter((c) => wiredParts.includes(c.id) && !isBoard(c));
    for (const c of two) {
      const [t0, t1] = CATALOG[c.type].terminals.map((t) => t.id) as [string, string];
      parent.set(find(node(c.id, t0)), find(node(c.id, t1)));
    }
    const floating = two
      .filter((c) => find(node(c.id, CATALOG[c.type].terminals[0]!.id)) !== find(REF))
      .map((c) => c.id);
    if (floating.length)
      issues.push({ code: 'floating_island', severity: 'warning', components: floating });
  }

  issues.push(...floatingInputs(doc, netOf, groundNets));

  // Visual ambiguity: a wire drawn across a terminal it is NOT connected to. Terminal
  // positions are computed once, and each wire is tested only against terminals inside its
  // route's bounding box, so the cost stays near-linear for V1-sized workspaces.
  const groupOf = new Map<string, number>();
  wireGroups(doc).forEach((g, i) => g.forEach((k) => groupOf.set(k, i)));
  const terminals: { component: string; terminal: string; key: string; x: number; y: number }[] =
    [];
  for (const c of doc.components) {
    for (const t of CATALOG[c.type].terminals) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) {
        const key = nodeKey({ kind: 'terminal', component: c.id, terminal: t.id });
        terminals.push({ component: c.id, terminal: t.id, key, x: p.x, y: p.y });
      }
    }
  }
  for (const w of doc.layout.wires) {
    const route = wireRoute(doc, w);
    if (!route) continue;
    const group = groupOf.get(nodeKey(w.from));
    const xs = route.map((p) => p.x);
    const ys = route.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (const term of terminals) {
      if (term.x < x0 || term.x > x1 || term.y < y0 || term.y > y1) continue;
      if (group !== undefined && groupOf.get(term.key) === group) continue; // same net: consistent
      const touches = route.some(
        (a, i) => i < route.length - 1 && pointOnSegment(term, a, route[i + 1]!),
      );
      if (touches) {
        issues.push({
          code: 'wire_over_terminal',
          severity: 'warning',
          components: [term.component],
          terminals: [term.terminal],
          wire: w.id,
        });
      }
    }
  }

  // Visual ambiguity: terminals of different parts drawn on top of each other but NOT connected
  // (only in a document made elsewhere; editing makes such a touch a direct contact).
  for (const t of touchingUnconnected(doc)) {
    const [a, b] = t.terminals as [(typeof t.terminals)[0], (typeof t.terminals)[0]];
    issues.push({
      code: 'terminals_touching',
      severity: 'warning',
      components: [a.component, b.component],
      terminals: [a.terminal, b.terminal],
    });
  }
  return issues;
}

/**
 * Parts that conduct at DC (both terminals one node for this check), and parts that neither conduct
 * nor drive (junctions: whether one conducts needs a threshold this check does not have; capacitors;
 * switches, taken OPEN: the state in which a pull resistor matters). Any other part's terminal, a
 * supply, GND or another board pin counts as holding the level (no warning: conservative).
 */
const CONDUCTS = new Set(['component.resistor', 'component.photoresistor']);
const SWITCHES = new Set(['component.push_button', 'component.toggle_switch']);
const NEITHER = new Set([
  'component.led',
  'component.diode',
  'component.rgb_led',
  'component.capacitor',
  'display.led_matrix_8x8',
  ...SWITCHES,
]);

/**
 * Sprint 24 (M2): a GPIO the program reads as an input (inputPins.ts) whose net, with every switch
 * open, reaches nothing that holds a level: through resistors only to switches, junctions or
 * nothing. Wired pins only (an unwired pin is not part of the circuit).
 */
function floatingInputs(
  doc: ProjectDocument,
  netOf: Map<string, string>,
  groundNets: Set<string>,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const board of doc.components) {
    if (board.type !== 'board.esp32_devkitc_wroom32') continue;
    const program = doc.programs[board.id];
    if (!program) continue;
    for (const gpio of programInputPins(program)) {
      const terminal = `gpio${gpio}`;
      const start = netOf.get(`${board.id}\u0000${terminal}`);
      if (start === undefined) continue;
      // Walk the nets joined through conducting parts; note what else touches them.
      const seen = new Set<string>([start]);
      const queue = [start];
      let held = false;
      const switches = new Set<string>();
      while (queue.length && !held) {
        const net = queue.shift()!;
        if (groundNets.has(net)) held = true;
        for (const c of doc.connections) {
          if (c.net !== net) continue;
          if (c.component === board.id && c.terminal === terminal) continue;
          const part = doc.components.find((x) => x.id === c.component);
          if (!part) continue;
          if (CONDUCTS.has(part.type)) {
            for (const t of CATALOG[part.type].terminals) {
              const n = netOf.get(`${part.id}\u0000${t.id}`);
              if (n !== undefined && !seen.has(n)) {
                seen.add(n);
                queue.push(n);
              }
            }
          } else if (SWITCHES.has(part.type)) switches.add(part.id);
          else if (!NEITHER.has(part.type)) held = true;
        }
      }
      if (held) continue;
      issues.push({
        code: 'gpio_input_floating',
        severity: 'warning',
        components: [board.id, ...[...switches].sort()],
        terminals: [terminal],
      });
    }
  }
  return issues;
}
