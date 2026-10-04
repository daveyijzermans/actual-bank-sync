'use strict';
// The API package must match the server's version: a mismatched client fails
// right after login. Before each run the service asks the server for its
// version and installs that API release into the data dir once.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

async function serverVersion(serverURL) {
  const res = await fetch(new URL('info', serverURL.endsWith('/') ? serverURL : serverURL + '/'), {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`server info: HTTP ${res.status}`);
  const info = await res.json();
  const version = info?.build?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error(`server info: no version in ${JSON.stringify(info)}`);
  return version;
}

function installedVersion(dir) {
  try {
    const pkg = path.join(dir, 'node_modules', '@actual-app', 'api', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  } catch {
    return null;
  }
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5 * 60 * 1000 }, (err, _stdout, stderr) =>
      err ? reject(new Error(`${label}: ${stderr.trim().split('\n').pop() || err.message}`)) : resolve());
  });
}

// Opens an in-memory database with the installed native module.
function sqliteWorks(dir) {
  const mod = path.join(dir, 'node_modules', 'better-sqlite3');
  return run(process.execPath, ['-e', `new (require(${JSON.stringify(mod)}))(':memory:').close()`], 'better-sqlite3')
    .then(() => true, () => false);
}

// Newer better-sqlite3 releases ship prebuilt binaries and need no install
// script; older ones fetch theirs in one. Install without scripts, and run
// the module's own install only when it does not load.
async function npmInstall(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  // npm 11+ runs only allowed install scripts.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, allowScripts: { 'better-sqlite3': true } }, null, 2),
  );
  const label = `npm install @actual-app/api@${version}`;
  await run('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', `@actual-app/api@${version}`], label);
  if (!(await sqliteWorks(dir))) {
    await run('npm', ['rebuild', '--prefix', dir, 'better-sqlite3'], `${label} (better-sqlite3)`);
    if (!(await sqliteWorks(dir))) throw new Error(`${label}: better-sqlite3 does not load`);
  }
}

// The package's exports hide its package.json; walk up from its entry point.
function bundledVersion() {
  let dir = path.dirname(require.resolve('@actual-app/api'));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name === '@actual-app/api') return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('bundled @actual-app/api not found');
    dir = parent;
  }
}

// Returns {apiDir, apiVersion, serverVersion}; apiDir null means the bundled API.
async function ensureApi({ serverURL, dataDir, pinned, log }) {
  const bundled = bundledVersion();
  let server = null;
  try {
    server = await serverVersion(serverURL);
  } catch (err) {
    log(`cannot read the server version (${err.message}); using API ${pinned || bundled}`);
  }
  const wanted = pinned || server || bundled;
  if (wanted === bundled) return { apiDir: null, apiVersion: bundled, serverVersion: server };
  const dir = path.join(dataDir, 'api', wanted);
  if (installedVersion(dir) !== wanted) {
    log(`installing @actual-app/api ${wanted}`);
    try {
      await npmInstall(dir, wanted);
    } catch (err) {
      log(`${err.message}; using bundled API ${bundled}`);
      return { apiDir: null, apiVersion: bundled, serverVersion: server };
    }
  }
  return { apiDir: dir, apiVersion: wanted, serverVersion: server };
}

module.exports = { ensureApi, serverVersion, installedVersion };
