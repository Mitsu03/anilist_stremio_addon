/**
 * Token Storage and Management
 *
 * This module handles secure storage and retrieval of OAuth tokens
 * for user authentication with AniList and MyAnimeList.
 *
 * @module config/tokens
 */

const fs = require('fs');
const path = require('path');

/**
 * Path to the tokens storage file
 * @constant {string}
 */
const TOKENS_FILE = path.join(__dirname, '..', 'data', 'tokens.json');

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
  const dataDir = path.dirname(TOKENS_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Load tokens from storage file
 *
 * @returns {Object} Token storage object
 */
function loadTokens() {
  try {
    ensureDataDir();
    if (fs.existsSync(TOKENS_FILE)) {
      const data = fs.readFileSync(TOKENS_FILE, 'utf8').trim();
      if (!data) return {};
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading tokens:', error.message);
    // Overwrite the corrupted file so subsequent reads succeed
    try { fs.writeFileSync(TOKENS_FILE, '{}'); } catch (_) {}
  }
  return {};
}

/**
 * Save tokens to storage file
 *
 * @param {Object} tokens - Token storage object
 */
function saveTokens(tokens) {
  try {
    ensureDataDir();
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (error) {
    console.error('Error saving tokens:', error.message);
  }
}

/**
 * Generate a unique user key for token storage
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @returns {string} Unique key for the user
 */
function getUserKey(service, username) {
  return `${service}:${username.toLowerCase()}`;
}

/**
 * Store OAuth tokens for a user
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @param {Object} tokenData - Token data from OAuth flow
 * @param {string} tokenData.access_token - Access token
 * @param {string} tokenData.refresh_token - Refresh token (optional)
 * @param {number} tokenData.expires_in - Token expiry time in seconds
 */
function storeTokens(service, username, tokenData) {
  const tokens = loadTokens();
  const userKey = getUserKey(service, username);

  tokens[userKey] = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in * 1000),
    updated_at: Date.now()
  };

  saveTokens(tokens);
  console.log(`Stored tokens for ${service} user: ${username}`);
}

/**
 * Store OAuth credentials for a user
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @param {Object} credentials - OAuth credentials
 * @param {string} credentials.client_id - OAuth client ID
 * @param {string} credentials.client_secret - OAuth client secret
 */
function storeCredentials(service, username, credentials) {
  const tokens = loadTokens();
  const userKey = getUserKey(service, username);

  if (!tokens[userKey]) {
    tokens[userKey] = {};
  }

  tokens[userKey].credentials = {
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    updated_at: Date.now()
  };

  saveTokens(tokens);
  console.log(`Stored credentials for ${service} user: ${username}`);
}

/**
 * Retrieve OAuth credentials for a user
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @returns {Object|null} Credentials data or null if not found
 */
function getCredentials(service, username) {
  const tokens = loadTokens();
  const userKey = getUserKey(service, username);
  const userData = tokens[userKey];

  return userData?.credentials || null;
}

/**
 * Retrieve OAuth tokens for a user
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @returns {Object|null} Token data or null if not found/expired
 */
function getTokens(service, username) {
  const tokens = loadTokens();
  const userKey = getUserKey(service, username);
  const userTokens = tokens[userKey];

  if (!userTokens || !userTokens.access_token || !userTokens.expires_at) {
    return null;
  }

  // Check if token is expired — only clear the token fields, keep credentials
  if (Date.now() >= userTokens.expires_at) {
    console.log(`Tokens expired for ${service} user: ${username}`);
    delete tokens[userKey].access_token;
    delete tokens[userKey].refresh_token;
    delete tokens[userKey].expires_at;
    saveTokens(tokens);
    return null;
  }

  return userTokens;
}

/**
 * Remove tokens for a user
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 */
function removeTokens(service, username) {
  const tokens = loadTokens();
  const userKey = getUserKey(service, username);

  if (tokens[userKey]) {
    delete tokens[userKey];
    saveTokens(tokens);
    console.log(`Removed tokens for ${service} user: ${username}`);
  }
}

/**
 * Check if a user has valid tokens
 *
 * @param {string} service - 'anilist' or 'mal'
 * @param {string} username - User's username
 * @returns {boolean} True if user has valid tokens
 */
function hasValidTokens(service, username) {
  return getTokens(service, username) !== null;
}

module.exports = {
  storeTokens,
  getTokens,
  removeTokens,
  hasValidTokens,
  getUserKey,
  storeCredentials,
  getCredentials,
  storePkceVerifier,
  getPkceVerifier
};

/**
 * Persist a PKCE code_verifier for a MAL OAuth flow
 *
 * @param {string} username - User's MAL username
 * @param {string} verifier - PKCE code_verifier string
 */
function storePkceVerifier(username, verifier) {
  const tokens = loadTokens();
  const userKey = getUserKey('mal', username);
  if (!tokens[userKey]) tokens[userKey] = {};
  tokens[userKey].pkce_verifier = verifier;
  saveTokens(tokens);
}

/**
 * Retrieve and delete a stored PKCE code_verifier
 *
 * @param {string} username - User's MAL username
 * @returns {string|null} The verifier, or null if not found
 */
function getPkceVerifier(username) {
  const tokens = loadTokens();
  const userKey = getUserKey('mal', username);
  const verifier = tokens[userKey]?.pkce_verifier || null;
  if (verifier) {
    delete tokens[userKey].pkce_verifier;
    saveTokens(tokens);
  }
  return verifier;
}