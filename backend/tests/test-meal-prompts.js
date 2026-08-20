// Testy budowania promptu analizy posiłku (utils/mealPrompts.js).
//
// Prompt jest tu jedynym miejscem, które decyduje o zachowaniu modelu, a jego
// regresja jest wyjątkowo trudna do zauważenia: aplikacja działa dalej, zwraca
// poprawny JSON, tylko liczby są policzone nie z tego, z czego trzeba. Dlatego
// sprawdzamy nie brzmienie tekstu, ale obecność instrukcji, które faktycznie
// zmieniają wynik - przede wszystkim pierwszeństwo opisu użytkownika nad zdjęciem.

const assert = require('assert');
const { buildMealPrompt } = require('../utils/mealPrompts');

const DESCRIPTION = 'to było 200 g kurczaka, ryż brązowy, smażone na maśle';

function testPhotoWithDescriptionGivesTextPrecedence() {
  console.log('\n--- TEST 1: zdjęcie + opis -> opis ma pierwszeństwo ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(prompt.includes(DESCRIPTION), 'Opis użytkownika nie trafił do promptu.');
  assert.ok(prompt.includes('<user_input>') && prompt.includes('</user_input>'),
    'Opis nie jest odgrodzony znacznikami <user_input> (ochrona przed wstrzyknięciem instrukcji).');
  assert.ok(/IDŹ ZA OPISEM/.test(prompt),
    'Brak jawnej reguły rozstrzygania sprzeczności na korzyść opisu.');
  assert.ok(/KOREKTĘ I UZUPEŁNIENIE/.test(prompt),
    'Prompt nie mówi, że opis jest korektą i uzupełnieniem zdjęcia.');
  assert.ok(/NIE traktuj opisu jako drugiego, osobnego posiłku/.test(prompt),
    'Brak zabezpieczenia przed policzeniem opisu jako drugiego posiłku.');

  console.log('  ✓ opis w <user_input>, reguła pierwszeństwa obecna');
  console.log('✅ Opis wygrywa ze zdjęciem.');
}

function testPhotoWithDescriptionAsksForANote() {
  console.log('\n--- TEST 2: model ma odnotować, że poszedł za opisem ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/dietician_comment/.test(prompt), 'Brak pola komentarza w strukturze.');
  assert.ok(/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'Prompt nie żąda adnotacji o skorzystaniu z opisu.');
  assert.ok(/Nie dodawaj takiej adnotacji, gdy\s+oba źródła są zgodne/.test(prompt),
    'Brak zastrzeżenia, żeby nie dodawać adnotacji przy zgodnych źródłach - inaczej pojawiałaby się zawsze.');

  console.log('  ✓ adnotacja wymagana przy rozbieżności, zabroniona przy zgodności');
  console.log('✅ Adnotacja o źródle danych.');
}

function testPhotoWithDescriptionCoversAddAndRemove() {
  console.log('\n--- TEST 3: opis może dodawać i odejmować pozycje ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/może DODAWAĆ rzeczy niewidoczne na zdjęciu/.test(prompt),
    'Prompt nie pozwala dopisać rzeczy spoza zdjęcia (napój, sos, oliwa).');
  assert.ok(/pomiń tę\s+pozycję, nawet jeśli wyraźnie widać ją na zdjęciu/.test(prompt),
    'Prompt nie pozwala usunąć pozycji, której użytkownik nie zjadł.');
  assert.ok(/wielkość porcji|tożsamość składnika|sposób przygotowania/.test(prompt),
    'Prompt nie wymienia, co konkretnie opis może korygować.');

  console.log('  ✓ dodawanie, pomijanie i korekta porcji/składnika/obróbki');
  console.log('✅ Pełen zakres uzupełnień.');
}

function testPhotoWithoutDescriptionHasNoConflictRules() {
  console.log('\n--- TEST 4: samo zdjęcie -> bez reguł rozstrzygania sporu ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '', language: 'pl' });

  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'Brak instrukcji samodzielnej identyfikacji przy braku opisu.');
  assert.ok(!prompt.includes('<user_input>'),
    'Pusty blok <user_input> nie powinien trafiać do promptu.');
  assert.ok(!/IDŹ ZA OPISEM/.test(prompt),
    'Reguła rozstrzygania sporu pojawiła się mimo braku opisu - to zbędny szum dla modelu.');
  assert.ok(!/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'Żądanie adnotacji o opisie pojawia się mimo braku opisu.');

  console.log('  ✓ prompt bez opisu nie zawiera reguł konfliktu');
  console.log('✅ Wariant bez opisu czysty.');
}

function testScreenshotBehaviourPreserved() {
  console.log('\n--- TEST 5: zachowanie dla zrzutów ekranu nietknięte ---');
  for (const userText of ['', DESCRIPTION]) {
    const prompt = buildMealPrompt({ hasImage: true, userText, language: 'pl' });
    assert.ok(/zrzut\s*\n?ekranu z aplikacji do liczenia kalorii/.test(prompt),
      'Zniknęła obsługa zrzutu ekranu z aplikacji do liczenia kalorii.');
    assert.ok(/NIE sumuj ich w jeden wpis/.test(prompt),
      'Zniknął zakaz sumowania wielu posiłków w jeden wpis.');
    assert.ok(/"meals"/.test(prompt), 'Zniknęła tablica "meals" ze struktury odpowiedzi.');
  }

  // Przy zdjęciu z wieloma posiłkami opis musi mieć określony zasięg, inaczej
  // korekta "200 g kurczaka" mogłaby zostać zastosowana do śniadania i kolacji naraz.
  const withText = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });
  assert.ok(/zastosuj opis TYLKO do tego posiłku/.test(withText),
    'Brak reguły zasięgu opisu przy zdjęciu z kilkoma posiłkami.');

  console.log('  ✓ wielosekcyjne zrzuty ekranu nadal obsługiwane, opis ma określony zasięg');
  console.log('✅ Bez regresji na zrzutach ekranu.');
}

