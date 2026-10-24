# -*- coding: utf-8 -*-
"""
把本机唯一的 Node 运行时复制进项目，让「讲义笔记」不再依赖 DSH。

背景（实测）：
  这台机器上没有任何独立安装的 Node.js ——
    C:\\Program Files\\nodejs\\node.exe                不存在
    C:\\Program Files (x86)\\nodejs\\node.exe          不存在
    C:\\Users\\KWY\\AppData\\Local\\Programs\\nodejs\\node.exe  不存在
  机器级 / 用户级 PATH 里也没有 node。
  唯一的运行时是 DSH 自带的那个。start.cmd 找不到它，于是双击启动器
  只能得到「后台服务没能启动起来」。

  对老大自己用：把 DSH 的路径写进 start.cmd 就行（已做）。
  但对「卖出去」这件事不够 —— 买家的电脑上不会有 DSH。
  所以这里把运行时复制进项目，做成自带运行时的绿色包。

用法：
  python bundle-runtime.py [源 node.exe 路径]
"""
import os
import shutil
import subprocess
import sys

PROJ = os.path.dirname(os.path.abspath(__file__))
DEST_DIR = os.path.join(PROJ, "runtime")
DEST = os.path.join(DEST_DIR, "node.exe")

# 默认源：本机唯一一个真正的 Node 运行时（DSH 自带）。
# 注意别拿 sys.executable —— 本机 python.exe 是个 100KB 的壳，复制过来跑不起来
# （退出码 3221225781 = STATUS_DLL_NOT_FOUND）。
DEFAULT_SRC = r"C:\Users\KWY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
if not src or not os.path.isfile(src):
    sys.exit("找不到源 node.exe：%r" % src)
if os.path.getsize(src) < 10 * 1024 * 1024:
    sys.exit("源文件只有 %.1f MB，八成是个壳不是真的 node.exe：%s"
             % (os.path.getsize(src) / 1024 / 1024, src))

os.makedirs(DEST_DIR, exist_ok=True)
shutil.copy2(src, DEST)

# 确认复制过来的这个真能跑（别只看文件存在）
out = subprocess.run([DEST, "-v"], capture_output=True, text=True)
version = (out.stdout or out.stderr).strip()
size_mb = os.path.getsize(DEST) / 1024 / 1024
print("已复制 -> %s" % DEST)
print("大小: %.1f MB" % size_mb)
print("版本: %s (退出码 %s)" % (version, out.returncode))
if out.returncode != 0:
    sys.exit("复制过来的 node.exe 跑不起来，已中止")
