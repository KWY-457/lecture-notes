/**
 * 只读探查 Meetily 的 SQLite 数据库，看看它的设置存在哪些表里。
 * 运行： node tests/probe-meetily-db.mjs "D:\Download\Meetily\data\meeting_minutes.sqlite"
 */
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
let db;
try {
  db = new DatabaseSync(file, { readOnly: true });
} catch (e) {
  console.error('打不开数据库:', e.message);
  process.exit(1);
}

const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`共 ${tables.length} 张表\n`);

for (const t of tables) {
  let count = '?';
  try {
    count = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
  } catch {}
  console.log(`── ${t.name}  (${count} 行)`);
  const cols = (t.sql || '').match(/\(([\s\S]*)\)/);
  if (cols) {
    const defs = cols[1].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c));
    console.log(`   列: ${defs.join(', ')}`);
  }
  if (/setting|config|prefer|option/i.test(t.name) && count > 0) {
    try {
      for (const row of db.prepare(`SELECT * FROM "${t.name}" LIMIT 40`).all()) {
        console.log('   ' + JSON.stringify(row).slice(0, 300));
      }
    } catch (e) {
      console.log('   读取出错: ' + e.message);
    }
  }
  console.log('');
}

db.close();
