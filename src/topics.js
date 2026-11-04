'use strict';

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// The service's own topics under its prefix: the last will, the retained state and the sync-now command.
function topics(prefix) {
  return {
    availability: `${prefix}/availability`,
    state: `${prefix}/state`,
    syncNow: `${prefix}/sync_now/press`,
  };
}

module.exports = { slugify, topics };
