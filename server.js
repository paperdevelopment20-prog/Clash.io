const ws = require("ws");
const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

// Import the connectDB function
const connectDB = require("./dbconn");

// --- DATABASE SETUP ---
const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema(
    {
        username: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        password: {
            type: String,
            required: true,
        },
        loadout: {
            type: [String], // Array of strings for ability names
            required: true,
        },
        wins: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true },
);

const User = mongoose.model("User", userSchema);

// Connect to mongoDB
connectDB();

// --- GAME CONSTANTS ---
const PORT = process.env.PORT || 5000;
const TILE_SIZE = 25;
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 1000;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 2.5;
const PROJECTILE_RADIUS = 5;

// ABILITY CONFIGURATION
const ALL_ABILITIES = {
    whiteBall: { name: "White Ball", damage: 10, projSpeed: 5 },
    fireBall: { name: "Fire Ball", damage: 20, projSpeed: 4, radius: 10 },
    snowball: { 
        name: "Snowball", 
        damage: 5, 
        projSpeed: 4, 
        slowDuration: 5000, 
        speedMult: 0.5 
    },
    target: { 
        name: "Target", 
        damage: 15, 
        projSpeed: 3.5, 
        isHoming: true, 
        color: "#ff0000" 
    },
    blink: { name: "Blink", cooldown: 3000 },
    shield: { name: "Shield", duration: 2000, cooldown: 5000 },
};

// --- WORLD DATA ---
const map = [];
for (let y = 0; y < MAP_HEIGHT / TILE_SIZE; y++) {
    const row = [];
    for (let x = 0; x < MAP_WIDTH / TILE_SIZE; x++) {
        row.push(
            x === 0 ||
                y === 0 ||
                x === MAP_WIDTH / TILE_SIZE - 1 ||
                y === MAP_HEIGHT / TILE_SIZE - 1 ||
                (Math.random() < 0.1 && x > 5 && y > 5)
                ? 1
                : 0,
        );
    }
    map.push(row);
}

function checkCollision(x, y, size) {
    const tilesToCheck = [
        { x: x - size, y: y - size },
        { x: x + size, y: y - size },
        { x: x - size, y: y + size },
        { x: x + size, y: y + size },
    ];
    for (const tile of tilesToCheck) {
        const tx = Math.floor(tile.x / TILE_SIZE);
        const ty = Math.floor(tile.y / TILE_SIZE);
        if (ty >= 0 && ty < map.length && tx >= 0 && tx < map[0].length) {
            if (map[ty][tx] === 1) return true;
        }
    }
    return false;
}

