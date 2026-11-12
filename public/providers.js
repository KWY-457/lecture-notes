/**
 * 云端 API 服务商注册表 —— 前后端共用一份，避免两处写着写着就不一致。
 *
 * 为什么要有这个文件：
 *   低配电脑跑本地 Whisper / 本地大模型会卡到不能用（本地 whisper-large-v3-turbo
 *   要 1GB 权重 + WebGPU；本地 Qwen2.5-7B 要 6GB 显存）。给同学、给别的机器用的时候，
 *   最省事的做法是把「转写」和「笔记」都换成云端 API：本机只负责上传和显示。
 *
 * ★ 只有四家，而且四家都是「转写 + 笔记都能做」（2026-10-21 收敛）：
 *     硅基流动   两样都做，国内直连，有免费额度 —— 首选
 *     OpenAI     两样都做，国内需要能访问的网络
 *     本地       两样都做（转写=浏览器 Whisper，笔记=本机 llama-server）
 *     自定义     两样都做（自己填地址和模型，任何 OpenAI 兼容接口）
 *
 *   之前还有 DeepSeek / 阿里云百炼 / 智谱 GLM / Kimi / Groq / Ollama / LM Studio
 *   七条「只能做一半」的记录。用户第一步就得先算「这家能不能转写」，界面还得为
 *   「只能转写」和「只能做笔记」各准备一套模型列表 —— 全是自找的复杂度。
 *   只做一半的整条删掉；真正需要它们的人走「自定义」：反正都是 OpenAI 兼容格式，
 *   填个地址和模型名就能用，反而更通用。
 *
 * 结构约定：
 *   kind        'llm' | 'asr' | 'both'（现在全是 'both'，字段留着是为了将来扩展）
 *   baseUrl     OpenAI 兼容的 base（会被拼成 <baseUrl>/chat/completions）
 *   asrUrl      OpenAI 兼容的 /audio/transcriptions 完整地址
 *   models      [{ id, label, tier?, recommended?, priceNote?, qualityNote?, inPrice?, outPrice? }]
 *               inPrice/outPrice 单位：元/百万 tokens
 *   free        true 表示新手有免费额度或免费模型可用
 *   console     去哪申请 API Key
 *   docs        官方文档
 *   setup       申请步骤（数组，界面上「怎么申请」直接显示）
 *
 * 模型的展示字段（给界面上的模型选择器用，都是可选的）：
 *   tier        档位，界面据此上色和排序。**一个标签同时说清「贵不贵 × 好不好」**
 *               （老大 2026-10-29 定的：只讲价格用户没法比）：
 *                 'free'   零成本      不花钱，在本机跑
 *                 'budget' 便宜·够用   花得很少，质量一般
 *                 'value'  便宜·好用   花得少，质量稳
 *                 'pro'    偏贵·更好   贵一档，归纳更细
 *   recommended 作者推荐（true 才显示）。**不是档位，是「我试下来最常用的那个」的背书**，
 *               所以单独一个字段，别塞进 tier 里 —— 一个模型可以既是 pro 又被推荐。
 *               ⚠ 2026-11-03：本地转写那四档已经全部撤掉这个标签（老大要求），
 *               现在只剩云端笔记里的 DeepSeek-V3 还在用。
 *   priceNote   只放「模型多重 / 要下多大」这类硬事实，见下面那条 ⚠
 *   qualityNote 一句话说明它好在哪 / 快不快
 *   reqNote     **只给本地转写模型用**：推荐配置（要不要显卡、内存多大），界面单独一行小字。
 *               为什么不塞进 qualityNote：那一行限 14 字、只讲质量（见下），
 *               而「独立显卡 6GB+ · 内存 16GB」是另一维信息，两者挤一起谁都读不清。
 *               收的都是「跑起来舒服」的配置，不是「刚好能启动」的下限 ——
 *               下限没实测过，不敢写。
 *               （2026-11-03 老大把这一行从「实测耗时」改成「配置推荐」，原话：
 *                「底下的小字就不要标速度了，标出配置推荐，什么GPU，内存多少」。
 *                耗时数据仍然留在 asrModels 上方的注释里，别删。）
 *   cpuDtype / gpuDtype
 *               **只给本地转写模型用**：这个模型在 CPU(WASM) / 显卡(WebGPU) 上该用哪份权重。
 *               cpuDtype 不写默认 'q8'，gpuDtype 不写默认 'fp16'。
 *               **gpuDtype 显式写 null 表示「这个模型在显卡上跑不了」** → worker 会直接用 CPU。
 *               为什么需要它：实测 WebGPU + fp16 只对 tiny 和 turbo 有效 ——
 *               base 输出乱码、small 输出空（都在 2 秒内「跑完」，让人误以为飞快）；
 *               而这两个模型在 GPU 上换成 q8 又慢到 0.17×（CPU 是 1.36×）。
 *               所以它们干脆走 CPU：改由模型自己声明，比 worker 里按设备一刀切可靠。
 *
 *   ⚠ 这两个 Note 会被原样铺到卡片第二行，**不要写括号**（老大特意要求删掉）：
 *     括号里的补充说明在窄屏上会被折成第三行，反而把档位这个关键区别挤没了。
 *     要补背景就写注释，不要写进展示字段。
 *
 *   ⚠ **priceNote 不要讲价格**（老大 2026-10-29 原话：「下面的小字就不要说价格方面的了，
 *     只做生成质量介绍就好」）。收费与否已经在档位徽章上说完了，第二行重复一遍是废话，
 *     而且「约 ¥0.8/小时」这种数字用户还得自己乘时长才知道贵不贵。
 *     priceNote 留给「这个模型本身多重 / 要下多大」这类硬事实（如「约 1.3GB 模型」），
 *     没有就留空 —— 它已经不是必填了。
 *   ⚠ qualityNote 只讲**好在哪**，不写缺点（老大原话：「别写会成片听错这种」）。
 *     缺点的实测数据一律写进注释，别摆在买家面前。
 *
 * 价格核对日期：2026-10-21
 *   ⚠ 单价以各家控制台为准，这里只写「大致量级 + 去哪看」，不写死具体数字
 *     （写死了改价就变成误导）。
 */

