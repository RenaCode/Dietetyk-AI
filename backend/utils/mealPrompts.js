// Building the meal analysis prompts (routes/meals.js).
//
// Extracted from the route into its own module for two reasons: the prompts are the most
// sensitive and most frequently adjusted part of this feature, and they used to sit as 150
// lines of templates inside the handler, where the only way to check them was a real Gemini
// call - billable and non-deterministic.
//
// THE KEY RULE for photo + description: the user's description is the SOURCE OF FACTS and
// the photo is supporting evidence. The description used to be handed to the model as
// "additional context", which on a conflict (user: "200 g of chicken"; photo: looks like
// 150 g) let the model simply ignore the text and count what it saw. Precedence is now
// stated outright, and the model is required to note in the dietician comment that it used
// the description instead of its own estimate - so it is visible where the number came from.

// Shared description of a single meal's structure. Kept in one place so the Polish and
// English variants cannot drift apart the next time a field changes.
function mealFieldsSchema(lang, { portionHint, commentHint }) {
  if (lang === 'en') {
    return `      "calories": (integer - kcal for THIS meal),
      "protein": (number - grams of protein),
      "carbs": (number - grams of carbohydrates),
      "fat": (number - grams of fat),
      "fiber": (number - grams of fiber, estimated based on ingredients),
      "sugar": (number - grams of simple sugars, estimated based on ingredients),
      "sodium": (number - milligrams of sodium, estimated based on ingredients),
      "food_items": [
        {
          "name": "name of identified ingredient (e.g., fried egg, boiled potatoes, chicken breast)",
          "portion": "${portionHint}",
          "calories": (number - kcal),
          "protein": (number - g),
          "carbs": (number - g),
          "fat": (number - g)
        }
      ],
      "dietician_comment": "${commentHint}",
      "health_rating": (integer from 1 to 10, where 1 is very unhealthy and 10 is super healthy and balanced)`;
  }
  return `      "calories": (liczba całkowita - kcal dla TEGO posiłku),
      "protein": (liczba - gramy białka),
      "carbs": (liczba - gramy węglowodanów),
      "fat": (liczba - gramy tłuszczu),
      "fiber": (liczba - gramy błonnika, szacunkowo na podstawie składników posiłku),
      "sugar": (liczba - gramy cukrów prostych, szacunkowo na podstawie składników posiłku),
      "sodium": (liczba - miligramy sodu, szacunkowo na podstawie składników posiłku),
      "food_items": [
        {
          "name": "nazwa zidentyfikowanego składnika (np. jajko sadzone, ziemniaki gotowane, pierś z kurczaka)",
          "portion": "${portionHint}",
          "calories": (liczba - kcal),
          "protein": (liczba - g),
          "carbs": (liczba - g),
          "fat": (liczba - g)
        }
      ],
      "dietician_comment": "${commentHint}",
      "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe, a 10 to super zdrowe i zbilansowane)`;
}

// The instruction giving the description precedence over the photo. Inserted ONLY when the
// user actually wrote something - otherwise the model would receive a rule for resolving a
// conflict that does not exist, which needlessly distracts it on a photo-only request.
function descriptionPrecedenceBlock(lang, userText) {
  if (lang === 'en') {
    return `The user attached this photo AND wrote a description. Treat the description as a
CORRECTION AND COMPLETION of the photo, not as a separate meal.

<user_input>${userText}</user_input>

How to combine the two sources:
1. The description is the AUTHORITATIVE source of facts. The photo is supporting
   evidence. Where they disagree, FOLLOW THE DESCRIPTION.
2. The description may correct what you see - portion sizes ("that was 200g of
   chicken"), the identity of an ingredient ("that is turkey, not chicken"), or the
   preparation method ("fried in butter", "no sugar added"). Apply every such
   correction.
3. The description may ADD things that are not visible in the photo (a drink, a
   sauce, a spoon of olive oil, a supplement taken with the meal). Include them as
   separate entries in "food_items".
4. The description may say something is absent ("I did not eat the bread") - then
   exclude that item even if it is clearly visible in the photo.
5. Whenever you follow the description INSTEAD of your own reading of the photo,
   say so in one short clause inside "dietician_comment", e.g. "photo suggests about
   150 g, using 200 g per your description". Do not add such a note when the two
   sources agree.
6. Do NOT treat the description as a second, separate meal. It describes the SAME
   food that is on the photo.`;
  }
  return `Użytkownik dołączył to zdjęcie ORAZ napisał opis. Potraktuj opis jako
KOREKTĘ I UZUPEŁNIENIE zdjęcia, a nie jako osobny posiłek.

<user_input>${userText}</user_input>

Jak połączyć oba źródła:
1. Opis jest ŹRÓDŁEM FAKTÓW o wyższym pierwszeństwie. Zdjęcie jest poszlaką.
   Gdy się różnią, IDŹ ZA OPISEM.
2. Opis może poprawiać to, co widzisz - wielkość porcji ("to było 200 g kurczaka"),
   tożsamość składnika ("to indyk, nie kurczak") albo sposób przygotowania
   ("smażone na maśle", "bez cukru"). Zastosuj każdą taką poprawkę.
3. Opis może DODAWAĆ rzeczy niewidoczne na zdjęciu (napój, sos, łyżka oliwy,
   suplement przyjęty do posiłku). Uwzględnij je jako osobne pozycje w "food_items".
4. Opis może mówić, że czegoś nie było ("chleba nie zjadłem") - wtedy pomiń tę
   pozycję, nawet jeśli wyraźnie widać ją na zdjęciu.
5. Za każdym razem, gdy idziesz za opisem ZAMIAST za własnym odczytem zdjęcia,
   zaznacz to jednym krótkim zdaniem w "dietician_comment", np. "na zdjęciu widać
   ok. 150 g, przyjęto 200 g zgodnie z opisem". Nie dodawaj takiej adnotacji, gdy
   oba źródła są zgodne.
6. NIE traktuj opisu jako drugiego, osobnego posiłku. Opisuje TO SAMO jedzenie,
   które jest na zdjęciu.`;
}

