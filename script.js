// ============================================
// THE WAITING GUN - Main Game Script (FIXED)
// ============================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// FIX #9: resizeCanvas must run AFTER DOM layout (called in window 'load')
function resizeCanvas() {
    const statsBar     = document.getElementById('statsBar');
    const controlPanel = document.getElementById('controlPanel');
    const upgradeSection = document.getElementById('upgradeSection');
    canvas.width = window.innerWidth;
    canvas.height = Math.max(
        150,
        window.innerHeight - statsBar.offsetHeight
                           - controlPanel.offsetHeight
                           - upgradeSection.offsetHeight
    );
}

// ============================================
// SCALE FACTOR
// Computed ONCE per frame (top of gameLoop) and cached here.
// This prevents ~25 redundant calls per frame and ensures
// every draw call uses the same scale within a single frame.
// Baseline: 360px wide = scale 1.0 (standard portrait phone).
// Tablets (~820px) → ~2.3. Desktop (~1440px) → ~4.0, capped at 3.
// ============================================
let _scale = 1;
function getScale()     { return _scale; }
function updateScale()  {
    _scale = Math.max(0.7, Math.min(canvas.width / 360, 3.0));
}

// ============================================
// CONSTANTS
// ============================================

const WALL_X           = 80;
const MAX_FIRE_RATE    = 10;
const HOMING_RADIUS    = 400;
const EXPLOSION_RADIUS = 60;

// FIX #1: UNIT_SPACING was a constant evaluated at parse-time (canvas.height = 0).
//         Now it's a function so it always reads the live canvas height.
function getUnitSpacing() {
    return canvas.height / 10;
}

// ============================================
// GAME STATE
// ============================================

const gameState = {
    money: 0,
    bullets: 0,
    bulletsPerSecond: 1.0,

    wallHP: 100,
    wallMaxHP: 100,

    xValue: 3,
    maxX: 3,

    kills: 0,
    highScore: 0,
    gameTime: 0,
    running: true,

    // FIX #11: track total money earned separately for accurate score
    totalMoneyEarned: 0,

    upgrades: {
        damageMultiplier: 0,
        fireLimitBreak:   0,
        moreAmmo:         0,
        captainAutofire:  0,
        explosiveRounds:  0,
        critRate:         0,
        critDamage:       0,
        bulletFusion:     0,
        wallThickening:   0,
        kineticRepulsion: 0,
        improvedMaterial: 0,
        armorPlating:     0,
        barbedWires:      0,
        fieldPatch:       0,
        emergencyRepairs: 0
    },

    units: [
        { unlocked: true, level: 1, damage: 5, autoAim: true, autofire: false, fireRate: 2, lastFired: 0 }
    ],

    autofireEnabled: false,
    lastAutofire: 0,

    spawnInterval: 3000,
    lastSpawn: 0,
    lastEventCheck: 0,  // will be set to Date.now() on first frame

    fusionBullets: 0,
    difficultySpeedMult: 1.0
};

// ============================================
// ENEMY / BOSS TYPE DEFINITIONS
// ============================================

const ENEMY_TYPES = {
    NORMAL: { hp: 10, damage: 5,  speed: 1.0, color: '#306230', shape: 'circle',   size: 12 },
    FAST:   { hp: 8,  damage: 3,  speed: 2.5, color: '#0f380f', shape: 'triangle', size: 14 },
    TANK:   { hp: 20, damage: 10, speed: 0.5, color: '#0f380f', shape: 'square',   size: 18 },
    HYDRA:  { hp: 15, damage: 5,  speed: 1.2, color: '#306230', shape: 'hydra',    size: 16 },
    HEALER: { hp: 20, damage: 0,  speed: 0.3, color: '#8bac0f', shape: 'healer',   size: 14 },
    SHIELD: { hp: 25, damage: 10, speed: 0.8, color: '#0f380f', shape: 'shield',   size: 16 }
};

const BOSS_TYPES = {
    GOLIATH:     { type: 'NORMAL',  name: 'GOLIATH',       multiplier: 20, ability: 'slam'       },
    SONIC:       { type: 'FAST',    name: 'SONIC VORTEX',  multiplier: 20, ability: 'dodge'      },
    IRON:        { type: 'TANK',    name: 'IRON MOUNTAIN', multiplier: 20, ability: 'armor'      },
    OVERMIND:    { type: 'HEALER',  name: 'THE OVERMIND',  multiplier: 20, ability: 'link'       },
    HYDRA_PRIME: { type: 'HYDRA',   name: 'HYDRA PRIME',   multiplier: 20, ability: 'multisplit' },
    AEGIS:       { type: 'SHIELD',  name: 'AEGIS TITAN',   multiplier: 20, ability: 'regen'      }
};

// ============================================
// BULLET CLASS
// ============================================

class Bullet {
    constructor() {
        this.active = false;
        this.x = 0; this.y = 0;
        this.vx = 0; this.vy = 0;
        this.damage = 0;
        this.isFusion = false;
        this.trail = [];
        this.homing = false;
        this.target = null;
    }

    reset(x, y, angle, damage, homing = false, isFusion = false) {
        this.active   = true;
        this.x        = x;
        this.y        = y;
        // Target crossing time: ~0.6 seconds to cross the full canvas width.
        // This gives identical FEEL on every device — phone, tablet, or desktop.
        const speed   = canvas.width / 0.6;
        this.vx       = Math.cos(angle) * speed;
        this.vy       = Math.sin(angle) * speed;
        this.damage   = damage;
        this.isFusion = isFusion;
        this.trail    = [];
        this.homing   = homing;
        this.target   = null;
    }

    update(deltaTime) {
        if (!this.active) return;

        // Chlorophyte homing logic
        if (this.homing) {
            if (!this.target || !this.target.active) {
                this.target = this.findBestTarget();
            }
            if (this.target) {
                const dx   = this.target.x - this.x;
                const dy   = this.target.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const hr   = HOMING_RADIUS * getScale();
                if (dist < hr && dist > 0) {
                    const targetAngle  = Math.atan2(dy, dx);
                    const currentAngle = Math.atan2(this.vy, this.vx);
                    let angleDiff = targetAngle - currentAngle;
                    while (angleDiff >  Math.PI) angleDiff -= Math.PI * 2;
                    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                    const t = 1 - Math.min(dist, hr) / hr;
                    const turnStrength = 0.12 + t * t * 0.45;
                    const newAngle = currentAngle + angleDiff * turnStrength;
                    const speed    = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
                    this.vx = Math.cos(newAngle) * speed;
                    this.vy = Math.sin(newAngle) * speed;
                }
            }
        }

        // Trail
        this.trail.push({ x: this.x, y: this.y });
        if (this.trail.length > 8) this.trail.shift();

        // Move using deltaTime so speed is identical at 60fps, 120fps, etc.
        this.x += this.vx * deltaTime;
        this.y += this.vy * deltaTime;

        if (this.x > canvas.width + 50 || this.x < -50 ||
            this.y < -50 || this.y > canvas.height + 50) {
            this.active = false;
        }
    }

    findBestTarget() {
        let bestTarget = null;
        let bestScore  = -Infinity;
        const hr = HOMING_RADIUS * getScale();

        for (const enemy of enemyPool) {
            if (!enemy.active) continue;
            const dx   = enemy.x - this.x;
            const dy   = enemy.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > hr) continue;

            // Threat score: prioritise enemies close to the wall AND high HP.
            // wallProximity: 1.0 = at the wall, 0.0 = at far edge of screen
            const wallProximity = 1 - Math.max(0, (enemy.x - WALL_X) / canvas.width);
            // hpWeight: normalised HP so tanky enemies are valued higher
            const hpWeight = enemy.hp / (enemy.maxHP || 1);
            // Boss bonus: bosses are always priority targets
            const bossMult = enemy.isBoss ? 2.0 : 1.0;

            const score = (wallProximity * 0.65 + hpWeight * 0.35) * bossMult;

            if (score > bestScore) {
                bestScore  = score;
                bestTarget = enemy;
            }
        }
        return bestTarget;
    }

    draw() {
        if (!this.active) return;

        // Trail — chunky pixel trail
        if (this.trail.length > 1) {
            ctx.strokeStyle = this.isFusion ? '#306230' : '#0f380f';
            ctx.lineWidth   = (this.isFusion ? 4 : 2) * getScale();
            ctx.beginPath();
            ctx.moveTo(this.trail[0].x, this.trail[0].y);
            for (let i = 1; i < this.trail.length; i++) {
                ctx.lineTo(this.trail[i].x, this.trail[i].y);
            }
            ctx.stroke();
        }

        // Bullet — pixel square scaled to screen
        const sc = getScale();
        const bs = (this.isFusion ? 5 : 3) * sc;
        ctx.fillStyle = this.isFusion ? '#8bac0f' : '#0f380f';
        ctx.fillRect(this.x - bs, this.y - bs, bs * 2, bs * 2);

        // Fusion outer glow square
        if (this.isFusion) {
            ctx.strokeStyle = '#306230';
            ctx.lineWidth   = 2 * sc;
            ctx.strokeRect(this.x - 8*sc, this.y - 8*sc, 16*sc, 16*sc);
        }
    }
}

