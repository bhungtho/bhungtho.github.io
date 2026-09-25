// Map and UI wiring; trip logic lives in heatmap-core.js.
import {
  buildResolver, buildRouteResolver, parseTrips, processTrips, aggregate, segKey,
} from "./heatmap-core.js";

const SYSTEM_NAMES = {
  sub: "Subway", lirr: "LIRR", mnr: "Metro-North", njt: "NJ Transit",
  fer: "NYC Ferry",
};

// Published Google Sheet CSV; set to "trips.csv" to read the local file.
const TRIPS_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSPfB_5luHDgpaQer4fOnS6B6gbyHzfHH1E9sLjSYjkBYtPaLmZxoQM0alZpbf-YT4rMX1ML4KSDt9H/pub?gid=0&single=true&output=csv";

const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// [fraction, color] stops, dim -> bright; fractions are log-scaled ride counts.
const HEAT_RAMP = [
  [0, "#6b1247"],
  [0.25, "#a02070"],
  [0.5, "#e83e9c"],
  [0.75, "#ff7dc0"],
  [1, "#ffb1dd"],
];

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

let visitedHoods = [];

const COS_LAT = Math.cos((40.73 * Math.PI) / 180);
function lineKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * COS_LAT;
    const dy = coords[i][1] - coords[i - 1][1];
    km += Math.hypot(dx, dy) * 111.32;
  }
  return km;
}

// Panel toggle is wired immediately so it works even if data loading fails.
let mapRef = null;
const toggleEl = document.getElementById("panel-toggle");
function setPanelHidden(hidden) {
  document.body.classList.toggle("panel-hidden", hidden);
  toggleEl.innerHTML = hidden ? "&#9776;" : "&#10005;";
  mapRef?.resize();
}
toggleEl.addEventListener("click", () =>
  setPanelHidden(!document.body.classList.contains("panel-hidden")));
if (window.matchMedia("(max-width: 640px)").matches) setPanelHidden(true);

