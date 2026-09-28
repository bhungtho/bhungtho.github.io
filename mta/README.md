# MTA Trip Heat Map

A personal transit heat map. Trips are logged in a Google Sheet; the page
expands each trip into the stations it passed through using the agencies'
GTFS feeds and renders the result over a map. Fully static, hosted on GitHub
Pages at <https://bhungtho.github.io/mta/>.

Covers NYC Subway, LIRR, Metro-North, NJ Transit rail and light rail, PATH,
and NYC Ferry.

## Logging trips

One row per leg. If a journey involves a transfer, log each leg separately.

| Column | Required | Notes |
|---|---|---|
| Date | yes | `M/D/YYYY` or `YYYY-MM-DD` |
| Start station | yes | Natural spelling is fine ("34th Street-Herald Square") |
| End station | yes | |
| Line | yes | See below |
| Via station | no | Pins which service pattern you rode (see below) |
| Car number | no | Purely numeric; classified by rolling stock class |

The via and car-number columns are told apart by content, so they can be in
either order and either can be omitted. A header row is skipped
automatically.

### Line names by system

- **Subway**: the letter or number (`N`, `7`). Express services are separate
  routes in MTA's feed: log `7X` or `6X` if you rode the express.
- **LIRR / Metro-North**: the branch or line name, with or without the
  suffix (`Babylon`, `Port Washington`, `New Haven`, `Hudson`).
- **NJ Transit**: code or name (`NEC` / `Northeast Corridor`, `NJCL`,
  `Morris & Essex`, `HBLR`, `Newark Light Rail`).
- **PATH**: the service pattern, since that is how PATH labels trains
  (`Newark - World Trade Center`, `Journal Square - 33rd Street`). Writing
  just `PATH` errors and lists the seven patterns.
- **NYC Ferry**: code or name (`ER` / `East River`, `AS` / `Astoria`).

### Station names

Names are normalized before matching (case, ordinals, common abbreviations:
Street/St, Avenue/Av, Square/Sq, etc.), so sheet spellings rarely need to
match the feed exactly. Same-named stations (five "86 St"s, two "Broadway"s)
are disambiguated by which the line actually serves.

When a name fails to resolve, the **Data issues** panel shows the reason and
the candidate stations. Two failure kinds:

- *Ambiguous*: the line serves more than one station with that name. Use a
  more specific name.
- *No match*: the feed spells it differently ("MSU" for Montclair State
  University). Fix by adding a line to `web/name_overrides.json`, keyed by
  the normalized name the error message shows:
  ```json
  { "newark airport": "njt:37953" }
  ```
  Find the station id with a quick search of `web/data/stations.json`.

### The via column

Expansion picks the fewest-stops service pattern that covers both endpoints,
which assumes you rode the express when both express and local match. On
commuter rail with skip-stop patterns this can be wrong. Add a station you
definitely passed through in the via column to force a pattern that includes
it.

### Verifying a sheet from the command line

```bash
curl -sL "<published-csv-url>" -o /tmp/sheet.csv
node check_sheet.mjs /tmp/sheet.csv      # every row's expansion, or its error
node check_classes.mjs /tmp/sheet.csv    # car class breakdown
```

## Layout

```
build_data.py          GTFS -> web/data/*.json (run when feeds change)
test_expansion.mjs     regression tests; run after any core or data change
check_sheet.mjs        pipeline check for an arbitrary trips CSV
check_classes.mjs      car class breakdown for a trips CSV
.gtfs/                 feed cache (gitignored-equivalent; not deployed)
web/
  index.html           panel markup and styles
  app.js               map rendering, panel sections, replay, sheet source
  heatmap-core.js      pure logic: name/route resolution, expansion, aggregation
  car_classes.json     fleet number ranges -> class, per system
  name_overrides.json  manual station-name pins
  trips.csv            local fallback data (unused when a sheet URL is set)
  data/                generated; do not edit by hand
```

`heatmap-core.js` has no DOM dependency and runs under node, which is what
the test and check scripts rely on.

## Data pipeline

`build_data.py` downloads each feed in `FEEDS`, then writes:

- `stations.json`: id, name, coordinates, neighborhood
- `routes.json`: label, aliases, official colors
- `variants.json`: every distinct ordered stop sequence per route
- `segments.json`: track geometry between consecutive stations, sliced from
  GTFS shapes
- `hoods.json`, `hood_borders.json`: neighborhood fill polygons and
  dissolved borders for the map overlay

Ids are namespaced by system (`sub:R05`, `lirr:237`) so agency ids cannot
collide.

Things the build handles that are easy to forget:

- **Variants come from all trips, not one per shape.** Metro-North reuses
  one shape for hundreds of skip-stop patterns; using shapes as the unit
  produced garbage.
