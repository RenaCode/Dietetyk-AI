// Priorytet źródeł danych o AKTYWNOŚCI (kroki, kalorie, dystans, minuty aktywności).
//
// Problem, który to rozwiązuje: do tabeli health_metrics piszą trzy niezależne
// źródła - webhook/HealthKit Apple Health, aktywne pobieranie z Google Fit i
// aktywne pobieranie z Oura. Wcześniej każdy z upsertów bronił się wyłącznie
// przed nadpisaniem danych z 'apple' (CASE WHEN activity_source = 'apple' ...),
// a Google Fit i Oura były traktowane jako równorzędne. Efekt: dla tej samej
// doby wynik zależał od KOLEJNOŚCI synchronizacji w danej godzinie - Oura
// potrafiła nadpisać świeższe kroki z Google Fit i odwrotnie, więc ta sama data
// pokazywała różne liczby przy kolejnych odświeżeniach.
//
// Hierarchia (od najwyższego): apple > google_fit > oura.
// Uzasadnienie jest takie samo jak to, które README podaje dla Apple Health:
// źródła telefonowe/zegarkowe raportują na bieżąco, a Oura domyka dobę dopiero
// następnego ranka - więc przy konflikcie dane z telefonu są bliższe prawdzie.
// Źródło nieznane (NULL, np. wiersz założony wyłącznie przez Withings) ma rangę
// 0, czyli każde realne źródło aktywności może je uzupełnić.
const ACTIVITY_SOURCE_RANK = {
  apple: 3,
  google_fit: 2,
  oura: 1
};

function getActivitySourceRank(source) {
  return ACTIVITY_SOURCE_RANK[source] || 0;
}

// Fragment SQL liczący rangę źródła JUŻ ZAPISANEGO w wierszu (kolumna activity_source).
// Trzymamy to jako string, bo SQLite nie ma mapy/CASE-in-parameter - lista musi być
// wygenerowana z tej samej stałej co strona JS, żeby nie rozjechały się przy zmianie.
const EXISTING_RANK_SQL = `CASE activity_source ${Object.entries(ACTIVITY_SOURCE_RANK)
  .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
  .join(' ')} ELSE 0 END`;

/**
 * Buduje wyrażenie SQL dla jednej kolumny metryki aktywności w klauzuli
 * ON CONFLICT ... DO UPDATE SET.
 *
 * Zasada: zachowaj istniejącą wartość tylko wtedy, gdy zapisana w wierszu jest
 * z WYŻEJ notowanego źródła ORAZ faktycznie coś zawiera (> 0). Samo wyższe
 * źródło nie wystarczy - dzień, w którym Apple Health nie zaraportowało dystansu,
 * nadal powinien dać się uzupełnić danymi z Oury.
 *
 * @param {string} column nazwa kolumny (np. 'steps')
 * @param {number} incomingRank ranga źródła, które właśnie zapisuje
 */
function preserveHigherPriority(column, incomingRank) {
  return `${column} = CASE
              WHEN (${EXISTING_RANK_SQL}) > ${incomingRank} AND COALESCE(${column}, 0) > 0 THEN ${column}
              ELSE COALESCE(excluded.${column}, ${column})
            END`;
}

/**
 * Wyrażenie SQL dla samej kolumny activity_source: etykieta źródła zmienia się na
 * nowe źródło tylko wtedy, gdy realnie coś nadpisaliśmy. Jeśli wiersz należy do
 * wyżej notowanego źródła i ma w podanych kolumnach jakiekolwiek dane, etykieta
 * zostaje - inaczej dzień "należący" do Apple Health zostałby po cichu podpisany
 * jako 'oura' tylko dlatego, że Oura dołożyła metrykę, której Apple nie ma.
 *
 * @param {number} incomingRank ranga źródła, które właśnie zapisuje
 * @param {string[]} columns kolumny decydujące o tym, czy stare źródło "ma dane"
 */
function preserveSourceLabel(incomingRank, columns) {
  const hasData = columns.map(c => `COALESCE(${c}, 0) > 0`).join(' OR ');
  return `activity_source = CASE
              WHEN (${EXISTING_RANK_SQL}) > ${incomingRank} AND (${hasData}) THEN activity_source
              ELSE COALESCE(excluded.activity_source, activity_source)
            END`;
}

module.exports = {
  ACTIVITY_SOURCE_RANK,
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
};