async function main() {
  const [stations, routes, variants, segments, carClasses, overrides, tripsText] = await Promise.all([
    fetchJson("data/stations.json"),
    fetchJson("data/routes.json"),
    fetchJson("data/variants.json"),
    fetchJson("data/segments.json"),
    fetchJson("car_classes.json").catch(() => ({})),
    fetchJson("name_overrides.json").catch(() => ({})),
    fetch(TRIPS_URL).then((r) => {
      if (!r.ok) throw new Error(`${TRIPS_URL}: HTTP ${r.status}`);
      return r.text();
    }),
  ]);

  const segLen = new Map(
    Object.entries(segments).map(([k, coords]) => [k, lineKm(coords)]));

  const { trips, errors: parseErrors } = parseTrips(tripsText);
  const resolve = buildResolver(stations, variants, overrides);
  const resolveRoute = buildRouteResolver(routes);
  const { expanded, errors: tripErrors } = processTrips(trips, resolve, variants, resolveRoute);

  renderErrors(parseErrors, tripErrors);
  renderCoverage(expanded, segments, stations);
  renderHoodCoverage(expanded, stations);
  setupRawTable(trips, expanded, tripErrors);

  const dates = expanded.map((t) => t.date).sort();
  const fromEl = document.getElementById("date-from");
  const toEl = document.getElementById("date-to");
  if (dates.length) {
    fromEl.value = dates[0];
    toEl.value = dates[dates.length - 1];
  }

  const map = new maplibregl.Map({
    container: "map",
    style: BASEMAP,
    center: [-73.94, 40.73],
    zoom: 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  mapRef = map;

  map.on("load", () => {
    // Full-network backdrop (unridden track).
    map.addSource("network", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: Object.values(segments).map((coords) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: {},
        })),
      },
    });
    map.addLayer({
      id: "network",
      type: "line",
      source: "network",
      // No line-cap: round is incompatible with line-dasharray.
      layout: { "line-join": "round" },
      paint: {
        "line-color": "#7d95b0",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 12, 1.8, 15, 3],
        "line-dasharray": [2, 2],
        "line-opacity": 0.55,
      },
    });

    map.addSource("segments", { type: "geojson", data: emptyFc() });
    map.addSource("stations", { type: "geojson", data: emptyFc() });

    // Neighborhood overlay (visited fill + citywide borders), lazy-loaded
    // (~4 MB) on first enable.
    const hoodToggle = document.getElementById("hood-fill-toggle");
    hoodToggle.addEventListener("change", async () => {
      if (hoodToggle.checked && !map.getSource("hoods")) {
        const [fills, borders] = await Promise.all([
          fetchJson("data/hoods.json").catch(() => null),
          fetchJson("data/hood_borders.json").catch(() => null),
        ]);
        if (!fills || !borders) { hoodToggle.checked = false; return; }
        map.addSource("hoods", { type: "geojson", data: fills });
        map.addSource("hood-borders", { type: "geojson", data: borders });
        map.addLayer({
          id: "hoods",
          type: "fill",
          source: "hoods",
          filter: ["in", ["get", "hood"], ["literal", visitedHoods]],
          paint: { "fill-color": "#e83e9c", "fill-opacity": 0.08 },
        }, "network"); // beneath all linework
        map.addLayer({
          id: "hood-borders",
          type: "line",
          source: "hood-borders",
          paint: {
            "line-color": "#66788c",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 13, 1],
            "line-opacity": 0.45,
          },
        }, "network");
      } else if (map.getLayer("hoods")) {
        const vis = hoodToggle.checked ? "visible" : "none";
        map.setLayoutProperty("hoods", "visibility", vis);
        map.setLayoutProperty("hood-borders", "visibility", vis);
      }
    });

    map.addLayer({
      id: "segments",
      type: "line",
      source: "segments",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": [
          "interpolate", ["linear"], ["get", "frac"],
          0, 2.5, 1, 9,
        ],
        "line-color": [
          "interpolate", ["linear"], ["get", "frac"],
          ...HEAT_RAMP.flat(),
        ],
        "line-opacity": [
          "interpolate", ["linear"], ["get", "frac"],
          0, 0.65, 1, 1,
        ],
      },
    });

    // First-visit flashes during replay.
    map.addSource("flash", { type: "geojson", data: emptyFc() });
    map.addLayer({
      id: "flash",
      type: "circle",
      source: "flash",
      paint: {
        "circle-radius": 13,
        "circle-color": "#ffb1dd",
        "circle-opacity": 0.35,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });

    map.addLayer({
      id: "stations",
      type: "circle",
      source: "stations",
      paint: {
        "circle-radius": [
          "case", ["get", "used"],
          ["interpolate", ["linear"], ["get", "visits"], 1, 4, 10, 8],
          2.5,
        ],
        "circle-color": ["case", ["get", "used"], "#ffffff", "#16181d"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": ["case", ["get", "used"], 0, 1.5],
      },
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    let segTripLists = new Map(); // segKey -> ["date · line", ...], rebuilt per render
    const segPopup = (e) => {
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat)
        .setHTML(`<b>${p.name}</b><br>${p.count} ride${p.count === 1 ? "" : "s"} · ${p.routes}`)
        .addTo(map);
    };
    const stationPopup = (e) => {
      const p = e.features[0].properties;
      if (!p.used) return;
      popup.setLngLat(e.lngLat)
        .setHTML(`<b>${p.name}</b><br>on: ${p.board} · off: ${p.alight} · through: ${p.through}`)
        .addTo(map);
    };
    for (const [layer, handler] of [["segments", segPopup], ["stations", stationPopup]]) {
      map.on("mousemove", layer, (e) => {
        map.getCanvas().style.cursor = "pointer";
        handler(e);
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });
    }
    // Clicks (which also cover touch) get the detailed view: the trips
    // behind the segment.
    map.on("click", "segments", (e) => {
      const p = e.features[0].properties;
      const list = segTripLists.get(p.key) || [];
      const shown = list.slice(0, 8).map((s) => `<div>${s}</div>`).join("");
      const more = list.length > 8 ? `<div>\u2026 +${list.length - 8} more</div>` : "";
      popup.setLngLat(e.lngLat)
        .setHTML(`<b>${p.name}</b><br>${p.count} ride${p.count === 1 ? "" : "s"} · ${p.routes}<hr style="border-color:#3a3d44;margin:4px 0">${shown}${more}`)
        .addTo(map);
    });
    map.on("click", "stations", stationPopup);
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ["segments", "stations"] });
      if (!hits.length) popup.remove();
    });

    // Intensity is anchored to the all-time max count so a segment's color
    // means the same thing under any date filter, and only brightens during
    // replay. Log scale keeps low counts distinct as the max grows.
    const allTimeMax = Math.max(
      1, ...[...aggregate(expanded).segCounts.values()].map((v) => v.count));
    const frac = (count) =>
      allTimeMax > 1 ? Math.log(count) / Math.log(allTimeMax) : 0.5;

    const render = (filtered, fit) => {
      const { segCounts, stationStats } = aggregate(filtered);

      segTripLists = new Map();
      for (const t of filtered) {
        const seen = new Set();
        for (const [a, b] of t.hops) {
          const k = segKey(a, b);
          if (seen.has(k)) continue; // a trip crosses a segment at most once per listing
          seen.add(k);
          if (!segTripLists.has(k)) segTripLists.set(k, []);
          segTripLists.get(k).push(`${t.date} \u00b7 ${t.route}`);
        }
      }
      const segFeatures = [...segCounts.entries()].map(([key, v]) => {
        const [a, b] = key.split("|");
        return {
          type: "Feature",
          geometry: { type: "LineString", coordinates: segments[key] },
          properties: {
            key,
            count: v.count,
            frac: frac(v.count),
            routes: [...v.routes].sort().join(" "),
            name: `${stations[a].name} \u2192 ${stations[b].name}`,
          },
        };
      });
      map.getSource("segments").setData({ type: "FeatureCollection", features: segFeatures });

      visitedHoods = [...new Set(
        [...stationStats.entries()]
          .filter(([id, s]) => s.board + s.alight > 0 && stations[id].hood)
          .map(([id]) => stations[id].hood))];
      if (map.getLayer("hoods")) {
        map.setFilter("hoods", ["in", ["get", "hood"], ["literal", visitedHoods]]);
      }

      const stationFeatures = Object.entries(stations).map(([id, s]) => {
        const st = stationStats.get(id);
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: {
            name: s.name,
            used: !!st,
            visits: st ? st.board + st.alight + st.through : 0,
            board: st ? st.board : 0,
            alight: st ? st.alight : 0,
            through: st ? st.through : 0,
          },
        };
      }).filter((f) => f.properties.used);
      map.getSource("stations").setData({ type: "FeatureCollection", features: stationFeatures });

      let distKm = 0;
      for (const [key, v] of segCounts) distKm += (segLen.get(key) || 0) * v.count;
      let longestKm = 0;
      for (const t of filtered) {
        let d = 0;
        for (const [a, b] of t.hops) d += segLen.get(segKey(a, b)) || 0;
        if (d > longestKm) longestKm = d;
      }

      renderTotals(filtered, segCounts, stationStats, distKm, longestKm);
      renderTopSegments(segCounts, stations);
      renderTopStations(stationStats, stations);
      renderTopLines(filtered, routes);
      renderCars(filtered, carClasses);
      renderTopHoods(stationStats, stations);
      renderChart(filtered);

      if (fit && segFeatures.length) {
        const bounds = new maplibregl.LngLatBounds();
        for (const f of segFeatures) for (const c of f.geometry.coordinates) bounds.extend(c);
        map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 400 });
      }
    };

    const refresh = (fit = true) => {
      const from = fromEl.value || "0000-00-00";
      const to = toEl.value || "9999-99-99";
      render(expanded.filter((t) => t.date >= from && t.date <= to), fit);
    };

    fromEl.addEventListener("change", () => refresh());
    toEl.addEventListener("change", () => refresh());
    refresh();

    setupReplay(map, expanded, segments, render, stations);
  });
}

