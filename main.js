// WebGL2 N-body GPGPU (N^2) setup
const N = 1024; // max body slots (was 512)
let activeBodies = 0;
const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl2');

// Setup: resize, check extensions
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

gl.viewport(0, 0, canvas.width, canvas.height);
const floatTexExt = gl.getExtension('EXT_color_buffer_float');
if (!gl || !floatTexExt) {
    alert('WebGL2 or EXT_color_buffer_float not supported.');
    throw new Error('WebGL2 not available.');
}

// Helpers to create shaders/programs, textures, FBOs
function createShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
}
function createProgram(vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, createShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, createShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
}
function createTexture(width, height, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}
function createFBO(tex) {
    let fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fb;
}

// State arrays
const side = Math.ceil(Math.sqrt(N));
let posData = new Float32Array(side * side * 4), velData = new Float32Array(side * side * 4);
// Initialize all as unused
toDormant();
function toDormant() {
    for (let i = 0; i < N; ++i) {
        posData[i * 4] = 0; posData[i * 4 + 1] = 0; posData[i * 4 + 2] = 0; posData[i * 4 + 3] = 0; // mass=0 => unused
        velData[i * 4] = 0; velData[i * 4 + 1] = 0; velData[i * 4 + 2] = 0; velData[i * 4 + 3] = 0;
    }
    activeBodies = 0;
    activeBodies = 0;
}

// Pattern State
let currentPattern = 'random';

// Evolve mode state
let evolveMode = false;
const COLLISION_RADIUS = 0.01; // Collision detection radius

// Spawn rate tracking
let spawnCount = 0;
let lastSpawnTime = performance.now();
let spawnRate = 0.0; // spawns per second
const SPAWN_RATE_UPDATE_INTERVAL = 1000; // Update every second

