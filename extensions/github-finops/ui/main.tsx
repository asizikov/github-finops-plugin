import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BaseStyles, ThemeProvider, Button, Label, Spinner, Flash} from '@primer/react';
import {CopilotIcon, GraphIcon, OrganizationIcon, CreditCardIcon, PeopleIcon, GearIcon} from '@primer/octicons-react';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import './style.css';
import CostCenters from './CostCenters';
import Budgets from './Budgets';
import Users, {type UserLookup} from './Users';
import Settings from './Settings';
import Onboarding, {type Startup} from './Onboarding';
import AttentionQueue from './AttentionQueue';
import UpdateReminder, {usePluginUpdates} from './UpdateReminder';
import type {ListState} from './pagination.mjs';

type Budget = {
  scope: 'enterprise' | 'multi_user_customer';
  configured: boolean;
  amount?: number | null;
  consumed?: number | null;
  preventFurtherUsage?: boolean | null;
  alerts?: boolean | null;
  excludeCostCenters?: boolean | null;
};
type Spending = {period: {year: number; month: number}} & (
  {status: 'available'; gross: number; discount: number; net: number} |
  {status: 'unavailable' | 'error'; message: string}
);
type CacheStatus = {
  source: 'cached' | 'live'; stale: boolean;
  budgetsAt: string; spendingAt: string | null; error: string | null; retryAt: string | null;
};
type Overview = {budgets: Budget[]; spending: Spending; updatedAt: string; cache: CacheStatus};
const usd = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
}).format(value);
const booleanLabel = (value: boolean | null | undefined, yes: string, no: string) =>
  value === true ? yes : value === false ? no : 'Unknown';

function SpendingOverview({spending}: {spending: Spending}) {
  const month = new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'})
    .format(new Date(Date.UTC(spending.period.year, spending.period.month - 1)));
  return <section className="spending-section" aria-labelledby="spending-title">
    <div className="spending-heading"><h3 id="spending-title">Current enterprise AI spending</h3><Label>{month} / Month to date</Label></div>
    <p className="muted">Enterprise-wide AI Credits usage, including cost centers and unallocated usage.</p>
    {spending.status === 'available' ? <div className="spending-metrics">
      <div><span className="muted">Gross usage value</span><strong>{usd(spending.gross)} <small>USD</small></strong><p className="caption">Before included usage and discounts.</p></div>
      <div><span className="muted">Included usage / discounts</span><strong>{usd(spending.discount)} <small>USD</small></strong><p className="caption">Coverage reported by the API; not all necessarily from the included credit pool.</p></div>
      <div><span className="muted">Net billed AI spending</span><strong>{usd(spending.net)} <small>USD</small></strong><p className="caption">Reported net amount, not a finalized monthly invoice.</p></div>
    </div> : <div className="spending-unavailable" role={spending.status === 'error' ? 'alert' : 'status'}>
      <Flash variant={spending.status === 'error' ? 'danger' : 'default'}>{spending.message}</Flash>
    </div>}
    <p className="caption">AI-credit usage report totals are separate from budget-tracked consumption below.</p>
  </section>;
}

