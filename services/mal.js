/**
 * MyAnimeList API Service
 *
 * Handles all interactions with the MAL REST API v2, including fetching
 * a user's currently watching anime and individual anime metadata.
 *
 * Requires a MAL Client ID — register an app at:
 * https://myanimelist.net/apiconfig
 *
 * @module services/mal
 */

const axios = require('axios');
const { MAL_API_URL, MAL_OAUTH, POSTER_SHAPES } = require('../config/constants');
const tokenManager = require('../config/tokens');
const { TTLCache } = require('../config/cache');
const mappings = require('../config/mappings');

// 5-minute TTL for anime list catalog responses, keyed by username:status
const animeListCache = new TTLCache(5 * 60 * 1000);
// 30-minute TTL for single anime meta, keyed by id
const animeMetaCache = new TTLCache(30 * 60 * 1000);

const KITSU_API_URL = 'https://kitsu.io/api/edge';
const KITSU_BATCH_SIZE = 20;

/**
 * Fields to request from the MAL anime list endpoint
 * @constant {string}
 */
const LIST_FIELDS = [
  'list_status',
  'main_picture',
  'synopsis',
  'genres',
  'mean',
  'num_episodes',
  'start_season',
  'status',
  'media_type',
  'alternative_titles'
].join(',');

/**
 * Fields to request from the MAL single-anime endpoint
 * @constant {string}
 */
const META_FIELDS = [
  'id',
  'title',
  'main_picture',
  'synopsis',
  'genres',
  'mean',
  'num_episodes',
  'start_season',
  'status',
  'background',
  'media_type',
  'alternative_titles'
].join(',');

/**
 * Fetches a user's anime list from MAL.
 *
 * @async
 * @param {string} username - MAL username
 * @param {string} clientId - MAL API Client ID
 * @param {string} status - MAL list status filter
 * @returns {Promise<Array<Object>>} Array of Stremio meta objects
 * @throws {Error} If the MAL API request fails
 */
async function getAnimeList(username, clientId, status) {
  try {
    const cacheKey = `${username}:${status}`;
    const cached = animeListCache.get(cacheKey);
    if (cached) {
      console.log(`[cache] Returning cached ${status} MAL list for ${username} (${cached.length} items)`);
      return cached;
    }
    console.log(`Fetching ${status} anime from MAL for user: ${username}`);

    const response = await axios.get(
      `${MAL_API_URL}/users/${encodeURIComponent(username)}/animelist`,
      {
        params: {
          status,
          fields: LIST_FIELDS,
          limit: 1000,
          nsfw: true
        },
        headers: {
          'X-MAL-CLIENT-ID': clientId
        },
        timeout: 10000
      }
    );

    const data = response.data?.data;
    if (!Array.isArray(data)) {
      throw new Error('Invalid response structure from MAL API');
    }

    console.log(`Found ${data.length} ${status} anime on MAL`);

    // Build a map of MAL ID -> Kitsu ID so stream addons can find streams
    const malIds = data.map(entry => entry.node.id);
    const kitsuIdMap = await fetchKitsuIdMap(malIds);
    console.log(`Kitsu ID mapping: ${Object.keys(kitsuIdMap).length}/${malIds.length} resolved`);

    const result = data.map(entry => transformToStremioMeta(entry, kitsuIdMap));
    animeListCache.set(cacheKey, result);
    return result;

  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.message || 'Unknown API error';

      console.error(`MAL API error (${status}): ${message}`);

      if (status === 400) {
        throw new Error(`MAL user "${username}" not found or list is private.`);
      } else if (status === 401) {
        throw new Error('MAL Client ID is invalid or missing. Check your MAL_CLIENT_ID in .env.');
      } else if (status === 403) {
        throw new Error(`MAL user "${username}"'s anime list is not public.`);
      } else if (status === 404) {
        throw new Error(`MAL user "${username}" not found.`);
      } else if (status === 429) {
        throw new Error('MAL API rate limit exceeded. Please try again later.');
      } else {
        throw new Error(`MAL API error (${status}): ${message}`);
      }
    } else if (error.request) {
      throw new Error('Unable to connect to MAL API. Please check your internet connection.');
    } else {
      throw new Error(`Failed to fetch MAL anime list: ${error.message}`);
    }
  }
}

