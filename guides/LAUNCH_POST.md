# Pingbird — launch copy (ready to paste)

## Short (X / LinkedIn comment / WhatsApp)

I built Pingbird 🐦 — a job-hunt guardian that lives inside your own Gmail +
Google Sheet. It reads application emails for you, keeps one clean row per
application, archives the noise, and pings your phone ONLY when you must act
(assessment, interview, recruiter question, offer). No servers, no signup —
your data never leaves your Google account. Free & open source. DM for the
template.

## Long (LinkedIn post / Product Hunt description)

An assessment deadline nearly slipped past me, buried under LinkedIn digests
and "your application was viewed" noise. Every job tracker I tried had the
same flaw: **I** was the tracker. Log the application, move the card, update
the status — abandoned by week two.

So I built the opposite. **Pingbird** — your job hunt on silent; it only
chirps when you must act.

🐦 **It watches.** Five times a day it scans Gmail for career email — and only
new mail, so it stays fast forever. Newsletters, job alerts, "application
viewed" pings, even income-tax "Assessment Year" lookalikes are filtered out.

🧠 **It understands.** An AI classifier (your own free OpenRouter key) reads
each email; hard-coded safety rules hold veto power — nothing is archived and
nothing is marked Rejected unless explicit textual evidence agrees.

📋 **It tracks itself.** One row per application, deduplicated by job ID →
company + role → thread. Application → assessment → interview → offer or
rejection, chained automatically. Recruiter name and email captured.

🔕 **It respects your attention.** Action needed? The email stays pinned
unread in your Inbox and your phone gets one content-free ping: "open your
Tracker." Everything else is handled silently.

🔒 **It's private by architecture, not by promise.** No server. No account.
The whole product is one Apps Script file running inside YOUR Google account.
I couldn't read your email if I wanted to.

Free, MIT-licensed. Setup is ~5 minutes: blank Google Sheet + two pasted
files + your keys. Comment "🐦" and I'll send the template.

## Product Hunt one-liners

- Tagline: **Your job hunt on silent — it only chirps when you must act.**
- First comment angle: the "I was the tracker" problem; privacy-by-
  architecture; built solo on Google Apps Script + OpenRouter + Pocket Alert.

## FAQ ammunition

- **"Why not Teal/Simplify?"** They're boards you maintain. Pingbird is a
  guardian that maintains itself — and your email never touches a third-party
  server.
- **"Is AI deciding to delete my email?"** No. AI can only *suggest*;
  deterministic rules must independently confirm before anything is archived,
  and uncertain email always stays in the Inbox.
- **"What does the phone alert reveal?"** Nothing. No company, role, subject,
  or deadline — by design.
- **"Cost?"** Free. OpenRouter free-tier models work; alerts use Pocket
  Alert's free daily quota (Pingbird caps itself below it).
