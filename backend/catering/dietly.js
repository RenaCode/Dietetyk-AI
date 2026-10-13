// Client for the Dietly customer panel (panel.dietly.pl), the platform Better Life catering
// - and some forty other Polish caterings - runs its customer accounts on.
//
// There is no public API. The endpoints below are the ones the panel's own single-page app
// calls (read from its JS bundle on 2026-10-13): a form-encoded login that sets a session
// cookie, then JSON endpoints under /api/panel that take the catering's slug in a
// `company-id` header. Because none of this is a documented contract, every assumption about
// the response shape is isolated in the pure functions here and pinned by
// tests/test-catering-dietly.js - when Dietly changes something, the failure should name the
// field that disappeared, not surface as "0 kcal today".

const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

const DIETLY_BASE = 'https://panel.dietly.pl/api/panel';
const TIMEOUT_MS = 20000;

class DietlyError extends Error {}

// Minimal cookie jar: the panel authenticates with a session cookie set by auth/login. Only
// name=value pairs are kept - every request goes to the same origin, so domain/path
// attributes do not matter here.
function mergeCookies(jar, response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const line of setCookies) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

class DietlyClient {
  constructor({ email, password, companyId, base = DIETLY_BASE, fetchImpl = fetchWithTimeout }) {
    if (!email || !password || !companyId) {
      throw new DietlyError('DIETLY_EMAIL, DIETLY_PASSWORD and DIETLY_COMPANY are all required');
    }
    this.email = email;
    this.password = password;
    this.companyId = companyId;
    this.base = base;
    this.fetch = fetchImpl;
    this.jar = new Map();
  }

  headers(extra = {}) {
    const h = { Accept: 'application/json', 'company-id': this.companyId, ...extra };
    if (this.jar.size) h.Cookie = cookieHeader(this.jar);
    // Spring-style CSRF: if the server hands out an XSRF-TOKEN cookie, it expects it echoed.
    const xsrf = this.jar.get('XSRF-TOKEN');
    if (xsrf) h['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
    return h;
  }

  async login() {
    const body = `username=${encodeURIComponent(this.email)}&password=${encodeURIComponent(this.password)}`;
    const res = await this.fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body,
      redirect: 'manual'
    }, TIMEOUT_MS);
    mergeCookies(this.jar, res);
    await res.text().catch(() => '');
    // The status alone is not proof: some panels answer 200 to a bad password and only
    // refuse the NEXT request. `getJson` below turns that 401/403 into the same message.
    if (res.status === 401 || res.status === 403) {
      throw new DietlyError(`login rejected (HTTP ${res.status}) - check DIETLY_EMAIL/DIETLY_PASSWORD`);
    }
    if (res.status >= 400) throw new DietlyError(`login failed (HTTP ${res.status})`);
    if (!this.jar.size) throw new DietlyError('login returned no session cookie');
  }

  async getJson(path) {
    const res = await this.fetch(`${this.base}/${path}`, { headers: this.headers() }, TIMEOUT_MS);
    mergeCookies(this.jar, res);
    if (res.status === 401 || res.status === 403) {
      throw new DietlyError(`not authorised for ${path} (HTTP ${res.status}) - session not accepted`);
    }
    if (!res.ok) throw new DietlyError(`GET ${path} failed (HTTP ${res.status})`);
    return res.json();
  }

  activeOrderIds() { return this.getJson('company/customer/order/active-ids'); }
  order(orderId) { return this.getJson(`company/customer/order/${encodeURIComponent(orderId)}`); }
  deliveryDetails(orderId, deliveryId) {
    return this.getJson(`company/customer/order/${encodeURIComponent(orderId)}/deliveries/${encodeURIComponent(deliveryId)}/details`);
  }
}

// --- pure response handling ---------------------------------------------------------------

