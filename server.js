const ws = require("ws");
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

// Import the connectDB function
const connectDB = require("./dbconn");

// --- DATABASE SETUP ---

const SALT_ROUNDS = 10;

// DEFINE MONGOOSE SCHEMA AND MODEL
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
        elo: {
            type: Number,
            default: 1000,
        },
    },
    { timestamps: true },
);

const User = mongoose.model("User", userSchema);
// END OF DATABASE SETUP

// Connect to mongoDB
connectDB().then(async () => {
    // Backfill elo for existing users who don't have it
    await User.updateMany({ elo: { $exists: false } }, { $set: { elo: 1000 } });
});

// --- GAME CONSTANTS (MUST MATCH CLIENT) ---

// --- GAME CONSTANTS (MUST MATCH CLIENT) ---
// --- GAME CONSTANTS (MUST MATCH CLIENT) ---
const PORT = process.env.PORT || 5000;
/* Around line 238 in index.html */
const TILE_SIZE = 20;
const TILES_X = 45; // (45 * 20 = 900px width)
const TILES_Y = 30; // (30 * 20 = 600px height)

const FULL_MAP_HEIGHT = TILES_Y * TILE_SIZE;
const GAME_WORLD_WIDTH = TILES_X * TILE_SIZE;

const CANVAS_WIDTH = TILES_X * TILE_SIZE;
const CANVAS_HEIGHT = TILES_Y * TILE_SIZE;
const PLAYER_SIZE = 10;
const PLAYER_SPEED = 2;
const MAX_HEALTH = 200;
const PROJECTILE_RADIUS = 5;
const ABILITY_COOLDOWN = 800;
const GAME_TICK = 1000 / 60;

const AFK_TIMEOUT = 60000; // NEW: 60 seconds of inactivity before kick

const HEALING_DURATION = 5000;
const HEALING_RADIUS = 60;
const REGEN_DELAY = 10000;
const REGEN_AMOUNT = 1 / 60;

// Fixed map barriers
const MAPS = [
    // Map 1: Original — center barrier + top/bottom enclosures
    [
        [0, 0, 45, 1], [0, 29, 45, 1], [0, 0, 1, 30], [44, 0, 1, 30],
        [10, 13, 25, 3],
        [18, 5, 9, 1], [18, 3, 1, 2], [26, 3, 1, 2],
        [18, 24, 9, 1], [18, 25, 1, 2], [26, 25, 1, 2],
    ],
    // Map 2: Crossroads — open corridors through center, 4 corner rooms
    [
        [0, 0, 45, 1], [0, 29, 45, 1], [0, 0, 1, 30], [44, 0, 1, 30],
        // Top-left block
        [2, 2, 16, 10],
        // Top-right block
        [27, 2, 16, 10],
        // Bottom-left block
        [2, 18, 16, 10],
        // Bottom-right block
        [27, 18, 16, 10],
    ],
    // Map 3: Open Arena — no internal barriers
    [
        [0, 0, 45, 1], [0, 29, 45, 1], [0, 0, 1, 30], [44, 0, 1, 30],
    ],
    // Map 4: Channels — horizontal walls creating 3 lanes
    [
        [0, 0, 45, 1], [0, 29, 45, 1], [0, 0, 1, 30], [44, 0, 1, 30],
        // Top channel wall (gap at x=20-24)
        [1, 9, 19, 2], [25, 9, 19, 2],
        // Bottom channel wall (gap at x=20-24)
        [1, 19, 19, 2], [25, 19, 19, 2],
        // Center blocker
        [20, 13, 5, 4],
    ],
];

const MAP_BARRIERS = MAPS[0]; // default, overridden per room
const ALL_ABILITIES = {
    whiteBall: { name: "White Ball", damage: 10, projSpeed: 5, duration: 0, cooldown: 3000 },
    fireBall: { name: "Fire Ball", damage: 20, projSpeed: 3, duration: 0, cooldown: 3000 },
    knockback: { name: "Knockback", damage: 0, force: 150, projSpeed: 3, ringRadius: 36, stopAfter: 650, duration: 0, cooldown: 3000 },
    impulse:   { name: "Impulse",   damage: 0, force: 150, projSpeed: 3, ringRadius: 36, stopAfter: 650, duration: 0, cooldown: 3000 },
    snowball: { name: "Snowball", damage: 10, projSpeed: 4, slowDuration: 1500, cooldown: 3000 },
    landmine: { name: "Landmine", damage: 25, force: 0, ringRadius: 36, explosionDelay: 500, projSpeed: 0, duration: 0, cooldown: 3000 },
    dash: {
        name: "Dash",
        damage: 0,
        projSpeed: 0,
        duration: 1000,
        dashDistance: 10,
        cooldown: 3000,
    },
    heal: {
        name: "Heal Zone",
        totalHeal: 25,
        duration: HEALING_DURATION,
        radius: HEALING_RADIUS,
        projSpeed: 0,
        cooldown: 3000,
    },
    reflection: { name: "Reflection", damage: 0, projSpeed: 0, duration: 3000, cooldown: 15000 },
    target: { name: "Target", damage: 50, projSpeed: 1, duration: 0, cooldown: 3000 },
};

// --- GAME UTILITIES (SHARED) ---

/**
 * Creates a base player object. Position and color are set by GameRoom.
 * @param {number} id - Player ID.
 * @param {string} name - Player name.
 * @param {string[]} loadout - Player ability loadout.
 * @param {WebSocket} ws - The associated WebSocket connection.
 */
function createPlayer(id, name, loadout, ws) {
    return {
        id: id,
        name: name,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        facingAngle: 0,
        health: MAX_HEALTH,
        color: "",
        isProtected: false,
        isReflecting: false,
        protectionEndTime: 0,
        isDashing: false,
        dashEndTime: 0,
        isStunned: false,
        stunEndTime: 0,
        isSlowed: false,
        slowEndTime: 0,
        isImpulsed: false,
        impulseEndTime: 0,
        lastDamageTime: Date.now(),
        loadout: loadout,
        // lastAbilityTime: [0, 0, 0, 0, 0],
        lastAbilityTime: Array(loadout.length).fill(0),
        input: { dx: 0, dy: 0 },
        wins: 0,
        ws: ws, // Store the WebSocket object for broadcasting
        lastActivityTime: Date.now(), // NEW: Initialize activity time
    };
}

/**
 * Checks for collision against canvas boundaries and map barriers.
 */
let _activeBarriers = MAP_BARRIERS; // set per-room before each update tick

function checkCollision(x, y, size) {
    const map = _activeBarriers;
    if (x - size < 0 || x + size > CANVAS_WIDTH || y - size < 0 || y + size > CANVAS_HEIGHT)
        return true;
    for (const b of map) {
        const bRect = {
            x: b[0] * TILE_SIZE, y: b[1] * TILE_SIZE,
            w: b[2] * TILE_SIZE, h: b[3] * TILE_SIZE,
        };
        const closestX = Math.max(bRect.x, Math.min(x, bRect.x + bRect.w));
        const closestY = Math.max(bRect.y, Math.min(y, bRect.y + bRect.h));
        const distX = x - closestX, distY = y - closestY;
        if (distX * distX + distY * distY < size * size) return true;
    }
    return false;
}

