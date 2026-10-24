# 03 · 国际市场录音转写 / AI 会议记录软件与 Whisper 生态调研报告

**目标产品**：「讲义笔记」—— Windows 本地优先的课堂录音转写 + AI 笔记工具
**调研时间**：2026 年 10 月
**调研范围**：商业产品（Otter、Fireflies、Notta、Descript、TurboScribe、MacWhisper、开源桌面工具 Whisper Desktop / Buzz / Vibe / Aiko）；开源生态（openai/whisper、whisper.cpp、faster-whisper、whisperX、Vosk、sherpa-onnx）；各家 ASR API 定价横向（OpenAI、Deepgram、AssemblyAI、Groq、Cloudflare、AWS）。
**口径说明**：所有价格、模型名、性能数字均尽量取自官方定价页 / 官方文档 / GitHub README 原文，并附来源 URL；官方页面被反爬拦截或截断的，采用第三方转述并明确标注「第三方转述」；查不到的一律写「未查到」，不编造。

---

## 一、核心结论（先给答案）

1. **国际会议转写市场是「云 + 订阅 + 机器人入会」的天下，课堂场景几乎空白。** Otter（2025 年 ARR 超 $100M）与 Fireflies（2025-03 达 1600 万用户）证明赛道规模，但两者的核心价值主张都是「自动加入 Zoom/Teams/Meet 会议并出纪要」，没有一个头部产品为「Windows 桌面 + 课堂录音 + 讲义笔记」设计。我们的场景是国际竞品都不做的。
2. **纯 ASR 已无利润，全行业把收入压在「转写后的整理」上。** 国际玩家用两种手段实现：一是「计量改革」（Descript 2025-09 把转写小时改成「媒体分钟」，多轨倍乘计费）；二是「AI 动作二次计费」（Fireflies 的 credits 体系、Notta Brain、AssemblyAI 的加购堆叠）。这对我们的启示：本地转写免费/买断当钩子，云端 AI 整理按量充值当收入引擎，结构正好踩在行业标准上。
3. **「本地优先 + 一次性买断」已被验证能卖成，最近同类就是 MacWhisper。** MacWhisper（Good Snooze / Jordi Bruin）Gumroad 直购版 Pro **€64 一次性买断、终身更新**，同时 App Store 版走订阅+IAP；日本 RecText AI 2 以 9,980 日元买断卖「离线转写 + 机密音频安心」。但 MacWhisper 仅 macOS——**Windows 上目前没有同等质量的商业级本地 Whisper 桌面工具**，这正是「讲义笔记」的窗口期。
4. **OpenAI 云 API 正在「去 Whisper 化」，依赖它做字幕/说话人分离不可持续。** 2026-07-28 OpenAI 发布 gpt-transcribe（$0.0045/min）取代 whisper-1；2026-08-26 宣布 whisper-1 / gpt-4o-transcribe 等旧模型 **2027-02-26 从 API 移除**，而新模型**没有词级时间戳、SRT/VTT 字幕、说话人分离、英译**，官方指南仍指向即将退役的旧模型。这从反面证明了：字幕和说话人功能必须握在自己手里（本地引擎生成），云端只做「整理类」工作。
5. **Whisper 生态技术成熟度足以支撑 Windows 本地产品。** whisper.cpp（54.4k★）提供整数量化（q5_0）、CPU/GPU/NPU 全后端；faster-whisper（25.9k★）官方基准证明 int8+batch 在 CPU 上能把 13 分钟音频压到 51 秒；sherpa-onnx（15.3k★）是中文场景的本地全栈备选（SenseVoice）。说话人分离的主流方案 pyannote 需要 Hugging Face token 且要同意 gated 协议，不适合直接捆绑进产品——课堂「老师/学生」两角色的简化分离可以自研。
6. **ASR API 价格战白热化，云转写成本可以忽略不计，但各有硬伤。** 最便宜的是 Cloudflare Workers AI 的 @cf/openai/whisper **$0.0005/音频分钟**（仅批量、无说话人分离/自定义词表）；OpenAI gpt-transcribe $0.0045/min；AWS Transcribe $0.024/min。价格相差近 50 倍，说明「卖转写」没有差异化空间，「卖整理」才有。
7. **坑集中在三处：计量口径不透明（Descript 媒体分钟）、订阅取消陷阱（TurboScribe 一星差评 15/26 条是「取消后仍扣费」）、AI 擅自改写原文（多款产品的共同吐槽）。** 这三点必须写进我们的产品原则：分钟口径清晰、买断+充值无自动续费、AI 产物永远可回溯到逐字稿。

---

## 二、竞品总表

### 表 1 · 商业产品

| 产品 | 定位/目标用户 | 平台 | 免费档 | 付费价格（官方） | 引擎 | 核心差异化 |
| --- | --- | --- | --- | --- | --- | --- |
| Otter | 会议 AI 助手，企业+教育 | Web/Win/iOS/Android/Chrome 扩展 | 300 分钟/月转写 | Pro $16.99/月（年付 $8.49/月）；Business $30/月（年付 $24/月） | 自研（未公开） | AI Chat 会内+跨会问答；仅 6 种转写语言；.edu 邮箱 Pro 8 折 |
| Fireflies | 会议转写+销售情报分析 | Web/Chrome/会议 Bot | 3 credits（Auto-join 后转写不限量） | Pro $18/月（年付 $10/月）；Business $29/月（年付 $19/月） | 自研（未公开） | 总结模板体系、AskFred 按发言者问答、1600 万用户 |
| Notta | 日系会议转写+翻译 | Web/iOS/Android/Chrome | 120 分钟/月 | Pro $13.49/月（年付 $8.17/月）；Business $27.99/月/席 | 自研（未公开） | 58 语言、转写→PPT/信息图、Notta Memo 硬件 |
| Descript | 音视频编辑式转写（播客/视频创作者） | Win/Mac 桌面+Web | 1 小时/月媒体 | Hobbyist $16/人/月；Creator $24；Business $50 | 自研（未公开） | 编辑转写=编辑音视频；Underlord AI；25 语言转写 |
| TurboScribe | 无限转写（个人/团队海量转写） | Web | 每天 3 条×30 分钟 | Unlimited $20/月（年付 $10/月）；Unlimited Max $200/月 | Whisper 系 | 无限转写、单文件 10 小时、134+ 语言翻译 |
| MacWhisper | Mac 本地 Whisper 桌面工具 | macOS（App Store 版+iOS） | 永久免费（Tiny/Base 模型） | Gumroad Pro **€64 一次性买断**；App Store 版 $6.99/月 等 | 本地 Whisper + Nvidia Parakeet | 买断+本地、会议检测录音、系统级听写、BYOK AI |
| Whisper Desktop（Const-me） | Windows 本地 GPGPU 转写 | Windows | 开源版免费 | 闭源商业后继版（30 天试用+买断） | whisper.cpp 移植（D3D11） | 纯 DirectCompute、无运行时依赖、Whisper.dll 仅 431KB |
| Buzz | 跨平台离线转写 | Win/macOS/Linux | 免费开源（MIT） | — | Whisper（HF 模型族） | 麦克风实时转写+演示窗、22,001★ |
| Vibe | 跨平台离线转写+AI 总结 | Win/macOS/Linux | 免费开源（MIT） | — | whisper.cpp + Claude/Ollama | 手机扫码录音、QR 回传、自动更新 |
| Aiko | 苹果端侧转写（sindresorhus） | macOS/iOS/visionOS | 免费 | — | 端侧 Whisper | Shortcuts 深度集成、100 语言 |

### 表 2 · Whisper 开源生态（GitHub API 实测，截至 2026-10-15）

| 项目 | ★ | License | 语言 | 更新状态 | 定位与关键指标 |
| --- | --- | --- | --- | --- | --- |
| openai/whisper | 110,527 | MIT | Python | pushed 2026-08-31 | 参考实现；13,399 forks |
| ggml-org/whisper.cpp | 54,404 | MIT | C/C++ | pushed 2026-10-12（活跃） | 纯 C/C++ 推理；量化 q5_0；NPU/ANE 后端；tiny 75MiB~large 2.9GiB |
| SYSTRAN/faster-whisper | 25,864 | MIT | Python | pushed 2026-10-13（活跃） | CTranslate2 加速，宣称快 4×；int8 量化；内置 Silero VAD |
| m-bain/whisperX | 24,556 | BSD-2-Clause | Python | pushed 2026-09-26 | 词级时间戳（wav2vec2 对齐）+ 说话人分离（pyannote）；宣称 70× realtime |
| alphacep/vosk-api | 15,175 | Apache-2.0 | 多语言绑定 | pushed 2026-10-15（活跃） | Kaldi 系离线小模型（约 50MB）；零延迟流式 API |
| k2-fsa/sherpa-onnx | 15,290 | Apache-2.0 | C++ | pushed 2026-10-15（非常活跃） | 本地全栈 STT/TTS/分离/VAD；12 种语言 API；NPU 支持；SenseVoice 中文 |

### 表 3 · ASR API 定价横向（官方页核实，2026-10）

| 厂商 | 模型/产品 | 价格 | 计费口径 | 备注 |
| --- | --- | --- | --- | --- |
| OpenAI | gpt-transcribe | **$0.0045/min** | 音频分钟 | 文件/批量，25MB 上限；无字幕/说话人 |
| OpenAI | gpt-live-transcribe | **$0.017/min** | 音频分钟 | 低延迟实时流 |
| OpenAI | whisper-1（旧） | $0.006/min | 音频分钟 | 2027-02-26 从 API 移除 |
| Deepgram | Nova-3 Monolingual | **$0.0048/min** | 音频分钟 | 促销价（原 $0.0077）；流式 |
| Deepgram | Flux English | $0.0065/min | 音频分钟 | 流式 |
| AssemblyAI | Universal-3.5 Pro | **$0.21/hr** | 音频小时 | 预录；加购说话人 +$0.02/hr |
| AssemblyAI | Universal-3.6 Pro Realtime | **$0.45/hr** | 会话小时 | 流式按 WebSocket 会话时长 |
| Groq | Whisper Large v3 Turbo | **$0.04/hr** | 音频小时 | 第三方转述官方 docs（console 403） |
| Cloudflare | @cf/openai/whisper | **$0.0005/min** | 音频分钟 | 仅批量；无说话人/自定义词表 |
| AWS | Transcribe 标准 | **$0.024/min** | 音频分钟 | 首 250k 分钟/月，阶梯递减 |

