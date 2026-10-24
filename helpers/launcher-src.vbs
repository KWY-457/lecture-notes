' ============================================================
'  讲义笔记 LectureNotes —— 启动器
'
'  双击本文件：在后台悄悄启动服务 -> 等它就绪 -> 弹出应用窗口。
'  全程没有命令行黑框。本地大模型不随启动自动拉起：点「AI 版笔记」
'  或校对时由应用按需拉起，不用就一直不占内存、不占显存。
'
'  端口与访问密钥由服务自己决定（每台机器首次启动时随机生成，
'  存在 data\instance.json 里），启动器只负责读 data\runtime.json
'  然后照地址开浏览器 —— 这样两台电脑上装同一份程序地址天然不同，
'  局域网里别人猜不到也扫不到。
'
'  浏览器配置目录（.browser-profile）**永远**放在 %LOCALAPPDATA%\LectureNotes\ 下，
'  哪怕程序在能写的目录里也一样 —— 它纯粹是浏览器缓存（实测能长到 4GB 以上），
'  没有任何"拷走当备份"的价值，放在程序目录里只会把备份/同步/打包全部撑爆。
'
'  想关掉：窗口里「设置 -> 退出服务」，或双击「停止.vbs」。
' ============================================================
Option Explicit

Dim sh, fso, base, profile, rtFile, rt, port, secret, url, waited
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base    = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- 数据目录与浏览器配置目录 -------------------------------------------
' 两者的规矩不一样，别混：
'   · data\ —— **跟着程序走**：程序目录里有 data\ 就用它（绿色版，拷走就是备份），
'     没有就去 %LOCALAPPDATA%\LectureNotes\data（跟 server.mjs 的 pickDataDir 一致）。
'   · .browser-profile —— **永远**放 %LOCALAPPDATA%\LectureNotes\，不看程序目录能不能写。
'
' 2026-10-24 改：以前是「程序目录能写就全放程序旁边」，结果解压在 D 盘的绿色版
' 攒出了 4.3GB 的 .browser-profile（1353 个缓存文件），拷项目、备份、打安装包
' 全被它拖累。浏览器 profile 是可以随时重建的缓存，没有任何"跟着程序走"的意义。
Dim localApp, userData
localApp = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
If localApp = "" Or InStr(localApp, "%") > 0 Then
  localApp = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\AppData\Local"
End If
userData = localApp & "\LectureNotes"

' 这里必须跟 server.mjs 的 pickDataDir() 完全一致：「程序目录下有 data\ 且能写」才用它。
' 只判 FolderExists 是不够的 —— 装到 Program Files 里、或者目录被设成只读时，
' data\ 可能存在但写不进去，那时服务会退回 %LOCALAPPDATA%，启动器却还去老地方
' 等 runtime.json，握手永远等不到（表现为启动器卡 90 秒然后报"服务没能启动起来"）。
If fso.FolderExists(base & "\data") And CanWrite(base & "\data") Then
  rtFile = base & "\data\runtime.json"
Else
  rtFile = userData & "\data\runtime.json"
  EnsureFolder userData & "\data"
End If
' 浏览器配置无条件进用户目录（不在程序目录里长任何东西）
profile = userData & "\.browser-profile"
EnsureFolder profile

' 1) 已经跑起来了吗？runtime.json 是服务启动成功后自己写的，
'    里面记着 pid / port / secret。进程还在就说明可以复用。
port = 0 : secret = ""
If fso.FileExists(rtFile) Then
  rt = ReadText(rtFile)
  port = JsonNum(rt, "port", 0)
  secret = JsonStr(rt, "secret", "")
  ' 文件在但进程已经死了：删掉它，别拿旧端口去连
  If port > 0 Then
    If Not Healthy(port) Then
      port = 0 : secret = ""
      On Error Resume Next
      fso.DeleteFile rtFile, True
      On Error GoTo 0
    End If
  End If
End If

