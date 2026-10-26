# Design Language — "Field Topo GIS", adapted for fire response

Source: your Google Stitch design system (`field_topo_gis/DESIGN.md`) and the four mockups (Map, Incidents, Navigate, Perimeter). This document **keeps** that system and adds what a fire tool needs. Changes to the original are marked **Δ**.

## 1. Character

*Minimalist field cartography*: the map is the product; everything else floats above it, quiet until needed. Calm, legible in glare, trustworthy. Fire is the one thing allowed to be loud.

**Rule of loudness:** colour saturation and motion are reserved for (1) active fire, (2) things needing the user's action now, (3) data-safety warnings. Everything else is neutral or forest green.

## 2. Colour

### 2.1 Brand (from Stitch, unchanged)
| Token | Hex | Use |
|---|---|---|
| `primary` | `#00450d` | Deepest green: pressed states, header icon |
| `primary-container` | `#1b5e20` | Primary buttons, active nav, tracks |
| `secondary` | `#1b6d24` | Success, "synced", toggles |
| `secondary-container` | `#a0f399` | Positive chip fill |
| `tertiary-container` (moss) | `#e8f5e9` | Selected chip/card tint |
| `surface` / `background` | `#f7f9ff` | App background |
| `surface-container-*` | `#f1f4f9 … #e0e3e8` | Cards, panels |
| `on-surface` | `#181c20` | Text |
| `outline-variant` | `#c0c9bb` | Borders |
| `error` / `error-container` | `#ba1a1a` / `#ffdad6` | Active fire, danger |

### 2.2 **Δ** Fire-status palette (semantic, not decorative)
Each status has **colour + icon + word** — colour is never the only signal.

| Status | Colour | Icon | Notes |
|---|---|---|---|
| Reported (unverified) | Amber `#b26a00` on `#fff3d6` | Help-circle | Dashed outline on map |
| Confirmed / Active | Red `#ba1a1a` on `#ffdad6` | Flame | Pulsing ring on map (disabled with reduced-motion) |
| Responding / On scene | Orange `#c2410c` on `#ffe7d6` | Truck / Users | |
| Contained / Controlled | Blue-green `#0b6e6e` on `#d6f2f2` | Shield-check | |
| Out (cold) | Forest `#1b5e20` on `#e8f5e9` | Check-circle | |
| Dismissed (false alarm) | Grey `#6b7280` on `#f1f3f5` | X-circle | |
| Satellite detection | Magenta `#a21caf` on `#fae8ff` | Satellite | Always "unverified" until promoted |

### 2.3 **Δ** Risk ramp (compartments)
Sequential, colour-blind-safe, with pattern fills as a second channel: Low `#d9ead3` · Moderate `#f5e29a` · High `#f0a45d` · Very high `#d2553b` · Extreme `#8f1d1d`.

### 2.4 **Δ** Data-safety colours
| State | Colour | Meaning |
|---|---|---|
| Synced | `secondary` green | Confirmed on the server |
| Pending | Amber | Safe on this phone, waiting to send |
| Error | Red | Needs attention (tap for details) |
| Offline | Slate `#475569` | No network; everything still works |

### 2.5 **Δ** Night mode
Required because night crews attend fires after 18:00.
- Surfaces `#0f1411`/`#171d19`, text `#e6ece7`, brand green lightened to `#91d78a`.
- Fire red softened to `#ff8a80` on dark; no pure white areas; map dimmed (basemap brightness 60%).
- Optional red-shift (night-vision-preserving) toggle: swaps greens/blues for red/amber hues.
- Auto-switches by clock (18:00–06:00) with manual override; follows OS preference by default.

## 3. Typography
Unchanged: **Plus Jakarta Sans**, self-hosted (no CDN) so it renders offline.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| display-lg | 32/40 | 700 | Big numbers (distance, area) |
| headline-lg | 24/32 | 700 | Screen titles |
| headline-md | 20/28 | 600 | Card titles |
| headline-sm | 16/24 | 600 | List titles, callouts |
| body-lg / md / sm | 16 / 14 / 12 | 400 | Text |
| label-lg / md / sm | 14 / 12 / 10 | 600 | Buttons, chips, metadata |

- Coordinates and live numbers use `tabular-nums` (from the original).
- **Δ** Minimum text size 12 px; 10 px label-sm only for non-critical labels. Critical values (distance, area, accuracy, time) ≥ 20 px.
- **Δ** Mockup defects to fix: truncated text in the navigate header ("Bearing 042…"), cut-off right-hand badges, and low-contrast greys at 10–12 px. Use wrapping or abbreviations, never ellipsis on critical values.

