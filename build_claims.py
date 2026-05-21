#!/usr/bin/env python3
"""
build_claims.py — Generate a static HTML page for every claim in the
Facthem EU Supabase database and update sitemap.xml.

Run manually:
    pip install -r requirements.txt
    python build_claims.py

Or via GitHub Actions (workflow_dispatch) — see .github/workflows/build-claims.yml.
"""

import html
import json
import os
import re
import sqlite3
import sys
import urllib.parse
from datetime import date
from pathlib import Path

# ── Local-mode detection ──────────────────────────────────────────────────────
# When DEBUG_DB_PATH is set (locally, via .env or env var), read claims directly
# from the parliament_eu.db SQLite file instead of Supabase. Useful when the
# local SQLite is fresher than the production Supabase mirror.
DEBUG_DB_PATH = os.environ.get("DEBUG_DB_PATH")
if not DEBUG_DB_PATH:
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("DEBUG_DB_PATH=") and "=" in line:
                DEBUG_DB_PATH = line.split("=", 1)[1].strip().strip('"').strip("'")

USE_SQLITE = bool(DEBUG_DB_PATH and Path(DEBUG_DB_PATH).exists())

if not USE_SQLITE:
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("supabase package not installed.  Run: pip install -r requirements.txt")

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ.get("SUPABASE_URL")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON")
BASE_URL      = "https://facthem.eu"
OUT_DIR       = Path(__file__).parent / "claim"
POL_OUT_DIR   = Path(__file__).parent / "politician"
SITEMAP_PATH  = Path(__file__).parent / "sitemap.xml"
SITEMAP_STATIC_PATH = Path(__file__).parent / "sitemap-static.xml"
SITEMAP_POLITICIANS_PATH = Path(__file__).parent / "sitemap-politicians.xml"
SITEMAP_CLAIMS_PATH = Path(__file__).parent / "sitemap-claims.xml"
TODAY         = date.today().isoformat()

# ── Label maps (mirror app.js) ────────────────────────────────────────────────
TEMATICO_LABELS = {
    "agriculture":             "Agriculture",
    "defence":                 "Defence",
    "economy":                 "Economy",
    "energy":                  "Energy",
    "environment":             "Environment",
    "equality":                "Equality",
    "health":                  "Health",
    "housing":                 "Housing",
    "human_rights":            "Human Rights",
    "industry_and_labour":     "Industry & Employment",
    "internal_affairs":        "Internal Affairs",
    "international_relations": "Foreign Affairs",
    "justice_and_corruption":  "Justice & Anti-Corruption",
    "migration":               "Migration",
    "other":                   "Other",
    "social_policy":           "Social Policy",
    "transport":               "Transport",
}

RESULTADO_LABELS = {
    "CONFIRMED":             "Confirmed",
    "CONFIRMED_WITH_NUANCE": "Nuanced",
    "DECONTEXTUALIZED":      "Out of context",
    "FALSE":                 "False",
    "INACCURATE":            "Inaccurate",
    "UNVERIFIABLE":          "Unverifiable",
    "OVERESTIMATED":         "Overestimated",
    "UNDERESTIMATED":        "Underestimated",
}

RESULTADO_TO_CLASS = {
    "CONFIRMED":             "verdadero",
    "CONFIRMED_WITH_NUANCE": "parcial",
    "DECONTEXTUALIZED":      "enganoso",
    "INACCURATE":            "nv",
    "FALSE":                 "falso",
    "UNVERIFIABLE":          "nv",
    "OVERESTIMATED":         "enganoso",
    "UNDERESTIMATED":        "enganoso",
}

# schema.org ClaimReview rating (1 = False … 5 = True)
CLAIM_REVIEW_RATINGS = {
    "CONFIRMED":             (5, "True"),
    "CONFIRMED_WITH_NUANCE": (4, "Mostly True"),
    "DECONTEXTUALIZED":      (3, "Out of Context"),
    "INACCURATE":            (2, "Inaccurate"),
    "FALSE":                 (1, "False"),
    "UNVERIFIABLE":          (3, "Unverifiable"),
    "OVERESTIMATED":         (2, "Overestimated"),
    "UNDERESTIMATED":        (2, "Underestimated"),
}

RESULTADO_EMOJIS = {
    "CONFIRMED":             "✅",
    "CONFIRMED_WITH_NUANCE": "⚠️",
    "FALSE":                 "❌",
    "DECONTEXTUALIZED":      "🟠",
    "INACCURATE":            "🔸",
    "UNVERIFIABLE":          "❓",
    "OVERESTIMATED":         "🟠",
    "UNDERESTIMATED":        "🟠",
}

FUENTE_TIPO_ORDER = {
    "Primary": 0, "Academic": 1, "Secondary": 2, "Tertiary": 3,
    "Primaria": 0, "Académica": 1, "Secundaria": 2, "Terciaria": 3,
}
FUENTE_TIPO_LABELS = {
    "Primaria": "Primary", "Académica": "Academic",
    "Secundaria": "Secondary", "Terciaria": "Tertiary",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s or ""), quote=True)


def capitalize(s):
    s = str(s or "").strip()
    return s[0].upper() + s[1:] if s else s


