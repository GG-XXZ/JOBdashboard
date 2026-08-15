// Local static file server for the job-search dashboard.
// Serves this folder on http://localhost:8420 so dashboard.html can fetch()
// the CSV files with fresh data on every reload. Also exposes write
// endpoints so the dashboard can:
//   - mark a job as Offer/Rejected (POST /api/update-status)
//   - add/edit/delete an upcoming calendar event, which also stamps the
//     job's current_stage in job_pool.csv (POST /api/calendar/*)
const http = require('http');
const fs = require('fs');
const path = require('path');
const emailMonitor = require('./email-monitor');

const PORT = 8420;
const ROOT = __dirname;
const JOB_POOL_PATH = path.join(ROOT, 'job_pool.csv');
const FOLLOW_UP_PATH = path.join(ROOT, 'follow_up.csv');
const APPLICATION_LOG_PATH = path.join(ROOT, 'application_log.csv');
const BLOCKER_QUEUE_PATH = path.join(ROOT, 'blocker_queue.csv');
const LEAD_SOURCES_PATH = path.join(ROOT, 'lead_sources.csv');
const RESUME_TEMPLATES_PATH = path.join(ROOT, 'resume_templates.csv');
const RESUME_REQUESTS_PATH = path.join(ROOT, 'resume_requests.csv');
const ACTIVITY_LOG_PATH = path.join(ROOT, 'activity_log.csv');
const SETTINGS_PATH = path.join(ROOT, 'dashboard_settings.json');
const EMAIL_CONFIG_PATH = path.join(ROOT, 'email_config.local.json');
const EMAIL_STATE_PATH = path.join(ROOT, 'email_state.local.json');
const TAILORED_RESUME_ROOT = path.resolve(ROOT, '..', 'tailored-resumes');

const FILE_SCHEMAS = new Map([
  [LEAD_SOURCES_PATH, ['date_added', 'source_type', 'name', 'url', 'notes', 'status', 'last_checked', 'next_action', 'enabled']],
  [RESUME_TEMPLATES_PATH, ['template_id', 'template_name', 'source_file_path', 'output_format', 'is_default', 'notes']],
  [RESUME_REQUESTS_PATH, ['request_date', 'company', 'job_title', 'job_url', 'template_id', 'status', 'output_directory', 'output_file', 'notes']],
  [ACTIVITY_LOG_PATH, ['timestamp', 'action', 'company', 'job_title', 'details']],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Same quoted-field CSV dialect job_pool.csv already uses (every field
// quoted, "" for an embedded quote, CRLF line endings).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function stringifyField(f) {
  return '"' + String(f == null ? '' : f).replace(/"/g, '""') + '"';
}

function stringifyCSV(rows) {
  return rows.map(r => r.map(stringifyField).join(',')).join('\r\n') + '\r\n';
}

function readCSVRows(filePath) {
  // PowerShell's UTF-8 CSV writer includes a BOM. Keep it out of the first
  // column name so subsequent writes do not silently lose that column.
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCSV(text);
  return { header: rows[0], dataRows: rows.slice(1) };
}

function writeCSVRows(filePath, header, dataRows) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, stringifyCSV([header, ...dataRows]), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function ensureDataFiles() {
  for (const [filePath, header] of FILE_SCHEMAS) {
    if (!fs.existsSync(filePath)) writeCSVRows(filePath, header, []);
  }
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
      title: 'JOBdashboard · 求职进度看板',
      search_sources: { web_enabled: true },
    }, null, 2), 'utf8');
  }
  ensureLeadSourceSchema();
  fs.mkdirSync(TAILORED_RESUME_ROOT, { recursive: true });
}

function ensureLeadSourceSchema() {
  if (!fs.existsSync(LEAD_SOURCES_PATH)) return;
  const { header, dataRows } = readCSVRows(LEAD_SOURCES_PATH);
  if (header.includes('enabled')) return;
  header.push('enabled');
  const statusIndex = header.indexOf('status');
  dataRows.forEach(row => row.push(statusIndex >= 0 && row[statusIndex] === 'Archived' ? 'No' : 'Yes'));
  writeCSVRows(LEAD_SOURCES_PATH, header, dataRows);
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch (_) { return { title: 'JOBdashboard · 求职进度看板', search_sources: { web_enabled: true } }; }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

function localISODate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + sign + hh + ':' + mm;
}

