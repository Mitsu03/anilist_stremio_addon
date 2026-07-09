/**
 * AniList API Service
 * 
 * This module handles all interactions with the AniList GraphQL API,
 * including fetching user's currently watching anime and anime metadata.
 * 
 * @module services/anilist
 */

const axios = require('axios');
const { ANILIST_API_URL, ANILIST_STATUS, POSTER_SHAPES } = require('../config/constants');
const mappings = require('../config/mappings');
const { TTLCache } = require('../config/cache');
const { fetchKitsuIdMap } = require('./mal');

// Cache viewer info so we only look it up once per token
const viewerCache = new Map();

// 5-minute TTL cache for anime list (catalog) responses, keyed by viewerId:status
const animeListCache = new TTLCache(5 * 60 * 1000);

// 30-minute TTL cache for individual anime meta, keyed by anilist ID
const animeMetaCache = new TTLCache(30 * 60 * 1000);

const VIEWER_QUERY = `{ Viewer { id name } }`;

const UPDATE_PROGRESS_MUTATION = `
  mutation ($mediaId: Int, $progress: Int) {
    SaveMediaListEntry(mediaId: $mediaId, progress: $progress) {
      id
      progress
    }
  }
`;

async function getViewerInfo(token) {
  if (viewerCache.has(token)) return viewerCache.get(token);
  const response = await axios.post(
    ANILIST_API_URL,
    { query: VIEWER_QUERY },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      timeout: 10000
    }
  );
  const viewer = response.data?.data?.Viewer;
  if (!viewer) throw new Error('Could not retrieve viewer info from AniList');
  viewerCache.set(token, viewer);
  return viewer;
}

const ANIME_META_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title {
        english
        romaji
      }
      description
      coverImage {
        large
        medium
      }
      bannerImage
      genres
      averageScore
      status
      format
      episodes
      seasonYear
      season
      nextAiringEpisode {
        episode
      }
      externalLinks {
        url
        site
      }
    }
  }
`;

const ANIME_LIST_QUERY = `
  query ($userId: Int, $status: MediaListStatus) {
    MediaListCollection(userId: $userId, type: ANIME, status: $status) {
      lists {
        entries {
          id
          media {
            id
            idMal
            title {
              english
              romaji
            }
            description
            coverImage {
              large
              medium
            }
            bannerImage
            genres
            averageScore
            status
            format
            episodes
            seasonYear
            season
            externalLinks {
              url
              site
            }
          }
          status
          progress
        }
      }
    }
  }
