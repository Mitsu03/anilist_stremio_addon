/**
 * Shared TTL-based in-memory cache
 *
 * Provides a simple time-to-live cache that all service modules share.
 * Each service creates its own TTLCache instances with appropriate TTLs.
 *
 * Usage:
 *   const { TTLCache } = require('../config/cache');
 *   const myCache = new TTLCache(5 * 60 * 1000); // 5-minute TTL
 */

class TTLCache {
  /**
   * @param {number} ttlMs - Time-to-live in milliseconds
   */
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  /**
   * Retrieve a cached value. Returns undefined if missing or expired.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Store a value under the given key, resetting its TTL.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.store.set(key, { value, ts: Date.now() });
  }

  /** Remove a single entry. */
  delete(key) {
    this.store.delete(key);
  }

  /** Wipe all entries. */
  clear() {
    this.store.clear();
  }
}

module.exports = { TTLCache };