export const PROVIDER_VERSION = '2026-10-21';
export const PRICING_CHECKED_AT = '2026-10-21';

export const PROVIDERS = [
  /* ------------------------------------------------------------------ */
  {
    id: 'siliconflow',
    kind: 'both',
    name: '硅基流动 SiliconFlow',
    tag: '推荐',
    // 国内站是 .cn（国际站 .com 是两套账号，余额不通用），这里用国内站
    baseUrl: 'https://api.siliconflow.cn/v1',
    asrUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    free: true,
    // 2026-10-21 用真实 Key 拉过 /v1/models?sub_type=chat，66 个对话模型、
    // 6 个转写模型。这里只挑能撑起「课堂笔记」的四档，不是全部照抄 ——
    // 把 66 个塞进卡片列表等于让用户自己一个个试。
    //
    // 分档依据是「会不会先思考」：Qwen3 系列和 GLM-5.3-Flash 在出正文之前要
    // 先生成几百字推理，这些推理 token 也计费（实测问一句「说好」，
    // Qwen3-8B 花了 406 output tokens 其中 404 是 reasoning；Qwen2.5-7B 只花 1 个），
    // 一节课下来能差出好几倍的钱。所以只有不思考的才放「便宜·够用」这一档。
    //
    // thinking: true 的模型，服务端调它时会自动带 `reasoning_effort: 'low'`
    // （见 server.mjs 的 /llm 分支）。**这不是可选的优化，是能不能用的分界**：
    // 2026-10-28 实测 GLM-5.3-Flash 整理一份 21316 字的逐字稿，
    //   不限制 → 810~822 秒（思考 50157 字），而 Node 内置 fetch 有 300 秒
    //            headersTimeout 硬墙 → 界面永远只看到「fetch failed」；
    //   加 low  → 160 秒，思考 0 字，产出 6995 字（69 条要点 / 21 个标题）。
    // 换句话说：不改这个，GLM-5.3-Flash 在「AI 润色」上是**只能失败**的。
    models: [
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        label: 'Qwen2.5-7B-Instruct',
        tier: 'budget',
        qualityNote: '速度快',
      },
      {
        id: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
        label: 'Qwen3-30B-A3B-2507',
        tier: 'value',
        qualityNote: '长逐字稿归纳更完整',
      },
      {
        id: 'deepseek-ai/DeepSeek-V3',
        label: 'DeepSeek-V3',
        tier: 'pro',
        // 老大 2026-10-29 点名要这个「作者推荐」标签 —— 它不是档位，是「我试下来
        // 最常用的那个」的背书。所以单独一个字段，不塞进 tier 里。
        recommended: true,
        qualityNote: '中文笔记质量高，适合重要课程',
      },
      {
        id: 'zai-org/GLM-5.3-Flash',
        label: 'GLM-5.3-Flash',
        // 2026-10-29 老大实测它不是免费的（原来标的是 'free' 免费），改回按「花得少、
        // 质量稳」这一档。顺带说明：它虽然便宜，但**慢**——这一点不写进卡片小字
        // （老大要求小字只讲生成质量），真要知道就看下面的 thinking 注释。
        tier: 'value',
        qualityNote: '较慢，质量较好',
        // 会先思考的模型。不压住的话一份长逐字稿要跑十几分钟，
        // 而请求在 300 秒就会被 Node 自己掐掉（详见上面那段）。
        thinking: true,
      },
    ],
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    asrModels: [
      {
        id: 'FunAudioLLM/SenseVoiceSmall',
        label: 'SenseVoiceSmall',
        tier: 'budget',
        // 2026-10-21 实测 42.7 分钟中文课堂录音：把「习近平总书记」听成
        // 「心里标有问几」、「我同桌一个男生」听成「能说有来」、整句「帮人民造福」
        // 只剩「富哦」。同一段音频跑两遍相似度只有 0.9812，本身就不稳。
        // 这些具体错例**不写进卡片**（老大 2026-10-29：「别写会成片听错这种」），
        // 卡片上只留一句大实话：快，但没那么准。
        qualityNote: '速度快，准确度略低',
      },
      {
        id: 'Qwen/Qwen3-ASR-1.7B',
        label: 'Qwen3-ASR-1.7B',
        tier: 'value',
        // 同一条录音 SenseVoice 出 9243 汉字、Qwen3-ASR 出 10074；拿第三方引擎
        // 当裁判，在能逐字对上的 57 个分歧点上 Qwen 对 36 次、SenseVoice 对 21 次。
        // 速度不稳定：9 分钟时快四倍（11.2s vs 47.8s），42.7 分钟反而慢
        // （53.7s vs 30.1s）—— 长录音上确实更慢，卡片就照实写。
        qualityNote: '较慢，准确性高',
        // 这个模型有单文件硬限制，超了服务端直接回裸 400（Content-Length: 0，
        // 连原因都不给），用户只会看到「转写服务返回 400: 」，完全无从下手。
        // 实测（2026-10-22，真 Key 直连，绕过本服务）：
        //   42.7 分 / 39.5MB → HTTP 200（50.4s，29501 字节）
        //   39.0 分 / 36.1MB → HTTP 200
        //   88.1 分 / 81.6MB → HTTP 400，空体，trace ti_oru7bx68gvov1g2ehc
        // 官方文档（docs.siliconflow.cn/docs/api/audio-transcriptions-post）写的是
        // 「时长不超过 1 小时，文件大小不超过 50MB」，跟实测对得上。
        // 所以发请求前先自己拦一道，报人话，别让用户白等半分钟再看个空错误。
        maxSeconds: 3600,
        maxBytes: 50 * 1024 * 1024,
      },
      // 曾经还放过 XingChenAGI/XingChenASR-V3.2（免费、能标说话人）。
      // 42.7 分钟长录音只出 7366 字（比 SenseVoice 少 1900），中段整片丢失，
      // 而本项目没有「人工检查有没有丢」的环节，宁可不给这个选项。
    ],
    // SenseVoice 不认 response_format=verbose_json，加了会直接 400
    // （服务端据此决定要不要加）
    verbose: false,
    note: '按量计费：转写按音频时长，笔记按 tokens。新人注册一般送十几元额度，够转几十小时。不吃本机性能。',
    console: 'https://cloud.siliconflow.cn/account/ak',
    docs: 'https://docs.siliconflow.cn/',
    setup: [
      '打开 https://cloud.siliconflow.cn/ 注册，手机号即可，新用户有赠送额度。',
      '进「账户管理 → API 密钥」（cloud.siliconflow.cn/account/ak），新建并复制密钥。',
      '回到本软件：设置 → ① 服务商选「硅基流动」，把 Key 粘进 API Key 框 → 保存。',
      '转写和 AI 笔记共用这一把 Key，不用填两次。',
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'openai',
    kind: 'both',
    name: 'OpenAI 官方',
    tag: '需外网',
    baseUrl: 'https://api.openai.com/v1',
    asrUrl: 'https://api.openai.com/v1/audio/transcriptions',
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'gpt-4o-mini',
        tier: 'budget',
        qualityNote: '速度快，质量一般',
        // 美元价 $0.15/$0.60 每百万 tokens，按 1 美元≈7.1 元折算（2026-10-21）
        inPrice: 1.07,
        outPrice: 4.26,
      },
      {
        id: 'gpt-4o',
        label: 'gpt-4o',
        tier: 'pro',
        qualityNote: '较慢，长课少漏考点',
        // 美元价 $2.50/$10.00 每百万 tokens（2026-10-21）
        inPrice: 17.75,
        outPrice: 71.0,
      },
    ],
    asrModel: 'whisper-1',
    asrModels: [
      {
        id: 'whisper-1',
        label: 'whisper-1',
        tier: 'value',
        qualityNote: '老牌稳定，中文标点齐全',
      },
    ],
    note: '转写按分钟计费、笔记按 tokens。国内服务器直连通常不通，得自己解决网络问题才能用。',
    console: 'https://platform.openai.com/api-keys',
    docs: 'https://platform.openai.com/docs/pricing',
    setup: [
      '打开 https://platform.openai.com/ 注册并绑定支付方式。',
      '「API keys」→ 新建密钥并复制（只显示一次）。',
      '回到本软件：设置 → ① 服务商选「OpenAI 官方」，把 Key 粘进 API Key 框 → 保存。',
      '转写和 AI 笔记共用这一把 Key，不用填两次。',
    ],
  },

  /* ------------------------------------------------------------------ */
  /**
   * 本地 —— 转写和笔记都做。
   *
   * 之前拆成三条记录：'local'(浏览器 Whisper)、'local-llm'(本机 llama-server)、
   * 外加 ollama / lmstudio 两条「别的本机程序」。用户心里「本地」就是
   * 「不花钱不联网」，不该让他先选「本地转写」再选「本机大模型」再想
   * 「Ollama 算哪一类」。现在合成一条：选本地 = 转写用浏览器 Whisper、
   * 笔记用本机 llama-server。想接自己的 Ollama / LM Studio，走「自定义」填地址。
   */
  {
    id: 'local',
    kind: 'both',
    name: '本地',
    tag: '离线',
    // 转写没有地址：真正的转写在浏览器里跑（public/worker-asr.js），服务端不代理
    asrUrl: '',
    asrModel: 'onnx-community/whisper-base',
    // ★ 2026-11-03 实测重排（老大 m28311：要按电脑性能从低到高都有适配、每档标注性能参考）
    //
    // 测法：录音「高数」(1e86e685, 2592 秒) 的第 300~360 秒，走产品真实链路
    // transcribeLocal()，CPU(WASM/q8) 与 GPU(WebGPU) 各跑一遍。脚本 _scratch/bench-models.mjs。
    // 数字是「相对实时倍数」= 音频秒数 / 转写秒数，越大越快。
    //
    // ┌ 模型    体积(q8)  CPU    GPU/fp16   实测结果
    // │ tiny     96MB    4.22×   11.21×    都能跑，但错字明显（「秋节」=球阶、「显示机会」=显示结果）
    // │ base    172MB    2.97×   乱码       GPU 上 2.7 秒跑完 120 秒音频 —— 根本没在编码
    // │ small   521MB    1.36×   空输出     同上，1.6 秒跑完，一个字都不吐
    // │ medium  1.5GB    报错    报错       CPU 报 Error 1267168960（内存不足），GPU 也报错 —— 整条删掉
    // │ turbo   1.9GB    0.30×    7.73×     有显卡时最好用；纯 CPU 一小时课要三小时多
    // └
    //
    // 因此只留四档，medium 整条删除：它在两种设备上都跑不起来，留着就是给用户埋坑。
    // 默认值也从 turbo 改成 base —— 没显卡的电脑占绝大多数，选 turbo 等于默认让他等三小时。
    // 有显卡的用户换 turbo 只多一次下载，反而不会被默认值坑。
    // ★ 2026-11-11 补 paramNote（老大：「为什么转写模型不像润色模型那样展示
    // 模型名称及几b」）。查下来不是漏字段 —— 两组的 label 都是照抄官方型号名，
    // 只是命名习惯不同：Qwen 官方就叫 qwen2.5-3b/7b（名字里天然带参数），
    // Whisper 官方就叫 tiny/base/small/large-v3-turbo（一个数字都没有）。
    // 光看「base」不知道它到底多小，所以补一行参数量。数字取自 Whisper 官方
    // 公布值：tiny 39M / base 74M / small 244M / large-v3-turbo 809M
    // （turbo 是 large-v3 砍到 4 层解码器，所以比 large 的 1550M 小）。
    // 不塞进 priceNote：引导页拿 priceNote 拼「会开始下载（172MB）」，混进
    // 参数量会变成「下载（172MB · 74M 参数）」，那句就说不通了。
    asrModels: [
      {
        id: 'onnx-community/whisper-base',
        label: 'base',
        tier: 'free',
        priceNote: '172MB',
        paramNote: '74M 参数',
        // 2026-11-11 老大看引导第 4 步的截图后要求：「下面每个模型下面的小字
        // 什么最快，较快那些全部删掉」—— 速度/精度这类形容词对挑模型没有帮助，
        // 留下体积和内存需求两行硬事实就够。
        reqNote: '内存 4GB',
        cpuDtype: 'q8',
        // GPU 上 fp16 是乱码（2.7 秒「跑完」120 秒音频，根本没在编码），q8 又只有 0.50×
        // 远不如 CPU 的 2.97× —— 这个模型在显卡上跑不了，null 让 worker 直接用 CPU。
        gpuDtype: null,
      },
      {
        id: 'onnx-community/whisper-tiny',
        label: 'tiny',
        tier: 'free',
        priceNote: '96MB',
        paramNote: '39M 参数',
        reqNote: '内存 2GB',
        cpuDtype: 'q8',
        gpuDtype: 'fp16',
      },
      {
        id: 'onnx-community/whisper-small',
        label: 'small',
        tier: 'free',
        priceNote: '521MB',
        paramNote: '244M 参数',
        reqNote: '内存 4GB',
        cpuDtype: 'q8',
        // 同上：GPU/fp16 输出空、GPU/q8 只有 0.17×，CPU 才是它的正确位置
        gpuDtype: null,
      },
      {
        id: 'onnx-community/whisper-large-v3-turbo',
        label: 'large-v3-turbo',
        tier: 'free',
        priceNote: '1.9GB',
        paramNote: '809M 参数',
        reqNote: '独立显卡 6GB+ · 内存 16GB',
        cpuDtype: 'q8',
        gpuDtype: 'fp16',
      },
    ],
    // 笔记走本机 llama-server（helpers/setup-local-llm.ps1 一键部署）
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKeyHint: '本地服务不用填',
    // ★ 2026-11-05 实测两档（老大 m29315：AI 润色的模型也别就一个）
    //
    // 测法：录音「工程制图」(62b4f73d) 的前 5997 字逐字稿，同一段材料、同一套
    // 启动参数（-c 16384 -ngl 99 -ctk q8_0 -ctv q8_0 -t 8 --jinja），
    // max_tokens 2048。脚本 _scratch/bench-llm.mjs。机器 RTX 5060 Laptop / 8GB。
    //
    // ┌ 模型  体积    启动   生成   输出             显存增量
    // │ 1.5B  0.92GB  1.7s   12.6s  2048tok/2824字   +1325MB
    // │ 3B    1.80GB  2.1s    6.3s   563tok/ 991字   +2301MB
    // │ 7B    4.36GB  4.5s    7.8s   337tok/ 569字   +4921MB
    // └
    //
    // 为什么不放 1.5B：它不是「质量差一点」，是坏了。放开到 max_tokens 4096
    // 重测 —— 25.0 秒写 6663 字 101 个小节，然后开始自己重复
    // （「课程考核：教材内容与心理材料相结合」连着写三遍），finish_reason
    // 是 length 而不是 stop，也就是它根本不会自己停。
    //
    // 为什么不只留 7B：7B 写得反而更短（569 字 vs 3B 的 991 字），
    // 把源素材里的「课程考核方式」整段丢了；而且常驻要 4.9GB 显存，
    // 本地转写（Whisper）和本地润色共用同一块 8GB 显存，7B 常驻之后
    // Whisper 只剩 3GB。3B 结构最规整、覆盖课程名称/培养目标/内容重点/
    // 考核方式四项，显存只花 2.3GB。
    //
    // 所以两档：3B 默认（省显存，笔记本友好），7B 给显存宽裕、想要更凝练的人。
    //
    // ★ 2026-11-06 又加两档（老大：「还有没有更高配置的，因为别的用户可能设备
    // 性能比我的这个要更好，都再往上再加一档吧」）。本机只有 8GB 显存 + 16GB
    // 内存，所以：
    //   · 14B（8.37GB）**实测过**：8GB 显存上自动分层后 6.50 tok/s，
    //     产出质量比 3B/7B 好一档（把「占总评 12 分」和「GB 国标」都写全了）。
    //   · 32B（18.49GB）**没实测** —— 本机装不下。列出来是因为 24GB 显存的
    //     台式机跑得动，而这一档的用户正是老大说的「设备性能更好的人」。
    //     卡片上如实写「未在本机实测过」，不编数字。
    models: [
      {
        id: 'qwen2.5-3b',
        label: 'qwen2.5-3b',
        tier: 'free',
        priceNote: '1.8GB',
        qualityNote: '结构规整，要点齐全',
        reqNote: '显存 3GB · 内存 8GB',
        gguf: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
      },
      {
        id: 'qwen2.5-7b',
        label: 'qwen2.5-7b',
        tier: 'free',
        priceNote: '4.4GB',
        qualityNote: '更凝练，但会漏细节',
        reqNote: '显存 6GB · 内存 16GB',
        gguf: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      },
      {
        id: 'qwen2.5-14b',
        label: 'qwen2.5-14b',
        tier: 'free',
        priceNote: '8.4GB',
        qualityNote: '细节记得最全',
        // 实测：8GB 显存（RTX 5060 Laptop）自动分层后占 6791MB、6.50 tok/s。
        // 所以 8GB 就能跑，不是「必须 10GB」—— 别把能跑的人挡在外面。
        reqNote: '显存 8GB 起 · 内存 16GB',
        gguf: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf',
      },
      {
        id: 'qwen2.5-32b',
        label: 'qwen2.5-32b',
        tier: 'free',
        priceNote: '18.5GB',
        qualityNote: '更强，家用机基本跑不动',
        // 这一档没实测 —— 本机 8GB 显存装不下（权重本身就 18.5GB，比 16GB 内存还大）。
        // 配置是按「Q4_K_M 需要略大于权重的显存/内存」推的，不是量出来的。
        reqNote: '显存 24GB 起 · 内存 32GB',
        gguf: 'Qwen2.5-32B-Instruct-Q4_K_M.gguf',
      },
    ],
    local: true,
    note: '录音和逐字稿完全不出本机，一分钱不花。代价：转写要下 96MB 到 1.9GB 的 Whisper 模型、笔记要下 1.8GB 或 4.4GB 的本地大模型，都吃内存和显卡；配置一般的电脑会明显卡顿。',
    setup: [
      '转写：什么都不用装。第一次转写会自动从 hf-mirror 下载 Whisper 模型，下过一次就留在本地。',
      '笔记：设置 → ⑤ 环境自检 →「部署本地模型」，一键装好 llama-server 和 Qwen2.5。',
      '不知道选哪个转写模型就看卡片上最后一行：只要求 2~4GB 内存的 base / small 大多数电脑都能跑，tiny 更快但错字多，large-v3-turbo 要有独立显卡才划算。',
      '切笔记模型会让本地大模型重启一次（两三秒），因为一次只能装一个模型。',
    ],
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'custom',
    kind: 'both',
    name: '自定义',
    tag: '自建/中转',
    baseUrl: '',
    asrUrl: '', // 留空：地址由用户在设置里手填（asr.endpoint / llm.baseUrl）
    models: [],
    asrModels: [],
    manual: true, // 需要用户自己填地址，界面上单独处理
    note: '自己搭的 faster-whisper、vLLM、one-api / New API 中转站，或其他云厂商 —— 只要兼容 OpenAI 格式都能填。',
    setup: [
      '转写地址填到 /v1/audio/transcriptions 这一层。',
      '笔记地址填到 /v1 这一层，程序会自己拼成 /v1/chat/completions。',
      '模型名照抄你的服务端支持的写法，faster-whisper 常写 large-v3-turbo。',
    ],
  },
];

