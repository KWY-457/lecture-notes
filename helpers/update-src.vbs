' 讲义笔记 LectureNotes —— 更新收尾脚本（打包时由 build.ps1 转成 UTF-16LE，名字叫「更新.vbs」）
'
' 它唯一的职责：
'   1. 等旧的服务进程真的退出（不是 sleep 几秒，是轮询进程列表）；
'   2. 把下载好的安装包拉起来；
'   3. 安装程序自己会覆盖文件、自己会启动新版（安装包里有 [Run]）。
'
' 为什么必须等进程真死：runtime\node.exe 在服务跑着的时候被 Windows 锁着，
' 安装程序写到一半会失败，用户就看到「无法写入文件」。而 node 退出不是瞬间的
' （它还要落盘 runtime.json、关 http 连接），所以不能写个 Sleep 3000 就算完。
'
' 参数：
'   WScript.Arguments(0) = 旧进程 pid
'   WScript.Arguments(1) = 安装包完整路径
'
' 任何一步失败都不弹模态框（用户可能人不在），只写日志到数据目录的 update.log，
' 下次打开软件时界面能读到原因。

Option Explicit

Const LOG_MAX = 200000

Dim fso, sh, pid, setupPath, logPath, waited, i, alive

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If

pid = WScript.Arguments(0)
setupPath = WScript.Arguments(1)

logPath = LogFilePath()

Sub Log(msg)
  On Error Resume Next
  Dim f
  ' 第四个参数 -1 = TristateTrue（Unicode / UTF-16LE）。
  ' 不写的话默认是 ANSI（中文系统上是 GBK），一旦用户的系统语言不是中文，
  ' 日志就是一堆问号；而且我们自己的程序读它也得猜编码。写 Unicode 最省事。
  Set f = fso.OpenTextFile(logPath, 8, True, -1)
  f.WriteLine Now & "  " & msg
  f.Close
  If Err.Number <> 0 Then Err.Clear
  On Error GoTo 0
End Sub

' 日志跟安装包放一起（数据目录\update\update.log），卸载不清理，方便事后追。
Function LogFilePath()
  Dim d
  d = fso.GetParentFolderName(setupPath)
  If Not fso.FolderExists(d) Then
    d = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\LectureNotes\update"
    If Not fso.FolderExists(d) Then fso.CreateFolder d
  End If
  LogFilePath = d & "\update.log"
End Function

Log "启动：等待 pid " & pid & " 退出，安装包 " & setupPath

If Not fso.FileExists(setupPath) Then
  Log "安装包不存在，放弃"
  WScript.Quit 3
End If

' 最多等 60 秒（120 × 500ms）。正常情况 node 几百毫秒就退了；
' 等这么久是给「正在写一条很长的录音」留余地 —— 那种情况它会先把文件写完。
waited = 0
Do While waited < 120
  If Not ProcessAlive(pid) Then Exit Do
  WScript.Sleep 500
  waited = waited + 1
Loop

If ProcessAlive(pid) Then
  Log "等了 " & (waited / 2) & " 秒旧进程还没退出，仍然尝试安装（安装程序会自己判断）"
Else
  Log "旧进程已退出（等了约 " & (waited / 2) & " 秒）"
End If

' 再稳一下：进程表消失和文件句柄释放之间有一点时间差，实测 300ms 够用。
WScript.Sleep 300

On Error Resume Next
' 用 ShellExecute 走「双击」那条路：安装包自己会请求提权（如果需要）。
sh.Run """" & setupPath & """", 1, False
If Err.Number <> 0 Then
  Log "拉起安装包失败：" & Err.Description
  Err.Clear
  On Error GoTo 0
  WScript.Quit 4
End If
On Error GoTo 0

Log "已拉起安装程序，脚本结束"
WScript.Quit 0

' 进程还活着吗。用 WMI 查，比 tasklist 稳（tasklist 的输出格式随语言变）。
Function ProcessAlive(thePid)
  Dim svc, list, p
  ProcessAlive = False
  On Error Resume Next
  Set svc = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    Err.Clear
    ' 查不了就当它已经退了 —— 宁可早装一秒，也不要卡在这里不装
    ProcessAlive = False
    On Error GoTo 0
    Exit Function
  End If
  Set list = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & thePid)
  For Each p In list
    ProcessAlive = True
  Next
  Err.Clear
  On Error GoTo 0
End Function
