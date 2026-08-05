# Pingbird v1.1.0 — Setup Guide

*(Pingbird is the launch name of Pingbird; if you're upgrading an
existing Pingbird sheet, just paste the new Code.gs — everything
migrates automatically, including the Home screen rebrand. Gmail labels keep
their names so nothing breaks.)*

Pingbird privately watches Gmail for job-application emails. Everything
runs inside your own Google account; no third-party dashboard ever gets Gmail
access. Only a generic "something needs your attention" alert (with a link to
your Tracker) is sent to your phone through Pocket Alert — never email content.

## What you need

1. A Google account (personal Gmail works).
2. An OpenRouter API key (openrouter.ai → Keys).
3. The Pocket Alert app on your phone with one webhook whose
   **Message Template is set to exactly:** `%message%`

## Installation — exact sequence

The script builds the entire template by itself, so you can start from
**any blank Google Sheet** — the `.xlsx` file is optional.

**Option A (recommended): blank sheet**
1. Create a new, empty Google Sheet (sheets.new).
2. Open **Extensions → Apps Script**.
3. In the Apps Script editor, open **Project Settings (⚙)** and tick
   **"Show appsscript.json manifest file in editor"**.
4. Replace the contents of `appsscript.json` and `Code.gs` with the provided
   files. Save. Quick setup (step 7 below) creates Home, Tracker, Settings,
   and all hidden sheets, and removes the blank default sheet. (You can also
   build the sheets alone at any time via
   **Advanced → Create / repair template on this sheet**.)

**Option B: import the template file**
1. Upload `Pingbird_Template.xlsx` to Google Drive, open it, and use
   **File → Save as Google Sheets**.
2–4. Same as Option A steps 2–4.
5. Name the Apps Script project **Pingbird** (top-left of the editor) —
   this becomes the menu label.
6. Reload the spreadsheet tab. The menu appears under
   **Extensions → Pingbird** (it deliberately stays out of the main
   menu bar).
7. Open **Extensions → Pingbird → 🚀 Quick setup** and approve the Google
   permissions when asked (it needs Gmail + Sheets + the ability to call
   OpenRouter and Pocket Alert).
