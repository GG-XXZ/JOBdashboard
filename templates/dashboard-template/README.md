# Dashboard Template

Use these CSV files as a lightweight dashboard. They can be imported into Excel, Google Sheets, Airtable, Notion, or converted into a workbook.

## Sheet Purposes

### `daily_dashboard.csv`

Daily operator summary.

Fields:

- `date`: run date.
- `found_count`: jobs found.
- `submitted_count`: confirmed submissions only.
- `skipped_count`: intentionally skipped jobs.
- `blocked_count`: attempted but automation could not complete.
- `needs_user_count`: waiting for user action.
- `pending_count`: queued for later.
- `top_sources`: LinkedIn, company sites, job boards, etc.
- `summary`: short run summary.
- `user_actions_needed`: concrete next actions for the user.

### `job_pool.csv`

Main job lead table and current state.

Fields:

- `date_found`: when the job was found.
- `company`, `job_title`, `role_family`, `level`, `location`, `remote_policy`.
- `source`, `job_url`, `posted_date`.
- `priority`: High, Medium, Low, Stretch.
- `status`: Submitted, Skipped, Blocked, Needs user, Pending, Ready to submit。`Ready to submit` 表示表单已填完、只差用户最终手动确认；Agent 可以先继续处理其它岗位。
- `resume_variant`: selected resume route.
- `skip_reason`: why skipped.
- `blocker`: current blocker if any.
- `next_action`: what should happen next.
- `notes`: short context.
- `cohort_match_status`: `Yes` / `No` / `Unclear` — whether the target hiring cycle (e.g. a specific graduating class / 届 for campus recruiting) has been explicitly confirmed open for this row. Set this explicitly every time you finish checking a company; don't leave the dashboard to guess it from free-text `notes`. The dashboard's "confirmed open, not yet applied" view is driven entirely by this column.
- `current_stage`: free-text label for where an already-submitted application currently stands (e.g. "笔试", "二面"). Set by the dashboard's calendar "add/edit event" action, verbatim as typed — it does not add a suffix or normalize wording, since every company's process reads differently. Left blank until the first calendar event is scheduled for that job.

### `application_log.csv`

Audit trail for actual attempts.

Fields:

- `attempt_date`, `company`, `job_title`, `job_url`, `platform`.
- `status`: final attempt outcome.
- `submission_evidence`: what proved submission.
- `resume_used`: exact resume file or variant.
- `answers_used`: answer bank sections or custom answers used.
- `confirmation_url`, `confirmation_text`.
- `notes`.

### `blocker_queue.csv`

Retry and handoff queue.

Fields:

- `date`, `company`, `job_title`, `job_url`.
- `blocker_category`: CAPTCHA, login, dropdown, upload, missing material, etc.
- `what_happened`: observed failure.
- `why_blocked`: why the agent stopped.
- `can_retry`: yes/no.
- `next_retry_strategy`: browser automation, visual control, user handoff, skip.
- `user_action_needed`: exact user action.
- `status`: open, retry later, resolved, abandoned.

### `follow_up.csv`

Post-application pipeline.

Fields:

- `date`, `time`, `company`, `job_title`, `contact`, `channel`.
- `event_type`: recruiter reply, rejection, interview, assessment, follow-up. Rows added via the dashboard's calendar UI use this field as free-text event content and also copy it into `job_pool.csv`'s `current_stage` for that job.
- `deadline`, `next_action`, `status`, `notes`.

### `resume_rules.csv`

Resume routing table.

Fields:

- `role_family`.
- `resume_file_path`.
- `use_for_titles`.
- `avoid_for_titles`.
- `tailor_threshold`: external score or qualitative threshold.
- `notes`.

### `automation_rules.csv`

Lessons learned.

Fields:

- `date`.
- `rule_category`: screening, browser, ATS, answer, resume, safety.
- `rule`: new or updated rule.
- `reason`: why it exists.
- `source_blocker_or_lesson`: link to blocker, application, or observation.
- `status`: active, testing, retired.

### `lead_sources.csv`

用户自定义的岗位搜索来源池。可保存公众号名称、在线文档链接和其它网站入口；`status=Active` 且 `enabled=Yes` 的来源才进入后续搜索轮次。看板还提供一个虚拟的“全网搜索”来源：没有其它来源时默认启用，有其它来源时仍可单独开关；全网搜索结果应优先回到公司官网网申页面核验和投递。

### `resume_templates.csv`

可选择的简历版式注册表。`source_file_path` 指向原始模板，`is_default=Yes` 是默认项。

### `resume_requests.csv`

按岗位定制简历的任务队列。状态使用 `Queued`、`Generating`、`Generated` 或 `Failed`；生成后必须写入 `output_directory` 和 `output_file`。

### `activity_log.csv`

网页看板中手动导入来源、确认投递、导入已投递岗位、创建简历任务和修改标题的审计日志。

### `dashboard_settings.json`

本地看板设置，保存可编辑的 `title` 以及 `search_sources.web_enabled` 全网搜索开关。

### 邮箱提醒

邮箱监测会把已投递岗位的面试直接写入日程；如果面试邮件只给出日期，会标记为“时间待确认”。测评/笔试提醒会保留在邮箱提醒区，使用“添加到日程”时只能选择邮件发放日到截止日之间的日期，也可以用“已完成”记录当天完成时间。

## Counting Rules

- Count only confirmed submissions in `submitted_count`.
- Put every job in `job_pool.csv` once.
- Put every real application attempt in `application_log.csv`, even if it failed.
- For lead-finding-only trials, leave `application_log.csv` empty because no application attempt occurred.
- Put repeatable failures in `blocker_queue.csv`.
- Convert repeated blockers into `automation_rules.csv`.

## Lead-Finding Trial Rules

For a first clean-room trial or demo:

- Find 3-5 jobs.
- Update `job_pool.csv` and `daily_dashboard.csv`.
- Use `Pending` only for jobs worth later review or application.
- Use `Needs user` when a missing high-impact fact blocks the decision, such as sponsorship, work authorization, compensation, relocation, or real resume file.
- Use `Skipped` for roles that clearly violate rules.
- Use `Blocked` only when an attempted workflow or site interaction cannot proceed.
- Do not write to `application_log.csv` unless the agent actually opened or attempted an application flow.
