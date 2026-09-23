/**
 * Application state: project lifecycle, the open document, selection, save state and
 * locale. UI-framework independent, so it is unit-testable without a DOM.
 *
 * Ownership (architecture §2, ADR-001): the Project Document in local storage is the source
 * of truth. User preferences (locale, last open project) are stored separately and are never
 * written into a project.
 */

import {
  CATALOG,
  SCHEMA_VERSION,
  createProject,
  emptySelection,
  classifyEdit,
  historyTarget,
  liveChanges,
  openDocument,
  renameProject,
  stampRevision,
  validateProject,
  type EditResult,
  type ProjectDocument,
  type Selection,
} from '@tbi-lab/domain';
import {
  negotiateLocale,
  getLocale,
  translate,
  type LocaleInfo,
  type MessageKey,
} from '../i18n/i18n.js';
import { Autosave, type SaveState } from '../persistence/autosave.js';
import type { ProjectIndexEntry, ProjectStorage } from '../persistence/store.js';
import type { LiveControl } from '@tbi-lab/engine';
import type { SimState, SimulationController } from '../sim/controller.js';

interface HistoryEntry {
  before: ProjectDocument;
  after: ProjectDocument;
}

const HISTORY_LIMIT = 100;

export const APP_VERSION = '0.1.0';

export interface Preferences {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const PREF_LOCALE = 'tbi-lab.locale';
export const PREF_LAST_PROJECT = 'tbi-lab.lastProject';

export type Notice = { key: MessageKey; params?: Record<string, string | number> };

export interface AppState {
  screen: 'loading' | 'home' | 'editor' | 'unavailable';
  locale: LocaleInfo;
  projects: ProjectIndexEntry[];
  doc: ProjectDocument | null;
  /** Set when the open project comes from a newer schema: nothing may be written. */
  readOnly: { schemaVersion: number } | null;
  /** A newer-schema project whose content this version cannot display. */
  unreadable: { schemaVersion: number; name: string } | null;
  selection: Selection;
  saveState: SaveState;
  notice: Notice | null;
  /** Runtime simulation state. Never persisted: a reopened project is always stopped. */
  sim: SimState;
  /** Undo/redo depth (the history itself is session state, never persisted). */
  history: { undo: number; redo: number };
}

export interface AppDeps {
  storage: ProjectStorage | null;
  prefs: Preferences;
  languages: readonly string[];
  newId: () => string;
  clock?: { now(): Date };
  autosaveDebounceMs?: number;
  /** Mode A simulation host. Absent in contexts that never simulate (some unit tests). */
  simulation?: SimulationController;
}

export class AppStore {
  private stateValue: AppState;
  private listeners = new Set<() => void>();
  private autosave: Autosave | null = null;
  /**
   * Undo/redo history of persistent edits: pairs of document contents. Session-only (a
   * reopened project starts with an empty history). Never holds language, Run/Stop, results,
   * button presses, selection or camera: those are not project edits.
   */
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private deviceId = 'unknown-device';

  constructor(private readonly deps: AppDeps) {
    const stored = deps.prefs.get(PREF_LOCALE);
    this.stateValue = {
      screen: 'loading',
      locale: getLocale(stored ?? negotiateLocale(deps.languages)),
      projects: [],
      doc: null,
      readOnly: null,
      unreadable: null,
      selection: emptySelection(),
      saveState: 'saved',
      notice: null,
      sim: { status: 'stopped' },
      history: { undo: 0, redo: 0 },
    };
    deps.simulation?.subscribe(() => this.set({ sim: deps.simulation!.state }));
  }

  get state(): AppState {
    return this.stateValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<AppState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    for (const l of this.listeners) l();
  }

  /** Load the project list and reopen the last project, as a desktop application would. */
  async init(): Promise<void> {
    const { storage } = this.deps;
    if (!storage) {
      this.set({ screen: 'unavailable' });
      return;
    }
    this.deviceId = await storage.getOrCreateDeviceId(() => `dev_${this.deps.newId()}`);
    this.autosave = new Autosave(
      storage,
      this.deps.autosaveDebounceMs === undefined
        ? {}
        : { debounceMs: this.deps.autosaveDebounceMs },
    );
    this.autosave.onState((saveState) => {
      this.set({ saveState });
      if (saveState === 'saved') void this.refreshProjects();
    });
    await this.refreshProjects();
    const last = this.deps.prefs.get(PREF_LAST_PROJECT);
    if (last && this.stateValue.projects.some((p) => p.projectId === last)) {
      await this.openProject(last);
      if (this.stateValue.screen === 'editor') return;
    }
    this.set({ screen: 'home' });
  }

