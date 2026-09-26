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
  copyAsNewProject,
  createPackage,
  createProject,
  emptySelection,
  firstAvailableName,
  projectNameKey,
  projectNameTaken,
  classifyEdit,
  historyTarget,
  liveChanges,
  openDocument,
  packageFileName,
  parsePackage,
  renameProject,
  serializePackage,
  stampRevision,
  validateProject,
  type EditResult,
  type ImportError,
  type ProjectDocument,
  type Selection,
} from '@tbi-lab/domain';
import {
  negotiateLocale,
  getLocale,
  isolateUserText,
  translate,
  type LocaleInfo,
  type MessageKey,
} from '../i18n/i18n.js';
import { Autosave, type SaveState } from '../persistence/autosave.js';
import {
  ProjectExistsError,
  isQuotaError,
  type ProjectIndexEntry,
  type ProjectStorage,
} from '../persistence/store.js';
import { findExample, type ExampleProbe } from '../examples/catalog.js';
import type { LiveControl } from '@tbi-lab/engine';
import type { SimState, SimulationHost } from '../sim/controller.js';

interface HistoryEntry {
  before: ProjectDocument;
  after: ProjectDocument;
}

const HISTORY_LIMIT = 100;

export const APP_VERSION = '0.2.0';

export interface Preferences {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const PREF_LOCALE = 'tbi-lab.locale';
export const PREF_LAST_PROJECT = 'tbi-lab.lastProject';

/**
 * One user-facing message. `tone` separates technical failures (`error`: something did not
 * happen) from advice (`warning`) and confirmations (`info`). Text is always a message key:
 * no raw exception text ever reaches the UI.
 */
export type Notice = {
  key: MessageKey;
  params?: Record<string, string | number>;
  tone?: 'error' | 'warning' | 'info';
};

/** A project file ready to be handed to the browser as a download. */
export interface ExportedFile {
  fileName: string;
  text: string;
}

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
  /** Why saving failed, when saveState is 'error'. */
  saveError: 'quota' | 'write' | null;
  /** Probes an opened example suggests for its project (editor presentation state only). */
  suggestedProbes: { projectId: string; probes: ExampleProbe[] } | null;
  /**
   * The name just submitted to create or rename a project reads the same as another project's
   * name in this library (see projectNameKey). Shown inline next to the field; nothing was
   * written.
   */
  nameConflict:
    { scope: 'create'; name: string } | { scope: 'rename'; projectId: string; name: string } | null;
}

