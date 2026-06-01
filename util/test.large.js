const fs = require("fs");
const path = require("path");
const lbug = require("./../");

(async () => {
  // Create an empty on-disk database and connect to it
  const bufferManagerSize = fs.statSync(path.join(__dirname, "./perf_import_db")).size;
  console.log("file size: ", Math.round(bufferManagerSize / (1024 * 1024)), "MB");
 
  const db = new lbug.Database(path.join(__dirname, "./perf_import_db"), 0, undefined, true);
  const conn = new lbug.Connection(db);

  // 统计节点数。
  const nodeResult = await conn.query(
    `MATCH (n) RETURN count(n) AS c`
  );
  const nodeCount = (await nodeResult.getAll())[0].c;
  nodeResult.close();

  // 统计关系数。
  const relResult = await conn.query(
    `MATCH ()-[r]->() RETURN count(r) AS c`
  );
  const relCount = (await relResult.getAll())[0].c;
  relResult.close();

  console.log("节点数:", nodeCount);
  console.log("关系数:", relCount);

  conn.close();
  db.close();

  process.exit(0);

})();
