/**
 * Pingbird v4.0.0 — private, AI-first job-email guardian.
 *
 * Rebuilt on the engine of the first working implementation:
 *   - Discovery uses a Gmail-side negative filter (-label:CG/Processed), so
 *     each run only ever sees NEW work. Work per run is proportional to new
 *     mail, not mailbox size. The processed label IS the checkpoint, which
 *     also makes backfill resumable for free.
 *   - Gmail messages are fetched in batches; labels are applied in batches.
 *   - Tracker, state, and outbox are read once and written once per run.
 *   - AI classification is batched (max 5 emails/request, max 2 requests/run).
 *   - Every run stops deliberately at an internal 240 s deadline.
 *
 * Visible sheets: Home, Tracker, Settings. Internal sheets are hidden.
 * Visible Gmail labels: "Jbs" and "Action required" only. The processed label
 * "CG/Processed" is hidden from the label list via the Gmail Advanced Service.
 *
 * Pocket Alert webhook template must be exactly: %message%
 */

/* ================================================================== *
 * SECTION 1 — CONFIG
 * ================================================================== */

const CG = Object.freeze({
  VERSION: '1.2.0',
  LABELS: Object.freeze({
    JOBS: 'Jbs',
    ACTION: 'Action required',
    PROCESSED: 'CG/Processed' // hidden from the Gmail label list
  }),
  SHEETS: Object.freeze({
    HOME: 'Home', TRACKER: 'Tracker', SETTINGS: 'Settings',
    STATE: '_State', OUTBOX: '_Outbox', LOG: '_Log', TESTS: '_Tests'
  }),
  PROPS: Object.freeze({
    SPREADSHEET_ID: 'CG_SPREADSHEET_ID', OWNER_EMAIL: 'CG_OWNER_EMAIL',
    ALERT_MESSAGE: 'CG_ALERT_MESSAGE',
    OPENROUTER_KEY: 'CG_OPENROUTER_KEY', AI_MODEL: 'CG_AI_MODEL',
    POCKET_WEBHOOK: 'CG_POCKET_WEBHOOK', LAST_SCAN_AT: 'CG_LAST_SCAN_AT',
    LAST_ALERT_OK: 'CG_LAST_ALERT_OK', LAST_ALERT_ERROR: 'CG_LAST_ALERT_ERROR',
    LAST_SCAN_ERROR: 'CG_LAST_SCAN_ERROR', LAST_AI_ERROR: 'CG_LAST_AI_ERROR',
    TESTS_PASSED_AT: 'CG_TESTS_PASSED_AT', BACKFILL_MONTHS: 'CG_BACKFILL_MONTHS',
    AI_CALLS_PREFIX: 'CG_AI_CALLS_', ALERT_SENT_PREFIX: 'CG_ALERT_SENT_',
    BACKFILL_DONE: 'CG_BACKFILL_DONE', BACKFILL_PROGRESS: 'CG_BACKFILL_PROGRESS',
    BACKFILL_CURSOR: 'CG_BACKFILL_CURSOR'
  }),
  AI: Object.freeze({
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openrouter/auto',
    maxBodyChars: 2600,          // per email inside a batch request
    batchMaxTokens: 2400,
    actionConfidence: 0.90,
    dailyRequestBudget: 60       // HTTP requests/day (each carries up to 10 emails)
  }),
  SCAN: Object.freeze({
    budgetMs: 240000,            // deliberate internal deadline (4 minutes)
    reserveWriteMs: 45000,       // held back for writes, labels, notifications
    reserveAiMs: 30000,          // never START an AI request with less left
    newLookbackDays: 7,          // discovery window for brand-new threads
    trackedThreadDays: 14,       // follow-up window on existing Jbs threads
    maxNewThreads: 40,
    maxTrackedThreads: 30,
    threadChunkSize: 25,
    maxCandidatesPerRun: 10,
    aiBatchSize: 5,
    maxAiBatchesPerRun: 2,
    lookbackDays: 30,            // message age cutoff for live scans
    stateMaxRows: 20000
  }),
  BACKFILL: Object.freeze({
    defaultMonths: 6,          // user-configurable; see Set backfill window
    maxMonths: 24,
    sliceDays: 15,             // history is imported in 15-day date slices
    maxThreadsPerPass: 60,
    maxCandidatesPerPass: 30,
    aiBatchSize: 10,
    maxAiBatchesPerPass: 3,
    maxPasses: 12              // one click keeps going until the time budget
  }),
  SCHEDULE_HOURS: Object.freeze([6, 10, 14, 18, 22]),
  ALERT: Object.freeze({
    dailyLimit: 45,              // Pocket Alert allows 50/day; stay under it
    maxAttempts: 5,
    maxSendsPerRun: 5,
    defaultMessage: '🐦 Pingbird: your job hunt needs you. Open the Tracker.'
  })
});

/* ================================================================== *
 * SECTION 2 — RUN STATE, BUDGET, PERFORMANCE INSTRUMENTATION
 * ================================================================== */

function newRunState_() {
  return {
    startedAt: Date.now(),
    aiRequests: 0,
    perf: [],
    lastStageAt: Date.now(),
    cache: {ss: null, url: '', tz: '', dayKey: '', labels: {}}
  };
}
let CG_RUN = newRunState_();
function resetRunState_() { CG_RUN = newRunState_(); }
function elapsedMs_() { return Date.now() - CG_RUN.startedAt; }
function remainingMs_() { return CG.SCAN.budgetMs - elapsedMs_(); }
function timeLeftFor_(reserveMs) { return remainingMs_() > Number(reserveMs || 0); }

/**
 * Stage instrumentation. Logs immediately to the execution console (survives a
 * hard kill) and buffers a PERF row for the hidden _Log sheet.
 */
function perf_(stage, details) {
  const now = Date.now();
  const record = Object.assign({
    stageMs: now - CG_RUN.lastStageAt,
    totalMs: now - CG_RUN.startedAt,
    remainingMs: Math.max(0, remainingMs_())
  }, details || {});
  CG_RUN.lastStageAt = now;
  console.log(`PERF ${stage} ${JSON.stringify(record)}`);
  CG_RUN.perf.push([new Date(), 'PERF', stage, '', JSON.stringify(record).slice(0, 4000)]);
}

/* ================================================================== *
 * SECTION 3 — PROPERTIES, TIMEZONE, MEMOISED HANDLES
 * ================================================================== */

function getUserProps_() { return PropertiesService.getUserProperties(); }
function getScriptProps_() { return PropertiesService.getScriptProperties(); }
function getSetting_(key, fallback) {
  const value = getUserProps_().getProperty(key);
  return value === null || value === '' ? fallback : value;
}
function setSetting_(key, value) { getUserProps_().setProperty(key, String(value)); }
function getAiModel_() { return getSetting_(CG.PROPS.AI_MODEL, CG.AI.defaultModel); }
function ownerEmail_() { return getSetting_(CG.PROPS.OWNER_EMAIL, Session.getEffectiveUser().getEmail() || ''); }

/**
 * The bound spreadsheet ID lives in USER properties. This is mandatory for
 * the Marketplace add-on build: in an add-on, Script Properties are shared
 * by every user of the add-on globally, so storing the sheet ID there would
 * make all installers collide on one spreadsheet. Per-user binding also lets
 * each user run Pingbird against their own sheet. Legacy installs that
 * stored the ID in Script Properties are migrated on first read.
 */
function boundSpreadsheetId_() {
  let id = getUserProps_().getProperty(CG.PROPS.SPREADSHEET_ID);
  if (!id) {
    const legacy = getScriptProps_().getProperty(CG.PROPS.SPREADSHEET_ID);
    if (legacy) {
      getUserProps_().setProperty(CG.PROPS.SPREADSHEET_ID, legacy);
      id = legacy;
    }
  }
  return id || '';
}

function getSpreadsheet_() {
  if (CG_RUN.cache.ss) return CG_RUN.cache.ss;
  const id = boundSpreadsheetId_();
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Run Pingbird → Quick setup first.');
  CG_RUN.cache.ss = ss;
  return ss;
}
function spreadsheetUrl_() {
  if (!CG_RUN.cache.url) CG_RUN.cache.url = getSpreadsheet_().getUrl();
  return CG_RUN.cache.url;
}

/**
 * Validated timezone chain: spreadsheet → script → Asia/Kolkata → GMT.
 * Resolved at most once per execution. Never pass an unvalidated timezone to
 * Utilities.formatDate or trigger builders (historical "Invalid argument:
 * timeZone" error came from a freshly converted sheet returning '').
 */
function getTimeZone_() {
  if (CG_RUN.cache.tz) return CG_RUN.cache.tz;
  const candidates = [];
  try { candidates.push(getSpreadsheet_().getSpreadsheetTimeZone()); } catch (e) {}
  try { candidates.push(Session.getScriptTimeZone()); } catch (e) {}
  candidates.push('Asia/Kolkata');
  for (const candidate of candidates) {
    if (isValidTimeZone_(candidate)) { CG_RUN.cache.tz = String(candidate).trim(); return CG_RUN.cache.tz; }
  }
  CG_RUN.cache.tz = 'GMT';
  return CG_RUN.cache.tz;
}
function isValidTimeZone_(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { Utilities.formatDate(new Date(), value.trim(), 'yyyyMMdd'); return true; }
  catch (e) { return false; }
}
function todayKey_() {
  if (!CG_RUN.cache.dayKey) CG_RUN.cache.dayKey = Utilities.formatDate(new Date(), getTimeZone_(), 'yyyyMMdd');
  return CG_RUN.cache.dayKey;
}

function withLock_(name, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error(`${name} is already running.`);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ================================================================== *
 * SECTION 4 — MENU AND MODULE ENTRY POINTS
 * Each module does one job; none does another module's work.
 * ================================================================== */

function onOpen() {
  // createAddonMenu places the menu under Extensions → <Apps Script project name>,
  // keeping the spreadsheet's own menu bar clean. Name the project "Pingbird".
  const ui = SpreadsheetApp.getUi();
  const advanced = ui.createMenu('Advanced')
    .addItem('Create / repair template on this sheet', 'setupCareerGuardianMenu')
    .addItem('Configure integrations', 'configureIntegrations')
    .addItem('Set AI model', 'setAiModel')
    .addItem('Set alert message', 'setAlertMessage')
    .addItem('Set backfill window', 'setBackfillWindow')
    .addItem('Install / repair automation', 'installAutomation')
    .addItem('Retry one pending alert', 'retryNotificationsMenu')
    .addItem('Dismiss noise Review rows', 'dismissIgnoreReviewRows')
    .addItem('⚠️ Reset (clear & rebuild template)', 'resetCareerGuardian');
  ui.createAddonMenu()
    .addItem('🚀 Quick setup', 'quickSetup')
    .addItem('Scan now', 'scanNow')
    .addItem('Run backfill batch', 'runBackfillBatch')
    .addItem('Test phone alert', 'testPocketAlertConnection')
    .addItem('Open Tracker', 'openTracker')
    .addSeparator()
    .addItem('Pause automation', 'removeAutomation')
    .addSubMenu(advanced)
    .addToUi();
}
function onInstall(e) { onOpen(e); }

/** MODULE 1 — Sheets and labels only. No Gmail scanning, no backfill, no AI. */
function setupCareerGuardian() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  const boundId = boundSpreadsheetId_();
  // Add-on mode: Pingbird can be opened from any spreadsheet, but it is
  // bound to exactly one. If setup runs from a different sheet, ask before
  // moving the binding rather than silently splitting the user's data.
  if (active && boundId && active.getId() !== boundId) {
    const ui = SpreadsheetApp.getUi();
    const answer = ui.alert('Move Pingbird to this spreadsheet?',
      'Pingbird is already set up in another spreadsheet. Move it here? ' +
      'Your Gmail labels and settings are kept; the old spreadsheet keeps its data but stops updating.',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) throw new Error('Setup cancelled: Pingbird stays bound to its current spreadsheet.');
  }
  const ss = active || getSpreadsheet_();
  getUserProps_().setProperty(CG.PROPS.SPREADSHEET_ID, ss.getId());
  CG_RUN.cache.ss = ss; CG_RUN.cache.url = ''; CG_RUN.cache.tz = ''; CG_RUN.cache.dayKey = '';

  try {
    if (!isValidTimeZone_(ss.getSpreadsheetTimeZone())) ss.setSpreadsheetTimeZone(getTimeZone_());
  } catch (e) {}
  CG_RUN.cache.tz = '';

  const email = Session.getEffectiveUser().getEmail();
  if (email) setSetting_(CG.PROPS.OWNER_EMAIL, email);

  ensureAllLabels_();
  ensureAllSheets_(ss);
  toast_('Sheets and labels are ready.', 'Setup complete');
}
function setupCareerGuardianMenu() { setupCareerGuardian(); refreshHome(); }
function setupIfNeeded_() {
  if (!boundSpreadsheetId_()) setupCareerGuardian();
}

/** MODULE 2 — Secrets + one AI test + one Pocket Alert test. Nothing else. */
function configureIntegrations() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();

  ui.alert('Pocket Alert template',
    'In Pocket Alert, set the webhook Message Template to exactly:\n\n%message%',
    ui.ButtonSet.OK);

  const ai = ui.prompt('Step 1 of 2 — AI key',
    'Paste your OpenRouter API key. Leave blank to keep the currently saved key.',
    ui.ButtonSet.OK_CANCEL);
  if (ai.getSelectedButton() !== ui.Button.OK) return false;
  const key = ai.getResponseText().trim();
  if (key) setSetting_(CG.PROPS.OPENROUTER_KEY, key);
  if (!getSetting_(CG.PROPS.OPENROUTER_KEY, '')) {
    ui.alert('An AI key is required. Configuration stopped.'); return false;
  }

  const pocket = ui.prompt('Step 2 of 2 — Pocket Alert',
    'Paste your Pocket Alert receive URL. Leave blank to keep the currently saved URL.',
    ui.ButtonSet.OK_CANCEL);
  if (pocket.getSelectedButton() !== ui.Button.OK) return false;
  const url = pocket.getResponseText().trim();
  if (url) {
    const validation = validatePocketWebhook_(url);
    if (!validation.valid) { ui.alert('Webhook not saved: ' + validation.reason); return false; }
    setSetting_(CG.PROPS.POCKET_WEBHOOK, url);
  }
  if (!getSetting_(CG.PROPS.POCKET_WEBHOOK, '')) {
    ui.alert('A Pocket Alert webhook URL is required. Configuration stopped.'); return false;
  }

  // Exactly one AI test request.
  try { testAiOnce_(); }
  catch (error) { ui.alert('AI test failed: ' + error.message); return false; }

  // Exactly one Pocket Alert test.
  const test = sendPocketAlert_(getSetting_(CG.PROPS.POCKET_WEBHOOK, ''),
    `✅ Pingbird setup test successful. Open Tracker: ${trackerSheetUrl_()}`, 'default');
  if (!test.ok) { ui.alert('Pocket Alert test failed: ' + test.error); return false; }
  incrementDailyAlertsSent_();
  setSetting_(CG.PROPS.LAST_ALERT_OK, new Date().toISOString());

  toast_('AI and Pocket Alert are connected.', 'Integrations configured');
  return true;
}

/** Orchestrates the modules for a non-technical user. No Gmail scanning. */
function quickSetup() {
  const ui = SpreadsheetApp.getUi();
  try {
    setupCareerGuardian();
    if (!configureIntegrations()) return;
    installAutomation_();
    refreshHome();
    refreshSettings_();
    ui.alert('Setup complete',
      'Pingbird will check Gmail at 6 AM, 10 AM, 2 PM, 6 PM and 10 PM.\n\n' +
      'Confirmed no-action job emails are archived automatically; anything needing you, ' +
      'or anything uncertain, always stays unread in your Inbox.\n\n' +
      'Use "Scan now" for a first scan, and "Run backfill batch" to import older history.',
      ui.ButtonSet.OK);
  } catch (error) {
    logSystem_('ERROR', 'QUICK_SETUP', 'Quick setup failed', {error: error.message, stack: error.stack || ''});
    ui.alert('Setup stopped safely', error.message + '\n\nNo automation was installed after this failure.', ui.ButtonSet.OK);
  }
}

/** MODULE 3 — Scheduled/manual live scan. */
function scheduledCareerScan() {
  return withLock_('scan', () => {
    resetRunState_();
    setupIfNeeded_();
    try {
      const summary = runScanPipeline_({backfill: false});
      setSetting_(CG.PROPS.LAST_SCAN_ERROR, '');
      return summary;
    } catch (error) {
      setSetting_(CG.PROPS.LAST_SCAN_ERROR, error.message);
      logSystem_('ERROR', 'SCAN', 'Scan failed', {error: error.message, stack: error.stack || '', elapsedMs: elapsedMs_()});
      throw error;
    }
  });
}
function scanNewCareerEmails() { return scheduledCareerScan(); }
function scanNow() {
  try {
    const s = scheduledCareerScan();
    const tail = s.stopReason ? `\n\nStopped early: ${s.stopReason}. The next run continues automatically.` : '';
    SpreadsheetApp.getUi().alert(
      `Scan complete in ${Math.round(s.elapsedMs / 1000)}s.\n` +
      `New threads found: ${s.threads}. Classified: ${s.scanned}. ` +
      `Attention: ${s.attention}. Review: ${s.review}. Deferred: ${s.deferred}.${tail}`);
  } catch (error) {
    SpreadsheetApp.getUi().alert('Scan failed: ' + error.message);
  }
}

function getBackfillDays_() {
  const months = Number(getSetting_(CG.PROPS.BACKFILL_MONTHS, CG.BACKFILL.defaultMonths));
  const bounded = Math.min(CG.BACKFILL.maxMonths, Math.max(1, Math.round(months) || CG.BACKFILL.defaultMonths));
  return bounded * 30;
}

function setAiModel() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('AI model',
    `Current model: ${getAiModel_()}\n\nEnter an OpenRouter model id (for a free model use a ":free" ` +
    'suffix, e.g. meta-llama/llama-3.3-70b-instruct:free). Leave blank to reset to the default.',
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const value = response.getResponseText().trim();
  if (value) setSetting_(CG.PROPS.AI_MODEL, value);
  else getUserProps_().deleteProperty(CG.PROPS.AI_MODEL);
  try {
    testAiOnce_();
    ui.alert(`AI model "${getAiModel_()}" works.`);
    setSetting_(CG.PROPS.LAST_AI_ERROR, '');
  } catch (error) {
    setSetting_(CG.PROPS.LAST_AI_ERROR, `${new Date().toISOString()} ${error.message}`.slice(0, 500));
    ui.alert(`AI model "${getAiModel_()}" failed: ${error.message}`);
  }
  refreshSettings_();
}

function alertMessage_() {
  return getSetting_(CG.PROPS.ALERT_MESSAGE, CG.ALERT.defaultMessage);
}

function setAlertMessage() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Alert message',
    `Current message:\n${alertMessage_()}\n\nEnter the new phone alert text (the Tracker link is appended ` +
    'automatically). Leave blank to reset to the default. Never put email content here — the whole point is ' +
    'that the notification channel carries no private details.',
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const value = response.getResponseText().trim();
  if (value) setSetting_(CG.PROPS.ALERT_MESSAGE, value.slice(0, 300));
  else getUserProps_().deleteProperty(CG.PROPS.ALERT_MESSAGE);
  refreshSettings_();
  toast_('Alert message updated.', 'Pingbird');
}

