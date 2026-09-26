/**
 * Project -> R2 session snapshot (Sprint 6).
 *
 * The browser owns the project. When a project contains a Classic ESP32 board, Run builds an
 * explicit, self-contained execution snapshot from the PERSISTED document and sends it to the
 * Session Host; the host never fetches or owns the project.
 *
 * The board itself is not an electrical element of the snapshot. It is replaced by what the
 * runtime models:
 *   - each wired GPIO pad becomes an R2 pin attachment on another component terminal of the
 *     same net (the engine places the MCU pad device there);
 *   - its GND terminal becomes a ground element on the same net: the board ground IS the
 *     circuit reference the runtime drives its pads against (runtime R2 model assumption).
 * Everything else (components, nets, PSU and toggle states) is the project's own snapshot,
 * unchanged, and the same production engine solves it on the server.
 */
import {
  ESP32_BOARD,
  NO_FIRMWARE,
  createSnapshot,
  firmwareBySha,
  type ComponentInstance,
  type FirmwareArtifact,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { PROTOCOL, type CreateSessionRequest } from '../../../runtime/host/protocol.js';

export type McuPlanError =
  | { code: 'mcu_multiple'; components: string[] }
  | { code: 'mcu_no_firmware'; components: string[] }
  | { code: 'mcu_unknown_firmware'; components: string[] }
  | { code: 'mcu_ground_unconnected'; components: string[] }
  | { code: 'mcu_pin_without_circuit'; components: string[]; pins: number[] };

export interface McuPlan {
  board: ComponentInstance;
  firmware: FirmwareArtifact;
  request: CreateSessionRequest;
  /** Project revision the session starts from (mirrors must carry later revisions). */
  revision: number;
}

/** The dispatch rule: a project with a Classic ESP32 board runs on the R2 Session Host. */
export function requiresMcuRuntime(doc: ProjectDocument): boolean {
  return doc.components.some((c) => c.type === ESP32_BOARD);
}

const gpioOf = (terminal: string) =>
  /^gpio(\d+)$/.exec(terminal) ? Number(terminal.slice(4)) : null;

export function buildSessionRequest(
  doc: ProjectDocument,
): { ok: true; plan: McuPlan } | { ok: false; error: McuPlanError } {
  const boards = doc.components.filter((c) => c.type === ESP32_BOARD);
  if (boards.length !== 1)
    return { ok: false, error: { code: 'mcu_multiple', components: boards.map((b) => b.id) } };
  const board = boards[0]!;
  const sha = board.params.firmware;
  if (typeof sha !== 'string' || sha === NO_FIRMWARE)
    return { ok: false, error: { code: 'mcu_no_firmware', components: [board.id] } };
  const firmware = firmwareBySha(sha);
  if (!firmware)
    return { ok: false, error: { code: 'mcu_unknown_firmware', components: [board.id] } };

  const own = doc.connections.filter((c) => c.component === board.id);
  const others = doc.connections.filter((c) => c.component !== board.id);
  const gnd = own.find((c) => c.terminal === 'gnd');
  if (!gnd) return { ok: false, error: { code: 'mcu_ground_unconnected', components: [board.id] } };

  const attachments: CreateSessionRequest['attachments'] = [];
  const orphan: number[] = [];
  for (const conn of own) {
    const gpio = gpioOf(conn.terminal);
    if (gpio === null) continue;
    // Any other component terminal on the pad's net is the same electrical node; take the first
    // in canonical connection order so the choice is deterministic.
    const at = others.find((c) => c.net === conn.net);
    if (!at) orphan.push(gpio);
    else attachments.push({ gpio, component: at.component, terminal: at.terminal });
  }
  if (orphan.length)
    return {
      ok: false,
      error: {
        code: 'mcu_pin_without_circuit',
        components: [board.id],
        pins: orphan.sort((a, b) => a - b),
      },
    };
  attachments.sort((a, b) => a.gpio - b.gpio);

  // The execution projection: the board replaced by its ground reference element.
  const groundId = `${board.id}_gnd`;
  const projected: ProjectDocument = {
    ...doc,
    components: [
      ...doc.components.filter((c) => c.id !== board.id),
      { id: groundId, type: 'component.ground', typeVersion: 1, params: {} },
    ],
    connections: [...others, { component: groundId, terminal: 'ref', net: gnd.net }],
  };
  const circuit = createSnapshot(projected);
  const usedNets = new Set(circuit.connections.map((c) => c.net));
  circuit.nets = circuit.nets.filter((n) => usedNets.has(n.id));

  const request: CreateSessionRequest = {
    protocol: PROTOCOL,
    artifact: { sha256: firmware.sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit,
    attachments,
    ...(firmware.features.internalPull.length || firmware.features.gpioInterrupt.length
      ? {
          firmwareFeatures: {
            internalPull: [...firmware.features.internalPull],
            gpioInterrupt: [...firmware.features.gpioInterrupt],
          },
        }
      : {}),
  };
  return { ok: true, plan: { board, firmware, request, revision: doc.revision.localRevision } };
}
