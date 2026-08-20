const db = require('../db');

// Runda 12 (audyt): ai-explanation-insight (patrz routes/dashboard.js) cache'uje
// wygenerowane przez AI wyjaśnienie przyczyny w health_metrics.ai_explanation, a dla dni
// PRZESZŁYCH traktuje ten cache jako "świeży na zawsze" (dane historyczne są z założenia
// niezmienne). Problem: aplikacja POZWALA edytować dane przeszłych dni po fakcie -
// dodanie/usunięcie posiłku (routes/meals.js), zmiana wody/suplementów (routes/health.js)
// dla daty z przeszłości. Bez invalidacji, wyjaśnienie AI wygenerowane PRZED edycją
// pozostawało w cache'u i mogło sprzecznie odnosić się do danych, które już nie
// odpowiadają stanowi bazy (np. wyjaśnienie wspominające "nie zjadłeś dziś śniadania",
// mimo że posiłek został dodany retroaktywnie po wygenerowaniu wyjaśnienia).
//
// Czyścimy WYŁĄCZNIE cache (ai_explanation/ai_explanation_generated_at) - kolejne
// wejście na dashboard dla tej daty samo wygeneruje nowe wyjaśnienie na bazie
// aktualnych danych (patrz logika isFresh w ai-explanation-insight).
async function invalidateAiExplanationCache(userId, date) {
  if (!date) return;
  try {
    await db.run(
      `UPDATE health_metrics SET ai_explanation = NULL, ai_explanation_generated_at = NULL
       WHERE user_id = ? AND date = ?`,
      [userId, date]
    );
  } catch (err) {
    // A failed cache invalidation must not break the main operation (saving a meal,
    // water or supplements) - at worst the user sees a stale explanation until the next
    // natural refresh (30 min) or until the day rolls over.
    console.error('[AI EXPLANATION CACHE] Cache invalidation failed:', err);
  }
}

module.exports = { invalidateAiExplanationCache };