---

## 三、商业产品逐个详解

### 1. Otter.ai

**定位与目标用户**：会议 AI 助手，主攻企业会议纪要与教育场景（Otter for Education 有专门页面），2025 年 ARR 超 $100M，G2 评分 4.4/5（505 条评价）。桌面端覆盖 iOS/Android/Windows（官网有 otter_latest.exe 直链），另有 Chrome 扩展。

**核心功能**：实时转写（会中流式出字）；说话人识别；AI Chat（会内针对本场会议提问 + 跨会针对全部历史会议提问）；自动加入 Zoom/Teams/Meet；多语言转写——但注意**转写语言仅 6 种：英/西/法/德/日/简体中文**；Otter MCP server（把会议数据接入 AI Agent）；Otter Sales Notetaker（销售场景，Enterprise）。Pro 档含团队词表与可标记说话人、高级搜索/导出/回放、Salesforce/HubSpot/Zapier 集成；Business 档解锁无限会议与录音、单会 ≤4 小时、3 场并行会议、管理功能；Enterprise 加 SSO/SCIM、HIPAA、API & Webhooks、Gmail/Drive/Notion/Jira AI Chat（标注 Coming Soon）。

**UI 布局与交互亮点**：三栏式「会议列表 / 转写正文 / AI 面板」是行业范式；值得抄的是「AI Chat 跨会」入口——把全部历史会议变成一个可问答的知识库，这对「讲义笔记」就是天然的「期末复习问答」（跨全部课堂录音提问）。

**底层技术**：自研 ASR（未公开细节），云端处理。

**定价**（官方 otter.ai/pricing，2026-10 直连核实）：Basic Free：300 分钟/月转写、3 个终身音视频文件导入、实时转写、说话人识别、AI Chat、会议集成、多语言、Otter MCP server。Pro **$16.99/月/人**，年付 **$8.49/月**（省 50%）：1200 分钟应用内录音/月、10 个文件导入/月、单会 ≤90 分钟、高级 AI 工作流、团队词表与可标记说话人、高级搜索/导出/回放、无限存储。Business **$30/月**，年付 **$24/月**：无限会议与录音、无限文件导入、单会 ≤4 小时、3 场并行、管理功能、优先支持。Enterprise 定制。**教育折扣：.edu 邮箱 Pro 8 折**。

**值得借鉴**：①「跨会 AI Chat」把转写库变成可问答知识库；②团队词表（课堂场景=课程术语表）；③教育折扣（.edu 8 折）证明教育市场是被验证的付费群体；④免费档给足 300 分钟/月做大漏斗。

**值得避免的坑**：隐私政策（2026-06-16 版）称可用去标识化录音/转写训练 AI，**仅 Enterprise 默认退出训练**——数据训练争议是云产品的原罪，恰是我们「本地优先、不训练」的对照话术。

**来源**：https://otter.ai/pricing ；https://theaiagentindex.com/agents/otter-ai

### 2. Fireflies.ai

**定位与目标用户**：会议转写 + conversation intelligence（对话情报），销售团队是重点（BANT 模板、CRM 集成），2016 年创立，2025-03 达 1600 万用户，官方宣称 95% 准确率，7 天免费试用。

**核心功能**：转写之外最完整的是「总结与分析」：总结模板体系（1:1 / Team Meeting / BANT / Standup / 自定义章节如 Progress Review，模板可「Save and Apply」复用）；行动项提取（带时间戳、可校验编辑）；AskFred（按发言者提问的 AI 问答）；说话占比与谈话时长分析；情感分析；评论协作。转写导出 PDF/DOCX/CSV/JSON/SRT，总结导出 DOCX/PDF/MD/JSON，音频导出 MP3。

**UI 布局与交互亮点**：**点击转写文本即跳转到对应音频位置并红色高亮**——词级定位是「讲义笔记」必须抄的交互（与飞书妙记一致）；自定义章节让 AI 总结按用户指定的结构产出，而非自由发挥。

**底层技术**：自研 ASR（未公开）；Notetaker Bot 入会录制（录音+视频），Chrome 扩展则只录音频、侧边栏实时转写；Auto-join 按日历自动入会。

**定价**（官方 fireflies.ai/pricing + guide.fireflies.ai，2026-08-14 核实）：Free：3 个转写 credits（Chrome 注册 5 个、手机注册 10 个）、Auto-join 日历开启后转写无限（仅总结耗 credit）、400 分钟存储/team、AskFred、100+ 语言、API 50 请求/天。Pro **$18/月**，年付 **$10/月**：无限 credits、8,000 分钟存储/席、下载转写/总结/录音、谈话时长分析、20 AI credits、API 500 请求/天；上传文件速率 3,000 分钟/月/源，超额 $0.01/min。Business **$29/月**，年付 **$19/月**：无限存储、视频录制、多语言模式、conversation intelligence、情感分析、说话占比、CRM、30 AI credits、API 60 请求/分钟。Enterprise **$39/月**：SSO/SCIM、HIPAA、私有存储、审计日志、50 AI credits。**2026-09-01 起新注册用户才受 credit 体系约束（老用户无限）**——这种「老用户不动、新用户上量」的迁移手法值得学，但 credit 体系本身复杂，用户学习成本高。

**值得借鉴**：①总结模板+自定义章节（课堂可做「章节/重点/例题/作业」模板）；②点击跳转音频+高亮；③行动项带时间戳可校验；④安全全家桶（SOC 2 Type II/GDPR/HIPAA/AES-256/0-day retention）是企业单的必要背书。

**值得避免的坑**：Notetaker Bot 偶发故障/迟到入会（机器人入会机制的可靠性问题）；免费档缺 AI 功能与 smart search，免费体验与付费能力割裂感强。

**来源**：https://fireflies.ai/pricing ；https://guide.fireflies.ai/articles/1055386295-learn-about-transcription-credits?lang=en ；https://geekflare.com/software/fireflies-review/

### 3. Notta.ai

**定位与目标用户**：日本团队做的全球会议转写工具（官网 1000 万+ 用户），主攻日系与国际市场的转写+翻译，日英双语场景强。

**核心功能**：58 语言转写；实时转写与文件转写；说话人识别；翻译（单语实时翻译与双语转写翻译为 Pro 加购项）；**差异化最强的是「转写后产出」：从转写内容直接生成 PPT 演示文稿、信息图（Infographics）、跨录音 Insights（把多段录音聚合出洞察）**；硬件周边 Notta Memo（卡片式录音机）；集成 Zoom/Meet/Teams/Webex/Slack/Notion/Salesforce/Zapier/Dropbox/Drive/ClickUp/HubSpot。

**UI 布局与交互亮点**：转写→PPT/信息图的一键产出是「转写不是终点、是原材料」的最激进实现；跨录音 Insights 相当于 Fireflies「跨会问答」的自动化版本。安全合规：SOC-2/GDPR。

**底层技术**：自研 ASR（未公开），云端处理。

**定价**（官方 support.notta.ai，2026-09-05 更新）：Free $0：120 分钟/月、单次会话 ≤3 分钟、50 文件上传/月、10 AI 总结/月。Pro **$13.49/月**，年付 **$97.99（$8.17/月）**。Business **$27.99/月/席**，年付 **$199.99（$16.67/月）**。Enterprise 定制（51 席起）。加购（仅 Pro+）：单语实时翻译 $10/月（$72/年，100 次/月）；双语转写翻译 $15/月（$108/年，200 次/月）；Notta Brain Pro $12.90/月（$93.59/年，8,000 AI credits/月）。有教育折扣文章入口。

**值得借鉴**：①「翻译」作为独立加购 SKU（留学生/外语课堂是真需求）；②转写→演示文稿的产出思维（讲义笔记可做「转写→复习讲义/导图」）；③教育折扣入口的存在说明学生是目标客群。

**值得避免的坑**：加购项多且相互独立（翻译、AI 各收一份钱），价格体系复杂；免费档单次会话仅 3 分钟，基本只够体验。

**来源**：https://support.notta.ai/hc/en-us/articles/55339089140123-Understand-Notta-s-Plans-Pricing ；https://www.notta.ai/en/pricing ；https://www.notta.ai/en

### 4. Descript

**定位与目标用户**：播客/视频创作者的一体化音视频编辑工具，核心卖点是「编辑转写稿=编辑音视频」。与我们重叠的是其转写与 AI 能力，编辑工作流不同。

**核心功能**：转写 25 语言；8+ 说话人检测（Speaker Detective）；多轨转写（多轨会话按轨数倍乘计费）；文本编辑视频（删文字=剪音频，行业首创）；Studio Sound（降噪/音质修复）；Underlord（AI 助手，Creator 档全量）；Overdub（AI 声音克隆）；翻译配音（Business 档 30+ 语言）；导出时间线到 Premiere/Final Cut/Resolve；集成 Ecamm/Restream/SquadCast/Zoom；发布到 YouTube/HubSpot/Wistia 与多播客托管；API+Zapier+MCP（beta）；无原生移动 App。

**UI 布局与交互亮点**：「转写稿即时间线」的编辑范式值得抄其心智——用户改文本即改成品，零学习成本；Speaker Detective 把 8+ 说话人自动标注为行业标杆。

**底层技术**：自研 ASR + AI 编辑栈（未公开细节），云端处理。