function cleanText(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeSegment(value, fallback) {
  const cleaned = cleanText(value, 120).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

function appendObjectRow(filePath, obj) {
  const { header, dataRows } = readCSVRows(filePath);
  dataRows.push(header.map(col => obj[col] == null ? '' : String(obj[col])));
  writeCSVRows(filePath, header, dataRows);
}

function rowObject(header, row) {
  const obj = {};
  header.forEach((col, i) => { obj[col] = row[i] || ''; });
  return obj;
}

function setColumn(header, row, column, value) {
  const index = header.indexOf(column);
  if (index === -1) throw new Error('Missing column: ' + column);
  row[index] = value;
}

function markJobSubmitted(header, row, resumeUsed) {
  setColumn(header, row, 'status', 'Submitted');
  setColumn(header, row, 'current_stage', '已投递，等待中');
  setColumn(header, row, 'blocker', '');
  setColumn(header, row, 'next_action', '等待招聘方反馈；有新进展时添加日程');
  if (resumeUsed) setColumn(header, row, 'resume_variant', cleanText(resumeUsed, 1000));
}

function resolveSubmissionBlockers(company, jobTitle) {
  if (!fs.existsSync(BLOCKER_QUEUE_PATH)) return 0;
  const blockers = readCSVRows(BLOCKER_QUEUE_PATH);
  let changed = 0;
  for (const row of blockers.dataRows) {
    const obj = rowObject(blockers.header, row);
    if (obj.company !== company || obj.job_title !== jobTitle || obj.status === 'resolved') continue;
    setColumn(blockers.header, row, 'status', 'resolved');
    setColumn(blockers.header, row, 'what_happened', '用户已确认完成投递，看板已同步为已投递。');
    setColumn(blockers.header, row, 'why_blocked', '已解决。');
    setColumn(blockers.header, row, 'next_retry_strategy', '无需重试。');
    setColumn(blockers.header, row, 'user_action_needed', '等待招聘方反馈。');
    changed++;
  }
  if (changed) writeCSVRows(BLOCKER_QUEUE_PATH, blockers.header, blockers.dataRows);
  return changed;
}

function reconcileSubmittedState() {
  if (!fs.existsSync(APPLICATION_LOG_PATH) || !fs.existsSync(JOB_POOL_PATH)) return 0;
  const applicationLog = readCSVRows(APPLICATION_LOG_PATH);
  const submitted = new Map();
  for (const row of applicationLog.dataRows) {
    const obj = rowObject(applicationLog.header, row);
    if (obj.status === 'Submitted') submitted.set(obj.company + '\u0000' + obj.job_title, obj);
  }

  const pool = readCSVRows(JOB_POOL_PATH);
  let changed = 0;
  for (const row of pool.dataRows) {
    const obj = rowObject(pool.header, row);
    const log = submitted.get(obj.company + '\u0000' + obj.job_title);
    if (!log) continue;
    if (['Pending', 'Needs user', 'Ready to submit', 'Blocked'].includes(obj.status)) {
      markJobSubmitted(pool.header, row, log.resume_used);
      changed++;
    }
    resolveSubmissionBlockers(obj.company, obj.job_title);
  }
  if (changed) writeCSVRows(JOB_POOL_PATH, pool.header, pool.dataRows);
  return changed;
}

function logActivity(action, company, jobTitle, details) {
  appendObjectRow(ACTIVITY_LOG_PATH, {
    timestamp: timestamp(), action, company: company || '', job_title: jobTitle || '', details: details || '',
  });
}

function submittedJobs() {
  const pool = readCSVRows(JOB_POOL_PATH);
  return pool.dataRows.map((row, rowIndex) => ({ ...rowObject(pool.header, row), rowIndex }))
    .filter(job => job.status === 'Submitted');
}

function appendEmailCalendarEvent(event) {
  const pool = readCSVRows(JOB_POOL_PATH);
  const jobIndex = pool.dataRows.findIndex(row => {
    const obj = rowObject(pool.header, row);
    return obj.status === 'Submitted' && obj.company === event.company && obj.job_title === event.job_title;
  });
  if (jobIndex < 0) return { added: false, reason: 'job_not_submitted' };

  const followUp = readCSVRows(FOLLOW_UP_PATH);
  const duplicate = followUp.dataRows.map(row => rowObject(followUp.header, row)).some(item =>
    item.company === event.company && item.job_title === event.job_title &&
    item.date === event.date && item.time === event.time && item.event_type === event.event_type
  );
  if (duplicate) return { added: false, reason: 'duplicate' };

  const row = new Array(followUp.header.length).fill('');
  const values = {
    date: event.date,
    company: event.company,
    job_title: event.job_title,
    contact: '',
    channel: '邮箱自动检索',
    event_type: event.event_type,
    deadline: event.date + ' ' + event.time,
    next_action: '按邮件要求完成' + event.event_type,
    status: 'Scheduled',
    notes: event.notes || '由邮箱提醒模块自动识别；请以原邮件内容为准。',
    time: event.time || '待确认',
  };
  followUp.header.forEach((col, index) => { row[index] = values[col] || ''; });
  followUp.dataRows.push(row);

  setColumn(pool.header, pool.dataRows[jobIndex], 'current_stage', event.event_type + '：' + event.date + ' ' + event.time);
  setColumn(pool.header, pool.dataRows[jobIndex], 'next_action', '查看招聘邮件并按时完成' + event.event_type);
  writeCSVRows(FOLLOW_UP_PATH, followUp.header, followUp.dataRows);
  writeCSVRows(JOB_POOL_PATH, pool.header, pool.dataRows);
  logActivity('Email event scheduled', event.company, event.job_title, event.event_type + ' · ' + event.date + ' ' + event.time);
  return { added: true };
}

let emailScanPromise = null;

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

async function handleUpdateStatus(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { rowIndex, company, job_title, status } = payload || {};
  if (!['Offer', 'Rejected'].includes(status)) {
    return sendJSON(res, 400, { ok: false, error: 'status must be Offer or Rejected' });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'rowIndex must be a non-negative integer' });
  }

  let header, dataRows;
  try {
    ({ header, dataRows } = readCSVRows(JOB_POOL_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read job_pool.csv: ' + e.message });
  }

  const companyCol = header.indexOf('company');
  const titleCol = header.indexOf('job_title');
  const statusCol = header.indexOf('status');

  if (statusCol === -1 || companyCol === -1 || titleCol === -1) {
    return sendJSON(res, 500, { ok: false, error: 'job_pool.csv is missing an expected column' });
  }
  if (rowIndex >= dataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'rowIndex out of range — the file may have changed, please refresh' });
  }

  const target = dataRows[rowIndex];
  // job_pool.csv may have been rewritten (e.g. by the agent) between page
  // load and this click, which would shift row positions — confirm the row
  // at this index is still the same job before overwriting its status.
  if (target[companyCol] !== company || target[titleCol] !== job_title) {
    return sendJSON(res, 409, { ok: false, error: 'This row no longer matches — the dashboard data changed, please refresh and try again' });
  }

  target[statusCol] = status;

  try {
    writeCSVRows(JOB_POOL_PATH, header, dataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write job_pool.csv: ' + e.message });
  }

  sendJSON(res, 200, { ok: true });
}

// Locate + verify a job_pool.csv row by index, checking it still matches the
// company/job_title the client last saw (same staleness guard as above).
// Returns { header, dataRows, companyCol, titleCol, stageCol, target } or
// throws an Error with an httpStatus property for the caller to relay.
function locateJobRow(jobRowIndex, company, job_title) {
  if (!Number.isInteger(jobRowIndex) || jobRowIndex < 0) {
    const e = new Error('jobRowIndex must be a non-negative integer'); e.httpStatus = 400; throw e;
  }
  let header, dataRows;
  try {
    ({ header, dataRows } = readCSVRows(JOB_POOL_PATH));
  } catch (err) {
    const e = new Error('Could not read job_pool.csv: ' + err.message); e.httpStatus = 500; throw e;
  }
  const companyCol = header.indexOf('company');
  const titleCol = header.indexOf('job_title');
  const statusCol = header.indexOf('status');
  const stageCol = header.indexOf('current_stage');
  if ([companyCol, titleCol, statusCol, stageCol].includes(-1)) {
    const e = new Error('job_pool.csv is missing an expected column (company/job_title/status/current_stage)'); e.httpStatus = 500; throw e;
  }
  if (jobRowIndex >= dataRows.length) {
    const e = new Error('jobRowIndex out of range — the file may have changed, please refresh'); e.httpStatus = 409; throw e;
  }
  const target = dataRows[jobRowIndex];
  if (target[companyCol] !== company || target[titleCol] !== job_title) {
    const e = new Error('This job row no longer matches — the dashboard data changed, please refresh and try again'); e.httpStatus = 409; throw e;
  }
  if (target[statusCol] !== 'Submitted') {
    const e = new Error('This job is not in the Submitted/Applied bucket — calendar events are only for already-applied jobs'); e.httpStatus = 409; throw e;
  }
  return { header, dataRows, statusCol, stageCol, target };
}

async function handleCalendarAdd(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { jobRowIndex, company, job_title, date, time, event_type } = payload || {};
  if (!DATE_RE.test(date)) return sendJSON(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' });
  if (!TIME_RE.test(time)) return sendJSON(res, 400, { ok: false, error: 'time must be HH:MM' });
  if (typeof event_type !== 'string' || !event_type.trim()) {
    return sendJSON(res, 400, { ok: false, error: 'event_type is required' });
  }

  let jobRow;
  try {
    jobRow = locateJobRow(jobRowIndex, company, job_title);
  } catch (e) {
    return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message });
  }

  // current_stage is the event content verbatim — no auto-suffix. Every
  // company's process reads differently, so don't guess a shared phrasing
  // convention on top of what the user typed.
  const stage = event_type.trim();
  jobRow.target[jobRow.stageCol] = stage;

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  const cols = ['date', 'company', 'job_title', 'contact', 'channel', 'event_type', 'deadline', 'next_action', 'status', 'notes', 'time'];
  if (cols.some(c => fuHeader.indexOf(c) === -1)) {
    return sendJSON(res, 500, { ok: false, error: 'follow_up.csv is missing an expected column' });
  }
  const newRow = new Array(fuHeader.length).fill('');
  newRow[fuHeader.indexOf('date')] = date;
  newRow[fuHeader.indexOf('company')] = company;
  newRow[fuHeader.indexOf('job_title')] = job_title;
  newRow[fuHeader.indexOf('event_type')] = event_type.trim();
  newRow[fuHeader.indexOf('status')] = 'Scheduled';
  newRow[fuHeader.indexOf('time')] = time;
  fuDataRows.push(newRow);
  const followUpRowIndex = fuDataRows.length - 1;

  try {
    writeCSVRows(JOB_POOL_PATH, jobRow.header, jobRow.dataRows);
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write dashboard files: ' + e.message });
  }

  sendJSON(res, 200, { ok: true, followUpRowIndex, current_stage: stage });
}

