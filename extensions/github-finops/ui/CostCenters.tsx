import {useEffect, useState} from 'react';
import {Button, Label, TextInput, FormControl, Spinner, Flash} from '@primer/react';
import {paginateCenters, resourceTypeLabels} from './pagination.mjs';

type Resource = {type: string; name: string};
type Center = {
  id: string; name: string; state?: string | null;
  azureSubscription?: string | null; aiCreditPoolEnabled?: boolean | null;
  aiCreditPoolState?: {targetAmount?: number | null; currentAmount?: number | null} | null;
  resources: Resource[]; resourcesComplete?: boolean;
};
type Snapshot<T> = {data: T; cache: {
  source: 'cached' | 'live'; stale: boolean; fetchedAt: string; error: string | null; retryAt: string | null;
}};
const cap = (value: boolean | null | undefined) => value === true ? 'Enabled' : value === false ? 'Disabled' : 'Unknown';
const valueLabel = (value: string | number | null | undefined) =>
  value === undefined ? 'Not returned' : value === null ? 'Unavailable' : String(value);

function useSnapshot<T>(endpoint: string) {
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function refresh(live = false, signal?: AbortSignal) {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`./${endpoint}${live ? '?refresh=1' : ''}`, {signal, cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) {
        setRetry(data.retryAt ?? null);
        throw new Error(data.error ?? 'Could not read cost center configuration.');
      }
      if (!signal?.aborted) {setSnapshot(data); setRetry(null);}
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Could not read configuration.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(false, controller.signal);
    return () => controller.abort();
  }, [endpoint]);
  const retryAt = retry ?? snapshot?.cache.retryAt;
  return {snapshot, error, loading, now, retryAt, blocked: Boolean(retryAt && Date.parse(retryAt) > now), refresh};
}

function SnapshotStatus<T>({state}: {state: ReturnType<typeof useSnapshot<T>>}) {
  const {snapshot, loading, error, now, blocked, retryAt} = state;
  const minutes = snapshot ? Math.max(0, Math.floor((now - Date.parse(snapshot.cache.fetchedAt)) / 60000)) : 0;
  return <>
    {error && <div className="error" role="alert"><Flash variant="danger">{error}{snapshot && ' Saved values below may be stale.'}</Flash></div>}
    {snapshot && <div className="cache-status">
      <Label>{snapshot.cache.source === 'cached' ? 'Cached snapshot' : 'Live snapshot'}</Label>
      <p className="caption">Last successful read {new Date(snapshot.cache.fetchedAt).toLocaleString()} ({minutes === 0 ? 'less than a minute old' : `${minutes} minute${minutes === 1 ? '' : 's'} old`}).{snapshot.cache.stale && ' Saved data may be stale.'}</p>
      {snapshot.cache.error && <div className="error" role="alert"><Flash variant="danger">{snapshot.cache.error}</Flash></div>}
    </div>}
    {blocked && retryAt && <p className="cooldown" role="status">Refresh available after {new Date(retryAt).toLocaleString()}. No automatic retries.</p>}
    {loading && !snapshot && <div className="loading" role="status"><Spinner size="medium" /><span>Reading cost center configuration...</span></div>}
  </>;
}

function RefreshButton<T>({state}: {state: ReturnType<typeof useSnapshot<T>>}) {
  return <Button disabled={state.loading || state.blocked} onClick={() => void state.refresh(true)}>{state.loading ? 'Refreshing...' : state.blocked ? 'Rate limited' : 'Refresh'}</Button>;
}

