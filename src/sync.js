'use strict';
// One bank-sync run in its own process. loot-core keeps a few hundred MB of
// budget in memory and can leave floating promise rejections behind; both die
// with this process instead of the long-running service.
//
// stdin:  {"serverURL", "password" | "sessionToken", "budgetId", "budgetPassword"?,
//          "dataDir", "apiDir"?, "retries"}
// stdout: one JSON line, {"status": "success" | "partial" | "error", "accounts": [...], "error"?}
const fs = require('node:fs');
const path = require('node:path');

function loadApi(apiDir) {
  return apiDir ? require(path.join(apiDir, 'node_modules', '@actual-app', 'api')) : require('@actual-app/api');
}

async function syncAccount(api, account, retries) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await api.runBankSync({ accountId: account.id });
      return { account: account.name, status: 'success', attempts: attempt };
    } catch (err) {
      lastError = err;
      console.error(`${account.name}: attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  return { account: account.name, status: 'error', attempts: retries, error: lastError.message };
}

async function run(cfg) {
  const api = loadApi(cfg.apiDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const auth = cfg.sessionToken ? { sessionToken: cfg.sessionToken } : { password: cfg.password };
  try {
    await api.init({ dataDir: cfg.dataDir, serverURL: cfg.serverURL, ...auth });
    await api.downloadBudget(cfg.budgetId, cfg.budgetPassword ? { password: cfg.budgetPassword } : undefined);
    // The API skips accounts without a bank link, so every open account is tried.
    const accounts = (await api.getAccounts()).filter((a) => !a.closed);
    console.error(`${accounts.length} open accounts`);
    const results = [];
    for (const account of accounts) results.push(await syncAccount(api, account, cfg.retries));
    const failed = results.filter((r) => r.status !== 'success').length;
    const status = failed === 0 ? 'success' : failed === results.length ? 'error' : 'partial';
    return { status, accounts: results, error: failed ? `${failed} of ${results.length} accounts failed` : null };
  } catch (err) {
    return { status: 'error', accounts: [], error: err.message };
  } finally {
    try {
      await api.shutdown();
    } catch {
      // A failed shutdown must not mask the result.
    }
  }
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let result;
  try {
    result = await run(JSON.parse(input));
  } catch (err) {
    result = { status: 'error', accounts: [], error: err.message };
  }
  // Exit explicitly once stdout is flushed: loot-core can leave timers behind.
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(result.status === 'error' ? 1 : 0));
});
