# Secret rotation: `APP_PASSWORD` and `OAUTH_STATE_SECRET`

A runbook for a human operator with `kubectl` access to the k3s cluster on the VPS.

## Read this first: order, or a CrashLoopBackOff

**`OAUTH_STATE_SECRET` must be in the `dietetyk-backend-secret` Secret BEFORE — or in the same
maintenance step as — the deploy of the code that requires it.** The backend now refuses to
start without that variable (`services/oauthHelpers.js`), and the production Secret does not
contain it today. Deploy first and add the variable later and the new pod goes into
CrashLoopBackOff.

What that failure actually looks like, so nobody misreads it: the Deployment runs one replica
with the default rolling-update strategy, so Kubernetes starts the new pod *before* removing the
old one and the old pod keeps serving traffic while the new one crash-loops. The site does not go
dark at that instant. What you get instead is a rollout that never completes
(`kubectl rollout status` hangs), an application that is one pod eviction or node reboot away
from being fully down, and — within 15 minutes — an alert e-mail from the monitoring CronJob,
which treats `CrashLoopBackOff` as a permanent failure (`renacode-infra`,
`charts/monitoring/czujka/reguly.py`).

The safe order is not a workaround, it is free: **Runbook A below can be done today, before the
new image is anywhere near production.** The currently deployed code already reads
`OAUTH_STATE_SECRET` when it is present — it only *falls back* to `APP_PASSWORD` when it is
missing (`git show 4431587:backend/services/oauthHelpers.js`, the commit behind the
`sha-4431587` tag in `charts/dietetyk/values.yaml`). Adding the variable therefore improves
security immediately, on the code that is running right now, and makes the later deploy a
non-event.

## Where production configuration actually lives

| Fact | Where |
|---|---|
| Deployment | k3s on the VPS, namespace `default`, `Deployment/dietetyk-backend` (containers `backend` + `db-viewer`) |
| Delivery | ArgoCD application `dietetyk`, source `charts/dietetyk` of this repo, `prune: true`, `selfHeal: true` (`renacode-infra/argocd-apps.yaml`) |
| Configuration | Secret `dietetyk-backend-secret`, key `dotenv` — the **entire** `.env` file, mounted read-only as `/app/.env` (`charts/dietetyk/templates/backend-deployment.yaml`) |
| Database | PVC `dietetyk-data-pvc` (`local-path`, 2Gi) mounted at `/app/data`; `DATABASE_DIR=/app/data` |
| Backups | `/app/data/backups/` on that same PVC — `db.js` writes them under `DATABASE_DIR` |

Two consequences that shape everything below:

- **Changing configuration means replacing the `dotenv` key of that Secret and restarting the
  Deployment.** There is no file on the host to edit. The `dotenv` value is the whole file, so an
  edit is: read it out, change one line, write the whole thing back.
- **The Secret is not created by the chart.** `charts/dietetyk/templates/` contains no Secret
  template; `values.yaml` only *references* the name (`backend.secretName`). It is therefore not
  part of the ArgoCD application's desired state, so `selfHeal` will not revert your edit and
  `prune` will not delete it. The flip side: the only copy of that Secret is the one in the
  cluster — nothing in git, nothing in a backup. **Save a copy before you replace it** (step A1),
  and keep that copy outside any repository.

> **OUTDATED:** `docker-compose.yml`, `/opt/dietetyk-ai/backend/.env` and the `docker compose`
> steps in the README are left over from the pre-k3s era and are no longer the production path.
> Do not run them — they will change nothing that the live application reads.

## What each secret protects

| Variable | Used for | Rotating it affects |
|---|---|---|
| `APP_PASSWORD` | key material for `ENCRYPTION_KEY` (`utils/encryption.js`) | every `enc:v1:` value in the database — see below |
| `OAUTH_STATE_SECRET` | HMAC over the OAuth `state` parameter (`services/oauthHelpers.js`) | only OAuth links in flight at that second |

Encrypted columns (the full list, from `utils/secretKeys.js` and `oauth_tokens`):

