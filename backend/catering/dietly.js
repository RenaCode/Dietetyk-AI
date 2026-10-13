// Client for the Dietly customer panel (panel.dietly.pl), the platform Better Life catering
// - and some forty other Polish caterings - runs its customer accounts on.
//
// There is no public API. The endpoints below are the ones the panel's own single-page app
// calls: a form-encoded login that sets a session cookie, then JSON endpoints under /api that
// take the catering's slug in a `company-id` header.
//
// VERIFIED AGAINST A LIVE ACCOUNT on 2026-10-13, which corrected two guesses read from the JS
// bundle: the base is /api, not /api/panel (the bundle's default `configSlice.baseUrl`, which
// the running panel overrides - /api/panel answered 403 to every request, a correct password
// included), and the day's nutrition comes from `company/general/menus/delivery/<id>/new`
// (`deliveryMenuMeal[]`), while `.../deliveries/<id>/details` answered 404 for today's delivery. Because none of this is a documented contract, every assumption about
// the response shape is isolated in the pure functions here and pinned by
// tests/test-catering-dietly.js - when Dietly changes something, the failure should name the
// field that disappeared, not surface as "0 kcal today".

const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

const DIETLY_BASE = 'https://panel.dietly.pl/api';
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
  constructor({ username, password, companyId, base = DIETLY_BASE, fetchImpl = fetchWithTimeout }) {
    if (!username || !password || !companyId) {
      throw new DietlyError('DIETLY_USERNAME, DIETLY_PASSWORD and DIETLY_COMPANY are all required');
    }
    this.username = username;
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
    // CSRF FIRST. The API is Spring-style: a POST without an X-XSRF-TOKEN header that echoes
    // the XSRF-TOKEN cookie is refused with 403 BEFORE the credentials are looked at. The
    // first version skipped this, and 403 read as "wrong password" for a password that was
    // right (2026-10-13). Any GET hands out the cookie; feature-flags is public and small.
    const warmup = await this.fetch(`${this.base}/open/feature-flags`, { headers: this.headers() }, TIMEOUT_MS);
    mergeCookies(this.jar, warmup);
    await warmup.text().catch(() => '');
    if (!this.jar.has('XSRF-TOKEN')) {
      throw new DietlyError(`no XSRF-TOKEN cookie from the panel (HTTP ${warmup.status}) - login would be refused`);
    }

    const body = `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    const res = await this.fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body,
      redirect: 'manual'
    }, TIMEOUT_MS);
    mergeCookies(this.jar, res);
    await res.text().catch(() => '');
    // 401 is the credentials ("Bad credentials"); 403 is the request itself (CSRF, a missing
    // company-id). Kept apart, because the two send whoever reads the log to different places.
    if (res.status === 401) {
      throw new DietlyError('login rejected (HTTP 401, bad credentials) - check DIETLY_USERNAME/DIETLY_PASSWORD');
    }
    if (res.status === 403) {
      throw new DietlyError('login refused (HTTP 403) before checking credentials - CSRF token or company-id not accepted');
    }
    if (res.status >= 400) throw new DietlyError(`login failed (HTTP ${res.status})`);
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
  // The day's menu with nutrition per meal - what the panel's day view renders. orderId is
  // not part of the path; it stays in the signature so callers do not care which endpoint
  // serves the menu.
  deliveryDetails(_orderId, deliveryId) {
    return this.getJson(`company/general/menus/delivery/${encodeURIComponent(deliveryId)}/new`);
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
    : Array.isArray(details?.deliveryMenuMeal) ? details.deliveryMenuMeal
      : Array.isArray(details?.deliveryMeals) ? details.deliveryMeals
      : Array.isArray(details?.meals) ? details.meals
        : null;
  if (!list) throw new DietlyError('delivery menu: no `deliveryMenuMeal` array');

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
