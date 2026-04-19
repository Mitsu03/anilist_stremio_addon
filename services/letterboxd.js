/**
 * Letterboxd API Service
 *
 * Handles Letterboxd token exchange/refresh and fetching a member's
 * watchlist/watched films for Stremio catalogs.
 *
 * @module services/letterboxd
 */

const axios = require('axios');
const tokenManager = require('../config/tokens');
const {
	LETTERBOXD_API_URL,
	LETTERBOXD_TOKEN_URL,
	LETTERBOXD_USER_AGENT,
	POSTER_SHAPES
} = require('../config/constants');

const APP_TOKEN_CACHE = {
	accessToken: null,
	expiresAt: 0
};

function getApiHeaders(accessToken) {
	return {
		'Accept': 'application/json',
		'User-Agent': LETTERBOXD_USER_AGENT,
		'Authorization': `Bearer ${accessToken}`
	};
}

function pickPosterUrl(image) {
	if (!image || !Array.isArray(image.sizes) || image.sizes.length === 0) return null;
	const sorted = [...image.sizes].sort((a, b) => (b.width || 0) - (a.width || 0));
	return sorted[0]?.url || null;
}

function getImdbIdFromLinks(links) {
	if (!Array.isArray(links)) return null;
	const imdbLink = links.find(link => link?.type === 'imdb' && link?.id);
	if (!imdbLink) return null;
	const id = String(imdbLink.id).trim();
	return /^tt\d+$/.test(id) ? id : null;
}

function filmToMeta(film, watched) {
	const imdbId = getImdbIdFromLinks(film.links);
	return {
		id: imdbId || `letterboxd:${film.id}`,
		type: 'movie',
		name: film.name || 'Untitled',
		poster: pickPosterUrl(film.poster),
		posterShape: POSTER_SHAPES.PORTRAIT,
		background: pickPosterUrl(film.backdrop),
		description: film.description || '',
		genres: Array.isArray(film.genres) ? film.genres.map(g => g.name).filter(Boolean) : [],
		imdbRating: typeof film.rating === 'number' ? (film.rating * 2).toFixed(1) : null,
		releaseInfo: film.releaseYear ? String(film.releaseYear) : undefined,
		year: film.releaseYear || null,
		watched
	};
}

async function requestToken(formParams) {
	const params = new URLSearchParams(formParams);
	const { data } = await axios.post(LETTERBOXD_TOKEN_URL, params, {
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json',
			'User-Agent': LETTERBOXD_USER_AGENT
		},
		timeout: 10000
	});
	return data;
}

async function getClientAccessToken(clientId, clientSecret, grantType = 'client_credentials') {
	if (APP_TOKEN_CACHE.accessToken && Date.now() < APP_TOKEN_CACHE.expiresAt - 10000) {
		return APP_TOKEN_CACHE.accessToken;
	}

	const data = await requestToken({
		grant_type: grantType,
		client_id: clientId,
		client_secret: clientSecret
	});

	if (!data?.access_token) {
		throw new Error('Letterboxd app token response did not include access_token.');
	}

	APP_TOKEN_CACHE.accessToken = data.access_token;
	APP_TOKEN_CACHE.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
	return APP_TOKEN_CACHE.accessToken;
}

async function authenticateUser(username, password, clientId, clientSecret) {
	const data = await requestToken({
		grant_type: 'password',
		username,
		password,
		client_id: clientId,
		client_secret: clientSecret
	});

	if (!data?.access_token) {
		throw new Error('Letterboxd login failed: no access token returned.');
	}

	tokenManager.storeTokens('letterboxd', username, {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in || 3600
	});

	return data;
}

async function refreshUserToken(username, clientId, clientSecret, refreshToken) {
	const data = await requestToken({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: clientId,
		client_secret: clientSecret
	});

	if (!data?.access_token) {
		throw new Error('Letterboxd refresh failed: no access token returned.');
	}

	tokenManager.storeTokens('letterboxd', username, {
		access_token: data.access_token,
		refresh_token: data.refresh_token || refreshToken,
		expires_in: data.expires_in || 3600
	});

	return data.access_token;
}

async function getStoredUserAccessToken(username, clientId, clientSecret) {
	const tokens = tokenManager.getTokens('letterboxd', username);
	if (tokens?.access_token) return tokens.access_token;

	const record = tokenManager.getTokenRecord('letterboxd', username);
	const refreshToken = record?.refresh_token;

	if (!refreshToken) {
		throw new Error('Letterboxd user token missing or expired. Please login again.');
	}

	return refreshUserToken(username, clientId, clientSecret, refreshToken);
}

async function getMe(accessToken) {
	const response = await axios.get(`${LETTERBOXD_API_URL}/me`, {
		headers: getApiHeaders(accessToken),
		timeout: 10000
	});
	return response.data?.member || null;
}

async function fetchMemberWatchlist(memberId, accessToken) {
	const response = await axios.get(`${LETTERBOXD_API_URL}/member/${encodeURIComponent(memberId)}/watchlist`, {
		params: {
			perPage: 100,
			sort: 'Added'
		},
		headers: getApiHeaders(accessToken),
		timeout: 15000
	});
	return Array.isArray(response.data?.items) ? response.data.items : [];
}

async function fetchMemberWatched(memberId, accessToken) {
	const response = await axios.get(`${LETTERBOXD_API_URL}/films`, {
		params: {
			member: memberId,
			memberRelationship: 'Watched',
			perPage: 100,
			sort: 'DateLatestFirst'
		},
		headers: getApiHeaders(accessToken),
		timeout: 15000
	});
	return Array.isArray(response.data?.items) ? response.data.items : [];
}

async function getCatalog(username, status, clientId, clientSecret) {
	try {
		const token = await getStoredUserAccessToken(username, clientId, clientSecret);
		const me = await getMe(token);
		if (!me?.id) throw new Error('Could not determine authenticated Letterboxd member.');

		const items = status === 'Watched'
			? await fetchMemberWatched(me.id, token)
			: await fetchMemberWatchlist(me.id, token);

		const watched = status === 'Watched';
		return items.map(film => filmToMeta(film, watched));
	} catch (error) {
		if (error.response?.status === 401) {
			throw new Error('Letterboxd auth expired. Please login again.');
		}
		if (error.response?.status === 403) {
			throw new Error('Letterboxd profile/list is private or inaccessible.');
		}
		const msg = error.response?.data?.message || error.message;
		throw new Error(`Letterboxd API error: ${msg}`);
	}
}

module.exports = {
	getClientAccessToken,
	authenticateUser,
	refreshUserToken,
	getStoredUserAccessToken,
	getMe,
	getCatalog
};
