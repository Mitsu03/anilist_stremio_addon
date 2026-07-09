/**
 * IMDB Watchlist Service
 *
 * Fetches a user's public IMDB watchlist via the IMDB GraphQL API
 * and transforms results into Stremio-compatible meta objects.
 *
 * Requires the user's IMDB User ID (starts with "ur") and the
 * watchlist/list to be public.
 *
 * @module services/imdb
 */

const { POSTER_SHAPES } = require('../config/constants');
const { TTLCache } = require('../config/cache');

// 5-minute TTL for watchlist/list responses
const watchlistCache = new TTLCache(5 * 60 * 1000);
// 1-hour TTL for profile ID resolution (rarely changes)
const profileIdCache = new TTLCache(60 * 60 * 1000);

const IMDB_GRAPHQL_URL = 'https://api.graphql.imdb.com/';
const IMDB_CLIENT_NAME = 'imdb-next-desktop';

const WATCHLIST_QUERY = `
  query WatchListPage($urConst: ID!, $first: Int!) {
    predefinedList(classType: WATCH_LIST, userId: $urConst) {
      id
      visibility { id }
      titleListItemSearch(first: $first) {
        total
        edges {
          listItem: title {
            id
            titleText { text }
            titleType { text }
            releaseYear { year }
            ratingsSummary { aggregateRating }
            titleGenres { genres { genre { text } } }
            countriesOfOrigin { countries { text } }
            plot { plotText { plainText } }
            primaryImage { url }
            runtime { seconds }
          }
        }
      }
    }
  }
`;

const LIST_QUERY = `
  query ListPage($listId: ID!, $first: Int!) {
    list(id: $listId) {
      id
      name { originalText }
      visibility { id }
      titleListItemSearch(first: $first) {
        total
        edges {
          listItem: title {
            id
            titleText { text }
            titleType { text }
            releaseYear { year }
            ratingsSummary { aggregateRating }
            titleGenres { genres { genre { text } } }
            countriesOfOrigin { countries { text } }
            plot { plotText { plainText } }
            primaryImage { url }
            runtime { seconds }
          }
        }
      }
    }
  }
`;

/**
 * Sends a GraphQL query to the IMDB API.
 *
 * @async
 * @private
 * @param {string} operationName
 * @param {string} query
 * @param {Object} variables
 * @returns {Promise<Object>} Parsed JSON response
 */
async function queryImdbGraphQL(operationName, query, variables) {
  const response = await fetch(IMDB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-imdb-client-name': IMDB_CLIENT_NAME
    },
    body: JSON.stringify({ operationName, query, variables })
  });

  if (!response.ok) {
    throw new Error('Could not reach the IMDB API.');
  }

  return response.json();
}

function hasForbiddenError(errors) {
  return Array.isArray(errors) && errors.some(e => e.extensions?.code === 'FORBIDDEN');
}

/**
 * Transforms raw IMDB GraphQL edges into Stremio meta objects.
 *
 * @private
 * @param {Array} edges
 * @returns {Array<Object>} Stremio meta objects
 */
function transformEdgesToMetas(edges) {
  const metas = [];
  for (const edge of edges) {
    const item = edge.listItem;
    if (!item || !item.id) continue;

    const typeName = item.titleType?.text || '';
    const isMovie = typeName === 'Movie';
    const isSeries = typeName === 'TV Series' || typeName === 'TV Mini Series';
    const isAnimeType = typeName === 'Anime Series';
    if (!isMovie && !isSeries && !isAnimeType) continue;

    const genres = [];
    if (item.titleGenres?.genres) {
      for (const g of item.titleGenres.genres) {
        if (g.genre?.text) genres.push(g.genre.text);
      }
    }

    const countries = [];
    if (item.countriesOfOrigin?.countries) {
      for (const c of item.countriesOfOrigin.countries) {
        if (c.text) countries.push(c.text);
      }
    }

    const isFromJapan = countries.includes('Japan');
    const isAnime = isAnimeType || (isSeries && genres.includes('Animation') && isFromJapan);

    const rating = item.ratingsSummary?.aggregateRating;
    const year = item.releaseYear?.year;

    metas.push({
      id: item.id,
      type: isMovie ? 'movie' : isAnime ? 'anime' : 'series',
      name: item.titleText?.text || '',
      poster: item.primaryImage?.url || null,
      posterShape: POSTER_SHAPES.PORTRAIT,
      description: item.plot?.plotText?.plainText || '',
      genres,
      imdbRating: rating != null ? String(rating) : null,
      releaseInfo: year != null ? String(year) : undefined,
      year: year || null
    });
  }
  return metas;
}

const RESOLVE_PROFILE_QUERY = `
  query ResolveProfile($input: UserProfileInput!) {
    userProfile(input: $input) {
      userId
      profileId
    }
  }
`;

