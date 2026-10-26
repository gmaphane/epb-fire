#!/usr/bin/env python3
"""
Port the EPBWA fire layers (01_raw_data/fire) into the fire app's tables.

    python scripts/port_fire_layers.py "C:/Users/Gladwell/Documents/BandaiHills_MRV/01_raw_data/fire"

Writes supabase/seed/estate_layers.json, which `npm run load:layers` uploads to Supabase.
Needs: geopandas, shapely, pandas (conda/ArcGIS Pro Python works).

Re-runnable: every record gets a stable id (uuid5 of layer + key), so a second run updates rather than duplicates.
Geometry is simplified for phones (2 m compartments/roads, 3 m routes): field display, not survey use.
ArcGIS/the geodatabase stay the master copy.
"""
import json, os, sys, uuid, re, warnings
from datetime import datetime
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union

warnings.filterwarnings("ignore")
NS = uuid.UUID("6f1b6f0e-3c1e-4c1a-9f7a-0e5b2f8a1d00")
UTM = 32630
WAR = "Fire_War_Room_2026-27"


def sid(*parts) -> str:
    return str(uuid.uuid5(NS, "|".join(str(p) for p in parts)))


def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.isoformat()[:10]
    if hasattr(v, "item"):
        v = v.item()
    return v


def props(row, keys):
    return {k: clean(row[k]) for k in keys if k in row and clean(row[k]) is not None}


def _fix(g):
    """Valid, single-type geometry: repair self-intersections, drop slivers/degenerate parts."""
    from shapely.validation import make_valid
    from shapely.geometry import GeometryCollection, MultiLineString, LineString
    if g is None or g.is_empty:
        return g
    if g.geom_type in ("Polygon", "MultiPolygon", "GeometryCollection"):
        g = make_valid(g)
        polys = [x for x in getattr(g, "geoms", [g]) if x.geom_type in ("Polygon", "MultiPolygon")]
        parts = []
        for x in polys:
            parts.extend(getattr(x, "geoms", [x]))
        parts = [x for x in parts if x.area > 1.0]  # drop < 1 m² slivers (UTM)
        if not parts:
            return g
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    if g.geom_type in ("LineString", "MultiLineString"):
        lines = [x for x in getattr(g, "geoms", [g]) if x.length > 0.5 and len(x.coords) >= 2]
        if not lines:
            return g
        return lines[0] if len(lines) == 1 else MultiLineString(lines)
    return g


