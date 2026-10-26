# EcoPlanet Fire Response App — Product Document

| | |
|---|---|
| **Working name** | EPB Fire (placeholder) |
| **Owner** | Gladwell — GIS & Monitoring Manager, EcoPlanet Bamboo Ghana |
| **Version** | 0.1 — draft for review, 23 Oct 2026 |
| **Status** | Pre-MVP. Companion docs: `02_USER_REQUIREMENTS`, `03_DESIGN_LANGUAGE`, `04_BUSINESS_CASE`, `05_TECHNICAL_ARCHITECTURE` |

---

## 1. One-paragraph summary

A mobile-first app that takes the 2026/27 fire season at Bandai Hills (Blocks A, B) and North Bandai (Block C) from "calls, WhatsApp and memory" to one shared picture: **where fire is likely, where it is now, who is going, how they get there, and how big it ended up**. It works with no signal, captures GPS reliably, syncs automatically to Supabase when any connectivity appears, and turns every fire into an auditable record (location, timeline, perimeter, area in ha) that also serves Verra monitoring and post-season learning.

## 2. Problem

Fire is the biggest single threat to the standing bamboo (and so to the carbon stock behind projects 2928/2929). The season plan (slashing → spraying → 3rd casing, 50 m edge bands, standby teams of 20 per block — 10 day / 10 night) reduces fuel and gives us crews. What it does not give us:

1. **Slow, lossy reporting.** A sighting travels by phone call or message, is relayed, re-interpreted, and often has no coordinate or a wrong one.
2. **No common operating picture.** Camera operators, supervisors, managers and crews each hold a fragment. Nobody can see "all fires, all crews, all water points" in one place.
3. **Mobilisation is manual.** Who is on shift, who has been told, who is moving, who has arrived — tracked by phone calls. The day/night hand-over (fires after 18:00 go to the night crew) depends on someone remembering.
4. **Connectivity gaps.** Much of the site has poor or no coverage. Any tool that needs signal fails exactly when it is needed.
5. **Poor fire records.** Perimeters, areas and times are reconstructed afterwards from memory or satellite imagery. This weakens causal analysis, budget justification and Verra evidence.
6. **Prediction and detection live elsewhere.** Hotspot data (FIRMS/VIIRS/MODIS), risk ranking, and camera feeds are not connected to the people who must act.

## 3. Product vision and principles

**Vision:** Every person who can help with a fire sees the same, current, trustworthy picture within seconds — signal or not — and every fire leaves behind a clean record.

**Principles (these decide trade-offs):**

1. **Seconds matter more than features.** Reporting a fire is ≤ 2 taps from anywhere in the app and must complete locally in < 1 s regardless of network. Nothing waits on a server.
2. **Offline is the normal state.** The app is designed offline-first; "online" is an optimisation that adds live updates and sync.
3. **Never lose a record.** Writes go to durable local storage first, then a persistent outbox. Sync is idempotent and retried forever.
4. **Honest about uncertainty.** GPS accuracy, data age, sync state and "unverified" status are always visible. The app never shows a stale position as live.
5. **Simple under stress.** Large targets, few choices, icons plus words, readable in glare and at night.
6. **Protect the bamboo.** Risk and response logic follows the agreed ranking basis (bamboo consequence; camps handled separately; community proximity not a consequence factor).

## 4. Scope — the four jobs

| Job | What the app does | MVP | Later |
|---|---|---|---|
| **Predict** | Shows compartment risk classes and season readiness level (Green/Amber/Red); shows fuel-treatment status (slashed / sprayed / casing) per compartment | Risk and readiness display from imported data; manual readiness level | Daily danger rating from weather (Open-Meteo), treatment progress pulled from the weekly planning/actuals data |
| **Detect** | One-tap fire report from anyone; verification workflow; satellite hotspots shown as "unverified detections" | Manual reports; FIRMS hotspot import (file/script) displayed and promotable to incident | Automated FIRMS ingest every few hours; Firehawk camera alert integration (to be investigated); Sentinel-2 dNBR burn-scar check |
| **Respond** | Incident lifecycle, dispatch to crews, acknowledgement, navigation to fire (bearing/distance offline), water points and assets, status timeline | Full lifecycle; in-app alerts + alarm; straight-line navigation; assets on map | Pre-computed road routes (ArcGIS Network Analyst export), SMS fallback, shift roster auto-targeting |
| **Record** | Perimeter walking with GPS, geotagged photos, area/perimeter calculation, cause and damage fields, exportable record | Perimeter walk, photos, area in ha, cause, export GeoJSON/CSV | Burn severity (dNBR) cross-check, season report, Verra evidence pack |

