# Changelog

## Unreleased

- **NapCat 撤离前端**：设置页「QQ 接入」的协议端切换（LuckyLillia / NapCat 两档胶囊）整体下架——界面不再公开、不可选；`POST /api/login/protocol` 与 NapCat 托管机制在后端原样保留（想用就手改 config 的 `onebot.flavor` 或直接调接口）。设置页的接入分节只剩端点、可用性检测、账号与重启/控制台。
- **一键安装提速**：ffmpeg 货源从 gyan.dev（本机实测 ~100KB/s）换成 npmmirror 的阿里 CDN（实测 ~800KB/s，8 倍；b6.0 是 MZ 头原生 exe，落盘即用、不再走解包）；「立即安装」的 ffmpeg 与协议端发行包两个纯下载改为**后台并行**，与 winget 各项同时跑——不再是三大件逐个排队干等。
- **work 续接同一场对话**：说「继续」不再是只带一段拼接任务文的冷启动——每场 run 的完整会话（全部轮次、思考、工具往返）随任务沙箱落盘（`.agent-session/<runId>.json`），回答提问、`continue_run`、桌面端续跑都把上一场**原样播种**进新一轮上下文，像普通 harness 一样在同一会话里接着跑；模型链挂了换个模型也是同一场。会话记录丢了（内核崩在中途）才退回旧的拼接任务文。顺手修掉续接文嵌套滚雪球：`work_runs` 新增 `orig_task` 列存原始任务原文，拼接兜底一律用它，不再拿上一版拼接文当原料（此前每续一轮就嵌套一层，实测五连继续的任务文里滚了五份原文）。
- **超大文件按需取件 `fetch_file`**：超过 16MB 的群文件/私聊文件/消息视频不再被体积闸白白丢掉——适配器拦下时登记进 `pending_files`（名字/文件号/体积，留 7 天、单会话 50 条），work 工具面新增 `fetch_file`：无参列登记簿，带名字按需把文件拉进任务沙箱 inbox（换临时链接、流式落盘、单文件上限 320MB、取回即销行）。
- **两类「模型链没有返回任何内容」的病根**（近四场迷宫任务复盘）：① QQ 把 GIF 动图落成 `.jpg` 扩展名，`readImage` 按扩展名声明 mime，网关以「Declared image type does not match its bytes」整发 400——改为按文件头嗅探真实类型（GIF 交 `image/gif`，认不出的明说让 Python 转）。② 瞬态中断只重试一次，免费网关 `fetch failed` 一次常常不够——改为重试 2 次 + 1.5s 退避，再失败把对端报错原文带回任务失败原因，不再一句「没有返回任何内容」让排障从零猜。
- **工作页历史记录批量删除**：历史分组头右侧加垃圾桶钮，进入选择态后逐条勾选（全选 / 反选 / Esc 退出 / 确认框），一次删掉多条运行记录。只删记录本身（内存 + `work_runs` 表），沙箱里的文件与产物保留；正在跑的任务一律跳过；删掉「等你回答」的记录时顺带清掉提问现场。`POST /api/work/delete`。
- **引用回查兜底 `get_msg`**：本地会话日志（内存尾 + 磁盘）查不到被引用消息时，改问协议端要原文（OneBot 11 `get_msg`，LLBot / NapCat 都实现）。重启/重登窗口期 bot 没落账的消息本地永远查不到，但协议端那边有——实测 787 条查不到的引用，短号 100% 都在 LLBot 的 `message` 表里。取回后同样写成 `replyTo` 快照；被引用的是图片/语音/视频时一并落进会话沙箱，引用旧图时模型仍看得见图本身。协议端也取不到就保留 `[回复:id]` 占位、不编内容。入站落账改为按会话串行（回查最长等协议端 1.2s，不能让后一条越过前一条）。
- **预期账号（`ui.expectedQq`）不再是启动前置**：登哪个号，bot 就是哪个号（适配器在预期账号为空时不设限，本就如此）。它降级为可选项：手填仍可启用账号守卫与 PMHQ 快速登录。设置页「QQ 接入」新增**协议端切换**（LuckyLillia / NapCat 两档胶囊，`POST /api/login/protocol`：停旧端→落盘→后台起新端，config API 仍不收 flavor）。登录门会显示托管端的启动拦截原因（如本机有别的 QQ 在跑、发行包下载失败）。README 协议端表补回 **NapCat**。LLBot 无头 token 警告只在 direct 模式打（有头模式不需要 token，旧日志会让排障的 AI 误诊成「没 token 起不来」）。