async function handleCalendarUpdate(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { followUpRowIndex, jobRowIndex, company, job_title, date, time, event_type } = payload || {};
  if (!Number.isInteger(followUpRowIndex) || followUpRowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'followUpRowIndex must be a non-negative integer' });
  }
  if (!DATE_RE.test(date)) return sendJSON(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' });
  if (!TIME_RE.test(time)) return sendJSON(res, 400, { ok: false, error: 'time must be HH:MM' });
  if (typeof event_type !== 'string' || !event_type.trim()) {
    return sendJSON(res, 400, { ok: false, error: 'event_type is required' });
  }

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  const fuCompanyCol = fuHeader.indexOf('company');
  const fuTitleCol = fuHeader.indexOf('job_title');
  if (followUpRowIndex >= fuDataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer exists — the calendar may have changed, please refresh' });
  }
  const fuTarget = fuDataRows[followUpRowIndex];
  if (fuTarget[fuCompanyCol] !== company || fuTarget[fuTitleCol] !== job_title) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer matches — the calendar may have changed, please refresh' });
  }

  let jobRow;
  try {
    jobRow = locateJobRow(jobRowIndex, company, job_title);
  } catch (e) {
    return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message });
  }

  fuTarget[fuHeader.indexOf('date')] = date;
  fuTarget[fuHeader.indexOf('time')] = time;
  fuTarget[fuHeader.indexOf('event_type')] = event_type.trim();

  // Same rule as add: current_stage is the event content verbatim.
  const stage = event_type.trim();
  jobRow.target[jobRow.stageCol] = stage;

  try {
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
    writeCSVRows(JOB_POOL_PATH, jobRow.header, jobRow.dataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write dashboard files: ' + e.message });
  }

  sendJSON(res, 200, { ok: true, current_stage: stage });
}