  async refreshProjects(): Promise<void> {
    if (!this.deps.storage) return;
    this.set({ projects: await this.deps.storage.list() });
  }

  setLocale(code: string): void {
    const locale = getLocale(code);
    this.deps.prefs.set(PREF_LOCALE, locale.code);
    this.set({ locale });
  }

  async newProject(name: string): Promise<void> {
    this.deps.simulation?.stop();
    const doc = createProject({
      projectId: `prj_${this.deps.newId()}`,
      deviceId: this.deviceId,
      name: name.trim() || translate(this.stateValue.locale, 'home.new.defaultName'),
      appVersion: APP_VERSION,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    this.deps.prefs.set(PREF_LAST_PROJECT, doc.projectId);
    this.clearHistory();
    this.set({
      screen: 'editor',
      doc,
      readOnly: null,
      unreadable: null,
      selection: emptySelection(),
      notice: null,
    });
    this.autosave?.queue(doc);
    await this.autosave?.flush();
  }

  async openProject(projectId: string): Promise<void> {
    this.deps.simulation?.stop();
    await this.autosave?.flush();
    const raw = await this.deps.storage?.load(projectId);
    if (raw === undefined) {
      this.set({ notice: { key: 'open.error.missing' } });
      return;
    }
    const result = openDocument(raw);
    this.clearHistory();
    const base = { selection: emptySelection(), notice: null, unreadable: null };
    if (result.status === 'ok') {
      this.deps.prefs.set(PREF_LAST_PROJECT, projectId);
      this.set({ ...base, screen: 'editor', doc: result.doc, readOnly: null });
      if (result.migratedFrom !== null) this.commit(result.doc);
    } else if (result.status === 'newer') {
      // Never guess at a newer schema. If its core still validates under this version's rules,
      // show it read-only; otherwise say plainly that it cannot be displayed.
      const asCurrent = { ...(result.raw as object), schemaVersion: SCHEMA_VERSION };
      const name = String((result.raw as { name?: unknown }).name ?? '');
      if (validateProject(asCurrent).length === 0) {
        this.set({
          ...base,
          screen: 'editor',
          doc: asCurrent as ProjectDocument,
          readOnly: { schemaVersion: result.schemaVersion },
        });
      } else {
        this.set({
          ...base,
          screen: 'home',
          doc: null,
          readOnly: null,
          unreadable: { schemaVersion: result.schemaVersion, name },
        });
      }
    } else {
      this.set({
        notice: {
          key: result.status === 'unmigratable' ? 'open.error.unmigratable' : 'open.error.invalid',
        },
      });
    }
  }

  async goHome(): Promise<void> {
    this.deps.simulation?.stop();
    this.clearHistory();
    await this.autosave?.flush();
    await this.refreshProjects();
    this.set({ screen: 'home', doc: null, readOnly: null, selection: emptySelection() });
  }

  select(selection: Selection): void {
    this.set({ selection });
  }

  /**
   * Apply the result of a domain edit. A refused edit leaves the document untouched and
   * surfaces its code; an accepted one advances the revision and is autosaved.
   */
  apply(result: EditResult, selection?: Selection, options: { record?: boolean } = {}): boolean {
    const current = this.stateValue.doc;
    if (this.stateValue.readOnly || !current) return false;
    if (result.ok && this.deps.simulation?.active) {
      // The running simulation holds an immutable snapshot. A STRUCTURAL edit would change
      // what it depends on and is refused, never applied silently: the user stops first.
      // Layout and live edits (PSU settings, toggle position) are allowed.
      if (classifyEdit(current, result.doc) === 'structural') {
        this.set({ notice: { key: 'sim.stopToEdit' } });
        return false;
      }
    }
    if (!result.ok) {
      const specific: Partial<Record<string, MessageKey>> = {
        same_endpoint: 'error.edit.same_endpoint',
        not_on_wire: 'error.edit.not_on_wire',
        name_empty: 'error.edit.name_empty',
      };
      const key = specific[result.error];
      this.set({
        notice: key ? { key } : { key: 'error.edit.generic', params: { code: result.error } },
      });
      return false;
    }
    this.commit(result.doc, selection);
    if (options.record ?? true) {
      this.past.push({ before: current, after: this.stateValue.doc! });
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
      this.syncHistory();
    }
    this.mirrorLiveChanges(current);
    return true;
  }

  /**
   * Undo the last persistent edit. It is committed like any edit: a NEW revision is stamped
   * and autosaved (revisions never go back), id counters never go back (no id is reissued),
   * and while running it obeys the same rules (structural undo refused; a live undo is
   * persisted first, then mirrored and re-solved).
   */
  undo(): boolean {
    const entry = this.past.at(-1);
    const current = this.stateValue.doc;
    if (!entry || !current) return false;
    if (
      !this.apply({ ok: true, doc: historyTarget(current, entry.before) }, undefined, {
        record: false,
      })
    ) {
      return false;
    }
    this.past.pop();
    this.future.push(entry); // redo returns to entry.after
    this.syncHistory();
    return true;
  }

  redo(): boolean {
    const entry = this.future.at(-1);
    const current = this.stateValue.doc;
    if (!entry || !current) return false;
    const target = historyTarget(current, entry.after);
    if (!this.apply({ ok: true, doc: target }, undefined, { record: false })) return false;
    this.future.pop();
    this.past.push(entry); // undo returns to entry.before again
    this.syncHistory();
    return true;
  }

  private clearHistory(): void {
    this.past = [];
    this.future = [];
    this.syncHistory();
  }

  private syncHistory(): void {
    this.set({ history: { undo: this.past.length, redo: this.future.length } });
  }

  /**
   * TRANSIENT runtime interaction: press/release a momentary push button while running. The
   * project document is not touched: no revision, no autosave, no undo entry.
   */
  press(componentId: string, pressed: boolean): boolean {
    const c = this.stateValue.doc?.components.find((x) => x.id === componentId);
    if (!c || !CATALOG[c.type].momentary) return false;
    return this.deps.simulation?.momentary(componentId, pressed) ?? false;
  }

  /**
   * Category-2 edits (architecture §2.2): the change is already persisted in the browser's
   * document at a new revision; only now is it mirrored to the running session.
   */
  private mirrorLiveChanges(before: ProjectDocument): void {
    const sim = this.deps.simulation;
    const after = this.stateValue.doc;
    if (!sim?.active || !after) return;
    for (const change of liveChanges(before, after)) {
      const control: LiveControl = {};
      for (const [key, value] of Object.entries(change.params)) {
        if ((key === 'outputEnabled' || key === 'closed') && typeof value === 'boolean') {
          control[key] = value;
        } else if (
          (key === 'setpointVoltage' || key === 'currentLimit') &&
          typeof value === 'object'
        ) {
          control[key] = value.value;
        }
      }
      sim.control(change.component, control, after.revision.localRevision);
    }
  }

  /** Run: simulate the current browser-owned project revision. */
  run(): void {
    const doc = this.stateValue.doc;
    if (!doc || !this.deps.simulation) return;
    this.set({ notice: null });
    void this.deps.simulation.run(doc);
  }

  /** Stop: discard runtime state only. */
  stop(): void {
    this.deps.simulation?.stop();
  }

  rename(name: string): boolean {
    const doc = this.stateValue.doc;
    return !!doc && this.apply(renameProject(doc, name));
  }

  private commit(doc: ProjectDocument, selection?: Selection): void {
    // Revisions only move forward, whatever revision the incoming content carries.
    const latest = Math.max(
      doc.revision.localRevision,
      this.stateValue.doc?.revision.localRevision ?? 0,
    );
    const based = { ...doc, revision: { ...doc.revision, localRevision: latest } };
    const stamped = stampRevision(based, this.deviceId, this.deps.clock);
    this.set({
      doc: stamped,
      notice: null,
      selection: selection ?? pruneSelection(this.stateValue.selection, stamped),
    });
    this.autosave?.queue(stamped);
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  retrySave(): Promise<void> {
    return this.autosave?.retry() ?? Promise.resolve();
  }

  flush(): Promise<void> {
    return this.autosave?.flush() ?? Promise.resolve();
  }

  get hasUnsavedChanges(): boolean {
    return this.autosave?.dirty ?? false;
  }
}

/** Drop selected ids that no longer exist after an edit. */
export function pruneSelection(sel: Selection, doc: ProjectDocument): Selection {
  const comps = new Set(doc.components.map((c) => c.id));
  const wires = new Set(doc.layout.wires.map((w) => w.id));
  const juncs = new Set(doc.layout.junctions.map((j) => j.id));
  return {
    components: sel.components.filter((id) => comps.has(id)),
    wires: sel.wires.filter((id) => wires.has(id)),
    junctions: sel.junctions.filter((id) => juncs.has(id)),
  };
}
