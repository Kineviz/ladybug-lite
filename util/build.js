

const fs = require("fs");
const path = require("path");


/**
 * Install packages
 */

const installPackage = (packageName, group = 'dev') => {

  console.log(
    `Install package ${packageName}...`
  );
  const childProcess = require("child_process");
  childProcess.execSync(`npm install ${packageName} --save-dev`, {
    cwd: rootDir,
    stdio: "inherit",
  });

}


/**
 * Copies files from the 'node_modules/@ladybugdb/core' directory to the current directory.
 * Excludes specific directories ('lbug-source', 'node_modules') and specific files ('lbugjs.node', 'package.json').
 */

const copyDir = (src, dest, excludeEntries = []) => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!excludeEntries.includes(entry.name)) {
        copyDir(srcPath, destPath);
      }
    } else if (!excludeEntries.includes(entry.name)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied: ${srcPath} -> ${destPath}`);
    }
  }
};

/**
 * Deletes all files and directories in the current directory
 * except for 'copy.js', 'package.json', and the 'node_modules' directory.
 */
const deleteFiles = (directory, excludeEntries = []) => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    // Skip if the entry is in the exclusion list
    if (excludeEntries.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively delete directory contents then the directory itself
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`Deleted directory: ${fullPath}`);
    } else {
      // Delete file
      fs.unlinkSync(fullPath);
      console.log(`Deleted file: ${fullPath}`);
    }
  }
};

const npmPublish = (package) => {
  console.log(
    `Publishing package ${package.name}(${package.version})... to npm`
  );
  const npmrcPath = path.join(rootDir, ".npmrc");
  fs.writeFileSync(
    npmrcPath,
    `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`,
    { encoding: "utf-8" }
  );

  const childProcess = require("child_process");
  try {
    childProcess.execSync("npm publish --access public --registry https://registry.npmjs.org", {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (err) {
    console.error("npm publish failed:", err);
  }
};

/**
 * Copies any lbugjs-*.node binaries that CI wrote into
 * node_modules/@ladybugdb/core/prebuilt/ up into ./prebuilt/ at the repo root.
 * This covers freshly-built artifacts on every platform (darwin-amd64 and the
 * Alpine arm64 build would otherwise never make it to the committed prebuilt/
 * directory, since copyPrebuiltBinaries below is gated to linux-x64/win32).
 */
const copyLocalPrebuiltBinaries = () => {
  const localPrebuiltDir = path.join(srcDir, "prebuilt");
  if (!fs.existsSync(localPrebuiltDir)) {
    return;
  }
  const rootPrebuiltDir = path.join(rootDir, "prebuilt");
  if (!fs.existsSync(rootPrebuiltDir)) {
    fs.mkdirSync(rootPrebuiltDir, { recursive: true });
  }
  const entries = fs
    .readdirSync(localPrebuiltDir)
    .filter((f) => f.endsWith(".node"));
  for (const file of entries) {
    const src = path.join(localPrebuiltDir, file);
    const dest = path.join(rootPrebuiltDir, file);
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${src} -> ${dest}`);
  }
};

/**
 * Fetches platform-specific prebuilt binaries from the scoped @ladybugdb/core-*
 * packages and copies each one's lbugjs.node into ./prebuilt/, remapping x64
 * filenames to amd64 so the runtime loader can find them.
 */
const copyPrebuiltBinaries = () => {
  const corePackageJsonPath = path.join(srcDir, "package.json");
  if (!fs.existsSync(corePackageJsonPath)) {
    console.error("@ladybugdb/core package.json not found, skipping prebuilt fetch");
    return;
  }
  const lbugVersion = JSON.parse(fs.readFileSync(corePackageJsonPath, "utf8")).version;

  const platformPackages = [
    "core-darwin-arm64",
    "core-darwin-x64",
    "core-linux-arm64",
    "core-linux-x64",
  ];

  const installArgs = platformPackages
    .map((pkg) => `@ladybugdb/${pkg}@${lbugVersion}`)
    .join(" ");

  console.log(`Installing platform-specific prebuilt packages: ${installArgs}`);
  const childProcess = require("child_process");
  childProcess.execSync(`npm install --force --no-save ${installArgs}`, {
    cwd: rootDir,
    stdio: "inherit",
  });

  const prebuiltDir = path.join(rootDir, "prebuilt");
  if (!fs.existsSync(prebuiltDir)) {
    fs.mkdirSync(prebuiltDir, { recursive: true });
  }

  for (const pkg of platformPackages) {
    const suffix = pkg.replace(/^core-/, "").replace(/-x64$/, "-amd64");
    const srcBin = path.join(rootDir, "node_modules", "@ladybugdb", pkg, "lbugjs.node");
    const destBin = path.join(prebuiltDir, `lbugjs-${suffix}.node`);
    if (fs.existsSync(srcBin)) {
      if (fs.existsSync(destBin)) {
        fs.unlinkSync(destBin); // Remove existing file if it exists
      }
      fs.copyFileSync(srcBin, destBin);
      console.log(`Copied: ${srcBin} -> ${destBin}`);
    } else {
      console.warn(`Source binary not found: ${srcBin}`);
    }
  }
};

