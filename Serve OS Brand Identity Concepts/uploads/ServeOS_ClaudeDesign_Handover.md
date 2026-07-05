# Serve OS — Complete Brand Handover for Claude Design

**Product:** Serve OS — an operating system for restaurants (QR menus, POS, WhatsApp ordering, reservations, inventory, analytics)
**Type:** B2B SaaS, sold to restaurants
**Domain:** serveos.cloud
**Languages:** English, Spanish, Arabic — Arabic is right-to-left (RTL)

---

## How to use this document

Work through it top to bottom:

1. **Read Part 1–2** so you know the intended brand. (Change anything you disagree with before you start.)
2. **Paste the Master Context Prompt (Part 3)** into Claude Design first. It loads the whole brand system so every later request stays consistent.
3. **Then paste the per-asset prompts (Part 4)** one at a time, in the order given. Each already contains its target dimensions.
4. **Follow the working notes (Part 5)** for iteration, export, and the two things to confirm with your developer.

A companion file, `ServeOS_Design_Asset_Spec.md`, holds the full dimensions reference. This document embeds the dimensions you need directly in each prompt, so you shouldn't have to cross-reference constantly.

---

# PART 1 — BRAND FOUNDATION

## What Serve OS is
Serve OS is the operating system restaurants run their business on. It replaces a drawer full of disconnected tools — a QR menu here, a POS there, a WhatsApp number, a booking sheet, a stock spreadsheet — with one platform. The name says it: **Serve** (hospitality, feeding people) + **OS** (the reliable system everything runs on).

## Who it's for
Restaurant owners and managers — small independents up to small chains. They are busy, non-technical, and care about two things: does it make service smoother, and does it make them money. The brand has to feel **capable enough to trust with the business, but friendly enough to not intimidate**.

## Brand personality
- **Trustworthy** — this runs their livelihood; it must feel solid and dependable.
- **Warm** — hospitality is human. Not a cold enterprise tool.
- **Modern & clear** — clean, uncluttered, confident. No visual noise.
- **Efficient** — every element earns its place, like good service.

Voice in three words: **dependable, warm, clear.**

## What to avoid
- Clichés: no forks/knives/plates-as-logo, no chef hats, no speech bubbles.
- Cold, generic "tech blue" corporate look.
- Gradients-everywhere, drop shadows, 3D, glassmorphism, skeuomorphism.
- Over-decoration. When in doubt, remove.

---

# PART 2 — VISUAL SYSTEM

## Logo concept
**Mark:** a connected triangle in Coral `#F0522B`. **Wordmark:** "ServeOS" set in Bricolage Grotesque 700, with the "OS" in Coral `#F0522B` and "Serve" in Ink `#1A0F0A` (or reversed to Paper on dark).

Requirements the mark must satisfy: it must work **on its own** (it becomes the app icon and favicon) and stay legible shrunk to a **16px** favicon. The connected-triangle form reads as network/flow/intelligence — reflecting the online-ordering + POS + AI-analytics positioning — rather than a literal hospitality cliché.

## Color system

Coral leads as the primary brand color; teal is reserved for the **data / AI** side of the product. Neutrals are a warm "Sand" family, not cold gray.

### Primary — Coral
| Token | Hex | Use |
|---|---|---|
| **Coral (PRIMARY)** | `#F0522B` | Primary brand color, buttons, key UI |
| Coral Deep | `#D23F1C` | Hover / pressed |
| Coral Soft | `#FBE3DA` | Tints, badges |

### Accent — Teal (data / AI)
| Token | Hex | Use |
|---|---|---|
| **Teal (ACCENT)** | `#0FB5A6` | Data, AI, analytics accents |
| Teal Deep | `#0A8478` | Hover / pressed |
| Teal Soft | `#DBF3F0` | Tints |

### Neutrals — warm "Sand"
| Token | Hex | Use |
|---|---|---|
| Paper | `#FBF7F2` | App background |
| Sand 50 | `#F4EDE4` | |
| Sand 100 | `#E9E0D6` | Borders / dividers |
| Sand 200 | `#D8CCBE` | |
| Sand 300 | `#B9AB9A` | |
| Sand 500 | `#6E6459` | Muted text |
| Sand 700 | `#3A332C` | Body text |
| Ink | `#1A0F0A` | Headings |

### Semantic (solid / soft)
| Token | Solid | Soft |
|---|---|---|
| Success | `#1F8A5B` | `#DDF0E6` |
| Warning | `#E8A33D` | `#FBEED6` |
| Error | `#CE2C2C` | `#F8DFDC` |
| Info | `#2E6BFF` | `#DEE8FF` |

