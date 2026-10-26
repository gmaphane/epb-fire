# User Requirements

Priority: **M** = must (MVP), **S** = should (pilot), **C** = could (later). "MVP" column marks what the first build implements.

## 1. User stories

| ID | As a… | I want to… | So that… | Pri |
|---|---|---|---|---|
| US-01 | Reporter | report a fire in two taps with my location captured automatically | responders know where it is within seconds | M |
| US-02 | Reporter | report when I have no signal and know it will send itself later | I never have to retry or remember | M |
| US-03 | Observer | report a fire I can see from a distance using bearing and approximate range | a distant sighting still gives a location | S |
| US-04 | Coordinator | see all active incidents, crews, water points and cameras on one map | I can decide where to send people | M |
| US-05 | Coordinator | verify or dismiss a report with a reason | false alarms don't waste crews | M |
| US-06 | Coordinator | dispatch one or more crews to an incident | everyone knows who is going | M |
| US-07 | Responder | receive a loud alert, see where to go, and acknowledge | the coordinator knows I'm moving | M |
| US-08 | Responder | see distance, bearing and ETA to the fire, offline | I can navigate without signal | M |
| US-09 | Responder | check in on arrival and post updates (spread, needs) in two taps | the coordinator can track the situation | M |
| US-10 | Responder | walk the burnt edge and have the app record the perimeter and compute hectares | we get an accurate area | M |
| US-11 | Responder | attach geotagged photos | evidence and cause analysis | M |
| US-12 | Coordinator | see which phones have not synced and how old their data is | I know how current my picture is | M |
| US-13 | Any user | use the app fully in sunlight and at night | day and night crews can both use it | M |
| US-14 | Coordinator | see satellite hotspots and promote them to incidents | I act on detections | S |
| US-15 | Coordinator | see compartment risk class and treatment status | I position resources sensibly | S |
| US-16 | Manager | see a simple situation summary and season statistics | I can brief leadership | S |
| US-17 | Admin | load compartments, roads, water points, cameras and crews from GeoJSON/CSV | the app reflects the real site | M |
| US-18 | Admin | export incident records (GeoJSON, CSV) | I can analyse and report them | M |
| US-19 | Coordinator | be alerted when a fire starts after the shift change and the night crew is targeted | the right crew responds | S |
| US-20 | Admin | download an offline map pack for the site to each phone | the map works with no signal | M |
| US-21 | Field person with no signal | read my GPS position out over the radio | camp can log the fire for everyone | M |
| US-22 | Camp radio operator | type in a position read out over the radio and have it read back to me | the fire reaches every phone even though the caller has no signal | M |

## 2. Functional requirements

### 2.1 Fire reporting and incidents