def snake_to_label(s):
    return capitalize(str(s or "").replace("_", " "))


def is_valid(v):
    return v and v not in ("N/A", "-", "n/a")


def format_nombre(full_name):
    parts = str(full_name or "").split(",")
    if len(parts) == 2:
        return f"{parts[1].strip()} {parts[0].strip()}"
    return str(full_name or "")


def resultado_to_class(resultado):
    if not resultado:
        return "nv"
    return RESULTADO_TO_CLASS.get(resultado.upper(), "nv")


def format_resultado(resultado):
    if not resultado:
        return "Unverified"
    return RESULTADO_LABELS.get(resultado.upper(), snake_to_label(resultado))


def slugify(text, claim_id):
    """First 8 words of text, URL-safe, suffixed with the first segment of the claim UUID."""
    short_id = str(claim_id).split("-")[0]
    s = str(text or "").strip().lower()
    # basic accent normalisation
    for src, dst in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),
                     ("ä","a"),("ö","o"),("ü","u"),("ñ","n"),("ç","c")]:
        s = s.replace(src, dst)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    words = s.split()[:8]
    slug = re.sub(r"-+", "-", "-".join(words)).strip("-")
    return f"{slug}-{short_id}" if slug else short_id


def slugify_politician(nombre_completo, party=""):
    """URL-safe slug from an MEP's formatted name + short party name."""
    s = f"{format_nombre(nombre_completo)} {party}".strip().lower()
    for src, dst in [("á","a"),("à","a"),("ä","a"),("â","a"),("ã","a"),("å","a"),
                     ("é","e"),("è","e"),("ë","e"),("ê","e"),
                     ("í","i"),("ì","i"),("ï","i"),("î","i"),
                     ("ó","o"),("ò","o"),("ö","o"),("ô","o"),("õ","o"),
                     ("ú","u"),("ù","u"),("ü","u"),("û","u"),
                     ("ñ","n"),("ç","c")]:
        s = s.replace(src, dst)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    slug = re.sub(r"-+", "-", "-".join(s.split())).strip("-")
    return slug or "unknown"


# ── HTML renderers (mirror app.js) ────────────────────────────────────────────

def to_list_items(text):
    return [s.strip() for s in re.split(r"\n|;", re.sub(r"^[\s\-•*\d.]+", "", text))
            if s.strip()]


def render_errores(raw):
    if not is_valid(raw):
        return ""
    try:
        parsed = json.loads(raw)
        items = [str(i) for i in (parsed if isinstance(parsed, list) else [parsed]) if i]
    except (json.JSONDecodeError, TypeError):
        items = [raw.strip()] if raw and raw.strip() else []
    if not items:
        return ""
    inner = "<br><br>".join(f"<em>{esc(capitalize(i))}</em>" for i in items)
    return (
        f'<div class="detail-row detail-errores">\n'
        f'    <dt>Error detected</dt>\n'
        f'    <dd>{inner}</dd>\n'
        f'  </div>'
    )


def render_omisiones(raw):
    if not is_valid(raw):
        return ""
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        items = to_list_items(raw)
    if not isinstance(items, list) or not items:
        return ""
    lis = "".join(f"<li>{esc(capitalize(str(i)))}</li>" for i in items)
    return (
        f'<div class="detail-row">\n'
        f'    <dt>Omissions</dt>\n'
        f'    <dd><ul class="detail-list omisiones">{lis}</ul></dd>\n'
        f'  </div>'
    )


def render_fuentes(raw):
    if not is_valid(raw):
        return ""
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        plain = to_list_items(raw)
        if not plain:
            return ""
        lis = "".join(f"<li>{esc(i)}</li>" for i in plain)
        return (
            f'<div class="detail-row">\n'
            f'    <dt>Sources</dt>\n'
            f'    <dd><ul class="detail-list fuentes">{lis}</ul></dd>\n'
            f'  </div>'
        )
    if not isinstance(items, list) or not items:
        return ""

    sorted_items = sorted(items, key=lambda s: FUENTE_TIPO_ORDER.get(s.get("tipo", ""), 9))

    bullets = []
    for s in sorted_items:
        tipo       = s.get("tipo", "")
        is_primary = tipo in ("Primaria", "Primary")
        tipo_label = FUENTE_TIPO_LABELS.get(tipo, tipo or "")
        tipo_key   = re.sub(r"[^a-z]", "", tipo_label.lower()) or "other"
        name       = esc(s.get("nombre") or "Source")
        url        = s.get("url", "")
        link       = (f'<a class="source-link" href="{esc(url)}" target="_blank" rel="noopener">{name}</a>'
                      if url else f"<span>{name}</span>")
        tipo_badge = (f'<span class="source-tipo source-tipo--{tipo_key}">{esc(tipo_label)}</span>'
                      if tipo_label else "")
        dato       = s.get("dato_especifico", "")
        dato_html  = f'<span class="source-dato">{esc(dato)}</span>' if dato else ""
        css_class  = "fuente-item fuente-item--primary" if is_primary else "fuente-item"
        bullets.append(f'<li class="{css_class}">{tipo_badge}{link}{dato_html}</li>')

    lis = "".join(bullets)
    return (
        f'<div class="detail-row">\n'
        f'    <dt>Sources</dt>\n'
        f'    <dd><ul class="detail-list fuentes">{lis}</ul></dd>\n'
        f'  </div>'
    )


