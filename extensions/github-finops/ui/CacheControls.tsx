import {useEffect, useRef, useState} from 'react';
import {Button, Flash, Label} from '@primer/react';

type CacheStatus = {
  exists: boolean; contextToken: string | null; refreshing: boolean; retryAt: string | null;
  snapshots: {resource: string; count: number; oldestAt: string; newestAt: string; errors: number}[];
};
const names: Record<string,string> = {
  overview: 'Overview budgets', 'overview-spending': 'Overview spending', budgets: 'Budget lists', 'budget-detail': 'Budget details',
  'cost-centers': 'Cost-center lists', 'cost-center-detail': 'Cost-center details',
  user: 'User lookups', 'team-cost-centers': 'Team links', connection: 'Connection checks',
};
function age(date: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(date)) / 60000));
  const count = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  return minutes < 1 ? 'less than a minute old' : `${count} ${unit}${count === 1 ? '' : 's'} old`;
}

export default function CacheControls({enterprise,host,cleared}: {enterprise: string; host: string; cleared: () => void}) {
  const [data,setData] = useState<CacheStatus | null>(null);
  const [busy,setBusy] = useState<string | null>('status');
  const [error,setError] = useState<string | null>(null);
  const [message,setMessage] = useState<string | null>(null);
  const [confirmation,setConfirmation] = useState<string | null>(null);
  const [now,setNow] = useState(Date.now());
  const cancel = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);},[]);
  useEffect(() => {
    if (confirmation) cancel.current?.focus();
    else if (wasConfirming.current) clearButton.current?.focus();
    wasConfirming.current = confirmation !== null;
  },[confirmation]);
  async function status(signal?: AbortSignal) {
    const response = await fetch('./settings/cache',{cache:'no-store',signal});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Could not read cache status.');
    if (!signal?.aborted) setData(value);
  }
  useEffect(() => {
    const controller = new AbortController();
    void status(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not read cache status.');
    }).finally(() => {if (!controller.signal.aborted) setBusy(null);});
    return () => controller.abort();
  },[]);
  async function act(action: 'status' | 'refresh' | 'clear') {
    setBusy(action);setError(null);setMessage(null);
    try {
      if (action === 'clear') {
        const response = await fetch('./settings/cache/clear',{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({contextToken:confirmation})});
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Could not clear this cache.');
        cleared();return;
      }
      if (action === 'refresh') {
        const response = await fetch('./overview?refresh=1',{cache:'no-store'});
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Could not refresh the overview.');
        if (value.cache.error) setError(value.cache.error);
        else setMessage('Overview refreshed. Other saved snapshots were not refreshed.');
      }
      await status();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Cache action failed.');
      if (action !== 'status') {
        try {await status();} catch (statusError) {
          setError(previous => `${previous} ${statusError instanceof Error ? statusError.message : 'Could not reload cache status.'}`);
        }
      }
    } finally {setBusy(null);}
  }
  const blocked = Boolean(data?.retryAt && Date.parse(data.retryAt) > now);
  return <section className="budget-card settings-section" aria-labelledby="cache-title" aria-busy={busy !== null}>
    <div className="spending-heading"><h3 id="cache-title">Local cache</h3>
      <Button size="small" disabled={busy !== null || confirmation !== null} onClick={() => void act('status')}>Reload status</Button></div>
    <p className="section-intro">{enterprise} on {host}, for the current credential context. Opening this panel does not query GitHub.</p>
    {error && <Flash variant="danger">{error}</Flash>}
    {message && <p role="status">{message}</p>}
    {data && <>
      <p className="field-note">{busy === 'refresh' || data.refreshing ? <Label>Refresh in progress</Label> : 'No refresh in progress'}</p>
      {!data.exists ? <p>No local database exists yet.</p> : !data.snapshots.length ? <p>No recognized snapshots in this context.</p> :
        <div className="table-scroll center-table wide-table" tabIndex={0} role="region" aria-label="Cache snapshots"><table><caption className="sr-only">Current-context cache snapshots</caption>
          <thead><tr><th scope="col">Snapshot group</th><th scope="col">Saved</th><th scope="col">Newest successful read</th><th scope="col">Oldest read</th><th scope="col">Status</th></tr></thead>
          <tbody>{data.snapshots.map(row => <tr key={row.resource}><td>{names[row.resource] ?? row.resource}</td><td>{row.count}</td>
            <td>{new Date(row.newestAt).toLocaleString()}<p className="caption">{age(row.newestAt,now)}</p></td>
            <td>{new Date(row.oldestAt).toLocaleString()}</td><td>{row.errors ? `${row.errors} with refresh errors` : 'Saved; may be stale'}</td></tr>)}</tbody>
        </table></div>}
      {blocked && data.retryAt && <p className="cooldown" role="status">GitHub cooldown until {new Date(data.retryAt).toLocaleString()}. Clearing does not remove this cooldown.</p>}
      <div className="row cache-actions">
        <Button disabled={busy !== null || blocked || data.refreshing || confirmation !== null} onClick={() => void act('refresh')}>{busy === 'refresh' ? 'Refreshing overview...' : 'Refresh overview'}</Button>
        <Button ref={clearButton} variant="danger" disabled={busy !== null || !data.contextToken || confirmation !== null} onClick={() => setConfirmation(data.contextToken)}>Clear this cache</Button>
      </div>
      {confirmation && <div className="cache-confirmation" role="group" aria-labelledby="clear-cache-title">
        <h4 id="clear-cache-title">Clear cached data for {enterprise} on {host}?</h4>
        <p>Removes snapshots and derived links for this credential context. Other enterprises/accounts, credentials, the configured target and rate-limit cooldown are retained. The next view returns to Connect your enterprise.</p>
        <div className="row"><Button ref={cancel} disabled={busy !== null} onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => void act('clear')}>{busy === 'clear' ? 'Clearing...' : 'Confirm clear current context'}</Button></div>
      </div>}
      <details className="section-details"><summary>What this cache contains</summary>
        <p>Snapshot groups include saved billing months. Inventory covers recognized snapshots. Older unclassified rows cannot be selectively deleted; clearing invalidates them for this context without touching another account.</p>
      </details>
    </>}
  </section>;
}