**定价**（官方 descript.com/pricing，2026-10 直连核实）：Free $0：1 小时/月媒体、100 一次性 AI credits、水印导出。Hobbyist **$16/人/月**：10 媒体小时、400 AI credits、1080p 无水印。Creator **$24**：30 小时、800 credits、4K、Underlord 全量。Business **$50**：40 小时、1500 credits、Brand Studio、30+ 语言翻译配音。Enterprise 定制（SOC 2 Type II/SSO/SCIM）。「媒体分钟」=导入或录制的音频分钟，AI credits 另算。

**值得借鉴**：①「媒体分钟」与「AI credits」双账户的**分层收费结构**（转写按分钟、AI 按动作）——但要注意其执行方式被骂；②Speaker Detective 的说话人标注质量是竞品口碑来源；③导出时间线到专业工具的「不锁死」姿态。

**值得避免的坑**（第三方评测 hackceleration，15 条 Trustpilot/G2 评论，总评 3.4/5，推荐率 47%）：①**2025-09 定价改革被骂**：转写小时改媒体分钟，多轨会话按轨数倍乘（1 小时多轨访谈可耗 4+ 媒体分钟）；②AI credits 单次消耗不在 App 内披露，400 credits 被用户 15 分钟烧光，超额约 $0.05–$0.10/个；③48 小时退款政策无例外（未用订阅也不退）；④年付按钮小、有用户误点花了 €192；⑤稳定性差（卡顿、Studio 上传失败、项目回退到未编辑状态）；⑥Underlord 过度编辑需手工撤销；⑦Overdub 长句机械、Hobbyist/Creator 限 1000 词词表。

**来源**：https://www.descript.com/pricing ；https://hackceleration.com/labs/review/descript

### 5. TurboScribe

**定位与目标用户**：主打「无限转写」的云端转写工具，面向个人与团队的海量转写需求（播客、访谈、课程录像批量转）。

**核心功能**：转写之外：翻译 134+ 语言；无限存储；批量上传（一次 50 个文件）；单文件 ≤10 小时、≤5GB。**无 API，只能浏览器上传**。底层引擎为 Whisper 系（第三方评测口径：「everyone's running the same engine」）。

**UI 布局与交互亮点**：极简「上传→排队→转写→下载」线性流，无会议集成、无 AI Chat——它证明「纯转写批发」也能成立一个产品，但价值天花板低。

**定价**（官网 turboscribe.ai 对爬虫 403，经官方 help 文章与第三方评测核实）：Free：每天 3 条、每条 30 分钟、一次一条、低优先级。Unlimited **$20/月**，年付 **$10/月（$120/年）**：文件 ≤10 小时、≤5GB，一次可传 50 个，无限存储，翻译 134+ 语言。**Unlimited Max（2025-12-02 发布，$200/月或 $2,000/年，10 倍专用容量）不在定价页展示**，只在 help 文章里。软限制：日超约 24 小时音频或 top 0.1% 用量会进 High Volume Mode，一次只转 1 个文件，可能拒传（「Try again later」）。

**值得借鉴**：①「无限」的心理锚点与真实的软限制之间的平衡术（High Volume Mode 是成本护栏）；②批量 50 个文件的排队 UI 值得学（课堂一学期录音批量转）。

**值得避免的坑**：①**订阅取消陷阱是最大槽点**：26 条一星差评中 15 条「取消后仍扣费/自动续费无告知」、10 条退款被拒、有 $120 年付被扣 $240 案例、客服不回 9 条；②无公开退款政策；③无 API，无法嵌入工作流。

**来源**：https://whisperai.com/blog/turboscribe-review ；https://turboscribe.ai/help/turboscribe-unlimited-max ；https://turboscribe.ai/help/tips-for-transcribing-extremely-large-volumes

### 6. MacWhisper（最接近的同类，重点）

**定位与目标用户**：Mac 本地 Whisper 桌面工具，开发者 Jordi Bruin / Good Snooze，2023 年初发布。定位是「文件转写」为主（实时听写是次要功能），与「讲义笔记」同为「本地优先转写桌面工具」，**但仅 macOS，Windows 无官方版本**——这是它最大的盲区，也是我们的窗口。

**核心功能**：文件/文件夹/批量转写；YouTube URL 转写；自动说话人识别；系统音频录制；系统级听写（全局输入到任意文本框）；watch folder 自动转写；会议检测（Zoom/Teams/Webex/Skype/Discord/Chime）自动录音；SRT/VTT 字幕导出（Pro 加 MD/PDF/HTML/DOCX）；BYOK AI（自带 OpenAI/Anthropic/Google/Groq 的 API key 做清理/总结/翻译）；模型支持 OpenAI Whisper（免费版 Base/Small，Pro 解锁全部含 large-v3/v4）+ **Nvidia Parakeet 模型（具体变体未公开）**；MDM 支持；CLI。

**UI 布局与交互亮点**：watch folder（拖进文件夹自动转）与会议检测（检测到会议就问是否录音）是「零操作转写」的典范；BYOK 把云端 AI 成本转嫁给用户，产品只卖本地能力——这是「本地买断+云端按量」架构的现成参照。

**定价与授权**（官方 docs.macwhisper.com + Gumroad + App Store 条目，2026-08~09 核实）：**双渠道双模式**——①Gumroad 直购「MacWhisper」：Free 永久免费（仅 Tiny/Base 小模型、基础转写）；**Pro €64 一次性买断、终身更新**。含全部 Whisper 模型、批量文件夹、YouTube 转写、自动说话人识别、字幕导出、系统音频录制、系统级听写、watch folder、BYOK AI、会议检测、MDM、license key 激活可跨 Mac。批量 5/10/20/50 席位折扣；**学生/记者/非营利 25% 折扣（€48，发邮件索取）**。②App Store「Whisper Transcription」：$6.99/月、$29.99/年、$99.99 终身 IAP（另有 $89.99 档）；Assistant（AI 云订阅）$5.99/周、$9.99/月、$89.99/年；Pro+Assistant 合订 $12.99/月。App Store 版限制：AI 供应商选项少（苹果政策）、无系统级听写、无 MDM。iOS 版免费全本地模型+BYOK。App Store 评分 3.9/5（158~164 评）。

**值得借鉴**：①**€64 买断 + 学生 25% 折扣**是被验证的本地转写定价锚点；②「本地能力买断 + 云端 AI 订阅/BYOK」双轨收入结构；③双渠道策略（Gumroad 直购放全功能与 license key，App Store 放订阅）绕过平台抽成与政策限制；④会议检测自动录音；⑤watch folder。

**值得避免的坑**：①仅 macOS（Windows 市场空白）；②双 SKU 让用户困惑（官方专门写 help 文章解释差异）；③App Store 版评分仅 3.9/5，说明订阅档的性价比感知一般；④BYOK 模式对普通用户有门槛（要自己搞 API key）。

**来源**：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://www.getvoibe.com/resources/macwhisper-pricing/ ；https://www.promptquorum.com/zh/power-local-llm/macwhisper-review ；https://goodsnooze.gumroad.com/l/macwhisper

### 7. 开源本地桌面工具（Whisper Desktop / Buzz / Vibe / Aiko）

**Const-me/Whisper（Whisper Desktop）**：10,679★，MPL-2.0，C++，Windows 本地 GPGPU 转写工具。技术亮点：whisper.cpp 的 Windows 移植，**纯 D3D11/DirectCompute 计算着色器，零运行时依赖（Whisper.dll 仅 431KB，对比 PyTorch+CUDA 9.63GB）**；GTX 1080Ti 上 3:24 音频用 medium 模型 19 秒转完；Media Foundation 音频处理；VAD 录音捕获延迟 5-10 秒；内置着色器性能分析器；NuGet 包 WhisperNet（C# 封装）。**关键教训：作者置顶声明开源版 2023 年起停更，已转向闭源商业后继版（AOT 编译 C# 引擎、Direct3D 12+Vulkan 1.3 后端、VoxTral Mini 4B Realtime 模型、免费 30 天试用+一次性买断）**——开源→闭源商业化的完整样本，也说明「本地转写桌面工具」有商业化空间。**安全警告：whisperdesktop.com 是冒充本项目官网的钓鱼站，勿信**——我们上线时也要防冒名站。

**chidiwilliams/buzz**：22,001★，MIT，Python，跨平台离线转写+翻译。功能：音视频文件/YouTube 转写；**麦克风实时转写+演示窗（Presentation window，无障碍设计）**；转写前语音分离（降噪）；说话人识别；多后端（CUDA/Apple Silicon/Vulkan 含集显）；HF Whisper 模型族；导出 TXT/SRT/VTT；高级转写查看器（搜索/回放/调速）；快捷键；watch folder；CLI；插件系统（AI 总结、转写 resize）。分发：SourceForge（Windows exe 未签名）、Flatpak/Snap/AppImage、PyPI（Python 3.12，GPU 需手动装 cu129 版 torch）。仅 29 个 open issues（质量信号好）。

**thewh1teagle/vibe**：7,786★，MIT，Tauri（Rust 核心 whisper.cpp），跨平台。功能：全离线；音视频+网站链接（YouTube/Vimeo/Facebook/Twitter）；批量；导出 SRT/VTT/TXT/HTML/PDF/JSON/DOCX；实时预览；模型=Whisper/Nemotron 3.5/Parakeet TDT v3；**Claude API 总结（多语言摘要）+ Ollama 本地 AI 分析/批量总结**；翻译成英文；直接打印；**自动更新**；GPU 优化（Vulkan/CoreML）；自定义模型（设置页+vibe://download/?url= 协议）；说话人分离；稳定时间戳模式（VAD-backed）；麦克风/系统音频转写；CLI；**手机扫码录音（QR，无需装 App，电脑转写后回传）**；HTTP API（Swagger）。这是「本地转写+可选云 AI」架构最接近我们的开源先例。

