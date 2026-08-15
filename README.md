# JOBdashboard

JOBdashboard 是一个本地运行的求职进度看板与 AI Agent 工作流模板。本项目是对直接原项目 [DanielPan12/JobHuntBot](https://github.com/DanielPan12/JobHuntBot) 的二次创作和改编版本，直接原项目的作者/仓库维护者为 **DanielPan12**。JobHuntBot 的文档和许可证另行提到 **Yvonne He** 的上游工作流 **ApplyPilot**；该上游来源和许可链条在本包 `LICENSE` 中保留说明。本版本加入了本地看板、岗位来源池、岗位简历队列、邮箱提醒和可复用启动器。

## 来源与署名

- 直接原项目：`JobHuntBot`
- 原项目仓库：https://github.com/DanielPan12/JobHuntBot
- 原项目作者/仓库维护者：`DanielPan12`
- 本项目性质：基于 JobHuntBot 的二次创作
- 上游来源：JobHuntBot 的许可证另行保留了 `ApplyPilot / Yvonne He` 的版权声明

## 发布包内容

- `dashboard/`：本地看板页面、Node.js 服务、空白 CSV 数据和邮箱监测模块。
- `templates/`：候选人资料、筛选规则、经历库、简历路由和空白看板模板。
- `references/`：初始化、浏览器投递和隐私安全说明。
- `启动 JOBdashboard.bat`：Windows 双击启动入口。
- `创建桌面快捷方式.ps1`：为当前目录创建桌面快捷方式。
- `JOBdashboard.ico`：本项目自选图标。

发布包不包含任何个人简历、姓名、联系方式、地址、身份证件、邮箱授权码、邮箱扫描状态、岗位投递记录、浏览器会话、Cookie、验证码信息或申请证据。

## Windows 使用

1. 安装 Node.js 18 或更高版本。
2. 解压本目录，不要直接双击 `dashboard.html`。
3. 双击 `启动 JOBdashboard.bat`。首次启动会在 `dashboard/` 下安装邮箱模块依赖，并打开 `http://localhost:8420/dashboard.html`。
4. 如需桌面图标，右键使用 PowerShell 运行：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\创建桌面快捷方式.ps1
   ```

5. 打开看板后，先在“搜索来源池”中选择要参与搜索的来源；没有其它来源时“全网搜索”默认启用，并优先回到公司官网网申页面核验。

## macOS / Linux 使用

```bash
chmod +x dashboard/start-dashboard.sh
./dashboard/start-dashboard.sh
```

需要 Node.js 18 或更高版本。看板只在本机运行，默认地址为 `http://localhost:8420/dashboard.html`。

## 邮箱监测

邮箱模块只接受 IMAP 授权码或应用专用密码，不应填写网页登录密码。复制 `dashboard/email_config.example.json` 的结构，在看板“邮箱设置”中配置。配置文件和扫描状态只保存在本机，发布模板不会预置任何邮箱信息。

- 面试邮件会自动加入日程；如果只有日期没有具体时刻，会标记为“时间待确认”。
- 测评/笔试邮件会进入待确认区，可选择发放日到截止日之间的日期加入日程，或点击“已完成”记录当天完成。

## AI Agent 工作流

让能够读取本地文件的 AI Agent 使用 `SKILL.md` 初始化工作流。Agent 可以帮助筛选岗位、维护看板、准备岗位简历和填写网页表单，但不会猜测身份、授权、薪资等高影响事实，也不会在没有用户明确确认的情况下点击最终投递按钮。

## GitHub 发布建议

发布前确认只提交本目录中的通用文件。不要把工作副本中的 `candidate_profile.json`、`answer_bank.md`、`experience_bank.md`、`resume_routing.md`、`application-previews.md`、`my-materials/`、`tailored-resumes/`、`application-evidence/`、`dashboard/email_config.local.json`、`dashboard/email_state.local.json` 或任何浏览器配置目录复制进仓库。

本项目保留原始 MIT 许可和原作者信息，详见 `LICENSE`。
