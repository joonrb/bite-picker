# Bite Picker

A personal phone app (PWA) for deciding what to order on Talabat. Plain HTML/CSS/JS, no build step.

- **Nearby**: food places around you from OpenStreetMap (live, cached 7 days; falls back to `places-seed.json`, a 30 km snapshot around Saadiyat Island). Search radius: 10 km by default, adjustable 1–30 km.
- **Genres**: every place gets up to 2 of 22 genres (`genres.js`): from its OpenStreetMap cuisine tag, then keywords in its name, then a list of known UAE chains, then its type. You can override genres per place in Mine → Edit.
- **Suggest**: preference-based. Choose place type (anything / new to me / my usuals / haven't had in a while), meal (auto from the clock, or breakfast / lunch / dinner / late night), any number of genres, and quick delivery (≤30 min), budget-friendly, or saved-only. Matches are weighted by your order history, how well the genre fits the meal, novelty and distance.
- **Delivery time**: after logging an order you can tap how long it took; your average is used for "Quick delivery". Otherwise it's estimated from distance (marked "est.").
- **Pick**: random spinner over your own choices, optionally weighted toward places you haven't had lately; save choice sets.
- **Mine**: saved places, Talabat links, order history, settings, backup export/import.

Talabat has no public API, so the app hands off to Talabat: a saved Talabat link opens directly; otherwise the name is copied and talabat.com opens. When you come back, it asks whether you ordered and logs it.

All data is stored in the phone browser's localStorage. Use **Mine → Settings → Export backup** occasionally.

## Run locally
    python -m http.server 8765
then open http://127.0.0.1:8765

## Refresh the Saadiyat snapshot
Re-run the Overpass query for `amenity=restaurant|fast_food|cafe` within 30 km of 24.539, 54.433 and regenerate `places-seed.json`. After changing app files, bump `CACHE` in `sw.js` so installed copies update.