**Aiko（sindresorhus）**：闭源免费 App（无 GitHub 仓库），macOS/iOS/visionOS，App Store id 1672085276，2023-03-03 发布。端侧 Whisper（macOS 用 large-v2，iOS 按内存用 medium/small）；100 语言；导出 JSON/CSV/SRT；**不支持编辑（官方建议导出后用专业编辑器）、无实时转写、无说话人分离（等 whisper.cpp #64）**、翻译仅到英文；开发者 FAQ 坦白 Whisper 幻觉（尾句「Thanks for watching!」）与简繁中文不分、v3 试过因质量更差回退 v2；**Shortcuts 深度集成**（批量转写/Finder 右键 Quick Actions/菜单栏全局快捷键→剪贴板）；非 App Store 版 1.6.0 约 3GB（macOS 14+），一年一更无自动更新，App Store 版正常自动更新；原生 Swift/SwiftUI。教训：打包本地模型的应用体积大（3GB）、手动更新渠道的用户体验差、端侧模型幻觉要提前管理预期。

**来源**：https://github.com/Const-me/Whisper ；https://raw.githubusercontent.com/chidiwilliams/buzz/main/README.md ；https://github.com/thewh1teagle/vibe ；https://raw.githubusercontent.com/sindresorhus/sindresorhus.github.com/92fce2c22fe261a4b08e01acf418094f4ec6fc8f/source/content/apps/aiko.md

---

## 四、Whisper 开源生态逐个详解

### 8. openai/whisper 与 OpenAI API 语音定价

**定位与地位**：Whisper 是 OpenAI 2022-09 开源的通用语音识别模型（110,527★，MIT，Python，pushed 2026-08-31），是整个本地转写生态的源头与事实标准。68 万小时弱监督训练，多语言+翻译（X→en）双任务。虽然官方仓库已进入维护期（2026 年后主推云 API），其权重格式（ggml 转换后）仍是 whisper.cpp/faster-whisper 等一切下游的原料。

**OpenAI 云 API 语音定价（2026-10 现状，多来源交叉核实）**：
- **gpt-transcribe $0.0045/分钟**（2026-07-28 发布，文件/批量转写，25MB 上限，支持 mp3/mp4/mpeg/mpga/m4a/wav/webm）——取代 whisper-1 成为推荐默认。
- **gpt-live-transcribe $0.017/分钟**（低延迟实时流式）。
- 旧模型：whisper-1 $0.006/分钟；gpt-4o-transcribe $0.006/分钟；gpt-4o-mini-transcribe 约 $0.003/分钟；gpt-realtime-whisper $0.017/分钟。
- **关键风险：2026-08-26 OpenAI 宣布 whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe / gpt-4o-transcribe-diarize 于 2027-02-26 从 API 移除**；快照 gpt-4o-mini-transcribe-2025-03-20 提前至 2027-01-20。**新模型缺少词级时间戳、SRT/VTT 字幕、说话人分离、英译**——这些能力官方指南仍指向即将退役的旧模型，无公布替代。
- 质量基准（官方口径）：Common Voice 22 语言 GPT-Transcribe WER 19.27% vs whisper-1 40.37%；真实世界音频 9 语言 8.98% vs 15.21%；Context Aware ASR 语义准确率 41.6%→45.2%（有上下文提示时）。
- 上下文感知：gpt-transcribe 支持 prompt/keywords[]/languages[] 推理时提示（术语表防错，课堂专业词可用）。

**对我们产品的启示**：①**云 API 路线不可持续依赖**——字幕/说话人分离必须由本地引擎生成（这正是我们 WebGPU 本地 Whisper 的定位）；②gpt-transcribe 的「关键词列表防错」证明「课程术语表」是有官方背书的刚需；③$0.0045/min 意味着 1 小时课堂云端转写约 $0.27，作为「本地失败时的云端兜底」成本可接受。

**来源**：https://alphasignal.ai/news/openai-replaces-whisper-with-gpt-transcribe-slashing-errors-by-52 ；https://distk.in/blog/openai-whisper-transcribe-shutdown-2027.html ；https://www.ithome.com/0/982/801.htm ；https://www.gigazine.net/gsc_news/en/20260729-gpt-live-transcribe/ ；https://developers.openai.com/api/docs/pricing （官方，直连 403，内容经上述来源转述）

### 9. whisper.cpp（ggml-org）

**定位与活跃度**：纯 C/C++ 无依赖的 Whisper 推理实现，54,404★，MIT，pushed 2026-10-12（活跃），6,252 forks。**本地桌面产品的事实标准引擎**：无 Python、无运行时依赖、可静态编译，是「讲义笔记」这类「零依赖便携 Windows 应用」的最优底层。

**量化支持**：F16/F32 混合 + **整数量化（q5_0 等，自带 quantize 工具）**。模型体积（磁盘/内存）：tiny 75MiB/~273MB；base 142MiB/~388MB；small 466MiB/~852MB；medium 1.5GiB/~2.1GB；large 2.9GiB/~3.9GB。模型托管在 huggingface.co/ggerganov/whisper.cpp。

**后端支持**：Apple Silicon 一等公民（NEON/Accelerate/Metal；**Core ML：编码器跑 ANE 比纯 CPU >3×**；ANEForge 直连 ANE 比 Core ML 编码器快约 2×，PR #3905）；x86 AVX；POWER VSX；Vulkan；NVIDIA CUDA（cuBLAS+自定义 kernel，RTX5000 系需 CMAKE_CUDA_ARCHITECTURES=86）；AMD ROCm/HIP；OpenVINO（编码器跑 Intel CPU/GPU，推荐 2026.3.0）；**AMD Ryzen AI NPU（VitisAI/FlexML，Win11+Linux，-DWHISPER_VITISAI=1）**；Ascend NPU（CANN）；Moore Threads（MUSA）；OpenBLAS（CPU 编码器）。

**周边能力**：Silero VAD v6.2.0（ggml 约 864KB，阈值/最小语音/静音/最长段拆分/padding/overlap 参数，`--vad`）；tinydiarize（small.en-tdrz，实验性说话人切分 [SPEAKER_TURN] 标签）；`--print-colors` 低置信词着色（**置信度可视化的现成实现**）；`-ml 1` 词级时间戳；`-owts` 卡拉OK字幕视频；whisper-server（HTTP，OpenAI 兼容 API）；whisper-stream（实时，SDL2）；多语言绑定（whisper-rs / whisper.net / JS / Swift / Java JNI）；XCFramework v1.7.5（Apple 全家桶）。

**对我们产品的意义**：①**WebGPU/WASM 之外的兜底与性能参照**：Windows 原生加速（CUDA/D3D/OpenVINO/NPU）路径可走 whisper.cpp DLL 调用，与浏览器 WebGPU 双引擎共存；②VAD 参数（padding/overlap/最长段）直接决定课堂长录音的分段质量；③`--print-colors` 是「低置信词高亮」的原型——讲义笔记的「可信度标注」可以直接对标。

**来源**：https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md ；https://api.github.com/repos/ggml-org/whisper.cpp

### 10. faster-whisper（SYSTRAN）

**定位与活跃度**：CTranslate2 加速的 Whisper 推理，25,864★，MIT，Python，pushed 2026-10-13（活跃）。宣称**「up to 4 times faster than openai/whisper for the same accuracy while using less memory」**，CPU/GPU 均支持 8-bit 量化。

**官方基准（13 分钟音频，large-v2，RTX 3070 Ti 8GB，CUDA 12.4）**：openai/whisper fp16 2m23s/4708MB；whisper.cpp fp16 1m05s/4127MB；transformers SDPA fp16 1m52s/4960MB；faster-whisper fp16 1m03s/4525MB；**fp16 batch_size=8 17s/6090MB**；int8 59s/2926MB；**int8 batch8 16s/4500MB**。CPU（i7-12700K 8 线程，small 模型）：openai/whisper fp32 6m58s/2335MB；whisper.cpp fp32 2m05s/1049MB；whisper.cpp OpenVINO 1m45s/1642MB；faster-whisper fp32 2m37s/2257MB；**fp32 batch8 1m06s/4230MB；int8 1m42s/1477MB；int8 batch8 51s/3608MB**。distil-large-v3 长任务：faster-whisper batch16 25m50s WER 13.527 vs transformers batch16 46m12s WER 14.801。

**技术细节**：Python 3.9+；无需系统 FFmpeg（PyAV 自带）；GPU 需 cuBLAS CUDA12+cuDNN9（ctranslate2 4.4.0 兼容 CUDA12/cuDNN8，3.24.0 兼容 CUDA11）；**内置 Silero VAD（vad_filter=True，批量转写默认开）**；word_timestamps=True 词级时间戳；distil-large-v3 兼容；Windows 可用 Purfview/whisper-standalone-win 的 CUDA 库压缩包。生态集成：aTrain（格拉茨大学 GUI，Windows Store 上架，转写+说话人分离）、WhisperLive、whisper_streaming（实时）、speaches（OpenAI 兼容 server）。

**对我们产品的意义**：①**批量转写时 batch+int8 是速度关键**（batch8 比单条快 3~4×，且 int8 在 CPU 上内存减半）——讲义笔记的「一学期录音批量转」必须做批处理与量化；②vad_filter 默认开启是「先切语音段再转写」的标准实践；③**aTrain 是「学术机构用 faster-whisper 做的 Windows Store 转写 GUI」先例**，与我们的定位几乎一致（学术/课堂场景），值得研究其 UI。

**来源**：https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md ；https://api.github.com/repos/SYSTRAN/faster-whisper

### 11. whisperX（m-bain）

**定位与活跃度**：词级时间戳对齐 + 说话人分离的 Whisper 扩展，24,556★，BSD-2-Clause，Python，pushed 2026-09-26。宣称 large-v2 **70× realtime**（faster-whisper 后端，large-v2 beam5 <8GB 显存）。