# ── ClaimReview schema.org ────────────────────────────────────────────────────

def build_claim_review_schema(claim, slug, pol_name, session_date):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    resultado_key = (v.get("resultado") or "").upper()
    rating_val, rating_name = CLAIM_REVIEW_RATINGS.get(resultado_key, (3, "Unverifiable"))
    claim_text = str(claim.get("texto_normalizado") or "").strip()
    claim_url = f"{BASE_URL}/claim/{slug}.html"
    published_date = session_date or TODAY

    item_reviewed = {
        "@type": "Claim",
        "name": claim_text,
        "datePublished": published_date,
        "appearance": {
            "@type": "CreativeWork",
            "name": "European Parliament debate intervention",
            "datePublished": published_date,
        },
    }
    if pol_name:
        item_reviewed["author"] = {
            "@type": "Person",
            "name": pol_name,
        }

    schema = {
        "@context": "https://schema.org",
        "@type": "ClaimReview",
        "@id": f"{claim_url}#claimreview",
        "url": claim_url,
        "headline": f"Fact check: {claim_text[:95]}",
        "claimReviewed": claim_text,
        "datePublished": published_date,
        "dateModified": TODAY,
        "inLanguage": "en",
        "author": {
            "@type": "Organization",
            "name": "Facthem EU",
            "url": BASE_URL,
            "sameAs": ["https://twitter.com/facthem_eu"],
        },
        "itemReviewed": item_reviewed,
        "reviewRating": {
            "@type": "Rating",
            "ratingValue": rating_val,
            "bestRating": 5,
            "worstRating": 1,
            "alternateName": rating_name,
            "name": rating_name,
        },
    }
    return json.dumps(schema, ensure_ascii=False, indent=2)


# ── Page renderer ─────────────────────────────────────────────────────────────

