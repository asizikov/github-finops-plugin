import {useEffect, useState} from 'react';
import {Button, Flash, Label, Spinner} from '@primer/react';

type Check = {key: string; state: string; status: number | null; message: string; lastAccessibleAt?: string | null};
type Connection = {
  data: {login: string | null; name: string | null; loginAt: string | null; nameAt: string | null; scopes: string[] | null; readEnterpriseScope: string; checkedAt: string; checks: Check[]};
  cache: {source: string; error: string | null; retryAt: string | null};
};
export type SettingsData = {
  version: {version: string; revision: string | null; dirty: boolean | null};
  database: string; authSource: string; target: {enterprise: string; host: string};
  connection: Connection | null; connectionError?: string | null; retryAt?: string | null;
};
export const labels: Record<string,string> = {
  authentication: 'GitHub authentication', enterprise: 'Enterprise identity', budgets: 'Billing budgets',
  cost_centers: 'Cost centers', ai_usage: 'Current-month AI usage', enterprise_teams: 'Enterprise teams',
};
export const states: Record<string,string> = {
  accessible: 'Accessible', unauthenticated: 'Authentication rejected', forbidden: 'Forbidden', missing_scope: 'Missing scope',
  unavailable: 'Unavailable / unsupported', rate_limited: 'Rate limited', unknown: 'Unknown', not_checked: 'Not checked',
};