/**
 * Resolves a p. profile ID to a classic ur user ID via the IMDB GraphQL API.
 *
 * @async
 * @private
 * @param {string} profileId - IMDB profile ID (e.g. "p.rttpfd5fkf7ewsi4xnkhj5cpfa")
 * @returns {Promise<string>} Classic ur user ID (e.g. "ur163769268")
 * @throws {Error} If profile cannot be resolved
 */
async function resolveProfileId(profileId) {
  const cached = profileIdCache.get(profileId);
  if (cached) {
    console.log(`[cache] Returning cached profile resolution ${profileId} -> ${cached}`);
    return cached;
  }
  const json = await queryImdbGraphQL('ResolveProfile', RESOLVE_PROFILE_QUERY, {
    input: { profileId }
  });

  const userId = json.data?.userProfile?.userId;
  if (!userId) {
    throw new Error(`Could not resolve IMDB profile "${profileId}" to a user ID. Please check the profile URL.`);
  }
  console.log(`Resolved IMDB profile ${profileId} -> ${userId}`);
  profileIdCache.set(profileId, userId);
  return userId;
}

/**
 * Fetches a user's public IMDB watchlist.
 *
 * @async
 * @param {string} userId - IMDB user ID (e.g. "ur12345678" or "p.xxxx")
 * @returns {Promise<Array<Object>>} Array of Stremio meta objects
 * @throws {Error} If watchlist not found, private, or API error
 */
async function getWatchlist(userId) {
  // Resolve p. profile IDs to classic ur IDs
  if (userId.startsWith('p.')) {
    userId = await resolveProfileId(userId);
  }

  const cached = watchlistCache.get(userId);
  if (cached) {
    console.log(`[cache] Returning cached IMDB watchlist for ${userId} (${cached.length} items)`);
    return cached;
  }

  console.log(`Fetching IMDB watchlist for user: ${userId}`);

  const json = await queryImdbGraphQL('WatchListPage', WATCHLIST_QUERY, {
    urConst: userId,
    first: 5000
  });

  if (json.errors?.length) {
    if (hasForbiddenError(json.errors)) {
      throw new Error(`IMDB watchlist for "${userId}" is private. Please make it public in your IMDB settings.`);
    }
    throw new Error(`Could not find an IMDB watchlist for "${userId}". Please check your user ID.`);
  }

  const list = json.data?.predefinedList;
  if (!list) {
    throw new Error(`Could not find an IMDB watchlist for "${userId}". Please check your user ID.`);
  }

  if (list.visibility?.id === 'PRIVATE') {
    throw new Error(`IMDB watchlist for "${userId}" is private. Please make it public in your IMDB settings.`);
  }

  const edges = list.titleListItemSearch?.edges || [];
  console.log(`Found ${edges.length} items in IMDB watchlist for ${userId}`);
  const result = transformEdgesToMetas(edges);
  watchlistCache.set(userId, result);
  return result;
}

/**
 * Fetches a public IMDB list by list ID.
 *
 * @async
 * @param {string} listId - IMDB list ID (starts with "ls")
 * @returns {Promise<Array<Object>>} Array of Stremio meta objects
 * @throws {Error} If list not found, private, or API error
 */
async function getList(listId) {
  const cached = watchlistCache.get(listId);
  if (cached) {
    console.log(`[cache] Returning cached IMDB list ${listId} (${cached.length} items)`);
    return cached;
  }

  console.log(`Fetching IMDB list: ${listId}`);

  const json = await queryImdbGraphQL('ListPage', LIST_QUERY, {
    listId,
    first: 5000
  });

  if (json.errors?.length) {
    if (hasForbiddenError(json.errors)) {
      throw new Error(`IMDB list "${listId}" is private. Please ask the owner to make it public.`);
    }
    throw new Error(`Could not find IMDB list "${listId}". Please check the list ID.`);
  }

  const list = json.data?.list;
  if (!list) {
    throw new Error(`Could not find IMDB list "${listId}". Please check the list ID.`);
  }

  if (list.visibility?.id === 'PRIVATE') {
    throw new Error(`IMDB list "${listId}" is private. Please ask the owner to make it public.`);
  }

  const edges = list.titleListItemSearch?.edges || [];
  console.log(`Found ${edges.length} items in IMDB list ${listId}`);
  const result = transformEdgesToMetas(edges);
  watchlistCache.set(listId, result);
  return result;
}

/**
 * Fetches metadata for a single IMDB title (used for meta requests).
 * Since the watchlist already returns full metadata, this is a lightweight
 * fallback that returns basic info from the title ID.
 *
 * @async
 * @param {string} id - IMDB title ID (e.g. "tt1234567")
 * @returns {Promise<Object|null>} Stremio meta object or null
 */
async function getTitleMeta(id) {
  // The IMDB GraphQL API doesn't have a direct single-title query that's
  // publicly usable, so we return null and let Stremio's built-in IMDB
  // metadata handling take over (Stremio natively supports tt* IDs).
  return null;
}

module.exports = {
  getWatchlist,
  getList,
  getTitleMeta
};
