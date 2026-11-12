import { USAGE_METRICS, capText } from '@tbi-lab/admin-client';
import { Loading, Num, Problem } from '../common.js';
import { useConsole, useT } from '../context.js';
import { auditRows, dayTotals, israelDay, simMinutes, unread } from '../views.js';
import { AuditList } from './Activity.js';

/** Everything the 21:00 summary says, at any time (admin app design §2-3). */
export function Today() {
  const t = useT();
  const { data, date, seen, go } = useConsole();
  const { accounts, capacity, usage, reports, audit } = data;
  const today = israelDay(Date.now());
  const day = usage?.ok ? dayTotals(usage.value, today) : null;

  return (
    <section aria-labelledby="today-h" class="stack">
      <h1 id="today-h">{t('console.today.heading')}</h1>
      <div class="tiles">
        <div class="tile" data-testid="today-capacity">
          <span class="tile-label">{t('console.today.capacity')}</span>
          {!capacity ? (
            <Loading />
          ) : capacity.ok ? (
            <span class="tile-value">
              <bdi dir="ltr">
                {capacity.value.live} / {capacity.value.max}
              </bdi>
            </span>
          ) : (
            <Problem
              error={capacity.error}
              unavailable="console.capacity.unavailable"
              testid="capacity-problem"
            />
          )}
        </div>
        <div class="tile" data-testid="today-testers">
          <span class="tile-label">{t('console.today.testers')}</span>
          {!accounts ? (
            <Loading />
          ) : accounts.ok ? (
            <span class="tile-value">
              <bdi dir="ltr">
                {capText(accounts.value).n} / {capText(accounts.value).cap}
              </bdi>
            </span>
          ) : (
            <Problem
              error={accounts.error}
              unavailable="console.capacity.unavailable"
              testid="testers-problem"
            />
          )}
        </div>
        <div class="tile" data-testid="today-active">
          <span class="tile-label">{t('console.today.active')}</span>
          {day ? (
            <span class="tile-value">
              <Num n={day.activeTesters} />
            </span>
          ) : usage && !usage.ok ? (
            <span class="tile-value">—</span>
          ) : (
            <Loading />
          )}
        </div>
        <div class="tile" data-testid="today-feedback">
          <span class="tile-label">{t('console.today.feedback')}</span>
          {!reports ? (
            <Loading />
          ) : reports.ok ? (
            <a
              class="tile-value tile-link"
              href="#/feedback"
              onClick={(e) => {
                e.preventDefault();
                go({ name: 'feedback' });
              }}
            >
              {t('console.today.unread', {
                unread: unread(reports.value, seen).length,
                total: reports.value.length,
              })}
            </a>
          ) : (
            <Problem error={reports.error} unavailable="console.reports.unavailable" />
          )}
        </div>
      </div>

      <section aria-labelledby="today-usage-h" class="card">
        <h2 id="today-usage-h">{t('console.today.usageHeading')}</h2>
        {!usage ? (
          <Loading />
        ) : !usage.ok ? (
          <Problem
            error={usage.error}
            unavailable="console.usage.unavailable"
            testid="usage-problem"
          />
        ) : (
          <>
            <dl class="metrics" data-testid="today-metrics">
              {USAGE_METRICS.map((m) => (
                <div key={m} data-testid={`today-metric-${m}`}>
                  <dt>{t(`console.metric.${m}`)}</dt>
                  <dd>
                    <Num n={m === 'simSeconds' ? simMinutes(day!.totals[m]) : day!.totals[m]} />
                  </dd>
                </div>
              ))}
            </dl>
            {day!.unmatched && <p class="muted">{t('console.today.unmatched')}</p>}
            <p class="muted small">
              {t('console.today.updated', { time: date(usage.value.generated) ?? '—' })}{' '}
              {t('admin.accounts.timeZone')}
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="today-changes-h" class="card">
        <h2 id="today-changes-h">{t('console.today.changes')}</h2>
        {!audit ? (
          <Loading />
        ) : !audit.ok ? (
          <Problem
            error={audit.error}
            unavailable="console.audit.unavailable"
            testid="audit-problem"
          />
        ) : (
          <>
            <AuditList
              rows={auditRows(audit.value, accounts?.ok ? accounts.value : null).slice(0, 5)}
              testid="today-changes"
            />
            <a
              href="#/activity"
              class="more"
              onClick={(e) => {
                e.preventDefault();
                go({ name: 'activity' });
              }}
            >
              {t('console.today.allChanges')}
            </a>
          </>
        )}
      </section>
    </section>
  );
}
