'use strict';

// THE MACHINE-DETECTION SURFACE, re-exported.

const envdetect = require('./envdetect');

module.exports = {
  osName: envdetect.osName,
  detectShell: envdetect.detectShell,
  detectPackageManager: envdetect.detectPackageManager,
  detectVenv: envdetect.detectVenv,
  detectTestRunner: envdetect.detectTestRunner,
  detectRuntimes: envdetect.detectRuntimes,
  detect: envdetect.detect,
  summary: envdetect.summary,
  reset: envdetect.reset,
};
