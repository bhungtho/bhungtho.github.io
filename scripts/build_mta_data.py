#!/usr/bin/env python3
"""Extract station, route, variant, and track-segment JSON from GTFS feeds.

Processes every feed in FEEDS and writes web/data/{stations,routes,variants,
segments}.json. Ids are namespaced with the feed key ("sub:R05", "lirr:1") so
agency ids cannot collide. Segment keys are the two station ids sorted,
joined by "|", with coordinates running from the lower id to the higher.

Usage: python3 build_data.py
"""

import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
import zipfile

# (key, name, url). url=None means manual: drop .gtfs/<key>.zip in place
# (NJ Transit requires a developer.njtransit.com account to download).
FEEDS = [
    ("sub", "Subway", "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"),
    ("lirr", "LIRR", "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip"),
    ("mnr", "Metro-North", "https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip"),
    ("njt", "NJ Transit", None),
    ("fer", "NYC Ferry", "http://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx"),
]

BASE = os.path.dirname(os.path.abspath(__file__))
# Overridable so the same script runs locally and in CI.
CACHE_DIR = os.environ.get("CACHE_DIR") or os.path.join(BASE, ".gtfs")
OUT_DIR = os.environ.get("OUT_DIR") or os.path.join(BASE, "web", "data")

# NYC 2020 census tracts, clipped to shoreline, with parent NTA names.
# Tracts (not NTAs directly) because the published NTA polygons include
# interior waterways, which legally belong to Manhattan out to the opposite
# shoreline and so put East River piers in Manhattan neighborhoods.
TRACTS_URL = "https://data.cityofnewyork.us/api/geospatial/63ge-mke6?method=export&format=GeoJSON"

# Scales longitude so polyline projections use roughly isotropic distances.
COS_LAT = math.cos(math.radians(40.73))


def download(url, path, attempts=3):
    for i in range(attempts):
        try:
            urllib.request.urlretrieve(url, path)
            return
        except Exception as e:
            if i == attempts - 1:
                raise
            print(f"download of {url} failed ({e}); retrying ...")
            time.sleep(10 * (i + 1))


def feed_zip_path(key, url):
    path = os.path.join(CACHE_DIR, f"{key}.zip")
    if os.path.exists(path):
        return path
    if url is None:
        return None
    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"[{key}] downloading {url} ...")
    download(url, path)
    return path


def read_csv(zf, name):
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        yield from csv.DictReader(text)


def normalize_route(s):
    """Normalized route alias: lowercase, punctuation to spaces, collapsed."""
    s = re.sub(r"[-/().,'\u2013\u2014]", " ", s.lower())
    return " ".join(s.split())


def route_aliases(short_name, long_name):
    aliases = set()
    if short_name:
        aliases.add(normalize_route(short_name))
    if long_name:
        norm = normalize_route(long_name)
        aliases.add(norm)
        # "babylon branch" -> also "babylon"; "harlem line" -> also "harlem"
        stripped = re.sub(r"\s+(branch|line)$", "", norm)
        aliases.add(stripped)
    aliases.discard("")
    return sorted(aliases)


def scaled(lat, lon):
    return (lon * COS_LAT, lat)


def polyline_cumlen(pts):
    cum = [0.0]
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dy = pts[i][1] - pts[i - 1][1]
        cum.append(cum[-1] + math.hypot(dx, dy))
    return cum


