'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PROVIDERS = {
  qq: { host: 'imap.qq.com', port: 993, secure: true },
  '163': { host: 'imap.163.com', port: 993, secure: true },
  '126': { host: 'imap.126.com', port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
};

const EVENT_PATTERNS = [
  { type: '面试', re: /(面试邀请|面试安排|参加面试|邀.{0,8}面试|interview invitation|interview schedule|schedule.{0,20}interview)/i },
  { type: '笔试', re: /(笔试邀请|笔试安排|参加笔试|在线笔试|written test|coding test)/i },
  { type: '测评', re: /(测评邀请|测评通知|在线测评|人才测评|职业测评|assessment invitation|online assessment|complete.{0,20}assessment)/i },
];

const COMPANY_SUFFIXES = /(股份有限公司|有限责任公司|有限公司|集团股份|集团|科技股份|控股|中国|公司)/g;
const WEAK_ALIASES = new Set(['中国', '集团', '科技', '股份', '有限', '公司', '股份有限公司', '有限责任公司', '科技股份', '集团股份', '招聘', '校园', 'campus', 'career', 'careers']);
const LOCATION_PREFIX = /^(北京|上海|天津|重庆|南京|苏州|无锡|常州|南通|宁波|杭州|绍兴|温州|嘉兴|金华|台州|江苏|浙江|广东|深圳|广州|合肥|武汉|成都|西安|济南|青岛|厦门|福州|长沙)/;
const INDUSTRY_SUFFIX = /(科技|技术|电子|能源|光学|电气|机电工具|机电|智能|股份)+$/;

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJSON(filePath, value) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
}