def render_page(claim, slug, session_date):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    pol = claim.get("politician") or {}

    resultado_class = resultado_to_class(v.get("resultado"))
    resultado_label = format_resultado(v.get("resultado"))
    score_raw       = v.get("confidence_score")
    score           = round(float(score_raw) * 100) if score_raw is not None else None
    claim_id        = claim["id"]

    pol_nombre = format_nombre(pol.get("nombre_completo", ""))
    pol_grupo  = pol.get("grupo_parlamentario", "")
    is_eu_com  = pol_grupo == "EU Commission"

    texto_norm = capitalize(str(claim.get("texto_normalizado") or "").strip())
    texto_orig = str(claim.get("texto_original") or "").strip()

    # ── Meta ──
    title = (f"{pol_nombre} — {resultado_label} | Facthem EU"
             if pol_nombre else f"{resultado_label} | Facthem EU")
    desc_text = str(claim.get("texto_normalizado") or "").strip()
    desc      = (desc_text[:157] + "…") if len(desc_text) > 160 else desc_text
    canon_url = f"{BASE_URL}/claim/{slug}.html"
    schema_ld = build_claim_review_schema(claim, slug, pol_nombre, session_date)

    # ── Back URL ──
    session_id = claim.get("session_id", "")
    back_url   = f"{BASE_URL}/?session={session_id}" if session_id else f"{BASE_URL}/"

    # ── Share text (mirrors buildShareText in app.js) ──
    resultado_key  = (v.get("resultado") or "").upper()
    verdict_emoji  = RESULTADO_EMOJIS.get(resultado_key, "🔍")
    nombre_share   = pol_nombre or "An MEP"
    partido_share  = f" ({pol_grupo})" if pol_grupo else ""
    texto_share    = desc_text[:200] + ("…" if len(desc_text) > 200 else "")
    share_text     = (
        f'🔍 {nombre_share}{partido_share} stated: "{texto_share}"\n'
        f'{verdict_emoji} {resultado_label} | facthem.eu'
    )

    # ── Share URLs ──
    enc_url     = urllib.parse.quote(canon_url)
    enc_text    = urllib.parse.quote(share_text)
    enc_wa      = urllib.parse.quote(f"{share_text}\n{canon_url}")
    url_twitter = f"https://twitter.com/intent/tweet?text={enc_text}&url={enc_url}&via=facthem_eu"
    url_wa      = f"https://wa.me/?text={enc_wa}"
    url_fb      = f"https://www.facebook.com/sharer/sharer.php?u={enc_url}"
    url_tg      = f"https://t.me/share/url?url={enc_url}&text={enc_text}"

    # ── Politician line ──
    if pol_nombre:
        if is_eu_com:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{esc(pol_nombre)}'
                f'<span class="politician-gobierno" title="EU Commission">🏛️</span>'
                f'</span>'
            )
        elif pol_grupo:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{esc(pol_nombre)}'
                f'<span class="politician-partido">· {esc(pol_grupo)}</span>'
                f'</span>'
            )
        else:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{esc(pol_nombre)}</span>'
            )
    else:
        pol_html = '<span class="politician-name unknown">Unknown MEP</span>'

    # ── Tags ──
    tag_parts = []
    tematico = claim.get("ambito_tematico", "")
    geo      = claim.get("ambito_geografico", "")
    if tematico:
        label = TEMATICO_LABELS.get(tematico, snake_to_label(tematico))
        tag_parts.append(f'<span class="tag tag-tematico">{esc(label)}</span>')
    if geo:
        tag_parts.append(f'<span class="tag tag-geo">{esc(snake_to_label(geo))}</span>')
    tags_html = (
        f'<div class="claim-tags" style="margin-bottom:1.25rem">{"".join(tag_parts)}</div>'
        if tag_parts else ""
    )

    # ── Confidence bar ──
    confidence_html = ""
    if score is not None:
        confidence_html = (
            f'<div class="confidence-bar" style="margin-bottom:1rem" '
            f'title="Model confidence: {score}%">\n'
            f'      <div class="confidence-track" style="width:160px">\n'
            f'        <div class="confidence-fill confidence-{resultado_class}" '
            f'style="width:{score}%"></div>\n'
            f'      </div>\n'
            f'      <span class="confidence-label">{score}% confidence</span>\n'
            f'    </div>'
        )

    # ── Detail list ──
    detail_parts = [
        render_errores(v.get("errores")),
        render_omisiones(v.get("omisiones")),
        render_fuentes(v.get("fuentes")),
    ]
    detail_inner = "\n  ".join(p for p in detail_parts if p)
    details_html = f'<dl class="modal-detail-list">\n  {detail_inner}\n</dl>' if detail_inner else ""

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}" />
  <link rel="canonical" href="{esc(canon_url)}" />

  <!-- Open Graph -->
  <meta property="og:type"        content="article" />
  <meta property="og:url"         content="{esc(canon_url)}" />
  <meta property="og:title"       content="{esc(title)}" />
  <meta property="og:description" content="{esc(desc)}" />
  <meta property="og:image"       content="{BASE_URL}/assets/portada.webp" />
  <meta property="og:locale"      content="en_GB" />
  <meta property="og:site_name"   content="Facthem EU" />

  <!-- Twitter / X -->
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@facthem_eu" />
  <meta name="twitter:title"       content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(desc)}" />
  <meta name="twitter:image"       content="{BASE_URL}/assets/portada.webp" />

  <!-- Favicon -->
  <link rel="icon" href="../assets/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="../assets/favicon-16x16.png" />
  <link rel="apple-touch-icon" href="../assets/apple-touch-icon.png" />
  <meta name="theme-color" content="#080d14" />

  <!-- ClaimReview structured data -->
  <script type="application/ld+json">
{schema_ld}
  </script>

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preload"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
        as="style" onload="this.onload=null;this.rel='stylesheet'" />
  <noscript>
    <link rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" />
  </noscript>

  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-49K9GGWS5K"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){{dataLayer.push(arguments);}}
    gtag('js', new Date());
    gtag('config', 'G-49K9GGWS5K');
  </script>

  <!-- Site styles -->
  <link rel="stylesheet" href="../css/style.css" />

  <style>
    body {{
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 2.5rem 1.25rem 4rem;
    }}

    /* ── Card: same as #modal-card but standalone ── */
    #modal-card {{
      max-height: none;
      animation: none;
    }}
    #modal-content {{
      padding-top: 2.5rem;
    }}

    /* ── Back button — sits where ✕ was ── */
    .cp-back {{
      position: absolute;
      top: 1rem;
      right: 1rem;
      background: rgba(255,255,255,.06);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-xs);
      color: var(--c-text-muted);
      font-size: .78rem;
      font-weight: 600;
      font-family: inherit;
      padding: .35rem .65rem;
      text-decoration: none;
      cursor: pointer;
      transition: background .12s, color .12s;
      display: inline-flex;
      align-items: center;
      gap: .3rem;
    }}
    .cp-back:hover {{
      background: rgba(255,255,255,.12);
      color: var(--c-text);
    }}

    /* ── Share button ─────────────────────────────────────────────────────── */
    .claim-actions {{
      display: flex;
      align-items: center;
      gap: .5rem;
      margin-top: 1.25rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--c-border);
    }}

    .share-wrapper {{ position: relative; margin-left: 0; }}

    .share-btn {{
      background: none;
      border: 1px solid var(--c-border);
      border-radius: var(--radius-xs);
      padding: .3rem .5rem;
      color: var(--c-text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: .35rem;
      font-size: .75rem;
      font-weight: 600;
      font-family: inherit;
      transition: border-color .12s, color .12s;
    }}
    .share-btn:hover {{
      border-color: var(--c-accent);
      color: var(--c-accent);
    }}

    .share-menu {{
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      right: auto;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-md);
      min-width: 160px;
      z-index: 200;
      overflow: hidden;
    }}
    .share-menu[hidden] {{ display: none; }}

    .share-option {{
      display: flex;
      align-items: center;
      gap: .5rem;
      width: 100%;
      padding: .55rem .875rem;
      font-size: .8rem;
      font-family: inherit;
      font-weight: 500;
      color: var(--c-text);
      background: none;
      border: none;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      transition: background .1s;
    }}
    .share-option:hover {{ background: rgba(255,255,255,.06); }}

    /* ── Subtle brand footer ── */
    .cp-brand {{
      margin-top: 1.5rem;
      font-size: .65rem;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--c-text-muted);
      opacity: .35;
    }}
  </style>