- `oauth_tokens.access_token`, `oauth_tokens.refresh_token` (Oura, Withings, Google Fit)
- `settings.gemini_api_key`, `settings.oura_client_secret`, `settings.withings_client_secret`
- `app_config.mailgun_api_key`, `app_config.google_client_secret`

**Not** derived from either secret, and therefore untouched by rotation:

- user passwords (bcrypt hashes, `users.password`)
- session tokens (`sessions.token` — `crypto.randomBytes` in `routes/auth.js`, stored as-is)
- sync tokens (`users.sync_token`, likewise random)

So nobody is logged out by a rotation, and no password has to be reset.

## Why this is being done at all

`backend/.env.example` used to ship a **concrete** `APP_PASSWORD` value (not a
`your_..._here` placeholder), and the same value appeared again in
`.github/workflows/docker-publish.yml`. Both are placeholders / generated per CI run now, but
that does not undo anything: if the production Secret ever carried the committed value, then

- `ENCRYPTION_KEY = scrypt(APP_PASSWORD, 'dietetyk-ai:field-encryption:v1')`
  (`backend/utils/encryption.js`) can be recomputed by anybody who read the repository, so a copy
  of `dietetyk.db` — from `/app/data/backups/`, from the PVC on the node, or through the
  `db-viewer` (sqlite-web) container — decrypts fully. "Encrypted at rest" was really
  "obfuscated at rest".
- `OAUTH_STATE_SECRET` fell back to `APP_PASSWORD`, so the HMAC on the OAuth `state` parameter
  was forgeable. A forged `<victimId>:google_link:<salt>:<hmac>` plus consent on the attacker's
  own Google account made `routes/auth.js` write the attacker's `google_id` onto the victim's
  user row — after which the ordinary "Sign in with Google" button hands out a session for the
  victim's account.

## Order of operations for `APP_PASSWORD`

`APP_PASSWORD` → `ENCRYPTION_KEY` → the ciphertext in the database. Change the first and the
third stops being readable, because AES-GCM authentication fails under the new key. The failure
is loud but late: the pod starts and passes its health check, and the damage only shows up when
something tries to *use* a secret — an Oura/Withings/Google Fit sync, an AI call with a user's
own Gemini key, a Mailgun send. Nothing is destroyed (the ciphertext stays in the table, and a
failed decrypt throws instead of deleting the row — token rows are only deleted on a 4xx from the
provider), so putting the old value back restores service. But until you do, the integrations are
down.

Therefore: **re-encrypt in the same maintenance window in which you change the value.**

---

## Runbook A — add `OAUTH_STATE_SECRET` to the Secret

Do this first. It is independent of the code deploy, needs no database work, and is what keeps
the deploy from crash-looping.

1. **Back up the current Secret** (the only copy that exists) and keep it off the repo:

   ```bash
   kubectl get secret dietetyk-backend-secret -n default -o jsonpath='{.data.dotenv}' \
     | base64 -d > ~/dotenv.backup
   ```

2. Build the new content — the whole file plus one line:

   ```bash
   cp ~/dotenv.backup ~/dotenv.new
   printf 'OAUTH_STATE_SECRET=%s\n' "$(openssl rand -hex 32)" >> ~/dotenv.new
   grep -c '^OAUTH_STATE_SECRET=' ~/dotenv.new   # must print exactly 1
   ```

3. Replace the Secret. `--dry-run=client -o yaml | kubectl apply -f -` rewrites the whole object,
   which is why step 1 is not optional:

   ```bash
   kubectl create secret generic dietetyk-backend-secret -n default \
     --from-file=dotenv=$HOME/dotenv.new --dry-run=client -o yaml | kubectl apply -f -
   ```

4. Restart the Deployment so the process re-reads `/app/.env` (the mounted file refreshes on its
   own within about a minute, but the backend only reads it at startup):

   ```bash
   kubectl rollout restart deploy/dietetyk-backend -n default
   kubectl rollout status deploy/dietetyk-backend -n default
   ```

