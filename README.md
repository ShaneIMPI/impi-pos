# IMPI PPE Mobile Shop — Point of Sale System

Point of Sale and Inventory Management System for IMPI RMS (Pty) Ltd.

Runs entirely in the browser — no backend, no database, no monthly hosting cost.

---

## What's new in this version

- **Local persistence** — stock, sales and invoice numbers now save automatically to this
  browser's storage (`localStorage`) after every action. Closing the tab, refreshing, or
  restarting the laptop no longer wipes your data. Data is tied to **this browser on this
  laptop** — it will not appear on another device.
- **Backup button** (admin only, top right) — downloads a dated `.json` snapshot of all stock
  and sales. Do this every hour or two during the show, and definitely before you close up —
  it's your safety net if the browser storage ever gets cleared.
- **Email Invoice button** — on the invoice screen, opens your default mail app with the
  customer's email, subject and a ready-made message. You still need to click **Print / Save
  PDF** first and attach the saved file — browsers won't let a webpage attach a file to an
  email automatically, this is a security restriction, not a bug.
- **Fixed logo path bug** — the logo previously used an absolute `/impi-logo.svg` path, which
  would have 404'd once deployed under a GitHub Pages subfolder. Now resolves correctly in
  both local dev and production.

---

## Quick Start (run on your laptop, no internet needed once loaded)

```bash
npm install
npm run dev
# Opens at http://localhost:5173
```

This is the **safest way to run it at the show** — no dependency on venue WiFi at all, since
everything (logic, stock, invoicing) runs locally in the browser.

---

## Before the show — checklist

1. **VAT number**: search `src/App.jsx` for `ZA000000000` (appears twice) and replace with
   IMPI's real VAT registration number. An invoice with a placeholder VAT number is not a
   valid tax invoice.
2. **TEST_MODE**: line 1 of `src/App.jsx`. Currently `true` (orange banner, `TEST-####`
   invoice numbers, watermark on invoices — safe for a dry run). Set to `false` for real,
   valid invoices during actual sales.
3. **Stock quantities & prices**: the `INITIAL_STOCK` array (~line 30) has sample data. Update
   quantities and prices to match what you're actually bringing to Seamless Africa 2026.
   Note: once you've used the app once, it loads from your saved backup, not from
   `INITIAL_STOCK` — so update this *before* first use, or use the Stock screen in-app instead.
4. **Login credentials**: the `USERS` array near the top. Consider changing the default
   passwords before a public event.

---

## Deployment — GitHub Pages (free, static, matches "no separate host")

1. Create a new **public** GitHub repo named exactly `impi-pos` under your account
   (`ShaneIMPI`) — the name matters, it's baked into `vite.config.js` as the `base` path.
2. Push this project to that repo's `main` branch (see step-by-step below).
3. In the repo: **Settings → Pages → Source → GitHub Actions** (not "Deploy from a branch" —
   this is a Vite build and needs the build step).
4. Push triggers the included workflow (`.github/workflows/deploy.yml`), which builds and
   publishes automatically. Live URL: `https://shaneimpi.github.io/impi-pos/`

**Important for the show**: once the page has loaded in your laptop's browser tab, do **not
refresh it** if the venue WiFi drops — a static page that's already loaded keeps working fine
offline (nothing on this app calls out to a server), but a refresh needs the network to
re-fetch it. If you're worried about venue WiFi at all, running it locally via `npm run dev`
(above) sidesteps the question entirely.

### Pushing to GitHub (if you haven't got a local git set up)
```bash
cd impi-pos
git init
git add .
git commit -m "IMPI POS — Seamless Africa 2026"
git branch -M main
git remote add origin https://github.com/ShaneIMPI/impi-pos.git
git push -u origin main
```

---

## Update company / VAT details
Search `src/App.jsx` for `ZA000000000` and replace with your actual VAT registration number.
Company details (address, phone, email) are in the `InvoiceView` component and the `print()`
function inside it.

## Add / change users
Find the `USERS` array near the top of `src/App.jsx`:
```js
const USERS = [
  { username: "admin",  password: "Impi@Admin2024", role: "admin" },
  { username: "staff",  password: "impi123",         role: "user"  },
  { username: "sales1", password: "impi123",         role: "user"  },
];
```
`role: "admin"` gives access to the Stock Management screen and the Backup button.

---

## Screens

| Screen | Access |
|--------|--------|
| Hero splash | First load only |
| Login | All users |
| POS (Point of Sale) | All users |
| Invoice View | All users |
| Stock Management (4 tabs) | Admin only |
| Sales History | All users |

---

## Data backup & recovery

- Click **⬇ BACKUP** (admin, top right, any screen) to download a timestamped `.json` file
  of all stock and sales — do this periodically during the show.
- There's currently no in-app "restore from backup" button. If you ever need to restore, send
  the backup file back and it can be added as a one-off — or ask for the "Import Backup"
  feature to be added ahead of time if you want it as a safety net for the show.

---

## Future: real email sending & multi-device sync

To send emails automatically (rather than the manual "save PDF, attach, send" flow) or to run
this from more than one laptop/tablet with shared, synced stock — both need a small backend
(e.g. Supabase, matching the stack used in IMPI's other tools, plus an email-sending service).
Out of scope for this weekend, but straightforward to add afterwards; happy to plan it once
the trade-show run is done and you know what worked well and what didn't.

Contact: shane@impi-secure.co.za · 083 782 2207