`;

/**
 * Fetches currently watching anime from AniList for the configured user
 * 
 * This function queries the AniList API to retrieve all anime that the user
 * has marked as "Currently Watching" and transforms them into Stremio-compatible
 * metadata objects.
 * 
 * @async
 * @returns {Promise<Array<Object>>} Array of Stremio meta objects
 * @returns {string} return[].id - Unique identifier in format "anilist:{id}"
 * @returns {string} return[].type - Content type (always "anime")
 * @returns {string} return[].name - Anime title (English or Romaji)
 * @returns {string} return[].poster - URL to anime poster image
 * @returns {string} return[].posterShape - Shape of poster (portrait/landscape/square)
 * @returns {string} return[].description - Anime description/synopsis
 * @returns {Array<string>} return[].genres - Array of genre names
 * @returns {string} return[].imdbRating - Rating converted from AniList score (0-10 scale)
 * @returns {number} return[].year - Year the anime aired
 * @returns {boolean} return[].watched - Whether user has watched any episodes
 * 
 * @throws {Error} If AniList API request fails
 * 
 * @example
 * const animeList = await getCurrentlyWatchingAnime();
 * // Returns: [{ id: "anilist:12345", name: "Attack on Titan", ... }]
 */
async function getAnimeList(token, status) {
  try {
    const viewer = await getViewerInfo(token);
    const cacheKey = `${viewer.id}:${status}`;
    const cached = animeListCache.get(cacheKey);
    if (cached) {
      console.log(`[cache] Returning cached ${status} anime list for viewer ${viewer.name} (${cached.length} items)`);
      return cached;
    }
    console.log(`Fetching ${status} anime for viewer: ${viewer.name} (id: ${viewer.id})`);

    const response = await axios.post(
      ANILIST_API_URL,
      {
        query: ANIME_LIST_QUERY,
        variables: { userId: viewer.id, status }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000
      }
    );

    // Validate response structure
    if (!response.data || !response.data.data) {
      throw new Error('Invalid response structure from AniList API');
    }

    // Extract entries from nested response structure
    const mediaListCollection = response.data.data.MediaListCollection;
    
    // Handle case where user has no currently watching anime
    if (!mediaListCollection || !mediaListCollection.lists || mediaListCollection.lists.length === 0) {
      console.log(`No ${status} anime found for user`);
      return [];
    }

    const entries = mediaListCollection.lists[0]?.entries || [];
    console.log(`Found ${entries.length} ${status} anime`);

    // Batch-resolve Kitsu IDs for all entries that have a MAL ID
    const malIds = entries
      .map(e => e.media.idMal)
      .filter(Boolean)
      .map(String);
    const kitsuIdMap = await fetchKitsuIdMap(malIds);

    // Transform AniList entries to Stremio meta format
    const result = entries.map(entry => transformToStremioMeta(entry, kitsuIdMap));
    animeListCache.set(cacheKey, result);
    return result;

  } catch (error) {
    // Enhanced error handling with specific error types
    if (error.response) {
      // AniList API returned an error response
      const status = error.response.status;
      const message = error.response.data?.errors?.[0]?.message || 'Unknown API error';
      
      console.error(`AniList API error (${status}): ${message}`);
      
      if (status === 404) {
        throw new Error(`AniList user "${username}" not found. Please check your username.`);
      } else if (status === 429) {
        throw new Error('AniList API rate limit exceeded. Please try again later.');
      } else {
        throw new Error(`AniList API error: ${message}`);
      }
    } else if (error.request) {
      // Request was made but no response received
      console.error('No response from AniList API:', error.message);
      throw new Error('Unable to connect to AniList API. Please check your internet connection.');
    } else {
      // Error in request setup or processing
      console.error('Error fetching from AniList:', error.message);
      throw new Error(`Failed to fetch anime list: ${error.message}`);
    }
  }
}

/**
 * Transforms an AniList media entry into Stremio meta format
 * 
 * Converts the AniList API response structure into the format expected
 * by Stremio, including proper ID formatting, rating conversion, and
 * metadata extraction.
 * 
 * @private
 * @param {Object} entry - AniList media list entry
 * @param {Object} entry.media - Media information
 * @param {number} entry.media.id - AniList media ID
 * @param {Object} entry.media.title - Title information
 * @param {string} entry.media.title.english - English title
 * @param {string} entry.media.title.romaji - Romaji title
 * @param {string} entry.media.description - Anime description
 * @param {Object} entry.media.coverImage - Cover image URLs
 * @param {string} entry.media.coverImage.large - Large cover image URL
 * @param {Array<string>} entry.media.genres - Genre list
 * @param {number} entry.media.averageScore - Average score (0-100)
 * @param {number} entry.media.seasonYear - Year aired
 * @param {number} entry.progress - Episodes watched
 * @returns {Object} Stremio-compatible meta object
 */
/**
 * Extracts a numeric Kitsu ID from AniList external links.
 *
 * @private
 * @param {Array<Object>} externalLinks - AniList externalLinks array
 * @returns {string|null} Kitsu ID string, or null if not found
 */
function extractKitsuId(externalLinks) {
  if (!Array.isArray(externalLinks)) return null;
  const kitsuLink = externalLinks.find(
    link => link.site === 'Kitsu' && link.url
  );
  if (!kitsuLink) return null;
  const match = kitsuLink.url.match(/kitsu\.(?:io|app)\/anime\/(\d+)/);
  return match ? match[1] : null;
}

function transformToStremioMeta(entry, kitsuIdMap = {}) {
  const media = entry.media;
  
  // Prefer English title, fallback to Romaji
  const title = media.title.english || media.title.romaji;

  // Build deduplicated aliases for Torrentio/search fallback
  const aliasSet = new Set();
  if (media.title.english) aliasSet.add(media.title.english);
  if (media.title.romaji) aliasSet.add(media.title.romaji);
  aliasSet.delete(title);
  const aliases = [...aliasSet].filter(Boolean);
  
  // Convert AniList score (0-100) to IMDb-style rating (0-10)
  const rating = media.averageScore 
    ? (media.averageScore / 10).toFixed(1) 
    : null;

  // Clean HTML tags from description
  const cleanDescription = media.description 
    ? media.description.replace(/<[^>]*>/g, '').trim()
    : '';

  // Resolve Kitsu ID from: externalLinks → batch map (via idMal) → fallback to anilist:
  const kitsuId = extractKitsuId(media.externalLinks)
    || (media.idMal && kitsuIdMap[String(media.idMal)])
    || null;

  // Use kitsu: ID so video IDs prefix-match the meta ID — required for
  // Stremio watched tracking (yellow banner). Fall back to anilist: if unresolved.
  const id = kitsuId ? `kitsu:${kitsuId}` : `anilist:${media.id}`;

  // Persist kitsu ↔ anilist mapping so future requests skip the API
  if (kitsuId) {
    mappings.set('kitsu_to_anilist', kitsuId, String(media.id));
    mappings.set('anilist_to_kitsu', String(media.id), kitsuId);
  }

  // Use 'movie' for films, 'series' for everything else so stream addons
  // (Comet, MediaFusion, AIO Streams) recognise the content type.
  const type = media.format === 'MOVIE' ? 'movie' : 'series';

  return {
    id,
    type,
    name: title,
    aliases,
    poster: media.coverImage.large || media.coverImage.medium,
    posterShape: POSTER_SHAPES.PORTRAIT,
    background: media.bannerImage || media.coverImage.large,
    description: cleanDescription,
    genres: media.genres || [],
    imdbRating: rating,
    releaseInfo: media.seasonYear ? `${media.seasonYear}` : undefined,
    year: media.seasonYear,
    // Mark as watched if user has made any progress
    watched: entry.progress > 0,
    // Additional metadata
    meta: {
      episodes: media.episodes,
      status: media.status,
      progress: entry.progress
    }
  };
}

/**
 * Fetches detailed metadata for a specific anime by ID
 * 
 * This function retrieves comprehensive information about a single anime
 * from AniList. Currently returns a placeholder but can be expanded to
 * fetch full details including episodes, characters, etc.
 * 
 * @async
 * @param {string} id - Anime ID in format "anilist:{id}"
 * @returns {Promise<Object>} Stremio meta object with anime details
 * @returns {string} return.id - The anime ID
 * @returns {string} return.type - Content type (always "anime")
 * @returns {string} return.name - Anime title
 * 
 * @example
 * const meta = await getAnimeMeta("anilist:12345");
 * // Returns: { id: "anilist:12345", type: "anime", name: "..." }
 */
async function getAnimeMeta(id) {
  try {
    const anilistId = parseInt(id.replace('anilist:', ''), 10);
    const cachedMeta = animeMetaCache.get(id);
    if (cachedMeta) {
      console.log(`[cache] Returning cached meta for anime ${anilistId}`);
      return cachedMeta;
    }
    console.log(`Fetching metadata for anime ID: ${anilistId}`);

    const response = await axios.post(
      ANILIST_API_URL,
      { query: ANIME_META_QUERY, variables: { id: anilistId } },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000
      }
    );

    const media = response.data?.data?.Media;
    if (!media) throw new Error('Anime not found on AniList');

    const title = media.title.english || media.title.romaji;
    const rating = media.averageScore ? (media.averageScore / 10).toFixed(1) : null;
    const cleanDescription = media.description
      ? media.description.replace(/<[^>]*>/g, '').trim()
      : '';

    const isMovie = media.format === 'MOVIE';
    const type = isMovie ? 'movie' : 'series';

    // Resolve Kitsu ID so video IDs match the ecosystem standard (kitsu:{id}:{ep}).
    // This ensures the yellow "watched" banner appears in Stremio.
    let kitsuId = extractKitsuId(media.externalLinks);
    if (!kitsuId && media.idMal) {
      kitsuId = mappings.get('mal_to_kitsu', String(media.idMal));
    }
    if (!kitsuId) {
      kitsuId = mappings.get('anilist_to_kitsu', String(anilistId));
    }
    console.log(`[meta] anilist:${anilistId} → idMal=${media.idMal}, kitsuId=${kitsuId || 'NONE'}`);
    if (kitsuId) {
      mappings.set('anilist_to_kitsu', String(anilistId), kitsuId);
      mappings.set('kitsu_to_anilist', kitsuId, String(anilistId));
    }

    // For ongoing series nextAiringEpisode.episode is the NEXT episode number,
    // so the last aired episode is episode - 1.
    // Fall back to 500 when neither field is available (unknown ongoing series).
    let episodeCount = media.episodes || 0;
    if (!isMovie && episodeCount === 0) {
      if (media.nextAiringEpisode?.episode > 1) {
        episodeCount = media.nextAiringEpisode.episode - 1;
      } else if (media.status === 'RELEASING') {
        episodeCount = 500;
      }
    }

    // Use kitsu-format video IDs (3-part: kitsu:{id}:{ep}) when possible,
    // matching Torrentio/AIO Streams/other addons. Fall back to anilist 4-part.
    const videoPrefix = kitsuId ? `kitsu:${kitsuId}` : null;
    const videos = [];
    if (!isMovie && episodeCount > 0) {
      const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (let ep = 1; ep <= episodeCount; ep++) {
        videos.push({
          id: videoPrefix ? `${videoPrefix}:${ep}` : `${id}:1:${ep}`,
          title: `Episode ${ep}`,
          season: 1,
          episode: ep,
          released: pastDate,
          overview: '',
          available: true
        });
      }
      console.log(`[meta] Video IDs format: ${videos[0]?.id} (${videos.length} episodes, type=${isMovie ? 'movie' : 'series'})`);
    }

    const meta = {
      id,
      type,
      name: title,
      description: cleanDescription,
      poster: media.coverImage?.large || media.coverImage?.medium,
      background: media.bannerImage,
      genres: media.genres || [],
      imdbRating: rating,
      releaseInfo: media.seasonYear ? String(media.seasonYear) : undefined,
      videos: isMovie ? undefined : videos,
      behaviorHints: isMovie ? { defaultVideoId: videoPrefix ? `kitsu:${kitsuId}` : id } : undefined
    };
    // Only cache if kitsu resolution succeeded or there's no MAL equivalent.
    // If an anime has a MAL ID but we couldn't resolve kitsu, it's likely a
    // race condition (mapping not loaded yet) — skip cache so next request retries.
    if (kitsuId || isMovie || !media.idMal) {
      animeMetaCache.set(id, meta);
    }
    return meta;
  } catch (error) {
    console.error(`Error fetching anime meta for ${id}:`, error.message);
    throw new Error(`Failed to fetch anime metadata: ${error.message}`);
  }
}

const IMDB_MAP_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
    }
  }
`;

