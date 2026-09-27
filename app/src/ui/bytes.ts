import { numberFormat, type LocaleInfo } from '../i18n/i18n.js';

/** A byte count for display: B below 1 KiB, KiB above (binary units, technical text). */
export function formatBytes(locale: LocaleInfo, bytes: number): string {
  if (bytes < 1024)
    return `${numberFormat(locale.code, { maximumFractionDigits: 0 }).format(bytes)} B`;
  const kib = bytes / 1024;
  return `${numberFormat(locale.code, { maximumFractionDigits: kib < 10 ? 1 : 0 }).format(kib)} KiB`;
}
