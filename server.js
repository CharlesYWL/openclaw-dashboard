const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3456;
const AUTH_FILE = path.join(__dirname, 'auth.json');
const AGENTS_FILE = path.join(__dirname, 'agents.json');
const OPENCLAW_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Initialize or load authentication
let authConfig = null;
function initAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    try {
      authConfig = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    } catch (err) {
      console.error('[AUTH] Error reading auth.json:', err.message);
    }
  }
  
  if (!authConfig || !authConfig.password) {
    // Generate random password
    const password = crypto.randomBytes(16).toString('hex');
    authConfig = { password, createdAt: new Date().toISOString() };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authConfig, null, 2));
    console.log('\n' + '='.repeat(60));
    console.log('🔐 DASHBOARD PASSWORD GENERATED');
    console.log('='.repeat(60));
    console.log(`Password: ${password}`);
    console.log('='.repeat(60) + '\n');
  }
}
initAuth();

// ===== Agent Fleet Management =====
let agentsConfig = { agents: [], pollIntervalMs: 15000 };
const agentStatus = new Map(); // id -> { status, lastCheck, lastActivity, sessions, error }

function loadAgentsConfig() {
  // First, load agents.json if exists
  if (fs.existsSync(AGENTS_FILE)) {
    try {
      agentsConfig = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    } catch (err) {
      console.error('[AGENTS] Error reading agents.json:', err.message);
    }
  }

  // Auto-discover from ~/.openclaw/openclaw.json
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    try {
      const openclawConfig = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
      const gateway = openclawConfig.gateway || {};
      const token = gateway.auth?.token || null;
      const port = gateway.port || 18789;
      const host = gateway.bind === 'loopback' ? '127.0.0.1' : (gateway.bind || '127.0.0.1');

      // Check if main agent already exists
      const mainIdx = agentsConfig.agents.findIndex(a => a.id === 'main');
      const mainAgent = {
        id: 'main',
        name: 'Main Agent',
        emoji: '🤖',
        host,
        port,
        token,
        workspace: path.join(os.homedir(), '.openclaw', 'agents', 'main'),
        autoDiscovered: true
      };

      if (mainIdx >= 0) {
        // Update existing with discovered values if token was null
        if (!agentsConfig.agents[mainIdx].token) {
          agentsConfig.agents[mainIdx].token = token;
        }
        agentsConfig.agents[mainIdx].port = port;
        agentsConfig.agents[mainIdx].host = host;
      } else {
        agentsConfig.agents.unshift(mainAgent);
      }

      // Save updated config
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(agentsConfig, null, 2));
      console.log('[AGENTS] Auto-discovered main agent from openclaw.json');
    } catch (err) {
      console.error('[AGENTS] Error reading openclaw.json:', err.message);
    }
  }

  // Initialize status for all agents
  for (const agent of agentsConfig.agents) {
    if (!agentStatus.has(agent.id)) {
      agentStatus.set(agent.id, {
        status: 'unknown',
        lastCheck: null,
        lastActivity: null,
        sessions: [],
        error: null
      });
    }
  }

  console.log(`[AGENTS] Loaded ${agentsConfig.agents.length} agent(s)`);
}
loadAgentsConfig();

