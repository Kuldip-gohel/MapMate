"""
MapMate — Smart Nearby Places Explorer
Streamlit launcher.

Streamlit only acts as a host: it reads index.html and script.js, inlines the
JavaScript into the HTML, and renders the result in an iframe with
streamlit.components.v1.html(). All geocoding (Nominatim) and place search
(Overpass) requests are made directly by the visitor's browser.
"""

from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

BASE_DIR = Path(__file__).resolve().parent
HTML_FILE = BASE_DIR / "index.html"
JS_FILE = BASE_DIR / "script.js"

# Exact external reference in index.html that gets replaced by the inline script
SCRIPT_TAG = '<script src="script.js"></script>'

IFRAME_HEIGHT = 1000  # px; the page scrolls inside the iframe


st.set_page_config(
    page_title="MapMate — Smart Nearby Places Explorer",
    page_icon="📍",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Remove Streamlit chrome and padding so the site fills the available width.
st.markdown(
    """
    <style>
      #MainMenu, footer, header[data-testid="stHeader"] { visibility: hidden; height: 0; }
      .block-container, [data-testid="stMainBlockContainer"] {
        padding: 0 !important; max-width: 100% !important;
      }
      iframe { border: 0 !important; width: 100% !important; }
    </style>
    """,
    unsafe_allow_html=True,
)


def build_page() -> str:
    """Return index.html with script.js inlined."""
    missing = [p.name for p in (HTML_FILE, JS_FILE) if not p.is_file()]
    if missing:
        raise FileNotFoundError(
            "Missing required file(s): " + ", ".join(missing)
            + ". Keep index.html, script.js, app.py and requirements.txt in the same folder."
        )

    html = HTML_FILE.read_text(encoding="utf-8")
    js = JS_FILE.read_text(encoding="utf-8")

    if SCRIPT_TAG not in html:
        raise ValueError(
            f"index.html must contain {SCRIPT_TAG} so app.py can inline script.js."
        )

    # A literal "</script" inside inline JS would end the script block early.
    safe_js = js.replace("</script", "<\\/script")
    return html.replace(SCRIPT_TAG, "<script>\n" + safe_js + "\n</script>", 1)


try:
    page = build_page()
except (FileNotFoundError, ValueError, OSError) as exc:
    st.error(f"MapMate could not start: {exc}")
    st.stop()

components.html(page, height=IFRAME_HEIGHT, scrolling=True)
