'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTimes, nextRun } = require('../src/schedule');
const { deviceConfig } = require('../src/discovery');
const { Service, readConfig, runChild } = require('../src/main');

const ENV = {
  ACTUAL_SERVER_URL: 'https://budget.example.org',
  ACTUAL_PASSWORD: 'x',
  ACTUAL_BUDGET_ID: 'budget-sync-id',
  MQTT_URL: 'mqtt://broker',
};

test('schedule picks the next local time, rolling to tomorrow', () => {
  const times = parseTimes('18:30, 06:00');
  assert.deepStrictEqual(times, [{ h: 6, m: 0 }, { h: 18, m: 30 }]);
  const now = new Date(2026, 0, 10, 7, 0);
  assert.deepStrictEqual(nextRun(times, now), new Date(2026, 0, 10, 18, 30));
  assert.deepStrictEqual(nextRun(times, new Date(2026, 0, 10, 19, 0)), new Date(2026, 0, 11, 6, 0));
  assert.strictEqual(nextRun(parseTimes(''), now), null);
  assert.throws(() => parseTimes('6am'));
});

test('entity ids follow the device name', () => {
  const cfg = deviceConfig({ name: 'Actual Bank Sync', prefix: 'p', serverURL: ENV.ACTUAL_SERVER_URL });
  const ids = Object.values(cfg.components).map((c) => c.default_entity_id).sort();
  assert.deepStrictEqual(ids, [
    'binary_sensor.actual_bank_sync_problem',
    'button.actual_bank_sync_sync_now',
    'sensor.actual_bank_sync_last_sync',
    'sensor.actual_bank_sync_next_sync',
    'sensor.actual_bank_sync_status',
  ]);
});

test('config needs a server, credentials, budget and broker', () => {
  const cfg = readConfig(ENV);
  assert.strictEqual(cfg.prefix, 'actual-bank-sync/actual_bank_sync');
  assert.deepStrictEqual(cfg.syncAt, [{ h: 6, m: 0 }]);
  assert.throws(() => readConfig({ ...ENV, ACTUAL_PASSWORD: '' }));
  assert.throws(() => readConfig({ ...ENV, ACTUAL_BUDGET_ID: '' }));
});

function service(result) {
  const svc = new Service(readConfig(ENV), {
    runSync: async () => result,
    apiResolver: async () => ({ apiDir: null, apiVersion: '1.2.3', serverVersion: '1.2.3' }),
  });
  return svc;
}

test('a successful run clears the problem and stamps last sync', async () => {
  const svc = service({ status: 'success', accounts: [{ account: 'A', status: 'success', attempts: 1 }] });
  const st = await svc.sync('test');
  assert.strictEqual(st.status, 'success');
  assert.strictEqual(st.problem, 'OFF');
  assert.ok(st.last_success && st.last_success === st.last_run);
  assert.strictEqual(st.attrs.api_version, '1.2.3');
});

test('a partial run raises the problem and keeps the last success', async () => {
  const svc = service({ status: 'partial', accounts: [], error: '1 of 2 accounts failed' });
  svc.state.last_success = '2026-01-01T06:00:00.000Z';
  const st = await svc.sync('test');
  assert.strictEqual(st.problem, 'ON');
  assert.strictEqual(st.last_success, '2026-01-01T06:00:00.000Z');
  assert.strictEqual(st.attrs.error, '1 of 2 accounts failed');
});

test('retained state restores once', () => {
  const svc = service({ status: 'success' });
  svc.restore(JSON.stringify({ status: 'error', problem: 'ON', last_run: 'a', last_success: 'b', attrs: { error: 'e' } }));
  svc.restore(JSON.stringify({ status: 'success', problem: 'OFF' }));
  assert.strictEqual(svc.state.status, 'error');
  assert.strictEqual(svc.state.problem, 'ON');
  assert.strictEqual(svc.state.last_success, 'b');
});

function stubApi(behaviour) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-api-'));
  const mod = path.join(dir, 'node_modules', '@actual-app', 'api');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: '@actual-app/api', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(mod, 'index.js'), `
    const behaviour = ${JSON.stringify(behaviour)};
    module.exports = {
      init: async () => {}, downloadBudget: async () => {}, shutdown: async () => {},
      getAccounts: async () => [{ id: '1', name: 'Checking' }, { id: '2', name: 'Savings' }, { id: '3', name: 'Old', closed: true }],
      runBankSync: async ({ accountId }) => { if (behaviour[accountId] === 'fail') throw new Error('bank said no'); },
    };`);
  return dir;
}

const childInput = (apiDir) => ({
  serverURL: ENV.ACTUAL_SERVER_URL, password: 'x', budgetId: 'b', retries: 1,
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'abs-data-')), apiDir,
});

test('the child syncs every open account', async () => {
  const result = await runChild(childInput(stubApi({})), 30000);
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.accounts.map((a) => a.account), ['Checking', 'Savings']);
});

test('the child reports a failing account as partial', async () => {
  const result = await runChild(childInput(stubApi({ 2: 'fail' })), 30000);
  assert.strictEqual(result.status, 'partial');
  assert.deepStrictEqual(result.accounts.find((a) => a.account === 'Savings'), {
    account: 'Savings', status: 'error', attempts: 1, error: 'bank said no',
  });
});

test('a hung child is killed at the timeout', async () => {
  const dir = stubApi({});
  fs.writeFileSync(path.join(dir, 'node_modules', '@actual-app', 'api', 'index.js'),
    'module.exports = { init: () => new Promise(() => setInterval(() => {}, 1000)), shutdown: async () => {} };');
  const result = await runChild(childInput(dir), 1500);
  assert.strictEqual(result.status, 'error');
  assert.match(result.error, /timed out/);
});