function BudgetCard({budget}: {budget: Budget}) {
  const perUser = budget.scope === 'multi_user_customer';
  const overBudget = budget.amount != null && budget.consumed != null && budget.consumed > budget.amount;
  const excess = budget.amount != null && budget.consumed != null ? budget.consumed - budget.amount : null;
  const percent = budget.amount != null && budget.amount > 0 && budget.consumed != null
    ? budget.consumed / budget.amount * 100 : null;
  return <section className="budget-card" aria-labelledby={`title-${budget.scope}`}>
    <div className="card-top">
      <h3 id={`title-${budget.scope}`}>{perUser ? 'Default per-user budget' : 'Enterprise spending budget'}</h3>
      <Label>{budget.configured ? booleanLabel(budget.preventFurtherUsage, 'Hard stop',
        budget.alerts === true ? 'Alert only' : 'No hard stop') : 'Not configured'}</Label>
    </div>
    <p className="muted">{perUser ? 'The default AI Credits budget for each enterprise member.' : 'The enterprise-wide spending budget for AI Credits.'}</p>
    {!budget.configured ? <div className="unconfigured"><strong>No budget configured</strong><p className="muted">GitHub returned no matching AI Credits budget for this scope. This does not imply a zero budget.</p></div> : <>
      <div className="amount">{budget.amount == null ? 'Unavailable' : usd(budget.amount)} <span>USD{perUser ? ' / user' : ''}</span></div>
      <div className="consumption">
        <div className="row"><span className="muted">{perUser ? 'Per-user consumption' : 'Budget-tracked consumption'}</span><strong>{budget.consumed == null ? 'Unavailable' : `${usd(budget.consumed)} USD`}</strong></div>
        {!perUser && percent !== null && <div className={`meter ${overBudget ? 'over' : ''}`} role="progressbar" aria-label="Enterprise budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)} aria-valuetext={`${percent.toFixed(1)}% of budget used`}><div style={{width: `${Math.min(percent, 100)}%`}} /></div>}
        {budget.consumed == null ? <p className="caption">{perUser ? 'The default budget does not report individual consumption. No member usage is aggregated here.' : 'Consumption was not returned by GitHub.'}</p> : !perUser && <p className={`caption ${overBudget ? 'warning' : ''}`}>{overBudget && excess !== null ? `${usd(excess)} over budget` : percent === null ? 'Percentage unavailable for a zero or unknown budget.' : `${percent.toFixed(1)}% of budget used`}</p>}
      </div>
      <dl>
        <div><dt>Enforcement</dt><dd>{booleanLabel(budget.preventFurtherUsage, 'Stop further usage at the limit', 'Usage can continue beyond the limit')}</dd></div>
        <div><dt>Budget alerts</dt><dd>{booleanLabel(budget.alerts, 'Enabled', 'Disabled')}</dd></div>
        {!perUser && <div><dt>Cost center usage</dt><dd>{booleanLabel(budget.excludeCostCenters, 'Excluded', 'Included')}</dd></div>}
      </dl>
    </>}
  </section>;
}

function OverviewPage({openBudget}: {openBudget: (id: string) => void}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedRetryAt, setFailedRetryAt] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function refresh(live = false) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(live ? './overview?refresh=1' : './overview', {cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) {
        setFailedRetryAt(data.retryAt ?? null);
        throw new Error(data.error ?? 'Overview refresh failed.');
      }
      setFailedRetryAt(null);
      setOverview(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Overview refresh failed.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {void refresh();}, []);
  const retryAt = failedRetryAt ?? overview?.cache.retryAt;
  const blocked = retryAt != null && Date.parse(retryAt) > clock;
  const age = (date: string) => {
    const minutes = Math.max(0, Math.floor((clock - Date.parse(date)) / 60000));
    const count = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
    const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
    return minutes < 1 ? 'less than a minute old' : `${count} ${unit}${count === 1 ? '' : 's'} old`;
  };
  return <main>
      <div className="overview-heading"><div><h2>AI spending and budgets</h2><p className="muted">Track current spending and understand how limits are enforced.</p></div><Button onClick={() => void refresh(true)} disabled={loading || blocked}>{loading ? 'Refreshing...' : blocked ? 'Rate limited' : 'Refresh'}</Button></div>
      {error && <div className="error" role="alert"><Flash variant="danger">{error}{overview && ' Previously loaded values below may be stale.'}</Flash></div>}
      {overview && <div className="cache-status">
        <div><Label>{overview.cache.source === 'cached' ? 'Cached snapshot' : overview.cache.stale ? 'Partially refreshed' : 'Live snapshot'}</Label><span className="muted">Budgets: {age(overview.cache.budgetsAt)}{overview.cache.spendingAt ? ` / Spending: ${age(overview.cache.spendingAt)}` : ' / Spending not cached'}</span></div>
        {overview.cache.source === 'cached' && <p className="caption">Showing saved local data. Values may be stale; Refresh checks for current data.</p>}
        {overview.cache.error && <div className="error" role="alert"><Flash variant="danger">{overview.cache.error}</Flash></div>}
      </div>}
      {blocked && retryAt && <p className="cooldown" role="status">Refresh available after {new Date(retryAt).toLocaleString()}. No automatic retries.</p>}
      <p className="section-intro">Amounts are in USD, not credit quantities. Enterprise and per-user budgets are separate controls.</p>
      {loading && !overview && <div className="loading" role="status"><Spinner size="medium" /><span>Reading enterprise spending and budgets...</span></div>}
      {overview && <div aria-busy={loading}><SpendingOverview spending={overview.spending} /><div className="cards">{overview.budgets.map(budget => <BudgetCard key={budget.scope} budget={budget} />)}</div><footer><span>Budgets last read {new Date(overview.cache.budgetsAt).toLocaleString()}{overview.cache.spendingAt && <> / Spending last read {new Date(overview.cache.spendingAt).toLocaleString()}</>}</span><span>Source: GitHub billing API / local SQLite</span></footer></div>}
      <AttentionQueue openBudget={openBudget} />
      <p className="scope-note">Summary cards show enterprise scope only. The attention queue uses cached budgets across scopes and products.</p>
    </main>;
}

type Page = 'Overview' | 'Cost Centers' | 'Budgets' | 'Users' | 'Settings';
type Route = {page: Page; id?: string};

function App() {
  const updates = usePluginUpdates();
  const [startup,setStartup] = useState<Startup | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('./startup',{signal:controller.signal,cache:'no-store'}).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not read startup information.');
      if (!controller.signal.aborted) setStartup(data);
    }).catch(error => {
      if (!controller.signal.aborted) setStartup({target:null,hasOverview:false,cli:null,platform:'unknown',error:error instanceof Error ? error.message : 'Could not read startup information.'});
    });
    return () => controller.abort();
  },[]);
  const [history, setHistory] = useState<Route[]>([{page:'Overview'}]);
  const [centerList, setCenterList] = useState<ListState>({query:'',page:1});
  const [budgetList, setBudgetList] = useState<ListState>({query:'',page:1});
  const [userLookup,setUserLookup] = useState<UserLookup>({query:'',login:null});
  const route = history[history.length - 1];
  const page = route.page;
  const open = (route: Route) => setHistory(history => [...history,route]);
  const back = () => setHistory(history => history.length > 1 ? history.slice(0,-1) : [{page}]);
  const backLabel = `Back to ${history[history.length - 2]?.page ?? page}`;
  const [dark, setDark] = useState(document.documentElement.dataset.colorMode === 'dark');
  useEffect(() => {
    const sync = () => setDark(document.documentElement.dataset.colorMode === 'dark' || document.body.dataset.colorMode === 'dark');
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-color-mode']});
    observer.observe(document.body, {attributes: true, attributeFilter: ['data-color-mode']});
    return () => observer.disconnect();
  }, []);
  return <ThemeProvider colorMode={dark ? 'night' : 'day'}><BaseStyles className="canvas-shell">
    <header className="header"><div className="brand"><span className="brand-mark" aria-hidden="true"><CopilotIcon size={28} /></span><div><h1>GitHub FinOps</h1><span className="muted">Enterprise spending and configuration</span></div></div></header>
    <div className={`app-layout${startup?.hasOverview ? '' : ' onboarding-layout'}`}>{startup?.hasOverview && <aside className="sidebar"><nav aria-label="Main navigation">{([
      {name: 'Overview', icon: GraphIcon}, {name: 'Cost Centers', icon: OrganizationIcon},
      {name: 'Budgets', icon: CreditCardIcon}, {name: 'Users', icon: PeopleIcon},
      {name: 'Settings', icon: GearIcon},
    ] satisfies {name: Page; icon: typeof GraphIcon}[]).map(item => <Button key={item.name} block variant="invisible" alignContent="start" leadingVisual={item.icon} aria-current={page === item.name ? 'page' : undefined} onClick={() => setHistory([{page:item.name}])}>{item.name}</Button>)}</nav></aside>}
      <div className="page-scroll" tabIndex={0} role="region" aria-label={startup?.hasOverview ? `${page} page content` : 'Connect your enterprise'} key={`${startup?.hasOverview}-${page}-${route.id ?? ''}`}>
      {!startup ? <main><h2>GitHub FinOps</h2><p role="status">Reading local startup information...</p></main> : !startup.hasOverview ?
        <Onboarding startup={startup} connected={() => setStartup({...startup,hasOverview:true})} /> :
      page === 'Overview' ? <OverviewPage openBudget={id => open({page:'Budgets',id})} /> : page === 'Settings' ? <Settings updates={updates.status} updateError={updates.error} cleared={() => {
        setUserLookup({query:'',login:null});setCenterList({query:'',page:1});setBudgetList({query:'',page:1});
        setHistory([{page:'Overview'}]);setStartup({...startup,hasOverview:false,error:null});
      }} /> : page === 'Cost Centers' ?
        <CostCenters selected={route.id} list={centerList} setList={setCenterList} select={id => open({page:'Cost Centers',id})} back={back} backLabel={backLabel} openBudget={id => open({page:'Budgets',...(id ? {id} : {})})} /> :
        page === 'Budgets' ? <Budgets selected={route.id} list={budgetList} setList={setBudgetList} select={id => open({page:'Budgets',id})} back={back} backLabel={backLabel} canGoBack={history.length > 1} openCenter={id => open({page:'Cost Centers',id})} /> :
        <Users lookup={userLookup} setLookup={setUserLookup} openCenter={id => open({page:'Cost Centers',id})} openBudget={id => open({page:'Budgets',id})} />}
      </div>
    </div>
    <UpdateReminder status={updates.error ? null : updates.status} changed={updates.setStatus} />
  </BaseStyles></ThemeProvider>;
}

createRoot(document.getElementById('root')!).render(<App />);