const asyncVersion = () => {
  // Copy version from node_modules/@ladybugdb/core/package.json to ./package.json
  const lbugPackageJsonPath = path.join(srcDir, "package.json");
  const projectPackageJsonPath = path.join(rootDir, "package.json");

  if (
    !fs.existsSync(lbugPackageJsonPath) ||
    !fs.existsSync(projectPackageJsonPath)
  ) {
    console.error("the package.json file not found");
  }

  let lbugPackageJson = {};
  let projectPackageJson = {};
  try {
    // Read both package.json files
    lbugPackageJson = JSON.parse(fs.readFileSync(lbugPackageJsonPath, "utf8"));
    projectPackageJson = JSON.parse(
      fs.readFileSync(projectPackageJsonPath, "utf8")
    );
  } catch (error) {
    console.error("Can not parse the package.json version:", error);
  }

  if (projectPackageJson.version != lbugPackageJson.version) {
    projectPackageJson.version = lbugPackageJson.version;
    projectPackageJson.devDependencies["@ladybugdb/core"] = lbugPackageJson.version;
    // Write the updated package.json back
    fs.writeFileSync(
      projectPackageJsonPath,
      JSON.stringify(projectPackageJson, null, 2)
    );
    console.log(`Updated package.json version to ${lbugPackageJson.version}`);
    npmPublish(projectPackageJson);
  } else {
    console.log(
      `Package.json version is already up to date: ${lbugPackageJson.version}`
    );
  }
};

const rootDir = path.join(__dirname, "..");

// already install @ladybugdb/core with docker or action
// installPackage("@ladybugdb/core");

// Delete files before copying new ones. lbug-src is the upstream clone
// fetched by util/cloneLbugSource.sh; on Linux CI it contains files created
// by root inside the Alpine build container and rmdir fails with EACCES, so
// leave it alone (and it's .gitignored anyway).
deleteFiles(rootDir, [
  "package.json",
  "util",
  "node_modules",
  "README.md",
  "test",
  ".git",
  ".vscode",
  ".gitignore",
  ".github",
  ".dockerignore",
  "Dockerfile",
  ".npmignore",
  "docs",
  "prebuilt",
  "lbug-src"
]);

const srcDir = path.join(rootDir, "node_modules", "@ladybugdb", "core");
const destDir = path.join(rootDir);

if (fs.existsSync(srcDir)) {
  copyDir(srcDir, destDir, [
    "lbug-source",
    "node_modules",
    "lbugjs.node",
    "package.json",
    "install.js",
    "README.md",
    "test",
    ".gitignore",
    ".github",
    ".dockerignore",
    ".npmignore",
    "Dockerfile",
    "prebuilt",
  ]);
  console.log("Copying completed!");
} else {
  console.error("Source directory not found:", srcDir);
}

// Promote any freshly-built .node files from
// node_modules/@ladybugdb/core/prebuilt/ into the repo's ./prebuilt/ dir so
// they get committed/published. Runs on every platform.
copyLocalPrebuiltBinaries();

// Fetch platform-specific prebuilt binaries only on linux-x64 so a single CI
// runner produces them (matches the former `if: matrix.arch == 'amd64'` gate).
if (process.platform === "win32" || (process.platform === "linux" && process.arch === "x64")) {
  copyPrebuiltBinaries();
} else {
  console.log(
    `Skipping platform-specific prebuilt fetch on ${process.platform}-${process.arch}`
  );
}

asyncVersion();
