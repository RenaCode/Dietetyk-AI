// Tests for building the meal analysis prompt (utils/mealPrompts.js).
//
// The prompt is the only thing here that decides how the model behaves, and a regression
// in it is exceptionally hard to notice: the app keeps working and keeps returning valid
// JSON, only the numbers are computed from the wrong thing. So we assert not on the exact
// wording but on the presence of the instructions that genuinely change the outcome -
// above all the user description taking precedence over the photo.
//
// The regex literals below deliberately stay Polish: they match the Polish PROMPT, so the
// Polish in them is data being matched, not prose anyone reads.

const assert = require('assert');
const { buildMealPrompt } = require('../utils/mealPrompts');

const DESCRIPTION = 'to było 200 g kurczaka, ryż brązowy, smażone na maśle';

function testPhotoWithDescriptionGivesTextPrecedence() {
  console.log('\n--- TEST 1: photo + description -> the description wins ---');
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

  console.log('  ✓ description wrapped in <user_input>, precedence rule present');
  console.log('✅ The description overrides the photo.');
}

function testPhotoWithDescriptionAsksForANote() {
  console.log('\n--- TEST 2: the model must note when it followed the description ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/dietician_comment/.test(prompt), 'Brak pola komentarza w strukturze.');
  assert.ok(/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'Prompt nie żąda adnotacji o skorzystaniu z opisu.');
  assert.ok(/Nie dodawaj takiej adnotacji, gdy\s+oba źródła są zgodne/.test(prompt),
    'Brak zastrzeżenia, żeby nie dodawać adnotacji przy zgodnych źródłach - inaczej pojawiałaby się zawsze.');

  console.log('  ✓ note required on divergence, forbidden when the sources agree');
  console.log('✅ Data-source annotation.');
}

function testPhotoWithDescriptionCoversAddAndRemove() {
  console.log('\n--- TEST 3: the description can add and remove items ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/może DODAWAĆ rzeczy niewidoczne na zdjęciu/.test(prompt),
    'Prompt nie pozwala dopisać rzeczy spoza zdjęcia (napój, sos, oliwa).');
  assert.ok(/pomiń tę\s+pozycję, nawet jeśli wyraźnie widać ją na zdjęciu/.test(prompt),
    'Prompt nie pozwala usunąć pozycji, której użytkownik nie zjadł.');
  assert.ok(/wielkość porcji|tożsamość składnika|sposób przygotowania/.test(prompt),
    'Prompt nie wymienia, co konkretnie opis może korygować.');

  console.log('  ✓ adding, excluding and correcting portion/ingredient/cooking method');
  console.log('✅ Full range of corrections.');
}

function testPhotoWithoutDescriptionHasNoConflictRules() {
  console.log('\n--- TEST 4: photo only -> no conflict-resolution rules ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '', language: 'pl' });

  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'Brak instrukcji samodzielnej identyfikacji przy braku opisu.');
  assert.ok(!prompt.includes('<user_input>'),
    'Pusty blok <user_input> nie powinien trafiać do promptu.');
  assert.ok(!/IDŹ ZA OPISEM/.test(prompt),
    'Reguła rozstrzygania sporu pojawiła się mimo braku opisu - to zbędny szum dla modelu.');
  assert.ok(!/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'Żądanie adnotacji o opisie pojawia się mimo braku opisu.');

  console.log('  ✓ the description-free prompt carries no conflict rules');
  console.log('✅ The no-description variant is clean.');
}

function testScreenshotBehaviourPreserved() {
  console.log('\n--- TEST 5: screenshot handling untouched ---');
  for (const userText of ['', DESCRIPTION]) {
    const prompt = buildMealPrompt({ hasImage: true, userText, language: 'pl' });
    assert.ok(/zrzut\s*\n?ekranu z aplikacji do liczenia kalorii/.test(prompt),
      'Zniknęła obsługa zrzutu ekranu z aplikacji do liczenia kalorii.');
    assert.ok(/NIE sumuj ich w jeden wpis/.test(prompt),
      'Zniknął zakaz sumowania wielu posiłków w jeden wpis.');
    assert.ok(/"meals"/.test(prompt), 'Zniknęła tablica "meals" ze struktury odpowiedzi.');
  }

  // With a photo containing several meals the description needs a defined scope, otherwise a
  // correction such as "200 g of chicken" could be applied to breakfast and dinner at once.
  const withText = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });
  assert.ok(/zastosuj opis TYLKO do tego posiłku/.test(withText),
    'Brak reguły zasięgu opisu przy zdjęciu z kilkoma posiłkami.');

  console.log('  ✓ multi-section screenshots still handled, description scope defined');
  console.log('✅ No regression on screenshots.');
}

function testTextOnlyPromptUnchangedInSpirit() {
  console.log('\n--- TEST 6: text only -> flat prompt, no meals array ---');
  const prompt = buildMealPrompt({ hasImage: false, userText: DESCRIPTION, language: 'pl' });

  assert.ok(prompt.includes(DESCRIPTION), 'Tekst użytkownika nie trafił do promptu.');
  assert.ok(/Użytkownik napisał/.test(prompt), 'Zmieniło się wprowadzenie wariantu tekstowego.');
  assert.ok(!/"meals"/.test(prompt),
    'Wariant tekstowy nie powinien prosić o tablicę "meals" - zapisuje jeden wiersz.');
  assert.ok(/"calories"/.test(prompt) && /"health_rating"/.test(prompt),
    'Zniknęły pola ze struktury odpowiedzi.');

  console.log('  ✓ flat structure, matching what routes/meals.js expects');
  console.log('✅ Text variant unchanged.');
}

function testEnglishParity() {
  console.log('\n--- TEST 7: the English variant carries the same rules ---');
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

  console.log('  ✓ EN has description precedence, the annotation and the comment language');
  console.log('✅ Language parity preserved.');
}

function testWhitespaceOnlyTextCountsAsNoDescription() {
  console.log('\n--- TEST 8: a whitespace-only description counts as none ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '   \n  ', language: 'pl' });

  assert.ok(!prompt.includes('<user_input>'),
    'Pusty (białe znaki) opis wygenerował blok <user_input> - model dostałby regułę konfliktu bez treści.');
  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'Nie użyto wariantu bez opisu.');

  console.log('  ✓ whitespace alone does not create a phantom description');
  console.log('✅ Robust against an empty description.');
}

function testUnknownLanguageFallsBackToPolish() {
  console.log('\n--- TEST 9: unknown language -> Polish ---');
  for (const lang of [undefined, null, 'de', '']) {
    const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: lang });
    assert.ok(/IDŹ ZA OPISEM/.test(prompt), `Dla language=${JSON.stringify(lang)} nie użyto polskiego wariantu.`);
  }
  console.log('  ✓ undefined/null/de/"" -> the Polish variant');
  console.log('✅ Safe language fallback.');
}

function main() {
  console.log('=== MEAL ANALYSIS PROMPT TESTS ===');
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
    console.log('\n✅ ALL PROMPT TESTS PASSED.\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    process.exit(1);
  }
}

main();
