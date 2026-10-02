# Cordial audio library

The "Add audio" picker on posts and reels reads its catalogue from these sources:

1. **Cordial Sounds.** These are original instrumentals in Nigerian styles (Afrobeats, Amapiano, Highlife, Gospel, Afropop), generated in the browser by `audiolib.js`. They are always available and need no licence.
2. **`audio/catalog.json`.** This is an admin-managed list of licensed tracks. It ships empty.
3. **A Supabase table (optional).** It has the same shape as the list, and is read when `DIARY_CONFIG.audioCatalogTable` is set in `config.js`. Only rows with `active = true` are shown.

4. **Jamendo.** These are independent artists who release under Creative Commons licences. They are served by the `diary-music` edge function, which searches Jamendo by category and query and switches on when the Supabase secret `JAMENDO_CLIENT_ID` is set. The client ID is free from devportal.jamendo.com. Each post credits the artist and links to the track's licence, as Creative Commons requires. Many tracks are licensed non-commercially (BY-NC). If Cordial earns money, check each licence or take a commercial licence from Jamendo Licensing.

**Only add music you hold the rights to use in Cordial.** Commercial recordings by Nigerian artists need a licence from the label, distributor or a music-licensing provider. Licensed tracks are streamed from their own URLs: Cordial stores which track and which part a post uses, never a copy of the audio.

## Track fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Your stable audio ID, for example the provider's ID |
| `title` | yes | Song title |
| `artist` | yes | Artist name |
| `cover` | no | Artwork URL, square |
| `preview` | yes | A playable URL used in the picker |
| `src` | no | The full audio URL used on posts (falls back to `preview`) |
| `duration` | yes | Seconds |
| `category` | yes | One or more of `afrobeats`, `gospel`, `afropop`, `highlife`, `amapiano` |
| `trending`, `popular`, `new` | no | `true` to list the track under Trending, Popular or New releases |

```json
{
  "version": 1,
  "provider": "Your licensing provider",
  "tracks": [
    {
      "id": "prov-12345",
      "title": "Song title",
      "artist": "Artist name",
      "cover": "https://…/cover.jpg",
      "preview": "https://…/preview.mp3",
      "duration": 180,
      "category": ["afrobeats"],
      "trending": true
    }
  ]
}
```

The Supabase table can use the same names, or `audio_id`, `artist_name`, `cover_url`, `preview_url` and `audio_url`. Each track also needs an `active` column for it to appear.