function emptyFc() {
  return { type: "FeatureCollection", features: [] };
}

// Cumulative playback, one frame per trip in date order. Camera fits the
// full extent once at play start, then stays put so frames don't lurch.
function setupReplay(map, expanded, segments, render, stations) {
  const playBtn = document.getElementById("replay-play");
  const slider = document.getElementById("replay-slider");
  const dateEl = document.getElementById("replay-date");
  const trips = [...expanded].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!trips.length) return;

  slider.max = trips.length - 1;
  slider.value = trips.length - 1;

  const allBounds = new maplibregl.LngLatBounds();
  const { segCounts } = aggregate(trips);
  for (const key of segCounts.keys()) for (const c of segments[key]) allBounds.extend(c);

  // Frame index at which each station is first boarded or exited, for the
  // first-visit flash.
  const firstVisit = new Map();
  trips.forEach((t, i) => {
    for (const id of [t.startId, t.endId]) {
      if (!firstVisit.has(id)) firstVisit.set(id, i);
    }
  });
  const setFlash = (i) => {
    const features = [...firstVisit.entries()]
      .filter(([, f]) => f === i)
      .map(([id]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [stations[id].lon, stations[id].lat] },
        properties: {},
      }));
    map.getSource("flash").setData({ type: "FeatureCollection", features });
  };

  let timer = null;
  const showFrame = (i) => {
    slider.value = i;
    dateEl.textContent = `${trips[i].date} \u00b7 ${i + 1}/${trips.length}`;
    render(trips.slice(0, i + 1), false);
    setFlash(i);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    playBtn.innerHTML = "&#9654;";
    map.getSource("flash").setData({ type: "FeatureCollection", features: [] });
  };
  const play = () => {
    let i = Number(slider.value);
    if (i >= trips.length - 1) i = 0; // replay from the start when at the end
    if (segCounts.size) map.fitBounds(allBounds, { padding: 60, maxZoom: 13, duration: 400 });
    playBtn.innerHTML = "&#9646;&#9646;";
    showFrame(i);
    timer = setInterval(() => {
      i += 1;
      if (i >= trips.length) { stop(); return; }
      showFrame(i);
    }, 700);
  };

  playBtn.addEventListener("click", () => (timer ? stop() : play()));
  slider.addEventListener("input", () => {
    stop();
    showFrame(Number(slider.value));
  });
}