## 5. Users (functional roles)

Roles are defined by **what they can do**, not by job title. Mapping EcoPlanet positions to roles is a decision for the owner (see §10).

| Role | Needs | Key actions |
|---|---|---|
| **Reporter** (any field worker, supervisor, community volunteer) | Report a fire fast; see if it is already known | Report fire, add photo, see incident status |
| **Observer** (camera monitor, lookout, patrol) | Report with bearing/range or location; flag satellite hotspots as real or false | Report, verify/dismiss detection |
| **Responder** (crew member / crew lead) | Know they are called, where to go, how far, who else is there; log arrival | Receive alert, acknowledge, navigate, check in, walk perimeter |
| **Coordinator** (person running the response) | See all incidents, crews, water points; dispatch; escalate; close | Verify, dispatch, reassign, change status, close |
| **Manager** (read-mostly) | Situation at a glance; fire statistics | Dashboard view, export |
| **Admin/Analyst** (GIS) | Load compartments, assets, risk layers, users, crews; export records | Data management, offline pack config, exports |

## 6. Concept of operations (the fire, start to finish)

1. **Detect** — a person sees smoke, a camera operator spots it, or a satellite hotspot appears.
2. **Report** — one tap on the red button. GPS fix is stamped automatically (or bearing/range if the reporter is far away). Saved locally in < 1 s; syncs when possible. Nearby devices that are online see it in seconds.
3. **Verify** — a coordinator confirms, dismisses (false alarm) or asks an observer to check. Unverified reports are shown as such but are visible to all.
4. **Mobilise** — the coordinator dispatches crews (day or night standby team for that block, plus support). Responders get an alarm; their acknowledgement time is recorded.
5. **Respond** — crews navigate (bearing/distance/ETA, nearest water points, access notes), check in on arrival, send status/needs, and update spread observations.
6. **Contain and control** — status moves Responding → On scene → Contained → Controlled → Out (cold). Each change is a timestamped event with the author and GPS.
7. **Record** — a responder walks the burnt perimeter; the app computes area (ha). Cause, damage and photos are added.
8. **Learn** — closed incidents feed risk re-ranking, resource positioning, budget justification and Verra monitoring evidence.

**Offline behaviour of this loop:** steps 2, 5, 6, 7 work fully offline on the individual phone. Sharing between phones requires *some* connectivity (cellular or, later, a mesh/SMS fallback). The app makes clear which information is local-only and which is confirmed synced (see sync indicator, design doc).

## 7. Release plan

| Phase | Goal | Contents | Gate to proceed |
|---|---|---|---|
| **0 — Foundations** (now) | Agree what we're building | These documents; confirm open decisions (§10) | Owner sign-off |
| **1 — MVP (field-testable PWA)** | Prove the core loop works offline and syncs | Report, incidents, dispatch + ack, navigate (bearing/distance), perimeter walk, offline map pack, sync, demo-data seed, Supabase schema | Pass test plan in `05_TECHNICAL_ARCHITECTURE` §10 on real phones, including airplane-mode drill |
| **2 — Pilot (one block, 2–3 weeks)** | Real-world reliability and adoption | Real compartment/asset data, org-owned Supabase (Pro), push/SMS fallback, FIRMS ingest, role/shift targeting, in-field training | Report-to-ack and GPS-accuracy targets met (see §8) |
| **3 — Season rollout** | All blocks | Camera integration, road routing, dashboards, weekly report hooks | Operations sign-off |
| **4 — Hardening and carbon evidence** | Audit-ready records | dNBR cross-check, Verra evidence pack, native wrapper for background tracking | Season review |

