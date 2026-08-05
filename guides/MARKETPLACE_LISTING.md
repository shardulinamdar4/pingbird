# Pingbird — Google Workspace Marketplace Listing Runbook

Every step from the current code to a live listing, in order. Facts verified
against Google's publishing docs (Aug 2026).

## Step 0 — Understand the three hard constraints

1. **Editor add-ons must be standalone Apps Script projects.** Your bound
   template script cannot be listed. You'll create a standalone "Pingbird"
   script (Step 1) — v1.2.0 of Code.gs is already add-on-safe (see Step 1
   notes on why older versions were not).
2. **Visibility (Public vs Private) is permanent** once saved in the
   Marketplace SDK. Private = your Workspace domain only, publishes
   immediately, no OAuth verification. Public = worldwide, but requires
   completed OAuth verification first (restricted `gmail.modify` scope →
   CASA Tier 2 security assessment) plus Google's Marketplace review.
3. **A dedicated standard GCP project** — the default project can't publish,
   and a published app can't share its project with anything else. This must
   be a *different* project from any Internal one you made earlier.

## Step 1 — Create the standalone add-on script

1. script.google.com → **New project** → name it exactly `Pingbird`.
2. Paste `Code.gs` (v1.2.0+) and `appsscript.json` (Project Settings ⚙ →
   show manifest first).
3. Why v1.2.0 is required, not just nice:
   - **Per-user spreadsheet binding.** In an add-on, *Script* Properties are
     shared by every installer globally; older versions stored the bound
     spreadsheet ID there, which would make all users collide on one sheet.
     v1.2.0 stores it in User Properties (with automatic migration for
     legacy installs) and asks before re-binding when setup runs from a
     different spreadsheet.
   - **`urlFetchWhitelist` in the manifest.** Published add-ons that call
     `UrlFetchApp` must whitelist their endpoints; the manifest now lists
     exactly three prefixes: OpenRouter, `p4a.me/wh/`, and
     `api.pocketalert.app/v1/webhooks/receive/`. Review checks this.
4. Test as unpublished: Editor → Run `onOpen`? No — for editor add-ons use
   **Extensions → Add-ons → Test add-on** from any spreadsheet (older UI) or
   simply run Quick setup from the standalone editor's tied test doc.
   Walk the full user journey: install → open a blank sheet → Extensions →
   Pingbird → Quick setup → Scan now → phone ping.

## Step 2 — Versioned deployment

Deploy → **New deployment** → type **Add-on** → description `Pingbird v1.2.0`
→ Deploy. Then note **two identifiers**:

- **Script ID** — Project Settings ⚙ → Script ID.
- **Version number** — Deploy → Manage deployments → the numeric version
  (1, 2, 3…).

⚠️ Classic trap: the Editor-add-on fields in the Marketplace SDK want the
**Script ID + version *number***, *not* the Deployment ID string. Pasting
the Deployment ID there is a famous silent failure.

