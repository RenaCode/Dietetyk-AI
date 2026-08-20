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
 */
export function useInsights(sessionToken, selectedDate, ids, onSessionExpired) {
  const [data, setData] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [failedIds, setFailedIds] = useState([]);

  // The id list is constant for the component's lifetime, but as an array it is a new
  // reference on every render - without collapsing it to a string the effect would fire
  // in an endless loop.
  const idsKey = useMemo(() => ids.join(','), [ids]);

  useEffect(() => {
    if (!sessionToken || !idsKey) return undefined;
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      try {
        const dateParam = selectedDate ? `&date=${encodeURIComponent(selectedDate)}` : '';
        const res = await fetch(`/api/dashboard/insights?ids=${idsKey}${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (cancelled) return;
        if (res.status === 401) { onSessionExpired(); return; }
        if (!res.ok) return;

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
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, idsKey, onSessionExpired]);

  return { data, isLoading, failedIds };
}
