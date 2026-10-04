# 🥗 Dietetyk AI (AI Dietician)

An aesthetically designed web application that analyzes your diet based on meals you enter (using **Gemini AI**), tracks health metrics from **Oura Ring** and **Withings** (smart scale and body composition) sensors, and visualizes trends on interactive charts.

Production runs on k3s, deployed by Argo CD from the Helm chart in `charts/dietetyk` — see [Deployment](#️-deployment-k3s--argo-cd).

---

## 🚀 Main Features

1.  **AI Meal Journal**: Input your meals in natural language (e.g., *"This morning I ate 2 slices of whole grain bread with avocado and a fried egg"*). Gemini AI automatically breaks it down into ingredients, calculates calories, macronutrients (protein, carbohydrates, fat), evaluates the meal, and generates tips.

    **Photo + description work together.** When you attach a photo *and* type something, the text is treated as a correction and completion of the photo — never as a second meal. Your description is the authoritative source and the photo is supporting evidence, so you can fix a portion the model misjudged (*"that was 200 g of chicken, not 150"*), correct an ingredient or the cooking method (*"turkey, not chicken"*, *"fried in butter"*), add what is out of frame (*"plus a glass of juice"*), or exclude something visible you did not eat (*"I skipped the bread"*). Where the two disagree the description wins, and the dietician comment says so — e.g. *"photo suggests about 150 g, using 200 g per your description"* — so the number is always traceable. Prompt construction lives in `utils/mealPrompts.js` and is covered by `tests/test-meal-prompts.js`.
2.  **Direct Oura Ring Integration**: Retrieve recovery metrics such as Readiness score, Sleep score, sleep stages (deep, REM), resting heart rate (RHR), and heart rate variability (HRV).
3.  **Direct Withings Integration**: Automatically retrieve body composition metrics: weight (kg), body fat percentage, and muscle mass (kg).
4.  **Progress Charts (Custom SVG)**: Built-in, fully responsive, and highly performant SVG charts tracking:
    *   **Fat Loss**: Weight trend plotted against body fat percentage (dual-axis chart).
    *   **Muscle Gain**: Lean muscle mass trend over time.
5.  **Daily Gemini AI Analysis**: The model analyzes your meals, sleep metrics from Oura, and body composition from Withings to provide personalized recommendations.
6.  **Admin Panel**: Allows dynamic configuration of API credentials for Oura and Withings directly from the user interface (no container restart required).
7.  **Apple Health Synchronization**: Steps, active energy (calories), and active minutes can be imported from Apple Health via a webhook—configure this in the Settings tab.
8.  **Google Fit Synchronization**: Similar to Apple Health, the app can fetch steps and calories from Google Fit (hourly sync via OAuth2, without needing an intermediate app)—connect your account from the Settings tab. Needs the Google client configured in the Admin Panel; without it the option is hidden.
9.  **Google Account Linking**: Connect an existing password-based account with your Google account in the Settings tab to sign in with a single click without losing your meal history and settings. Like Google Fit, this and the "Sign in with Google" button appear only once an administrator has configured the Google client.
10. **Energy Battery**: A single 0–100 number at the top of the dashboard answering "how much fuel do I have today". It charges overnight from sleep quality, duration and readiness, drains through the day from actual training load (relative to your own 30-day median, not a population norm) and from time awake, takes a hit from accumulated **sleep debt** over the last 14 nights, and adjusts for stress vs. recovery minutes. Every card shows its own breakdown, so the number is checkable rather than magic. See `/api/dashboard/energy-battery`.

> [!NOTE]
> Energy Battery and Wellness Score answer different questions and are deliberately kept separate. Wellness Score rates how *good* the day was (sleep, readiness, calorie adherence, hydration) — a judgement about behaviour. The battery says how much resource is *left right now*. A day with a perfect diet after three short nights scores well and shows a low battery; that is the intended behaviour.

---

## 🧭 Notes for Developers

### Insights are fetched in one batch

The dashboard renders ~49 independent insight cards. Each used to have its own `useEffect` and its own `fetch`, so opening the screen fired ~50 HTTP round-trips and as many separate SQLite query bursts.

`GET /api/dashboard/insights?ids=a,b,c&date=YYYY-MM-DD` now runs them in one request (6 at a time server-side) and returns a per-item status:

```json
{ "date": "2026-08-20", "results": { "sleep-insight": { "status": "ok", "data": { … } } } }
```

Each item is isolated — an error, a timeout (15 s cap, relevant for AI-backed insights) or an unknown id yields a status for that card only and never breaks the rest of the response. On the client this is `useInsights()` (`frontend/src/utils/useInsights.js`).

**The registry is automatic.** `routes/dashboard.js` wraps `router.get` and indexes every `/api/dashboard/<id>` route as it is registered, so a new insight joins the batch without touching a second list. `tests/test-energy-battery.js` asserts that the count of routes in the file matches the count in the registry, so an insight added in a different style fails the test instead of silently disappearing from the dashboard.

Two insights stay overridable after the batch because they refresh independently: `ai-explanation-insight` (backend generates in the background, client polls) and `training-plan-insight` (manual "Odśwież" button). Both keep an override keyed by date so switching days never shows the previous day's result.

### Activity data source priority

Three sources write activity metrics to `health_metrics`: the Apple Health webhook/HealthKit, Google Fit, and Oura. The hierarchy lives in **one** place, `utils/activitySources.js`:

```
apple (3)  >  google_fit (2)  >  oura (1)
```

Phone and watch sources report continuously; Oura only finalises a day the next morning, so on conflict the phone data is closer to the truth. A lower-priority source can still fill columns the higher one left empty, and a day written as all-zeros never locks out a later real value.

Previously each upsert only guarded against overwriting `'apple'`, leaving Google Fit and Oura to overwrite each other — the same day showed different step counts depending on which sync ran last that hour. `tests/test-activity-sources.js` pins this down by writing the same data in both orders and asserting the result is identical.

### Dates are always Europe/Warsaw

Google Fit's `dataset:aggregate` aligns its daily buckets to the **start of the requested window**, not to UTC or any timezone. The window therefore starts at Warsaw midnight (`getWarsawDayStartMillis`), and because `durationMillis` is a fixed 24 h, buckets are labelled by their **midpoint** so the week containing a DST change still maps to seven distinct, consecutive days. `tests/test-dates.js` covers both DST transitions and the year boundary.

### Translation coverage

`npm run check-i18n` (in `frontend/`) cross-checks every `t('…')` literal against the dictionary in `utils/i18n.js` and reports three things: missing translations, texts hardcoded in JSX despite having a translation, and stale dictionary entries.

**430 strings now go through `t()`**, up from 13 — switching the language actually translates the interface. `t()` also warns in the console (dev builds only) whenever a translation is missing, so future drift is visible instead of silent.

A handful of Polish literals remain unwrapped on purpose, and the check lists them:

- **Keyword matchers** — `'siłownia'`, `'pływ'`, `'różeniec'` are compared against workout and supplement names with `.includes()`. Wrapping them in `t()` would change what the code *matches*, not what it *shows*, and silently break the matching in English.
- **Comparison operands** — e.g. `recentCategory !== 'Prawidłowe'`, where the value comes from the backend.
- **Comments** — Polish prose inside `//` and `{/* */}` is covered by the separate code-language rule in `CLAUDE.md`, not by `t()`.

> [!NOTE]
> The dictionary keys are the Polish source strings themselves, so changing Polish copy silently breaks its translation. `npm run check-i18n` is what catches that: it matches **exact** occurrences only. An earlier version used a substring match and reported 61 hardcoded strings where only 43 were real — `"Zaloguj się"` was matching inside `"Sesja wygasła. Zaloguj się ponownie."`. Wrapping a hit like that would have torn the sentence in half.

About 150 dictionary entries match no string in the code. They are pre-written translations for wording that has since changed; they are kept rather than deleted, because the English text is still useful when that part of the UI is revisited.

---

## 🛠️ Architecture and Technologies

*   **Backend**: Node.js + Express
*   **Database**: SQLite (local file in the `/data` directory mounted as a volume)
*   **Frontend**: React (Vite) styled in a modern dark theme with glassmorphism effects
*   **Containerization**: two images on GHCR (Node.js API, nginx serving the SPA), deployed to k3s by a Helm chart and Argo CD

---

## 💻 How to Run Locally (Development)

### Requirements
*   **Node.js 24** (the version CI and the images use; sqlite3@6 needs at least 20.17) and **npm** installed

### Quick Start
1.  Grant execution permissions to the startup script and run it:
    ```bash
    chmod +x scripts/start.sh
    ./scripts/start.sh
    ```
2.  Copy the environment template and paste your Google AI Studio API key into `backend/.env`:
    ```env
    GEMINI_API_KEY=YOUR_API_KEY_HERE
    ```
3.  Start the backend server:
    ```bash
    cd backend
    npm start
    ```
4.  The application will be available at: `http://localhost:3000` (with automated proxying for the frontend).

---

## ☸️ Deployment (k3s + Argo CD)

Production runs on a single-node **k3s** cluster on the RenaCode VPS, deployed by **Argo CD** from the Helm chart in [`charts/dietetyk`](charts/dietetyk). Nothing is built or edited on the server: the code reaches production only through `main`.

### Pipeline: push → images → tag bump → Argo CD

1.  **CI** (`.github/workflows/docker-publish.yml`) runs on every push to `main`:
    *   `test-backend` — `npm audit` of production dependencies (high/critical blocks the run, no exceptions are whitelisted) and `npm test`;
    *   `test-frontend` — `npm audit` of the frontend;
    *   `test-e2e` — Playwright against a throwaway database.
2.  **Images**: `build-backend` / `build-frontend` start only when their own tests **and** E2E passed, and only for the service whose files changed (`dorny/paths-filter`; `workflow_dispatch` builds both). They push `ghcr.io/renacode/dietetyk-ai-{backend,frontend}` tagged `latest` and `sha-<commit>`. Base images are pinned by digest (Node 24 LTS on Debian trixie for the backend — see the comment in `docker/backend.Dockerfile` on why not bookworm).
3.  **Tag bump**: `update-git` writes `sha-<commit>` into `charts/dietetyk/values.yaml` and pushes `chore: update image tags to sha-… [skip ci]` to `main` with the `DEPLOY_PAT` secret (`main` is protected; the PAT is the bypass).
4.  **Argo CD** (Application `dietetyk` in the `renacode-infra` repo: `path: charts/dietetyk`, namespace `default`, automated sync with prune + self-heal) sees the new tag and rolls the pods.

A red E2E therefore stops the release before anything reaches the registry or `values.yaml`.

### What the chart deploys

| Object | Notes |
|---|---|
| backend `Deployment` | Node API on :3000, runs as uid 1000, liveness/readiness on `GET /api/healthz`. Data on a PVC (`persistence`, `local-path`) mounted at `/app/data`. |
| frontend `Deployment` | nginx serving the built SPA and proxying `/api` to the backend; its config is the ConfigMap in `templates/nginx-configmap.yaml`, **not** `docker/nginx.conf`. |
| `Ingress` | Traefik, host `dietetyk.renacode.com`, TLS from cert-manager (`letsencrypt-prod`). |
| `NetworkPolicy` | On by default (`networkPolicy.enabled`): the backend accepts only the frontend pod on :3000, the frontend only Traefik on :80. Egress (`networkPolicy.egress`) blocks the private networks listed in `networkPolicy.egress.siecDomowa`, which is empty in this public repository and set by the cluster operator in the Argo CD Application's `valuesObject`; everything else outbound is open. Rollback: `enabled: false` (or `egress.enabled: false` for egress alone) and let Argo CD sync. Covered by `backend/tests/test-chart.js`. |
| sqlite-web sidecar | Opt-in (`dbImage.enabled`, off): it has no authentication. Enable only for a debugging session and reach it with `kubectl port-forward`. |

### Backend configuration (secrets)

The backend `.env` is the `dotenv` key of the Kubernetes Secret `dietetyk-backend-secret`, mounted at `/app/.env`. It is created by hand on the cluster, never committed:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
APP_PASSWORD=<openssl rand -hex 32>
OAUTH_STATE_SECRET=<a second, different openssl rand -hex 32>
```

> [!NOTE]
> `GEMINI_MODEL` is optional — omit it and the backend uses `gemini-2.5-flash`. Earlier revisions of this README recommended `gemini-1.5-flash`, which returns 404 in the current SDK; `config.js` substitutes the working model and logs a warning at startup.
>
> `APP_PASSWORD` is the key material for encrypting integration secrets at rest (`utils/encryption.js`) — **not** a login password. Changing it makes stored Oura/Withings/Gemini credentials undecryptable, so it is rotated together with a re-encryption pass: see [`backend/docs/secret-rotation.md`](backend/docs/secret-rotation.md).
>
> `OAUTH_STATE_SECRET` signs the `state` parameter of the OAuth flows and is **required** — the backend refuses to start without it. Keep it different from `APP_PASSWORD`.

### Images must stay pullable

The cluster has **no** `imagePullSecrets` (`values.yaml`: `imagePullSecrets: []`): it relies on the `ghcr.io/renacode/dietetyk-ai-*` packages being **public**. If they turn private, new pods sit in `ImagePullBackOff` while the old ones keep serving — a failed deploy that does not look like an outage. To check:

```bash
curl -s "https://ghcr.io/token?scope=repository:renacode/dietetyk-ai-backend:pull&service=ghcr.io"
```

A `token` in the answer means the package is public and the problem is elsewhere (e.g. the tag); `UNAUTHORIZED` means it is private. Either make it public again, or create a pull secret (`scripts/create-ghcr-secret.sh`) and list it in `imagePullSecrets`.

### Verifying a deploy

```bash
kubectl -n default get pods -l app.kubernetes.io/instance=dietetyk -w
kubectl -n default describe pod <pod> | grep -A5 Events   # the real pull/probe error
kubectl -n default logs deploy/dietetyk-backend --tail=50
curl -s https://dietetyk.renacode.com/api/healthz
```

Argo CD shows the synced revision; it should match the last `chore: update image tags` commit on `main`.

### Database backups

The backend backs up its SQLite database every day at 04:30 Europe/Warsaw (`BACKUP_HOUR_LOCAL`, `HH:MM`) — before the host's off-site copy job picks up the newest file — and at startup when the newest copy is older than 24 hours. Copies go to `/app/data/backups` on the PVC with mode `0600`, keeping the newest copy of each of the last 14 days — see `backupDatabase` in `backend/db.js` and `scheduleDailyBackup` in `backend/server.js`.

**Every backup is verified before it counts.** Right after `VACUUM INTO` writes the copy, the backend reopens it read-only and runs `PRAGMA quick_check` plus a row-count sanity check. A copy that fails is deleted immediately and rotation is skipped, so a run of bad backups can never evict the last good ones.

Those copies sit on the same disk as the database. The **off-site** copy is the daily `renacode-kopia.timer` on the VPS (`backup/kopia.sh` in `renacode-infra`): it takes the newest verified backup out of the pod, encrypts it with `age` and pushes it to the private `RenaCode/renacode-backup` repository. Restoring is described in that repository's README; `scripts/verify_backup.sh <file>` checks that a copy opens, passes an integrity check and has non-empty core tables.

### Local Docker Compose (not production)

`docker-compose.yml` and `docker/nginx.conf` are the old single-VPS setup (certbot certificates, sqlite-web on :8081). Production no longer uses them, and neither does CI; they are kept only as a way to run the published images on one machine. The same goes for `scripts/setup-deploy-user.sh`, `deploy_pull.sh`, `deploy_sync.sh` and `vps_backup_db.sh`.

---

## 🔐 GUI Login and Admin Access

User accounts and default credentials are defined locally (saved in the database). On first run, the backend generates a random admin password and prints it once to the container log (see `[DB INIT]` in `db.js`) — you will be asked to change it on first login.

> [!WARNING]
> Do **not** keep credentials in a plaintext file inside the project directory. Older revisions of this README pointed to a `passwords.txt` in the project root — it held the VPS root password and the Oura/Withings client secrets alongside app logins. That file has been deleted; the credentials belong in a password manager.
>
> Being git-ignored was never enough protection: a plaintext file still lands in every directory backup, every `rsync`, every editor/IDE workspace index, and any `tar` of the project. Integration secrets belong in the **Settings** tab, where they are encrypted at rest (see `utils/encryption.js`); server credentials belong in a password manager and nowhere else.

Once logged in as an administrator (`admin`), you can navigate to the **Settings** or **Admin Panel** (available in the navigation menu for accounts with the `admin` role) to manage the global configuration of the application. Developer credentials for Oura Ring and Withings (needed for integration) are configured by each user individually in their own **Settings** tab.

---

## 🔌 Configuration of Integrations (Step-by-Step)

To automatically import sleep, activity, and body composition data from external sensors, and to allow the AI to analyze your diet using your own API key, enter the appropriate credentials in the **Settings** tab.

### 1. Oura Ring Integration (Sleep, HRV, Activity)
1.  Log in to your Oura account on the [Oura Developer Portal](https://developer.ouraring.com/applications).
2.  Click **"Create New Application"**.
3.  Fill in the application details (e.g., Name: `Dietetyk AI`, Description: `AI Dietician Application`).
4.  In the **"Redirect URIs"** field, add the following callback URL (replace `dietetyk.renacode.com` with your own domain if deployed elsewhere):
    `https://dietetyk.renacode.com/api/auth/oura/callback`
5.  Save the application. A **Client ID** and **Client Secret** will be generated.
6.  Copy and paste them into the Oura Ring section in the **Settings** tab of the Dietetyk AI app, click **"Save credentials"**, and then click **"Connect Oura"** to authorize the integration.

### 2. Withings Integration (Weight and Body Composition)
1.  Log in to your Withings account on the [Withings Developer Portal](https://developer.withings.com/).
2.  Navigate to the **Partner Dashboard**.
3.  Create a new developer application.
4.  For the **"Callback URL"** (Redirect URI), enter:
    `https://dietetyk.renacode.com/api/auth/withings/callback`
5.  Select the data scopes for weight and body composition.
6.  Once created, you will receive a **Client ID** and **Client Secret**.
7.  Copy these details and enter them in the Withings section in the **Settings** tab of the Dietetyk AI app, click **"Save credentials"**, and click **"Connect Withings"** to authorize the integration.

### 3. Apple Health Integration (Steps, Calories, Active Minutes)
Unlike Oura and Withings, Apple Health does not expose a public cloud API—data is sent from the phone via a webhook using the free **Health Auto Export** app (acting as a bridge between HealthKit and our backend).
1.  Install the **Health Auto Export** app from the App Store on your iPhone.
2.  Log in to Dietetyk AI, navigate to the **Settings** tab, and locate the **Apple Health** section. Copy the generated webhook URL (which contains your private sync token, e.g., `https://dietetyk.renacode.com/api/integrations/apple-health/<token>`). You can regenerate a new token if needed.
3.  In the Health Auto Export app, navigate to **Automations** and create a new **REST API** automation.
4.  Paste the copied URL as the destination address and set the format to **JSON**.
5.  Select the metrics: **Steps**, **Active Energy**, **Basal Energy Burned**, and **Apple Exercise Time**. If you also want to synchronize workouts, create a second automation for **Workouts** pointing to the same URL.
6.  Enable background delivery (e.g., hourly)—data will flow into `health_metrics` with `activity_source = 'apple'` and will show up on your Dashboard automatically.

> [!NOTE]
> When both Apple Health and Oura are active, Apple Health data is treated as the primary source for steps/calories/activity minutes (since it syncs immediately, while Oura usually finalizes its summary the next morning). Oura only fills in these metrics for days where Apple Health has not reported any data.

### 4. Google Fit Integration (Steps, Calories)
Unlike Apple Health (webhook) and Oura/Withings (per-user credentials), Google Fit uses OAuth2 and global Google credentials (Client ID/Secret) configured once by the administrator in the **Admin Panel** (the same keys used for Google Login). This means standard users do not need to register their own developer applications.
1.  The administrator must configure `google_client_id` and `google_client_secret` in the **Admin Panel** from the [Google Cloud Console](https://console.cloud.google.com/), with the Authorized redirect URI set to `https://dietetyk.renacode.com/api/auth/google-fit/callback` and the Fitness API enabled with scope `https://www.googleapis.com/auth/fitness.activity.read`.
2.  Each user navigates to the **Settings** tab, **Google Fit** section, and clicks **"Connect Google Fit"**.
3.  After choosing a Google account and accepting the permissions, data is synchronized automatically (hourly, between 5:00 and 22:00, and immediately upon connection).
4.  The integration can be disconnected at any time by clicking **"Disconnect Integration"**.

> [!NOTE]
> Google Fit timezone aggregation limits may cause a small (1-2h) shift relative to Europe/Warsaw time used by the rest of the application. Furthermore, Apple Health and Google Fit share the same priority (whoever writes last wins), while Apple Health always overrides Oura.

### 5. Linking an Existing Account with Google
If you already have an account created with a username/password and want to link it to a Google account for single-click login without losing history:
1.  Log in normally (username/password) and go to the **Settings** tab, **Google Account** section.
2.  Click **"Connect Google"** and choose the Google account you wish to link.
3.  From now on, you can log in using either method—both lead to the same account.
4.  You can unlink Google at any time by clicking **"Disconnect Google"** (login will then require your password).

### 6. Gemini AI Integration (API Key)
1.  Go to [Google AI Studio](https://aistudio.google.com/).
2.  Log in with your Google account.
3.  Click **"Get API Key"**.
4.  Click **"Create API Key"** (choose a new or existing Google Cloud project).
5.  Copy the generated key.
6.  Paste it in the Gemini AI section in the **Settings** tab of the Dietetyk AI app and click **"Save credentials"**. Once configured, meal analyses and dietary advice will use your personal quota.

---

## 🌍 Hosting and Contributions

*   **Hosting**: The production application is hosted at [https://dietetyk.renacode.com](https://dietetyk.renacode.com).
*   **Contributions**: Pull Requests (PRs) with improvements, bug fixes, or new features are highly encouraged.
*   **Main Branch**: The main branch of the repository (`main`) is protected by a GitHub Ruleset named `protect-main`, which means all changes must be submitted via Pull Requests and pass verification.
