/**
 * TBI-022: one operation per sign-up id at a time, in this process. Shared by every approver
 * instance (the admin route builds one per request) and by the retention purge, so a purge can
 * never unlink a record that an approve / reject / resend is reading or updating. In-process only:
 * the admin service is the single process that updates or deletes records (the intake only
 * creates them, guarded by O_EXCL markers).
 */
const locks = new Map<string, Promise<unknown>>();

export function serialById<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}
