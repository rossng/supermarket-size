const INITIAL_CENTER = [52.3718, 4.8952];
const INITIAL_ZOOM = 14;
const DEFAULT_LOCATION = [52.3731, 4.8922];
const WALKING_METERS_PER_MINUTE = 80;
const OVERLAYS_ENABLED = true;
const INITIAL_LNGLAT = [INITIAL_CENTER[1], INITIAL_CENTER[0]];
const BUILDING_CHUNK_MANIFEST_URL = "./data/building-chunks/manifest.json";
const BUILDING_POINTS_URL = "./data/supermarket-building-points.geojson";
const BUILDINGS_FALLBACK_URL = "./data/supermarket-buildings.geojson";
const BASEMAP_STYLE = {
  version: 8,
  sources: {
    cartoLight: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      ],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  },
  layers: [
    {
      id: "carto-light",
      type: "raster",
      source: "cartoLight",
      minzoom: 0,
      maxzoom: 19
    }
  ]
};

const state = {
  features: [],
  filtered: [],
  buildingPoints: null,
  buildingPointById: new Map(),
  buildingChunks: [],
  loadedBuildingChunkKeys: new Set(),
  loadingBuildingChunkKeys: new Map(),
  loadedBuildingChunkFeatures: new Map(),
  userLocation: null,
  activeId: null,
  popup: null,
  hoverPopup: null,
  userMarker: null
};

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP_STYLE,
  center: INITIAL_LNGLAT,
  zoom: INITIAL_ZOOM,
  attributionControl: true,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  renderWorldCopies: false
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "bottom-right");
map.touchZoomRotate.disableRotation();
map.doubleClickZoom.disable();
const mapReady = new Promise((resolve) => map.once("load", resolve));
const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const searchEl = document.querySelector("#search");
const sortEl = document.querySelector("#sort");
const locateEl = document.querySelector("#locate");
const sidebarToggleEl = document.querySelector("#sidebar-toggle");
const infoEl = document.querySelector("#info");
const aboutEl = document.querySelector("#about");
const appEl = document.querySelector(".app");
let overlayHandlersInstalled = false;
let supermarketOverlayUpdateId = 0;

function featureId(feature) {
  return `${feature.properties.osm_type}-${feature.properties.osm_id}`;
}

function createUserLocationElement() {
  const element = document.createElement("div");
  element.className = "person-location";
  element.setAttribute("aria-label", "Your location");
  element.innerHTML = '<span class="person-location-head"></span><span class="person-location-body"></span>';
  return element;
}

