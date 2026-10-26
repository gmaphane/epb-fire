# Business Case

> **How to read the numbers.** Facts about the site come from your notes (11,145 ha landscape; Verra projects 2928/2929, VM0047; season plan with 20-person standby teams per block). Everything in **[A]** is an assumption I have made so the arithmetic can be shown; **replace with Finance/Operations figures**. I have no data on EcoPlanet's fire history, replanting cost per hectare, or current response times. The pilot's first job is to measure the baseline.

## 1. The problem in business terms

| Exposure | Why it matters |
|---|---|
| **Standing bamboo and carbon stock** | Fire destroys planted area and the above-ground biomass that underpins credit issuance. A burnt hectare is lost growth plus replacement cost. |
| **Verra non-permanence / reversals** | Fire events need to be documented and may affect net removals or buffer contributions. Confirm treatment with the methodology and the validation/verification body; the app produces the dated, geolocated evidence either way. |
| **Cost of the fire programme** | Standby teams (20 per block, 10 day/10 night), slashing and spraying already consume the budget under a no-hiring constraint. Coordination that wastes crew time is a direct cost. |
| **Safety** | Crews move toward fire in poor-visibility terrain; unknown positions and no check-in raise risk. |
| **Reporting and credibility** | Fire records feed the GM, Finance, and auditors. Records reconstructed afterwards are weaker. |

## 2. How the app creates value

1. **Shorter detection-to-attack time** — the biggest lever (§3).
2. **Better-targeted response** — right crew, right water point, right route; less duplicated effort.
3. **Fewer false-alarm callouts** — verification step plus satellite cross-check.
4. **Better data for decisions** — perimeters, causes and response times improve next season's risk ranking, crew positioning and budget case.
5. **Audit-ready evidence** — one clean record per fire.
6. **Safety** — acknowledgement, check-ins and (later) live positions.

## 3. Why minutes matter — an illustrative model

For a fire spreading at a roughly constant rate in all directions, area grows with the square of time. Real fires are elongated by wind and slope, but early growth is still strongly super-linear, so the shape of the result holds.

**Relative fire area at first attack (baseline = 90 minutes from ignition to crews applying water/tools = 1.00)**

| Ignition → first attack | Relative area | Change vs baseline |
|---|---|---|
| 120 min | 1.78 | +78% |
| **90 min (assumed baseline [A])** | **1.00** | — |
| 60 min | 0.44 | −56% |
| 45 min | 0.25 | −75% |
| 30 min | 0.11 | −89% |

Where the time goes (all of it measurable once the app is in use):

`undetected → detected → reported → verified → dispatched → crew told → crew moving → travel → at fire`

The app directly attacks four of these stages (reported, verified, dispatched, told) and informs travel. If those four stages currently take 40 minutes and the app takes them to 10, the saving is **30 minutes** — enough to move a 90-minute baseline to 60 minutes (−56% fire area at first attack under the model). *The 40-minute figure is [A]; measuring it is a pilot deliverable.*

## 4. Costs

### 4.1 Cash cost (annual, first year) — [A], check current vendor prices

| Item | Estimate | Notes |
|---|---|---|
| Supabase (Pro, org-owned) | ≈ US$300 | 25 US$/month; avoids free-tier inactivity pause; includes daily backups |
| SMS fallback | ≈ US$100–300 | Depends on volume and provider; Phase 2 |
| Map tiles | US$0–600 | US$0 if self-hosted from your own export; paid tile service otherwise |
| Phones | US$0 if existing devices are adequate | Add a budget line if rugged cases/power banks are needed |
| Domain / hosting for the PWA | ≈ US$0–100 | Static hosting is free or very cheap |
| **Total cash** | **≈ US$400–1,300** | Sum of the ranges above |

### 4.2 Time cost (not priced here)
Product design and build (this project), field testing and training drills, and weekly data management during the season. Internal salary cost is excluded; Finance can add it.