async function handleCalendarDelete(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { followUpRowIndex, company, job_title, event_type, date, time } = payload || {};
  if (!Number.isInteger(followUpRowIndex) || followUpRowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'followUpRowIndex must be a non-negative integer' });
  }

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  if (followUpRowIndex >= fuDataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer exists — the calendar may have changed, please refresh' });
  }
  const fuTarget = fuDataRows[followUpRowIndex];
  const matches = (col, val) => fuTarget[fuHeader.indexOf(col)] === val;
  if (!matches('company', company) || !matches('job_title', job_title) || !matches('event_type', event_type) || !matches('date', date) || !matches('time', time)) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer matches — the calendar may have changed, please refresh' });
  }

  fuDataRows.splice(followUpRowIndex, 1);

  try {
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write follow_up.csv: ' + e.message });
  }

  // Deliberately does not revert job_pool.csv's current_stage — there's no
  // reliable "previous stage" to roll back to. Edit the stage manually if
  // deleting this event should also change what's shown on the job card.
  sendJSON(res, 200, { ok: true });
}

function validHttpUrl(value) {
  if (!value) return true;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function handleAddSource(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }

  const sourceType = cleanText(payload && payload.source_type, 40);
  const name = cleanText(payload && payload.name, 160);
  const url = cleanText(payload && payload.url, 1000);
  const notes = cleanText(payload && payload.notes);
  if (!['公众号', '在线文档', '网站/其他'].includes(sourceType)) {
    return sendJSON(res, 400, { ok: false, error: '请选择有效的来源类型' });
  }
  if (!name) return sendJSON(res, 400, { ok: false, error: '来源名称不能为空' });
  if (sourceType === '在线文档' && !url) return sendJSON(res, 400, { ok: false, error: '在线文档需要填写链接' });
  if (!validHttpUrl(url)) return sendJSON(res, 400, { ok: false, error: '链接必须是 http:// 或 https:// 地址' });

  const { header, dataRows } = readCSVRows(LEAD_SOURCES_PATH);
  const duplicate = dataRows.map(r => rowObject(header, r)).some(r =>
    (url && r.url === url) || (!url && r.source_type === sourceType && r.name.toLowerCase() === name.toLowerCase())
  );
  if (duplicate) return sendJSON(res, 409, { ok: false, error: '这个来源已经在工作池中' });
  dataRows.push(header.map(col => ({
    date_added: localISODate(), source_type: sourceType, name, url, notes,
    status: 'Active', last_checked: '', next_action: '等待搜索/解析', enabled: 'Yes',
  })[col] || ''));
  writeCSVRows(LEAD_SOURCES_PATH, header, dataRows);
  logActivity('Add source', '', '', sourceType + ' · ' + name);
  sendJSON(res, 200, { ok: true });
}

function sourceSearchStatus() {
  const settings = readSettings();
  const sourceRows = readCSVRows(LEAD_SOURCES_PATH);
  const sources = sourceRows.dataRows.map((row, rowIndex) => ({
    ...rowObject(sourceRows.header, row), rowIndex,
  }));
  const activeSources = sources.filter(source => source.status !== 'Archived');
  const webDefault = activeSources.length === 0;
  const webEnabled = webDefault ? true : (settings.search_sources && settings.search_sources.web_enabled !== undefined
    ? settings.search_sources.web_enabled !== false
    : true);
  return {
    ok: true,
    web_enabled: webEnabled,
    web_default: webDefault,
    has_custom_sources: activeSources.length > 0,
    sources: activeSources,
  };
}

