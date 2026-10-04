'use strict';
// Daily run times as local HH:MM (the container's TZ).

function parseTimes(spec) {
  const times = String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
      if (!m) throw new Error(`SYNC_AT entry "${s}" is not HH:MM`);
      return { h: Number(m[1]), m: Number(m[2]) };
    });
  return times.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
}

function nextRun(times, now = new Date()) {
  if (!times.length) return null;
  for (let day = 0; day < 2; day++) {
    for (const t of times) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, t.h, t.m, 0, 0);
      if (at > now) return at;
    }
  }
  return null;
}

module.exports = { parseTimes, nextRun };