async function mapKitsuToAniList(kitsuId) {
  // Check persistent mappings first — populated by catalog fetches or prior lookups
  const cached = mappings.get('kitsu_to_anilist', kitsuId);
  if (cached) return cached;
  try {
    // Use ?include=mappings (standard JSON:API) to get mapping data
    const response = await axios.get(
      `https://kitsu.io/api/edge/anime/${kitsuId}?include=mappings`,
      {
        headers: { 'Accept': 'application/vnd.api+json' },
        timeout: 10000
      }
    );
    const included = response.data?.included || [];
    const anilistMapping = included.find(
      item => item.type === 'mappings' && item.attributes?.externalSite === 'anilist/anime'
    );
    if (anilistMapping) {
      const anilistId = anilistMapping.attributes.externalId;
      mappings.set('kitsu_to_anilist', kitsuId, anilistId);
      mappings.set('anilist_to_kitsu', anilistId, kitsuId);
      return anilistId;
    }
    // Fallback: try MAL mapping → AniList idMal lookup
    const malMapping = included.find(
      item => item.type === 'mappings' && item.attributes?.externalSite === 'myanimelist/anime'
    );
    if (malMapping) {
      const anilistId = await mapMalIdToAniList(parseInt(malMapping.attributes.externalId, 10));
      if (anilistId) {
        mappings.set('kitsu_to_anilist', kitsuId, anilistId);
        mappings.set('anilist_to_kitsu', anilistId, kitsuId);
        return anilistId;
      }
    }
    return null;
  } catch (err) {
    console.error(`mapKitsuToAniList(${kitsuId}):`, err.message);
    return null;
  }
}

