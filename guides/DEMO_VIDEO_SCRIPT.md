# Pingbird — OAuth Demo Video Script

A ready-to-record script for the Google OAuth verification demo video. It shows the
consent flow and demonstrates how **each requested scope** is used. Target length: **3–5 min**.

---

## 0. Before you record (setup)

- **Do NOT record against production.** Use a **test project or a hidden/staging route**, and a
  **test Google account** (add it under *Audience → Test users* on the consent screen).
- The **"Google hasn't verified this app"** warning **will** appear for the test account — this is
  **expected and must be shown** in the video. Click **Advanced → Go to Pingbird (unsafe)** to proceed.
- Seed the test inbox with a few realistic job emails (an application confirmation, an assessment
  invite, an interview invite, a rejection) so the scan has something to classify.
- **Recorder (Mac):** press `⌘⇧5` → *Record Entire Screen* (or QuickTime → New Screen Recording).
  Record your mic for narration, OR record silent and add on-screen captions.
- Speak in **English** (or add English captions). Show the **browser URL bar** during the consent
  step so the OAuth client ID is visible.

---

## 1. Scene-by-scene script

| # | On screen (what you do) | Narration (say this) | Scope shown |
|---|---|---|---|
| 1 | Homepage `https://shardulinamdar4.github.io/pingbird/` | "This is Pingbird — a free, open-source Google Sheets add-on that tracks your job applications from Gmail and pings your phone only when you need to act." | — (intro) |
| 2 | Open a Google Sheet → **Extensions menu** → **Pingbird → Set up** | "Pingbird runs inside Google Sheets. Opening its menu and setup dialog uses the *container UI* scope to render the add-on's menu, sidebar, and dialogs." | `script.container.ui` |
| 3 | The **OAuth consent screen** appears. Slowly scroll so **every requested permission is readable**. Keep the URL bar visible. | "When I authorize Pingbird, Google shows the exact permissions it requests. I'll walk through how each one is used." | (all scopes listed) |
| 4 | The **"Google hasn't verified this app"** screen → **Advanced → Go to Pingbird** | "Because the app is still in verification, the unverified-app warning appears for my test account. I'll continue as the developer." | — (required to show) |
| 5 | Grant consent → back in the Sheet. Open **Settings** sheet showing the signed-in account email. | "After consent, Pingbird reads my primary account email address — the *userinfo.email* scope — to identify my account and route my personal phone alerts to me." | `userinfo.email` |
| 6 | Show the **test Gmail inbox** with the seeded job emails. | "Here's my inbox with several job-search emails: an application confirmation, an assessment, an interview invite, and a rejection." | context |
| 7 | Back in the Sheet → **Pingbird → Scan now**. Show it processing. | "I run a scan. Pingbird reads my messages to find and classify job-application email — this is the read part of the *gmail.modify* scope. It never composes, sends, or deletes email." | `gmail.modify` (read) |
| 8 | Show the **Tracker sheet** filling in — one row per application (company, role, stage, recruiter). | "For each application, Pingbird writes a single, self-updating row into my own spreadsheet — the *spreadsheets* scope. It maintains the Home, Tracker, and Settings tabs." | `spreadsheets` |
| 9 | Switch to Gmail → show a **Pingbird label** applied, an **action email still unread in the Inbox**, and a **noise email archived**. | "Pingbird also organizes my inbox using *gmail.modify*: it applies its labels, keeps action-required threads unread in my Inbox so I don't miss deadlines, and archives only job emails that both its rules and the classifier agree need no action." | `gmail.modify` (label/archive/unread) |
| 10 | Show the classification result / mention the API key in Settings. Then show the **phone notification** arriving (or the Pocket Alert config). | "Classification is done by the AI provider I configure with my own key, and a content-free alert is sent to my phone through my own Pocket Alert webhook. These are the only two external calls — the *external request* scope — and both are locked to a manifest allow-list." | `script.external_request` |
| 11 | Open **Apps Script → Triggers** (or **Pingbird → Automation** menu) showing the scheduled triggers. | "Pingbird installs scheduled daily scan triggers plus one edit trigger so the tracker stays current in the background — the *run when the user is not present* scope. I can pause them anytime from the menu." | `script.scriptapp` |
| 12 | Return to the homepage's **"How Pingbird uses your Google data"** section, then the **Privacy Policy** page. | "Every scope and its purpose is documented on our homepage and privacy policy, which follows Google's Limited Use requirements. There's no server and no account — everything runs in my own Google account." | recap |

---

## 2. Coverage checklist (all six scopes MUST appear)

- [ ] `userinfo.email` — scene 5
- [ ] `gmail.modify` — scenes 7 (read) + 9 (label/archive/unread)
- [ ] `spreadsheets` — scene 8
- [ ] `script.external_request` — scene 10
- [ ] `script.scriptapp` — scene 11
- [ ] `script.container.ui` — scene 2
- [ ] OAuth consent screen with scopes visible — scene 3
- [ ] Unverified-app warning shown — scene 4

---

## 3. After recording

1. Upload to **YouTube** and set visibility to **Unlisted** (not Private — reviewers must be able to open it; not Public — no need).
2. Copy the video URL.
3. Cloud Console → **Google Auth Platform → Verification centre / Data access** → paste into the **Video link** field.
4. Re-submit for verification.

## 4. Reviewer gotchas

- The consent screen **must** show the actual scopes — don't cut this scene.
- The unverified-app warning **must** be shown — don't skip it.
- Demonstrate **real product behavior** for each scope, not just slides.
- Keep it tight (3–5 min) but don't rush past the consent screen or any scope demo.
