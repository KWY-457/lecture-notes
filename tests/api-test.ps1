# LectureNotes API 端到端测试
# 用法： pwsh -File tests/api-test.ps1  [-Base http://127.0.0.1:8788]
param([string]$Base = "http://127.0.0.1:8788")

$ErrorActionPreference = "Continue"
$pass = 0; $fail = 0
function Check($name, $cond, $detail = "") {
  if ($cond) { Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green; $script:pass++ }
  else { Write-Host ("  [FAIL] {0} {1}" -f $name, $detail) -ForegroundColor Red; $script:fail++ }
}
function Get-Json($url) { (& curl.exe -s --max-time 15 $url) | ConvertFrom-Json }
function Post-Json($url, $obj, $method = "POST") {
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
  $r = & curl.exe -s --max-time 30 -X $method "$url" -H "content-type: application/json" --data-binary "@$tmp"
  Remove-Item $tmp -Force
  return ($r | ConvertFrom-Json)
}

Write-Host "`n=== LectureNotes 接口测试 @ $Base ===`n" -ForegroundColor Cyan

# 1. 健康检查
$h = Get-Json "$Base/api/health"
Check "GET /api/health" ($h.ok -eq $true) ($h | Out-String)
Check "返回 Node 版本" ([bool]$h.node) "node=$($h.node)"
Check "数据目录在工作区内" ($h.dataDir -like "*lecture-notes*") $h.dataDir

# 2. 静态资源
foreach ($f in @("", "app.js", "app.css", "summarize.js", "md.js", "llm.js", "asr-local.js", "worker-asr.js")) {
  $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 10 "$Base/$f"
  Check "静态资源 /$f" ($code -eq "200") "HTTP $code"
}

# 3. 配置读写
$cfg = Get-Json "$Base/api/config"
Check "GET /api/config" ($cfg.ok -eq $true)
# 本机（127.0.0.1）请求会回传真实 Key —— 这是为了让人能确认 Key 还在、能复制出来。
# 手机/局域网访问时才只给掩码，那条边界在 test-cloud-e2e.mjs 里单独验。
Check "本机可以看到 Key 原文" ($cfg.config.asr.apiKey -ne $null) "本机应回传明文"
Check "同时给出掩码" ([string]::IsNullOrEmpty($cfg.config.asr.apiKey) -or $cfg.config.asr.apiKeyMasked) "apiKeyMasked 应有值"
$saved = Post-Json "$Base/api/config" @{ notes = @{ style = "outline"; maxPointsPerTopic = 5 } } "PUT"
Check "PUT /api/config 保存成功" ($saved.config.notes.style -eq "outline") ($saved | Out-String)
Check "PUT /api/config 生效" ((Get-Json "$Base/api/config").config.notes.style -eq "outline")
Post-Json "$Base/api/config" @{ notes = @{ style = "exam"; maxPointsPerTopic = 6 } } "PUT" | Out-Null

# 4. 上传
$tmpAudio = Join-Path $PSScriptRoot "_tmp_audio.wav"
[System.IO.File]::WriteAllBytes($tmpAudio, (New-Object byte[] 2048))
$q = "title=" + [uri]::EscapeDataString("接口测试课") + "&filename=test.wav&course=" + [uri]::EscapeDataString("测试课程") + "&duration=690"
$up = (& curl.exe -s --max-time 30 -X POST "$Base/api/lectures?$q" -H "content-type: audio/wav" --data-binary "@$tmpAudio") | ConvertFrom-Json
Check "POST /api/lectures 上传" ($up.ok -eq $true) ($up | Out-String)
$id = $up.lecture.id
Check "返回讲次 id" ([bool]$id) "id=$id"
Check "时长被记录" ($up.lecture.duration -eq 690)
Check "课程被记录" ($up.lecture.course -eq "测试课程")
Remove-Item $tmpAudio -Force

# 5. 空文件应当被拒绝
$emptyFile = Join-Path $PSScriptRoot "_tmp_empty.bin"
[System.IO.File]::WriteAllBytes($emptyFile, (New-Object byte[] 0))
$empty = (& curl.exe -s --max-time 20 -X POST "$Base/api/lectures?filename=empty.wav" -H "content-type: audio/wav" --data-binary "@$emptyFile") | ConvertFrom-Json
Check "空文件被拒绝" ($empty.ok -eq $false) ($empty | Out-String)
Remove-Item $emptyFile -Force

# 6. 列表与详情
$list = Get-Json "$Base/api/lectures"
Check "GET /api/lectures 列表包含新讲次" (@($list.lectures | Where-Object { $_.id -eq $id }).Count -eq 1) ("共 " + @($list.lectures).Count + " 条，目标 " + $id)
$detail = Get-Json "$Base/api/lectures/$id"
Check "GET /api/lectures/:id 详情" ($detail.lecture.id -eq $id)
Check "新讲次带空逐字稿" ($detail.transcript.segments.Count -eq 0)