| ID | Requirement | Acceptance criteria | Pri | MVP |
|---|---|---|---|---|
| FR-REP-01 | A "Report fire" control is visible on every primary screen. | Reachable in 1 tap from any tab; report completed in ≤ 2 further taps (confirm). | M | ✔ |
| FR-REP-02 | On open of the report form the app takes the best available GPS fix and shows accuracy. | Location + accuracy (m) + fix age displayed; user may refine via map pin or enter coordinates. | M | ✔ |
| FR-REP-03 | Report saves to local durable storage before any network call. | Saved (airplane mode) in < 1 s; survives app kill and phone reboot. | M | ✔ |
| FR-REP-04 | Report captures: detected-by (tower, camera, satellite, patrol, community, other), approximate size class, smoke colour optional, notes, photo(s). | Fields optional except location and detected-by. | M | ✔ |
| FR-REP-05 | Reports use client-generated IDs so retries cannot duplicate. | Replay of the same report 10× yields 1 server row. | M | ✔ |
| FR-REP-06 | Report from distance by bearing + range from the reporter's own position. | Computed point shown and marked "estimated". | S | ✘ |
| FR-REP-08 | **Radio relay:** type in coordinates read out by someone in the field with no signal (decimal degrees, DMS, degrees-decimal-minutes, PSP sheet style, UTM 30N), with who saw it, how it was received (radio/phone) and when it was seen. | Parsed point shown on the map with a read-back line (DMS + UTM + compartment) to confirm with the caller; warning if > 30 km from site or hemisphere assumed; record marked `location_source = manual`. | M | ✔ |
| FR-REP-09 | **Read-out of own position** for the field person, offline, in DMS, decimal and UTM with grouped digits. | One tap (ⓘ) from any screen. | M | ✔ |
| FR-REP-07 | Possible duplicates (another open incident within a configurable radius, default 500 m) are suggested for merge. | Prompt shown; user decides. | S | ✔ (prompt only) |
| FR-INC-01 | Incident lifecycle: Reported → Confirmed → Responding → On scene → Contained → Controlled → Out; also Dismissed (false alarm, reason required). | Only allowed transitions permitted; each writes a timeline event with author, time, GPS. | M | ✔ |
| FR-INC-02 | Incident list sorted by severity then recency; filter All / Active / Closed. | Active first; shows age ("14 min ago") and sync state per item. | M | ✔ |
| FR-INC-03 | Incident detail: location (decimal degrees, DMS, UTM 30N), compartment/block (point-in-polygon), timeline, crews, photos, notes. | Block/compartment resolved offline. | M | ✔ |
| FR-INC-04 | Priority derived from simple rules (nearness to bamboo compartment, size class, time of day) and editable by Coordinator. | Rules visible; override logged. | S | ✘ |
| FR-INC-05 | Cause and damage fields at close (cause category, area, compartments affected, bamboo age class, notes). | Required to move to Out. | M | ✔ |

### 2.2 Mobilisation

| ID | Requirement | Acceptance criteria | Pri | MVP |
|---|---|---|---|---|
| FR-MOB-01 | Crews (teams) and members managed by Admin; each crew has a block, shift (day/night) and lead. | CRUD via import/seed in MVP. | M | ✔ (seed) |
| FR-MOB-02 | Coordinator dispatches crew(s) to an incident with an optional instruction and rendezvous point. | Creates assignment records; targets see them. | M | ✔ |
| FR-MOB-03 | Responders see an alert with audible alarm and vibration while the app is open; in-app banner persists until acknowledged. | Alarm plays on new assignment; stops on acknowledge. | M | ✔ |
| FR-MOB-04 | Acknowledge, "En route", "On scene" and "Need support" are one-tap actions with time and GPS. | Each is an event; coordinator sees live counts. | M | ✔ |
| FR-MOB-05 | Unacknowledged assignments escalate (highlight to coordinator after N minutes; default 3). | Visible state; configurable. | S | ✔ (highlight) |
| FR-MOB-06 | Push notification when the app is closed (Web Push) and SMS fallback for phones without data. | Delivered within target when phone has any coverage. | S | ✘ |
| FR-MOB-07 | Shift awareness: default dispatch target is the on-duty crew for that block (after 18:00 = night crew). | Rule configurable; coordinator can override. | S | ✘ |
| FR-MOB-08 | Live crew positions (opt-in per shift) visible to Coordinator only. | Position beacons every 30–60 s while app is open; stored offline and flushed. | S | ✘ |

### 2.3 Map and situational awareness

| ID | Requirement | Acceptance criteria | Pri | MVP |
|---|---|---|---|---|
| FR-MAP-01 | Full-screen map with: own position + accuracy ring, incidents, perimeters, compartments (risk-coloured), roads/tracks, water points, cameras and coverage, towers, camps. | Layers toggle; defaults sensible. | M | ✔ |
| FR-MAP-02 | Works offline using a cached map pack covering the site. | Pan/zoom within pack with no network, ≥ 30 fps on a mid-range Android phone. | M | ✔ |
| FR-MAP-03 | Basemap choices: satellite, topographic/street. | Switch without reload. | M | ✔ (one configurable source + hillshade-free fallback) |
| FR-MAP-04 | Tools: compass/north-up, locate me, layers, measure distance. | Per design language. | M | ✔ |
| FR-MAP-05 | Satellite hotspots (FIRMS) shown as distinct "unverified" markers with acquisition time and confidence. | Promote to incident in 2 taps. | S | ✔ (import only) |
| FR-MAP-06 | Compartment info card: block, compartment, treatment status, risk class. | Tap compartment. | S | ✔ |
| FR-MAP-07 | Season readiness banner (Green/Amber/Red) set by Coordinator, visible to all. | Changes sync. | S | ✔ |

