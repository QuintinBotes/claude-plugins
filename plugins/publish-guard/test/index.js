// Node 22's test runner takes files, not directories: given
// `node --test plugins/publish-guard/test/` it loads this directory's
// index.js. Importing every *.test.mjs here runs the whole suite that way
// too. `node --test plugins/publish-guard/test/*.test.mjs` does not load
// this file, so nothing runs twice.
'use strict';

const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

for (const file of readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, file)).href);
}