</head>
<body>

  <div id="modal-card" data-resultado="{resultado_class}">

    <!-- Back button where ✕ used to be -->
    <a class="cp-back" href="{back_url}" id="cp-back-btn">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Back
    </a>

    <div id="modal-content">

      <header class="claim-header" style="margin-bottom:1.25rem">
        <div class="claim-meta-top">
          {pol_html}
        </div>
        <span class="resultado-badge resultado-{resultado_class}">{esc(resultado_label)}</span>
      </header>

      <blockquote class="claim-text modal-claim-text" title="{esc(texto_orig)}">
        {esc(texto_norm)}
      </blockquote>

      {confidence_html}

      {tags_html}

      {details_html}

      <div class="claim-actions">
        <div class="share-wrapper">
          <button class="share-btn" id="share-btn" aria-label="Share claim">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            <span>Share</span>
          </button>
          <div class="share-menu" id="share-menu" hidden>
            <a class="share-option" href="{url_wa}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 0C5.373 0 0 5.373 0 12c0 2.127.557 4.123 1.532 5.856L0 24l6.335-1.652A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
              WhatsApp
            </a>
            <a class="share-option" href="{url_twitter}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              X / Twitter
            </a>
            <a class="share-option" href="{url_fb}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
              Facebook
            </a>
            <a class="share-option" href="{url_tg}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              Telegram
            </a>
            <button class="share-option share-copy-btn" id="cp-copy" data-url="{esc(canon_url)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <span>Copy link</span>
            </button>
          </div>
        </div>
      </div>

    </div>
  </div>

  <p class="cp-brand">
    <a href="{BASE_URL}/" style="color:inherit;text-decoration:none">facthem.eu</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/methodology.html" style="color:inherit;text-decoration:none">Methodology</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/about.html" style="color:inherit;text-decoration:none">About</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/legal.html" style="color:inherit;text-decoration:none">Legal</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/archive.html" style="color:inherit;text-decoration:none">All claims</a>
  </p>

  <script>
    var shareBtn = document.getElementById('share-btn');
    var shareMenu = document.getElementById('share-menu');
    shareBtn.addEventListener('click', function (e) {{
      e.stopPropagation();
      shareMenu.hidden = !shareMenu.hidden;
    }});

    document.addEventListener('click', function () {{
      shareMenu.hidden = true;
    }});

    document.getElementById('cp-copy').addEventListener('click', function (e) {{
      e.stopPropagation();
      navigator.clipboard.writeText(this.dataset.url).then(() => {{
        this.querySelector('span').textContent = 'Copied!';
        setTimeout(() => {{ this.querySelector('span').textContent = 'Copy link'; }}, 2000);
      }});
    }});

    // Back button: use history.back() when coming from the same site
    // (restores tab + session + scroll). Falls through to the ?session= href
    // when arriving from a share link or external source.
    (function () {{
      try {{
        var ref = document.referrer;
        if (ref && new URL(ref).origin === location.origin) {{
          document.getElementById('cp-back-btn').addEventListener('click', function (e) {{
            e.preventDefault();
            history.back();
          }});
        }}
      }} catch (e) {{}}
    }})();
  </script>

</body>
</html>
"""


# ── Supabase fetch ────────────────────────────────────────────────────────────

SELECT_FIELDS = """
  id, session_id, texto_normalizado, texto_original,
  ambito_geografico, ambito_tematico,
  politician:politician_id (nombre_completo, partido, grupo_parlamentario),
  verification (resultado, confidence_score, omisiones, errores, fuentes)
