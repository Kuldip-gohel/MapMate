/* =====================================================================
   MapMate — Smart Nearby Places Explorer
   Vanilla JavaScript: Fetch API + JSON + Leaflet + OpenStreetMap
   Services used (all public, may be rate-limited or unavailable):
     - Nominatim  (geocoding)      https://nominatim.openstreetmap.org
     - Overpass   (nearby places)  https://overpass-api.de
   ===================================================================== */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  /* ------------------------------------------------------------------
     1. CONFIGURATION (easy to change)
  ------------------------------------------------------------------ */
  const CONFIG = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search',
    OVERPASS_URL: 'https://overpass-api.de/api/interpreter', // swap for another public Overpass mirror if needed
    GEOCODE_TIMEOUT_MS: 12000,
    OVERPASS_TIMEOUT_MS: 35000,
    OVERPASS_SERVER_TIMEOUT_S: 25,
    OVERPASS_ELEMENT_LIMIT: 500,   // cap on elements requested from Overpass
    MIN_QUERY_LENGTH: 2,
    MAX_QUERY_LENGTH: 120,
    MAX_DISPLAY: 60,               // max cards / markers rendered
    ALLOWED_RADII_KM: [1, 3, 5, 10],
    DEFAULT_VIEW: { lat: 12.9716, lon: 77.5946, zoom: 11, label: 'Bengaluru, India' }
  };

  /* OpenStreetMap tag for each category */
  const CATEGORIES = {
    restaurant:  { label: 'Restaurants',  singular: 'restaurant',  icon: '🍽️', tag: ['amenity', 'restaurant'] },
    cafe:        { label: 'Cafés',        singular: 'café',        icon: '☕',  tag: ['amenity', 'cafe'] },
    hospital:    { label: 'Hospitals',    singular: 'hospital',    icon: '🏥', tag: ['amenity', 'hospital'] },
    pharmacy:    { label: 'Pharmacies',   singular: 'pharmacy',    icon: '💊', tag: ['amenity', 'pharmacy'] },
    atm:         { label: 'ATMs',         singular: 'ATM',         icon: '🏧', tag: ['amenity', 'atm'] },
    park:        { label: 'Parks',        singular: 'park',        icon: '🌳', tag: ['leisure', 'park'] },
    library:     { label: 'Libraries',    singular: 'library',     icon: '📚', tag: ['amenity', 'library'] },
    supermarket: { label: 'Supermarkets', singular: 'supermarket', icon: '🛒', tag: ['shop', 'supermarket'] }
  };

  /* ------------------------------------------------------------------
     2. STATE + DOM REFERENCES
  ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const el = {};
  const state = {
    busy: false,
    controller: null,     // AbortController of the running search
    requestId: 0,         // increments for every search / reset to discard stale results
    places: [],           // currently displayed places
    byKey: new Map(),     // key -> place
    markers: new Map(),   // key -> Leaflet marker
    selectedKey: null,
    lastSearch: null,     // { category, radiusKm } of the last successful search
    tileErrorShown: false
  };
  const map = { instance: null, resultsLayer: null, originMarker: null, circle: null };
  let hintTimer = null;

  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ------------------------------------------------------------------
     3. SMALL UTILITIES
  ------------------------------------------------------------------ */
  /** Escape any text from an API before placing it into HTML. */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** Great-circle (straight-line) distance in metres. */
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function formatDistance(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }

  function shortName(displayName) {
    return String(displayName || '').split(',')[0].trim() || 'your location';
  }

  /** Animate a number from 0 to `to` (instant if reduced motion). */
  function animateCount(node, to) {
    if (prefersReducedMotion() || to === 0) { node.textContent = String(to); return; }
    const duration = 700;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------
     4. ERROR MODEL + FETCH HELPER (Fetch API, JSON, AbortController)
  ------------------------------------------------------------------ */
  class AppError extends Error {
    constructor(kind, message, detail) {
      super(message);
      this.name = 'AppError';
      this.kind = kind;     // notfound | timeout | network | service | ratelimit | http | badjson | aborted
      this.detail = detail;
    }
  }

  /**
   * fetch() + timeout + cancellation + response.ok check + response.json().
   * Always throws an AppError so callers can show a precise message.
   */
  async function requestJson(url, { method = 'GET', body, timeoutMs, signal } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const classifyAbort = (err) => {
      if (timedOut) return new AppError('timeout', 'The request timed out.');
      if (err && err.name === 'AbortError') return new AppError('aborted', 'The request was cancelled.');
      return null;
    };

    try {
      let response;
      try {
        response = await fetch(url, { method, body, signal: ctrl.signal });
      } catch (err) {
        throw classifyAbort(err) || new AppError('network', 'Network request failed.', err);
      }

      if (!response.ok) {                                // HTTP errors
        const status = response.status;
        if (status === 429) throw new AppError('ratelimit', 'Rate limited.', status);
        if (status >= 500) throw new AppError('service', `Service error (HTTP ${status}).`, status);
        throw new AppError('http', `Request rejected (HTTP ${status}).`, status);
      }

      try {
        return await response.json();                    // JSON parsing
      } catch (err) {
        throw classifyAbort(err) || new AppError('badjson', 'The service returned invalid JSON.', err);
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Convert an AppError into user-facing text. */
  function describeError(err, stage) {
    const what = stage === 'geocode' ? 'location service' : 'places service';
    const kind = err instanceof AppError ? err.kind : 'unknown';

    switch (kind) {
      case 'notfound':
        return { tone: 'warn', icon: '🔎', title: 'Location not found',
          message: "We couldn't find that location. Try a city name, locality, or landmark.",
          tips: ['Check the spelling.', 'Add the city or country, e.g. “Indiranagar, Bengaluru”.', 'Try a well-known landmark nearby.'] };
      case 'timeout':
        return { tone: 'warn', icon: '⏱️', title: 'The request took too long',
          message: `The ${what} did not respond in time. This is usually temporary.`,
          tips: stage === 'places'
            ? ['Try again in a moment.', 'Choose a smaller radius to reduce the query size.']
            : ['Try again in a moment.'] };
      case 'ratelimit':
        return { tone: 'error', icon: '🚦', title: 'Too many requests',
          message: `The public ${what} is rate-limiting requests. Please wait a minute and search again.`,
          tips: ['Public OpenStreetMap services are shared, so limits apply.'] };
      case 'service':
        return { tone: 'error', icon: '🛠️', title: stage === 'geocode' ? 'Location service temporarily unavailable' : 'Places service temporarily unavailable',
          message: `The ${what} is having problems right now. Your location text was not the issue — please try again shortly.`,
          tips: ['Wait a minute and retry.', stage === 'places' ? 'A smaller radius sometimes succeeds when the server is busy.' : 'If it keeps failing, the public service may be down.'] };
      case 'network':
        return { tone: 'error', icon: '📡', title: `Couldn't reach the ${what}`,
          message: 'The request failed before a response arrived. Check your internet connection, or the service may be blocked on this network.',
          tips: ['Check your connection and try again.', 'Disable any blocker that may stop requests to openstreetmap.org or overpass-api.de.'] };
      case 'badjson':
        return { tone: 'error', icon: '🧩', title: 'Unexpected response',
          message: `The ${what} returned data MapMate could not read. Please try again.`, tips: [] };
      case 'http':
        return { tone: 'error', icon: '⚠️', title: 'Request rejected',
          message: `The ${what} rejected the request (${escapeHtml(err.message)}).`, tips: ['Try different wording or a smaller radius.'] };
      case 'aborted':
        return { tone: 'info', icon: '✋', title: 'Search cancelled', message: 'The search was cancelled. Press Search to start again.', tips: [] };
      default:
        return { tone: 'error', icon: '⚠️', title: 'Something went wrong',
          message: 'An unexpected error occurred. Please try again.', tips: [] };
    }
  }

  /* ------------------------------------------------------------------
     5. DATA LAYER — Nominatim + Overpass
  ------------------------------------------------------------------ */
  async function geocode(query, signal) {
    const url = new URL(CONFIG.NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '1');

    const data = await requestJson(url.toString(), { timeoutMs: CONFIG.GEOCODE_TIMEOUT_MS, signal });
    if (!Array.isArray(data)) throw new AppError('badjson', 'Geocoder returned an unexpected structure.');

    // First hit that has valid, in-range numeric coordinates
    for (const hit of data) {
      const lat = parseFloat(hit && hit.lat);
      const lon = parseFloat(hit && hit.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon, displayName: typeof hit.display_name === 'string' && hit.display_name ? hit.display_name : query };
      }
    }
    throw new AppError('notfound', 'No geocoding results.');   // empty array or no usable coordinates
  }

  function buildOverpassQuery(categoryKey, lat, lon, radiusMeters) {
    const [key, value] = CATEGORIES[categoryKey].tag;
    const filter = `["${key}"="${value}"]`;
    const around = `(around:${Math.round(radiusMeters)},${lat.toFixed(6)},${lon.toFixed(6)})`;
    return `[out:json][timeout:${CONFIG.OVERPASS_SERVER_TIMEOUT_S}];` +
      `(node${filter}${around};way${filter}${around};relation${filter}${around};);` +
      `out center tags ${CONFIG.OVERPASS_ELEMENT_LIMIT};`;
  }

  async function fetchPlaces(categoryKey, origin, radiusKm, signal) {
    const query = buildOverpassQuery(categoryKey, origin.lat, origin.lon, radiusKm * 1000);
    const data = await requestJson(CONFIG.OVERPASS_URL, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      timeoutMs: CONFIG.OVERPASS_TIMEOUT_MS,
      signal
    });

    if (!data || typeof data !== 'object' || !Array.isArray(data.elements)) {
      throw new AppError('badjson', 'Overpass returned an unexpected structure.');
    }
    // Overpass can answer HTTP 200 with a runtime problem described in "remark"
    if (typeof data.remark === 'string' && /error|timed out|out of memory|rate_limited/i.test(data.remark)) {
      throw new AppError('service', 'Overpass reported a runtime problem.', data.remark);
    }
    return {
      places: normalisePlaces(data.elements, origin, categoryKey),
      hitLimit: data.elements.length >= CONFIG.OVERPASS_ELEMENT_LIMIT
    };
  }

  /** Turn raw Overpass elements into clean place objects, sorted by distance. */
  function normalisePlaces(elements, origin, categoryKey) {
    const cat = CATEGORIES[categoryKey];
    const seen = new Set();
    const out = [];

    for (const item of elements) {
      if (!item || typeof item !== 'object') continue;
      if (!['node', 'way', 'relation'].includes(item.type) || !Number.isFinite(item.id)) continue;

      const key = `${item.type}/${item.id}`;
      if (seen.has(key)) continue;

      // nodes carry lat/lon, ways & relations carry "center"
      const lat = item.type === 'node' ? item.lat : item.center && item.center.lat;
      const lon = item.type === 'node' ? item.lon : item.center && item.center.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      seen.add(key);

      const tags = item.tags && typeof item.tags === 'object' ? item.tags : {};
      const rawName = tags.name || tags['name:en'] || tags.brand || tags.operator || '';
      const name = String(rawName).trim();

      const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      const addressParts = tags['addr:full']
        ? [tags['addr:full']]
        : [tags['addr:housename'], street, tags['addr:suburb'] || tags['addr:neighbourhood'], tags['addr:city'], tags['addr:postcode']].filter(Boolean);

      out.push({
        key,
        osmType: item.type,
        osmId: item.id,
        name: name || `Unnamed ${cat.singular}`,
        unnamed: !name,
        lat, lon,
        distance: haversineMeters(origin.lat, origin.lon, lat, lon),
        address: addressParts.length ? addressParts.join(', ') : '',
        openingHours: tags.opening_hours ? String(tags.opening_hours) : '',
        cuisine: tags.cuisine ? String(tags.cuisine).replace(/_/g, ' ').replace(/;/g, ', ') : '',
        osmUrl: `https://www.openstreetmap.org/${item.type}/${item.id}`
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /* ------------------------------------------------------------------
     6. VALIDATION + FORM FEEDBACK
  ------------------------------------------------------------------ */
  function validateLocation(raw) {
    const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return { ok: false, message: 'Please enter a city, locality, landmark, or address.' };
    if (value.length < CONFIG.MIN_QUERY_LENGTH) return { ok: false, message: `Enter at least ${CONFIG.MIN_QUERY_LENGTH} characters.` };
    if (value.length > CONFIG.MAX_QUERY_LENGTH) return { ok: false, message: `Please keep the location under ${CONFIG.MAX_QUERY_LENGTH} characters.` };
    if (!/[\p{L}\p{N}]/u.test(value)) return { ok: false, message: 'Use letters or numbers in the location.' };
    return { ok: true, value };
  }

  function setLocationHint(text, tone) {
    const tones = { neutral: 'text-forest-800/60', good: 'text-emerald-700', error: 'text-rose-700 font-semibold' };
    el.locationHint.className = `mt-1.5 min-h-[1.25rem] text-xs ${tones[tone] || tones.neutral}`;
    el.locationHint.textContent = text;
  }

  function setFieldInvalid(invalid) {
    el.location.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    el.location.classList.toggle('border-rose-400', invalid);
    el.location.classList.toggle('ring-4', invalid);
    el.location.classList.toggle('ring-rose-200', invalid);
  }

  function setStatus(text) { el.formStatus.textContent = text || ''; }

  function setBusy(busy) {
    state.busy = busy;
    el.searchBtn.disabled = busy;
    el.searchSpinner.classList.toggle('hidden', !busy);
    el.searchIcon.classList.toggle('hidden', busy);
    el.searchBtnLabel.textContent = busy ? 'Searching…' : 'Search nearby places';
    el.cancelBtn.classList.toggle('hidden', !busy);
    el.cancelBtn.classList.toggle('inline-flex', busy);
    el.searchBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /* ------------------------------------------------------------------
     7. STATE PANEL (initial / loading / empty / error)
  ------------------------------------------------------------------ */
  const TONE_CLASSES = {
    info:  'border-emerald-200 bg-emerald-50/70 text-forest-900',
    warn:  'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900'
  };

  function showState({ tone = 'info', icon = '🧭', title, message, tips = [] }) {
    el.listWrap.classList.add('hidden');
    el.summary.classList.add('hidden');
    el.summary.classList.remove('grid');
    el.stateBox.classList.remove('hidden');
    el.stateBox.className = `rounded-3xl border p-6 ${TONE_CLASSES[tone] || TONE_CLASSES.info}`;
    const tipsHtml = tips.length
      ? `<ul class="mt-3 list-disc space-y-1 pl-5 text-sm opacity-90">${tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '';
    el.stateBox.innerHTML =
      `<div class="flex items-start gap-4">
         <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/80 text-2xl shadow-sm" aria-hidden="true">${icon}</div>
         <div class="min-w-0">
           <h3 class="font-display text-lg font-bold">${escapeHtml(title)}</h3>
           <p class="mt-1 text-sm leading-relaxed opacity-90">${escapeHtml(message)}</p>
           ${tipsHtml}
         </div>
       </div>`;
  }

  function showInitialState() {
    showState({
      tone: 'info', icon: '🧭', title: 'Start exploring',
      message: 'Enter a place above, choose a category and radius, then press “Search nearby places”. Results will appear here and as pins on the map.',
      tips: ['Try a city, a locality, a landmark or an address.', 'Start with 1–3 km in busy cities for faster results.']
    });
  }

  function showLoading(text) {
    el.listWrap.classList.add('hidden');
    el.summary.classList.add('hidden');
    el.summary.classList.remove('grid');
    el.stateBox.classList.remove('hidden');
    el.stateBox.className = `rounded-3xl border p-8 ${TONE_CLASSES.info}`;
    el.stateBox.innerHTML =
      `<div class="flex flex-col items-center gap-4 py-4 text-center">
         <div class="spinner-lg" aria-hidden="true"></div>
         <p class="font-display text-lg font-bold">${escapeHtml(text)}</p>
         <p class="text-sm opacity-75">Public map services can take a few seconds.</p>
       </div>`;
  }

  /* ------------------------------------------------------------------
     8. MAP (Leaflet)
  ------------------------------------------------------------------ */
  function initMap() {
    if (typeof L === 'undefined') {
      el.map.innerHTML = '<div class="flex h-full items-center justify-center p-6 text-center text-sm text-rose-800">The map library (Leaflet) could not be loaded. Check your internet connection and reload the page.</div>';
      return false;
    }
    const v = CONFIG.DEFAULT_VIEW;
    map.instance = L.map(el.map, { zoomControl: true, scrollWheelZoom: true }).setView([v.lat, v.lon], v.zoom);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    }).addTo(map.instance);
    tiles.on('tileerror', () => {
      if (state.tileErrorShown) return;
      state.tileErrorShown = true;
      el.mapNote.textContent = 'Some map tiles failed to load. Check your connection; markers and the list still work.';
    });
    map.resultsLayer = L.layerGroup().addTo(map.instance);

    // keep the map correctly sized when its container changes size
    if ('ResizeObserver' in window) new ResizeObserver(() => map.instance.invalidateSize()).observe(el.map);
    window.addEventListener('resize', () => map.instance && map.instance.invalidateSize());
    return true;
  }

  function setMapBadge(text, kind) {
    const kinds = {
      default: 'bg-amber-50 text-amber-800 ring-amber-200',
      live: 'bg-emerald-50 text-emerald-800 ring-emerald-200'
    };
    el.mapBadge.className = `inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${kinds[kind]}`;
    el.mapBadge.textContent = text;
  }

  function clearMapResults() {
    if (!map.instance) return;
    map.resultsLayer.clearLayers();
    state.markers.clear();
    state.selectedKey = null;
    if (map.originMarker) { map.instance.removeLayer(map.originMarker); map.originMarker = null; }
    if (map.circle) { map.instance.removeLayer(map.circle); map.circle = null; }
  }

  function showOriginOnMap(origin, radiusKm) {
    if (!map.instance) return;
    clearMapResults();
    const icon = L.divIcon({ className: 'mm-origin-wrap', html: '<div class="mm-origin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    map.originMarker = L.marker([origin.lat, origin.lon], { icon, title: 'Searched location', zIndexOffset: 500 })
      .addTo(map.instance)
      .bindPopup(`<strong>Searched location</strong><br>${escapeHtml(origin.displayName)}`);
    map.circle = L.circle([origin.lat, origin.lon], {
      radius: radiusKm * 1000, color: '#059669', weight: 2, fillColor: '#10b981', fillOpacity: 0.08
    }).addTo(map.instance);
    map.instance.fitBounds(map.circle.getBounds(), { padding: [24, 24], animate: !prefersReducedMotion() });
  }

  function popupHtml(place, categoryKey) {
    const cat = CATEGORIES[categoryKey];
    return `<div style="min-width:180px;max-width:240px">
      <strong style="font-size:14px">${escapeHtml(place.name)}</strong>
      <div style="font-size:12px;color:#475569;margin-top:2px">${escapeHtml(cat.label.replace(/s$/, ''))} · ${formatDistance(place.distance)} (straight-line)</div>
      ${place.address ? `<div style="font-size:12px;margin-top:4px">${escapeHtml(place.address)}</div>` : ''}
      <a href="${escapeHtml(place.osmUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;font-size:12px;font-weight:600;color:#047857">Open in OpenStreetMap ↗</a>
    </div>`;
  }

  function drawMarkers(places, categoryKey) {
    if (!map.instance) return;
    places.forEach((p, i) => {
      const icon = L.divIcon({
        className: 'mm-pin-wrap',
        html: `<div class="mm-pin"><span>${i + 1}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]
      });
      const marker = L.marker([p.lat, p.lon], { icon, title: p.name, keyboard: true })
        .bindPopup(popupHtml(p, categoryKey));
      marker.on('click', () => selectPlace(p.key, { fromMarker: true }));
      marker.addTo(map.resultsLayer);
      state.markers.set(p.key, marker);
    });
  }

  /* ------------------------------------------------------------------
     9. RENDERING RESULTS
  ------------------------------------------------------------------ */
  function renderCards(places, categoryKey) {
    const cat = CATEGORIES[categoryKey];
    el.placeList.innerHTML = places.map((p, i) => `
      <article class="place-card card-in rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm" data-key="${escapeHtml(p.key)}" style="animation-delay:${Math.min(i, 12) * 35}ms">
        <div class="flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-forest-700 text-sm font-bold text-white">${i + 1}</span>
          <div class="min-w-0 flex-1">
            <h3 class="break-words text-[15px] font-bold leading-snug text-forest-900 ${p.unnamed ? 'italic opacity-80' : ''}">${escapeHtml(p.name)}</h3>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <span class="rounded-full bg-emerald-50 px-2.5 py-0.5 font-semibold text-emerald-800">${cat.icon} ${escapeHtml(cat.label.replace(/s$/, ''))}</span>
              <span class="rounded-full bg-amber-50 px-2.5 py-0.5 font-semibold text-amber-800" title="Straight-line distance estimate">📏 ${formatDistance(p.distance)}</span>
              ${p.cuisine ? `<span class="rounded-full bg-slate-100 px-2.5 py-0.5 font-medium capitalize text-slate-700">${escapeHtml(p.cuisine)}</span>` : ''}
            </div>
            <p class="mt-2 text-sm text-forest-800/80">${p.address ? '📍 ' + escapeHtml(p.address) : '<span class="opacity-60">📍 Address not listed in OpenStreetMap</span>'}</p>
            <p class="mt-0.5 text-sm text-forest-800/80">${p.openingHours ? '🕒 ' + escapeHtml(p.openingHours) : '<span class="opacity-60">🕒 Opening hours not listed</span>'}</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button type="button" data-action="show" class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700">Show on Map</button>
              <a href="${escapeHtml(p.osmUrl)}" target="_blank" rel="noopener noreferrer" class="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-bold text-emerald-800 transition hover:bg-emerald-50">Open in OpenStreetMap ↗</a>
            </div>
          </div>
        </div>
      </article>`).join('');
  }

  function renderSuccess(origin, categoryKey, radiusKm, allPlaces, hitLimit) {
    const cat = CATEGORIES[categoryKey];
    const shown = allPlaces.slice(0, CONFIG.MAX_DISPLAY);
    state.places = shown;
    state.byKey = new Map(shown.map((p) => [p.key, p]));

    showOriginOnMap(origin, radiusKm);
    setMapBadge(`Showing: ${shortName(origin.displayName)} · ${radiusKm} km radius`, 'live');

    if (shown.length === 0) {
      showState({
        tone: 'info', icon: '🌱', title: 'No matching places found in this area.',
        message: `OpenStreetMap has no ${cat.label.toLowerCase()} within ${radiusKm} km of ${shortName(origin.displayName)}.`,
        tips: ['Try a larger radius.', 'Select another category.', 'Search for a nearby locality.']
      });
      return;
    }

    drawMarkers(shown, categoryKey);
    renderCards(shown, categoryKey);

    el.stateBox.classList.add('hidden');
    el.listWrap.classList.remove('hidden');
    el.summary.classList.remove('hidden');
    el.summary.classList.add('grid');
    animateCount(el.sumCount, allPlaces.length);
    el.sumCategory.textContent = `${cat.icon} ${cat.label}`;
    el.sumRadius.textContent = `${radiusKm} km`;
    el.sumLocation.textContent = shortName(origin.displayName);
    el.sumLocation.title = origin.displayName;

    const parts = [];
    if (allPlaces.length > shown.length) parts.push(`Showing the nearest ${shown.length} of ${allPlaces.length} places to keep the page fast.`);
    else parts.push(`Showing all ${shown.length} place${shown.length === 1 ? '' : 's'}, nearest first.`);
    if (hitLimit) parts.push('The data request reached its size cap, so some nearer places may be missing; try a smaller radius.');
    parts.push('Distances are straight-line estimates.');
    el.limitNote.textContent = parts.join(' ');

    setTimeout(() => map.instance && map.instance.invalidateSize(), 150);
  }

  /* ------------------------------------------------------------------
     10. SELECTING A PLACE (card ⇄ marker)
  ------------------------------------------------------------------ */
  function selectPlace(key, { fromMarker = false } = {}) {
    const place = state.byKey.get(key);
    const marker = state.markers.get(key);
    if (!place || !marker || !map.instance) return;

    // clear previous highlight
    if (state.selectedKey) {
      const prevCard = el.placeList.querySelector(`[data-key="${CSS.escape(state.selectedKey)}"]`);
      if (prevCard) prevCard.classList.remove('is-selected');
      const prevMarker = state.markers.get(state.selectedKey);
      if (prevMarker) { const e = prevMarker.getElement(); if (e) e.classList.remove('is-selected'); prevMarker.setZIndexOffset(0); }
    }
    state.selectedKey = key;

    const card = el.placeList.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (card) {
      card.classList.add('is-selected');
      if (fromMarker) card.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    const markerEl = marker.getElement();
    if (markerEl) markerEl.classList.add('is-selected');
    marker.setZIndexOffset(1000);

    const zoom = Math.max(map.instance.getZoom(), 16);
    if (prefersReducedMotion()) map.instance.setView([place.lat, place.lon], zoom, { animate: false });
    else map.instance.flyTo([place.lat, place.lon], zoom, { duration: 0.8 });
    marker.openPopup();

    // on stacked (mobile/tablet) layouts bring the map into view
    if (!fromMarker && window.innerWidth < 1024) {
      el.map.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }

  /* ------------------------------------------------------------------
     11. EVENT HANDLERS
  ------------------------------------------------------------------ */

  /** EVENT 1 — form submit: validate → geocode → fetch places → render */
  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;                                  // prevent duplicate submissions

    const check = validateLocation(el.location.value);
    if (!check.ok) {
      setFieldInvalid(true);
      setLocationHint(check.message, 'error');
      setStatus(check.message);
      el.location.focus();
      return;
    }
    setFieldInvalid(false);

    const categoryKey = el.category.value;
    const radiusKm = Number(el.radius.value);
    if (!CATEGORIES[categoryKey] || !CONFIG.ALLOWED_RADII_KM.includes(radiusKm)) {
      setStatus('Please choose a valid category and radius.');
      return;
    }

    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    const { signal } = state.controller;
    const myId = ++state.requestId;

    setBusy(true);
    setStatus('');
    setLocationHint('Searching…', 'neutral');
    showLoading('Finding your location…');
    el.explore.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

    let origin = null;
    let stage = 'geocode';
    try {
      origin = await geocode(check.value, signal);
      if (myId !== state.requestId) return;

      stage = 'places';
      showLoading(`Searching for ${CATEGORIES[categoryKey].label.toLowerCase()} near ${shortName(origin.displayName)}…`);
      const { places, hitLimit } = await fetchPlaces(categoryKey, origin, radiusKm, signal);
      if (myId !== state.requestId) return;

      renderSuccess(origin, categoryKey, radiusKm, places, hitLimit);
      state.lastSearch = { category: categoryKey, radiusKm };
      setLocationHint('Looks good — press Search to run it again.', 'good');
      setStatus(places.length ? `Found ${places.length} ${CATEGORIES[categoryKey].label.toLowerCase()} within ${radiusKm} km.` : 'No matching places found in this area.');
    } catch (err) {
      if (myId !== state.requestId) return;
      if (!(err instanceof AppError)) console.error('MapMate unexpected error:', err);
      else if (err.kind !== 'aborted' && err.kind !== 'notfound') console.warn('MapMate request problem:', err.kind, err.detail || err.message);

      const info = describeError(err, stage);
      if (origin) {
        // Geocoding genuinely succeeded, so show the real location even though places failed.
        showOriginOnMap(origin, radiusKm);
        setMapBadge(`Located: ${shortName(origin.displayName)} (places not loaded)`, 'live');
      } else if (err.kind === 'notfound') {
        setFieldInvalid(true);
        setLocationHint('Location not found.', 'error');
      }
      showState(info);
      setStatus(info.title);
    } finally {
      if (myId === state.requestId) setBusy(false);          // always restore the button
    }
  }

  /** EVENT 2 — category / radius change: give feedback, don't search automatically */
  function handleSelectChange() {
    const cat = CATEGORIES[el.category.value];
    const km = el.radius.value;
    if (!cat) return;
    const changed = state.lastSearch && (state.lastSearch.category !== el.category.value || String(state.lastSearch.radiusKm) !== km);
    el.categoryHint.innerHTML = `Selected: <strong>${escapeHtml(cat.label)}</strong> within <strong>${escapeHtml(km)} km</strong>.` +
      (changed ? ' <span class="font-semibold text-emerald-700">Press “Search nearby places” to update the results.</span>' : '');
  }

  /** EVENT 3 — place card click (event delegation) */
  function handleListClick(event) {
    if (event.target.closest('a')) return;                   // let links work normally
    const card = event.target.closest('[data-key]');
    if (card) selectPlace(card.dataset.key);
  }

  /** EVENT 4 — location input: gentle, debounced feedback (no error per keystroke) */
  function handleLocationInput() {
    clearTimeout(hintTimer);
    setFieldInvalid(false);
    setStatus('');
    hintTimer = setTimeout(() => {
      const raw = el.location.value.replace(/\s+/g, ' ').trim();
      if (raw.length === 0) setLocationHint('Try “Indiranagar, Bengaluru” or “Cubbon Park”.', 'neutral');
      else if (raw.length < CONFIG.MIN_QUERY_LENGTH) setLocationHint(`Keep typing — at least ${CONFIG.MIN_QUERY_LENGTH} characters.`, 'neutral');
      else if (raw.length > CONFIG.MAX_QUERY_LENGTH) setLocationHint(`Too long (${raw.length}/${CONFIG.MAX_QUERY_LENGTH}). Please shorten it.`, 'error');
      else if (!/[\p{L}\p{N}]/u.test(raw)) setLocationHint('Use letters or numbers.', 'neutral');
      else setLocationHint('Looks good — press Search.', 'good');
    }, 350);
  }

  /** EVENT 5 — reset: cancel work, clear results, restore the initial state */
  function handleReset() {
    if (state.controller) state.controller.abort();
    state.requestId++;                                       // invalidates any in-flight search
    setBusy(false);
    el.searchForm.reset();
    el.category.value = 'restaurant';
    el.radius.value = '3';
    state.places = [];
    state.byKey.clear();
    state.lastSearch = null;
    el.placeList.innerHTML = '';
    clearMapResults();
    if (map.instance) {
      const v = CONFIG.DEFAULT_VIEW;
      map.instance.closePopup();
      map.instance.setView([v.lat, v.lon], v.zoom, { animate: !prefersReducedMotion() });
    }
    setMapBadge(`Default view: ${CONFIG.DEFAULT_VIEW.label} (not a search result)`, 'default');
    setFieldInvalid(false);
    setLocationHint('Try “Indiranagar, Bengaluru” or “Cubbon Park”.', 'neutral');
    handleSelectChange();
    showInitialState();
    setStatus('Search reset.');
    el.location.focus();
  }

  /** EVENT 6 — cancel button aborts the running request */
  function handleCancel() {
    if (!state.busy) return;
    state.controller.abort();
  }

  /** EVENT 7 — example chips fill the input */
  function handleChipClick(event) {
    const chip = event.target.closest('.example-chip');
    if (!chip) return;
    el.location.value = chip.dataset.q || '';
    el.location.focus();
    handleLocationInput();
  }

  /** EVENT 8 — mobile navigation */
  function handleMenuToggle() {
    const open = el.mobileMenu.classList.toggle('hidden') === false;
    el.mobileMenuBtn.setAttribute('aria-expanded', String(open));
  }

  /* ------------------------------------------------------------------
     12. ENTRANCE ANIMATIONS
  ------------------------------------------------------------------ */
  function initReveal() {
    const nodes = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
      nodes.forEach((n) => n.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    nodes.forEach((n) => io.observe(n));
    setTimeout(() => nodes.forEach((n) => n.classList.add('in')), 2500);   // safety net
  }

  /* ------------------------------------------------------------------
     13. INIT
  ------------------------------------------------------------------ */
  function init() {
    [
      'mobileMenuBtn', 'mobileMenu', 'searchForm', 'location', 'locationHint', 'category', 'radius', 'categoryHint',
      'searchBtn', 'searchBtnLabel', 'searchSpinner', 'searchIcon', 'cancelBtn', 'resetBtn', 'formStatus', 'explore',
      'summary', 'sumCount', 'sumCategory', 'sumRadius', 'sumLocation', 'stateBox', 'listWrap', 'placeList',
      'limitNote', 'map', 'mapBadge', 'mapNote'
    ].forEach((id) => { el[id] = $(id); });

    try { initReveal(); } catch (e) { console.warn('Reveal animations disabled:', e); }

    initMap();
    showInitialState();

    el.searchForm.addEventListener('submit', handleSubmit);
    el.category.addEventListener('change', handleSelectChange);
    el.radius.addEventListener('change', handleSelectChange);
    el.placeList.addEventListener('click', handleListClick);
    el.location.addEventListener('input', handleLocationInput);
    el.resetBtn.addEventListener('click', handleReset);
    el.cancelBtn.addEventListener('click', handleCancel);
    document.addEventListener('click', handleChipClick);
    el.mobileMenuBtn.addEventListener('click', handleMenuToggle);
    el.mobileMenu.addEventListener('click', (e) => {
      if (e.target.closest('a')) { el.mobileMenu.classList.add('hidden'); el.mobileMenuBtn.setAttribute('aria-expanded', 'false'); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