### Dark mode
| Token | Hex |
|---|---|
| Canvas | `#140D08` |
| Surface | `#211610` |
| Elevated | `#2C1F16` |
| Text | `#FBF1EC` |
| Text muted | `#B9AB9A` |
| Border | `rgba(255,255,255,0.10)` |
| Coral | `#FF6B45` |
| Teal | `#2DD4C4` |
| Success | `#38D08C` |
| Warning | `#F5BE5C` |
| Error | `#F26D5F` |
| Info | `#6E9BFF` |

## Typography
Trilingual set (covers Latin and Arabic), loaded from Google Fonts:

- **Display / brand (wordmark, headings):** Bricolage Grotesque — weights 600/700/800.
- **UI / body:** Space Grotesk — weights 400/500/700.
- **Arabic / RTL (all Arabic text):** IBM Plex Sans Arabic — weights 400/600/700.
- **Monospace (data, prices, order IDs):** JetBrains Mono — weights 400/500.

Google Fonts embed:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Sans+Arabic:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

## Iconography style
Geometric line icons, **2px stroke, rounded joins and caps, on a 24px grid.** Consistent optical weight. Minimal fills; use Coral `#F0522B` for active, Sand 500 `#6E6459` for default; reserve Teal `#0FB5A6` for data/analytics icons. This single style covers navigation, actions, and features.

## Illustration style
Flat, two-tone (coral + teal) over warm Sand neutrals, with generous negative space. Friendly and simple — for empty states and marketing spots. No gradients, no fine detail, no realism.

## Photography / imagery
When real photos are used (marketing, menu context): warm, natural light, authentic restaurant moments — hands, plates, service in motion. Avoid sterile stock photography.

## Shape & spacing language
Rounded corners (8–12px on cards, 6px on inputs, pill or 8px on buttons). Generous padding. Calm, breathable layouts. The overall feeling is "clean, warm, organized."

---

# PART 3 — MASTER CONTEXT PROMPT (paste this into Claude Design FIRST)

Choose **one** of the two versions below and paste it as your first message to Claude Design.

- **Option A — Prescribed system:** you hand over the finished brand (the colors, fonts, and logo concept in Part 2) and Claude Design executes it. Use this if you're happy with the teal + coral direction.
- **Option B — Let Claude Design decide:** you hand over only the context and personality, and it proposes 2–3 complete brand directions for you to choose from. Use this if you'd rather see options first.

Either way, once the system is set, the per-asset prompts in Part 4 work unchanged.

## Option A — Prescribed system

```
You are helping me build the complete brand identity and asset set for
Serve OS — a B2B SaaS platform that is an operating system for restaurants
(QR menus, POS, WhatsApp ordering, reservations, inventory, analytics). It's
sold to restaurant owners and managers who are busy and non-technical. It
runs in English, Spanish, and Arabic (Arabic is right-to-left).

Hold this brand system for everything you design from now on:

BRAND PERSONALITY: dependable, warm, confident, and intelligent. Trustworthy
enough to run a business on, friendly enough not to intimidate. Modern and
alive — hospitality software with a smart, data-driven edge, not cold
enterprise tech.

POSITIONING: Serve OS is the service provider that gives restaurants a
complete operating system — online ordering, a full POS, and AI-powered
analytics. The intelligent backbone a restaurant runs on.

AVOID: fork/knife/plate/chef-hat clichés, cold corporate blue, gradients,
drop shadows, 3D, glassmorphism, clutter.

LOGO CONCEPT: mark = a connected triangle in Coral #F0522B; wordmark =
"ServeOS" in Bricolage Grotesque 700 with the "OS" in Coral #F0522B and
"Serve" in Ink #1A0F0A (reversed to Paper on dark). The mark must work alone
and stay legible at 16px (it becomes the favicon and app icon).

COLORS:
- Primary Coral #F0522B (hover #D23F1C, soft tint #FBE3DA)
- Accent Teal #0FB5A6 (hover #0A8478, soft #DBF3F0) — reserved for data / AI
- Warm Sand neutrals: Paper #FBF7F2, Sand50 #F4EDE4, Sand100 #E9E0D6 (borders),
  Sand200 #D8CCBE, Sand300 #B9AB9A, Sand500 #6E6459 (muted text),
  Sand700 #3A332C (body), Ink #1A0F0A (headings)
- Semantic: success #1F8A5B, warning #E8A33D, error #CE2C2C, info #2E6BFF
- Dark mode: canvas #140D08, surface #211610, elevated #2C1F16, text #FBF1EC,
  muted #B9AB9A; coral #FF6B45, teal #2DD4C4

TYPOGRAPHY: Display/brand = Bricolage Grotesque (600/700/800). UI/body =
Space Grotesk (400/500/700). Arabic/RTL = IBM Plex Sans Arabic (400/600/700).
Monospace = JetBrains Mono (400/500).

ICON STYLE: geometric line icons, 2px stroke, rounded joins, 24px grid,
consistent weight. Coral for active, Sand500 for default, Teal for data icons.

ILLUSTRATION STYLE: flat, two-tone coral+teal over warm Sand neutrals, lots
of negative space, friendly and simple.

Confirm you've got this, then wait for my first asset request.
```