// active-ids: the panel stores the payload straight into `ordersIds`; accept plain ids or
// objects carrying one.
function parseOrderIds(payload) {
  if (!Array.isArray(payload)) throw new DietlyError('active-ids: expected an array');
  return payload
    .map(x => (x && typeof x === 'object' ? (x.orderId ?? x.id) : x))
    .filter(x => x !== undefined && x !== null && x !== '');
}

// The order carries its deliveries; the panel normalises them by `deliveryId` and reads
// `date` for the calendar. Only the date part is compared - the value may carry a time.
function deliveriesOn(order, date) {
  const deliveries = order && Array.isArray(order.deliveries) ? order.deliveries : null;
  if (!deliveries) throw new DietlyError('order: no `deliveries` array');
  return deliveries.filter(d => d && typeof d.date === 'string' && d.date.slice(0, 10) === date);
}

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// Delivery details -> meals in the shape routes/catering.js accepts.
//
// What the panel itself does (its "Podsumowanie dnia"): for each meal, nutrition[key] *
// amount, keys `calories`, `protein`, `carbohydrate`, `fat`. A meal with amount 0 is one the
// customer cancelled - it is shown greyed out and contributes nothing, so it is dropped here.
//
// Sodium: EU labels give SALT in grams, and salt = sodium x 2.5 by definition (Regulation
// 1169/2011, Annex I). meals.sodium is in milligrams, so salt g x 400 = sodium mg. Only an
// explicit value is converted; nothing is estimated.
function mealsFromDetails(details) {
  const list = Array.isArray(details) ? details
    : Array.isArray(details?.deliveryMeals) ? details.deliveryMeals
      : Array.isArray(details?.meals) ? details.meals
        : null;
  if (!list) throw new DietlyError('delivery details: no `deliveryMeals` array');

  const meals = [];
  let withoutNutrition = 0;
  for (const m of list) {
    const amount = firstNumber(m, ['amount']) ?? 1;
    if (amount <= 0) continue;
    const n = m?.nutrition;
    const calories = firstNumber(n, ['calories', 'kcal', 'energy']);
    if (calories === null) { withoutNutrition++; continue; }
    const scale = (v) => (v === null ? null : Math.round(v * amount * 10) / 10);
    const salt = firstNumber(n, ['salt']);
    const sodiumMg = firstNumber(n, ['sodium']);
    const label = [m.mealName, m.menuMealName].filter(Boolean).join(': ');
    meals.push({
      externalId: String(m.deliveryMealId ?? m.id ?? m.menuMealId),
      name: label || 'Posiłek z cateringu',
      calories: Math.round(calories * amount),
      protein: scale(firstNumber(n, ['protein', 'proteins'])) ?? 0,
      carbs: scale(firstNumber(n, ['carbohydrate', 'carbohydrates', 'carbs'])) ?? 0,
      fat: scale(firstNumber(n, ['fat', 'fats'])) ?? 0,
      fiber: scale(firstNumber(n, ['fiber', 'dietaryFiber', 'fibre'])),
      sugar: scale(firstNumber(n, ['sugar', 'sugars'])),
      sodium: sodiumMg !== null ? scale(sodiumMg) : (salt !== null ? scale(salt * 400) : null),
      priority: firstNumber(m, ['mealPriority']) ?? 0
    });
  }
  meals.sort((a, b) => a.priority - b.priority);
  return { meals: meals.map(({ priority: _priority, ...rest }) => rest), withoutNutrition };
}

// Keys only, never values: what --probe prints so a shape change can be diagnosed from the
// job log without the log ever holding the customer's address, phone number or order.
function describeShape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [describeShape(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth > 3) return '{…}';
    return Object.fromEntries(Object.keys(value).map(k => [k, describeShape(value[k], depth + 1)]));
  }
  return typeof value;
}

module.exports = {
  DietlyClient,
  DietlyError,
  DIETLY_BASE,
  parseOrderIds,
  deliveriesOn,
  mealsFromDetails,
  describeShape
};