const MAL_ID_QUERY = `
  query ($idMal: Int) {
    Media(idMal: $idMal, type: ANIME) {
      id
    }
  }
`;

async function mapMalIdToAniList(malId) {
  const cached = mappings.get('mal_to_anilist', malId);
  if (cached) return cached;
  try {
    const response = await axios.post(
      ANILIST_API_URL,
      { query: MAL_ID_QUERY, variables: { idMal: malId } },
      {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 10000
      }
    );
    const id = response.data?.data?.Media?.id?.toString() || null;
    if (id) mappings.set('mal_to_anilist', malId, id);
    return id;
  } catch (err) {
    console.error(`mapMalIdToAniList(${malId}):`, err.message);
    return null;
  }
}

async function mapImdbToAniList(imdbId) {
  const cached = mappings.get('imdb_to_anilist', imdbId);
  if (cached) return cached;
  try {
    // AniList doesn't have a direct IMDB lookup; search by IMDB ID string as fallback
    const response = await axios.post(
      ANILIST_API_URL,
      { query: IMDB_MAP_QUERY, variables: { search: imdbId } },
      {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 10000
      }
    );
    const id = response.data?.data?.Media?.id?.toString() || null;
    if (id) mappings.set('imdb_to_anilist', imdbId, id);
    return id;
  } catch (err) {
    console.error(`mapImdbToAniList(${imdbId}):`, err.message);
    return null;
  }
}

