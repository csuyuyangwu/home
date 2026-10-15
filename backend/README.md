# 点赞与留言审核服务

前端继续放在 GitHub Pages，Worker + D1 保存共享数据，Resend 将待审核留言发到 `2995824036@qq.com`。当前后端地址为 `https://yuyang-home-community.csuyuyangwu-home.workers.dev`，生产数据库和邮件密钥已配置。下面的首次上线步骤供迁移或重新配置时参考。

## 使用方式

- 任何访客都可以点赞，无须登录。同一个浏览器只计一次；清理浏览器数据或换设备可再次点赞，因此不是实名投票系统。
- 访客填写昵称、留言，提交后保存在数据库的 `pending` 状态。不会立即出现在主页。
- QQ 邮箱收到留言全文和专属审核链接。打开链接只显示内容；点击“通过并发布”后立即成为公开留言。点击“拒绝”后保持不公开。
- 审核链接是访问凭证，请勿转发，14 天有效。已完成的审核不能被同一链接重复改写。
- 邮件发送失败会保留待审核留言，由每 5 分钟定时任务自动重试；服务不承诺第三方邮箱一定投递到收件箱，请检查垃圾邮件。
- 主页重载时读取最新计数和公开留言；留言每页 20 条，可继续加载。

## 站主删除留言

打开主页留言区下方的“站主管理”，或直接访问：

https://yuyang-home-community.csuyuyangwu-home.workers.dev/admin

1. 点击“发送登录链接到站主邮箱”。系统固定发往 `2995824036@qq.com`，访客不能指定其他收件地址。
2. 打开主题为“个人主页：站主管理登录”的邮件，点击链接，再点击“确认登录”。链接只能使用一次，15 分钟有效；邮件自动预览不会完成登录。
3. 在管理页选择对应留言的“删除这条留言”，确认内容后点击“确认删除”。留言会永久移除，主页刷新后不再显示。审核邮件过期的旧留言也可以删除。
4. 管理会话保存在安全的 HttpOnly Cookie 中，7 天有效；共用电脑上请点击“退出登录”。登录邮件链接不能转发。

普通访客只能打开登录页，没有站主登录会话无法查看管理列表或删除留言。即使直接请求删除接口，也会由后端拒绝。修改后的 `schema.sql` 包含 `owner_tokens` 表，已存在数据库升级时也需要执行一次该文件（所有建表语句均为 `IF NOT EXISTS`）。

## 首次上线

需要 Node.js 22+、Cloudflare 账号、Resend 账号。Cloudflare 和 Resend 的凭证只在本地命令行输入，不要贴到主页源码、GitHub、聊天中。

1. 注册 Cloudflare，进入本目录，使用 Wrangler 登录并创建 D1：

   ```powershell
   cd D:\home\backend
   npx wrangler login
   npx wrangler d1 create yuyang-home-community
   ```

2. 将返回的 `database_id` 填入 `wrangler.toml`，初始化生产数据库：

   ```powershell
   npx wrangler d1 execute yuyang-home-community --remote --file=schema.sql
   ```

3. 注册 Resend，创建发送邮件 API Key。配置有效发件人到 `MAIL_FROM`。正式发送通常需要在 Resend 验证你自己的域名；若使用测试发件人 `onboarding@resend.dev`，仅能给 Resend 账号自己的注册邮箱发送测试邮件，因此应使用审核用的 QQ 邮箱注册并按 Resend 控制台实际限制验证。发送人不能直接随意填 QQ 地址。

4. 生成随机密钥并将两个值保存为 Worker secrets：

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put MODERATION_SECRET
   npx wrangler secret put RESEND_API_KEY
   ```

   `MODERATION_SECRET` 至少 32 个随机字符。它也用于匿名化限流键。更换此密钥会使旧邮件审核链接失效。

5. 部署 Worker，获取实际 `https://...workers.dev` 地址：

   ```powershell
   npx wrangler deploy
   ```

   将这个地址填入 `wrangler.toml` 的 `PUBLIC_API_URL`，然后再次 `npx wrangler deploy`。`SITE_ORIGIN` 保持 `https://csuyuyangwu.github.io`，`SITE_URL` 记录完整主页地址。若以后换域名，要同步修改 `SITE_ORIGIN`。

6. 设置 `D:\home\static\js\community-config.js`：

   ```javascript
   window.COMMUNITY_API_URL = 'https://你的实际Worker地址.workers.dev';
   ```

   这里只能有公开 API 地址，不能放任何密钥。然后 Git 提交并推送，通过原有 GitHub Pages 流程发布前端。

7. 验收：在主页点赞，换浏览器确认总数共享；提交一条测试留言，确认提交后不公开；在 QQ 邮箱打开审核页，先不点击按钮并确认仍不公开；点击通过后刷新主页确认显示。再提交并拒绝一条留言，确认公开列表不包含它。

## 本地测试

在仓库根目录运行 `npm run test:community`。测试使用真实内存 SQLite 模拟 D1，邮件请求在测试内拦截，不会发送真实邮件。

完整本地联调：复制 `.dev.vars.example` 为 `.dev.vars`，设置值；在 `wrangler.toml` 暂时将 `SITE_ORIGIN` 设为本地前端 origin、`PUBLIC_API_URL` 设为实际 HTTPS 测试地址，然后使用 `npx wrangler d1 execute yuyang-home-community --local --file=schema.sql` 和 `npx wrangler dev`。不要将开发配置推送到线上。

## 维护

- 每个 IP 每小时最多 3 次留言、30 次点赞请求。昵称限 40 字，留言限 1000 字，接口限制请求体大小。公开接口只返回已通过的昵称、内容、时间及公开条目 ID。
- 不收集留言者邮箱；昵称是访客自填，未核验身份。公开留言和审核页都按纯文本显示用户内容。
- 邮件链接使用 HMAC 签名，只存留言数据，不在数据库存原始审核 token。请勿将带 token 的审核 URL 写入日志或第三方统计；Worker 自带代码不会打印它。
- 如漏收邮件，使用 Cloudflare D1 控制台查询 `SELECT id, reference, status, notified, notification_attempts FROM comments ORDER BY id DESC;`。仍在 14 天以内的待审核留言可将 `notified = 0, notification_next_at = 0` 后等待重试。已超过 14 天的留言需要由站主在 D1 控制台人工审核；不要为了续期修改提交时间。
- 人工审核 SQL：`UPDATE comments SET status = 'approved', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 具体ID AND status = 'pending';`。拒绝时将 `approved` 换成 `rejected`；已公开留言要撤下时将该 ID 的 `status` 改为 `rejected`。
- `.dev.vars`、`.env*`、`.wrangler/` 已忽略。GitHub Pages 仅打包 `index.html` 和 `static/`，不会发布后端目录或本地配置。
- 已部署 Worker、初始化远程数据库，并配置邮件密钥。公开列表只返回已审核留言；站主可通过上线测试邮件的审核链接完成最后的人工验收。

官方参考：[Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Resend 邮件接口](https://resend.com/docs/api-reference/emails/send-email)、[Resend 测试发送限制](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)。
