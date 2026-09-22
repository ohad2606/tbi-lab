/**
 * Application state: project lifecycle, the open document, selection, save state and
 * locale. UI-framework independent, so it is unit-testable without a DOM.
 *
 * Ownership (architecture §2, ADR-001): the Project Document in local storage is the source
 * of truth. User preferences (locale, last open project) are stored separately and are never
 * written into a project.
 */

import {
  SCHEMA_VERSION,
  createProject,
  emptySelection,
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
}

export interface AppDeps {
  storage: ProjectStorage | null;
  prefs: Preferences;
  languages: readonly string[];
  newId: () => string;
  clock?: { now(): Date };
  autosaveDebounceMs?: number;
}

export class AppStore {
  private stateValue: AppState;
  private listeners = new Set<() => void>();
  private autosave: Autosave | null = null;
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
    };
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
    const doc = createProject({
      projectId: `prj_${this.deps.newId()}`,
      deviceId: this.deviceId,
      name: name.trim() || translate(this.stateValue.locale, 'home.new.defaultName'),
      appVersion: APP_VERSION,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    this.deps.prefs.set(PREF_LAST_PROJECT, doc.projectId);
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
    await this.autosave?.flush();
    const raw = await this.deps.storage?.load(projectId);
    if (raw === undefined) {
      this.set({ notice: { key: 'open.error.missing' } });
      return;
    }
    const result = openDocument(raw);
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
  apply(result: EditResult, selection?: Selection): boolean {
    if (this.stateValue.readOnly || !this.stateValue.doc) return false;
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
    return true;
  }

  rename(name: string): boolean {
    const doc = this.stateValue.doc;
    return !!doc && this.apply(renameProject(doc, name));
  }

  private commit(doc: ProjectDocument, selection?: Selection): void {
    const stamped = stampRevision(doc, this.deviceId, this.deps.clock);
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