// ============================================
// ENEMY CLASS
// ============================================

class Enemy {
    constructor() {
        this.active      = false;
        this.type        = 'NORMAL';
        this.x = 0; this.y = 0;
        this.hp = 0; this.maxHP = 0;
        this.damage = 0; this.speed = 0;
        this.isBoss      = false;
        this.bossData    = null;
        this.shieldHP    = 0;
        this.maxShieldHP = 0;
        this.dodgeTimer  = 0;
        this.abilityTimer = 0;
        this.healTimer   = 0;
        this.linkedEnemy = null;
        this.hitWall     = false;
        // FIX #8: armor threshold flags so they trigger once regardless of frame size
        this._armor75 = false;
        this._armor50 = false;
        this._armor25 = false;
    }

    reset(type, isBoss = false, bossType = null) {
        this.active   = true;
        this.type     = type;
        this.isBoss   = isBoss;
        this.bossData = bossType;

        const baseStats     = ENEMY_TYPES[type];
        const timeMultiplier = 1 + (gameState.gameTime / 120);
        const multiplier    = isBoss ? (bossType ? bossType.multiplier : 20) : 1;

        this.maxHP  = baseStats.hp     * multiplier * timeMultiplier;
        this.hp     = this.maxHP;
        this.damage = baseStats.damage * multiplier * timeMultiplier;
        this.speed  = baseStats.speed * (isBoss ? 0.7 : 1) * (gameState.difficultySpeedMult || 1);

        this.x = canvas.width + 150;  // further off-screen = more travel time before wall
        this.y = Math.random() * (canvas.height - 40) + 20;

        this.shieldHP    = 0;
        this.maxShieldHP = 0;
        if (type === 'SHIELD') {
            this.maxShieldHP = 15 * multiplier * timeMultiplier;
            this.shieldHP    = this.maxShieldHP;
        }

        this.dodgeTimer   = 0;
        this.abilityTimer = 0;
        this.healTimer    = 0;
        this.linkedEnemy  = null;
        this.hitWall      = false;
        // FIX #8: reset armor flags
        this._armor75 = false;
        this._armor50 = false;
        this._armor25 = false;
    }

    update(deltaTime) {
        if (!this.active) return;

        // Boss abilities
        if (this.isBoss && this.bossData) {
            this.abilityTimer += deltaTime;

            switch (this.bossData.ability) {

                case 'slam':
                    // GOLIATH – speed boost every 5 s, hard-capped to prevent runaway stacking
                    if (this.abilityTimer >= 5) {
                        this.abilityTimer = 0;
                        for (const e of enemyPool) {
                            if (e.active && !e.isBoss) {
                                const baseSpeed = ENEMY_TYPES[e.type].speed * gameState.difficultySpeedMult;
                                e.speed = Math.min(e.speed * 1.3, baseSpeed * 3.0);
                            }
                        }
                    }
                    break;

                case 'dodge':
                    // SONIC VORTEX – dodgeTimer drives the invulnerability window
                    this.dodgeTimer += deltaTime;
                    break;

                case 'armor': {
                    // FIX #8: use boolean flags instead of brittle range check
                    const pct = this.hp / this.maxHP;
                    if (!this._armor75 && pct <= 0.75) { this._armor75 = true; this.spawnShieldEnemy(); }
                    if (!this._armor50 && pct <= 0.50) { this._armor50 = true; this.spawnShieldEnemy(); }
                    if (!this._armor25 && pct <= 0.25) { this._armor25 = true; this.spawnShieldEnemy(); }
                    break;
                }

                case 'link':
                    // THE OVERMIND – keep a live link to closest enemy to wall
                    if (!this.linkedEnemy || !this.linkedEnemy.active) {
                        this.linkedEnemy = this.findClosestEnemyToWall();
                    }
                    break;

                case 'regen':
                    // AEGIS – regen shield if not hit for 3 s (abilityTimer reset on hit in takeDamage)
                    if (this.shieldHP < this.maxShieldHP && this.abilityTimer >= 3) {
                        this.shieldHP = this.maxShieldHP;
                    }
                    break;
            }
        }

        // Healer pulse
        if (this.type === 'HEALER') {
            this.healTimer += deltaTime;
            if (this.healTimer >= 2) {
                this.healTimer = 0;
                this.healNearbyEnemies();
            }
        }

        // Movement — speed is px/second, multiply by deltaTime
        // Base speeds defined in ENEMY_TYPES are in "units", multiply by
        // canvas width / 480 so enemies cross the screen in the same time
        // regardless of device.
        const pixelSpeed = this.speed * (canvas.width / 480) * 120;
        if (this.type !== 'HEALER' || this.x > canvas.width - 150 * getScale()) {
            this.x -= pixelSpeed * deltaTime;
        }

        // Wall collision
        if (this.x <= WALL_X + 20 * getScale() && !this.hitWall) {
            this.hitWall = true;
            this.hitTheWall();
        }
    }

    spawnShieldEnemy() {
        const e = getEnemy();
        e.reset('SHIELD');
        e.x = this.x;
        e.y = this.y + (Math.random() - 0.5) * 60;
    }

    findClosestEnemyToWall() {
        let closest = null;
        let minDist = Infinity;
        for (const e of enemyPool) {
            if (e.active && e !== this && !e.isBoss) {
                const d = e.x - WALL_X;
                if (d < minDist) { minDist = d; closest = e; }
            }
        }
        return closest;
    }

    healNearbyEnemies() {
        for (const e of enemyPool) {
            if (!e.active || e === this) continue;
            const dx = e.x - this.x;
            const dy = e.y - this.y;
            if (Math.sqrt(dx * dx + dy * dy) < 200) {
                e.hp = Math.min(e.maxHP, e.hp + e.maxHP * 0.1);
            }
        }
    }

    hitTheWall() {
        // Barbed wires
        if (gameState.upgrades.barbedWires > 0) {
            this.takeDamage(this.maxHP * 0.05);
            if (!this.active) return; // barbed wire killed it
        }

        // Knockback
        if (gameState.upgrades.kineticRepulsion > 0) {
            if (Math.random() * 100 < gameState.upgrades.kineticRepulsion * 5) {
                this.x += 100 * getScale();
                this.hitWall = false;
                return;
            }
        }

        // Damage wall
        const armorReduction = gameState.upgrades.armorPlating * 0.01;
        const finalDamage    = this.damage * (1 - armorReduction);
        // FIX #13: clamp to 0, not negative
        gameState.wallHP = Math.max(0, gameState.wallHP - finalDamage);

        if (gameState.wallHP <= 0) {
            gameOver();
            return;
        }

        this.active = false;
    }

    takeDamage(amount, isExplosion = false) {
        // SONIC VORTEX dodge window
        if (this.isBoss && this.bossData && this.bossData.ability === 'dodge') {
            if ((this.dodgeTimer % 4) >= 3) return;
        }

        // Shield absorbs first
        if (this.shieldHP > 0) {
            this.shieldHP -= amount;
            if (this.shieldHP < 0) {
                // overflow bleeds into HP
                this.hp     += this.shieldHP;
                this.shieldHP = 0;
            }
            // AEGIS regen timer reset on hit
            if (this.isBoss && this.bossData && this.bossData.ability === 'regen') {
                this.abilityTimer = 0;
            }
            if (this.hp <= 0) this.die();
            return;
        }

        // OVERMIND link protection (explosions bypass it)
        if (!isExplosion) {
            for (const e of enemyPool) {
                if (e.active && e.type === 'HEALER' && e.isBoss && e.linkedEnemy === this) {
                    return;
                }
            }
        }

        this.hp -= amount;
        if (this.hp <= 0) this.die();
    }

