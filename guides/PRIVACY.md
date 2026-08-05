# Pingbird — Privacy Architecture

Pingbird has no server, no database, no account system, and no telemetry.
This document is the complete data-flow map.

## Where your data goes

| Data | Destination | Controlled by |
|---|---|---|
| Your email (full) | The hidden/visible sheets in **your** Google Sheet | You (your Google account) |
| Email excerpts for classification | The AI provider you configured (OpenRouter) | You (your key, your model choice) |
| A generic alert ("open your Tracker") | Your Pocket Alert webhook | You |
| Anything at all | The person who shared Pingbird with you | **Nothing. Ever.** |

## What is sanitized before AI sees it

Before any text is sent to OpenRouter, Pingbird strips: URLs, phone numbers,
email addresses, and long numeric IDs, and truncates bodies. Requests are
sent with OpenRouter's `data_collection: "deny"` provider preference (no
training on your data); if your chosen model has no endpoint under that
policy, Pingbird retries without it — you can pin a specific model via
Advanced → Set AI model if you want stricter control.

## What is never sent to your phone

The Pocket Alert notification is intentionally content-free: no sender, no
subject, no company, no role, no deadline. If your phone is compromised or a
notification appears on a lock screen, an attacker learns only that
*something* needs attention in a spreadsheet.

## Secrets

Your OpenRouter key and Pocket Alert webhook are stored in Google Apps
Script **User Properties** — scoped to your Google account, not visible in
any sheet cell, and **not included** when someone copies your spreadsheet.

## Permissions the script requests, and why

- **Gmail (modify)** — read career email, apply/remove the three labels,
  keep action emails in the Inbox, archive confirmed no-action mail.
- **Spreadsheets** — maintain the Tracker and hidden state sheets.
- **External requests** — call OpenRouter and your Pocket Alert webhook.
  These are the only two endpoints in the code.
- **Triggers** — run the five daily scans.

The entire source is in one readable file; verify every claim above yourself.