### 4.3 Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **A. Status quo** (calls, WhatsApp, ArcGIS) | No cost | Slow, lossy, no record, no offline picture |
| **B. ArcGIS Field Maps / QuickCapture / Survey123 only** | Already licensed; team trained | Alerting/dispatch workflow limited; offline-sync works but incident coordination and custom logic are awkward; per-user licences limit broad community use |
| **C. Commercial fire-management product** | Mature | Cost per seat, not tailored to bamboo/Ghana, vendor lock-in |
| **D. This app (PWA + Supabase)** | Tailored, offline-first, cheap, owned by EcoPlanet, fits the hybrid architecture already chosen | Build/maintenance effort; PWA limits (background GPS); needs testing discipline |

Recommendation: **D**, keeping ArcGIS as the system of record for routine field capture and pushing validated fire records to ArcGIS Online in a later phase, consistent with the hybrid design already adopted.

## 5. Break-even

Only the cash cost is included. Value of a hectare saved = replanting/establishment cost + lost growth + carbon-related loss. **I don't have EcoPlanet's figure**; the table shows break-even for a range.

| Value of a hectare saved [A] | Break-even at US$500 | at US$1,000 | at US$1,500 |
|---|---|---|---|
| US$500 /ha | 1.0 ha | 2.0 ha | 3.0 ha |
| US$1,500 /ha | 0.3 ha | 0.7 ha | 1.0 ha |
| US$3,000 /ha | 0.2 ha | 0.3 ha | 0.5 ha |
| US$5,000 /ha | 0.1 ha | 0.2 ha | 0.3 ha |

**Reading:** across the whole range, preventing **1–3 hectares** of loss in a season repays the cash cost. On an 11,145 ha landscape, 3 ha is 0.03% of the area. The honest uncertainty is not the cost; it is whether the app changes outcomes — which is why the pilot measures response times against a baseline.

## 6. Scenarios (season outcome)

All values [A]; illustrates the structure, not a forecast.

| Scenario | Fires/season | Avg area at first attack (ha) | Avg final area (ha) | Total burnt (ha) | Loss at US$1,500/ha |
|---|---|---|---|---|---|
| **Status quo** | 10 | 4.0 | 8.0 | 80 | US$120,000 |
| **App, modest effect** (attack 25% faster ≈ area −44%) | 10 | 2.3 | 4.5 | 45 | US$67,500 |
| **App, strong effect** (attack 50% faster ≈ area −75%) | 10 | 1.0 | 2.0 | 20 | US$30,000 |
| **App, no effect** | 10 | 4.0 | 8.0 | 80 | US$120,000 |

Final area is modelled as 2× area at first attack in these rows. In the "no effect" case the loss is unchanged and the cash cost (~US$1,000) is the whole downside — **downside is capped and small; upside is large relative to cost.**

## 7. Non-financial benefits
- A shared, defensible fire record for the GM, Finance, VP Forestry and auditors.
- Evidence for resource requests (more standby crews, water tanks, cameras) based on measured response times and burn data.
- Feeds the risk-ranking basis already agreed (bamboo consequence, not camps or community proximity).
- Reduces dependence on individuals remembering locations and phone numbers.
- Reusable at other EcoPlanet sites (Rwanda and others) given the shared ArcGIS organisation, if the global application effort allows.

## 8. What would make the case wrong

| If… | Then… |
|---|---|
| There is little or no cellular coverage in the fire-prone areas | Value shifts to local recording and perimeter capture; dispatch needs SMS/radio integration or a mesh solution. Pilot coverage test determines this. |
| Fires are mostly detected and fought within minutes already | Marginal time savings are small; value is mainly the record and learning. |
| Crews will not use a phone app under stress | Adoption fails regardless of design; mitigate with drills, 2-tap design, radio fallback. |
| Fire losses per hectare are low | Break-even needs more hectares saved; the evidence/reporting value still applies. |

## 9. Pilot test of the business case

Two to three weeks on one block:
1. Record baseline: for each real or drill fire, time to report, verify, dispatch, acknowledge, arrive.
2. Run at least two night-time drills and one no-signal drill.
3. Compare to the targets in `01_PRODUCT_DOCUMENT` §8.
4. Replace every [A] in this document with measured or Finance-supplied values, and decide to proceed to season rollout.
