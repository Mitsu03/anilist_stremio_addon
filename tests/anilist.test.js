'use strict';

jest.mock('axios');

const axios = require('axios');
const anilist = require('../services/anilist');
const { extractKitsuId, extractImdbId, findRootKitsuIdInline, findRootImdbIdInline, transformToStremioMeta } = anilist._test;

// ---------------------------------------------------------------------------
// Pure utility helpers
// ---------------------------------------------------------------------------

describe('extractKitsuId', () => {
  test('extracts numeric ID from kitsu.io URL', () => {
    const links = [{ site: 'Kitsu', url: 'https://kitsu.io/anime/12345' }];
    expect(extractKitsuId(links)).toBe('12345');
  });

  test('extracts numeric ID from kitsu.app URL', () => {
    const links = [{ site: 'Kitsu', url: 'https://kitsu.app/anime/99' }];
    expect(extractKitsuId(links)).toBe('99');
  });

  test('returns null when no Kitsu link present', () => {
    const links = [{ site: 'Crunchyroll', url: 'https://crunchyroll.com/anime/foo' }];
    expect(extractKitsuId(links)).toBeNull();
  });

  test('returns null for empty array', () => {
    expect(extractKitsuId([])).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(extractKitsuId(null)).toBeNull();
  });

  test('returns null when Kitsu URL has no numeric ID', () => {
    const links = [{ site: 'Kitsu', url: 'https://kitsu.io/anime/some-slug' }];
    expect(extractKitsuId(links)).toBeNull();
  });
});

describe('extractImdbId', () => {
  test('extracts tt-prefixed ID from IMDb URL', () => {
    const links = [{ site: 'IMDB', url: 'https://www.imdb.com/title/tt9335498/' }];
    expect(extractImdbId(links)).toBe('tt9335498');
  });

  test('is case-insensitive for site name', () => {
    const links = [{ site: 'imdb', url: 'https://www.imdb.com/title/tt0000001/' }];
    expect(extractImdbId(links)).toBe('tt0000001');
  });

  test('returns null when no IMDb link', () => {
    const links = [{ site: 'Kitsu', url: 'https://kitsu.io/anime/1' }];
    expect(extractImdbId(links)).toBeNull();
  });

  test('returns null for empty array', () => {
    expect(extractImdbId([])).toBeNull();
  });

  test('returns null for non-array input', () => {
    expect(extractImdbId(undefined)).toBeNull();
  });
});

describe('findRootKitsuIdInline', () => {
  test('returns null when entry is already root (no prequel)', () => {
    const media = {
      relations: { edges: [{ relationType: 'SEQUEL', node: { type: 'ANIME', externalLinks: [] } }] },
      externalLinks: [{ site: 'Kitsu', url: 'https://kitsu.io/anime/1' }]
    };
    expect(findRootKitsuIdInline(media)).toBeNull();
  });

  test('follows one PREQUEL edge to find root Kitsu ID', () => {
    const media = {
      relations: {
        edges: [{
          relationType: 'PREQUEL',
          node: {
            type: 'ANIME',
            externalLinks: [{ site: 'Kitsu', url: 'https://kitsu.io/anime/42' }],
            relations: { edges: [] }
          }
        }]
      },
      externalLinks: []
    };
    expect(findRootKitsuIdInline(media)).toBe('42');
  });

  test('follows two PREQUEL edges (depth 2)', () => {
    const grandparent = {
      type: 'ANIME',
      externalLinks: [{ site: 'Kitsu', url: 'https://kitsu.io/anime/7' }],
      relations: { edges: [] }
    };
    const parent = {
      type: 'ANIME',
      externalLinks: [],
      relations: {
        edges: [{ relationType: 'PREQUEL', node: grandparent }]
      }
    };
    const media = {
      relations: { edges: [{ relationType: 'PREQUEL', node: parent }] },
      externalLinks: []
    };
    expect(findRootKitsuIdInline(media)).toBe('7');
  });

  test('returns null if root has no Kitsu link', () => {
    const media = {
      relations: {
        edges: [{
          relationType: 'PREQUEL',
          node: {
            type: 'ANIME',
            externalLinks: [{ site: 'Crunchyroll', url: 'https://cr.com/anime/foo' }],
            relations: { edges: [] }
          }
        }]
      },
      externalLinks: []
    };
    expect(findRootKitsuIdInline(media)).toBeNull();
  });
});

