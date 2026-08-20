// MapLibre 6.4.1, vendored: the ESM build expects a bundler to inject its
// web-worker URL (getWorkerUrl() is "" by default, and Chrome would refuse a
// cross-origin worker from a CDN anyway) — so the dist files are served
// same-origin and the worker URL is set explicitly.
import * as maplibregl from "./vendor/maplibre-gl.mjs";
maplibregl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// ---------------------------------------------------------------------------
// EPA AQI categories. gridcode in the AirNow contour service = category 1–6.
// The palette is the EPA standard — it is NOT colorblind-safe (and the two
// worst categories have <3:1 contrast on a dark map), so the category name
// and AQI number range are always rendered alongside the color.
// ---------------------------------------------------------------------------
const AQI = {
  1: { name: "Good",                           range: "AQI 0–50",    color: "#00e400",
       verdict: "Clear — enjoy." },
  2: { name: "Moderate",                       range: "AQI 51–100",  color: "#ffff00",
       verdict: "Fine for most — unusually sensitive? Pace yourself." },
  3: { name: "Unhealthy for Sensitive Groups", range: "AQI 101–150", color: "#ff7e00",
       verdict: "Sensitive groups take it easy." },
  4: { name: "Unhealthy",                      range: "AQI 151–200", color: "#ff0000",
       verdict: "Unhealthy — everyone limit time outside." },
  5: { name: "Very Unhealthy",                 range: "AQI 201–300", color: "#8f3f97",
       verdict: "Hard no, close the windows." },
  6: { name: "Hazardous",                      range: "AQI 301+",    color: "#7e0023",
       verdict: "Hard no, close the windows." },
};

const SOURCES = {
  perimeters: {
    label: "fires",
    url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query" +
      "?where=1%3D1&outFields=poly_IncidentName,poly_GISAcres,attr_IncidentSize,attr_PercentContained,attr_FireDiscoveryDateTime,attr_POOState" +
      "&outSR=4326&maxAllowableOffset=0.0005&f=geojson",
  },
  hotspots: {
    label: "hotspots",
    url: "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query" +
      "?where=hours_old%3C%3D24&geometry=-170,15,-50,72&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=frp,hours_old&outSR=4326&f=geojson",
  },
  aqi: {
    label: "AQI",
    url: "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/AirNowLatestContoursCombined/FeatureServer/0/query" +
      "?where=1%3D1&outFields=gridcode,Timestamp&outSR=4326&f=geojson",
  },
};

const data = { perimeters: null, hotspots: null, aqi: null };
const status = { perimeters: "loading", hotspots: "loading", aqi: "loading" };
let fetchedAt = null;
let aqiTimestamp = null;

const fmtInt = d3.format(",.0f");
const fmtClock = d3.timeFormat("%-I:%M %p");
const fmtDay = d3.timeFormat("%b %-d");
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [-100, 44],
  zoom: 3.3,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

const marker = new maplibregl.Marker({ element: markerEl(), anchor: "center" });
function markerEl() {
  const el = document.createElement("div");
  el.className = "click-marker";
  return el;
}

map.on("load", () => {
  // Data layers slide under the basemap's place labels so cities stay readable.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const empty = { type: "FeatureCollection", features: [] };

  map.addSource("aqi", { type: "geojson", data: empty });
  map.addSource("perimeters", { type: "geojson", data: empty });
  map.addSource("hotspots", { type: "geojson", data: empty });

  const aqiColor = ["match", ["get", "gridcode"],
    1, AQI[1].color, 2, AQI[2].color, 3, AQI[3].color,
    4, AQI[4].color, 5, AQI[5].color, 6, AQI[6].color,
    "transparent"];

  map.addLayer({
    id: "aqi-fill", type: "fill", source: "aqi",
    paint: { "fill-color": aqiColor, "fill-opacity": 0.38 },
  }, firstSymbol);
  map.addLayer({
    id: "aqi-line", type: "line", source: "aqi",
    paint: { "line-color": aqiColor, "line-opacity": 0.55, "line-width": 1 },
  }, firstSymbol);

  map.addLayer({
    id: "fire-fill", type: "fill", source: "perimeters",
    paint: { "fill-color": "#ff5a1f", "fill-opacity": 0.18 },
  }, firstSymbol);
  map.addLayer({
    id: "fire-line", type: "line", source: "perimeters",
    paint: { "line-color": "#ff8c42", "line-width": 1.5, "line-opacity": 0.95 },
  }, firstSymbol);

  map.addLayer({
    id: "viirs-heat", type: "heatmap", source: "hotspots", maxzoom: 8,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 1], 0, 0.2, 20, 0.55, 120, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 8, 2.2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 3, 7, 8, 22],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0.85, 8, 0],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)",
        0.2, "rgba(72,15,24,0.55)",
        0.45, "#8a1f10",
        0.7, "#e25822",
        0.9, "#ffb347",
        1, "#fff3d6"],
    },
  }, firstSymbol);
  map.addLayer({
    id: "viirs-dot", type: "circle", source: "hotspots", minzoom: 6.5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 1], 0, 2.5, 50, 5, 300, 9],
      "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 1], 0, "#e25822", 60, "#ffb347", 300, "#fff3d6"],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0, 7.5, 0.9],
      "circle-stroke-color": "#2a0d08",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6.5, 0, 7.5, 0.8],
    },
  }, firstSymbol);

  for (const key of Object.keys(pending)) {
    map.getSource(key).setData(pending[key]);
    delete pending[key];
  }
  sourcesReady = true;
});