def gj(geom, tol_m, gdf_crs_utm=True):
    """Simplify in UTM metres, repair, drop Z, return valid WGS84 GeoJSON (7 dp ≈ 1 cm)."""
    from shapely import force_2d
    from shapely.geometry import shape
    g = gpd.GeoSeries([force_2d(geom)], crs=UTM if gdf_crs_utm else 4326)
    if not gdf_crs_utm:
        g = g.to_crs(UTM)
    if tol_m:
        g = g.simplify(tol_m, preserve_topology=True)
    g = gpd.GeoSeries([_fix(g.iloc[0])], crs=UTM).to_crs(4326)
    geo = mapping(g.iloc[0])
    def r(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            return [round(c[0], 7), round(c[1], 7)]
        return [r(x) for x in c]
    out = {"type": geo["type"], "coordinates": r(geo["coordinates"])}
    if not shape(out).is_valid:  # rounding re-broke it: repair once more in degrees
        from shapely.validation import make_valid
        fixed = make_valid(shape(out))
        if fixed.geom_type == "GeometryCollection":
            fixed = unary_union([x for x in fixed.geoms if x.geom_type in ("Polygon", "MultiPolygon", "LineString", "MultiLineString")])
        geo = mapping(fixed)
        out = {"type": geo["type"], "coordinates": r(geo["coordinates"])}
    return out


def read(p):
    g = gpd.read_file(p)
    if g.crs is None:
        g = g.set_crs(4326)
    return g.to_crs(UTM)


def main(root: Path):
    war = root / WAR
    out = {"compartments": [], "roads": [], "assets": [], "map_layers": [], "fire_history": []}
    notes = []

    # ---------- burnt areas (field-mapped 2024 + 2023 + walked perimeters) ----------
    burnt = read(root / "Fire Data" / "Burnt Area.shp")
    burnt_by_cpt = burnt.assign(ha=burnt.area / 1e4).groupby("Compart_ID")["ha"].sum().to_dict()
    for i, r in burnt.iterrows():
        out["map_layers"].append({"id": sid("burnt_area", "2024", i, r.get("Compart_ID")), "layer": "burnt_area",
            "name": f"Burnt {clean(r.get('Date')) or clean(r.get('Year'))} · {r.get('Compart_ID') or ''}".strip(" ·"),
            "geojson": gj(r.geometry, 2), "props": {**props(r, ["Compart_ID", "Block", "Date", "Year", "Causes"]), "area_ha": round(r.geometry.area / 1e4, 2), "source": "Fire Data/Burnt Area.shp"}})
    p23 = root / "2023 Fireland Burnt 20m.shp"
    if p23.exists():
        for i, r in read(p23).iterrows():
            out["map_layers"].append({"id": sid("burnt_area", "2023", i), "layer": "burnt_area", "name": "Burnt 2023 (20 m fire land)",
                "geojson": gj(r.geometry, 2), "props": {"Year": 2023, "area_ha": round(r.geometry.area / 1e4, 2), "source": p23.name}})
    for k in sorted(list((root / "Fire Data" / "KML").glob("*.kml")) + list((root / "Fire incidents").glob("*.kml"))):
        g = read(k)
        geoms = []
        for geom in g.geometry:
            if geom is None:
                continue
            if geom.geom_type in ("LineString", "LinearRing") and len(geom.coords) >= 4:
                geoms.append(Polygon(list(geom.coords)))
            elif geom.geom_type in ("Polygon", "MultiPolygon"):
                geoms.append(geom)
        if not geoms:
            continue
        poly = unary_union(geoms).buffer(0)
        m = re.match(r"(\d{4})(\d{2})(\d{2})", k.name)
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None
        cpt = re.search(r"\b([ABC]\s?\d{1,3})\b", k.stem.replace("Compt ", "C").replace("Area  ", ""))
        out["map_layers"].append({"id": sid("burnt_area", "kml", k.name), "layer": "burnt_area", "name": f"Burnt {date or ''} · {k.stem.split(' - ', 1)[-1]}",
            "geojson": gj(poly, 1), "props": {"Date": date, "area_ha": round(poly.area / 1e4, 2), "source": f"walked perimeter KML: {k.name}"}})

    # ---------- compartments ----------
    cpt = read(war / "compartments_wgs84.geojson")
    hrz = read(war / "high_risk_zones.geojson")
    hrz_u = unary_union(list(hrz.geometry.buffer(0)))
    gee = pd.read_csv(war / "gee_results" / "EPBWA_fire_by_compartment.csv")
    gee_p = gee.pivot_table(index="parent", columns="season", values="burnt_ha", aggfunc="sum").to_dict("index")
    # year of planting per compartment (youngest/oldest) → "young bamboo" in the fire app
    yop_path = Path(os.environ.get("YOP_CSV", war / "compartment_yop.csv"))
    yop = pd.read_csv(yop_path).set_index("parent").to_dict("index") if yop_path.exists() else {}
    notes.append(f"planting years: {len(yop)} compartments from {yop_path}" if yop else f"planting years: none ({yop_path} not found; set YOP_CSV)")
    n_high = 0
    for _, r in cpt.iterrows():
        code = str(r["parent"])
        geom = r.geometry.buffer(0)
        ha = geom.area / 1e4
        ov = geom.intersection(hrz_u).area / 1e4 if not geom.is_empty else 0
        pct = 100 * ov / ha if ha else 0
        high = pct >= 10 or ov >= 5
        n_high += high
        p = {"area_ha": round(ha, 1), "hrz_overlap_ha": round(ov, 1), "hrz_overlap_pct": round(pct, 1),
             "risk_basis": "2025 Fire Management Plan high-risk zones (≥10% or ≥5 ha overlap) — provisional, replace with the agreed ranking"}
        if code in burnt_by_cpt:
            p["burnt_2024_field_ha"] = round(burnt_by_cpt[code], 1)
        for season, v in (gee_p.get(code) or {}).items():
            if pd.notna(v):
                p[f"burnt_{season.replace('/', '_')}_s2_ha"] = round(float(v), 1)
        if code in yop:
            y = yop[code]
            p.update({"yop_youngest": int(y["youngest_yop"]), "yop_oldest": int(y["oldest_yop"]), "planted_ha": round(float(y["planted_ha"]), 1),
                      "yop_source": yop_path.name})
        out["compartments"].append({"id": sid("compartment", code), "code": code, "block": f"Block {r['block']}",
            "geojson": gj(geom, 2), "risk_class": "high" if high else "moderate", "risk_score": None,
            "treatment_status": "", "props": p})
    notes.append(f"compartments: {len(cpt)} ({n_high} flagged high from FMP high-risk zones)")

    # ---------- roads ----------
    rd = read(war / "deployment_inputs" / "roads_revised_centrelines.geojson")
    for i, r in rd.iterrows():
        status = clean(r.get("Status")) or "unknown"
        typ = (clean(r.get("Type")) or "road").lower()
        name = clean(r.get("Road")) or f"{typ.title()} road · Block {clean(r.get('Block')) or '?'}"
        out["roads"].append({"id": sid("road", i, name), "name": str(name), "geojson": gj(r.geometry, 2),
            "passable": status != "Needs Opening",
            "props": {**props(r, ["Type", "Status", "Block", "Grader", "Date_grade", "Date_opene", "Comment"]), "length_m": round(r.geometry.length), "source": "Roads_Revised.shp"}})
    trk = read(war / "roads_tracks.geojson")
    for i, r in trk.iterrows():
        out["roads"].append({"id": sid("track", i, r.get("name")), "name": str(clean(r.get("name")) or "Track"), "geojson": gj(r.geometry, 2),
            "passable": True, "props": {"type": "track", "length_m": round(r.geometry.length), "source": "roads_tracks.geojson"}})

    # ---------- assets ----------
    def pt(geom):
        g = gpd.GeoSeries([geom], crs=UTM).to_crs(4326).iloc[0]
        return round(g.y, 6), round(g.x, 6)

    for i, r in read(war / "water_points_register.geojson").iterrows():
        lat, lon = pt(r.geometry)
        nm = clean(r.get("name"))
        out["assets"].append({"id": sid("water", i, nm), "kind": "water", "name": f"Water point {nm}" if nm else f"Water point · Block {clean(r.get('block_id')) or '?'}",
            "lat": lat, "lon": lon, "props": {"block": clean(r.get("block_id")), "source": "water_points_register"}})
    for i, r in read(war / "camps_register.geojson").iterrows():
        lat, lon = pt(r.geometry)
        nm = clean(r.get("name"))
        kind = "water" if nm and "water" in nm.lower() else "camp"
        label = nm if nm and kind == "camp" else ("Water point (camp register)" if kind == "water" else f"Camp · Block {clean(r.get('block_id')) or '?'}")
        out["assets"].append({"id": sid("camp", i, nm), "kind": kind, "name": label, "lat": lat, "lon": lon,
            "props": {"block": clean(r.get("block_id")), "source": "camps_register"}})
    cams = pd.read_csv(root / "fire_towers_cameras.csv")
    for _, r in cams.iterrows():
        g = gpd.GeoSeries(gpd.points_from_xy([r["x"]], [r["y"]]), crs=UTM).to_crs(4326).iloc[0]
        out["assets"].append({"id": sid("lookout", r["name"]), "kind": "camera" if r["type"] == "camera" or r.get("firehawk_camera") == "yes" else "tower",
            "name": r["name"], "lat": round(g.y, 6), "lon": round(g.x, 6),
            "props": {"type": r["type"], "firehawk_camera": r["firehawk_camera"], "position_accuracy": "±300 m (georeferenced map)", "source": r["source"]}})
    for i, r in read(war / "standby_deployment" / "standby_posts.geojson").iterrows():
        lat, lon = pt(r.geometry)
        out["assets"].append({"id": sid("post", r["post"]), "kind": "standby_post", "name": f"Post {r['post']} ({r['shift']})", "lat": lat, "lon": lon,
            "props": props(r, ["block", "shift", "post", "elev_m", "view_ha", "hotspots_in_view", "compartment", "tricycle"])})
    for i, r in read(war / "standby_deployment" / "standby_vehicle_parking.geojson").iterrows():
        lat, lon = pt(r.geometry)
        out["assets"].append({"id": sid("parking", r["block"], r["shift"]), "kind": "parking", "name": f"{r['unit']} · Block {r['block']} {r['shift']}",
            "lat": lat, "lon": lon, "props": props(r, ["block", "shift", "unit", "furthest_post_min"])})
    for i, r in read(war / "deployment_inputs" / "communities.geojson").iterrows():
        lat, lon = pt(r.geometry)
        out["assets"].append({"id": sid("community", clean(r.get("Name")), i), "kind": "community", "name": str(clean(r.get("Name")) or "Community"),
            "lat": lat, "lon": lon, "props": {"source": "Communities.shp"}})

    # ---------- overlay layers ----------
    def layer(path, name_layer, tol, name_fn, keys=()):
        g = read(path)
        for i, r in g.iterrows():
            if r.geometry is None or r.geometry.is_empty:
                continue
            out["map_layers"].append({"id": sid(name_layer, path.name, i), "layer": name_layer, "name": name_fn(r, i),
                "geojson": gj(r.geometry, tol), "props": {**props(r, keys), "source": path.name}})
    layer(war / "deployment_inputs" / "firebreaks_all.geojson", "firebreak", 2, lambda r, i: f"Firebreak {clean(r.get('id')) or i + 1}")
    layer(war / "high_risk_zones.geojson", "high_risk_zone", 2, lambda r, i: f"High-risk zone {i + 1}")
    layer(war / "deployment_inputs" / "FireHawk_coverage_digitised.geojson", "camera_coverage", 5, lambda r, i: f"FireHawk view: {clean(r.get('camera'))}", ["camera", "radius_m", "visible_ha"])
    layer(war / "standby_deployment" / "standby_routes.geojson", "standby_route", 3, lambda r, i: f"Patrol {clean(r.get('crew')) or clean(r.get('unit')) or ''} · Block {r.get('block')} {r.get('shift')}", ["block", "shift", "unit", "crew", "km", "loop_min"])
    layer(war / "deployment_inputs" / "waterways.geojson", "waterway", 2, lambda r, i: "Waterway")

    # ---------- fire history (server only) ----------
    fr = gpd.read_file(war / "deployment_inputs" / "firms_detections_2016_2026.geojson")
    for i, r in fr.iterrows():
        d = clean(r.get("date"))
        out["fire_history"].append({"id": sid("firms", i, d, r.get("lat"), r.get("lon")), "source": "firms_modis", "observed_on": str(d)[:10] if d else None, "observed_time": None,
            "lat": round(float(r["lat"]), 6), "lon": round(float(r["lon"]), 6), "props": props(r, ["t21_k", "confidence"])})
    al = pd.read_csv(root / "Fire Alerts 2025.csv")
    al.columns = [c.strip() for c in al.columns]
    for i, r in al.iterrows():
        try:
            lat, lon = float(r["Lat"]), float(r["Long"])
        except (TypeError, ValueError):
            continue
        if pd.isna(lat) or pd.isna(lon):
            continue
        d = None
        try:
            d = datetime.strptime(str(r["Date"]).strip(), "%d/%m/%y").date().isoformat()
        except ValueError:
            pass
        out["fire_history"].append({"id": sid("alert", i, r.get("Date"), lat, lon), "source": "alert_log", "observed_on": d, "observed_time": clean(r.get("Time")),
            "lat": round(lat, 6), "lon": round(lon, 6), "props": {k: clean(r.get(k)) for k in ["from", "to", "compartment", "duration", "Alert", "comments", "Remarks"] if clean(r.get(k)) is not None}})

    # extent for the app's default view / offline pack
    b = cpt.to_crs(4326).total_bounds
    out["_meta"] = {"generated": datetime.now().isoformat(timespec="seconds"), "source": str(root), "notes": notes,
                    "bbox_wgs84": [round(b[1] - 0.01, 3), round(b[0] - 0.01, 3), round(b[3] + 0.01, 3), round(b[2] + 0.01, 3)],
                    "center": [round((b[1] + b[3]) / 2, 4), round((b[0] + b[2]) / 2, 4)],
                    "counts": {k: len(v) for k, v in out.items() if isinstance(v, list)}}
    dest = Path(__file__).resolve().parent.parent / "supabase" / "seed" / "estate_layers.json"
    dest.write_text(json.dumps(out, ensure_ascii=False))
    print(json.dumps(out["_meta"], indent=1))
    print(f"wrote {dest} ({dest.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "."))