describe('findRootImdbIdInline', () => {
  test('returns null when entry is already root (no prequel)', () => {
    const media = {
      relations: { edges: [] },
      externalLinks: [{ site: 'IMDB', url: 'https://www.imdb.com/title/tt111/' }]
    };
    // own IMDB is handled by caller; function returns null for root
    expect(findRootImdbIdInline(media)).toBeNull();
  });

  test('follows PREQUEL edge to find root IMDB ID', () => {
    const media = {
      relations: {
        edges: [{
          relationType: 'PREQUEL',
          node: {
            type: 'ANIME',
            externalLinks: [{ site: 'IMDB', url: 'https://www.imdb.com/title/tt9876543/' }],
            relations: { edges: [] }
          }
        }]
      },
      externalLinks: []
    };
    expect(findRootImdbIdInline(media)).toBe('tt9876543');
  });
});

// ---------------------------------------------------------------------------
// transformToStremioMeta
// ---------------------------------------------------------------------------

describe('transformToStremioMeta', () => {
  const baseEntry = {
    media: {
      id: 1234,
      idMal: 5678,
      title: { english: 'Test Anime', romaji: 'Tesuto Anime' },
      description: '<p>Some description</p>',
      coverImage: { large: 'https://img.example.com/large.jpg', medium: 'https://img.example.com/med.jpg' },
      bannerImage: 'https://img.example.com/banner.jpg',
      genres: ['Action', 'Adventure'],
      averageScore: 85,
      seasonYear: 2022,
      season: 'FALL',
      status: 'FINISHED',
      format: 'TV',
      episodes: 24,
      externalLinks: [],
      relations: { edges: [] }
    },
    status: 'CURRENT',
    progress: 5
  };

  test('uses English title when available', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.name).toBe('Test Anime');
  });

  test('falls back to romaji when English title is absent', () => {
    const entry = { ...baseEntry, media: { ...baseEntry.media, title: { english: null, romaji: 'Romaji Title' } } };
    const result = transformToStremioMeta(entry);
    expect(result.name).toBe('Romaji Title');
  });

  test('strips HTML from description', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.description).toBe('Some description');
  });

  test('converts AniList score (0-100) to IMDb-style rating', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.imdbRating).toBe('8.5');
  });

  test('imdbRating is null when averageScore is 0', () => {
    const entry = { ...baseEntry, media: { ...baseEntry.media, averageScore: 0 } };
    const result = transformToStremioMeta(entry);
    expect(result.imdbRating).toBeNull();
  });

  test('uses anilist: id when no IMDB or Kitsu ID', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.id).toBe('anilist:1234');
    expect(result.type).toBe('anime');
  });

  test('uses kitsu: id when rootKitsuId is set', () => {
    const entry = { ...baseEntry, _rootKitsuId: '9999' };
    const result = transformToStremioMeta(entry);
    expect(result.id).toBe('kitsu:9999');
  });

  test('uses IMDB id when rootImdbId is set', () => {
    const entry = { ...baseEntry, _rootImdbId: 'tt1234567' };
    const result = transformToStremioMeta(entry);
    expect(result.id).toBe('tt1234567');
    expect(result.type).toBe('series'); // TV format → series
  });

  test('uses movie type for MOVIE format with IMDB id', () => {
    const entry = { ...baseEntry, _rootImdbId: 'tt0000001', media: { ...baseEntry.media, format: 'MOVIE' } };
    const result = transformToStremioMeta(entry);
    expect(result.type).toBe('movie');
  });

  test('watched is true when progress > 0', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.watched).toBe(true);
  });

  test('watched is false when progress is 0', () => {
    const entry = { ...baseEntry, progress: 0 };
    const result = transformToStremioMeta(entry);
    expect(result.watched).toBe(false);
  });

  test('uses Cinemeta metadata when available', () => {
    const entry = {
      ...baseEntry,
      _rootImdbId: 'tt9999999',
      _cinemetaMeta: {
        name: 'Cinemeta Title',
        poster: 'https://cinemeta.example/poster.jpg',
        background: 'https://cinemeta.example/bg.jpg',
        description: 'Cinemeta description',
        genres: ['Drama'],
        imdbRating: '9.0',
        releaseInfo: '2020-',
        year: 2020
      }
    };
    const result = transformToStremioMeta(entry);
    expect(result.name).toBe('Cinemeta Title');
    expect(result.poster).toBe('https://cinemeta.example/poster.jpg');
    expect(result.imdbRating).toBe('9.0');
    expect(result.year).toBe(2020);
  });

  test('aliases excludes primary title, includes romaji', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.aliases).toContain('Tesuto Anime');
    expect(result.aliases).not.toContain('Test Anime'); // primary title excluded
  });

  test('poster falls back to medium image when large is absent', () => {
    const entry = {
      ...baseEntry,
      media: { ...baseEntry.media, coverImage: { large: null, medium: 'https://img.example.com/med.jpg' } }
    };
    const result = transformToStremioMeta(entry);
    expect(result.poster).toBe('https://img.example.com/med.jpg');
  });

  test('releaseInfo is set from seasonYear', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.releaseInfo).toBe('2022');
  });

  test('meta object contains episodes, status, progress', () => {
    const result = transformToStremioMeta(baseEntry);
    expect(result.meta.episodes).toBe(24);
    expect(result.meta.status).toBe('FINISHED');
    expect(result.meta.progress).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getViewerInfo (axios mocked)
// ---------------------------------------------------------------------------

describe('getViewerInfo', () => {
  beforeEach(() => {
    axios.post.mockReset();
  });

  test('returns viewer data on success', async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: { Viewer: { id: 42, name: 'TestUser' } } }
    });
    const viewer = await anilist.getViewerInfo('test_token');
    expect(viewer).toEqual({ id: 42, name: 'TestUser' });
  });

  test('caches viewer info for the same token', async () => {
    // First call will be cached from previous test; use a fresh token
    axios.post.mockResolvedValueOnce({
      data: { data: { Viewer: { id: 7, name: 'CachedUser' } } }
    });
    await anilist.getViewerInfo('unique_token_for_cache_test');
    await anilist.getViewerInfo('unique_token_for_cache_test');
    // axios.post should only have been called once
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('throws when Viewer is missing from response', async () => {
    axios.post.mockResolvedValueOnce({ data: { data: {} } });
    await expect(anilist.getViewerInfo('bad_token')).rejects.toThrow(
      'Could not retrieve viewer info from AniList'
    );
  });
});

