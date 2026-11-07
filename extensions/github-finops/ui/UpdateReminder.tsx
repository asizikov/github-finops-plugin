import {useEffect, useState} from 'react';
import {Button, Link} from '@primer/react';
import {pollUpdates} from './update-polling.mjs';

export type UpdateStatus = {
  installed: string; latest: string | null; checkedAt: number | null;
  attemptedAt: number | null; available: boolean; error: string | null; updateUrl: string;
};

export function usePluginUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const stop = pollUpdates(async () => {
      const response = await fetch('./updates', {signal: controller.signal, cache: 'no-store'});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not read plugin update status.');
      if (!controller.signal.aborted) {setStatus(result);setError(null);}
    }, cause => {
      console.error('Plugin update status:', cause);
      setError('Could not read plugin update status. Reload the canvas to retry.');
    });
    return () => {stop();controller.abort();};
  }, []);
  return {status, setStatus, error};
}

export default function UpdateReminder({status, changed}: {
  status: UpdateStatus | null; changed: (status: UpdateStatus) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function dismiss() {
    if (!status?.latest) return;
    setSaving(true);setError(null);
    try {
      const response = await fetch('./updates/dismiss', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: status.latest}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not save update dismissal.');
      changed(result);
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Could not save update dismissal.');}
    finally {setSaving(false);}
  }
  return <div role="status" aria-live="polite" aria-atomic="true">
    {status?.available && <section className="update-reminder" aria-labelledby="update-reminder-title">
      <h3 id="update-reminder-title">Update available</h3>
      <p>GitHub FinOps {status.latest} is available. You have {status.installed}.</p>
      <div className="update-actions">
        <Link href={status.updateUrl} target="_blank" rel="noreferrer">How to update<span className="sr-only"> (opens in a new tab)</span></Link>
        <Button size="small" disabled={saving} onClick={() => void dismiss()}>{saving ? 'Dismissing...' : 'Dismiss'}</Button>
      </div>
      {error && <p className="caption" role="alert">{error}</p>}
    </section>}
  </div>;
}
