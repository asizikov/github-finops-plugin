import {useEffect, useState} from 'react';
import {Button, Flash, Label, TextInput} from '@primer/react';
import {labels, states, type SettingsData} from './Settings';

export type Startup = {
  target: {enterprise: string; host: string} | null;
  hasOverview: boolean;
  cli: {installed: boolean; version: string | null; error: string | null} | null;
  platform: string;
  error: string | null;
};

export default function Onboarding({startup, connected}: {startup: Startup; connected: (target: Startup['target']) => void}) {
  const [url,setUrl] = useState(startup.target ? `https://${startup.target.host}/enterprises/${startup.target.enterprise}` : '');
  const [result,setResult] = useState<SettingsData | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(startup.error);
  const [retryAt,setRetryAt] = useState<string | null>(null);
  const [installation,setInstallation] = useState(startup.cli);
  const [now,setNow] = useState(Date.now());
  useEffect(() => {const timer = setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);},[]);
  const checks = result?.connection?.data.checks;
  const usable = result?.connection?.cache.source === 'live' && !result.connection.cache.error &&
    ['authentication','budgets'].every(key => checks?.some(check => check.key === key && check.state === 'accessible'));
  async function check() {
    setBusy(true);setError(null);setResult(null);
    try {
      const response = await fetch('./connect/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enterpriseUrl:url})});
      const data = await response.json();
      if (!response.ok) {setRetryAt(data.retryAt ?? null);throw new Error(data.error ?? 'Connection check failed.');}
      setResult(data);setInstallation(data.cli);setRetryAt(data.retryAt ?? data.connection?.cache.retryAt ?? null);
      if (data.connectionError) setError(data.connectionError);
    } catch (error) {setError(error instanceof Error ? error.message : 'Connection check failed.');}
    finally {setBusy(false);}
  }
  async function load() {
    setBusy(true);setError(null);
    try {
      const response = await fetch('./connect/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enterpriseUrl:url})});
      const data = await response.json();
      if (!response.ok) {setRetryAt(data.retryAt ?? null);throw new Error(data.error ?? 'Could not load the overview.');}
      connected(data.target ?? null);
    } catch (error) {setError(error instanceof Error ? error.message : 'Could not load the overview.');}
    finally {setBusy(false);}
  }
  const install = startup.platform === 'darwin' ? 'brew install gh' : startup.platform === 'win32'
    ? 'winget install --id GitHub.cli --exact' : null;
  const cooling = Boolean(retryAt && Date.parse(retryAt) > now);
  return <main className="onboarding-page">
    <div className="overview-heading"><div><h2>Connect your enterprise</h2>
      <p className="muted">Verify access, then load your enterprise overview.</p></div></div>
    <section className="budget-card settings-section">
      <form className="onboarding-form" onSubmit={event => {event.preventDefault();void check();}}>
        <label htmlFor="enterprise-url">Enterprise URL</label>
        <TextInput id="enterprise-url" block type="url" required placeholder="https://github.com/enterprises/example-enterprise"
          value={url} onChange={event => {setUrl(event.target.value);setResult(null);setError(null);}} disabled={busy} />
        <p className="caption">Also supports https://TENANT.ghe.com/enterprises/SLUG. Keep the host and enterprise slug from your enterprise URL.</p>
        <div className="row"><Button type="submit" disabled={busy || !url.trim() || cooling}>{busy ? 'Working...' : 'Check connection'}</Button>
          <Button type="button" variant="primary" disabled={busy || !usable || cooling} onClick={() => void load()}>Load overview</Button></div>
      </form>
      {error && <div className="error" role="alert"><Flash variant="danger">{error}</Flash></div>}
      {cooling && retryAt && <p className="cooldown" role="status">GitHub checks are paused until {new Date(retryAt).toLocaleString()}. No automatic retries.</p>}
      <div className="table-scroll center-table"><table><caption className="sr-only">Connection checklist</caption>
        <thead><tr><th scope="col">Prerequisite</th><th scope="col">Status</th></tr></thead><tbody>
          <tr><td>GitHub CLI</td><td>{installation?.installed ? installation.version : installation?.error ?? 'Not checked'}</td></tr>
          {(checks ?? ['authentication','enterprise','budgets','cost_centers','ai_usage','enterprise_teams'].map(key => ({key,state:'not_checked',message:'Run Check connection.'}))).map(item =>
            <tr key={item.key}><td>{labels[item.key] ?? item.key}{item.key === 'enterprise_teams' && ' (optional)'}</td>
              <td><Label>{states[item.state] ?? 'Unknown'}</Label><p className="caption">{item.message}</p></td></tr>)}
        </tbody></table></div>
      {result && !usable && <p className="caption">Authentication and billing budget access must succeed in this check. Saved checks or scope names alone do not verify access.</p>}
      {usable && <p className="caption">Ready to load the overview. Other unavailable capabilities remain visible as limitations; enterprise-team access is optional.</p>}
    </section>
    <section className="budget-card settings-section"><h3>Need help connecting?</h3>
      <p>Ask Copilot to run <code>github-finops-plugin:finops-init</code> for guided setup. No installation, login, or scope change runs automatically.</p>
      {installation?.installed === false && <p className="caption">Install GitHub CLI using the <a href="https://cli.github.com/" target="_blank" rel="noreferrer">official platform instructions</a>{install && <>; on this platform, <code>{install}</code> is an option</>}. Ask before installing software.</p>}
      <details className="section-details"><summary>Authentication and local data</summary>
        <p>Use gh authentication for the displayed host and an account with enterprise billing read access. Environment tokens override stored credentials and cannot be elevated in place. SSO, enterprise roles, policies, and API availability can also restrict access.</p>
        <p>Billing and user snapshots are stored locally in SQLite. Credentials stay in the backend, never in this page. No enterprise settings are changed.</p>
      </details>
    </section>
  </main>;
}