### 2.4 Navigation

| ID | Requirement | Acceptance criteria | Pri | MVP |
|---|---|---|---|---|
| FR-NAV-01 | Navigate to an incident or water point showing distance, bearing, heading, ETA and a bearing arrow, entirely offline. | Updates ≥ 1 Hz; ETA based on measured speed with a fallback walking/driving speed. | M | ✔ |
| FR-NAV-02 | Show GPS quality (accuracy, satellites if available) and warn when poor. | Warning if accuracy > 20 m (configurable). | M | ✔ |
| FR-NAV-03 | Show nearest water points and access notes en route. | List within radius. | S | ✔ |
| FR-NAV-04 | Road-following routes from pre-computed network analysis. | Routes imported from ArcGIS Network Analyst as GeoJSON, drawn offline. | S | ✘ |
| FR-NAV-05 | Report road obstruction/hazard at current location. | Creates a hazard point, visible to all. | S | ✔ |

### 2.5 Perimeter and field data

| ID | Requirement | Acceptance criteria | Pri | MVP |
|---|---|---|---|---|
| FR-PER-01 | Walk-the-edge perimeter capture with start, pause, resume, undo vertex, finish. | Vertices stored incrementally so an app crash loses ≤ the last vertex. | M | ✔ |
| FR-PER-02 | Vertex capture by distance (default 5 m) or time (default 5 s), and only when accuracy ≤ threshold (default 15 m); manual "add point" also available. | Rejected fixes counted and shown. | M | ✔ |
| FR-PER-03 | Live area (ha), perimeter length (km), vertex count, walk time. | Matches reference geodesic calculation within 0.5%. | M | ✔ |
| FR-PER-04 | GPS averaging at a point (e.g., 10-sample average) for key points such as ignition point. | Reports mean position and spread. | S | ✘ |
| FR-PER-05 | Geotagged photos with heading, linked to incident or perimeter. | Photo stored locally; uploaded in background; thumbnail immediately. | M | ✔ |
| FR-PER-06 | Perimeter can be completed by hand-editing vertices on the map. | Edit and re-compute. | S | ✘ |
| FR-PER-07 | Ability to keep the screen on during a walk and warn if the app is backgrounded. | Wake lock requested; banner shown if lost. | M | ✔ |

### 2.6 Prediction and detection inputs

| ID | Requirement | Pri | MVP |
|---|---|---|---|
| FR-PRD-01 | Import compartment risk ranking (class + score) from the GIS analysis as GeoJSON/CSV and display it. | S | ✔ |
| FR-PRD-02 | Import FIRMS VIIRS/MODIS hotspots (CSV/GeoJSON) for the site buffer and display as detections. | S | ✔ |
| FR-PRD-03 | Scheduled FIRMS ingest into Supabase (every 3 h in season) via Edge Function or script. | S | ✘ |
| FR-PRD-04 | Daily fire danger rating from weather (temperature, humidity, wind, days since rain). | C | ✘ |
| FR-PRD-05 | Firehawk camera alert ingestion (method to be confirmed). | C | ✘ |
| FR-PRD-06 | Post-fire burn scar check via Sentinel-2 dNBR to compare with walked perimeter. | C | ✘ |

### 2.7 Sync, data and administration

