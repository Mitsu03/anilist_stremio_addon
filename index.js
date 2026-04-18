/**
 * Stremio AniList Addon Server
 * 
 * This is the main entry point for the Stremio addon server. It sets up
 * an Express HTTP server that handles Stremio protocol requests and serves
 * the addon manifest, catalogs, and metadata.
 * 
 * @module index
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const addonInterface = require('./addon');
const config = require('./config/env');
const { HTTP_STATUS, ANILIST_OAUTH, MAL_OAUTH } = require('./config/constants');
const tokenManager = require('./config/tokens');

// Initialize Express application
const app = express();

/**
 * CORS Middleware
 * 
 * Enables Cross-Origin Resource Sharing (CORS) to allow Stremio clients
 * from any origin to access the addon. This is required for Stremio to
 * communicate with the addon server.
 */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

/**
 * Request Logging Middleware
 * 
 * Logs all incoming requests for debugging and monitoring purposes.
 * Only active in development mode to reduce noise in production.
 */
if (config.isDevelopment) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

/**
 * Validates a username from the URL path.
 * Allows alphanumeric characters, underscores, and hyphens (2-20 chars).
 */
function isValidUsername(username) {
  return /^[a-zA-Z0-9_-]{2,20}$/.test(username);
}

const VALID_SERVICES = new Set(['anilist', 'mal']);

/**
 * GET /auth/:service/:username
 *
 * Initiates OAuth authentication flow for a user
 */
app.get('/auth/:service/:username', (req, res) => {
  const { service, username } = req.params;
  const { client_id, client_secret } = req.query;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Unknown service. Use "anilist" or "mal".' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }

  // Store user credentials if provided, and use them directly without
  // re-reading from file (guards against filesystem write failures on the server)
  let credentials;
  if (client_id && client_secret) {
    tokenManager.storeCredentials(service, username, { client_id, client_secret });
    credentials = { client_id, client_secret };
  } else {
    credentials = tokenManager.getCredentials(service, username);
  }

  if (!credentials) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ 
      error: 'OAuth credentials not provided. Please provide client_id and client_secret as query parameters.' 
    });
  }

  const host = req.headers.host || `localhost:${config.port}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${protocol}://${host}`;
  const redirectUri = `${baseUrl}/auth/${service}/${username}/callback`;

  let authUrl;

  if (service === 'anilist') {
    const state = `${service}:${username}:${Date.now()}`;
    authUrl = `${ANILIST_OAUTH.AUTH_URL}?client_id=${credentials.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;
  } else if (service === 'mal') {
    // MAL requires PKCE — generate a code_verifier and derive the code_challenge.
    // MAL only supports the 'plain' challenge method (code_challenge = code_verifier).
    // The verifier and credentials are embedded in the state parameter so the callback
    // works even when the server filesystem is read-only.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    // State format: mal:username:timestamp:codeVerifier:clientId:clientSecret
    const state = `${service}:${username}:${Date.now()}:${codeVerifier}:${credentials.client_id}:${credentials.client_secret}`;
    authUrl = `${MAL_OAUTH.AUTH_URL}?response_type=code&client_id=${credentials.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&code_challenge=${codeVerifier}&code_challenge_method=plain`;
  }

  res.redirect(authUrl);
});

/**
 * GET /auth/:service/:username/callback
 *
 * OAuth callback handler - exchanges authorization code for access token
 */
app.get('/auth/:service/:username/callback', async (req, res) => {
  const { service, username } = req.params;
  const { code, state, error } = req.query;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).send('Unknown service');
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).send('Invalid username');
  }

  if (error) {
    return res.status(HTTP_STATUS.BAD_REQUEST).send(`Authentication failed: ${error}`);
  }

  if (!code) {
    return res.status(HTTP_STATUS.BAD_REQUEST).send('No authorization code received');
  }

  try {
    const host = req.headers.host || `localhost:${config.port}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${host}`;
    const redirectUri = `${baseUrl}/auth/${service}/${username}/callback`;

    // Get stored credentials — only strictly required for AniList;
    // MAL carries credentials in the state parameter.
    const credentials = tokenManager.getCredentials(service, username);
    if (!credentials && service === 'anilist') {
      return res.status(HTTP_STATUS.BAD_REQUEST).send('OAuth credentials not found');
    }

    let tokenResponse;
    const tokenData = {
      client_id: credentials?.client_id,
      client_secret: credentials?.client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    };

    if (service === 'anilist') {
      tokenResponse = await axios.post(ANILIST_OAUTH.TOKEN_URL, tokenData, {
        headers: { 'Content-Type': 'application/json' }
      });
    } else if (service === 'mal') {
      // Extract the code_verifier and credentials embedded in the state parameter.
      // State format: mal:username:timestamp:codeVerifier:clientId:clientSecret
      const stateParts = state ? decodeURIComponent(state).split(':') : [];
      const codeVerifier = stateParts.length >= 4 ? stateParts[3] : null;
      const stateClientId = stateParts.length >= 5 ? stateParts[4] : null;
      const stateClientSecret = stateParts.length >= 6 ? stateParts[5] : null;
      if (!codeVerifier) {
        return res.status(HTTP_STATUS.BAD_REQUEST).send('PKCE verifier not found in state. Please restart the authentication flow.');
      }
      // Use credentials from state (reliable) with fallback to stored credentials
      const effectiveClientId = stateClientId || credentials?.client_id;
      const effectiveClientSecret = stateClientSecret || credentials?.client_secret;
      if (!effectiveClientId || !effectiveClientSecret) {
        return res.status(HTTP_STATUS.BAD_REQUEST).send('OAuth credentials not found. Please restart the authentication flow.');
      }
      tokenResponse = await axios.post(MAL_OAUTH.TOKEN_URL, new URLSearchParams({
        client_id: effectiveClientId,
        client_secret: effectiveClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }

    tokenManager.storeTokens(service, username, tokenResponse.data);

    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>&#x2705; Authentication Successful!</h1>
          <p>You can now use progress updates for ${service === 'anilist' ? 'AniList' : 'MyAnimeList'}.</p>
          <p>You can close this tab and return to the configuration page.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'auth_success', service: '${service}', username: '${username}' }, '*');
            }
          <\/script>
        </body>
      </html>
    `);

  } catch (error) {
    const detail = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error('OAuth callback error:', detail);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(`Authentication failed: ${detail}`);
  }
});

