'use strict';

jest.mock('axios');
jest.mock('fs');

const axios = require('axios');
const fs = require('fs');

// Shared in-memory store backing the mocked fs
const store = {};
fs.existsSync.mockImplementation(() => true);
fs.readFileSync.mockImplementation(() => JSON.stringify(store));
fs.writeFileSync.mockImplementation((_, data) => {
  const parsed = JSON.parse(data);
  Object.keys(store).forEach(k => delete store[k]);
  Object.assign(store, parsed);
});
fs.mkdirSync.mockImplementation(() => {});

// Load modules once — mal.js loads tokens.js via the same cache, so they
// share the same tokenManager instance and the mocked fs above.
const tokens = require('../config/tokens');
const mal = require('../services/mal');

function clearStore() {
  Object.keys(store).forEach(k => delete store[k]);
}

// ---------------------------------------------------------------------------
// getAnimeList
// ---------------------------------------------------------------------------

describe('mal.getAnimeList', () => {
  const USERNAME = 'testuser';
  const CLIENT_ID = 'client123';

  const makeEntry = (id, title, episodesWatched = 3) => ({
    node: {
      id,
      title,
      main_picture: { large: `https://img/${id}.jpg`, medium: null },
      synopsis: '<p>Synopsis</p>',
      genres: [{ id: 1, name: 'Action' }],
      mean: 8.0,
      num_episodes: 12,
      start_season: { year: 2020, season: 'spring' },
      status: 'currently_airing',
      media_type: 'tv',
      alternative_titles: { en: `${title} EN`, ja: `${title} JA` },
      related_anime: []
    },
    list_status: { num_episodes_watched: episodesWatched }
  });

  beforeEach(() => {
    axios.get.mockReset();
  });

  test('returns transformed Stremio meta array', async () => {
    const entries = [makeEntry(1, 'Anime A'), makeEntry(2, 'Anime B')];
    axios.get
      .mockResolvedValueOnce({ data: { data: entries } }) // MAL list
      .mockResolvedValueOnce({ data: { data: [] } });     // Kitsu batch

    const result = await mal.getAnimeList(USERNAME, CLIENT_ID, 'watching');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Anime A EN');
    expect(result[0].watched).toBe(true);
  });

  test('sets watched=false when progress is 0', async () => {
    const entries = [makeEntry(3, 'Anime C', 0)];
    axios.get
      .mockResolvedValueOnce({ data: { data: entries } })
      .mockResolvedValueOnce({ data: { data: [] } });

    const result = await mal.getAnimeList(USERNAME, CLIENT_ID, 'watching');
    expect(result[0].watched).toBe(false);
  });

  test('deduplicates sequel entries — only root survives', async () => {
    const root = makeEntry(10, 'Root Anime');
    const sequel = makeEntry(20, 'Sequel Anime');
    root.node.related_anime = [{ relation_type: 'sequel', node: { id: 20 } }];
    sequel.node.related_anime = [{ relation_type: 'prequel', node: { id: 10 } }];

    axios.get
      .mockResolvedValueOnce({ data: { data: [root, sequel] } })
      .mockResolvedValueOnce({ data: { data: [] } });

    const result = await mal.getAnimeList(USERNAME, CLIENT_ID, 'watching');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Root Anime EN');
  });

  test('uses kitsu: id when Kitsu mapping found', async () => {
    const entries = [makeEntry(30, 'Kitsu Anime')];
    axios.get
      .mockResolvedValueOnce({ data: { data: entries } })
      .mockResolvedValueOnce({
        data: {
          data: [{
            attributes: { externalId: '30' },
            relationships: { item: { data: { id: '555' } } }
          }]
        }
      });

    const result = await mal.getAnimeList(USERNAME, CLIENT_ID, 'watching');
    expect(result[0].id).toBe('kitsu:555');
  });

  test('falls back to mal: id when no Kitsu mapping', async () => {
    const entries = [makeEntry(40, 'No Kitsu')];
    axios.get
      .mockResolvedValueOnce({ data: { data: entries } })
      .mockResolvedValueOnce({ data: { data: [] } });

    const result = await mal.getAnimeList(USERNAME, CLIENT_ID, 'watching');
    expect(result[0].id).toBe('mal:40');
  });

  test('throws human-readable error for 400 (user not found / private)', async () => {
    axios.get.mockRejectedValueOnce({
      response: { status: 400, data: { message: 'User not found' } }
    });
    await expect(mal.getAnimeList(USERNAME, CLIENT_ID, 'watching')).rejects.toThrow(
      `MAL user "${USERNAME}" not found or list is private.`
    );
  });

  test('throws human-readable error for 401 (invalid client ID)', async () => {
    axios.get.mockRejectedValueOnce({
      response: { status: 401, data: { message: 'Unauthorized' } }
    });
    await expect(mal.getAnimeList(USERNAME, CLIENT_ID, 'watching')).rejects.toThrow(
      'MAL Client ID is invalid or missing.'
    );
  });

  test('throws human-readable error for 403 (private list)', async () => {
    axios.get.mockRejectedValueOnce({
      response: { status: 403, data: { message: 'Forbidden' } }
    });
    await expect(mal.getAnimeList(USERNAME, CLIENT_ID, 'watching')).rejects.toThrow(
      `MAL user "${USERNAME}"'s anime list is not public.`
    );
  });

  test('throws on network error', async () => {
    axios.get.mockRejectedValueOnce({ request: {}, message: 'Network error' });
    await expect(mal.getAnimeList(USERNAME, CLIENT_ID, 'watching')).rejects.toThrow(
      'Unable to connect to MAL API'
    );
  });
});

