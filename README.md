# ethora-uptime

Uptime monitoring system for Ethora instances.

## Status model (green / amber / red)

Each check can be marked as:

- **critical**: affects instance rollup status (failures can make the instance **red**, missing data can make it **amber**)
- **optional**: never affects instance rollup status (still recorded + visible)

In config you can set:

- `severity: critical | optional`

By default, **journey** checks should be configured as `optional`.

## Run locally (Docker)

```bash
docker compose up --build
```

Open:
- `http://localhost:8099` (dashboard)
- `http://localhost:8099/api/summary` (JSON)

## UI

- `/` shows a wallboard with:
  - **Top rollup banner**: total green/amber/red instances, critical-OK fraction, optional-OK fraction.
  - **Tag filter chips**: filter visible cards by `tags` from `uptime.yml` (e.g. `public`, `enterprise`, `staging`).
  - **Show / Hide disabled instances** toggle (header).
  - **Theme toggle**: dark / light / wallboard (large-screen). Persisted in `localStorage`.
  - **Pause / Resume auto-refresh** with a visible 15s countdown.
- Per-card:
  - Coloured left border + status pill (GREEN / AMBER / RED).
  - Build info (version + commit + time) when the API exposes it via captures.
  - **Promoted Run buttons** for journey/push-validate checks at the top of each card (no need to expand the optional section first).
  - Critical checks always visible; optional/manual checks under an expander.
  - Each row shows: status icon, name (link → history), status text (truncated to fit, full message in tooltip), latency, "When" (relative time, hover for absolute), and a 24h **sparkline** (green/red bucketed).
  - Per-row `▶` (run now) and `⋯` (last-run details) actions.
  - **Journey "Run" → inline popover** (anchored to the button) for the optional Observer-room field — no full-screen modal until results come back.
- Click any check name to open history: `/history.html#<checkId>`.

### Status classification

Failures are split into three buckets so the wallboard reflects what an operator actually needs to act on:

- **service_fail** → instance turns RED. Indicates the monitored service is down.
- **checker_error** → instance turns AMBER. Indicates the uptime container itself failed (DNS, missing polyfill, missing env, refused connection). Don't page on these without first checking the uptime container.
- **skipped** → instance turns AMBER. Check is intentionally inert (e.g. `Missing env: ETHORA_*`).

The classification is computed server-side in `/api/summary`, so the UI just consumes `errorClass`.

## API

- `GET /api/summary`: rollup view for UI. Returns `{ generatedAt, totals: {...}, instances: [...] }`. Each check includes `severity`, `enabled`, `intervalSeconds`, `lastRunIso`, `lastRunAgoSeconds`, `errorClass` (`service_fail | checker_error | skipped`), and `noRunReason` (`manual_or_disabled | no_data_yet`) when there is no run yet.
- `GET /api/history?checkId=<id>&sinceMinutes=1440`: raw time series points.
- `GET /api/sparkline?checkId=<id>&sinceMinutes=1440&buckets=24`: bucketed pass/fail counts for the wallboard sparkline strip.
- `POST /api/run-check` with `{ "checkId": "instanceId:checkId" }`: run a check now and record the result.

## Local vs Public instances

The deploy template defines two instance types:

| Instance | Name suffix | What it checks |
|----------|-------------|----------------|
| **local** | (base name, e.g. "Astro Test") | Internal connectivity: uptime container → host services via `host.docker.internal` (API, MinIO) and → XMPP container via `xmpp:5280`. Use this to verify the stack works from inside Docker. |
| **public** | `_Public` (e.g. "Astro Test_Public") | External connectivity: internet → your server via public URLs (`https://api...`, `https://xmpp...`). Use this to verify TLS, Nginx, and DNS. |

- **Local red, Public green**: The uptime container cannot reach host services (e.g. `host.docker.internal` not resolving on Linux, or backend not listening). External access works.
- **Local green, Public red**: Internal stack is fine; external access is broken (DNS, firewall, SSL).

### Manual-only checks

If you want a check to **not** be scheduled, set:

- `enabled: false`

You can still run it from the UI “Run” button (or via `POST /api/run-check`).

## Synthetic apps (no analytics noise, full create/delete coverage)

Synthetic journeys used to create a fresh app per run (`uptime-journey-<random>`), which made HubSpot/Slack
report a "new app created" event every time, and cluttered the admin Apps list.

This is now solved with a small contract between the uptime container and the backend:

1. The uptime container uses a **stable per-mode displayName** for its synthetic apps:
   - `journey` (basic) → `__uptime__journey`
   - `journey_advanced` → `__uptime__journey_advanced`
   - `journey_b2b` → `__uptime__journey_b2b` (child app under the parent tenant)