async function handleSourceToggle(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const enabled = payload && typeof payload.enabled === 'boolean' ? payload.enabled : null;
  if (enabled === null) return sendJSON(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
  if (payload.kind === 'web') {
    if (!sourceSearchStatus().has_custom_sources && !enabled) {
      return sendJSON(res, 400, { ok: false, error: '没有其它来源池时，全网搜索默认保持启用' });
    }
    const settings = readSettings();
    settings.search_sources ||= {};
    settings.search_sources.web_enabled = enabled;
    writeSettings(settings);
    logActivity('Toggle search source', '', '', '全网搜索 · ' + (enabled ? '启用' : '停用'));
    return sendJSON(res, 200, sourceSearchStatus());
  }

  const rowIndex = Number(payload.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) return sendJSON(res, 400, { ok: false, error: '来源记录位置无效' });
  const result = readCSVRows(LEAD_SOURCES_PATH);
  if (rowIndex >= result.dataRows.length) return sendJSON(res, 409, { ok: false, error: '来源记录已变化，请刷新看板' });
  const target = rowObject(result.header, result.dataRows[rowIndex]);
  if (target.name !== cleanText(payload.name, 160) || target.url !== cleanText(payload.url, 1000)) {
    return sendJSON(res, 409, { ok: false, error: '来源记录已变化，请刷新看板' });
  }
  const enabledIndex = result.header.indexOf('enabled');
  if (enabledIndex < 0) return sendJSON(res, 500, { ok: false, error: '来源池缺少 enabled 字段，请重启看板迁移数据' });
  result.dataRows[rowIndex][enabledIndex] = enabled ? 'Yes' : 'No';
  writeCSVRows(LEAD_SOURCES_PATH, result.header, result.dataRows);
  logActivity('Toggle search source', '', '', target.name + ' · ' + (enabled ? '启用' : '停用'));
  sendJSON(res, 200, sourceSearchStatus());
}

async function handleAddResumeRequest(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }

  const company = cleanText(payload && payload.company, 160);
  const jobTitle = cleanText(payload && payload.job_title, 240);
  const jobUrl = cleanText(payload && payload.job_url, 1000);
  let templateId = cleanText(payload && payload.template_id, 80);
  const notes = cleanText(payload && payload.notes);
  if (!company || !jobTitle) return sendJSON(res, 400, { ok: false, error: '公司和岗位不能为空' });
  if (!validHttpUrl(jobUrl)) return sendJSON(res, 400, { ok: false, error: '岗位链接格式无效' });

  const templates = readCSVRows(RESUME_TEMPLATES_PATH);
  const templateRows = templates.dataRows.map(r => rowObject(templates.header, r));
  if (!templateId) {
    const defaultTemplate = templateRows.find(r => r.is_default === 'Yes') || templateRows[0];
    templateId = defaultTemplate ? defaultTemplate.template_id : '';
  }
  const templateExists = templateRows.some(r => r.template_id === templateId);
  if (!templateExists) return sendJSON(res, 400, { ok: false, error: '所选简历模板不存在' });

  const { header, dataRows } = readCSVRows(RESUME_REQUESTS_PATH);
  const existing = dataRows.map(r => rowObject(header, r)).find(r =>
    r.company === company && r.job_title === jobTitle && ['Queued', 'Generating', 'Generated'].includes(r.status)
  );
  if (existing) return sendJSON(res, 409, { ok: false, error: '这个岗位已有未完成或已生成的岗位简历任务' });

  const companyDir = path.join(TAILORED_RESUME_ROOT, safeSegment(company, '未分类公司'));
  fs.mkdirSync(companyDir, { recursive: true });
  dataRows.push(header.map(col => ({
    request_date: localISODate(), company, job_title: jobTitle, job_url: jobUrl,
    template_id: templateId, status: 'Queued', output_directory: companyDir,
    output_file: '', notes: notes || '根据真实经历和岗位 JD 定制；文件名不得含公司名。',
  })[col] || ''));
  writeCSVRows(RESUME_REQUESTS_PATH, header, dataRows);
  logActivity('Queue tailored resume', company, jobTitle, 'Template: ' + templateId);
  sendJSON(res, 200, { ok: true, output_directory: companyDir });
}

function locateAnyJobRow(rowIndex, company, jobTitle) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    const e = new Error('rowIndex 必须是非负整数'); e.httpStatus = 400; throw e;
  }
  const result = readCSVRows(JOB_POOL_PATH);
  if (rowIndex >= result.dataRows.length) {
    const e = new Error('记录位置已经变化，请刷新后重试'); e.httpStatus = 409; throw e;
  }
  const obj = rowObject(result.header, result.dataRows[rowIndex]);
  if (obj.company !== company || obj.job_title !== jobTitle) {
    const e = new Error('岗位记录已经变化，请刷新后重试'); e.httpStatus = 409; throw e;
  }
  return { ...result, target: result.dataRows[rowIndex], obj };
}

function validateGeneratedResumeForJob(job) {
  const requests = readCSVRows(RESUME_REQUESTS_PATH);
  const matches = requests.dataRows.map(r => rowObject(requests.header, r)).filter(r =>
    r.company === job.company && r.job_title === job.job_title && r.status === 'Generated'
  );
  if (matches.length !== 1) {
    return { ok: false, error: matches.length
      ? '该岗位存在多个已生成简历记录，请先保留唯一对应版本'
      : '该岗位尚无已生成的对应简历，不能进入待确认投递' };
  }

  const outputFile = path.resolve(matches[0].output_file || '');
  const companyDir = path.resolve(TAILORED_RESUME_ROOT, safeSegment(job.company, '未分类公司'));
  const expectedName = safeSegment('Candidate-' + job.job_title, 'Candidate-岗位简历') + '.pdf';
  if (!outputFile.toLowerCase().endsWith('.pdf') || !fs.existsSync(outputFile)) {
    return { ok: false, error: '岗位简历PDF不存在，请先重新生成并核验文件' };
  }
  if (path.dirname(outputFile).toLowerCase() !== companyDir.toLowerCase()) {
    return { ok: false, error: '岗位简历不在对应公司文件夹中，请检查简历映射' };
  }
  if (path.basename(outputFile) !== expectedName) {
    return { ok: false, error: '岗位简历文件名与“姓名-完整岗位名称”规则不一致' };
  }
  if (job.resume_variant !== path.basename(outputFile)) {
    return { ok: false, error: '看板记录的已上传附件名与岗位简历不一致，请先核对招聘页面文件名' };
  }
  return { ok: true, outputFile };
}