// --- ROOM-SPECIFIC GAME LOGIC (GameRoom Class) ---

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = {};
        this.projectiles = [];
        this.mines = [];
        this.healingFields = [];
        this.gameStatus = "lobby";
        this.gameInterval = null;
        this.playerCount = 0;
        this.mapIndex = Math.floor(Math.random() * MAPS.length);
        this.barriers = MAPS[this.mapIndex];

        // Countdown properties
        this.countdown = 0;
        this.countdownInterval = null;
        this.isStarting = false;

        console.log(`Room ${this.id} created with map ${this.mapIndex}.`);
    }

    addPlayer(player) {
        this.players[player.id] = player;
        this.playerCount++;

        // Map center X = tile 22.5 = 450px
        // Top barrier: tiles y 0-1 → spawn below at y=2 (40px)
        // Bottom barrier: tiles y 29-30 → spawn above at y=27 (540px)
        const centerX = CANVAS_WIDTH / 2;
        const spawns = [
            { x: centerX, y: 2 * TILE_SIZE }, // Below top barrier
            { x: centerX, y: 27 * TILE_SIZE }, // Above bottom barrier
        ];

        // Assign position based on player order
        const pos = spawns[(this.playerCount - 1) % spawns.length];
        player.x = pos.x;
        player.y = pos.y;

        // Set default player properties
        player.color = "#F7C574";

        // Trigger game start logic
        this.checkStartCondition();

        // Sync new state to all clients
        this.broadcastState();
    }

    removePlayer(playerId) {
        const player = this.players[playerId];
        if (!player) return;

        delete this.players[playerId];
        this.playerCount--;

        console.log(
            `Player ${player.name} left Room ${this.id}. Players remaining: ${this.playerCount}`,
        );

        // MODIFIED: Check start condition to stop countdown if necessary
        this.checkStartCondition();

        if (this.playerCount <= 1) {
            // If game hasn't started yet, send remaining player back to menu
            if (
                this.gameStatus === "waiting" ||
                this.gameStatus === "countdown"
            ) {
                const remainingPlayer = Object.values(this.players)[0];
                if (remainingPlayer && remainingPlayer.ws) {
                    remainingPlayer.ws.send(
                        JSON.stringify({
                            type: "returnToMenu",
                            message: "Opponent left. Returning to menu.",
                        }),
                    );
                }
            }
            this.endGame();
        } else {
            this.broadcastState();
        }
    }

    // NEW: Handles the countdown before match start
    checkStartCondition() {
        const numPlayers = Object.keys(this.players).length;

        if (numPlayers < 2) {
            // Stop countdown if condition is lost
            if (this.countdownInterval) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;
                this.countdown = 0;
                this.isStarting = false;
            }
            // Only broadcast status if not already finished/lobby
            if (this.gameStatus !== "finished") {
                this.broadcast({
                    type: "status",
                    message: "Waiting for another player...",
                });
            }
        } else if (
            numPlayers >= 2 &&
            !this.isStarting &&
            this.gameStatus === "lobby"
        ) {
            this.isStarting = true;
            this.countdown = 5; // 2s delay + 3s countdown
            this.gameStatus = "starting"; // Set room status to starting
            
            // Start game loop immediately so players can move during countdown
            this.startGameLoop();

            // Send initial status message (2 seconds delay starts here)
            this.broadcast({
                type: "status",
                message: "Match starting in 5 seconds...",
            });

            // Start Countdown Interval
            this.countdownInterval = setInterval(() => {
                this.countdown--;

                if (this.countdown === 3) {
                    // Start visual countdown after 2 seconds delay
                    this.broadcast({ type: "status", message: "3" });
                } else if (this.countdown > 0 && this.countdown < 3) {
                    // Send update for 2 and 1
                    this.broadcast({
                        type: "status",
                        message: `${this.countdown}`,
                    });
                } else if (this.countdown === 0) {
                    clearInterval(this.countdownInterval);
                    this.countdownInterval = null;
                    this.isStarting = false;
                    this.gameStatus = "playing"; // Set room status to playing (game loop already running)
                    this.broadcast({ type: "matchStart" });
                    console.log(`Room ${this.id} match started.`);
                }
            }, 1000);
        }
    }

    broadcast(message) {
        const data = JSON.stringify(message);
        Object.values(this.players).forEach((p) => {
            if (p.ws && p.ws.readyState === ws.OPEN) {
                p.ws.send(data);
            }
        });
    }

    broadcastStateTo(targetWs) {
        const stateMessage = JSON.stringify({
            type: "state",
            players: Object.values(this.players).map((p) => ({
                id: p.id,
                name: p.name,
                x: p.x,
                y: p.y,
                facingAngle: p.facingAngle,
                health: p.health,
                color: p.color,
                isProtected: p.isProtected,
                isReflecting: p.isReflecting,
                isDashing: p.isDashing,
                isStunned: p.isStunned,
                isImpulsed: p.isImpulsed,
                lastAbilityTime: p.lastAbilityTime,
                roomId: this.id,
                wins: p.wins || 0,
            })),
            projectiles: this.projectiles.map((p) => ({ ...p, abilityType: p.type })),
            mines: this.mines,
            healingFields: this.healingFields.map((f) => ({ x: f.x, y: f.y, radius: f.radius, color: f.color })),
            status: this.gameStatus,
            mapIndex: this.mapIndex,
        });
        if (targetWs && targetWs.readyState === ws.OPEN) targetWs.send(stateMessage);
    }

    broadcastState() {
        const stateMessage = {
            type: "state",
            players: Object.values(this.players).map((p) => ({
                id: p.id,
                name: p.name,
                x: p.x,
                y: p.y,
                facingAngle: p.facingAngle,
                health: p.health,
                color: p.color,
                isProtected: p.isProtected,
                isReflecting: p.isReflecting,
                isDashing: p.isDashing,
                isStunned: p.isStunned,
                isImpulsed: p.isImpulsed,
                lastAbilityTime: p.lastAbilityTime,
                roomId: this.id,
                wins: p.wins || 0,
            })),
            projectiles: this.projectiles.map((p) => ({
                ...p,
                abilityType: p.type,
            })),
            mines: this.mines,
            healingFields: this.healingFields.map((f) => ({
                x: f.x,
                y: f.y,
                radius: f.radius,
                color: f.color,
            })),
            status: this.gameStatus,
            mapIndex: this.mapIndex,
        };
        this.broadcast(stateMessage);
    }

    // --- GAME LOGIC METHODS (OPERATING ON THIS.STATE) ---

    updatePlayerPosition(player) {
        const now = Date.now();
        if (player.isStunned && now >= player.stunEndTime)
            player.isStunned = false;
        if (player.isSlowed && now >= player.slowEndTime)
            player.isSlowed = false;
        if (player.isProtected && now > player.protectionEndTime) {
            player.isProtected = false;
            player.isReflecting = false;
        }
        if (player.isDashing && now > player.dashEndTime)
            player.isDashing = false;
        if (player.isImpulsed && now > player.impulseEndTime)
            player.isImpulsed = false;

        if (player.isStunned) return;

        // --- FIX START: UNSTUCK LOGIC ---
        const isStuck = checkCollision(player.x, player.y, PLAYER_SIZE);

        if (isStuck) {
            const centerX = CANVAS_WIDTH / 2;
            const centerY = CANVAS_HEIGHT / 2;
            const angleToCenter = Math.atan2(
                centerY - player.y,
                centerX - player.x,
            );
            const pushSpeed = 2; // Gentle push speed

            player.x += Math.cos(angleToCenter) * pushSpeed;
            player.y += Math.sin(angleToCenter) * pushSpeed;
            // return; // Removed the return statement
        }

        player.dx = player.input.dx;
        player.dy = player.input.dy;

        // Normal movement (dash is handled separately in ability casting)
        const speed = player.isSlowed ? PLAYER_SPEED * 0.5 : PLAYER_SPEED;

        let newX = player.x + player.dx * speed;
        let newY = player.y + player.dy * speed;

        if (!checkCollision(newX, player.y, PLAYER_SIZE)) player.x = newX;
        if (!checkCollision(player.x, newY, PLAYER_SIZE)) player.y = newY;

        // Clamp player position to boundaries as a safety measure
        player.x = Math.max(
            PLAYER_SIZE,
            Math.min(CANVAS_WIDTH - PLAYER_SIZE, player.x),
        );
        player.y = Math.max(
            PLAYER_SIZE,
            Math.min(CANVAS_HEIGHT - PLAYER_SIZE, player.y),
        );
    }

    updateProjectiles() {
        const projectilesToRemove = [];
        const playerList = this._cachedPlayerList || Object.values(this.players);
        const now = Date.now();

        this.projectiles.forEach((p, index) => {
            // --- RING PROJECTILES (knockback / impulse) ---
            if (p.isRing) {
                if (now - p.createdAt > p.lifetime) {
                    projectilesToRemove.push(index);
                    return;
                }
                // Travel until stopAfter ms OR until a player is inside — then freeze in place
                const hasStopped = p.stopped || (p.stopAfter && (now - p.createdAt > p.stopAfter));
                if (!hasStopped) {
                    p.x += p.dx;
                    p.y += p.dy;
                    // Hit a wall — freeze instead of removing
                    if (checkCollision(p.x, p.y, PROJECTILE_RADIUS)) {
                        p.x -= p.dx;
                        p.y -= p.dy;
                        p.dx = 0;
                        p.dy = 0;
                        p.stopped = true;
                    }
                }
                if (p.type === "impulse") {
                    let impulseHit = false;
                    playerList.forEach((target) => {
                        if (target.id === p.ownerId || impulseHit) return;
                        const distSq = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
                        if (distSq < p.ringRadius ** 2) {
                            const angle = Math.atan2(target.y - p.y, target.x - p.x);
                            const dist = Math.sqrt(distSq);
                            const pullAmount = Math.min(dist, 60);
                            const newX = target.x + Math.cos(angle) * -pullAmount;
                            const newY = target.y + Math.sin(angle) * -pullAmount;
                            if (!checkCollision(newX, target.y, PLAYER_SIZE)) target.x = newX;
                            if (!checkCollision(target.x, newY, PLAYER_SIZE)) target.y = newY;
                            target.x = Math.max(PLAYER_SIZE, Math.min(CANVAS_WIDTH - PLAYER_SIZE, target.x));
                            target.y = Math.max(PLAYER_SIZE, Math.min(CANVAS_HEIGHT - PLAYER_SIZE, target.y));
                            target.lastDamageTime = now;
                            impulseHit = true;
                        }
                    });
                    if (impulseHit) projectilesToRemove.push(index);
                } else {
                    let knockbackHit = false;
                    playerList.forEach((target) => {
                        if (target.id === p.ownerId || knockbackHit) return;
                        const distSq = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
                        if (distSq < p.ringRadius ** 2) {
                            const angle = Math.atan2(target.y - p.y, target.x - p.x);
                            const newX = p.x + Math.cos(angle) * (p.ringRadius + PLAYER_SIZE);
                            const newY = p.y + Math.sin(angle) * (p.ringRadius + PLAYER_SIZE);
                            if (!checkCollision(newX, target.y, PLAYER_SIZE)) target.x = newX;
                            else target.x = Math.max(PLAYER_SIZE, Math.min(CANVAS_WIDTH - PLAYER_SIZE, target.x));
                            if (!checkCollision(target.x, newY, PLAYER_SIZE)) target.y = newY;
                            else target.y = Math.max(PLAYER_SIZE, Math.min(CANVAS_HEIGHT - PLAYER_SIZE, target.y));
                            target.lastDamageTime = now;
                            knockbackHit = true;
                        }
                    });
                    if (knockbackHit) projectilesToRemove.push(index);
                }
                return;
            }

            p.x += p.dx;
            p.y += p.dy;

            if (p.isTracking) {
                const target = playerList.find((pl) => pl.id !== p.ownerId);
                const speed = p.type === 'target' ? 1.5 : ALL_ABILITIES.whiteBall.projSpeed;
                if (target) {
                    const angle = Math.atan2(target.y - p.y, target.x - p.x);
                    p.dx = Math.cos(angle) * speed;
                    p.dy = Math.sin(angle) * speed;
                }
            }

            // Projectile collision check against barriers
            if (checkCollision(p.x, p.y, PROJECTILE_RADIUS)) {
                projectilesToRemove.push(index);
                return;
            }

            playerList.forEach((target) => {
                if (target.id !== p.ownerId) {
                    const distSq =
                        (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
                    if (distSq < (PLAYER_SIZE + PROJECTILE_RADIUS) ** 2) {
                        // Check for reflection
                        if (target.isProtected) {
                            if (target.isReflecting) {
                                // Reflect the projectile
                                p.ownerId = target.id;
                                p.dx = -p.dx;
                                p.dy = -p.dy;
                                p.color = target.color;
                                return;
                            } else {
                                // Protection absorbs the hit
                                projectilesToRemove.push(index);
                                return;
                            }
                        }

                        projectilesToRemove.push(index);

                        // Apply slow effect if this is a snowball
                        if (p.isStun) {
                            target.isSlowed = true;
                            target.slowEndTime = now + ALL_ABILITIES.snowball.slowDuration;
                        }

                        // Apply damage/heal
                        if (p.damage > 0) {
                            target.health = Math.max(
                                0,
                                target.health - p.damage,
                            );
                            target.lastDamageTime = now;
                        } else if (p.damage < 0) {
                            target.health = Math.min(
                                MAX_HEALTH,
                                target.health - p.damage,
                            );
                        }

                        // Handle elimination
                        if (target.health <= 0)
                            this.handleElimination(target.id, p.ownerId);
                    }
                }
            });
        });

        this.projectiles = this.projectiles.filter(
            (_, index) => !projectilesToRemove.includes(index),
        );
    }

    updateMines() {
        const minesToRemove = [];
        const playerList = this._cachedPlayerList || Object.values(this.players);
        const now = Date.now();

        this.mines.forEach((m, index) => {
            // --- RING MINES (landmine redesign) ---
            if (m.isRing) {
                // Move mine until it hits a wall
                if (m.isMoving) {
                    m.x += m.dx;
                    m.y += m.dy;
                    if (checkCollision(m.x, m.y, PROJECTILE_RADIUS)) {
                        m.x -= m.dx;
                        m.y -= m.dy;
                        m.dx = 0;
                        m.dy = 0;
                        m.isMoving = false;
                    }
                }

                // Check if any enemy player enters the ring to arm it
                if (!m.armed) {
                    const triggered = playerList.some(target => {
                        if (target.id === m.ownerId) return false;
                        const distSq = (m.x - target.x) ** 2 + (m.y - target.y) ** 2;
                        return distSq < m.ringRadius ** 2;
                    });
                    if (triggered) {
                        m.armed = true;
                        m.placedTime = now;
                    }
                    return; // don't explode until armed
                }

                const age = now - m.placedTime;
                if (age >= m.explosionDelay) {
                    // Explode
                    playerList.forEach((target) => {
                        const distSq = (m.x - target.x) ** 2 + (m.y - target.y) ** 2;
                        if (distSq < m.ringRadius ** 2) {
                            if (m.damage > 0) {
                                target.health = Math.max(0, target.health - m.damage);
                                target.lastDamageTime = now;
                                if (target.health <= 0) this.handleElimination(target.id, m.ownerId);
                            }
                        }
                    });
                    minesToRemove.push(index);
                }
                return;
            }

            // Normal mine (legacy)
            playerList.forEach((target) => {
                if (target.id !== m.ownerId) {
                    const distSq =
                        (m.x - target.x) ** 2 + (m.y - target.y) ** 2;
                    if (distSq < (PLAYER_SIZE + m.radius) ** 2) {
                        minesToRemove.push(index);
                        target.health = Math.max(0, target.health - m.damage);
                        if (m.damage > 0) target.lastDamageTime = now;

                        if (target.health <= 0)
                            this.handleElimination(target.id, m.ownerId);
                    }
                }
            });
        });

        this.mines = this.mines.filter(
            (_, index) => !minesToRemove.includes(index),
        );
    }

    updateHealingFields() {
        const fieldsToRemove = [];
        const playerList = this._cachedPlayerList || Object.values(this.players);
        const now = Date.now();
        const HEAL_PER_TICK =
            ALL_ABILITIES.heal.totalHeal /
            (ALL_ABILITIES.heal.duration / GAME_TICK);

        this.healingFields.forEach((field, index) => {
            if (now > field.startTime + field.duration) {
                fieldsToRemove.push(index);
                return;
            }

            playerList.forEach((target) => {
                const distSq =
                    (field.x - target.x) ** 2 + (field.y - target.y) ** 2;
                if (distSq < (PLAYER_SIZE + field.radius) ** 2) {
                    target.health = Math.min(
                        MAX_HEALTH,
                        target.health + HEAL_PER_TICK,
                    );
                }
            });
        });

        this.healingFields = this.healingFields.filter(
            (_, index) => !fieldsToRemove.includes(index),
        );
    }

    // ====================================================================
    // 💡 CRITICAL CHANGE FOR DEATH SCREEN: handleElimination
    // ====================================================================
    /**
     * MODIFIED: Sends a specific 'playerEliminated' message to the loser's client.
     */
    handleElimination(eliminatedId, killerId) {
        const eliminatedPlayer = this.players[eliminatedId];
        const killerPlayer = this.players[killerId];
        if (!eliminatedPlayer) return;

        // Determine the killer's name (Use 'The Environment' if killerId is null/undefined, like from a self-mine, or if the killer already left)
        const killerName = killerPlayer ? killerPlayer.name : "The Environment";

        // 1. Send specific message to the eliminated player to show the death screen
        if (eliminatedPlayer.ws && eliminatedPlayer.ws.readyState === ws.OPEN) {
            eliminatedPlayer.ws.send(
                JSON.stringify({
                    type: "playerEliminated",
                    killerUsername: killerName,
                }),
            );
        }

        // 2. Broadcast general elimination message to all remaining players
        this.broadcast({
            type: "elimination",
            message: `${eliminatedPlayer.name} was eliminated by ${killerName}!`,
        });

        // 3. Remove player from the room state
        delete this.players[eliminatedId];
        this.playerCount--;
        this.lastLoserUsername = eliminatedPlayer.ws.username || null;
        this.lastLoserWs = eliminatedPlayer.ws;

        // 4. Check for game over — keep sending state to dead player's ws for 2s spectate
        if (this.playerCount <= 1) {
            const deadWs = eliminatedPlayer.ws;
            const spectateInterval = setInterval(() => {
                if (deadWs && deadWs.readyState === ws.OPEN) {
                    this.broadcastStateTo(deadWs);
                } else {
                    clearInterval(spectateInterval);
                }
            }, GAME_TICK);
            setTimeout(() => {
                clearInterval(spectateInterval);
                this.endGame();
            }, 2000);
        }
    }
    // ====================================================================

    endGame() {
        // MODIFIED: Stop countdown if it's running
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }

        const winner = Object.values(this.players)[0]; // The last remaining player
        const winnerName = winner ? winner.name : "No one";

        // Notify the winner and update ELO for authenticated users
        if (winner) {
            const winnerUsername = winner.ws.username || null;
            const loserUsername = this.lastLoserUsername || null;
            // Update ELO first (async), then send gameOver after a short delay so eloUpdate arrives first
            updateElo(winnerUsername, loserUsername, winner.ws, this.lastLoserWs).then(() => {
                if (winner.ws && winner.ws.readyState === 1)
                    winner.ws.send(JSON.stringify({ type: "gameOver", winnerName: winnerName }));
            });
            // Also send gameOver to loser (they already got playerEliminated, but need gameOver for winnerName)
            if (this.lastLoserWs && this.lastLoserWs.readyState === 1)
                setTimeout(() => {
                    if (this.lastLoserWs.readyState === 1)
                        this.lastLoserWs.send(JSON.stringify({ type: "gameOver", winnerName: winnerName }));
                }, 100);
        }

        // Stop the game loop
        this.gameStatus = "finished";
        clearInterval(this.gameInterval);
        this.gameInterval = null;
        console.log(`Room ${this.id} Game Over. Winner: ${winnerName}`);

        // Remove room from global list (handled outside this class, but good practice to clean up)
    }

    updateGameState() {
        if (this.gameStatus === "lobby") return;
        _activeBarriers = this.barriers;
        const now = Date.now();
        // Cache playerList once per tick — avoid repeated Object.values() allocations
        const playerList = this._cachedPlayerList || (this._cachedPlayerList = []);
        playerList.length = 0;
        for (const id in this.players) playerList.push(this.players[id]);

        // 1. Handle player state updates (movement, status effects)
        for (let i = 0; i < playerList.length; i++) {
            const player = playerList[i];
            this.updatePlayerPosition(player);
            if (now > player.lastDamageTime + REGEN_DELAY) {
                player.health = Math.min(MAX_HEALTH, player.health + REGEN_AMOUNT);
            }
        }

        // 2. Handle projectile/mine/field updates
        this.updateProjectiles();
        this.updateMines();
        this.updateHealingFields();

        // 3. Broadcast new state
        this.broadcastState();
    }

    startGameLoop() {
        // gameStatus is set to 'playing' in checkStartCondition
        this.gameInterval = setInterval(() => {
            this.updateGameState();
        }, GAME_TICK);
    }
}

