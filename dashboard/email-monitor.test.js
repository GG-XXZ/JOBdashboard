'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectMessage, parseEventDate, scanMailbox, writeJSON } = require('./email-monitor');

const jobs = [
  { company: 'Example Corp', job_title: '机械设计工程师', status: 'Submitted' },
  { company: '苏州科达科技股份有限公司', job_title: '结构开发工程师', status: 'Submitted' },
];

test('recognizes a future interview and matches a submitted company', () => {
  const result = inspectMessage({
    messageId: '<one@example.com>',
    subject: 'Example Corp面试邀请',
    from: 'Example Recruiting <hr@example.com>',
    text: '请于2099年8月20日 14:30参加机械设计工程师线上面试。',
    internalDate: new Date('2099-08-10T08:00:00+08:00'),
  }, jobs, {});
  assert.equal(result.disposition, 'schedule');
  assert.equal(result.company, 'Example Corp');
  assert.equal(result.date, '2099-08-20');
  assert.equal(result.time, '14:30');
  assert.equal(result.event_type, '面试');
});

test('keeps an event without a submitted-job match for review', () => {
  const result = inspectMessage({
    messageId: '<two@example.com>',
    subject: '陌生公司测评通知',
    from: 'recruit@unknown.test',
    text: '请于2099年8月20日18:00前完成在线测评。',
    internalDate: new Date('2099-08-10T08:00:00+08:00'),
  }, jobs, {});
  assert.equal(result.disposition, 'review');
  assert.equal(result.reason, '未匹配到已投递岗位');
});

test('does not treat a generic company suffix as a competing match', () => {
  const result = inspectMessage({
    messageId: '<suffix@example.com>',
    subject: 'Example Energy assessment invitation',
    from: 'Example Energy Ltd <hr@example.com>',
    text: 'Example Energy thanks you for your interest. Please complete the assessment within 72 hours.',
    internalDate: new Date('2099-08-10T08:00:00+08:00'),
  }, [
    { company: 'Example Energy Ltd', job_title: '结构工程师-南京', status: 'Submitted' },
    { company: 'Sample Manufacturing Ltd', job_title: '机电类-27届', status: 'Submitted' },
  ], {});
  assert.equal(result.disposition, 'schedule');
  assert.equal(result.company, 'Example Energy Ltd');
  assert.equal(result.date_max, '2099-08-13');
});

test('schedules an interview date without an exact time for confirmation', () => {
  const result = inspectMessage({
    messageId: '<three@example.com>',
    subject: '科达面试安排',
    from: 'hr@example.com',
    text: '面试日期为2099年8月20日，时间稍后通知。',
    internalDate: new Date('2099-08-10T08:00:00+08:00'),
  }, jobs, {});
  assert.equal(result.disposition, 'schedule');
  assert.equal(result.time, '待确认');
  assert.equal(result.event_type, '面试（时间待确认）');
});

test('parses a Chinese deadline date', () => {
  const parsed = parseEventDate('请在2099年8月20日 18:30前完成测评', new Date('2099-08-10'), '测评');
  assert.ok(parsed);
  assert.equal(parsed.date.getFullYear(), 2099);
  assert.equal(parsed.date.getMonth(), 7);
  assert.equal(parsed.date.getDate(), 20);
  assert.equal(parsed.date.getHours(), 18);
  assert.equal(parsed.date.getMinutes(), 30);
});

test('parses a relative assessment deadline', () => {
  const parsed = parseEventDate('请在72小时内完成测评', new Date('2026-08-14T10:00:00+08:00'), '测评');
  assert.ok(parsed);
  assert.equal(parsed.deadline, true);
  assert.equal(parsed.date.getTime(), new Date('2026-08-17T10:00:00+08:00').getTime());
});

test('does not schedule the same message twice across refresh scans', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-email-'));
  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'state.json');
  writeJSON(configPath, { enabled:true, provider:'custom', email:'x@example.com', auth_code:'secret', host:'imap.example.com', port:993, secure:true, lookback_days:30 });
  const message = {
    messageId: '<dedupe@example.com>', subject:'Example Corp面试邀请', from:'hr@example.com',
    text:'请于2099年8月20日18:00参加面试。', internalDate:new Date('2099-08-10T08:00:00+08:00'),
  };
  let scheduled = 0;
  const scheduleEvent = async () => { scheduled++; return { added:true }; };
  const first = await scanMailbox({ configPath, statePath, jobs, scheduleEvent, messages:[message] });
  const second = await scanMailbox({ configPath, statePath, jobs, scheduleEvent, messages:[message] });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(scheduled, 1);
});