5. Verify one OAuth link end to end (Settings → connect Oura, or "Sign in with Google").

6. Remove the plaintext copies from the machine you worked on:

   ```bash
   shred -u ~/dotenv.new    # keep ~/dotenv.backup only until the change is confirmed, then shred it too
   ```

Any OAuth flow a user had *in progress* during the restart — already redirected to the provider,
not yet back — fails with an invalid state and has to be started again. The window is seconds and
the cost is one retry of something they clicked themselves.

---

## Runbook B — rotate `APP_PASSWORD` (with re-encryption)

You need the **old** value at hand before you start; without it the encrypted data cannot be
migrated at all. Requires the deployed image to contain `scripts/reencrypt-secrets.js` — that is,
an image built from the commit that added it.

### Why a Job with the Deployment scaled down, and not `kubectl exec`

`kubectl exec` into the running pod is the wrong tool here, for two independent reasons:

1. **Two writers.** The live backend refreshes OAuth tokens on a timer (`scheduler.js`), and the
   `db-viewer` sidecar can write to the same file. A migration racing a token refresh gives you a
   database with some rows under the old key and some under the new one — the one state the
   script's transaction cannot protect you from, because it happens outside it.
2. **A live process cannot be switched over.** `ENCRYPTION_KEY` is derived once when
   `utils/encryption.js` is loaded. After the migration commits, the still-running pod would keep
   writing values under the *old* key and failing to read the new ones until it is restarted.

Scaling the Deployment to 0 solves both at once and is cheap here: `backend` and `db-viewer` are
containers of the **same** pod, and no other workload mounts the PVC (only
`backend-deployment.yaml` references `dietetyk-data-pvc`), so one `scale` removes every writer.
A Job then mounts the same PVC — `ReadWriteOnce` is no obstacle on a single-node cluster once the
Deployment's pod is gone — runs once, and exits.

### Steps

1. **Stop ArgoCD from fighting you.** `replicaCount: 1` *is* in git and the application runs with
   `selfHeal: true`, so a `kubectl scale --replicas=0` gets reverted automatically within a minute
   or two — in the middle of your migration. Suspend automated sync first:

   ```bash
   kubectl patch application dietetyk -n argocd --type merge \
     -p '{"spec":{"syncPolicy":{"automated":null}}}'
   ```

   Nothing manages the ArgoCD `Application` objects themselves (`renacode-infra/argocd-apps.yaml`
   is applied by hand), so this patch stays until you undo it in step 8. Undoing it is a required
   step, not a courtesy — a cluster left with auto-sync off stops receiving deploys silently.

2. Generate the new value and keep both old and new at hand:

   ```bash
   openssl rand -hex 32
   ```

3. Scale the backend down and wait for the pod to actually disappear:

   ```bash
   kubectl scale deploy/dietetyk-backend -n default --replicas=0
   kubectl wait --for=delete pod -n default -l app.kubernetes.io/component=backend --timeout=120s
   kubectl get pod -n default -l app.kubernetes.io/component=backend
   ```

   `kubectl wait` printing "no matching resources found" means the pod is already gone, which is
   what you want; the `get` afterwards is the check that actually matters — it must list nothing.

4. Put the **new** `APP_PASSWORD` into the Secret, the same way as in Runbook A (back up first,
   edit the one line in a copy of the whole file, `create --dry-run | apply`). Check free space on
   the PVC while you are there — the migration writes a full copy of the database next to it:

   ```bash
   sed -i 's/^APP_PASSWORD=.*/APP_PASSWORD=<new value>/' ~/dotenv.new
   ```

5. Run the migration as a one-off Job. Read the old password into a shell variable rather than
   typing it into the manifest, so it does not end up in your shell history, and take the image
   from the Deployment so the Job runs exactly the code that is deployed:

