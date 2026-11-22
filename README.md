# Bite Picker

A personal phone app (PWA) for deciding what to order on Talabat. Plain HTML/CSS/JS, no build step.

- **Nearby**: food places around you from OpenStreetMap (live, cached 7 days; falls back to `places-seed.json`, a 15 km snapshot around Saadiyat Island).
- **Suggest**: "Something new" (places you've never ordered from, favoring cuisines you haven't had in 14 days) or "My usual" (ranked by order count and time of day).
- **Pick**: random spinner over your own choices, optionally weighted toward places you haven't had lately; save choice sets.
- **Mine**: saved places, Talabat links, order history, settings, backup export/import.

Talabat has no public API, so the app hands off to Talabat: a saved Talabat link opens directly; otherwise the name is copied and talabat.com opens. When you come back, it asks whether you ordered and logs it.

All data is stored in the phone browser's localStorage. Use **Mine → Settings → Export backup** occasionally.

## Run locally
    python -m http.server 8765
then open http://127.0.0.1:8765

## Refresh the Saadiyat snapshot
Re-run the Overpass query for `amenity=restaurant|fast_food|cafe` within 15 km of 24.539, 54.433 and regenerate `places-seed.json`. After changing app files, bump `CACHE` in `sw.js` so installed copies update.