function setBackfillWindow() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();
  const current = Number(getSetting_(CG.PROPS.BACKFILL_MONTHS, CG.BACKFILL.defaultMonths));
  const response = ui.prompt('Backfill window',
    `How many months of history should backfill cover? (1–${CG.BACKFILL.maxMonths}, currently ${current})`,
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return false;
  const months = Math.round(Number(response.getResponseText().trim()));
  if (!Number.isFinite(months) || months < 1 || months > CG.BACKFILL.maxMonths) {
    ui.alert(`Please enter a whole number between 1 and ${CG.BACKFILL.maxMonths}.`);
    return false;
  }
  setSetting_(CG.PROPS.BACKFILL_MONTHS, months);
  getUserProps_().deleteProperty(CG.PROPS.BACKFILL_CURSOR);
  getUserProps_().deleteProperty(CG.PROPS.BACKFILL_DONE);
  refreshSettings_();
  toast_(`Backfill window set to ${months} months; import restarts from today backwards.`, 'Pingbird');
  return true;
}

/**
 * MODULE 4 — Backfill. The selected window (e.g. 12 months) is walked
 * newest→oldest in fixed 15-day date slices. A slice is only "done" when its
 * Gmail query returns zero unprocessed threads, and the cursor is persisted
 * after every completed slice — so the 6-minute Apps Script limit can never
 * lose progress, and each run reports exactly which dates were imported and
 * where the next run resumes.
 */
function runBackfillBatch() {
  try {
    setupIfNeeded_();
    // First run: let the user choose how far back to import (default 6 months).
    if (!getUserProps_().getProperty(CG.PROPS.BACKFILL_MONTHS)) {
      if (!setBackfillWindow()) return;
    }
    const result = withLock_('scan', () => {
      resetRunState_();
      setupIfNeeded_();
      const windowStartMs = Date.now() - getBackfillDays_() * 86400000;
      const storedCursor = asDate_(getSetting_(CG.PROPS.BACKFILL_CURSOR, ''));
      let cursorEndMs = storedCursor ? storedCursor.getTime() : Date.now();
      const runStartCursorMs = cursorEndMs;
      const totals = {passes: 0, slicesCompleted: 0, scanned: 0, unrelated: 0, attention: 0};

      while (cursorEndMs > windowStartMs &&
             totals.passes < CG.BACKFILL.maxPasses && timeLeftFor_(75000)) {
        const slice = nextBackfillSlice_(windowStartMs, cursorEndMs, CG.BACKFILL.sliceDays);
        let sliceDone = false;
        let summary = null;
        while (totals.passes < CG.BACKFILL.maxPasses && timeLeftFor_(75000)) {
          summary = runScanPipeline_({backfill: true, slice: slice});
          totals.passes++;
          totals.scanned += summary.scanned;
          totals.unrelated += summary.unrelated;
          totals.attention += summary.attention;
          if (summary.threads === 0) { sliceDone = true; break; }
          if (summary.scanned === 0 && summary.unrelated === 0 && summary.skippedOwn === 0) break;
        }
        if (!sliceDone) break; // out of time/budget mid-slice: cursor stays put
        totals.slicesCompleted++;
        cursorEndMs = slice.startMs;
        setSetting_(CG.PROPS.BACKFILL_CURSOR, new Date(cursorEndMs).toISOString());
      }

      const complete = cursorEndMs <= windowStartMs;
      if (complete) {
        setSetting_(CG.PROPS.BACKFILL_DONE, new Date().toISOString());
        getUserProps_().deleteProperty(CG.PROPS.BACKFILL_CURSOR);
      }
      return {
        totals: totals, complete: complete, elapsedMs: elapsedMs_(),
        importedFromMs: cursorEndMs, importedToMs: runStartCursorMs, windowStartMs: windowStartMs
      };
    });

    const progress = Number(getSetting_(CG.PROPS.BACKFILL_PROGRESS, 0)) + result.totals.scanned;
    setSetting_(CG.PROPS.BACKFILL_PROGRESS, progress);
    refreshSettings_();

    const day = ms => Utilities.formatDate(new Date(ms), getTimeZone_(), 'dd MMM yyyy');
    const rangeText = result.totals.slicesCompleted > 0
      ? `Data added for ${day(result.importedFromMs)} → ${day(result.importedToMs)}: ` +
        `${result.totals.scanned} job emails, ${result.totals.unrelated} filtered as noise.`
      : `${result.totals.scanned} job emails classified in the current slice (slice not yet complete).`;
    SpreadsheetApp.getUi().alert(result.complete
      ? `✅ Backfill complete — the full ${getSetting_(CG.PROPS.BACKFILL_MONTHS, CG.BACKFILL.defaultMonths)}-month window is imported.\n\n` +
        `${rangeText}\nTotal imported overall: ${progress} emails.`
      : `⏱ Time budget executed (${Math.round(result.elapsedMs / 1000)}s, ${result.totals.passes} pass(es)).\n\n` +
        `${rangeText}\n\nNext run continues backwards from ${day(result.importedFromMs)} — ` +
        `just run "Run backfill batch" again. Progress is saved after every completed 15-day slice, ` +
        `so nothing is ever lost to the 6-minute limit. Backfilled emails never trigger phone alerts.`);
  } catch (error) {
    SpreadsheetApp.getUi().alert('Backfill batch failed: ' + error.message);
  }
}

/** Pure slice math: the next 15-day range ending at the cursor, clamped to the window. */
function nextBackfillSlice_(windowStartMs, cursorEndMs, sliceDays) {
  const startMs = Math.max(windowStartMs, cursorEndMs - sliceDays * 86400000);
  return {
    startMs: startMs,
    endMs: cursorEndMs,
    afterSec: Math.floor(startMs / 1000) - 1,
    beforeSec: Math.floor(cursorEndMs / 1000) + 1
  };
}

/** MODULE 5 — One retry of the oldest failed notification. No Gmail. */
function retryNotifications() {
  setupIfNeeded_();
  return retryOldestNotification_();
}
function retryNotificationsMenu() {
  const result = retryNotifications();
  refreshSettings_();
  SpreadsheetApp.getUi().alert(result.attempted
    ? (result.sent ? 'Oldest pending alert delivered.' : 'Retry failed: ' + (result.error || 'unknown'))
    : 'No pending alerts.');
}

/** MODULE 6 — Bounded Home refresh from stored data. No Gmail, no AI. */
function refreshHome() {
  setupIfNeeded_();
  refreshHome_(null);
}

/** MODULE 7 — Idempotent trigger installation. */
function installAutomation() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();
  try {
    if (!getSetting_(CG.PROPS.OPENROUTER_KEY, '')) throw new Error('Configure the OpenRouter AI key first.');
    const webhook = validatePocketWebhook_(getSetting_(CG.PROPS.POCKET_WEBHOOK, ''));
    if (!webhook.valid) throw new Error(webhook.reason);
    installAutomation_();
    refreshSettings_();
    ui.alert('Automation installed', 'Five daily scans and Tracker status syncing are active.', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Automation was not installed', error.message, ui.ButtonSet.OK);
  }
}
function installAutomation_() {
  removeAutomation_();
  const timezone = getTimeZone_();
  const spreadsheetId = getSpreadsheet_().getId();
  try {
    CG.SCHEDULE_HOURS.forEach(hour => {
      ScriptApp.newTrigger('scheduledCareerScan')
        .timeBased().everyDays(1).atHour(hour).nearMinute(0).inTimezone(timezone).create();
    });
    ScriptApp.newTrigger('handleTrackerEdit').forSpreadsheet(spreadsheetId).onEdit().create();
  } catch (error) {
    removeAutomation_();
    throw new Error('Could not install automation: ' + error.message);
  }
  logSystem_('INFO', 'TRIGGERS', 'Automation installed', {hours: CG.SCHEDULE_HOURS, timezone: timezone});
}
function removeAutomation() {
  removeAutomation_();
  refreshSettings_();
  toast_('Automation paused.', 'Pingbird');
}
function removeAutomation_() {
  const handlers = new Set(['scheduledCareerScan', 'handleTrackerEdit']);
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (handlers.has(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  });
}

function openTracker() {
  const ss = getSpreadsheet_();
  ss.setActiveSheet(ss.getSheetByName(CG.SHEETS.TRACKER));
}

/* ================================================================== *
 * SECTION 5 — GMAIL LABELS (with a hidden processed label)
 * ================================================================== */

function ensureLabel_(name) {
  if (CG_RUN.cache.labels[name]) return CG_RUN.cache.labels[name];
  const label = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  CG_RUN.cache.labels[name] = label;
  return label;
}

function ensureAllLabels_() {
  ensureLabel_(CG.LABELS.JOBS);
  ensureLabel_(CG.LABELS.ACTION);
  ensureLabel_(CG.LABELS.PROCESSED);
  hideProcessedLabel_();
}

/**
 * Hides CG/Processed from the Gmail label list via the Gmail Advanced Service.
 * Search by that label still works, which is what discovery relies on.
 * If the advanced service is unavailable, the label simply appears nested and
 * collapsed under "CG" — cosmetic only; functionality is identical.
 */
function hideProcessedLabel_() {
  try {
    if (typeof Gmail === 'undefined' || !Gmail.Users || !Gmail.Users.Labels) return;
    const labels = Gmail.Users.Labels.list('me').labels || [];
    const target = labels.find(label => label.name === CG.LABELS.PROCESSED);
    if (target && target.labelListVisibility !== 'labelHide') {
      Gmail.Users.Labels.patch(
        {labelListVisibility: 'labelHide', messageListVisibility: 'hide'}, 'me', target.id);
    }
  } catch (error) {
    logSystem_('WARN', 'LABELS', 'Could not hide the processed label; it will appear nested under CG', {error: error.message});
  }
}

/** Batch label application: one API call per ≤100 threads instead of one per thread. */
function addLabelToThreads_(label, threads) {
  for (let i = 0; i < threads.length; i += 100) {
    label.addToThreads(threads.slice(i, i + 100));
  }
}

/* ================================================================== *
 * SECTION 6 — SCAN PIPELINE (live scan and backfill share it)
 * ================================================================== */

function runScanPipeline_(options) {
  const backfill = Boolean(options && options.backfill);
  perf_('START', {mode: backfill ? 'BACKFILL' : 'LIVE'});

  const summary = {
    threads: 0, examined: 0, candidates: 0, scanned: 0, deferred: 0,
    attention: 0, review: 0, jobs: 0, unrelated: 0, skippedOwn: 0,
    aiRequests: 0, alertsSent: 0, errors: 0, stopReason: '', elapsedMs: 0
  };

  // Retry exactly one previously failed notification, then move on regardless.
  if (!backfill) {
    const retry = retryOldestNotification_();
    if (retry.sent) summary.alertsSent++;
    perf_('RETRY_NOTIFICATION', {attempted: retry.attempted, sent: Boolean(retry.sent)});
  }

  // ---- Load run context: everything is read ONCE. ----
  const owner = ownerEmail_().toLowerCase();
  const tracker = readTracker_();
  const processed = loadProcessedIds_(tracker);
  const outboxKeys = loadOutboxDedupKeys_();
  perf_('LOAD_STATE', {processedIds: processed.size, trackerRows: tracker.values.length});

  // ---- SEARCH_GMAIL: negatively-filtered discovery (the v1 engine). ----
  const discovery = findCandidateThreads_(backfill, options && options.slice);
  summary.threads = discovery.newThreads.length + discovery.trackedThreads.length;
  perf_('SEARCH_GMAIL', {
    newThreads: discovery.newThreads.length,
    trackedThreads: discovery.trackedThreads.length
  });

  // ---- LOAD_MESSAGE + PRE_FILTER ----
  const cutoff = backfill
    ? new Date(Date.now() - getBackfillDays_() * 86400000)
    : new Date(Date.now() - CG.SCAN.lookbackDays * 86400000);
  const maxCandidates = backfill ? CG.BACKFILL.maxCandidatesPerPass : CG.SCAN.maxCandidatesPerRun;

  const buffers = {
    state: [], tracker: [], outbox: [], updatedRows: new Set(), updatedFullRows: new Set(),
    fullyHandledNewThreads: [], incompleteThreads: new Set(),
    touched: new Set(), threadsById: new Map()
  };
  const candidates = collectCandidates_(discovery, {
    owner: owner, processed: processed, cutoff: cutoff,
    maxCandidates: maxCandidates, summary: summary, buffers: buffers
  });
  summary.candidates = candidates.length;
  perf_('PRE_FILTER', {
    examined: summary.examined, candidates: candidates.length,
    noise: summary.unrelated, skippedOwn: summary.skippedOwn
  });

  // ---- AI_REQUEST / AI_RESPONSE / CLASSIFICATION ----
  classifyCandidates_(candidates, tracker, processed, outboxKeys, buffers, summary, backfill
    ? {backfill: true, batchSize: CG.BACKFILL.aiBatchSize, maxBatches: CG.BACKFILL.maxAiBatchesPerPass}
    : {backfill: false, batchSize: CG.SCAN.aiBatchSize, maxBatches: CG.SCAN.maxAiBatchesPerRun});
  summary.aiRequests = CG_RUN.aiRequests;
  perf_('CLASSIFICATION', {
    scanned: summary.scanned, jobs: summary.jobs, review: summary.review,
    deferred: summary.deferred, aiRequests: CG_RUN.aiRequests
  });

  // ---- WRITE_TRACKER: one batch write per sheet. ----
  applyTrackerUpdates_(tracker, buffers.updatedRows);
  applyFullRowUpdates_(tracker, buffers.updatedFullRows);
  flushTrackerRows_(tracker.sheet, buffers.tracker);
  appendRows_(getSpreadsheet_().getSheetByName(CG.SHEETS.STATE), buffers.state);
  appendRows_(getSpreadsheet_().getSheetByName(CG.SHEETS.OUTBOX), buffers.outbox);
  perf_('WRITE_TRACKER', {
    trackerInserts: buffers.tracker.length, trackerUpdates: buffers.updatedFullRows.size,
    stateRows: buffers.state.length, outboxRows: buffers.outbox.length
  });

  // ---- UPDATE_LABELS ----
  reconcileLabels_(tracker, buffers, summary);
  perf_('UPDATE_LABELS', {
    touched: buffers.touched.size,
    markedProcessed: buffers.fullyHandledNewThreads.length
  });

  // ---- SEND_NOTIFICATION: bounded, deduplicated, daily-capped. ----
  if (timeLeftFor_(15000)) {
    const delivery = deliverPendingAlerts_(CG.ALERT.maxSendsPerRun);
    summary.alertsSent += delivery.sent;
    perf_('SEND_NOTIFICATION', delivery);
  } else {
    summary.stopReason = summary.stopReason || 'Notification delivery deferred to the next run';
    perf_('SEND_NOTIFICATION', {skipped: true});
  }

  // ---- REFRESH_HOME: bounded value writes only. ----
  try { refreshHome_(tracker); } catch (error) {
    logSystem_('WARN', 'UI_HOME', 'Home refresh failed', {error: error.message});
  }
  try { refreshSettings_(); } catch (error) {
    logSystem_('WARN', 'UI_SETTINGS', 'Settings refresh failed', {error: error.message});
  }
  perf_('REFRESH_HOME', {});

  trimStateSheetIfNeeded_();
  setSetting_(CG.PROPS.LAST_SCAN_AT, new Date().toISOString());
  summary.elapsedMs = elapsedMs_();
  perf_('COMPLETE', {summary: summary});
  flushPerfLog_(summary);
  return summary;
}

/**
 * The v1 engine restored:
 *  Q1 (new work): -label:CG/Processed limits the search to threads never
 *     handled before, so Gmail itself excludes finished work.
 *  Q2 (follow-ups, live scans only): existing Jbs threads that may have new
 *     replies; message-level dedup protects against reprocessing.
 * Backfill uses only Q1 with a 365-day window and a small batch cap; the
 * processed label makes every batch resumable with no cursor bookkeeping.
 */
function findCandidateThreads_(backfill, slice) {
  const careerTerms = '{"your application" "thank you for applying" "application received" ' +
    '"received your application" interview assessment "coding challenge" "share your availability" ' +
    '"notice period" "current ctc" "expected ctc" shortlisted "offer letter" ' +
    'from:greenhouse-mail.io from:hire.lever.co from:smartrecruiters.com from:workablemail.com ' +
    'from:myworkday.com from:myworkdayjobs.com from:ashbyhq.com from:icims.com from:successfactors.com}';

  // Backfill walks fixed date slices (after:/before: accept Unix seconds), so
  // "is this range done?" has a definite answer: the slice query returns zero.
  const dateFilter = backfill && slice
    ? `after:${slice.afterSec} before:${slice.beforeSec}`
    : `newer_than:${backfill ? getBackfillDays_() : CG.SCAN.newLookbackDays}d`;
  const newQuery = [
    `-label:${quoteLabel_(CG.LABELS.PROCESSED)}`,
    '-in:spam', '-in:trash', '-in:sent',
    dateFilter,
    careerTerms
  ].join(' ');

  const newThreads = GmailApp.search(newQuery, 0,
    backfill ? CG.BACKFILL.maxThreadsPerPass : CG.SCAN.maxNewThreads);

  let trackedThreads = [];
  if (!backfill) {
    const trackedQuery = `label:${quoteLabel_(CG.LABELS.JOBS)} newer_than:${CG.SCAN.trackedThreadDays}d -in:spam -in:trash`;
    const seen = new Set(newThreads.map(thread => thread.getId()));
    trackedThreads = GmailApp.search(trackedQuery, 0, CG.SCAN.maxTrackedThreads)
      .filter(thread => !seen.has(thread.getId()));
  }
  return {newThreads: newThreads, trackedThreads: trackedThreads};
}

/** Batched message loading + pre-filter. Never one Gmail call per thread. */
function collectCandidates_(discovery, ctx) {
  const candidates = [];
  const groups = [
    {threads: discovery.newThreads, isNew: true},
    {threads: discovery.trackedThreads, isNew: false}
  ];

  for (const group of groups) {
    for (let start = 0; start < group.threads.length; start += CG.SCAN.threadChunkSize) {
      if (!timeLeftFor_(CG.SCAN.reserveWriteMs + CG.SCAN.reserveAiMs)) {
        ctx.summary.stopReason = 'Stopped during candidate collection to protect the write budget';
        return candidates;
      }
      const chunk = group.threads.slice(start, start + CG.SCAN.threadChunkSize);
      let messagesByThread;
      try {
        messagesByThread = GmailApp.getMessagesForThreads(chunk);
      } catch (error) {
        ctx.summary.errors++;
        logSystem_('WARN', 'GMAIL', 'Batch thread read failed', {error: error.message});
        continue;
      }
      perf_('LOAD_MESSAGE', {chunk: chunk.length, group: group.isNew ? 'NEW' : 'TRACKED'});

      for (let t = 0; t < chunk.length; t++) {
        const thread = chunk[t];
        const threadId = thread.getId();
        ctx.buffers.threadsById.set(threadId, thread);
        let fullyHandled = true;

        for (const message of (messagesByThread[t] || [])) {
          const messageId = message.getId();
          if (ctx.processed.has(messageId)) continue;
          if (message.isInTrash()) continue;
          if (message.getDate() < ctx.cutoff) { continue; }
          ctx.summary.examined++;

          const senderEmail = extractEmail_(message.getFrom()).toLowerCase();
          if (isOwnMessage_(senderEmail, ctx.owner)) {
            ctx.summary.skippedOwn++;
            ctx.buffers.state.push([new Date(), messageId, threadId, 'SKIPPED_OWN', 'Message sent by the owner']);
            ctx.processed.add(messageId);
            continue;
          }

          const mail = buildMailRecord_(message, threadId);
          const deterministic = classifyDeterministic_(mail);
          const skipAsNoise = deterministic.decision === 'UNRELATED' &&
            (deterministic.certainty === 'DEFINITE' || !hasCareerCandidateSignal_(mail));
          if (skipAsNoise) {
            ctx.summary.unrelated++;
            ctx.buffers.state.push([new Date(), messageId, threadId, 'NOT_CANDIDATE',
              safeCellText_(deterministic.reason || '')]);
            ctx.processed.add(messageId);
            continue;
          }

          if (candidates.length >= ctx.maxCandidates) {
            ctx.summary.deferred++;
            fullyHandled = false;
            ctx.buffers.incompleteThreads.add(threadId); // must NOT be marked processed this run
            continue;
          }
          candidates.push({mail: mail, deterministic: deterministic, threadId: threadId, isNewThread: group.isNew});
          fullyHandled = false;  // provisional; classification marks it handled on success
        }

        if (group.isNew && fullyHandled) ctx.buffers.fullyHandledNewThreads.push(thread);
      }
    }
  }
  return candidates;
}