// --- GLOBAL SERVER STATE AND HANDLERS (OUTSIDE GameRoom) ---

// Create Express app and HTTP server for serving static files
const app = express();
const http = require("http").createServer(app);

// Serve static files (CSS, JS, HTML)
const compression = require("compression");
app.use(compression());
app.use(express.static(path.join(__dirname), { maxAge: "1h" }));

// Serve index.html for root path
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});



/**
 * Updates ELO for winner and loser using standard K=32 formula.
 */
async function updateElo(winnerUsername, loserUsername, winnerWs, loserWs) {
    const K = 32;
    try {
        const [winnerDoc, loserDoc] = await Promise.all([
            winnerUsername ? User.findOne({ username: winnerUsername.toLowerCase() }) : null,
            loserUsername ? User.findOne({ username: loserUsername.toLowerCase() }) : null,
        ]);
        const winnerElo = winnerDoc ? (winnerDoc.elo || 1000) : 1000;
        const loserElo = loserDoc ? (loserDoc.elo || 1000) : 1000;
        const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
        const newWinnerElo = Math.round(winnerElo + K * (1 - expectedWinner));
        const newLoserElo = Math.max(0, Math.round(loserElo + K * (0 - (1 - expectedWinner))));
        const winnerDelta = newWinnerElo - winnerElo;
        const loserDelta = newLoserElo - loserElo;

        if (winnerDoc) {
            await User.findOneAndUpdate(
                { username: winnerUsername.toLowerCase() },
                { $inc: { wins: 1 }, $set: { elo: newWinnerElo } },
            );
        }
        if (loserDoc) {
            await User.findOneAndUpdate(
                { username: loserUsername.toLowerCase() },
                { $set: { elo: newLoserElo } },
            );
        }

        // Notify both players — check readyState at send time
        if (winnerWs && winnerWs.readyState === 1)
            winnerWs.send(JSON.stringify({ type: "eloUpdate", elo: newWinnerElo, delta: winnerDelta }));
        if (loserWs && loserWs.readyState === 1)
            loserWs.send(JSON.stringify({ type: "eloUpdate", elo: newLoserElo, delta: loserDelta }));

        console.log(`ELO: ${winnerUsername||"guest"} ${winnerElo}→${newWinnerElo} (+${winnerDelta}), ${loserUsername||"guest"} ${loserElo}→${newLoserElo} (${loserDelta})`);
    } catch (error) {
        console.error("Error updating ELO:", error);
    }
}

