/**
 * Alpha UX-P1: one Build action for the toolbar, the Run-blocked notice and the code view.
 *
 * There is no second build mechanism: every entry point calls `store.buildProgram(boardId)` (the
 * same build service API, permissions, queue and error handling), and the rules for when Build is
 * unavailable are the code view's (D-S7-9: never while an ESP32 session runs; one build per
 * program; read-only projects never build). Nothing builds automatically and Run never builds.
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import type { MessageKey } from '../i18n/messages.en.js';
import type { BuildView } from '../programs/state.js';

/** The board whose program this project authors (V1: at most one), as the Code view shows it. */
export function programBoardOf(doc: ProjectDocument | null | undefined): string | undefined {
  return doc
    ? Object.keys(doc.programs).find((id) => doc.components.some((c) => c.id === id))
    : undefined;
}

/** Why Build cannot start now, or null when it can. A build in progress is not a reason here. */
export function buildBlocker(opts: {
  available: boolean;
  readOnly: boolean;
  simulating: boolean;
  view: BuildView | null;
}): MessageKey | null {
  if (!opts.available) return 'build.unavailable';
  if (opts.readOnly) return 'toolbar.build.readOnly';
  if (opts.simulating) return 'build.blockedRunning';
  if (opts.view?.olderBuildRunning) return 'build.olderRunning';
  return null;
}

// ---- Requests to show the code view (its diagnostics) from outside the editor workspace.
const codeViewListeners = new Set<() => void>();

/** Ask the editor to show the Code view (the toolbar's "Show problems"). */
export function requestCodeView(): void {
  for (const l of codeViewListeners) l();
}

/** The editor subscribes; returns the unsubscribe function. */
export function onCodeViewRequest(listener: () => void): () => void {
  codeViewListeners.add(listener);
  return () => void codeViewListeners.delete(listener);
}

/** The toolbar Build button's element id, so other entry points can move focus to it. */
export const TOOLBAR_BUILD_ID = 'toolbar-build';
