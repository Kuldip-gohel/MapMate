# MapMate

📍 MapMate — Smart Nearby Places Explorer

Discover More. Explore Smarter.

MapMate helps students, visitors and newcomers find nearby places by category and search radius, using live OpenStreetMap data. Enter a location, pick a category (for example Cafés) and a radius (for example 3 km), and MapMate shows a nearest-first list of real places together with numbered pins on an interactive map.

🔗 Live demo: https://mapmate-wdz9srcfczlgicym8bfbrv.streamlit.app/

Problem statement :-
Users exploring unfamiliar areas may need a focused way to discover nearby places by category and search radius. MapMate provides a location-based discovery workflow that combines searchable place listings with an interactive map, helping users compare nearby options and quickly locate them.

Features :-
Location search with Nominatim (city, locality, landmark or address)
8 categories: restaurants, cafés, hospitals, pharmacies, ATMs, parks, libraries, supermarkets
Radius choices: 1, 3, 5 or 10 km, drawn as a circle on the map
Nearest-first result cards linked to numbered pins on a Leaflet map
Straight-line distance, address and opening hours when OpenStreetMap has them
Form validation with in-page feedback (no alert() pop-ups)
Loading, empty and error states (not found, timeout, service unavailable, network error)
Responsive layout built with Tailwind CSS, with reduced-motion support

How it works :-
The user submits the form; the input is validated.
Nominatim turns the location text into latitude and longitude.
An Overpass query finds nodes, ways and relations with the chosen OpenStreetMap tag inside the chosen radius.
Results are cleaned, de-duplicated, measured with the haversine formula and sorted nearest first (at most 60 are shown).
The map shows the radius circle and numbered pins; clicking a card moves the map to that place.

JavaScript events implemented :-
submit (search), change (category and radius), click (place card), input (location field), click (Reset), click (Cancel), click (quick-start chips), click (mobile menu).

Run locally:-
pip install -r requirements.txt
streamlit run app.py

Limitations :-
Results depend on OpenStreetMap coverage, so some places may be missing or lack details.
Distances are straight-line estimates, not walking or driving distances.
The public Nominatim and Overpass services are shared and can be slow, rate-limited or unavailable; MapMate shows an error instead of fake data.
At most 60 places are displayed.

Author :-
Gohel Kuldip — MSc Artificial Intelligence and Machine Learning