// Create WebSocket server attached to HTTP server
const wss = new ws.Server({ server: http });

// Start HTTP server
http.listen(PORT, "0.0.0.0", () => {
    console.log(`🎮 clashes.pro is running at http://localhost:${PORT}`);
    console.log(`Production server: https://clashes.pro`);
});

const gameRooms = {};
let nextPlayerId = 1;
let nextRoomId = 1;

/**
 * Broadcasts the current online player count to all connected clients.
 */
function broadcastOnlineCount() {
    const onlineCount = wss.clients.size;
    const message = JSON.stringify({ type: "onlineCount", count: onlineCount });
    wss.clients.forEach((client) => {
        if (client.readyState === ws.OPEN) {
            client.send(message);
        }
    });
}

/**
 * Training room — player vs bot. Bot difficulty scales with player ELO.
 */
class TrainingRoom extends GameRoom {
    constructor(id, playerElo) {
        super(id);
        this.isTraining = true;
        this.botId = -1;
        this.playerElo = playerElo || 1000;
        // Difficulty tiers based on ELO
        if (playerElo >= 1200) this.difficulty = "hard";
        else if (playerElo >= 1050) this.difficulty = "medium";
        else this.difficulty = "easy";
    }

    addBot() {
        const bot = {
            id: this.botId,
            name: "BOT",
            x: CANVAS_WIDTH / 2,
            y: 27 * TILE_SIZE,
            dx: 0, dy: 0,
            facingAngle: 0,
            health: MAX_HEALTH,
            color: "#F7C574",
            isProtected: false, isReflecting: false,
            isDashing: false, dashEndTime: 0,
            isStunned: false, stunEndTime: 0,
            isSlowed: false, slowEndTime: 0,
            isImpulsed: false, impulseEndTime: 0,
            lastDamageTime: Date.now(),
            loadout: ["fireBall", "whiteBall", "knockback", "dash", "heal"],
            lastAbilityTime: Array(5).fill(0),
            input: { dx: 0, dy: 0 },
            wins: 0,
            ws: { readyState: -1, send: () => {}, username: null }, // fake ws
            lastActivityTime: Date.now(),
            isBot: true,
        };
        this.players[this.botId] = bot;
        this.playerCount++;
    }