map.on("click", (e) => answerAt([e.lngLat.lng, e.lngLat.lat]));
map.getCanvas().style.cursor = "crosshair";

document.getElementById("locate-btn").addEventListener("click", () => {
  navigator.geolocation.getCurrentPosition(
    (pos) => answerAt([pos.coords.longitude, pos.coords.latitude]),
    () => renderMessage("Couldn’t get your location — click the map instead."),
    { timeout: 8000 }
  );
});

// ---------------------------------------------------------------------------
// Data loading — each source lands independently; failures degrade gracefully.
// ---------------------------------------------------------------------------
async function fetchGeoJSON(url) {
  // Esri caps a response at maxRecordCount; page with resultOffset until done.
  const features = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const resp = await fetch(url + (offset ? `&resultOffset=${offset}` : ""));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const gj = await resp.json();
    if (gj.error) throw new Error(gj.error.message || "service error");
    features.push(...(gj.features || []));
    if (!gj.properties?.exceededTransferLimit && !gj.exceededTransferLimit) break;
    offset = features.length;
  }
  return { type: "FeatureCollection", features };
}

// Fetches start immediately, in parallel with basemap/tile loading; results
// are stashed in `pending` until the map's sources exist.
let sourcesReady = false;
const pending = {};

function loadData() {
  fetchedAt = new Date();
  for (const key of Object.keys(SOURCES)) {
    fetchGeoJSON(SOURCES[key].url)
      .then((fc) => {
        data[key] = fc;
        status[key] = "ok";
        if (sourcesReady) map.getSource(key).setData(fc);
        else pending[key] = fc;
        if (key === "aqi") {
          const ts = d3.max(fc.features, (f) => f.properties?.Timestamp);
          if (ts) aqiTimestamp = new Date(ts);
        }
      })
      .catch((err) => {
        console.error(`${key} failed:`, err);
        status[key] = "failed";
      })
      .finally(renderStatusLine);
  }
}
loadData();

