# Setting up the database (Supabase) — step by step

> **Status (23 Oct 2026): done for the pilot project.** Organisation *EcoPlanet Bamboo* → project **epb-fire** (`qmgialosxnlvyvzpvgiv`, London eu-west-2, free plan). Migrations `init`, `radio_relay`, `harden` applied; crews and DEMO layers loaded; Supabase security advisor clean. `fire-app/.env` points at it. Admin user set up (gmaphane@…, Block B — Day crew for solo testing). Migration `estate_layers` added (overlay layers, fire history); **load the real layers with part E**. The steps below are kept for rebuilding or a second environment.

**Recommendation: use a Supabase cloud project for testing and the pilot.** Phones at camp and in the field need a server they can reach over mobile data. A database on an office PC is only reachable from devices on the same network, so it suits desk testing only. Part C (local Supabase) and Part D (your own Postgres) cover those cases.

What the app needs from the server: a Postgres database with PostGIS, a REST API, logins, live updates (Realtime) and photo storage. Supabase provides all five. Plain Postgres provides only the first.

---

## A. Supabase cloud (≈ 20 minutes)

### 1. Create the project
1. Go to **supabase.com** and sign in with the EcoPlanet account you plan to own this, not a personal one.
2. **New project.** Name it `epb-fire`, set a strong database password and store it safely, and choose a European region (the closest to Ghana).
3. Wait until the project shows **Healthy**.

> The free plan pauses projects after a week without activity. That's fine for testing; move to a paid plan before the fire season.

### 2. Create the tables, security rules and demo layers
1. Left menu → **SQL Editor** → **New query**.
2. Open `fire-app\supabase\setup_all.sql` in Notepad, copy everything, paste and click **Run**. It should finish with "Success. No rows returned". It's safe to run again.
   - This creates the tables, row-level security, a private `incident-photos` storage bucket, live-update settings, the 7 standby crews and the **DEMO** placeholder layers.
   - When you have real data, skip the demo layers: run the three files in `supabase\migrations\` plus `supabase\seed\crews.sql` instead, then load real layers (step 6).

### 3. Get the keys
Left menu → **Project Settings → API** (or **Connect**). Copy:
- **Project URL**, e.g. `https://abcd1234.supabase.co`
- **anon / publishable key** (safe to put in the app)
- **service_role / secret key**: **admin key, keep it private**, only used in step 4

### 4. Create the test users
In PowerShell, from the `fire-app` folder:
```powershell
copy supabase\seed\users.example.json supabase\seed\users.json
notepad supabase\seed\users.json        # set real emails/passwords; roles: reporter, responder, coordinator, manager, admin
$env:SUPABASE_URL="https://abcd1234.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="paste-service-role-key"
npm run setup:users
```
Each line should print ✓. Responders need a `crew` that exactly matches a crew name, e.g. `Block B — Day`. Rerun any time you change roles.

### 5. Point the app at Supabase
```powershell
copy .env.example .env
notepad .env
```
Fill in:
```
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=paste-anon-key
```
Then:
```powershell
npm run build
npm run preview
```
Open http://localhost:4173. You now get an email/password sign-in instead of the demo role buttons. Sign in with one of the users from step 4.

To test on phones, put the `dist` folder on an HTTPS host (README, "Test on an Android phone"). Rebuild whenever `.env` changes.

### 6. Load real layers (when ready)
Export each layer from ArcGIS as **GeoJSON in WGS84**, then:
```powershell
node scripts\geojson-to-sql.mjs compartments compartments.geojson > compartments.sql
node scripts\geojson-to-sql.mjs roads roads.geojson > roads.sql
node scripts\geojson-to-sql.mjs assets water_points.geojson --kind water > water.sql
```
Paste each `.sql` into the SQL Editor and run it. Fields read from the attribute table: `CODE`, `BLOCK`, `RISK_CLASS`, `RISK_SCORE`, `TREATMENT` (compartments); `NAME`, `PASSABLE` (roads); `NAME` plus any other fields (assets).

To remove the demo layers:
```sql
delete from compartments where code like 'DEMO-%';
delete from assets      where id::text like '00000000-0000-4000-8000-0000000001%';
delete from roads       where id::text like '00000000-0000-4000-8000-0000000002%';
delete from detections  where id::text like '00000000-0000-4000-8000-0000000004%';
```

### 7. Check it works (10-minute drill)
Use three devices or browser windows signed in as different users:
1. **Field person (Patrol)**: turn on airplane mode, tap **ⓘ** (top bar) and read out the position shown under "My position".
2. **Camp radio desk (Coordinator)**: **Report fire → Type / radio**, type the coordinate, check the read-back line with the caller, enter "Seen by", then **Report relayed fire**.
3. **Coordinator**: open the incident, tap **Confirmed**, then **Dispatch crews** → *Block B — Day*.
4. **Responder (Block B Day)**: the alarm sounds; tap **Acknowledge**.
5. In Supabase → **Table Editor → incidents** you should see the fire with `location_source = manual`, `relayed_via = radio` and the observer's name.
6. Field person: turn airplane mode off; anything they recorded syncs on its own.

---

## B. Users and roles
| Role | Can |
|---|---|
| reporter | report fires, add notes and photos |
| responder | the above, plus acknowledge/en route/on scene for their crew, set status up to Contained, walk perimeters |
| coordinator | everything operational: confirm, dispatch, close, false alarm, readiness level |
| manager | read everything, report fires |
| admin | everything, including reference layers and user roles |

The roles are enforced in the database (row-level security), not just hidden in the app. Mapping EcoPlanet positions to roles is still your decision (product document §10).

