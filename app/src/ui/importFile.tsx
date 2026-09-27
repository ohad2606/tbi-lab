import { useRef } from 'preact/hooks';
import { PACKAGE_EXTENSION, PACKAGE_MAX_BYTES, PACKAGE_MEDIA_TYPE } from '@tbi-lab/domain';
import type { AppStore } from '../state/app.js';
import { useStore, useT } from './context.js';

/** Read a chosen .tbilab file and hand it to the store's import (validated there). */
export async function importProjectFile(store: AppStore, file: File): Promise<void> {
  if (file.size > PACKAGE_MAX_BYTES) {
    store.notify({ key: 'import.error.too_large' });
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    store.notify({ key: 'import.error.read' });
    return;
  }
  await store.importPackage(text);
}

/**
 * The hidden file picker behind every "Import project…" action (Projects screen and the
 * editor menu): render `input` once, call `choose()` from the visible control.
 */
export function useImportPicker() {
  const store = useStore();
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      class="visually-hidden"
      tabIndex={-1}
      accept={`${PACKAGE_EXTENSION},application/json,${PACKAGE_MEDIA_TYPE}`}
      aria-label={t('library.import.label')}
      data-testid="import-file"
      onChange={(e) => {
        const el = e.currentTarget;
        const file = el.files?.[0];
        el.value = ''; // the same file can be chosen again after a refusal
        if (file) void importProjectFile(store, file);
      }}
    />
  );
  return { input, choose: () => ref.current?.click() };
}