def project_onto(pts, cum, p):
    """(distance along polyline, offset) of the closest point on it to p."""
    best_d2 = float("inf")
    best_along = 0.0
    px, py = p
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        vx, vy = bx - ax, by - ay
        seg_len2 = vx * vx + vy * vy
        if seg_len2 == 0:
            t = 0.0
        else:
            t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / seg_len2))
        cx, cy = ax + t * vx, ay + t * vy
        d2 = (px - cx) ** 2 + (py - cy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_along = cum[i] + t * math.sqrt(seg_len2)
    return best_along, math.sqrt(best_d2)


def slice_polyline(raw_pts, cum, d0, d1):
    """Coordinates ([lon, lat]) of the polyline between distances d0 < d1."""

    def point_at(d):
        for i in range(1, len(cum)):
            if cum[i] >= d:
                seg = cum[i] - cum[i - 1]
                t = 0.0 if seg == 0 else (d - cum[i - 1]) / seg
                lat = raw_pts[i - 1][0] + t * (raw_pts[i][0] - raw_pts[i - 1][0])
                lon = raw_pts[i - 1][1] + t * (raw_pts[i][1] - raw_pts[i - 1][1])
                return [round(lon, 6), round(lat, 6)]
        return [round(raw_pts[-1][1], 6), round(raw_pts[-1][0], 6)]

    coords = [point_at(d0)]
    for i in range(len(cum)):
        if d0 < cum[i] < d1:
            coords.append([round(raw_pts[i][1], 6), round(raw_pts[i][0], 6)])
    coords.append(point_at(d1))
    out = [coords[0]]
    for c in coords[1:]:
        if c != out[-1]:
            out.append(c)
    return out


def process_feed(key, zf):
    """Extract namespaced stations, routes, variants, segments from one feed."""
    ns = lambda raw: f"{key}:{raw}"

    # --- stops ---
    stations = {}
    parent_of = {}
    rows = list(read_csv(zf, "stops.txt"))
    has_parents = any(r.get("location_type") == "1" for r in rows)
    for row in rows:
        sid = row["stop_id"]
        if has_parents:
            if row.get("location_type") == "1":
                stations[ns(sid)] = _station(key, row)
            elif row.get("parent_station"):
                parent_of[sid] = row["parent_station"]
        else:
            # Feed defines no parent stations (LIRR, MNR): stops ARE stations.
            stations[ns(sid)] = _station(key, row)

    # --- routes ---
    routes = {}
    for row in read_csv(zf, "routes.txt"):
        short = (row.get("route_short_name") or "").strip()
        long = (row.get("route_long_name") or "").strip()
        color = (row.get("route_color") or "").strip()
        text_color = (row.get("route_text_color") or "").strip()
        routes[ns(row["route_id"])] = {
            "sys": key,
            "label": short or long or row["route_id"],
            "aliases": route_aliases(short, long),
            "color": f"#{color}" if color else None,
            "textColor": f"#{text_color}" if text_color else None,
        }

    # Variants must come from all trips, not one per shape: MNR reuses one
    # shape for hundreds of different skip-stop patterns.
    trip_meta = {}  # trip_id -> (routeKey, shape_id)
    for row in read_csv(zf, "trips.txt"):
        trip_meta[row["trip_id"]] = (ns(row["route_id"]), row.get("shape_id") or None)

    # --- stop_times for every trip ---
    trip_stops = {}
    for row in read_csv(zf, "stop_times.txt"):
        t = row["trip_id"]
        if t in trip_meta:
            trip_stops.setdefault(t, []).append(
                (int(row["stop_sequence"]), row["stop_id"]))

    # --- shape geometry ---
    shape_pts = {}
    for row in read_csv(zf, "shapes.txt"):
        shape_pts.setdefault(row["shape_id"], []).append(
            (int(row["shape_pt_sequence"]),
             float(row["shape_pt_lat"]),
             float(row["shape_pt_lon"]))
        )
    for shp, pts in shape_pts.items():
        pts.sort()
        shape_pts[shp] = [(lat, lon) for _, lat, lon in pts]

    # --- variants: distinct stop patterns per route across all trips ---
    variants = {}
    seen_seqs = {}
    slice_jobs = {}  # (shape_id, station seq tuple), deduped, for slicing
    for trip_id, (route, shp) in trip_meta.items():
        stops = trip_stops.get(trip_id)
        if not stops:
            continue
        seq = []
        for _, stop_id in sorted(stops):
            parent = ns(parent_of.get(stop_id, stop_id))
            if parent in stations and (not seq or seq[-1] != parent):
                seq.append(parent)
        if len(seq) < 2:
            continue
        tup = tuple(seq)
        if tup not in seen_seqs.setdefault(route, set()):
            seen_seqs[route].add(tup)
            variants.setdefault(route, []).append(seq)
            if shp:
                slice_jobs.setdefault((shp, tup), seq)

    # --- segments ---
    segments = {}
    skipped = []
    for (shp, _), seq in slice_jobs.items():
        raw_pts = shape_pts.get(shp)
        if not raw_pts or len(raw_pts) < 2:
            continue
        pts = [scaled(lat, lon) for lat, lon in raw_pts]
        cum = polyline_cumlen(pts)
        along = {}
        for sid in seq:
            st = stations[sid]
            along[sid] = project_onto(pts, cum, scaled(st["lat"], st["lon"]))
        for a, b in zip(seq, seq[1:]):
            lo, hi = sorted((a, b))
            seg_key = f"{lo}|{hi}"
            if seg_key in segments:
                continue
            da, off_a = along[a]
            db, off_b = along[b]
            # Offset > ~550 m means the projection snapped to the wrong part
            # of the shape; skip and let another shape or fallback cover it.
            if off_a > 0.005 or off_b > 0.005 or abs(db - da) < 1e-9:
                skipped.append(seg_key)
                continue
            d0, d1 = sorted((da, db))
            coords = slice_polyline(raw_pts, cum, d0, d1)
            if len(coords) < 2:
                skipped.append(seg_key)
                continue
            forward_first = a if da < db else b
            if forward_first != lo:
                coords.reverse()
            segments[seg_key] = coords

    # Straight-line fallback for pairs no shape could slice.
    missing = {k for k in skipped if k not in segments}
    for seg_key in missing:
        lo, hi = seg_key.split("|")
        a, b = stations[lo], stations[hi]
        segments[seg_key] = [
            [round(a["lon"], 6), round(a["lat"], 6)],
            [round(b["lon"], 6), round(b["lat"], 6)],
        ]

    n_var = sum(len(v) for v in variants.values())
    print(f"[{key}] {len(stations)} stations, {len(routes)} routes, "
          f"{n_var} variants, {len(segments)} segments"
          + (f", {len(missing)} straight-line fallbacks" if missing else ""))
    return stations, routes, variants, segments


def _station(sys_key, row):
    return {
        "name": row["stop_name"],
        "lat": float(row["stop_lat"]),
        "lon": float(row["stop_lon"]),
        "sys": sys_key,
    }


def point_in_rings(lon, lat, rings):
    """Even-odd ray casting over all rings (handles holes)."""
    inside = False
    for ring in rings:
        for i in range(len(ring) - 1):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i + 1][0], ring[i + 1][1]
            if (y1 > lat) != (y2 > lat):
                if lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                    inside = not inside
    return inside