/** 按 id + 用途取服务商（用途为 'llm'/'asr'；'both' 两个用途都算） */
export function getProvider(id, kind) {
  return PROVIDERS.find((p) => p.id === id && (!kind || p.kind === kind || p.kind === 'both')) || null;
}

/**
 * 给某个用途列出可选服务商。
 * 用「该用途真的有地址/模型」来判断，而不是只看 kind 字段 —— 这样把某条改成
 * kind:'both' 也不会因为漏配 asrUrl 被当成能转写。
 */
export function listProviders(kind) {
  return PROVIDERS.filter((p) => {
    if (!kind) return true;
    if (p.kind !== kind && p.kind !== 'both') return false;
    if (kind === 'asr') return !!(p.asrUrl || p.asrModel || (p.asrModels && p.asrModels.length));
    return !!(p.baseUrl || (p.models && p.models.length));
  });
}

/**
 * 界面上要显示的服务商列表（含「自定义」这种要手填地址的项）。
 * 和 listProviders 的区别：这里保留 manual 项，只是它们没有预设地址。
 */
export function optionsFor(kind) {
  return PROVIDERS.filter((p) => p.kind === kind || p.kind === 'both');
}

/** 取某个服务商的默认模型名 */
export function defaultModel(id, kind) {
  const p = getProvider(id, kind);
  if (!p) return '';
  if (kind === 'asr') return p.asrModel || (p.asrModels && p.asrModels[0] && p.asrModels[0].id) || '';
  return (p.models && p.models[0] && p.models[0].id) || '';
}

