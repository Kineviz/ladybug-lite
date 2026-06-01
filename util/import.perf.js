/**
 * 分开导入（逐表 COPY）性能测试，每条语句 10 秒超时。
 *
 * 参考 util/test.large.js 的写法（CommonJS）。
 * util/export_parquet 是用标准 `EXPORT DATABASE` 导出的文件夹：
 *   - schema.cypher  建表 DDL（NODE / REL TABLE）
 *   - copy.cypher    COPY ... FROM "*.parquet" 导入语句
 *   - *.parquet      实际数据
 *
 * 为什么不用单条 `IMPORT DATABASE`：
 *   IMPORT DATABASE 是一条不可细分、不可中断的语句，整库导入要 ~9 分钟，
 *   且无法定位是哪一步慢。实测瓶颈 100% 集中在 `Includes` 这一条
 *   「带属性的关系 COPY」上（quantity/price）——同样的边，带属性 37s/有
 *   属性 vs 0.24s/无属性（429K 行），约 150× 差距，单线程。其余所有表
 *   （节点 ~1.4s、无属性关系 AtStore/Placed 均亚秒级）都很快。
 *   因此这里改成「分开导入」：schema + 逐表 COPY，逐条计时、逐条 10s 预算。
 *
 * 关于超时：
 *   conn.setQueryTimeout(10000) 在本版本 **不会中断 COPY**（实测一条 COPY
 *   会跑满 8.8 分钟而无视超时）。所以这里用 JS 墙钟（Promise.race）对每条
 *   语句强制 10s 预算：超时即判定该语句 FAIL 并退出进程（底层 COPY 无法
 *   取消，只能随进程结束而终止）。
 *   为尽量测全，节点先导入，关系再按 parquet 文件大小升序导入，
 *   慢的大表自然排在最后。
 *
 * 运行：
 *   node util/import.perf.js
 *
 * 可选参数：
 *   argv[2]  目标数据库文件（默认 util/perf_import_db）
 *   --keep   运行前不清空已有数据库（默认每次清空以测纯导入耗时）
 */

const fs = require("fs");
const path = require("path");
const lbug = require("./../");

const dataDir = path.join(__dirname, "export_parquet");
const BUDGET_MS = 10 * 60 * 1000; // 每条语句 10 分钟预算

const argv = process.argv.slice(2);
const keepExisting = argv.includes("--keep");
const dbPathArg = argv.find((a) => !a.startsWith("--"));
const dbPath = dbPathArg || path.join(__dirname, "perf_import_db");

// 把一段 cypher 脚本按 `;` 拆成独立语句，去掉空白行。
function splitStatements(text) {
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 把 COPY 语句里的相对 parquet 文件名替换成 export_parquet 下的绝对路径。
function absolutizeParquetPaths(stmt) {
  return stmt.replace(/FROM\s+"([^"]+\.parquet)"/gi, (_match, file) => {
    const abs = path.join(dataDir, file).replace(/\\/g, "/");
    return `FROM "${abs}"`;
  });
}

// 从 DDL 中提取 表名 -> 是否为 REL 表 的映射。
function parseTableKinds(schemaSql) {
  const kinds = new Map();
  const re = /CREATE\s+(NODE|REL)\s+TABLE\s+`([^`]+)`/gi;
  let m;
  while ((m = re.exec(schemaSql)) !== null) {
    kinds.set(m[2], m[1].toUpperCase() === "REL");
  }
  return kinds;
}

// 从 COPY 语句里提取目标表名。
function copyTargetTable(stmt) {
  const m = stmt.match(/COPY\s+`([^`]+)`/i);
  return m ? m[1] : "(unknown)";
}

// 取出 COPY 语句引用的 parquet 绝对路径（用于按文件大小排序 / 统计字节数）。
function copyParquetPath(stmt) {
  const m = stmt.match(/FROM\s+"([^"]+\.parquet)"/i);
  return m ? m[1] : null;
}

