const path = require("path");
const process = require("process");
const fs = require("fs");
const https = require("https");
const { HttpsProxyAgent } = require('https-proxy-agent');
const packageJson = require("./../package.json");

const rootDir = path.join(__dirname, "..");

let arch = process.arch;
let platform = process.platform;
const isAlpine = platform == "linux" && fs.readFileSync('/etc/os-release', 'utf8').includes('Alpine Linux');
if (isAlpine) {
  platform = "alpine";
}

if(arch == "x64"){
  arch="amd64"
}

const prebuiltURL = `prebuilt/lbugjs-${platform}-${arch}.node`;

// force copy prebuilt file to  ./lbugjs.node
fs.copyFileSync(path.join(rootDir, prebuiltURL), path.join(rootDir, "lbugjs.node"));