"""


def _sqlite_conn():
    con = sqlite3.connect(DEBUG_DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def fetch_all_claims_sqlite():
    con = _sqlite_conn()
    total = con.execute("SELECT COUNT(*) FROM claim").fetchone()[0]
    print(f"  SQLite reports {total} claims in the claim table")
    rows = con.execute("""
        SELECT c.id, c.session_id, c.texto_normalizado, c.texto_original,
               c.ambito_geografico, c.ambito_tematico,
               p.nombre_completo AS pol_nombre, p.partido AS pol_partido, p.grupo_parlamentario AS pol_grupo,
               v.resultado, v.confidence_score, v.omisiones, v.errores, v.fuentes
        FROM claim c
        LEFT JOIN politician p ON p.id = c.politician_id
        LEFT JOIN verification v ON v.claim_id = c.id
    """).fetchall()
    con.close()
    claims = []
    for r in rows:
        pol = None
        if r["pol_nombre"]:
            pol = {"nombre_completo": r["pol_nombre"],
                   "partido": r["pol_partido"],
                   "grupo_parlamentario": r["pol_grupo"]}
        ver = []
        if r["resultado"]:
            ver = [{"resultado": r["resultado"],
                    "confidence_score": r["confidence_score"],
                    "omisiones": r["omisiones"],
                    "errores": r["errores"],
                    "fuentes": r["fuentes"]}]
        claims.append({
            "id": r["id"], "session_id": r["session_id"],
            "texto_normalizado": r["texto_normalizado"],
            "texto_original": r["texto_original"],
            "ambito_geografico": r["ambito_geografico"],
            "ambito_tematico": r["ambito_tematico"],
            "politician": pol,
            "verification": ver,
        })
    return claims


def fetch_session_dates_sqlite():
    con = _sqlite_conn()
    rows = con.execute("SELECT id, fecha FROM session").fetchall()
    con.close()
    return {r["id"]: (r["fecha"] or "")[:10] for r in rows}


def fetch_all_claims(supabase):
    """Paginate through all claims (Supabase default page = 1 000 rows)."""
    all_claims, page_size, offset = [], 1000, 0
    while True:
        resp = (
            supabase.from_("claim")
            .select(SELECT_FIELDS)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        all_claims.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return all_claims


def fetch_session_dates(supabase):
    """Returns {session_id: fecha_iso_string}."""
    resp = supabase.from_("session").select("id, fecha").execute()
    return {s["id"]: (s["fecha"] or "")[:10] for s in (resp.data or [])}


# ── Sitemap ───────────────────────────────────────────────────────────────────

STATIC_URLS = [
    ("https://facthem.eu/",           "2026-04-13T00:00:00+00:00", "weekly",  "1.0"),
    ("https://facthem.eu/legal.html",       "2026-04-13T00:00:00+00:00", "yearly",  "0.3"),
    ("https://facthem.eu/methodology.html", "2026-04-30T00:00:00+00:00", "yearly",  "0.4"),
    ("https://facthem.eu/about.html",       "2026-04-30T00:00:00+00:00", "yearly",  "0.4"),
    ("https://facthem.eu/blog.html",  "2026-05-06T00:00:00+00:00", "monthly", "0.5"),
]


def _iso(date_str):
    """Convert YYYY-MM-DD (or already full ISO) to full ISO-8601 with UTC offset."""
    if not date_str:
        return f"{TODAY}T00:00:00+00:00"
    if "T" in date_str:
        return date_str
    return f"{date_str}T00:00:00+00:00"


def _loc(url):
    """XML-escape a URL for use inside <loc>. Slugs are ASCII-safe but guard anyway."""
    return (url.replace("&", "&amp;")
               .replace('"', "&quot;")
               .replace("'", "&apos;")
               .replace("<", "&lt;")
               .replace(">", "&gt;"))


def _write_urlset(path, entries):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]
    for loc, lastmod, changefreq, priority in entries:
        parts.append(
            f"  <url>\n    <loc>{_loc(loc)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
        )
    parts.append("</urlset>\n")
    path.write_bytes("".join(parts).encode("utf-8"))


def _write_sitemap_index(paths):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]
    for path in paths:
        parts.append(
            f"  <sitemap>\n    <loc>{_loc(f'{BASE_URL}/{path.name}')}</loc>\n"
            f"    <lastmod>{_iso(TODAY)}</lastmod>\n  </sitemap>\n"
        )
    parts.append("</sitemapindex>\n")
    SITEMAP_PATH.write_bytes("".join(parts).encode("utf-8"))


def update_sitemap(slug_dates, politician_slugs):
    static_entries = list(STATIC_URLS)

    politician_entries = []
    for slug in sorted(politician_slugs):
        url = f"{BASE_URL}/politician/{slug}.html"
        politician_entries.append((url, TODAY, "weekly", "0.6"))

    claim_entries = []
    for slug, lastmod in sorted(slug_dates.items()):
        url = f"{BASE_URL}/claim/{slug}.html"
        claim_entries.append((url, lastmod, "monthly", "0.7"))

    _write_urlset(SITEMAP_STATIC_PATH, static_entries)
    _write_urlset(SITEMAP_POLITICIANS_PATH, politician_entries)
    _write_urlset(SITEMAP_CLAIMS_PATH, claim_entries)
    _write_sitemap_index([SITEMAP_STATIC_PATH, SITEMAP_POLITICIANS_PATH, SITEMAP_CLAIMS_PATH])

    print(
        "  sitemap.xml index updated — "
        f"{len(static_entries)} static, {len(politician_entries)} MEPs, {len(claim_entries)} claim URLs"
    )


# ── Archive page ──────────────────────────────────────────────────────────────

ARCHIVE_PATH = Path(__file__).parent / "archive.html"


def generate_archive(claims_data):
    """
    Build a plain-HTML archive page listing every claim with a bare <a href>.
    No JS required — pure link graph for crawlers.
    Groups claims by MEP name alphabetically.
    """
    by_mep = {}
    for slug, claim in claims_data:
        pol = claim.get("politician") or {}
        name = format_nombre(pol.get("nombre_completo", "")) or "Unknown MEP"
        by_mep.setdefault(name, []).append((slug, claim))

    rows = []
    for name in sorted(by_mep):
        sample_pol = (by_mep[name][0][1].get("politician") or {}) if by_mep[name] else {}
        pol_slug = slugify_politician(
            sample_pol.get("nombre_completo", name),
            sample_pol.get("partido") or sample_pol.get("grupo_parlamentario") or "",
        )
        rows.append(f'  <h2><a href="{BASE_URL}/politician/{pol_slug}.html">{esc(name)}</a></h2>\n  <ul>')
        for slug, claim in by_mep[name]:
            text = esc(str(claim.get("texto_normalizado") or slug).strip()[:120])
            url  = f"{BASE_URL}/claim/{slug}.html"
            rows.append(f'    <li><a href="{url}">{text}</a></li>')
        rows.append("  </ul>")

    body = "\n".join(rows)
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>All claims archive — Facthem EU</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="canonical" href="{BASE_URL}/archive.html" />
  <link rel="stylesheet" href="css/style.css" />
  <style>
    .archive-page {{
      flex: 1;
      max-width: 900px;
      margin: 0 auto;
      width: 100%;
      padding: 3rem 1.75rem 5rem;
    }}
    .archive-page h1 {{
      font-size: 1.4rem;
      font-weight: 900;
      letter-spacing: -.03em;
      background: linear-gradient(135deg, #c9a020 0%, #b08800 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 2rem;
    }}
    .archive-page h2 {{
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--c-text-muted);
      margin: 2rem 0 .5rem;
    }}
    .archive-page ul {{
      margin: 0 0 .5rem;
      padding-left: 1.2rem;
    }}
    .archive-page li {{
      margin: .3rem 0;
      font-size: .88rem;
      line-height: 1.5;
    }}
    .archive-page a {{
      color: var(--c-accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(160,120,0,.3);
    }}
    .archive-page a:hover {{ border-color: var(--c-accent); }}
    .archive-back {{
      font-size: .85rem;
      color: var(--c-text-muted);
      margin-bottom: 2rem;
      display: block;
    }}
  </style>
</head>
<body>
  <header class="site-header">
    <nav class="tabs">
      <a href="{BASE_URL}/" class="tab-button" style="text-decoration:none">← Back</a>
    </nav>
  </header>
  <div class="archive-page">
    <h1>All claims</h1>
{body}
  </div>
</body>
</html>
"""
    ARCHIVE_PATH.write_text(page, encoding="utf-8")
    print(f"  archive.html written — {sum(len(v) for v in by_mep.values())} claims, {len(by_mep)} MEPs")


