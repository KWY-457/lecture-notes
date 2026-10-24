' ============================================================
'  讲义笔记 —— 停止一切
'
'  关掉后台的网页服务，并释放本地大模型占用的显存。
'  没在跑也不会报错。
'
'  端口和入口密钥都从 data\runtime.json 里读 —— 每台机器不一样，
'  写死端口就会关不掉别人的、或者关不掉自己的。
' ============================================================
Option Explicit

Dim sh, fso, http, base, rtFile, rt, i, port, secret, appOk, n, wmi, procs, p, body
Dim localApp, userData, probe
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
appOk = False

' runtime.json 可能在程序旁边（绿色版），也可能在用户目录（装到 Program Files 时）。
' 两个都找一遍，找到哪个用哪个。
rtFile = ""
probe = base & "\data\runtime.json"
If fso.FileExists(probe) Then rtFile = probe
If rtFile = "" Then
  localApp = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
  If localApp = "" Or InStr(localApp, "%") > 0 Then
    localApp = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\AppData\Local"
  End If
  userData = localApp & "\LectureNotes"
  probe = userData & "\data\runtime.json"
  If fso.FileExists(probe) Then rtFile = probe
End If

' 1) 网页服务（有专门的退出接口，只允许本机调用）
'    先看 runtime.json 拿到真实端口；文件不在就退回 8788 试一下老版本。
port = 8788 : secret = ""
If rtFile <> "" Then
  On Error Resume Next
  Set rt = fso.OpenTextFile(rtFile, 1)
  body = rt.ReadAll
  rt.Close
  On Error GoTo 0
  port = JsonNum(body, "port", 8788)
  secret = JsonStr(body, "secret", "")
End If

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1500, 1500, 3000, 3000
http.Open "POST", "http://127.0.0.1:" & port & "/api/shutdown", False
http.Send
If Err.Number = 0 And http.Status = 200 Then appOk = True
Err.Clear
On Error GoTo 0

' 2) 本地大模型（llama-server 没有退出接口，直接结束进程）
n = 0
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='llama-server.exe'")
For Each p In procs
  p.Terminate()
  n = n + 1
Next
On Error GoTo 0

Dim msg
msg = ""
If appOk Then msg = msg & "· 网页服务已关闭" & vbCrLf
If n > 0 Then msg = msg & "· 本地大模型已关闭（释放约 6GB 显存）" & vbCrLf
If msg = "" Then msg = "后台没有在运行的东西。"

MsgBox msg, 64, "讲义笔记"

' ---- 极简 JSON 取值（只认 {"key": value}，够用了，不引第三方库）----
Function JsonNum(s, key, dflt)
  Dim m, v
  JsonNum = dflt
  m = InStr(s, """" & key & """")
  If m = 0 Then Exit Function
  m = InStr(m, s, ":")
  If m = 0 Then Exit Function
  v = ""
  Do While m < Len(s)
    m = m + 1
    Dim c
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