function buildImagePrompt(lang, userText) {
  const hasText = Boolean(userText);

  if (lang === 'en') {
    const intro = hasText
      ? descriptionPrecedenceBlock('en', userText)
      : `Analyze the attached photo for nutritional value.
The user did not provide a text description, identify the dishes in the photo yourself.`;

    return `${intro}

IMPORTANT - the photo may show a SINGLE meal (e.g., a photo of a plate) OR a screenshot from a calorie tracking app showing a breakdown of the entire day into several separate meals (e.g., sections "Breakfast", "Lunch", "Dinner", each with its own items and calories/macro sum).
- If you see a clear division into several sections/meals on the photo, return in the "meals" array ONE object for EACH detected section, each with its own separate nutritional values - DO NOT sum them into one entry. Use the meal label visible in the photo as "name" (e.g., "Breakfast", "Lunch", "Dinner").
- If there is only one meal/dish on the photo, without a division into sections, return the "meals" array with ONE element, and use a short name of the recognized dish as "name" (e.g., "Oatmeal with banana and nuts").${hasText ? `
- If the photo contains several meals and the description clearly refers to one of them (e.g., mentions the label "Lunch"), apply the description ONLY to that meal. If the description is general, apply it to the whole day shown in the photo.` : ''}

Return the response in JSON format. The response must be strictly valid JSON, without any additional markdown formatting or text before/after.

JSON Structure:
{
  "meals": [
    {
      "name": "meal name/label detected in the photo (see instructions above)",
${mealFieldsSchema('en', {
      portionHint: hasText
        ? 'portion size - taken from the user description when it specifies one, otherwise estimated from the photo (e.g., 2 pieces, 150g, 1 cup)'
        : 'portion size estimated from the photo (e.g., 2 pieces, 150g, 1 cup)',
      commentHint: hasText
        ? 'A short, professional dietician comment in English (max 3 sentences) regarding THIS meal. Evaluate balance, pros, cons, and suggestions for improvement. If you followed the user description instead of your own reading of the photo, note it in one short clause.'
        : 'A short, professional dietician comment in English (max 3 sentences) regarding THIS meal. Evaluate balance, pros, cons, and suggestions for improvement.'
    })}
    }
  ]
}
`;
  }

  const intro = hasText
    ? descriptionPrecedenceBlock('pl', userText)
    : `Przeanalizuj dołączone zdjęcie pod kątem wartości odżywczych.
Użytkownik nie podał opisu tekstowego, zidentyfikuj dania na zdjęciu samodzielnie.`;

  return `${intro}

WAŻNE - zdjęcie może przedstawiać JEDEN posiłek (np. zdjęcie talerza) ALBO zrzut
ekranu z aplikacji do liczenia kalorii, pokazujący podział całego dnia na kilka
osobnych posiłków (np. sekcje "Śniadanie", "II Śniadanie", "Obiad", "Podwieczorek",
"Kolacja", każda z własnymi pozycjami i sumą kcal/makro).
- Jeśli widzisz na zdjęciu wyraźny podział na kilka sekcji/posiłków, zwróć w tablicy
  "meals" JEDEN obiekt na KAŻDĄ wykrytą sekcję, każdy z własnymi, osobnymi wartościami
  odżywczymi - NIE sumuj ich w jeden wpis. Jako "name" użyj etykiety posiłku widocznej
  na zdjęciu (np. "Śniadanie", "Obiad", "Kolacja").
- Jeśli na zdjęciu jest tylko jeden posiłek/danie, bez podziału na sekcje, zwróć
  tablicę "meals" z JEDNYM elementem, a jako "name" użyj krótkiej nazwy rozpoznanego
  dania (np. "Owsianka z bananem i orzechami").${hasText ? `
- Jeśli na zdjęciu jest kilka posiłków, a opis wyraźnie dotyczy jednego z nich (np.
  wymienia etykietę "Obiad"), zastosuj opis TYLKO do tego posiłku. Jeśli opis jest
  ogólny, zastosuj go do całego dnia widocznego na zdjęciu.` : ''}

Zwróć odpowiedź w formacie JSON. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "meals": [
    {
      "name": "nazwa posiłku/etykieta wykryta na zdjęciu (patrz instrukcja powyżej)",
${mealFieldsSchema('pl', {
    portionHint: hasText
      ? 'wielkość porcji - wzięta z opisu użytkownika, gdy ją podaje, w przeciwnym razie oszacowana ze zdjęcia (np. 2 sztuki, 150g, 1 szklanka)'
      : 'wielkość porcji oszacowana na podstawie zdjęcia (np. 2 sztuki, 150g, 1 szklanka)',
    commentHint: hasText
      ? 'Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania) dotyczący TEGO posiłku. Oceń zbilansowanie, zalety, wady i ewentualne sugestie ulepszenia. Jeśli poszedłeś za opisem użytkownika zamiast za własnym odczytem zdjęcia, zaznacz to jednym krótkim zdaniem.'
      : 'Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania) dotyczący TEGO posiłku. Oceń zbilansowanie, zalety, wady i ewentualne sugestie ulepszenia.'
  })}
    }
  ]
}
`;
}