// ---------------------------------------------------------------------------
// getAnimeMeta - mal: id
// ---------------------------------------------------------------------------

describe('mal.getAnimeMeta - mal: id', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('returns meta for mal: id', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        id: 123,
        title: 'Test Anime',
        main_picture: { large: 'https://img/large.jpg' },
        synopsis: 'A synopsis',
        genres: [{ id: 1, name: 'Action' }],
        mean: 7.5,
        num_episodes: 26,
        start_season: { year: 2019 },
        status: 'finished_airing',
        media_type: 'tv',
        alternative_titles: { en: '', ja: 'テスト' }
      }
    });
    const meta = await mal.getAnimeMeta('mal:123', 'clientX');
    expect(meta.id).toBe('mal:123');
    expect(meta.name).toBe('Test Anime');
    expect(meta.imdbRating).toBe('7.5');
    expect(meta.type).toBe('series');
  });

  test('uses English alternative title when available', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        id: 124,
        title: 'Romaji Title',
        main_picture: null,
        synopsis: '',
        genres: [],
        mean: null,
        num_episodes: 1,
        start_season: null,
        status: 'not_yet_aired',
        media_type: 'tv',
        alternative_titles: { en: 'English Title', ja: '' }
      }
    });
    const meta = await mal.getAnimeMeta('mal:124', 'cid');
    expect(meta.name).toBe('English Title');
  });

  test('maps movie media_type to type "movie"', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        id: 125,
        title: 'A Movie',
        main_picture: null,
        synopsis: '',
        genres: [],
        mean: 6.0,
        num_episodes: 1,
        start_season: { year: 2020 },
        status: 'finished_airing',
        media_type: 'movie',
        alternative_titles: { en: '', ja: '' }
      }
    });
    const meta = await mal.getAnimeMeta('mal:125', 'cid');
    expect(meta.type).toBe('movie');
  });

  test('throws 404 error with meaningful message', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(mal.getAnimeMeta('mal:999', 'cid')).rejects.toThrow('not found on MAL');
  });

  test('throws 401 error with meaningful message', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(mal.getAnimeMeta('mal:999', 'cid')).rejects.toThrow('MAL Client ID is invalid');
  });
});

// ---------------------------------------------------------------------------
// getAnimeMeta - kitsu: id
// ---------------------------------------------------------------------------