// Pattern Generators
function initRandom(start, pos, vel) {
    for (let i = 0; i < start; ++i) {
        pos[i * 4] = Math.random() * 2 - 1;
        pos[i * 4 + 1] = Math.random() * 2 - 1;
        pos[i * 4 + 2] = 0.0;
        pos[i * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

        // Tangential velocity for CCW rotation
        // v_tan = k / (r + 0.1)
        const x = pos[i * 4];
        const y = pos[i * 4 + 1];
        const r = Math.sqrt(x * x + y * y);
        const k = 0.02 * Math.sqrt(start / 50);
        const v = k / (r + 0.1);

        // Normalized tangent direction: (-y/r, x/r)
        // vel = v * dir
        if (r > 0.0001) {
            vel[i * 4] = (-y / r) * v;
            vel[i * 4 + 1] = (x / r) * v;
        } else {
            vel[i * 4] = 0;
            vel[i * 4 + 1] = 0;
        }
        vel[i * 4 + 2] = 0;
        vel[i * 4 + 3] = 0;
    }
}

function initGalaxy(start, pos, vel) {
    const arms = 3;
    const armSeparation = (2 * Math.PI) / arms;
    for (let i = 0; i < start; ++i) {
        const dist = Math.random(); // 0 to 1
        const angle = dist * 5 + (Math.floor(i % arms) * armSeparation);
        const x = Math.cos(angle) * dist * 0.8;
        const y = Math.sin(angle) * dist * 0.8;

        // Add some noise
        const noiseX = (Math.random() - 0.5) * 0.1;
        const noiseY = (Math.random() - 0.5) * 0.1;

        pos[i * 4] = x + noiseX;
        pos[i * 4 + 1] = y + noiseY;
        pos[i * 4 + 2] = 0.0;
        pos[i * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

        // Orbital velocity approximation
        const v = 0.015 / (Math.sqrt(dist) + 0.1);
        vel[i * 4] = -Math.sin(angle) * v;
        vel[i * 4 + 1] = Math.cos(angle) * v;
        vel[i * 4 + 2] = 0;
        vel[i * 4 + 3] = 0;
    }
}

function initSphere(start, pos, vel) {
    for (let i = 0; i < start; ++i) {
        const r = Math.sqrt(Math.random()) * 0.8;
        const theta = Math.random() * 2 * Math.PI;
        pos[i * 4] = r * Math.cos(theta);
        pos[i * 4 + 1] = r * Math.sin(theta);
        pos[i * 4 + 2] = 0.0;
        pos[i * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

        // Tangential velocity
        const x = pos[i * 4];
        const y = pos[i * 4 + 1];
        const dist = Math.sqrt(x * x + y * y);
        const k = 0.02 * Math.sqrt(start / 50);
        const v = k / (dist + 0.1);

        if (dist > 0.0001) {
            vel[i * 4] = (-y / dist) * v;
            vel[i * 4 + 1] = (x / dist) * v;
        } else {
            vel[i * 4] = 0;
            vel[i * 4 + 1] = 0;
        }
        vel[i * 4 + 2] = 0;
        vel[i * 4 + 3] = 0;
    }
}

function initGrid(start, pos, vel) {
    const cols = Math.ceil(Math.sqrt(start));
    const spacing = 1.6 / cols;
    for (let i = 0; i < start; ++i) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        pos[i * 4] = -0.8 + col * spacing;
        pos[i * 4 + 1] = -0.8 + row * spacing;
        pos[i * 4 + 2] = 0.0;
        pos[i * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

        // Tangential velocity
        const x = pos[i * 4];
        const y = pos[i * 4 + 1];
        const dist = Math.sqrt(x * x + y * y);
        const k = 0.02 * Math.sqrt(start / 50);
        const v = k / (dist + 0.1);

        if (dist > 0.0001) {
            vel[i * 4] = (-y / dist) * v;
            vel[i * 4 + 1] = (x / dist) * v;
        } else {
            vel[i * 4] = 0;
            vel[i * 4 + 1] = 0;
        }
        vel[i * 4 + 2] = 0;
        vel[i * 4 + 3] = 0;
    }
}

function clearBodies() {
    toDormant();
    resetSpawnRate();
    // Update textures with cleared data
    gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, nextPosTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, curVelTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindTexture(gl.TEXTURE_2D, nextVelTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    console.log('Cleared all bodies');
}

function restartSim() {
    toDormant();
    resetSpawnRate();
    let slider = document.getElementById('bodyCountSlider');
    let start = Math.min(Number(slider ? slider.value : 50), N);

    if (currentPattern === 'galaxy') {
        initGalaxy(start, posData, velData);
    } else if (currentPattern === 'sphere') {
        initSphere(start, posData, velData);
    } else if (currentPattern === 'grid') {
        initGrid(start, posData, velData);
    } else {
        initRandom(start, posData, velData);
    }
    activeBodies = start;
    gl.bindTexture(gl.TEXTURE_2D, curPosTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, nextPosTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, curVelTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindTexture(gl.TEXTURE_2D, nextVelTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    console.log('Restarted with', activeBodies, 'bodies');
}
// Create ping-pong position/velocity textures and framebuffers
let posTexA = createTexture(side, side, posData);
let posTexB = createTexture(side, side, posData);
let velTexA = createTexture(side, side, velData);
let velTexB = createTexture(side, side, velData);
let posFBA = createFBO(posTexA);
let posFBB = createFBO(posTexB);
let velFBA = createFBO(velTexA);
let velFBB = createFBO(velTexB);

let curPosTex = posTexA, nextPosTex = posTexB;
let curVelTex = velTexA, nextVelTex = velTexB;
let curPosFB = posFBA, nextPosFB = posFBB;
let curVelFB = velFBA, nextVelFB = velFBB;

// Quad geometry
const quadVerts = new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1
]);
const quadVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

// Vertex shader (shared)
const quadVS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos*0.5 + 0.5; gl_Position = vec4(aPos,0,1); }
`;

// Fragment shader: velocity update (all-pairs, naive N^2)
const velFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outVel;

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uN;
uniform float uSide;
uniform float uDT;
uniform float uG;

#define SOFTEN 0.02
#define DAMP 0.997
void main(){
    ivec2 uv = ivec2(vUV * uSide);
    vec4 myPos = texelFetch(uPos, uv, 0);
    vec4 myVel = texelFetch(uVel, uv, 0);
    vec3 force = vec3(0.0);
    for(int x=0; x<int(uSide); ++x) {
        for(int y=0; y<int(uSide); ++y) {
            vec4 other = texelFetch(uPos, ivec2(x,y), 0);
            float dx = other.x-myPos.x;
            float dy = other.y-myPos.y;
            float distSqr = dx*dx+dy*dy+SOFTEN;
            float invDist = 1.0/sqrt(distSqr);
            float f = (uG * other.w) * invDist * invDist;
            if(distSqr>0.0) {
                force.x += dx * f;
                force.y += dy * f;
            }
        }
    }
    vec3 vel = myVel.xyz + force * uDT;
    // Clamp max velocity (large value, keep stable)
    float vlen = length(vel.xy);
    if (vlen > 0.03) vel.xy = normalize(vel.xy) * 0.03;
    // Add light damping
    float damping = pow(DAMP, uDT);
    outVel = vec4(vel.xy * damping, 0.0, 0.0);
}
`;

// Fragment shader: position update
const posFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outPos;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDT;
uniform float uSide;
void main(){
    ivec2 uv = ivec2(vUV * uSide);
    vec4 pos = texelFetch(uPos, uv, 0);
    vec4 vel = texelFetch(uVel, uv, 0);
    vec2 npos = pos.xy + vel.xy * uDT;
    float mass = pos.w;
    // Destroy bodies that hit the border (set mass to 0)
    if (npos.x < -1.0 || npos.x > 1.0 || npos.y < -1.0 || npos.y > 1.0) {
        mass = 0.0; // Destroy body
    }
    outPos = vec4(npos, 0, mass);
}
`;

// Fragment shader: collision detection (marks slower bodies for destruction)
const collisionFS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outCollision; // .x = shouldDestroy (1.0 if yes, 0.0 if no), .y = mySpeed, .z = otherSpeed, .w = otherIndex
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uSide;
uniform float uCollisionRadius;
uniform float uActiveBodies;
void main(){
    ivec2 uv = ivec2(vUV * uSide);
    int sideInt = int(uSide);
    int idx = uv.y * sideInt + uv.x;
    if (float(idx) >= uActiveBodies) {
        outCollision = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    
    vec4 myPos = texelFetch(uPos, uv, 0);
    vec4 myVel = texelFetch(uVel, uv, 0);
    
    // Skip if already destroyed (mass = 0)
    if (myPos.w <= 0.0) {
        outCollision = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    
    float mySpeed = length(myVel.xy);
    float shouldDestroy = 0.0;
    float maxOtherSpeed = 0.0;
    float colliderIdx = -1.0;
    
    // Check collisions with all other bodies
    for(int x=0; x<sideInt; ++x) {
        for(int y=0; y<sideInt; ++y) {
            int otherIdx = y * sideInt + x;
            if (otherIdx == idx) continue; // Skip self
            if (float(otherIdx) >= uActiveBodies) continue;
            
            vec4 otherPos = texelFetch(uPos, ivec2(x,y), 0);
            vec4 otherVel = texelFetch(uVel, ivec2(x,y), 0);
            
            // Skip if other is destroyed
            if (otherPos.w <= 0.0) continue;
            
            float dx = otherPos.x - myPos.x;
            float dy = otherPos.y - myPos.y;
            float distSqr = dx*dx + dy*dy;
            float dist = sqrt(distSqr);
            
            // Check if collision occurred
            if (dist < uCollisionRadius && dist > 0.001) {
                float otherSpeed = length(otherVel.xy);
                float speedDiff = abs(otherSpeed - mySpeed);
                float speedThreshold = 0.0001; // Very small threshold for "equal" speeds
                
                // Determine which body to destroy:
                // If speeds are very similar (within threshold), destroy the lighter body
                // Otherwise, destroy the slower body
                bool shouldDestroyThis = false;
                
                if (speedDiff < speedThreshold) {
                    // Speeds are essentially equal - destroy lighter body
                    if (otherPos.w > myPos.w) {
                        shouldDestroyThis = true;
                    }
                } else {
                    // Speeds differ - destroy slower body
                    if (otherSpeed > mySpeed) {
                        shouldDestroyThis = true;
                    }
                }
                
                if (shouldDestroyThis) {
                    shouldDestroy = 1.0;
                    if (otherSpeed > maxOtherSpeed) {
                        maxOtherSpeed = otherSpeed;
                        colliderIdx = float(otherIdx);
                    }
                }
            }
        }
    }
    
    outCollision = vec4(shouldDestroy, mySpeed, maxOtherSpeed, colliderIdx);
}
`;

// Draw shader (draw points to screen, sampling position tex)
const drawVS = `#version 300 es
in float aIdx;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uSide;
out float vSpeed;
void main() {
    float idxF = aIdx;
    float x = mod(idxF, uSide);
    float y = floor(idxF/uSide);
    vec4 pos = texelFetch(uPos, ivec2(int(x),int(y)), 0);
    vec4 vel = texelFetch(uVel, ivec2(int(x),int(y)), 0);
    vSpeed = length(vel.xy);
    gl_Position = vec4(pos.xy, 0, 1);
    gl_PointSize = 12.0;
}
`;
const drawFS = `#version 300 es
precision highp float;
in float vSpeed;
out vec4 col;
void main(){
    // Speed range for color interpolation
    float lo = 0.0;
    float hi = 0.02;
    float t = clamp((vSpeed-lo)/(hi-lo), 0.0, 1.0);
    
    // High contrast colors for beige background
    // Low speed: Dark Orange/Red (#C2410C) -> vec3(0.76, 0.25, 0.05)
    // High speed: Deep Purple/Indigo (#4338CA) -> vec3(0.26, 0.22, 0.79)
    
    vec3 colorLow = vec3(0.76, 0.25, 0.05);
    vec3 colorHigh = vec3(0.26, 0.22, 0.79);
    
    vec3 finalColor = mix(colorLow, colorHigh, t);
    
    col = vec4(finalColor, 1.0);
    
    // Circular point shape
    vec2 c = gl_PointCoord-vec2(0.5);
    if (dot(c,c) > 0.25) discard;
}
`;

// Create programs
const velProg = createProgram(quadVS, velFS);
const posProg = createProgram(quadVS, posFS);
const drawProg = createProgram(drawVS, drawFS);
const collisionProg = createProgram(quadVS, collisionFS);

// Collision detection texture and framebuffer
let collisionTex = createTexture(side, side, null);
let collisionFB = createFBO(collisionTex);
let collisionData = new Float32Array(side * side * 4);

// Setup VAOs/buffers
const idxData = new Float32Array(N);
for (let i = 0; i < N; ++i) idxData[i] = i;
const idxVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, idxVBO);
gl.bufferData(gl.ARRAY_BUFFER, idxData, gl.STATIC_DRAW);
const drawVAO = gl.createVertexArray();
gl.bindVertexArray(drawVAO);
const drawAidxLoc = gl.getAttribLocation(drawProg, 'aIdx');
gl.enableVertexAttribArray(drawAidxLoc);
gl.vertexAttribPointer(drawAidxLoc, 1, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// Remove all step back code. No HISTORY_LENGTH, histIdx, histSize, positionHistory, velocityHistory, saveHistory, restoreHistory, or any related logic.
// Remove the event hookup for 'stepBackBtn' as well.
// Clean logic regarding history in the step() function: omit saveHistory();

function handleBorderDestruction() {
    // Read current position and velocity data to check for border destruction
    let tempFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tempFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curPosTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curVelTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tempFB);

    // Find bodies destroyed at borders (mass = 0)
    const borderDestroyedBodies = [];
    for (let i = 0; i < activeBodies; ++i) {
        const idx = i * 4;
        const mass = posData[idx + 3];
        if (mass <= 0.0) {
            // Check if it was destroyed at border (position is at or beyond boundary)
            const px = posData[idx];
            const py = posData[idx + 1];
            if (px <= -1.0 || px >= 1.0 || py <= -1.0 || py >= 1.0) {
                borderDestroyedBodies.push(i);
            }
        }
    }

    if (borderDestroyedBodies.length === 0) return;

    if (evolveMode) {
        // Spawn new bodies for each border-destroyed body
        for (const idx of borderDestroyedBodies) {
            // Random position on map
            const px = (Math.random() * 2 - 1) * 0.9; // Keep within bounds
            const py = (Math.random() * 2 - 1) * 0.9;

            // Strong initial impulse to escape coalesced masses
            const angle = Math.random() * 2 * Math.PI;
            const speed = 0.02 + Math.random() * 0.02; // Strong speed range (0.02-0.04)
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;

            // Reuse the destroyed body slot
            posData[idx * 4] = px;
            posData[idx * 4 + 1] = py;
            posData[idx * 4 + 2] = 0.0;
            posData[idx * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

            velData[idx * 4] = vx;
            velData[idx * 4 + 1] = vy;
            velData[idx * 4 + 2] = 0.0;
            velData[idx * 4 + 3] = 0.0;

            // Track spawn
            spawnCount++;
        }
    }
    // If not in evolve mode, bodies are just destroyed (mass already set to 0)

    // Update textures with modified data
    gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, nextPosTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, curVelTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindTexture(gl.TEXTURE_2D, nextVelTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
}

function handleCollisions() {
    if (!evolveMode) return;

    // Run collision detection pass
    gl.useProgram(collisionProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, collisionFB);
    gl.viewport(0, 0, side, side);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    const loc = gl.getAttribLocation(collisionProg, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.uniform1i(gl.getUniformLocation(collisionProg, 'uPos'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, curVelTex);
    gl.uniform1i(gl.getUniformLocation(collisionProg, 'uVel'), 1);
    gl.uniform1f(gl.getUniformLocation(collisionProg, 'uSide'), side);
    gl.uniform1f(gl.getUniformLocation(collisionProg, 'uCollisionRadius'), COLLISION_RADIUS);
    gl.uniform1f(gl.getUniformLocation(collisionProg, 'uActiveBodies'), activeBodies);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(loc);

    // Read collision results back to CPU
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, collisionData);

    // Read current position and velocity data
    let tempFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tempFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curPosTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curVelTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tempFB);

    // Process collisions: destroy slower bodies and spawn new ones
    const bodiesToDestroy = [];
    for (let i = 0; i < activeBodies; ++i) {
        const idx = i * 4;
        const shouldDestroy = collisionData[idx]; // .x component
        if (shouldDestroy > 0.5) {
            bodiesToDestroy.push(i);
        }
    }

    // Destroy bodies (set mass to 0)
    for (const idx of bodiesToDestroy) {
        posData[idx * 4 + 3] = 0.0; // Set mass to 0
        velData[idx * 4] = 0.0;
        velData[idx * 4 + 1] = 0.0;
        velData[idx * 4 + 2] = 0.0;
        velData[idx * 4 + 3] = 0.0;
    }

    // Spawn new bodies for each destroyed body
    for (const idx of bodiesToDestroy) {
        // Random position on map
        const px = (Math.random() * 2 - 1) * 0.9; // Keep within bounds
        const py = (Math.random() * 2 - 1) * 0.9;

        // Strong initial impulse to escape coalesced masses
        // Increased significantly to counteract gravitational pull from clusters
        const angle = Math.random() * 2 * Math.PI;
        const speed = 0.02 + Math.random() * 0.02; // Strong speed range (0.02-0.04)
        const vx = Math.cos(angle) * speed;
        const vy = Math.sin(angle) * speed;

        // Reuse the destroyed body slot
        posData[idx * 4] = px;
        posData[idx * 4 + 1] = py;
        posData[idx * 4 + 2] = 0.0;
        posData[idx * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5

        velData[idx * 4] = vx;
        velData[idx * 4 + 1] = vy;
        velData[idx * 4 + 2] = 0.0;
        velData[idx * 4 + 3] = 0.0;

        // Track spawn
        spawnCount++;
    }

    // Update textures with modified data
    if (bodiesToDestroy.length > 0) {
        gl.bindTexture(gl.TEXTURE_2D, curPosTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
        gl.bindTexture(gl.TEXTURE_2D, nextPosTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
        gl.bindTexture(gl.TEXTURE_2D, curVelTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
        gl.bindTexture(gl.TEXTURE_2D, nextVelTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    }
}

function step(dt) {
    // Update velocities (write to nextVelFB, read from curPosTex, curVelTex)
    gl.useProgram(velProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextVelFB);
    gl.viewport(0, 0, side, side);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    const loc = gl.getAttribLocation(velProg, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.uniform1i(gl.getUniformLocation(velProg, 'uPos'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, curVelTex);
    gl.uniform1i(gl.getUniformLocation(velProg, 'uVel'), 1);
    gl.uniform1f(gl.getUniformLocation(velProg, 'uN'), N);
    gl.uniform1f(gl.getUniformLocation(velProg, 'uSide'), side);
    gl.uniform1f(gl.getUniformLocation(velProg, 'uDT'), dt);
    gl.uniform1f(gl.getUniformLocation(velProg, 'uG'), getGravity());
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(loc);
    // Update positions (write to nextPosFB, read from curPosTex, nextVelTex)
    gl.useProgram(posProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextPosFB);
    gl.viewport(0, 0, side, side);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    const locp = gl.getAttribLocation(posProg, 'aPos');
    gl.enableVertexAttribArray(locp);
    gl.vertexAttribPointer(locp, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.uniform1i(gl.getUniformLocation(posProg, 'uPos'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, nextVelTex);
    gl.uniform1i(gl.getUniformLocation(posProg, 'uVel'), 1);
    gl.uniform1f(gl.getUniformLocation(posProg, 'uDT'), dt);
    gl.uniform1f(gl.getUniformLocation(posProg, 'uSide'), side);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(locp);
    // Swap references: next becomes current for next iteration.
    [curVelTex, nextVelTex] = [nextVelTex, curVelTex];
    [curVelFB, nextVelFB] = [nextVelFB, curVelFB];
    [curPosTex, nextPosTex] = [nextPosTex, curPosTex];
    [curPosFB, nextPosFB] = [nextPosFB, curPosFB];

    // Handle border destruction (bodies that hit borders)
    handleBorderDestruction();

    // Handle collisions in Evolve mode
    handleCollisions();
}

// Simulation and rendering - loop over activeBodies only:
function render() {
    gl.useProgram(drawProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, curPosTex);
    gl.uniform1i(gl.getUniformLocation(drawProg, 'uPos'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curVelTex);
    gl.uniform1i(gl.getUniformLocation(drawProg, 'uVel'), 1);
    gl.uniform1f(gl.getUniformLocation(drawProg, 'uSide'), side);
    gl.bindVertexArray(drawVAO);
    gl.drawArrays(gl.POINTS, 0, activeBodies);
    gl.bindVertexArray(null);
    if (window._firstRender === undefined) {
        console.log('Rendering', activeBodies, 'bodies');
        window._firstRender = true;
    }
}

// Simulation control state
let isPaused = false;
let doStep = false;
function pause() { isPaused = true; }
function resume() { isPaused = false; }
function stepSim() { doStep = true; }
function getSimSpeed() {
    const slider = document.getElementById('speedSlider');
    if (!slider) return 1.0;
    return Number(slider.value) / 100.0; // Now supports up to 4.0x (400/100)
}

function getGravity() {
    const slider = document.getElementById('gravitySlider');
    if (!slider) return 0.000003;
    // Slider 0-100, default 30 (3.0 micro).
    // Value 30 -> 0.000003
    // So value * 0.0000001
    return Number(slider.value) * 0.0000001;
}

function resetSpawnRate() {
    spawnCount = 0;
    lastSpawnTime = performance.now();
    spawnRate = 0.0;
    const spawnRateElement = document.getElementById('spawnRateDisplay');
    if (spawnRateElement) {
        spawnRateElement.textContent = '0.00';
    }
}

function updateSpawnRate() {
    const now = performance.now();
    const elapsed = now - lastSpawnTime;

    if (elapsed >= SPAWN_RATE_UPDATE_INTERVAL) {
        spawnRate = (spawnCount / elapsed) * 1000; // Convert to per second
        spawnCount = 0;
        lastSpawnTime = now;

        // Update UI
        const spawnRateElement = document.getElementById('spawnRateDisplay');
        if (spawnRateElement) {
            spawnRateElement.textContent = spawnRate.toFixed(2);
        }
    }
}
// UI wiring
window.addEventListener('DOMContentLoaded', () => {
    const bindClick = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };
    bindClick('pauseBtn', pause);
    bindClick('resumeBtn', resume);
    bindClick('stepBtn', stepSim);
    bindClick('restartBtn', restartSim);
    bindClick('clearBtn', clearBodies);

    // Split Button Logic
    const patternBtn = document.getElementById('patternBtn');
    const patternDropdown = document.getElementById('patternDropdown');

    if (patternBtn && patternDropdown) {
        patternBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            patternDropdown.classList.toggle('hidden');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!patternBtn.contains(e.target) && !patternDropdown.contains(e.target)) {
                patternDropdown.classList.add('hidden');
            }
        });

        // Pattern selection
        document.querySelectorAll('.pattern-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                currentPattern = e.target.dataset.pattern;
                patternDropdown.classList.add('hidden');
                restartSim();
            });
        });
    }

    const drawButton = document.getElementById('drawBtn');
    if (drawButton) {
        drawButton.addEventListener('click', () => {
            if (isDrawingMode) disableDrawMode();
            else enableDrawMode();
        });
    }

    const evolveButton = document.getElementById('evolveBtn');
    if (evolveButton) {
        evolveButton.addEventListener('click', () => {
            evolveMode = !evolveMode;
            if (evolveMode) {
                evolveButton.classList.add('ring-4', 'ring-yellow-300', 'ring-offset-2', 'ring-offset-slate-900');
                evolveButton.classList.remove('bg-amber-600', 'hover:bg-amber-500');
                evolveButton.classList.add('bg-yellow-500', 'hover:bg-yellow-400');
            } else {
                evolveButton.classList.remove('ring-4', 'ring-yellow-300', 'ring-offset-2', 'ring-offset-slate-900');
                evolveButton.classList.remove('bg-yellow-500', 'hover:bg-yellow-400');
                evolveButton.classList.add('bg-amber-600', 'hover:bg-amber-500');
                resetSpawnRate(); // Reset when evolve mode is turned off
            }
        });
    }
});

// -- Drawing tool state --
let isDrawingMode = false;
let isMouseDown = false;

function enableDrawMode() {
    isDrawingMode = true;
    const btn = document.getElementById('drawBtn');
    if (btn) btn.classList.add('ring-4', 'ring-yellow-300', 'ring-offset-2', 'ring-offset-slate-900');
    canvas.classList.add('cursor-crosshair');
}
function disableDrawMode() {
    isDrawingMode = false;
    const btn = document.getElementById('drawBtn');
    if (btn) btn.classList.remove('ring-4', 'ring-yellow-300', 'ring-offset-2', 'ring-offset-slate-900');
    canvas.classList.remove('cursor-crosshair');
}

function canvasToSimCoords(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
    return [x, -y];
}

canvas.addEventListener('mousedown', ev => {
    if (!isDrawingMode) return;
    isMouseDown = true; paintBody(ev);
});
canvas.addEventListener('mouseup', ev => {
    if (!isDrawingMode) return;
    isMouseDown = false;
});
canvas.addEventListener('mouseleave', ev => {
    if (!isDrawingMode) return;
    isMouseDown = false;
});
canvas.addEventListener('mousemove', ev => {
    if (!isDrawingMode || !isMouseDown) return;
    paintBody(ev);
});

// Painting new bodies:
function findNextFreeBody() {
    if (activeBodies < N) return activeBodies;
    return -1;
}
function addBody(px, py) {
    let i = findNextFreeBody();
    if (i < 0) return;

    // Read current GPU state back into JS arrays to preserve simulation state
    // Create temporary framebuffer to read from current position texture
    let tempFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tempFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curPosTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, posData);

    // Read velocity texture
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, curVelTex, 0);
    gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, velData);

    // Unbind framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tempFB);

    // Now update the new body slot with fresh data
    posData[i * 4] = px;
    posData[i * 4 + 1] = py;
    posData[i * 4 + 2] = 0;
    posData[i * 4 + 3] = 0.5 + Math.random() * 2.0; // Random mass: 0.5 to 2.5
    velData[i * 4] = (Math.random() - 0.5) * 0.005;
    velData[i * 4 + 1] = (Math.random() - 0.5) * 0.005;
    velData[i * 4 + 2] = 0;
    velData[i * 4 + 3] = 0;
    activeBodies++;

    // Update textures (both ping and pong) with the synced data
    gl.bindTexture(gl.TEXTURE_2D, curPosTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, nextPosTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, posData);
    gl.bindTexture(gl.TEXTURE_2D, curVelTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    gl.bindTexture(gl.TEXTURE_2D, nextVelTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, velData);
    console.log('Added body:', activeBodies, '/', N);
}
function paintBody(ev) {
    let [x, y] = canvasToSimCoords(ev);
    addBody(x, y);
}

function animate() {
    if (!isPaused || doStep) {
        const speed = getSimSpeed();
        step(1.0 * speed);
        doStep = false;
    }
    render();
    updateSpawnRate();
    requestAnimationFrame(animate);
}
animate();
