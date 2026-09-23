import { useEffect, useMemo, useState } from 'react';

/**
 * Fetches many dashboard insights in a SINGLE request (/api/dashboard/insights).
 *
 * Why this exists: every dashboard card had its own useEffect and its own fetch, so
 * opening the screen fired roughly 60 HTTP round-trips and as many separate bursts of
 * SQLite queries. The backend computes these insights independently either way - all
 * that changes here is how they are delivered.
 *
 * Response contract (see backend/routes/dashboard.js):
 *   { date, results: { "<id>": { status: 'ok'|'error'|'timeout'|'unknown', data? } } }
 *
 * Entries with a status other than 'ok' deliberately do NOT enter the returned map -
 * the cards then read undefined and render their normal "no data" state, exactly as they
 * would after a failed individual request. That way one broken insight cannot take the
 * whole dashboard down with it.
 *
 * @param {string} sessionToken token sesji (Bearer)
 * @param {string} selectedDate date as YYYY-MM-DD, or null/undefined for today
 * @param {string[]} ids insight identifiers (the segment after /api/dashboard/)
 * @param {Function} onSessionExpired called on a 401 response
 *
 * Returns `loadError: true` when the batch request itself failed (a non-2xx response or a
 * network error), as opposed to individual insights failing - the caller can then say
 * "nie udało się policzyć" rather than rendering each card's ordinary "no data" state,
 * which is indistinguishable from a successful computation that found nothing.
 */
export function useInsights(sessionToken, selectedDate, ids, onSessionExpired) {
  const [data, setData] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [failedIds, setFailedIds] = useState([]);
  const [loadError, setLoadError] = useState(false);

  // The id list is constant for the component's lifetime, but as an array it is a new
  // reference on every render - without collapsing it to a string the effect would fire
  // in an endless loop.
  const idsKey = useMemo(() => ids.join(','), [ids]);

  useEffect(() => {
    if (!sessionToken || !idsKey) return undefined;
    let cancelled = false;

    const load = async () => {
      // Drop the previous day's results BEFORE the new request starts.
      //
      // Failure mode this prevents: the cards are guarded by the pattern
      // `{isLoadingX && !insightX && <shimmer/>}`, so as long as a stale-but-truthy value
      // sat in `data`, the shimmer never appeared and the old content stayed on screen
      // under the new date. Switching from 22.09 to 23.09 left "Gotowość do treningu",
      // "Bateria energii" and "Ty dziś vs Ty w przeszłości" showing 22.09's numbers for
      // the several seconds the 47-insight batch takes - and permanently if the batch then
      // returned 500. A training decision was being made on yesterday's readiness.
      setData({});
      setFailedIds([]);
      setLoadError(false);
      setIsLoading(true);
      try {
        const dateParam = selectedDate ? `&date=${encodeURIComponent(selectedDate)}` : '';
        const res = await fetch(`/api/dashboard/insights?ids=${idsKey}${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (cancelled) return;
        if (res.status === 401) { onSessionExpired(); return; }
        // A failed batch is NOT the same as a batch that computed nothing: leaving `data`
        // untouched here is what made a 500 permanent (see setData({}) above).
        if (!res.ok) { setLoadError(true); return; }

        const payload = await res.json();
        if (cancelled) return;

        const next = {};
        const failed = [];
        Object.entries(payload.results || {}).forEach(([id, entry]) => {
          if (entry && entry.status === 'ok') {
            next[id] = entry.data;
          } else {
            failed.push(id);
          }
        });
        setData(next);
        setFailedIds(failed);
        if (failed.length > 0) {
          console.warn('[insights] Failed to fetch:', failed.join(', '));
        }
      } catch (err) {
        console.error('Batch insight fetch failed:', err);
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, idsKey, onSessionExpired]);

  return { data, isLoading, failedIds, loadError };
}