function renderStatusLine() {
  const parts = [];
  parts.push(status.perimeters === "ok" ? `${data.perimeters.features.length} active fires`
    : status.perimeters === "failed" ? "fires unavailable" : "fires…");
  parts.push(status.hotspots === "ok" ? `${fmtInt(data.hotspots.features.length)} heat detections`
    : status.hotspots === "failed" ? "hotspots unavailable" : "hotspots…");
  parts.push(status.aqi === "ok" ? `AQI as of ${aqiTimestamp ? fmtClock(aqiTimestamp) : fmtClock(fetchedAt)}`
    : status.aqi === "failed" ? "AQI unavailable" : "AQI…");
  document.getElementById("status-line").textContent = parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Geometry helpers.
// Planar even-odd ray casting instead of d3.geoContains: it is insensitive to
// ring winding order, which Esri GeoJSON does not guarantee.
// ---------------------------------------------------------------------------
function pointInRings(pt, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) &&
          pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function geomContains(geom, pt) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInRings(pt, geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((poly) => pointInRings(pt, poly));
  return false;
}
function nearestVertex(pt, geom) {
  let best = { km: Infinity, vertex: null };
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const ring of poly) for (const v of ring) {
    const km = d3.geoDistance(pt, v) * 6371;
    if (km < best.km) best = { km, vertex: v };
  }
  return best;
}
function bearingDeg(from, to) {
  const r = Math.PI / 180;
  const [l1, p1] = [from[0] * r, from[1] * r], [l2, p2] = [to[0] * r, to[1] * r];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const compassWord = (deg) => COMPASS[Math.round(deg / 45) % 8];

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------
function answerAt(pt) {
  marker.setLngLat(pt).addTo(map);
  const targetZoom = Math.max(map.getZoom(), 5.4);
  const pad = window.innerWidth > 720 ? { right: 440, top: 40, bottom: 40, left: 40 } : { bottom: 320 };
  map.flyTo({ center: pt, zoom: targetZoom, padding: pad, duration: 1600, essential: true });

  // AQI: contours nest, so the worst (max) category containing the point wins.
  let gridcode = null;
  if (data.aqi) {
    for (const f of data.aqi.features) {
      const gc = f.properties?.gridcode;
      if (gc && (gridcode === null || gc > gridcode) && geomContains(f.geometry, pt)) gridcode = gc;
    }
  }

  // Nearest fire: distance to the perimeter edge (nearest vertex), not centroid.
  let fire = null;
  if (data.perimeters) {
    for (const f of data.perimeters.features) {
      if (!f.geometry) continue;
      const near = nearestVertex(pt, f.geometry);
      if (!fire || near.km < fire.km) fire = { feature: f, ...near };
    }
    if (fire && fire.km < 80 && geomContains(fire.feature.geometry, pt)) fire.inside = true;
  }

  // Evidence: heat detections within 25 miles (~40 km), last 24 h.
  let nearbyHeat = null;
  if (data.hotspots) {
    nearbyHeat = 0;
    const cosLat = Math.max(0.2, Math.cos((pt[1] * Math.PI) / 180));
    for (const f of data.hotspots.features) {
      const c = f.geometry?.coordinates;
      if (!c || Math.abs(c[1] - pt[1]) > 0.4 || Math.abs(c[0] - pt[0]) > 0.4 / cosLat) continue;
      if (d3.geoDistance(pt, c) * 6371 <= 40.2) nearbyHeat++;
    }
  }

  renderAnswer({ pt, gridcode, fire, nearbyHeat });
}

function renderAnswer({ pt, gridcode, fire, nearbyHeat }) {
  const cat = gridcode ? AQI[gridcode] : null;
  const verdict = cat ? cat.verdict : "No air-quality reading here.";
  const accent = cat ? cat.color : "rgba(255,255,255,0.25)";

  let aqiHtml;
  if (cat) {
    aqiHtml = `
      <div class="aqi-row">
        <span class="swatch" style="background:${cat.color}"></span>
        <span>${cat.name} <span class="aqi-range">· ${cat.range}</span></span>
      </div>`;
  } else if (status.aqi === "failed") {
    aqiHtml = `<p class="no-reading">AQI service unavailable right now.</p>`;
  } else {
    aqiHtml = `<p class="no-reading">Outside AirNow contour coverage — no reading for this spot.</p>`;
  }

  let fireHtml;
  if (fire) {
    const p = fire.feature.properties || {};
    const name = p.poly_IncidentName || "Unnamed fire";
    const acres = p.poly_GISAcres ?? p.attr_IncidentSize;
    const contained = p.attr_PercentContained;
    const since = p.attr_FireDiscoveryDateTime ? fmtDay(new Date(p.attr_FireDiscoveryDateTime)) : null;
    const state = p.attr_POOState ? String(p.attr_POOState).replace(/^US-/, "") : null;
    const mi = fire.km * 0.621371;
    const distTxt = fire.inside
      ? `<strong>You’re inside this fire’s mapped perimeter.</strong>`
      : `<strong>${mi < 10 ? mi.toFixed(1) : fmtInt(mi)} mi</strong> (${fmtInt(fire.km)} km) to the ${compassWord(bearingDeg(pt, fire.vertex))}`;
    const facts = [
      acres ? `${fmtInt(acres)} ${Math.round(acres) === 1 ? "acre" : "acres"}` : null,
      contained != null ? `${Math.round(contained)}% contained` : null,
      since ? `burning since ${since}` : null,
      state,
    ].filter(Boolean).join(" · ");
    fireHtml = `
      <div class="fire-block">
        <p class="section-label">Nearest active fire</p>
        <p class="fire-name">${escapeHtml(name)}${/fire$/i.test(name.trim()) ? "" : " Fire"}</p>
        <p class="fire-facts">${distTxt}${facts ? `<br>${facts}` : ""}</p>
        ${nearbyHeat != null && nearbyHeat > 0
          ? `<p class="fire-facts">${fmtInt(nearbyHeat)} satellite heat detection${nearbyHeat === 1 ? "" : "s"} within 25 mi in the last 24 h</p>`
          : ""}
      </div>`;
  } else {
    fireHtml = `<div class="fire-block">
      <p class="section-label">Nearest active fire</p>
      <p class="fire-facts">${status.perimeters === "failed" ? "Fire perimeter service unavailable." : "Loading fire perimeters…"}</p>
    </div>`;
  }

  const footerBits = [
    aqiTimestamp ? `AQI contours as of ${fmtClock(aqiTimestamp)}` : null,
    fetchedAt ? `fires & hotspots fetched ${fmtClock(fetchedAt)}` : null,
    "click anywhere to re-check",
  ].filter(Boolean).join(" · ");

  document.getElementById("panel-content").innerHTML = `
    <div class="verdict-accent" style="background:${accent}" aria-hidden="true"></div>
    <h2 class="verdict">${verdict}</h2>
    <p class="section-label">Air quality</p>
    ${aqiHtml}
    ${fireHtml}
    <p class="panel-footer">${footerBits}</p>`;
}

function renderMessage(msg) {
  const el = document.querySelector("#panel-content .empty-sub");
  if (el) el.textContent = msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Legend: the AQI scale, taught with color + name + number together.
// ---------------------------------------------------------------------------
document.getElementById("aqi-scale").innerHTML = Object.values(AQI)
  .map((c) => `<li><span class="swatch" style="background:${c.color}"></span>
    <span class="cat-name">${c.name === "Unhealthy for Sensitive Groups" ? "Unhealthy · sensitive" : c.name}</span>
    <span class="cat-range">${c.range.replace("AQI ", "")}</span></li>`)
  .join("");