export default function Settings() {
  const [data,setData] = useState<SettingsData | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string | null>(null);
  const [opening,setOpening] = useState(false);
  const [openMessage,setOpenMessage] = useState<string | null>(null);
  const [openError,setOpenError] = useState<string | null>(null);
  const [now,setNow] = useState(Date.now());
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);},[]);
  async function load(refresh = false, signal?: AbortSignal) {
    setLoading(true);setError(null);
    try {
      const response = await fetch(`./settings${refresh ? '?refresh=1' : ''}`,{cache:'no-store',signal});
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Could not load Settings.');
      if (!signal?.aborted) setData(value);
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Could not load Settings.');
    } finally {if (!signal?.aborted) setLoading(false);}
  }
  useEffect(() => {const controller = new AbortController();void load(false,controller.signal);return () => controller.abort();},[]);
  async function openDatabase() {
    setOpening(true);setOpenError(null);setOpenMessage(null);
    try {
      const response = await fetch('./settings/reveal',{method:'POST'});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not open the cache folder.');
      setOpenMessage('Opened the database location in the system file manager.');
    } catch (error) {setOpenError(error instanceof Error ? error.message : 'Could not open the cache folder.');}
    finally {setOpening(false);}
  }
  const connection = data?.connection;
  const checked = connection?.data;
  const retryAt = connection?.cache.retryAt ?? data?.retryAt;
  const blocked = Boolean(retryAt && Date.parse(retryAt) > now);
  return <main>
    <div className="overview-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Settings</h2><p className="muted">Local installation and read-only GitHub connection checks.</p></div></div>
    {error && <Flash variant="danger">{error}</Flash>}
    {loading && !data && <div className="loading" role="status"><Spinner size="medium" />Loading local settings...</div>}
    {data && <>
      <section className="budget-card settings-section" aria-labelledby="installation-title">
        <h3 id="installation-title">Installation</h3>
        <dl><div><dt>Version</dt><dd>{data.version.version}</dd></div>
          <div><dt>Development revision</dt><dd>{data.version.revision ? <>{data.version.revision}{data.version.dirty === true ? ' (uncommitted changes)' : data.version.dirty === false ? ' (clean)' : ' (working tree status unknown)'}</> : 'Unavailable in this distribution'}</dd></div>
          <div><dt>Local SQLite database</dt><dd className="database-location"><code>{data.database}</code><Button size="small" disabled={opening} onClick={() => void openDatabase()}>{opening ? 'Opening...' : 'Open'}</Button></dd></div>
        </dl>
        {openError && <div className="error" role="alert"><Flash variant="danger">{openError}</Flash></div>}
        {openMessage && <p className="caption" role="status">{openMessage}</p>}
      </section>
      <section className="budget-card settings-section" aria-labelledby="connection-title">
        <div className="spending-heading"><h3 id="connection-title">Enterprise connection</h3>
          <Button disabled={loading || blocked} onClick={() => void load(true)}>{loading ? 'Checking...' : blocked ? 'Rate limited' : checked ? 'Refresh checks' : 'Check connection'}</Button></div>
        <dl><div><dt>Configured enterprise</dt><dd>{data.target.enterprise}</dd></div>
          <div><dt>GitHub host</dt><dd>{data.target.host}</dd></div>
          <div><dt>Enterprise display name</dt><dd>{checked?.name ?? 'Not verified'}{checked?.nameAt && checked.nameAt !== checked.checkedAt && <p className="caption">Last verified {new Date(checked.nameAt).toLocaleString()}; latest check failed.</p>}</dd></div>
          <div><dt>Authenticated account</dt><dd>{checked?.login ? `@${checked.login}` : 'Not verified'}{checked?.loginAt && checked.loginAt !== checked.checkedAt && <p className="caption">Last verified {new Date(checked.loginAt).toLocaleString()}; latest check failed.</p>}</dd></div>
          <div><dt>Credential source</dt><dd>{data.authSource}</dd></div>
          <div><dt>Reported OAuth scopes</dt><dd>{checked?.scopes == null ? 'Unknown / not reported' : checked.scopes.length ? checked.scopes.join(', ') : 'None reported'}</dd></div>
          <div><dt>Enterprise read scope</dt><dd>{checked?.readEnterpriseScope === 'present' ? 'Present (does not prove endpoint access)' : checked?.readEnterpriseScope === 'missing' ? 'Missing read:enterprise or a covering scope' : 'Not checked / unknown'}</dd></div>
        </dl>
        {!checked && <p className="caption">{loading ? 'Checking the configured target and read endpoints...' : 'Not checked. Opening Settings does not query GitHub. Check connection tests the configured target and read endpoints.'}</p>}
        {checked && <p className="caption">{connection?.cache.source === 'cached' ? 'Saved checks' : 'Checks completed'} {new Date(checked.checkedAt).toLocaleString()}. These results may be stale; each capability is independent.</p>}
        {(data.connectionError || connection?.cache.error) && <div className="error" role="alert"><Flash variant="danger">{data.connectionError ?? connection?.cache.error}</Flash></div>}
        {blocked && retryAt && <p className="cooldown" role="status">Checks available after {new Date(retryAt).toLocaleString()}. No automatic retries.</p>}
        {checked && <div className="table-scroll center-table"><table><caption className="sr-only">Last verified endpoint access</caption>
          <thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead>
          <tbody>{checked.checks.map(check => <tr key={check.key}><td>{labels[check.key] ?? check.key}</td><td><Label>{states[check.state] ?? 'Unknown'}</Label></td><td>{check.status && `HTTP ${check.status}. `}{check.message}{check.state !== 'accessible' && check.lastAccessibleAt && <p className="caption">Last accessible {new Date(check.lastAccessibleAt).toLocaleString()}; not confirmed now.</p>}</td></tr>)}</tbody>
        </table></div>}
        <p className="caption">Billing access depends on enterprise roles, policies and endpoint support, not scope text alone. A successful empty usage report verifies access, not zero spend. Enterprise team checks use the authenticated account, not a bulk member roster, and require the new teams experience.</p>
        <p className="caption">For enterprise teams, use a classic token with read:enterprise and enterprise owner or enterprise_teams:read permission; fine-grained PATs and GitHub App tokens are unsupported. An environment token cannot be elevated in place: replace it at its source or deliberately switch to authorized stored gh credentials. Stored gh credentials can be refreshed separately by the user. This page never changes authentication.</p>
      </section>
    </>}
  </main>;
}
