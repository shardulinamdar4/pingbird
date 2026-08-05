# Pingbird repo → GitHub Pages → Marketplace fields

Ten minutes from this zip to every URL the Marketplace forms are asking for.

## 1. Personalize (one command)

Two placeholders appear throughout the site: `YOUR_GITHUB_USERNAME` and
`YOUR_EMAIL`. Replace both in one shot (run inside the repo folder):

```bash
grep -rl 'YOUR_GITHUB_USERNAME\|YOUR_EMAIL' docs/ | xargs sed -i '' \
  -e 's/YOUR_GITHUB_USERNAME/<your-github-username>/g' \
  -e 's/YOUR_EMAIL/<you@example.com>/g'
```
(Linux: drop the `''` after `-i`.)

## 2. Create the repo and push

```bash
cd pingbird
git init -b main
git add .
git commit -m "Pingbird v1.2.0 — your job hunt on silent"
# create an empty PUBLIC repo named "pingbird" on github.com first, then:
git remote add origin https://github.com/<your-github-username>/pingbird.git
git push -u origin main
```

## 3. Enable GitHub Pages

GitHub → repo → **Settings → Pages** → Source: *Deploy from a branch* →
Branch: `main`, folder: **/docs** → Save. After ~1 minute your site is live at:

```
https://<your-github-username>.github.io/pingbird/
```

Verify all five pages load (index, setup, support, privacy, terms) **before**
pasting URLs into Google — reviewers reject dead links immediately.

## 4. Paste-map for the Marketplace SDK forms (your exact screens)

### App Configuration screen
| Field on your screen | Value |
|---|---|
| Sheets add-on ✔ | checked (only this one) |
| Sheets add-on project script ID | Apps Script → Project Settings ⚙ → **Script ID** |
| Sheets add-on script version | Deploy → Manage deployments → the **version number** (e.g. `1`) — a plain number, **never** the long Deployment ID |

### Developer information screen
| Field | Value |
|---|---|
| Trader status | **Non-trader** — Pingbird is free, open-source, and not a commercial activity, so EEA consumer-protection trader rules don't apply. (Pick *Trader* only if you distribute it as a registered business.) |
| Developer name | your name (or "Pingbird") |
| Developer website URL | `https://<user>.github.io/pingbird/` |
| Developer email | your email (Google contacts you here about reviews — watch it) |
| Application website URL | `https://<user>.github.io/pingbird/` |

### Store listing screen — Graphic assets
All files are in `docs/assets/` at the exact required pixel sizes:
| Field | File |
|---|---|
| Application Icon 32×32 * | `pingbird-logo-32.png` |
| Application Icon 48×48 | `pingbird-logo-48.png` |
| Application Icon 96×96 | `pingbird-logo-96.png` |
| Application Icon 128×128 * | `pingbird-logo-128.png` |
| Application card banner 220×140 * | `pingbird-card-220x140.png` |
| Screenshot * | `pingbird-hero-1280x800.png` first, **then add real 1280×800 screenshots**: full Tracker with rows, Home "Needs your attention", Quick-setup dialog, the phone ping. Reviewers require actual product UI. |

Category: **Productivity**.

### Store listing screen — Support links
| Field | URL |
|---|---|
| Terms of Service URL * | `https://<user>.github.io/pingbird/terms.html` |
| Privacy policy URL * | `https://<user>.github.io/pingbird/privacy.html` |
| Setup URL | `https://<user>.github.io/pingbird/setup.html` |
| Admin config URL | leave empty |
| Support URL * | `https://<user>.github.io/pingbird/support.html` |
| Help URL | `https://<user>.github.io/pingbird/support.html` |
| Report issue URL | `https://github.com/<user>/pingbird/issues` |

## 5. Sync the OAuth consent screen

Your toast says project `pingbird` in **"No organisation"** → your consent
screen is **External** (Internal isn't available without a Workspace org),
so the public path requires OAuth verification before the listing review
passes. Add the same two URLs there: Google Auth Platform → Branding →
**App home page** = the Pages URL, **Privacy policy** = `privacy.html`, and
add `<your-github-username>.github.io` under **Authorized domains**
(github.io subdomains are accepted for user sites). Logo:
`docs/assets/pingbird-logo-120.png`.

## 6. Repo contents

```
pingbird/
├── Code.gs                  # v1.2.0, add-on ready
├── appsscript.json          # manifest incl. urlFetchWhitelist
├── Pingbird_Template.xlsx   # optional spreadsheet template
├── README.md · LICENSE (MIT)
├── guides/                  # setup, GCP/OAuth, marketplace runbooks, dev log
└── docs/                    # ← the GitHub Pages site
    ├── index.html · setup.html · support.html · privacy.html · terms.html
    └── assets/              # all icons incl. 32/48/96/128, card, hero
```

The privacy page includes the Google API Services **Limited Use** statement
verification reviewers look for. The terms page is written for a free,
MIT-licensed, no-server tool — read both once before publishing; they speak
in your name.