// Fetch agent status using openclaw CLI
async function fetchAgentStatus(agent) {
  try {
    // Use openclaw status --json to get real status
    const result = execSync('openclaw status --json 2>/dev/null', { 
      timeout: 10000,
      encoding: 'utf-8'
    });
    const data = JSON.parse(result);
    
    // Find sessions for this agent
    const sessions = data.sessions?.recent?.filter(s => s.agentId === agent.id) || [];
    
    // Calculate last activity from most recent session
    let lastActivity = null;
    if (sessions.length > 0) {
      const mostRecent = sessions.reduce((a, b) => 
        (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a
      );
      if (mostRecent.updatedAt) {
        lastActivity = new Date(mostRecent.updatedAt).toISOString();
      }
    }
    
    return { 
      online: true, 
      data: {
        agentId: agent.id,
        sessions: sessions,
        sessionCount: sessions.length,
        lastActivity: lastActivity,
        channels: data.channelSummary || [],
        heartbeat: data.heartbeat
      }, 
      error: null 
    };
  } catch (err) {
    return { online: false, data: null, error: err.message };
  }
}

// Fetch agent sessions from gateway API
async function fetchAgentSessions(agent) {
  const url = `http://${agent.host}:${agent.port}/sessions`;
  const headers = {};
  if (agent.token) {
    headers['Authorization'] = `Bearer ${agent.token}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return { success: true, sessions: data.sessions || data || [], error: null };
  } catch (err) {
    return { success: false, sessions: [], error: err.message };
  }
}

// Poll all agents
async function pollAllAgents() {
  const updates = [];

  for (const agent of agentsConfig.agents) {
    const statusResult = await fetchAgentStatus(agent);
    const currentStatus = agentStatus.get(agent.id) || {};
    
    const newStatus = {
      status: statusResult.online ? 'online' : 'offline',
      lastCheck: new Date().toISOString(),
      lastActivity: statusResult.data?.lastActivity || currentStatus.lastActivity,
      sessions: statusResult.data?.sessions || [],
      sessionCount: statusResult.data?.sessionCount || 0,
      gatewayData: statusResult.data,
      error: statusResult.error
    };

    // Check if status changed
    const changed = currentStatus.status !== newStatus.status;
    agentStatus.set(agent.id, newStatus);

    if (changed) {
      updates.push({ agentId: agent.id, ...newStatus });
    }
  }

  // Broadcast status changes via WebSocket
  if (updates.length > 0) {
    broadcastAgentUpdates(updates);
  }
}

// Broadcast agent updates to all connected WebSocket clients
function broadcastAgentUpdates(updates) {
  const message = JSON.stringify({ type: 'agent-status', updates });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Start polling
let pollInterval = null;
function startAgentPolling() {
  // Initial poll
  pollAllAgents();

  // Set up interval
  pollInterval = setInterval(pollAllAgents, agentsConfig.pollIntervalMs || 15000);
  console.log(`[AGENTS] Polling every ${agentsConfig.pollIntervalMs || 15000}ms`);
}
startAgentPolling();

// Simple session storage (in-memory)
const sessions = new Map();
const LOGS_DIRS = [
  '/tmp/openclaw',  // Main gateway logs
  path.join(os.homedir(), '.openclaw', 'logs')  // Command logs
];
const SESSIONS_DIR = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');

// Limits
const DEFAULT_LIMIT = 200;
const INITIAL_LIMIT = 500;
const MAX_LIMIT = 1000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

// Authentication middleware
function requireAuth(req, res, next) {
  const sessionId = req.cookies.session;
  if (sessionId && sessions.has(sessionId)) {
    next();
  } else {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
    } else {
      res.redirect('/login');
    }
  }
}

// Login page
app.get('/login', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - OpenClaw Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      background: #1a1a1a;
      padding: 40px;
      border-radius: 16px;
      border: 1px solid #333;
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 32px; font-size: 14px; }
    .form-group { margin-bottom: 20px; text-align: left; }
    label { display: block; margin-bottom: 8px; font-size: 14px; color: #888; }
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #333;
      border-radius: 8px;
      background: #0f0f0f;
      color: #e0e0e0;
      font-size: 16px;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: #60a5fa;
    }
    button {
      width: 100%;
      padding: 14px;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #1d4ed8; }
    .error {
      background: #451a1a;
      border: 1px solid #6a2d2d;
      color: #f87171;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">🦞</div>
    <h1>OpenClaw Dashboard</h1>
    <p class="subtitle">Enter your password to continue</p>
    <div id="error" class="error"></div>
    <form id="login-form">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus>
      </div>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const error = document.getElementById('error');
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = '/';
        } else {
          error.textContent = data.message || 'Invalid password';
          error.classList.add('show');
        }
      } catch (err) {
        error.textContent = 'Connection error';
        error.classList.add('show');
      }
    });
  </script>
</body>
</html>
  `);
});