**技术架构**：faster-whisper 转写 → **wav2vec2 强制对齐（forced alignment）产出词级时间戳** → **pyannote-audio 说话人分离（需 HF token 并同意 speaker-diarization-community-1 gated 协议）**；VAD 预处理降幻觉不损 WER；INTERSPEECH 2023 论文 + Ego4d 转写挑战第 1 名；2026 年新增 Context-Aware Batching（interleaved_context=True / condition_on_previous_context 提升标点与专名）。要求 CUDA 12.8；pip install whisperx 或 uvx。

**已知局限（README 自述）**：数字/符号词无法对齐时间戳；重叠语音处理差；说话人分离不完美；对齐模型按语言（默认 en/fr/de/es/it 走 torchaudio，其余走 HF，中文需自找 wav2vec2 音素模型）。

**对我们产品的意义**：①**词级时间戳 = wav2vec2 对齐**这条路线是精度标杆，但中文需要额外音素模型，工程成本高——讲义笔记课堂场景可用 whisper.cpp `-ml 1` 的词级时间戳作为轻量替代；②**pyannote 的 gated 协议意味着说话人分离不能开箱即用**，课堂「老师/学生」两角色可用声纹阈值/VAD 简化为自研；③其 README 顶部 Recall.ai 赞助横幅（靠平台原生音轨 100% 准确分离）说明「高质量分离靠音轨来源」而非纯算法——课堂单麦克风录音注定只能做粗分离，预期管理要诚实。

**来源**：https://raw.githubusercontent.com/m-bain/whisperX/main/README.md ；https://api.github.com/repos/m-bain/whisperX

### 12. Vosk / sherpa-onnx（离线小模型方案）

**Vosk（alphacep/vosk-api）**：15,175★，Apache-2.0，Kaldi 系离线 ASR 工具包，pushed 2026-10-15（活跃），20+ 语言。**模型小（约 50MB）**、连续大词表转写、**零延迟流式 API**、可重配词表、说话人识别；绑定 Python/Java/Node.JS/C#/C++/Rust/Go；从树莓派/安卓到集群。适合嵌入式与低端设备，但转写质量与 Whisper 有代差，中文模型质量一般。

**sherpa-onnx（k2-fsa）**：15,290★，Apache-2.0，C++，pushed 2026-10-15（**非常活跃**）。本地全栈：STT（流式+非流式）/TTS/源分离/说话人识别/分离/验证/语种识别/音频打标/VAD/KWS/标点/语音增强；x86/x64/arm32/arm64/riscv64；Win/macOS/Linux/Android/WearOS/iOS/HarmonyOS/openKylin；**12 种语言 API**；Flutter+Tauri 预构建 demo；NPU：Rockchip RKNN/Qualcomm QNN/Ascend/Axera/Intel OpenVINO；WASM+中国镜像；预训练模型含 Whisper tiny.en、**SenseVoice（中英日韩粤，支持方言）**、Paraformer 中文、Zipformer CTC 中文 int8、Moonshine。案例：中国联通/中国人寿 App（KWS）、deepseek-harness（经 sherpa-onnx-node 用 SenseVoice）、SmartSub（本地字幕流水线）、Fono、Speed of Sound（Linux 语音打字）。模型下载走 GitHub releases（asr-models tag）。

**对我们产品的意义**：①**中文课堂场景 SenseVoice 是重要备选**：FunASR 官方 micro-CER 口径 SenseVoiceSmall 7.81 vs whisper.cpp large-v3-turbo 23.15，中文直用 Whisper 错字率高——讲义笔记若主打中文课堂，「本地 Whisper + 清洗 + 大模型校对」与「SenseVoice 引擎」两条路都要评估；②sherpa-onnx 的 12 语言 API 与 WASM 支持意味着**它也可以跑进浏览器**（与我们的 WebGPU 路线兼容）；③Vosk 的「可重配词表」思路=课程术语表热插拔。

**来源**：https://raw.githubusercontent.com/alphacep/vosk-api/master/README.md ；https://alphacephei.com/vosk ；https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/README.md ；https://api.github.com/repos/{alphacep/vosk-api,k2-fsa/sherpa-onnx}

---

## 五、ASR API 定价横向对比（云兜底/可选项）

| 厂商 | 模型/产品 | 价格 | 口径 | 卖点/硬伤 |
| --- | --- | --- | --- | --- |
| Cloudflare Workers AI | @cf/openai/whisper | **$0.0005/min** | 音频分钟 | 最便宜；仅批量、无说话人分离、无自定义词表 |
| Deepgram | Nova-3 Monolingual | **$0.0048/min**（促销，原 $0.0077） | 流式音频分钟 | WSS 并发免费 50/付费 225；免费 $200 credit |
| OpenAI | gpt-transcribe | **$0.0045/min** | 文件/批量音频分钟 | 无字幕/说话人/英译（旧模型 2027-02-26 退役） |
| Groq | Whisper Large v3 Turbo | **$0.04/hr**（第三方转述） | 音频小时 | 号称比 OpenAI 便宜 9×（第三方口径） |
| AssemblyAI | Universal-3.5 Pro | **$0.21/hr** | 预录音频小时 | 加购堆叠：说话人 +$0.02/hr、医疗 +$0.15/hr、翻译 +$0.06/hr |
| AssemblyAI | Universal-3.6 Pro Realtime | **$0.45/hr** | 流式会话小时 | 按 WebSocket 会话时长计费（非音频时长） |
| AWS | Transcribe 标准 | **$0.024/min** | 音频分钟 | 首 250k 分钟/月；流式 $0.018/min、医疗 $0.075/min |

**结论**：①云转写价格已低到「本地转写的成本优势不在转写本身，而在隐私、无网可用、无限量」；②Cloudflare $0.0005/min（≈$0.03/hr）是最便宜批量兜底，但功能裸奔——作为「本地失败自动云端补位」的可选项最划算；③**OpenAI 生态的 API 不稳定（旧模型退役、能力缺失）**，不应把任何核心体验绑定在单一云厂商；④Deepgram/AssemblyAI 的「加购堆叠」证明行业把说话人/翻译/医疗等能力当独立 SKU 卖，我们也应把「AI 整理能力」逐项定价。

**来源**：https://developers.cloudflare.com/workers-ai/platform/pricing/ ；https://deepgram.com/pricing ；https://www.assemblyai.com/llms/pricing.md ；https://jakeinsight.com/ai/2026-05-19-cloudflare-workers-ai-whisper-transcription-cost-p/ ；https://omr.com/en/reviews/product/groq/pricing ；https://github.com/bis-code/groq-whisper-mcp

---

## 六、可借鉴清单（对「讲义笔记」）

> 每条按「现象与证据 → 为什么成立 → 落地到讲义笔记的具体动作」展开。

### （一）UI / 交互组（8 条）

1. **词级点击定位 + 低置信高亮**。Fireflies 的转写页点击任意文本即跳转到对应音频位置并以红色高亮当前句（geekflare 评测核实）；国内飞书妙记是同一交互的最优实现，「点击文字→播放定位」是双向联动。为什么成立：转写稿是长文本，用户找一段录音最自然的动作就是「点字」，没有这个交互的转写工具只能靠进度条硬拖，可用性断崖。技术前提比想象中便宜：whisper.cpp 自带词级时间戳（`-ml 1`）和低置信词着色（`--print-colors`），我们本地引擎已能产出词级对齐，剩下的是前端「词→时间」映射。落地动作：①转写正文每个词可点击跳播放并高亮当前句；②置信度低于阈值的词标黄/下划线，悬浮显示「AI 不确定，请核对音频」——这是把 whisper.cpp 的官方能力变成我们的信任卖点；③同一交互复用到「AI 摘要的每句话」，点摘要条目跳回逐字稿对应段（AI 产物可回溯的 UI 载体）。来源：https://geekflare.com/software/fireflies-review/ ；https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md

2. **章节速览 + 点击跳片段 + 自定义总结结构**。通义听悟的「章节速览」产出带时间戳的章节列表、点击跳转对应片段；Fireflies 把总结做成模板体系（1:1/Team Meeting/BANT/Standup），且支持「自定义章节」和「Save and Apply」保存复用。为什么成立：学生对 90 分钟课堂录音的第一需求不是读全文而是「这节课讲了哪几块、每块在第几分钟」，章节列表就是转写稿的目录；模板化让 AI 输出结构可预期，比自由发挥更接近「笔记」而非「小作文」。落地动作：①AI 整理默认产出「章节速览（时间戳+点击跳转）」作为第一个产物；②为课堂定制总结模板：「章节/核心概念/例题/课堂提问/作业布置」五段式，用户可自建模板并保存复用；③模板选择器放在 AI 面板顶部（一个下拉框），而非藏在设置里——Fireflies 的教训是「结构化的总结」必须低门槛触发。来源：https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules （功能口径见通义听悟官方文档）；https://geekflare.com/software/fireflies-review/

3. **三栏布局 + 右栏 AI 面板**。Otter 的界面是「会议列表/转写正文/AI Chat」三栏；通义听悟是「原文区 + 上方 AI 产物条 + 右侧文档编辑栏」，重点内容标记后可「一键提取到右侧编辑器」。为什么成立：转写工具的信息密度高，固定区域比弹窗更适合「边读边整理」的工作流；「左原文、右笔记、AI 产物在侧栏」是会议转写行业收敛出的最优解，我们的三栏（列表/笔记/转写）方向正确，缺的是 AI 能力的位置。落地动作：①在右侧笔记栏旁增加可折叠「AI 面板」，容纳：跨录音问答、摘要、章节、导图四个 Tab；②AI 产物支持「提取到笔记」按钮（借鉴通义听悟的标记-提取工作流）——AI 生成的内容进入笔记栏后变成可编辑的 Markdown，用户保有最终编辑权；③面板默认折叠、生成结果以浮层预览，避免挤压转写正文空间。来源：https://otter.ai/pricing （产品能力口径）；https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules

