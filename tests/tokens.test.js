'use strict';

jest.mock('fs');

const fs = require('fs');

// Set up default fs mock before loading tokens module
const store = {};
fs.existsSync.mockImplementation(() => Object.keys(store).length > 0 || false);
fs.readFileSync.mockImplementation(() => JSON.stringify(store));
fs.writeFileSync.mockImplementation((_, data) => {
  const parsed = JSON.parse(data);
  Object.keys(store).forEach(k => delete store[k]);
  Object.assign(store, parsed);
});
fs.mkdirSync.mockImplementation(() => {});

// Single shared module instance — no resetModules (avoids stale mock refs)
const tokens = require('../config/tokens');

function clearStore() {
  Object.keys(store).forEach(k => delete store[k]);
}

// ---------------------------------------------------------------------------
// getUserKey
// ---------------------------------------------------------------------------

describe('getUserKey', () => {
  test('lowercases username and prefixes with service', () => {
    expect(tokens.getUserKey('anilist', 'TestUser')).toBe('anilist:testuser');
    expect(tokens.getUserKey('mal', 'AnotherUser')).toBe('mal:anotheruser');
  });

  test('already-lowercase username unchanged', () => {
    expect(tokens.getUserKey('mal', 'lowercase')).toBe('mal:lowercase');
  });
});

// ---------------------------------------------------------------------------
// storeTokens / getTokens
// ---------------------------------------------------------------------------

