'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mqtt = require('mqtt');

const { ensureApi } = require('./api-version');
const { parseTimes, nextRun } = require('./schedule');
const { slugify, topics, deviceConfig } = require('./discovery');

const log = (...args) => console.log(new Date().toISOString(), ...args);

// Touched on every schedule tick while MQTT is up; the healthcheck reads its age.
const HEALTH_FILE = '/tmp/actual-bank-sync.alive';

function readConfig(env = process.env) {
  const need = (key) => {
    if (!env[key]) throw new Error(`${key} is required`);
    return env[key];
  };
  if (!env.ACTUAL_PASSWORD && !env.ACTUAL_SESSION_TOKEN) throw new Error('ACTUAL_PASSWORD or ACTUAL_SESSION_TOKEN is required');
  const name = env.DEVICE_NAME || 'Actual Bank Sync';
  return {
    serverURL: need('ACTUAL_SERVER_URL'),
    password: env.ACTUAL_PASSWORD || null,
    sessionToken: env.ACTUAL_SESSION_TOKEN || null,
    budgetId: need('ACTUAL_BUDGET_ID'),
    budgetPassword: env.ACTUAL_BUDGET_PASSWORD || null,
    apiVersion: env.ACTUAL_API_VERSION || null,
    dataDir: env.DATA_DIR || '/data',
    syncAt: parseTimes(env.SYNC_AT ?? '06:00'),
    retries: Number(env.SYNC_RETRIES || 3),
    timeoutMs: Number(env.SYNC_TIMEOUT_MIN || 15) * 60 * 1000,
    mqttURL: need('MQTT_URL'),
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    name,
    prefix: env.MQTT_PREFIX || `actual-bank-sync/${slugify(name)}`,
    discoveryPrefix: env.DISCOVERY_PREFIX || 'homeassistant',
  };
}

// Runs src/sync.js in a child process; resolves with its result, never rejects.
function runChild(input, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    let err = '';
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve(result);
    };
    const child = spawn(process.execPath, [path.join(__dirname, 'sync.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 'error', accounts: [], error: `timed out after ${timeoutMs / 60000} min` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      err = (err + d).slice(-2000);
    });
    child.on('error', (e) => finish({ status: 'error', accounts: [], error: `spawn: ${e.message}` }));
    child.on('close', (code) => {
      try {
        finish(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        finish({ status: 'error', accounts: [], error: `sync process exited ${code}: ${err.trim().split('\n').pop() || 'no output'}` });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

class Service {
  constructor(cfg, { runSync = runChild, apiResolver = ensureApi } = {}) {
    this.cfg = cfg;
    this.t = topics(cfg.prefix);
    this.runSync = runSync;
    this.apiResolver = apiResolver;
    this.client = null;
    this.running = false;
    this.state = {
      status: 'idle',
      problem: 'OFF',
      last_run: null,
      last_success: null,
      next_run: null,
      attrs: { accounts: [], error: null, api_version: null, server_version: null, duration_s: null },
    };
    this.restored = false;
  }

  publishState() {
    this.state.next_run = nextRun(this.cfg.syncAt)?.toISOString() ?? null;
    if (this.client?.connected) this.client.publish(this.t.state, JSON.stringify(this.state), { qos: 1, retain: true });
  }

  publishDiscovery() {
    const cfg = deviceConfig({ name: this.cfg.name, prefix: this.cfg.prefix, serverURL: this.cfg.serverURL });
    const topic = `${this.cfg.discoveryPrefix}/device/actual_bank_sync_${slugify(this.cfg.name)}/config`;
    this.client.publish(topic, JSON.stringify(cfg), { qos: 1, retain: true });
  }

  // Keep the last run's outcome across restarts from the retained state.
  restore(payload) {
    if (this.restored) return;
    this.restored = true;
    try {
      const prev = JSON.parse(payload);
      for (const key of ['last_run', 'last_success', 'problem', 'attrs']) if (prev[key] !== undefined) this.state[key] = prev[key];
      if (['success', 'partial', 'error'].includes(prev.status)) this.state.status = prev.status;
    } catch {
      // Unreadable retained state: start fresh.
    }
  }

  async sync(reason) {
    if (this.running) {
      log(`sync requested (${reason}) while one runs; ignored`);
      return this.state;
    }
    this.running = true;
    const started = Date.now();
    log(`sync started (${reason})`);
    this.state.status = 'running';
    this.publishState();
    try {
      const api = await this.apiResolver({ serverURL: this.cfg.serverURL, dataDir: this.cfg.dataDir, pinned: this.cfg.apiVersion, log });
      const result = await this.runSync(
        {
          serverURL: this.cfg.serverURL,
          password: this.cfg.password,
          sessionToken: this.cfg.sessionToken,
          budgetId: this.cfg.budgetId,
          budgetPassword: this.cfg.budgetPassword,
          dataDir: path.join(this.cfg.dataDir, 'budgets'),
          apiDir: api.apiDir,
          retries: this.cfg.retries,
        },
        this.cfg.timeoutMs,
      );
      const now = new Date().toISOString();
      this.state.status = result.status;
      this.state.problem = result.status === 'success' ? 'OFF' : 'ON';
      this.state.last_run = now;
      if (result.status === 'success') this.state.last_success = now;
      this.state.attrs = {
        accounts: result.accounts || [],
        error: result.error || null,
        api_version: api.apiVersion,
        server_version: api.serverVersion,
        duration_s: Math.round((Date.now() - started) / 1000),
      };
      log(`sync ${result.status}${result.error ? `: ${result.error}` : ''}`);
    } finally {
      this.running = false;
      this.publishState();
    }
    return this.state;
  }

  start() {
    const { cfg, t } = this;
    this.client = mqtt.connect(cfg.mqttURL, {
      clientId: `actual-bank-sync-${slugify(cfg.name)}`,
      username: cfg.mqttUsername,
      password: cfg.mqttPassword,
      will: { topic: t.availability, payload: 'offline', qos: 1, retain: true },
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      log(`connected to ${cfg.mqttURL}`);
      this.client.subscribe([`${cfg.discoveryPrefix}/status`, t.syncNow, t.state]);
      this.publishDiscovery();
      this.client.publish(t.availability, 'online', { qos: 1, retain: true });
      // Give the retained state a moment to arrive before publishing over it.
      setTimeout(() => {
        this.restored = true;
        this.publishState();
      }, 3000);
    });
    this.client.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic === t.state) this.restore(text);
      else if (topic === t.syncNow) this.sync('button');
      else if (topic === `${cfg.discoveryPrefix}/status` && text === 'online') {
        this.publishDiscovery();
        this.publishState();
      }
    });
    this.client.on('error', (err) => log(`MQTT: ${err.message}`));

    // Check the schedule every 30 s rather than one long timer, so clock and
    // DST changes cannot skip a run.
    let due = nextRun(cfg.syncAt);
    this.timer = setInterval(() => {
      if (this.client.connected) fs.writeFile(HEALTH_FILE, '', () => {});
      if (due && new Date() >= due) {
        due = nextRun(cfg.syncAt);
        this.sync('schedule');
      }
    }, 30000);
  }

  async stop() {
    clearInterval(this.timer);
    if (this.client?.connected) {
      // A clean disconnect suppresses the last will: say offline first.
      await this.client.publishAsync(this.t.availability, 'offline', { qos: 1, retain: true }).catch(() => {});
    }
    await this.client?.endAsync().catch(() => {});
  }
}

if (require.main === module) {
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const service = new Service(cfg);
  service.start();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      await service.stop();
      process.exit(0);
    });
  }
}

module.exports = { Service, readConfig, runChild };