2. **Each run still creates AND deletes the app**. The stable displayName is only there
   so the analytics bypass fires deterministically — it does NOT mean the app persists.
3. Before creating, the run sweeps any orphan apps with the same displayName (left over
   from a previous failed run) so leaks self-heal.
4. The backend recognises any `displayName` starting with `__uptime__` (or any request
   carrying `x-ethora-synthetic: 1`) and **skips marketing/CRM side-effects** for it:
   no HubSpot form submission, no future Slack notifications, no welcome flow.

Result:
- Full regression coverage of `POST /v1/apps`, `POST /v2/apps`, `DELETE /v1/apps/:id`,
  `DELETE /v2/apps/:id` on every uptime tick.
- Zero HubSpot/Slack noise.
- Admin Apps list never accumulates synthetic apps — they exist only for the brief
  duration of an in-flight run.
- If a run dies mid-way, the next run automatically deletes the orphan(s) and reports
  the cleanup count in the wallboard "Details" modal (`cleaned N orphans` pill).

If you want to keep the old behaviour, override `ETHORA_APP_NAME_PREFIX` in `uptime.env`
to a non-`__uptime__` prefix — but you'll lose the analytics suppression too.

## Journey modes

There are three supported journey levels (configured via `checks[].id`).
Each one uses its own distinct stable displayName so they can run concurrently.

### `journey` (basic)

Covers the core admin/end-user flow:

- `GET /v1/apps/get-config` — base app config + appToken resolution
- `POST /v1/users/login-with-email` — admin login
- `GET /v1/users/me` — verify admin user JWT works
- `GET /v1/apps` — orphan sweep (find any leftover synthetic apps)
- `POST /v1/apps` — create the synthetic app
- `PUT /v1/apps/{id}` — exercise app-settings update
- `POST /v2/users/sign-up-with-email/` — sign up N test users
- `POST /v2/users/login-with-email` — log in test users
- `POST /v1/chats` — create a chat
- `POST /v1/chats/users-access` — add a member
- `DELETE /v1/chats` — delete the chat (cleanup)
- `POST /v1/users/delete-many-with-app-id/{id}` — delete users (cleanup)
- `DELETE /v1/apps/{id}` — delete the synthetic app (cleanup)

### `journey_advanced`

Same as basic, plus:

- 2 chats (Test + Validation)
- Membership add/remove + post-removal join-denied check
- XMPP WebSocket join + groupchat delivery confirmation
- File upload via `POST /v1/chats/media/{chatName}` + media stanza delivery + public file access
- Optional sharelink lifecycle: `POST /v2/files/` → `POST /v1/sharelink` → `GET /v1/sharelink/` → `DELETE /v1/sharelink/{token}` → `DELETE /v2/files/{id}`
  (skipped gracefully if the install does not have the v2 files / sharelink modules enabled)

### `journey_b2b` (tenant / B2B admin)

Signs a server token locally with the parent tenant's secret and exercises the
tenant-actor API surface:

- `GET /v2/apps` — orphan sweep
- `POST /v2/apps` — create child app
- `GET /v2/apps/{appId}` — fetch app
- `PATCH /v2/apps/{appId}` — update app settings
- `POST /v2/apps/{appId}/provision` — provision default rooms
- `GET /v2/apps/{appId}/bot` + `PUT /v2/apps/{appId}/bot` — AI bot read/update (optional; skipped if AI service is unavailable)
- `POST /v2/apps/{appId}/tokens` + `GET /v2/apps/{appId}/tokens` + `POST /v2/apps/{appId}/tokens/{tokenId}/rotate` + `DELETE /v2/apps/{appId}/tokens/{tokenId}` — full app-token lifecycle
- `POST /v2/apps/{appId}/users/batch` + `GET /v2/apps/{appId}/users/batch/{jobId}` + `DELETE /v2/apps/{appId}/users/batch` — async user batch
- `POST /v2/apps/{appId}/chats` + `PATCH /v2/apps/{appId}/chats/{chatId}` + `DELETE /v2/apps/{appId}/chats` — chat lifecycle
- `POST /v2/apps/{appId}/chats/users-access` + `DELETE /v2/apps/{appId}/chats/users-access` — chat membership
- `GET /v2/apps/{appId}/users/{userId}/chats` — user chat list
- `POST /v2/apps/{appId}/chats/broadcast` + `GET /v2/apps/{appId}/chats/broadcast/{jobId}` — async broadcast (skipped gracefully if 5xx)
- `DELETE /v2/apps/{appId}` — delete the child app (cleanup)

### Optional manual journeys (run on demand from the wallboard)