| ID | Requirement | Pri | MVP |
|---|---|---|---|
| FR-SYN-01 | All user actions are written locally first and queued in a persistent outbox; the app pushes automatically on connectivity change, on a timer, and on foreground. | M | ✔ |
| FR-SYN-02 | Pull changes since last cursor; live updates via Supabase Realtime when online. | M | ✔ |
| FR-SYN-03 | Per-record sync state (pending / synced / error) and global sync status always visible. | M | ✔ |
| FR-SYN-04 | Conflict rule: incident timeline events are append-only; mutable fields use last-writer-wins by client timestamp with server validation; destructive deletes are soft. | M | ✔ |
| FR-SYN-05 | Manual "Sync now", retry failed items, view and export the outbox. | M | ✔ |
| FR-SYN-06 | Clock skew tolerance: device time may be wrong; server records receipt time, and the app shows both. | M | ✔ |
| FR-SYN-07 | Large files (photos) upload separately with resume; metadata syncs first. | M | ✔ |
| FR-ADM-01 | Bulk import for compartments, roads, assets, crews (GeoJSON/CSV). | M | ✔ (seed + import file) |
| FR-ADM-02 | Role-based access via Supabase Auth and Row-Level Security. | M | ✔ (schema) |
| FR-ADM-03 | Export incidents and perimeters (GeoJSON, CSV). | M | ✔ |
| FR-ADM-04 | Audit trail: who changed what and when. | S | ✔ (events table) |
| FR-ADM-05 | Offline sign-in: a previously authenticated user can open the app with no network. | M | ✔ |

## 3. Non-functional requirements

### 3.1 Performance ("no delays that could cause fire damage")

| ID | Requirement | Target |
|---|---|---|
| NFR-PERF-01 | App launch to interactive (warm, cached) | < 2 s on a mid-range Android phone |
| NFR-PERF-02 | App launch (cold, first after install, online) | < 6 s on 3G |
| NFR-PERF-03 | Tap-to-response for local actions | < 100 ms visual feedback, < 300 ms completion |
| NFR-PERF-04 | Report-fire save | < 1 s, independent of network |
| NFR-PERF-05 | Map pan/zoom | ≥ 30 fps, no blank tiles inside offline pack |
| NFR-PERF-06 | Sync of a single new incident (online) | < 3 s end to end |
| NFR-PERF-07 | Initial JS payload (gzip) | < 300 KB excluding map libraries; total precache < 5 MB excluding map pack |
| NFR-PERF-08 | Battery | ≥ 8 h of active use with GPS on a phone starting at 100% (to be tested) |
| NFR-PERF-09 | Local DB | Remain responsive with 10,000 incidents/events and 100,000 track points |

### 3.2 Offline and reliability

| ID | Requirement |
|---|---|
| NFR-OFF-01 | Every M-priority feature in §2 except cross-device sharing works with no network after first load. |
| NFR-OFF-02 | The app shell, data and map pack are cached; the app launches in airplane mode after a cold restart. |
| NFR-OFF-03 | Zero data loss on: app kill, browser crash, low battery shutdown, network flapping, server errors (5xx), partial uploads. |
| NFR-OFF-04 | Sync is idempotent and resumable; retry with exponential backoff capped at 60 s; never gives up. |
| NFR-OFF-05 | Storage is requested as persistent so the OS does not evict it; user is warned at < 100 MB free. |
| NFR-OFF-06 | If the server is down, the app continues to function and shows "Server unreachable — data safe on this phone". |
| NFR-REL-01 | Server availability target 99.5% during the season; plan a paid Supabase tier and daily backups. |

### 3.3 GPS and accuracy