4. **跨录音问答（AI Chat 跨会）**。Otter 的 AI Chat 分两层：会内问答（针对本场会议）与跨会问答（针对全部历史会议），后者是 Pro 的核心卖点之一；Notta 的「跨录音 Insights」是同一能力的自动化版本（多段录音聚合出洞察）。为什么成立：单场转写的问答价值有限，但「一个学期所有课堂录音」变成可提问的知识库，价值是数量级的提升；这正是「笔记工具」超越「转写工具」的分水岭——Fireflies 的 AskFred 同样把提问作为付费能力。落地动作：①「期末复习问答」入口：在课程视图下跨全部该课程的录音提问（「第三章讲了哪些例题？」「老师反复强调的重点是什么？」）；②本地优先的实现路径：先用云端大模型跑通（引用转写片段+音频时间戳作答，答案每句可点击回跳录音），长期评估本地 RAG（Ollama+嵌入）做完全离线版；③答案必须带「引用段落」格式，这是问答可信度的最低要求，也是我们与纯聊天机器人的差异。来源：https://theaiagentindex.com/agents/otter-ai ；https://www.notta.ai/en

5. **前三分钟免费试看**。讯飞听见的机器转写提供「前三分钟转写预览」免费试看机制——用户上传后先看到开头 3 分钟的转写质量，再决定是否付费（素材见国内报告 09-补充事实集）。为什么成立：转写质量是本地工具的第一决策变量，而「质量」无法用文案证明、只能让用户亲眼看；MacWhisper 的免费档（Tiny/Base 模型）本质上是同一策略的变体——先给一点、证明能力、再卖全量。落地动作：①未激活用户转写任意录音时，默认免费产出前 3 分钟完整结果（含时间戳、置信度标注），3 分钟后提示解锁；②试用结果必须真实可用（可复制、可跳转），而不是加水印的废料；③试看次数不限制、每次录音都送前 3 分钟——把「试看」变成习惯，转化在用户发现「后面的内容我也想有」时自然发生。来源：https://www.iflyrec.com/html/addMachineOrder.html （见 docs/research/09-补充事实集.md 第 3 节）

6. **转写→产物一键化（PPT/信息图/导图）**。Notta 的差异化卖点是「转写后产出」：从转写内容直接生成 PPT 演示文稿与信息图（Infographics），把转写当作原材料而非终点。为什么成立：学生真正的任务不是「得到逐字稿」而是「做出复习材料」；Notta 证明「一键产出」可以成为产品主卖点（官网首屏即宣传），而国内通义听悟的思维导图/章节速览是同逻辑的本地化实现。落地动作：①「一键生成复习讲义」：章节速览+关键词+例题汇总按模板拼成 Markdown 讲义，导出 PDF；②「一键生成思维导图」：章节结构映射为 Mermaid/Markmap，节点点击回跳录音（导图=大纲的视图，幕布范式）；③产物生成列为独立计费项（对齐通义听悟「大模型能力逐项计费」的结构），但每个产物都附「基于逐字稿」的溯源链接。来源：https://www.notta.ai/en ；https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules

7. **watch folder 零操作转写**。MacWhisper 的 watch folder 与 Buzz 的同类功能：指定一个文件夹后，新放入的音频自动转写，用户零操作；MacWhisper 还有「会议检测」——检测到 Zoom/Teams 等会议开始就询问是否录音。为什么成立：课堂场景的录音是规律性动作（每周同时间），「丢进去就行」把软件从工具变成流程的一部分；Const-me 开源版的 VAD 录音捕获（延迟 5-10 秒）证明桌面端全自动链路可行。落地动作：①「课程文件夹」：每个课程绑定一个本地文件夹+录音来源，拖入即转写、转完即进课程时间线；②配合手机扫码录音（见功能组第 7 条），手机录完回传后自动落入 watch folder；③转写完成的系统通知文案要克制（「《高数第 12 讲》转写完成，点击查看」），避免通知轰炸。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://raw.githubusercontent.com/chidiwilliams/buzz/main/README.md

8. **低置信度可视化与幻觉预期管理**。whisper.cpp 的 `--print-colors` 把低置信词着色输出；Aiko 开发者在官方 FAQ 里坦白 Whisper 的幻觉（尾句「Thanks for watching!」）与简繁中文不分、并解释 v3 因质量更差回退 v2——开源工具里最诚实的预期管理范本。为什么成立：转写不可能 100% 准确，用户对「错字」的容忍度取决于产品是否提前说清；Aiko 4.9 分口碑（言灵，见 09-补充事实集）与 MacWhisper 3.9 分之间的差距，很大程度来自预期管理而非引擎本身。落地动作：①转写页底栏常驻「准确率说明」（本机引擎在 XX 条件下的典型字准率，附测试条件，学 RecText AI 2 的「约 40dB 会议室、单说话人、一次验证」口径）；②低置信词着色+悬浮提示（同第 1 条）；③首次转写完成时引导用户「抽查 30 秒」核对质量，把「校对」变成产品内动作而非用户自发行为。来源：https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md ；https://raw.githubusercontent.com/sindresorhus/sindresorhus.github.com/92fce2c22fe261a4b08e01acf418094f4ec6fc8f/source/content/apps/aiko.md

### （二）功能组（7 条）

1. **课程术语表/热词库**。讯飞听见支持最多 200 个热词（单个 1-16 字符、总上限 1000 字符、仅中英文）；Otter Pro 含「团队词表」；OpenAI gpt-transcribe 原生支持 prompt/keywords[]/languages[] 推理时提示（官方基准显示有上下文时语义准确率 41.6%→45.2%）；Vosk 支持可重配词表。四路产品在同一功能上互相印证，说明「词表纠错」是转写行业的共识性能力。为什么成立：课堂录音的错误集中在专名（老师姓名、定理名、公式读法、教材术语），而这些词恰好可以事先收集——错误模式可预测=可针对性修复，比提升整体模型便宜一个数量级。落地动作：①每门课程一个术语表（默认从课程名+教材信息预填，用户可增删）；②转写后处理阶段用术语表做纠错替换（对齐讯飞「热词优化」的批量替换），并保留「原词→替换词」的修改痕迹供用户一键撤销；③若未来接云端引擎（gpt-transcribe），把同一术语表映射为 keywords[] 参数，实现本地云端同库。来源：https://www.iflyrec.com/html/addMachineOrder.html ；https://otter.ai/pricing ；https://distk.in/blog/openai-whisper-transcribe-shutdown-2027.html ；https://raw.githubusercontent.com/alphacep/vosk-api/master/README.md

2. **说话人「老师/学生」粗分离**。MacWhisper、Buzz、Vibe 三家本地工具都内置说话人识别；但 whisperX README 自述「重叠语音处理差、分离不完美」，其赞助商 Recall.ai 的卖点正是「靠平台原生音轨实现 100% 准确分离」——反证单麦克风录音的分离天花板有限。为什么成立：课堂录音是单麦克风（手机/电脑）采集，算法分离只能做到「粗细」，但「粗」对学生已经足够：把老师讲解与课堂提问分开标注，能显著提升检索效率；「只显示老师段落」是比「完美分离」更实用的诉求。落地动作：①用 VAD 切段+声纹能量阈值做「主讲/他人」二分类标注（不承诺多说话人）；②提供「只看老师段落」过滤器与「跳过空白/咳嗽/杂音」选项；③产品文案与 UI 里诚实标注「自动区分，可能误判，可手动改标」——学 Aiko 的坦白，避免 pyannote 式过度承诺；不做「说话人改名」的复杂交互，两角色标签即可。来源：https://raw.githubusercontent.com/m-bain/whisperX/main/README.md ；https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference

3. **批量转写 + 排队 UI + 量化加速**。TurboScribe 支持一次上传 50 个文件排队转写；faster-whisper 官方基准证明批处理的价值：RTX 3070 Ti 上 large-v2 fp16 单条 1m03s → batch8 17s；CPU（i7-12700K）fp32 2m37s → batch8 1m06s、int8 batch8 51s——批处理+int8 量化能把 13 分钟音频压到 51 秒，且内存减半（2926MB→1477MB 同场景对比）。为什么成立：学生「一学期录音批量转」是刚需（开学导入一学期、期末集中复习），队列体验决定产品是否被长期使用；本地引擎的批处理收益（3~4×）是免费的性能杠杆。落地动作：①「导入一学期」流程：一次拖入 N 个文件，队列面板显示进度/预计剩余时间/可插队；②本地引擎默认启用 int8 量化+批处理（batch=4~8 按内存自适应），把 faster-whisper 的官方结论直接落到我们的 WebGPU/WASM 引擎参数上；③队列失败项自动重试+单独标记原因（文件损坏/超长/格式不支持），不让一个坏文件卡死整队。来源：https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md ；https://turboscribe.ai/help/turboscribe-unlimited-max

4. **AI 整理逐项计费 + 可回溯**。通义听悟把大模型能力逐项计费（每项 0.064 元/小时：章节速览/全文摘要/发言总结/问答回顾/思维导图/待办/关键词/口语书面化各自独立叠加）；AssemblyAI 用加购堆叠（说话人 +$0.02/hr、翻译 +$0.06/hr、摘要 +$0.03/hr）；讯飞听见的「语篇规整」提供「选用/弃用」二态，规整稿以副本存在、永不覆盖原文。为什么成立：AI 能力是成本项，逐项计费让用户只为需要的买单，也给我们清晰的收入线；而「AI 产物覆盖原文」是 Descript Underlord 被骂的原因之一（过度编辑需手工撤销）——可回溯是 AI 笔记的底线。落地动作：①云端 AI 整理按「单次动作」明码标价（如摘要 X 元/次、章节 X 元/次），执行前展示消耗；②所有 AI 产物以「副本/侧栏卡片」形态存在，原文逐字稿永远是唯一数据源，产物随时可删除重生成；③AI 规整稿提供「一键对比」视图（左原文右规整），差异处高亮，用户逐条采纳。来源：https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules ；https://www.assemblyai.com/llms/pricing.md ；https://hackceleration.com/labs/review/descript

