import { PACKAGE_MEDIA_TYPE } from '@tbi-lab/domain';
import type { AppStore } from '../state/app.js';

/** Hand an exported project file to the browser as a download. */
export async function downloadProject(store: AppStore, projectId: string): Promise<void> {
  const file = await store.exportProject(projectId);
  if (!file) return;
  try {
    const url = URL.createObjectURL(new Blob([file.text], { type: PACKAGE_MEDIA_TYPE }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.fileName;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoke once the browser has taken the file.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    store.exportFailed();
  }
}