8. Paste your OpenRouter key, then your Pocket Alert webhook URL. Quick setup
   sends one test AI request, one test phone alert, runs the safety tests, and
   installs the five daily scans (06:00, 10:00, 14:00, 18:00, 22:00 in your
   spreadsheet's timezone). It never scans your mailbox.
9. Run **Scan now** once to process recent mail.
10. To import older history, run **Run backfill batch**. The first run asks
    how many months back to cover (default **6 months**; change it any time
    via **Advanced → Set backfill window**). Run the batch repeatedly — each
    one is small and safely resumable; Settings shows progress and a message
    tells you when backfill is complete.
11. That's it. Archiving is live from the start: only emails where **both**
    the rules and the AI agree there is nothing to do are archived. Anything
    needing you — or anything uncertain — always stays unread in your Inbox
    with the "Action required" label.

## Daily use

- **Tracker** — newest entries on top. Change a row's Status to *Completed* or
  *Dismissed* when you've handled it; the Gmail "Action required" label and
  Inbox state sync automatically.
- **Home** — pending items and system status at a glance.
- **Settings** — read-only status. Secrets are never displayed; change them via
  **Advanced → Configure integrations**.
- Gmail shows two labels: **Jbs** on every tracked job thread, and
  **Action required** on threads that need you. Emails needing action stay
  unread in your Inbox.

## Migrating from the previous (v3.x) sheet

The Tracker columns are identical, so migration is in-place:

1. Open your existing Pingbird spreadsheet → Extensions → Apps Script.
2. Replace `Code.gs` and `appsscript.json` with the v4 files. Save, reload.
3. Run **Pingbird → 🚀 Quick setup** once (it repairs sheets, creates
   the new hidden `CG/Processed` label, re-tests integrations, and reinstalls
   triggers — old triggers are removed automatically).
4. Nothing else is required. On the first scan, threads you already tracked
   are re-discovered once, every message is skipped by the message-ID dedup,
   and the thread receives the processed label — after which it permanently
   drops out of discovery. The first scan may take a minute or two; every scan
   after that is fast.
5. The old `_Archive` sheet is no longer used; you may delete it.

## If the Tracker shows junk or the AI seems off

Open **Settings** and look at **Last AI error**. If AI requests fail, Career
Guardian falls back to safe rule-based decisions — emails without career
evidence are quietly ignored (never turned into Review alerts), and explicit
rule matches (acknowledgements, assessments, interviews, offers, rejections)
still work exactly like the original version.

Common AI fixes:
- The default model is `openrouter/auto`, which needs OpenRouter credits. On a
  free account, use **Advanced → Set AI model** and enter a free model such as
  `meta-llama/llama-3.3-70b-instruct:free`. The dialog tests the model
  immediately.
- If older noise rows are cluttering the Tracker (Status *Review* with Stage
  *Ignore*), run **Advanced → Dismiss noise Review rows** once — it dismisses
  them all and clears the Gmail "Action required" labels.

## The Tracker: one row per application

The Tracker keeps exactly **one row per application**, matched in this order:
**requisition / job ID** (hidden Req ID column) → **company + role** → the
Gmail thread. A later email updates the existing row instead of adding a new
one: the stage only ever moves forward (Applied → Under Review → Assessment →
Interview → Offer; Rejected/Withdrawn are terminal), a new required action
revives the row to Pending, and a completion or rejection clears a matching
pending action. Duplicate ATS acknowledgements simply merge.

## Sharing Pingbird with friends and coworkers

There are two easy paths — no add-on publishing needed.

**Simplest: just send the two files.** Since v4.2.0 the script builds the
template itself, a friend only needs `Code.gs` and `appsscript.json`: they
create a blank Google Sheet, paste both files into Apps Script (Installation
Option A), and run Quick setup with their own keys. Nothing of yours is
involved at all.

**Alternative: a template copy** of your sheet:

1. Finish your own setup, then make a fresh copy for sharing: File → Make a
   copy, open the copy's Apps Script, and confirm the code is there. Delete
   any of your rows from Tracker/_State/_Outbox/_Log in the shared copy
   (your API key, webhook, and Gmail data do **not** travel with a copy —
   they live in your account's User Properties).
2. Share that copy: **Share → Anyone with the link → Viewer**, and send the
   link.
3. Your friend opens it and uses **File → Make a copy**. Their copy includes
   the script. They then follow this guide from step 5: name the project, run
   Quick setup, paste **their own** OpenRouter key and Pocket Alert webhook.
4. During authorization Google shows an **"unverified app"** warning because
   the script isn't published — that's expected for personal scripts. They
   click *Advanced → Go to Pingbird (unsafe)*. Everything runs inside
   their own Google account; nobody else ever gets access to their Gmail.

**Publishing options, honestly assessed:**

- **Coworkers on the same Google Workspace domain** — this is the one real
  publishing path that's practical. A Workspace admin can deploy the script
  as a **domain-internal Editor add-on** (Apps Script → Deploy → New
  deployment → Add-on, published *internally* via the Google Workspace
  Marketplace SDK, visibility "Private"). Internal apps in the same domain
  skip Google's public OAuth verification, so coworkers install it from the
  company's internal Marketplace with no "unverified app" warning. Each
  person still uses their own keys; nobody's Gmail is shared.
- **Public Google Workspace Marketplace** — not practical for casual sharing:
  `gmail.modify` is a *restricted* OAuth scope, so a public listing requires
  Google's OAuth verification **plus** a paid annual third-party security
  assessment (CASA). Only worth it if you're turning this into a product.
- **Everyone else** — use the two-files or template-copy method above. It's
  the same experience, minus a one-time "unverified app" click-through.

## Phone alerts

Alerts deliberately never contain email content — only your alert text plus a
link to the Tracker. Change the text via **Advanced → Set alert message**
(the Tracker link is appended automatically). At most 45 alerts are sent per
day, duplicates are suppressed, and **backfilled history never triggers
alerts** — only newly arriving mail does.

## Starting over: the reset

**Extensions → Pingbird → Advanced → ⚠️ Reset (clear & rebuild
template)** wipes the Tracker and every internal sheet (state, alert queue,
logs, tests), removes the scheduled automation, returns to Pilot Mode, and
rebuilds a fresh template — all in one step. Your OpenRouter key, Pocket
Alert webhook, AI model, and backfill window are kept, and any sheets you
added yourself are never touched.

A second prompt asks whether to also delete the Gmail labels:
- **Yes** — "Jbs", "Action required", and the hidden "CG/Processed" label are
  removed from Gmail, so Pingbird forgets which threads it handled and
  a fresh backfill re-imports your history from scratch.
- **No** — labels stay; previously processed threads are not imported again.

After a reset, run **Install / repair automation** (or Quick setup), then
**Scan now** / **Run backfill batch**.

## Verifying a healthy install (release checklist)

Run each of these; all must pass before trusting the system:

- [ ] **Advanced → Run system check** — all green, including all safety tests.
- [ ] **Advanced → Run performance probe** — Gmail discovery under ~5 s;
      batch message load under ~5 s; tracker read under ~3 s.
- [ ] **Pingbird → Test phone alert** — alert arrives, template shows
      only the message (no `{`/`}` characters → template is `%message%`).
- [ ] **Scan now** completes well under its internal 4-minute deadline
      (typical: 5–30 s; check the popup's elapsed time).
- [ ] **Scan now** a second time immediately — creates **no duplicate**
      Tracker rows and finishes in a few seconds (discovery returns ~0 new
      threads).
- [ ] Temporarily break the AI key (Advanced → Configure integrations, paste
      a wrong key) and scan: career emails appear as **Review**, stay unread
      in Inbox, and nothing is archived. Restore the key afterwards.
- [ ] Settings shows "Scheduled scans: Installed".

## How it stays fast (for the curious)

Processed threads carry a hidden Gmail label, and the discovery search
excludes that label — so Gmail itself filters out finished work and each run
only sees new mail. Messages are fetched in batches, the Tracker is read once
and written once per run, AI classification is batched (≤5 emails per request,
≤2 requests per run), and every run stops itself at 4 minutes with a stage-by-
stage timing log in the hidden `_Log` sheet (`PERF` rows).

## Known limitations

1. **AI-deferred email**: if a run finds more than 10 candidate emails, the
   extras wait for the next scheduled run (at most ~4 hours). Backfill batches
   are similarly sized on purpose.
2. **Hidden label visibility**: if the Gmail Advanced Service isn't enabled,
   the `CG/Processed` label appears collapsed under a "CG" group in Gmail's
   sidebar instead of being fully hidden. Cosmetic only.
3. **Noise threads don't get follow-up**: a thread classified as a newsletter
   is marked processed; if a genuine recruiter later replies *on that same
   thread*, it won't be rediscovered. New threads always are.
4. **Reminder escalation**: an unactioned Pending item does not currently
   re-alert as its deadline approaches; you get one alert per action email.
5. **AI quality depends on the chosen OpenRouter model**. The default is
   `openrouter/auto`; set the `CG_AI_MODEL` user property to pin a model.
   Deterministic safety rules veto destructive outcomes regardless of model.
6. **English-language patterns**: the deterministic rules target English ATS
   phrasing. AI handles other languages, but with Review-first safety.
7. **Pocket Alert daily cap**: at most 45 alerts/day are sent (provider limit
   is 50); further alerts queue for the next day.
8. **AI-outage trade-off (changed in 4.1.0)**: when AI is unavailable, emails
   with *no* deterministic career evidence are treated as unrelated instead of
   being escalated to Review. A rare ambiguous job email could be missed
   during an AI outage; explicit acknowledgements, assessments, interviews,
   offers, and rejections are still caught by rules regardless.

## What changed in 4.1.0

- Fixed: non-job mail (tax intimations, bank statements, subscription
  marketing, course admissions) no longer becomes Review rows or phone
  alerts. "Assessment Year" tax notices are recognized as the false friend
  they are, and a transactional-mail noise filter plus a career-signal gate
  keep evidence-free mail away from both the Tracker and the AI budget.
- Fixed: when AI fails, evidence-free emails fall back to *unrelated*
  (rules-only, like the original version) instead of Review; AI failures are
  now visible in Settings → **Last AI error**.
- Fixed: duplicate no-action rows (repeated ATS acknowledgements, same
  thread/stage updates) are collapsed instead of inserted again.
- The menu moved under **Extensions → Pingbird**.
- Backfill window is configurable (default 6 months) via a first-run prompt
  or **Advanced → Set backfill window**.
- New: **Advanced → Set AI model** (with instant test) and
  **Advanced → Dismiss noise Review rows** cleanup.
- Empty roles show as blank instead of "Role not detected".

## What changed in 4.2.0

- The script now bootstraps the full template on any blank Google Sheet — the
  `.xlsx` template is optional. Setup also removes the empty default "Sheet1"
  and orders the tabs Home → Tracker → Settings (user-added sheets with data
  are never touched).
- New **Advanced → ⚠️ Reset (clear & rebuild template)**: one-step wipe and
  rebuild of every Pingbird sheet and all run state, keeping your
  saved secrets, with an optional Gmail-label wipe for a full history
  re-import.
- The repair menu item is now named **Create / repair template on this
  sheet** to make the blank-sheet path obvious.

## What changed in 4.3.0

- **Fixed the AI 404** (`No endpoints found matching your data policy (Zero
  data retention)`): the hard Zero-Data-Retention requirement is gone. Career
  Guardian now asks OpenRouter for providers that don't train on data, and if
  that policy leaves no endpoint for your model (typical for free models) it
  automatically retries without the restriction. Email bodies are sanitized
  (URLs, phone numbers, addresses stripped) before any AI call either way.
  This 404 is also why the webhook step *looked* broken — the AI test runs
  right after the URL prompt; the URL itself was valid, and the validator now
  also tolerates trailing slashes.
- **Backfill is ~10× faster per click**: one run now loops pass after pass
  (up to 30 emails per AI batch pass) until the ~4-minute execution budget is
  spent or the window is exhausted — no more 10-at-a-time. Nothing was ever
  lost before; "deferred" emails were simply queued for the next run.
- **One row per application**: the Tracker deduplicates by job/requisition
  ID, then company + role, then Gmail thread (see "The Tracker" above).
- **Pilot Mode removed** — always live. Only rule-and-AI-agreed no-action
  emails are archived; uncertain mail never is.
- **Configurable phone alert text** via Advanced → Set alert message.
- System check, safety tests, and the performance probe are gone from the
  menu (the functions still exist and can be run from the Apps Script editor
  if ever needed).

## What changed in 1.1.0

- **Backfill now walks your window in 15-day date slices, newest first.**
  Pick 12 months and each run imports slice after slice until its ~4-minute
  budget is spent, then reports exactly what happened: *"Data added for
  21 Jul → 04 Aug"* and *"next run continues backwards from 21 Jul"*. The
  cursor is saved after every completed slice, so Apps Script's 6-minute
  limit can never lose progress; a slice only counts as done when its Gmail
  query returns zero unprocessed threads. Settings shows "Imported back to
  <date>". Changing the window restarts the import from today backwards.
- **Secrets audit**: confirmed no API keys, tokens, or webhook URLs are
  hardcoded anywhere in the source — your OpenRouter key and Pocket Alert
  URL live only in your Google account's User Properties, are never written
  to any sheet or log, and do not travel when the spreadsheet is copied.

## What changed in 1.0.1

- Home's "Needs your attention" list now has working **Open email** links
  (they were plain text — sheet reads return display text, not hyperlinks, so
  the links are rebuilt as formulas on every refresh).
- **Actionable items always have a deadline**: when an email states none, the
  Deadline defaults to one week after it arrived (shown as "Default: 1
  week"). Explicit deadlines are never overridden.
- **Status is editable right on Home** (dropdown in the attention list).
  Setting Completed/Dismissed removes the item from the list immediately,
  updates the matching Tracker row, clears the Gmail "Action required" label,
  and archives the thread when that's rule-confirmed safe — same behavior as
  editing the Tracker directly, in both directions.

## What changed in 4.4.0

- **Rejections are actually caught now.** Real-world phrasing like Google's
  "decided not to proceed with your application" matches, using a two-tier
  design: past-tense completed decisions always fire, while conditional-prone
  phrases ("not selected for this position") are still vetoed by hypothetical
  wording ("If you are not selected…") — so acknowledgements remain safe.
- **Recruiter name and email columns** (visible, after Notes). Existing
  trackers are migrated automatically on the next scan — two columns are
  inserted in place, no data moves.
- **Recruiter personal emails map to the real employer.** "Divya Chaudhary
  (xWF) <chaudharydi@google.com>" now yields Company = Google (derived from
  the sender's corporate domain), so the application → assessment → rejection
  chain merges into one row instead of fragmenting across recruiter names.
  When the company matches exactly one tracked application, updates link to
  it even when the role can't be compared.
- **LinkedIn notification flood fixed**: "application viewed", job alerts,
  digests and similar platform notifications are noise; genuine "your
  application … was sent" confirmations are still tracked. Run **Advanced →
  Dismiss noise Review rows** once to clear existing LinkedIn Review rows.
- **Confident no-action career emails become quiet "No action" rows** that
  stay in the Inbox (never archived without rule proof) instead of Review
  rows with phone alerts.
- Extraction hardening: articles ("the", "a") are never a Role; run-on
  sentence captures ("Ollion. We appreciate…") are truncated to the company
  name.