# ── Politician pages ──────────────────────────────────────────────────────────

def generate_politician_pages(claims_with_slugs):
    """One static page per MEP listing all their claims."""
    by_name = {}
    for claim_slug, claim in claims_with_slugs:
        pol = claim.get("politician") or {}
        nombre_completo = pol.get("nombre_completo", "")
        if not nombre_completo:
            continue
        party = pol.get("partido") or ""
        group = pol.get("grupo_parlamentario") or ""
        entry = by_name.setdefault(nombre_completo, {
            "nombre": format_nombre(nombre_completo),
            "party": party,
            "group": group,
            "claims": [],
        })
        if not entry["party"] and party:
            entry["party"] = party
        if not entry["group"] and group:
            entry["group"] = group
        entry["claims"].append((claim_slug, claim))

    by_slug = {}
    for nombre_completo, info in by_name.items():
        by_slug[slugify_politician(nombre_completo, info["party"] or info["group"])] = info

    POL_OUT_DIR.mkdir(exist_ok=True)
    for f in POL_OUT_DIR.glob("*.html"):
        f.unlink()

    for pol_slug, info in by_slug.items():
        _write_politician_page(pol_slug, info)

    print(f"  politician/ written — {len(by_slug)} pages")
    return list(by_slug.keys())


def _verdict_counts(claims):
    counts = {}
    for _, claim in claims:
        v = claim.get("verification") or []
        v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
        key = (v.get("resultado") or "UNVERIFIABLE").upper()
        counts[key] = counts.get(key, 0) + 1
    return counts


