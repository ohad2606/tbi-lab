import { Loading, Problem, useWide } from '../common.js';
import { useConsole, useT } from '../context.js';
import { codeKey } from '../i18n.js';
import { auditRows, type AuditRow } from '../views.js';

/** Recent administration changes: action, the account (name or masked), result, time. */
export function Activity() {
  const t = useT();
  const { data } = useConsole();
  const { audit, accounts } = data;
  return (
    <section aria-labelledby="activity-h" class="stack">
      <h1 id="activity-h">{t('console.activity.heading')}</h1>
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
            rows={auditRows(audit.value, accounts?.ok ? accounts.value : null)}
            testid="activity-list"
          />
          <p class="muted small">{t('admin.accounts.timeZone')}</p>
        </>
      )}
    </section>
  );
}

export function AuditList({ rows, testid }: { rows: AuditRow[]; testid: string }) {
  const t = useT();
  const { date } = useConsole();
  const wide = useWide();
  if (!rows.length)
    return (
      <p class="muted" data-testid={`${testid}-empty`}>
        {t('console.activity.empty')}
      </p>
    );
  const action = (r: AuditRow) =>
    `${t(codeKey('console.audit.action.', r.action, 'console.audit.action.other').key)}${
      r.count !== undefined ? ` ${t('console.activity.count', { count: r.count })}` : ''
    }`;
  const account = (r: AuditRow) =>
    !r.known ? (
      t('console.unknownAccount')
    ) : r.label === null ? (
      '—'
    ) : (
      <bdi dir="auto">{r.label}</bdi>
    );
  // The result in words; a code this app does not know gets a generic label and the code, small.
  const result = (r: AuditRow) => {
    const { key, known } = codeKey('console.result.', r.result, 'console.result.other');
    return (
      <span
        class={`result ${r.result === 'done' || r.result === 'ok' ? 'ok' : 'warn'}`}
        data-testid="activity-result"
        data-code={r.result}
      >
        {t(key)}
        {!known && (
          <>
            {' '}
            <bdi dir="ltr" class="code small">
              {r.result}
            </bdi>
          </>
        )}
      </span>
    );
  };
  if (wide)
    return (
      <div class="table-wrap">
        <table data-testid={testid}>
          <thead>
            <tr>
              <th scope="col">{t('console.activity.when')}</th>
              <th scope="col">{t('console.activity.action')}</th>
              <th scope="col">{t('console.activity.account')}</th>
              <th scope="col">{t('console.activity.result')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.corr}-${i}`} data-testid="activity-row" data-action={r.action}>
                <td>{date(r.at)}</td>
                <td>{action(r)}</td>
                <td>{account(r)}</td>
                <td>{result(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <ul class="list" data-testid={testid}>
      {rows.map((r, i) => (
        <li key={`${r.corr}-${i}`} class="item" data-testid="activity-row" data-action={r.action}>
          <div class="item-head">
            <strong>{action(r)}</strong>
            {result(r)}
          </div>
          <div>{account(r)}</div>
          <div class="muted small">{date(r.at)}</div>
        </li>
      ))}
    </ul>
  );
}
