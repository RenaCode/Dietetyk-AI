// Catering sync job: today's menu from the catering panel -> today's meals in Dietetyk.
//
// Runs as its own CronJob container (charts/dietetyk/templates/catering-cronjob.yaml), from
// the backend image but WITHOUT the database: SQLite lives on the backend's ReadWriteOnce
// volume and must have exactly one writer, so this job goes through the backend's HTTP
// import endpoint (routes/catering.js) like any other client.
//
//   node catering/sync.js            sync today (Europe/Warsaw)
//   node catering/sync.js --date D   sync a given YYYY-MM-DD
//   node catering/sync.js --dry-run  fetch and print the day, send nothing
//   node catering/sync.js --probe    print the response SHAPES (keys, no values) and exit
//
// Environment: DIETLY_EMAIL, DIETLY_PASSWORD, DIETLY_COMPANY (the catering's slug,
// `betterlifecateringdietetyczny` for Better Life), CATERING_SOURCE (default `betterlife`),
// DIETETYK_URL (default the in-cluster backend Service), DIETETYK_SYNC_TOKEN.
//
// Exit codes are the job's only alarm: a failed run shows up as a Failed Job, so anything
// that would leave the day silently wrong exits non-zero.

const { getLocalDateString, isCalendarDateString } = require('../utils/dates');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const {
  DietlyClient, DietlyError, parseOrderIds, deliveriesOn, mealsFromDetails, describeShape
} = require('./dietly');

function parseArgs(argv) {
  const args = { dryRun: false, probe: false, date: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--date') args.date = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (args.date !== null && !isCalendarDateString(args.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got ${args.date}`);
  }
  return args;
}

async function collectDay(client, date, { probe = false } = {}) {
  const idsPayload = await client.activeOrderIds();
  if (probe) console.log('active-ids:', JSON.stringify(describeShape(idsPayload)));
  const orderIds = parseOrderIds(idsPayload);

  const meals = [];
  let deliveriesFound = 0;
  let withoutNutrition = 0;
  for (const orderId of orderIds) {
    const order = await client.order(orderId);
    if (probe) console.log(`order:`, JSON.stringify(describeShape(order)));
    for (const delivery of deliveriesOn(order, date)) {
      deliveriesFound++;
      const details = await client.deliveryDetails(orderId, delivery.deliveryId);
      if (probe) console.log(`delivery details:`, JSON.stringify(describeShape(details)));
      const day = mealsFromDetails(details);
      meals.push(...day.meals);
      withoutNutrition += day.withoutNutrition;
    }
  }
  return { orderIds, deliveriesFound, meals, withoutNutrition };
}

async function sendDay({ url, token, source, date, meals }) {
  const res = await fetchWithTimeout(
    `${url.replace(/\/$/, '')}/api/integrations/catering/${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, date, meals })
    },
    20000
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dietetyk refused the import (HTTP ${res.status}): ${body.error || ''}`);
  return body;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const date = args.date || getLocalDateString();
  const source = env.CATERING_SOURCE || 'betterlife';

  const client = new DietlyClient({
    email: env.DIETLY_EMAIL,
    password: env.DIETLY_PASSWORD,
    companyId: env.DIETLY_COMPANY
  });
  await client.login();

  const day = await collectDay(client, date, { probe: args.probe });
  if (args.probe) return 0;

  if (day.orderIds.length === 0) {
    console.log(`[catering] ${date}: no active order - nothing to import`);
    return 0;
  }
  if (day.deliveriesFound === 0) {
    // Not an error (a weekend without delivery, a paused order) - and deliberately NOT an
    // empty import: an empty list would delete the day's catering meals, and a change in
    // the panel's date format would then wipe days instead of failing.
    console.log(`[catering] ${date}: ${day.orderIds.length} active order(s), no delivery for this day`);
    return 0;
  }
  if (day.meals.length === 0) {
    // A delivery with meals but no nutrition: either the catering hides nutrition in the
    // panel (`visibleNutritionInDietly`) or the field moved. Either way the day would read
    // as 0 kcal, so this is a failure, not a quiet success.
    throw new DietlyError(
      `${date}: delivery found but no meal carries nutrition (${day.withoutNutrition} without) - ` +
      `run with --probe to see the response shape`);
  }
  if (day.withoutNutrition > 0) {
    console.warn(`[catering] ${date}: ${day.withoutNutrition} meal(s) without nutrition were skipped`);
  }

  const total = day.meals.reduce((s, m) => s + m.calories, 0);
  console.log(`[catering] ${date}: ${day.meals.length} meal(s), ${total} kcal`);
  for (const m of day.meals) {
    console.log(`  - ${m.name}: ${m.calories} kcal, B ${m.protein} g, W ${m.carbs} g, T ${m.fat} g`);
  }
  if (args.dryRun) return 0;

  if (!env.DIETETYK_SYNC_TOKEN) throw new Error('DIETETYK_SYNC_TOKEN is not set');
  const result = await sendDay({
    url: env.DIETETYK_URL || 'http://dietetyk-backend:3000',
    token: env.DIETETYK_SYNC_TOKEN,
    source,
    date,
    meals: day.meals
  });
  console.log(`[catering] imported: ${result.meals} meal(s), ${result.calories} kcal` +
    (result.changed ? '' : ' (no change since the last run)'));
  return 0;
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    err => {
      // The message only - a stack trace from fetch could echo the request, and the URL of
      // the import carries the sync token.
      console.error(`[catering] FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main, parseArgs, collectDay };