/** 取某个服务商在某个用途下的全部候选模型（给界面的卡片选择器用） */
export function modelsFor(id, kind) {
  const p = getProvider(id, kind);
  if (!p) return [];
  if (kind === 'asr') {
    if (p.asrModels && p.asrModels.length) return p.asrModels;
    return p.asrModel ? [{ id: p.asrModel, label: p.asrModel }] : [];
  }
  return p.models || [];
}

/**
 * 模型档位的统一说法 —— 界面上的徽章文案、颜色、排序都从这里来。
 *
 * 为什么要分档而不是照着列表顺序摆：用户填完 Key 后最常见的问题是
 * 「我现在用的是哪个？是不是最贵那个？有没有免费的？」。只给一串模型名
 * 等于让人自己去搜价格。这里把档位做成一眼能认的标签 —— 而且一个标签同时说
 * 两件事：贵不贵、好不好（「便宜·够用」比单说「性价比」信息量大，
 * 用户不用自己再估一遍质量）。
 */
export const TIERS = {
  free: { label: '零成本', hint: '不花钱，在本机跑', order: 0 },
  budget: { label: '便宜·够用', hint: '花得很少，质量一般', order: 1 },
  value: { label: '便宜·好用', hint: '花得少，质量稳', order: 2 },
  pro: { label: '偏贵·更好', hint: '贵一档，归纳更细', order: 3 },
};

