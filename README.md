# 🐦 Pingbird

**Your job hunt on silent. It only chirps when you must act.**

Pingbird is a private, AI-powered job-search guardian that lives entirely
inside your own Gmail and a Google Sheet. It reads your application emails so
you don't have to, keeps one clean row per application, quietly archives the
noise — and pings your phone only when something actually needs you: an
assessment to complete, an interview to confirm, a recruiter waiting on an
answer, an offer on the table.

## Why it's different

Every job tracker on the market — Teal, Simplify, Careerflow, the spreadsheet
you abandoned in week two — asks you to do the tracking. Pingbird inverts it:
**the tracker maintains itself from your inbox.** You never log an
application, move a card, or update a status. And unlike hosted tools, no
company (including whoever shared Pingbird with you) ever touches your Gmail:
everything runs as a script inside *your* Google account.

| | Typical job trackers | Pingbird |
|---|---|---|
| Data entry | You, manually | Automatic, from Gmail |
| Where your email lives | Their servers | Your Google account |
| Notifications | Everything, or nothing | Only when action is required |
| Rejections, acks, status noise | You triage | Auto-filed, inbox stays clean |
| Cost | Freemium subscriptions | Free (your own free AI key) |

## How it works

1. **Watches** — five times a day, a Gmail-side query surfaces only *new*
   career email. Newsletters, job alerts, "your application was viewed"
   notifications, bank/tax lookalikes ("Assessment Year"!) are discarded.
2. **Understands** — an AI classifier (your own OpenRouter key, batched,
   pennies-or-free) reads each candidate email; deterministic safety rules
   hold veto power: nothing is archived and nothing is marked *Rejected*
   unless explicit rule-level evidence agrees.
3. **Tracks** — one row per application, deduplicated by job/requisition ID →
   company + role → email thread. Stages only move forward; a rejection or
   completion closes the loop; recruiter name and email are captured.
4. **Chirps** — a required action pins the email unread in your Inbox with an
   "Action required" label and sends one content-free phone ping via Pocket
   Alert: just "open your Tracker," never the email itself.

## Privacy, in one breath

Gmail → your Sheet (your account). Sanitized excerpts (links, phone numbers,
addresses stripped) → the AI provider you chose. A generic ping → your Pocket
Alert. **Nothing → anyone else. There is no server.** Details in PRIVACY.md.

## Install (about 5 minutes)

1. Create a blank Google Sheet.
2. Extensions → Apps Script → name the project **Pingbird** → paste
   `Code.gs`, and paste `appsscript.json` (enable "Show manifest" in project
   settings first). Save, reload the sheet.
3. **Extensions → Pingbird → 🚀 Quick setup** — paste your OpenRouter API key
   and a Pocket Alert webhook (template must be exactly `%message%`). Click
   through Google's one-time "unverified app" screen — it's *your* script in
   *your* account.
4. **Scan now**, then **Run backfill batch** to import history (default 6
   months, configurable).

Full walkthrough, sharing instructions, and troubleshooting: SETUP_GUIDE.md.

## Launch-day checklist

- [ ] Project named **Pingbird** (that's the Extensions menu label)
- [ ] Quick setup green: AI test ✓, phone test ✓
- [ ] `Scan now` twice — second run finishes in seconds with zero duplicates
- [ ] Backfill run once; Tracker rows look sane; Settings → Last AI error = None
- [ ] Alert text customized (Advanced → Set alert message) if desired
- [ ] Clean template copy shared (File → Make a copy path) or the two files sent

## Known limits (honest edition)

AI-deferred emails wait for the next scheduled run. During an AI outage,
evidence-free ambiguous mail is skipped rather than escalated (explicit
acknowledgements, assessments, interviews, offers, rejections are still
caught by rules). English-first rule patterns; a recruiter mailing from a
staffing agency's domain is filed under the agency. The name "Pingbird" was
collision-checked by web search only — verify domain and trademark before
spending on branding.

---
*Pingbird v1.0.0 · MIT licensed · runs on Google Apps Script, OpenRouter, and
Pocket Alert · no servers, no accounts, no tracking.*
