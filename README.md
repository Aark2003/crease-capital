# Crease Capital

Crease Capital is a full-stack fantasy cricket purse and trade management workspace based on the supplied architecture. It includes role-aware admin and team workspaces, a relational SQLite persistence layer, purse ledger calculations, season activation, winner payouts, player ownership, trade requests, atomic acceptance, negotiation chat, notifications, and audit records.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on port 4000 and the Vite proxy serves `/api` requests.

Demo credentials:

- Admin: `admin` / `demo123`
- Team: `royalstrikers` / `demo123`
- Team: `mumbaimavericks` / `demo123`
- Team: `delhidynamos` / `demo123`

For a production bundle, run `npm run build`, then start the API with `NODE_ENV=production node --import tsx server/index.ts`.

The local database is created at `data/crease-capital.db` on first launch. The schema is relational and keeps historical seasons, ownership records, trades, messages, notifications, ledger entries, winner payouts, and audit logs separate.

## Deploying with Render + Vercel + Neon

The checked-in [render.yaml](/Users/aarkdeepsarkar/Documents/ChatGPT/Bank/render.yaml) configures the API as a Render web service with a persistent data disk, and [vercel.json](/Users/aarkdeepsarkar/Documents/ChatGPT/Bank/vercel.json) configures the Vite SPA for Vercel deep links. Render services must bind to `0.0.0.0`; the API does this automatically.

1. Create a Neon project and copy its pooled `DATABASE_URL` connection string.
2. Connect this repository to Render, select the Blueprint from `render.yaml`, and set `DATABASE_URL` and `CORS_ORIGIN` in the service environment.
3. Connect the repository to Vercel, set `VITE_API_URL` to the Render service URL, and deploy.

Important: this MVP currently persists through Node 24's local SQLite engine, so the Render disk is the active source of persistence. `DATABASE_URL` is included as the deployment contract for Neon, but a PostgreSQL adapter/migration is still required before Neon can become the active database. I have not represented Neon as live when it is not yet used by the runtime.
