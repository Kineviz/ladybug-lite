const path = require("path");
const lbug = require("./../");

(async () => {
  // Create an empty on-disk database and connect to it
  const db = new lbug.Database(path.join(__dirname, "./demo_large"));
  const conn = new lbug.Connection(db);

  const queryResult = await conn.query(`MATCH (n:User) WHERE NOT ID(n) IN [internal_id(3, 0),internal_id(3, 1),internal_id(3, 2),internal_id(3, 3),internal_id(3, 4),internal_id(3, 5),internal_id(3, 6),internal_id(3, 7),internal_id(3, 8),internal_id(3, 9),internal_id(3, 10),internal_id(3, 11),internal_id(3, 12),internal_id(3, 13),internal_id(3, 14),internal_id(3, 15),internal_id(3, 16),internal_id(3, 17),internal_id(3, 18),internal_id(3, 19),internal_id(3, 20),internal_id(3, 21),internal_id(3, 22),internal_id(3, 23),internal_id(3, 24)] RETURN * LIMIT 20000`);


  // Get all rows from the query result
  const rows = await queryResult.getAll();

  // Print the rows
  console.log("res count: " ,rows.length);
    // for (const row of rows) {
    //     console.log(row);
    // }
  queryResult.close();
  conn.close();
  db.close();

  process.exit(0);

})();