/**
 * GET /
 *
 * Configure page — lets users pick AniList or MAL, enter their username,
 * and get a personalised install URL for Stremio.
 */
app.get('/', (req, res) => {
  const host = req.headers.host || `localhost:${config.port}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${protocol}://${host}`;
  const malConfigured = !!config.malClientId;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Anime Stremio Addon</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 500px;
      width: 100%;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.4rem; color: #fff; }
    .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 1.8rem; }
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.8rem; }
    .tab {
      flex: 1;
      padding: 0.55rem 0;
      text-align: center;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 500;
      border: 1px solid #2a2a2a;
      background: #111;
      color: #888;
      transition: all 0.15s;
      user-select: none;
    }
    .tab:hover { color: #ccc; border-color: #444; }
    .tab.active { background: #5b6af5; color: #fff; border-color: #5b6af5; }
    .tab.disabled { opacity: 0.4; cursor: not-allowed; }
    .panel { display: none; }
    .panel.active { display: block; }
    .warning {
      background: #2a1f00;
      border: 1px solid #554400;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.82rem;
      color: #ffcc55;
      margin-bottom: 1.2rem;
      line-height: 1.5;
    }
    .warning a { color: #ffd97a; }
    label { display: block; font-size: 0.85rem; color: #aaa; margin-bottom: 0.4rem; }
    input {
      width: 100%;
      padding: 0.65rem 0.9rem;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #5b6af5; }
    input.error { border-color: #e05555; }
    .hint { font-size: 0.78rem; color: #666; margin-top: 0.35rem; min-height: 1.1em; }
    .hint.err { color: #e05555; }
    .result { margin-top: 1.5rem; display: none; }
    .result.visible { display: block; }
    .url-box {
      background: #111;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 0.7rem 0.9rem;
      font-family: monospace;
      font-size: 0.82rem;
      color: #a0c4ff;
      word-break: break-all;
      margin-bottom: 0.8rem;
    }
    .actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    button, .stremio-btn {
      padding: 0.55rem 1.1rem;
      border-radius: 7px;
      font-size: 0.88rem;
      cursor: pointer;
      border: none;
      font-weight: 500;
      text-decoration: none;
      display: inline-block;
      transition: opacity 0.15s;
    }
    button:hover, .stremio-btn:hover { opacity: 0.85; }
    .copy-btn { background: #2a2a2a; color: #e0e0e0; }
    .stremio-btn { background: #5b6af5; color: #fff; }
    .auth-btn {
      background: #4caf7d;
      color: #fff;
      padding: 0.6rem 1.2rem;
      border-radius: 7px;
      font-size: 0.88rem;
      cursor: pointer;
      border: none;
      font-weight: 500;
      transition: opacity 0.15s;
    }
    .auth-btn:hover { opacity: 0.85; }
    .auth-status { color: #4caf7d; }
    .auth-status.error { color: #e05555; }
    .copied { color: #4caf7d; font-size: 0.82rem; margin-top: 0.4rem; min-height: 1.1em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Anime Stremio Addon</h1>
    <p class="subtitle">Sync your anime tracking list to Stremio.</p>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('anilist')">AniList</div>
      <div class="tab${malConfigured ? '' : ' disabled'}" id="mal-tab" onclick="switchTab('mal')">MyAnimeList</div>
    </div>

    <!-- AniList panel -->
    <div class="panel active" id="panel-anilist">
      <label for="al-username">Your AniList username</label>
      <input type="text" id="al-username" placeholder="e.g. MyUsername"
             autocomplete="off" spellcheck="false" maxlength="20">
      <p class="hint" id="al-hint">Letters, numbers, hyphens and underscores (2&ndash;20 chars).</p>

      <div class="credentials-section">
        <label style="margin-top:1.5rem; display:block;">OAuth Credentials (for progress updates)</label>
        <p style="font-size:0.9rem; color:#888; margin-bottom:0.5rem;">
          Get these from <a href="https://anilist.co/settings/developer" target="_blank" rel="noopener">AniList Developer Settings</a>
        </p>
        <input type="text" id="al-client-id" placeholder="Client ID"
               autocomplete="off" spellcheck="false">
        <input type="password" id="al-client-secret" placeholder="Client Secret"
               autocomplete="off" spellcheck="false" style="margin-top:0.5rem;">
      </div>

      <div class="result" id="al-result">
        <label style="margin-top:1rem">Your install URL</label>
        <div class="url-box" id="al-url"></div>
        <div class="actions">
          <button class="copy-btn" onclick="copyUrl('al-url')">Copy URL</button>
          <a class="stremio-btn" id="al-stremio" href="#">Open in Stremio</a>
        </div>
        <p class="copied" id="al-copied"></p>
      </div>
      <div class="auth-section">
        <label style="margin-top:1.5rem; display:block;">Progress Updates (Optional)</label>
        <p style="font-size:0.9rem; color:#888; margin-bottom:0.5rem;">
          Authenticate to enable automatic progress syncing when you watch episodes.
        </p>
        <button class="auth-btn" id="al-auth-btn" onclick="authenticate('anilist')">
          🔐 Authenticate with AniList
        </button>
        <div class="auth-status" id="al-auth-status" style="font-size:0.9rem; margin-top:0.5rem;"></div>
      </div>
    </div>

    <!-- MAL panel -->
    <div class="panel" id="panel-mal">
      ${malConfigured ? '' : `<div class="warning">
        MAL support is not enabled on this server. Add <code>MAL_CLIENT_ID</code> to the
        <code>.env</code> file. Register an app at
        <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a>
        to get a Client ID.
      </div>`}
      <label for="mal-username">Your MyAnimeList username</label>
      <input type="text" id="mal-username" placeholder="e.g. MyUsername"
             autocomplete="off" spellcheck="false" maxlength="20"
             ${malConfigured ? '' : 'disabled'}>
      <p class="hint" id="mal-hint">Letters, numbers, hyphens and underscores (2&ndash;20 chars).</p>

      <div class="credentials-section">
        <label style="margin-top:1.5rem; display:block;">OAuth Credentials (for progress updates)</label>
        <p style="font-size:0.9rem; color:#888; margin-bottom:0.5rem;">
          Get these from <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">MAL API Config</a>
        </p>
        <input type="text" id="mal-client-id" placeholder="Client ID"
               autocomplete="off" spellcheck="false" ${malConfigured ? '' : 'disabled'}>
        <input type="password" id="mal-client-secret" placeholder="Client Secret"
               autocomplete="off" spellcheck="false" style="margin-top:0.5rem;" ${malConfigured ? '' : 'disabled'}>
      </div>

      <div class="result" id="mal-result">
        <label style="margin-top:1rem">Your install URL</label>
        <div class="url-box" id="mal-url"></div>
        <div class="actions">
          <button class="copy-btn" onclick="copyUrl('mal-url')">Copy URL</button>
          <a class="stremio-btn" id="mal-stremio" href="#">Open in Stremio</a>
        </div>
        <p class="copied" id="mal-copied"></p>
      </div>
      <div class="auth-section">
        <label style="margin-top:1.5rem; display:block;">Progress Updates (Optional)</label>
        <p style="font-size:0.9rem; color:#888; margin-bottom:0.5rem;">
          Authenticate to enable automatic progress syncing when you watch episodes.
        </p>
        <button class="auth-btn" id="mal-auth-btn" onclick="authenticate('mal')" style="display:none;">
          🔐 Authenticate with MyAnimeList
        </button>
        <div class="auth-status" id="mal-auth-status" style="font-size:0.9rem; margin-top:0.5rem;"></div>
      </div>
    </div>
  </div>

  <script>
    const BASE = '${baseUrl}';
    const MAL_CONFIGURED = ${malConfigured};
    const VALID = /^[a-zA-Z0-9_-]{2,20}$/;

    function switchTab(service) {
      if (service === 'mal' && !MAL_CONFIGURED) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      const tabEl = service === 'anilist'
        ? document.querySelector('.tab:first-child')
        : document.getElementById('mal-tab');
      tabEl.classList.add('active');
      document.getElementById('panel-' + service).classList.add('active');
    }

    function setupInput(inputId, hintId, resultId, urlId, stremioId, service) {
      const input = document.getElementById(inputId);
      if (!input || input.disabled) return;
      input.addEventListener('input', () => {
        const val = input.value.trim();
        document.getElementById(inputId.replace('username', 'copied') + '-copied') && 
          (document.getElementById(inputId.replace('username', 'copied') + '-copied').textContent = '');
        const hint = document.getElementById(hintId);
        const result = document.getElementById(resultId);
        if (!val) {
          input.classList.remove('error');
          hint.textContent = 'Letters, numbers, hyphens and underscores (2\\u201320 chars).';
          hint.classList.remove('err');
          result.classList.remove('visible');
          return;
        }
        if (!VALID.test(val)) {
          input.classList.add('error');
          hint.textContent = 'Invalid username \\u2014 only letters, numbers, hyphens and underscores allowed.';
          hint.classList.add('err');
          result.classList.remove('visible');
          return;
        }
        input.classList.remove('error');
        hint.textContent = '';
        hint.classList.remove('err');
        const manifestUrl = BASE + '/' + service + '/' + encodeURIComponent(val) + '/manifest.json';
        document.getElementById(urlId).textContent = manifestUrl;
        document.getElementById(stremioId).href = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '');
        result.classList.add('visible');
        checkAuthStatus(service, val);
      });
    }

    function getServicePrefix(service) {
      return service === 'anilist' ? 'al' : service;
    }

    async function checkAuthStatus(service, username) {
      if (!username) return;

      const prefix = getServicePrefix(service);
      const authBtn = document.getElementById(prefix + '-auth-btn');
      const authStatus = document.getElementById(prefix + '-auth-status');
      const clientId = document.getElementById(prefix + '-client-id').value.trim();
      const clientSecret = document.getElementById(prefix + '-client-secret').value.trim();

      // Show auth button if credentials are provided
      if (clientId && clientSecret) {
        authBtn.style.display = 'inline-block';
      } else {
        authBtn.style.display = 'none';
        authStatus.textContent = 'Enter your OAuth credentials above to enable progress updates';
        authStatus.classList.remove('error');
        return;
      }

      try {
        const response = await fetch(BASE + '/auth/' + service + '/' + username + '/status');
        const data = await response.json();

        if (data.authenticated) {
          authBtn.style.display = 'none';
          authStatus.textContent = '✅ Authenticated - Progress updates enabled';
          authStatus.classList.remove('error');
        } else {
          authBtn.style.display = 'inline-block';
          authStatus.textContent = '❌ Not authenticated - Click authenticate to enable progress updates';
          authStatus.classList.add('error');
        }
      } catch (error) {
        authBtn.style.display = 'inline-block';
        authStatus.textContent = '❌ Unable to check authentication status';
        authStatus.classList.add('error');
      }
    }

    function authenticate(service) {
      const prefix = getServicePrefix(service);
      const username = document.getElementById(prefix + '-username').value.trim();
      const clientId = document.getElementById(prefix + '-client-id').value.trim();
      const clientSecret = document.getElementById(prefix + '-client-secret').value.trim();

      if (!username) {
        alert('Please enter your username first');
        return;
      }

      if (!clientId || !clientSecret) {
        alert('Please enter your OAuth Client ID and Client Secret');
        return;
      }

      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret
      });

      const authUrl = BASE + '/auth/' + service + '/' + username + '?' + params.toString();
      window.open(authUrl, '_blank');

      const authStatus = document.getElementById(prefix + '-auth-status');
      authStatus.textContent = '⏳ Waiting for authentication...';
      authStatus.classList.remove('error');

      // Listen for postMessage from the auth success page in the new tab
      function onAuthMessage(event) {
        if (event.data && event.data.type === 'auth_success' && event.data.service === service) {
          window.removeEventListener('message', onAuthMessage);
          checkAuthStatus(service, username);
        }
      }
      window.addEventListener('message', onAuthMessage);
    }

    // Add listeners for credential inputs
    function setupCredentialInputs(service) {
      const prefix = getServicePrefix(service);
      const clientIdInput = document.getElementById(prefix + '-client-id');
      const clientSecretInput = document.getElementById(prefix + '-client-secret');

      if (clientIdInput) {
        clientIdInput.addEventListener('input', () => {
          const username = document.getElementById(prefix + '-username').value.trim();
          if (username) checkAuthStatus(service, username);
        });
      }

      if (clientSecretInput) {
        clientSecretInput.addEventListener('input', () => {
          const username = document.getElementById(prefix + '-username').value.trim();
          if (username) checkAuthStatus(service, username);
        });
      }
    }

    // Load stored credentials into form fields
    async function loadStoredCredentials() {
      try {
        const alUsername = localStorage.getItem('al-username');
        const malUsername = localStorage.getItem('mal-username');

        if (alUsername) {
          const anilistResponse = await fetch(BASE + '/auth/anilist/' + encodeURIComponent(alUsername) + '/credentials');
          if (anilistResponse.ok) {
            const anilistCreds = await anilistResponse.json();
            if (anilistCreds.client_id) document.getElementById('al-client-id').value = anilistCreds.client_id;
            if (anilistCreds.client_secret) document.getElementById('al-client-secret').value = anilistCreds.client_secret;
          }
        }

        if (malUsername) {
          const malResponse = await fetch(BASE + '/auth/mal/' + encodeURIComponent(malUsername) + '/credentials');
          if (malResponse.ok) {
            const malCreds = await malResponse.json();
            if (malCreds.client_id) document.getElementById('mal-client-id').value = malCreds.client_id;
            if (malCreds.client_secret) document.getElementById('mal-client-secret').value = malCreds.client_secret;
          }
        }
      } catch (error) {
        console.error('Error loading stored credentials:', error);
      }
    }

    setupInput('al-username',  'al-hint',  'al-result',  'al-url',  'al-stremio',  'anilist');
    setupInput('mal-username', 'mal-hint', 'mal-result', 'mal-url', 'mal-stremio', 'mal');
    setupCredentialInputs('anilist');
    setupCredentialInputs('mal');

    // Persist usernames in localStorage so they survive page navigation
    ['al-username', 'mal-username'].forEach(id => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', () => {
        localStorage.setItem(id, input.value.trim());
      });
    });

    // Restore usernames from localStorage and trigger the input handler
    // so the manifest URL and auth status are populated automatically
    function restoreUsernames() {
      ['al-username', 'mal-username'].forEach(id => {
        const saved = localStorage.getItem(id);
        if (!saved) return;
        const input = document.getElementById(id);
        if (!input) return;
        input.value = saved;
        input.dispatchEvent(new Event('input'));
      });
    }

    // Load stored credentials when page loads, then restore usernames so that
    // checkAuthStatus fires after credentials are already populated in the fields
    loadStoredCredentials().then(restoreUsernames);

    function copyUrl(urlId) {
      const url = document.getElementById(urlId).textContent;
      if (!url) return;
      const copiedId = urlId.replace('-url', '-copied');
      navigator.clipboard.writeText(url).then(() => {
        const el = document.getElementById(copiedId);
        if (el) { el.textContent = 'Copied!'; setTimeout(() => { el.textContent = ''; }, 2000); }
      });
    }
  </script>
</body>
</html>`);
});

/**
 * GET /auth/:service/:username/status
 *
 * Check authentication status for a user
 */
app.get('/auth/:service/:username/status', (req, res) => {
  const { service, username } = req.params;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Unknown service' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }

  const authenticated = tokenManager.hasValidTokens(service, username);
  res.json({ authenticated });
});

/**
 * GET /auth/:service/:username/credentials
 *
 * Get stored OAuth credentials for a user
 */
app.get('/auth/:service/:username/credentials', (req, res) => {
  const { service, username } = req.params;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Unknown service' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }

  const credentials = tokenManager.getCredentials(service, username);
  if (credentials) {
    res.json(credentials);
  } else {
    res.json({ client_id: '', client_secret: '' });
  }
});

/**
 * GET /:service/:username/manifest.json
 */
app.get('/:service/:username/manifest.json', (req, res) => {
  const { service, username } = req.params;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service. Use "anilist" or "mal".' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }
  if (service === 'mal' && !config.malClientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL service is not configured on this server (missing MAL_CLIENT_ID).' });
  }

  try {
    res.json(addonInterface.getManifest(service));
  } catch (error) {
    console.error('Error serving manifest:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to load manifest' });
  }
});

/**
 * GET /:service/:username/catalog/:type/:id/:extra?.json
 */
app.get('/:service/:username/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { service, username, type, id, extra } = req.params;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service. Use "anilist" or "mal".' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }
  if (service === 'mal' && !config.malClientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL service is not configured on this server (missing MAL_CLIENT_ID).' });
  }

  try {
    const catalog = await addonInterface.getCatalog(type, id, extra, username, service, config.malClientId);
    res.json(catalog);
  } catch (error) {
    console.error('Catalog error:', error.message);
    const statusCode = error.message.includes('not found')
      ? HTTP_STATUS.NOT_FOUND
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    res.status(statusCode).json({ error: error.message || 'Failed to fetch catalog' });
  }
});

/**
 * GET /:service/:username/meta/:type/:id.json
 */
app.get('/:service/:username/meta/:type/:id.json', async (req, res) => {
  const { service, username, type, id } = req.params;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service. Use "anilist" or "mal".' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }
  if (service === 'mal' && !config.malClientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL service is not configured on this server (missing MAL_CLIENT_ID).' });
  }

  try {
    const meta = await addonInterface.getMeta(type, id, username, service, config.malClientId);
    res.json(meta);
  } catch (error) {
    console.error('Meta error:', error.message);
    const statusCode = error.message.includes('not found')
      ? HTTP_STATUS.NOT_FOUND
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    res.status(statusCode).json({ error: error.message || 'Failed to fetch metadata' });
  }
});

/**
 * GET /:service/:username/stream/:type/:id.json
 */
app.get('/:service/:username/stream/:type/:id.json', async (req, res) => {
  const { service, username, type, id } = req.params;
  const { season, episode } = req.query;

  if (!VALID_SERVICES.has(service)) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service. Use "anilist" or "mal".' });
  }
  if (!isValidUsername(username)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid username' });
  }
  if (service === 'mal' && !config.malClientId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL service is not configured on this server (missing MAL_CLIENT_ID).' });
  }

  try {
    const videoInfo = {};
    if (season) videoInfo.season = parseInt(season, 10);
    if (episode) videoInfo.episode = parseInt(episode, 10);

    // If no episode in query params, try to extract from ID.
    // Stremio series format: service:id:season:episode (4 parts)
    // Legacy format:         service:id:episode       (3 parts)
    if (!episode && id.includes(':')) {
      const parts = id.split(':');
      if (parts.length >= 4) {
        const potentialSeason = parseInt(parts[2], 10);
        const potentialEpisode = parseInt(parts[3], 10);
        if (!isNaN(potentialSeason) && potentialSeason > 0) {
          videoInfo.season = potentialSeason;
        }
        if (!isNaN(potentialEpisode) && potentialEpisode > 0) {
          videoInfo.episode = potentialEpisode;
          console.log(`Extracted season ${potentialSeason}, episode ${potentialEpisode} from ID: ${id}`);
        }
      } else if (parts.length === 3) {
        const potentialEpisode = parseInt(parts[2], 10);
        if (!isNaN(potentialEpisode) && potentialEpisode > 0) {
          videoInfo.episode = potentialEpisode;
          console.log(`Extracted episode ${potentialEpisode} from ID: ${id}`);
        }
      }
    }

    if (!videoInfo.episode) {
      console.log(`No episode info found for stream request: ${id}`);
    }

    const stream = await addonInterface.getStream(type, id, videoInfo, username, service, config.malClientId);
    res.json(stream);
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to process stream request' });
  }
});

/**
 * 404 Handler
 * 
 * Catches all unmatched routes and returns a 404 error.
 */
app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({ 
    error: 'Endpoint not found',
    path: req.url
  });
});

/**
 * Global Error Handler
 * 
 * Catches any unhandled errors in the application and returns
 * a generic error response to prevent server crashes.
 */
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ 
    error: 'Internal server error' 
  });
});

/**
 * Start the Express server
 * 
 * Binds the server to the configured port and begins listening for requests.
 * Displays helpful information about how to install the addon in Stremio.
 */
app.listen(config.port, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Anime Stremio Addon Server Started');
  console.log('='.repeat(60));
  console.log(`📡 Server listening on port ${config.port}`);
  console.log(`🌍 Environment: ${config.nodeEnv}`);
  console.log(`✅ AniList service: enabled`);
  console.log(`${config.malClientId ? '✅' : '⚠️ '} MAL service: ${config.malClientId ? 'enabled' : 'disabled (set MAL_CLIENT_ID in .env)'}`);
  console.log('\n📦 Configure page:');
  console.log(`   http://localhost:${config.port}/`);
  console.log('\n📜 Per-user install URL format:');
  console.log(`   http://localhost:${config.port}/anilist/<username>/manifest.json`);
  console.log(`   http://localhost:${config.port}/mal/<username>/manifest.json`);
  console.log('='.repeat(60) + '\n');
});

/**
 * Graceful Shutdown Handler
 * 
 * Handles SIGINT (Ctrl+C) and SIGTERM signals to gracefully shut down
 * the server, allowing ongoing requests to complete.
 */
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  process.exit(0);
});

// Made with Bob
