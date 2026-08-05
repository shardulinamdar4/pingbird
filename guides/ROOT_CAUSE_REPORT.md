# Career Guardian — Root-Cause Report

Comparison of the first working implementation (`Code.gs`, 729 lines, "Job Tracker v1")
against the latest failing implementation (`Career_Guardian_v3_4_Code.gs`, 2,412 lines),
explaining exactly why v1 finished in seconds and v3.x hits *Exceeded maximum execution time*.

---

## 1. The one property that made v1 fast — and v3.x removed

**v1's Gmail query contained its own dedup filter:**

```
-label:"Job Tracker/Processed" ... newer_than:365d (career phrases)
```

Because processed threads carried a Gmail label, **Gmail itself excluded finished
work from the search**. Each run received only *new* threads. Work per run was
proportional to **new mail since the last run** (usually 0–5 threads), not to
mailbox size. Dedup cost the script nothing.

**v3.x inverted this.** It runs four broad queries with no negative filter —
including a catch-all `in:inbox newer_than:5d` — that return **the same 200–480
threads every single run, forever**. Dedup moved into the script: read the entire
`_State` sheet plus a Tracker column into a Set, then call `thread.getMessages()`
on every thread individually to check each message against the Set.

So every v3.x run pays a fixed tax of roughly:

| Operation | Count | Typical cost | Subtotal |
|---|---|---|---|
| `GmailApp.search` | 4 | 1–3 s | 4–12 s |
| `thread.getMessages()` (per thread) | up to 240–480 | 150–400 ms | **40–120 s** |
| `_State` + Tracker bulk read | 1 | 1–2 s | 1–2 s |

**40–130 seconds are burned before a single email is classified**, and the same
tax is re-paid on the next run because nothing removes those threads from the
queries. This is the treadmill: v3.4's "execution guard" defers work when the
budget runs low, but the deferred work never shrinks, because the budget was
consumed by *rediscovery*, not progress.

## 2. Sequential AI calls (v3.1 – v3.3)

v3.1 allowed up to 45 sequential OpenRouter calls per run, each 3–15 s, with
`Utilities.sleep(attempt * 1200)` backoff between retries. That path **alone**
exceeds six minutes. v3.4 correctly moved to batched AI calls (4 emails per
request, max 2 batches) — this part of v3.4 is sound and is retained in the
rebuild — but every other cost above remained.

## 3. Per-message Sheet I/O

For every message/candidate, v3.x performed individual Sheets API round trips
(each ~200 ms–2 s):

- `recordState_` → `appendRow` **per examined message** (including noise).
- `insertTrackerRow_` → `insertRowBefore` + `setValues` + `setFormula` + 3×`setNumberFormat` + styling = **~8 calls per row**.
- `resolvePriorTrackerRows_` → **full `getDataRange().getValues()` per job email**.
- `queueAttentionAlert_` → `createTextFinder` scan of the outbox **per alert**.
- `reconcileThread_` → another full Tracker read **per touched thread**.

Ten candidates ≈ 40–60 additional Sheets round trips ≈ 30–90 s.

## 4. Hidden constant costs

- `getTimeZone_()` called `SpreadsheetApp.openById()` on **every invocation**, and it
  is invoked per classified message via `todayKey_()` → `consumeAiBudget_()`, and per
  formatted date in the UI.
- Every AI call re-fetched `getSpreadsheet_().getUrl()` for the referer header.
- `refreshUiSafe_()` — full Home + Settings rebuild (≈25 range operations plus
  `ScriptApp.getProjectTriggers()`) — ran **after every scan and inside every
  Tracker edit**.

## 5. The two historical runtime errors

| Error | Cause | Status |
|---|---|---|
| `Range.setColumnWidth is not a function` | `setColumnWidth` is a **Sheet** method; an earlier version called it on a Range object | Fixed; rebuild only ever calls `sheet.setColumnWidth(col, px)` |
| `Invalid argument: timeZone` | A freshly converted spreadsheet can return an empty/invalid timezone, which was passed unvalidated into `Utilities.formatDate` / trigger `.inTimezone()` | Fixed; validated fallback chain (spreadsheet → script → `Asia/Kolkata` → `GMT`), resolved once per execution |

## 6. Why reducing loop counts never fixed it

v3.4 already reduced `maxThreadsPerQuery` to 60 and candidates to 8. It still
timed out, because caps don't change the *shape* of the cost: 4 broad queries ×
60 threads = up to 240 `getMessages()` round trips of pure rediscovery, plus
per-message sheet writes, plus UI rebuild. The cost is O(tracked mailbox) per
run instead of O(new mail) per run.

## 7. What the rebuild (v4.0.0) does

1. **Restores the v1 engine**: one negatively-filtered discovery query using a
   *hidden* processed label (`CG/Processed`, hidden via the Gmail Advanced
   Service so the label list stays clean), plus one bounded follow-up query on
   existing `Jbs` threads. Steady-state discovery returns near-zero threads.
2. **Batched Gmail reads**: `GmailApp.getMessagesForThreads()` per chunk and
   `label.addToThreads()` for batch labeling, instead of per-thread calls.
3. **Batched AI** (kept from v3.4): ≤5 emails per request, ≤2 requests per run,
   at most 1 retry, no sleep loops, strict JSON validation, deterministic safety
   vetoes unchanged.
4. **One read, one write**: Tracker/state/outbox are read once into memory and
   written once at the end (single `insertRowsBefore` + `setValues`).
5. **Deliberate 240 s internal deadline** with stage instrumentation
   (START → SEARCH_GMAIL → LOAD_MESSAGE → PRE_FILTER → AI_REQUEST →
   CLASSIFICATION → WRITE_TRACKER → UPDATE_LABELS → SEND_NOTIFICATION →
   REFRESH_HOME → COMPLETE), each stage logging elapsed ms, item counts, and
   remaining budget to `_Log` and to the execution console.
6. **Module separation** exactly as specified: setup, integrations, scan,
   backfill batch, notification retry, home refresh, and trigger installation
   are independent functions; none of them does another's work. Backfill is
   resumable *for free* — the processed label is the checkpoint.
7. **Bounded UI refresh**: value-range writes only; no rebuild during scans.

Expected steady-state scan time: **5–20 s**. Worst case (10 new candidates,
2 AI batches): **60–120 s**, well inside the 240 s deadline.