- **Split routes are merged.** NJT models Montclair-Boonton and North Jersey
  Coast as two routes each (weekday/weekend). Same long name + same color +
  prefix-related short names are merged. The subway's C and E (both "8
  Avenue Local") are deliberately left apart by the prefix rule.
- **Shared short names fall back to long names.** Every PATH route has short
  name "PATH".
- **Neighborhood assignment uses shoreline-clipped census tracts**, not the
  NTA polygons. NTA polygons include waterways, and the East River legally
  belongs to Manhattan out to the far shore, so Brooklyn and Queens ferry
  piers were landing in Manhattan neighborhoods. Ferry landings always take
  the nearest tract; other stations use containment with a sanity check that
  catches slivers, parks, and airports.

### Refreshing data

The Pages repo has a GitHub Action (`.github/workflows/refresh-mta-data.yml`)
that rebuilds monthly and commits `mta/data` when anything changed. It runs
`scripts/build_mta_data.py`, a copy of `build_data.py`. When the build logic
changes, copy the script over as part of deploying.

Feeds that require a login cannot be auto-downloaded and are committed under
`scripts/feeds/` in the Pages repo; the workflow seeds them into the cache.
Currently that is NJ Transit. To refresh it, download the rail GTFS from
<https://developer.njtransit.com>, save it as both `.gtfs/njt.zip` (local)
and `scripts/feeds/njt.zip` (Pages repo), and rebuild.

To rebuild locally:

```bash
python3 build_data.py           # uses .gtfs/ cache; delete a zip to force re-download
node test_expansion.mjs
```

### Adding a system

1. Add a `(key, display name, url)` tuple to `FEEDS` in `build_data.py`.
   Use `None` for the URL if the feed must be downloaded manually.
2. Add the key to `SYSTEM_NAMES` and the `order` array in `web/app.js`.
3. Add fleet ranges to `web/car_classes.json` if you want car classification.
4. Rebuild, run the tests, and add a synthetic trip for the new system to
   `test_expansion.mjs`.
5. Decide whether it counts as a city system for camera framing
   (`CITY_SYSTEMS` in `app.js`).

Feeds seen so far differ in whether they define parent stations, whether
short names are meaningful, and how they split routes; the build handles all
the variations encountered, but a new feed may add one.

## Deploying

The site repo is a sibling checkout at `../bhungtho.github.io`; the app
lives at `/mta/`. Deploy is a copy plus a commit:

```bash
cp web/app.js web/heatmap-core.js web/index.html ../bhungtho.github.io/mta/
cp web/car_classes.json web/name_overrides.json ../bhungtho.github.io/mta/
cp web/data/*.json ../bhungtho.github.io/mta/data/      # only if data changed
cp build_data.py ../bhungtho.github.io/scripts/build_mta_data.py  # only if build changed
cd ../bhungtho.github.io && git add mta scripts && git commit && git push
```

Trip edits need no deploy; the page reads the published sheet live. GitHub
Pages caches for about ten minutes, so hard-refresh after a deploy.

Local preview:

```bash
python3 -m http.server 8642 --directory web
```

## Sheet source

The page reads trips from, in order: a `?sheet=<url>` query parameter, a URL
saved in `localStorage` via the "Use your own sheet" panel, or the default
sheet in `DEFAULT_TRIPS_URL` in `app.js`. Only `https://` URLs are accepted.
Text from the sheet is HTML-escaped wherever it is rendered, since arbitrary
sheets can be loaded.

Publishing a sheet: File > Share > Publish to web, choose the tab, choose
CSV. The published URL is public to anyone who has it.

## Tuning knobs

All in `web/app.js` unless noted.

- `HEAT_RAMP`: intensity colors, dim to bright. Intensity is log-scaled and
  anchored to the all-time max so a color means the same count under any
  filter and only brightens during replay.
- `CITY_SYSTEMS`: which systems the camera frames on load.
- `network` layer: unridden-track backdrop style (dashed steel blue).
- `hoods` / `hood-borders` layers: neighborhood overlay opacity.
- Replay interval: the `700` (ms) in `setupReplay`.
- Station dot sizes: the zoom-keyed `circle-radius` in the `stations` layer.
- Chart bucketing switches from weekly to monthly past 104 weeks
  (`renderChart`).

## Known limits

- Express vs local is inferred (fewest stops) unless pinned with via.
- NJ Transit schedule patterns are frozen at the committed zip's date.
- Neighborhoods are NYC only; commuter stations outside the city have none
  and are excluded from the neighborhood denominator.
- NYC Ferry's feed includes its Rockaway shuttle buses as routes.
- AirTrain Newark has no public GTFS; AirTrain JFK has a 2020 feed that was
  scoped but not added.