def _ring_centroid(rings):
    """Area-weighted centroid via the shoelace formula."""
    a = cx = cy = 0.0
    for ring in rings:
        for i in range(len(ring) - 1):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i + 1][0], ring[i + 1][1]
            cross = x1 * y2 - x2 * y1
            a += cross
            cx += (x1 + x2) * cross
            cy += (y1 + y2) * cross
    if abs(a) < 1e-12:
        return None
    return (cx / (3 * a), cy / (3 * a))


def assign_neighborhoods(stations):
    """Set a "hood" (NTA name) on each station, or None outside NYC.

    Containment alone misassigns two classes: piers (legally Manhattan
    slivers on the far shore) and stations inside park/airport/yard tracts.
    Both are caught by comparing distance-to-containing-tract-centroid
    against distance-to-nearest-tract-centroid; ferries skip containment
    entirely and always take the nearest tract.
    """
    path = os.path.join(CACHE_DIR, "tracts.geojson")
    if not os.path.exists(path):
        os.makedirs(CACHE_DIR, exist_ok=True)
        print(f"downloading census tracts from {TRACTS_URL} ...")
        download(TRACTS_URL, path)
    feats = json.load(open(path))["features"]

    tracts = []
    for f in feats:
        rings = [ring for poly in f["geometry"]["coordinates"] for ring in poly]
        c = _ring_centroid(rings)
        if not c:
            continue
        xs = [pt[0] for ring in rings for pt in ring]
        ys = [pt[1] for ring in rings for pt in ring]
        tracts.append({
            "hood": f["properties"]["ntaname"],
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "centroid": c,
            "rings": rings,
        })

    def dist2(lon, lat, c):
        return ((lon - c[0]) * COS_LAT) ** 2 + (lat - c[1]) ** 2

    assigned = 0
    for sid, st in stations.items():
        lon, lat = st["lon"], st["lat"]
        nearest = min(tracts, key=lambda t: dist2(lon, lat, t["centroid"]))
        d_near = math.sqrt(dist2(lon, lat, nearest["centroid"]))
        containing = None
        for t in tracts:
            x0, y0, x1, y1 = t["bbox"]
            if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_rings(lon, lat, t["rings"]):
                containing = t
                break
        if sid.startswith("fer:"):
            st["hood"] = nearest["hood"]
        elif containing:
            d_c = math.sqrt(dist2(lon, lat, containing["centroid"]))
            # Contained but far from the tract's bulk while another tract's
            # bulk is close: a sliver, park, or water extension. ~0.0054 deg
            # is roughly 600 m.
            sliver = d_c > 3 * d_near and d_c > 0.0054
            st["hood"] = (nearest if sliver else containing)["hood"]
        elif d_near < 0.0054:
            st["hood"] = nearest["hood"]
        else:
            st["hood"] = None  # outside NYC (commuter rail)
        if st["hood"]:
            assigned += 1
    print(f"{assigned}/{len(stations)} stations assigned a neighborhood")


