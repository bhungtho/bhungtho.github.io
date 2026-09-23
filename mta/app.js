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

async function main() {
  const [stations, routes, variants, segments, overrides, tripsText] = await Promise.all([
    fetchJson("data/stations.json"),
    fetchJson("data/routes.json"),
    fetchJson("data/variants.json"),
    fetchJson("data/segments.json"),
    fetchJson("name_overrides.json").catch(() => ({})),
    fetch(TRIPS_URL).then((r) => {
      if (!r.ok) throw new Error(`${TRIPS_URL}: HTTP ${r.status}`);
      return r.text();
    }),
  ]);

  const { trips, errors: parseErrors } = parseTrips(tripsText);
  const resolve = buildResolver(stations, variants, overrides);
  const resolveRoute = buildRouteResolver(routes);
  const { expanded, errors: tripErrors } = processTrips(trips, resolve, variants, resolveRoute);

  renderErrors(parseErrors, tripErrors);
  renderCoverage(expanded, segments, stations);

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

  const toggleEl = document.getElementById("panel-toggle");
  const setPanelHidden = (hidden) => {
    document.body.classList.toggle("panel-hidden", hidden);
    toggleEl.innerHTML = hidden ? "&#9776;" : "&#10005;";
    map.resize();
  };
  toggleEl.addEventListener("click", () =>
    setPanelHidden(!document.body.classList.contains("panel-hidden")));
  // Panel starts closed on small screens so the map gets the viewport.
  if (window.matchMedia("(max-width: 640px)").matches) setPanelHidden(true);

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
    // click handlers cover touch devices, where hover never fires.
    for (const [layer, handler] of [["segments", segPopup], ["stations", stationPopup]]) {
      map.on("click", layer, handler);
      map.on("mousemove", layer, (e) => {
        map.getCanvas().style.cursor = "pointer";
        handler(e);
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });
    }
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ["segments", "stations"] });
      if (!hits.length) popup.remove();
    });

    const refresh = () => {
      const from = fromEl.value || "0000-00-00";
      const to = toEl.value || "9999-99-99";
      const filtered = expanded.filter((t) => t.date >= from && t.date <= to);
      const { segCounts, stationStats } = aggregate(filtered);

      const maxCount = Math.max(1, ...[...segCounts.values()].map((v) => v.count));
      // Log scale keeps low counts distinct once one segment's count grows large.
      const frac = (count) =>
        maxCount > 1 ? Math.log(count) / Math.log(maxCount) : 0.5;
      const segFeatures = [...segCounts.entries()].map(([key, v]) => {
        const [a, b] = key.split("|");
        return {
          type: "Feature",
          geometry: { type: "LineString", coordinates: segments[key] },
          properties: {
            count: v.count,
            frac: frac(v.count),
            routes: [...v.routes].sort().join(" "),
            name: `${stations[a].name} \u2192 ${stations[b].name}`,
          },
        };
      });
      map.getSource("segments").setData({ type: "FeatureCollection", features: segFeatures });

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

      renderTotals(filtered, segCounts, stationStats);
      renderTopSegments(segCounts, stations);
      renderTopStations(stationStats, stations);

      if (segFeatures.length) {
        const bounds = new maplibregl.LngLatBounds();
        for (const f of segFeatures) for (const c of f.geometry.coordinates) bounds.extend(c);
        map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 400 });
      }
    };

    fromEl.addEventListener("change", refresh);
    toEl.addEventListener("change", refresh);
    refresh();
  });
}

function emptyFc() {
  return { type: "FeatureCollection", features: [] };
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

function renderTotals(filtered, segCounts, stationStats) {
  const rows = [
    ["Trips", filtered.length],
    ["Segments ridden", segCounts.size],
    ["Stations touched", stationStats.size],
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
