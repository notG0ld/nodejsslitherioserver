'use strict';

const WebSocket = require('ws');
const config = require('../config');
const { calcScore } = require('../protocol/encoder');

class Leaderboard {
  constructor() {
    this.entries = [];
    this.lastUpdate = 0;

    // WebSocket server
    this.wss = new WebSocket.Server({ port: config.WS_PORT || 8181 });

    this.wss.on('connection', (ws) => {
      // Send current leaderboard once on connect
      if (this.entries.length > 0) {
        ws.send(JSON.stringify({ type: 'leaderboard', data: this.entries }));
      }
    });
  }

  broadcast(data) {
    if (!data || data.length === 0) return; // never broadcast empty

    const message = JSON.stringify({ type: 'leaderboard', data });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
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

      // Safe snake object (no circular refs)
      const safeSnake = {
        id: snake.id,
        sct: snake.sct,
        rsc: snake.rsc,
        fam: snake.fam,
        skin: snake.skin,
        name: snake.name
      };

      scored.push({
        place: 0,              // will be assigned after sorting
        cv: snake.skin,        // skin
        i: snake.id,           // id
        nk: snake.name,        // name
        score: score,          // score
        snake: safeSnake       // GameEngine compatibility
      });
    }

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    // Assign place numbers
    scored.forEach((e, idx) => e.place = idx + 1);

    const newEntries = scored.slice(0, config.LEADERBOARD_SIZE);

    const oldLength = this.entries.length;
    const newLength = newEntries.length;

    const changed =
      JSON.stringify(newEntries) !== JSON.stringify(this.entries);

    const lengthChanged = oldLength !== newLength;

    // Only broadcast when:
    // 1. leaderboard content changed
    // 2. OR length changed (1→0 or 0→1)
    if (changed || lengthChanged) {
      this.entries = newEntries;

      // Only broadcast non-empty lists
      if (newLength > 0) {
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