// --- GAME ROOM CLASS ---
class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = {};
        this.projectiles = [];
        this.interval = setInterval(() => this.update(), 1000 / 60);
    }

    addPlayer(id, name, loadout, ws) {
        let spawnX, spawnY;
        do {
            spawnX = Math.random() * (MAP_WIDTH - 100) + 50;
            spawnY = Math.random() * (MAP_HEIGHT - 100) + 50;
        } while (checkCollision(spawnX, spawnY, PLAYER_SIZE));

        this.players[id] = {
            id,
            name,
            x: spawnX,
            y: spawnY,
            hp: 100,
            maxHp: 100,
            loadout,
            color: `hsl(${Math.random() * 360}, 70%, 50%)`,
            input: { dx: 0, dy: 0 },
            isStunned: false,
            stunEndTime: 0,
            isSlowed: false,
            slowEndTime: 0,
            hasShield: false,
            shieldEndTime: 0,
            ws,
            lastActivityTime: Date.now(),
        };
    }

    removePlayer(id) {
        delete this.players[id];
    }

    update() {
        const now = Date.now();
        const playerList = Object.values(this.players);

        playerList.forEach((player) => {
            this.updatePlayerPosition(player);
        });

        this.updateProjectiles();

        const gameState = {
            players: playerList.map((p) => ({
                id: p.id,
                name: p.name,
                x: p.x,
                y: p.y,
                hp: p.hp,
                maxHp: p.maxHp,
                color: p.color,
                hasShield: p.hasShield,
                isStunned: p.isStunned,
                isSlowed: p.isSlowed
            })),
            projectiles: this.projectiles.map((p) => ({
                x: p.x,
                y: p.y,
                color: p.color,
                type: p.type,
                radius: p.type === 'fireBall' ? ALL_ABILITIES.fireBall.radius : PROJECTILE_RADIUS
            })),
        };

        playerList.forEach((p) => {
            if (p.ws.readyState === ws.OPEN) {
                p.ws.send(JSON.stringify({ type: "gameState", state: gameState }));
            }
        });
    }

    updatePlayerPosition(player) {
        const now = Date.now();

        // Handle Status Effects
        if (player.isStunned && now >= player.stunEndTime) player.isStunned = false;
        if (player.isSlowed && now >= player.slowEndTime) player.isSlowed = false;
        if (player.hasShield && now >= player.shieldEndTime) player.hasShield = false;

        if (player.isStunned) return;

        let currentSpeed = PLAYER_SPEED;
        if (player.isSlowed) {
            currentSpeed *= ALL_ABILITIES.snowball.speedMult;
        }

        let newX = player.x + player.input.dx * currentSpeed;
        let newY = player.y + player.input.dy * currentSpeed;

        if (!checkCollision(newX, player.y, PLAYER_SIZE)) player.x = newX;
        if (!checkCollision(player.x, newY, PLAYER_SIZE)) player.y = newY;

        player.x = Math.max(PLAYER_SIZE, Math.min(MAP_WIDTH - PLAYER_SIZE, player.x));
        player.y = Math.max(PLAYER_SIZE, Math.min(MAP_HEIGHT - PLAYER_SIZE, player.y));
    }

    updateProjectiles() {
        const projectilesToRemove = [];
        const playerList = Object.values(this.players);
        const now = Date.now();

        this.projectiles.forEach((p, index) => {
            // Homing Logic for 'target'
            if (p.type === 'target') {
                let nearestPlayer = null;
                let minDist = Infinity;

                playerList.forEach(target => {
                    if (target.id !== p.ownerId) {
                        const d = Math.sqrt((p.x - target.x) ** 2 + (p.y - target.y) ** 2);
                        if (d < minDist) {
                            minDist = d;
                            nearestPlayer = target;
                        }
                    }
                });

                if (nearestPlayer) {
                    const angle = Math.atan2(nearestPlayer.y - p.y, nearestPlayer.x - p.x);
                    p.dx = Math.cos(angle) * ALL_ABILITIES.target.projSpeed;
                    p.dy = Math.sin(angle) * ALL_ABILITIES.target.projSpeed;
                }
            }

            p.x += p.dx;
            p.y += p.dy;

            // Collision with walls
            if (checkCollision(p.x, p.y, PROJECTILE_RADIUS) || 
                p.x < 0 || p.x > MAP_WIDTH || p.y < 0 || p.y > MAP_HEIGHT) {
                projectilesToRemove.push(index);
                return;
            }

            // Collision with players
            for (const target of playerList) {
                if (target.id !== p.ownerId) {
                    const pRadius = p.type === 'fireBall' ? ALL_ABILITIES.fireBall.radius : PROJECTILE_RADIUS;
                    const distSq = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;

                    if (distSq < (PLAYER_SIZE + pRadius) ** 2) {
                        if (target.hasShield) {
                            // Simple reflection
                            p.ownerId = target.id;
                            p.dx *= -1.2;
                            p.dy *= -1.2;
                            return;
                        }

                        // Apply damage
                        target.hp -= p.damage;

                        // Snowball Effect: Slow
                        if (p.type === 'snowball') {
                            target.isSlowed = true;
                            target.slowEndTime = now + ALL_ABILITIES.snowball.slowDuration;
                        }

                        if (target.hp <= 0) {
                            this.respawnPlayer(target);
                            const killer = this.players[p.ownerId];
                            if (killer) killer.kills = (killer.kills || 0) + 1;
                        }

                        projectilesToRemove.push(index);
                        break;
                    }
                }
            }
        });

        this.projectiles = this.projectiles.filter((_, i) => !projectilesToRemove.includes(i));
    }

    respawnPlayer(player) {
        player.hp = 100;
        let spawnX, spawnY;
        do {
            spawnX = Math.random() * (MAP_WIDTH - 100) + 50;
            spawnY = Math.random() * (MAP_HEIGHT - 100) + 50;
        } while (checkCollision(spawnX, spawnY, PLAYER_SIZE));
        player.x = spawnX;
        player.y = spawnY;
        player.isStunned = false;
        player.isSlowed = false;
    }
}