describe('storeTokens / getTokens', () => {
  beforeEach(clearStore);

  test('stores and retrieves a valid token', () => {
    tokens.storeTokens('anilist', 'user1', {
      access_token: 'tok123',
      refresh_token: 'ref456',
      expires_in: 3600
    });
    const result = tokens.getTokens('anilist', 'user1');
    expect(result).not.toBeNull();
    expect(result.access_token).toBe('tok123');
    expect(result.refresh_token).toBe('ref456');
  });

  test('returns null for non-existent user', () => {
    expect(tokens.getTokens('anilist', 'nobody')).toBeNull();
  });

  test('returns null for expired token', () => {
    tokens.storeTokens('anilist', 'user2', {
      access_token: 'tok_expired',
      refresh_token: null,
      expires_in: -1 // already expired
    });
    expect(tokens.getTokens('anilist', 'user2')).toBeNull();
  });

  test('hasValidTokens returns true for valid token', () => {
    tokens.storeTokens('anilist', 'user3', {
      access_token: 'tok_valid',
      refresh_token: null,
      expires_in: 3600
    });
    expect(tokens.hasValidTokens('anilist', 'user3')).toBe(true);
  });

  test('hasValidTokens returns false for missing user', () => {
    expect(tokens.hasValidTokens('anilist', 'no_such_user')).toBe(false);
  });

  test('removeTokens deletes the entry', () => {
    tokens.storeTokens('anilist', 'user4', {
      access_token: 'tok_del',
      refresh_token: null,
      expires_in: 3600
    });
    tokens.removeTokens('anilist', 'user4');
    expect(tokens.getTokens('anilist', 'user4')).toBeNull();
  });

  test('getTokenRecord returns raw record including credentials', () => {
    tokens.storeTokens('anilist', 'user5', {
      access_token: 'raw_tok',
      refresh_token: null,
      expires_in: 3600
    });
    const rec = tokens.getTokenRecord('anilist', 'user5');
    expect(rec).not.toBeNull();
    expect(rec.access_token).toBe('raw_tok');
  });

  test('getTokenRecord returns null for unknown user', () => {
    expect(tokens.getTokenRecord('anilist', 'ghost')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storeCredentials / getCredentials
// ---------------------------------------------------------------------------

describe('storeCredentials / getCredentials', () => {
  beforeEach(clearStore);

  test('stores and retrieves credentials', () => {
    tokens.storeCredentials('mal', 'userA', {
      client_id: 'cid',
      client_secret: 'csec'
    });
    const creds = tokens.getCredentials('mal', 'userA');
    expect(creds).not.toBeNull();
    expect(creds.client_id).toBe('cid');
    expect(creds.client_secret).toBe('csec');
  });

  test('returns null when no credentials stored', () => {
    expect(tokens.getCredentials('mal', 'nobody')).toBeNull();
  });

  test('credentials coexist with token data', () => {
    tokens.storeTokens('mal', 'combined', {
      access_token: 'tok',
      refresh_token: null,
      expires_in: 3600
    });
    tokens.storeCredentials('mal', 'combined', {
      client_id: 'c1',
      client_secret: 'c2'
    });
    expect(tokens.getTokens('mal', 'combined').access_token).toBe('tok');
    expect(tokens.getCredentials('mal', 'combined').client_id).toBe('c1');
  });
});

// ---------------------------------------------------------------------------
// opaque token store
// ---------------------------------------------------------------------------

describe('opaque token store', () => {
  beforeEach(clearStore);

  test('storeServiceOpaqueToken / resolveServiceOpaqueToken round-trip', () => {
    tokens.storeServiceOpaqueToken('anilist', 'opaqueABC', 'MyUser');
    expect(tokens.resolveServiceOpaqueToken('anilist', 'opaqueABC')).toBe('myuser');
  });

  test('MAL compat wrappers storeOpaqueToken / resolveOpaqueToken', () => {
    tokens.storeOpaqueToken('malToken123', 'MalUser');
    expect(tokens.resolveOpaqueToken('malToken123')).toBe('maluser');
  });

  test('resolveServiceOpaqueToken returns null for unknown token', () => {
    expect(tokens.resolveServiceOpaqueToken('anilist', 'nonexistent')).toBeNull();
  });

  test('hasValidTokensByOpaqueToken returns false when no matching user', () => {
    expect(tokens.hasValidTokensByOpaqueToken('mal', 'badtoken')).toBe(false);
  });

  test('hasValidTokensByOpaqueToken returns true when user has valid token', () => {
    tokens.storeOpaqueToken('tok_opaque_ht', 'richUser2');
    tokens.storeTokens('mal', 'richUser2', {
      access_token: 'richTok',
      refresh_token: null,
      expires_in: 3600
    });
    expect(tokens.hasValidTokensByOpaqueToken('mal', 'tok_opaque_ht')).toBe(true);
  });

  test('hasValidTokensByOpaqueToken returns false when token is expired', () => {
    tokens.storeOpaqueToken('tok_expired_ht', 'expiredUser');
    tokens.storeTokens('mal', 'expiredUser', {
      access_token: 'expTok',
      refresh_token: null,
      expires_in: -1
    });
    expect(tokens.hasValidTokensByOpaqueToken('mal', 'tok_expired_ht')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PKCE verifier store
// ---------------------------------------------------------------------------

describe('PKCE verifier store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('storePkceVerifier / getPkceVerifier round-trip', () => {
    tokens.storePkceVerifier('pkce_sess1', 'verifier_abc');
    expect(tokens.getPkceVerifier('pkce_sess1')).toBe('verifier_abc');
  });

  test('getPkceVerifier deletes verifier after retrieval (one-time use)', () => {
    tokens.storePkceVerifier('pkce_sess2', 'verifier_xyz');
    tokens.getPkceVerifier('pkce_sess2');
    expect(tokens.getPkceVerifier('pkce_sess2')).toBeNull();
  });

  test('verifier auto-expires after 10 minutes', () => {
    tokens.storePkceVerifier('pkce_sess3', 'expiring_verifier');
    jest.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(tokens.getPkceVerifier('pkce_sess3')).toBeNull();
  });

  test('getPkceVerifier returns null for unknown sessionId', () => {
    expect(tokens.getPkceVerifier('no_session_ever')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// watch sessions
// ---------------------------------------------------------------------------

describe('watch sessions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('storeWatchSession returns true for a new session', () => {
    const isNew = tokens.storeWatchSession('anilist', 'ws_tok_1', 'ws_anime_1', 10);
    expect(isNew).toBe(true);
  });

  test('storeWatchSession returns false for an existing session', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_2', 'ws_anime_2', 11);
    const isNew = tokens.storeWatchSession('anilist', 'ws_tok_2', 'ws_anime_2', 11);
    expect(isNew).toBe(false);
  });

  test('shouldUpdateProgress returns false before 5 minutes', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_3', 'ws_anime_3', 1);
    jest.advanceTimersByTime(4 * 60 * 1000); // 4 minutes
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_3', 'ws_anime_3', 1)).toBe(false);
  });

  test('shouldUpdateProgress returns true after 5 minutes', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_4', 'ws_anime_4', 1);
    jest.advanceTimersByTime(5 * 60 * 1000 + 1000); // 5 min + 1s
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_4', 'ws_anime_4', 1)).toBe(true);
  });

  test('shouldUpdateProgress returns false for unknown session', () => {
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_x', 'ws_anime_x', 99)).toBe(false);
  });

  test('markProgressUpdated prevents immediate re-update', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_5', 'ws_anime_5', 2);
    jest.advanceTimersByTime(6 * 60 * 1000); // 6 min — eligible
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_5', 'ws_anime_5', 2)).toBe(true);
    tokens.markProgressUpdated('anilist', 'ws_tok_5', 'ws_anime_5', 2);
    // Still within the 60-second re-update guard
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_5', 'ws_anime_5', 2)).toBe(false);
  });

  test('markProgressUpdated allows update after 60-second guard expires', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_6', 'ws_anime_6', 5);
    jest.advanceTimersByTime(6 * 60 * 1000);
    tokens.markProgressUpdated('anilist', 'ws_tok_6', 'ws_anime_6', 5);
    jest.advanceTimersByTime(61 * 1000); // past the 60s guard
    expect(tokens.shouldUpdateProgress('anilist', 'ws_tok_6', 'ws_anime_6', 5)).toBe(true);
  });

  test('updateWatchSessionAccess does not throw', () => {
    tokens.storeWatchSession('anilist', 'ws_tok_7', 'ws_anime_7', 3);
    expect(() => tokens.updateWatchSessionAccess('anilist', 'ws_tok_7', 'ws_anime_7', 3)).not.toThrow();
  });
});