function buildTextPrompt(lang, userText) {
  if (lang === 'en') {
    return `You are analyzing the user's meal for nutritional value.
The user wrote: <user_input>${userText}</user_input>

Return the response in JSON format containing estimated nutritional values of the meal. The response must be strictly valid JSON, without any additional markdown formatting or text before/after.

JSON Structure:
{
  "calories": (integer - kcal for the entire meal),
  "protein": (number - grams of protein),
  "carbs": (number - grams of carbohydrates),
  "fat": (number - grams of fat),
  "fiber": (number - grams of fiber, estimated based on ingredients),
  "sugar": (number - grams of simple sugars, estimated based on ingredients),
  "sodium": (number - milligrams of sodium, estimated based on ingredients),
  "food_items": [
    {
      "name": "ingredient name (e.g., egg, wheat bread)",
      "portion": "portion size specified by the user or default estimated (e.g., 2 pieces, 100g)",
      "calories": (number - kcal),
      "protein": (number - g),
      "carbs": (number - g),
      "fat": (number - g)
    }
  ],
  "dietician_comment": "A short, professional dietician comment in English (max 3 sentences). Evaluate balance, pros, cons, and suggestions for improvement.",
  "health_rating": (integer from 1 to 10, where 1 is very unhealthy e.g. fast food, and 10 is super healthy and balanced)
}
`;
  }

  return `Analizujesz posiłek użytkownika pod kątem wartości odżywczych.
Użytkownik napisał: <user_input>${userText}</user_input>

Zwróć odpowiedź w formacie JSON zawierającym szacunkowe wartości odżywcze posiłku. Odpowiedź musi być wyłącznie poprawnym JSON-em, bez żadnych dodatkowych znaczników markdown czy tekstu przed/po.

Struktura JSON:
{
  "calories": (liczba całkowita - kcal dla całego posiłku),
  "protein": (liczba - gramy białka),
  "carbs": (liczba - gramy węglowodanów),
  "fat": (liczba - gramy tłuszczu),
  "fiber": (liczba - gramy błonnika, szacunkowo na podstawie składników posiłku),
  "sugar": (liczba - gramy cukrów prostych, szacunkowo na podstawie składników posiłku),
  "sodium": (liczba - miligramy sodu, szacunkowo na podstawie składników posiłku),
  "food_items": [
    {
      "name": "nazwa składnika (np. jajko, chleb pszenny)",
      "portion": "wielkość porcji podana przez użytkownika lub domyślna szacowana (np. 2 sztuki, 100g)",
      "calories": (liczba - kcal),
      "protein": (liczba - g),
      "carbs": (liczba - g),
      "fat": (liczba - g)
    }
  ],
  "dietician_comment": "Krótki, profesjonalny komentarz dietetyczny po polsku (max 3 zdania). Ocen zbilansowanie posiłku, zalety, wady i ewentualne sugestie ulepszenia.",
  "health_rating": (liczba całkowita od 1 do 10, gdzie 1 to bardzo niezdrowe np. fast food, a 10 to super zdrowe i zbilansowane)
}
`;
}

/**
 * Builds the meal analysis prompt.
 *
 * @param {Object} opts
 * @param {boolean} opts.hasImage whether a photo was attached to the request
 * @param {string}  opts.userText the text the user typed (already sanitised)
 * @param {string}  opts.language 'pl' | 'en'
 */
function buildMealPrompt({ hasImage, userText, language }) {
  const lang = language === 'en' ? 'en' : 'pl';
  const text = typeof userText === 'string' ? userText.trim() : '';

  return hasImage ? buildImagePrompt(lang, text) : buildTextPrompt(lang, text);
}

module.exports = {
  buildMealPrompt
};