5. **导出格式分层**。MacWhisper 免费版导出 SRT/VTT/TXT，Pro 版解锁 Markdown/PDF/HTML/DOCX；Buzz 导出 TXT/SRT/VTT；Vibe 导出 SRT/VTT/TXT/HTML/PDF/JSON/DOCX 七种格式。为什么成立：导出格式是天然的权益分层工具（不损害核心体验、又明确感知「买了什么」）；SRT/VTT 对学生「做视频笔记/加字幕」是真需求（Vibe 的「稳定时间戳模式」专门为字幕级时间戳设计）；Markdown 是我们笔记生态的枢纽格式。落地动作：①免费档：TXT/SRT/VTT（对齐 MacWhisper）；买断档：Markdown/PDF/DOCX/HTML；②「导出到笔记」作为内部格式（Markdown 直入笔记栏）而非外部动作，把导出从「文件操作」升级为「工作流节点」；③字幕导出默认带「低置信词不标注」的干净模式与「带标注」的校对模式两种。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://github.com/thewh1teagle/vibe ；https://raw.githubusercontent.com/chidiwilliams/buzz/main/README.md

6. **BYOK 云端 AI + Ollama 本地 LLM 双轨**。MacWhisper 的 BYOK 机制（自带 OpenAI/Anthropic/Google/Groq 的 API key 做清理/总结/翻译）是其 Pro 版核心能力，App Store 版因苹果政策减少供应商；Vibe 支持 Claude API 总结（多语言摘要）+ Ollama 本地 AI 分析/批量总结。为什么成立：BYOK 让「本地优先」产品享受云端大模型能力而产品方零 API 成本、零数据中转责任——数据从用户机器直连用户自己的 API key，隐私话术无懈可击；Ollama 路线则覆盖「完全断网+隐私洁癖」用户。落地动作：①设置页「AI 引擎」三选：官方充值（我们代购云端额度）/自带 API key（OpenAI/DeepSeek/Kimi 等兼容接口）/本地 Ollama（自动探测 127.0.0.1:11434）；②BYOK 模式下明确提示「音频转写仍在本机，仅发送文本摘要请求」，让用户知道边界；③Ollama 模式自动降级：模型能力不足时用更短的提示词与更简单的任务（只摘要、不做导图）。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://github.com/thewh1teagle/vibe

7. **手机扫码录音回传**。Vibe 的 QR 录音：电脑端展示二维码，手机扫码后直接录音（无需安装 App），录音自动回传电脑并转写，结果回显。为什么成立：课堂录音的物理场景是「手机在讲台附近、电脑在宿舍/工位」——手机是最佳收音设备而电脑是最佳转写设备；「扫码即用」绕过开发手机 App 的成本（开发、上架、双端同步都是坑，Aiko 一年一更的手动更新就是反例）。落地动作：①「手机录音」按钮 → 电脑生成局域网二维码 → 手机浏览器打开即录音页面（MediaRecorder API），录完回传；②同一页面向下兼容「上传已有录音文件」（手机里已有的课堂录音直接传）；③回传完成后自动进入对应课程的 watch folder/时间线，与功能组第 1、7 条闭环。来源：https://github.com/thewh1teagle/vibe

### （三）技术选型组（7 条）

1. **引擎：浏览器 WebGPU/WASM Whisper 为主 + whisper.cpp DLL 为性能兜底**。whisper.cpp（54,404★、MIT、pushed 2026-10-12）是本地桌面推理的事实标准：纯 C/C++ 无依赖、运行时零内存分配、整数量化 q5_0、后端覆盖 NEON/AVX/CUDA/Vulkan/ROCm/OpenVINO/AMD NPU/Ascend；Const-me 的 Windows 移植证明其可在无 PyTorch 环境下跑 D3D11（Whisper.dll 仅 431KB，对比 PyTorch+CUDA 9.63GB）。我们「零依赖便携 + 浏览器跑模型」的路线与其同族——浏览器 WebGPU 覆盖 Chrome/Edge 87.82% 可用率，whisper.cpp DLL 作为 Windows 原生兜底（无 WebGPU/需极限性能时走 CUDA/OpenVINO/NPU）。落地动作：①主路径维持 WebGPU/WASM 本地引擎（已验证 0.40× 实时）；②引入 whisper.cpp 编译产物作为「高性能模式」可选项，检测到 NVIDIA/AMD GPU 或 Intel OpenVINO 环境时推荐启用；③两引擎共用同一套 ggml 量化模型文件（HF ggerganov/whisper.cpp 托管），模型分发一次到位。来源：https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md ；https://github.com/Const-me/Whisper ；https://caniuse.com/webgpu

2. **量化模型分级下载 + 断点续传**。whisper.cpp 官方模型体积：tiny 75MiB（内存 ~273MB）、base 142MiB（~388MB）、small 466MiB（~852MB）、medium 1.5GiB（~2.1GB）、large 2.9GiB（~3.9GB）——模型分级是本地产品的安装体验核心（Aiko 非 App Store 版 3GB 体积、一年一更是其被吐槽点之一）。落地动作：①安装包只内置 tiny 或 base（几十 MB 级），首次启动即可转写；②medium/large 在设置页按需下载，支持断点续传+校验和（LM Studio 是唯一支持暂停续传的先例，我们已实现 Range 续传）；③UI 标注「磁盘/内存」双口径与推荐场景（课堂中文推荐 small+，安静环境可用 base），把 whisper.cpp README 的体积表做成设置页的引导文案。来源：https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md ；https://raw.githubusercontent.com/sindresorhus/sindresorhus.github.com/92fce2c22fe261a4b08e01acf418094f4ec6fc8f/source/content/apps/aiko.md

3. **VAD 前置切段**。faster-whisper 内置 Silero VAD 且批量转写默认开启（vad_filter=True）；whisper.cpp 集成 Silero v6.2.0（ggml 约 864KB），支持阈值/最小语音时长/最大静音/最长段拆分/padding/overlap 全套参数；whisperX 的结论是 VAD 预处理「降低幻觉且不损 WER」。为什么成立：课堂录音含大量静默（课间、板书停顿），长音频直接推理会产出幻觉填充，先切段再转写是社区收敛的标准管线；静音切分天然产出「章节边界」，一鱼两吃。落地动作：①转写管线固定为 VAD 切段→逐段推理→按 overlap 拼接，参数暴露在「高级设置」（默认值对齐 whisper.cpp 推荐）；②VAD 切出的「静音边界」作为章节速览的候选边界（省一次 AI 调用）；③长录音（>2 小时）先 VAD 粗切再分段推理，规避长上下文漂移。来源：https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md ；https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md ；https://raw.githubusercontent.com/m-bain/whisperX/main/README.md

4. **中文引擎备选：SenseVoice**。FunASR 官方 micro-CER 口径：SenseVoiceSmall 7.81 vs whisper.cpp large-v3-turbo 23.15——中文场景直用 Whisper 的错字率显著更高；sherpa-onnx（15,290★、Apache-2.0、pushed 2026-10-15 极活跃）提供 SenseVoice 的 ONNX 推理、12 种语言 API、WASM 支持与中国镜像下载，deepseek-harness 等已实际使用。为什么成立：讲义笔记的主场景是中文课堂，「中文错字率」是质量生命线；我们的补偿路径（抗噪+清洗+大模型校对）有效但 SenseVoice 作为专用引擎可以把「裸转写质量」直接拉高一档。落地动作：①短期维持「本地 Whisper + 清洗 + 校对」管线，把 SenseVoice 作为实验引擎接入评估（同一输入对比 CER）；②若 SenseVoice 中文 CER 显著领先，做「引擎切换」设置项（中文课堂默认 SenseVoice、英文/多语回退 Whisper）；③模型分发走 GitHub releases（asr-models tag）镜像到自有 CDN，避免下载失败。来源：https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/README.md （SenseVoice 支持）；FunASR micro-CER 数字见 docs/research/00-调研大纲.md 结论区第 3 条（07 路报告）

5. **词级时间戳：轻量方案优先，wav2vec2 对齐后置**。whisperX 的精度来自 wav2vec2 强制对齐（INTERSPEECH 2023、Ego4d 转写挑战第 1 名），但其 README 自述：数字/符号词无法对齐、中文需要自找 wav2vec2 音素模型、要求 CUDA 12.8——对 Windows 便携产品是重资产；whisper.cpp 的 `-ml 1` 词级时间戳是零成本替代（精度略低、够用）。落地动作：①第一版用 whisper.cpp 词级时间戳支撑「点击定位」（UI 组第 1 条），对中文数字/公式词的不精确接受并标注；②「字幕级时间戳」需求（导出 SRT）用 VAD 稳定边界兜底（Vibe 的稳定时间戳模式思路）；③wav2vec2 对齐作为「Pro 增强精度」的远期评估项，仅在有清晰付费意愿信号时投入。来源：https://raw.githubusercontent.com/m-bain/whisperX/main/README.md ；https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md

6. **说话人分离：不依赖 pyannote**。whisperX 的说话人分离依赖 pyannote-audio，需要 Hugging Face token 且必须同意 speaker-diarization-community-1 gated 协议——协议限制+额外模型体积（数百 MB）+CUDA 依赖，无法捆绑进「零依赖便携」的商业产品；whisper.cpp 的 tinydiarize 是实验性方案（仅 small.en-tdrz、[SPEAKER_TURN] 标签）。落地动作：①课堂场景自研「VAD+能量/声纹阈值」二分类（主讲/他人），不承诺多说话人（功能组第 2 条已述）；②标注结果允许手动批量改标（「从 12:30 起都是老师」）；③文案诚实标注局限，避免 pyannote 式「完美分离」的预期。来源：https://raw.githubusercontent.com/m-bain/whisperX/main/README.md ；https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md

