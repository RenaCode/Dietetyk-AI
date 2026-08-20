import { useEffect, useMemo, useState } from 'react';

/**
 * Pobiera wiele insightów dashboardu JEDNYM żądaniem (/api/dashboard/insights).
 *
 * Dlaczego to istnieje: każda karta dashboardu miała własny useEffect i własny
 * fetch, więc jedno wejście na ekran to było ok. 60 round-tripów HTTP i tyle samo
 * osobnych serii zapytań do SQLite. Backend liczy te insighty i tak niezależnie -
 * jedyne, co zmieniamy, to sposób ich dostarczenia.
 *
 * Kontrakt odpowiedzi (patrz backend/routes/dashboard.js):
 *   { date, results: { "<id>": { status: 'ok'|'error'|'timeout'|'unknown', data? } } }
 *
 * Pozycje inne niż 'ok' celowo NIE trafiają do zwracanej mapy - karty czytają
 * wtedy undefined i renderują swój normalny stan "brak danych", dokładnie tak jak
 * przy nieudanym pojedynczym żądaniu. Dzięki temu jeden zepsuty insight nie
 * wywraca całego dashboardu.
 *
 * @param {string} sessionToken token sesji (Bearer)
 * @param {string} selectedDate data YYYY-MM-DD lub null/undefined dla dzisiaj
 * @param {string[]} ids identyfikatory insightów (segment po /api/dashboard/)
 * @param {Function} onSessionExpired wywoływane przy odpowiedzi 401
 */
export function useInsights(sessionToken, selectedDate, ids, onSessionExpired) {
  const [data, setData] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [failedIds, setFailedIds] = useState([]);

  // Lista identyfikatorów jest stała w czasie życia komponentu, ale jako tablica
  // jest nową referencją przy każdym renderze - bez sprowadzenia jej do stringa
  // effect odpalałby się w kółko.
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
          console.warn('[insights] Nie udało się pobrać:', failed.join(', '));
        }
      } catch (err) {
        console.error('Błąd zbiorczego pobierania insightów:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [sessionToken, selectedDate, idsKey, onSessionExpired]);

  return { data, isLoading, failedIds };
}