describe('mal.getAnimeMeta - kitsu: id', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('fetches from Kitsu API for kitsu: id', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        data: {
          id: '42',
          attributes: {
            titles: { en: 'Kitsu Anime', en_jp: 'Kitsu Anime JP' },
            canonicalTitle: 'Kitsu Anime',
            synopsis: 'Kitsu synopsis',
            averageRating: '80.0',
            startDate: '2018-04-01',
            posterImage: { large: 'https://kitsu.io/poster.jpg', medium: null },
            coverImage: { large: 'https://kitsu.io/cover.jpg', original: null }
          }
        }
      }
    });
    const meta = await mal.getAnimeMeta('kitsu:42', 'unused');
    expect(meta.id).toBe('kitsu:42');
    expect(meta.name).toBe('Kitsu Anime');
    expect(meta.imdbRating).toBe('8.0');
    expect(meta.year).toBe(2018);
  });

  test('strips HTML from Kitsu synopsis', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        data: {
          id: '43',
          attributes: {
            titles: { en: 'HTML Anime' },
            canonicalTitle: 'HTML Anime',
            synopsis: '<p>Desc with <b>tags</b></p>',
            averageRating: null,
            startDate: null,
            posterImage: null,
            coverImage: null
          }
        }
      }
    });
    const meta = await mal.getAnimeMeta('kitsu:43', 'unused');
    expect(meta.description).toBe('Desc with tags');
  });
});

// ---------------------------------------------------------------------------
// updateProgress
// ---------------------------------------------------------------------------

describe('mal.updateProgress', () => {
  beforeEach(() => {
    clearStore();
    axios.patch.mockReset();
  });

  test('throws when user has no stored token', async () => {
    await expect(mal.updateProgress('123', 5, 'unknownUser', 'cid')).rejects.toThrow(
      'Failed to update progress: User not authenticated with MyAnimeList'
    );
  });

  test('calls MAL PATCH endpoint with stored token', async () => {
    tokens.storeTokens('mal', 'richUser', {
      access_token: 'access_tok',
      refresh_token: null,
      expires_in: 3600
    });
    axios.patch.mockResolvedValueOnce({ data: { num_watched_episodes: 7 } });

    await expect(mal.updateProgress('456', 7, 'richUser', 'cid')).resolves.not.toThrow();
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/anime/456/my_list_status'),
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access_tok' })
      })
    );
  });

  test('throws when PATCH request fails', async () => {
    tokens.storeTokens('mal', 'errUser', {
      access_token: 'err_tok',
      refresh_token: null,
      expires_in: 3600
    });
    axios.patch.mockRejectedValueOnce(new Error('PATCH failed'));

    await expect(mal.updateProgress('789', 1, 'errUser', 'cid')).rejects.toThrow(
      'Failed to update progress: PATCH failed'
    );
  });
});

// ---------------------------------------------------------------------------
// getAuthenticatedUsername
// ---------------------------------------------------------------------------

describe('mal.getAuthenticatedUsername', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('returns username from @me endpoint', async () => {
    axios.get.mockResolvedValueOnce({ data: { id: 1, name: 'oAuthUser' } });
    const name = await mal.getAuthenticatedUsername('access_token_xyz');
    expect(name).toBe('oAuthUser');
  });

  test('returns null on API error', async () => {
    axios.get.mockRejectedValueOnce(new Error('network fail'));
    const name = await mal.getAuthenticatedUsername('bad_token');
    expect(name).toBeNull();
  });

  test('returns null when name field is missing', async () => {
    axios.get.mockResolvedValueOnce({ data: { id: 2 } });
    const name = await mal.getAuthenticatedUsername('tok');
    expect(name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapKitsuToMal
// ---------------------------------------------------------------------------

describe('mal.mapKitsuToMal', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('returns MAL ID from Kitsu mapping', async () => {
    axios.get.mockResolvedValueOnce({
      data: { data: [{ attributes: { externalId: '789' } }] }
    });
    const id = await mal.mapKitsuToMal('12345');
    expect(id).toBe('789');
  });

  test('returns null when no mapping found', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: [] } });
    const id = await mal.mapKitsuToMal('99999');
    expect(id).toBeNull();
  });

  test('returns null on network failure', async () => {
    axios.get.mockRejectedValueOnce(new Error('network fail'));
    const id = await mal.mapKitsuToMal('bad');
    expect(id).toBeNull();
  });
});