// Login API
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === authConfig.password) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, { createdAt: Date.now() });
    res.cookie('session', sessionId, { 
      httpOnly: true, 
      maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
      sameSite: 'strict'
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// Logout API
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// Protected routes - all below this point require auth
app.use((req, res, next) => {
  // Allow login page and auth endpoints
  if (req.path === '/login' || req.path.startsWith('/api/auth/')) {
    return next();
  }
  requireAuth(req, res, next);
});

// System metrics API
app.get('/api/metrics', (req, res) => {
  try {
    // CPU usage (average of all cores)
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const cpuPercent = Math.round((1 - totalIdle / totalTick) * 100);
    
    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    
    // Disk usage (using df command)
    let disk = { used: 0, total: 0, percent: 0 };
    try {
      const dfOutput = execSync('df -k / | tail -1', { encoding: 'utf-8' });
      const parts = dfOutput.trim().split(/\s+/);
      if (parts.length >= 5) {
        disk.total = parseInt(parts[1]) * 1024;
        disk.used = parseInt(parts[2]) * 1024;
        disk.percent = parseInt(parts[4].replace('%', '')) || Math.round((disk.used / disk.total) * 100);
      }
    } catch (err) {
      console.error('[METRICS] Disk error:', err.message);
    }
    
    res.json({
      cpu: cpuPercent,
      memory: {
        used: usedMem,
        total: totalMem,
        percent: memPercent
      },
      disk: {
        used: disk.used,
        total: disk.total,
        percent: disk.percent
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all log files from all directories
function getAllLogFiles() {
  const files = [];
  for (const dir of LOGS_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const dirFiles = fs.readdirSync(dir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({
          name: f,
          dir: dir,
          path: path.join(dir, f),
          mtime: fs.statSync(path.join(dir, f)).mtime
        }));
      files.push(...dirFiles);
    } catch (err) {
      console.error(`Error reading ${dir}:`, err.message);
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

// Get all session files
function getAllSessionFiles() {
  const files = [];
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return files;
    const dirFiles = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.endsWith('.lock'))
      .map(f => {
        const fullPath = path.join(SESSIONS_DIR, f);
        const stat = fs.statSync(fullPath);
        const sessionId = f.replace('.jsonl', '');
        return {
          name: f,
          sessionId: sessionId,
          path: fullPath,
          mtime: stat.mtime,
          size: stat.size
        };
      });
    files.push(...dirFiles);
  } catch (err) {
    console.error(`Error reading sessions dir:`, err.message);
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

// Get the latest log file
function getLatestLogFile() {
  const files = getAllLogFiles();
  return files.length > 0 ? files[0].path : null;
}

// Execute gateway command
function executeGatewayCommand(action) {
  return new Promise((resolve, reject) => {
    const validActions = ['start', 'stop', 'restart', 'status'];
    if (!validActions.includes(action)) {
      reject(new Error('Invalid action'));
      return;
    }

    exec(`openclaw gateway ${action}`, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout || stderr || `Gateway ${action} command executed`);
    });
  });
}

// Parse search query - extract field:value filters and plain keywords
function parseSearchQuery(query) {
  const fieldFilters = [];
  let keywords = [];

  if (!query || !query.trim()) {
    return { fieldFilters, keywords };
  }

  // Match field:value patterns (with optional quotes)
  const fieldRegex = /(\w+):(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let match;
  let processedQuery = query;

  while ((match = fieldRegex.exec(query)) !== null) {
    const field = match[1].toLowerCase();
    const value = (match[2] || match[3] || match[4]).toLowerCase();
    fieldFilters.push({ field, value });
    processedQuery = processedQuery.replace(match[0], '');
  }

  // Remaining text becomes keywords
  keywords = processedQuery.trim().toLowerCase().split(/\s+/).filter(k => k);

  return { fieldFilters, keywords };
}

// Check if an object matches field:value filters
function matchesFieldFilters(obj, fieldFilters) {
  for (const { field, value } of fieldFilters) {
    if (!matchesFieldFilter(obj, field, value)) {
      return false;
    }
  }
  return true;
}

function matchesFieldFilter(obj, field, value) {
  if (!obj || typeof obj !== 'object') return false;

  // Direct field check
  if (obj.hasOwnProperty(field)) {
    const fieldValue = String(obj[field]).toLowerCase();
    if (fieldValue.includes(value)) return true;
  }

  // Nested object check
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (matchesFieldFilter(obj[key], field, value)) return true;
    }
  }

  return false;
}

// Check if line/object matches all keywords
function matchesKeywords(line, keywords) {
  const lowerLine = line.toLowerCase();
  return keywords.every(kw => lowerLine.includes(kw));
}

// ===== SEARCH API ENDPOINTS =====

// Search log files using grep (fast for plain text search)
app.get('/api/logs/search', async (req, res) => {
  const { q, file, dir, limit = DEFAULT_LIMIT } = req.query;
  const limitNum = Math.min(parseInt(limit) || DEFAULT_LIMIT, MAX_LIMIT);

  let targetFile;
  if (file && dir) {
    targetFile = path.join(dir, file);
  } else {
    targetFile = getLatestLogFile();
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    return res.json({ success: false, results: [], message: 'Log file not found' });
  }

  try {
    const { fieldFilters, keywords } = parseSearchQuery(q);

    // If no query, return last N lines
    if (!q || !q.trim()) {
      const results = await getLastLines(targetFile, limitNum);
      return res.json({
        success: true,
        results,
        total: results.length,
        truncated: results.length >= limitNum
      });
    }

    // Use grep for plain keyword search (fast!)
    if (keywords.length > 0 && fieldFilters.length === 0) {
      const results = await grepSearch(targetFile, keywords, limitNum);
      return res.json({
        success: true,
        results,
        total: results.length,
        truncated: results.length >= limitNum
      });
    }

    // For field:value queries, we need to parse JSON
    const results = await jsonSearch(targetFile, fieldFilters, keywords, limitNum);
    return res.json({
      success: true,
      results,
      total: results.length,
      truncated: results.length >= limitNum
    });
  } catch (err) {
    console.error('Search error:', err);
    return res.json({ success: false, results: [], message: err.message });
  }
});

// Session log endpoints - MUST be before :sessionId route!
app.get('/api/sessions/files', (req, res) => {
  try {
    const files = getAllSessionFiles();
    res.json({ 
      success: true, 
      files: files.map(f => ({ 
        name: f.name, 
        sessionId: f.sessionId,
        displayName: f.sessionId,
        mtime: f.mtime,
        size: f.size
      }))
    });
  } catch (err) {
    res.json({ success: false, files: [], message: err.message });
  }
});

// Search session JSONL files
app.get('/api/sessions/search', async (req, res) => {
  const { q, id, limit = DEFAULT_LIMIT } = req.query;
  const limitNum = Math.min(parseInt(limit) || DEFAULT_LIMIT, MAX_LIMIT);

  if (!id) {
    return res.json({ success: false, results: [], message: 'Session ID required' });
  }

  const sessionFile = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!fs.existsSync(sessionFile)) {
    return res.json({ success: false, results: [], message: 'Session not found' });
  }

  try {
    const { fieldFilters, keywords } = parseSearchQuery(q);

    // If no query, return last N lines
    if (!q || !q.trim()) {
      const results = await getLastJsonlLines(sessionFile, limitNum);
      return res.json({
        success: true,
        results,
        total: results.length,
        truncated: results.length >= limitNum
      });
    }

    // For session search, always use JSON parsing (it's JSONL)
    const results = await jsonSearch(sessionFile, fieldFilters, keywords, limitNum);
    return res.json({
      success: true,
      results,
      total: results.length,
      truncated: results.length >= limitNum
    });
  } catch (err) {
    console.error('Session search error:', err);
    return res.json({ success: false, results: [], message: err.message });
  }
});

// Get initial session data (last N lines only)
app.get('/api/sessions/:sessionId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || INITIAL_LIMIT, MAX_LIMIT);

  try {
    const sessionFile = path.join(SESSIONS_DIR, `${req.params.sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    // Read file info
    const stat = fs.statSync(sessionFile);
    const totalLines = countLines(sessionFile);

    // Get last N lines
    getLastJsonlLines(sessionFile, limit).then(results => {
      res.json({
        success: true,
        results,
        totalLines,
        limit,
        truncated: totalLines > limit,
        fileSize: stat.size
      });
    }).catch(err => {
      res.status(500).json({ success: false, message: err.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Load older entries (pagination)
app.get('/api/sessions/:sessionId/older', (req, res) => {
  const { offset = 0, limit = INITIAL_LIMIT } = req.query;
  const offsetNum = parseInt(offset) || 0;
  const limitNum = Math.min(parseInt(limit) || INITIAL_LIMIT, MAX_LIMIT);

  try {
    const sessionFile = path.join(SESSIONS_DIR, `${req.params.sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    getJsonlLinesRange(sessionFile, offsetNum, limitNum).then(results => {
      res.json({
        success: true,
        results,
        offset: offsetNum,
        limit: limitNum
      });
    }).catch(err => {
      res.status(500).json({ success: false, message: err.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== HELPER FUNCTIONS =====

// Count lines in a file (fast using wc)
function countLines(filePath) {
  try {
    const result = execSync(`wc -l < "${filePath}"`, { encoding: 'utf-8' });
    return parseInt(result.trim()) || 0;
  } catch {
    return 0;
  }
}

// Get last N lines of a text file
async function getLastLines(filePath, limit) {
  return new Promise((resolve, reject) => {
    exec(`tail -n ${limit} "${filePath}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const results = lines.map(line => {
        // Try to parse as JSON
        const trimmed = line.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            return { parsed: JSON.parse(trimmed), raw: line };
          } catch {
            return { raw: line };
          }
        }
        return { raw: line };
      });
      resolve(results);
    });
  });
}

// Get last N lines of a JSONL file
async function getLastJsonlLines(filePath, limit) {
  return new Promise((resolve, reject) => {
    exec(`tail -n ${limit} "${filePath}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const results = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line));
        } catch {
          results.push({ _raw: line });
        }
      }
      resolve(results);
    });
  });
}

// Get lines by offset (for pagination) - from the beginning
async function getJsonlLinesRange(filePath, offset, limit) {
  return new Promise((resolve, reject) => {
    // Use sed to get specific line range
    const startLine = offset + 1;
    const endLine = offset + limit;
    exec(`sed -n '${startLine},${endLine}p' "${filePath}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const results = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line));
        } catch {
          results.push({ _raw: line });
        }
      }
      resolve(results);
    });
  });
}

// Use grep for fast keyword search
async function grepSearch(filePath, keywords, limit) {
  return new Promise((resolve, reject) => {
    // Build grep chain: grep -i keyword1 | grep -i keyword2 | ...
    let cmd = `grep -i "${keywords[0]}" "${filePath}"`;
    for (let i = 1; i < keywords.length; i++) {
      cmd += ` | grep -i "${keywords[i]}"`;
    }
    cmd += ` | tail -n ${limit}`;

    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code !== 1) { // grep returns 1 when no matches
        reject(err);
        return;
      }
      const lines = (stdout || '').trim().split('\n').filter(l => l.trim());
      const results = lines.map(line => {
        const trimmed = line.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            return { parsed: JSON.parse(trimmed), raw: line };
          } catch {
            return { raw: line };
          }
        }
        return { raw: line };
      });
      resolve(results);
    });
  });
}

// JSON-aware search (for field:value queries)
async function jsonSearch(filePath, fieldFilters, keywords, limit) {
  return new Promise((resolve, reject) => {
    const results = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (results.length >= limit) {
        rl.close();
        fileStream.destroy();
        return;
      }

      const trimmed = line.trim();
      if (!trimmed) return;

      // Try to parse as JSON
      let obj = null;
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          obj = JSON.parse(trimmed);
        } catch {}
      }

      // Check field filters (requires parsed JSON)
      if (fieldFilters.length > 0) {
        if (!obj || !matchesFieldFilters(obj, fieldFilters)) {
          return;
        }
      }

      // Check keywords (can match against raw line)
      if (keywords.length > 0) {
        if (!matchesKeywords(line, keywords)) {
          return;
        }
      }

      // Match found
      if (obj) {
        results.push(obj);
      } else {
        results.push({ _raw: line });
      }
    });

    rl.on('close', () => {
      resolve(results);
    });

    rl.on('error', (err) => {
      reject(err);
    });
  });
}

// API endpoints

// ===== Agent Fleet API =====

// GET /api/agents - List all agents with their status
app.get('/api/agents', (req, res) => {
  try {
    const agents = agentsConfig.agents.map(agent => {
      const status = agentStatus.get(agent.id) || {};
      return {
        ...agent,
        token: agent.token ? '***' : null, // Don't expose token
        status: status.status || 'unknown',
        lastCheck: status.lastCheck,
        lastActivity: status.lastActivity,
        sessionsCount: status.sessions?.length || 0,
        error: status.error
      };
    });
    res.json({ success: true, agents });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/agents/:id/status - Get single agent status
app.get('/api/agents/:id/status', async (req, res) => {
  try {
    const agent = agentsConfig.agents.find(a => a.id === req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    // Fetch fresh status
    const statusResult = await fetchAgentStatus(agent);
    const status = agentStatus.get(agent.id) || {};
    
    // Update cached status
    status.status = statusResult.online ? 'online' : 'offline';
    status.lastCheck = new Date().toISOString();
    status.gatewayData = statusResult.data;
    status.error = statusResult.error;
    agentStatus.set(agent.id, status);

    res.json({
      success: true,
      agent: {
        ...agent,
        token: agent.token ? '***' : null
      },
      status: status.status,
      lastCheck: status.lastCheck,
      lastActivity: status.lastActivity,
      gatewayData: status.gatewayData,
      error: status.error
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/agents/:id/sessions - Get agent sessions
app.get('/api/agents/:id/sessions', async (req, res) => {
  try {
    const agent = agentsConfig.agents.find(a => a.id === req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    // Get sessions from cached status (already fetched via openclaw CLI)
    const status = agentStatus.get(agent.id) || {};
    const sessions = status.sessions || [];
    
    // Format sessions for display
    const formattedSessions = sessions.map(s => ({
      id: s.sessionId,
      sessionId: s.sessionId,
      key: s.key,
      kind: s.kind,
      channel: s.key?.split(':')[2] || s.kind || 'unknown',
      updatedAt: s.updatedAt,
      age: s.age,
      model: s.model,
      totalTokens: s.totalTokens,
      contextTokens: s.contextTokens || 128000,
      percentUsed: s.percentUsed
    }));

    res.json({
      success: true,
      sessions: formattedSessions,
      error: null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/agents/:id/refresh - Force refresh agent status
app.post('/api/agents/:id/refresh', async (req, res) => {
  try {
    const agent = agentsConfig.agents.find(a => a.id === req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const statusResult = await fetchAgentStatus(agent);
    const sessionsResult = await fetchAgentSessions(agent);

    const status = {
      status: statusResult.online ? 'online' : 'offline',
      lastCheck: new Date().toISOString(),
      lastActivity: statusResult.data?.lastActivity,
      gatewayData: statusResult.data,
      sessions: sessionsResult.sessions || [],
      error: statusResult.error
    };
    agentStatus.set(agent.id, status);

    // Broadcast update
    broadcastAgentUpdates([{ agentId: agent.id, ...status }]);

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/agents/refresh-all - Force refresh all agents
app.post('/api/agents/refresh-all', async (req, res) => {
  try {
    await pollAllAgents();
    const agents = agentsConfig.agents.map(agent => {
      const status = agentStatus.get(agent.id) || {};
      return {
        id: agent.id,
        status: status.status || 'unknown',
        lastCheck: status.lastCheck
      };
    });
    res.json({ success: true, agents });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/gateway/:action', async (req, res) => {
  const { action } = req.params;
  try {
    const result = await executeGatewayCommand(action);
    res.json({ success: true, message: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const result = await executeGatewayCommand('status');
    res.json({ success: true, status: result });
  } catch (err) {
    res.json({ success: false, status: 'unknown', message: err.message });
  }
});

app.get('/api/logs/files', (req, res) => {
  try {
    const files = getAllLogFiles();
    res.json({ 
      success: true, 
      files: files.map(f => ({ name: f.name, dir: f.dir, displayName: `${f.name} (${path.basename(f.dir)})` }))
    });
  } catch (err) {
    res.json({ success: false, files: [], message: err.message });
  }
});

// WebSocket connection for log streaming
const logWatchers = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected');
  
  let tailProcess = null;
  let currentLogFile = null;

  const startTailing = (logFileInfo) => {
    if (tailProcess) {
      tailProcess.kill();
    }

    let targetFile;
    if (logFileInfo && logFileInfo.name && logFileInfo.dir) {
      targetFile = path.join(logFileInfo.dir, logFileInfo.name);
    } else {
      targetFile = getLatestLogFile();
    }
    
    if (!targetFile || !fs.existsSync(targetFile)) {
      ws.send(JSON.stringify({ type: 'error', message: 'No log file found' }));
      return;
    }

    currentLogFile = targetFile;
    ws.send(JSON.stringify({ type: 'info', message: `Tailing: ${path.basename(targetFile)}` }));

    // Send last 100 lines first (use the API endpoint logic)
    exec(`tail -n 100 "${targetFile}"`, (err, stdout) => {
      if (!err && stdout) {
        ws.send(JSON.stringify({ type: 'initial', data: stdout }));
      }
    });

    // Start tailing
    tailProcess = spawn('tail', ['-f', '-n', '0', targetFile]);

    tailProcess.stdout.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'log', data: data.toString() }));
      }
    });

    tailProcess.stderr.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: data.toString() }));
      }
    });

    tailProcess.on('close', () => {
      console.log('Tail process closed');
    });
  };

  // Start with the latest log file
  startTailing();

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'switch-log' && msg.file) {
        startTailing({ name: msg.file, dir: msg.dir });
      } else if (msg.type === 'refresh') {
        startTailing(null);
      }
    } catch (err) {
      console.error('Invalid message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (tailProcess) {
      tailProcess.kill();
    }
  });
});

// Express error handler middleware
app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Dashboard running at http://localhost:${PORT}`);
  console.log(`Logs directories: ${LOGS_DIRS.join(', ')}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`PID: ${process.pid}`);
});

// Keep the server running
server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
});
