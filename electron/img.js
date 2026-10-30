'use strict';
// sharp (libvips) with memory-friendly settings for a long-running tray app:
//  - no operation cache (libvips keeps up to ~50 MB of decoded results by default),
//  - a small worker pool (each libvips thread keeps its own buffers).
// Loaded lazily: nothing is paid until an image operation actually runs.
let sharp = null;
module.exports = new Proxy(function () {}, {
  apply(_t, _this, args) { return get()(...args); },
  get(_t, prop) { return get()[prop]; },
});
function get() {
  if (!sharp) {
    sharp = require('sharp');
    try {
      sharp.cache(false);
      const cores = require('os').cpus().length || 4;
      sharp.concurrency(Math.max(2, Math.min(4, Math.floor(cores / 2))));
    } catch (_) { /* older sharp */ }
  }
  return sharp;
}
