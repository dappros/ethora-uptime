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

## Running modes

### Always-on (recommended)

Run the server continuously; it schedules each check by `intervalSeconds` and records results.

### Cron / one-shot mode

If you prefer running checks via cron:

- Build once: `npm run build`
- Run one tick and exit: `node dist/runOnce.js`

## Notes

- This project is intended to be used both as a standalone public repo and as a monoserver module (git submodule).