    updateBot() {
        const bot = this.players[this.botId];
        if (!bot) return;
        const realPlayer = Object.values(this.players).find(p => !p.isBot);
        if (!realPlayer) return;

        const now = Date.now();
        const dx = realPlayer.x - bot.x;
        const dy = realPlayer.y - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        bot.facingAngle = angle;

        // Movement — chase player, keep some distance
        const { easy: easyDist, medium: medDist, hard: hardDist } = { easy: 120, medium: 80, hard: 50 };
        const preferredDist = this.difficulty === "hard" ? hardDist : this.difficulty === "medium" ? medDist : easyDist;
        const speed = this.difficulty === "hard" ? 1.8 : this.difficulty === "medium" ? 1.4 : 1.0;

        if (dist > preferredDist + 20) {
            bot.input.dx = (dx / dist) * speed;
            bot.input.dy = (dy / dist) * speed;
        } else if (dist < preferredDist - 20) {
            bot.input.dx = -(dx / dist) * speed;
            bot.input.dy = -(dy / dist) * speed;
        } else {
            // Strafe sideways
            bot.input.dx = -dy / dist * speed * 0.5;
            bot.input.dy = dx / dist * speed * 0.5;
        }

        // Shooting — fire abilities based on difficulty
        const cooldowns = { easy: 2500, medium: 1500, hard: 800 };
        const cd = cooldowns[this.difficulty];
        const abilityKeys = ["fireBall", "whiteBall", "knockback"];
        abilityKeys.forEach((key, i) => {
            if (now - (bot.lastAbilityTime[i] || 0) > cd && dist < 400) {
                const ability = ALL_ABILITIES[key];
                if (!ability) return;
                bot.lastAbilityTime[i] = now;
                if (key === "knockback") {
                    this.projectiles.push({
                        id: nextPlayerId++, ownerId: bot.id,
                        x: bot.x, y: bot.y,
                        dx: Math.cos(angle) * ability.projSpeed,
                        dy: Math.sin(angle) * ability.projSpeed,
                        damage: ability.damage, type: "knockback",
                        isRing: true, ringRadius: ability.ringRadius,
                        stopped: false, stopAfter: ability.stopAfter,
                        createdAt: now, lifetime: 2000,
                    });
                } else {
                    this.projectiles.push({
                        id: nextPlayerId++, ownerId: bot.id,
                        x: bot.x, y: bot.y,
                        dx: Math.cos(angle) * ability.projSpeed,
                        dy: Math.sin(angle) * ability.projSpeed,
                        damage: ability.damage, type: key,
                    });
                }
            }
        });

        // Heal when low (medium/hard only)
        if (this.difficulty !== "easy" && bot.health < 80 && now - (bot.lastAbilityTime[4] || 0) > 5000) {
            bot.lastAbilityTime[4] = now;
            this.healingFields.push({
                ownerId: bot.id, x: bot.x, y: bot.y,
                radius: ALL_ABILITIES.heal.radius,
                startTime: now, duration: ALL_ABILITIES.heal.duration,
                color: bot.color,
            });
        }
    }

    updateGameState() {
        if (this.gameStatus === "lobby") return;
        _activeBarriers = this.barriers;
        const now = Date.now();
        const playerList = Object.values(this.players);

        this.updateBot(); // Set bot input before position update
        playerList.forEach(player => {
            this.updatePlayerPosition(player);
            if (now > player.lastDamageTime + REGEN_DELAY)
                player.health = Math.min(MAX_HEALTH, player.health + REGEN_AMOUNT);
        });

        this.updateProjectiles();
        this.updateMines();
        this.updateHealingFields();
        this.broadcastState();
    }