async function updateProgress(animeId, episode, token) {
  try {
    const response = await axios.post(
      ANILIST_API_URL,
      {
        query: UPDATE_PROGRESS_MUTATION,
        variables: { mediaId: parseInt(animeId, 10), progress: episode }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000
      }
    );
    const saved = response.data?.data?.SaveMediaListEntry;
    if (!saved) throw new Error('No data returned from mutation');
    console.log(`Updated AniList progress: anime ${animeId} ep ${saved.progress}`);
    return saved;
  } catch (err) {
    console.error(`updateProgress(${animeId}, ep ${episode}):`, err.message);
    throw err;
  }
}

const ANILIST_TO_MAL_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      idMal
    }
  }
`;

async function mapAniListToMal(anilistId) {
  const cached = mappings.get('anilist_to_mal', anilistId);
  if (cached) return cached;
  try {
    const response = await axios.post(
      ANILIST_API_URL,
      { query: ANILIST_TO_MAL_QUERY, variables: { id: parseInt(anilistId, 10) } },
      {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 10000
      }
    );
    const idMal = response.data?.data?.Media?.idMal;
    const malId = idMal ? String(idMal) : null;
    if (malId) mappings.set('anilist_to_mal', anilistId, malId);
    return malId;
  } catch (err) {
    console.error(`mapAniListToMal(${anilistId}):`, err.message);
    return null;
  }
}

module.exports = {
  getViewerInfo,
  getAnimeList,
  getAnimeMeta,
  mapKitsuToAniList,
  mapImdbToAniList,
  mapAniListToMal,
  updateProgress
};

// Made with Bob
