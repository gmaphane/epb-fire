# EPB Fire Response — MVP

Offline-first fire reporting, dispatch, navigation and perimeter mapping for EcoPlanet Bamboo, Bandai Hills / North Bandai.
Read `docs/` first: product document, user requirements, design language, business case, technical architecture.

## What the MVP does
- **Report fire in 2 taps** — GPS stamped automatically, saved on the phone in well under a second, sends by itself when there is signal.
- **Incidents** — status flow Reported → Confirmed → Responding → On scene → Contained → Controlled → Out, plus False alarm; timeline of every action with time, person and GPS.
- **Dispatch** — coordinator calls crews (day/night crew suggested by block and time); responders get an alarm + vibration until they acknowledge; En route / On scene / Need support.
- **Navigate** — distance, bearing, arrow, ETA to the fire or nearest water, fully offline (straight line).
- **Perimeter** — walk the burnt edge; points auto-captured (≥5 m moved, accuracy ≤15 m), area in ha and length in km, undo/pause/add point, photos.
- **Map** — compartments coloured by risk, roads (impassable shown red), water, cameras + coverage, lookout, camp, assembly, satellite hotspots (unverified), hazards. Offline tile pack.
- **Sync** — outbox, auto-retry with back-off, live updates (Supabase Realtime), last-writer-wins, readiness level, night mode, GeoJSON/CSV export.

- **Radio relay** — camp can type in coordinates read out by a field person with no signal (decimal, DMS, UTM 30N…), with read-back and misheard-digit warnings; field person reads their own position from ⓘ.

## Run it now (demo mode, no Supabase needed)
```bash
npm install
npm run build && npm run preview   # http://localhost:4173
```
Pick a demo role on the sign-in screen. Demo layers are placeholders around the PSP area. The demo "server" lives in memory and resets on reload.
To try it on a phone, deploy `dist/` to any HTTPS static host (Netlify, Vercel, Cloudflare Pages). **GPS and offline mode need HTTPS.**

## Connect Supabase (pilot)
Full walkthrough: **docs/06_SUPABASE_SETUP.md** (one SQL paste: `supabase/setup_all.sql`; users: `npm run setup:users`).

1. Create the **org-owned** Supabase project (paid tier recommended for the season — free projects pause when idle).
2. SQL editor → run `supabase/setup_all.sql` (or the two files in `supabase/migrations/` + `supabase/seed/crews.sql`).
3. Load real layers: export from ArcGIS as GeoJSON (WGS84), then
   `node scripts/geojson-to-sql.mjs compartments compartments.geojson > c.sql` (also `roads`, and `assets --kind water|camera|tower|camp|assembly`) and run the SQL.
4. Auth → create users (email + password). Each gets a `reporter` profile; set roles/crews with the SQL at the bottom of `crews.sql`.
5. Copy `.env.example` to `.env`, fill URL + anon key, `npm run build`, deploy `dist/`.
6. Each phone: open the link online once, sign in, **Add to Home screen**, then Sync → **Download map** on Wi-Fi. After that it works with no signal.

## Tests
```bash
npm test                 # unit: sync engine (offline, replay, flapping, 5xx, LWW, dependencies, auth) + geodesy
npx playwright test      # end-to-end on a Pixel 7 profile against the built app
npm run test:db          # app sync code against real Postgres+PostGIS via PostgREST (see docs/06, part D)
```
Last run (23 Oct 2026): 17/17 unit, 7/7 end-to-end. Measured: report saved locally in 16–47 ms; app cold-starts with network off; walked 100 m × 100 m square = **1.00 ha** (16 points, weak fix rejected); 1.11 km distance/bearing correct.
Schema checked on PostgreSQL 16 + PostGIS: RLS (reporter cannot dispatch/close, responder sees only own crew), replay-safe upserts, server incident codes, LWW, perimeter/compartment geometry.

**Not yet tested — needs real phones / real Supabase:** two-phone sync and Realtime (T6), field GPS accuracy (T9), map pack on site with licensed tiles (T10), battery (T12), night drill (T13), Supabase Storage photo upload.

## Known limits (by design for the MVP)
- Browser apps cannot track GPS in the background or with the screen locked — the app keeps the screen on during perimeter walks and warns if it was backgrounded.
- Phones without data cannot receive dispatches until they get signal; radio/phone remain the primary call-out. SMS/Web Push fallback is Phase 2.
- Navigation is straight-line; road routing from ArcGIS Network Analyst is Phase 2.
- FIRMS hotspots are shown if loaded into the `detections` table; scheduled ingest is Phase 2.
- Default tile URLs are for development only (licensing).