    // Override handleElimination — if real player dies, restart immediately
    handleElimination(eliminatedId, killerId) {
        if (eliminatedId === this.botId) {
            // Bot died — respawn it
            const bot = this.players[this.botId];
            if (bot) {
                bot.health = MAX_HEALTH;
                bot.x = CANVAS_WIDTH / 2;
                bot.y = 27 * TILE_SIZE;
            }
            return;
        }
        // Real player died — restart training
        const player = this.players[eliminatedId];
        if (player) {
            player.health = MAX_HEALTH;
            player.x = CANVAS_WIDTH / 2;
            player.y = 2 * TILE_SIZE;
            if (player.ws && player.ws.readyState === ws.OPEN)
                player.ws.send(JSON.stringify({ type: "trainingRestart" }));
        }
    }

    broadcastState() {
        const bot = this.players[this.botId];
        const stateMsg = {
            type: "state",
            players: Object.values(this.players).filter(p => !p.isBot).map(p => ({
                id: p.id, name: p.name, x: p.x, y: p.y,
                facingAngle: p.facingAngle, health: p.health, color: p.color,
                isProtected: p.isProtected, isReflecting: p.isReflecting,
                isDashing: p.isDashing, isStunned: p.isStunned,
                isImpulsed: p.isImpulsed, lastAbilityTime: p.lastAbilityTime,
                roomId: this.id, wins: p.wins || 0,
            })).concat(bot ? [{
                id: bot.id, name: bot.name, x: bot.x, y: bot.y,
                facingAngle: bot.facingAngle, health: bot.health, color: bot.color,
                isProtected: false, isReflecting: false, isDashing: false,
                isStunned: false, isImpulsed: false, lastAbilityTime: bot.lastAbilityTime,
                roomId: this.id, wins: 0,
            }] : []),
            projectiles: this.projectiles.map(p => ({ ...p, abilityType: p.type })),
            mines: this.mines,
            healingFields: this.healingFields.map(f => ({ x: f.x, y: f.y, radius: f.radius, color: f.color })),
            status: this.gameStatus,
            mapIndex: this.mapIndex,
        };
        Object.values(this.players).filter(p => !p.isBot).forEach(p => {
            if (p.ws && p.ws.readyState === ws.OPEN)
                p.ws.send(JSON.stringify(stateMsg));
        });
    }
}

const trainingRooms = {};

function startTraining(playerWs, playerName, loadout, playerElo) {
    // Clean up any existing training room for this player
    if (playerWs.trainingRoomId && trainingRooms[playerWs.trainingRoomId]) {
        const old = trainingRooms[playerWs.trainingRoomId];
        delete old.players[playerWs.playerId];
        clearInterval(old.gameInterval);
        delete trainingRooms[playerWs.trainingRoomId];
    }

    const room = new TrainingRoom(nextRoomId++, playerElo);
    trainingRooms[room.id] = room;
    playerWs.trainingRoomId = room.id;

    const player = createPlayer(playerWs.playerId, playerName, loadout, playerWs);
    player.x = CANVAS_WIDTH / 2;
    player.y = 2 * TILE_SIZE;
    player.color = "#F7C574";
    room.players[player.id] = player;
    room.playerCount++;
    room.addBot();
    room.gameStatus = "playing";
    room.startGameLoop();

    playerWs.send(JSON.stringify({ type: "trainingStart" }));
}

function endTraining(playerWs) {
    if (!playerWs.trainingRoomId) return;
    const room = trainingRooms[playerWs.trainingRoomId];
    if (room) {
        clearInterval(room.gameInterval);
        room.gameInterval = null;
        room.gameStatus = "finished";
        delete trainingRooms[playerWs.trainingRoomId];
    }
    playerWs.trainingRoomId = null;

    // Reset player position in their real room
    const realRoom = playerWs.roomId ? gameRooms[playerWs.roomId] : null;
    if (realRoom && realRoom.players[playerWs.playerId]) {
        const player = realRoom.players[playerWs.playerId];
        const spawns = [
            { x: CANVAS_WIDTH / 2, y: 2 * TILE_SIZE },
            { x: CANVAS_WIDTH / 2, y: 27 * TILE_SIZE },
        ];
        const pos = spawns[(Object.keys(realRoom.players).indexOf(String(playerWs.playerId))) % spawns.length];
        player.x = pos.x;
        player.y = pos.y;
        player.health = MAX_HEALTH;
        player.input = { dx: 0, dy: 0 };

        // Send the real room's state immediately so player sees themselves
        realRoom.broadcastStateTo(playerWs);
    } else if (playerWs.readyState === ws.OPEN) {
        // No real room yet — send empty clean state
        playerWs.send(JSON.stringify({
            type: "state",
            players: [],
            projectiles: [],
            mines: [],
            healingFields: [],
            status: "starting",
            mapIndex: 0,
        }));
    }
}


function findOrCreateRoom() {
    // Look for an existing room that needs 1 more player, and is not currently starting
    for (const id in gameRooms) {
        const room = gameRooms[id];
        // MODIFIED: Only join rooms in 'lobby' that are not already starting the countdown
        if (
            room.playerCount < 2 &&
            room.gameStatus === "lobby" &&
            !room.isStarting
        ) {
            return room;
        }
    }

    // If no suitable room found, create a new one
    const newRoom = new GameRoom(nextRoomId++);
    gameRooms[newRoom.id] = newRoom;
    return newRoom;
}

/**
 * Handle user authentication and registration.
 */
async function handleAuthRequest(data, ws) {
    if (data.type === "register") {
        // SECURITY VALIDATION: Username and password length/type
        if (
            typeof data.username !== "string" ||
            data.username.length < 3 ||
            data.username.length > 12 ||
            typeof data.password !== "string" ||
            data.password.length < 6
        ) {
            ws.send(
                JSON.stringify({
                    type: "authFailure",
                    message:
                        "Username must be 3-12 characters. Password must be at least 6 characters.",
                }),
            );
            return;
        }

        const hashedPassword = await bcrypt.hash(data.password, SALT_ROUNDS);
        try {
            const newUser = new User({
                username: data.username,
                password: hashedPassword,
                loadout: data.loadout || [
                    "whiteBall",
                    "fireBall",
                    "knockback",
                    "dash",
                    "heal",
                ], // Use default if none provided
            });
            await newUser.save();
            ws.send(
                JSON.stringify({
                    type: "authSuccess",
                    name: newUser.username,
                    loadout: newUser.loadout,
                    elo: newUser.elo || 1000,
                }),
            );
        } catch (error) {
            console.error("Registration error:", error);
            ws.send(
                JSON.stringify({
                    type: "authFailure",
                    message: "Username already taken or database error.",
                }),
            );
        }
    } else if (data.type === "login") {
        try {
            const user = await User.findOne({
                username: data.username.toLowerCase(),
            });
            if (user && (await bcrypt.compare(data.password, user.password))) {
                ws.send(
                    JSON.stringify({
                        type: "authSuccess",
                        name: user.username,
                        loadout: user.loadout,
                        elo: user.elo || 1000,
                    }),
                );
            } else {
                ws.send(
                    JSON.stringify({
                        type: "authFailure",
                        message: "Invalid username or password.",
                    }),
                );
            }
        } catch (error) {
            console.error("Login error:", error);
            ws.send(
                JSON.stringify({
                    type: "authFailure",
                    message: "An internal server error occurred.",
                }),
            );
        }
    }
}

