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
import sys
from datetime import date
from pathlib import Path

try:
    from supabase import create_client
except ImportError:
    sys.exit("supabase package not installed.  Run: pip install -r requirements.txt")

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ.get("SUPABASE_URL",  "https://ekjwtubwiyogmrrzuqaa.supabase.co")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON", "sb_publishable_vXpAYlgmIUm2T7XszzPu2w_TlAxfqgR")
BASE_URL      = "https://facthem.eu"
OUT_DIR       = Path(__file__).parent / "claim"
SITEMAP_PATH  = Path(__file__).parent / "sitemap.xml"
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
    """First 8 words of text, URL-safe, prefixed with claim ID."""
    s = str(text or "").strip().lower()
    # basic accent normalisation
    for src, dst in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),
                     ("ä","a"),("ö","o"),("ü","u"),("ñ","n"),("ç","c")]:
        s = s.replace(src, dst)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    words = s.split()[:8]
    slug = re.sub(r"-+", "-", "-".join(words)).strip("-")
    return f"{claim_id}-{slug}" if slug else str(claim_id)


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

    schema = {
        "@context": "https://schema.org",
        "@type": "ClaimReview",
        "url": f"{BASE_URL}/claim/{slug}/",
        "claimReviewed": str(claim.get("texto_normalizado") or "").strip(),
        "datePublished": session_date or TODAY,
        "author": {
            "@type": "Organization",
            "name": "Facthem EU",
            "url": BASE_URL,
            "sameAs": ["https://twitter.com/facthem_eu"],
        },
        "reviewRating": {
            "@type": "Rating",
            "ratingValue": rating_val,
            "bestRating": 5,
            "worstRating": 1,
            "alternateName": rating_name,
        },
    }
    if pol_name:
        schema["itemReviewed"] = {
            "@type": "Claim",
            "author": {"@type": "Person", "name": pol_name},
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
    canon_url = f"{BASE_URL}/claim/{slug}/"
    schema_ld = build_claim_review_schema(claim, slug, pol_nombre, session_date)

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
  <link rel="icon" href="/assets/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png" />
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
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

  <!-- Site styles (absolute path — resolves from domain root on GitHub Pages) -->
  <link rel="stylesheet" href="/css/style.css" />

  <style>
    /* ── Claim page layout ── */
    body {{
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }}
    .cp-nav {{
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: .875rem 1.5rem;
      border-bottom: 1px solid var(--c-border);
      background: var(--c-surface);
      position: sticky;
      top: 0;
      z-index: 10;
    }}
    .cp-back {{
      color: var(--c-text-muted);
      text-decoration: none;
      font-size: .82rem;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      transition: color .12s;
    }}
    .cp-back:hover {{ color: var(--c-text); }}
    .cp-logo {{
      margin-left: auto;
      font-weight: 800;
      font-size: .9rem;
      color: var(--c-accent);
      text-decoration: none;
      letter-spacing: -.01em;
    }}
    .cp-main {{
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2.5rem 1.25rem 4rem;
    }}
    /* Strip modal-specific overrides so the card renders as a normal block */
    #modal-card {{
      max-height: none;
      animation: none;
    }}
    #modal-content {{
      padding-top: 0;
    }}
    .cp-view-live {{
      margin-top: 1.25rem;
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      color: var(--c-text-muted);
      text-decoration: none;
      font-size: .8rem;
      font-weight: 500;
      border: 1px solid var(--c-border);
      border-radius: var(--radius-xs);
      padding: .4rem .9rem;
      transition: border-color .12s, color .12s;
    }}
    .cp-view-live:hover {{ border-color: var(--c-accent); color: var(--c-accent); }}
  </style>
</head>
<body>

  <nav class="cp-nav">
    <a class="cp-back" href="{BASE_URL}/">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Back
    </a>
    <a class="cp-logo" href="{BASE_URL}/">Facthem.eu</a>
  </nav>

  <main class="cp-main">
    <div id="modal-card" data-resultado="{resultado_class}">
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

      </div>
    </div>

    <a class="cp-view-live" href="{BASE_URL}/?claim={claim_id}">
      View on Facthem
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </a>
  </main>

</body>
</html>
"""


# ── Supabase fetch ────────────────────────────────────────────────────────────

SELECT_FIELDS = """
  id, session_id, texto_normalizado, texto_original,
  ambito_geografico, ambito_tematico,
  politician:politician_id (nombre_completo, grupo_parlamentario),
  verification (resultado, confidence_score, omisiones, errores, fuentes)
"""


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
    ("https://facthem.eu/",           "2026-04-13", "weekly",  "1.0"),
    ("https://facthem.eu/aviso.html", "2026-04-13", "yearly",  "0.3"),
    ("https://facthem.eu/blog.html",  "2026-04-13", "monthly", "0.5"),
]


def update_sitemap(claim_slugs):
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for loc, lastmod, changefreq, priority in STATIC_URLS:
        lines.append(
            f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{lastmod}</lastmod>\n"
            f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>"
        )
    for slug in sorted(claim_slugs):
        lines.append(
            f"  <url>\n    <loc>{BASE_URL}/claim/{slug}/</loc>\n"
            f"    <lastmod>{TODAY}</lastmod>\n    <changefreq>monthly</changefreq>\n"
            f"    <priority>0.7</priority>\n  </url>"
        )
    lines.append("</urlset>")
    SITEMAP_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  sitemap.xml updated — {len(claim_slugs)} claim URLs")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Connecting to Supabase…")
    supabase = create_client(SUPABASE_URL, SUPABASE_ANON)

    print("Fetching claims…")
    claims = fetch_all_claims(supabase)
    print(f"  {len(claims)} claims fetched")

    print("Fetching session dates…")
    session_dates = fetch_session_dates(supabase)

    OUT_DIR.mkdir(exist_ok=True)

    generated, errors = [], []

    print("Generating pages…")
    for claim in claims:
        try:
            slug         = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            session_date = session_dates.get(claim.get("session_id"), "")
            page_dir     = OUT_DIR / slug
            page_dir.mkdir(exist_ok=True)
            (page_dir / "index.html").write_text(
                render_page(claim, slug, session_date), encoding="utf-8"
            )
            generated.append(slug)
        except Exception as exc:
            errors.append((claim.get("id"), str(exc)))

    print(f"  {len(generated)} pages written to claim/")
    if errors:
        print(f"  {len(errors)} error(s):")
        for cid, err in errors[:20]:
            print(f"    claim {cid}: {err}")

    print("Updating sitemap…")
    update_sitemap(generated)
    print("Done.")


if __name__ == "__main__":
    main()