---

## C. Local Supabase on this PC (desk testing only)
Needs **Docker Desktop for Windows** (about 2–4 GB and WSL2; may need IT approval).
```powershell
winget install Docker.DockerDesktop      # restart Windows, open Docker Desktop once
cd "C:\Users\Gladwell\Documents\BandaiHills_MRV\Applications\Fire App\fire-app"
npx supabase init                         # answer N to the VS Code questions; keeps our migrations folder
npx supabase start                        # first run downloads images; prints API URL, anon key, service_role key, Studio URL
```
- The migrations in `supabase\migrations` are applied automatically.
- Open Studio (http://localhost:54323) → SQL Editor and run `supabase\seed\crews.sql` and `supabase\seed\demo_reference.sql`.
- Then do steps A4–A5 using the local URL (`http://127.0.0.1:54321`) and keys.
- Phones can't reach this unless they're on the same Wi-Fi and you use the PC's IP address, and even then phone GPS won't work over plain `http://`. Use it only for desk testing.

## D. Your existing Postgres
The app can't talk to Postgres directly. It needs the API, logins and live updates in front of it. Using the operations database (the one fed from ArcGIS Online) as the fire app's back end isn't recommended: it mixes systems and puts field data at risk from a schema change.

What this repository *does* include is a **database test harness**. It runs the app's real sync code against any Postgres 15+ with PostGIS through PostgREST, to prove the tables, security rules and sync behave correctly. I used it here, and it caught two real bugs before you deployed:
1. Coordinators couldn't confirm a fire reported by someone else, and responders couldn't acknowledge call-outs. The app saves with an "upsert", and Postgres checks the *insert* rule even when the row already exists.
2. Any record downloaded from the server and then edited on a phone was rejected, because it carried the server-calculated `geom` column back.

Both are fixed and covered by `npm run test:db` (`tests\integration\supabase.test.ts`).

To run the harness against your own Postgres (needs PostGIS and the PostgREST binary):
1. Create an empty database, e.g. `epb_fire_test`, and run the small Supabase stand-in (roles `anon`, `authenticated`, `authenticator`, schemas `auth`, `storage`, `extensions`). The stand-in script is available on request; I kept it out of the app folder because it must never touch a production database.
2. Run `supabase\setup_all.sql`, start PostgREST with a JWT secret, and run `npm run test:db` with `SUPA_REST` and `JWT_SECRET` set.

Later, if you want fire records in ArcGIS or the operations Postgres, the right pattern is a one-way scheduled copy *out of* Supabase, matching the hybrid architecture already chosen.

---

## E. Load the real estate layers (from `01_raw_data\fire`)
The fire folder is converted into one file, then uploaded with your admin login (no secret key):
```powershell
cd "C:\Users\Gladwell\Documents\BandaiHills_MRV\Applications\Fire App\fire-app"
npm run load:layers -- --remove-demo
```
Enter your app email and password when asked. It loads 84 compartments, 208 roads/tracks, 77 assets (water points, camps, towers, FireHawk cameras, 32 standby posts, crew vehicles, communities), 144 overlay features (firebreaks, FMP 2025 high-risk zones, camera view areas, patrol routes, 38 burnt areas incl. B121 on 22 Oct 2026, waterways) and 8 963 fire-history points (FIRMS 2016–2026 + 2025/26 alert log), then removes the DEMO placeholders. Safe to re-run: records are updated, not duplicated.

**When the layers change** (new burnt area, edited roads, the agreed risk ranking), regenerate and reload:
```powershell
python scripts\port_fire_layers.py "C:\Users\Gladwell\Documents\BandaiHills_MRV\01_raw_data\fire"   # needs geopandas (e.g. your conda env)
npm run load:layers
```
Phones pick up the changes on their next sync. Source mapping and caveats:

| App table | From | Notes |
|---|---|---|
| compartments | `Fire_War_Room_2026-27/compartments_wgs84.geojson` | `risk_class` = **provisional**: high if ≥10 % or ≥5 ha inside a 2025 FMP high-risk zone (41 of 84), else moderate. Replace with the agreed risk ranking. Props carry area, 2024 field-mapped burnt ha and Sentinel-2 burnt ha for 2023/24 and 2025/26 |
| roads | `roads_revised_centrelines` (Roads_Revised.shp) + `roads_tracks` | "Needs Opening" → shown as not passable (22) |
| assets | water/camps registers, `fire_towers_cameras.csv`, standby posts & vehicle parking, communities | Tower/camera positions ±300 m (georeferenced map); 2 water points and 1 camp have no name in the registers |
| map_layers | firebreaks_all, high_risk_zones, FireHawk coverage, standby routes, waterways, Burnt Area.shp (2024), 2023 fire land, walked KML perimeters | KML perimeters closed into polygons |
| fire_history | FIRMS/MODIS 2016–2026 (estate + 5 km), `Fire Alerts 2025.csv` | Server only (not sent to phones); readable by coordinator/manager/admin |

Not loaded: Excel registers without coordinates (Fire Monitoring Register, Implementation plan), contours, the ArcGIS `.gdb` files (the war-room GeoJSONs are the cleaned copies of the same layers). Geometry is simplified 1–3 m for phones and repaired where invalid; ArcGIS stays the master copy.

## Security notes
- Only the **anon** key goes into `.env` and the app. The **service_role** key bypasses all security: keep it out of the app, Dropbox and email.
- Change the example passwords in `users.json`, and don't commit or share that file.
- Every table has row-level security switched on. Test with a reporter account that dispatching is refused.
