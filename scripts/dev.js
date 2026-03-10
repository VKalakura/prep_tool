#!/usr/bin/env node
const { execSync, spawn } = require('child_process');
const http = require('http');

// ── 1. Node version check ─────────────────────────────────────────────────────
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  console.error(`\n  [dev] ERROR: Node.js ${process.versions.node} detected. Node 20+ is required.`);
  console.error('  [dev] Run:  nvm use 20\n');
  process.exit(1);
}

// ── 2. Kill existing processes on required ports ──────────────────────────────
const PORTS = [3001, 5173];
for (const port of PORTS) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    if (pids.length) {
      execSync(`kill -9 ${pids.join(' ')} 2>/dev/null`, { stdio: 'ignore' });
      console.log(`[dev] Port ${port} was in use — killed PID(s) ${pids.join(', ')}`);
    } else {
      console.log(`[dev] Port ${port} is free`);
    }
  } catch {
    console.log(`[dev] Port ${port} is free`);
  }
}

// ── 3. Start API server ───────────────────────────────────────────────────────
console.log('[dev] Starting API server...');
const server = spawn('npm', ['--prefix', 'server', 'run', 'dev'], {
  stdio: 'inherit',
  shell: true,
  cwd: __dirname + '/..',
});

server.on('error', (err) => {
  console.error('[dev] Failed to start server:', err.message);
  process.exit(1);
});

// ── 4. Wait for server to be ready ────────────────────────────────────────────
function waitForServer(url, retries = 30, interval = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      }).on('error', retry);
    };
    const retry = () => {
      if (++attempts >= retries) {
        reject(new Error(`Server did not respond after ${retries} attempts`));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

waitForServer('http://localhost:3001/api/health')
  .then(() => {
    console.log('[dev] API server is ready. Starting UI...\n');

    // ── 5. Start client ─────────────────────────────────────────────────────
    const client = spawn('npm', ['--prefix', 'client', 'run', 'dev'], {
      stdio: 'inherit',
      shell: true,
      cwd: __dirname + '/..',
    });

    client.on('error', (err) => {
      console.error('[dev] Failed to start client:', err.message);
    });

    // Clean up both on exit
    const cleanup = () => { server.kill(); client.kill(); };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  })
  .catch((err) => {
    console.error('[dev] Server failed to start:', err.message);
    server.kill();
    process.exit(1);
  });
