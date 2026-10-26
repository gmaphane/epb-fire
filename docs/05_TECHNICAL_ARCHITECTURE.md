# Technical Architecture (MVP)

## 1. Choices and why

| Decision | Choice | Reason |
|---|---|---|
| App type | **Installable PWA** (Android Chrome first) | One codebase, no app-store step, ships to phones by link, works offline with a service worker. Native wrapper (Capacitor) reserved for background GPS if the pilot demands it. |
| UI | Preact + TypeScript + Tailwind (tokens from the Stitch design system) | Small bundle (fast on low-end phones), typed, reuses the mockup classes. |
| Map | Leaflet + custom offline tile layer (Cache API) | Light, works on low-end phones, simple to cache raster tiles. |
| Local storage | IndexedDB (`idb`) + Cache API | Durable, large, available offline; asked to be persistent. |
| Backend | Supabase: Postgres + PostGIS, Auth, Realtime, Storage, Edge Functions | Matches your existing plan (org-owned Supabase). |
| Sync | Custom outbox + pull, behind a `RemoteAdapter` interface | Keeps offline logic independent of Supabase and testable without a server. |
| Geodesy | Own haversine/bearing + `@turf/area`/`length`; `proj4` for UTM 30N | Offline, small, verifiable. |

## 2. System context

```
 Phones (PWA, offline-first)                         Supabase (org-owned)
 ┌────────────────────────────┐   HTTPS (when any)   ┌─────────────────────────────┐
 │ UI ─ state ─ IndexedDB     │ ───────────────────▶ │ Auth · RLS                  │
 │        │        ▲          │   push outbox        │ Postgres + PostGIS          │
 │     Outbox ─ Sync engine   │ ◀─────────────────── │ Realtime (live updates)     │
 │   Cache API (map tiles)    │   pull + realtime    │ Storage (photos)            │
 │   GPS (Geolocation API)    │                      │ Edge Functions (FIRMS, SMS) │
 └────────────────────────────┘                      └─────────────────────────────┘
         ▲ GeoJSON import (compartments, assets, risk, hotspots)    ▲ later: ArcGIS Online one-way push
```

## 3. Offline-first rules
1. **Local write first.** Every action writes to IndexedDB and appends to the outbox in **one transaction**; the UI reads from IndexedDB only.
2. **The network is a background concern.** The sync engine runs on: app start, `online` event, visibility change, a 10 s timer while items are pending, and after every local write.
3. **Idempotent by design.** IDs are UUIDs created on the device. Server writes are upserts keyed by `id`; events are insert-or-ignore.
4. **Order within an incident.** Outbox is FIFO; events carry device time and sequence so replay order does not matter.
5. **Retry forever** with exponential backoff (1 s → 60 s cap). A failing item does not block others unless it is a dependency (e.g., event before its incident) — dependencies are detected and re-queued.
6. **Poison items** (server rejects with 4xx other than auth/rate limit) are parked as `error`, shown in the Sync screen, never silently dropped.
7. **Photos** are stored as Blobs locally, compressed before upload (max edge 1600 px, JPEG ~0.75), uploaded after metadata. Upload state is tracked separately.

## 4. Data model (PostGIS) — summary
Full SQL: `supabase/migrations/` (one-paste version: `supabase/setup_all.sql`).

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | User + role | `id` (auth uid), `full_name`, `role`, `crew_id` |
| `crews` | Standby teams | `id`, `name`, `block`, `shift`, `lead_id` |
| `compartments` | Reference polygons | `code`, `block`, `geom`, `risk_class`, `risk_score`, `treatment_status` |
| `assets` | Water points, cameras, towers, camps, assembly points | `kind`, `name`, `geom`, `props` |
| `roads` | Access tracks | `name`, `geom`, `passable` |
| `detections` | FIRMS hotspots | `source`, `acq_time`, `confidence`, `geom`, `promoted_incident_id` |
| `incidents` | Fires | `id`, `code`, `status`, `source`, `size_class`, `geom` (point), `accuracy_m`, `block`, `compartment`, `reported_by`, `reported_at`, `client_updated_at`, `updated_at`, `cause`, `area_ha` |
| `incident_events` | Append-only timeline | `id`, `incident_id`, `kind`, `payload`, `geom`, `accuracy_m`, `by`, `client_ts`, `received_at` |
| `assignments` | Dispatch | `id`, `incident_id`, `crew_id`/`user_id`, `state`, `instruction`, `acked_at`, `onscene_at` |
| `perimeters` | Walked burnt edge | `id`, `incident_id`, `geom` (polygon), `vertices` (with accuracy), `area_ha`, `length_km`, `walk_seconds` |
| `photos` | Evidence | `id`, `incident_id`, `storage_path`, `geom`, `heading`, `taken_at` |
| `hazards` | Road obstruction etc. | `id`, `kind`, `geom`, `note`, `resolved_at` |
| `positions` | Opt-in crew beacons (Phase 2) | `user_id`, `geom`, `accuracy_m`, `client_ts` |

**Conflicts:** `incidents` and `assignments` use last-writer-wins by `client_updated_at` (enforced by a trigger that ignores older writes); everything else is append-only or single-writer. Deletes are soft (`deleted_at`).

**Security:** RLS on every table; role from `profiles.role`; Reporters can insert incidents/events/photos and read the active board; Coordinators can update incidents and assignments; Admins manage reference data. Crew positions only readable by Coordinator/Admin.