async function handleMarkReady(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  let job;
  try { job = locateAnyJobRow(payload.rowIndex, payload.company, payload.job_title); }
  catch (e) { return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message }); }
  if (!['Pending', 'Needs user', 'Ready to submit'].includes(job.obj.status)) {
    return sendJSON(res, 409, { ok: false, error: '只有未投递岗位可以进入待最终确认队列' });
  }
  const resumeCheck = validateGeneratedResumeForJob(job.obj);
  if (!resumeCheck.ok) return sendJSON(res, 409, { ok: false, error: resumeCheck.error });
  setColumn(job.header, job.target, 'status', 'Ready to submit');
  setColumn(job.header, job.target, 'current_stage', 'Final review — waiting for manual confirmation');
  setColumn(job.header, job.target, 'next_action', '保留在待最终确认队列；继续处理其他岗位，等待用户明确确认后再点击提交');
  writeCSVRows(JOB_POOL_PATH, job.header, job.dataRows);
  logActivity('Ready to submit', job.obj.company, job.obj.job_title, 'Final submit remains manual');
  sendJSON(res, 200, { ok: true });
}

function appendSubmissionLog(job, payload, sourceLabel) {
  appendObjectRow(APPLICATION_LOG_PATH, {
    attempt_date: payload.applied_date || localISODate(),
    company: job.company,
    job_title: job.job_title,
    job_url: job.job_url || payload.job_url || '',
    platform: cleanText(payload.platform, 120) || '用户手动投递',
    status: 'Submitted',
    submission_evidence: cleanText(payload.evidence) || sourceLabel,
    resume_used: cleanText(payload.resume_used, 1000),
    answers_used: cleanText(payload.answers_used),
    confirmation_url: cleanText(payload.confirmation_url, 1000),
    confirmation_text: cleanText(payload.confirmation_text),
    job_description: cleanText(payload.job_description, 20000),
    notes: cleanText(payload.notes) || sourceLabel,
  });
}

async function handleManualSubmit(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  if (payload.applied_date && !DATE_RE.test(payload.applied_date)) {
    return sendJSON(res, 400, { ok: false, error: '投递日期必须是 YYYY-MM-DD' });
  }
  let job;
  try { job = locateAnyJobRow(payload.rowIndex, payload.company, payload.job_title); }
  catch (e) { return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message }); }
  if (job.obj.status === 'Submitted') return sendJSON(res, 409, { ok: false, error: '该岗位已经是已投递状态' });
  if (['Offer', 'Rejected', 'Skipped'].includes(job.obj.status)) {
    return sendJSON(res, 409, { ok: false, error: '该岗位当前状态不能直接确认投递' });
  }
  markJobSubmitted(job.header, job.target, payload.resume_used);
  writeCSVRows(JOB_POOL_PATH, job.header, job.dataRows);
  appendSubmissionLog(job.obj, payload, '用户在看板中手动确认已完成投递');
  resolveSubmissionBlockers(job.obj.company, job.obj.job_title);
  logActivity('Manual submission confirmation', job.obj.company, job.obj.job_title, cleanText(payload.evidence) || 'User confirmed');
  sendJSON(res, 200, { ok: true });
}

async function handleImportSubmitted(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const company = cleanText(payload.company, 160);
  const jobTitle = cleanText(payload.job_title, 240);
  const jobUrl = cleanText(payload.job_url, 1000);
  if (!company || !jobTitle) return sendJSON(res, 400, { ok: false, error: '公司和岗位不能为空' });
  if (payload.applied_date && !DATE_RE.test(payload.applied_date)) return sendJSON(res, 400, { ok: false, error: '投递日期格式无效' });
  if (!validHttpUrl(jobUrl)) return sendJSON(res, 400, { ok: false, error: '岗位链接格式无效' });

  const pool = readCSVRows(JOB_POOL_PATH);
  const objects = pool.dataRows.map(r => rowObject(pool.header, r));
  let index = objects.findIndex(r => (jobUrl && r.job_url === jobUrl) || (r.company === company && r.job_title === jobTitle));
  if (index >= 0 && objects[index].status === 'Submitted') {
    return sendJSON(res, 409, { ok: false, error: '该岗位已经存在于已投递中' });
  }
  let job;
  if (index >= 0) {
    const target = pool.dataRows[index];
    markJobSubmitted(pool.header, target, payload.resume_used);
    job = { ...objects[index], company, job_title: jobTitle, job_url: jobUrl || objects[index].job_url };
  } else {
    job = {
      date_found: payload.applied_date || localISODate(), company, job_title: jobTitle,
      role_family: cleanText(payload.role_family, 160), level: cleanText(payload.level, 120),
      location: cleanText(payload.location, 160), remote_policy: '', source: '用户导入已投递', job_url: jobUrl,
      posted_date: '', priority: 'Imported', status: 'Submitted', resume_variant: cleanText(payload.resume_used, 1000),
      skip_reason: '', blocker: '', next_action: '等待招聘方反馈；有新进展时添加日程',
      notes: cleanText(payload.notes) || '用户自行完成投递后导入看板', cohort_match_status: 'Unclear', current_stage: '已投递，等待中',
    };
    pool.dataRows.push(pool.header.map(col => job[col] || ''));
  }
  writeCSVRows(JOB_POOL_PATH, pool.header, pool.dataRows);
  appendSubmissionLog(job, payload, '用户导入已完成投递（未经工具自动核验）');
  resolveSubmissionBlockers(company, jobTitle);
  logActivity('Import submitted job', company, jobTitle, jobUrl || 'No URL');
  sendJSON(res, 200, { ok: true });
}