// All-time and per-system: date filtering shouldn't shrink lifetime progress,
// and one merged denominator would swamp subway progress with commuter track.
function renderCoverage(expanded, segments, stations) {
  const { segCounts, stationStats } = aggregate(expanded);
  const sysOf = (id) => id.split(":")[0];

  const totals = new Map();
  const entry = (sys) => {
    if (!totals.has(sys)) totals.set(sys, { segTotal: 0, stTotal: 0, segDone: 0, stDone: 0 });
    return totals.get(sys);
  };
  for (const key of Object.keys(segments)) entry(sysOf(key)).segTotal += 1;
  for (const id of Object.keys(stations)) entry(sysOf(id)).stTotal += 1;
  for (const key of segCounts.keys()) entry(sysOf(key)).segDone += 1;
  for (const id of stationStats.keys()) entry(sysOf(id)).stDone += 1;

  const order = ["sub", "lirr", "mnr", "njt", "fer"];
  const systems = [...totals.keys()].sort(
    (a, b) => (order.indexOf(a) + 99) - (order.indexOf(b) + 99) || a.localeCompare(b));

  document.getElementById("coverage").innerHTML = systems
    .map((sys) => {
      const t = totals.get(sys);
      const rows = [
        ["segments", t.segDone, t.segTotal],
        ["stations", t.stDone, t.stTotal],
      ];
      return `<div class="cov-sys">${SYSTEM_NAMES[sys] || sys}</div>` + rows
        .map(([label, done, total]) => {
          const pct = total ? (100 * done) / total : 0;
          return `
            <div class="stat-row"><span>${label}</span>
              <span class="value">${done} / ${total} (${pct.toFixed(1)}%)</span></div>
            <div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
        })
        .join("");
    })
    .join("");
}

function renderTotals(filtered, segCounts, stationStats, distKm, longestKm) {
  const rows = [
    ["Trips", filtered.length],
    ["Segments ridden", segCounts.size],
    ["Stations touched", stationStats.size],
    ["Distance ridden", `${distKm.toFixed(1)} km`],
    ["Longest trip", `${longestKm.toFixed(1)} km`],
  ];
  document.getElementById("totals").innerHTML = rows
    .map(([k, v]) => `<div class="stat-row"><span>${k}</span><span class="value">${v}</span></div>`)
    .join("");
}

function renderTopSegments(segCounts, stations) {
  const top = [...segCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);
  document.getElementById("top-segments").innerHTML = top
    .map(([key, v]) => {
      const [a, b] = key.split("|");
      return `<div><span class="count">${v.count}\u00d7</span> ${stations[a].name} \u2013 ${stations[b].name}</div>`;
    })
    .join("");
}

// GTFS splits multi-division stations (Queensboro Plaza is two station ids),
// so same-named stations within ~400 m merge; the distance guard keeps
// distinct stations that share a name (the two Broadways) apart.
function renderTopStations(stationStats, stations) {
  const groups = new Map();
  for (const [id, s] of stationStats.entries()) {
    const st = stations[id];
    const list = groups.get(st.name) || [];
    const near = list.find(
      (g) => Math.abs(g.lat - st.lat) < 0.004 &&
             Math.abs(g.lon - st.lon) < 0.005);
    if (near) {
      near.visits += s.board + s.alight;
      near.through += s.through;
    } else {
      list.push({ lat: st.lat, lon: st.lon, name: st.name,
                  visits: s.board + s.alight, through: s.through });
      groups.set(st.name, list);
    }
  }
  const top = [...groups.values()].flat()
    .filter((s) => s.visits > 0)
    .sort((a, b) => b.visits - a.visits || b.through - a.through)
    .slice(0, 8);
  document.getElementById("top-stations").innerHTML = top
    .map((s) => {
      const through = s.through ? ` <span class="through">(+${s.through} through)</span>` : "";
      return `<div><span class="count">${s.visits}\u00d7</span> ${s.name}${through}</div>`;
    })
    .join("");
}

// Weekly bars (monthly once the span exceeds two years), inline SVG.
function renderChart(filtered) {
  const el = document.getElementById("chart");
  if (!filtered.length) { el.innerHTML = ""; return; }
  const dates = filtered.map((t) => t.date).sort();
  const weekStart = (isoDate) => {
    const d = new Date(isoDate + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
    return d;
  };
  const iso = (d) => d.toISOString().slice(0, 10);
  const WEEK = 7 * 86400000;
  const first = weekStart(dates[0]);
  const nWeeks = Math.round((weekStart(dates[dates.length - 1]) - first) / WEEK) + 1;
  const monthly = nWeeks > 104;

  let keys, keyOf, prefix;
  if (monthly) {
    keyOf = (date) => date.slice(0, 7);
    prefix = "";
    keys = [];
    const d = new Date(dates[0].slice(0, 7) + "-01T00:00:00Z");
    const end = keyOf(dates[dates.length - 1]);
    for (;;) {
      const k = d.toISOString().slice(0, 7);
      keys.push(k);
      if (k === end) break;
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  } else {
    keyOf = (date) => iso(weekStart(date));
    prefix = "week of ";
    keys = Array.from({ length: nWeeks }, (_, i) => iso(new Date(first.getTime() + i * WEEK)));
  }
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const t of filtered) counts.set(keyOf(t.date), counts.get(keyOf(t.date)) + 1);

  const max = Math.max(1, ...counts.values());
  const W = 268, H = 48, LBL = 11;
  const bw = W / keys.length;
  const bars = keys.map((k, i) => {
    const c = counts.get(k);
    if (!c) return "";
    const h = Math.max(2, (c / max) * H);
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}"` +
      ` width="${Math.max(1, bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#e83e9c">` +
      `<title>${prefix}${k}: ${c} ride${c === 1 ? "" : "s"}</title></rect>`;
  }).join("");
  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H + LBL}" xmlns="http://www.w3.org/2000/svg">` +
    bars +
    `<line x1="0" y1="${H + 0.5}" x2="${W}" y2="${H + 0.5}" stroke="#3a3d44"/>` +
    `<text x="0" y="${H + LBL - 1}" font-size="8" fill="#8b919c">${keys[0]}</text>` +
    `<text x="${W}" y="${H + LBL - 1}" font-size="8" fill="#8b919c" text-anchor="end">` +
    `${keys[keys.length - 1]}</text></svg>`;
}

function renderTopLines(filtered, routes) {
  const counts = new Map(); // routeKey -> {n, label}
  for (const t of filtered) {
    if (!counts.has(t.routeKey)) counts.set(t.routeKey, { n: 0, label: t.route });
    counts.get(t.routeKey).n += 1;
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label))
    .slice(0, 8);
  document.getElementById("top-lines").innerHTML = top
    .map(([key, { n, label }]) => {
      const r = routes[key] || {};
      const bg = r.color || "#3a3d44";
      const fg = r.textColor || "#ffffff";
      return `<div><span class="count">${n}\u00d7</span> ` +
        `<span class="line-chip" style="background:${bg};color:${fg}">${label}</span></div>`;
    })
    .join("");
}

