const anilistService = require("./services/anilist");

const manifest = {
  id: "community.anilist-stremio",
  version: "1.0.0",
  name: "AniList Sync",
  description: "Syncs your AniList Currently Watching anime to Stremio library",
  types: ["anime"],
  catalogs: [
    {
      type: "anime",
      id: "anilist.watching",
      name: "AniList - Currently Watching"
    }
  ],
  resources: ["catalog", "meta"],
  contactEmail: "contact@example.com"
};

const getCatalog = async (type, id, extra) => {
  if (id === "anilist.watching") {
    const metas = await anilistService.getCurrentlyWatchingAnime();
    return { metas };
  }
  return { metas: [] };
};

const getMeta = async (type, id) => {
  return await anilistService.getAnimeMeta(id);
};

module.exports = {
  manifest,
  getCatalog,
  getMeta
};