/** 取某个模型的完整描述（找不到就返回 null，不编造） */
export function modelSpec(providerId, kind, modelId) {
  const list = modelsFor(providerId, kind);
  if (!list.length) return null;
  return list.find((m) => m.id === modelId) || null;
}

/** 按档位排序过的候选列表（同档保持原顺序，免费在前） */
export function sortedModels(providerId, kind) {
  const list = modelsFor(providerId, kind).slice();
  return list.sort((a, b) => {
    const oa = a.tier && TIERS[a.tier] ? TIERS[a.tier].order : 9;
    const ob = b.tier && TIERS[b.tier] ? TIERS[b.tier].order : 9;
    return oa - ob;
  });
}

/**
 * 判断用户填的模型名有没有落到预设列表里。
 * 返回 { spec, known }：known=false 表示是手填的（自定义中转站常见），
 * 界面要说「自定义模型」而不是假装认识它。
 */
export function describeModel(providerId, kind, modelId) {
  const id = String(modelId || '').trim();
  if (!id) return { spec: null, known: false };
  const spec = modelSpec(providerId, kind, id);
  return { spec, known: !!spec };
}

/**
 * 自检：同一个 id 不能在同一个用途里出现两次。
 * 之前就踩过 —— siliconflow 写了 .com 和 .cn 两条，listProviders('asr') 返回两条，
 * Object.fromEntries 后一条覆盖前一条，而 getProvider 只认前一条，界面上显示的地址
 * 和代理真正请求的地址会不一致。宁可当场报错，也不要悄悄跑出两份配置。
 */