## Option B — Let Claude Design create the direction

```
You are helping me create the complete brand identity for Serve OS — a B2B
SaaS platform that is an operating system for restaurants (QR menus, POS,
WhatsApp ordering, reservations, inventory, analytics). It's sold to
restaurant owners and managers who are busy and non-technical. It runs in
English, Spanish, and Arabic (Arabic is right-to-left, so any typography
must support Arabic).

I don't have a fixed visual direction — I want you to create one. Here's what
the brand should feel like:

PERSONALITY: dependable, warm, clear. Trustworthy enough to run a business
on, friendly enough not to intimidate. Modern, uncluttered, confident. It's
hospitality software — human and warm, not cold enterprise tech.

AVOID: fork/knife/plate/chef-hat clichés, cold generic corporate blue, heavy
gradients, drop shadows, 3D, clutter.

Please propose a complete brand direction. I want you to decide:
- a color palette (primary, accent, neutrals, and semantic colors for a
  dashboard — success/warning/error/info — plus dark-mode values, since the
  app runs on tablets in restaurants)
- a typography system that covers Latin AND Arabic (display, UI/body, and a
  monospace for prices/order numbers)
- a logo concept for a mark that stays legible shrunk to a 16px favicon and
  works as a standalone app icon

Give me 2–3 distinct directions first — each as a small moodboard: palette,
font choices, and a rough logo concept with a one-line rationale. I'll pick
one, then we'll refine it and build out the full asset set.

Confirm you understand, then present the directions.
```

> Two things stay firm even in Option B — they're facts about the product, not style choices: **typography must support Arabic**, and the **logo must stay legible at 16px**. Both are already built into the prompt above.

---

# PART 4 — PER-ASSET PROMPTS (paste in this order, after the master prompt)

> Each prompt assumes the master context above is loaded. Dimensions are included where they matter. The logo is already locked (connected-triangle mark + "ServeOS" wordmark), so start at prompt #1 to build the full set, then continue down the list.

### 1. Logo system (mark is locked — build the full set)
```
The Serve OS logo is locked: mark = a connected triangle in Coral #F0522B;
wordmark = "ServeOS" in Bricolage Grotesque 700, "OS" in Coral #F0522B and
"Serve" in Ink #1A0F0A. Produce the full logo set as clean vectors:
1) primary lockup (triangle mark + "ServeOS" wordmark)
2) horizontal lockup
3) stacked lockup
4) mark only (the connected triangle)
5) one-color black
6) one-color white / reversed
Show each in light (on Paper #FBF7F2) and dark (on Canvas #140D08) versions —
on dark, "Serve" flips to Paper #FBF1EC and "OS" stays coral. Keep the mark
legible at very small sizes.
```

### 2. Favicon & app-icon set
```
Using the locked Serve OS mark (the connected triangle), produce the favicon and app-icon set at
these exact sizes: favicon 16x16 and 32x32; Apple touch icon 180x180;
PWA icons 192x192 and 512x512; a maskable 512x512 with the symbol centered
in a safe zone (~80% of canvas); and a monochrome silhouette version for
Safari pinned tabs. Show each at actual size so I can verify small-size
legibility.
```

### 3. Marketing site — hero + logo application
```
Design the serveos.cloud marketing homepage hero: a 1920x1080 background
composition on-brand (coral-led, teal for data/AI, warm Sand neutrals, clean) that works
behind a headline and a "Get Started" button, with the Serve OS logo in the
header. Keep the center calm enough for white text to sit on it. Also give
me a still fallback image version.
```

### 4. Marketing site — feature icons
```
Design a set of 6 feature icons in the Serve OS icon style (geometric, 2px
stroke, rounded, 24px grid, coral with teal for the data/analytics ones), one for each: QR Menu &
Ordering, Point of Sale (POS), WhatsApp Ordering, Table Reservations,
Inventory Control, Live Analytics. Consistent optical weight. Show at 64x64.
```