For every future release: Manage deployments → edit the existing deployment
→ **New version** (never "New deployment" — a new deployment kills existing
users' triggers), then update the version number in the SDK App
Configuration. Users don't reinstall; they only re-consent if scopes grew.

## Step 3 — Dedicated GCP project + consent screen

Follow `GCP_OAUTH_SETUP.md` Parts 1–5 with these listing-specific deltas:
- New project (suggested ID: `pingbird-marketplace`), name **Pingbird**
  (users see the Cloud project name on the consent prompt).
- Enable **Gmail API** *and* **Google Workspace Marketplace SDK**
  (APIs & Services → Library).
- Attach this project to the standalone script by **project number**
  (one-way door — that's fine here; this script exists to be published).
- Consent screen: External for public / Internal for domain-private.
  Now is when the **logo** (`pingbird-logo-120.png`) goes on — public
  listing means you're doing verification anyway.
- Public path ordering matters: **Publish App on the consent screen and
  complete OAuth verification (scope justifications from GCP_OAUTH_SETUP.md
  Part 7, demo video, CASA Tier 2) *before* submitting the Marketplace
  listing.** Reviewers bounce listings whose verification is pending.

## Step 4 — Marketplace SDK: App Configuration

Console → Google Workspace Marketplace SDK → **App Configuration**:

| Field | Value |
|---|---|
| App visibility | Public or Private — **permanent, choose deliberately** |
| Installation settings | Individual + admin install |
| App integration | **Editor add-on → Sheets add-on** |
| Sheets add-on project script ID | (Step 2 Script ID) |
| Sheets add-on script version | (Step 2 version **number**) |
| OAuth scopes | Paste all six, byte-identical to the manifest & consent screen: `…/auth/gmail.modify`, `…/auth/spreadsheets`, `…/auth/script.external_request`, `…/auth/script.scriptapp`, `…/auth/userinfo.email`, `…/auth/script.container.ui` |
| Developer name / website / email | yours |

Scope-list mismatches between manifest ↔ consent screen ↔ SDK are a top
rejection cause — keep all three identical forever.

## Step 5 — Store Listing (paste-ready)

**App name:** Pingbird

**Short description** (≤ ~132 chars):
`Your job hunt on silent. Auto-tracks every application from Gmail and pings your phone only when you must act.`

**Detailed description:**
```
Pingbird is a private job-search guardian that lives inside your own Gmail
and a Google Sheet. It reads application emails so you don't have to, keeps
one clean row per application, quietly archives the noise — and sends one
content-free phone alert only when something actually needs you: an
assessment to complete, an interview to confirm, a recruiter waiting on an
answer, an offer on the table.

WHY IT'S DIFFERENT
• The tracker maintains itself from your inbox — you never log an
  application or move a card.
• One row per application, deduplicated by job/requisition ID, company +
  role, and email thread. Stages only move forward; rejections close loops;
  recruiter name and email are captured automatically.
• AI classification (your own OpenRouter key) with hard safety rules that
  hold veto power: nothing is archived and nothing is marked Rejected
  without explicit textual evidence, and uncertain email always stays
  unread in your Inbox.
• Privacy by architecture: no server, no accounts. Your email is processed
  inside your Google account; sanitized excerpts go only to the AI provider
  you configure; phone alerts contain no email content whatsoever.
• Import up to 24 months of history in resumable 15-day slices.

SETUP (≈5 minutes)
Install → open a blank Google Sheet → Extensions → Pingbird → Quick setup →
paste your OpenRouter API key and Pocket Alert webhook. Five daily scans run
automatically; Pilot your first days from the Tracker, and mark items done
right from the Home screen.

Requires: a free OpenRouter API key (AI) and the Pocket Alert app (phone
notifications). Both stay under their free tiers in normal use.
```

**Category:** Productivity. **Pricing:** Free.

**Graphic assets** (in the logo kit / outputs):
| Asset | File | Spec |
|---|---|---|
| App icon 128×128 | `pingbird-logo-128.png` | PNG |
| App icon 32×32 | `pingbird-logo-32.png` | PNG |
| Card banner 220×140 | `pingbird-card-220x140.png` | PNG |
| Screenshots ≥1, 1280×800 | `pingbird-hero-1280x800.png` **+ real screenshots** | see below |

**Real screenshots are non-negotiable for review.** The branded hero may
lead, but capture at 1280×800 and add: (1) the Tracker filled with rows —
stages, deadlines, recruiter columns; (2) Home with the "Needs your
attention" list; (3) the Quick-setup dialog; (4) a phone showing the
content-free Pocket Alert ping. Blur any personal data.

**Support links:** homepage, terms, **privacy policy (required — host
PRIVACY.md)**, support page/email. Same authorized domain as the consent
screen.

## Step 6 — Submit and survive review

Store Listing → **Publish**. Private: live in your domain almost
immediately. Public: Google's reviewer installs and exercises the app,
communicating by email — respond fast; stalled threads auto-reject.

Common rejection causes, pre-answered:
- OAuth verification not completed first (public) → Step 3 ordering.
- Scope mismatch across manifest/consent/SDK → Step 4.
- Deployment ID pasted where the version number belongs → Step 2.
- Dead or placeholder privacy-policy URL → Step 5.
- Screenshots that don't show the actual product → Step 5.
- App errors on a fresh account with zero data → test Quick setup on a
  brand-new Google account before submitting; Pingbird's empty-state Home
  ("Nothing needs your attention") covers the empty-data case.

## Ongoing

Keep the template-copy distribution alive alongside the listing — it's the
zero-friction path for individuals, and its master must stay on its default
GCP project (see GCP_OAUTH_SETUP.md Rule zero). Ship updates as new
*versions* on the same deployment; re-run OAuth verification only when
scopes change; CASA re-assessment is annual for the public listing.