export function selfCheck() {
  const problems = [];
  const seen = new Map();
  for (const p of PROVIDERS) {
    for (const kind of ['llm', 'asr']) {
      const applies = p.kind === kind || p.kind === 'both';
      if (!applies) continue;
      // 只有「该用途真的有内容」才算占用，避免一条 asr 专用的记录误报冲突
      const hasContent =
        kind === 'asr'
          ? !!(p.asrUrl || p.asrModel || (p.asrModels && p.asrModels.length))
          : !!(p.baseUrl || (p.models && p.models.length));
      if (!hasContent) continue;
      const key = kind + ':' + p.id;
      if (seen.has(key)) problems.push(`服务商 id 重复：${key}（${seen.get(key)} 与 ${p.name}）`);
      else seen.set(key, p.name);
    }
  }
  return problems;
}

/**
 * 估算「整理一节课笔记」要花多少钱。
 * 经验值：1 小时课 ≈ 1.2 万字逐字稿 ≈ 1.8 万 tokens 输入（含提示词与分块重复读入），
 * 输出（笔记正文）≈ 0.6 万 tokens。这是量级估算，不是精确计费。
 */
export const TOKENS_PER_HOUR = { input: 18000, output: 6000 };

export function estimateCost(providerId, modelId, hours = 1.5) {
  const p = getProvider(providerId, 'llm');
  if (!p || !p.models) return null;
  const m = p.models.find((x) => x.id === modelId) || p.models[0];
  if (!m || m.inPrice == null || m.outPrice == null) return null;
  const inTok = (TOKENS_PER_HOUR.input * hours) / 1000000;
  const outTok = (TOKENS_PER_HOUR.output * hours) / 1000000;
  return {
    yuan: inTok * m.inPrice + outTok * m.outPrice,
    model: m.id,
    inputTokens: Math.round(TOKENS_PER_HOUR.input * hours),
    outputTokens: Math.round(TOKENS_PER_HOUR.output * hours),
  };
}