def main():
    all_stations, all_routes, all_variants, all_segments = {}, {}, {}, {}
    for key, name, url in FEEDS:
        path = feed_zip_path(key, url)
        if path is None:
            print(f"[{key}] {name}: no .gtfs/{key}.zip and no download URL; skipped")
            continue
        stations, routes, variants, segments = process_feed(key, zipfile.ZipFile(path))
        all_stations.update(stations)
        all_routes.update(routes)
        all_variants.update(variants)
        all_segments.update(segments)

    assign_neighborhoods(all_stations)

    # Fill polygons for the map's neighborhood overlay: shoreline-clipped
    # tracts tagged with their NTA, limited to station-served neighborhoods.
    used_hoods = {s["hood"] for s in all_stations.values() if s["hood"]}
    feats = json.load(open(os.path.join(CACHE_DIR, "tracts.geojson")))["features"]
    hood_feats = []
    for f in feats:
        hood = f["properties"]["ntaname"]
        if hood not in used_hoods:
            continue
        coords = [
            [[[round(x, 5), round(y, 5)] for x, y in ring] for ring in poly]
            for poly in f["geometry"]["coordinates"]
        ]
        hood_feats.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": coords},
            "properties": {"hood": hood},
        })
    hoods_fc = {"type": "FeatureCollection", "features": hood_feats}
    print(f"{len(hood_feats)} tract polygons across {len(used_hoods)} neighborhoods")

    # Neighborhood borders for the whole city, dissolved from tracts: an edge
    # shared by two tracts of the same NTA is internal and dropped; edges
    # between different NTAs or on the shoreline survive, then get chained
    # into polylines. Tracts tile the city topologically, so shared edges
    # match exactly after rounding.
    edge_hoods = {}
    for f in feats:
        hood = f["properties"]["ntaname"]
        for poly in f["geometry"]["coordinates"]:
            for ring in poly:
                pts = [(round(x, 5), round(y, 5)) for x, y in ring]
                for a, b in zip(pts, pts[1:]):
                    if a == b:
                        continue
                    key = (a, b) if a < b else (b, a)
                    edge_hoods.setdefault(key, []).append(hood)
    kept = [k for k, hs in edge_hoods.items() if len(set(hs)) > 1 or len(hs) == 1]

    adj = {}
    for a, b in kept:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    visited_edges = set()
    lines = []
    starts = [n for n in adj if len(adj[n]) != 2] + list(adj)
    for start in starts:
        for nxt in list(adj[start]):
            ek = (start, nxt) if start < nxt else (nxt, start)
            if ek in visited_edges:
                continue
            visited_edges.add(ek)
            line = [start, nxt]
            prev, cur = start, nxt
            while len(adj[cur]) == 2:
                a, b = adj[cur]
                nxt2 = a if a != prev else b
                ek = (cur, nxt2) if cur < nxt2 else (nxt2, cur)
                if ek in visited_edges:
                    break
                visited_edges.add(ek)
                prev, cur = cur, nxt2
                line.append(cur)
            lines.append([[x, y] for x, y in line])
    borders_fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": lines},
            "properties": {},
        }],
    }
    print(f"{len(kept)} border edges chained into {len(lines)} polylines")

    # An alias mapping to multiple routes makes sheet rows ambiguous.
    alias_owners = {}
    for rk, r in all_routes.items():
        for a in r["aliases"]:
            alias_owners.setdefault(a, []).append(rk)
    collisions = {a: ks for a, ks in alias_owners.items() if len(ks) > 1}
    if collisions:
        print(f"WARNING: ambiguous route aliases (will error at resolve time): {collisions}")

    os.makedirs(OUT_DIR, exist_ok=True)
    for name, data in [
        ("stations.json", all_stations),
        ("routes.json", all_routes),
        ("variants.json", all_variants),
        ("segments.json", all_segments),
        ("hoods.json", hoods_fc),
        ("hood_borders.json", borders_fc),
    ]:
        path = os.path.join(OUT_DIR, name)
        with open(path, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"wrote {path} ({os.path.getsize(path) // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
