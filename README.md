# ladybug-lite

A lightweight fork of the [Ladybug](https://github.com/LadybugDB/ladybug) (formerly [Kùzu](https://github.com/kuzudb/kuzu)) embedded graph database, optimized for faster installation and broader compatibility.

## What is Ladybug?

Ladybug is a high-performance embedded graph database management system designed for efficient graph data storage and querying. It supports property graphs and the openCypher query language. Ladybug is the renamed continuation of the Kùzu project.

## Why We Forked Ladybug

- **Large Package Size:** The official Ladybug (`@ladybugdb/core`) npm package can exceed 100MB, resulting in slow downloads and build times, particularly outside Europe and North America. **ladybug-lite** strips it down to essential binaries for a smaller, faster package.

- **No Alpine Linux Support:** The official Ladybug package doesn't ship Alpine Linux binaries out of the box, which is critical for lightweight Docker containers. **ladybug-lite** includes musl libc-compatible binaries to work seamlessly with Alpine Linux environments.

## Benefits

- **Smaller Footprint:** Significantly reduced package size for faster downloads and deployments.

- **Broader Compatibility:** Full support for Alpine Linux and musl libc environments.

- **Faster Integration:** Reduced build times in CI/CD pipelines and development workflows.

- **Same Core Power:** Retains all of Ladybug's essential functionality and performance in a leaner package.

## Installation

```bash
npm install @kineviz/ladybug-lite
# or
yarn add @kineviz/ladybug-lite
```

## Usage

```javascript
const lbug = require('@kineviz/ladybug-lite');
const path = require("path");

(async () => {
  // Create an empty on-disk database and connect to it
  const db = new lbug.Database(path.join(__dirname, "./demo_db"));
  const conn = new lbug.Connection(db);
  try {
    await conn.query(`
      CREATE NODE TABLE Movie (name STRING, PRIMARY KEY(name));
      CREATE NODE TABLE Person (name STRING, birthDate STRING, PRIMARY KEY(name));
      CREATE REL TABLE ActedIn (FROM Person TO Movie);
      CREATE (:Person {name: 'Al Pacino', birthDate: '1940-04-25'});
      CREATE (:Person {name: 'Robert De Nero', birthDate: '1943-08-17'});
      CREATE (:Movie {name: 'The Godfather: Part II'});
      MATCH (p:Person), (m:Movie) WHERE p.name = 'Al Pacino' AND m.name = 'The Godfather: Part II' CREATE (p)-[:ActedIn]->(m);
      MATCH (p:Person), (m:Movie) WHERE p.name = 'Robert De Nero' AND m.name = 'The Godfather: Part II' CREATE (p)-[:ActedIn]->(m);
      `)
  } catch (e) {
    console.error("Create DB failed:",e.message);
  }

  const queryResult = await conn.query("MATCH (p)-[:ActedIn]->(m) RETURN *");

  // Get all rows from the query result
  const rows = await queryResult.getAll();

  // Print the rows
  for (const row of rows) {
    console.log(row);
  }

})();
```

## Compatibility

ladybug-lite is tested on:
- Linux (glibc and musl libc) — x64 and arm64
- macOS — Apple Silicon (arm64) and Intel (x64). The Intel build is produced from source on a `macos-26-intel` GitHub Actions runner; Apple Silicon uses upstream's prebuilt.
- Windows — x64

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the same license as Ladybug. See [LICENSE](LICENSE) file for details.
