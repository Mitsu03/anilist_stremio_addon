/**
 * Persistent ID Mappings
 *
 * Loads/saves known good ID mappings from data/mappings.json so that
 * previously resolved cross-service IDs (kitsu↔anilist, mal↔anilist,
 * imdb↔anilist) are never re-fetched from the API.
 *
 * Writes are debounced (2 s) to avoid excessive disk IO.
 */

const fs = require('fs');
const path = require('path');

const MAPPINGS_PATH = path.join(__dirname, '../data/mappings.json');

const DEFAULT_MAPPINGS = {
  kitsu_to_anilist: {},
  anilist_to_kitsu: {},
  mal_to_anilist: {},
  anilist_to_mal: {},
  imdb_to_anilist: {},
  mal_to_kitsu: {},
  kitsu_to_mal: {}
};

let data = { ...DEFAULT_MAPPINGS };

function load() {
  try {
    if (fs.existsSync(MAPPINGS_PATH)) {
      const raw = fs.readFileSync(MAPPINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      data = { ...DEFAULT_MAPPINGS, ...parsed };
      // Ensure every expected namespace exists
      for (const ns of Object.keys(DEFAULT_MAPPINGS)) {
        if (!data[ns] || typeof data[ns] !== 'object') data[ns] = {};
      }
      const total = Object.values(data).reduce((s, v) => s + Object.keys(v).length, 0);
      console.log(`[mappings] Loaded ${total} cached ID mappings from ${MAPPINGS_PATH}`);
    } else {
      data = { ...DEFAULT_MAPPINGS };
      saveSoon();
    }
  } catch (err) {
    console.error('[mappings] Failed to load mappings.json:', err.message);
    data = { ...DEFAULT_MAPPINGS };
  }
}

let saveTimer = null;

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(MAPPINGS_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[mappings] Failed to save mappings.json:', err.message);
    }
  }, 2000);
}

/**
 * Retrieve a cached mapping.
 *
 * @param {string} namespace - e.g. 'kitsu_to_anilist'
 * @param {string|number} key
 * @returns {string|null} cached value, or null if not found
 */
function get(namespace, key) {
  return data[namespace]?.[String(key)] ?? null;
}

/**
 * Store a mapping and schedule a file write.
 *
 * @param {string} namespace
 * @param {string|number} key
 * @param {string|number} value
 */
function set(namespace, key, value) {
  const k = String(key);
  const v = String(value);
  if (!data[namespace]) data[namespace] = {};
  if (data[namespace][k] !== v) {
    data[namespace][k] = v;
    saveSoon();
  }
}

// Initialize on require
load();

module.exports = { get, set };