/** AI batch classification with deterministic safety vetoes, all buffered. */
function classifyCandidates_(candidates, tracker, processed, outboxKeys, buffers, summary, opts) {
  if (!candidates.length) return;
  const batchSize = (opts && opts.batchSize) || CG.SCAN.aiBatchSize;
  const maxBatches = (opts && opts.maxBatches) || CG.SCAN.maxAiBatchesPerRun;
  const backfill = Boolean(opts && opts.backfill);
  const batches = chunkArray_(candidates, batchSize).slice(0, maxBatches);
  const processable = batches.reduce((count, batch) => count + batch.length, 0);
  summary.deferred += candidates.length - processable;

  const handledNewThreadIds = new Set();

  for (const batch of batches) {
    let aiById = {};
    let aiError = '';
    if (!timeLeftFor_(CG.SCAN.reserveWriteMs + CG.SCAN.reserveAiMs)) {
      summary.deferred += batch.length;
      summary.stopReason = 'Remaining emails deferred before another AI request';
      continue;
    }
    const key = getSetting_(CG.PROPS.OPENROUTER_KEY, '');
    if (!key) aiError = 'AI key is not configured';
    else if (!consumeAiBudget_()) aiError = 'Daily AI request budget reached';
    else {
      perf_('AI_REQUEST', {batchSize: batch.length});
      try {
        aiById = classifyBatchWithAI_(batch);
        setSetting_(CG.PROPS.LAST_AI_ERROR, '');
        perf_('AI_RESPONSE', {results: Object.keys(aiById).length});
      } catch (error) {
        aiError = error.message;
        setSetting_(CG.PROPS.LAST_AI_ERROR, `${new Date().toISOString()} ${error.message}`.slice(0, 500));
        perf_('AI_RESPONSE', {error: error.message.slice(0, 200)});
        logSystem_('ERROR', 'AI_BATCH', 'AI batch failed safely', {
          error: error.message, messageIds: batch.map(item => item.mail.messageId)
        });
      }
    }

    for (const item of batch) {
      const mail = item.mail;
      try {
        let decision;
        const ai = aiById[mail.messageId];
        if (ai) {
          decision = reconcileAiPrimaryDecision_(mail, item.deterministic, ai);
        } else if (item.deterministic.certainty === 'DEFINITE') {
          // AI missing but the rule evidence is explicit: keep the safe rule decision.
          decision = Object.assign({}, item.deterministic, {
            reason: `${item.deterministic.reason || 'Deterministic decision'} • ${aiError || 'AI result missing'}`
          });
        } else if (item.deterministic.decision === 'UNRELATED') {
          // No deterministic career evidence and AI is unavailable: rules-only
          // outcome, exactly like the original working version. Escalating
          // evidence-free mail to Review would spam alerts and train the user
          // to ignore them, which is the worse failure mode.
          decision = Object.assign({}, item.deterministic, {
            reason: `${item.deterministic.reason || 'No career evidence'} • ${aiError || 'AI result missing'}; rules-only decision`
          });
        } else {
          decision = uncertainDecision_(`${aiError || 'AI did not return this email'}; retained for safety`, item.deterministic);
        }

        decision = enrichDecision_(mail, decision);
        if (decision.decision === 'UNRELATED') {
          summary.unrelated++;
          buffers.state.push([new Date(), mail.messageId, mail.threadId, 'UNRELATED', safeCellText_(decision.reason || '')]);
          processed.add(mail.messageId);
          summary.scanned++;
          handledNewThreadIds.add(item.isNewThread ? mail.threadId : '');
          continue;
        }

        if (decision.decision === 'JOB') {
          const identity = validateIdentity_(decision);
          if (!identity.valid) decision = enrichDecision_(mail, uncertainDecision_(identity.reason, decision));
        }

        const status = decision.decision === 'UNCERTAIN' ? 'Review' : (decision.requiresAction ? 'Pending' : 'No action');
        if (decision.decision === 'UNCERTAIN') summary.review++; else summary.jobs++;
        if (status === 'Pending' || status === 'Review') summary.attention++;

        const upsert = upsertApplicationRow_(tracker, buffers, mail, decision, status);
        buffers.state.push([new Date(), mail.messageId, mail.threadId,
          upsert === 'updated' ? decision.decision + '_MERGED' : decision.decision,
          safeCellText_(decision.reason || '')]);
        buffers.touched.add(mail.threadId);

        // Backfill never sends phone alerts; the Tracker carries the history.
        if (!backfill && (status === 'Pending' || status === 'Review')) {
          const dedup = `ATTENTION:${decision.eventType || 'REVIEW'}:${mail.messageId}`;
          if (!outboxKeys.has(dedup)) {
            outboxKeys.add(dedup);
            buffers.outbox.push([new Date(), `ALT-${Utilities.getUuid().slice(0, 8).toUpperCase()}`, dedup,
              `${alertMessage_()} ${trackerSheetUrl_()}`, 'high', 'Pending', 0, '', '', '']);
          }
        }
        processed.add(mail.messageId);
        summary.scanned++;
        handledNewThreadIds.add(item.isNewThread ? mail.threadId : '');
      } catch (error) {
        summary.errors++;
        logSystem_('ERROR', 'MESSAGE', 'Message processing failed safely', {
          messageId: mail.messageId, threadId: mail.threadId, subject: mail.subject, error: error.message
        });
        // Not marked processed and the thread is not labeled: next run retries.
      }
    }
  }

  // New threads whose candidate messages all succeeded can now leave discovery.
  handledNewThreadIds.delete('');
  const stillPending = new Set(candidates
    .filter(item => !processed.has(item.mail.messageId))
    .map(item => item.threadId));
  handledNewThreadIds.forEach(threadId => {
    if (stillPending.has(threadId)) return;
    if (buffers.incompleteThreads.has(threadId)) return; // a deferred message still lives here
    const thread = buffers.threadsById.get(threadId);
    if (thread) buffers.fullyHandledNewThreads.push(thread);
  });
}

/** Thread label + Inbox reconciliation using in-memory tracker rows. */
function reconcileLabels_(tracker, buffers, summary) {
  const jobsLabel = ensureLabel_(CG.LABELS.JOBS);
  const actionLabel = ensureLabel_(CG.LABELS.ACTION);
  const processedLabel = ensureLabel_(CG.LABELS.PROCESSED);
  const rowsByThread = buildRowsByThread_(tracker, buffers.tracker);

  // Batch: everything fully handled leaves discovery in ≤1 call per 100 threads.
  try {
    if (buffers.fullyHandledNewThreads.length) addLabelToThreads_(processedLabel, buffers.fullyHandledNewThreads);
  } catch (error) {
    summary.errors++;
    logSystem_('WARN', 'GMAIL', 'Batch processed-labeling failed', {error: error.message});
  }

  // Batch: all touched job threads get Jbs.
  const touchedThreads = Array.from(buffers.touched)
    .map(threadId => buffers.threadsById.get(threadId)).filter(Boolean);
  try {
    if (touchedThreads.length) addLabelToThreads_(jobsLabel, touchedThreads);
  } catch (error) {
    summary.errors++;
    logSystem_('WARN', 'GMAIL', 'Batch Jbs labeling failed', {error: error.message});
  }

  // Per-thread: Action label / Inbox visibility depends on that thread's rows.
  for (const threadId of buffers.touched) {
    if (!timeLeftFor_(8000)) { summary.stopReason = summary.stopReason || 'Label reconciliation deferred'; break; }
    try {
      const thread = buffers.threadsById.get(threadId) || GmailApp.getThreadById(threadId);
      if (!thread) continue;
      const rows = rowsByThread.get(threadId) || [];
      if (!rows.length) continue;
      if (rows.some(row => ['Pending', 'Review'].includes(row.status))) {
        thread.addLabel(actionLabel);
        thread.moveToInbox();
        thread.markUnread();
      } else {
        thread.removeLabel(actionLabel);
        if (rows[0].safeArchive === 'Yes') thread.moveToArchive();
      }
    } catch (error) {
      summary.errors++;
      logSystem_('WARN', 'GMAIL', 'Thread reconciliation failed', {threadId: threadId, error: error.message});
    }
  }
}

function hasCareerCandidateSignal_(mail) {
  const text = `${mail.sender}\n${mail.subject}\n${mail.body}`.toLowerCase();
  return [
    'your application', 'your candidacy', 'you applied', 'thank you for applying',
    'interview', 'coding challenge', 'recruiter', 'hiring manager',
    'job opportunity', 'offer letter', 'notice period', 'current ctc',
    'expected ctc', 'shortlisted', 'work authorization', 'take-home', 'hackerrank'
  ].some(token => text.includes(token)) || isRecruitingSender_(mail.sender);
}



