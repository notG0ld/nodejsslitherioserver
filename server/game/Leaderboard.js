'use strict';

const WebSocket = require('ws');
const config = require('../config');
const { calcScore } = require('../protocol/encoder');

class Leaderboard {
  constructor() {
    this.entries = [];
    this.lastUpdate = 0;

    this.wss = new WebSocket.Server({
      port: config.WS_PORT || 8181
    });

    // Heartbeat interval (30s)
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('connection', (ws) => {
      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('error', () => {
        try { ws.terminate(); } catch {}
      });

      ws.on('close', () => {
        ws.isAlive = false;
      });

      // Send current leaderboard once on connect
      if (this.entries.length > 0) {
        try {
          ws.send(JSON.stringify({ type: 'leaderboard', data: this.entries }));
        } catch {}
      }
    });
  }

  broadcast(data) {
    if (!data || data.length === 0) return;

    const message = JSON.stringify({ type: 'leaderboard', data });

    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      try {
        client.send(message);
      } catch {
        try { client.terminate(); } catch {}
      }
    });
  }

  update(snakes) {
    const now = Date.now();
    if (now - this.lastUpdate < config.LEADERBOARD_INTERVAL) return false;
    this.lastUpdate = now;

    const scored = [];

    for (const snake of snakes) {
      if (!snake.alive || snake.isBot) continue;

      const score = calcScore(snake.sct, snake.fam);

      const safeSnake = {
        id: snake.id,
        sct: snake.sct,
        rsc: snake.rsc,
        fam: snake.fam,
        skin: snake.skin,
        name: snake.name
      };

      scored.push({
        place: 0,
        cv: snake.skin,
        i: snake.id,
        nk: snake.name,
        score: score,
        snake: safeSnake
      });
    }

    scored.sort((a, b) => b.score - a.score);
    scored.forEach((e, idx) => e.place = idx + 1);

    const newEntries = scored.slice(0, config.LEADERBOARD_SIZE);

    const changed = JSON.stringify(newEntries) !== JSON.stringify(this.entries);

    if (changed) {
      this.entries = newEntries;
      if (newEntries.length > 0) {
        this.broadcast(this.entries);
      }
    }

    return true;
  }

  getRank(snakeId) {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].snake.id === snakeId) return i + 1;
    }
    return this.entries.length + 1;
  }

  getMyPosition(snakeId) {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].snake.id === snakeId) return i + 1;
    }
    return 0;
  }
}

module.exports = Leaderboard;