function carClassOf(carClasses, sys, car) {
  const n = Number(car);
  for (const [lo, hi, name] of carClasses[sys] || []) {
    if (n >= lo && n <= hi) return name;
  }
  return null;
}

function renderCars(filtered, carClasses) {
  const cars = new Map(); // car -> {count, routes: Set}
  const classes = new Map(); // class -> {rides, cars: Set}
  let logged = 0;
  for (const t of filtered) {
    if (!t.car) continue;
    logged += 1;
    if (!cars.has(t.car)) cars.set(t.car, { count: 0, routes: new Set() });
    const c = cars.get(t.car);
    c.count += 1;
    c.routes.add(t.route);
    const cls = carClassOf(carClasses, t.sys, t.car) || "unknown";
    if (!classes.has(cls)) classes.set(cls, { rides: 0, cars: new Set() });
    classes.get(cls).rides += 1;
    classes.get(cls).cars.add(t.car);
  }
  const rows = [
    ["Rides with car logged", logged],
    ["Unique cars", cars.size],
    ["Classes ridden", [...classes.keys()].filter((c) => c !== "unknown").length],
  ];
  document.getElementById("car-stats").innerHTML = rows
    .map(([k, v]) => `<div class="stat-row"><span>${k}</span><span class="value">${v}</span></div>`)
    .join("");
  const classRows = [...classes.entries()]
    .sort((a, b) => b[1].rides - a[1].rides || a[0].localeCompare(b[0]))
    .map(([cls, c]) => {
      const n = c.cars.size;
      return `<div><span class="count">${c.rides}\u00d7</span> ${cls} ` +
        `<span class="dim">(${n} car${n === 1 ? "" : "s"})</span></div>`;
    });
  document.getElementById("car-classes").innerHTML = classRows.length
    ? `<div class="sub-head">Rolling stock classes</div>` + classRows.join("")
    : "";
  const repeats = [...cars.entries()]
    .filter(([, c]) => c.count > 1)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 8);
  const repeatRows = repeats.length
    ? repeats.map(([car, c]) =>
        `<div><span class="count">${c.count}\u00d7</span> car ${car} <span class="dim">(${[...c.routes].sort().join(", ")})</span></div>`)
      .join("")
    : `<div class="dim">None yet \u2014 same physical car caught twice.</div>`;
  document.getElementById("top-cars").innerHTML = logged
    ? `<div class="sub-head">Repeat cars</div>` + repeatRows
    : "";
}