```bash
read -rs -p 'old APP_PASSWORD: ' OLD_APP_PASSWORD; echo
IMAGE=$(kubectl get deploy dietetyk-backend -n default \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="backend")].image}')
echo "$IMAGE"   # must be the tag built from the commit that added scripts/reencrypt-secrets.js
```

The block below is deliberately at the left margin: it is a heredoc, and a closing `EOF` pasted
with leading spaces does not terminate it — the shell would just sit there waiting for input.

```bash
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: dietetyk-reencrypt
  namespace: default
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: reencrypt
          image: ${IMAGE}
          command: ["node", "scripts/reencrypt-secrets.js"]
          env:
            - name: DATABASE_DIR
              value: "/app/data"
            - name: APP_PASSWORD_OLD
              value: "${OLD_APP_PASSWORD}"
          volumeMounts:
            - name: data-volume
              mountPath: /app/data
            - name: env-volume
              mountPath: /app/.env
              subPath: .env
      volumes:
        - name: data-volume
          persistentVolumeClaim:
            claimName: dietetyk-data-pvc
        - name: env-volume
          secret:
            secretName: dietetyk-backend-secret
            items:
              - key: dotenv
                path: .env
EOF

kubectl logs -f job/dietetyk-reencrypt -n default
```

   The new `APP_PASSWORD` comes from the mounted `.env`; only the old one is passed in. The script
   decrypts every value with the old key **in memory first** and aborts before writing anything if
   a single one fails, takes a verified `pre-rotation-<timestamp>.db` copy into
   `/app/data/backups/`, and applies all writes in one transaction — so the database ends up
   entirely on the old key or entirely on the new one, never half. It never logs a secret value,
   only row counts and column names.

6. **Delete the Job as soon as you have read its log.** Until you do, the old password sits in the
   Job's pod spec in etcd, readable with `kubectl get job -o yaml`:

   ```bash
   kubectl delete job dietetyk-reencrypt -n default
   unset OLD_APP_PASSWORD
   ```

7. Scale back up and verify against the integrations, not just the login page:

   ```bash
   kubectl scale deploy/dietetyk-backend -n default --replicas=1
   kubectl rollout status deploy/dietetyk-backend -n default
   kubectl logs deploy/dietetyk-backend -n default -c backend --tail=50
   ```

   - trigger a manual sync for an account that has Oura/Withings/Google Fit connected,
   - run one AI request for a user with their own Gemini key configured,
   - send a test e-mail (Mailgun) from the admin panel.

   Masked `********` fields in Settings prove nothing — the mask is applied without decrypting.

8. **Re-enable ArgoCD automated sync** (the values match `renacode-infra/argocd-apps.yaml`):

   ```bash
   kubectl patch application dietetyk -n argocd --type merge \
     -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
   kubectl get application dietetyk -n argocd -o jsonpath='{.spec.syncPolicy}{"\n"}'
   ```

9. Only after the verification in step 7, delete the pre-rotation copy — it is a complete database
   readable with the **old** password:

   ```bash
   kubectl exec deploy/dietetyk-backend -n default -c backend -- \
     sh -c 'ls -la /app/data/backups/ && rm -f /app/data/backups/pre-rotation-*.db'
   ```

**Rollback** (any step fails): scale to 0, restore the pre-rotation copy over
`/app/data/dietetyk.db` from inside a Job or the `db-viewer` container (both mount the same PVC),
put the old `APP_PASSWORD` back into the Secret, scale to 1, then re-enable auto-sync.

---

## Transition period: two accepted secrets, or one-off invalidation?

**Recommendation: neither — a single cutover, for both secrets.** No `APP_PASSWORD_OLD` accepted
at runtime, and no wiping of user data.

- **For `OAUTH_STATE_SECRET`**, a dual-secret window would mean continuing to accept state signed
  with the old secret — the very secret being retired for being forgeable. It would keep the
  account-takeover path open for the length of the window in exchange for saving a handful of
  users one retry. `state` lives for the seconds between the redirect and the callback; that is
  what makes the cutover free.

