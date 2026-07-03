# 🔥 FlareCrawl

Self-hosted **browser-agent control plane** for `crawl.flare-labs.tech` — your own
Browserbase/Steel-Cloud. A pool of real Chrome browsers (Steel) driven by AI
prompts, with a **public live view**, admin dashboard, API keys, and per-key
concurrency limits.

- **Engine:** Steel (one browser per container) + a **hybrid AI brain** — DOM/text
  loop by default (works with non-vision models), optional screenshot+vision
  fallback (Llama-4 Scout) when the loop gets stuck.
- **Live view:** the gateway reverse-proxies Steel's screencast WebSocket at
  `/{PUBLIC}/live/<session>` — so it works remotely (no more `localhost:3300`).

## Quick start (ready-to-go)

```bash
cd /home/flare/labs/crawl
pnpm install
pnpm run setup      # asks: how many browsers? start port? admin pw? LLM key?
pnpm start          # or: systemctl --user start crawl
```

`setup` provisions everything: writes `.env`, starts Postgres, applies the schema,
and launches the Steel fleet across the chosen port range.

## Architecture

```
                 crawl.flare-labs.tech  (nginx, TLS, WS upgrade)
                              │
                    ┌─────────▼──────────┐
                    │  Gateway :4000     │  Fastify + Postgres
                    │  admin · api keys  │
                    │  concurrency · agent│
                    │  live-view WS proxy │
                    └───┬───────────┬─────┘
          ws /live/<id>/cast        │ POST /v1/sessions  /v1/agent
                    │               │
        ┌───────────▼───┐   ┌───────▼────────┐ ...  Steel fleet
        │ steel :3300   │   │ steel :3301    │      (1 browser each,
        └───────────────┘   └────────────────┘       ports FLEET_PORT_START+i)
```

## API

Authenticate with `Authorization: Bearer <fc_live_...>` (create keys in the admin UI).

- `POST /v1/sessions` → `{ sessionId, liveViewUrl, websocketUrl }`
- `POST /v1/agent` `{ task, startUrl?, maxSteps?, sessionId? }` → `{ sessionId, liveViewUrl, summary, steps, currentUrl, pageTitle }`
- `POST /v1/sessions/:id/release`
- `GET  /live/:sessionId` → public interactive live-view page

Admin UI at `/admin`.

## Ops

```bash
bash scripts/fleet.sh {start|stop|rm|count|health}   # manage the Steel fleet
systemctl --user {start|stop|status} crawl           # gateway
```

nginx vhost: `nginx/crawl.flare-labs.tech.conf` (WS-upgrade aware) → `certbot --nginx -d crawl.flare-labs.tech`.

## Config (`.env`)

`FLEET_SIZE`, `FLEET_PORT_START/END`, `DATABASE_URL`, `ADMIN_*`, `SESSION_SECRET`,
`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_TEXT_MODEL`, `LLM_VISION_MODEL` (empty = DOM only),
`AGENT_MAX_STEPS`, `PUBLIC_BASE_URL`.
