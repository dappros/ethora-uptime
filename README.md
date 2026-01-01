# ethora-uptime

Uptime monitoring system for Ethora instances.

## Run locally (Docker)

```bash
docker compose up --build
```

Open:
- `http://localhost:8099` (dashboard)
- `http://localhost:8099/api/summary` (JSON)

## Configuration

The service reads a YAML config file (mounted into the container):

- Default path in Docker: `/config/uptime.yml`
- Example file: `config/uptime.example.yml`

## Notes

- This project is intended to be used both as a standalone public repo and as a monoserver module (git submodule).