These are configured with `enabled: false` and `intervalSeconds: 0` in
`uptime.yml`, so they never run on a schedule. They show up in the wallboard's
"Optional & manual checks" section with a `▶` button. Use them after install /
update for QA, or ad-hoc to confirm a specific area still works.

| `checks[].id` | What it covers |
|---|---|
| `journey_token_refresh` | `POST /v1/users/login` → `POST /v1/users/login/refresh` → `GET /v1/users/me` with the refreshed token |
| `journey_signup_validation` | `POST /v1/apps/check-domain-name` + `GET /v1/users/checkEmail/{email}` |
| `journey_password_reset` | `POST /v1/users/forgot` for an existing user, then `POST /v1/users/reset` with a deliberately invalid token (expect 4xx). Does NOT roundtrip the email. |
| `journey_app_stats` | `GET /v1/apps/graph-statistic/{appId}` + `GET /v1/apps/{id}` |
| `journey_user_tags` | `POST /v1/users/tags-add/{appId}` + `tags-set` + `tags-delete` |
| `journey_chat_reports` | Public chat + `POST /v1/chats/reports/{chatName}` (moderation flow) |
| `journey_v1_files` | `POST /v1/files/` + `GET /v1/files/` + `GET /v1/files/{id}` + `DELETE /v1/files/{id}` |
| `journey_private_chat` | `POST /v1/chats/private` + `GET /v1/chats/my` |
| `journey_v2_user_chats` | `POST /v2/chats` + `GET /v2/chats/users` + `PATCH /v2/chats/users` |

All manual journeys (except `token_refresh` and `signup_validation`) create + delete
their own dedicated synthetic app per run, with the same `__uptime__journey_<mode>`
display-name contract for analytics suppression and orphan recovery.

### Required env for **basic** journey

- `ETHORA_API_BASE` (e.g. `http://host.docker.internal:8080`)
- `ETHORA_BASE_DOMAIN_NAME` (base app domain slug)
- `ETHORA_ADMIN_EMAIL`
- `ETHORA_ADMIN_PASSWORD`

Optional:
- `ETHORA_APP_NAME_PREFIX` — kept for backwards compatibility but no longer used to mint new app names by default. The journey now uses the hard-coded `__uptime__journey` displayName so the backend can suppress HubSpot/Slack analytics.
- `ETHORA_USERS_COUNT`

### Additional env for **advanced** journey

Advanced mode requires XMPP websocket connectivity to validate message delivery:

- `ETHORA_XMPP_SERVICE` (e.g. `ws://xmpp:5280/ws`)
- `ETHORA_XMPP_HOST` (e.g. `localhost` or your XMPP domain)
- `ETHORA_XMPP_MUC_SERVICE` (optional; defaults to `conference.<XMPP_HOST>`)

### Additional env for **B2B** journey

The B2B journey signs a server token locally and exercises the tenant/admin API surface:

- `ETHORA_B2B_APP_ID`
- `ETHORA_B2B_APP_SECRET`

Compatibility fallback:

- `ETHORA_CHAT_APP_ID`
- `ETHORA_CHAT_APP_SECRET`

if the `ETHORA_B2B_*` variables are not set.

## Push validation check (optional)

There is an optional check type:

- `type: push_validate`

It logs into the Ethora API using the same env vars as journeys (`ETHORA_API_BASE`, `ETHORA_BASE_DOMAIN_NAME`, `ETHORA_ADMIN_EMAIL`, `ETHORA_ADMIN_PASSWORD`)
and calls `POST /v1/push/validate/{appId}` to perform a Firebase **dry-run** validation.

## Operator observer room (watch journeys live)

By default, journey runs create their own temporary chats and operate there (so membership/removal tests are isolated).

If you want to **watch a journey run live** in an existing chat room, you can provide an *observer room* and the journey
will stream high-level progress updates into that room (best-effort).

- **From the UI**: click **Run** on a journey check and enter an **Observer room JID / name** when prompted.
- **From env (default for all runs)**: set `ETHORA_JOURNEY_OBSERVER_ROOM` to a room name or full room JID.

Notes:
- The observer room is **not** used for the journey’s membership tests; it’s only an operator “log stream”.
- You can paste either:
  - a full room JID like `APPID_operator@conference.xmpp.example.com`, or
  - a short room name / suffix like `operator` (it will be prefixed as `APPID_operator` for multi-tenant ejabberd).

## Running modes

### Always-on (recommended)

Run the server continuously; it schedules each check by `intervalSeconds` and records results.

### Cron / one-shot mode

If you prefer running checks via cron:

- Build once: `npm run build`
- Run one tick and exit: `node dist/runOnce.js`

## Notes

- This project is intended to be used both as a standalone public repo and as a monoserver module (git submodule).