/**
 * Saves the player's current loadout to the database.
 */
async function savePlayerLoadout(username, loadout) {
    if (!username) return;
    try {
        await User.findOneAndUpdate(
            { username: username.toLowerCase() },
            { loadout: loadout },
        );
        console.log(`Loadout saved for ${username}.`);
    } catch (error) {
        console.error(`Error saving loadout for ${username}:`, error);
    }
}

// AFK check loop
setInterval(() => {
    Object.values(gameRooms).forEach((room) => {
        if (room.gameStatus === "playing") {
            Object.values(room.players).forEach((player) => {
                if (Date.now() - player.lastActivityTime > AFK_TIMEOUT) {
                    console.log(
                        `Kicking player ${player.name} (${player.id}) for AFK.`,
                    );

                    // Send AFK kick message to client
                    if (player.ws && player.ws.readyState === ws.OPEN) {
                        player.ws.send(
                            JSON.stringify({
                                type: "afkKick",
                                message:
                                    "You were kicked for inactivity (AFK).",
                            }),
                        );
                        // Terminate the connection after sending the message
                        player.ws.close();
                    }
                    // The 'close' event handler will handle removal from the room.
                }
            });
        }
    });

    // Clean up empty/finished rooms (optional but recommended)
    for (const id in gameRooms) {
        const room = gameRooms[id];
        // MODIFIED: Also clean up rooms that failed to start
        if (
            room.gameStatus === "finished" ||
            room.playerCount === 0 ||
            (room.gameStatus === "starting" && room.playerCount < 2)
        ) {
            if (room.countdownInterval) clearInterval(room.countdownInterval);
            delete gameRooms[id];
            console.log(`Room ${id} cleaned up.`);
        }
    }
}, 5000);