/**
 * Fetches detailed metadata for a single anime by MAL ID.
 *
 * @async
 * @param {string} id - Anime ID in "mal:{id}" format
 * @param {string} clientId - MAL API Client ID
 * @returns {Promise<Object>} Stremio meta object
 * @throws {Error} If the MAL API request fails
 */
async function getAnimeMeta(id, clientId) {
  try {
    // kitsu: IDs come through when the catalog entry was resolved to a Kitsu ID
    if (id.startsWith('kitsu:')) {
      return await fetchKitsuMeta(id);
    }

    const cached = animeMetaCache.get(id);
    if (cached) {
      console.log(`[cache] Returning cached MAL meta for ${id}`);
      return cached;
    }

    const malId = id.replace('mal:', '');
    console.log(`Fetching MAL metadata for anime ID: ${malId}`);

    const response = await axios.get(
      `${MAL_API_URL}/anime/${encodeURIComponent(malId)}`,
      {
        params: { fields: META_FIELDS },
        headers: { 'X-MAL-CLIENT-ID': clientId },
        timeout: 10000
      }
    );

    const anime = response.data;
    if (!anime || !anime.id) {
      throw new Error('Invalid response structure from MAL API');
    }

    const meta = transformSingleToMeta(anime);

    // Add episode list so Stremio's "mark as watched" button works.
    const isMovie = anime.media_type === 'movie';
    // num_episodes is 0 for ongoing series; fall back to 500 so episodes are
    // still generated for currently-airing anime.
    const episodeCount = anime.num_episodes || (isMovie ? 0 : 500);
    if (!isMovie && episodeCount > 0) {
      meta.videos = [];
      const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (let ep = 1; ep <= episodeCount; ep++) {
        meta.videos.push({
          id: `${meta.id}:1:${ep}`,
          title: `Episode ${ep}`,
          season: 1,
          episode: ep,
          released: pastDate,
          overview: '',
          available: true
        });
      }
    }
    if (isMovie) {
      meta.behaviorHints = { defaultVideoId: meta.id };
    }

    animeMetaCache.set(id, meta);
    return meta;

  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error(`Anime "${id}" not found on MAL.`);
    }
    if (error.response?.status === 401) {
      throw new Error('MAL Client ID is invalid or missing.');
    }
    console.error(`Error fetching MAL meta for ${id}:`, error.message);
    throw new Error(`Failed to fetch MAL anime metadata: ${error.message}`);
  }
}

/**
 * Fetches metadata for a Kitsu anime ID via the Kitsu REST API.
 *
 * @async
 * @private
 * @param {string} id - Anime ID in "kitsu:{id}" format
 * @returns {Promise<Object>} Stremio meta object
 */
