import {useEffect, useState} from 'react';
import {Button, Label, Spinner, Flash} from '@primer/react';
import type {RelationshipsData} from './Relationships';

type Snapshot<T> = {data: T; relationships?: RelationshipsData; cache: {
  source: 'cached' | 'live'; stale: boolean; fetchedAt: string; error: string | null; retryAt: string | null;
}};

export function useSnapshot<T>(endpoint: string) {
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
        throw new Error(data.error ?? 'Could not read billing configuration.');
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

export function SnapshotStatus<T>({state}: {state: ReturnType<typeof useSnapshot<T>>}) {
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
    {loading && !snapshot && <div className="loading" role="status"><Spinner size="medium" /><span>Reading billing configuration...</span></div>}
  </>;
}

export function RefreshButton<T>({state}: {state: ReturnType<typeof useSnapshot<T>>}) {
  return <Button disabled={state.loading || state.blocked} onClick={() => void state.refresh(true)}>{state.loading ? 'Refreshing...' : state.blocked ? 'Rate limited' : 'Refresh'}</Button>;
}
