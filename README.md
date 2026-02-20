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

- `/` shows a wallboard view (per-instance rollup + critical checks)
- Optional checks are under “Optional checks” (expandable)
- Journey checks have a **Run** button (manual regression run)
- Click any check name to open history: `/history.html#<checkId>`

## API

- `GET /api/summary`: rollup view for UI
- `GET /api/history?checkId=<id>&sinceMinutes=1440`: time series points from DB
- `POST /api/run-check` with `{ "checkId": "instanceId:checkId" }`: run a check now and record the result

## Configuration

The service reads a YAML config file (mounted into the container):

- Default path in Docker: `/config/uptime.yml`
- Example file: `config/uptime.example.yml`

### Manual-only checks

If you want a check to **not** be scheduled, set:

- `enabled: false`

You can still run it from the UI “Run” button (or via `POST /api/run-check`).

## Journey modes

There are two supported journey levels (configured via `checks[].id`):

- `journey` → basic flow (app + users + 1 chat + add member)
- `journey_advanced` → comprehensive flow (2 chats, membership changes, XMPP delivery, file upload)

### Required env for **basic** journey

- `ETHORA_API_BASE` (e.g. `http://host.docker.internal:8080`)
- `ETHORA_BASE_DOMAIN_NAME` (base app domain slug)
- `ETHORA_ADMIN_EMAIL`
- `ETHORA_ADMIN_PASSWORD`

Optional:
- `ETHORA_APP_NAME_PREFIX`
- `ETHORA_USERS_COUNT`

### Additional env for **advanced** journey

Advanced mode requires XMPP websocket connectivity to validate message delivery:

- `ETHORA_XMPP_SERVICE` (e.g. `ws://xmpp:5280/ws`)
- `ETHORA_XMPP_HOST` (e.g. `localhost` or your XMPP domain)
- `ETHORA_XMPP_MUC_SERVICE` (optional; defaults to `conference.<XMPP_HOST>`)

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
