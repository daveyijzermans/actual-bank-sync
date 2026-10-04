'use strict';

const { version } = require('../package.json');

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function topics(prefix) {
  return {
    availability: `${prefix}/availability`,
    state: `${prefix}/state`,
    syncNow: `${prefix}/sync_now/press`,
  };
}

const STATUSES = ['idle', 'running', 'success', 'partial', 'error'];

function deviceConfig({ name, prefix, serverURL }) {
  const slug = slugify(name);
  const uid = `actual_bank_sync_${slug}`;
  const t = topics(prefix);
  const comp = (platform, key, label, extra) => ({
    p: platform,
    name: label,
    unique_id: `${uid}_${key}`,
    default_entity_id: `${platform}.${slug}_${key}`,
    ...extra,
  });
  return {
    device: { identifiers: [uid], name, manufacturer: 'Actual Budget', model: 'Bank sync', configuration_url: serverURL },
    origin: { name: 'actual-bank-sync', sw_version: version },
    availability: [{ topic: t.availability }],
    components: {
      status: comp('sensor', 'status', 'Status', {
        state_topic: t.state,
        value_template: '{{ value_json.status }}',
        device_class: 'enum',
        options: STATUSES,
        json_attributes_topic: t.state,
        json_attributes_template: '{{ value_json.attrs | tojson }}',
        icon: 'mdi:bank-transfer',
      }),
      problem: comp('binary_sensor', 'problem', 'Problem', {
        state_topic: t.state,
        value_template: '{{ value_json.problem }}',
        device_class: 'problem',
      }),
      last_sync: comp('sensor', 'last_sync', 'Last sync', {
        state_topic: t.state,
        value_template: '{{ value_json.last_success }}',
        device_class: 'timestamp',
      }),
      next_sync: comp('sensor', 'next_sync', 'Next sync', {
        state_topic: t.state,
        value_template: '{{ value_json.next_run }}',
        device_class: 'timestamp',
      }),
      sync_now: comp('button', 'sync_now', 'Sync now', {
        command_topic: t.syncNow,
        payload_press: 'PRESS',
        icon: 'mdi:sync',
      }),
    },
  };
}

module.exports = { slugify, topics, deviceConfig, STATUSES };
