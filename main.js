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
let posData = new Float32Array(side*side*4), velData = new Float32Array(side*side*4);
// Initialize all as unused
toDormant();
function toDormant() {
    for (let i = 0; i < N; ++i) {
        posData[i*4] = 0; posData[i*4+1] = 0; posData[i*4+2] = 0; posData[i*4+3] = 0; // mass=0 => unused
        velData[i*4] = 0; velData[i*4+1] = 0; velData[i*4+2] = 0; velData[i*4+3] = 0;
    }
    activeBodies = 0;
}
// During restart, clear all and repopulate some
function restartSim() {
    toDormant();
    let slider = document.getElementById('bodyCountSlider');
    let start = Math.min(Number(slider ? slider.value : 50), N);
    for (let i=0; i<start; ++i) {
        posData[i*4] = Math.random()*2-1;
        posData[i*4+1] = Math.random()*2-1;
        posData[i*4+2] = 0.0;
        posData[i*4+3] = 1.0 + Math.random();
        velData[i*4] = (Math.random()-0.5)*0.001;
        velData[i*4+1] = (Math.random()-0.5)*0.001;
        velData[i*4+2] = 0;
        velData[i*4+3] = 0;
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
    -1,-1, 1,-1, -1,1,
    -1,1, 1,-1, 1,1
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

#define G 0.00004
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
            float f = (G * other.w) * invDist * invDist;
            if(distSqr>0.0) {
                force.x += dx * f;
                force.y += dy * f;
            }
        }
    }
    vec3 vel = myVel.xyz + force;
    // Clamp max velocity (large value, keep stable)
    float vlen = length(vel.xy);
    if (vlen > 0.03) vel.xy = normalize(vel.xy) * 0.03;
    // Add light damping
    outVel = vec4(vel.xy * DAMP, 0.0, 0.0);
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
    // Clamp/bounce at edges
    if (npos.x < -1.0) { npos.x = -1.0; vel.x *= -0.7; }
    if (npos.x >  1.0) { npos.x =  1.0; vel.x *= -0.7; }
    if (npos.y < -1.0) { npos.y = -1.0; vel.y *= -0.7; }
    if (npos.y >  1.0) { npos.y =  1.0; vel.y *= -0.7; }
    outPos = vec4(npos, 0, pos.w); // keep mass in .w
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
    gl_PointSize = 7.0;
}
`;
const drawFS = `#version 300 es
precision highp float;
in float vSpeed;
out vec4 col;
void main(){
    float lo = 0.0, hi = 0.03;
    float t = clamp((vSpeed-lo)/(hi-lo), 0.0, 1.0);
    // Red for slow, blue for fast
    col = vec4(1.0-t, 0.0, t, 1.0);
    // Make discs, not squares
    vec2 c = gl_PointCoord-vec2(0.5);
    if (dot(c,c) > 0.25) discard;
}
`;

// Create programs
const velProg = createProgram(quadVS, velFS);
const posProg = createProgram(quadVS, posFS);
const drawProg = createProgram(drawVS, drawFS);

// Setup VAOs/buffers
const idxData = new Float32Array(N);
for(let i=0;i<N;++i) idxData[i]=i;
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

function step(dt) {
    // Update velocities (write to nextVelFB, read from curPosTex, curVelTex)
    gl.useProgram(velProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextVelFB);
    gl.viewport(0,0,side,side);
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
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(loc);
    // Update positions (write to nextPosFB, read from curPosTex, nextVelTex)
    gl.useProgram(posProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextPosFB);
    gl.viewport(0,0,side,side);
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
}

// Simulation and rendering - loop over activeBodies only:
function render() {
    gl.useProgram(drawProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,canvas.width,canvas.height);
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
  return Number(slider.value) / 10.0;
}
// UI wiring
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pauseBtn').onclick = pause;
    document.getElementById('resumeBtn').onclick = resume;
    document.getElementById('stepBtn').onclick = stepSim;
    document.getElementById('restartBtn').onclick = restartSim;
    let slider = document.getElementById('bodyCountSlider');
    let label = document.getElementById('bodyCountLabel');
    if (slider && label) {
        slider.value = '50'; label.textContent = '50'; userBodyCount = 50;
        slider.addEventListener('input', e => {
            label.textContent = slider.value;
            userBodyCount = Number(slider.value);
        });
    }
});

// -- Drawing tool state --
let isDrawingMode = false;
let isMouseDown = false;

function enableDrawMode() {
    isDrawingMode = true;
    document.getElementById('drawBtn').classList.add('active');
    canvas.classList.add('drawing');
}
function disableDrawMode() {
    isDrawingMode = false;
    document.getElementById('drawBtn').classList.remove('active');
    canvas.classList.remove('drawing');
}

// Toggle Draw Bodies mode
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('drawBtn').onclick = function() {
        if (!isDrawingMode) enableDrawMode();
        else disableDrawMode();
    };
});

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
    posData[i*4]   = px;
    posData[i*4+1] = py;
    posData[i*4+2] = 0;
    posData[i*4+3] = 1.2 + Math.random(); // mass > 0 => used
    velData[i*4]   = (Math.random()-0.5)*0.005;
    velData[i*4+1] = (Math.random()-0.5)*0.005;
    velData[i*4+2] = 0;
    velData[i*4+3] = 0;
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
    requestAnimationFrame(animate);
}
animate();