async function fetchKitsuMeta(id) {
  const cached = animeMetaCache.get(id);
  if (cached) {
    console.log(`[cache] Returning cached Kitsu meta for ${id}`);
    return cached;
  }
  const kitsuId = id.replace('kitsu:', '');
  console.log(`Fetching Kitsu metadata for MAL-sourced anime ID: ${kitsuId}`);

  const response = await axios.get(
    `${KITSU_API_URL}/anime/${encodeURIComponent(kitsuId)}`,
    {
      headers: { 'Accept': 'application/vnd.api+json' },
      timeout: 10000
    }
  );

  const anime = response.data?.data;
  if (!anime) throw new Error('Invalid response from Kitsu API');

  const attrs = anime.attributes;
  const title = attrs.titles?.en || attrs.titles?.en_jp || attrs.canonicalTitle;
  const rating = attrs.averageRating
    ? (parseFloat(attrs.averageRating) / 10).toFixed(1)
    : null;
  const year = attrs.startDate ? parseInt(attrs.startDate.substring(0, 4), 10) : null;
  const cleanDescription = attrs.synopsis
    ? attrs.synopsis.replace(/<[^>]*>/g, '').trim()
    : '';

  const isMovie = attrs.showType === 'movie';
  const type = isMovie ? 'movie' : 'series';
  // episodeCount is null for ongoing series; fall back to 500.
  const episodeCount = attrs.episodeCount || (isMovie ? 0 : 500);

  const videos = [];
  if (!isMovie && episodeCount > 0) {
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (let ep = 1; ep <= episodeCount; ep++) {
      videos.push({
        id: `${id}:${ep}`,
        title: `Episode ${ep}`,
        season: 1,
        episode: ep,
        released: pastDate,
        overview: '',
        available: true
      });
    }
  }

  const meta = {
    id,
    type,
    name: title,
    poster: attrs.posterImage?.large || attrs.posterImage?.medium,
    posterShape: POSTER_SHAPES.PORTRAIT,
    background: attrs.coverImage?.large || attrs.coverImage?.original,
    description: cleanDescription,
    imdbRating: rating,
    releaseInfo: year ? `${year}` : undefined,
    year,
    videos: isMovie ? undefined : videos,
    behaviorHints: isMovie ? { defaultVideoId: id } : undefined
  };
  animeMetaCache.set(id, meta);
  return meta;
}

/**
 * Fetches Kitsu IDs for an array of MAL IDs in batches.
 * Returns a map of { malId (string) -> kitsuId (string) }.
 * Entries with no Kitsu match are omitted; callers fall back to mal: IDs.
 *
 * @async
 * @private
 * @param {number[]} malIds
 * @returns {Promise<Object>}
 */
async function fetchKitsuIdMap(malIds) {
  if (!malIds.length) return {};

  const map = {};
  const uncached = [];

  for (const id of malIds) {
    const cached = mappings.get('mal_to_kitsu', id);
    if (cached) {
      map[String(id)] = cached;
    } else {
      uncached.push(id);
    }
  }

  if (!uncached.length) {
    console.log(`[cache] All ${malIds.length} Kitsu IDs resolved from persistent mappings`);
    return map;
  }

  console.log(`[cache] Fetching Kitsu IDs for ${uncached.length}/${malIds.length} uncached MAL entries`);

  const chunks = [];
  for (let i = 0; i < uncached.length; i += KITSU_BATCH_SIZE) {
    chunks.push(uncached.slice(i, i + KITSU_BATCH_SIZE));
  }

  await Promise.all(chunks.map(async (chunk) => {
    try {
      // Build URL manually — axios encodes commas as %2C in params,
      // but Kitsu requires literal commas for multi-value filters.
      const qs = `filter[externalSite]=myanimelist/anime&filter[externalId]=${chunk.join(',')}&include=item&page[limit]=${KITSU_BATCH_SIZE}`;
      const url = `${KITSU_API_URL}/mappings?${qs}`;
      console.log(`Kitsu batch URL: ${url}`);
      const response = await axios.get(url, {
        headers: { 'Accept': 'application/vnd.api+json' },
        timeout: 10000
      });
      console.log(`Kitsu batch returned ${response.data?.data?.length ?? 0} mappings`);

      for (const item of response.data?.data || []) {
        const malId = item.attributes?.externalId;
        const kitsuId = item.relationships?.item?.data?.id;
        if (kitsuId && malId != null) {
          map[String(malId)] = String(kitsuId);
          mappings.set('mal_to_kitsu', malId, kitsuId);
        }
      }
    } catch (err) {
      console.warn(`Kitsu ID batch lookup failed: ${err.message}`);
    }
  }));

  return map;
}