async function handleUpdateSettings(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const title = cleanText(payload && payload.title, 100);
  if (!title) return sendJSON(res, 400, { ok: false, error: '看板标题不能为空' });
  const settings = readSettings();
  settings.title = title;
  settings.search_sources ||= { web_enabled: true };
  writeSettings(settings);
  logActivity('Update dashboard title', '', '', title);
  sendJSON(res, 200, { ok: true, title });
}

function emailStatus() {
  const config = emailMonitor.readJSON(EMAIL_CONFIG_PATH, {});
  const state = emailMonitor.readJSON(EMAIL_STATE_PATH, { pending: {}, scheduled: {} });
  return {
    ok: true,
    ...emailMonitor.publicConfig(config),
    last_scan: state.last_scan || '',
    last_error: state.last_error || '',
    scanned_count: state.scanned_count || 0,
    review_count: Object.keys(state.pending || {}).length,
    scheduled_count: Object.keys(state.scheduled || {}).length,
    pending: Object.values(state.pending || {}).sort((a, b) => (b.received_at || '').localeCompare(a.received_at || '')).slice(0, 50),
  };
}

async function handleEmailConfig(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const previous = emailMonitor.readJSON(EMAIL_CONFIG_PATH, {});
  const config = emailMonitor.resolveConfig(payload || {}, previous);
  if (!config.email || !config.host || !config.port) {
    return sendJSON(res, 400, { ok: false, error: '邮箱、IMAP服务器和端口不能为空' });
  }
  if (!config.auth_code) {
    return sendJSON(res, 400, { ok: false, error: '首次配置必须填写IMAP授权码或应用密码' });
  }
  emailMonitor.writeJSON(EMAIL_CONFIG_PATH, config);
  logActivity('Update email monitor', '', '', config.provider + ' · ' + config.host);
  sendJSON(res, 200, { ok: true, ...emailMonitor.publicConfig(config) });
}

async function handleEmailScan(req, res) {
  const config = emailMonitor.readJSON(EMAIL_CONFIG_PATH, {});
  if (!emailMonitor.publicConfig(config).configured) {
    return sendJSON(res, 200, { ok: true, configured: false, added: 0, review_count: 0, scanned: 0 });
  }
  try {
    if (!emailScanPromise) {
      emailScanPromise = emailMonitor.scanMailbox({
        configPath: EMAIL_CONFIG_PATH,
        statePath: EMAIL_STATE_PATH,
        jobs: submittedJobs(),
        scheduleEvent: appendEmailCalendarEvent,
      }).finally(() => { emailScanPromise = null; });
    }
    const result = await emailScanPromise;
    sendJSON(res, 200, result);
  } catch (e) {
    sendJSON(res, 502, { ok: false, configured: true, error: '邮箱检索失败：' + e.message });
  }
}

async function handleEmailReviewDismiss(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const key = cleanText(payload && payload.key, 64);
  const state = emailMonitor.readJSON(EMAIL_STATE_PATH, { pending: {}, ignored: {} });
  const item = state.pending && state.pending[key];
  if (!key || !item) return sendJSON(res, 404, { ok: false, error: '待确认邮件不存在或已处理' });
  state.ignored ||= {};
  state.ignored[key] = { ...item, dismissed_at: timestamp() };
  delete state.pending[key];
  emailMonitor.writeJSON(EMAIL_STATE_PATH, state);
  sendJSON(res, 200, { ok: true });
}

function localTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function handleEmailReviewSchedule(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const key = cleanText(payload && payload.key, 64);
  const requestedDate = cleanText(payload && payload.date, 10);
  const state = emailMonitor.readJSON(EMAIL_STATE_PATH, { pending: {}, scheduled: {} });
  const item = state.pending && state.pending[key];
  if (!key || !item) return sendJSON(res, 404, { ok: false, error: '待确认邮件不存在或已处理' });
  if (!['测评', '笔试', '测评截止', '笔试截止'].includes(item.event_type)) {
    return sendJSON(res, 400, { ok: false, error: '只有测评或笔试提醒支持选择日期加入日程' });
  }
  if (!DATE_RE.test(requestedDate)) return sendJSON(res, 400, { ok: false, error: '请选择有效日期' });
  if (!item.date_max) return sendJSON(res, 400, { ok: false, error: '邮件中未识别到测评时限，不能安全限制可选日期' });
  if (item.date_min && requestedDate < item.date_min) return sendJSON(res, 400, { ok: false, error: '日期不能早于测评发放日' });
  if (requestedDate > item.date_max) return sendJSON(res, 400, { ok: false, error: '日期不能晚于测评截止日' });

  const company = cleanText(payload.company, 160) || item.company;
  const jobTitle = cleanText(payload.job_title, 240) || item.job_title;
  if (!company || !jobTitle) return sendJSON(res, 409, { ok: false, error: '该邮件尚未匹配到已投递岗位，请先补选公司和岗位' });
  const event = {
    ...item,
    company,
    job_title: jobTitle,
    date: requestedDate,
    time: /^\d{2}:\d{2}$/.test(item.deadline_time || item.time || '') ? (item.deadline_time || item.time) : '23:59',
    event_type: item.event_type || '测评',
    notes: '由用户从邮箱提醒选择日期加入；请以原邮件内容为准。',
  };
  const scheduled = appendEmailCalendarEvent(event);
  if (!scheduled.added && scheduled.reason !== 'duplicate') {
    return sendJSON(res, 409, { ok: false, error: scheduled.reason === 'job_not_submitted' ? '对应岗位不在已投递中' : '日程已存在或无法写入' });
  }
  state.scheduled ||= {};
  state.scheduled[key] = { ...item, ...event, scheduled_at: timestamp(), manual_action: 'schedule' };
  delete state.pending[key];
  emailMonitor.writeJSON(EMAIL_STATE_PATH, state);
  sendJSON(res, 200, { ok: true, added: scheduled.added, date: requestedDate });
}