// ---------------------------------------------------------------------------
// getAnimeMeta (axios mocked)
// ---------------------------------------------------------------------------

describe('getAnimeMeta', () => {
  beforeEach(() => {
    axios.post.mockReset();
  });

  test('returns meta object for valid anilist: id', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        data: {
          Media: {
            id: 101,
            title: { english: 'My Anime', romaji: 'Mai Anime' },
            description: '<b>Desc</b>',
            coverImage: { large: 'https://img/large.jpg', medium: null },
            bannerImage: null,
            genres: ['Fantasy'],
            averageScore: 75,
            status: 'FINISHED',
            format: 'TV',
            episodes: 12,
            seasonYear: 2021,
            externalLinks: []
          }
        }
      }
    });
    const meta = await anilist.getAnimeMeta('anilist:101');
    expect(meta.id).toBe('anilist:101');
    expect(meta.name).toBe('My Anime');
    expect(meta.description).toBe('Desc');
    expect(meta.imdbRating).toBe('7.5');
  });

  test('throws when Media is not found', async () => {
    axios.post.mockResolvedValueOnce({ data: { data: { Media: null } } });
    await expect(anilist.getAnimeMeta('anilist:999')).rejects.toThrow(
      'Failed to fetch anime metadata'
    );
  });
});

// ---------------------------------------------------------------------------
// updateProgress (axios mocked)
// ---------------------------------------------------------------------------

describe('updateProgress', () => {
  beforeEach(() => {
    axios.post.mockReset();
  });

  test('returns saved entry on success', async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: { SaveMediaListEntry: { id: 55, progress: 3 } } }
    });
    const result = await anilist.updateProgress('1234', 3, 'valid_token');
    expect(result.progress).toBe(3);
  });

  test('throws when mutation returns no data', async () => {
    axios.post.mockResolvedValueOnce({ data: { data: {} } });
    await expect(anilist.updateProgress('1234', 3, 'token')).rejects.toThrow();
  });
});