// 去掉 parquet 文件名后面的选项括号，如 (parallel=true)。
// 本版本「COPY FROM Parquet」仅接受 IGNORE_ERRORS 选项，其余选项会报错。
function stripCopyOptions(stmt) {
  return stmt.replace(/("[^"]+\.parquet")\s*\([^)]*\)/i, "$1");
}

// 去掉 REL 表 COPY 语句中表名与 FROM 之间的显式属性列清单，
// 例如 COPY `Includes` (`quantity`,`price`) FROM ...
// 本版本 REL COPY 直接按 parquet 列顺序解析（前两列 from/to 主键，其余为属性）。
function stripRelColumnList(stmt) {
  return stmt.replace(/(COPY\s+`[^`]+`)\s*\([^)]*\)\s+(FROM\b)/i, "$1 $2");
}

// 针对当前版本规整一条 COPY 语句为「列顺序」形式。
function normalizeCopy(stmt, isRel) {
  let s = stripCopyOptions(stmt);
  if (isRel) s = stripRelColumnList(s);
  return s;
}

// 工具函数：db / conn / res 一律不共享。
// 每次调用都新建 db + conn，执行单条语句，用完立即按 res -> conn -> db 顺序关闭，
// 下次使用必须重新调用本函数（即重新创建）。
// 数据落在磁盘上的同一个 dbPath，所以新连接能读到上一次写入的数据。
// 可选 onResult(one) 在关闭前读取结果并作为返回值。
async function runOnce(stmt, onResult) {
  const db = new lbug.Database(dbPath);
  const conn = new lbug.Connection(db);
  let res;
  try {
    await conn.init();
    conn.setQueryTimeout(BUDGET_MS); // 记录意图（注意：本版本不会中断 COPY）
    // 导入前关闭 spill to disk。连接不共享，故每条新连接都要单独设一次，
    // 否则对后续 COPY（在各自的新连接上执行）不生效。
    const spill = await conn.query("CALL spill_to_disk=false");
    (Array.isArray(spill) ? spill[0] : spill).close();
    res = await conn.query(stmt);
    const one = Array.isArray(res) ? res[0] : res;
    return onResult ? await onResult(one) : undefined;
  } finally {
    if (res) (Array.isArray(res) ? res[0] : res).close();
    await conn.close();
    await db.close();
  }
}

// 执行单条语句（不需要结果），内部用 runOnce 新建并关闭 db/conn/res。
async function exec(stmt) {
  await runOnce(stmt);
}

// 在 JS 墙钟上对一条语句强制 budgetMs 预算。
// 返回 { timedOut, ms, error }。timedOut=true 时底层查询仍在后台运行。
function runWithBudget(stmt, budgetMs) {
  const t0 = performance.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  const run = exec(stmt)
    .then(() => ({ timedOut: false }))
    .catch((error) => ({ timedOut: false, error }));
  return Promise.race([run, timeout]).then((r) => {
    clearTimeout(timer);
    return { ...r, ms: performance.now() - t0 };
  });
}

// 统计某张表的行数 / 边数。内部用 runOnce 新建并关闭 db/conn/res。
async function getCount(table, isRel) {
  const q = isRel
    ? `MATCH ()-[r:\`${table}\`]->() RETURN count(r) AS c`
    : `MATCH (n:\`${table}\`) RETURN count(n) AS c`;
  return runOnce(q, async (one) => {
    const rows = await one.getAll();
    const c = rows[0] ? rows[0].c : 0;
    return typeof c === "bigint" ? Number(c) : Number(c || 0);
  });
}

const fmtInt = (n) => n.toLocaleString("en-US");
const fmtMs = (ms) => `${ms.toFixed(0)} ms`;
const fmtRate = (rows, ms) =>
  ms > 0 ? `${fmtInt(Math.round(rows / (ms / 1000)))} rows/s` : "-";

// 人类可读的字节大小。
const fmtBytes = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};

// 数据库在磁盘上占用的总大小：主文件/目录 + 旁文件（WAL 等）。
function dbDiskSize() {
  const sizeOfPath = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return 0; // 文件不存在
    }
    if (!st.isDirectory()) return st.size;
    return fs
      .readdirSync(p)
      .reduce((s, f) => s + sizeOfPath(path.join(p, f)), 0);
  };
  return ["", ".wal", ".shadow", ".tmp"].reduce(
    (s, suffix) => s + sizeOfPath(dbPath + suffix),
    0
  );
}

// 进程内存：RSS（常驻）/ Heap（V8 堆已用）。
const fmtMem = () => {
  const m = process.memoryUsage();
  return `RSS ${fmtBytes(m.rss)} / Heap ${fmtBytes(m.heapUsed)}`;
};

// 记录运行期间的峰值 RSS（在每条 COPY 后采样）。
let peakRss = 0;
function sampleMem() {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  return rss;
}