// A neighborhood counts as visited when you boarded or exited there;
// riding through underneath doesn't count. All-time, like system coverage.
function renderHoodCoverage(expanded, stations) {
  const { stationStats } = aggregate(expanded);
  const visited = new Set();
  for (const [id, s] of stationStats.entries()) {
    if (s.board + s.alight > 0 && stations[id].hood) visited.add(stations[id].hood);
  }
  const total = new Set(
    Object.values(stations).map((s) => s.hood).filter(Boolean)).size;
  const pct = total ? (100 * visited.size) / total : 0;
  document.getElementById("hood-coverage").innerHTML = `
    <div class="stat-row"><span>visited (all time)</span>
      <span class="value">${visited.size} / ${total} (${pct.toFixed(1)}%)</span></div>
    <div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
}

function renderTopHoods(stationStats, stations) {
  const counts = new Map();
  for (const [id, s] of stationStats.entries()) {
    const hood = stations[id].hood;
    const visits = s.board + s.alight;
    if (hood && visits) counts.set(hood, (counts.get(hood) || 0) + visits);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);
  document.getElementById("top-hoods").innerHTML = top
    .map(([hood, n]) => `<div><span class="count">${n}\u00d7</span> ${hood}</div>`)
    .join("");
}

function setupRawTable(trips, expanded, tripErrors) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const errByTrip = new Map(tripErrors.map((e) => [e.trip, e.error]));
  const queue = [...expanded]; // same order as trips, minus errored rows
  const rows = trips.map((t) => {
    const err = errByTrip.get(t);
    const status = err
      ? `<span class="bad">error</span>`
      : `<span class="ok">${queue.shift().path.length} stops</span>`;
    let html = `<tr><td>${esc(t.date)}</td><td>${esc(t.start)}</td><td>${esc(t.end)}</td>` +
      `<td>${esc(t.route)}</td><td>${esc(t.via ?? "")}</td>` +
      `<td class="num">${esc(t.car ?? "")}</td><td>${status}</td></tr>`;
    // Error reasons get their own row: visible on touch, where title
    // tooltips never show.
    if (err) html += `<tr class="err-detail"><td colspan="7">${esc(err)}</td></tr>`;
    return html;
  });
  document.getElementById("raw-table").innerHTML =
    "<thead><tr><th>Date</th><th>Start</th><th>End</th><th>Line</th>" +
    "<th>Via</th><th>Car</th><th>Status</th></tr></thead>" +
    `<tbody>${rows.join("")}</tbody>`;

  const modal = document.getElementById("raw-modal");
  document.getElementById("raw-open").addEventListener("click", () => (modal.hidden = false));
  document.getElementById("raw-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.hidden = true;
  });
}

function renderErrors(parseErrors, tripErrors) {
  const el = document.getElementById("errors");
  const items = [
    ...parseErrors.map((e) => `Line ${e.lineNumber}: ${e.error}`),
    ...tripErrors.map((e) =>
      `${e.trip.date} ${e.trip.start} \u2192 ${e.trip.end} (${e.trip.route}): ${e.error}`),
  ];
  el.innerHTML = items.length
    ? items.map((m) => `<div class="err">${m}</div>`).join("")
    : `<div class="ok">All trips resolved.</div>`;
}

main().catch((err) => {
  document.getElementById("errors").innerHTML =
    `<div class="err">Failed to load: ${err.message}</div>`;
  console.error(err);
});
