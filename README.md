# mister-transmission-form

Customer intake / check-in ("booking") form for **Mister Transmission** (Parkland Transmission, Red Deer AB).

## What's in this repo
- **`index.html`** — the iPad intake form (self-contained static page, embedded logo).
  Served on **GitHub Pages**: https://mjlemon1992.github.io/mister-transmission-form/
- **`server.js`** — Express backend. This repo is **also deployed on Railway**, where the
  server serves `index.html` at `/` **and** handles `POST /checkin` → creates a customer +
  vehicle + repair order in **Shopmonkey**.

## Why the backend lives in the "form" repo
The Railway backend service (`mister-transmission-backend`, project **mister transmission
booking**) currently deploys **this** repo, so it needs `server.js` to answer `/checkin`.
Live backend URL: https://mister-transmission-backend-production.up.railway.app

The canonical backend code also lives in the **`mister-transmission-checkin`** repo. For a
cleaner split (form here, backend there), re-point the Railway service **Source** to
`mister-transmission-checkin` in the dashboard — then `server.js` here can be removed.

## Environment
- `SM_API_KEY` — Shopmonkey JWT bearer token. Set on Railway, **not** in code.

## Notes
- **Fleet** customers (`customerType: "fleet"`): do **not** send `firstName`/`lastName` to
  Shopmonkey — it rejects them. Send `companyName` only. (`server.js` handles this.)
- `.nojekyll` keeps GitHub Pages serving `index.html` as-is.
- Express **4** only (Express 5 breaks wildcard routes).