wss.on("connection", (ws) => {
    const playerId = nextPlayerId++;
    ws.playerId = playerId;
    ws.roomId = null; // Track which room the player is in
    ws.username = null; // Track authenticated username

    console.log(`New player connected. ID: ${playerId}`);
    console.log("before ws send");
    ws.send(JSON.stringify({ type: "init", id: playerId }));

    ws.on("message", (message) => {
        console.log("inside ws");
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Invalid JSON received:", message);
            return;
        }

        let room = ws.roomId ? gameRooms[ws.roomId] : null;

        if (data.type === "login" || data.type === "register") {
            handleAuthRequest(data, ws).then((authSuccess) => {
                if (authSuccess) ws.username = data.username;
            });
            return;
        }

        if (data.type === "saveLoadout") {
            if (ws.username) {
                savePlayerLoadout(ws.username, data.loadout);
            }
            return;
        }

        if (data.type === "getOnlineCount") {
            const onlineCount = wss.clients.size;
            ws.send(JSON.stringify({ type: "onlineCount", count: onlineCount }));
            return;
        }

        if (data.type === "startTraining") {
            const playerName = data.name ? data.name.trim() : "Anonymous";
            startTraining(ws, playerName, data.loadout || [], data.elo || 1000);
            return;
        }

        if (data.type === "stopTraining") {
            endTraining(ws);
            return;
        }

        if (data.type === "joinGame") {
            // MODIFIED: Changed from 'join' to 'joinGame'
            const playerName = data.name ? data.name.trim() : "Anonymous";

            // SECURITY VALIDATION: Player Name
            if (
                typeof playerName !== "string" ||
                playerName.length < 1 ||
                playerName.length > 12
            ) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        message: "Invalid player name length.",
                    }),
                );
                return;
            }

            // Player attempts to join a game
            room = findOrCreateRoom();
            ws.roomId = room.id;

            // Set authenticated username if available
            ws.username = data.isAuth ? data.name : null;

            // Create player object with validated name
            const newPlayer = createPlayer(
                playerId,
                playerName,
                data.loadout,
                ws,
            );

            // Fetch wins for authenticated players
            if (data.isAuth && data.name) {
                User.findOne({ username: data.name.toLowerCase() })
                    .then((user) => {
                        if (user) {
                            newPlayer.wins = user.wins || 0;
                        }
                        room.broadcastState();
                    })
                    .catch((err) => console.error("Error fetching wins:", err));
            }

            room.addPlayer(newPlayer);
            console.log(`Player ${playerName} joined Room ${room.id}.`);

            // If this room now has 2 players, notify any training player to return
            if (room.playerCount === 2) {
                Object.values(room.players).forEach(p => {
                    if (p.ws && p.ws.trainingRoomId && p.ws.readyState === ws.OPEN) {
                        endTraining(p.ws);
                        p.ws.send(JSON.stringify({ type: "matchFound" }));
                    }
                });
            }

            broadcastOnlineCount();
            return;
        }

        // --- In-Game Logic (Requires player to be in a room) ---

        // Route to training room if player is in training (either no real room, or not yet in real room)
        if (ws.trainingRoomId && trainingRooms[ws.trainingRoomId]) {
            const tRoom = trainingRooms[ws.trainingRoomId];
            if (tRoom.players[playerId]) {
                room = tRoom;
            }
        }

        if (!room && ws.roomId) room = gameRooms[ws.roomId];

        if (!room || !room.players[playerId]) return;

        const player = room.players[playerId];
        // Ensure collision uses this room's barriers
        _activeBarriers = room.barriers || MAP_BARRIERS;

        switch (data.type) {
            case "movement": // MODIFIED: Changed from 'input' to 'movement'
                // SECURITY VALIDATION: Movement Input
                const dx = parseFloat(data.dx);
                const dy = parseFloat(data.dy);
                const facingAngle = parseFloat(data.facingAngle);

                // Use a small epsilon for float comparison safety
                if (
                    isNaN(dx) ||
                    isNaN(dy) ||
                    isNaN(facingAngle) ||
                    Math.abs(dx) > 1 + 1e-6 ||
                    Math.abs(dy) > 1 + 1e-6
                ) {
                    player.input.dx = 0;
                    player.input.dy = 0;
                } else {
                    player.input.dx = dx;
                    player.input.dy = dy;
                    player.facingAngle = facingAngle;
                    player.lastActivityTime = Date.now(); // Update activity time
                }
                break;
            /* --- Updated case 'ability' in server.js --- */

            case "ability":
                const slotIndex = parseInt(data.slotIndex);
                const aimAngle = parseFloat(data.aimAngle);

                // 1. Validation
                if (
                    isNaN(slotIndex) ||
                    slotIndex < 0 ||
                    slotIndex >= player.loadout.length
                )
                    return;
                if (isNaN(aimAngle)) return;

                // 2. Cooldown Check
                const abilityKey = player.loadout[slotIndex];
                const ability = ALL_ABILITIES[abilityKey];
                const cooldown = ability?.cooldown || ABILITY_COOLDOWN;
                if (
                    Date.now() <
                    player.lastAbilityTime[slotIndex] + cooldown
                )
                    return;

                if (!ability) return;

                // 3. Set Cooldown
                player.lastAbilityTime[slotIndex] = Date.now();

                // --- PROJECTILE ABILITIES (White Ball, Fire Ball, Snowball) ---
                if (
                    abilityKey === "whiteBall" ||
                    abilityKey === "fireBall" ||
                    abilityKey === "snowball"
                ) {
                    const angle = aimAngle;
                    const speed = ability.projSpeed;

                    // Determination of specific colors
                    let projColor = player.color; // Default fallback

                    if (abilityKey === "whiteBall") {
                        projColor = "#ffffff"; // Force White
                    } else if (abilityKey === "fireBall") {
                        projColor = "#ff4500"; // Fire Orange/Red
                    } else if (abilityKey === "snowball") {
                        projColor = "#add8e6"; // Ice Blue
                    }

                    // Configure spread based on ability type
                    let spreadAngles = [];
                    const fireColors = ["#FFD700", "#FFA500", "#ff4500", "#FF6347", "#FF8C00"];
                    
                    if (abilityKey === "whiteBall") {
                        // 5 projectiles spread wide
                        spreadAngles = [
                            { angle: angle - 0.56, colorIdx: 0 },
                            { angle: angle - 0.28, colorIdx: 0 },
                            { angle: angle, colorIdx: 0 },
                            { angle: angle + 0.28, colorIdx: 0 },
                            { angle: angle + 0.56, colorIdx: 0 }
                        ];
                    } else if (abilityKey === "fireBall") {
                        // 1 fireball straight ahead with fiery color
                        spreadAngles = [
                            { angle: angle, colorIdx: 0 }
                        ];
                    } else {
                        // Snowball: single projectile
                        spreadAngles = [{ angle: angle, colorIdx: 0 }];
                    }

                    spreadAngles.forEach((angleData) => {
                        const shootAngle = angleData.angle;
                        const speedVariation = abilityKey === "fireBall" 
                            ? speed * (0.7 + Math.random() * 0.6) // Vary speed for organic feel
                            : speed;
                        
                        const fireColor = abilityKey === "fireBall" 
                            ? "#FF4500" 
                            : projColor;

                        room.projectiles.push({
                            ownerId: playerId,
                            type: abilityKey,
                            x: player.x + Math.cos(shootAngle) * (PLAYER_SIZE + PROJECTILE_RADIUS + 1),
                            y: player.y + Math.sin(shootAngle) * (PLAYER_SIZE + PROJECTILE_RADIUS + 1),
                            dx: Math.cos(shootAngle) * speedVariation,
                            dy: Math.sin(shootAngle) * speedVariation,
                            damage: ability.damage,
                            color: fireColor,
                            isStun: abilityKey === "snowball",
                            isTracking: false,
                            lifetime: 3000,
                            isFirey: abilityKey === "fireBall",
                        });
                    });
                }
                // --- RING PROJECTILES (Knockback, Impulse) ---
                else if (abilityKey === "knockback" || abilityKey === "impulse") {
                    room.projectiles.push({
                        x: player.x,
                        y: player.y,
                        dx: Math.cos(aimAngle) * ability.projSpeed,
                        dy: Math.sin(aimAngle) * ability.projSpeed,
                        ownerId: playerId,
                        type: abilityKey,
                        isRing: true,
                        ringRadius: ability.ringRadius,
                        force: ability.force,
                        stopAfter: ability.stopAfter,
                        lifetime: abilityKey === "impulse" ? 6000 : 3500,
                        createdAt: Date.now(),
                        stopped: false,
                    });
                }
                // --- RING MINE (Landmine) ---
                else if (abilityKey === "landmine") {
                    room.mines.push({
                        ownerId: playerId,
                        x: player.x,
                        y: player.y,
                        dx: Math.cos(aimAngle) * 3,
                        dy: Math.sin(aimAngle) * 3,
                        isRing: true,
                        isMoving: true,
                        armed: false,
                        damage: ability.damage,
                        ringRadius: ability.ringRadius,
                        force: ability.force,
                        placedTime: null, // timer starts when player enters
                        explosionDelay: ability.explosionDelay,
                    });
                } else if (abilityKey === "dash") {
                    const dashAngle = player.facingAngle;
                    const dashDistance = ability.dashDistance;
                    const dashStep = 5;
                    const steps = Math.floor(dashDistance / dashStep);

                    for (let i = 1; i <= steps; i++) {
                        let tempX =
                            player.x + Math.cos(dashAngle) * dashStep * i;
                        let tempY =
                            player.y + Math.sin(dashAngle) * dashStep * i;
                        if (checkCollision(tempX, tempY, PLAYER_SIZE)) break;
                        player.x = tempX;
                        player.y = tempY;
                    }
                    player.x = Math.max(
                        PLAYER_SIZE,
                        Math.min(CANVAS_WIDTH - PLAYER_SIZE, player.x),
                    );
                    player.y = Math.max(
                        PLAYER_SIZE,
                        Math.min(CANVAS_HEIGHT - PLAYER_SIZE, player.y),
                    );
                    player.isDashing = true;
                    player.dashEndTime = Date.now() + 200;
                } else if (abilityKey === "heal") {
                    room.healingFields.push({
                        ownerId: playerId,
                        x: player.x,
                        y: player.y,
                        radius: ability.radius,
                        startTime: Date.now(),
                        duration: ability.duration,
                        color: player.color,
                    });
                } else if (abilityKey === "reflection") {
                    player.isProtected = true;
                    player.isReflecting = true;
                    player.protectionEndTime = Date.now() + ability.duration;
                } else if (abilityKey === "target") {
                    // Target: Red homing projectile
                    room.projectiles.push({
                        ownerId: playerId,
                        type: abilityKey,
                        x: player.x + Math.cos(aimAngle) * (PLAYER_SIZE + PROJECTILE_RADIUS + 1),
                        y: player.y + Math.sin(aimAngle) * (PLAYER_SIZE + PROJECTILE_RADIUS + 1),
                        dx: Math.cos(aimAngle) * ability.projSpeed,
                        dy: Math.sin(aimAngle) * ability.projSpeed,
                        damage: ability.damage,
                        color: "#ff0000",
                        isTracking: true,
                        lifetime: 10000,
                    });
                }

                player.lastActivityTime = Date.now();
                break;
            case "ping":
                // Simply update last activity time
                if (room.players[playerId]) {
                    room.players[playerId].lastActivityTime = Date.now(); // NEW: Update activity time
                }
                break;
            case "leaveGame":
                if (ws.username && room && room.players[playerId]) {
                    // Save loadout before leaving
                    savePlayerLoadout(
                        ws.username,
                        room.players[playerId].loadout,
                    );
                }
                // If leaving a room, remove them from the room
                if (room) {
                    room.removePlayer(playerId);
                    ws.roomId = null;
                }
                // Intentionally don't close the socket here; let the client do it cleanly if they initiated the leave.
                break;
        }
    });

    ws.on("close", () => {
        console.log(`Player ${playerId} disconnected.`);
        // Check if the player was in a room
        if (ws.roomId) {
            const room = gameRooms[ws.roomId];
            if (room) {
                room.removePlayer(playerId);
            }
        }
        broadcastOnlineCount();
    });

    ws.on("error", (error) => {
        console.error("ws Error:", error.message);
    });
});

//console.log(`Clash.io Arena Server running on ws://localhost:${PORT}`);
console.log(`User data persistence is now handled by MongoDB via Mongoose.`);
mongoose.connection.once("open", () => {
    console.log("Database connection is officially open.");
});