- **For `APP_PASSWORD`**, the tempting shortcut is a read-time fallback ("try the new key, then
  the old one"), which is what `SECRETS_KEY_OLD` does in the sibling Trader-AI project
  (`charts/trader/templates/workers.yaml`). That fits Trader-AI because it runs several worker
  pods that read data written by others and cannot all be cut over at one instant. Dietetyk AI is
  a single-replica Deployment over one SQLite file on one PVC: it can be scaled to zero, migrated
  and scaled back inside a few minutes. A read-time fallback here would keep the *public* key
  valid indefinitely, give no signal for when the last row has moved, and turn a bounded
  maintenance window into a permanent second key path — the migration would never finish.

- **One-off invalidation** (clear the encrypted columns and let everyone re-enter their keys) is
  worse than re-encryption on every axis: it disconnects every user's Oura/Withings/Google Fit,
  forces each of them to fetch their API keys again, and requires the admin to re-enter the
  Mailgun and Google OAuth secrets — all for no security gain, since re-encryption produces the
  same end state under the new key. Use it **only** if the old `APP_PASSWORD` has genuinely been
  lost, in which case there is no alternative.

- **Sessions** are a separate decision, not a consequence: nothing about them derives from either
  secret, so rotation leaves everyone logged in. If you believe a database copy leaked, invalidate
  them explicitly — `DELETE FROM sessions;` — which forces a fresh login everywhere.

## What rotation does *not* fix

Rotating `APP_PASSWORD` protects the database *from now on*. It does nothing for copies that
already exist:

- **Old backups.** Every `/app/data/backups/dietetyk-*.db` written before the rotation is still
  encrypted with the old key, on the same PVC that the `db-viewer` container also mounts.
  `backupDatabase()` in `db.js` keeps 14 copies, so they age out on their own — but if the old
  value was the one committed to the repository, delete them by hand:

  ```bash
  kubectl exec deploy/dietetyk-backend -n default -c backend -- \
    sh -c 'ls -la /app/data/backups/'
  ```

  Anything copied off the PVC earlier (an off-site backup, a file pulled to a laptop) is outside
  the cluster's reach entirely and has to be tracked down by hand.
- **The credentials inside the database.** If a copy of the `.db` ever left the server, treat every
  secret it contained as compromised regardless of the encryption: the Mailgun API key, the Google
  OAuth client secret, per-user Gemini keys, and the Oura/Withings/Google Fit access and refresh
  tokens. Re-encrypting them under a new key does not make an already-copied value secret again.
  Revoking and reissuing those downstream credentials is a separate task, and it is the one with
  the shortest deadline.
- **`ADMIN_INITIAL_PASSWORD`** in the e2e job of `.github/workflows/docker-publish.yml` is a
  literal on purpose: `e2e-tests/auth.spec.js` types the same string into the login form, and it
  only ever unlocks a throwaway database created inside the CI job. It is not key material and is
  not part of this rotation.

## Related files

- `charts/dietetyk/templates/backend-deployment.yaml` — the Secret mount, the PVC mount and
  `DATABASE_DIR`; the chart deliberately does **not** create `dietetyk-backend-secret`
- `backend/utils/encryption.js` — key derivation, `encrypt`/`decrypt`, and `deriveKey` /
  `encryptWith` / `decryptWith` for holding two keys at once during a migration
- `backend/scripts/reencrypt-secrets.js` — the old-key → new-key migration used in Runbook B
- `backend/scripts/encrypt-existing-secrets.js` — a *different* tool: it encrypts legacy plaintext
  with the current key and deliberately **skips** anything already carrying the `enc:v1:` prefix.
  After a password change every row carries that prefix, so it would skip all of them and report
  success while the database stayed unreadable. Do not reach for it here.
- `backend/services/oauthHelpers.js` — `OAUTH_STATE_SECRET`, `generateOAuthState`,
  `verifyOAuthState`
- `backend/tests/test-oauth-state.js` — guards both properties: a missing `OAUTH_STATE_SECRET`
  stops startup, and state signed with `APP_PASSWORD` is rejected
