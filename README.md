# AniList Stremio Extension

This Stremio extension syncs your AniList "Currently Watching" anime to your Stremio library automatically.

## Setup

### 1. Prerequisites
- Node.js (v14+)
- npm
- Your AniList username

### 2. Configuration

Create a `.env` file in the root directory:

```
ANILIST_USERNAME=your_username_here
PORT=3000
```

Replace `your_username_here` with your actual AniList username.

### 3. Start the Extension

```powershell
npm start
```

The extension will start on `http://localhost:3000`

### 4. Add to Stremio

1. Open Stremio
2. Go to **Settings** ? **Addons**
3. Click **Install from URL**
4. Enter: `http://localhost:3000/manifest.json`
5. Click **Install**

## Features

- Fetches all anime from your AniList "Currently Watching" status
- Displays them in a custom Stremio catalog
- Shows anime metadata including poster, description, rating, and year
- Updates when you refresh the catalog

## Notes

- The extension requires your AniList username to be publicly visible on AniList
- Keep the extension running while using it in Stremio
- The catalog is fetched fresh each time you open it in Stremio

## Troubleshooting

### AniList API Error
- Make sure your username matches your AniList profile
- Ensure your AniList profile is public
- Check if you have anime in your "Currently Watching" list

### Port Already in Use
Set a different port:
```powershell
$env:PORT=3001; npm start
```

