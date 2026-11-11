import { useRef, useState } from 'preact/hooks';
import {
  DISPLAY_NAME_MAX,
  addTester,
  capFull,
  maskAddress,
  normalizeDisplayName,
  plausibleAddress,
} from '@tbi-lab/admin-client';
import { Loading, Num, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';

/** Add a tester: a name and the address; afterwards the address is shown masked only. */
export function Add() {
  const t = useT();
  const { data, settle } = useConsole();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<'email' | 'name' | null>(null);
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const { accounts } = data;
  if (!accounts) return <Loading />;
  if (!accounts.ok)
    return <Problem error={accounts.error} unavailable="console.accounts.unavailable" />;
  const full = capFull(accounts.value);

  const submit = async () => {
    if (sending || full) return;
    const n = name.trim() ? normalizeDisplayName(name) : '';
    if (n === null) {
      setProblem('name');
      nameField.current?.focus();
      return;
    }
    if (!plausibleAddress(email)) {
      setProblem('email');
      emailField.current?.focus();
      return;
    }
    setProblem(null);
    setSending(true);
    const typed = email.trim().toLowerCase();
    try {
      const o = await addTester(api, typed, n);
      if (o.kind === 'refused' && (o.error === 'invalid_email' || o.error === 'invalid_name')) {
        setProblem(o.error === 'invalid_name' ? 'name' : 'email');
        (o.error === 'invalid_name' ? nameField : emailField).current?.focus();
        return;
      }
      setEmail('');
      setName('');
      setLast(maskAddress(typed));
      await settle(o, n || maskAddress(typed), 'add');
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-labelledby="add-h" class="stack">
      <h1 id="add-h">{t('console.add.heading')}</h1>
      <p class="muted">
        {t('admin.capacity.testers')}:{' '}
        <bdi dir="ltr">
          <Num n={accounts.value.authorizedTesters} /> / <Num n={accounts.value.cap} />
        </bdi>{' '}
        {t('admin.capacity.ownerExcluded')}
      </p>
      <form
        class="card stack"
        noValidate
        data-testid="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {full && (
          <p role="note" class="problem" data-testid="add-cap-full">
            {t('admin.result.cap_reached')}
          </p>
        )}
        <label class="field">
          <span>{t('admin.add.nameLabel')}</span>
          <input
            ref={nameField}
            type="text"
            dir="auto"
            autoComplete="off"
            maxLength={4 * DISPLAY_NAME_MAX}
            data-testid="add-name"
            value={name}
            readOnly={sending}
            disabled={full}
            aria-invalid={problem === 'name'}
            aria-describedby="add-name-hint"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <small id="add-name-hint" class="muted">
            {t('admin.add.nameHint', { max: DISPLAY_NAME_MAX })}
          </small>
        </label>
        <label class="field">
          <span>{t('admin.add.label')}</span>
          <input
            ref={emailField}
            type="email"
            inputMode="email"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            data-testid="add-email"
            value={email}
            readOnly={sending}
            disabled={full}
            aria-invalid={problem === 'email'}
            aria-describedby="add-email-hint"
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
          <small id="add-email-hint" class="muted">
            {t('admin.add.hint')}
          </small>
        </label>
        {problem && (
          <p class="problem" role="alert" data-testid="add-problem">
            {problem === 'name'
              ? t('admin.name.invalid', { max: DISPLAY_NAME_MAX })
              : t('admin.add.invalid')}
          </p>
        )}
        <button
          type="submit"
          class="button button-primary"
          data-testid="add-submit"
          disabled={full}
          aria-disabled={sending ? 'true' : undefined}
        >
          {sending ? t('admin.add.sending') : t('admin.add.submit')}
        </button>
        {last && (
          <p class="muted small" data-testid="add-last">
            {t('admin.add.last')} <bdi dir="ltr">{last}</bdi>
          </p>
        )}
      </form>
    </section>
  );
}
