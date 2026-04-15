const axios = require("axios");

const ANILIST_API = "https://graphql.anilist.co";

const CURRENTLY_WATCHING_QUERY = `
  query ($userName: String) {
    MediaListCollection(userName: $userName, type: ANIME, status: CURRENT) {
      lists {
        entries {
          id
          media {
            id
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
            episodes
            seasonYear
            season
          }
          status
          progress
        }
      }
    }
  }
`;

const getCurrentlyWatchingAnime = async () => {
  try {
    const userName = process.env.ANILIST_USERNAME || "YOUR_USERNAME";
    
    const response = await axios.post(ANILIST_API, {
      query: CURRENTLY_WATCHING_QUERY,
      variables: { userName }
    });

    const entries = response.data.data?.MediaListCollection?.lists[0]?.entries || [];
    
    return entries.map(entry => ({
      id: `anilist:${entry.media.id}`,
      type: "anime",
      name: entry.media.title.english || entry.media.title.romaji,
      poster: entry.media.coverImage.large,
      posterShape: "portrait",
      description: entry.media.description,
      genres: entry.media.genres,
      imdbRating: (entry.media.averageScore / 10).toFixed(1),
      runtime: "",
      year: entry.media.seasonYear,
      watched: entry.progress > 0 ? true : false
    }));
  } catch (error) {
    console.error("Error fetching from AniList:", error);
    return [];
  }
};

const getAnimeMeta = async (id) => {
  return {
    id,
    type: "anime",
    name: "Anime Title"
  };
};

module.exports = {
  getCurrentlyWatchingAnime,
  getAnimeMeta
};