async function handleEmailReviewComplete(req, res) {
  let payload;
  try { payload = await readJSONBody(req); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const key = cleanText(payload && payload.key, 64);
  const state = emailMonitor.readJSON(EMAIL_STATE_PATH, { pending: {}, scheduled: {} });
  const item = state.pending && state.pending[key];
  if (!key || !item) return sendJSON(res, 404, { ok: false, error: '待确认邮件不存在或已处理' });
  if (!['测评', '笔试', '测评截止', '笔试截止'].includes(item.event_type)) {
    return sendJSON(res, 400, { ok: false, error: '只有测评或笔试提醒支持标记已完成' });
  }
  const company = cleanText(payload.company, 160) || item.company;
  const jobTitle = cleanText(payload.job_title, 240) || item.job_title;
  if (!company || !jobTitle) return sendJSON(res, 409, { ok: false, error: '该邮件尚未匹配到已投递岗位，请先补选公司和岗位' });
  const event = {
    ...item,
    company,
    job_title: jobTitle,
    date: localISODate(),
    time: localTime(),
    event_type: (item.event_type || '测评').replace(/截止/g, '') + '（已完成）',
    notes: '由用户从邮箱提醒标记为已完成；完成日期为今天。',
  };
  const scheduled = appendEmailCalendarEvent(event);
  if (!scheduled.added && scheduled.reason !== 'duplicate') {
    return sendJSON(res, 409, { ok: false, error: scheduled.reason === 'job_not_submitted' ? '对应岗位不在已投递中' : '日程无法写入' });
  }
  state.scheduled ||= {};
  state.scheduled[key] = { ...item, ...event, scheduled_at: timestamp(), manual_action: 'completed' };
  delete state.pending[key];
  emailMonitor.writeJSON(EMAIL_STATE_PATH, state);
  sendJSON(res, 200, { ok: true, added: scheduled.added, date: event.date });
}

const ROUTES = {
  '/api/update-status': handleUpdateStatus,
  '/api/calendar/add': handleCalendarAdd,
  '/api/calendar/update': handleCalendarUpdate,
  '/api/calendar/delete': handleCalendarDelete,
  '/api/sources/add': handleAddSource,
  '/api/sources/toggle': handleSourceToggle,
  '/api/resume-requests/add': handleAddResumeRequest,
  '/api/jobs/ready': handleMarkReady,
  '/api/jobs/manual-submit': handleManualSubmit,
  '/api/jobs/import-submitted': handleImportSubmitted,
  '/api/settings': handleUpdateSettings,
  '/api/email/config': handleEmailConfig,
  '/api/email/scan': handleEmailScan,
  '/api/email/review/dismiss': handleEmailReviewDismiss,
  '/api/email/review/schedule': handleEmailReviewSchedule,
  '/api/email/review/complete': handleEmailReviewComplete,
};

ensureDataFiles();
reconcileSubmittedState();

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && ROUTES[urlPath]) {
    Promise.resolve(ROUTES[urlPath](req, res)).catch(err => {
      console.error(err);
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '本地看板写入失败：' + err.message });
      else res.end();
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/settings') {
    try {
      return sendJSON(res, 200, { ok: true, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: '无法读取看板设置：' + e.message });
    }
  }

  if (req.method === 'GET' && urlPath === '/api/email/status') {
    return sendJSON(res, 200, emailStatus());
  }

  if (req.method === 'GET' && urlPath === '/api/sources/status') {
    try { return sendJSON(res, 200, sourceSearchStatus()); }
    catch (e) { return sendJSON(res, 500, { ok: false, error: '无法读取搜索来源：' + e.message }); }
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  const servedPath = urlPath === '/' ? '/dashboard.html' : urlPath;
  const filePath = path.resolve(ROOT, '.' + servedPath);

  // Prevent escaping the dashboard folder.
  if (path.relative(ROOT, filePath).startsWith('..') || path.isAbsolute(path.relative(ROOT, filePath))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const relativePath = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (relativePath === 'email_config.local.json' || relativePath === 'email_state.local.json' || relativePath.startsWith('node_modules/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
});

// Bind to localhost only — this server can now write to job_pool.csv, so it
// shouldn't be reachable from other devices on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log('Dashboard running / 仪表盘已启动: http://localhost:' + PORT + '/dashboard.html');
  console.log('Keep this window open to keep serving; close it or press Ctrl+C to stop.');
  console.log('保持这个窗口开着；关掉窗口或按 Ctrl+C 即可停止服务。');
});
