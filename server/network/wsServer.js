'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const config = require('../config');
const Player = require('./Player');
const encoder = require('../protocol/encoder');
const decoder = require('../protocol/decoder');

// Path to your OpenSSL binary
const OPENSSL_BIN = "C:\\Program Files\\Common Files\\SSL\\bin\\openssl.exe";

// Run OpenSSL safely
function runOpenSSL(args) {
    return new Promise((resolve, reject) => {
        execFile(
            OPENSSL_BIN,
            args,
            { windowsHide: true },
            (err, stdout, stderr) => {
                if (err) return reject(stderr || err);
                resolve(stdout);
            }
        );
    });
}

// Detect newest PFX in config.CERTH_PATH
function getLatestPfx(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.pfx'))
        .map(f => ({
            name: f,
            time: fs.statSync(path.join(dir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
        throw new Error("No .pfx files found in " + dir);
    }

    return path.join(dir, files[0].name);
}

// Extract PEMs using real OpenSSL
async function extractPemsFromPfx(pfxPath, outKey, outCert) {
    console.log("[SSL] Extracting PEMs from:", pfxPath);

    // Extract private key
    await runOpenSSL([
        "pkcs12",
        "-in", pfxPath,
        "-nocerts",
        "-nodes",
        "-out", outKey,
        "-passin", "pass:"
    ]);
    console.log("[SSL] Extracted key →", outKey);

    // Extract certificate
    await runOpenSSL([
        "pkcs12",
        "-in", pfxPath,
        "-clcerts",
        "-nokeys",
        "-out", outCert,
        "-passin", "pass:"
    ]);
    console.log("[SSL] Extracted cert →", outCert);
}

class WsServer {
    constructor(gameEngine) {
        this.game = gameEngine;
        this.wss = null;
    }

    async start(port, host) {
        let server;

        if (config.HTTPS) {
            const pfxPath = getLatestPfx(config.CERTH_PATH);
            console.log("Detected PFX:", pfxPath);

            const outKey = path.join(config.CERTH_PATH, "node-key.pem");
            const outCert = path.join(config.CERTH_PATH, "node-cert.pem");

            // Extract PEMs and WAIT
            await extractPemsFromPfx(pfxPath, outKey, outCert);

            // Now safe to read
            const key = fs.readFileSync(outKey);
            const cert = fs.readFileSync(outCert);

            server = https.createServer({ key, cert });
            console.log("[HTTPS] Using extracted PEM certificates");

        } else {
            server = http.createServer();
            console.log("[HTTP] Running without TLS");
        }

        this.wss = new WebSocket.Server({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: 4096,
        });

        server.on('upgrade', (req, socket, head) => {
            if (req.url !== '/slither') {
                socket.destroy();
                return;
            }

            const ver = req.headers['sec-websocket-version'];
            if (ver && ver.includes(',')) {
                req.headers['sec-websocket-version'] = ver.split(',')[0].trim();
            }

            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit('connection', ws, req);
            });
        });

        server.listen(port, host, () => {
            console.log(`WebSocket server listening on ${config.HTTPS ? "https" : "http"}://${host}:${port}/slither`);
        });

        this.wss.on('connection', (ws, req) => {
            this._handleConnection(ws, req);
        });

        this.wss.on('error', (err) => {
            console.error('WebSocket server error:', err.message);
        });
    }

    _handleConnection(ws, req) {
        ws.binaryType = 'arraybuffer';
        const player = new Player(ws);
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        console.log(`[Connect] Player ${player.id} from ${ip}`);

        ws.on('message', (data) => {
            this._handleMessage(player, data);
        });

        ws.on('close', () => {
            console.log(`[Disconnect] Player ${player.id}`);
            this.game.removePlayer(player.id);
            player.cleanup();
        });

        ws.on('error', (err) => {
            console.error(`[Error] Player ${player.id}: ${err.message}`);
        });
    }

    _handleMessage(player, rawData) {
        const data = new Uint8Array(rawData);
        if (data.length === 0) return;

        switch (player.state) {
            case 'connected':
                this._handleHandshake(player, data);
                break;
            case 'handshake':
                this._handlePreLogin(player, data);
                break;
            case 'playing':
                this._handleInput(player, data);
                break;
        }
    }

    _handleHandshake(player, data) {
        if (data.length === 1 && (data[0] === 0x01 || data[0] === 0x02)) {
            if (data[0] === 0x02) player.wantSeq = true;
            player.wantEtm = true;
            return;
        }

        if (!player.wantEtm) {
            player.needsPrefix = true;
            if (data.length >= 2 && data[1] === 0x04) {
                player.clientType = 'protocol13';
                player.protocolVersion = 13;
            } else {
                player.clientType = 'protocol11';
                player.protocolVersion = 11;
            }
        } else {
            player.needsPrefix = false;
            player.clientType = 'protocol11';
            player.protocolVersion = config.PROTOCOL_VERSION;
        }

        player.send(encoder.encodeServerVersion(config.PROTOCOL11_SECRET));
        player.state = 'handshake';
    }

    _handlePreLogin(player, data) {
        if (!player.gotRandomId) {
            if (data[0] === 0x73 && data.length > 6 && data[1] < 65) {
                this._processLogin(player, data);
                return;
            }
            player.gotRandomId = true;
            return;
        }

        if (data[0] === 0x73) {
            this._processLogin(player, data);
        }
    }

    _processLogin(player, data) {
        const login = decoder.decodeLoginPacket(data);
        if (!login) {
            console.log(`[Login] Player ${player.id}: invalid login packet`);
            player.ws.close();
            return;
        }

        if (!login.isProtocol13 && player.clientType === 'protocol13') {
            player.clientType = 'protocol11';
        }

        if (player.wantEtm) {
            if (login.version >= 11 && login.version <= 19) {
                player.protocolVersion = login.version;
            } else if (login.version === 31) {
                player.protocolVersion = 14;
            } else {
                player.protocolVersion = config.PROTOCOL_VERSION;
            }
        }

        console.log(`[Login] Player ${player.id}: name="${login.name}" skin=${login.skin} proto=${player.protocolVersion}`);

        this.game.addPlayer(player);

        const initPkt = encoder.encodeInitPacket({
            sid: player.id,
            protocolVersion: player.protocolVersion,
        });
        player.send(initPkt);

        const snake = this.game.spawnSnake(player, login.name, login.skin);
        if (!snake) {
            console.log(`[Login] Player ${player.id}: failed to spawn snake`);
            player.ws.close();
            return;
        }

        player.state = 'playing';
        this.game.sendInitialState(player);

        console.log(`[Login] Player ${player.id}: playing! snake=${snake.id}`);
    }

    _handleInput(player, data) {
        if (data.length === 1 && data[0] === 0xFB) {
            player.lastPing = Date.now();
            player.send(encoder.encodePong());
            return;
        }

        if (!player.snake || !player.snake.alive) {
            if (data[0] === 0x73 && data.length > 6) {
                this._handleReLogin(player, data);
            }
            return;
        }

        const input = decoder.decodeInput(data);
        if (!input) return;

        switch (input.type) {
            case 'angle':
                player.snake.setWantAngle(input.angle);
                break;
            case 'boost':
                player.snake.setBoost(input.active);
                break;
            case 'turn':
                if (input.direction === 'left') {
                    player.snake.setWantAngle(player.snake.wantAngle - input.amount * 0.01);
                } else {
                    player.snake.setWantAngle(player.snake.wantAngle + input.amount * 0.01);
                }
                break;
            case 'ping':
                player.lastPing = Date.now();
                player.send(encoder.encodePong());
                break;
        }
    }

    _handleReLogin(player, data) {
        const login = decoder.decodeLoginPacket(data);
        if (!login) return;

        console.log(`[ReLogin] Player ${player.id}: name="${login.name}"`);

        const initPkt = encoder.encodeInitPacket({
            sid: player.id,
            protocolVersion: player.protocolVersion,
        });
        player.send(initPkt);

        const snake = this.game.spawnSnake(player, login.name, login.skin);
        if (!snake) return;

        this.game.sendInitialState(player);
    }

    getConnectionCount() {
        return this.wss ? this.wss.clients.size : 0;
    }
}

module.exports = WsServer;
