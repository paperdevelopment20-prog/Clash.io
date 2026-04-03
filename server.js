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
    },
    { timestamps: true },
);

const User = mongoose.model("User", userSchema);
// END OF DATABASE SETUP

// Connect to mongoDB
connectDB();

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
const MAX_HEALTH = 100;
const PROJECTILE_RADIUS = 5;
const ABILITY_COOLDOWN = 800;
const GAME_TICK = 1000 / 60;

const AFK_TIMEOUT = 60000; // NEW: 60 seconds of inactivity before kick

const HEALING_DURATION = 5000;
const HEALING_RADIUS = 60;
const REGEN_DELAY = 10000;
const REGEN_AMOUNT = 1 / 60;

// Fixed map barriers
const MAP_BARRIERS = [
    [0, 0, 45, 1],
    [0, 29, 45, 1],
    [0, 0, 1, 30],
    [44, 0, 1, 30],
    [17, 11, 11, 8],
    [19, 5, 7, 4],
    [19, 21, 7, 4],
];
const ALL_ABILITIES = {
    whiteBall: { name: "White Ball", damage: 10, projSpeed: 5, duration: 0 },
    fireBall: { name: "Fire Ball", damage: 25, projSpeed: 3, duration: 0 },
    knockback: { name: "Knockback", damage: 0, force: 200, projSpeed: 3, ringRadius: 36, stopAfter: 650, duration: 0 },
    impulse:   { name: "Impulse",   damage: 0, force: 200, projSpeed: 3, ringRadius: 36, stopAfter: 650, duration: 0 },
    snowball: { name: "Snowball", damage: 0, projSpeed: 4, stunDuration: 1500 },
    landmine: { name: "Landmine", damage: 30, force: 0, ringRadius: 36, explosionDelay: 3000, projSpeed: 0, duration: 0 },
    dash: {
        name: "Dash",
        damage: 0,
        projSpeed: 0,
        duration: 200,
        dashDistance: 10,
    },
    heal: {
        name: "Heal Zone",
        totalHeal: 15,
        duration: HEALING_DURATION,
        radius: HEALING_RADIUS,
        projSpeed: 0,
    },
    reflection: { name: "Reflection", damage: 0, projSpeed: 0, duration: 1000 },
    target: { name: "Target", damage: 50, projSpeed: 1, duration: 0 },
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
function checkCollision(x, y, size) {
    // 1. Check canvas boundaries
    // Keep this check to prevent players from leaving the map
    if (
        x - size < 0 ||
        x + size > CANVAS_WIDTH ||
        y - size < 0 ||
        y + size > CANVAS_HEIGHT
    )
        return true;

    // 2. Check map barriers
    for (const b of MAP_BARRIERS) {
        const bRect = {
            x: b[0] * TILE_SIZE,
            y: b[1] * TILE_SIZE,
            w: b[2] * TILE_SIZE,
            h: b[3] * TILE_SIZE,
        };

        // Check if player circle overlaps with barrier rectangle
        const closestX = Math.max(bRect.x, Math.min(x, bRect.x + bRect.w));
        const closestY = Math.max(bRect.y, Math.min(y, bRect.y + bRect.h));
        const distX = x - closestX;
        const distY = y - closestY;

        // If the distance is less than the circle's size (radius), a collision occurred
        if (distX * distX + distY * distY < size * size) return true;
    }
    return false;
}

// --- ROOM-SPECIFIC GAME LOGIC (GameRoom Class) ---

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = {}; // Player objects within this room
        this.projectiles = [];
        this.mines = [];
        this.healingFields = [];
        this.gameStatus = "lobby";
        this.gameInterval = null;
        this.playerCount = 0;

        // NEW: Countdown properties
        this.countdown = 0;
        this.countdownInterval = null;
        this.isStarting = false;

        console.log(`Room ${this.id} created.`);
    }

    addPlayer(player) {
        this.players[player.id] = player;
        this.playerCount++;

        // Map center X = tile 22.5 = 450px
        // Top bracket: tiles y 3-6 → spawn above at y=2 (40px)
        // Bottom bracket: tiles y 23-26 → spawn below at y=27 (540px)
        const centerX = CANVAS_WIDTH / 2;
        const spawns = [
            { x: centerX, y: 2 * TILE_SIZE }, // Above top bracket
            { x: centerX, y: 27 * TILE_SIZE }, // Below bottom bracket
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
                    this.gameStatus = "playing"; // Set room status to playing
                    this.startGameLoop(); // Start the game update loop
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
        };
        this.broadcast(stateMessage);
    }

    // --- GAME LOGIC METHODS (OPERATING ON THIS.STATE) ---

    updatePlayerPosition(player) {
        const now = Date.now();
        if (player.isStunned && now >= player.stunEndTime)
            player.isStunned = false;
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
        const speed = PLAYER_SPEED;

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
        const playerList = Object.values(this.players);
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
                let knockbackHit = false;
                playerList.forEach((target) => {
                    if (target.id === p.ownerId) return;
                    if (knockbackHit) return;
                    const distSq = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
                    if (distSq < p.ringRadius ** 2) {
                        const angle = Math.atan2(target.y - p.y, target.x - p.x);
                        if (p.type === "impulse") {
                            // Stop ring here so it pins to this location and keeps pulling
                            p.dx = 0;
                            p.dy = 0;
                            p.stopped = true;
                            // Continuous gravity pull toward center every tick — ring stays alive
                            const pullStrength = 14;
                            target.x += Math.cos(angle) * -pullStrength;
                            target.y += Math.sin(angle) * -pullStrength;
                            target.x = Math.max(PLAYER_SIZE, Math.min(CANVAS_WIDTH - PLAYER_SIZE, target.x));
                            target.y = Math.max(PLAYER_SIZE, Math.min(CANVAS_HEIGHT - PLAYER_SIZE, target.y));
                        } else {
                            // Knockback: one-shot push OUT, ring consumed
                            target.x += Math.cos(angle) * p.force;
                            target.y += Math.sin(angle) * p.force;
                            target.x = Math.max(PLAYER_SIZE, Math.min(CANVAS_WIDTH - PLAYER_SIZE, target.x));
                            target.y = Math.max(PLAYER_SIZE, Math.min(CANVAS_HEIGHT - PLAYER_SIZE, target.y));
                            target.lastDamageTime = now;
                            knockbackHit = true;
                        }
                    }
                });
                if (knockbackHit) projectilesToRemove.push(index);
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

                        // Apply stun effect if this is a snowball
                        if (p.isStun) {
                            target.isStunned = true;
                            target.stunEndTime =
                                now + ALL_ABILITIES.snowball.stunDuration;
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
        const playerList = Object.values(this.players);
        const now = Date.now();

        this.mines.forEach((m, index) => {
            // --- RING MINES (landmine redesign) ---
            if (m.isRing) {
                const age = now - m.placedTime;
                if (age >= m.explosionDelay) {
                    // Explode: deal damage to all players within explosion radius
                    playerList.forEach((target) => {
                        const distSq = (m.x - target.x) ** 2 + (m.y - target.y) ** 2;
                        if (distSq < m.ringRadius ** 2) { // ringRadius is already in pixels
                            if (m.damage > 0) {
                                target.health = Math.max(0, target.health - m.damage);
                                target.lastDamageTime = now;
                                if (target.health <= 0) this.handleElimination(target.id, m.ownerId);
                            }
                        }
                    });
                    minesToRemove.push(index);
                }
                return; // no contact trigger for ring mines
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
        const playerList = Object.values(this.players);
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

        // 4. Check for game over
        if (this.playerCount <= 1) {
            this.endGame();
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

        // Notify the winner and increment their win count if authenticated
        if (winner) {
            // Increment wins for authenticated users
            if (winner.ws.username) {
                incrementPlayerWins(winner.ws.username);
            }

            winner.ws.send(
                JSON.stringify({
                    type: "gameOver",
                    winnerName: winnerName,
                }),
            );
        }

        // Stop the game loop
        this.gameStatus = "finished";
        clearInterval(this.gameInterval);
        this.gameInterval = null;
        console.log(`Room ${this.id} Game Over. Winner: ${winnerName}`);

        // Remove room from global list (handled outside this class, but good practice to clean up)
    }

    updateGameState() {
        if (this.gameStatus !== "playing") return;

        const now = Date.now();
        const playerList = Object.values(this.players);

        // 1. Handle player state updates (movement, status effects)
        playerList.forEach((player) => {
            this.updatePlayerPosition(player);

            // Health regeneration (if no damage taken recently)
            if (now > player.lastDamageTime + REGEN_DELAY) {
                player.health = Math.min(
                    MAX_HEALTH,
                    player.health + REGEN_AMOUNT,
                );
            }
        });

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
app.use(express.static(path.join(__dirname)));

// Serve index.html for root path
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Leaderboard API endpoint
app.get("/api/leaderboard", async (req, res) => {
    try {
        const topPlayers = await User.find({ wins: { $gt: 0 } })
            .sort({ wins: -1 })
            .limit(10)
            .select("username wins -_id");
        res.json(topPlayers);
    } catch (error) {
        console.error("Leaderboard fetch error:", error);
        res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
});

/**
 * Increments the win count for a player.
 */
async function incrementPlayerWins(username) {
    if (!username) return;
    try {
        await User.findOneAndUpdate(
            { username: username.toLowerCase() },
            { $inc: { wins: 1 } },
        );
        console.log(`Win recorded for ${username}.`);
    } catch (error) {
        console.error(`Error recording win for ${username}:`, error);
    }
}

// Create WebSocket server attached to HTTP server
const wss = new ws.Server({ server: http });

// Start HTTP server
http.listen(PORT, "0.0.0.0", () => {
    console.log(`🎮 Clash.io is running at http://localhost:${PORT}`);
    console.log(`Share this link with friends: http://localhost:${PORT}`);
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
 * Finds or creates a suitable 1v1 room.
 */
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
            broadcastOnlineCount();
            return;
        }

        // --- In-Game Logic (Requires player to be in a room) ---

        if (!room || !room.players[playerId]) return;

        const player = room.players[playerId];

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
                if (
                    Date.now() <
                    player.lastAbilityTime[slotIndex] + ABILITY_COOLDOWN
                )
                    return;

                const abilityKey = player.loadout[slotIndex];
                const ability = ALL_ABILITIES[abilityKey];

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
                        isRing: true,
                        damage: ability.damage,
                        ringRadius: ability.ringRadius,
                        force: ability.force,
                        placedTime: Date.now(),
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
                    player.dashEndTime = Date.now() + ability.duration;
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
                player.lastActivityTime = Date.now(); // Ability use counts as activity
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