# 7. Range 请求（音频拖动）
$hdr = & curl.exe -s -o NUL -D - --max-time 10 -H "Range: bytes=0-99" "$Base/api/lectures/$id/audio"
Check "音频支持 Range (206)" (($hdr -join "`n") -match "206") ($hdr -join " ")
Check "返回 Content-Range" (($hdr -join "`n") -match "Content-Range")

# 8. 不存在的资源
Check "未知讲次返回错误" ((Get-Json "$Base/api/lectures/nosuchid12345").ok -eq $false)
Check "非法 id 被拒" ((Get-Json "$Base/api/lectures/..%2f..%2fetc").ok -eq $false)

# 9. 路径穿越
$t1 = & curl.exe -s -o NUL -w "%{http_code}" --max-time 10 "$Base/../server.mjs"
$t2 = & curl.exe -s --max-time 10 "$Base/..%2fserver.mjs"
Check "拒绝路径穿越（不返回源码）" (($t2 -notmatch "createServer") -and ($t1 -ne "200")) "code=$t1"

# 10. 保存逐字稿
$segs = @(
  @{ start = 0; end = 32; text = "好，那我们今天接着讲二叉树的遍历。" },
  @{ start = 32; end = 78; text = "先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。" },
  @{ start = 78; end = 140; text = "那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历，顺序是左、根、右；第三种是后序遍历，顺序是左、右、根。" },
  @{ start = 140; end = 196; text = "这里特别要注意的是，中序遍历在二叉搜索树上的结果一定是一个递增序列，这个性质非常关键，大家一定要记住。" }
)
$tr = Post-Json "$Base/api/lectures/$id/transcript" @{
  language = "zh"; engine = "unit-test"; model = "fake"; duration = 690
  text = (($segs | ForEach-Object { $_.text }) -join "`n"); segments = $segs
} "PUT"
Check "PUT 逐字稿" ($tr.transcript.segments.Count -eq 4) ($tr | Out-String)
Check "讲次状态变为已转写" ((Get-Json "$Base/api/lectures/$id").lecture.status -eq "transcribed")

# 11. 保存笔记 + 导出
$note = Post-Json "$Base/api/lectures/$id/note" @{ markdown = "# 测试笔记`n`n## 重点`n- 四种遍历方式 [01:18](#t=78)"; mode = "offline"; model = "" } "PUT"
Check "PUT 笔记" ($note.note.markdown -like "*四种遍历方式*")
$md = & curl.exe -s --max-time 10 "$Base/api/lectures/$id/export?kind=note"
Check "导出 Markdown" ($md -match "测试笔记")
$srt = & curl.exe -s --max-time 10 "$Base/api/lectures/$id/export?kind=srt"
Check "导出 SRT 含时间轴" ($srt -match "00:00:00,000 --> 00:00:32,000") ($srt | Select-Object -First 3 | Out-String)
$txt = & curl.exe -s --max-time 10 "$Base/api/lectures/$id/export?kind=txt"
Check "导出 TXT" ($txt -match "二叉树的遍历")
$docxOut = Join-Path $PSScriptRoot "_tmp_export.docx"
$docxHdr = & curl.exe -s --max-time 20 -o $docxOut -D - "$Base/api/lectures/$id/export"
Check "导出 Word 的 Content-Type" (($docxHdr -join "`n") -match "wordprocessingml") (($docxHdr -join " ") -replace "`r","")
$b = [System.IO.File]::ReadAllBytes($docxOut)
Check "导出 Word 是合法 docx（PK 魔数）" ($b.Length -gt 2000 -and $b[0] -eq 0x50 -and $b[1] -eq 0x4B) ("size=" + $b.Length + " head=" + $b[0].ToString("X2") + $b[1].ToString("X2"))
Remove-Item $docxOut -Force

# 12. 重命名
$ren = Post-Json "$Base/api/lectures/$id" @{ title = "改过名字的课" } "PATCH"
Check "PATCH 重命名" ($ren.lecture.title -eq "改过名字的课")

# 13. LLM 代理在连不上后端时应给出清晰错误（不依赖当前是否配置了模型）
$llm = Post-Json "$Base/api/llm" @{ messages = @(@{ role = "user"; content = "hi" }); baseUrl = "http://127.0.0.1:1/v1" } "POST"
Check "LLM 连不上时返回明确错误" ($llm.ok -eq $false -and $llm.error) ($llm | Out-String)

# 14. 删除
Check "DELETE 讲次" (((& curl.exe -s -X DELETE "$Base/api/lectures/$id") | ConvertFrom-Json).ok -eq $true)
Check "删除后列表里没有了" (@((Get-Json "$Base/api/lectures").lectures | Where-Object { $_.id -eq $id }).Count -eq 0)
Check "删除后详情 404" ((Get-Json "$Base/api/lectures/$id").ok -eq $false)

Write-Host "`n=== 结果：$pass 通过 / $fail 失败 ===`n" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
exit $fail