def _write_politician_page(pol_slug, info):
    nombre = info["nombre"]
    party = info["party"]
    group = info["group"]
    claims = sorted(
        info["claims"],
        key=lambda item: str(item[1].get("session_id") or ""),
        reverse=True,
    )
    pol_url = f"{BASE_URL}/politician/{pol_slug}.html"
    title = f"{nombre} — Verified claims | Facthem EU"
    desc = f"All claims by {nombre} verified by Facthem EU."
    if party:
        desc = f"Claims by {nombre} ({party}) verified by Facthem EU."

    counts = _verdict_counts(claims)
    stats_items = []
    for resultado, label in RESULTADO_LABELS.items():
        n = counts.get(resultado, 0)
        if n:
            cls = RESULTADO_TO_CLASS.get(resultado, "nv")
            stats_items.append(
                f'<span class="resultado-badge resultado-{cls}" style="font-size:.7rem">'
                f'{esc(label)}: {n}</span>'
            )
    stats_html = (
        f'<div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.5rem">'
        f'{"".join(stats_items)}</div>'
        if stats_items else ""
    )

    rows = []
    for claim_slug, claim in claims:
        v = claim.get("verification") or []
        v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
        resultado = (v.get("resultado") or "UNVERIFIABLE").upper()
        res_class = RESULTADO_TO_CLASS.get(resultado, "nv")
        res_label = RESULTADO_LABELS.get(resultado, snake_to_label(resultado))
        text = esc(capitalize(str(claim.get("texto_normalizado") or "").strip())[:180])
        claim_url = f"{BASE_URL}/claim/{claim_slug}.html"
        topic = claim.get("ambito_tematico")
        topic_html = (
            f'<span class="tag tag-tematico">{esc(TEMATICO_LABELS.get(topic, snake_to_label(topic)))}</span>'
            if topic else ""
        )
        topic_tags_html = f'<div class="claim-tags">{topic_html}</div>' if topic_html else ""
        rows.append(
            f'  <article class="claim-card" data-resultado="{res_class}" style="margin-bottom:.75rem">\n'
            f'    <header class="claim-header">\n'
            f'      <span class="resultado-badge resultado-{res_class}">{esc(res_label)}</span>\n'
            f'    </header>\n'
            f'    <blockquote class="claim-text" style="margin:.5rem 0 .75rem">\n'
            f'      <a href="{claim_url}" style="color:inherit;text-decoration:none">{text}</a>\n'
            f'    </blockquote>\n'
            f'    {topic_tags_html}\n'
            f'  </article>'
        )
    claims_html = "\n".join(rows)

    subtitle_parts = []
    if party:
        subtitle_parts.append(esc(party))
    if group and group != party:
        subtitle_parts.append(esc(group))
    subtitle_html = (
        f'<p style="font-size:.82rem;color:var(--c-text-muted);margin:.25rem 0 2rem">'
        f'{"&nbsp;·&nbsp;".join(subtitle_parts)}</p>'
        if subtitle_parts else '<div style="margin-bottom:2rem"></div>'
    )

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}" />
  <link rel="canonical" href="{esc(pol_url)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="{esc(pol_url)}" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(desc)}" />
  <meta property="og:image" content="{BASE_URL}/assets/portada.webp" />
  <meta property="og:locale" content="en_GB" />
  <meta property="og:site_name" content="Facthem EU" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@facthem_eu" />
  <meta name="twitter:title" content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(desc)}" />
  <meta name="twitter:image" content="{BASE_URL}/assets/portada.webp" />
  <link rel="icon" href="../assets/favicon.ico" sizes="any" />
  <link rel="stylesheet" href="../css/style.css" />
  <style>
    .pol-page {{
      max-width: 760px;
      margin: 0 auto;
      width: 100%;
      padding: 3rem 1.25rem 5rem;
    }}
    .pol-page h1 {{
      font-size: 1.55rem;
      font-weight: 900;
      letter-spacing: -.03em;
      background: linear-gradient(135deg, #d7c58a 0%, #9f8430 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: .15rem;
    }}
    .pol-back {{
      font-size: .85rem;
      color: var(--c-text-muted);
      margin-bottom: 2rem;
      display: inline-block;
      text-decoration: none;
    }}
    .pol-back:hover {{ color: var(--c-accent); }}
  </style>
</head>
<body>
  <div class="pol-page">
    <a class="pol-back" href="{BASE_URL}/?tab=meps&amp;politician={esc(pol_slug)}">← Back to Facthem EU</a>
    <h1>{esc(nombre)}</h1>
    {subtitle_html}
    {stats_html}
    <p style="font-size:.82rem;color:var(--c-text-muted);margin:0 0 1rem">{len(claims)} verified claim{'s' if len(claims) != 1 else ''}</p>
{claims_html}
  </div>
</body>
</html>
"""
    (POL_OUT_DIR / f"{pol_slug}.html").write_text(page, encoding="utf-8")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if USE_SQLITE:
        print(f"DEBUG mode: reading local SQLite ({DEBUG_DB_PATH})")
        print("Fetching claims…")
        claims = fetch_all_claims_sqlite()
        print(f"  {len(claims)} claims fetched")
        print("Fetching session dates…")
        session_dates = fetch_session_dates_sqlite()
    else:
        if not SUPABASE_URL or not SUPABASE_ANON:
            sys.exit("SUPABASE_URL and SUPABASE_ANON must be set in the environment")
        print("Connecting to Supabase…")
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON)
        print("Fetching claims…")
        claims = fetch_all_claims(supabase)
        print(f"  {len(claims)} claims fetched")
        print("Fetching session dates…")
        session_dates = fetch_session_dates(supabase)

    OUT_DIR.mkdir(exist_ok=True)
    for f in OUT_DIR.glob("*.html"):
        f.unlink()

    generated, errors = {}, []

    print("Generating pages…")
    for claim in claims:
        try:
            slug         = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            session_date = session_dates.get(claim.get("session_id"), "")
            OUT_DIR.mkdir(exist_ok=True)
            (OUT_DIR / f"{slug}.html").write_text(
                render_page(claim, slug, session_date), encoding="utf-8"
            )
            generated[slug] = session_date or TODAY
        except Exception as exc:
            errors.append((claim.get("id"), str(exc)))

    print(f"  {len(generated)} pages written to claim/")
    if errors:
        print(f"  {len(errors)} error(s):")
        for cid, err in errors[:20]:
            print(f"    claim {cid}: {err}")

    claims_with_slugs = []
    for claim in claims:
        try:
            slug = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            claims_with_slugs.append((slug, claim))
        except Exception:
            pass

    print("Generating politician pages…")
    politician_slugs = generate_politician_pages(claims_with_slugs)

    print("Updating sitemap…")
    update_sitemap(generated, politician_slugs)

    print("Generating archive page…")
    generate_archive(claims_with_slugs)

    print("Done.")


if __name__ == "__main__":
    main()
