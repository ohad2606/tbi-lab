/**
 * The product footer (Sprint 10, approved): product, author, copyright and the support address,
 * one muted line at the inline start of the bottom status bar. The build identity (VersionStatus)
 * shares the bar at the inline end and stays visually distinct: this is product/legal/support
 * information, that is engineering/deployment information.
 * English: TBI Lab · Developed by Ohad David · © 2026 TBI. All rights reserved. · support@tbi-tech.net
 * In RTL locales the sentence runs right-to-left; the Latin tokens (product, copyright, address)
 * are isolated left-to-right so their punctuation never reverses.
 */
import { COPYRIGHT, PRODUCT_NAME, SUPPORT_EMAIL } from '../product.js';
import { useT } from './context.js';

export function ProductFooter() {
  const t = useT();
  return (
    <p class="product-footer" data-testid="product-footer">
      <bdi dir="ltr">{PRODUCT_NAME}</bdi>
      <span aria-hidden="true"> · </span>
      <span>{t('footer.developedBy')}</span>
      <span aria-hidden="true"> · </span>
      <bdi dir="ltr">{COPYRIGHT}</bdi> <span>{t('footer.rights')}</span>
      <span aria-hidden="true"> · </span>
      <a
        href={`mailto:${SUPPORT_EMAIL}`}
        class="product-footer-mail"
        data-testid="footer-support"
        aria-label={t('footer.supportLabel', { email: SUPPORT_EMAIL })}
      >
        <bdi dir="ltr">{SUPPORT_EMAIL}</bdi>
      </a>
    </p>
  );
}