function compactPreview(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function companyAliases(company, configuredAliases = {}) {
  const raw = String(company || '').trim();
  const values = new Set([raw]);
  raw.split(/[\s\/·（）()｜|]+/).forEach(v => values.add(v.trim()));
  const core = raw.replace(COMPANY_SUFFIXES, '').replace(/[（）()]/g, '').trim();
  values.add(core);
  values.add(core.replace(LOCATION_PREFIX, ''));
  values.add(core.replace(LOCATION_PREFIX, '').replace(INDUSTRY_SUFFIX, ''));
  const latinWords = raw.match(/[A-Za-z][A-Za-z0-9.-]{2,}/g) || [];
  latinWords.forEach(v => values.add(v));
  const custom = configuredAliases[raw];
  if (Array.isArray(custom)) custom.forEach(v => values.add(String(v)));
  return [...values].map(normalize).filter(v => v.length >= 2 && !WEAK_ALIASES.has(v));
}

function classifyEvent(text) {
  for (const pattern of EVENT_PATTERNS) {
    if (pattern.re.test(text)) return pattern.type;
  }
  return '';
}

function matchSubmittedJob(text, jobs, aliases = {}) {
  const haystack = normalize(text);
  const ranked = jobs.map(job => {
    const hits = companyAliases(job.company, aliases).filter(alias => haystack.includes(alias));
    const companyScore = hits.reduce((best, alias) => Math.max(best, alias.length >= 4 ? 6 : 4), 0);
    const title = normalize(String(job.job_title || '').replace(/[（(].*?[）)]/g, ''));
    const titleScore = title.length >= 4 && haystack.includes(title) ? 2 : 0;
    return { job, score: companyScore + titleScore, hits };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { job: null, score: 0, ambiguous: false };
  return {
    job: ranked[0].job,
    score: ranked[0].score,
    ambiguous: ranked.length > 1 && ranked[1].score === ranked[0].score,
    alias: ranked[0].hits.sort((a, b) => b.length - a.length)[0] || '',
  };
}

function validDateParts(year, month, day, hour, minute) {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

function inferYear(month, day, reference) {
  let year = reference.getFullYear();
  const candidate = validDateParts(year, month, day, 0, 0);
  if (candidate && candidate.getTime() < reference.getTime() - 45 * 86400000) year += 1;
  return year;
}

function parseEventDate(text, referenceDate, eventType) {
  const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date();
  const source = String(text || '').replace(/[：]/g, ':');
  const patterns = [
    /(?:^|[^\d])(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?(?:[^\d]{0,12})(\d{1,2})(?::|时)(\d{2})?/,
    /(?:^|[^\d])(\d{1,2})月(\d{1,2})日(?:[^\d]{0,12})(\d{1,2})(?::|时)(\d{2})?/,
    /(?:^|[^\d])(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/,
    /(?:^|[^\d])(\d{1,2})月(\d{1,2})日/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = source.match(patterns[i]);
    if (!m) continue;
    let year, month, day, hour, minute, hasTime;
    if (i === 0) {
      [, year, month, day, hour, minute] = m; hasTime = true;
    } else if (i === 1) {
      [, month, day, hour, minute] = m; year = inferYear(Number(month), Number(day), ref); hasTime = true;
    } else if (i === 2) {
      [, year, month, day] = m; hasTime = false;
    } else {
      [, month, day] = m; year = inferYear(Number(month), Number(day), ref); hasTime = false;
    }
    hour = hasTime ? Number(hour) : (eventType === '测评' || eventType === '笔试' ? 23 : 0);
    minute = hasTime ? Number(minute || 0) : (eventType === '测评' || eventType === '笔试' ? 59 : 0);
    const date = validDateParts(Number(year), Number(month), Number(day), hour, minute);
    if (!date) continue;
    return { date, hasTime, deadline: /截止|前完成|之前完成|due|deadline/i.test(source.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)) };
  }
  const relative = source.match(/(明天|后天)(?:[^\d]{0,12})(\d{1,2})(?::|时)(\d{2})?/);
  if (relative) {
    const date = new Date(ref);
    date.setDate(date.getDate() + (relative[1] === '明天' ? 1 : 2));
    date.setHours(Number(relative[2]), Number(relative[3] || 0), 0, 0);
    return { date, hasTime: true, deadline: false };
  }
  const duration = source.match(/(?:在|于|within|in)?\s*(\d{1,3})\s*(小时|天|日|hours?|days?)\s*(?:内|以内|within)?/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const date = new Date(ref.getTime() + amount * (/hour/.test(unit) || unit === '小时' ? 3600000 : 86400000));
    return { date, hasTime: true, deadline: true };
  }
  return null;
}

function localParts(date) {
  const pad = n => String(n).padStart(2, '0');
  return {
    date: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    time: pad(date.getHours()) + ':' + pad(date.getMinutes()),
  };
}

function messageKey(message) {
  const stable = message.messageId || [message.from, message.subject, message.internalDate && new Date(message.internalDate).toISOString()].join('|');
  return crypto.createHash('sha256').update(String(stable)).digest('hex').slice(0, 32);
}

function inspectMessage(message, jobs, aliases) {
  const combined = [message.subject, message.from, message.text].filter(Boolean).join('\n');
  const eventType = classifyEvent(combined);
  if (!eventType) return { disposition: 'ignore', reason: 'not_recruiting_event' };
  const match = matchSubmittedJob(combined, jobs, aliases);
  const parsed = parseEventDate([message.subject, message.text].filter(Boolean).join('\n'), new Date(message.internalDate || Date.now()), eventType);
  const key = messageKey(message);
  const received = new Date(message.internalDate || Date.now());
  const receivedParts = localParts(received);
  const parsedParts = parsed ? localParts(parsed.date) : null;
  const base = {
    key,
    subject: compactPreview(message.subject, 180),
    from: compactPreview(message.from, 120),
    received_at: received.toISOString(),
    event_type: eventType,
    company: match.job && !match.ambiguous ? match.job.company : '',
    job_title: match.job && !match.ambiguous ? match.job.job_title : '',
    date_min: receivedParts.date,
    date_max: parsedParts ? parsedParts.date : '',
    deadline_time: parsedParts ? parsedParts.time : '',
  };
  if (!match.job) return { disposition: 'review', reason: '未匹配到已投递岗位', ...base, ...(parsedParts || {}) };
  if (match.ambiguous) return { disposition: 'review', reason: '同时匹配多个已投递岗位', ...base };
  if (!parsed) return { disposition: 'review', reason: '未识别到明确日期和时间', ...base };
  if (!parsed.hasTime && eventType === '面试') {
    return {
      disposition: 'schedule', reason: '面试日期已识别，具体时刻待确认', ...base,
      ...parsedParts, time: '待确认', event_type: '面试（时间待确认）', needs_time_confirmation: true,
    };
  }
  const when = localParts(parsed.date);
  if (parsed.date.getTime() < Date.now() - 86400000) return { disposition: 'review', reason: '识别出的时间已经过去', ...base, ...when };
  if (match.score < 4) return { disposition: 'review', reason: '岗位匹配置信度不足', ...base, ...when };
  return {
    disposition: 'schedule', reason: '', ...base, ...when,
    event_type: eventType + (parsed.deadline ? '截止' : ''),
  };
}

function publicConfig(config) {
  return {
    configured: Boolean(config && config.email && config.auth_code && config.host),
    enabled: config ? config.enabled !== false : false,
    provider: config && config.provider || '',
    email: config && config.email || '',
    host: config && config.host || '',
    port: config && config.port || 993,
    secure: config ? config.secure !== false : true,
    lookback_days: config && config.lookback_days || 30,
    has_auth_code: Boolean(config && config.auth_code),
  };
}

function resolveConfig(input, previous = {}) {
  const provider = String(input.provider || previous.provider || 'custom');
  const preset = PROVIDERS[provider] || {};
  return {
    enabled: input.enabled !== false,
    provider,
    email: String(input.email || previous.email || '').trim(),
    auth_code: String(input.auth_code || previous.auth_code || '').replace(/\s+/g, ''),
    host: String(input.host || preset.host || previous.host || '').trim(),
    port: Number(input.port || preset.port || previous.port || 993),
    secure: input.secure !== undefined ? Boolean(input.secure) : (preset.secure !== false),
    mailbox: 'INBOX',
    lookback_days: Math.min(90, Math.max(1, Number(input.lookback_days || previous.lookback_days || 30))),
    aliases: input.aliases && typeof input.aliases === 'object' ? input.aliases : (previous.aliases || {}),
  };
}

async function fetchRecentMessages(config) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.email, pass: config.auth_code },
    logger: false,
  });
  const messages = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox || 'INBOX');
    try {
      const since = new Date(Date.now() - config.lookback_days * 86400000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids.length) return messages;
      for await (const item of client.fetch(uids, { uid: true, envelope: true, source: true, internalDate: true }, { uid: true })) {
        const parsed = await simpleParser(item.source);
        messages.push({
          messageId: parsed.messageId || item.envelope && item.envelope.messageId || '',
          subject: parsed.subject || item.envelope && item.envelope.subject || '',
          from: parsed.from && parsed.from.text || '',
          text: parsed.text || htmlToText(parsed.html || ''),
          internalDate: item.internalDate || parsed.date || new Date(),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) { /* connection may already be closed */ }
  }
  return messages;
}

async function scanMailbox({ configPath, statePath, jobs, scheduleEvent, messages }) {
  const config = readJSON(configPath, {});
  if (!publicConfig(config).configured || config.enabled === false) {
    return { ok: true, configured: false, added: 0, review_count: 0, scanned: 0 };
  }
  const state = readJSON(statePath, { scheduled: {}, pending: {}, ignored: {} });
  state.scheduled ||= {};
  state.pending ||= {};
  state.ignored ||= {};
  try {
    const incoming = messages || await fetchRecentMessages(config);
    let added = 0;
    for (const message of incoming) {
      const key = messageKey(message);
      if (state.scheduled[key] || state.pending[key] || state.ignored[key]) continue;
      const result = inspectMessage(message, jobs, config.aliases || {});
      if (result.disposition === 'ignore') continue;
      // Assessment and written-test notices stay visible for an explicit
      // date choice or completion confirmation; only interviews are placed
      // directly on the calendar when their date is known.
      if (result.disposition === 'review' || /^(测评|笔试)/.test(result.event_type || '')) {
        state.pending[key] = /^(测评|笔试)/.test(result.event_type || '')
          ? { ...result, reason: result.reason || '测评提醒待用户选择日程日期' }
          : result;
        continue;
      }
      const scheduled = await scheduleEvent(result);
      state.scheduled[key] = { ...result, duplicate: !scheduled.added, scheduled_at: new Date().toISOString() };
      if (scheduled.added) added++;
    }
    state.last_scan = new Date().toISOString();
    state.last_error = '';
    state.scanned_count = incoming.length;
    writeJSON(statePath, state);
    return { ok: true, configured: true, added, review_count: Object.keys(state.pending).length, scanned: incoming.length, last_scan: state.last_scan };
  } catch (error) {
    state.last_scan = new Date().toISOString();
    state.last_error = error && error.message || String(error);
    writeJSON(statePath, state);
    throw error;
  }
}

module.exports = {
  PROVIDERS,
  readJSON,
  writeJSON,
  publicConfig,
  resolveConfig,
  inspectMessage,
  matchSubmittedJob,
  parseEventDate,
  scanMailbox,
};
