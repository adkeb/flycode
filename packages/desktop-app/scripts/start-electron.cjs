#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');

const electronBinary = require('electron');
const appEntry = path.resolve(__dirname, '../src/main.cjs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [];
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  args.push('--no-sandbox');
}
args.push(appEntry);

const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (code === null) {
    process.stderr.write(`electron exited by signal ${signal || 'unknown'}\n`);
    process.exit(1);
  }
  process.exit(code);
});

child.on('error', (error) => {
  process.stderr.write(`failed to start electron: ${error.message}\n`);
  process.exit(1);
});
