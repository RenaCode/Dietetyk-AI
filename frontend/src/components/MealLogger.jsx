import React, { useState, useRef, useEffect } from 'react';
import { t } from '../utils/i18n';

export default function MealLogger({ meals, onAddMeal, onDeleteMeal, isAnalyzing, frequentMeals, onRepeatMeal }) {
  const [mealText, setMealText] = useState('');
  const [imageSrc, setImageSrc] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  // Confirmation message after saving a meal - the form used to just clear its fields with no
  // clear success signal at all (the only cue was a new row in the meal list below, easy to
  // miss).
  const [successMessage, setSuccessMessage] = useState('');
  const fileInputRef = useRef(null);
  const successTimeoutRef = useRef(null);

  // Round 12 (audit): the setTimeout in handleSubmit/handleRepeatClick was not cleared when
  // the component unmounted (switching tabs right after saving a meal, say), so after 4s it
  // tried to call setSuccessMessage on an already-unmounted component.
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);
  // Id of the meal currently being repeated from a 'frequent meals' chip (round 9) - it
  // disables only that one chip while saving, not the whole form (unlike isAnalyzing, which
  // covers the AI analysis of a new meal).
  const [repeatingMealId, setRepeatingMealId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRepeatClick = async (mealId) => {
    if (repeatingMealId || isAnalyzing || isSubmitting) return;
    setRepeatingMealId(mealId);
    setSuccessMessage('');
    try {
      const ok = await onRepeatMeal(mealId);
      if (ok) {
        setSuccessMessage(t('Posiłek zapisany!'));
        if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = setTimeout(() => setSuccessMessage(''), 4000);
      }
    } finally {
      setRepeatingMealId(null);
    }
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsCompressing(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Zmniejszenie rozmiaru obrazka do maks 800x800 px i kompresja canvas
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Compress to JPEG (quality 0.7) - significantly reduces the size of the SQLite database
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.7);
        setImageSrc(compressedBase64);
        setIsCompressing(false);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isAnalyzing || isCompressing || isSubmitting) return;
    if (!mealText.trim() && !imageSrc) return;
    setIsSubmitting(true);
    setSuccessMessage('');
    try {
      const ok = await onAddMeal(mealText, imageSrc);
      if (ok) {
        setMealText('');
        setImageSrc(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        setSuccessMessage(t('Posiłek zapisany!'));
        if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = setTimeout(() => setSuccessMessage(''), 4000);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const getScoreClass = (score) => {
    // score == null (no AI rating) should not look like 'low' (a badly rated meal) - these are
    // two different situations, so they get their own CSS class.
    if (score == null) return 'unrated';
    if (score >= 8) return 'high';
    if (score >= 5) return 'med';
    return 'low';
  };

  const formatTime = (timestampStr) => {
    if (!timestampStr) return '';
    try {
      const parts = timestampStr.split(' ');
      if (parts.length >= 2) {
        return parts[1].substring(0, 5); // HH:MM
      }
      const d = new Date(timestampStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  };

  return (
    <div className="logger-card">
      <div className="glass-card">
        <h3 className="card-title" id="meal-logger-heading">{t("✍️ Co dziś jadłeś?")}</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Wpisz posiłek w języku naturalnym lub <strong>{t("dodaj zdjęcie swojego talerza")}</strong>. Sztuczna inteligencja automatycznie wyliczy kalorie i makro.
        </p>

        {/* Frequent meals (round 9): chips with the user's most repeated meals
            użytkownika - jedno kliknięcie zapisuje "to samo co ostatnio" bez
            ponownego wywołania AI (patrz POST /api/meals/repeat). */}
        {frequentMeals && frequentMeals.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '8px' }}>
              ⚡ Często jadłeś:
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {frequentMeals.map((fm) => (
                <button
                  key={fm.mealId}
                  type="button"
                  onClick={() => handleRepeatClick(fm.mealId)}
                  disabled={isAnalyzing || repeatingMealId !== null}
                  title={`${fm.avgCalories} kcal | B: ${fm.avgProtein}g, W: ${fm.avgCarbs}g, T: ${fm.avgFat}g`}
                  style={{
                    background: 'rgba(124,58,237,0.12)',
                    border: '1px solid rgba(124,58,237,0.3)',
                    color: '#c4b5fd',
                    borderRadius: '999px',
                    padding: '6px 14px',
                    fontSize: '0.76rem',
                    cursor: repeatingMealId !== null || isAnalyzing ? 'default' : 'pointer',
                    opacity: repeatingMealId !== null && repeatingMealId !== fm.mealId ? 0.5 : 1
                  }}
                >
                  {repeatingMealId === fm.mealId ? t('Zapisywanie...') : `🔁 ${fm.rawText}`}
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="textarea-wrapper">
            {/* aria-labelledby ties the textarea to the section heading (id="meal-logger-heading")
                zamiast dublować widoczny tekst w dodatkowym, wizualnie zbędnym <label> -
                wcześniej pole nie miało żadnej programowej etykiety dla czytników ekranu. */}
            {/* The hint changes once a photo is added. It used to read
                "...lub zostaw puste, jeśli wgrywasz tylko zdjęcie", co sugerowało, że
                przy zdjęciu opis jest zbędny - a to właśnie wtedy jest najbardziej
                przydatny: AI szacuje gramaturę i sposób obróbki ze zdjęcia, a opis
                pozwala to poprawić i dopisać rzeczy spoza kadru. */}
            <textarea
              className="meal-input"
              aria-labelledby="meal-logger-heading"
              aria-describedby={imageSrc ? 'meal-photo-hint' : undefined}
              value={mealText}
              onChange={(e) => setMealText(e.target.value)}
              placeholder={imageSrc
                ? t("Uzupełnij lub popraw zdjęcie (np. '200 g kurczaka, nie 150', 'smażone na maśle', 'do tego szklanka soku', 'chleba nie zjadłem')...")
                : t("Opisz swój posiłek (np. 'Kurczak z ryżem i warzywami') albo dodaj zdjęcie...")}
                disabled={isAnalyzing || isSubmitting}
            />
          </div>

          {imageSrc && (
            <p
              id="meal-photo-hint"
              style={{ fontSize: '0.8rem', color: 'var(--text-dim)', margin: '-6px 0 0', lineHeight: 1.5 }}
            >
              💡 Opis <strong>{t("uzupełnia zdjęcie")}</strong>, nie tworzy drugiego posiłku. Gdy opis
              przeczy zdjęciu, AI liczy według opisu i zaznacza to w komentarzu dietetyka.
            </p>
          )}

          {/* Photo upload */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-glass)',
                  boxShadow: 'none',
                  color: 'var(--text-main)',
                  padding: '10px 16px',
                  fontSize: '0.9rem'
                }}
                disabled={isAnalyzing || isCompressing || isSubmitting}
              >
                📷 {imageSrc ? t('Zmień zdjęcie') : t('Zrób/Dodaj zdjęcie')}
              </button>
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageChange}
                style={{ display: 'none' }}
              />
              {isCompressing && <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Kompresowanie obrazu...</span>}
            </div>

            {imageSrc && (
              <div style={{ position: 'relative', width: '100%', maxWidth: '200px', height: '150px', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-glass)', marginTop: '8px' }}>
                <img src={imageSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={t("Podgląd posiłku")} />
                <button
                  type="button"
                  onClick={() => {
                    setImageSrc(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    background: 'rgba(239, 68, 68, 0.9)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '50%',
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 'bold'
                  }}
                  title={t("Usuń zdjęcie")}
                  aria-label={t("Usuń zdjęcie")}
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {successMessage && (
            <div className="alert alert-success" role="status">
              ✅ {successMessage}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={isAnalyzing || isCompressing || isSubmitting || (!mealText.trim() && !imageSrc)}
          >
            {isAnalyzing || isSubmitting ? (
              <>
                <span className="loading-pulse"></span>
                <span>Analizowanie przez AI...</span>
              </>
            ) : (
              <>
                <span>{t("🥗 Przeanalizuj posiłek")}</span>
              </>
            )}
          </button>
        </form>
      </div>

      <div className="glass-card">
        <h3 className="card-title">{t("📋 Dzisiejsze posiłki")}</h3>
        
        {meals.length === 0 ? (
          <p className="empty-state">{t("Brak wprowadzonych posiłków na ten dzień. Wpisz coś powyżej lub dodaj zdjęcie!")}</p>
        ) : (
          <div className="meals-list">
            {meals.map((meal) => (
              <div
                key={meal.id}
                className="meal-item"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '20px',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ flex: 1, minWidth: '250px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div className="meal-item-header">
                    <div>
                      <h4 className="meal-title">{meal.raw_text}</h4>
                      <span className="meal-time">🕒 Dodano o {formatTime(meal.timestamp)}</span>
                    </div>
                    <button
                      className="btn-delete"
                      onClick={() => onDeleteMeal(meal.id)}
                      title={t("Usuń posiłek")}
                      aria-label={t("Usuń posiłek")}
                    >
                      🗑️
                    </button>
                  </div>

                  <div className="meal-nutrition-chips">
                    <span className="nutrition-chip calories">{meal.calories != null ? Math.round(meal.calories) : '-'} kcal</span>
                    <span className="nutrition-chip protein">B: {meal.protein != null ? Math.round(meal.protein) : '-'}g</span>
                    <span className="nutrition-chip carbs">W: {meal.carbs != null ? Math.round(meal.carbs) : '-'}g</span>
                    <span className="nutrition-chip fat">T: {meal.fat != null ? Math.round(meal.fat) : '-'}g</span>
                    {/* health_rating == null (an older entry with no AI rating) shows
                        "Brak oceny" - poprzednio || 5 fałszywie udawało ocenę 5/10
                        zarówno dla null, jak i dla realnej, najniższej oceny 0. */}
                    <span className={`meal-score ${getScoreClass(meal.health_rating)}`}>
                      {meal.health_rating != null ? `Ocena: ${meal.health_rating}/10` : 'Brak oceny'}
                    </span>
                  </div>

                  {(meal.fiber != null || meal.sugar != null || meal.sodium != null) && (
                    <div className="meal-nutrition-chips" style={{ marginTop: '-4px' }}>
                      {meal.fiber != null && (
                        <span className="nutrition-chip fiber">
                          Błonnik: {Math.round(meal.fiber * 10) / 10}g
                        </span>
                      )}
                      {meal.sugar != null && (
                        <span className="nutrition-chip sugar">
                          Cukry: {Math.round(meal.sugar * 10) / 10}g
                        </span>
                      )}
                      {meal.sodium != null && (
                        <span className="nutrition-chip sodium">
                          Sód: {Math.round(meal.sodium)}mg
                        </span>
                      )}
                    </div>
                  )}

                  {meal.dietician_comment && (
                    <p className="meal-comment">
                      <strong>Dietetyk AI:</strong> {meal.dietician_comment}
                    </p>
                  )}

                  {/* Anomaly detector: macro/calorie inconsistency or a statistical outlier
                      względem własnej historii posiłków użytkownika (patrz detectMealAnomalies
                      w backend/routes/meals.js). To opisowe sygnały, nie diagnoza - dlatego
                      neutralny ton i brak czerwieni "błędu", a kolor ostrzegawczy. */}
                  {meal.anomalies && meal.anomalies.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {meal.anomalies.map((a, idx) => (
                        <div
                          key={idx}
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-main)',
                            background: 'rgba(251, 191, 36, 0.08)',
                            border: '1px solid rgba(251, 191, 36, 0.3)',
                            borderRadius: '8px',
                            padding: '6px 10px'
                          }}
                        >
                          ⚠️ {a.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {meal.food_items && meal.food_items.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>{t("Rozbicie na składniki:")}</span>
                      <ul style={{ fontSize: '0.8rem', paddingLeft: '16px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {meal.food_items.map((item, idx) => (
                          <li key={idx} style={{ marginBottom: '2px' }}>
                            <strong>{item.name}</strong> ({item.portion}) - {item.calories} kcal | B: {item.protein}g, W: {item.carbs}g, T: {item.fat}g
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Meal photo thumbnail */}
                {meal.image_base64 && (
                  <div style={{
                    width: '120px',
                    height: '120px',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    border: '1px solid var(--border-glass)',
                    flexShrink: 0,
                    boxShadow: 'var(--shadow-purple)',
                    marginTop: '4px'
                  }}>
                    <img src={meal.image_base64} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={t("Zdjęcie posiłku")} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