| ID | Requirement |
|---|---|
| NFR-GPS-01 | Use high-accuracy positioning (GNSS), not network location; request `enableHighAccuracy` with no stale cache. |
| NFR-GPS-02 | Every stored position carries: lat, lon, accuracy (m), altitude and accuracy if provided, speed, heading, device timestamp, and source. |
| NFR-GPS-03 | Positioning works with no network (GNSS only). A warm start is typically fast; a cold start may take minutes — the app shows "acquiring" state and starts the fix on launch, not on demand. |
| NFR-GPS-04 | "Good fix" rule: accuracy ≤ 10 m open-sky target; fixes worse than 20 m are flagged; report allowed anyway with the flag. |
| NFR-GPS-05 | Perimeter vertices are filtered by accuracy and optionally by short-window averaging. |
| NFR-GPS-06 | Coordinates shown in decimal degrees (WGS84), DMS and UTM 30N; copyable. |
| NFR-GPS-07 | External high-accuracy GNSS receivers (Bluetooth) supported where the phone OS exposes them as the system location source; no app-specific driver in MVP. |
| NFR-GPS-08 | Browser limits (documented): no background tracking, accuracy depends on phone hardware and sky view. |

### 3.4 Usability

| ID | Requirement |
|---|---|
| NFR-UX-01 | Touch targets ≥ 48 × 48 px; primary actions ≥ 56 px high; usable with gloves where feasible. |
| NFR-UX-02 | Readable in direct sunlight (contrast ≥ 7:1 for key text) and in a night mode that preserves night vision. |
| NFR-UX-03 | One-handed use for report, acknowledge and navigate. |
| NFR-UX-04 | Icon + label for every action; no icon-only critical actions. |
| NFR-UX-05 | Plain English, short sentences, localisable strings. |
| NFR-UX-06 | Errors say what happened and what the app is doing about it; never block the user from reporting. |
| NFR-UX-07 | Metric units only (ha, m, km, km/h). |

### 3.5 Security and privacy

| ID | Requirement |
|---|---|
| NFR-SEC-01 | Supabase Auth; Row-Level Security on every table; no service key in the client. |
| NFR-SEC-02 | Role-based permissions (Reporter, Responder, Coordinator, Manager, Admin) enforced in the database. |
| NFR-SEC-03 | TLS in transit; device storage not encrypted by the app (relies on OS); lost device → revoke session. |
| NFR-SEC-04 | Crew positions visible to Coordinator/Admin only; retention configurable (default 90 days). |
| NFR-SEC-05 | Organisation-owned Supabase project, not a personal account, before any real data is entered. |

### 3.6 Compatibility and maintainability

| ID | Requirement |
|---|---|
| NFR-CMP-01 | Android Chrome (current and previous two major versions) as primary target; iOS Safari as secondary; desktop Chrome/Edge for the Coordinator view. |
| NFR-CMP-02 | Installable PWA (home-screen icon, full-screen, no browser chrome). |
| NFR-MNT-01 | Typed codebase, unit tests on sync, geodesy and state machine; schema in versioned migrations. |
| NFR-MNT-02 | Configuration (tile URL, thresholds, project centre) in one file/environment, not in code. |

## 4. Data requirements

- **Reference data:** compartments (Block → Compartment → FMU, polygons, bamboo age class, treatment status, risk score/class), roads/tracks (lines, passability), water points (type, capacity), cameras (location, bearing, coverage radius), towers/lookouts, camps, assembly points.
- **Operational data:** incidents, incident events, assignments, perimeters, tracks, photos, hazards, detections (hotspots), crew positions (opt-in), sync log.
- **Identity:** users, crews, crew members, shifts.
- **Identifiers:** UUIDs generated on device; human-friendly incident code (e.g. `F-2026-0001`) assigned on server with a device-local provisional label until synced.
- **CRS:** stored WGS84 (EPSG:4326); analysis/display in UTM Zone 30N (EPSG:32630) where required.

## 5. Constraints and assumptions

1. Field phones are Android with Chrome (**to be confirmed**).
2. Some areas have no cellular coverage (**to be measured**).
3. Radio or phone calls remain the primary mobilisation method; the app complements them until proven.
4. The weekly plan's field-phone collection for syncing is a different workflow and is not replaced by this app.
5. Source GIS layers listed in §4 may not all exist yet; the MVP includes demo data and an importer.
