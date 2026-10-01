/**
 * The Contest Room: automatic backup of Neon data to Google Drive.
 *
 * Runs inside your own Google account (script.google.com), so no Google Cloud project or keys are needed.
 * Every 5 minutes it pulls new data from the site's admin API and writes it into a Drive folder:
 *
 *   answers/answers-latest.json         every student's current answers and status (overwritten each run)
 *   answers/answers-<time>.json         a timestamped copy from each run (history)
 *   logs/logs-<fromId>-<toId>.jsonl     activity-log batches, one JSON object per line, never overwritten
 *   joins/joins-<fromId>-<toId>.jsonl   every join with IP and browser
 *
 * Setup: see the README section "Google Drive backup".
 */

const RUN_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops a run at 6 minutes
const MAX_FILE_CHARS = 40 * 1000 * 1000;

function props_() { return PropertiesService.getScriptProperties(); }

function cfg_() {
  const p = props_();
  const base = (p.getProperty('BASE_URL') || '').replace(/\/+$/, '');
  const key = p.getProperty('ADMIN_KEY');
  const folderId = p.getProperty('FOLDER_ID');
  if (!base || !key || !folderId) throw new Error('Set BASE_URL, ADMIN_KEY and FOLDER_ID in Project Settings → Script properties.');
  return { base, key, folderId };
}

function get_(c, query) {
  const r = UrlFetchApp.fetch(c.base + '/api/admin?' + query, {
    headers: { 'x-admin-key': c.key }, muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) throw new Error('HTTP ' + r.getResponseCode() + ' for ' + query + ': ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}

function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function write_(folder, name, text, overwrite) {
  if (overwrite) {
    const it = folder.getFilesByName(name);
    if (it.hasNext()) { it.next().setContent(text); return; }
  }
  folder.createFile(Utilities.newBlob(text, 'application/json', name));
}

const stamp_ = () => Utilities.formatDate(new Date(), 'Africa/Nairobi', "yyyy-MM-dd'T'HH-mm-ss");

/** Main job. The trigger calls this; you can also run it by hand. */
function backup() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;            // a previous run is still going
  const t0 = Date.now();
  try {
    const c = cfg_();
    const root = DriveApp.getFolderById(c.folderId);

    // 1. Answers and status for every student (small: re-fetched in full each run)
    const all = [];
    let after = '';
    do {
      const page = get_(c, 'action=backup-sessions&after=' + encodeURIComponent(after));
      all.push.apply(all, page.rows);
      after = page.next;
    } while (after);
    const text = JSON.stringify({ savedAt: new Date().toISOString(), students: all });
    const aFolder = sub_(root, 'answers');
    write_(aFolder, 'answers-latest.json', text, true);
    write_(aFolder, 'answers-' + stamp_() + '.json', text, false);

    // 2. New activity-log batches since the last run (append-only)
    pullIncremental_(c, sub_(root, 'logs'), 'backup-logs', 'LAST_LOG_ID', 'logs', t0);
    // 3. New joins since the last run
    pullIncremental_(c, sub_(root, 'joins'), 'backup-joins', 'LAST_JOIN_ID', 'joins', t0);

    props_().setProperty('LAST_OK', new Date().toISOString() + ' · ' + all.length + ' students');
  } finally {
    lock.releaseLock();
  }
}

function pullIncremental_(c, folder, action, propName, prefix, t0) {
  let last = props_().getProperty(propName) || '0';
  let buf = [], size = 0, from = last;
  const flush = () => {
    if (!buf.length) return;
    write_(folder, prefix + '-' + pad_(from) + '-' + pad_(last) + '.jsonl', buf.join('\n') + '\n', false);
    props_().setProperty(propName, last);   // only advance after the file is safely written
    buf = []; size = 0; from = last;
  };
  for (;;) {
    const page = get_(c, 'action=' + action + '&after=' + last);
    for (const r of page.rows) { const line = JSON.stringify(r); buf.push(line); size += line.length; }
    last = page.last;
    if (size > MAX_FILE_CHARS) flush();
    if (!page.more || Date.now() - t0 > RUN_BUDGET_MS) break;
  }
  flush();
}

const pad_ = n => ('0000000000' + n).slice(-10);

/** Run once: checks the settings, does a first backup, and schedules it every 5 minutes. */
function setup() {
  cfg_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'backup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('backup').timeBased().everyMinutes(5).create();
  backup();
  Logger.log('Backup scheduled every 5 minutes. Last result: ' + props_().getProperty('LAST_OK'));
}

/** Run to stop the automatic backups (e.g. a few hours after the contest). */
function stop() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'backup') ScriptApp.deleteTrigger(t); });
  Logger.log('Automatic backups stopped.');
}