## 5. Sync protocol

**Push** (per outbox item, FIFO):
- `POST /rest/v1/<table>?on_conflict=id` with `Prefer: resolution=merge-duplicates` (upsert), or `resolution=ignore-duplicates` for events.
- Success → mark local row `synced`, remove outbox item.
- Network error / 5xx / timeout → keep, back off. 401 → refresh token, else pause and show "Sign in to sync". 4xx → park as error.

**Pull** (per table): `GET ?updated_at=gt.<cursor>&order=updated_at.asc&limit=500`, merged into IndexedDB (LWW on `client_updated_at`; ignore if a local pending change is newer). Cursor stored in `meta`. Pull runs after push, on foreground, and every 30 s while online; Realtime subscription delivers inserts/updates immediately and also writes into IndexedDB.

**Clock safety:** the device sends `client_ts`; the server adds `received_at`. The UI shows device time but the Sync screen flags devices whose clock differs from server time by > 2 min (computed from response `Date` header).

**Reachability:** `navigator.onLine` is a hint only. The engine treats "a request succeeded" as online, "a request failed" as offline, and shows state accordingly.

## 6. GPS strategy
- Start `watchPosition({enableHighAccuracy:true, maximumAge:0, timeout:30000})` at app launch and keep it warm while the app is visible, so the first report already has a fix.
- Keep the best recent fix (lowest accuracy within 10 s) and the latest fix. Report uses the best of the last 10 s, else latest, else last-known marked stale.
- Quality: ≤ 10 m good, ≤ 20 m fair, otherwise poor. Poor fixes are flagged, never blocked.
- Perimeter: capture a vertex when moved ≥ 5 m (or 5 s) **and** accuracy ≤ 15 m; reject low-quality fixes and count them.
- Navigation: heading from GPS course when speed > 1 m/s, else from device orientation if available.
- Limits: no background tracking; Wake Lock keeps the screen on during walks; banner appears if the tab is hidden. Phone-hardware dependent. Offline GNSS works without data; first fix after a long power-off ("cold start") can take minutes.

## 7. Offline maps
- Basemap tile URL is configuration (`VITE_TILE_URL`).
- **Pack download:** for a configured bounding box and zoom range, tiles are fetched and stored in the Cache API with a progress bar and a size estimate. Tiles outside the pack are fetched on demand and also cached.
- **Licensing:** bulk-downloading from free public tile servers typically violates their terms. For the pilot, export tiles from your ArcGIS organisation or generate PMTiles/MBTiles and host them yourself (e.g. Supabase Storage). The MVP default is a public tile server for **development only**.
- Vector reference data (compartments, roads, assets) is stored in IndexedDB as GeoJSON and rendered directly.

## 8. Performance budget
Initial JS < 300 KB gzip excluding Leaflet; Leaflet loaded in the main bundle (fast, ~40 KB gzip); fonts self-hosted subset; icons inline SVG; map pack outside the precache. UI renders from memory state hydrated from IndexedDB; no spinners on local reads; list virtualisation not needed until > 500 rows.

## 9. Repository layout

```
fire-app/
  docs/                      ← these documents
  supabase/migrations/       ← SQL schema + RLS
  supabase/seed/             ← demo seed (DEMO data only)
  src/
    core/                    ← db, outbox, sync, remote adapters, gps, geo, store
    ui/                      ← screens and components
    data/                    ← demo seed GeoJSON
  tests/                     ← unit + e2e
  public/                    ← icons, manifest
```

## 10. Test plan (MVP exit criteria)

| # | Test | Pass condition |
|---|---|---|
| T1 | **Airplane-mode report:** report fire offline, kill app, reopen, still offline | Record present, marked pending, < 1 s save |
| T2 | **Reconnect:** turn network on | Pending cleared < 60 s; server has exactly one row |
| T3 | **Flapping network:** toggle 20× during sync | No duplicates, no loss |
| T4 | **Server down (5xx):** simulate | App fully usable; backoff; no data loss |
| T5 | **Replay:** send same report 10× | One server row |
| T6 | **Two phones:** A offline reports, B online | B sees it after A reconnects; dispatch reaches A after it syncs |
| T7 | **Dispatch/ack:** coordinator dispatches, responder acknowledges | Alarm on responder; ack visible to coordinator; time recorded |
| T8 | **Perimeter:** walk a known 100 m × 100 m square (1.00 ha) | Area within ±5% on a real phone in open sky; calc within 0.5% of reference in unit test |
| T9 | **GPS:** compare reported position to a surveyed point | Report offset and accuracy recorded; ≥ 90% of fixes ≤ 10 m in the open |
| T10 | **Offline map:** download pack, airplane mode, pan/zoom | No blank tiles in pack; ≥ 30 fps |
| T11 | **Cold start offline:** reboot phone, no signal, open app | Loads < 3 s |
| T12 | **Battery:** 1 h with GPS + screen on | Drain recorded for planning |
| T13 | **Night drill:** night mode, one-handed report | Completed in ≤ 10 s |
| T14 | **Permissions (RLS):** reporter tries to dispatch/delete | Denied by database |

Automated now: T1–T5, parts of T7, T8 (calculation), T11 (service-worker offline load) with Playwright and unit tests. Needs real devices/real Supabase: T6, T8 field, T9, T10 field, T12, T13, T14.
