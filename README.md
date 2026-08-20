# 🥗 Dietetyk AI (AI Dietician)

An aesthetically designed web application that analyzes your diet based on meals you enter (using **Gemini AI**), tracks health metrics from **Oura Ring** and **Withings** (smart scale and body composition) sensors, and visualizes trends on interactive charts.

The application supports full HTTPS encryption (SSL Let's Encrypt) and is ready to be deployed on a VPS server using Docker Compose.

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
8.  **Google Fit Synchronization**: Similar to Apple Health, the app can fetch steps and calories from Google Fit (hourly sync via OAuth2, without needing an intermediate app)—connect your account from the Settings tab.
9.  **Google Account Linking**: Connect an existing password-based account with your Google account in the Settings tab to sign in with a single click without losing your meal history and settings.
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

> [!WARNING]
> As of this writing the check reports **6% coverage**: only 13 strings actually go through `t()`, 61 have a translation but are hardcoded in JSX, and 127 dictionary entries match no string in the code. Switching the language to English therefore changes almost nothing on screen. `t()` now warns in the console (dev builds only) whenever a translation is missing, so the failure is at least visible — but wiring the remaining strings through `t()` is still outstanding work.

---

## 🛠️ Architecture and Technologies

*   **Backend**: Node.js + Express
*   **Database**: SQLite (local file in the `/data` directory mounted as a volume)
*   **Frontend**: React (Vite) styled in a modern dark theme with glassmorphism effects
*   **Containerization**: Docker + Docker Compose (Nginx with SSL reverse proxy + Node.js API + sqlite-web on port 8081)

---

## 💻 How to Run Locally (Development)

### Requirements
*   **Node.js** (version 18+) and **npm** installed

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

## ☁️ Deployment on a VPS Server (Docker Compose)

The backend and frontend images are built and published automatically by GitHub Actions (`.github/workflows/docker-publish.yml`) on every push to `main` and pushed to `ghcr.io`. The production server **does not build code locally**—it only needs `docker-compose.yml`, environment configuration files (`.env`), and the `./data` directory to pull and start the pre-built images.

> [!IMPORTANT]
> The application directory path on the server is always `/opt/dietetyk-ai` (lowercase), regardless of the fact that the repository on GitHub is named `Dietetyk-AI`.
> Specify this path explicitly as an argument when cloning with `git clone` (as shown below)—never let git name the directory automatically based on the repository name, as it will create a casing mismatch. The `/opt/dietetyk-ai` path is hardcoded in the CD deployment jobs and in `scripts/setup-deploy-user.sh`.

### Step 0: First Run - Dedicated `deploy` User
If this is the first server configuration (or you are migrating from an older, less secure setup where CI/CD logged in as `root`), run the script `scripts/setup-deploy-user.sh` as root on the VPS. It creates an unprivileged user `deploy` (in the `docker` group), moves the application to `/opt/dietetyk-ai`, and sets the permissions of the `./data` directory for the unprivileged `node` user inside the backend container. Details and subsequent manual steps (Secrets in GitHub, SSH key authorization) are described in the comments at the beginning of the script.

### Step 1: Clone the Repository on the VPS
This is only needed to obtain `docker-compose.yml`, `docker/nginx.conf`, and `backend/.env`—the application code is already packaged inside the images on `ghcr.io`.
```bash
git clone https://github.com/RenaCode/Dietetyk-AI.git /opt/dietetyk-ai
cd /opt/dietetyk-ai
```

### Step 2: Prepare Let's Encrypt Certificates
Install `certbot` on the host VPS and generate a certificate for your domain:
```bash
apt-get update && apt-get install -y certbot
certbot certonly --standalone -d dietetyk.renacode.com
```

### Step 3: Environment Configuration File `.env` on VPS
Create `/opt/dietetyk-ai/.env` and define paths to the generated certificates:
```env
SSL_CERT_PATH=/etc/letsencrypt/live/dietetyk.renacode.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/dietetyk.renacode.com/privkey.pem
```
In the directory `/opt/dietetyk-ai/backend/.env`, create the configuration for the backend:
```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
APP_PASSWORD=<a long random string, not a guessable phrase>
```

> [!NOTE]
> `GEMINI_MODEL` is optional — omit it and the backend uses `gemini-2.5-flash`. Earlier revisions of this README recommended `gemini-1.5-flash`, which returns 404 in the current SDK; `config.js` silently substitutes the working model and logs a warning at startup, so existing `.env` files keep working, but update the value to clear the warning.
>
> `APP_PASSWORD` is the key material for encrypting integration secrets at rest (`utils/encryption.js`) — **not** a login password. Changing it makes previously stored Oura/Withings/Gemini credentials undecryptable and they must be re-entered in Settings.
The `./data` directory must be writable by uid 1000 (`chown -R 1000:1000 ./data`)—the backend container runs internally as the unprivileged `node` user, not root.

### Step 4: Run the Containers
```bash
docker compose pull
docker compose up -d
```
After this step, every subsequent push to `main` will automatically refresh the containers via CI/CD (the `deploy` job in `docker-publish.yml`)—manual `docker compose pull/up` is only required for the first run.
The application will run on ports `80` and `443` (with automatic redirection to HTTPS).
The optional SQLite database web browser (sqlite-web) is only accessible **locally** on the VPS at `http://127.0.0.1:8081` (intentionally kept private as it does not have built-in authorization). Remote access requires an SSH tunnel from your computer:
```bash
ssh -L 8081:localhost:8081 deploy@<VPS_IP>
```
and then opening `http://localhost:8081` locally.

### Step 5: Database Backups
The backend automatically creates backups of the SQLite database (at startup and every 24 hours, keeping the last 14) in `./data/backups` on the VPS — see `backupDatabase` in `backend/db.js`.

**Every backup is verified before it counts.** Right after `VACUUM INTO` writes the copy, the backend reopens it read-only and runs `PRAGMA quick_check` plus a row-count sanity check. A copy that fails is deleted immediately and rotation is skipped, so a run of bad backups can never evict the last good ones. Without this, rotation would eventually leave you with 14 unreadable files and you'd only find out during a restore.

### Offsite copies (required for real protection)

Local backups sit on the same disk as the database, so they protect against corruption and bad migrations but **not** against host/disk failure. Point the backup script at a remote destination:

```bash
# /etc/cron.d/dietetyk-backup
0 3 * * * root OFFSITE_DEST=user@backup-host:/backups/dietetyk-ai/ /opt/dietetyk-ai/scripts/vps_backup_db.sh >> /var/log/db_backup.log 2>&1
```

`scripts/vps_backup_db.sh` makes a consistent copy (`VACUUM INTO` — never a plain `cp` of a live database, which can produce a torn, unrestorable file), verifies it, ships it offsite, and only then rotates old copies. If `OFFSITE_DEST` is unset it still works, but prints a warning that copies exist in one place only.

### Testing that a backup actually restores

```bash
scripts/verify_backup.sh                      # checks the newest backup
scripts/verify_backup.sh /path/to/copy.db     # checks a specific file
```

Exit code 0 means the file opens, passes an integrity check, and its core tables (`users`, `meals`, `health_metrics`, `settings`) are readable and non-empty. Worth running from cron as an independent watchdog — a backup nobody has ever opened is not a backup:

```bash
0 6 * * * root /opt/dietetyk-ai/scripts/verify_backup.sh || mail -s "Dietetyk AI: BACKUP USZKODZONY" you@example.com
```

---

## ☸️ Kubernetes (Helm chart)

The chart in `charts/dietetyk` deploys the backend, frontend and the sqlite-web browser. CI keeps the image tags in `values.yaml` pointing at the latest built `sha-<commit>`.

### Registry credentials — required

The `ghcr.io/renacode/*` packages are **private**. A private GHCR package issues no anonymous pull token, so without credentials the kubelet gets HTTP 401 and both pods sit in **`ImagePullBackOff`**.

This is easy to misdiagnose as a wrong or missing image tag — the symptom looks identical. To tell them apart, check whether the registry answers at all:

```bash
curl -s "https://ghcr.io/token?scope=repository:renacode/dietetyk-ai-backend:pull&service=ghcr.io"
```

`{"errors":[{"code":"UNAUTHORIZED"...}]}` means the package is private (credentials problem). A response containing a `token` means the package is public and the problem is the tag instead.

Docker Compose on the VPS does not hit this, because a one-off `docker login ghcr.io` leaves credentials in `~/.docker/config.json`. Kubernetes has no equivalent ambient login — every namespace needs its own pull secret:

```bash
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<PAT with read:packages scope> \
  --namespace=<release namespace>
```

The secret name is referenced by `imagePullSecrets` in `values.yaml`. If you would rather not manage a secret, make both packages public at `https://github.com/users/renacode/packages` and set `imagePullSecrets: null` — the images hold application code but no secrets, so this is a deliberate trade-off rather than a workaround.

### Verifying a deploy

```bash
helm upgrade --install dietetyk charts/dietetyk -n <namespace>
kubectl get pods -n <namespace> -w
kubectl describe pod <pod> -n <namespace> | grep -A5 Events   # shows the real pull error
```

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