### 5. Marketing site — Open Graph share image
```
Design the Open Graph / social share image for Serve OS at exactly
1200x630. Include the logo, the line "The operating system for restaurants,"
and a clean on-brand background. This is what shows when serveos.cloud is
shared in WhatsApp, LinkedIn, etc. Keep key content away from the edges.
```

### 6. Auth pages
```
Design the login/signup page side panel for Serve OS: a ~960x1080 vertical
branded panel (half the screen) with the logo, a warm on-brand illustration
or pattern, and space that complements a form on the other half. Show a
light and a dark version.
```

### 7. Dashboard — logo + navigation
```
Design the dashboard sidebar branding for Serve OS: expanded logo (~160x40)
and a collapsed version (32x32, symbol only), each in light and dark mode.
Then show them applied in a simple sidebar mockup so I can see them in
context.
```

### 8. Dashboard — UI icon set
```
Design a core UI icon set for the Serve OS dashboard in the brand icon style
(geometric, 2px stroke, rounded, 24px grid). Include: home/dashboard, orders,
menu, tables/reservations, inventory, analytics, customers, settings,
search, add, edit, delete, notification, plus the 4 semantic status icons
(success, warning, error, info). Show at 24x24, consistent weight.
```

### 9. Dashboard — empty-state illustrations
```
Design a set of empty-state illustrations in the Serve OS illustration style
(flat, two-tone teal+coral, lots of negative space) at ~320x240 each, for:
"No orders yet," "No menu items," "No reservations," "No inventory items."
Friendly and simple, each with room for a short caption below.
```

### 10. Dashboard — misc
```
Design: a default user avatar placeholder (200x200, circular-safe, on-brand),
and a loading/splash screen built from the Serve OS symbol. Light and dark.
```

### 11. Restaurant-facing QR menu  ⚠ confirm sizes with developer first
```
Design the customer-facing QR menu template that diners see (this is what
each restaurant's guests open). Include: a menu cover/hero banner (~1600x600),
a category card style (square ~800x800), and a food-item card style with the
photo at ~800x800 or 4:3. Keep it clean and appetizing, letting the
restaurant's OWN logo and food photos lead — Serve OS branding stays minimal
and neutral here. Also design a printable table-tent QR card (A6, 105x148mm)
that holds the QR code plus subtle Serve OS branding.
```
> ⚠ The exact upload dimensions for menu/food/category images are set by the platform script, not by free choice. Confirm them with your developer before finalizing these, or the images may crop or blur.

### 12. Social media kit
```
Design the Serve OS social kit: profile picture (use the symbol, 400x400)
and these banners — LinkedIn 1128x191, X/Twitter 1500x500, Facebook cover
820x312, YouTube 2560x1440 (keep content in the central 1546x423 safe area).
Plus one reusable feed-post template (1080x1080) and one story template
(1080x1920) I can duplicate for future posts. All on-brand.
```

### 13. Email
```
Design a Serve OS email header (logo on a clean band, ~600px wide layout)
for transactional and marketing emails, in light and dark. Keep it simple
and safe for email clients.
```

---

# PART 5 — WORKING WITH CLAUDE DESIGN

**Sequence matters.** Do them in the order above. The logo (#1) unlocks everything; the favicon (#2) and dashboard logo (#7) depend on the final symbol. Don't design collateral before the mark is locked.

**Iterate, don't restart.** Claude Design is conversational — refine rather than re-prompt. e.g. *"take direction 2, tighten the dome curve, and put the coral only on the S,"* or *"same icon set but make the stroke slightly heavier."* That back-and-forth is its strength.

**Lock the mark, then reuse it.** Once you approve the symbol, reference it in later prompts ("using the final Serve OS symbol…") so everything stays consistent.

**Export.** Ask for clean vectors (SVG) for the logo and icons — they must scale. Raster (PNG) is fine for photographic/illustration assets and the fixed-size favicon/social exports. Request @2x for any raster meant for screen.

**Two things to confirm with your developer before final production:**
1. The **exact image dimensions the platform script expects** for menu covers, category images, and food photos (Part 4 #11). The script decides these; matching them prevents cropping/blurring.
2. Whether native **mobile apps** are planned — if so, you'll also need iOS 1024x1024 and Android 512x512 app icons (easy to add from the final symbol).

**RTL / Arabic.** The wordmark stays left-to-right (it's a name), but any asset with directional elements (arrows, layout-anchored illustrations, the auth panel) needs an RTL-aware or symmetrical version, since the whole UI mirrors in Arabic. Mention this to Claude Design when you reach those assets.

**Priority if you're short on time:** Logo → Favicon → OG image → Feature icons → Dashboard logo + UI icons. That gets the site and product looking real fastest; everything else is collateral you can layer in after.