// --- SERVER SETUP ---
const app = express();
const server = app.listen(PORT);
const wss = new ws.Server({ server });

const gameRooms = {
    "Arena 1": new GameRoom("Arena 1"),
};

// --- WEBSOCKET HANDLER ---
wss.on("connection", (ws) => {
    const playerId = Math.random().toString(36).substr(2, 9);
    console.log(`New player connected: ${playerId}`);

    ws.on("message", async (message) => {
        const data = JSON.parse(message);
        const room = ws.roomId ? gameRooms[ws.roomId] : null;

        switch (data.type) {
            case "login":
                try {
                    const user = await User.findOne({ username: data.username.toLowerCase() });
                    if (user && (await bcrypt.compare(data.password, data.password))) {
                        ws.username = user.username;
                        ws.send(JSON.stringify({ type: "loginSuccess", username: user.username, loadout: user.loadout }));
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid credentials" }));
                    }
                } catch (e) {
                    ws.send(JSON.stringify({ type: "error", message: "Database error" }));
                }
                break;

            case "joinGame":
                ws.roomId = data.room || "Arena 1";
                const targetRoom = gameRooms[ws.roomId];
                targetRoom.addPlayer(playerId, data.username || "Guest", data.loadout || ["whiteBall", "blink"], ws);
                ws.send(JSON.stringify({ type: "mapData", map }));
                break;

            case "input":
                if (room && room.players[playerId]) {
                    room.players[playerId].input = { dx: data.dx, dy: data.dy };
                    room.players[playerId].lastActivityTime = Date.now();
                }
                break;

            case "ability":
                if (room && room.players[playerId]) {
                    const player = room.players[playerId];
                    const abilityKey = data.ability;
                    const ability = ALL_ABILITIES[abilityKey];

                    if (!ability) return;

                    if (["whiteBall", "fireBall", "snowball", "target"].includes(abilityKey)) {
                        const angle = data.angle;
                        let projColor = player.color;
                        if (abilityKey === "whiteBall") projColor = "#ffffff";
                        else if (abilityKey === "fireBall") projColor = "#ff4500";
                        else if (abilityKey === "snowball") projColor = "#add8e6";
                        else if (abilityKey === "target") projColor = "#ff0000";

                        room.projectiles.push({
                            ownerId: playerId,
                            type: abilityKey,
                            x: player.x + Math.cos(angle) * (PLAYER_SIZE + 5),
                            y: player.y + Math.sin(angle) * (PLAYER_SIZE + 5),
                            dx: Math.cos(angle) * ability.projSpeed,
                            dy: Math.sin(angle) * ability.projSpeed,
                            damage: ability.damage,
                            color: projColor,
                        });
                    } else if (abilityKey === "blink") {
                        const dist = 100;
                        const nx = player.x + player.input.dx * dist;
                        const ny = player.y + player.input.dy * dist;
                        if (!checkCollision(nx, ny, PLAYER_SIZE)) {
                            player.x = nx;
                            player.y = ny;
                        }
                    } else if (abilityKey === "shield") {
                        player.hasShield = true;
                        player.shieldEndTime = Date.now() + ability.duration;
                    }
                }
                break;
        }
    });

    ws.on("close", () => {
        if (ws.roomId && gameRooms[ws.roomId]) {
            gameRooms[ws.roomId].removePlayer(playerId);
        }
    });
});

console.log(`Clash.io Server running on port ${PORT}`);