7. **云端兜底：最便宜的批量 API，绝不做核心路径**。Cloudflare Workers AI 的 @cf/openai/whisper 官方价 $0.0005/音频分钟（≈$0.03/小时），比 OpenAI gpt-transcribe（$0.0045/min）便宜 9 倍、比 AWS Transcribe（$0.024/min）便宜 48 倍；但仅支持批量、无说话人分离、无自定义词表。OpenAI 旧模型 2027-02-26 退役事件证明云 API 的不可持续风险。落地动作：①「云端补位」开关（默认关）：本地引擎失败/超长录音（>6 小时）/用户主动选择时，走 Cloudflare whisper 批量转写，结果标注「云端转写」来源；②云端结果与本地结果同构入库（同一时间戳格式），AI 整理层无感知；③定价上云端补位按成本+毛利定价（如 0.01 元/分钟级），并在执行前明示——云转写是「保险」不是「卖点」，卖点永远是本地。来源：https://developers.cloudflare.com/workers-ai/platform/pricing/ ；https://jakeinsight.com/ai/2026-05-19-cloudflare-workers-ai-whisper-transcription-cost-p/

### （四）商业模式组（7 条）

1. **「本地买断 + 云端 AI 按量」双轨定价**。已核实的三组先例：MacWhisper Gumroad Pro €64 一次性买断终身更新（学生/记者/非营利 25% 折扣→€48）+ App Store 版 Assistant 云订阅（$5.99/周~$89.99/年）；通义听悟「ASR 0.6 元/小时 + 大模型能力逐项 0.064 元/小时」的行业标准价格结构；日本 RecText AI 2 以 9,980 日元一次性买断卖「离线转写+机密音频安心」。为什么成立：转写的边际成本为零（本地引擎），买断定价没有后端成本风险；云端 AI 是真实成本项，按量计费才能持续；两类用户（轻度/重度 AI 使用）各自得到公平价格。落地动作：①定价草案：基础版买断 ¥68~128（对标 MacWhisper €64 与国内白描 30/50 元、言灵 ¥18 的心理区间），含本地转写全模型+批量+导出+术语表；②云端 AI 整理按「单次动作」充值（如 0.1 元/摘要、0.2 元/章节+导图），充值余额不过期；③学生认证（.edu/学生证）买断 7~8 折——MacWhisper 的 25% 折扣与 Otter 的 .edu 8 折都证明教育折扣是被验证的转化工具。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules ；https://www.sourcenext.com/product/rectext/

2. **学生/教育折扣作为增长引擎**。MacWhisper 25% 折扣「发邮件索取」（低摩擦的资格审核）；Otter .edu 邮箱 Pro 8 折；Notta 有教育折扣文章入口——三家不同市场地位的产品都把教育折扣当作独立获客通道。为什么成立：学生是价格敏感但规模巨大、且天然需要转写笔记的群体；折扣不是让利而是获客成本，学生毕业后转化为全价用户是标准的生命周期逻辑。落地动作：①「学生认证」：.edu/.edu.cn 邮箱或学生证照片（本地校验后即焚，不留存隐私）；②折扣形式选「买断立减」而非「订阅减免」（买断产品折扣感知更强）；③校园渠道：班级团购（5/10/20 席折扣，学 MacWhisper 的批量折扣）+ 课件场景（老师推荐学生用「讲义笔记」整理课堂录音）。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://theaiagentindex.com/agents/otter-ai ；https://support.notta.ai/hc/en-us/articles/55339089140123-Understand-Notta-s-Plans-Pricing

3. **双渠道策略：官网直购 + 商店上架**。MacWhisper 的双 SKU 是最完整的参照：Gumroad 直购版放全功能（系统级听写、会议检测、全 AI 供应商、MDM、批量折扣、CLI、license key 激活），App Store 版受苹果政策限制做订阅+IAP；官方专门写 help 文章解释双版本差异。为什么成立：直购渠道绕开平台抽成（苹果 30%）与政策限制，承载「买断+激活码」；商店渠道获取搜索流量与信任背书；双 SKU 的困惑成本可通过清晰的官方文档管理（MacWhisper 已示范）。落地动作：①官网直购（爱发电/Paddle/Lemon Squeezy 等）放「买断+全功能+license key」；②Microsoft Store 上架（个人开发者 2025-09-11 起免费注册、月活 2.5 亿）放「免费试用+应用内买断」——注意 MS Store 中国区收款方式需核实，若受限则以 Store 引流+官网成交；③两渠道版本号与更新节奏一致，官网页明确写出差异对照表（抄 MacWhisper help 文章的结构）。来源：https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://www.ithome.com/0/882/056.htm

4. **免费档设计成大漏斗**。Otter 免费档给足 300 分钟/月转写（含 AI Chat）；MacWhisper 免费版永久可用（Tiny/Base 模型+基础转写）；讯飞听见「前三分钟试看」。为什么成立：转写工具的试用门槛极低（丢个文件就行），免费档让用户先建立「我的录音都在这里」的资产依赖，再为效率付费；MacWhisper 证明「永久免费小模型」不会吃掉付费转化（小模型质量差距明显，天然构成付费理由）。落地动作：①免费档=永久：base 模型+基础转写+TXT/SRT 导出+3 个课程位；②买断解锁：全模型（small/medium/large 按需下载）+批量转写+术语表纠错+全部导出格式+AI 整理（按量充值）；③免费档转写结果完整可用（不阉割核心质量），差异化在「规模与效率」而非「能用不能用」——避免 Fireflies 免费档「缺 AI 功能与 smart search」的割裂感。来源：https://otter.ai/pricing ；https://docs.macwhisper.com/article/40-macwhisper-whisper-transcription-difference ；https://geekflare.com/software/fireflies-review/

5. **绝不做自动续费陷阱，把「信任」当产品功能**。TurboScribe 的 26 条一星差评中 15 条是「取消后仍扣费/自动续费无告知」、10 条退款被拒、有 $120 年付被扣 $240 的案例；Descript 的 48 小时无例外退款政策同样被骂。国内用户已被「网易见外关停、搜狗录音笔停服、讯飞语记缩水」连续教育，对订阅与停服的恐惧是当前市场的最大情绪。为什么成立：「本地优先」产品最大的卖点就是「我的数据与软件不会消失」，任何续费争议都会直接摧毁这个卖点；买断+充值天然没有自动续费问题。落地动作：①首发只做「买断+充值」形态，不设订阅；②若未来做订阅：续费前 7 天通知+一键取消+「未使用自动退款」承诺，把取消流程写成产品文档公开展示；③产品文案主卖点固定为「录音不出本机、买断永久、不怕停服」，对标 TurboScribe 的反面案例做信任建设。来源：https://whisperai.com/blog/turboscribe-review ；https://hackceleration.com/labs/review/descript

6. **计量口径透明：单一分钟口径 + AI 动作明码标价**。Descript 2025-09 把转写小时改为「媒体分钟」且多轨按轨数倍乘（1 小时多轨访谈耗 4+ 媒体分钟）、AI credits 单次消耗不在 App 内披露——被用户骂到推荐率 47%；通义听悟的逐项计费（每项 0.064 元/小时）与 Fireflies 的 credits 体系同样复杂。为什么成立：计量口径是转写产品的「价格税」，用户被 Descript 教育后对「隐藏消耗」高度敏感；我们作为新进入者，「透明」是零成本的可信度优势。落地动作：①转写计量=音频实际时长（单一口径，不倍乘、不四舍五入到分钟）；②AI 整理每个动作在按钮上直接标价（「生成章节速览 ¥0.2」），执行前二次确认，完成后余额变动即时可见；③「用量明细」页：每笔消耗记录动作/时间/音频时长/扣费，可导出——把 Descript 的痛点做成我们的卖点。来源：https://hackceleration.com/labs/review/descript ；https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules

7. **开源→商业化的路径与防冒名警示**。Const-me/Whisper 的完整路径：开源版（10,679★、MPL-2.0）2023 年起停更→闭源商业后继版（AOT 编译 C# 引擎、Direct3D 12+Vulkan 1.3、VoxTral Mini 4B Realtime、30 天试用+一次性买断）——证明「本地转写桌面工具」有独立商业化空间，且「试用+买断」是被选中的模式；同时其 README 置顶警告 whisperdesktop.com 是冒充官网的钓鱼站。为什么成立：本地推理引擎的工程护城河（性能优化、VAD、打包）足以支撑闭源收费，但品牌容易被冒名（开源工具的官网心智混乱是行业通病）。落地动作：①我们的「本地引擎+课程笔记」工程资产走闭源（bytenode 等已有方案），模型权重保持开源许可合规；②上线即注册相近域名/商标防冒名站，官网只从官方渠道链接下载，安装包强制签名（已有 OV 证书计划）；③「30 天免费试用+买断」作为标准转化路径（Const-me 后继版已验证），试用期全功能、到期降级为免费档而非锁死——降级保留数据可读，避免「买了才让看数据」的绑架感。来源：https://github.com/Const-me/Whisper

---

## 七、附：访问受限与口径说明（诚实清单）

- 以下官方页面对爬虫受限，数字经第三方转述并已标注：turboscribe.ai（Cloudflare 403，定价经官方 help 文章+whisperai.com 评测核实）；platform.openai.com / developers.openai.com（403，定价经 alphasignal.ai、distk.in、IT之家、GIGAZINE 转述）；console.groq.com（403，定价经 omr.com 转述）；goodsnooze.gumroad.com（直连失败，定价经 getvoibe.com 与 docs.macwhisper.com 核实）；macwhisper.com 首页截断（细节经官方 docs 与 PromptQuorum 评测核实）。
- GitHub 全部 star/fork/license/活跃度数据取自 api.github.com 实测（2026-10-15），非 README 口径。
- whisperdesktop.com 为冒充 Const-me/Whisper 的钓鱼站，所有相关下载只认 github.com/Const-me/Whisper。
- Otter Business 年付价第三方口径 $19.99/月与官方页 $24/月不一致，本报告以官方 otter.ai/pricing 为准。
- MacWhisper Pro 价格以官方文档与多数评测一致口径 **€64** 为准（个别评测标题写 €59，未采用）。
