// Trip logic: name resolution, trip-to-hop expansion, aggregation.
// No DOM or map dependencies; runs in the browser and under node for tests.

// Maps user spellings ("34th Street-Herald Square") to GTFS spellings
// ("34 St-Herald Sq").
export function normalizeName(name) {
  const tokenMap = {
    street: "st", streets: "st", avenue: "av", ave: "av", avs: "av",
    avenues: "av", boulevard: "blvd", square: "sq", park: "pk",
    parkway: "pkwy", place: "pl", plaza: "plaza", road: "rd",
    drive: "dr", court: "ct", terrace: "ter", heights: "hts",
    center: "ctr", junction: "jct", fort: "ft", saint: "st",
    highway: "hwy", expressway: "expwy", turnpike: "tpke",
    university: "univ", island: "is", beach: "bch", gardens: "gdns",
    north: "n", south: "s", east: "e", west: "w",
  };
  return name
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[-/().,'\u00b7]/g, " ")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => tokenMap[t] || t)
    .join(" ");
}

// Mirrors build_data.py's normalize_route.
export function normalizeRoute(s) {
  return s
    .toLowerCase()
    .replace(/[-/().,'\u2013\u2014]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// User route string ("N", "Babylon", "New Haven") -> route key ("sub:N",
// "lirr:1", "mnr:3").
export function buildRouteResolver(routes) {
  const byAlias = new Map();
  for (const [key, r] of Object.entries(routes)) {
    for (const a of r.aliases) {
      if (!byAlias.has(a)) byAlias.set(a, []);
      byAlias.get(a).push(key);
    }
  }
  return function resolveRoute(userRoute) {
    const norm = normalizeRoute(userRoute);
    const keys = byAlias.get(norm) || [];
    if (keys.length === 0) return { error: `unknown line "${userRoute}"` };
    if (keys.length > 1) {
      return {
        error: `line "${userRoute}" is ambiguous: ` +
          keys.map((k) => `${routes[k].label} (${k})`).join(", "),
      };
    }
    return { key: keys[0], label: routes[keys[0]].label, sys: routes[keys[0]].sys };
  };
}

// Station name + route key -> station id. Same-named stations (five 86 Sts)
// disambiguate by which the route serves; overrides pin anything left, keyed
// by normalized name or "name|routeKey".
export function buildResolver(stations, variants, overrides = {}) {
  // Word-order-insensitive key, used only when an exact match fails:
  // "59th Street-Lexington Avenue" vs the feed's "Lexington Av/59 St".
  const tokenKey = (norm) => norm.split(" ").sort().join(" ");
  const byName = new Map();
  const byTokens = new Map();
  for (const [id, s] of Object.entries(stations)) {
    const key = normalizeName(s.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(id);
    const tk = tokenKey(key);
    if (!byTokens.has(tk)) byTokens.set(tk, []);
    byTokens.get(tk).push(id);
  }
  const routeStations = new Map();
  for (const [route, seqs] of Object.entries(variants)) {
    const set = new Set();
    for (const seq of seqs) for (const id of seq) set.add(id);
    routeStations.set(route, set);
  }

  return function resolve(userName, route) {
    const norm = normalizeName(userName);
    const pinned = overrides[`${norm}|${route}`] ?? overrides[norm];
    if (pinned) {
      if (!stations[pinned]) {
        return { error: `override for "${userName}" points at unknown station id ${pinned}` };
      }
      return { id: pinned };
    }
    let candidates = byName.get(norm) || byTokens.get(tokenKey(norm)) || [];
    if (candidates.length === 0) {
      return { error: `no station matches "${userName}" (normalized: "${norm}")` };
    }
    const onRoute = routeStations.get(route);
    if (onRoute) {
      const filtered = candidates.filter((id) => onRoute.has(id));
      if (filtered.length > 0) candidates = filtered;
      else {
        return {
          error:
            `"${userName}" matches ${candidates.map((id) => `${id} (${stations[id].name})`).join(", ")} ` +
            `but none are served by the ${route}`,
        };
      }
    }
    if (candidates.length > 1) {
      return {
        error:
          `"${userName}" on the ${route} is ambiguous: ` +
          candidates.map((id) => `${id} (${stations[id].name})`).join(", "),
      };
    }
    return { id: candidates[0] };
  };
}

// Expand a trip into consecutive station hops using the route's service
// patterns. Picks the fewest-stops pattern covering both endpoints in order
// (assumes express when both express and local match); viaId restricts to
// patterns passing through that station, which pins the local or a specific
// skip-stop pattern.
export function expandTrip(variants, routeKey, startId, endId, viaId = null) {
  const seqs = variants[routeKey];
  if (!seqs) return { error: `no service data for route "${routeKey}"` };
  let best = null;
  let sawEndpoints = false;
  for (const seq of seqs) {
    const i = seq.indexOf(startId);
    if (i === -1) continue;
    const j = seq.indexOf(endId, i + 1);
    if (j === -1) continue;
    sawEndpoints = true;
    if (viaId !== null) {
      const k = seq.indexOf(viaId, i);
      if (k === -1 || k > j) continue;
    }
    if (!best || j - i < best.j - best.i) best = { seq, i, j };
  }
  if (!best) {
    const via = viaId !== null && sawEndpoints ? ` via ${viaId}` : "";
    return {
      error: `no ${routeKey} service pattern covers ${startId} -> ${endId}${via} in that direction`,
    };
  }
  const path = best.seq.slice(best.i, best.j + 1);
  const hops = [];
  for (let k = 0; k < path.length - 1; k++) hops.push([path[k], path[k + 1]]);
  return { hops, path };
}

// Undirected station-pair key, matching segments.json.
export function segKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function processTrips(trips, resolve, variants, resolveRoute) {
  const expanded = [];
  const errors = [];
  for (const trip of trips) {
    const r = resolveRoute(trip.route);
    if (r.error) { errors.push({ trip, error: r.error }); continue; }
    const s = resolve(trip.start, r.key);
    if (s.error) { errors.push({ trip, error: `start: ${s.error}` }); continue; }
    const e = resolve(trip.end, r.key);
    if (e.error) { errors.push({ trip, error: `end: ${e.error}` }); continue; }
    let viaId = null;
    if (trip.via) {
      const v = resolve(trip.via, r.key);
      if (v.error) { errors.push({ trip, error: `via: ${v.error}` }); continue; }
      viaId = v.id;
    }
    const ex = expandTrip(variants, r.key, s.id, e.id, viaId);
    if (ex.error) { errors.push({ trip, error: ex.error }); continue; }
    expanded.push({
      date: trip.date, route: r.label, routeKey: r.key, sys: r.sys,
      startId: s.id, endId: e.id, car: trip.car ?? null,
      purpose: trip.purpose ?? null, ...ex,
    });
  }
  return { expanded, errors };
}

export function aggregate(expanded) {
  const segCounts = new Map();
  const stationStats = new Map();
  const stat = (id) => {
    if (!stationStats.has(id)) stationStats.set(id, { board: 0, alight: 0, through: 0 });
    return stationStats.get(id);
  };
  for (const trip of expanded) {
    for (const [a, b] of trip.hops) {
      const key = segKey(a, b);
      if (!segCounts.has(key)) segCounts.set(key, { count: 0, routes: new Set() });
      const entry = segCounts.get(key);
      entry.count += 1;
      entry.routes.add(trip.route);
    }
    stat(trip.startId).board += 1;
    stat(trip.endId).alight += 1;
    for (const id of trip.path.slice(1, -1)) stat(id).through += 1;
  }
  return { segCounts, stationStats };
}

// Header names -> optional trip fields, for columns after the first four.
function headerColumns(fields) {
  const cols = {};
  fields.forEach((h, i) => {
    if (i < 4) return;
    const name = h.toLowerCase();
    if (/\bcar\b/.test(name)) cols.car = i;
    else if (/^via\b/.test(name)) cols.via = i;
    else if (/\bpurpose\b/.test(name)) cols.purpose = i;
  });
  return Object.keys(cols).length ? cols : null;
}

// Rows: date, start, end, line, then optional columns. Tab- or
// comma-separated; blank lines are skipped; dates are M/D/YYYY or ISO.
// With a header row naming the optional columns (Car Number, Via, Purpose),
// columns are read by name and unrecognized ones are ignored. Without one,
// extras are classified by content: purely numeric is a car number,
// anything else a via station.
export function parseTrips(text) {
  const trips = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  let cols = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    const parts = line.includes("\t") ? line.split("\t") : splitCsvLine(line);
    const fields = parts.map((p) => p.trim());
    if (fields.length < 4) {
      errors.push({ lineNumber: n + 1, error: `expected 4 fields, got ${fields.length}: "${line}"` });
      continue;
    }
    const [date, start, end, route, ...extras] = fields;
    const iso = toIsoDate(date);
    if (!iso) {
      if (n === 0) { cols = headerColumns(fields); continue; }
      errors.push({ lineNumber: n + 1, error: `unparseable date "${date}"` });
      continue;
    }
    let via = null;
    let car = null;
    let purpose = null;
    if (cols) {
      const at = (i) => (i === undefined ? null : fields[i] || null);
      via = at(cols.via);
      car = at(cols.car);
      purpose = at(cols.purpose);
    } else {
      for (const extra of extras) {
        if (!extra) continue;
        if (/^\d{2,6}$/.test(extra)) car = car ?? extra;
        else via = via ?? extra;
      }
    }
    trips.push({ date: iso, start, end, route, via, car, purpose });
  }
  return { trips, errors };
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function toIsoDate(s) {
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