function metersBetween(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function featureLatLng(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  return [lat, lon];
}

function featureLngLat(feature) {
  return feature.geometry.coordinates;
}

function floorArea(feature) {
  const value = Number(feature.properties.floor_area_m2);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function areaLabel(feature) {
  const area = floorArea(feature);
  return area ? `${area.toLocaleString("nl-NL")} m2` : "area unknown";
}

function distanceLabel(feature) {
  if (!state.userLocation) return "";
  const meters = metersBetween(state.userLocation, featureLatLng(feature));
  const minutes = Math.max(1, Math.round(meters / WALKING_METERS_PER_MINUTE));
  return `${minutes} min walk`;
}

function addressLabel(feature) {
  const props = feature.properties;
  const street = [props.street, props.housenumber].filter(Boolean).join(" ");
  return [street, props.postcode, props.city].filter(Boolean).join(", ");
}

function popupHtml(feature) {
  const props = feature.properties;
  const area = areaLabel(feature);
  const distance = distanceLabel(feature);
  return `
    <div class="popup">
      <h2>${escapeHtml(props.name || "Supermarket")}</h2>
      <p>${escapeHtml(addressLabel(feature) || props.bag_display_name || "")}</p>
      <p><strong>${escapeHtml(area)}</strong>${distance ? ` · ${escapeHtml(distance)}` : ""}</p>
      <p>${escapeHtml(props.bag_match_status || "not resolved")}</p>
    </div>
  `;
}

function buildingPopupHtml(feature) {
  const props = feature.properties ?? {};
  const area = Number(props.floor_area_m2);
  const areaText = Number.isFinite(area) && area > 0 ? `${area.toLocaleString("nl-NL")} m2` : "size unknown";
  return `
    <div class="popup">
      <h2>${escapeHtml(props.name || "Supermarket")}</h2>
      <p>${escapeHtml(props.bag_display_name || "")}</p>
      <p><strong>${escapeHtml(areaText)}</strong></p>
      <p>BAG pand ${escapeHtml(props.bag_pand_id || "")}</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markerRadiusMeters(feature) {
  const area = floorArea(feature);
  if (!area) return 18;
  return Math.max(18, Math.min(55, Math.sqrt(area) * 0.55));
}

// Key brand colour per chain, matched as a lowercase substring of the OSM
// brand/name/operator. Verified against brand style guides / logo assets where
// possible. Order matters: more specific needles first, and "ekoplaza" must
// come before "marqt" because "Ekoplaza Foodmarqt" contains "marqt".
const BRAND_COLORS = [
  ["albert heijn", "#179eda"],
  ["jumbo", "#ffd400"],
  ["aldi", "#001e5e"],
  ["plus", "#7dba30"],
  ["lidl", "#015aa2"],
  ["spar", "#e4002b"],
  ["coop", "#da291c"],
  ["dirk", "#e2001a"],
  ["vomar", "#e3001b"],
  ["hoogvliet", "#e30613"],
  ["dekamarkt", "#e00614"],
  ["deen", "#e2001a"],
  ["nettorama", "#1d4e9a"],
  ["poiesz", "#4c9a2a"],
  ["boni", "#e2001a"],
  ["jan linders", "#e2001a"],
  ["mcd", "#003d7d"],
  ["dagwinkel", "#4c9a2a"],
  ["boon's", "#e2001a"],
  ["troefmarkt", "#e2001a"],
  ["attent", "#ee7203"],
  ["ekoplaza", "#53a910"],
  ["marqt", "#1a1a1a"],
  ["odin", "#8c1d40"],
  ["natuurwinkel", "#3aaa35"],
  ["amazing oriental", "#c8102e"]
];
const DEFAULT_BRAND_COLOR = "#00a2e3";

function brandColor(feature) {
  const props = feature.properties ?? {};
  const haystack = [props.brand, props.name, props.operator]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  const match = BRAND_COLORS.find(([needle]) => haystack.includes(needle));
  return match ? match[1] : DEFAULT_BRAND_COLOR;
}

function markerColor(feature) {
  return brandColor(feature);
}

function displayFeature(feature) {
  return state.buildingPointById.get(featureId(feature)) ?? feature;
}

function exaggeratedRadiusMeters(feature) {
  const area = floorArea(feature);
  if (!area) return 24;
  return Math.max(18, Math.min(145, 12 + (area / 1000) ** 1.55 * 12));
}

function destinationPoint([lon, lat], distanceMeters, bearingDegrees) {
  const radius = 6371008.8;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const angularDistance = distanceMeters / radius;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [((lon2 * 180) / Math.PI + 540) % 360 - 180, (lat2 * 180) / Math.PI];
}

function circlePolygonFeature(feature) {
  const centerFeature = displayFeature(feature);
  const center = centerFeature.geometry.coordinates;
  const radius = exaggeratedRadiusMeters(feature);
  const steps = 32;
  const ring = [];
  for (let i = 0; i < steps; i += 1) {
    ring.push(destinationPoint(center, radius, (i / steps) * 360));
  }
  ring.push(ring[0]);
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ring]
    },
    properties: {
      ...feature.properties,
      radius_m: radius,
      circle_color: markerColor(feature),
      is_matched_area: Boolean(floorArea(feature))
    }
  };
}

function stopMapLocationClick(event) {
  if (event.originalEvent) event.originalEvent.stopPropagation();
}

function collection(features) {
  return { type: "FeatureCollection", features };
}

function fetchJson(url) {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
    return response.json();
  });
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function currentViewBbox({ padding = 0.5, minSpan = 0 } = {}) {
  const bounds = map.getBounds();
  let west = bounds.getWest();
  let south = bounds.getSouth();
  let east = bounds.getEast();
  let north = bounds.getNorth();
  const lonSpan = Math.max(east - west, minSpan);
  const latSpan = Math.max(north - south, minSpan);
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  west = centerLon - lonSpan / 2 - lonSpan * padding;
  east = centerLon + lonSpan / 2 + lonSpan * padding;
  south = centerLat - latSpan / 2 - latSpan * padding;
  north = centerLat + latSpan / 2 + latSpan * padding;
  return [west, south, east, north];
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function pointInBbox([lon, lat], bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function bboxCenter(bbox) {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function distanceSquared(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function featuresNearCurrentView(features) {
  const bbox = currentViewBbox({ padding: 1.2, minSpan: 0.04 });
  return features.filter((feature) => pointInBbox(featureLngLat(displayFeature(feature)), bbox));
}

function addSourceIfMissing(id, source) {
  if (!map.getSource(id)) map.addSource(id, source);
}

function addLayerIfMissing(layer) {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

async function ensureOverlayLayers() {
  if (!OVERLAYS_ENABLED) return;
  await mapReady;

  addSourceIfMissing("supermarket-radius-polygons", {
    type: "geojson",
    data: collection([])
  });
  addSourceIfMissing("supermarket-buildings", {
    type: "geojson",
    data: collection([])
  });

  addLayerIfMissing({
    id: "supermarkets-radius-fill",
    type: "fill",
    source: "supermarket-radius-polygons",
    paint: {
      "fill-color": [
        "case",
        ["get", "is_matched_area"],
        ["get", "circle_color"],
        "rgba(255, 255, 255, 0)"
      ],
      "fill-opacity": [
        "case",
        ["get", "is_matched_area"],
        0.74,
        0
      ]
    }
  });

  addLayerIfMissing({
    id: "supermarkets-radius-line",
    type: "line",
    source: "supermarket-radius-polygons",
    paint: {
      "line-color": [
        "case",
        ["get", "is_matched_area"],
        "#ffffff",
        ["get", "circle_color"]
      ],
      "line-opacity": 0.95,
      "line-width": [
        "case",
        ["get", "is_matched_area"],
        1.2,
        1.6
      ]
    }
  });

  addLayerIfMissing({
    id: "supermarket-buildings-fill",
    type: "fill",
    source: "supermarket-buildings",
    paint: {
      "fill-color": "#21918c",
      "fill-opacity": [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "floor_area_m2"], 0],
        0, 0.1,
        2500, 0.2
      ]
    }
  });

  addLayerIfMissing({
    id: "supermarket-buildings-line",
    type: "line",
    source: "supermarket-buildings",
    paint: {
      // Size-unknown buildings get a warmer, stronger outline so they read as
      // "polygon only, no sensible area" rather than a tiny matched store.
      "line-color": ["case", ["get", "has_area"], "#3b528b", "#c98a1b"],
      "line-opacity": ["case", ["get", "has_area"], 0.45, 0.85],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        10, 0.4,
        16, 1.4
      ]
    }
  });

  if (!overlayHandlersInstalled) {
    overlayHandlersInstalled = true;
    map.on("click", "supermarkets-radius-fill", (event) => {
      stopMapLocationClick(event);
      const feature = event.features?.[0];
      if (feature) setActive(featureId(feature), true);
    });

    map.on("click", "supermarket-buildings-fill", (event) => {
      stopMapLocationClick(event);
      const feature = event.features?.[0];
      if (!feature) return;
      showPopup(event.lngLat, buildingPopupHtml(feature));
    });

    map.on("mouseenter", "supermarkets-radius-fill", (event) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = event.features?.[0];
      if (!feature) return;
      const id = featureId(feature);
      const store = state.features.find((item) => featureId(item) === id) ?? feature;
      showHoverPopup(featureLngLat(displayFeature(store)), popupHtml(store));
    });

    map.on("mouseleave", "supermarkets-radius-fill", () => {
      map.getCanvas().style.cursor = "";
      hideHoverPopup();
    });

    map.on("mouseenter", "supermarket-buildings-fill", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "supermarket-buildings-fill", () => {
      map.getCanvas().style.cursor = "";
    });
  }
}

async function updateSupermarketOverlay() {
  if (!OVERLAYS_ENABLED) return;
  const updateId = ++supermarketOverlayUpdateId;
  await ensureOverlayLayers();
  if (updateId !== supermarketOverlayUpdateId) return;
  const source = map.getSource("supermarket-radius-polygons");
  if (!source) return;
  const visibleFirst = featuresNearCurrentView(state.features);
  const initialFeatures = visibleFirst.length ? visibleFirst : state.features.slice(0, 100);
  source.setData(collection(initialFeatures.map(circlePolygonFeature)));
}

function showPopup(lngLat, html) {
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

function showHoverPopup(lngLat, html) {
  state.hoverPopup?.remove();
  state.hoverPopup = new maplibregl.Popup({
    className: "hover-popup",
    closeButton: false,
    closeOnClick: false,
    focusAfterOpen: false
  })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

function hideHoverPopup() {
  state.hoverPopup?.remove();
  state.hoverPopup = null;
}

function renderResults() {
  resultsEl.innerHTML = "";
  if (!state.filtered.length) {
    resultsEl.innerHTML = '<li class="result"><span class="result-meta">No supermarkets match this view.</span></li>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const feature of state.filtered.slice(0, 100)) {
    const props = feature.properties;
    const id = featureId(feature);
    const area = floorArea(feature);
    const item = document.createElement("li");
    item.className = `result${state.activeId === id ? " active" : ""}`;
    item.dataset.id = id;
    item.innerHTML = `
      <div class="result-title">
        <span>${escapeHtml(props.name || "Supermarket")}</span>
        <span class="area${area ? "" : " missing"}" style="--brand-color: ${brandColor(feature)}">${escapeHtml(areaLabel(feature))}</span>
      </div>
      <div class="result-meta">${escapeHtml(addressLabel(feature) || props.bag_display_name || "Address missing")}</div>
      <div class="result-meta">${escapeHtml(distanceLabel(feature) || props.bag_match_status || "BAG match pending")}</div>
    `;
    item.addEventListener("click", () => setActive(id, true));
    fragment.appendChild(item);
  }
  resultsEl.appendChild(fragment);
}

function applyFilters() {
  const query = searchEl.value.trim().toLowerCase();
  state.filtered = state.features.filter((feature) => {
    if (!query) return true;
    const props = feature.properties;
    return [props.name, props.brand, props.city, props.street, props.postcode]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  state.filtered.sort((a, b) => {
    if (sortEl.value === "area") return (floorArea(b) || 0) - (floorArea(a) || 0);
    if (sortEl.value === "name") return (a.properties.name || "").localeCompare(b.properties.name || "");
    if (state.userLocation) {
      return (
        metersBetween(state.userLocation, featureLatLng(a)) -
        metersBetween(state.userLocation, featureLatLng(b))
      );
    }
    return (a.properties.name || "").localeCompare(b.properties.name || "");
  });

  updateSupermarketOverlay();
  renderResults();
  statusEl.textContent = `${state.filtered.length.toLocaleString("nl-NL")} supermarkets`;
}

function setActive(id, pan) {
  state.activeId = id;
  const feature = state.features.find((item) => featureId(item) === id);
  if (feature) {
    showPopup(featureLngLat(displayFeature(feature)), popupHtml(feature));
  }
  if (feature && pan) {
    map.easeTo({
      center: featureLngLat(displayFeature(feature)),
      zoom: Math.max(map.getZoom(), 15),
      duration: 450,
      essential: true
    });
  }
  renderResults();
}

function setUserLocation(latlng, { pan = false } = {}) {
  state.userLocation = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
  sortEl.value = "distance";
  updateUserLocationOverlay();
  if (pan) {
    map.easeTo({
      center: [state.userLocation[1], state.userLocation[0]],
      zoom: Math.max(map.getZoom(), 13),
      duration: 450,
      essential: true
    });
  }
  applyFilters();
}

async function updateUserLocationOverlay() {
  if (!OVERLAYS_ENABLED || !state.userLocation) return;
  await mapReady;
  const lngLat = [state.userLocation[1], state.userLocation[0]];
  if (!state.userMarker) {
    state.userMarker = new maplibregl.Marker({
      element: createUserLocationElement(),
      anchor: "bottom"
    })
      .setLngLat(lngLat)
      .addTo(map);
    return;
  }
  state.userMarker.setLngLat(lngLat);
}

function locateUser() {
  if (!navigator.geolocation) {
    statusEl.textContent = "Geolocation is not available";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setUserLocation([position.coords.latitude, position.coords.longitude], { pan: true });
    },
    () => {
      statusEl.textContent = "Could not get your location";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function loadData() {
  const collection = await fetchJson("./data/supermarkets.geojson");
  state.features = (collection.features ?? []).filter((feature) => feature.geometry?.type === "Point");
  state.userLocation = DEFAULT_LOCATION;
  sortEl.value = "distance";
  applyFilters();
  updateUserLocationOverlay();
}

function setBuildingPointIndex(collection) {
  state.buildingPoints = collection;
  state.buildingPointById = new Map(
    (collection.features ?? []).map((feature) => [featureId(feature), feature])
  );
}

async function loadBuildingPoints() {
  const collection = await fetchJson(BUILDING_POINTS_URL);
  setBuildingPointIndex(collection);
  updateSupermarketOverlay();
}

function buildingChunkUrl(chunk) {
  return new URL(chunk.href, new URL(BUILDING_CHUNK_MANIFEST_URL, window.location.href)).toString();
}

function setLoadedBuildingData(chunks = chunksNearCurrentView()) {
  const features = [];
  for (const chunk of chunks) {
    features.push(...(state.loadedBuildingChunkFeatures.get(chunk.key) ?? []));
  }
  map.getSource("supermarket-buildings")?.setData(collection(features));
}

async function loadBuildingChunk(chunk) {
  if (
    state.loadedBuildingChunkKeys.has(chunk.key) ||
    state.loadingBuildingChunkKeys.has(chunk.key)
  ) {
    return state.loadingBuildingChunkKeys.get(chunk.key);
  }

  const promise = fetchJson(buildingChunkUrl(chunk))
    .then((chunkCollection) => {
      state.loadedBuildingChunkFeatures.set(chunk.key, chunkCollection.features ?? []);
      state.loadedBuildingChunkKeys.add(chunk.key);
    })
    .finally(() => {
      state.loadingBuildingChunkKeys.delete(chunk.key);
    });

  state.loadingBuildingChunkKeys.set(chunk.key, promise);
  return promise;
}

async function loadBuildingChunks(chunks) {
  const pending = chunks.filter((chunk) => !state.loadedBuildingChunkKeys.has(chunk.key));
  if (pending.length) await Promise.all(pending.map(loadBuildingChunk));
  setLoadedBuildingData(chunks);
}

function chunksNearCurrentView() {
  const bbox = currentViewBbox({ padding: 1.5, minSpan: 0.08 });
  const center = bboxCenter(bbox);
  const chunks = state.buildingChunks.filter((chunk) => bboxIntersects(chunk.bbox, bbox));
  return chunks.sort((a, b) => {
    return distanceSquared(bboxCenter(a.bbox), center) - distanceSquared(bboxCenter(b.bbox), center);
  });
}

async function loadVisibleBuildingChunks() {
  if (!state.buildingChunks.length) return;
  const chunks = chunksNearCurrentView();
  await loadBuildingChunks(chunks.length ? chunks : state.buildingChunks.slice(0, 1));
}

async function loadBuildingsFallback() {
  const collection = await fetchJson(BUILDINGS_FALLBACK_URL);
  map.getSource("supermarket-buildings")?.setData(collection);
}

async function loadBuildings() {
  if (!OVERLAYS_ENABLED) return;
  await ensureOverlayLayers();
  loadBuildingPoints().catch((error) => console.warn("Building center points failed to load", error));

  try {
    const manifest = await fetchJson(BUILDING_CHUNK_MANIFEST_URL);
    state.buildingChunks = manifest.chunks ?? [];
    await loadVisibleBuildingChunks();
  } catch (error) {
    console.warn("Building chunks unavailable; falling back to full polygon file", error);
    await loadBuildingsFallback();
  }
}

function toggleSidebar() {
  const collapsed = appEl.classList.toggle("sidebar-collapsed");
  sidebarToggleEl.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggleEl.title = collapsed ? "Show the list" : "Collapse the list";
  // The map shares a CSS grid with the sidebar, so it needs to recompute its
  // size once the rows have been reflowed.
  requestAnimationFrame(() => map.resize());
}

function openAbout() {
  if (typeof aboutEl.showModal === "function") {
    aboutEl.showModal();
  } else {
    aboutEl.setAttribute("open", "");
  }
}

searchEl.addEventListener("input", applyFilters);
sortEl.addEventListener("change", applyFilters);
locateEl.addEventListener("click", locateUser);
sidebarToggleEl.addEventListener("click", toggleSidebar);
infoEl.addEventListener("click", openAbout);
aboutEl.addEventListener("click", (event) => {
  if (event.target === aboutEl) aboutEl.close();
});
map.on("dblclick", (event) => setUserLocation(event.lngLat));
map.on("moveend", () => {
  updateSupermarketOverlay();
  loadVisibleBuildingChunks().catch((error) => console.warn("Visible building chunks failed to load", error));
});

loadData()
  .then(async () => {
    await waitForNextPaint();
    loadBuildings().catch((error) => console.warn("Building overlays failed to load", error));
  })
  .catch((error) => {
    console.error(error);
    statusEl.textContent = "No data yet. Run the data scripts first.";
  });