function Details({id, back}: {id: string; back: () => void}) {
  const state = useSnapshot<Center>(`cost-centers/${encodeURIComponent(id)}`);
  const center = state.snapshot?.data;
  return <main>
    <Button variant="invisible" onClick={back}>Back to Cost Centers</Button>
    <div className="overview-heading"><div><h2>{center?.name ?? 'Cost center configuration'}</h2><p className="muted">Read-only configuration and assigned resources.</p></div><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {center && <div aria-busy={state.loading}>
      <section className="budget-card config-details"><h3>Configuration</h3><dl>
        <div><dt>Name</dt><dd>{center.name}</dd></div>
        <div><dt>ID</dt><dd>{center.id}</dd></div>
        <div><dt>State</dt><dd>{valueLabel(center.state)}</dd></div>
        <div><dt>Azure subscription</dt><dd>{center.azureSubscription === null ? 'None configured' : valueLabel(center.azureSubscription)}</dd></div>
        <div><dt>AI credit pool cap</dt><dd>{cap(center.aiCreditPoolEnabled)}</dd></div>
      </dl>
      <p className="caption">{center.aiCreditPoolEnabled === true ? 'The cost center is capped at an amount derived from member license entitlements.' : center.aiCreditPoolEnabled === false ? 'No cost-center pool cap; usage draws from the shared enterprise pool.' : 'Pool cap configuration was not returned.'}</p>
      <h3>AI credit pool state</h3>
      {center.aiCreditPoolState ? <dl><div><dt>Target amount</dt><dd>{valueLabel(center.aiCreditPoolState.targetAmount)}</dd></div><div><dt>Current amount</dt><dd>{valueLabel(center.aiCreditPoolState.currentAmount)}</dd></div></dl> : <p className="muted">Pool state was not returned by the API.</p>}
      </section>
      <section className="resource-section"><h3>Assigned resources ({center.resources.length})</h3>
        {center.resources.length ? <div className="table-scroll"><table><caption className="sr-only">All assigned cost center resources</caption><thead><tr><th scope="col">Type</th><th scope="col">Name</th></tr></thead><tbody>{center.resources.map(resource => <tr key={JSON.stringify([resource.type, resource.name])}><td>{resource.type}</td><td>{resource.name}</td></tr>)}</tbody></table></div> : <p className="muted">No assigned resources returned.</p>}
      </section>
    </div>}
  </main>;
}

export default function CostCenters() {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  return selected ? <Details key={selected} id={selected} back={() => setSelected(null)} /> :
    <CenterList query={query} setQuery={value => {setQuery(value);setPage(1);}} page={page} setPage={setPage} select={setSelected} />;
}

function CenterList({query, setQuery, page, setPage, select}: {
  query: string; setQuery: (value: string) => void; page: number; setPage: (value: number) => void; select: (id: string) => void;
}) {
  const state = useSnapshot<Center[]>('cost-centers');
  const result = paginateCenters(state.snapshot?.data ?? [], query, page);
  return <main>
    <div className="overview-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Cost Centers</h2><p className="muted">Search enterprise cost centers and inspect their configuration.</p></div><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {state.snapshot && <>
      <FormControl><FormControl.Label>Search by name, ID, or state</FormControl.Label><TextInput block value={query} onChange={event => setQuery(event.target.value)} placeholder="Search all cost centers" /></FormControl>
      <div className="table-scroll center-table" aria-busy={state.loading}><table>
        <caption className="sr-only">Cost centers. Select a name to view configuration.</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Type / scope</th><th scope="col">State</th><th scope="col">AI credit pool cap</th></tr></thead>
        <tbody>{result.items.map(center => <tr key={center.id} onClick={() => select(center.id)} className="clickable-row">
          <td><button type="button" className="row-link" onClick={event => {event.stopPropagation();select(center.id);}}>{center.name}</button></td>
          <td><div className="resource-types">{resourceTypeLabels(center.resources, center.resourcesComplete).map(type => <Label key={type}>{type}</Label>)}</div></td>
          <td><Label>{center.state ?? 'Unknown'}</Label></td><td>{cap(center.aiCreditPoolEnabled)}</td>
        </tr>)}</tbody>
      </table>{result.total === 0 && <p className="empty-results">{query ? 'No cost centers match this search.' : 'No cost centers returned by GitHub.'}</p>}</div>
      <div className="pagination" aria-label="Cost center pagination"><span role="status">Showing {result.start}-{result.end} of {result.total} results{query && ` (${state.snapshot.data.length} total)`}</span><div><Button disabled={result.page === 1} onClick={() => setPage(result.page - 1)}>Previous</Button><span>Page {result.page} of {result.pages}</span><Button disabled={result.page === result.pages} onClick={() => setPage(result.page + 1)}>Next</Button></div></div>
    </>}
  </main>;
}
