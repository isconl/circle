'use strict';
/**
 * Thin local TSV store for pulse -- read/append/rewrite bound to a memory
 * directory, matching the flat, colocated-filesystem model every lib/
 * module here was already written against (finance.js et al assume
 * SYNCHRONOUS readTSV/appendTSV/rewriteTSV, since they were ported straight
 * from a single-process monolith doing plain fs calls).
 *
 * Deliberately NOT vault's full lib/store.js: this skips bootRepair/
 * snapshot/schema-migration -- vault owns that (it's the process
 * responsible for creating and repairing the vault on boot). This is just
 * enough for pulse to read/write files vault has already bootstrapped,
 * plus create one from `defaultSchema` if it's missing.
 *
 * KNOWN GAP, noted rather than hidden: this assumes pulse and vault share
 * the same on-disk `memory/` directory (true today -- everything runs on
 * one host). If pulse and vault are ever deployed to genuinely separate
 * hosts, this needs to become a real HTTP client against vault's
 * /vault/:collection routes instead, which are async by nature -- that
 * would cascade into making every lib/ module's I/O async too. Flagged in
 * the refactor canvas's Deployment Architecture section as undecided; not
 * solved here.
 */

const fs = require('fs');
const path = require('path');
const { readTSV: rawRead, appendTSV: rawAppend, rewriteTSV: rawRewrite } = require('./tsv');
const defaultSchema = require('./default-schema');

function createStore({ memoryDir, schema = defaultSchema, auditLog = { log: () => {} } }) {
  if (!memoryDir) throw new Error('createStore requires memoryDir');

  function keepPreviousVersion(relPath, contents, why) {
    try {
      const trashDir = path.join(memoryDir, '.trash');
      fs.mkdirSync(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = relPath.replace(/\//g, '__');
      fs.writeFileSync(path.join(trashDir, `${stamp}__${why || 'rewrite'}__${safeName}`), contents);
      auditLog.log('pulse_previous_version_kept', { file: relPath, why: why || 'rewrite' });
    } catch (e) {
      auditLog.log('pulse_keep_previous_version_failed', { file: relPath, error: String(e.message || e).slice(0, 120) });
    }
  }

  function read(relPath) {
    return rawRead(memoryDir, relPath);
  }

  function append(relPath, row) {
    return rawAppend(memoryDir, relPath, row, { headerIfMissing: schema[relPath], auditLog });
  }

  function rewrite(relPath, fn, opts = {}) {
    return rawRewrite(memoryDir, relPath, fn, { ...opts, auditLog, keepPreviousVersion });
  }

  return { read, append, rewrite, schema, memoryDir };
}

module.exports = { createStore, defaultSchema };
