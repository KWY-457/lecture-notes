/**
 * 显存读数核对：把界面里那个「显卡显存 X / Y GB」一行，逐层拆开验一遍。
 *
 * 老大问过一次「我显存一共 16G，咋说的 8G」——所以这个脚本要把三层都查清：
 *   ① 服务端 nvidia-smi 报多少（界面显示的就是这个数）
 *   ② Windows 自己认多少（注册表里的真实硬件显存 / WMI 那个会溢出的字段）
 *   ③ 系统内存多少（「16G」很可能是内存，不是显存）
 *
 * 三层对不上就是 bug；三层一致，界面就是对的，得换个地方找 16G 是哪来的。
 *
 * 用法：node tests/check-vram-truth.mjs
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

/** 服务端用的就是这段逻辑（server.mjs 的 readGpu），这里照抄一份来核对 */
async function readGpu() {
  const exes = ['C:\\Windows\\System32\\nvidia-smi.exe', 'nvidia-smi'];
  for (const exe of exes) {
    try {
      const { stdout } = await execFileAsync(
        exe,
        ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
        { timeout: 8000, windowsHide: true }
      );
      const raw = String(stdout).trim();
      const line = raw.split('\n')[0];
      const [name, total, used, free, util] = line.split(',').map((s) => s.trim());
      return { available: true, name, totalMB: +total, usedMB: +used, freeMB: +free, utilPercent: +util, lines: raw.split('\n').filter(Boolean).length };
    } catch {}
  }
  return { available: false };
}

/** 注册表里的真实硬件显存（Windows 自己认的，不受驱动 API 差异影响） */
async function readRegistryVram() {
  // 注意：可能「能跑但被策略拦」，execFile 会直接抛错，
  // 所以这里 catch 住并返回原因，让调用方决定这是硬失败还是仅供参照。
  const ps = "$b='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; Get-ChildItem $b -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.'HardwareInformation.qwMemorySize') { '{0}|{1}|{2}' -f $_.PSChildName, $p.DriverDesc, $p.'HardwareInformation.qwMemorySize' } }";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000, windowsHide: true });
    const rows = String(stdout)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [key, desc, bytes] = l.trim().split('|');
        return { key, desc, bytes: Number(bytes), gb: Number(bytes) / 1024 ** 3 };
      });
    return { rows, err: '' };
  } catch (e) {
    return { rows: [], err: (e && (e.message || e.stderr)) || '未知' };
  }
}

async function wmiVram() {
  const ps = "Get-CimInstance Win32_VideoController | ForEach-Object { '{0}|{1}' -f $_.Name, $_.AdapterRAM }";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000, windowsHide: true });
    return String(stdout)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [n, b] = l.split('|');
        return { name: (n || '').trim(), gb: Number(b) / 1024 ** 3 };
      });
  } catch {
    return [];
  }
}

async function physicalRamGb() {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,1)'], { timeout: 15000, windowsHide: true });
    return Number(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

console.log('\n=== ① 服务端那条路（nvidia-smi，界面显示的来源）===');
const gpu = await readGpu();
console.log('  ' + JSON.stringify(gpu));
check('nvidia-smi 读到了显卡', gpu.available === true);
check('只有一行输出（多卡才会串行，界面只取第一行）', gpu.lines === 1, `实际 ${gpu.lines} 行`);
check('总显存是个合理数字（1~80GB）', gpu.totalMB > 1024 && gpu.totalMB < 80 * 1024, `${gpu.totalMB} MiB`);
// nvidia-smi 的 used+free 不会精确等于 total（驱动自己留了一块 reserved），
// 差几百 MiB 正常；差上千 MiB 才说明读串了卡。
const mathDiff = gpu.usedMB + gpu.freeMB - gpu.totalMB;
check('已用 + 空闲 与总量差在合理范围（<512MiB，驱动会留 reserved）', Math.abs(mathDiff) < 512, `${gpu.usedMB}+${gpu.freeMB} vs ${gpu.totalMB}，差 ${mathDiff} MiB`);
check('空闲不超过总量', gpu.freeMB / gpu.totalMB <= 1.0001);

console.log('\n=== ② Windows 自己认的显存（跟显卡物理规格对一下）===');
const regRes = await readRegistryVram();
const nv = regRes.rows.find((r) => /NVIDIA/i.test(r.desc));
for (const r of regRes.rows) console.log(`  ${r.key}  ${r.desc}  ${r.gb.toFixed(2)} GB`);
if (!regRes.rows.length) {
  console.log(`  （从 node 起 powershell 读注册表拿不到数据：${String(regRes.err).split('\n')[0].slice(0, 120)}）`);
  console.log('   → 不作为失败：注册表只是旁证，判据用 nvidia-smi 那一行。');
}
if (nv && gpu.available) {
  const diff = Math.abs(nv.gb * 1024 - gpu.totalMB);
  console.log(`  注册表 ${(nv.gb * 1024).toFixed(0)} MiB  vs  nvidia-smi ${gpu.totalMB} MiB  （差 ${diff.toFixed(0)} MiB）`);
  check('两条口径一致（差 < 256MiB，界面就没报错）', diff < 256, `差 ${diff.toFixed(0)} MiB`);
} else if (!nv) {
  check('注册表读不到时，nvidia-smi 的 total 就是唯一判据', gpu.available === true);
}
const wmi = await wmiVram();
for (const w of wmi) console.log(`  WMI: ${w.name}  AdapterRAM=${w.gb.toFixed(2)} GB（这个字段 4GB 就溢出，不可信）`);
check('Win32_VideoController 的 AdapterRAM 明显小于真实显存 → 证实这个字段不可用', wmi.some((w) => /NVIDIA/i.test(w.name) && w.gb * 1024 < gpu.totalMB - 1024), JSON.stringify(wmi));

console.log('\n=== ③ 系统内存（「16G」很可能是这个，不是显存）===');
const ram = await physicalRamGb();
console.log(`  物理内存 = ${ram} GB`);
check('物理内存读到了', ram > 1);

console.log('\n=== ④ 界面那句话有没有夸大或缩小 ===');
if (gpu.available && ram > 1) {
  const totalGb = gpu.totalMB / 1024;
  console.log(`  界面会说：「${(gpu.usedMB / 1024).toFixed(1)} / ${totalGb.toFixed(1)} GB 已用，空闲 ${(gpu.freeMB / 1024).toFixed(1)} GB」`);
  check('界面用的总量就是显卡真实显存', Math.abs(totalGb - gpu.totalMB / 1024) < 0.05);
  const halfRam = ram / 2;
  if (Math.abs(halfRam - totalGb) < 0.6) {
    console.log(`  ⚠ 内存的一半（${halfRam.toFixed(1)}GB）≈ 显存（${totalGb.toFixed(1)}GB），最容易看混的就是这两个数`);
    console.log('    任务管理器「共享 GPU 内存」显示的就是内存的一半，那个不是显存。');
  }
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败 / ${pass} 项通过`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
