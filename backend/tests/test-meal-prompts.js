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

  assert.ok(prompt.includes(DESCRIPTION), 'The user description did not reach the prompt.');
  assert.ok(prompt.includes('<user_input>') && prompt.includes('</user_input>'),
    'The description is not fenced by <user_input> markers (protection against instruction injection).');
  assert.ok(/IDŹ ZA OPISEM/.test(prompt),
    'There is no explicit rule resolving a contradiction in favour of the description.');
  assert.ok(/KOREKTĘ I UZUPEŁNIENIE/.test(prompt),
    'The prompt does not say the description is a correction of and a supplement to the photo.');
  assert.ok(/NIE traktuj opisu jako drugiego, osobnego posiłku/.test(prompt),
    'There is no guard against counting the description as a second meal.');

  console.log('  ✓ description wrapped in <user_input>, precedence rule present');
  console.log('✅ The description overrides the photo.');
}

function testPhotoWithDescriptionAsksForANote() {
  console.log('\n--- TEST 2: the model must note when it followed the description ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/dietician_comment/.test(prompt), 'Brak pola komentarza w strukturze.');
  assert.ok(/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'The prompt does not require a note that the description was used.');
  assert.ok(/Nie dodawaj takiej adnotacji, gdy\s+oba źródła są zgodne/.test(prompt),
    'There is no caveat against adding the note when the sources agree - otherwise it would always appear.');

  console.log('  ✓ note required on divergence, forbidden when the sources agree');
  console.log('✅ Data-source annotation.');
}

function testPhotoWithDescriptionCoversAddAndRemove() {
  console.log('\n--- TEST 3: the description can add and remove items ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });

  assert.ok(/może DODAWAĆ rzeczy niewidoczne na zdjęciu/.test(prompt),
    'The prompt does not allow adding items absent from the photo (a drink, a sauce, oil).');
  assert.ok(/pomiń tę\s+pozycję, nawet jeśli wyraźnie widać ją na zdjęciu/.test(prompt),
    'The prompt does not allow removing an item the user did not eat.');
  assert.ok(/wielkość porcji|tożsamość składnika|sposób przygotowania/.test(prompt),
    'The prompt does not list what specifically the description may correct.');

  console.log('  ✓ adding, excluding and correcting portion/ingredient/cooking method');
  console.log('✅ Full range of corrections.');
}

function testPhotoWithoutDescriptionHasNoConflictRules() {
  console.log('\n--- TEST 4: photo only -> no conflict-resolution rules ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '', language: 'pl' });

  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'Brak instrukcji samodzielnej identyfikacji przy braku opisu.');
  assert.ok(!prompt.includes('<user_input>'),
    'An empty <user_input> block should not reach the prompt.');
  assert.ok(!/IDŹ ZA OPISEM/.test(prompt),
    'The conflict-resolution rule appeared despite there being no description - pointless noise for the model.');
  assert.ok(!/zaznacz to jednym krótkim zdaniem/.test(prompt),
    'The request for a note about the description appears despite there being no description.');

  console.log('  ✓ the description-free prompt carries no conflict rules');
  console.log('✅ The no-description variant is clean.');
}

function testScreenshotBehaviourPreserved() {
  console.log('\n--- TEST 5: screenshot handling untouched ---');
  for (const userText of ['', DESCRIPTION]) {
    const prompt = buildMealPrompt({ hasImage: true, userText, language: 'pl' });
    assert.ok(/zrzut\s*\n?ekranu z aplikacji do liczenia kalorii/.test(prompt),
      'Support for a screenshot from a calorie-counting app disappeared.');
    assert.ok(/NIE sumuj ich w jeden wpis/.test(prompt),
      'The ban on merging several meals into one entry disappeared.');
    assert.ok(/"meals"/.test(prompt), 'The "meals" array disappeared from the response structure.');
  }

  // With a photo containing several meals the description needs a defined scope, otherwise a
  // correction such as "200 g of chicken" could be applied to breakfast and dinner at once.
  const withText = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'pl' });
  assert.ok(/zastosuj opis TYLKO do tego posiłku/.test(withText),
    'The description-scope rule is missing for a photo with several meals.');

  console.log('  ✓ multi-section screenshots still handled, description scope defined');
  console.log('✅ No regression on screenshots.');
}

function testTextOnlyPromptUnchangedInSpirit() {
  console.log('\n--- TEST 6: text only -> flat prompt, no meals array ---');
  const prompt = buildMealPrompt({ hasImage: false, userText: DESCRIPTION, language: 'pl' });

  assert.ok(prompt.includes(DESCRIPTION), 'The user text did not reach the prompt.');
  assert.ok(/Użytkownik napisał/.test(prompt), 'The introduction of the text variant changed.');
  assert.ok(!/"meals"/.test(prompt),
    'The text variant should not ask for a "meals" array - it saves a single row.');
  assert.ok(/"calories"/.test(prompt) && /"health_rating"/.test(prompt),
    'Fields disappeared from the response structure.');

  console.log('  ✓ flat structure, matching what routes/meals.js expects');
  console.log('✅ Text variant unchanged.');
}

function testEnglishParity() {
  console.log('\n--- TEST 7: the English variant carries the same rules ---');
  const en = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: 'en' });

  assert.ok(en.includes(DESCRIPTION), 'The description did not reach the English prompt.');
  assert.ok(/FOLLOW THE DESCRIPTION/.test(en), 'The precedence rule is missing from the EN version.');
  assert.ok(/CORRECTION AND COMPLETION/.test(en), 'The description role is not stated in the EN version.');
  assert.ok(/dietician_comment/.test(en) && /note it in one short clause/.test(en),
    'The note requirement is missing from the EN version.');
  assert.ok(/in English/.test(en), 'Komentarz dietetyka nie jest wymuszony po angielsku.');

  const enNoText = buildMealPrompt({ hasImage: true, userText: '', language: 'en' });
  assert.ok(!/FOLLOW THE DESCRIPTION/.test(enNoText),
    'The conflict rule is present in the EN version despite there being no description.');

  console.log('  ✓ EN has description precedence, the annotation and the comment language');
  console.log('✅ Language parity preserved.');
}

function testWhitespaceOnlyTextCountsAsNoDescription() {
  console.log('\n--- TEST 8: a whitespace-only description counts as none ---');
  const prompt = buildMealPrompt({ hasImage: true, userText: '   \n  ', language: 'pl' });

  assert.ok(!prompt.includes('<user_input>'),
    'A whitespace-only description produced a <user_input> block - the model would get a conflict rule with no content.');
  assert.ok(/zidentyfikuj dania na zdjęciu samodzielnie/.test(prompt),
    'The no-description variant was not used.');

  console.log('  ✓ whitespace alone does not create a phantom description');
  console.log('✅ Robust against an empty description.');
}

function testUnknownLanguageFallsBackToPolish() {
  console.log('\n--- TEST 9: unknown language -> Polish ---');
  for (const lang of [undefined, null, 'de', '']) {
    const prompt = buildMealPrompt({ hasImage: true, userText: DESCRIPTION, language: lang });
    assert.ok(/IDŹ ZA OPISEM/.test(prompt), `For language=${JSON.stringify(lang)} the Polish variant was not used.`);
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