export interface AppDeps {
  storage: ProjectStorage | null;
  prefs: Preferences;
  languages: readonly string[];
  newId: () => string;
  clock?: { now(): Date };
  autosaveDebounceMs?: number;
  /** Mode A simulation host. Absent in contexts that never simulate (some unit tests). */
  simulation?: SimulationHost;
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
      saveError: null,
      suggestedProbes: null,
      nameConflict: null,
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
      this.set({ saveState, saveError: saveState === 'error' ? this.autosave!.lastError : null });
      if (saveState === 'saved') void this.refreshProjects().catch(() => undefined);
    });
    try {
      await this.refreshProjects();
    } catch {
      this.set({ screen: 'unavailable' });
      return;
    }
    const last = this.deps.prefs.get(PREF_LAST_PROJECT);
    if (last && this.stateValue.projects.some((p) => p.projectId === last)) {
      await this.openProject(last);
      if (this.stateValue.screen === 'editor') return;
    }
    this.set({ screen: 'home' });
  }

  async refreshProjects(): Promise<void> {
    if (!this.deps.storage) return;
    // Failures propagate to the caller, which decides what to tell the user.
    this.set({ projects: await this.deps.storage.list() });
  }

  setLocale(code: string): void {
    const locale = getLocale(code);
    this.deps.prefs.set(PREF_LOCALE, locale.code);
    this.set({ locale });
  }

  /**
   * Create a project. An empty name gets the first free default name ("Untitled project",
   * "Untitled project 2", ...). A typed name that reads the same as an existing project's name
   * is refused: nothing is created and `nameConflict` explains it inline.
   */
  async newProject(name: string): Promise<boolean> {
    let names: string[];
    try {
      names = await this.libraryNames();
    } catch {
      this.set({ notice: { key: 'storage.error.read' } });
      return false;
    }
    const typed = name.trim();
    if (typed !== '' && projectNameTaken(typed, names)) {
      this.set({ nameConflict: { scope: 'create', name: typed } });
      return false;
    }
    this.deps.simulation?.stop();
    const doc = createProject({
      projectId: `prj_${this.deps.newId()}`,
      deviceId: this.deviceId,
      name: typed || this.defaultProjectName(names),
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
      nameConflict: null,
    });
    this.autosave?.queue(doc);
    await this.autosave?.flush();
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Display names. The project id is the identity; names are compared by projectNameKey so the
  // library never gains two projects a person would read as the same. Existing duplicates (from
  // before this rule) are left exactly as they are and stay openable.

  /** Display names of the projects in this library, optionally without one project. */
  private async libraryNames(exceptId?: string): Promise<string[]> {
    const list = this.deps.storage ? await this.deps.storage.list() : this.stateValue.projects;
    return list.filter((p) => p.projectId !== exceptId).map((p) => p.name);
  }

  /** The first free default name for a new project, in the active locale. */
  defaultProjectName(
    names: readonly string[] = this.stateValue.projects.map((p) => p.name),
  ): string {
    const locale = this.stateValue.locale;
    return firstAvailableName(names, (n) =>
      n === 1
        ? translate(locale, 'home.new.defaultName')
        : translate(locale, 'home.new.defaultNameN', { n }),
    );
  }

  /** `base` if free, else the first free copy name: "base (copy)", "base (copy 2)", ... */
  private uniqueName(base: string, names: readonly string[], forceCopy = false): string {
    const locale = this.stateValue.locale;
    if (!forceCopy && !projectNameTaken(base, names)) return base;
    return firstAvailableName(names, (n) =>
      n === 1
        ? translate(locale, 'library.copyName', { name: base })
        : translate(locale, 'library.copyNameN', { name: base, n }),
    );
  }

  /** A rename to `name` would collide with ANOTHER project (renaming to itself is fine). */
  private renameCollides(current: string, name: string, others: readonly string[]): boolean {
    if (projectNameKey(name) === projectNameKey(current)) return false;
    return projectNameTaken(name, others);
  }

  /** The user edited the name field after a conflict: stop showing it. */
  clearNameConflict(): void {
    if (this.stateValue.nameConflict) this.set({ nameConflict: null });
  }

  async openProject(projectId: string): Promise<void> {
    this.deps.simulation?.stop();
    await this.autosave?.flush();
    let raw: unknown;
    try {
      raw = await this.deps.storage?.load(projectId);
    } catch {
      this.set({ notice: { key: 'storage.error.read' } });
      return;
    }
    if (raw === undefined) {
      this.set({ notice: { key: 'open.error.missing' } });
      await this.refreshProjects().catch(() => undefined);
      return;
    }
    const result = openDocument(raw);
    this.clearHistory();
    const base = {
      selection: emptySelection(),
      notice: null,
      unreadable: null,
      nameConflict: null,
    };
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

  // -------------------------------------------------------------------------------------------
  // Project library (Sprint 5). Every operation is awaited to durability before it reports
  // success, and a failure leaves every stored project exactly as it was.

  /** A stored project as a valid current-schema document, or null (with a notice). */
  private async loadValid(projectId: string): Promise<ProjectDocument | null> {
    if (this.stateValue.doc?.projectId === projectId && !this.stateValue.readOnly) {
      await this.flush();
      return this.stateValue.doc;
    }
    const raw = await this.deps.storage?.load(projectId);
    if (raw === undefined) {
      this.set({ notice: { key: 'open.error.missing' } });
      return null;
    }
    const opened = openDocument(raw);
    if (opened.status !== 'ok') {
      this.set({
        notice: { key: opened.status === 'newer' ? 'library.error.newer' : 'open.error.invalid' },
      });
      return null;
    }
    return opened.doc;
  }

  private storageFailure(e: unknown, key: MessageKey): void {
    this.set({ notice: { key: isQuotaError(e) ? 'storage.error.quota' : key } });
  }

  private newIdentity(name?: string) {
    return {
      projectId: `prj_${this.deps.newId()}`,
      deviceId: this.deviceId,
      appVersion: APP_VERSION,
      ...(name === undefined ? {} : { name }),
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    };
  }

  /** Rename a project from the library: the same project (same id), a normal new revision. */
  async renameInLibrary(projectId: string, name: string): Promise<boolean> {
    if (this.stateValue.doc?.projectId === projectId) return this.rename(name);
    try {
      const doc = await this.loadValid(projectId);
      if (!doc) return false;
      const renamed = renameProject(doc, name);
      if (!renamed.ok) {
        this.set({ notice: { key: 'error.edit.name_empty' } });
        return false;
      }
      if (renamed.doc.name === doc.name) {
        this.clearNameConflict();
        return true;
      }
      if (this.renameCollides(doc.name, renamed.doc.name, await this.libraryNames(projectId))) {
        this.set({ nameConflict: { scope: 'rename', projectId, name: renamed.doc.name } });
        return false;
      }
      await this.deps.storage!.save(stampRevision(renamed.doc, this.deviceId, this.deps.clock));
      await this.refreshProjects();
      this.clearNameConflict();
      return true;
    } catch (e) {
      this.storageFailure(e, 'library.error.rename');
      return false;
    }
  }

  /** A new, independent project with the same engineering content. Returns its id. */
  async duplicate(projectId: string): Promise<string | null> {
    try {
      const source = await this.loadValid(projectId);
      if (!source) return null;
      // Always succeeds: the first free "(copy)", "(copy 2)", ... in the active locale.
      const name = this.uniqueName(source.name, await this.libraryNames(), true);
      const copy = copyAsNewProject(source, this.newIdentity(name));
      await this.deps.storage!.add(copy);
      await this.refreshProjects();
      this.set({
        notice: {
          key: 'library.duplicated',
          params: { name: isolateUserText(name) },
          tone: 'info',
        },
      });
      return copy.projectId;
    } catch (e) {
      this.storageFailure(e, 'library.error.duplicate');
      return null;
    }
  }

  /**
   * Delete one project (the UI asks for confirmation first). A pending autosave of it is
   * discarded and any in-flight write awaited BEFORE the delete, so nothing can write the
   * project back afterwards. Deleting the open project returns to the library.
   */
  async deleteProject(projectId: string): Promise<boolean> {
    const open = this.stateValue.doc?.projectId === projectId;
    const name =
      this.stateValue.projects.find((p) => p.projectId === projectId)?.name ??
      this.stateValue.doc?.name ??
      '';
    if (open) this.deps.simulation?.stop();
    await this.autosave?.discard(projectId);
    try {
      await this.deps.storage!.delete(projectId);
    } catch (e) {
      this.storageFailure(e, 'library.error.delete');
      return false;
    }
    if (this.deps.prefs.get(PREF_LAST_PROJECT) === projectId) {
      this.deps.prefs.set(PREF_LAST_PROJECT, '');
    }
    if (open) {
      this.clearHistory();
      this.set({ screen: 'home', doc: null, readOnly: null, selection: emptySelection() });
    }
    await this.refreshProjects().catch(() => undefined);
    this.set({
      notice: { key: 'library.deleted', params: { name: isolateUserText(name) }, tone: 'info' },
    });
    return true;
  }

  /**
   * The portable package of a project. For the open project, pending edits are flushed first
   * and the in-memory document is exported, so an export right after an edit includes it (and
   * still works as a rescue copy if the browser storage is failing).
   */
  async exportProject(projectId: string): Promise<ExportedFile | null> {
    try {
      const doc = await this.loadValid(projectId);
      if (!doc) return null;
      const exportedAt = (this.deps.clock ?? { now: () => new Date() }).now().toISOString();
      const text = serializePackage(createPackage(doc, { appVersion: APP_VERSION, exportedAt }));
      return { fileName: packageFileName(doc.name), text };
    } catch {
      this.set({ notice: { key: 'export.error' } });
      return null;
    }
  }

  /** Report a failure to hand an exported file to the browser. */
  exportFailed(): void {
    this.set({ notice: { key: 'export.error' } });
  }

  /**
   * Import a package. It is parsed and fully validated before anything is written; a
   * project id that already exists locally is never overwritten: the package is imported as
   * an independent copy with a new id, and the user is told. On success the project opens.
   */
  async importPackage(text: string): Promise<boolean> {
    const parsed = parsePackage(text);
    if (!parsed.ok) {
      this.set({ notice: importNotice(parsed.error) });
      return false;
    }
    const storage = this.deps.storage!;
    let doc = parsed.doc;
    let copied = false;
    const original = doc.name;
    let renamed = false;
    try {
      if ((await storage.load(doc.projectId)) !== undefined) {
        doc = copyAsNewProject(doc, this.newIdentity());
        copied = true;
      }
      // Never add a second project with a name that reads the same: take a copy-style name.
      const names = await this.libraryNames();
      if (projectNameTaken(doc.name, names)) {
        doc = { ...doc, name: this.uniqueName(doc.name, names, true) };
        renamed = true;
      }
      try {
        await storage.add(doc);
      } catch (e) {
        // Created by someone else between the check and the write: still never overwrite.
        if (!(e instanceof ProjectExistsError) || copied) throw e;
        doc = copyAsNewProject(doc, this.newIdentity());
        copied = true;
        await storage.add(doc);
      }
    } catch (e) {
      this.storageFailure(e, 'import.error.storage');
      return false;
    }
    // Open first, then refresh the list: re-rendering the whole library just before leaving it
    // was the largest part of the import time with 50+ projects (Sprint 5 measurement).
    await this.openProject(doc.projectId);
    await this.refreshProjects().catch(() => undefined);
    this.set({
      notice: {
        key: renamed
          ? copied
            ? 'import.doneCopyRenamed'
            : 'import.doneRenamed'
          : copied
            ? 'import.doneCopy'
            : 'import.done',
        params: { name: isolateUserText(doc.name), original: isolateUserText(original) },
        tone: 'info',
      },
    });
    return true;
  }

  /** Start a new local project from a curated example. */
  async openExample(exampleId: string): Promise<boolean> {
    const example = findExample(exampleId);
    const opened = example ? openDocument(example.document) : null;
    if (!example || opened?.status !== 'ok') {
      this.set({ notice: { key: 'example.error' } });
      return false;
    }
    this.deps.simulation?.stop();
    await this.autosave?.flush();
    let doc: ProjectDocument;
    try {
      const title = translate(this.stateValue.locale, example.titleKey);
      const name = this.uniqueName(title, await this.libraryNames());
      doc = copyAsNewProject(opened.doc, this.newIdentity(name));
      await this.deps.storage!.add(doc);
    } catch (e) {
      this.storageFailure(e, 'library.error.create');
      return false;
    }
    this.deps.prefs.set(PREF_LAST_PROJECT, doc.projectId);
    this.clearHistory();
    this.set({
      screen: 'editor',
      doc,
      readOnly: null,
      unreadable: null,
      selection: emptySelection(),
      notice: null,
      suggestedProbes: { projectId: doc.projectId, probes: example.probes },
    });
    await this.refreshProjects().catch(() => undefined);
    return true;
  }

  async goHome(): Promise<void> {
    this.deps.simulation?.stop();
    this.clearHistory();
    await this.autosave?.flush();
    await this.refreshProjects().catch(() => this.set({ notice: { key: 'storage.error.read' } }));
    this.set({
      screen: 'home',
      doc: null,
      readOnly: null,
      selection: emptySelection(),
      nameConflict: null,
    });
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

  /**
   * Rename the open project. Refused, with nothing written, when the new name reads the same
   * as another project's name in the library.
   */
  rename(name: string): boolean {
    const doc = this.stateValue.doc;
    if (!doc) return false;
    const result = renameProject(doc, name);
    if (result.ok && result.doc.name !== doc.name) {
      const others = this.stateValue.projects
        .filter((p) => p.projectId !== doc.projectId)
        .map((p) => p.name);
      if (this.renameCollides(doc.name, result.doc.name, others)) {
        this.set({
          nameConflict: { scope: 'rename', projectId: doc.projectId, name: result.doc.name },
          notice: {
            key: 'library.error.nameTaken',
            params: { name: isolateUserText(result.doc.name) },
          },
        });
        return false;
      }
    }
    if (!this.apply(result)) return false;
    this.clearNameConflict();
    return true;
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

  /** Show a message from the UI layer (e.g. a file that could not be read). */
  notify(notice: Notice): void {
    this.set({ notice });
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

/** The localized notice for a refused import. */
export function importNotice(error: ImportError): Notice {
  const keys: Record<ImportError['code'], MessageKey> = {
    too_large: 'import.error.too_large',
    not_json: 'import.error.not_package',
    not_a_package: 'import.error.not_package',
    bad_package: 'import.error.damaged',
    newer_package: 'import.error.newer',
    unsupported_content: 'import.error.newer',
    hash_mismatch: 'import.error.damaged',
    newer_schema: 'import.error.newer',
    unsupported_schema: 'import.error.old',
    invalid_project: 'import.error.invalid',
  };
  return { key: keys[error.code], params: { code: error.code } };
}