    die() {
        this.active = false;
        gameState.kills++;

        // Base reward per enemy type (reflects threat/annoyance level)
        const BASE_REWARDS = {
            NORMAL: 5, FAST: 4, TANK: 15, HYDRA: 10, HEALER: 12, SHIELD: 12
        };
        const base = BASE_REWARDS[this.type] || 5;

        // Time scaling: reward grows with session length (same curve as HP scaling)
        const timeMult = 1 + gameState.gameTime / 120;

        // Randomness: ±30% variance so kills feel less mechanical
        const rand = 0.7 + Math.random() * 0.6;

        // Money multiplier: each damageMultiplier upgrade adds 2% more money
        // (rewards players who invest in upgrades, thematically: better bullets = more loot)
        const moneyMult = 1 + gameState.upgrades.damageMultiplier * 0.02;

        let reward = Math.floor(base * timeMult * rand * moneyMult);
        reward = Math.max(1, reward);

        // Bosses are worth 10× after all other modifiers
        if (this.isBoss) reward *= 10;

        gameState.money            += reward;
        gameState.totalMoneyEarned += reward;

        // Cap array so a 30-enemy swarm kill doesn't flood the renderer
        if (floatingTexts.length < 60) {
            floatingTexts.push({
                x: this.x, y: this.y,
                text: `+$${reward}`,
                life: 1,
                vy: -1.2 * getScale(),
                color: this.isBoss ? '#8bac0f' : '#0f380f',
                size: this.isBoss ? 18 : 12
            });
        }

        // Hydra split logic
        if (this.type === 'HYDRA') {
            if (this.isBoss && this.bossData && this.bossData.ability === 'multisplit') {
                for (let i = 0; i < 3; i++) {
                    const ne = getEnemy();
                    ne.reset('HYDRA', true, { ...this.bossData, multiplier: 5 });
                    ne.x = this.x;
                    ne.y = this.y + (i - 1) * 40;
                }
            } else {
                for (let i = 0; i < 3; i++) {
                    const ne = getEnemy();
                    ne.reset('FAST');
                    ne.x = this.x;
                    ne.y = this.y + (i - 1) * 30;
                }
            }
        }
    }

