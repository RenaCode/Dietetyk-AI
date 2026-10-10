// Run with: npm test  (node:test, part of Node - no test dependency is added)
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SETTINGS_FORM, formFromLoadedSettings, settingsPatch } from './settingsForm.js';

// W1 (audit 2026-10-09): the form showed 2500 kcal / BMR 1800 before (and instead of) the
// user's own values, and "Save" wrote them to the database.
test('the form starts with no invented targets', () => {
  for (const key of ['target_calories', 'target_protein', 'target_carbs', 'target_fat', 'bmr', 'target_water_ml']) {
    assert.equal(EMPTY_SETTINGS_FORM[key], '', `${key} starts empty`);
  }
});

test('a key missing from the database stays empty instead of showing a default', () => {
  // Registration stores no target_water_ml - the form used to show 2500 ml as the user's choice.
  const form = formFromLoadedSettings({ target_calories: 1700, bmr: 1450 });
  assert.equal(form.target_water_ml, '');
  assert.equal(form.target_calories, 1700);
});

test('a save is refused when the settings were never loaded', () => {
  assert.throws(() => settingsPatch(null, { ...EMPTY_SETTINGS_FORM, target_calories: 2500 }));
});

test('a save sends only the fields the user changed', () => {
  const loaded = formFromLoadedSettings({ target_calories: 1700, target_protein: 120, bmr: 1450, sync_token: 'sync_x' });
  const current = { ...loaded, target_protein: 130 };
  assert.deepEqual(settingsPatch(loaded, current), { target_protein: 130 });
});

test('saving one section does not persist untouched empty fields of another', () => {
  const loaded = formFromLoadedSettings({ target_calories: 1700 });
  const current = { ...loaded, oura_client_id: 'abc' };
  const patch = settingsPatch(loaded, current);
  assert.deepEqual(Object.keys(patch), ['oura_client_id']);
  assert.ok(!('target_water_ml' in patch));
});

test('a number typed back as the same value is not a change', () => {
  const loaded = formFromLoadedSettings({ bmr: 1450 });
  assert.deepEqual(settingsPatch(loaded, { ...loaded, bmr: '1450' }), {});
});