function testTextOnlyPromptUnchangedInSpirit() {
  console.log('\n--- TEST 6: sam tekst -> prompt płaski, bez tablicy meals ---');
  const prompt = buildMealPrompt({ hasImage: false, userText: DESCRIPTION, language: 'pl' });

  assert.ok(prompt.includes(DESCRIPTION), 'Tekst użytkownika nie trafił do promptu.');
  assert.ok(/Użytkownik napisał/.test(prompt), 'Zmieniło się wprowadzenie wariantu tekstowego.');
  assert.ok(!/"meals"/.test(prompt),
    'Wariant tekstowy nie powinien prosić o tablicę "meals" - zapisuje jeden wiersz.');
  assert.ok(/"calories"/.test(prompt) && /"health_rating"/.test(prompt),
    'Zniknęły pola ze struktury odpowiedzi.');

  console.log('  ✓ struktura płaska, zgodna z tym, czego oczekuje routes/meals.js');
  console.log('✅ Wariant tekstowy bez zmian.');
}

function testEnglishParity() {
  console.log('\n--- TEST 7: wersja angielska ma te same reguły ---');
  const en = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'en' });

  assert.ok(en.includes(DESCRIPTION), 'Opis nie trafił do angielskiego promptu.');
  assert.ok(/FOLLOW THE DESCRIPTION/.test(en), 'Brak reguły pierwszeństwa w wersji EN.');
  assert.ok(/CORRECTION AND COMPLETION/.test(en), 'Brak określenia roli opisu w wersji EN.');
  assert.ok(/dietician_comment/.test(en) && /note it in one short clause/.test(en),
    'Brak żądania adnotacji w wersji EN.');
  assert.ok(/in English/.test(en), 'Komentarz dietetyka nie jest wymuszony po angielsku.');

  const enNoText = buildMealPrompt({ hasImage: true, userText: '', language: 'en' });
  assert.ok(!/FOLLOW THE DESCRIPTION/.test(enNoText),
    'Reguła konfliktu w wersji EN mimo braku opisu.');

  console.log('  ✓ EN ma pierwszeństwo opisu, adnotację i język komentarza');
  console.log('✅ Parzystość językowa zachowana.');
}

function testWhitespaceOnlyTextCountsAsNoDescription() {
  console.log('\n--- TEST 8: opis z samych spacji traktowany jak brak opisu ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '   \n  ', language: 'pl' });

  assert.ok(!prompt.includes('<user_input>'),
    'Pusty (białe znaki) opis wygenerował blok <user_input> - model dostałby regułę konfliktu bez treści.');
  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'Nie użyto wariantu bez opisu.');

  console.log('  ✓ same białe znaki nie tworzą fałszywego opisu');
  console.log('✅ Odporność na pusty opis.');
}

function testUnknownLanguageFallsBackToPolish() {
  console.log('\n--- TEST 9: nieznany język -> polski ---');
  for (const lang of [undefined, null, 'de', '']) {
    const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: lang });
    assert.ok(/IDŹ ZA OPISEM/.test(prompt), `Dla language=${JSON.stringify(lang)} nie użyto polskiego wariantu.`);
  }
  console.log('  ✓ undefined/null/de/"" -> wariant polski');
  console.log('✅ Bezpieczny fallback języka.');
}

function main() {
  console.log('=== TESTY PROMPTÓW ANALIZY POSIŁKU ===');
  try {
    testPhotoWithDescriptionGivesTextPrecedence();
    testPhotoWithDescriptionAsksForANote();
    testPhotoWithDescriptionCoversAddAndRemove();
    testPhotoWithoutDescriptionHasNoConflictRules();
    testScreenshotBehaviourPreserved();
    testTextOnlyPromptUnchangedInSpirit();
    testEnglishParity();
    testWhitespaceOnlyTextCountsAsNoDescription();
    testUnknownLanguageFallsBackToPolish();
    console.log('\n✅ WSZYSTKIE TESTY PROMPTÓW PRZESZŁY.\n');
  } catch (err) {
    console.error('\n❌ TEST NIE PRZESZEDŁ:', err.message);
    process.exit(1);
  }
}

main();