Dates are deliberately not set: the owner should set them against the fire-season calendar and the Block-by-block readiness timeline.

## 8. Success metrics

| Metric | Target (MVP/pilot) | How measured |
|---|---|---|
| Time to file a fire report | ≤ 10 s from app open; ≤ 2 taps from any screen | Timestamped test script |
| Local save latency | < 300 ms perceived, < 1 s worst case | Instrumented in app |
| Report → coordinator sees it (online) | < 5 s median | Server timestamp vs client |
| Report → first acknowledgement | < 3 min median (pilot target) | Events table |
| Detection → first crew on scene | Baseline in pilot, then −30% | Events table |
| GPS fix quality at report | ≥ 90% of reports with ≤ 10 m accuracy in open terrain | Stored `accuracy_m` |
| Records lost | 0 | Outbox vs server reconciliation |
| Sync backlog cleared after regaining signal | < 60 s for typical day's data | Sync log |
| Fires with complete record (perimeter, area, cause) | ≥ 90% | Query |

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Browser (PWA) cannot track in background or with screen locked** | Perimeter walk or tracking stops if the app is backgrounded | Screen Wake Lock during walks; clear on-screen warning; native wrapper (Capacitor) in Phase 4 if needed |
| **No signal means phones cannot alert each other** | Dispatch only reaches phones with coverage | Design for store-and-forward; SMS/voice fallback via a gateway (Phase 2); radio remains primary; this must be tested on site |
| **Cell coverage at site is unverified** | Plan may be over/under-built | Pilot starts with a coverage walk using the app's sync log |
| **Map-tile licensing** (bulk offline download from free providers is typically not permitted) | Offline map may breach terms | Use a licensed or self-hosted tile source (e.g., export tiles from ArcGIS or host PMTiles in Supabase Storage); MVP tile URL is configurable and dev-only default is flagged |
| **Source data not yet seen** (roads, camera locations/coverage, historical fires, water points) | Core layers empty | MVP ships with demo seed; data audit before pilot |
| **Supabase personal free tier** pauses after inactivity and has limits | Outage during season | Org-owned account on a paid plan before pilot |
| **False alarms flood the board** | Alert fatigue | Verification step; dismiss with reason; duplicates merged by proximity |
| **Adoption under stress** | Tool unused in a real fire | Training drill, 2-tap report, radio/phone remain the fallback; run drills before the season |
| **Single-developer dependency** | Maintenance risk | Plain stack (PWA + Supabase), documented schema, tests |
| **Data protection** (staff and community locations) | Privacy | Live crew positions visible only to Coordinator role; retention policy; consent in onboarding |

## 10. Decisions needed from the owner (not assumed)

1. **Devices:** Which phones do crews and supervisors have (Android version, GNSS capability)? Are phones personal or company-issued/shared?
2. **Role mapping:** which positions are Coordinator, Observer, Responder, Manager?
3. **Dispatch authority:** who may dispatch and who may close an incident?
4. **Notification channel:** is an SMS provider (e.g., Africa's Talking or Twilio) acceptable, and who pays?
5. **Map tiles:** licensed/self-hosted source, or export from your ArcGIS Online org?
6. **Supabase:** go-ahead to create the org-owned project under the company account, and plan tier.
7. **Languages:** English only for the pilot, or Twi/other labels?
8. **Source data:** access roads/tracks, compartment boundaries, Firehawk camera locations, water points, historical fire records — where can I get them (the earlier note says they exist but were not personally verified)?
9. **Camera integration:** does Firehawk expose alerts (API/email/webhook), or is it viewed by eye only?
10. **Units and datum:** assumed hectares, km, WGS84 with UTM Zone 30N (EPSG:32630) display — confirm.
11. **Block-level crews:** is the 20-per-block (10 day/10 night) standby structure final, and how are community members to be registered?

## 11. Out of scope for the MVP

Replacing radio/phone; automated camera detection; live vehicle telematics; fire-spread simulation; HR or payroll; budget management; ArcGIS Online two-way sync (the architecture allows a one-way push later, consistent with the hybrid design already chosen).