## 0.3.0 (2026-10-31)

分发形态全面铺开的版本：npm 直装、零依赖绿色版、一键安装、winget。

- **npm registry**：包转公开（`private: false`），`npm i -g @ddnoodles/parallel` 直装；Release CI 在配好 `NPM_TOKEN` 后自动 publish。
- **零依赖绿色版**：发布 zip 内置 win-x64 Node 运行时（`runtime/node.exe`，nodejs.org 官方源 + SHA256 校验后入包）与完整 node_modules——不再要求目标机装过 Node；`parallel.cmd` 优先用包内运行时。修复两处 zip 老坑：CI（ubuntu GNU tar）把 `.zip` 打成裸 tar；本地（Git 的 GNU tar 命中后掉进 Compress-Archive 兜底）丢顶层目录。现在压缩后硬校验 PK 魔数与首条目前缀。
- **一键安装**：`scripts/install.ps1`——解析最新 Release、下载解压到 `%LOCALAPPDATA%\Programs\parallel`、加用户 PATH、建开始菜单快捷键；`irm ... | iex` 即用。
- **winget**：`scripts/winget-manifest.mjs` 按版本生成 manifest 三件套（提交官方源走 fork + PR）。
- **其他**：会话页删掉「打断当前回复」按钮；README 截图区精简为拟人化 / 工作真机演示 + 桌面活动流，致谢区 MaiBot / AstrBot 补上链接；仓库 topics 上齐。

## 0.2.1 (2026-10-31)

- **发布包剔除私人插件 cover**（npm files 负 pattern + zip FORBIDDEN 双管），仓库与开发目录保留；插件缺席时 supervisor 不启动、UI 走现成「插件未启用」兜底。
- 修复 CI zip 实为裸 tar（魔数 `para` 非 `PK`）——v0.2.0 的 zip 即此问题，撤回重发。

## 0.2.0 (2026-10-29)

两轮全量审查（131 + 105 条发现）落地后的首个打包版本。

- **安全**：内核日志 token 脱敏；mdLite 链接属性注入 XSS 修复；免 token 端点强制回环来源与 Origin；请求体上限；沙箱真实路径（realpath）校验防符号链接逃逸 + 聊天键消毒；`web_fetch` 拒绝内网/环回/元数据地址；卸载插件清空密钥。
- **资源**：消息积压保护真正生效；work 运行记录内存淘汰；会话列表尾部限窗读；docker 调用全链异步化（不再冻结事件循环）；分群开关缓存；全局执行并发帽；python 桥超时中断；沙箱配额/TTL 真实扫盘。
- **业务/前端**：work 汇报轮结构化标记；派活归属取实际说话人；桌面端打断按钮、发送失败反馈、会话页竞态守卫；人格写入 `data/personas`（不再改源码树）；内核身份节不再写死人格；core 插件不受分群开关约束（修复新装实例 chat 不生效）；环境检查走过一次不再重复拦截。
- **分发**：协议端发行包官方源优先 + SHA256 校验；发布脚本干净树闸门；`logos/`、`ref/`、`__pycache__` 不入发布物。
- **许可与素材**：许可证定为 **AGPL-3.0-only**（`agency.ts` 行动容量判定为 HDS-Interlude 逐行移植，见 `THIRD-PARTY-NOTICES.md`）；258 张腾讯版权 QQ 表情移出仓库与发布包，运行时由内核从本机协议端发行包转码生成到 `data/face/`。
- **打包**：npm 化（`bin`/`files`/`engines`/prepack 检查），GitHub Actions CI 与 tag→Release 自动出 `.tgz` + `.zip`；全局安装时数据目录落在用户工作目录；npm 包内带编译产物 `dist/`（Node 拒绝对 node_modules 里的 TS 做类型剥离，安装版必须跑编译 JS，开发/zip 仍直跑 TS 源码）。

## 0.1.0 (2026-10-28)

首个可用快照：内核（agent loop / Pipeline / 拟人层 / 沙箱 / 插件容器）+ 9 个内置插件 + 桌面端（14 页）。