' 2) 没在跑就启动。端口由服务自己决定，这里不用操心。
If port = 0 Then
  On Error Resume Next
  fso.DeleteFile rtFile, True
  On Error GoTo 0
  sh.CurrentDirectory = base
  ' 第二参数 0 = 隐藏窗口，服务在后台跑，你看不到黑框
  sh.Run """" & base & "\start.cmd"" --host 0.0.0.0", 0, False

  ' 等它把自己写进 runtime.json（最多 90 秒）
  waited = 0
  Do While waited < 180
    WScript.Sleep 500
    waited = waited + 1
    If fso.FileExists(rtFile) Then
      rt = ReadText(rtFile)
      port = JsonNum(rt, "port", 0)
      secret = JsonStr(rt, "secret", "")
      If port > 0 Then
        If Healthy(port) Then Exit Do
      End If
      port = 0
    End If
  Loop

  If port = 0 Then
    MsgBox "后台服务没能启动起来。" & vbCrLf & vbCrLf & _
           "请双击项目里的 start.cmd 看具体报错。" & vbCrLf & _
           "最常见的原因是：程序放在了没有写入权限的目录，或被杀毒软件拦住了。", _
           16, "讲义笔记"
    WScript.Quit 1
  End If
End If

' 3) 打开应用窗口
'    本机访问也带上密钥：服务虽然对 127.0.0.1 放行，
'    但带上之后浏览器就被种了 cookie，以后手动敲 127.0.0.1:端口 也能进。
If secret <> "" Then
  url = "http://127.0.0.1:" & port & "/" & secret & "/"
Else
  url = "http://127.0.0.1:" & port & "/"
End If
OpenApp url

' ---------------------------------------------------------------
'  小工具
' ---------------------------------------------------------------

' 这个目录能写吗（装到 Program Files 后就是不能）
Function CanWrite(p)
  Dim probe, ts
  CanWrite = False
  probe = p & "\.write-test-" & Replace(CStr(Timer), ".", "")
  On Error Resume Next
  Set ts = fso.CreateTextFile(probe, True)
  If Err.Number = 0 Then
    ts.Write "ok"
    ts.Close
    CanWrite = True
  End If
  Err.Clear
  fso.DeleteFile probe, True
  Err.Clear
  On Error GoTo 0
End Function

Sub EnsureFolder(p)
  Dim parent
  On Error Resume Next
  If fso.FolderExists(p) Then Exit Sub
  ' 逐级往上建：%LOCALAPPDATA% 一定存在，但从它往下的两级都得自己建
  parent = fso.GetParentFolderName(p)
  If parent <> "" And Not fso.FolderExists(parent) Then EnsureFolder parent
  fso.CreateFolder p
  Err.Clear
  On Error GoTo 0
End Sub

Function ReadText(p)
  Dim ts
  ReadText = ""
  On Error Resume Next
  Set ts = fso.OpenTextFile(p, 1)
  ReadText = ts.ReadAll
  ts.Close
  On Error GoTo 0
End Function

' 这个端口上跑的是不是本程序
Function Healthy(p)
  Dim http, body
  Healthy = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 800, 800, 1200, 1200
  http.Open "GET", "http://127.0.0.1:" & p & "/api/health", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then
      body = http.responseText
      If InStr(body, """ok"":true") > 0 Then Healthy = True
    End If
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ---- 极简 JSON 取值（只认 {"key": value}，够用了，不引第三方库）----
Function JsonNum(s, key, dflt)
  Dim m, v, c
  JsonNum = dflt
  m = InStr(s, """" & key & """")
  If m = 0 Then Exit Function
  m = InStr(m, s, ":")
  If m = 0 Then Exit Function
  v = ""
  Do While m < Len(s)
    m = m + 1
    c = Mid(s, m, 1)
    If c >= "0" And c <= "9" Then
      v = v & c
    ElseIf v <> "" Then
      Exit Do
    ElseIf c <> " " Then
      Exit Do
    End If
  Loop
  If IsNumeric(v) Then JsonNum = CLng(v)
End Function

Function JsonStr(s, key, dflt)
  Dim m, e
  JsonStr = dflt
  m = InStr(s, """" & key & """")
  If m = 0 Then Exit Function
  m = InStr(m, s, ":")
  If m = 0 Then Exit Function
  m = InStr(m, s, """")
  If m = 0 Then Exit Function
  e = InStr(m + 1, s, """")
  If e = 0 Then Exit Function
  JsonStr = Mid(s, m + 1, e - m - 1)
End Function

' 用 Edge/Chrome 的 --app 模式开一个没有地址栏的应用窗口
Sub OpenApp(u)
  Dim b, cmd
  b = FindBrowser()
  If b = "" Then
    ' 没有已知浏览器就用系统默认浏览器打开（会带地址栏，但功能一样）
    sh.Run u, 1, False
    Exit Sub
  End If
  cmd = """" & b & """ --app=" & u & " --window-size=1440,980" & _
        " --user-data-dir=""" & profile & """" & _
        " --no-first-run --no-default-browser-check --disable-sync" & _
        " --disable-features=msEdgeWelcomePage,msImplicitSignin"
  sh.Run cmd, 1, False
End Sub

Function FindBrowser()
  Dim list, i
  list = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\BraveSoftware\Brave-Browser\Application\brave.exe")
  FindBrowser = ""
  For i = 0 To UBound(list)
    If fso.FileExists(list(i)) Then
      FindBrowser = list(i)
      Exit Function
    End If
  Next
End Function