    draw() {
        if (!this.active) return;

        const sc        = getScale();
        const baseStats = ENEMY_TYPES[this.type];
        const size      = baseStats.size * (this.isBoss ? 3 : 1) * sc;

        // SONIC VORTEX translucent dodge
        const isDodging = this.isBoss && this.bossData && this.bossData.ability === 'dodge' &&
                          (this.dodgeTimer % 4) >= 3;
        if (isDodging) ctx.globalAlpha = 0.3;

        switch (baseStats.shape) {

            case 'circle': {
                // NORMAL — round soldier with angry eyes
                ctx.fillStyle   = '#306230';
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 2 * sc;
                ctx.beginPath();
                ctx.arc(this.x, this.y, size, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                // Eyes — two dark squares
                ctx.fillStyle = '#0f380f';
                ctx.fillRect(this.x - size * 0.4 - size * 0.15, this.y - size * 0.2, size * 0.3, size * 0.3);
                ctx.fillRect(this.x + size * 0.1,                this.y - size * 0.2, size * 0.3, size * 0.3);
                // Angry brow lines
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 1.5 * sc;
                ctx.beginPath();
                ctx.moveTo(this.x - size * 0.55, this.y - size * 0.45);
                ctx.lineTo(this.x - size * 0.1,  this.y - size * 0.3);
                ctx.moveTo(this.x + size * 0.1,  this.y - size * 0.3);
                ctx.lineTo(this.x + size * 0.55, this.y - size * 0.45);
                ctx.stroke();
                break;
            }

            case 'triangle': {
                // FAST — sharp forward arrow with speed chevrons
                ctx.fillStyle   = '#8bac0f';
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 2 * sc;
                ctx.beginPath();
                ctx.moveTo(this.x - size * 1.2, this.y);          // sharp nose pointing LEFT (toward wall)
                ctx.lineTo(this.x + size * 0.7, this.y - size);
                ctx.lineTo(this.x + size * 0.7, this.y + size);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                // Speed chevrons behind body
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 1.5 * sc;
                for (let k = 1; k <= 2; k++) {
                    const ox = this.x + size * 0.7 + k * size * 0.55;
                    ctx.beginPath();
                    ctx.moveTo(ox, this.y - size * 0.5);
                    ctx.lineTo(ox + size * 0.4, this.y);
                    ctx.lineTo(ox, this.y + size * 0.5);
                    ctx.stroke();
                }
                break;
            }

            case 'square': {
                // TANK — armored box with plating detail
                ctx.fillStyle   = '#0f380f';
                ctx.strokeStyle = '#306230';
                ctx.lineWidth   = 2 * sc;
                ctx.fillRect(this.x - size, this.y - size, size * 2, size * 2);
                ctx.strokeRect(this.x - size, this.y - size, size * 2, size * 2);
                // Armor plate lines
                ctx.strokeStyle = '#306230';
                ctx.lineWidth   = 1 * sc;
                ctx.beginPath();
                // Horizontal plate divide
                ctx.moveTo(this.x - size * 0.9, this.y);
                ctx.lineTo(this.x + size * 0.9, this.y);
                // Vertical plate divide
                ctx.moveTo(this.x, this.y - size * 0.9);
                ctx.lineTo(this.x, this.y + size * 0.9);
                ctx.stroke();
                // Corner bolts
                ctx.fillStyle = '#306230';
                const boltOff = size * 0.65;
                for (const [bx, by] of [[-boltOff,-boltOff],[boltOff,-boltOff],[-boltOff,boltOff],[boltOff,boltOff]]) {
                    ctx.fillRect(this.x + bx - sc, this.y + by - sc, sc * 2, sc * 2);
                }
                break;
            }

            case 'healer': {
                // HEALER — glowing circle with medical cross
                // Outer glow ring
                ctx.strokeStyle = 'rgba(139, 172, 15, 0.35)';
                ctx.lineWidth   = 4 * sc;
                ctx.beginPath();
                ctx.arc(this.x, this.y, size * 1.4, 0, Math.PI * 2);
                ctx.stroke();
                // Main body
                ctx.fillStyle   = '#8bac0f';
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 2 * sc;
                ctx.beginPath();
                ctx.arc(this.x, this.y, size, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                // Cross symbol
                ctx.fillStyle = '#0f380f';
                ctx.fillRect(this.x - size * 0.2, this.y - size * 0.65, size * 0.4, size * 1.3);
                ctx.fillRect(this.x - size * 0.65, this.y - size * 0.2, size * 1.3, size * 0.4);
                // Heal pulse ring
                if (this.healTimer > 1.7) {
                    const pulseR = size * (1.5 + (this.healTimer - 1.7) * 4);
                    ctx.strokeStyle = `rgba(139, 172, 15, ${Math.max(0, 0.6 - (this.healTimer - 1.7) * 0.6)})`;
                    ctx.lineWidth   = 2 * sc;
                    ctx.beginPath();
                    ctx.arc(this.x, this.y, pulseR, 0, Math.PI * 2);
                    ctx.stroke();
                }
                break;
            }

            case 'hydra': {
                // HYDRA — central diamond core with 3 orbiting nodes
                // Draw connecting lines first (behind nodes)
                for (let k = 0; k < 3; k++) {
                    const a  = (k / 3) * Math.PI * 2 - Math.PI / 2;
                    const nx = this.x + Math.cos(a) * size * 1.3;
                    const ny = this.y + Math.sin(a) * size * 1.3;
                    ctx.strokeStyle = '#0f380f';
                    ctx.lineWidth   = 2 * sc;
                    ctx.beginPath();
                    ctx.moveTo(this.x, this.y);
                    ctx.lineTo(nx, ny);
                    ctx.stroke();
                    // Satellite nodes — small filled diamonds
                    ctx.fillStyle = '#306230';
                    ctx.strokeStyle = '#0f380f';
                    ctx.lineWidth = 1.5 * sc;
                    ctx.beginPath();
                    ctx.moveTo(nx,               ny - size * 0.45);
                    ctx.lineTo(nx + size * 0.45, ny);
                    ctx.lineTo(nx,               ny + size * 0.45);
                    ctx.lineTo(nx - size * 0.45, ny);
                    ctx.closePath();
                    ctx.fill(); ctx.stroke();
                }
                // Core — diamond
                ctx.fillStyle   = '#9bbc0f';
                ctx.strokeStyle = '#0f380f';
                ctx.lineWidth   = 2 * sc;
                ctx.beginPath();
                ctx.moveTo(this.x,          this.y - size * 0.8);
                ctx.lineTo(this.x + size * 0.8, this.y);
                ctx.lineTo(this.x,          this.y + size * 0.8);
                ctx.lineTo(this.x - size * 0.8, this.y);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }

            case 'shield': {
                // SHIELD — hexagon, distinct inner core when shielded
                const shielded = this.shieldHP > 0;
                // Outer hex (shield layer)
                if (shielded) {
                    ctx.fillStyle   = '#9bbc0f';
                    ctx.strokeStyle = '#0f380f';
                    ctx.lineWidth   = 3 * sc;
                    ctx.beginPath();
                    for (let k = 0; k < 6; k++) {
                        const a = (k / 6) * Math.PI * 2 - Math.PI / 6;
                        const px = this.x + Math.cos(a) * size;
                        const py = this.y + Math.sin(a) * size;
                        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.fill(); ctx.stroke();
                    // Shield HP bar
                    const sw = size * 2 * (this.shieldHP / this.maxShieldHP);
                    ctx.fillStyle = '#8bac0f';
                    ctx.fillRect(this.x - size, this.y - size - 8*sc, sw, 4*sc);
                    ctx.strokeStyle = '#0f380f';
                    ctx.lineWidth   = 1 * sc;
                    ctx.strokeRect(this.x - size, this.y - size - 8*sc, size * 2, 4*sc);
                }
                // Inner core — always visible, red/dark when shield down
                const coreSize = shielded ? size * 0.55 : size;
                ctx.fillStyle   = shielded ? '#306230' : '#0f380f';
                ctx.strokeStyle = shielded ? '#0f380f' : '#8bac0f';
                ctx.lineWidth   = 2 * sc;
                ctx.beginPath();
                for (let k = 0; k < 6; k++) {
                    const a = (k / 6) * Math.PI * 2 - Math.PI / 6;
                    const px = this.x + Math.cos(a) * coreSize;
                    const py = this.y + Math.sin(a) * coreSize;
                    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
        }

        ctx.globalAlpha = 1;

        // HP bar — pixel style, GB palette
        if (this.hp < this.maxHP) {
            const bw    = size * 2;
            const hpPct = this.hp / this.maxHP;
            ctx.fillStyle = '#0f380f';
            ctx.fillRect(this.x - bw / 2, this.y - size - 14*sc, bw, 5*sc);
            ctx.fillStyle = hpPct > 0.5 ? '#8bac0f' : hpPct > 0.25 ? '#306230' : '#0f380f';
            ctx.fillRect(this.x - bw / 2, this.y - size - 14*sc, bw * hpPct, 5*sc);
        }

        // Boss name tag — Press Start 2P style
        if (this.isBoss && this.bossData) {
            ctx.fillStyle = '#0f380f';
            ctx.font      = `bold ${Math.round(8*sc)}px 'Press Start 2P', monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(this.bossData.name, this.x, this.y - size - 20*sc);
        }

        // OVERMIND link beam — dark dashed line
        if (this.type === 'HEALER' && this.isBoss && this.linkedEnemy && this.linkedEnemy.active) {
            ctx.strokeStyle = 'rgba(15, 56, 15, 0.7)';
            ctx.lineWidth   = 3 * sc;
            ctx.setLineDash([6*sc, 4*sc]);
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(this.linkedEnemy.x, this.linkedEnemy.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
}

// ============================================
// OBJECT POOLS
// FIX #2: Removed bullets[] and enemies[] secondary arrays.
//         All iteration now goes directly over the pool arrays,
//         so the same object can NEVER be pushed twice.
// ============================================

const bulletPool  = [];
const enemyPool   = [];
const floatingTexts = [];
// FIX #6: Explosion visuals stored here, drawn in render phase
const explosions  = [];

for (let i = 0; i < 500; i++) bulletPool.push(new Bullet());
for (let i = 0; i < 200; i++) enemyPool.push(new Enemy());

function getBullet() {
    for (const b of bulletPool) { if (!b.active) return b; }
    // Hard cap: if all 500 are active, reuse the oldest one rather than growing.
    // Growing the pool unboundedly causes O(n²) homing scans that freeze mobile.
    return bulletPool[0];
}

function getEnemy() {
    for (const e of enemyPool) { if (!e.active) return e; }
    // Same cap for enemies.
    return enemyPool[0];
}

// ============================================
// COMBAT FUNCTIONS
// ============================================

function fire() {
    const activeUnits = gameState.units.filter(u => u && u.unlocked).length;
    const totalCost   = gameState.xValue * activeUnits;
    if (gameState.bullets < totalCost) return;

    gameState.bullets -= totalCost;

    const damageMultiplier = 1 + (gameState.upgrades.damageMultiplier * 0.01);
    const spacing          = getUnitSpacing(); // FIX #1

    for (let i = 0; i < gameState.units.length; i++) {
        const unit = gameState.units[i];
        if (!unit || !unit.unlocked) continue;

        const unitY      = (i + 1) * spacing;
        const baseDamage = unit.damage * damageMultiplier;

        const spreadAngle = Math.min(gameState.xValue * 0.05, Math.PI / 3);
        const angleStep   = spreadAngle / (gameState.xValue > 1 ? gameState.xValue - 1 : 1);
        const startAngle  = -spreadAngle / 2;

        for (let j = 0; j < gameState.xValue; j++) {
            const bullet = getBullet();
            const angle  = gameState.xValue > 1 ? startAngle + j * angleStep : 0;

            // FIX #7: fusion fires when fusionBullets >= 1 (not >= 10)
            let isFusion = false;
            if (gameState.upgrades.bulletFusion > 0 && gameState.fusionBullets >= 1) {
                isFusion = true;
                gameState.fusionBullets -= 1;
            }

            const damage = isFusion ? baseDamage * 3 : baseDamage;
            // Small random jitter so homing bullets don't all start on identical
            // paths and look more organic (±3° for normal, ±6° for multi-shot)
            const jitter = (Math.random() - 0.5) * (gameState.xValue > 1 ? 0.20 : 0.10);
            bullet.reset(WALL_X, unitY, angle + jitter, damage, unit.autoAim, isFusion);
            // FIX #2: NO bullets.push(bullet) — pool is iterated directly
        }
    }
}

function checkBulletCollisions() {
    for (const bullet of bulletPool) {
        if (!bullet.active) continue;
        for (const enemy of enemyPool) {
            if (!enemy.active) continue;

            const dx   = bullet.x - enemy.x;
            const dy   = bullet.y - enemy.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const size = ENEMY_TYPES[enemy.type].size * (enemy.isBoss ? 3 : 1) * getScale();

            if (dist < size) {
                let damage    = bullet.damage;
                const critChance = gameState.upgrades.critRate;

                if (Math.random() * 100 < critChance) {
                    damage *= (2 + gameState.upgrades.critDamage * 0.1);
                    floatingTexts.push({
                        x: enemy.x, y: enemy.y - 20 * getScale(),
                        text: 'CRIT!', life: 1, vy: -2 * getScale(), color: '#0f380f', size: 10
                    });
                }

                enemy.takeDamage(damage);

                if (Math.random() * 100 < gameState.upgrades.explosiveRounds) {
                    // FIX #6: trigger explosion (stores effect, no direct canvas draw)
                    triggerExplosion(bullet.x, bullet.y, damage * 0.5);
                }

                bullet.active = false;
                break;
            }
        }
    }
}

// Explosion logic: damage runs immediately, visuals stored for render phase
function triggerExplosion(x, y, damage) {
    // Spawn pixel shards flying outward
    const sc     = getScale();
    const shards = [];
    const count  = 10 + Math.floor(Math.random() * 6);
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
        const speed = (1.5 + Math.random() * 3.5) * sc;
        shards.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: (2 + Math.floor(Math.random() * 3)) * sc,
            life: 0.6 + Math.random() * 0.4
        });
    }
    explosions.push({ x, y, life: 1.0, shards });

    for (const enemy of enemyPool) {
        if (!enemy.active) continue;
        const dx = enemy.x - x;
        const dy = enemy.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < EXPLOSION_RADIUS * getScale()) {
            enemy.takeDamage(damage, true);
        }
    }
}

function drawExplosions() {
    for (let i = explosions.length - 1; i >= 0; i--) {
        const exp = explosions[i];
        exp.life -= 0.045;
        if (exp.life <= 0) { explosions.splice(i, 1); continue; }

        const age = 1 - exp.life;
        const sc  = getScale();
        const er  = EXPLOSION_RADIUS * sc;

        // Outer expanding ring
        const r1 = er * age * 1.1;
        ctx.strokeStyle = `rgba(15, 56, 15, ${exp.life * 0.9})`;
        ctx.lineWidth   = 5 * sc;
        ctx.strokeRect(exp.x - r1, exp.y - r1, r1 * 2, r1 * 2);

        // Mid ring
        const r2 = er * age * 0.7;
        ctx.strokeStyle = `rgba(139, 172, 15, ${exp.life * 0.7})`;
        ctx.lineWidth   = 3 * sc;
        ctx.strokeRect(exp.x - r2, exp.y - r2, r2 * 2, r2 * 2);

        // Central flash — bright square that fades fast
        if (exp.life > 0.7) {
            const fs = er * 0.3 * exp.life;
            ctx.fillStyle = `rgba(155, 188, 15, ${(exp.life - 0.7) * 3.3})`;
            ctx.fillRect(exp.x - fs, exp.y - fs, fs * 2, fs * 2);
        }

        // Pixel shards
        for (const s of exp.shards) {
            s.x    += s.vx * _deltaTime * 60;
            s.y    += s.vy * _deltaTime * 60;
            s.vy   += 0.12 * _deltaTime * 60;
            s.life -= 0.045 * _deltaTime * 60;
            if (s.life <= 0) continue;
            const alpha = Math.min(1, s.life * 1.5);
            ctx.fillStyle = s.size > 3 * getScale()
                ? `rgba(15, 56, 15, ${alpha})`
                : `rgba(48, 98, 48, ${alpha})`;
            ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
        }
    }
}

// ============================================
// ENEMY SPAWNING
// ============================================

function spawnEnemy(types, weights) {
    // Default to full pool if called without restrictions (e.g. from Hydra split)
    if (!types) {
        types   = ['NORMAL', 'FAST', 'TANK', 'HYDRA', 'HEALER', 'SHIELD'];
        weights = [40, 25, 15, 10, 5, 5];
    }
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let selected = types[0];
    for (let i = 0; i < types.length; i++) {
        r -= weights[i];
        if (r <= 0) { selected = types[i]; break; }
    }
    const enemy = getEnemy();
    enemy.reset(selected);
}

function spawnBoss(allowedBosses) {
    const pool = allowedBosses && allowedBosses.length > 0
        ? allowedBosses.map(k => BOSS_TYPES[k])
        : Object.values(BOSS_TYPES);
    const selectedBoss = pool[Math.floor(Math.random() * pool.length)];
    const enemy = getEnemy();
    enemy.reset(selectedBoss.type, true, selectedBoss);
    floatingTexts.push({
        x: canvas.width / 2, y: Math.round(50 * getScale()),
        text: `BOSS: ${selectedBoss.name}`,
        life: 3, vy: 0, color: '#0f380f', size: 10
    });
}

function spawnEnemyEvent(maxSize) {
    const count = maxSize || 30;
    for (let i = 0; i < count; i++) spawnEnemy();
    floatingTexts.push({
        x: canvas.width / 2, y: Math.round(100 * getScale()),
        text: '!! ENEMY SWARM !!', life: 2, vy: 0, color: '#0f380f', size: 9
    });
}

// ============================================
// DRAW FUNCTIONS
// ============================================

function drawBackground() {
    // Lightest GB green as the "screen" background
    ctx.fillStyle = '#9bbc0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Faint pixel grid in medium GB green
    ctx.strokeStyle = '#8bac0f';
    ctx.lineWidth = 1;
    const g = Math.round(16 * getScale());
    for (let x = 0; x < canvas.width;  x += g) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += g) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
}

function drawWall() {
    const hpPct = gameState.wallHP / gameState.wallMaxHP;

    // Wall body color shifts through GB palette as HP drops
    let wallColor = '#306230';         // healthy — dark green
    if      (hpPct < 0.25) wallColor = '#0f380f'; // critical — darkest
    else if (hpPct < 0.50) wallColor = '#0f380f'; // damaged  — darkest

    const sc  = getScale();
    const hw  = Math.max(8, Math.round(12 * sc)); // half-width of wall

    // Main wall block
    ctx.fillStyle = wallColor;
    ctx.fillRect(WALL_X - hw, 0, hw * 2, canvas.height);

    // Hard right-edge line
    ctx.fillStyle = '#0f380f';
    ctx.fillRect(WALL_X + hw, 0, Math.max(2, Math.round(4 * sc)), canvas.height);

    // Brick pattern
    ctx.fillStyle = '#0f380f';
    const brickH = Math.round(16 * sc);
    for (let y = 0; y < canvas.height; y += brickH) {
        ctx.fillRect(WALL_X - hw, y, hw * 2, Math.max(1, Math.round(2 * sc)));
    }

    // HP fill overlay
    const barH = canvas.height * hpPct;
    ctx.fillStyle = '#8bac0f';
    ctx.globalAlpha = 0.35;
    ctx.fillRect(WALL_X - hw + 1, canvas.height - barH, hw * 2 - 2, barH);
    ctx.globalAlpha = 1;
}

function drawUnits() {
    const spacing = getUnitSpacing();
    const sc      = getScale();
    const s = (n) => Math.round(n * sc);

    for (let i = 0; i < gameState.units.length; i++) {
        const unit = gameState.units[i];
        if (!unit || !unit.unlocked) continue;

        const cx        = WALL_X - s(28); // center X of unit
        const cy        = Math.round((i + 1) * spacing); // center Y
        const isCaptain = i === 0;
        const hasAutoAim = unit.autoAim;

        // Color scheme:
        // Captain        = #0f380f (darkest) — elite
        // AutoAim unlock = #306230 (dark)    — veteran
        // Basic recruit  = #8bac0f (medium)  — rookie (contrasts bg)
        const bodyCol = isCaptain ? '#0f380f' : hasAutoAim ? '#306230' : '#8bac0f';
        const darkCol = '#0f380f';
        const lightCol = '#9bbc0f';

        // ── HELMET ──────────────────────────────
        // Brim (wide base)
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx - s(9), cy - s(20), s(18), s(4));
        // Crown
        ctx.fillStyle = bodyCol;
        ctx.fillRect(cx - s(7), cy - s(28), s(14), s(9));
        // Visor slit (dark stripe across brim)
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx - s(7), cy - s(21), s(14), s(2));

        // Captain gets a gold star badge on the helmet
        if (isCaptain) {
            ctx.fillStyle = lightCol;
            ctx.fillRect(cx - s(2), cy - s(26), s(4), s(4));
        }

        // ── BODY / TORSO ─────────────────────────
        ctx.fillStyle = bodyCol;
        ctx.fillRect(cx - s(6), cy - s(16), s(12), s(12));
        // Dark outline on torso
        ctx.strokeStyle = darkCol;
        ctx.lineWidth = Math.max(1, s(1));
        ctx.strokeRect(cx - s(6), cy - s(16), s(12), s(12));

        // Belt line
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx - s(6), cy - s(6), s(12), s(2));

        // ── GUN ARM ──────────────────────────────
        // Arm stub
        ctx.fillStyle = bodyCol;
        ctx.fillRect(cx + s(5), cy - s(14), s(4), s(5));
        // Gun barrel extending right toward wall
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx + s(8), cy - s(13), s(14), s(3));
        // Gun body block
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx + s(5), cy - s(15), s(6), s(6));
        // Muzzle flash pixel when firing could go here

        // ── LEGS ─────────────────────────────────
        ctx.fillStyle = bodyCol;
        ctx.fillRect(cx - s(5), cy - s(4),  s(4), s(10));
        ctx.fillRect(cx + s(1), cy - s(4),  s(4), s(10));
        // Boots
        ctx.fillStyle = darkCol;
        ctx.fillRect(cx - s(6), cy + s(5),  s(5), s(4));
        ctx.fillRect(cx,        cy + s(5),  s(5), s(4));

        // ── RANK PIPS for recruits ────────────────
        // Show upgrade level as small dots under the feet (max 5 shown)
        if (!isCaptain) {
            const pips = Math.min(unit.level, 5);
            ctx.fillStyle = hasAutoAim ? lightCol : darkCol;
            for (let p = 0; p < pips; p++) {
                ctx.fillRect(cx - s(4) + p * s(4), cy + s(11), s(3), s(3));
            }
        }

        // ── AUTOFIRE HALO ─────────────────────────
        if (unit.autofire && gameState.autofireEnabled) {
            const pulse = (Math.floor(Date.now() / 250) % 2) === 0;
            const haloR = s(pulse ? 22 : 26);
            ctx.strokeStyle = lightCol;
            ctx.lineWidth   = s(2);
            ctx.beginPath();
            ctx.arc(cx, cy - s(10), haloR, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
}

function drawFloatingTexts(deltaTime) {
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const t = floatingTexts[i];
        // Use deltaTime so texts drain at the same rate on 60fps and 120fps
        t.life -= deltaTime;
        t.y    += t.vy * deltaTime * 60; // vy is in px/frame@60fps, convert to px/s
        if (t.life <= 0) { floatingTexts.splice(i, 1); continue; }

        ctx.fillStyle   = t.color || '#0f380f';
        ctx.font        = `${Math.round((t.size || 10) * getScale())}px 'Press Start 2P', monospace`;
        ctx.textAlign   = 'center';
        ctx.globalAlpha = Math.min(1, t.life);
        ctx.fillText(t.text, t.x, t.y);
        ctx.globalAlpha = 1;
    }
}

// ============================================
// GAME LOOP
// ============================================

// Module-level deltaTime — set once per frame at top of gameLoop.
// drawExplosions and any other non-loop function that needs it reads from here.
let _deltaTime = 0;
let lastTime   = 0;

function gameLoop(timestamp) {
    if (!gameState.running) return;

    // Cache scale once per frame so all draw calls use the same value
    updateScale();

    // FIX #17: huge first deltaTime (lastTime=0) capped to 100ms
    const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime   = timestamp;
    _deltaTime = deltaTime;

    // Bullet accumulation
    gameState.bullets += gameState.bulletsPerSecond * deltaTime;

    // FIX #7: Fusion bullets accumulate at 1/10 the bullet rate (10 bullets = 1 fusion)
    if (gameState.upgrades.bulletFusion > 0) {
        gameState.fusionBullets += (gameState.bulletsPerSecond * deltaTime) / 10;
    }

    gameState.gameTime += deltaTime;

    const now = Date.now();
    const t   = gameState.gameTime;

    // Initialize spawn timers on the very first frame
    if (gameState.lastSpawn      === 0) gameState.lastSpawn      = now;
    if (gameState.lastEventCheck === 0) gameState.lastEventCheck = now;

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL RESTRICTION SYSTEM (invisible to player)
    //
    // Milestone 1 — 0–30 s    "TUTORIAL WINDOW"
    //   Only NORMAL enemies. Single spawns. No events at all.
    //   Player learns: accumulate ammo → fire → kill → earn money.
    //
    // Milestone 2 — 30–60 s   "WARMING UP"
    //   NORMAL + FAST unlocked. Still no heavy types, no events.
    //   Player feels first speed pressure.
    //
    // Milestone 3 — 60–120 s  "FIRST ESCALATION"
    //   NORMAL + FAST + TANK + HYDRA unlocked. HEALER/SHIELD still locked.
    //   Mini-swarms allowed (max 10). No bosses yet.
    //
    // Milestone 4 — 120–180 s "ALL REGULARS"
    //   All 6 regular types unlocked. Swarms up to 15.
    //   Only beginner bosses: GOLIATH or SONIC VORTEX.
    //
    // Milestone 5 — 180–300 s "MID GAME"
    //   GOLIATH, SONIC, IRON MOUNTAIN, OVERMIND allowed.
    //   HYDRA PRIME and AEGIS TITAN still locked (too complex too early).
    //   Swarms up to 22.
    //
    // Milestone 6 — 300 s+    "FULL GAME — all restrictions lifted"
    //   Every boss, full swarm of 30, full difficulty ramp.
    // ═══════════════════════════════════════════════════════════════════════

    // Enemy type pool — expands with milestones
    let allowedTypes, allowedWeights;
    if (t < 30) {
        allowedTypes   = ['NORMAL'];
        allowedWeights = [100];
    } else if (t < 60) {
        allowedTypes   = ['NORMAL', 'FAST'];
        allowedWeights = [65, 35];
    } else if (t < 120) {
        allowedTypes   = ['NORMAL', 'FAST', 'TANK', 'HYDRA'];
        allowedWeights = [45, 30, 15, 10];
    } else {
        allowedTypes   = ['NORMAL', 'FAST', 'TANK', 'HYDRA', 'HEALER', 'SHIELD'];
        allowedWeights = [40, 25, 15, 10, 5, 5];
    }

    // Boss pool — expands with milestones (null = all allowed)
    let allowedBosses;
    if      (t < 120) allowedBosses = [];                                          // none
    else if (t < 180) allowedBosses = ['GOLIATH', 'SONIC'];                        // easy two only
    else if (t < 300) allowedBosses = ['GOLIATH', 'SONIC', 'IRON', 'OVERMIND'];   // no split/regen bosses yet
    else              allowedBosses = Object.keys(BOSS_TYPES);                     // all

    // Swarm size cap — grows with milestones
    const maxSwarmSize = t < 60  ? 0  :
                         t < 120 ? 10 :
                         t < 180 ? 15 :
                         t < 300 ? 22 : 30;

    // Difficulty phase — controls spawn rate and speed
    let spawnCount, targetInterval, speedMult, eventInterval;
    if (t < 60) {
        spawnCount     = 1;
        targetInterval = Math.max(2000, 3000 - t * 10);
        speedMult      = 1.0;
        eventInterval  = 999999; // disabled — milestone system handles this
    } else if (t < 180) {
        spawnCount     = Math.random() < 0.35 ? 2 : 1;
        targetInterval = Math.max(1200, 2000 - (t - 60) * 5);
        speedMult      = 1.2;
        eventInterval  = 20000;
    } else if (t < 360) {
        spawnCount     = Math.random() < 0.5 ? 3 : 2;
        targetInterval = Math.max(800, 1200 - (t - 180) * 3);
        speedMult      = 1.45;
        eventInterval  = 14000;
    } else if (t < 600) {
        spawnCount     = Math.floor(Math.random() * 3) + 3;
        targetInterval = Math.max(500, 800 - (t - 360) * 1.5);
        speedMult      = 1.75;
        eventInterval  = 11000;
    } else {
        spawnCount     = Math.floor(Math.random() * 4) + 4;
        targetInterval = 400;
        speedMult      = 2.2;
        eventInterval  = 9000;
    }

    gameState.difficultySpeedMult = speedMult;

    if (gameState.spawnInterval > targetInterval) {
        gameState.spawnInterval = targetInterval;
    }

    // Spawn regular enemies (restricted type pool)
    if (now - gameState.lastSpawn > gameState.spawnInterval) {
        gameState.lastSpawn = now;
        for (let s = 0; s < spawnCount; s++) spawnEnemy(allowedTypes, allowedWeights);
    }

    // Event roll — only fires when milestone permits it
    if (now - gameState.lastEventCheck > eventInterval) {
        gameState.lastEventCheck = now;
        const bossChance  = allowedBosses.length > 0 ? Math.min(15, 5 + t / 120) : 0;
        const swarmChance = maxSwarmSize  > 0         ? Math.min(25, 10 + t / 90) : 0;
        const roll = Math.random() * 100;
        if      (bossChance  > 0 && roll < bossChance)                spawnBoss(allowedBosses);
        else if (swarmChance > 0 && roll < bossChance + swarmChance)  spawnEnemyEvent(maxSwarmSize);
    }

    // Autofire
    if (gameState.autofireEnabled && gameState.upgrades.captainAutofire > 0) {
        const totalCost = gameState.xValue * gameState.units.filter(u => u.unlocked).length;
        if (gameState.bullets >= totalCost) {
            const fireDelay = 1000 / Math.min(gameState.units[0].fireRate, MAX_FIRE_RATE);
            if (now - gameState.lastAutofire > fireDelay) {
                gameState.lastAutofire = now;
                fire();
            }
        }
    }

    // Update
    for (const bullet of bulletPool) bullet.update(deltaTime);
    for (const enemy  of enemyPool)  enemy.update(deltaTime);
    checkBulletCollisions();

    // Render
    drawBackground();
    drawWall();
    drawUnits();
    for (const enemy  of enemyPool)  enemy.draw();
    for (const bullet of bulletPool) bullet.draw();
    drawExplosions();
    drawFloatingTexts(deltaTime);

    updateUI();
    requestAnimationFrame(gameLoop);
}

// ============================================
// UI FUNCTIONS
// ============================================

function updateUI() {
    document.getElementById('moneyDisplay').textContent    = `$${Math.floor(gameState.money)}`;
    document.getElementById('bulletsDisplay').textContent  = gameState.bullets.toFixed(1);
    document.getElementById('wallHPDisplay').textContent   =
        `${Math.max(0, Math.floor(gameState.wallHP))}/${gameState.wallMaxHP}`;
    document.getElementById('highScoreDisplay').textContent = Math.floor(gameState.highScore);

    const activeUnits = gameState.units.filter(u => u && u.unlocked).length;
    const totalCost   = gameState.xValue * activeUnits;
    const fireBtn     = document.getElementById('fireButton');
    fireBtn.classList.toggle('ready', gameState.bullets >= totalCost);

    // FIX #11: score uses totalMoneyEarned, not current money balance
    const currentScore = (gameState.kills * 10) + gameState.bullets + (gameState.totalMoneyEarned / 10);
    if (currentScore > gameState.highScore) gameState.highScore = currentScore;

    // BUG FIX: re-check buy button affordability every frame.
    // updateUpgradeUI() only runs on purchase events, so buttons stay permanently
    // disabled even after the player earns enough money. This lightweight pass
    // just toggles disabled without rebuilding the DOM.
    refreshButtonAffordability();
}

function refreshButtonAffordability() {
    const money = gameState.money;

    // Use CSS class instead of the `disabled` attribute.
    // The disabled attribute silently swallows click events in many browsers,
    // so a button that just became affordable sometimes eats the first click.
    // 'unaffordable' dims it visually; the real guard lives inside each buy fn.
    for (const [key, level] of Object.entries(gameState.upgrades)) {
        const el = document.querySelector(`[data-upgrade="${key}"]`);
        if (!el) continue;
        const btn = el.querySelector('.buy-button');
        if (!btn) continue;
        const maxLevel = getMaxUpgradeLevel(key);
        if (maxLevel > 0 && level >= maxLevel) {
            btn.classList.add('unaffordable');
            btn.textContent = 'MAX';
            btn.disabled = false;
            continue;
        }
        const cost = getUpgradeCost(key, level);
        // Heal consumables: also gray out when wall is already full
        const wallFull = (key === 'fieldPatch' || key === 'emergencyRepairs')
                         && gameState.wallHP >= gameState.wallMaxHP;
        btn.classList.toggle('unaffordable', money < cost || wallFull);
        btn.disabled = false;
    }

    for (let i = 0; i < 9; i++) {
        const el = document.querySelector(`[data-unit="${i}"]`);
        if (!el) continue;
        const btn = el.querySelector('.buy-button');
        if (!btn) continue;
        const unit = gameState.units[i];
        const cost = (unit && unit.unlocked)
            ? getUnitUpgradeCost(i, unit.level)
            : 1000 * Math.pow(3, i);
        btn.classList.toggle('unaffordable', money < cost);
        btn.disabled = false;
    }
}

function updateUpgradeUI() {
    // General upgrades
    for (const [key, level] of Object.entries(gameState.upgrades)) {
        const el = document.querySelector(`[data-upgrade="${key}"]`);
        if (!el) continue;

        el.querySelector('.level').textContent = level;
        const cost    = getUpgradeCost(key, level);
        el.querySelector('.cost').textContent  = Math.floor(cost);

        const btn      = el.querySelector('.buy-button');
        const maxLevel = getMaxUpgradeLevel(key);
        if (maxLevel > 0 && level >= maxLevel) {
            btn.classList.add('unaffordable');
            btn.disabled    = false;
            btn.textContent = 'MAX';
        } else {
            const wallFull = (key === 'fieldPatch' || key === 'emergencyRepairs')
                             && gameState.wallHP >= gameState.wallMaxHP;
            btn.classList.toggle('unaffordable', gameState.money < cost || wallFull);
            btn.disabled = false;
            if (btn.textContent === 'MAX') btn.textContent = 'BUY';
        }
    }

    // Unit upgrades
    for (let i = 0; i < 9; i++) {
        const el = document.querySelector(`[data-unit="${i}"]`);
        if (!el) continue;

        const unitExists = i < gameState.units.length;
        const unit       = unitExists ? gameState.units[i] : null;

        if (!unit || !unit.unlocked) {
            const cost = 1000 * Math.pow(3, i);
            el.querySelector('.cost').textContent = cost.toLocaleString();
            const btn = el.querySelector('.buy-button');
            btn.classList.toggle('unaffordable', gameState.money < cost);
            btn.disabled    = false;
            btn.textContent = 'UNLOCK';
        } else {
            el.classList.remove('locked');
            const h3 = el.querySelector('h3');
            if (h3 && h3.textContent.includes('🔒')) h3.textContent = `Unit ${i + 1}`;
            const cost      = getUnitUpgradeCost(i, unit.level);
            const levelSpan = el.querySelector('.level');
            if (levelSpan) levelSpan.textContent = unit.level;
            el.querySelector('.cost').textContent = Math.floor(cost);
            const btn = el.querySelector('.buy-button');
            btn.classList.toggle('unaffordable', gameState.money < cost);
            btn.disabled    = false;
            btn.textContent = 'UPGRADE';
            const desc = el.querySelector('.desc');
            if (desc) {
                let d = `Damage: ${unit.damage}`;
                if (unit.autoAim)  d += ' | Auto-aim ✓';
                if (unit.autofire) d += ' | Autofire ✓';
                desc.textContent = d;
            }
        }
    }
}

function getUpgradeCost(upgrade, currentLevel) {
    const costs = {
        damageMultiplier: () => 8   * Math.pow(1.4,  currentLevel),
        fireLimitBreak:   () => 35  * Math.pow(1.6,  currentLevel),
        moreAmmo:         () => 12  * Math.pow(1.35, currentLevel),  // significantly cheaper
        captainAutofire:  () => 250,
        explosiveRounds:  () => 120 * Math.pow(1.8,  currentLevel),
        critRate:         () => 180 * Math.pow(1.9,  currentLevel),
        critDamage:       () => 60  * Math.pow(1.5,  currentLevel),
        bulletFusion:     () => 600,
        wallThickening:   () => 18  * Math.pow(1.4,  currentLevel),
        kineticRepulsion: () => 80  * Math.pow(1.7,  currentLevel),
        improvedMaterial: () => 300 * Math.pow(2.5,  currentLevel),
        armorPlating:     () => 120 * Math.pow(1.6,  currentLevel),
        barbedWires:      () => 400,
        // Consumable heals — cost never scales with purchase count
        fieldPatch:       () => 90,
        emergencyRepairs: () => Math.floor(gameState.wallMaxHP * 1.2)  // ~$120 at base, grows with wall upgrades
    };
    return Math.floor(costs[upgrade]());
}

function getMaxUpgradeLevel(upgrade) {
    const max = {
        captainAutofire: 1, explosiveRounds: 10,
        critRate: 10, bulletFusion: 1,
        kineticRepulsion: 10, armorPlating: 25, barbedWires: 1
    };
    return max[upgrade] || 0;
}

function getUnitUpgradeCost(unitIndex, currentLevel) {
    return Math.floor(20 * (unitIndex + 1) * Math.pow(1.5, currentLevel));
}

function buyUpgrade(upgradeName) {
    const currentLevel = gameState.upgrades[upgradeName];
    const cost         = getUpgradeCost(upgradeName, currentLevel);
    const maxLevel     = getMaxUpgradeLevel(upgradeName);

    if (maxLevel > 0 && currentLevel >= maxLevel) return;
    if (gameState.money < cost) return;

    gameState.money -= cost;
    gameState.upgrades[upgradeName]++;

    switch (upgradeName) {
        case 'fireLimitBreak': {
            const lv = gameState.upgrades[upgradeName];
            if      (lv <= 10) gameState.maxX += 1;
            else if (lv <= 20) gameState.maxX += 2;
            else if (lv <= 40) gameState.maxX += 4;
            else               gameState.maxX += 6;
            break;
        }
        case 'moreAmmo':
            gameState.bulletsPerSecond++;
            break;
        case 'captainAutofire':
            document.getElementById('autofireToggle').style.display = 'block';
            gameState.units[0].autofire = true;
            break;
        case 'wallThickening':
            gameState.wallMaxHP += 10;
            gameState.wallHP    += 10;
            break;
        case 'improvedMaterial': {
            const oldMax = gameState.wallMaxHP;
            gameState.wallMaxHP = Math.floor(gameState.wallMaxHP * 1.5);
            gameState.wallHP   += gameState.wallMaxHP - oldMax;
            break;
        }
        case 'fieldPatch':
            // Heal flat 20 HP, never exceed max
            gameState.wallHP = Math.min(gameState.wallMaxHP, gameState.wallHP + 20);
            break;
        case 'emergencyRepairs':
            // Heal 10% of max HP, never exceed max
            gameState.wallHP = Math.min(gameState.wallMaxHP,
                gameState.wallHP + Math.floor(gameState.wallMaxHP * 0.10));
            break;
    }

    updateUpgradeUI();
    saveGame();
}

function unlockUnit(unitIndex) {
    // FIX #12: cost is consistent with updateUpgradeUI (Math.pow(10, unitIndex))
    const cost = 1000 * Math.pow(3, unitIndex);
    if (gameState.money < cost) return;

    gameState.money -= cost;

    while (gameState.units.length <= unitIndex) {
        gameState.units.push({
            unlocked: false, level: 0, damage: 5,
            autoAim: false, autofire: false, fireRate: 2, lastFired: 0
        });
    }
    gameState.units[unitIndex].unlocked = true;
    gameState.units[unitIndex].level    = 1;

    updateUpgradeUI();
    saveGame();
}

function upgradeUnit(unitIndex) {
    const unit = gameState.units[unitIndex];
    const cost = getUnitUpgradeCost(unitIndex, unit.level);
    if (gameState.money < cost) return;

    gameState.money -= cost;
    unit.level++;

    // FIX #5: was "level<=39 || level>=41" — a tautology (ALWAYS true).
    //         Level 40 should only unlock autofire, not also add damage.
    if (unit.level !== 40) {
        unit.damage += 2;
    }
    if (unit.level === 10) unit.autoAim  = true;
    if (unit.level === 40) unit.autofire = true;
    if (unit.level >= 41)  unit.fireRate = Math.min(unit.fireRate + 0.2, MAX_FIRE_RATE);

    updateUpgradeUI();
    saveGame();
}

// ============================================
// EVENT HANDLERS
// ============================================

document.getElementById('fireButton').addEventListener('click', fire);

// Hold-to-repeat for +/- buttons.
// ONLY mousedown is used — no separate 'click' listener.
// startHold() calls fn() immediately for the single-press case,
// so adding a 'click' listener too would double-fire (1→3, skipping 2).
// Fix: was calling fn() AND then immediately starting a 120ms interval.
// If the player released before 120ms the interval still fired once → skip.
// Now: single press = one fire. Hold 400ms → rapid repeat at 80ms.
let holdInterval = null;
let holdTimeout  = null;
function startHold(fn) {
    fn();
    holdTimeout = setTimeout(() => {
        holdInterval = setInterval(fn, 80);
    }, 400);
}
function stopHold() {
    clearTimeout(holdTimeout);
    clearInterval(holdInterval);
    holdTimeout  = null;
    holdInterval = null;
}

const xValueEl = document.getElementById('xValue');

function addHoldListeners(el, fn) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); startHold(fn); });
}

addHoldListeners(document.getElementById('increaseX'), () => {
    if (gameState.xValue < gameState.maxX) {
        gameState.xValue++;
        xValueEl.textContent = gameState.xValue;
    }
});
addHoldListeners(document.getElementById('decreaseX'), () => {
    if (gameState.xValue > 1) {
        gameState.xValue--;
        xValueEl.textContent = gameState.xValue;
    }
});

document.addEventListener('pointerup',     stopHold);
document.addEventListener('pointercancel', stopHold);

document.getElementById('autofireCheckbox').addEventListener('change', e => {
    gameState.autofireEnabled = e.target.checked;
});

// Tab switching
document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.upgrade-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`${btn.dataset.tab}Tab`).classList.add('active');
    });
});

// General upgrade buttons (static HTML items)
document.querySelectorAll('.upgrade-item .buy-button').forEach(btn => {
    btn.addEventListener('click', e => {
        const item = e.target.closest('.upgrade-item');
        buyUpgrade(item.dataset.upgrade);
    });
});

// FIX #4: Captain button had NO listener (generateUnitElements started at i=1).
//         Using event delegation on #unitsList handles ALL unit buttons including Captain.
document.getElementById('unitsList').addEventListener('click', e => {
    if (!e.target.matches('.buy-button')) return;
    const unitEl = e.target.closest('[data-unit]');
    if (!unitEl) return;
    const i = parseInt(unitEl.dataset.unit, 10);
    if (gameState.units[i] && gameState.units[i].unlocked) {
        upgradeUnit(i);
    } else {
        unlockUnit(i);
    }
});

// Generate locked unit slots 2-9 in the DOM
// FIX #15: template now includes <span class="level"> so updateUpgradeUI can read it
function generateUnitElements() {
    const list = document.getElementById('unitsList');
    for (let i = 1; i < 9; i++) {
        if (document.querySelector(`[data-unit="${i}"]`)) continue; // already exists
        const cost = 1000 * Math.pow(3, i);
        const div  = document.createElement('div');
        div.className    = 'unit-upgrade locked';
        div.dataset.unit = i;
        div.innerHTML = `
            <div class="upgrade-info">
                <h3>🔒 Unit ${i + 1}</h3>
                <p>Level: <span class="level">0</span> | Cost: $<span class="cost">${cost.toLocaleString()}</span></p>
                <p class="desc">Unlock new defender</p>
            </div>
            <button class="buy-button">UNLOCK</button>
        `;
        list.appendChild(div);
        // Note: click is handled by the delegated listener on #unitsList above
    }
}

// ============================================
// SAVE / LOAD — disabled. Every session starts fresh.
// High score only is kept in memory for the session.
// ============================================
function saveGame() { /* no-op — no persistence */ }
function loadGame()  { /* no-op — no persistence */ }

function gameOver() {
    if (!gameState.running) return; // guard against double-call
    gameState.running = false;

    // FIX #11: use totalMoneyEarned not current balance; floor everything
    const finalScore = (gameState.kills * 10) +
                       Math.floor(gameState.bullets) +
                       Math.floor(gameState.totalMoneyEarned / 10);

    document.getElementById('finalScore').textContent = Math.floor(finalScore);
    document.getElementById('finalKills').textContent = gameState.kills;
    document.getElementById('finalMoney').textContent = Math.floor(gameState.totalMoneyEarned);
    document.getElementById('gameOverScreen').style.display = 'flex';

    if (finalScore > gameState.highScore) {
        gameState.highScore = finalScore;
        saveGame();
    }
}

// ============================================
// TITLE SCREEN & TUTORIAL
// ============================================

const TOTAL_STEPS = 6;
let tutStep = 0;

function setupTitleScreen() {
    const titleScreen    = document.getElementById('titleScreen');
    const tutorialScreen = document.getElementById('tutorialScreen');

    // Use a guard so startGame() can never be called twice
    let gameStarted = false;
    function safeStart() {
        if (gameStarted) return;
        gameStarted = true;
        titleScreen.style.display = 'none';
        startGame();
    }

    // touch-action:manipulation on * converts taps to click events automatically.
    // We only need 'click' listeners — no separate touchend needed, and
    // having both caused a double-fire that launched two game loops.
    document.getElementById('playButton').addEventListener('click', safeStart);

    document.getElementById('tutorialButton').addEventListener('click', openTutorial);

    document.getElementById('tutNext').addEventListener('click',  tutorialNext);
    document.getElementById('tutPrev').addEventListener('click',  tutorialPrev);
    document.getElementById('tutClose').addEventListener('click', () => {
        tutorialScreen.style.display = 'none';
        titleScreen.style.display    = 'flex';
    });
    document.getElementById('tutPlay').addEventListener('click', () => {
        if (gameStarted) return;
        gameStarted = true;
        tutorialScreen.style.display = 'none';
        startGame();
    });

    // Build dots
    const dotsEl = document.getElementById('tutDots');
    for (let i = 0; i < TOTAL_STEPS; i++) {
        const d = document.createElement('span');
        d.className = 'tut-dot' + (i === 0 ? ' active' : '');
        d.dataset.i = i;
        dotsEl.appendChild(d);
    }
}

function openTutorial() {
    tutStep = 0;
    document.getElementById('titleScreen').style.display    = 'none';
    document.getElementById('tutorialScreen').style.display = 'flex';
    renderTutStep();
}

function tutorialNext() {
    if (tutStep < TOTAL_STEPS - 1) { tutStep++; renderTutStep(); }
}
function tutorialPrev() {
    if (tutStep > 0)               { tutStep--; renderTutStep(); }
}

function renderTutStep() {
    document.querySelectorAll('.tut-step').forEach((el, i) => {
        el.classList.toggle('active', i === tutStep);
    });
    document.querySelectorAll('.tut-dot').forEach((el, i) => {
        el.classList.toggle('active', i === tutStep);
    });
    document.getElementById('tutPrev').disabled = tutStep === 0;
    document.getElementById('tutNext').style.display = tutStep === TOTAL_STEPS - 1 ? 'none' : 'inline-block';
    document.getElementById('tutPlay').style.display = tutStep === TOTAL_STEPS - 1 ? 'inline-block' : 'none';
}

function startGame() {
    const gc = document.getElementById('gameContainer');
    gc.style.display = 'flex';
    resizeCanvas();
    generateUnitElements();
    updateUpgradeUI();
    requestAnimationFrame(gameLoop);
}

// ============================================
// INITIALIZATION
// ============================================

window.addEventListener('load', () => {
    // Wait for Press Start 2P to fully load before showing anything.
    // Without this, canvas text falls back to system monospace on mobile.
    const fontPromise = document.fonts.load("10px 'Press Start 2P'");
    const timeout     = new Promise(res => setTimeout(res, 2000)); // 2s max wait
    Promise.race([fontPromise, timeout]).then(() => {
        setupTitleScreen();
    });
});

window.addEventListener('resize', () => {
    if (document.getElementById('gameContainer').style.display !== 'none') {
        resizeCanvas();
        updateUpgradeUI();
    }
});

document.getElementById('restartButton').addEventListener('click', () => location.reload());
