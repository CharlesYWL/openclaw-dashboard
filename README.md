# OpenClaw Gateway Dashboard

A simple web-based dashboard for managing the OpenClaw Gateway.

## Features

- **Real-time Log Viewer** - Tails gateway logs via WebSocket
- **Gateway Controls** - Start/Stop/Restart buttons
- **Status Monitoring** - Auto-refreshing status indicator
- **Multiple Log Files** - Switch between gateway and command logs

## Installation

```bash
npm install
```

## Usage

```bash
node server.js
```

Then open http://localhost:3456 in your browser.

## Tech Stack

- Backend: Node.js + Express + WebSocket
- Frontend: Vanilla HTML/JS
- No frameworks, minimal dependencies

## Log Sources

- `/tmp/openclaw/` - Main gateway logs
- `~/.openclaw/logs/` - Command logs

## API Endpoints

- `GET /api/status` - Gateway status
- `POST /api/gateway/start` - Start gateway
- `POST /api/gateway/stop` - Stop gateway
- `POST /api/gateway/restart` - Restart gateway
- `GET /api/logs/files` - List available log files

## WebSocket

Connect to `ws://localhost:3456` for real-time log streaming.

Messages:
- `{ type: 'switch-log', file: 'name.log', dir: '/path' }` - Switch log file
- `{ type: 'refresh' }` - Refresh current log