(async () => {
  // 1) 准备：必要时清空旧库，保证测纯导入耗时。
  //    单文件数据库：主文件 + .wal 旁文件需一并删除，否则残留 WAL 会报
  //    "Database ID ... does not match"。
  if (!keepExisting) {
    for (const suffix of ["", ".wal", ".shadow", ".tmp"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }

  const schemaSql = fs.readFileSync(path.join(dataDir, "schema.cypher"), "utf8");
  const copySql = fs.readFileSync(path.join(dataDir, "copy.cypher"), "utf8");
  const tableKinds = parseTableKinds(schemaSql);

  // 解析 COPY 语句并绝对化路径；节点在前，关系按 parquet 大小升序排在后面，
  // 让慢的大表自然排最后，尽量在 10s 预算内测全其余表。
  const copyStmts = splitStatements(copySql).map(absolutizeParquetPaths);
  const sizeOf = (stmt) => {
    const p = copyParquetPath(stmt);
    return p && fs.existsSync(p) ? fs.statSync(p).size : 0;
  };
  const nodes = copyStmts.filter((s) => !tableKinds.get(copyTargetTable(s)));
  const rels = copyStmts
    .filter((s) => tableKinds.get(copyTargetTable(s)))
    .sort((a, b) => sizeOf(a) - sizeOf(b));
  const ordered = [...nodes, ...rels];

  const totalBytes = copyStmts.reduce((s, stmt) => s + sizeOf(stmt), 0);

  console.log("=== Ladybug 分开导入性能测试（逐表 COPY，每条 10s 超时） ===");
  console.log(`数据目录 : ${dataDir}`);
  console.log(`数据库   : ${dbPath}${keepExisting ? " (保留旧库)" : " (已清空)"}`);
  console.log(`Lbug 版本: ${lbug.VERSION}`);
  console.log(`单条预算 : ${BUDGET_MS} ms`);
  console.log(`parquet  : ${fmtBytes(totalBytes)}`);
  console.log(`起始内存 : ${fmtMem()}`);
  console.log("");

  // 注意：db / conn / res 不在多条语句间共享，统一交给 runOnce 每次新建并关闭。

  // 2) 建表（DDL）。
  const ddlStmts = splitStatements(schemaSql);
  const ddlStart = performance.now();
  for (const stmt of ddlStmts) {
    await exec(stmt);
  }
  console.log(`Schema (${ddlStmts.length} 条 DDL): ${fmtMs(performance.now() - ddlStart)}`);
  console.log("");

  // 3) 逐表 COPY，逐条 10s 预算。
  console.log("=== 逐表导入 ===");
  const timings = [];
  let copySum = 0;
  for (const rawStmt of ordered) {
    const table = copyTargetTable(rawStmt);
    const isRel = tableKinds.get(table) || false;
    const stmt = normalizeCopy(rawStmt, isRel);
    const kind = isRel ? "[REL] " : "[NODE]";

    const { timedOut, error, ms } = await runWithBudget(stmt, BUDGET_MS);

    if (timedOut) {
      console.log(
        `  COPY ${table.padEnd(12)} ${kind}  ⏱  超时 (>${BUDGET_MS} ms) — 判定为 FAIL`
      );
      console.log("");
      console.log(
        `该语句超过 ${BUDGET_MS} ms 预算。底层 COPY 无法中断、仍在后台运行，` +
          `进程将立即强制退出以终止它。\n` +
          `已知根因：带属性的关系 COPY（如 ${table}）在本版本是单线程慢路径。`
      );
      printSummary(timings, copySum, totalBytes, /*incomplete*/ true);
      // 底层 COPY 跑在 libuv worker 线程上，会阻塞 Node 的正常退出
      //（实测 process.exit() 不生效，进程会驻留到 COPY 跑完）。
      // 因此直接强杀自身进程，立刻终止它。
      process.kill(process.pid, "SIGKILL");
      return;
    }

    if (error) {
      console.log(`  COPY ${table.padEnd(12)} ${kind}  ✗ 失败: ${error.message}`);
      process.exit(1);
    }

    const rows = await getCount(table, isRel);
    copySum += ms;
    sampleMem(); // 采样当前内存，更新峰值
    timings.push({ table, isRel, ms, rows });
    console.log(
      `  COPY ${table.padEnd(12)} ${kind} ${fmtMs(ms).padStart(10)}  ` +
        `${fmtInt(rows).padStart(12)} 行  ${fmtRate(rows, ms).padEnd(16)}  ${fmtMem()}`
    );
  }

  printSummary(timings, copySum, totalBytes, /*incomplete*/ false);

  process.exit(0);
})().catch((err) => {
  console.error("导入性能测试失败:", err);
  process.exit(1);
});

function printSummary(timings, copySum, totalBytes, incomplete) {
  const totalRows = timings.reduce((s, t) => s + t.rows, 0);
  console.log("");
  console.log(`=== 汇总${incomplete ? "（未完整，已超时中止）" : ""} ===`);
  console.log(`已完成表    : ${timings.length}`);
  console.log(`COPY 累计耗时: ${fmtMs(copySum)}`);
  console.log(`已导入行数  : ${fmtInt(totalRows)}`);
  console.log(`平均吞吐    : ${fmtRate(totalRows, copySum)}`);
  if (totalBytes > 0) {
    console.log(`parquet 大小: ${fmtBytes(totalBytes)}`);
  }
  console.log(`数据库文件  : ${fmtBytes(dbDiskSize())}`);
  console.log(
    `峰值内存    : RSS ${fmtBytes(Math.max(peakRss, process.memoryUsage().rss))}`
  );
  console.log(`当前内存    : ${fmtMem()}`);
}
