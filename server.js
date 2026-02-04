const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

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