/**
 * Transforms a MAL animelist entry into Stremio meta format.
 *
 * @private
 * @param {Object} entry - MAL list entry ({ node, list_status })
 * @param {Object} kitsuIdMap - map of malId -> kitsuId
 * @returns {Object} Stremio-compatible meta object
 */
function transformToStremioMeta(entry, kitsuIdMap = {}) {
  const anime = entry.node;
  const listStatus = entry.list_status;
  const kitsuId = kitsuIdMap[String(anime.id)] || null;
  return buildMeta(anime, listStatus?.num_episodes_watched ?? 0, kitsuId);
}

/**
 * Transforms a single MAL anime object (from /anime/:id) into Stremio meta format.
 *
 * @private
 * @param {Object} anime - MAL anime object
 * @returns {Object} Stremio-compatible meta object
 */
function transformSingleToMeta(anime) {
  return buildMeta(anime, 0, null);
}

/**
 * Shared builder for Stremio meta objects from MAL data.
 *
 * @private
 */
function buildMeta(anime, progressEpisodes, kitsuId) {
  const rating = anime.mean ? anime.mean.toFixed(1) : null;

  const cleanDescription = anime.synopsis
    ? anime.synopsis.replace(/<[^>]*>/g, '').trim()
    : '';

  const year = anime.start_season?.year ?? null;

  // Prefer English title; fall back to the default MAL title (usually romaji)
  const altTitles = anime.alternative_titles || {};
  const englishTitle = altTitles.en && altTitles.en.trim() !== '' ? altTitles.en.trim() : null;
  const primaryTitle = englishTitle || anime.title;

  // Build deduplicated aliases list for Torrentio/search fallback
  const aliasSet = new Set();
  if (englishTitle) aliasSet.add(englishTitle);
  if (anime.title) aliasSet.add(anime.title);
  if (altTitles.ja) aliasSet.add(altTitles.ja);
  (altTitles.synonyms || []).forEach(s => aliasSet.add(s));
  aliasSet.delete(primaryTitle);
  const aliases = [...aliasSet].filter(Boolean);

  return {
    id: kitsuId ? `kitsu:${kitsuId}` : `mal:${anime.id}`,
    type: anime.media_type === 'movie' ? 'movie' : 'series',
    name: primaryTitle,
    aliases,
    poster: anime.main_picture?.large || anime.main_picture?.medium || null,
    posterShape: POSTER_SHAPES.PORTRAIT,
    background: anime.main_picture?.large || null,
    description: cleanDescription,
    genres: (anime.genres || []).map(g => g.name),
    imdbRating: rating,
    releaseInfo: year ? `${year}` : undefined,
    year,
    watched: progressEpisodes > 0,
    meta: {
      episodes: anime.num_episodes,
      status: anime.status,
      progress: progressEpisodes
    }
  };
}

/**
 * Refreshes MAL OAuth tokens using the stored refresh_token.
 * Persists the new token pair back to tokens.json on success.
 *
 * @async
 * @param {string} username - MAL username whose tokens should be refreshed
 * @param {string} clientId - MAL OAuth Client ID
 * @param {string} clientSecret - MAL OAuth Client Secret
 * @returns {Promise<string>} New access_token
 * @throws {Error} If the refresh request fails or no refresh_token is stored
 */
async function refreshMalTokens(username, clientId, clientSecret) {
  const record = tokenManager.getTokenRecord('mal', username);
  const refreshToken = record?.refresh_token;

  if (!refreshToken) {
    throw new Error(`No refresh_token stored for MAL user "${username}". Re-authentication required.`);
  }

  console.log(`[MAL] Refreshing access token for user: ${username}`);

  const { data } = await axios.post(MAL_OAUTH.TOKEN_URL, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });

  if (!data?.access_token) {
    throw new Error('MAL token refresh returned no access_token.');
  }

  tokenManager.storeTokens('mal', username, {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 2592000  // default 30 days
  });

  console.log(`[MAL] Token refreshed successfully for user: ${username}`);
  return data.access_token;
}