/**
 * 决定「这次云端转写往哪发、用什么模型、要不要 verbose_json」。
 *
 * 放在这里（而不是 server.mjs 里）是为了能单测：这段逻辑写错的后果，要么是
 * 「用户保存的 API Key 被发到别人指定的服务器」，要么是「配置明明对了却一直 400」，
 * 两种都不该只能靠真发一次请求才发现。
 *
 * 安全约定：**一律只读服务端保存的 config，不看请求体**。请求体是客户端说了算的，
 * 允许它覆盖 endpoint/model/apiKey 就等于把用户的 Key 交出去。
 *
 * @param {{asr?: object}} config 服务端保存的完整配置
 * @returns {{url:string, model:string, verbose:boolean, apiKey:string, who:string, provider:string, ok:boolean, error?:string, maxSeconds?:number, maxBytes?:number}}
 */
export function resolveAsrTarget(config) {
  const a = (config && config.asr) || {};
  const provider = a.provider || 'local';
  const reg = getProvider(provider, 'asr');
  const who = reg ? `「${reg.name}」` : `「${provider}」`;
  const isCustom = provider === 'custom';
  const isLocal = provider === 'local' || (reg && reg.local);
  const url = isLocal ? '' : isCustom ? a.endpoint || (reg && reg.asrUrl) || '' : (reg && reg.asrUrl) || '';
  const model = a.model || (reg && reg.asrModel) || '';
  const verbose = !reg || reg.verbose !== false;
  const apiKey = a.apiKey || '';
  // 发请求前要自己拦的单文件上限（见 asrModels 里各条的 maxSeconds / maxBytes）。
  // 自定义服务商没有登记，就不拦 —— 用户自建的东西我们不知道边界，硬拦反而添乱。
  const spec = reg && !isCustom ? modelSpec(provider, 'asr', model) : null;
  const limit = {};
  if (spec && (spec.maxSeconds || spec.maxBytes)) {
    if (spec.maxSeconds) limit.maxSeconds = spec.maxSeconds;
    if (spec.maxBytes) limit.maxBytes = spec.maxBytes;
  }
  const base = { url, model, verbose, apiKey, who, provider, local: !!isLocal, ...limit };
  // 本地转写不走服务端代理（在浏览器里跑），这里直接说清楚，免得报「缺地址」误导人
  if (isLocal) return { ...base, ok: false, error: '本地转写不需要云端接口，它是在浏览器里跑的' };
  if (!url) {
    return { ...base, ok: false, error: `云端转写服务商 ${who} 还缺少接口地址：设置 → 转写接口地址` };
  }
  if (!apiKey) {
    return { ...base, ok: false, error: `还缺少云端转写的 API Key（${who}）：设置 → API Key` };
  }
  if (!model) {
    return { ...base, ok: false, error: `还没有填转写模型名（${who}）：设置 → 转写模型` };
  }
  return { ...base, ok: true };
}
