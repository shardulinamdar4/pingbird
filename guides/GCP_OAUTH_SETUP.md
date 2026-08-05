# Pingbird — GCP OAuth Consent Screen: Complete Setup Playbook

## Part 0 — Decide if you need this at all (read first)

Attaching a custom GCP project changes how authorization works. Pick your row:

| Your goal | Do you need a GCP consent screen? |
|---|---|
| Personal use + template-copy sharing | **No.** Each copy runs on its owner's default hidden Apps Script project. One "unverified app" click-through, then it works forever. Adding a custom External project in *Testing* would make this **worse** (7-day re-auth, see trap below). |
| Coworkers on your Google Workspace domain, no warnings | **Yes — Internal user type.** No verification, no user cap, no token expiry. The best deal Google offers. |
| A quick demo to ≤100 named people | Yes — External + Testing, but only for demos: authorizations **expire in 7 days**, killing the scheduled scans weekly. |
| Public launch without the "unverified" warning | Yes — External + full verification, including a **CASA Tier 2 security audit** (because `gmail.modify` is a *restricted* scope). Weeks of lead time and real money. |

**Rule zero — protect the master template (one-way door):** switching a
script to a standard Cloud project is **irreversible** — Google's docs:
*"You can't switch a script back to a default project. Apps Script deletes
default projects after you set the script to use a standard project."* And
the Cloud-project association travels with spreadsheet copies, so a master
template switched to your External standard project would make every
friend's copy authorize against *your* project — inheriting your user cap or
Testing-mode expiry — permanently. **Never switch the copy you share.** Keep
the shareable master on its default project; make a separate fork ("Pingbird
Internal" / "Pingbird Marketplace") for any standard-project deployment.

**When Google *requires* a standard project** (per the official doc):
publishing to the Google Workspace Marketplace, verifying the OAuth client,
calling the script via the Apps Script API's `scripts.run`, viewing Cloud
logs / Error Reporting in the console, or creating a file-open dialog.
Pingbird needs none of these for personal or template use.

**The Testing-mode trap, explicitly:** Google's own policy — a test user's
authorization *and refresh token* expire seven days after consent (the only
exemption is apps using nothing beyond name/email/profile scopes). Pingbird
uses restricted Gmail scope, so Testing mode = broken triggers every week.
Testing is for demos, never for daily drivers.

---

## Part 1 — Create the GCP project

1. Go to console.cloud.google.com → project picker → **New Project**.
2. Name: `Pingbird` — this matters more than it looks: for scripts on a
   standard project, **the Cloud project name is what users see on the
   authorization prompt** (not the Apps Script project name). A sloppy name
   here is what your users will be asked to trust.
3. Organization: your Workspace org (required for Internal), or
   "No organization" for a personal account (External only).
4. Open the new project → **Dashboard** → copy the **Project number**
   (a plain number). Apps Script asks for the *number*, not the project ID —
   the #1 source of "invalid project" errors.

## Part 2 — Configure the consent screen

Console → **Google Auth Platform** (older UI: APIs & Services → OAuth
consent screen) → **Get started / Branding**:

| Field | Value |
|---|---|
| App name | `Pingbird` |
| User support email | your email |
| App logo | **Leave empty for now** — uploading a logo triggers brand verification review even in early stages |
| App home page | your Pingbird page (required only for verification) |
| Privacy policy link | host the contents of `PRIVACY.md` on your domain (required for verification) |
| Terms of service | optional |
| Authorized domains | the domain hosting the pages above |
| Developer contact | your email |

**Audience** tab: choose **Internal** (Workspace org only — strongly
preferred if eligible) or **External**. External starts in *Testing*; add
test users by email there (hard cap: 100).

## Part 3 — Declare the scopes (Data Access tab)

Add exactly the scopes from `appsscript.json` — no more (adding a restricted
scope later restarts verification from zero):

| Scope | Class | Paste-ready justification (for verification) |
|---|---|---|
| `.../auth/gmail.modify` | **Restricted** | "Pingbird reads job-application emails in the user's own mailbox, applies/removes three organizational labels (Jbs, Action required, CG/Processed), keeps action-required emails unread in the Inbox, and archives only confirmed no-action job emails. Read results are written solely to the user's own spreadsheet. No email content leaves the user's Google account except sanitized excerpts sent to the AI provider the user configures with their own key." |
| `.../auth/spreadsheets` | Sensitive | "Maintains the user's job-application Tracker and hidden state sheets inside the container spreadsheet the script is bound to." |
| `.../auth/script.external_request` | Sensitive | "Calls exactly two endpoints: the OpenRouter API (AI classification, user's own key) and the user's own Pocket Alert webhook (a content-free notification)." |
| `.../auth/script.scriptapp` | Sensitive | "Installs the five daily time-based scan triggers and one edit trigger; removable by the user via the Pause automation menu." |
| `.../auth/userinfo.email` | Non-sensitive | "Identifies the account owner so the user's own sent messages are excluded from tracking." |
| `.../auth/script.container.ui` | Non-sensitive | "Renders the spreadsheet menu and setup dialogs." |

## Part 4 — Enable the Gmail API

Console → APIs & Services → **Library** → **Gmail API** → Enable.
This is **mandatory** once you attach a custom project: advanced services
must be manually activated in a standard project, so Pingbird's advanced
Gmail service (used to hide the `CG/Processed` label) fails with
*"Gmail API has not been used in project…"* otherwise. Two related notes
from the official doc: built-in **Drive** would also need the Drive API on a
standard project — Pingbird doesn't use Drive, so skip it; and switching
projects "loses data tied to advanced services in the previous project" —
harmless for Pingbird, since its labels live in Gmail itself, not in the
Cloud project.

## Part 5 — Attach the project to Apps Script

1. Apps Script editor → **Project Settings ⚙** → *Google Cloud Platform
   (GCP) Project* → **Change project** → paste the **project number**.
2. Everyone (including you) must **re-authorize** on next run — expected.
3. Run **Extensions → Pingbird → Advanced → Install / repair automation**
   afterwards so the triggers are rebuilt under the new authorization.
4. **There is no rollback to default.** Switching deletes the default
   project permanently; you can only ever move to *another standard*
   project. This is why Rule zero says: do this on a dedicated fork, never
   on the master template you share.

## Part 6 — Publishing status: consequences table

| Status | Warning screen | User cap | Token life | Verification |
|---|---|---|---|---|
| Internal (Workspace) | None | Unlimited (domain) | Normal | **None** |
| External + Testing | Yes (milder for test users) | 100 hard cap | **7 days** | None |
| External + In production, unverified | Yes ("Advanced → continue") | Capped (restricted scopes) | Normal | None yet |
| External + Verified | None | None | Normal | Full + CASA |

## Part 7 — The verification submission kit (External → Verified)

Prerequisites you must own before clicking **Prepare for verification**:

1. A domain you control, listed under Authorized domains, hosting a real
   **homepage** and **privacy policy** (adapt `PRIVACY.md`; it already
   answers Google's data-handling questions accurately).
2. **Scope justifications** — table above, one per sensitive/restricted scope.
3. **Demo video** (unlisted YouTube, in English, on the production app):
   - Show the homepage URL, then the full OAuth consent screen; hover the
     browser URL and reveal the **client ID** in it.
   - Walk each requested scope being *used*: a scan labeling a thread and
     keeping an action email unread (`gmail.modify`), the Tracker updating
     (`spreadsheets`), an AI call + phone ping firing (`external_request`),
     the schedule in the triggers screen (`script.scriptapp`).
   - Same app name/branding as the consent screen throughout.
4. **A dedicated Cloud project** if you go to the Marketplace: published
   apps can't share a Cloud project with any other app or script.
5. **CASA Tier 2 security assessment** — required *because* `gmail.modify`
   is restricted: an authorized third-party lab reviews security posture and
   data handling; budget hundreds to a few thousand dollars and re-assessment
   **annually**. Sensitive-scope review itself typically resolves in days
   once complete; restricted-scope end-to-end commonly runs **2–6+ weeks**.

(Renumber accordingly.) Sequence: complete Branding + Data Access → Publish app → Prepare for
verification → answer Google's emails promptly (incomplete consent-screen
fields are the top rejection reason) → complete CASA when Google issues the
assessment request.

## Part 8 — Common failure modes

- **"Invalid project number"** — you pasted the project *ID* (string); use
  the *number*.
- **Advanced Gmail calls fail after switching** — Gmail API not enabled in
  the new project (Part 4).
- **Triggers stopped for a friend after a week** — they're on your External
  project in Testing; the 7-day expiry. Move them to template-copy (own
  default project) or publish Internal/verified.
- **Can't select Internal** — the project isn't owned by a Workspace
  organization account.
- **Verification bounced immediately** — missing/unreachable privacy policy
  URL, domain not in Authorized domains, or video doesn't show the client ID
  and each scope in use.

## Recommendation for Pingbird today

Friends → template copy (no GCP at all). Coworkers → **Internal** consent
screen (this playbook Parts 1–5, fifteen minutes, zero verification).
Public → start the domain + privacy-policy + CASA track only when there's
traction that justifies annual audit costs; until then, the unverified
click-through is an honest trade-off for an open-source, no-server product.