/**
 * Returns a valid MAL access token for the given user, automatically
 * refreshing via refresh_token if the stored access token has expired.
 *
 * @async
 * @param {string} username - MAL username
 * @param {string} clientId - MAL OAuth Client ID
 * @param {string} clientSecret - MAL OAuth Client Secret
 * @returns {Promise<string>} A valid access_token
 * @throws {Error} If neither a valid access_token nor a refresh_token is available
 */
async function getMalAccessToken(username, clientId, clientSecret) {
  const tokens = tokenManager.getTokens('mal', username);
  if (tokens?.access_token) return tokens.access_token;

  // Access token expired or missing — attempt silent refresh
  return refreshMalTokens(username, clientId, clientSecret);
}

/**
 * Updates the user's progress for an anime on MyAnimeList.
 * Requires the user to have authenticated via OAuth (token stored in tokens.json).
 *
 * @async
 * @param {string} animeId - MAL anime ID
 * @param {number} episode - Episode number that was watched
 * @param {string} username - User's MAL username
 * @param {string} clientId - MAL Client ID
 * @returns {Promise<void>}
 * @throws {Error} If progress update fails
 */
async function updateProgress(animeId, episode, username, clientId) {
  try {
    console.log(`Updating progress for MAL anime ${animeId}: episode ${episode} for user ${username}`);

    const config = require('../config/env');
    const accessToken = await getMalAccessToken(username, clientId, config.malClientSecret);
    if (!accessToken) {
      throw new Error('User not authenticated with MyAnimeList. Please authenticate via the configure page.');
    }

    await axios.patch(
      `${MAL_API_URL}/anime/${animeId}/my_list_status`,
      new URLSearchParams({ num_watched_episodes: episode }),
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    console.log(`Successfully updated MAL progress for anime ${animeId} to episode ${episode}`);

  } catch (error) {
    console.error(`Error updating progress for anime ${animeId}:`, error.message);
    throw new Error(`Failed to update progress: ${error.message}`);
  }
}

/**
 * Fetches the authenticated user's username from MAL using their access token.
 *
 * @async
 * @param {string} accessToken - MAL OAuth access token
 * @returns {Promise<string|null>} MAL username or null
 */
async function getAuthenticatedUsername(accessToken) {
  try {
    const response = await axios.get(`${MAL_API_URL}/users/@me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 10000
    });
    return response.data?.name || null;
  } catch (err) {
    console.error('Failed to fetch MAL username from @me:', err.message);
    return null;
  }
}

module.exports = {
  getAnimeList,
  getAnimeMeta,
  updateProgress,
  refreshMalTokens,
  getMalAccessToken,
  mapKitsuToMal,
  getAuthenticatedUsername,
  fetchKitsuIdMap
};

/**
 * Maps a Kitsu anime ID to a MAL anime ID.
 *
 * @async
 * @param {string} kitsuId - Kitsu anime ID
 * @returns {Promise<string|null>} MAL ID or null if not found
 */
async function mapKitsuToMal(kitsuId) {
  const cached = mappings.get('kitsu_to_mal', kitsuId);
  if (cached) return cached;
  try {
    const response = await axios.get(
      `${KITSU_API_URL}/anime/${encodeURIComponent(kitsuId)}/mappings?filter[externalSite]=myanimelist/anime`,
      {
        headers: { 'Accept': 'application/vnd.api+json' },
        timeout: 10000
      }
    );
    const malId = response.data?.data?.[0]?.attributes?.externalId;
    const result = malId ? String(malId) : null;
    if (result) mappings.set('kitsu_to_mal', kitsuId, result);
    return result;
  } catch (err) {
    console.warn(`Kitsu→MAL mapping failed for kitsuId ${kitsuId}: ${err.message}`);
    return null;
  }
}