## 4. Layout (canvas-anchored HUD, from Stitch)
- Full-bleed map; floating top capsule (project/location + sync chip); right-hand tool rail (compass, locate, layers, measure); bottom sheet with peek 88 px / half 45 vh / full 90 vh.
- Tablet/desktop: 380 px docked card at left (Coordinator view uses this plus a persistent incident list).
- Bottom navigation (5 items, same as mockups): **Map · Incidents · Navigate · Perimeter · Sync**.
- **Δ** A persistent **Report Fire** button (red, flame icon, 64 px) floats above the bottom nav on every screen except the report form itself. It is the single most prominent control in the app.
- **Δ** Safe areas respected (notches, gesture bars); bottom nav ≥ 64 px.

## 5. Shape, depth, spacing (unchanged)
Radii: pills 9999; cards 16; callouts 12; buttons 8. Spacing scale 4/8/12/16/24. Elevation levels 1–3 with soft, diffuse shadows and 1 px hairline borders (values as in the original).

## 6. Components

| Component | Spec |
|---|---|
| **Primary button** | Filled `primary-container`, white label-lg, 8 px radius, min-height 52 px (**Δ** from 44) |
| **Danger button** | Filled `error`, white label; used for Report Fire, Dispatch, Confirm fire |
| **Secondary button** | White, 1 px `#E5E7EB`, `#212529` text |
| **Map FAB** | 48 px circle, white, hairline border; active = green fill |
| **Chip** | Pill; selected = moss fill + green text/border |
| **Incident card** | Left status bar (6 px), status chip, title, meta row (age, source), coordinates block, two actions |
| **Status chip** | Colour + icon + word per §2.2 |
| **Sync chip** | In top capsule: dot + word (Synced / 3 pending / Offline / Error) — tap opens Sync screen |
| **GPS chip** | Accuracy ± m with quality dot (≤ 10 m green, ≤ 20 m amber, > 20 m red) and fix age |
| **Metric tile** | Label (label-md, muted) over value (display or headline) with unit; used for Distance / ETA / Bearing / Area |
| **Map pin callout** | Per original: 36 px thumbnail, label, pointer needle |
| **Alarm banner** (**Δ**) | Full-width red banner with big Acknowledge button; sound + vibration until acknowledged |
| **Toast** | Bottom, 3 s; never covers the Report button |
| **Empty state** | Icon + one sentence + the one action that fixes it |

## 7. Iconography
Outline icons, 24 px, 2 px stroke, consistent family (Lucide, bundled as inline SVG — **Δ** replaces the Material Symbols web font, which would need the network). Fire-specific: flame, satellite, droplets (water), camera, tower/eye (lookout), truck, users, tent (camp), alert-triangle (hazard).

## 8. Motion
Short (150–200 ms) ease-out for sheets and chips. Pulsing ring only on *active* fire markers. Respect `prefers-reduced-motion`. No decorative animation while GPS is acquiring other than a small spinner.

## 9. Content and voice
Short, direct, present tense. Metric units only.
- Good: "Saved on this phone. Will send when signal returns."
- Avoid: "Oops! Something went wrong."
Terminology: *Report*, *Incident*, *Crew*, *Dispatch*, *Acknowledge*, *On scene*, *Contained*, *Out*. Time as relative ("14 min ago") with absolute time on tap, 24-hour clock.

## 10. **Δ** Field-use rules
1. Never rely on colour alone.
2. A destructive or irreversible action asks for one confirmation; reporting never does.
3. Show the age of every live value ("GPS 3 s ago", "Updated 12 min ago"). Grey out and label stale values.
4. Disabled controls explain why in one line.
5. Everything critical reachable by thumb in the lower 60% of the screen.
6. Haptics on report saved, assignment received, acknowledgement; distinct patterns.

## 11. **Δ** Localisation of the mockups
The mockups were generated with US content (acres, miles, feet, NAD83, "National Forest", "Lincoln West"). The app uses: hectares, kilometres, metres, km/h, WGS84 with UTM 30N, site names (Bandai Hills Block A/B, North Bandai Block C), compartment codes (e.g. C026), and 24-hour time.

## 12. Screens in the MVP

| Screen | From mockup | Notes |
|---|---|---|
| Map | Map view | Layers, readiness banner, selected-incident sheet |
| Incidents | Incidents | Status filters; sync + offline banner at top |
| Incident detail | New | Timeline, crews, photos, actions |
| Report fire | New | Fast path, GPS banner, map pin refine |
| Dispatch | New | Select crews, instruction |
| Navigate | Navigate | Offline bearing/distance/ETA, arrow, water points |
| Perimeter | Perimeter | Walk recording, area in ha |
| Sync | Not mocked | Outbox, health, offline map pack, settings, export |
| Sign in | New | Offline-capable |