function normalizeKey_(value) {
  return clean_(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isOwnMessage_(senderEmail, owner) {
  return Boolean(owner) && senderEmail === owner;
}

function chunkArray_(items, size) {
  const chunks = [];
  const width = Math.max(1, Number(size || 1));
  for (let i = 0; i < items.length; i += width) chunks.push(items.slice(i, i + width));
  return chunks;
}

/* ================================================================== *
 * SECTION 7 — CLASSIFICATION
 * AI is the primary semantic classifier. Deterministic rules veto every
 * destructive outcome: archiving, Rejected, and removing Action required.
 * The safer result always wins for actions (AI action OR rule action).
 * ================================================================== */

function classifyDeterministic_(mail) {
  const sender = clean_(mail.sender);
  const subject = clean_(mail.subject);
  const body = clean_(mail.body);
  const text = `${subject}\n${body}`;
  const source = detectSource_(sender);

  if (isDefiniteNoise_(sender, subject, body)) {
    return decision_('UNRELATED', 'Ignore', false, false, 0.999,
      'Known newsletter, marketing, learning, or unrelated sender/content', source, 'DEFINITE');
  }

  const directApplication = hasDirectApplicationContext_(text);
  const recruitingSender = isRecruitingSender_(sender);

  const action = detectExplicitAction_(text);
  if (action && (directApplication || recruitingSender || action.allowWithoutApplicationContext)) {
    return Object.assign(
      decision_('JOB', action.stage, true, false, 0.997, action.reason, source, 'DEFINITE'),
      {eventType: action.eventType, action: action.action, deadlineText: action.deadlineText || '', resolves: []});
  }

  const completion = detectCompletion_(text);
  if (completion && (directApplication || recruitingSender)) {
    return Object.assign(
      decision_('JOB', completion.stage, false, true, 0.995, completion.reason, source, 'DEFINITE'),
      {eventType: completion.eventType, action: '', resolves: completion.resolves || []});
  }

  const rejection = detectExplicitRejection_(text);
  if (rejection && directApplication) {
    return Object.assign(
      decision_('JOB', 'Rejected', false, true, 0.998, rejection.reason, source, 'DEFINITE'),
      {eventType: 'APPLICATION_REJECTED', action: '',
       resolves: ['ASSESSMENT', 'INTERVIEW', 'INFO_REQUEST', 'OFFER_RESPONSE', 'REVIEW']});
  }

  const acknowledgement = detectAcknowledgement_(text);
  if (acknowledgement && directApplication) {
    const stage = acknowledgement.underReview ? 'Under Review' : 'Applied';
    return Object.assign(
      decision_('JOB', stage, false, true, 0.997, acknowledgement.reason, source, 'DEFINITE'),
      {eventType: acknowledgement.underReview ? 'APPLICATION_UNDER_REVIEW' : 'APPLICATION_RECEIVED',
       action: '', resolves: []});
  }

  if (directApplication && recruitingSender) {
    return Object.assign(
      decision_('PROBABLE_JOB', 'Under Review', false, false, 0.75,
        'Recruiting sender and application context, but no safe deterministic intent', source, 'PROBABLE'),
      {eventType: 'AMBIGUOUS_JOB_UPDATE', action: '', resolves: []});
  }

  if (detectRecruiterOutreach_(text, sender)) {
    return Object.assign(
      decision_('PROBABLE_JOB', 'Under Review', true, false, 0.78,
        'Personalized recruiter outreach may require a response', source, 'PROBABLE'),
      {eventType: 'RECRUITER_OUTREACH', action: 'Review recruiter outreach and respond if interested', resolves: []});
  }

  return decision_('UNRELATED', 'Ignore', false, false, 0.60, 'No direct career-process evidence', source, 'WEAK');
}

function decision_(decision, stage, requiresAction, deterministicArchive, confidence, reason, source, certainty) {
  return {
    decision: decision, stage: stage,
    requiresAction: Boolean(requiresAction),
    deterministicArchive: Boolean(deterministicArchive),
    confidence: Number(confidence || 0), reason: reason || '',
    source: source || 'Direct / Other', certainty: certainty || 'WEAK',
    classifier: 'Rules', model: ''
  };
}

function uncertainDecision_(reason, context) {
  return {
    decision: 'UNCERTAIN',
    stage: context && context.stage ? context.stage : 'Under Review',
    requiresAction: true, deterministicArchive: false,
    confidence: context && context.confidence ? context.confidence : 0,
    reason: reason,
    source: context && context.source ? context.source : 'Direct / Other',
    certainty: 'UNCERTAIN',
    classifier: context && context.classifier ? context.classifier : 'Rules',
    eventType: 'REVIEW_REQUIRED', action: 'Review this career-related email', resolves: []
  };
}

function hasDirectApplicationContext_(text) {
  return [
    /\b(?:your|the) application\b/i, /\byour candidacy\b/i,
    /\bjob (?:requisition|application|number|id)\b/i,
    /\brole you applied\b/i, /\bposition you applied\b/i,
    /\bthanks? (?:again )?for applying\b/i, /\bapplication status\b/i
  ].some(rx => rx.test(text));
}

function detectAcknowledgement_(text) {
  const ack = [
    /\bthank(?:s| you) for (?:your )?(?:interest|application|applying)\b/i,
    /\b(?:we|we've|we have) received your application\b/i,
    /\byour application (?:has been|was) received\b/i,
    /\bapplication (?:received|submitted successfully)\b/i,
    /\byour application to .+? was sent\b/i
  ].some(rx => rx.test(text));
  if (!ack) return null;
  return {
    underReview: /\bunder review|currently being reviewed|queued for review|reviewing your application\b/i.test(text),
    reason: 'Explicit application acknowledgement'
  };
}

function detectExplicitRejection_(text) {
  // Two tiers. STRONG patterns are past-tense completed decisions that cannot
  // occur inside a hypothetical sentence — they fire even when the same email
  // also contains conditional wording elsewhere ("we may contact you if...").
  const strong = [
    /\b(?:(?:we|they) )?(?:have )?decided not to (?:move|proceed)(?: forward)? with (?:your|the) application\b/i,
    /\bwe (?:will not|won't) be (?:moving forward|proceeding) with (?:your|the) (?:application|candidacy)\b/i,
    /\byour application (?:will not|won't) be (?:progressed|taken forward)\b/i,
    /\byour application was unsuccessful\b/i,
    /\bwe regret to inform you that (?:you|your application)\b/i,
    /\bwe have (?:chosen|selected) (?:another|other) candidate/i,
    /\bwe won't be progressing your candidacy\b/i,
    /\bwe have decided to pursue other candidates\b/i,
    /\bdecided to pursue other (?:candidates|applicants)\b/i
  ];
  if (strong.some(rx => rx.test(text))) {
    return {reason: 'Explicit completed rejection decision about this application'};
  }

  // WEAK patterns can appear inside conditionals ("If you are not selected
  // for this position, keep an eye on our jobs page"), so they are vetoed by
  // hypothetical wording. This guard is what keeps acknowledgements safe.
  const hypothetical = [
    /\bif you are not selected\b/i, /\bif your qualifications match\b/i,
    /\bshould we decide not to\b/i, /\bwe will (?:contact|be in touch) if\b/i,
    /\bonly shortlisted candidates\b/i, /\bkeep an eye on our jobs page\b/i,
    /\bif we do not contact you\b/i, /\bin case you are not\b/i
  ];
  if (hypothetical.some(rx => rx.test(text))) return null;

  const weak = [
    /\byou have not been selected\b/i,
    /\bnot selected for (?:the|this) (?:role|position)\b/i,
    /\bwe are unable to offer you (?:the|this) position\b/i,
    /\bposition has been filled\b/i
  ];
  return weak.some(rx => rx.test(text))
    ? {reason: 'Explicit completed rejection decision about this application'} : null;
}

function detectExplicitAction_(text) {
  const groups = [
    {
      eventType: 'ASSESSMENT_REQUIRED', stage: 'Assessment', action: 'Complete the assessment',
      allowWithoutApplicationContext: true,
      reason: 'Direct instruction to complete or submit an assessment',
      patterns: [
        /\b(?:complete|take|start|finish|submit|attempt).{0,90}\b(?:assessment|coding challenge|online test|technical test|assignment|take[- ]home)\b/i,
        /\b(?:assessment|coding challenge|online test).{0,90}\b(?:due|deadline|expires|complete by)\b/i,
        /\bhackerrank\b|\bcodility\b|\bcodesignal\b/i
      ]
    },
    {
      eventType: 'INTERVIEW_REQUIRED', stage: 'Interview',
      action: 'Schedule, confirm, or attend the interview', allowWithoutApplicationContext: true,
      reason: 'Direct interview invitation, scheduling, confirmation, or attendance instruction',
      patterns: [
        /\binterview (?:request|invitation|confirmation|scheduled|schedule|details|reminder)\b/i,
        /\b(?:select|choose|book|confirm|share|send).{0,100}\b(?:availability|time slot|interview time)\b/i,
        /\b(?:accept|decline).{0,80}\b(?:calendar )?invitation\b/i,
        /\bjoin (?:the )?interview\b/i,
        /\byou have been shortlisted\b.{0,150}\binterview\b/i,
        /\bupcoming (?:technical |virtual |onsite )?interview\b/i
      ]
    },
    {
      eventType: 'OFFER_RESPONSE_REQUIRED', stage: 'Offer',
      action: 'Review and respond to the offer', allowWithoutApplicationContext: true,
      reason: 'Direct employment offer requiring review or response',
      patterns: [
        /\bwe are pleased to offer you\b/i, /\b(?:employment|job) offer\b/i,
        /\boffer letter\b/i, /\baccept (?:the|your) offer\b/i
      ]
    },
    {
      eventType: 'INFO_REQUEST', stage: 'Under Review',
      action: 'Provide the requested information or documents',
      reason: 'Recruiter requested information, documents, or a reply',
      patterns: [
        /\bplease (?:send|share|provide|confirm|reply with|respond with).{0,140}\b(?:availability|resume|cv|notice period|current ctc|expected ctc|salary|location|documents?|details?|experience|work authorization|visa)\b/i,
        /\bneed (?:some|more|additional) (?:information|details|documents?)\b/i,
        /\baction required\b/i
      ]
    }
  ];
  for (const group of groups) {
    if (group.patterns.some(rx => rx.test(text))) return group;
  }
  return null;
}

function detectCompletion_(text) {
  const groups = [
    {
      eventType: 'ASSESSMENT_COMPLETED', stage: 'Under Review', resolves: ['ASSESSMENT'],
      reason: 'Assessment completed or result received',
      patterns: [
        /\byou passed (?:the )?.{0,40}assessment\b/i,
        /\bassessment (?:has been )?(?:completed|submitted|received)\b/i,
        /\bwe have received your (?:assessment|test|assignment)\b/i
      ]
    },
    {
      eventType: 'INTERVIEW_COMPLETED', stage: 'Interview', resolves: ['INTERVIEW'],
      reason: 'Interview completed or feedback requested',
      patterns: [
        /\byour .{0,30}interview .{0,30}is completed\b/i,
        /\bthank you for interviewing with\b/i,
        /\bprovide feedback from your .{0,30}interview\b/i
      ]
    },
    {
      eventType: 'INTERVIEW_CANCELLED', stage: 'Under Review', resolves: ['INTERVIEW'],
      reason: 'Interview was cancelled or no longer requires attendance',
      patterns: [
        /\binterview (?:has been )?(?:cancelled|canceled)\b/i,
        /\bwe need to cancel (?:your|the) interview\b/i
      ]
    }
  ];
  for (const group of groups) {
    if (group.patterns.some(rx => rx.test(text))) return group;
  }
  return null;
}

function detectRecruiterOutreach_(text, sender) {
  if (isDefiniteNoise_(sender, '', text)) return false;
  return [
    /\b(?:we are|we're|i am|i'm) (?:currently )?hiring\b/i,
    /\bwould you be (?:open|interested)\b/i,
    /\byour profile (?:looks|seems|stood out)\b/i,
    /\bopportunity (?:with|at|for)\b/i,
    /\bcan we schedule (?:a )?(?:call|conversation)\b/i
  ].some(rx => rx.test(text));
}

function isDefiniteNoise_(sender, subject, body) {
  const text = `${sender}\n${subject}\n${String(body || '').slice(0, 2500)}`.toLowerCase();
  const exactNoiseSenders = [
    'newsletters-noreply@linkedin.com', 'mail.adplist.org', 'cultivatedculture.com',
    'tryexponent.com', 'substack.com', 'info.emeritus.org', 'coursera.org',
    'updates.upgrad.com', 'scaler.com', 'codenewsletter', 'joinsuperhuman.ai',
    'kaggle.com', 'groww.in', 'incometax.gov.in', 'epfindia', 'uidai.gov.in',
    'hdfcbank', 'icicibank', 'axisbank', 'kotak.com', 'sbi.co.in', 'irctc'
  ];
  if (exactNoiseSenders.some(value => text.includes(value))) return true;

  const directSignals = [
    'your application', 'your candidacy', 'complete your assessment',
    'share your availability', 'interview has been scheduled', 'offer letter'
  ];
  const hasDirectSignal = directSignals.some(value => text.includes(value));

  // LinkedIn platform notifications (job alerts, "application viewed",
  // digests) are not application updates. Genuine LinkedIn application
  // confirmations say "your application ... was sent" and stay tracked.
  if (/linkedin\.com/.test(text) && !/your application to .{1,120} was sent/.test(text)) {
    const linkedInNoise = [
      'your application was viewed', 'application was viewed by', 'jobs similar to',
      'new jobs for', 'job alert', 'be an early applicant', 'apply early',
      'you appeared in', 'search appearances', 'people are noticing',
      'trending jobs', 'recommended for you', 'invitation is waiting',
      'see who viewed', 'add connections', 'congratulate', 'work anniversary',
      'daily digest', 'weekly digest', 'inmail'
    ];
    if (linkedInNoise.some(value => text.includes(value))) return true;
  }

  // Transactional/financial/government/subscription mail is never a job email.
  // "Assessment Year" in Indian tax notices is the classic false friend for
  // the career word "assessment".
  const transactionalSignals = [
    'income tax', 'intimation u/s', 'assessment year 20', 'e-filing', 'itr-v',
    'form 16', 'e-verification', 'netbanking', 'account statement',
    'credit card statement', 'your bill is', 'policy premium', 'premium plan',
    'renew your subscription', 'subscription will', 'linkedin premium',
    'mutual fund', 'demat', 'fixed deposit', 'emi due', 'admission open',
    'last date to apply for admission', 'certificate program', 'executive program',
    'batch starts'
  ];
  if (!hasDirectSignal && transactionalSignals.some(value => text.includes(value))) return true;

  const noiseSignals = [
    'unsubscribe', 'manage preferences', 'view in browser', 'interview prep',
    'interview questions recently asked', 'program fee', 'course fee', 'book a mentor',
    'weekly newsletter', 'career newsletter'
  ];
  return noiseSignals.filter(value => text.includes(value)).length >= 2 && !hasDirectSignal;
}

function isRecruitingSender_(sender) {
  const value = String(sender || '').toLowerCase();
  return [
    'greenhouse', 'lever.co', 'smartrecruiters', 'workable', 'workday',
    'ashby', 'icims', 'successfactors', 'careers', 'recruit', 'talent',
    'hiring', 'interview', 'jobs-noreply@linkedin.com'
  ].some(token => value.includes(token));
}

/**
 * Reconciles the AI result with deterministic evidence.
 * Safety table:
 *   Action:    AI action OR rule action           => Action required
 *   Rejected:  AI rejection AND explicit rule evidence => Rejected; else Review
 *   Archive:   deterministic archive AND AI agrees no action => archivable
 *   Anything invalid, low-confidence, or contradictory     => Review
 */
function reconcileAiPrimaryDecision_(mail, deterministic, ai) {
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) {
    return deterministic.certainty === 'DEFINITE' ? deterministic
      : uncertainDecision_('Invalid AI response', deterministic);
  }

  const confidence = normalizeAiConfidence_(ai.confidence);
  const emailType = String(ai.email_type || '').trim().toLowerCase();
  const knownTypes = ['application_acknowledgement', 'status_update', 'assessment', 'interview',
    'recruiter_request', 'offer', 'rejection', 'newsletter', 'job_alert', 'unrelated', 'uncertain',
    'job_application_update', 'recruiter_outreach', 'career_newsletter', 'job_marketing'];
  const effectiveType = knownTypes.includes(emailType) ? emailType : 'uncertain';
  const stage = normalizeStage_(ai.stage);
  const aiSaysUnrelated = ['career_newsletter', 'job_marketing', 'newsletter', 'job_alert', 'unrelated'].includes(effectiveType);

  if (confidence < CG.AI.actionConfidence) {
    if (deterministic.certainty === 'DEFINITE') {
      return Object.assign({}, deterministic, {
        classifier: 'AI+Rules', model: ai._model || getAiModel_(),
        reason: deterministic.reason + ' • AI confidence was invalid or below the automatic threshold'});
    }
    if (deterministic.decision === 'UNRELATED') {
      return Object.assign({}, deterministic, {
        classifier: 'AI+Rules', model: ai._model || getAiModel_(),
        reason: (deterministic.reason || 'No career evidence') + ' • AI confidence too low to override'});
    }
    return uncertainDecision_('AI confidence below automatic threshold', deterministic);
  }

  if (effectiveType === 'uncertain') {
    // No deterministic career evidence AND AI is unsure => not worth an alert.
    if (deterministic.decision === 'UNRELATED') {
      return Object.assign({}, deterministic, {
        classifier: 'AI+Rules', model: ai._model || getAiModel_(),
        reason: (deterministic.reason || 'No career evidence') + ' • AI was also uncertain'});
    }
    return uncertainDecision_('AI marked the email uncertain', deterministic);
  }

  if (aiSaysUnrelated) {
    if (deterministic.certainty === 'DEFINITE' && deterministic.decision === 'JOB') {
      return Object.assign({}, deterministic, {
        classifier: 'AI+Rules', model: ai._model || getAiModel_(),
        reason: deterministic.reason + ' • AI disagreed, so the safer career classification was retained'});
    }
    if (deterministic.decision === 'PROBABLE_JOB') {
      return uncertainDecision_('AI and deterministic evidence disagree; retained for review', deterministic);
    }
    return Object.assign({}, deterministic, {
      decision: 'UNRELATED', stage: 'Ignore', requiresAction: false, deterministicArchive: false,
      confidence: confidence, reason: String(ai.reason || 'AI classified as unrelated'),
      classifier: 'AI+Rules', model: ai._model || getAiModel_()});
  }

  if ((stage === 'Rejected' || effectiveType === 'rejection') && deterministic.stage !== 'Rejected') {
    return uncertainDecision_('AI proposed rejection without explicit deterministic rejection evidence', deterministic);
  }

  const explicitAiAction = parseAiBoolean_(ai.requires_action);
  const aiRequiresAction = explicitAiAction === true || ['Assessment', 'Interview', 'Offer'].includes(stage);
  const requiresAction = Boolean(deterministic.requiresAction) || aiRequiresAction;
  const resolvedStage = stage && stage !== 'Ignore' ? stage : (deterministic.stage || 'Under Review');
  const deterministicArchive = Boolean(deterministic.deterministicArchive) &&
    explicitAiAction !== true && !requiresAction && stage !== 'Offer';

  // A confident career email with no action is a quiet Tracker update, not an
  // alert. Without deterministic archive proof it simply stays in the Inbox
  // (Safe Archive = No); it must never become Review + phone alert.
  return {
    decision: 'JOB', stage: resolvedStage, requiresAction: requiresAction,
    deterministicArchive: deterministicArchive, confidence: confidence,
    reason: String(ai.reason || deterministic.reason || 'AI-primary decision with deterministic safety gate'),
    source: deterministic.source,
    certainty: deterministicArchive ? 'AI_CONFIRMED_ARCHIVE' : (requiresAction ? 'AI_ACTION' : 'AI_JOB'),
    classifier: 'AI+Rules', model: ai._model || getAiModel_(),
    eventType: String(ai.event_type || deterministic.eventType || actionTypeFromStage_(resolvedStage)),
    action: requiresAction ? String(ai.action_summary || ai.action || deterministic.action || defaultActionForStage_(resolvedStage)) : '',
    deadlineText: String(ai.deadline_text || ai.deadline || deterministic.deadlineText || ''),
    interviewText: String(ai.interview_datetime_iso || ai.interview_datetime || deterministic.interviewText || ''),
    company: String(ai.company || deterministic.company || ''),
    role: String(ai.role || deterministic.role || ''),
    requisitionId: String(ai.requisition_id || deterministic.requisitionId || ''),
    resolves: deterministic.resolves || []
  };
}

function normalizeAiConfidence_(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number > 1 && number <= 100) number = number / 100;
  return Math.max(0, Math.min(1, number));
}

function parseAiBoolean_(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return null;
}

/** One batched AI request. No sleep loops; at most one retry for retryable statuses. */
function classifyBatchWithAI_(items) {
  const key = getSetting_(CG.PROPS.OPENROUTER_KEY, '');
  if (!key) throw new Error('OpenRouter key is not configured');
  if (!items || !items.length) return {};

  const model = getAiModel_();
  const records = items.map(item => ({
    message_id: item.mail.messageId,
    sender: sanitizeForAi_(item.mail.sender),
    subject: sanitizeForAi_(item.mail.subject),
    body: sanitizeForAi_(item.mail.body).slice(0, CG.AI.maxBodyChars),
    deterministic_context: {
      decision: item.deterministic.decision, stage: item.deterministic.stage,
      requiresAction: item.deterministic.requiresAction, reason: item.deterministic.reason
    }
  }));

  const resultSchema = {
    message_id: '', is_career_email: true,
    email_type: 'application_acknowledgement|status_update|assessment|interview|recruiter_request|offer|rejection|newsletter|job_alert|unrelated|uncertain',
    company: '', role: '', requisition_id: '',
    stage: 'Applied|Under Review|Assessment|Interview|Offer|Rejected|Withdrawn',
    requires_action: false, action_summary: '',
    deadline_iso: '', deadline_text: '', interview_datetime_iso: '',
    confidence: 0.0, reason: '', evidence: ''
  };

  const prompt = [
    'Classify every supplied email independently for a private career-inbox guardian.',
    'Return exactly one JSON object: {"results":[...]}. Preserve every message_id; one result per input.',
    'Rules:',
    '- Newsletters, courses, interview preparation, job alerts, and general career advice are unrelated.',
    '- A real action directly asks the recipient to complete, reply, schedule, select, accept, submit, provide, attend, or review.',
    '- Never infer rejection from hypothetical wording such as "if you are not selected".',
    '- Extract the employer company, not the ATS platform or sender person.',
    '- Return JSON only; no markdown.',
    `RESULT ITEM SCHEMA: ${JSON.stringify(resultSchema)}`,
    `EMAILS: ${JSON.stringify(records)}`
  ].join('\n');

  const buildRequest = withProviderPolicy => ({
    method: 'post', contentType: 'application/json',
    headers: {Authorization: `Bearer ${key}`, 'HTTP-Referer': spreadsheetUrl_(), 'X-Title': 'Pingbird'},
    payload: JSON.stringify(Object.assign({
      model: model,
      messages: [
        {role: 'system', content: 'You are the primary career-email decision engine. Return one valid JSON object only.'},
        {role: 'user', content: prompt}
      ],
      temperature: 0, max_tokens: CG.AI.batchMaxTokens
    }, withProviderPolicy ? {provider: {data_collection: 'deny'}} : {})),
    muteHttpExceptions: true
  });

  // Prefer providers that don't train on the data; if that policy leaves no
  // endpoint for the chosen model (common with free models), fall back to the
  // model's default endpoints rather than failing. Bodies are already
  // sanitized (URLs, phone numbers, and email addresses are stripped).
  let withPolicy = true;
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let status = 0, raw = '';
    try {
      const response = UrlFetchApp.fetch(CG.AI.endpoint, buildRequest(withPolicy));
      status = response.getResponseCode();
      raw = response.getContentText();
    } catch (error) {
      lastError = error.message;
      if (attempt < 3 && timeLeftFor_(CG.SCAN.reserveWriteMs)) continue;
      break;
    }
    if (status >= 200 && status < 300) {
      CG_RUN.aiRequests++;
      return parseBatchAiEnvelope_(raw, model, items.length);
    }
    lastError = `HTTP ${status}: ${raw.slice(0, 400)}`;
    if (status === 404 && withPolicy && /data policy|no endpoints/i.test(raw)) {
      withPolicy = false; // retry without the provider data policy
      logSystem_('INFO', 'AI', 'Provider data policy left no endpoints; retrying without it', {model: model});
      continue;
    }
    const retryable = status === 408 || status === 429 || status >= 500;
    if (!retryable || attempt === 3 || !timeLeftFor_(CG.SCAN.reserveWriteMs)) break;
  }
  CG_RUN.aiRequests++;
  throw new Error(lastError || 'OpenRouter request failed');
}

function parseBatchAiEnvelope_(raw, model, expectedCount) {
  const envelope = JSON.parse(raw);
  const content = envelope.choices && envelope.choices[0] && envelope.choices[0].message
    ? envelope.choices[0].message.content : '';
  const parsed = parseJsonObject_(content);
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : [];
  if (!results.length) throw new Error('AI batch response did not contain a results array');
  if (results.length !== expectedCount) {
    logSystem_('WARN', 'AI_BATCH', 'AI returned a different result count; unmatched emails fall back safely',
      {expected: expectedCount, received: results.length});
  }
  const byId = {};
  results.forEach(result => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    const id = String(result.message_id || '');
    if (!id || byId[id]) return; // ignore missing or duplicate ids
    result._model = envelope.model || model;
    byId[id] = result;
  });
  return byId;
}

function consumeAiBudget_() {
  const key = CG.PROPS.AI_CALLS_PREFIX + todayKey_();
  const props = getUserProps_();
  const used = Number(props.getProperty(key) || 0);
  if (used >= CG.AI.dailyRequestBudget) return false;
  props.setProperty(key, String(used + 1));
  return true;
}

/** Exactly one lightweight AI request, used only by configureIntegrations. */
function testAiOnce_() {
  const mail = {
    messageId: 'test', threadId: 'test', date: new Date(),
    sender: 'Level AI <no-reply@hire.lever.co>',
    subject: 'Thank you for your application to Level AI',
    body: 'We received your application for Lead Software Engineer - AI Agents.'
  };
  const result = classifyBatchWithAI_([{mail: mail, deterministic: classifyDeterministic_(mail)}]);
  if (!result || !result.test) throw new Error('The AI endpoint returned no usable result.');
  return true;
}

function actionTypeFromStage_(stage) {
  if (stage === 'Assessment') return 'ASSESSMENT_REQUIRED';
  if (stage === 'Interview') return 'INTERVIEW_REQUIRED';
  if (stage === 'Offer') return 'OFFER_RESPONSE_REQUIRED';
  return 'INFO_REQUEST';
}
function defaultActionForStage_(stage) {
  if (stage === 'Assessment') return 'Complete the assessment';
  if (stage === 'Interview') return 'Schedule, confirm, or attend the interview';
  if (stage === 'Offer') return 'Review and respond to the offer';
  return 'Review and respond to the recruiter';
}

/* ================================================================== *
 * SECTION 8 — MAIL RECORDS, ENRICHMENT, EXTRACTION
 * ================================================================== */

function buildMailRecord_(message, threadId) {
  return {
    messageId: message.getId(),
    threadId: threadId || message.getThread().getId(),
    date: message.getDate(),
    sender: clean_(message.getFrom()),
    subject: clean_(message.getSubject()),
    body: normalizeBody_(message.getPlainBody())
  };
}

function enrichDecision_(mail, decision) {
  const source = decision.source || detectSource_(mail.sender);
  const extracted = extractIdentity_(mail, source);
  const company = cleanCompany_(decision.company || extracted.company || '');
  const role = cleanRole_(decision.role || extracted.role || '', company);
  const requisitionId = clean_(decision.requisitionId || extracted.requisitionId || '');
  let deadline = parseDeadline_(decision.deadlineText || '', `${mail.subject}\n${mail.body}`, mail.date);
  // Every action needs a due date to be actionable: default to one week.
  if (decision.requiresAction && !deadline.date) {
    const fallback = new Date(mail.date || new Date());
    fallback.setDate(fallback.getDate() + 7);
    fallback.setHours(23, 59, 0, 0);
    deadline = {date: fallback, text: 'Default: 1 week'};
  }
  const interviewAt = parseDateTime_(decision.interviewText || '', `${mail.subject}\n${mail.body}`, mail.date);
  const recruiter = extractRecruiter_(mail.sender);
  return Object.assign({}, decision, {
    company: company, role: role, requisitionId: requisitionId,
    recruiterName: recruiter.name, recruiterEmail: recruiter.email,
    deadlineAt: deadline.date, deadlineText: deadline.text,
    interviewAt: interviewAt.date, interviewText: interviewAt.text, source: source
  });
}

function extractIdentity_(mail, source) {
  const subject = clean_(mail.subject);
  const body = clean_(mail.body);
  const sender = clean_(mail.sender);
  let company = '';
  let role = '';
  const requisitionId = extractRequisitionId_(`${subject}\n${body}`);
  let match;

  match = subject.match(/^Your application to\s+(.+?)\s+at\s+(.+?)\s*$/i);
  if (match) return {role: cleanRole_(match[1], ''), company: cleanCompany_(match[2]), requisitionId: requisitionId};

  match = subject.match(/^Interview Request:\s*(.+?)\s+at\s+(.+?)(?:\s+[—–-]\s+\d+\s*(?:LPA|K|USD|INR).*)?$/i);
  if (match) return {role: cleanRole_(match[1], ''), company: cleanCompany_(match[2]), requisitionId: requisitionId};

  match = subject.match(/^Application Received\s*[—–:-]\s*(.+?)\s+at\s+(.+?)\s*$/i);
  if (match) return {role: cleanRole_(match[1], ''), company: cleanCompany_(match[2]), requisitionId: requisitionId};

  match = subject.match(/^We received your application for\s+(.+?)\s+[—–-]\s+(.+?)\s*$/i);
  if (match) return {role: cleanRole_(match[1], ''), company: cleanCompany_(match[2]), requisitionId: requisitionId};

  if (source === 'Workable') {
    const parts = subject.split(/\s+[—–-]\s+/);
    if (parts.length === 2 && looksLikeRole_(parts[0])) {
      role = cleanRole_(parts[0], '');
      company = cleanCompany_(parts[1]);
    }
  }

  const subjectCompanyPatterns = [
    /^Thank(?:s| you) for (?:your application to|applying to)\s+(.+?)[!\s]*$/i,
    /^(.+?)\s+[—–-]\s+Thank You for Applying[!\s]*$/i,
    /^(.+?)\s+[—–-]\s+Thanks for Applying[!\s]*$/i,
    /^(.+?)\s+[—–-]\s+Thank you for your application[!\s]*$/i
  ];
  if (!company) {
    for (const rx of subjectCompanyPatterns) {
      match = subject.match(rx);
      if (match) { company = cleanCompany_(match[1]); break; }
    }
  }

  const rolePatterns = [
    /invited you to apply for\s+(?:the\s+)?(.+?)\s+(?:role|position)\b/i,
    /referred (?:you )?for\s+(?:the\s+)?(.+?)\s+(?:role|position)\b/i,
    /received your application for\s+(?:the\s+)?(.+?)(?:,\s+(?:and|we|which)|\.\s|\n|\s+(?:position|role|job advert)\b)/i,
    /application for\s+(?:the\s+)?(.+?)\s+(?:position|role)\b/i,
    /applying for\s+(?:the\s+)?(.+?)\s+(?:position|role)\b/i,
    /submit your application for\s+(.+?)(?:\s*\(|\.\s|\n)/i,
    /position of\s+(.+?)(?:\.\s|\n)/i
  ];
  if (!role) {
    for (const rx of rolePatterns) {
      match = body.match(rx);
      if (match) { role = cleanRole_(match[1], company); break; }
    }
  }

  if (!company) {
    const bodyCompanyPatterns = [
      /\b(?:role|position)\s+at\s+([A-Z][A-Za-z0-9&.'’\- ]{1,70})(?:[,.!]|\n)/,
      /\binterest in joining\s+([A-Z][A-Za-z0-9&.'’\- ]{1,70})(?:[,.!]|\n)/i,
      /\bjoining\s+([A-Z][A-Za-z0-9&.'’\- ]{1,70})(?:[,.!]|\n)/
    ];
    for (const rx of bodyCompanyPatterns) {
      match = body.match(rx);
      if (match) { company = cleanCompany_(match[1]); break; }
    }
  }

  if (!company) {
    const email = extractEmail_(sender).toLowerCase();
    const domainCompany = companyFromDomain_(email.split('@')[1] || '');
    const display = sender.replace(/<[^>]+>/g, '').replace(/["']/g, '').trim();
    const candidate = display
      .replace(/\s+(?:via|from)\s+.+$/i, '')
      .replace(/\s+(?:Careers?|Hiring|Talent|Recruiting|People|Jobs?)\s*(?:Team|Services?)?$/i, '')
      .trim();
    // "Divya Chaudhary (xWF) <chaudharydi@google.com>": the person's name is
    // NOT the employer — the domain is. Person-looking display names defer to
    // the corporate domain.
    if (looksLikePersonName_(candidate) && domainCompany) {
      company = domainCompany;
    } else if (candidate && !candidate.includes('@') &&
        !/^(no-?reply|notification|careers|jobs|recruiting|talent|hiring|team|workable|greenhouse|lever)$/i.test(candidate)) {
      company = cleanCompany_(candidate);
    }
    if (!company) company = domainCompany;
  }
  return {company: company, role: role, requisitionId: requisitionId};
}

/** 1–3 plain capitalized words, optional "(xWF)"-style tag, no brand markers. */
function looksLikePersonName_(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/technolog|solution|system|lab|software|analytic|consult|infotech|\b(?:inc|ltd|llc|corp|pvt|bank|global|digital|ai|hr)\b/i.test(text)) return false;
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}(?:\s*\([^)]{1,12}\))?$/.test(text);
}

/** Employer guessed from the sender's domain; ATS and freemail excluded. */
function companyFromDomain_(domain) {
  const value = String(domain || '').toLowerCase().trim();
  if (!value) return '';
  const excluded = [
    'greenhouse-mail.io', 'hire.lever.co', 'lever.co', 'smartrecruiters.com',
    'workablemail.com', 'workable.com', 'myworkday.com', 'myworkdayjobs.com',
    'ashbyhq.com', 'icims.com', 'successfactors.com', 'linkedin.com',
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com',
    'hotmail.com', 'live.com', 'icloud.com', 'protonmail.com', 'proton.me',
    'rediffmail.com', 'aol.com'
  ];
  if (excluded.some(d => value === d || value.endsWith('.' + d))) return '';
  const parts = value.split('.').filter(Boolean);
  const generic = ['mail', 'email', 'careers', 'jobs', 'recruiting', 'notifications',
    'notification', 'no-reply', 'noreply', 'hire', 'talent', 'apply', 'smtp', 'mailer', 'alerts'];
  while (parts.length > 2 && generic.includes(parts[0])) parts.shift();
  const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!sld || sld.length < 2 || generic.includes(sld)) return '';
  return titleCase_(sld.replace(/[-_]/g, ' '));
}

function titleCase_(value) {
  return String(value || '').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Recruiter name/email from the sender, when it's an actual person. */
function extractRecruiter_(sender) {
  const email = extractEmail_(sender);
  let name = String(sender || '').replace(/<[^>]+>/g, '').replace(/["']/g, '').trim()
    .replace(/\s+(?:via|from)\s+.+$/i, '').trim();
  if (/no-?reply|do-?not-?reply|notification|careers|jobs|recruiting|talent|hiring|alerts|donotreply/i.test(name + ' ' + email)) {
    return {name: '', email: ''};
  }
  if (!looksLikePersonName_(name)) name = '';
  return {name: name, email: name ? email : ''};
}

function looksLikeRole_(value) {
  return /\b(engineer|developer|scientist|manager|lead|architect|analyst|researcher|consultant|specialist|director|head)\b/i.test(String(value || ''));
}

function extractRequisitionId_(text) {
  const patterns = [
    /\b(?:job|requisition|req)\s*(?:number|id|#)\s*[:#-]?\s*([A-Z0-9-]*\d[A-Z0-9-]{3,})\b/i,
    /\b(?:job|requisition|req)[\s#:-]+([A-Z0-9-]*\d[A-Z0-9-]{3,})\b/i,
    /\bJR[-_ ]?(\d{4,})\b/i
  ];
  for (const rx of patterns) {
    const match = String(text || '').match(rx);
    if (match) return match[1];
  }
  return '';
}

function validateIdentity_(decision) {
  const company = cleanCompany_(decision.company || '');
  if (!company || company.length < 2) return {valid: false, reason: 'Missing employer company'};
  if (/^(unknown|email|the|software|felix|team|hr team|careers|recruiting|interview feedback|linkedin member)$/i.test(company)) {
    return {valid: false, reason: 'Invalid company extraction'};
  }
  if (/\bwe\b|\byour\b/i.test(company)) return {valid: false, reason: 'Sentence fragment captured as company'};
  // A missing role must not create a false action alert by itself.
  return {valid: true, reason: ''};
}

function parseDeadline_(hint, text, baseDate) {
  const source = `${hint || ''}\n${text || ''}`;
  const base = new Date(baseDate || new Date());
  let match = source.match(/\bdue in\s+(\d+)\s+days?\b/i);
  if (match) {
    const date = new Date(base);
    date.setDate(date.getDate() + Number(match[1]));
    date.setHours(23, 59, 0, 0);
    return {date: date, text: match[0]};
  }
  match = source.match(/\bwithin\s+(\d+)\s+hours?\b/i);
  if (match) return {date: new Date(base.getTime() + Number(match[1]) * 3600000), text: match[0]};
  match = source.match(/\bwithin\s+(\d+)\s+days?\b/i);
  if (match) return {date: new Date(base.getTime() + Number(match[1]) * 86400000), text: match[0]};

  const absolutePatterns = [
    /\b(?:due|deadline|complete by|submit by|before)\s*:?\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[a-z]*,?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /\b(?:due|deadline|complete by|submit by|before)\s*:?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
    /\b(?:due|deadline|complete by|submit by|before)\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i
  ];
  for (const rx of absolutePatterns) {
    match = source.match(rx);
    if (!match) continue;
    const parsed = new Date(match[1]);
    if (!isNaN(parsed)) return {date: parsed, text: match[0]};
  }
  return {date: '', text: hint || ''};
}

function parseDateTime_(hint, text, baseDate) {
  const source = `${hint || ''}\n${text || ''}`;
  const patterns = [
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[, ]+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?/i,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?/i
  ];
  for (const rx of patterns) {
    const match = source.match(rx);
    if (!match) continue;
    const parsed = new Date(match[0]);
    if (!isNaN(parsed)) return {date: parsed, text: match[0]};
  }
  return {date: '', text: hint || ''};
}

function detectSource_(sender) {
  const value = String(sender || '').toLowerCase();
  if (value.includes('greenhouse')) return 'Greenhouse';
  if (value.includes('lever.co')) return 'Lever';
  if (value.includes('smartrecruiters')) return 'SmartRecruiters';
  if (value.includes('workable')) return 'Workable';
  if (value.includes('workday')) return 'Workday';
  if (value.includes('ashby')) return 'Ashby';
  if (value.includes('jobs-noreply@linkedin.com')) return 'LinkedIn';
  return 'Direct / Other';
}

function normalizeStage_(stage) {
  const map = {
    'applied': 'Applied', 'application received': 'Applied', 'under review': 'Under Review',
    'more information required': 'Under Review', 'assessment': 'Assessment',
    'coding assessment': 'Assessment', 'interview': 'Interview',
    'recruiter screen': 'Interview', 'phone screen': 'Interview',
    'technical interview': 'Interview', 'final interview': 'Interview',
    'offer': 'Offer', 'rejected': 'Rejected', 'withdrawn': 'Withdrawn', 'ignore': 'Ignore'
  };
  return map[String(stage || '').trim().toLowerCase()] || '';
}

function sanitizeForAi_(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/\b\+?\d[\d\s().-]{8,}\d\b/g, '[PHONE]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b\d{12,}\b/g, '[LONG_ID]')
    .replace(/\nOn .+?wrote:[\s\S]*$/i, '')
    .trim();
}
function normalizeBody_(value) {
  return clean_(value)
    .replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/\nOn .+?wrote:[\s\S]*$/i, '')
    .slice(0, 6000);
}
function clean_(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function cleanCompany_(value) {
  // Cut run-on sentence captures ("Ollion. We appreciate your interest in...").
  let company = clean_(value).split(/[.!?]\s|\bwe appreciate\b|\bthank you\b|\bthanks\b/i)[0];
  company = company.replace(/[.!,:;]+$/g, '')
    .replace(/\s+(?:team|careers team|hiring team)$/i, '').trim();
  return company.length > 60 ? '' : company;
}
function cleanRole_(value, company) {
  let role = clean_(value).replace(/[.!,:;]+$/g, '').replace(/\s+job was submitted successfully$/i, '').trim();
  if (company) role = role.replace(new RegExp(`\\s+at\\s+${escapeRegex_(company)}.*$`, 'i'), '');
  role = role.trim();
  // Articles and stop-fragments are extraction noise, never a real role.
  if (role.length < 3 || /^(?:the|an?|this|that|role|position|our|your|job)$/i.test(role)) return '';
  return role;
}
function extractEmail_(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}
function escapeRegex_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function parseJsonObject_(text) {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!cleaned) throw new Error('AI returned an empty response');
  try { return JSON.parse(cleaned); } catch (firstError) {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error('AI response did not contain valid JSON');
}

/* ================================================================== *
 * SECTION 9 — SHEET LAYER (read once, write once)
 * ================================================================== */

function trackerHeaders_() {
  return ['Received', 'Company', 'Role', 'Stage', 'Needs Attention', 'What to do', 'Deadline', 'Status',
    'Email', 'AI Confidence', 'Notes', 'Recruiter', 'Recruiter Email',
    'Message ID', 'Thread ID', 'Safe Archive', 'Event Type', 'Reason', 'Req ID'];
}

/** Later/stronger stages have higher priority; terminal states always win. */
function stagePriority_(stage) {
  const map = {'Ignore': 0, 'Applied': 10, 'Under Review': 20, 'Assessment': 30,
    'Interview': 40, 'Offer': 50, 'Rejected': 90, 'Withdrawn': 95};
  return map[String(stage || '')] || 0;
}

function readTracker_() {
  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.TRACKER);
  const headers = trackerHeaders_();
  migrateTrackerColumns_(sh);
  ensureSheetSize_(sh, 2, headers.length);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return {sheet: sh, headers: indexHeaders_(headers), values: []};
  const values = sh.getRange(1, 1, lastRow, headers.length).getValues();
  return {sheet: sh, headers: indexHeaders_(values[0]), values: values.slice(1)};
}

/**
 * Older trackers had Message ID at column 12 (no Recruiter columns). Insert
 * the two new columns in place so existing rows stay aligned with headers.
 */
function migrateTrackerColumns_(sh) {
  try {
    if (sh.getMaxColumns() >= 12 &&
        String(sh.getRange(1, 12).getValue()) === 'Message ID') {
      sh.insertColumnsBefore(12, 2);
      const headers = trackerHeaders_();
      ensureSheetSize_(sh, 2, headers.length);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeader_(sh.getRange(1, 1, 1, headers.length));
      try { sh.hideColumns(14, 6); } catch (e) {}
      logSystem_('INFO', 'MIGRATE', 'Tracker upgraded with Recruiter columns', {});
    }
  } catch (error) {
    logSystem_('WARN', 'MIGRATE', 'Tracker column migration failed', {error: error.message});
  }
}

function loadProcessedIds_(tracker) {
  const result = new Set();
  const state = getSpreadsheet_().getSheetByName(CG.SHEETS.STATE);
  if (state && state.getLastRow() >= 2) {
    state.getRange(2, 2, state.getLastRow() - 1, 1).getValues().flat()
      .forEach(value => { if (value) result.add(String(value)); });
  }
  const h = tracker.headers;
  tracker.values.forEach(row => {
    const id = String(row[h['Message ID']] || '');
    if (id) result.add(id);
  });
  return result;
}

function loadOutboxDedupKeys_() {
  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.OUTBOX);
  const keys = new Set();
  if (!sh || sh.getLastRow() < 2) return keys;
  sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues().flat()
    .forEach(value => { if (value) keys.add(String(value)); });
  return keys;
}

function safeCellText_(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function buildTrackerRowValues_(mail, decision, status) {
  return [
    mail.date,
    safeCellText_(decision.company || 'Needs review'),
    safeCellText_(decision.role || ''),
    safeCellText_(decision.stage || 'Under Review'),
    status === 'Pending' || status === 'Review' ? 'Yes' : 'No',
    safeCellText_(decision.action || (status === 'Review' ? 'Review this email' : '')),
    decision.deadlineAt || '',
    status,
    '',
    normalizeAiConfidence_(decision.confidence),
    '',
    safeCellText_(decision.recruiterName || ''),
    safeCellText_(decision.recruiterEmail || ''),
    mail.messageId,
    mail.threadId,
    decision.deterministicArchive ? 'Yes' : 'No',
    safeCellText_(decision.eventType || ''),
    safeCellText_(decision.reason || ''),
    safeCellText_(decision.requisitionId || '')
  ];
}

/**
 * One Tracker row per application. Matching order:
 *   1. requisition/job ID   2. company + role   3. Gmail thread.
 * A newer email updates the existing row in place; the stage never regresses
 * (except to the terminal Rejected/Withdrawn), and a new required action
 * always revives the row to Pending/Review. Returns 'inserted' or 'updated'.
 */
function upsertApplicationRow_(tracker, buffers, mail, decision, status) {
  const h = tracker.headers;
  const HEAD = trackerHeaders_();
  const col = name => HEAD.indexOf(name);
  const reqKey = normalizeKey_(decision.requisitionId || '');
  const companyKey = normalizeKey_(decision.company || '');
  const roleKey = normalizeKey_(decision.role || '');

  const matchRank = (companyV, roleV, reqV, threadV) => {
    if (reqKey && normalizeKey_(reqV) === reqKey) return 1;
    if (companyKey && roleKey &&
        normalizeKey_(companyV) === companyKey && normalizeKey_(roleV) === roleKey) return 2;
    if (String(threadV) === mail.threadId) return 3;
    return 0;
  };

  let best = null; // {kind:'buffered'|'sheet', ref, rank}
  buffers.tracker.forEach(entry => {
    const v = entry.values;
    const rank = matchRank(v[col('Company')], v[col('Role')], v[col('Req ID')], entry.threadId);
    if (rank && (!best || rank < best.rank)) best = {kind: 'buffered', ref: entry, rank: rank};
  });
  if (!best || best.rank > 1) {
    for (let i = 0; i < tracker.values.length; i++) {
      const row = tracker.values[i];
      const rank = matchRank(row[h.Company], row[h.Role], row[h['Req ID']], row[h['Thread ID']]);
      if (rank && (!best || rank < best.rank)) best = {kind: 'sheet', ref: i, rank: rank};
      if (best && best.rank === 1) break;
    }
  }

  // Last resort: when the company matches exactly ONE tracked application,
  // link to it even though the role could not be compared (rejections often
  // name a role the acknowledgement never did, and vice versa).
  if (!best && companyKey) {
    const companyMatches = [];
    buffers.tracker.forEach(entry => {
      if (normalizeKey_(entry.values[col('Company')]) === companyKey) {
        companyMatches.push({kind: 'buffered', ref: entry, rank: 4});
      }
    });
    tracker.values.forEach((row, i) => {
      if (normalizeKey_(row[h.Company]) === companyKey) {
        companyMatches.push({kind: 'sheet', ref: i, rank: 4});
      }
    });
    if (companyMatches.length === 1) best = companyMatches[0];
  }

  if (!best) {
    buffers.tracker.push({
      threadId: mail.threadId, receivedAt: mail.date.getTime(),
      values: buildTrackerRowValues_(mail, decision, status)
    });
    return 'inserted';
  }

  const row = best.kind === 'buffered' ? best.ref.values : tracker.values[best.ref];
  while (row.length < HEAD.length) row.push('');
  const idx = best.kind === 'buffered'
    ? name => col(name)
    : name => h[name];

  const prevReceived = asDate_(best.kind === 'buffered' ? row[col('Received')] : row[h.Received]);
  const isNewer = !prevReceived || mail.date.getTime() >= prevReceived.getTime();
  const oldStage = String(row[idx('Stage')] || '');
  const progresses = ['Rejected', 'Withdrawn'].includes(String(decision.stage || '')) ||
    stagePriority_(decision.stage) >= stagePriority_(oldStage);
  const needsAttention = status === 'Pending' || status === 'Review';
  // Completion/rejection events clear a matching pending action even when
  // their stage ranks lower (e.g. "assessment completed" => Under Review).
  const resolves = decision.resolves || [];
  const rowPending = ['Pending', 'Review'].includes(String(row[idx('Status')] || ''));
  const resolvesRow = isNewer && rowPending && resolves.length > 0 &&
    (resolves.includes(eventFamily_(row[idx('Event Type')])) || resolves.includes('REVIEW'));

  // Fill identity blanks in either direction.
  if (!String(row[idx('Company')] || '') && decision.company) row[idx('Company')] = safeCellText_(decision.company);
  if (!String(row[idx('Role')] || '') && decision.role) row[idx('Role')] = safeCellText_(decision.role);
  if (!String(row[idx('Req ID')] || '') && decision.requisitionId) row[idx('Req ID')] = safeCellText_(decision.requisitionId);
  if (decision.recruiterName && (isNewer || !String(row[idx('Recruiter')] || ''))) {
    row[idx('Recruiter')] = safeCellText_(decision.recruiterName);
  }
  if (decision.recruiterEmail && (isNewer || !String(row[idx('Recruiter Email')] || ''))) {
    row[idx('Recruiter Email')] = safeCellText_(decision.recruiterEmail);
  }

  if (isNewer) {
    row[idx('Received')] = mail.date;
    row[idx('Message ID')] = mail.messageId;
    row[idx('Thread ID')] = mail.threadId;
    row[idx('AI Confidence')] = normalizeAiConfidence_(decision.confidence);
    row[idx('Reason')] = safeCellText_(decision.reason || '');
  }

  // A new required action always surfaces, even without a stage upgrade.
  if ((isNewer && needsAttention) || (isNewer && progresses) || resolvesRow) {
    if (progresses && decision.stage) row[idx('Stage')] = safeCellText_(decision.stage);
    row[idx('Event Type')] = safeCellText_(decision.eventType || '');
    row[idx('Safe Archive')] = decision.deterministicArchive ? 'Yes' : 'No';
    row[idx('Status')] = needsAttention ? status : 'No action';
    row[idx('Needs Attention')] = needsAttention ? 'Yes' : 'No';
    row[idx('What to do')] = needsAttention
      ? safeCellText_(decision.action || (status === 'Review' ? 'Review this email' : ''))
      : '';
    row[idx('Deadline')] = needsAttention ? (decision.deadlineAt || '') : '';
  }

  if (best.kind === 'buffered') {
    best.ref.threadId = String(row[col('Thread ID')] || best.ref.threadId);
    best.ref.receivedAt = Math.max(best.ref.receivedAt, mail.date.getTime());
  } else {
    buffers.updatedFullRows.add(best.ref + 2);
  }
  return 'updated';
}

function eventFamily_(eventType) {
  const value = String(eventType || '');
  if (value.includes('ASSESSMENT')) return 'ASSESSMENT';
  if (value.includes('INTERVIEW')) return 'INTERVIEW';
  if (value.includes('OFFER')) return 'OFFER_RESPONSE';
  if (value.includes('REVIEW')) return 'REVIEW';
  return 'INFO_REQUEST';
}

/** Full-row rewrite for upserted sheet rows, preserving the Email hyperlink. */
function applyFullRowUpdates_(tracker, rowNumbers) {
  if (!rowNumbers || !rowNumbers.size) return;
  const h = tracker.headers;
  const width = trackerHeaders_().length;
  rowNumbers.forEach(rowNumber => {
    const row = tracker.values[rowNumber - 2];
    if (!row) return;
    while (row.length < width) row.push('');
    tracker.sheet.getRange(rowNumber, 1, 1, 8).setValues([row.slice(0, 8)]);          // A..H
    tracker.sheet.getRange(rowNumber, 10, 1, width - 9).setValues([row.slice(9, width)]); // J..end
    const threadId = String(row[h['Thread ID']] || '');
    if (threadId) {
      tracker.sheet.getRange(rowNumber, 9)
        .setFormula(`=HYPERLINK("${gmailThreadUrl_(threadId)}","Open email")`);
    }
  });
}



/** Updates run before inserts so buffered row numbers stay correct. */
function applyTrackerUpdates_(tracker, updatedRows) {
  if (!updatedRows || !updatedRows.size) return;
  const h = tracker.headers;
  const firstCol = h['Needs Attention'] + 1;   // column 5
  const span = (h.Notes + 1) - firstCol + 1;   // columns 5..11
  updatedRows.forEach(rowNumber => {
    const row = tracker.values[rowNumber - 2];
    if (!row) return;
    tracker.sheet.getRange(rowNumber, firstCol, 1, span)
      .setValues([row.slice(firstCol - 1, firstCol - 1 + span)]);
  });
}

/** All new Tracker rows in one insertRowsBefore + one setValues, newest first at row 2. */
function flushTrackerRows_(sh, entries) {
  if (!entries.length) return;
  const width = trackerHeaders_().length;
  const ordered = entries.slice().sort((a, b) => b.receivedAt - a.receivedAt);
  sh.insertRowsBefore(2, ordered.length);
  sh.getRange(2, 1, ordered.length, width).setValues(ordered.map(entry => entry.values));
  sh.getRange(2, 9, ordered.length, 1).setFormulas(
    ordered.map(entry => [`=HYPERLINK("${gmailThreadUrl_(entry.threadId)}","Open email")`]));
  sh.getRange(2, 1, ordered.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange(2, 7, ordered.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange(2, 10, ordered.length, 1).setNumberFormat('0.0%');
  sh.getRange(2, 1, ordered.length, 13)
    .setBackground('#FFFFFF').setFontColor('#475569').setFontWeight('normal').setWrap(true);
}

function appendRows_(sh, rows) {
  if (!sh || !rows.length) return;
  const firstRow = sh.getLastRow() + 1;
  ensureSheetSize_(sh, firstRow + rows.length, rows[0].length);
  sh.getRange(firstRow, 1, rows.length, rows[0].length).setValues(rows);
}

/** Thread → tracker rows (existing + this run's buffered rows), newest first. */
function buildRowsByThread_(tracker, newEntries) {
  const h = tracker.headers;
  const map = new Map();
  const push = (threadId, record) => {
    if (!threadId) return;
    if (!map.has(threadId)) map.set(threadId, []);
    map.get(threadId).push(record);
  };
  tracker.values.forEach(row => {
    const received = asDate_(row[h.Received]);
    push(String(row[h['Thread ID']] || ''), {
      at: received ? received.getTime() : 0,
      status: String(row[h.Status] || ''),
      safeArchive: String(row[h['Safe Archive']] || '')
    });
  });
  newEntries.forEach(entry => push(entry.threadId, {
    at: entry.receivedAt,
    status: String(entry.values[trackerHeaders_().indexOf('Status')] || ''),
    safeArchive: String(entry.values[trackerHeaders_().indexOf('Safe Archive')] || '')
  }));
  map.forEach(rows => rows.sort((a, b) => b.at - a.at));
  return map;
}

function trimStateSheetIfNeeded_() {
  const limits = {};
  limits[CG.SHEETS.STATE] = CG.SCAN.stateMaxRows;
  limits[CG.SHEETS.OUTBOX] = 1500;
  limits[CG.SHEETS.LOG] = 3000;
  limits[CG.SHEETS.TESTS] = 300;
  const ss = getSpreadsheet_();
  Object.keys(limits).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const dataRows = sh.getLastRow() - 1;
    const limit = limits[name];
    if (dataRows <= limit) return;
    const excess = dataRows - limit;
    if (name !== CG.SHEETS.OUTBOX) { sh.deleteRows(2, excess); return; }
    // Never delete Pending/Retry alerts just to enforce a size limit.
    const values = sh.getDataRange().getValues();
    const h = indexHeaders_(values[0]);
    const deletable = [];
    for (let i = 1; i < values.length && deletable.length < excess; i++) {
      if (['Sent', 'Dead'].includes(String(values[i][h.Status] || ''))) deletable.push(i + 1);
    }
    deletable.sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
  });
}

/* ================================================================== *
 * SECTION 10 — NOTIFICATIONS (Pocket Alert)
 * Content-free by design: only the generic message + tracker link is sent.
 * ================================================================== */

function sendPocketAlert_(webhook, message, level) {
  try {
    const response = UrlFetchApp.fetch(webhook, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({message: message, level: level || 'high'}),
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status >= 200 && status < 300) return {ok: true, status: status};
    return {
      ok: false, status: status, retryable: status === 429 || status >= 500,
      error: `HTTP ${status}: ${response.getContentText().slice(0, 300)}`
    };
  } catch (error) {
    return {ok: false, status: 0, retryable: true, error: error.message};
  }
}

function validatePocketWebhook_(value) {
  const url = String(value || '').trim();
  if (!url) return {valid: false, reason: 'Webhook URL is missing.'};
  if (!/^https:\/\/(?:p4a\.me\/wh\/[A-Za-z0-9_-]+|api\.pocketalert\.app\/v1\/webhooks\/receive\/[A-Za-z0-9_-]+)\/?(?:\?.*)?$/.test(url)) {
    return {valid: false, reason: 'Expected a Pocket Alert receive URL such as https://p4a.me/wh/....'};
  }
  return {valid: true};
}

/** One attempt at the OLDEST Pending/Retry alert. Never loops, never sleeps. */
function retryOldestNotification_() {
  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.OUTBOX);
  if (!sh || sh.getLastRow() < 2) return {attempted: false};
  const webhook = getSetting_(CG.PROPS.POCKET_WEBHOOK, '');
  const validation = validatePocketWebhook_(webhook);
  if (!validation.valid) return {attempted: false, error: validation.reason};
  if (dailyAlertsSent_() >= CG.ALERT.dailyLimit) return {attempted: false, error: 'Daily alert limit reached'};

  const values = sh.getDataRange().getValues();
  const h = indexHeaders_(values[0]);
  let oldest = null;
  for (let i = 1; i < values.length; i++) {
    if (!['Pending', 'Retry'].includes(String(values[i][h.Status] || ''))) continue;
    const created = asDate_(values[i][h.Created]);
    const at = created ? created.getTime() : 0;
    if (!oldest || at < oldest.at) oldest = {rowIndex: i + 1, row: values[i], at: at};
  }
  if (!oldest) return {attempted: false};
  return attemptOutboxRow_(sh, h, oldest.rowIndex, oldest.row, webhook);
}

/** Sends up to maxSends newly queued alerts. Daily cap and dedup enforced. */
function deliverPendingAlerts_(maxSends) {
  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.OUTBOX);
  if (!sh || sh.getLastRow() < 2) return {sent: 0, pending: 0, failed: 0};
  const webhook = getSetting_(CG.PROPS.POCKET_WEBHOOK, '');
  const validation = validatePocketWebhook_(webhook);
  if (!validation.valid) {
    setSetting_(CG.PROPS.LAST_ALERT_ERROR, validation.reason);
    return {sent: 0, pending: countOutboxStatus_(sh, ['Pending', 'Retry']), failed: 0};
  }

  const values = sh.getDataRange().getValues();
  const h = indexHeaders_(values[0]);
  const candidates = [];
  for (let i = 1; i < values.length; i++) {
    if (['Pending', 'Retry'].includes(String(values[i][h.Status] || ''))) {
      candidates.push({rowIndex: i + 1, row: values[i]});
    }
  }
  candidates.sort((a, b) => {
    const ad = asDate_(a.row[h.Created]);
    const bd = asDate_(b.row[h.Created]);
    return (ad ? ad.getTime() : 0) - (bd ? bd.getTime() : 0);
  });

  let sent = 0, failed = 0;
  for (const item of candidates) {
    if (sent + failed >= Number(maxSends || 1)) break;
    if (dailyAlertsSent_() >= CG.ALERT.dailyLimit) break;
    if (!timeLeftFor_(8000)) break;
    const result = attemptOutboxRow_(sh, h, item.rowIndex, item.row, webhook);
    if (result.sent) sent++; else { failed++; if (result.retryable) break; }
  }
  return {sent: sent, pending: countOutboxStatus_(sh, ['Pending', 'Retry']), failed: failed};
}

function attemptOutboxRow_(sh, h, rowIndex, row, webhook) {
  const attempts = Number(row[h.Attempts] || 0) + 1;
  const result = sendPocketAlert_(webhook, String(row[h.Message] || ''), String(row[h.Level] || 'high'));
  sh.getRange(rowIndex, h.Attempts + 1).setValue(attempts);
  sh.getRange(rowIndex, h['Last Attempt'] + 1).setValue(new Date());
  if (result.ok) {
    sh.getRange(rowIndex, h.Status + 1).setValue('Sent');
    sh.getRange(rowIndex, h['Sent At'] + 1).setValue(new Date());
    sh.getRange(rowIndex, h['Last Error'] + 1).clearContent();
    incrementDailyAlertsSent_();
    setSetting_(CG.PROPS.LAST_ALERT_OK, new Date().toISOString());
    setSetting_(CG.PROPS.LAST_ALERT_ERROR, '');
    return {attempted: true, sent: true};
  }
  setSetting_(CG.PROPS.LAST_ALERT_ERROR, result.error);
  sh.getRange(rowIndex, h['Last Error'] + 1).setValue(result.error);
  const retryable = result.retryable && attempts < CG.ALERT.maxAttempts;
  sh.getRange(rowIndex, h.Status + 1).setValue(retryable ? 'Retry' : 'Dead');
  logSystem_(retryable ? 'WARN' : 'ERROR', 'POCKET_ALERT',
    retryable ? 'Alert queued for retry' : 'Alert permanently failed',
    {attempts: attempts, status: result.status, error: result.error});
  return {attempted: true, sent: false, retryable: retryable, error: result.error};
}

function countOutboxStatus_(sh, statuses) {
  if (!sh || sh.getLastRow() < 2) return 0;
  const values = sh.getDataRange().getValues();
  const h = indexHeaders_(values[0]);
  return values.slice(1).filter(row => statuses.includes(String(row[h.Status] || ''))).length;
}

function testPocketAlertConnection() {
  setupIfNeeded_();
  const url = getSetting_(CG.PROPS.POCKET_WEBHOOK, '');
  const validation = validatePocketWebhook_(url);
  if (!validation.valid) {
    SpreadsheetApp.getUi().alert('Pocket Alert is not configured: ' + validation.reason);
    return;
  }
  const result = sendPocketAlert_(url,
    `✅ Pingbird test successful. Open Tracker: ${trackerSheetUrl_()}`, 'default');
  if (result.ok) {
    incrementDailyAlertsSent_();
    setSetting_(CG.PROPS.LAST_ALERT_OK, new Date().toISOString());
    SpreadsheetApp.getUi().alert('Test alert sent. Check your phone.');
  } else {
    setSetting_(CG.PROPS.LAST_ALERT_ERROR, result.error);
    SpreadsheetApp.getUi().alert('Test alert failed: ' + result.error);
  }
  refreshSettings_();
}

function dailyAlertsSent_() {
  return Number(getUserProps_().getProperty(CG.PROPS.ALERT_SENT_PREFIX + todayKey_()) || 0);
}
function incrementDailyAlertsSent_() {
  getUserProps_().setProperty(CG.PROPS.ALERT_SENT_PREFIX + todayKey_(), String(dailyAlertsSent_() + 1));
}

/* ================================================================== *
 * SECTION 11 — SHEETS AND BOUNDED UI
 * Layouts are built ONCE in setup. Refreshes write value ranges only.
 * ================================================================== */

function ensureAllSheets_(ss) {
  ensureSheet_(ss, CG.SHEETS.HOME, []);
  ensureSheet_(ss, CG.SHEETS.TRACKER, trackerHeaders_());
  ensureSheet_(ss, CG.SHEETS.SETTINGS, ['Setting', 'Value', 'What it means']);
  ensureSheet_(ss, CG.SHEETS.STATE, ['Processed At', 'Message ID', 'Thread ID', 'Decision', 'Details']);
  ensureSheet_(ss, CG.SHEETS.OUTBOX, ['Created', 'Alert ID', 'Dedup Key', 'Message', 'Level', 'Status', 'Attempts', 'Last Attempt', 'Sent At', 'Last Error']);
  ensureSheet_(ss, CG.SHEETS.LOG, ['Timestamp', 'Level', 'Component', 'Message', 'Details JSON']);
  ensureSheet_(ss, CG.SHEETS.TESTS, ['Run At', 'Test', 'Expected', 'Actual', 'Result', 'Reason']);
  buildHomeLayoutIfNeeded_(ss.getSheetByName(CG.SHEETS.HOME));
  buildSettingsLayoutIfNeeded_(ss.getSheetByName(CG.SHEETS.SETTINGS));
  formatTrackerOnce_(ss.getSheetByName(CG.SHEETS.TRACKER));
  [CG.SHEETS.STATE, CG.SHEETS.OUTBOX, CG.SHEETS.LOG, CG.SHEETS.TESTS].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && !sh.isSheetHidden()) sh.hideSheet();
  });
  removeBlankForeignSheets_(ss);
  orderVisibleSheets_(ss);
}

/**
 * The script alone can build the full template: on a brand-new spreadsheet
 * the default blank "Sheet1" is removed once the Pingbird sheets
 * exist. Sheets that contain any user data are never touched.
 */
function removeBlankForeignSheets_(ss) {
  const cgNames = new Set([
    CG.SHEETS.HOME, CG.SHEETS.TRACKER, CG.SHEETS.SETTINGS,
    CG.SHEETS.STATE, CG.SHEETS.OUTBOX, CG.SHEETS.LOG, CG.SHEETS.TESTS
  ]);
  ss.getSheets().forEach(sh => {
    if (cgNames.has(sh.getName())) return;
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) {
      try { ss.deleteSheet(sh); } catch (error) {}
    }
  });
}

/** Home, Tracker, Settings in that order, with Home focused. */
function orderVisibleSheets_(ss) {
  [CG.SHEETS.HOME, CG.SHEETS.TRACKER, CG.SHEETS.SETTINGS].forEach((name, index) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    try { ss.setActiveSheet(sh); ss.moveActiveSheet(index + 1); } catch (error) {}
  });
  try { ss.setActiveSheet(ss.getSheetByName(CG.SHEETS.HOME)); } catch (error) {}
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  ensureSheetSize_(sh, 100, Math.max(16, headers.length || 1));
  if (headers.length) {
    const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join('|') !== headers.join('|')) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader_(sh.getRange(1, 1, 1, headers.length));
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureSheetSize_(sh, minRows, minColumns) {
  if (sh.getMaxRows() < minRows) sh.insertRowsAfter(sh.getMaxRows(), minRows - sh.getMaxRows());
  if (sh.getMaxColumns() < minColumns) sh.insertColumnsAfter(sh.getMaxColumns(), minColumns - sh.getMaxColumns());
}

function buildHomeLayoutIfNeeded_(sh) {
  if (String(sh.getRange('A1').getValue()).toUpperCase() === 'PINGBIRD') return;
  sh.getRange('A1:H30').breakApart();
  sh.clear();
  sh.getRange('A1:H2').merge().setValue('PINGBIRD')
    .setBackground('#111827').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(22)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('A4:H4').merge().setValue('Never miss an assessment, interview, recruiter request, or offer.')
    .setFontColor('#475569').setHorizontalAlignment('center');
  sh.getRange('A6:C6').merge().setValue('QUICK START').setBackground('#DBEAFE').setFontColor('#1E3A8A').setFontWeight('bold');
  sh.getRange('A7:C11').merge().setValue(
    '1. In Pocket Alert, set the Message Template to %message%\n\n' +
    '2. Open Pingbird → 🚀 Quick setup\n\n' +
    '3. Paste your AI key and webhook URL when asked.').setWrap(true);
  sh.getRange('E6:H6').merge().setValue('SYSTEM STATUS').setBackground('#DCFCE7').setFontColor('#166534').setFontWeight('bold');
  sh.getRange('A14:H14').merge().setValue('NEEDS YOUR ATTENTION').setBackground('#FEF3C7').setFontColor('#92400E').setFontWeight('bold');
  sh.getRange('A15:G15').setValues([['Received', 'Company', 'Role', 'What to do', 'Deadline', 'Status', 'Email']]);
  styleHeader_(sh.getRange('A15:G15'));
  sh.getRange('A26:H26').merge().setValue('HOW IT WORKS').setBackground('#F1F5F9').setFontColor('#334155').setFontWeight('bold');
  sh.getRange('A27:H30').merge().setValue(
    'Pingbird checks Gmail five times a day. Only emails requiring your attention ' +
    'trigger a phone alert, and the alert never contains email content.').setWrap(true);
  [120, 120, 150, 180, 120, 110, 150, 110].forEach((width, index) => sh.setColumnWidth(index + 1, width));
}

function buildSettingsLayoutIfNeeded_(sh) {
  if (String(sh.getRange('A1').getValue()) === 'Setting' && sh.getColumnWidth(3) >= 400) return;
  sh.getRange('A1:C1').setValues([['Setting', 'Value', 'What it means']]);
  styleHeader_(sh.getRange('A1:C1'));
  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(2, 300);
  sh.setColumnWidth(3, 500);
  sh.setFrozenRows(1);
}

function formatTrackerOnce_(sh) {
  ensureSheetSize_(sh, 100, trackerHeaders_().length);
  styleHeader_(sh.getRange(1, 1, 1, trackerHeaders_().length));
  sh.setFrozenRows(1);
  [130, 150, 220, 110, 105, 260, 150, 105, 90, 95, 180, 150, 190].forEach((width, index) => sh.setColumnWidth(index + 1, width));
  try { sh.hideColumns(14, 6); } catch (e) {}  // Message ID .. Req ID
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('G:G').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('J:J').setNumberFormat('0.0%');
  sh.getRange('A:M').setWrap(true).setVerticalAlignment('top');
  sh.getRange('H2:H').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pending', 'Review', 'Completed', 'Dismissed', 'No action'], true).build());
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Pending').setBackground('#FEF3C7').setRanges([sh.getRange('H2:H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Review').setBackground('#FDE68A').setRanges([sh.getRange('H2:H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Completed').setBackground('#DCFCE7').setRanges([sh.getRange('H2:H')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Dismissed').setBackground('#F1F5F9').setRanges([sh.getRange('H2:H')]).build()
  ]);
}

/** Bounded Home refresh: two value-range writes. Optionally reuses this run's tracker read. */
function refreshHome_(trackerOrNull) {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(CG.SHEETS.HOME);
  buildHomeLayoutIfNeeded_(sh);
  const tracker = trackerOrNull || readTracker_();
  const h = tracker.headers;
  const pendingRows = tracker.values
    .filter(row => ['Pending', 'Review'].includes(String(row[h.Status])))
    .sort((a, b) => {
      const ad = asDate_(a[h.Received]); const bd = asDate_(b[h.Received]);
      return (bd ? bd.getTime() : 0) - (ad ? ad.getTime() : 0);
    });

  sh.getRange('E7:H11').setValues([
    ['AI', getSetting_(CG.PROPS.OPENROUTER_KEY, '') ? 'Configured' : 'Not configured', '', ''],
    ['Phone alerts', getSetting_(CG.PROPS.POCKET_WEBHOOK, '') ? 'Configured' : 'Not configured', '', ''],
    ['Alerts today', dailyAlertsSent_(), '', ''],
    ['Pending attention', pendingRows.length, '', ''],
    ['Last scan', formatDateTime_(getSetting_(CG.PROPS.LAST_SCAN_AT, '')), '', '']
  ]);
  sh.getRange('E7:E11').setFontWeight('bold');

  const top = pendingRows.slice(0, 8);
  const grid = top.map(row =>
    [row[h.Received], row[h.Company], row[h.Role], row[h['What to do']], row[h.Deadline], row[h.Status]]);
  while (grid.length < 8) grid.push(['', '', '', '', '', '']);
  if (!pendingRows.length) grid[0][0] = 'Nothing needs your attention right now.';
  sh.getRange(16, 1, 8, 6).setValues(grid);

  // getValues() on the Tracker returns the display text "Open email", not the
  // hyperlink — so the Email column must be rebuilt as real HYPERLINK formulas.
  const linkFormulas = [];
  const threadIds = [];
  for (let i = 0; i < 8; i++) {
    const threadId = top[i] ? String(top[i][h['Thread ID']] || '') : '';
    threadIds.push([threadId]);
    linkFormulas.push([threadId ? `=HYPERLINK("${gmailThreadUrl_(threadId)}","Open email")` : '']);
  }
  sh.getRange(16, 7, 8, 1).setFormulas(linkFormulas);
  // Hidden per-row thread map (column I) lets a Status edit on Home sync back.
  sh.getRange(16, 9, 8, 1).setValues(threadIds);
  try { sh.hideColumns(9); } catch (e) {}
  sh.getRange('A16:A23').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('E16:E23').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('F16:F23').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pending', 'Review', 'Completed', 'Dismissed', 'No action'], true).build());
}

function refreshSettings_() {
  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.SETTINGS);
  buildSettingsLayoutIfNeeded_(sh);
  const scanTriggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scheduledCareerScan').length;
  const outbox = getSpreadsheet_().getSheetByName(CG.SHEETS.OUTBOX);
  const backfillDone = getSetting_(CG.PROPS.BACKFILL_DONE, '');
  const rows = [
    ['Setup', getSetting_(CG.PROPS.OPENROUTER_KEY, '') && getSetting_(CG.PROPS.POCKET_WEBHOOK, '') ? 'Complete' : 'Incomplete', 'Use Pingbird → Quick setup'],
    ['Pocket Alert template', '%message%', 'Enter this exact value when creating the webhook'],
    ['Pocket Alert URL', getSetting_(CG.PROPS.POCKET_WEBHOOK, '') ? 'Configured privately' : 'Not configured', 'Stored in Google User Properties; never shown here'],
    ['AI', getSetting_(CG.PROPS.OPENROUTER_KEY, '') ? 'Configured privately' : 'Not configured', 'OpenRouter key is never shown here'],
    ['AI model', getAiModel_(), 'Change via Advanced → Set AI model'],
    ['Last AI error', getSetting_(CG.PROPS.LAST_AI_ERROR, '') || 'None', 'If AI fails, emails fall back to the safe rule-based decisions'],
    ['AI requests today', Number(getUserProps_().getProperty(CG.PROPS.AI_CALLS_PREFIX + todayKey_()) || 0), `Capped at ${CG.AI.dailyRequestBudget} batched requests per day`],
    ['Schedule', '06:00 · 10:00 · 14:00 · 18:00 · 22:00', getTimeZone_()],
    ['Scheduled scans', scanTriggers === CG.SCHEDULE_HOURS.length ? 'Installed' : `Expected ${CG.SCHEDULE_HOURS.length}, found ${scanTriggers}`, 'Quick setup installs all of them'],
    ['Backfill window', `${Number(getSetting_(CG.PROPS.BACKFILL_MONTHS, CG.BACKFILL.defaultMonths))} months`, 'Change via Advanced → Set backfill window'],
    ['Backfill', backfillDone
      ? `Complete (${formatDateTime_(backfillDone)})`
      : (getSetting_(CG.PROPS.BACKFILL_CURSOR, '')
          ? `Imported back to ${formatDateTime_(getSetting_(CG.PROPS.BACKFILL_CURSOR, ''))} · ${getSetting_(CG.PROPS.BACKFILL_PROGRESS, 0)} emails so far`
          : `Not started · ${getSetting_(CG.PROPS.BACKFILL_PROGRESS, 0)} emails imported`),
      'Walks 15-day slices, newest first; progress survives the 6-minute limit'],
    ['Alert message', alertMessage_(), 'Change via Advanced → Set alert message; no email details are ever sent'],
    ['Alerts sent today', dailyAlertsSent_(), `Pingbird caps itself at ${CG.ALERT.dailyLimit}`],
    ['Pending alert retries', countOutboxStatus_(outbox, ['Pending', 'Retry']), 'The oldest unsuccessful alert is retried once per scheduled run'],
    ['Last successful alert', formatDateTime_(getSetting_(CG.PROPS.LAST_ALERT_OK, '')), 'Pocket Alert HTTP success'],
    ['Last alert error', getSetting_(CG.PROPS.LAST_ALERT_ERROR, '') || 'None', 'Fix the webhook, then use Advanced → Retry one pending alert'],
    ['Last scan', formatDateTime_(getSetting_(CG.PROPS.LAST_SCAN_AT, '')), 'Most recent completed Gmail scan'],
    ['Last scan error', getSetting_(CG.PROPS.LAST_SCAN_ERROR, '') || 'None', 'A failed message is retried on the next scan'],
    ['Version', CG.VERSION, 'Installed Pingbird version']
  ];
  sh.getRange(2, 1, 40, 3).clearContent();
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.getRange(2, 1, rows.length, 3).setWrap(true).setVerticalAlignment('top');
}

/* ================================================================== *
 * SECTION 12 — TRACKER EDITS
 * Bounded: status sync + one thread reconcile + one Home count update.
 * No full rescan, no workbook rebuild.
 * ================================================================== */

function handleTrackerEdit(event) {
  if (!event || !event.range) return;
  const sheetName = event.range.getSheet().getName();
  if (sheetName === CG.SHEETS.HOME) { handleHomeAttentionEdit_(event); return; }
  if (sheetName !== CG.SHEETS.TRACKER) return;
  withLock_('handleTrackerEdit', () => {
    const sh = event.range.getSheet();
    if (event.range.getLastRow() < 2) return;
    const h = indexHeaders_(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);
    const statusColumn = h.Status + 1;
    if (event.range.getColumn() > statusColumn || event.range.getLastColumn() < statusColumn) return;

    const firstRow = Math.max(2, event.range.getRow());
    const rowCount = event.range.getLastRow() - firstRow + 1;
    const statuses = sh.getRange(firstRow, statusColumn, rowCount, 1).getValues();
    const threadIds = sh.getRange(firstRow, h['Thread ID'] + 1, rowCount, 1).getValues();
    const touched = new Set();

    statuses.forEach((row, index) => {
      const status = String(row[0] || '');
      if (!['Pending', 'Review', 'Completed', 'Dismissed', 'No action'].includes(status)) return;
      sh.getRange(firstRow + index, h['Needs Attention'] + 1)
        .setValue(['Pending', 'Review'].includes(status) ? 'Yes' : 'No');
      const threadId = String(threadIds[index][0] || '');
      if (threadId) touched.add(threadId);
    });

    if (touched.size) {
      const tracker = readTracker_();
      const rowsByThread = buildRowsByThread_(tracker, []);
      const actionLabel = ensureLabel_(CG.LABELS.ACTION);
      touched.forEach(threadId => {
        try {
          const thread = GmailApp.getThreadById(threadId);
          const rows = rowsByThread.get(threadId) || [];
          if (!thread || !rows.length) return;
          if (rows.some(row => ['Pending', 'Review'].includes(row.status))) {
            thread.addLabel(actionLabel);
            thread.moveToInbox();
            thread.markUnread();
          } else {
            thread.removeLabel(actionLabel);
            if (rows[0].safeArchive === 'Yes') thread.moveToArchive();
          }
        } catch (error) {
          logSystem_('WARN', 'EDIT', 'Could not reconcile edited tracker row', {threadId: threadId, error: error.message});
        }
      });
      try { refreshHome_(tracker); } catch (e) {}
    }
  });
}

/**
 * Factory reset: deletes and rebuilds every Pingbird sheet, clears all
 * run state, removes automation, and (optionally) deletes the Gmail labels so
 * history can be re-imported. Saved secrets (OpenRouter key, Pocket Alert
 * webhook, AI model, backfill window) are kept. Sheets that are not part of
 * Pingbird are never touched.
 */
function resetCareerGuardian() {
  const ui = SpreadsheetApp.getUi();
  const first = ui.alert('Reset Pingbird?',
    'This permanently clears the Tracker and ALL internal data (state, alert queue, logs, ' +
    'test results) and rebuilds a fresh template.\n\n' +
    'Kept: your OpenRouter key, Pocket Alert webhook, AI model, alert message, and backfill window.\n' +
    'Removed: scheduled automation (reinstall afterwards).\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (first !== ui.Button.YES) return;
  const wipeLabels = ui.alert('Also reset Gmail labels?',
    'YES — delete the "Jbs", "Action required", and hidden "CG/Processed" labels from Gmail. ' +
    'Pingbird forgets which threads it handled, so a fresh backfill re-imports history.\n\n' +
    'NO — keep the labels; previously processed threads stay processed and will not be imported again.',
    ui.ButtonSet.YES_NO) === ui.Button.YES;

  withLock_('reset', () => {
    resetRunState_();
    const ss = SpreadsheetApp.getActiveSpreadsheet() || getSpreadsheet_();
    getUserProps_().setProperty(CG.PROPS.SPREADSHEET_ID, ss.getId());
    CG_RUN.cache.ss = ss;
    removeAutomation_();

    // A spreadsheet must always contain at least one sheet, so park a
    // temporary one while every Pingbird sheet is deleted and rebuilt.
    const cgNames = [CG.SHEETS.HOME, CG.SHEETS.TRACKER, CG.SHEETS.SETTINGS,
      CG.SHEETS.STATE, CG.SHEETS.OUTBOX, CG.SHEETS.LOG, CG.SHEETS.TESTS];
    let keeper = null;
    try { keeper = ss.insertSheet('_CG_RESET_TMP'); } catch (error) {}
    cgNames.forEach(name => {
      const sh = ss.getSheetByName(name);
      if (sh) { try { ss.deleteSheet(sh); } catch (error) {} }
    });

    // Clear run state; keep secrets and user preferences.
    const props = getUserProps_();
    [CG.PROPS.LAST_SCAN_AT, CG.PROPS.LAST_SCAN_ERROR, CG.PROPS.LAST_ALERT_OK,
     CG.PROPS.LAST_ALERT_ERROR, CG.PROPS.LAST_AI_ERROR, CG.PROPS.TESTS_PASSED_AT,
     CG.PROPS.BACKFILL_DONE, CG.PROPS.BACKFILL_PROGRESS, CG.PROPS.BACKFILL_CURSOR].forEach(key => props.deleteProperty(key));
    (props.getKeys() || []).forEach(key => {
      if (key.indexOf(CG.PROPS.AI_CALLS_PREFIX) === 0 || key.indexOf(CG.PROPS.ALERT_SENT_PREFIX) === 0) {
        props.deleteProperty(key);
      }
    });

    if (wipeLabels) {
      [CG.LABELS.PROCESSED, CG.LABELS.ACTION, CG.LABELS.JOBS].forEach(name => {
        try {
          const label = GmailApp.getUserLabelByName(name);
          if (label) label.deleteLabel();
        } catch (error) {
          logSystem_('WARN', 'RESET', 'Could not delete label', {label: name, error: error.message});
        }
      });
      CG_RUN.cache.labels = {};
    }

    ensureAllLabels_();
    ensureAllSheets_(ss);
    if (keeper) { try { ss.deleteSheet(keeper); } catch (error) {} }
    try { refreshHome_(null); } catch (error) {}
    try { refreshSettings_(); } catch (error) {}
  });

  ui.alert('Reset complete',
    'A fresh template is in place.\n\nNext steps:\n' +
    '1. Advanced → Install / repair automation (or run 🚀 Quick setup)\n' +
    '2. Scan now, and Run backfill batch' +
    (wipeLabels ? ' to re-import history.' : '.'),
    ui.ButtonSet.OK);
}

/** Sets Status=Dismissed on Review rows whose Stage is Ignore (past noise). */
function dismissIgnoreReviewRows() {
  setupIfNeeded_();
  const tracker = readTracker_();
  const h = tracker.headers;
  const updatedRows = new Set();
  const touched = new Set();
  tracker.values.forEach((row, index) => {
    if (String(row[h.Status]) !== 'Review') return;
    const isIgnoreStage = String(row[h.Stage]) === 'Ignore';
    const isLinkedInNotification = String(row[h.Company]) === 'LinkedIn' && !String(row[h.Role] || '');
    if (!isIgnoreStage && !isLinkedInNotification) return;
    row[h.Status] = 'Dismissed';
    row[h['Needs Attention']] = 'No';
    row[h.Notes] = 'Dismissed by noise cleanup';
    updatedRows.add(index + 2);
    const threadId = String(row[h['Thread ID']] || '');
    if (threadId) touched.add(threadId);
  });
  applyTrackerUpdates_(tracker, updatedRows);

  const actionLabel = ensureLabel_(CG.LABELS.ACTION);
  const rowsByThread = buildRowsByThread_(tracker, []);
  touched.forEach(threadId => {
    try {
      const thread = GmailApp.getThreadById(threadId);
      if (!thread) return;
      const rows = rowsByThread.get(threadId) || [];
      if (!rows.some(row => ['Pending', 'Review'].includes(row.status))) thread.removeLabel(actionLabel);
    } catch (error) {
      logSystem_('WARN', 'CLEANUP', 'Could not reconcile dismissed thread', {threadId: threadId, error: error.message});
    }
  });
  try { refreshHome_(tracker); } catch (e) {}
  SpreadsheetApp.getUi().alert(updatedRows.size
    ? `Dismissed ${updatedRows.size} noise Review row(s).`
    : 'No noise Review rows found.');
}

/**
 * Status changed directly in Home's "NEEDS YOUR ATTENTION" list (F16:F23):
 * update the matching Tracker row, reconcile the Gmail thread, and refresh
 * Home so completed items disappear from the list immediately.
 */
function handleHomeAttentionEdit_(event) {
  const range = event.range;
  if (range.getColumn() > 6 || range.getLastColumn() < 6) return;
  const firstRow = Math.max(16, range.getRow());
  const lastRow = Math.min(23, range.getLastRow());
  if (lastRow < firstRow) return;

  withLock_('handleHomeEdit', () => {
    const home = getSpreadsheet_().getSheetByName(CG.SHEETS.HOME);
    const count = lastRow - firstRow + 1;
    const statuses = home.getRange(firstRow, 6, count, 1).getValues();
    const threadIds = home.getRange(firstRow, 9, count, 1).getValues();

    const tracker = readTracker_();
    const h = tracker.headers;
    const updatedRows = new Set();
    const touched = new Set();

    statuses.forEach((cell, index) => {
      const status = String(cell[0] || '');
      const threadId = String(threadIds[index][0] || '');
      if (!threadId) return;
      if (!['Pending', 'Review', 'Completed', 'Dismissed', 'No action'].includes(status)) return;
      // Topmost still-open row for this thread is the one shown on Home.
      for (let i = 0; i < tracker.values.length; i++) {
        const row = tracker.values[i];
        if (String(row[h['Thread ID']]) !== threadId) continue;
        if (!['Pending', 'Review'].includes(String(row[h.Status])) &&
            String(row[h.Status]) !== status) continue;
        row[h.Status] = status;
        row[h['Needs Attention']] = ['Pending', 'Review'].includes(status) ? 'Yes' : 'No';
        updatedRows.add(i + 2);
        touched.add(threadId);
        break;
      }
    });

    if (!updatedRows.size) { refreshHome_(tracker); return; }
    applyTrackerUpdates_(tracker, updatedRows);

    const actionLabel = ensureLabel_(CG.LABELS.ACTION);
    const rowsByThread = buildRowsByThread_(tracker, []);
    touched.forEach(threadId => {
      try {
        const thread = GmailApp.getThreadById(threadId);
        const rows = rowsByThread.get(threadId) || [];
        if (!thread || !rows.length) return;
        if (rows.some(row => ['Pending', 'Review'].includes(row.status))) {
          thread.addLabel(actionLabel);
          thread.moveToInbox();
          thread.markUnread();
        } else {
          thread.removeLabel(actionLabel);
          if (rows[0].safeArchive === 'Yes') thread.moveToArchive();
        }
      } catch (error) {
        logSystem_('WARN', 'HOME_EDIT', 'Could not reconcile thread from Home edit', {threadId: threadId, error: error.message});
      }
    });
    refreshHome_(tracker);
  });
}

/* ================================================================== *
 * SECTION 13 — TESTS, HEALTH CHECK, PERFORMANCE PROBE
 * ================================================================== */

function regressionFixtures_() {
  return [
    {name: '1 Level AI acknowledgement is not rejection',
     sender: 'Level AI <no-reply@hire.lever.co>',
     subject: 'Thank you for your application to Level AI',
     body: 'We received your application for Lead Software Engineer - AI Agents. If you are not selected for this position, keep an eye on our jobs page.',
     expected: 'Applied|false|true'},
    {name: '2 Aera acknowledgement under review',
     sender: 'Aera Technology <no-reply@hire.lever.co>',
     subject: 'Thank you for your application to Aera Technology',
     body: 'Your application has been received and is currently being reviewed by our internal team.',
     expected: 'Under Review|false|true'},
    {name: '3 Google assessment action',
     sender: 'noreply@google.com',
     subject: '[Due in 4 days] Next Part of your Google Application: Google Hiring Assessment',
     body: 'Thanks again for applying. The next step is to complete the Google Hiring Assessment.',
     expected: 'Assessment|true|false'},
    {name: '4 Google passed assessment resolves action',
     sender: 'noreply@google.com',
     subject: 'Google Hiring Assessment results',
     body: 'Congratulations! You passed the Google Hiring Assessment. Our Recruiting team is reviewing your candidacy for next steps.',
     expected: 'Under Review|false|true'},
    {name: '5 Turgon interview request',
     sender: 'chaitanya@coderound.tech',
     subject: 'Interview Request: Senior AI Engineer at Turgon AI',
     body: 'You have been shortlisted by the hiring manager. Please share your availability for an interview.',
     expected: 'Interview|true|false'},
    {name: '6 EPAM interview reminder',
     sender: 'noreply.interview@epam.com',
     subject: 'EPAM Technical Interview: Shardul Inamdar',
     body: 'Please accept the invitation to inform us about your attendance. Join interview Friday.',
     expected: 'Interview|true|false'},
    {name: '7 EPAM interview completion has no action',
     sender: 'noreply.interview@epam.com',
     subject: 'EPAM Technical interview: Shardul Inamdar',
     body: 'Your Technical Interview is completed. Please share feedback about the interview.',
     expected: 'Interview|false|true'},
    {name: '8 Explicit rejection',
     sender: 'careers@example.com',
     subject: 'Update on your application',
     body: 'After reviewing your application, we have decided not to move forward with your application.',
     expected: 'Rejected|false|true'},
    {name: '9 Hypothetical rejection sentence stays Applied',
     sender: 'careers@example.com',
     subject: 'Application received',
     body: 'We received your application. If you are not selected, please watch our jobs page.',
     expected: 'Applied|false|true'},
    {name: '10 ADPList newsletter mentioning interviews is unrelated',
     sender: 'Felix Lee <felix@mail.adplist.org>',
     subject: 'Introducing Claude to ADPList',
     body: 'Book an interview prep session with a mentor. Unsubscribe.',
     expected: 'UNRELATED'},
    {name: '11 LinkedIn newsletter is unrelated',
     sender: 'newsletters-noreply@linkedin.com',
     subject: 'She Applied to Google and Got an Interview',
     body: 'Career newsletter. Manage preferences. Unsubscribe.',
     expected: 'UNRELATED'},
    {name: '12 LinkedIn application confirmation',
     sender: 'LinkedIn <jobs-noreply@linkedin.com>',
     subject: 'Your application to Senior AI Engineer at SPlus IT Solutions',
     body: 'Your application to Senior AI Engineer at SPlus IT Solutions was sent.',
     expected: 'Applied|false|true'},
    {name: '13 Microsoft acknowledgement',
     sender: 'Microsoft Careers <donotreply@email.careers.microsoft.com>',
     subject: 'Thank you for your application!',
     body: 'Thank you for taking the time to submit your application for Software Engineer 2 (Job number: 200038122).',
     expected: 'Applied|false|true'},
    {name: '14 Ollion recruiter asks for CTC and notice period',
     sender: 'notifications@ollion.com',
     subject: 'Ollion - Thanks for Applying! Need more details!',
     body: 'Regarding your application, please reply with current CTC, expected CTC and notice period.',
     expected: 'Under Review|true|false'},
    {name: '15b Generic interview advice is unrelated',
     sender: 'Austin <austin@cultivatedculture.com>',
     subject: '7 Interview Truths Nobody Tells You',
     body: 'I bombed my first interview at Google. Unsubscribe.',
     expected: 'UNRELATED'},
    {name: '16 Income-tax intimation is unrelated despite "Assessment Year"',
     sender: 'Income Tax Department <intimations@cpc.incometax.gov.in>',
     subject: 'ITR Intimation u/s 143(1)',
     body: 'Your Income Tax Return for Assessment Year 2026-27 has been processed. Please complete e-verification before the due date.',
     expected: 'UNRELATED'},
    {name: '17 LinkedIn Premium marketing is unrelated',
     sender: 'LinkedIn <premium-noreply@notifications.linkedin.com>',
     subject: 'Get ahead with LinkedIn Premium',
     body: 'Try LinkedIn Premium free for a month and stand out in interviews. Renew your subscription anytime. Unsubscribe.',
     expected: 'UNRELATED'},
    {name: '18 Bank statement is unrelated',
     sender: 'HDFC Bank <alerts@hdfcbank.net>',
     subject: 'Your account statement is ready',
     body: 'Your monthly account statement is available in netbanking.',
     expected: 'UNRELATED'},
    {name: '19 Google recruiter rejection ("decided not to proceed")',
     sender: 'Divya Chaudhary (xWF) <chaudharydi@google.com>',
     subject: 'Following up on your recent application to Google',
     body: 'A Googler recently invited you to apply for the Applied AI/ML Engineer - Bengaluru role. We carefully reviewed your background and experience, and decided not to proceed with your application at this time. Although this role didn\'t work out, we may contact you if we come across another opening.',
     expected: 'Rejected|false|true'},
    {name: '20 LinkedIn "application viewed" notification is unrelated',
     sender: 'LinkedIn <jobs-noreply@linkedin.com>',
     subject: 'Your application was viewed by AlphaSense',
     body: 'Your application was viewed by the hiring team at AlphaSense. See jobs similar to this one on linkedin.com.',
     expected: 'UNRELATED'}
  ];
}

function aiPolicyFixtures_() {
  return [
    {name: 'AI cannot turn acknowledgement into rejection',
     sender: 'Level AI <no-reply@hire.lever.co>',
     subject: 'Thank you for your application to Level AI',
     body: 'We received your application. If you are not selected, keep an eye on our jobs page.',
     ai: {email_type: 'rejection', stage: 'Rejected', requires_action: false, confidence: 0.99, reason: 'Incorrect rejection'},
     expected: 'UNCERTAIN'},
    {name: 'deterministic action wins AI unrelated disagreement',
     sender: 'noreply@google.com',
     subject: 'Next Part of your Google Application: Google Hiring Assessment',
     body: 'Please complete the assessment in four days.',
     ai: {email_type: 'unrelated', stage: '', requires_action: false, confidence: 0.99, reason: 'Incorrect unrelated'},
     expected: 'Assessment|true|false'},
    {name: 'AI and rules agree acknowledgement can archive',
     sender: 'Level AI <no-reply@hire.lever.co>',
     subject: 'Thank you for your application to Level AI',
     body: 'We received your application for Lead Software Engineer - AI Agents.',
     ai: {email_type: 'application_acknowledgement', stage: 'Applied', requires_action: false, company: 'Level AI', role: 'Lead Software Engineer - AI Agents', confidence: 0.98, reason: 'Acknowledgement'},
     expected: 'Applied|false|true'},
    {name: 'AI action upgrades recruiter outreach',
     sender: 'Jane <jane@startup.ai>',
     subject: 'AI Engineer opportunity',
     body: 'Your profile stood out. Would you be open to a conversation?',
     ai: {email_type: 'recruiter_request', stage: 'Under Review', requires_action: true, action_summary: 'Reply to recruiter', company: 'Startup AI', role: 'AI Engineer', confidence: 0.96, reason: 'Personal recruiter outreach'},
     expected: 'Under Review|true|false'},
    {name: 'safer recruiter-action evidence wins AI no-action',
     sender: 'Jane <jane@startup.ai>',
     subject: 'AI Engineer opportunity',
     body: 'Your profile stood out. We may contact you later.',
     ai: {email_type: 'recruiter_request', stage: 'Under Review', requires_action: false, company: 'Startup AI', role: 'AI Engineer', confidence: 0.96, reason: 'No immediate action'},
     expected: 'Under Review|true|false'},
    {name: 'string "false" is not treated as true',
     sender: 'careers@example.com',
     subject: 'Thank you for your application',
     body: 'We received your application for Data Engineer.',
     ai: {email_type: 'application_acknowledgement', stage: 'Applied', requires_action: 'false', company: 'Example', role: 'Data Engineer', confidence: 98, reason: 'Acknowledgement; confidence given as 98'},
     expected: 'Applied|false|true'},
    {name: 'weak unrelated + uncertain AI stays unrelated, never Review',
     sender: 'events@techconf.io',
     subject: 'Speaker invitation follow-up',
     body: 'We would love your thoughts on the conference agenda for next month.',
     ai: {email_type: 'uncertain', stage: '', requires_action: false, confidence: 0.95, reason: 'Unsure'},
     expected: 'UNRELATED'},
    {name: 'weak unrelated + low-confidence AI stays unrelated, never Review',
     sender: 'events@techconf.io',
     subject: 'Speaker invitation follow-up',
     body: 'We would love your thoughts on the conference agenda for next month.',
     ai: {email_type: 'status_update', stage: 'Applied', requires_action: false, confidence: 0.4, reason: 'Low confidence guess'},
     expected: 'UNRELATED'},
    {name: 'confident career email without action becomes quiet No-action row',
     sender: 'Acme <no-reply@hire.lever.co>',
     subject: 'An update regarding your application',
     body: 'Regarding your application, our team has shared an internal update. No action is needed from you.',
     ai: {email_type: 'status_update', stage: 'Under Review', requires_action: false, company: 'Acme', role: 'Engineer', confidence: 0.95, reason: 'Status update'},
     expected: 'Under Review|false|false'},
    {name: 'unknown enum value becomes uncertain',
     sender: 'careers@example.com',
     subject: 'Thank you for your application',
     body: 'We received your application for Data Engineer. Something ambiguous follows.',
     ai: {email_type: 'banana', stage: 'Applied', requires_action: false, confidence: 0.99, reason: 'Nonsense type'},
     expected: 'UNCERTAIN'}
  ];
}

function runRegressionTests() {
  const result = runRegressionTests_(false);
  SpreadsheetApp.getUi().alert(result.failures
    ? `${result.failures} of ${result.total} tests failed. See the hidden _Tests sheet.`
    : `All ${result.total} safety tests passed.`);
}

function runRegressionTests_(quiet) {
  setupIfNeeded_();
  const rows = [];
  let failures = 0;
  const describe = result => result.decision === 'JOB'
    ? `${result.stage}|${Boolean(result.requiresAction)}|${Boolean(result.deterministicArchive)}`
    : result.decision;

  regressionFixtures_().forEach(test => {
    const result = classifyDeterministic_({sender: test.sender, subject: test.subject, body: test.body, date: new Date()});
    const actual = describe(result);
    // WEAK/PROBABLE non-noise results defer to AI; deterministic tests only pin DEFINITE outcomes.
    const pass = actual === test.expected ||
      (test.expected === 'UNRELATED' && result.decision === 'UNRELATED');
    if (!pass) failures++;
    rows.push([new Date(), test.name, test.expected, actual, pass ? 'PASS' : 'FAIL', result.reason || '']);
  });

  aiPolicyFixtures_().forEach(test => {
    const mail = {sender: test.sender, subject: test.subject, body: test.body, date: new Date()};
    const result = reconcileAiPrimaryDecision_(mail, classifyDeterministic_(mail), test.ai);
    const actual = describe(result);
    const pass = actual === test.expected;
    if (!pass) failures++;
    rows.push([new Date(), 'AI policy: ' + test.name, test.expected, actual, pass ? 'PASS' : 'FAIL', result.reason || '']);
  });

  // Fixture 15: the user's own reply in an application thread is ignored.
  const ownPass = isOwnMessage_('me@example.com', 'me@example.com') === true &&
    isOwnMessage_('recruiter@company.com', 'me@example.com') === false &&
    isOwnMessage_('anyone@example.com', '') === false;
  if (!ownPass) failures++;
  rows.push([new Date(), '15 Own reply in application thread is skipped', 'skip own / keep others', ownPass ? 'as expected' : 'mismatch', ownPass ? 'PASS' : 'FAIL', 'isOwnMessage_ predicate']);

  const sh = getSpreadsheet_().getSheetByName(CG.SHEETS.TESTS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  if (failures === 0) setSetting_(CG.PROPS.TESTS_PASSED_AT, new Date().toISOString());
  else getUserProps_().deleteProperty(CG.PROPS.TESTS_PASSED_AT);
  if (!quiet) refreshSettings_();
  return {total: rows.length, failures: failures};
}

/** Times each expensive primitive once so the true bottleneck is measurable. */
function runPerformanceProbe() {
  setupIfNeeded_();
  resetRunState_();
  const lines = [];
  const time = (name, fn) => {
    const start = Date.now();
    let note = '';
    try { const out = fn(); note = out === undefined ? '' : String(out); }
    catch (error) { note = 'ERROR: ' + error.message; }
    lines.push(`${name}: ${Date.now() - start} ms${note ? ' (' + note + ')' : ''}`);
  };
  time('Gmail discovery query (new work)', () => {
    const found = findCandidateThreads_(false, null);
    return `${found.newThreads.length} new + ${found.trackedThreads.length} tracked threads`;
  });
  time('Batch message load (≤10 threads)', () => {
    const found = findCandidateThreads_(false, null);
    const sample = found.newThreads.concat(found.trackedThreads).slice(0, 10);
    if (!sample.length) return 'no threads to sample';
    const messages = GmailApp.getMessagesForThreads(sample);
    return `${messages.reduce((n, m) => n + m.length, 0)} messages`;
  });
  time('Tracker full read', () => `${readTracker_().values.length} rows`);
  time('State ids load', () => `${loadProcessedIds_(readTracker_()).size} ids`);
  time('Sheet batch write (5 log rows)', () => {
    appendRows_(getSpreadsheet_().getSheetByName(CG.SHEETS.LOG),
      [[new Date(), 'INFO', 'PERF_PROBE', 'probe', '{}'], [new Date(), 'INFO', 'PERF_PROBE', 'probe', '{}'],
       [new Date(), 'INFO', 'PERF_PROBE', 'probe', '{}'], [new Date(), 'INFO', 'PERF_PROBE', 'probe', '{}'],
       [new Date(), 'INFO', 'PERF_PROBE', 'probe', '{}']]);
  });
  SpreadsheetApp.getUi().alert('Performance probe', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
  logSystem_('INFO', 'PERF_PROBE', 'Performance probe completed', {lines: lines});
}

function runHealthCheck() {
  setupIfNeeded_();
  const ui = SpreadsheetApp.getUi();
  const lines = [];
  let ok = true;
  const check = (condition, success, failure) => {
    if (condition) lines.push('✅ ' + success);
    else { lines.push('❌ ' + failure); ok = false; }
  };
  try {
    const ss = getSpreadsheet_();
    check(Boolean(ss), 'Spreadsheet is connected', 'Spreadsheet connection failed');
    check(isValidTimeZone_(getTimeZone_()), `Timezone is valid: ${getTimeZone_()}`, 'Timezone is invalid');
    [CG.SHEETS.HOME, CG.SHEETS.TRACKER, CG.SHEETS.SETTINGS, CG.SHEETS.STATE, CG.SHEETS.OUTBOX, CG.SHEETS.LOG, CG.SHEETS.TESTS]
      .forEach(name => check(Boolean(ss.getSheetByName(name)), `Sheet exists: ${name}`, `Missing sheet: ${name}`));
    check(Boolean(GmailApp.getUserLabelByName(CG.LABELS.JOBS)), 'Jbs label exists', 'Jbs label is missing');
    check(Boolean(GmailApp.getUserLabelByName(CG.LABELS.ACTION)), 'Action required label exists', 'Action required label is missing');
    check(Boolean(GmailApp.getUserLabelByName(CG.LABELS.PROCESSED)), 'Processed label exists', 'Processed label is missing');
    check(Boolean(getSetting_(CG.PROPS.OPENROUTER_KEY, '')), 'AI key is configured', 'AI key is not configured');
    check(validatePocketWebhook_(getSetting_(CG.PROPS.POCKET_WEBHOOK, '')).valid,
      'Pocket Alert webhook format is valid', 'Pocket Alert webhook is missing or invalid');
    const scanTriggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'scheduledCareerScan').length;
    check(scanTriggers === CG.SCHEDULE_HOURS.length,
      `${CG.SCHEDULE_HOURS.length} scheduled scans are installed`,
      `Expected ${CG.SCHEDULE_HOURS.length} scheduled scans, found ${scanTriggers}`);
    const tests = runRegressionTests_(true);
    check(tests.failures === 0, `${tests.total} safety tests passed`, `${tests.failures} safety tests failed`);
  } catch (error) {
    lines.push('❌ System check stopped: ' + error.message);
    ok = false;
  }
  refreshSettings_();
  ui.alert(ok ? 'Pingbird system check passed' : 'Pingbird needs attention',
    lines.join('\n'), ui.ButtonSet.OK);
  return {ok: ok, lines: lines};
}

/* ================================================================== *
 * SECTION 14 — LOGGING AND SMALL UTILITIES
 * ================================================================== */

function logSystem_(level, component, message, details) {
  try {
    appendRows_(getSpreadsheet_().getSheetByName(CG.SHEETS.LOG), [[
      new Date(), level, component, safeCellText_(message), JSON.stringify(details || {}).slice(0, 45000)
    ]]);
  } catch (error) {
    console.log(`${level} ${component}: ${message}`);
  }
}

function flushPerfLog_(summary) {
  try {
    const rows = CG_RUN.perf.slice();
    rows.push([new Date(), 'INFO', 'SCAN',
      summary.stopReason ? 'Scan stopped early inside its own deadline' : 'Scan completed',
      JSON.stringify(summary).slice(0, 45000)]);
    appendRows_(getSpreadsheet_().getSheetByName(CG.SHEETS.LOG), rows);
  } catch (error) {
    console.log('PERF flush failed: ' + error.message);
  }
}

function quoteLabel_(name) { return name.includes(' ') ? `"${name}"` : name; }
function trackerSheetUrl_() {
  const ss = getSpreadsheet_();
  return `${ss.getUrl()}#gid=${ss.getSheetByName(CG.SHEETS.TRACKER).getSheetId()}`;
}
function gmailThreadUrl_(threadId) { return `https://mail.google.com/mail/u/0/#all/${threadId}`; }
function styleHeader_(range) {
  range.setBackground('#1D4ED8').setFontColor('#FFFFFF').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}
function indexHeaders_(headers) {
  return headers.reduce((acc, value, index) => (acc[String(value)] = index, acc), {});
}
function formatDateTime_(value) {
  const date = asDate_(value);
  if (!date) return value || 'Never';
  return Utilities.formatDate(date, getTimeZone_(), 'dd MMM yyyy, hh:mm a');
}
function asDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) return value;
  const parsed = new Date(value);
  return isNaN(parsed) ? null : parsed;
}
function toast_(message, title) {
  try { getSpreadsheet_().toast(message, title || 'Pingbird', 6); }
  catch (error) { console.log(message); }
}
