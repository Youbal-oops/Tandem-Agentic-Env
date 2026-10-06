// The Tandem system: a star (the codebase) and two planets (the agents) in orbit.
// Each planet is an instrument for what its agent is doing:
//   inner HUD ring ....... context window used (cool -> amber -> red as it fills)
//   outer thin ring ...... usage limit used (5 hour window)
//   lattice shield ....... permission mode (read-only / ask / edit / auto)
//   small moons .......... one per running tool, coloured by kind of tool
//   large moons .......... sub-agents
//   debris belt .......... every tool call made this session, coloured by kind
//   beads ................ the agent's plan, done / active / to do
//   far satellites ....... connected MCP servers
//   pulses ............... thinking;  beacon ... waiting for your approval
//   flares / shockwaves .. errors, denials, context compaction
// The star is the repo: edits fly into it as packets of light.
// Occasional ships, meteors, comets and asteroids pass through to keep the sky alive.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { AGENT_LOOK, CLASS_COLORS } from './looks.js';
export { AGENT_LOOK, CLASS_COLORS };
const SHIELD = {
  plan: ['#74e6ff', 0.34],
  read: ['#74e6ff', 0.34],
  ask: ['#ffd27a', 0.22],
  edit: ['#6ee7a0', 0.12],
  auto: ['#c79bff', 0.22],
};
const MCP_COLORS = { connected: '#6ee7a0', pending: '#ffd27a', 'needs-auth': '#ff6b6b', failed: '#ff6b6b' };
const SUN_RADIUS = 38;

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+10.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
  return 105.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*snoise(p); p*=2.03; a*=.5; } return s; }
`;

function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.25)') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, mid);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.shadowColor = 'white';
  g.shadowBlur = 10;
  g.beginPath();
  g.arc(128, 128, 104, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}
function bandTexture(hex) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 4;
  const g = c.getContext('2d');
  const col = new THREE.Color(hex);
  for (let x = 0; x < 512; x++) {
    const t = x / 511;
    const a = (Math.sin(t * 80) * 0.5 + 0.5) * (Math.sin(t * 23 + 1) * 0.35 + 0.65) * Math.sin(Math.PI * t) ** 0.6;
    g.fillStyle = `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${(a * 0.9).toFixed(3)})`;
    g.fillRect(x, 0, 1, 4);
  }
  return new THREE.CanvasTexture(c);
}

/** A HUD gauge: an arc that fills clockwise from the top, billboarded to the camera. */
function gaugeRing(inner, outer, baseColor, warn = true) {
  const u = { uFill: { value: 0 }, uColor: { value: new THREE.Color(baseColor) }, uTime: { value: 0 }, uWarn: { value: warn ? 1 : 0 }, uAlpha: { value: 1 } };
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 160, 1),
    new THREE.ShaderMaterial({
      uniforms: u,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uFill, uTime, uWarn, uAlpha; uniform vec3 uColor; varying vec2 vP;
        void main(){
          float ang = atan(vP.x, vP.y);
          float a = (ang < 0. ? ang + 6.2831853 : ang) / 6.2831853;
          float filled = step(a, uFill);
          vec3 col = uColor;
          float warn = smoothstep(0.6, 0.85, uFill) * uWarn;
          float crit = smoothstep(0.85, 0.97, uFill) * uWarn;
          col = mix(col, vec3(1.0, 0.72, 0.25), warn);
          col = mix(col, vec3(1.0, 0.26, 0.2), crit);
          float tick = smoothstep(0.47, 0.5, abs(fract(a * 20.) - 0.5));
          float head = exp(-pow((a - uFill) * 55., 2.0)) * step(0.002, uFill);
          float pulse = 1.0 + crit * 0.5 * sin(uTime * 9.0);
          float alpha = filled * (0.92 - tick * 0.45) + (1.0 - filled) * (0.07 + tick * 0.22) + head * 0.9;
          gl_FragColor = vec4(col * (1.0 + head * 1.6) * pulse, alpha * uAlpha);
        }`,
    }),
  );
  mesh.userData.u = u;
  return mesh;
}

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  // Full quality as before. Only a GPU that cannot keep up gets a lower step (see the watchdog), and that is remembered.
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75, Number((() => { try { return localStorage.getItem('tandem:scene-dpr'); } catch { return 0; } })()) || 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x02030a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 9000);

  // ---------------------------------------------------------------- backdrop
  {
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(3200 + Math.random() * 600);
      pos.set([v.x, v.y, v.z], i * 3);
      const k = 0.35 + Math.random() * 0.65;
      const tint = Math.random();
      col.set([k * (0.8 + tint * 0.2), k * 0.85, k * (1 - tint * 0.25)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false })));

    const nebula = (hex, x, y, z, s, o) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hex, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.position.set(x, y, z);
      sp.scale.set(s, s, 1);
      scene.add(sp);
    };
    nebula('#3a1d5e', -1800, 500, -2200, 3600, 0.22);
    nebula('#0b4a6b', 2000, -600, -2000, 3400, 0.2);
    nebula('#6b2a14', 300, 900, 2300, 2800, 0.1);
  }

  // ---------------------------------------------------------------- the star
  const sunU = { uTime: { value: 0 }, uPulse: { value: 0 } };
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: sunU,
      vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main(){ vP=normalize(position); vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform float uTime; uniform float uPulse; varying vec3 vP; varying vec3 vN; varying vec3 vV;
        ${NOISE}
        void main(){
          float n = fbm(vP*2.6 + vec3(uTime*0.05, uTime*0.03, 0.));
          float n2 = fbm(vP*7.0 - vec3(0., uTime*0.08, uTime*0.04));
          float t = clamp(n*0.95 + n2*0.4 + 0.42, 0., 1.);
          vec3 deep = vec3(0.95,0.22,0.03); vec3 mid = vec3(1.0,0.58,0.12); vec3 hot = vec3(1.0,0.9,0.62);
          vec3 c = mix(deep, mid, smoothstep(0.1,0.7,t)); c = mix(c, hot, smoothstep(0.78,1.0,t));
          float f = pow(1.-max(dot(vN,vV),0.), 2.2);
          c = mix(c, vec3(1.0,0.78,0.45), f*0.5);
          gl_FragColor = vec4(c*(0.9+uPulse*1.3), 1.);
        }`,
    }),
  );
  scene.add(sun);
  const corona = (hex, s, o) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hex, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.scale.set(s, s, 1);
    scene.add(sp);
    return sp;
  };
  const coronaA = corona('#ffb347', SUN_RADIUS * 4.6, 0.5);
  const coronaB = corona('#ff5a1f', SUN_RADIUS * 8, 0.13);
  scene.add(new THREE.PointLight(0xffd9a8, 2.2, 0, 0));
  scene.add(new THREE.AmbientLight(0x2a3566, 0.5));

  // ---------------------------------------------------------------- particles (sparks, trails, bursts)
  const MAXP = 1400;
  const P = {
    pos: new Float32Array(MAXP * 3),
    col: new Float32Array(MAXP * 3),
    size: new Float32Array(MAXP),
    alpha: new Float32Array(MAXP),
    vel: new Float32Array(MAXP * 3),
    life: new Float32Array(MAXP),
    max: new Float32Array(MAXP),
    base: new Float32Array(MAXP),
    next: 0,
  };
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(P.pos, 3));
  pg.setAttribute('aColor', new THREE.BufferAttribute(P.col, 3));
  pg.setAttribute('aSize', new THREE.BufferAttribute(P.size, 1));
  pg.setAttribute('aAlpha', new THREE.BufferAttribute(P.alpha, 1));
  const pmat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPx: { value: pixelRatio } },
    vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uPx; varying vec3 vC; varying float vA;
      void main(){ vC=aColor; vA=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=aSize*uPx*(520./-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vC; varying float vA; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; float s=smoothstep(.5,0.,d); gl_FragColor=vec4(vC*s*vA*2.2, s*vA); }`,
  });
  const points = new THREE.Points(pg, pmat);
  points.frustumCulled = false;
  scene.add(points);

  function emit(x, y, z, vx, vy, vz, color, size, life) {
    const i = P.next;
    const k = i * 3;
    P.next = (P.next + 1) % MAXP;
    P.pos[k] = x; P.pos[k + 1] = y; P.pos[k + 2] = z;
    P.vel[k] = vx; P.vel[k + 1] = vy; P.vel[k + 2] = vz;
    P.col[k] = color.r; P.col[k + 1] = color.g; P.col[k + 2] = color.b;
    P.base[i] = size;
    P.size[i] = size;
    P.max[i] = P.life[i] = life;
    P.alpha[i] = 1;
    P.colDirty = true;
  }

  // ---------------------------------------------------------------- planets
  const planets = {};
  const planetGroup = new THREE.Group();
  scene.add(planetGroup);
  const glow = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.4)');
  const ringTex = ringTexture();

  function orbitPoint(o, t) {
    const x = o.a * Math.cos(t);
    const z = o.b * Math.sin(t);
    return new THREE.Vector3(x, z * Math.sin(o.tilt), z * Math.cos(o.tilt));
  }

  const BELT_N = 380;
  const waves = [];
  function wave(p, color, maxMul, dur, opacity = 0.7) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    p.group.add(sp);
    waves.push({ sp, t: 0, dur, r: p.look.radius, maxMul, opacity });
  }

  function addPlanet(id, look) {
    if (planets[id]) return;
    const r = look.radius;
    const u = {
      uTime: { value: 0 },
      uHeat: { value: 0.06 },
      uHover: { value: 0 },
      uAlert: { value: 0 },
      uStyle: { value: look.style },
      uC0: { value: new THREE.Color(look.palette[0]) },
      uC1: { value: new THREE.Color(look.palette[1]) },
      uC2: { value: new THREE.Color(look.palette[2]) },
      uC3: { value: new THREE.Color(look.palette[3]) },
      uRim: { value: new THREE.Color(look.rim) },
    };
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(r, 80, 56),
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vW;
          void main(){ vP=normalize(position); vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform float uTime, uHeat, uHover, uAlert, uStyle; uniform vec3 uC0,uC1,uC2,uC3,uRim; varying vec3 vP; varying vec3 vN; varying vec3 vW;
          ${NOISE}
          void main(){
            vec3 p = vP; vec3 surf;
            if (uStyle < 0.5) {
              float warp = fbm(p*vec3(1.3,3.2,1.3) + vec3(uTime*0.02,0.,0.))*0.4;
              float band = sin((p.y+warp)*15.0 + fbm(p*3.0)*2.4);
              float t = smoothstep(-0.9,0.9,band);
              float t2 = fbm(p*vec3(2.,10.,2.)+13.0)*0.5+0.5;
              surf = mix(mix(uC0,uC1,t), mix(uC2,uC3,t2), 0.42);
              float storm = smoothstep(0.16,0.0,length((p-normalize(vec3(0.7,-0.25,0.65)))*vec3(1.,2.2,1.)));
              surf = mix(surf, uC3, storm*0.7);
            } else {
              float n = fbm(p*2.6 + vec3(0., uTime*0.01, 0.));
              float clouds = smoothstep(0.12, 0.62, fbm(p*vec3(3.5,5.5,3.5) + vec3(uTime*0.03,0.,0.)));
              vec3 ocean = mix(uC0, uC1, smoothstep(-0.45,0.5,n));
              surf = mix(ocean, uC2, smoothstep(0.35,0.7,n)*0.5);
              surf = mix(surf, uC3, clouds*0.75);
              surf = mix(surf, uC3, smoothstep(0.76,0.94,abs(p.y)));
            }
            surf = mix(surf, vec3(1.0,0.2,0.15), uAlert*0.55);
            vec3 N = normalize(vN); vec3 L = normalize(-vW); vec3 V = normalize(cameraPosition - vW);
            float lam = max(dot(N,L),0.);
            float fres = pow(1.-max(dot(N,V),0.), 3.0);
            vec3 col = surf*(0.03 + 0.72*lam) + uRim*fres*(0.10 + lam*0.38);
            // the activity pattern only shows while the planet is busy; at rest its contribution is a fraction of a percent
            float pat = 0.5;
            if (uHeat > 0.1) pat = fbm(p*vec3(3.,9.,3.) + uTime*0.25)*0.5+0.5;
            // activity glow shows as light in the bands, strongest on the night side
            col += surf*uHeat*(0.12+0.5*pat)*(1.0-lam*0.7)*0.9 + uRim*uHeat*fres*0.55;
            col += uRim*uHover*(0.10+fres*0.5);
            gl_FragColor = vec4(min(col, vec3(1.6)),1.);
          }`,
      }),
    );
    const atmU = { uColor: { value: new THREE.Color(look.rim) }, uHeat: u.uHeat, uHover: u.uHover, uCache: { value: 0.4 } };
    const atm = new THREE.Mesh(
      new THREE.SphereGeometry(r * 1.16, 64, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: atmU,
        vertexShader: `varying vec3 vN; void main(){ vN=normalize(normalMatrix*normal); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uHeat; uniform float uHover; uniform float uCache; varying vec3 vN;
          void main(){ float i=pow(max(0.62-dot(vN,vec3(0.,0.,1.)),0.),2.6); gl_FragColor=vec4(uColor*i*(0.9+uCache*1.2+uHeat*2.2+uHover*1.2),i); }`,
      }),
    );
    const hit = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData.agent = id;

    const g = new THREE.Group();
    const tilt = new THREE.Group(); // axial tilt for the spinning body
    tilt.rotation.z = look.style ? 0.38 : 0.12;
    tilt.add(body);
    g.add(tilt, atm);

    let ring = null;
    if (id === 'codex') {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 1.4, r * 2.0, 128, 1),
        new THREE.MeshBasicMaterial({ map: bandTexture(look.hex), color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      const uv = ring.geometry.attributes.uv;
      const posA = ring.geometry.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (Math.hypot(posA.getX(i), posA.getY(i)) - r * 1.4) / (r * 0.6), 0.5);
      ring.rotation.x = Math.PI / 2 + 0.38;
      ring.rotation.y = 0.12;
      g.add(ring);
    }

    // HUD gauges (context, limit)
    const ctxRing = gaugeRing(r * 2.28, r * 2.42, look.hex, true);
    const limRing = gaugeRing(r * 2.5, r * 2.56, '#cfd6ff', true);
    g.add(ctxRing, limRing);

    // shield lattice
    const shieldMat = new THREE.LineBasicMaterial({ color: '#74e6ff', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
    const shield = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(r * 1.32, 2)), shieldMat);
    g.add(shield);

    // beacon + halo
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: '#ffd27a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    beacon.scale.set(r * 5, r * 5, 1);
    g.add(beacon);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: look.hex, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.set(r * 6, r * 6, 1);
    g.add(halo);

    // tool moons (one per running tool)
    const moons = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(look.hex).multiplyScalar(3) }));
      m.visible = false;
      g.add(m);
      moons.push({ mesh: m, cls: 'other', ang: Math.random() * 7, rad: r * (1.55 + (i % 4) * 0.13), speed: 1.1 + Math.random() * 0.9, inc: (Math.random() - 0.5) * 1.1, s: 0 });
    }
    // sub-agent moons
    const subs = [];
    for (let i = 0; i < 4; i++) {
      const grp = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(2.4) }));
      const halo2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: look.hex, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo2.scale.set(5, 5, 1);
      const ring2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: look.hex, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      ring2.scale.set(3.4, 3.4, 1);
      grp.add(core, halo2, ring2);
      grp.visible = false;
      g.add(grp);
      subs.push({ grp, core, halo: halo2, ring: ring2, ang: (i / 4) * 6.28 + 0.5, rad: r * (3.25 + i * 0.12), speed: 0.55 + i * 0.07, inc: 0.35 + i * 0.12, s: 0, active: false });
    }
    // debris belt: every tool call this session
    const beltPos = new Float32Array(BELT_N * 3);
    const beltCol = new Float32Array(BELT_N * 3);
    const beltSeed = new Float32Array(BELT_N);
    for (let i = 0; i < BELT_N; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = r * (3.85 + Math.random() * 0.8);
      beltPos.set([Math.cos(a) * rad, (Math.random() - 0.5) * r * 0.18, Math.sin(a) * rad], i * 3);
      beltSeed[i] = Math.random();
    }
    const beltGeo = new THREE.BufferGeometry();
    beltGeo.setAttribute('position', new THREE.BufferAttribute(beltPos, 3));
    beltGeo.setAttribute('color', new THREE.BufferAttribute(beltCol, 3));
    beltGeo.setDrawRange(0, 0);
    const belt = new THREE.Points(beltGeo, new THREE.PointsMaterial({ size: 3.2, map: glow, alphaTest: 0.01, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    belt.rotation.x = 0.28;
    belt.frustumCulled = false;
    g.add(belt);
    // plan beads
    const beads = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 10), new THREE.MeshBasicMaterial({ color: '#888888' }));
      m.visible = false;
      g.add(m);
      beads.push(m);
    }
    // MCP satellites (far ring)
    const sats = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({ color: '#6ee7a0' }));
      m.visible = false;
      g.add(m);
      sats.push({ mesh: m, ang: (i / 8) * 6.28, rad: r * 5.5, y: (Math.random() - 0.5) * r * 1.2 });
    }

    planetGroup.add(g);
    scene.add(hit);

    // orbit line + trail
    const o = look.orbit;
    const pts = [];
    for (let i = 0; i <= 256; i++) pts.push(orbitPoint(o, (i / 256) * Math.PI * 2));
    const orbitLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: look.hex, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(orbitLine);
    const TRAIL = 120;
    const trailPos = new Float32Array(TRAIL * 3);
    const trailCol = new Float32Array(TRAIL * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.frustumCulled = false;
    scene.add(trail);

    planets[id] = {
      id, look, group: g, tilt, body, atmU, u, ring, beacon, halo, hit, moons, subs, belt, beltGeo, beltSeed, beads, sats, shield, shieldMat, ctxRing, limRing,
      orbitLine, trail, trailPos, trailCol, TRAIL,
      theta: o.phase, speedMul: 1, heat: 0.06, heatTarget: 0.06, hover: 0, hoverTarget: 0, alert: 0,
      busy: false, thinking: false, awaiting: 0, sparkAcc: 0, thinkAcc: 0, tps: 0,
      ctx: 0, tCtx: 0, lim: 0, tLim: 0, cache: 0.4,
      moonCls: [], subStates: [], planStates: [], mcpStates: [], beltSig: '', mode: null,
      pos: new THREE.Vector3(), color: new THREE.Color(look.hex), spin: 0, focus: 0,
    };
  }

  for (const [id, look] of Object.entries(AGENT_LOOK)) addPlanet(id, look);
  // ---------------------------------------------------------------- packets (edit -> star, hand-off comets)
  const packets = [];
  const tmpV = new THREE.Vector3();
  function sendPacket(from, to, color, { dur = 1.3, size = 7, lift = 0.35 } = {}) {
    const a = from.clone();
    const b = to instanceof THREE.Vector3 ? to.clone() : to.pos.clone();
    const ctrl = a.clone().add(b).multiplyScalar(0.5);
    ctrl.y += a.distanceTo(b) * lift + 14;
    packets.push({ a, b, ctrl, color, t: 0, dur, size, target: to instanceof THREE.Vector3 ? null : to, onDone: null });
    return packets[packets.length - 1];
  }
  function bezier(out, a, c, b, t) {
    const u = 1 - t;
    return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
  }

  // ---------------------------------------------------------------- post-processing (adaptive: weak GPUs drop effects)
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.6, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let bloomOn = true;
  let ecoMode = false;
  let quality = 'high';

  // ---------------------------------------------------------------- layout + camera
  const insets = { left: 0, right: 0 };
  let W = 1;
  let H = 1;
  function applyView() {
    camera.aspect = W / H;
    camera.setViewOffset(W, H, -(insets.left - insets.right) / 2, 0, W, H);
    camera.updateProjectionMatrix();
  }
  function resize() {
    W = Math.max(1, host.clientWidth);
    H = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(ecoMode ? 1 : pixelRatio);
    renderer.setSize(W, H);
    composer.setPixelRatio?.(ecoMode ? 1 : pixelRatio);
    composer.setSize(W, H);
    bloom.setSize(W, H);
    pmat.uniforms.uPx.value = ecoMode ? 1 : pixelRatio;
    applyView();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.minDistance = 36;
  controls.maxDistance = 6500;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.7;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.25;

  const OVERVIEW_DIR = new THREE.Vector3(0.0, 0.62, 0.78).normalize();
  const OVERVIEW_DIST = 610;
  camera.position.copy(OVERVIEW_DIR.clone().multiplyScalar(OVERVIEW_DIST));
  controls.target.set(0, 0, 0);

  let selected = null;
  let topDown = true;
  function overviewDistance() {
    const radius = Math.max(245, ...Object.values(planets).map((p) => p.look.orbit.a + 80));
    const usable = Math.max(240, W - insets.left - insets.right);
    return Math.max(610, radius * 3.1 * Math.max(1, H / usable));
  }
  let tween = null;
  function setSelected(id) {
    selected = id;
    controls.autoRotate = !!id || !topDown;
    const now = performance.now();
    if (id) {
      const p = planets[id];
      const radial = p.pos.clone().normalize();
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x);
      const dir = tangent.multiplyScalar(0.9).add(new THREE.Vector3(0, 0.34, 0)).add(radial.multiplyScalar(-0.25)).normalize();
      // far enough to show the gauge rings, belt and moons around the planet
      tween = { until: now + 1900, dist: p.look.radius * 9.5, dir };
    } else {
      tween = { until: now + 1900, dist: overviewDistance(), dir: topDown ? new THREE.Vector3(0, 1, 0.001) : OVERVIEW_DIR.clone() };
    }
  }
  controls.addEventListener('start', () => {
    if (tween) tween.dirLocked = true;
  });

  // ---------------------------------------------------------------- picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverId = null;
  let hoverCb = () => {};
  let pickCb = () => {};
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([sun, ...Object.values(planets).map((p) => p.hit)], false);
    if (hits[0]?.object === sun) return 'sun';
    return hits.length ? hits[0].object.userData.agent : null;
  }
  const el = renderer.domElement;
  let down = null;
  el.addEventListener('pointermove', (e) => {
    const id = pick(e);
    if (id !== hoverId) {
      hoverId = id;
      for (const p of Object.values(planets)) p.hoverTarget = p.id === id ? 1 : 0;
      el.style.cursor = id ? 'pointer' : '';
      hoverCb(id);
    }
  });
  el.addEventListener('pointerleave', () => {
    hoverId = null;
    for (const p of Object.values(planets)) p.hoverTarget = 0;
    hoverCb(null);
  });
  el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  el.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved < 5) pickCb(pick(e));
  });

  // ---------------------------------------------------------------- sky events: ships, meteors, comets, asteroids
  const sky = []; // active events
  const camBasis = () => {
    const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    return { fwd, right, up };
  };
  const rnd = (a, b) => a + Math.random() * (b - a);

  function makeShip() {
    const grp = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: '#b9c2d6', metalness: 0.65, roughness: 0.38, emissive: '#10131c' });
    const body = new THREE.Mesh(new THREE.ConeGeometry(1.5, 9, 10), hull);
    body.rotation.x = Math.PI / 2; // nose along +z
    const wing = new THREE.Mesh(new THREE.BoxGeometry(9, 0.25, 3.2), hull);
    wing.position.z = -1.6;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.6, 2.4), hull);
    fin.position.set(0, 1.2, -2.6);
    const engine = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#7fd8ff', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    engine.scale.set(7, 7, 1);
    engine.position.z = -4.8;
    const navR = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#ff4d4d', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    navR.scale.set(2.6, 2.6, 1);
    navR.position.set(4.4, 0, -1.6);
    const navG = navR.clone();
    navG.material = new THREE.SpriteMaterial({ map: glow, color: '#4dff9a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    navG.position.set(-4.4, 0, -1.6);
    grp.add(body, wing, fin, engine, navR, navG);
    grp.scale.setScalar(1.7);
    grp.userData = { navR, navG };
    return grp;
  }

  function spawnShip() {
    const { right, up, fwd } = camBasis();
    const c = controls.target.clone();
    const side = Math.random() < 0.5 ? -1 : 1;
    const a = c.clone().addScaledVector(right, -side * rnd(560, 760)).addScaledVector(up, rnd(-120, 220)).addScaledVector(fwd, rnd(-240, 120));
    const b = c.clone().addScaledVector(right, side * rnd(560, 760)).addScaledVector(up, rnd(-160, 200)).addScaledVector(fwd, rnd(-240, 120));
    const ctrl = c.clone().addScaledVector(up, rnd(-60, 140)).addScaledVector(fwd, -rnd(120, 300)); // swoops toward the camera
    const ship = makeShip();
    scene.add(ship);
    sky.push({ type: 'ship', ship, a, b, ctrl, t: 0, dur: rnd(15, 22), prev: a.clone() });
  }

  function spawnMeteor() {
    const { right, up, fwd } = camBasis();
    const c = controls.target.clone().addScaledVector(fwd, -80);
    const start = c.clone().addScaledVector(right, rnd(-260, 420)).addScaledVector(up, rnd(160, 340));
    const dir = right.clone().multiplyScalar(-rnd(0.6, 1)).addScaledVector(up, -rnd(0.35, 0.7)).normalize();
    sky.push({ type: 'meteor', pos: start, dir, speed: rnd(520, 820), life: rnd(0.9, 1.5), t: 0, color: new THREE.Color().setHSL(rnd(0.05, 0.6), 0.5, 0.82) });
  }

  function spawnComet() {
    const { right, up, fwd } = camBasis();
    const c = controls.target.clone();
    const side = Math.random() < 0.5 ? -1 : 1;
    const a = c.clone().addScaledVector(right, -side * 900).addScaledVector(up, rnd(120, 360)).addScaledVector(fwd, rnd(-400, -100));
    const b = c.clone().addScaledVector(right, side * 900).addScaledVector(up, rnd(-120, 120)).addScaledVector(fwd, rnd(-100, 150));
    const ctrl = c.clone().addScaledVector(up, rnd(40, 160)).addScaledVector(fwd, rnd(-60, 60));
    sky.push({ type: 'comet', a, b, ctrl, t: 0, dur: rnd(18, 26), color: new THREE.Color('#bfe9ff') });
  }

  function spawnAsteroid() {
    const { right, up, fwd } = camBasis();
    const c = controls.target.clone();
    const side = Math.random() < 0.5 ? -1 : 1;
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(4, 9), 1), new THREE.MeshStandardMaterial({ color: '#6c6560', roughness: 0.95, metalness: 0.05, flatShading: true }));
    const jitter = mesh.geometry.attributes.position;
    for (let i = 0; i < jitter.count; i++) jitter.setXYZ(i, jitter.getX(i) * rnd(0.8, 1.2), jitter.getY(i) * rnd(0.8, 1.2), jitter.getZ(i) * rnd(0.8, 1.2));
    mesh.geometry.computeVertexNormals();
    const a = c.clone().addScaledVector(right, -side * 640).addScaledVector(up, rnd(-140, 200)).addScaledVector(fwd, rnd(-60, 240));
    const b = c.clone().addScaledVector(right, side * 640).addScaledVector(up, rnd(-140, 200)).addScaledVector(fwd, rnd(-60, 240));
    mesh.position.copy(a);
    scene.add(mesh);
    sky.push({ type: 'rock', mesh, a, b, t: 0, dur: rnd(22, 34), spin: new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)) });
  }

  // Sky events are rare treats, not background noise: on average a shooting star every quarter hour or so, and a
  // ship, asteroid or comet roughly once an hour. Due times are wall-clock and remembered across restarts, so closing
  // and reopening the app neither resets the wait nor stacks up a pile of events. Alt+K still shows one on demand.
  const SPAWN = { ship: spawnShip, meteor: spawnMeteor, comet: spawnComet, asteroid: spawnAsteroid };
  const EVERY_MIN = { meteor: [8, 22], ship: [35, 75], asteroid: [50, 95], comet: [70, 150] }; // minutes between events of one kind
  const MIN_GAP_MS = 4 * 60 * 1000; // never two events within four minutes of each other
  const SKY_KEY = 'tandem:sky-due';
  const SOON_MS = [2 * 60 * 1000, 9 * 60 * 1000]; // an event that came due while the app was closed shows up a few minutes into the next session
  const loadDue = () => { try { const d = JSON.parse(localStorage.getItem(SKY_KEY) || '{}'); return d && typeof d === 'object' ? d : {}; } catch { return {}; } };
  const due = loadDue();
  const nowMs = Date.now();
  const stored = Object.fromEntries(Object.keys(SPAWN).map((k) => [k, Number(due[k])]));
  const overdue = Object.keys(SPAWN).filter((k) => Number.isFinite(stored[k]) && stored[k] > 0 && stored[k] <= nowMs).sort((a, b) => stored[a] - stored[b]);
  for (const k of Object.keys(SPAWN)) {
    const upcoming = Number.isFinite(stored[k]) && stored[k] > nowMs;
    // Kept as stored; or, if it came due while the app was closed, only the longest-overdue kind returns soon and
    // the rest wait a normal interval, so reopening never brings a burst of events.
    due[k] = upcoming ? stored[k] : k === overdue[0] ? nowMs + rnd(...SOON_MS) : nowMs + rnd(...EVERY_MIN[k]) * 60000;
  }
  const saveDue = () => { try { localStorage.setItem(SKY_KEY, JSON.stringify(due)); } catch { /* storage full or blocked: events just restart their wait */ } };
  saveDue();
  let lastSkyEvent = 0;
  let skyCheck = 0;
  let eventsOn = true;

  function updateSky(dt) {
    skyCheck -= dt;
    if (eventsOn && skyCheck <= 0) {
      skyCheck = 5; // a clock check every few seconds is plenty
      const now = Date.now();
      if (now - lastSkyEvent >= MIN_GAP_MS) {
        const k = Object.keys(due).filter((x) => due[x] <= now).sort((a, b) => due[a] - due[b])[0];
        if (k) {
          SPAWN[k]();
          lastSkyEvent = now;
          due[k] = now + rnd(...EVERY_MIN[k]) * 60000;
          saveDue();
        }
      }
    }
    for (let i = sky.length - 1; i >= 0; i--) {
      const e = sky[i];
      e.t += dt;
      if (e.type === 'ship') {
        const f = Math.min(1, e.t / e.dur);
        bezier(tmpV, e.a, e.ctrl, e.b, f);
        e.ship.position.copy(tmpV);
        const ahead = bezier(tmpA, e.a, e.ctrl, e.b, Math.min(1, f + 0.02));
        e.ship.lookAt(ahead);
        const blink = Math.sin(e.t * 7) > 0.2 ? 1 : 0.15;
        e.ship.userData.navR.material.opacity = blink;
        e.ship.userData.navG.material.opacity = 1.15 - blink;
        const back = tmpB.set(0, 0, -1).applyQuaternion(e.ship.quaternion);
        emit(tmpV.x + back.x * 8, tmpV.y + back.y * 8, tmpV.z + back.z * 8, back.x * 18, back.y * 18, back.z * 18, ENGINE, 6, 0.9);
        if (f >= 1) {
          scene.remove(e.ship);
          sky.splice(i, 1);
        }
      } else if (e.type === 'meteor') {
        e.pos.addScaledVector(e.dir, e.speed * dt);
        for (let k = 0; k < 3; k++) emit(e.pos.x - e.dir.x * k * 6, e.pos.y - e.dir.y * k * 6, e.pos.z - e.dir.z * k * 6, 0, 0, 0, e.color, 9 - k * 2, 0.5 - k * 0.1);
        if (e.t > e.life) sky.splice(i, 1);
      } else if (e.type === 'comet') {
        const f = Math.min(1, e.t / e.dur);
        bezier(tmpV, e.a, e.ctrl, e.b, f);
        const away = tmpA.copy(tmpV).normalize();
        emit(tmpV.x, tmpV.y, tmpV.z, 0, 0, 0, WHITE, 16, 0.4);
        for (let k = 0; k < 5; k++) {
          const spread = 6;
          emit(tmpV.x, tmpV.y, tmpV.z, away.x * rnd(25, 60) + rnd(-spread, spread), away.y * rnd(25, 60) + rnd(-spread, spread), away.z * rnd(25, 60) + rnd(-spread, spread), e.color, rnd(4, 9), rnd(1.2, 2.4));
        }
        if (f >= 1) sky.splice(i, 1);
      } else if (e.type === 'rock') {
        const f = Math.min(1, e.t / e.dur);
        e.mesh.position.lerpVectors(e.a, e.b, f);
        e.mesh.rotation.x += e.spin.x * dt * 0.6;
        e.mesh.rotation.y += e.spin.y * dt * 0.6;
        e.mesh.rotation.z += e.spin.z * dt * 0.6;
        if (f >= 1) {
          scene.remove(e.mesh);
          e.mesh.geometry.dispose();
          sky.splice(i, 1);
        }
      }
    }
  }

  // ---------------------------------------------------------------- frame loop
  const clock = {
    last: performance.now(),
    elapsedTime: 0,
    getDelta() {
      const n = performance.now();
      const d = (n - this.last) / 1000;
      this.last = n;
      this.elapsedTime += Math.min(d, 0.1);
      return d;
    },
  };
  const hooks = new Set();
  let running = true;
  let pulse = 0;
  let lastRaf = performance.now();
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) { lastRaf = performance.now(); loop(); }
  });

  // ---- frame pacing. While you are using Tandem it draws every frame exactly as before (at most 60 a second, so a
  // 120/144 Hz display is not driven twice as hard for nothing). Only when the window is not focused (it is on a
  // second screen, or you are working in another app) does it slow to 24 fps, which is the one place nobody is watching closely.
  const FPS = { focused: 60, away: 24 };
  let lastFrame = 0;
  let liveParticles = 0;
  const frameInterval = () => 1000 / (document.hasFocus() ? FPS.focused : FPS.away);

  // ---- frame-time watchdog: on a slow GPU, lower the resolution a step at a time (the picture is soft and bloomy,
  // so this is barely visible) and only drop the bloom as a last resort. The chosen step is remembered for next time.
  const DPR_STEPS = [1.5, 1.25, 1];
  let slow = 0;
  let sampleT = 0;
  let sampleN = 0;
  function watchdog(dt) {
    if (dt > 0.25) return; // a tab switch or a pause, not a slow GPU
    sampleT += dt;
    sampleN += 1;
    if (sampleT < 2) return;
    const avg = sampleT / sampleN;
    sampleT = 0;
    sampleN = 0;
    if (avg > 0.026) slow += 1;
    else slow = Math.max(0, slow - 1);
    if (slow >= 2) {
      slow = 0;
      const next = DPR_STEPS.find((s) => s < pixelRatio - 0.01);
      if (next) {
        pixelRatio = next;
        quality = 'medium';
        try { localStorage.setItem('tandem:scene-dpr', String(next)); } catch { /* not remembered */ }
        resize();
      } else if (bloomOn && avg > 0.04) {
        bloomOn = false;
        composer.passes.splice(composer.passes.indexOf(bloom), 1);
        quality = 'low';
      }
    }
  }

  const offset = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const prevTarget = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const ENGINE = new THREE.Color('#7fd8ff');
  const WHITE = new THREE.Color('#ffffff');
  const camQ = new THREE.Quaternion();
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const now = performance.now();
    watchdog((now - lastRaf) / 1000);
    lastRaf = now;
    if (now - lastFrame < frameInterval() - 3) return; // skip this tick: nothing here needs every frame
    lastFrame = now;
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;

    sunU.uTime.value = t;
    pulse = Math.max(0, pulse - dt * 1.4);
    sunU.uPulse.value = pulse;
    coronaA.scale.setScalar(SUN_RADIUS * (4.6 + pulse * 1.1 + Math.sin(t * 1.3) * 0.12));
    coronaB.scale.setScalar(SUN_RADIUS * (8 + pulse * 2 + Math.sin(t * 0.7) * 0.3));
    sun.rotation.y += dt * 0.02;
    camera.getWorldQuaternion(camQ);

    for (const p of Object.values(planets)) {
      const o = p.look.orbit;
      const isSel = selected === p.id;
      p.focus += ((isSel ? 1 : 0) - p.focus) * Math.min(1, dt * 3);
      const wantMul = isSel ? 0.18 : 1;
      p.speedMul += (wantMul - p.speedMul) * Math.min(1, dt * 2.5);
      p.theta += dt * o.speed * p.speedMul * (1 + p.heat * 0.4);
      p.pos.copy(orbitPoint(o, p.theta));
      p.group.position.copy(p.pos);
      p.hit.position.copy(p.pos);
      const camDist = camera.position.distanceTo(p.pos);
      p.hit.scale.setScalar(Math.max(p.look.radius * 1.5, Math.min(70, camDist * 0.045)));

      p.heat += (p.heatTarget - p.heat) * Math.min(1, dt * 3);
      p.hover += (p.hoverTarget - p.hover) * Math.min(1, dt * 8);
      p.alert = Math.max(0, p.alert - dt * 0.9);
      p.ctx += (p.tCtx - p.ctx) * Math.min(1, dt * 2.5);
      p.lim += (p.tLim - p.lim) * Math.min(1, dt * 2.5);
      p.u.uTime.value = t;
      p.u.uHeat.value = p.heat;
      p.u.uHover.value = p.hover;
      p.u.uAlert.value = p.alert;
      p.atmU.uCache.value += (p.cache - p.atmU.uCache.value) * Math.min(1, dt * 2);
      // the focused planet turns visibly faster so it feels alive up close
      p.spin += dt * p.look.spin * (1 + p.heat * 4) * (1 + p.focus * 4.5);
      p.body.rotation.y = p.spin;
      p.body.scale.setScalar(1 + p.hover * 0.04);
      p.halo.material.opacity = 0.12 + p.heat * 0.16 + p.hover * 0.1;
      if (p.ring) p.ring.rotation.z += dt * 0.03;

      // gauges face the camera
      for (const gr of [p.ctxRing, p.limRing]) gr.quaternion.copy(camQ);
      const cu = p.ctxRing.userData.u;
      cu.uFill.value = p.ctx;
      cu.uTime.value = t;
      cu.uAlpha.value = 0.55 + p.focus * 0.45;
      const lu = p.limRing.userData.u;
      lu.uFill.value = p.lim;
      lu.uTime.value = t;
      lu.uAlpha.value = 0.4 + p.focus * 0.5;

      // shield
      p.shield.rotation.y += dt * 0.12;
      p.shield.rotation.x += dt * 0.05;
      p.shieldMat.opacity += ((p.shieldTarget ?? 0.2) * (0.85 + 0.15 * Math.sin(t * 2) * (p.mode === 'auto' ? 1 : 0.2)) - p.shieldMat.opacity) * Math.min(1, dt * 4);

      // beacon
      const bOn = p.awaiting > 0;
      const ph = (t * 1.1) % 1;
      p.beacon.material.opacity += ((bOn ? 0.5 * (1 - ph) : 0) - p.beacon.material.opacity) * Math.min(1, dt * 10);
      const bs = p.look.radius * (2.4 + (bOn ? ph * 3.2 : 0));
      p.beacon.scale.set(bs, bs, 1);

      // tool moons
      p.moons.forEach((m, i) => {
        const cls = p.moonCls[i];
        const on = cls !== undefined;
        m.s += ((on ? 1 : 0) - m.s) * Math.min(1, dt * 6);
        m.mesh.visible = m.s > 0.03;
        if (!m.mesh.visible) return;
        if (on && m.cls !== cls) {
          m.cls = cls;
          m.mesh.material.color.set(CLASS_COLORS[cls] || CLASS_COLORS.other).multiplyScalar(3);
        }
        m.ang += dt * m.speed * (1 + p.heat);
        m.mesh.position.set(Math.cos(m.ang) * m.rad, Math.sin(m.ang) * m.rad * Math.sin(m.inc), Math.sin(m.ang) * m.rad * Math.cos(m.inc));
        m.mesh.scale.setScalar(1.55 * m.s);
      });
      // sub-agent moons
      p.subs.forEach((s, i) => {
        const st = p.subStates[i];
        const on = st !== undefined;
        s.s += ((on ? 1 : 0) - s.s) * Math.min(1, dt * 4);
        s.grp.visible = s.s > 0.03;
        if (!s.grp.visible) return;
        s.active = st === 'running';
        s.ang += dt * s.speed * (s.active ? 1.4 : 0.5);
        s.grp.position.set(Math.cos(s.ang) * s.rad, Math.sin(s.ang) * s.rad * Math.sin(s.inc), Math.sin(s.ang) * s.rad * Math.cos(s.inc));
        s.grp.scale.setScalar(p.look.radius * 0.2 * s.s);
        s.halo.material.opacity = s.active ? 0.8 + 0.2 * Math.sin(t * 6 + i) : 0.28;
        s.ring.material.opacity = s.active ? 0.9 : 0.35;
        s.ring.scale.setScalar(3.2 + (s.active ? Math.sin(t * 5 + i) * 0.5 : 0));
        s.core.material.color.set(s.active ? '#ffffff' : '#8a93a8').multiplyScalar(s.active ? 2.4 : 1);
        if (s.active && Math.random() < dt * 14) emit(p.pos.x + s.grp.position.x, p.pos.y + s.grp.position.y, p.pos.z + s.grp.position.z, rnd(-8, 8), rnd(-8, 8), rnd(-8, 8), p.color, 3, 0.7);
      });
      // belt
      p.belt.rotation.y += dt * 0.06;
      // plan beads
      const nb = p.planStates.length;
      p.beads.forEach((b, i) => {
        const st = p.planStates[i];
        b.visible = st !== undefined;
        if (!b.visible) return;
        const ang = (i / Math.max(nb, 1)) * Math.PI * 2 - t * 0.25;
        const rad = p.look.radius * 2.12;
        b.position.set(Math.cos(ang) * rad, Math.sin(ang) * rad * 0.28, Math.sin(ang) * rad * 0.96);
        const base = p.look.radius * 0.1;
        if (st === 'done') {
          b.material.color.set('#6ee7a0').multiplyScalar(2.2);
          b.scale.setScalar(base);
        } else if (st === 'active') {
          b.material.color.copy(p.color).multiplyScalar(2.6);
          b.scale.setScalar(base * (1.2 + 0.35 * Math.sin(t * 6)));
        } else {
          b.material.color.set('#59627a');
          b.scale.setScalar(base * 0.8);
        }
      });
      // MCP satellites
      p.sats.forEach((s, i) => {
        const st = p.mcpStates[i];
        s.mesh.visible = st !== undefined;
        if (!s.mesh.visible) return;
        s.ang += dt * 0.12;
        s.mesh.position.set(Math.cos(s.ang) * s.rad, s.y, Math.sin(s.ang) * s.rad);
        s.mesh.rotation.y += dt;
        s.mesh.scale.setScalar(p.look.radius * 0.07);
        s.mesh.material.color.set(MCP_COLORS[st] || '#9aa3b8').multiplyScalar(1.6);
      });

      // sparks while busy; faster output means more sparks
      if (p.busy) {
        p.sparkAcc += dt * Math.min(150, 34 + p.tps * 0.6);
        while (p.sparkAcc >= 1) {
          p.sparkAcc -= 1;
          const d = tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
          const sp = 10 + Math.random() * 26;
          emit(p.pos.x + d.x * p.look.radius, p.pos.y + d.y * p.look.radius, p.pos.z + d.z * p.look.radius, d.x * sp, d.y * sp, d.z * sp, p.color, 3 + Math.random() * 4, 0.9 + Math.random() * 1.1);
        }
      }
      // thinking: expanding pulse rings
      if (p.thinking) {
        p.thinkAcc += dt;
        if (p.thinkAcc > 1.15) {
          p.thinkAcc = 0;
          wave(p, p.look.hex, 2.5, 1.5, 0.5);
        }
      }

      // trail: the path moves every frame, but its colours only follow the planet's heat, so recolour only when that changes
      p.trailPos.copyWithin(3, 0, (p.TRAIL - 1) * 3);
      p.trailPos[0] = p.pos.x; p.trailPos[1] = p.pos.y; p.trailPos[2] = p.pos.z;
      const heatKey = Math.round(p.heat * 60);
      if (heatKey !== p.trailHeatKey) {
        p.trailHeatKey = heatKey;
        for (let i = 0; i < p.TRAIL; i++) {
          const f = (1 - i / p.TRAIL) ** 2 * (0.35 + p.heat * 0.9);
          p.trailCol[i * 3] = p.color.r * f; p.trailCol[i * 3 + 1] = p.color.g * f; p.trailCol[i * 3 + 2] = p.color.b * f;
        }
        p.trail.geometry.attributes.color.needsUpdate = true;
      }
      p.trail.geometry.attributes.position.needsUpdate = true;
      p.orbitLine.material.opacity = 0.12 + (isSel ? 0.18 : 0) + p.heat * 0.12;
    }

    // waves
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.t += dt / w.dur;
      const s = w.r * (2 + (w.maxMul - 1) * w.t * 2.2);
      w.sp.scale.set(s, s, 1);
      w.sp.material.opacity = w.opacity * (1 - w.t) ** 1.5;
      if (w.t >= 1) {
        w.sp.parent?.remove(w.sp);
        w.sp.material.dispose();
        waves.splice(i, 1);
      }
    }

    // packets
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i];
      k.t += dt / k.dur;
      if (k.target) k.b.copy(k.target.pos);
      const e = Math.min(1, k.t);
      const s = e * e * (3 - 2 * e);
      bezier(tmpV, k.a, k.ctrl, k.b, s);
      emit(tmpV.x, tmpV.y, tmpV.z, 0, 0, 0, k.color, k.size, 0.35);
      emit(tmpV.x, tmpV.y, tmpV.z, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, k.color, k.size * 0.5, 0.7);
      if (k.t >= 1) {
        packets.splice(i, 1);
        k.onDone?.();
      }
    }

    updateSky(dt);

    // particles
    let alive = 0;
    for (let i = 0; i < MAXP; i++) {
      if (P.life[i] <= 0) {
        P.alpha[i] = 0;
        continue;
      }
      alive++;
      P.life[i] -= dt;
      const f = Math.max(0, P.life[i] / P.max[i]);
      P.pos[i * 3] += P.vel[i * 3] * dt;
      P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt;
      P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      P.alpha[i] = f;
      P.size[i] = P.base[i] * (0.4 + f * 0.6);
    }
    // Upload only what changed: nothing at all while no particle lives (one last time after the final one fades),
    // and colours only when a particle was added.
    if (alive || liveParticles) {
      pg.attributes.position.needsUpdate = true;
      pg.attributes.aAlpha.needsUpdate = true;
      pg.attributes.aSize.needsUpdate = true;
    }
    if (P.colDirty) { pg.attributes.aColor.needsUpdate = true; P.colDirty = false; }
    liveParticles = alive;

    // camera: follow the chosen planet (or the star), keeping the current viewing offset
    goal.copy(selected ? planets[selected].pos : tmpV.set(0, 0, 0));
    prevTarget.copy(controls.target);
    controls.target.lerp(goal, Math.min(1, dt * (selected ? 5 : 3)));
    camera.position.add(tmpB.subVectors(controls.target, prevTarget));
    // slowly circle whatever is in focus
    controls.autoRotateSpeed += ((selected ? 1.1 : 0.25) - controls.autoRotateSpeed) * Math.min(1, dt * 2);
    if (tween) {
      if (now > tween.until) tween = null;
      else {
        const k = 1 - Math.pow(0.0035, dt);
        offset.copy(camera.position).sub(controls.target);
        const len = offset.length();
        const nl = len + (tween.dist - len) * k;
        if (!tween.dirLocked) offset.normalize().lerp(tween.dir, k * 0.9).normalize();
        else offset.normalize();
        camera.position.copy(controls.target).addScaledVector(offset, nl);
      }
    }
    controls.update();

    composer.render();
    for (const fn of hooks) fn(now);
  }
  loop();

  // ---------------------------------------------------------------- public api
  const v = new THREE.Vector3();
  function screen(id) {
    const base = id === 'sun' ? new THREE.Vector3(0, 0, 0) : planets[id].pos;
    const r = id === 'sun' ? SUN_RADIUS : planets[id].look.radius;
    v.copy(base).project(camera);
    const x = (v.x * 0.5 + 0.5) * W;
    const y = (-v.y * 0.5 + 0.5) * H;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(r);
    const e = base.clone().add(right).project(camera);
    const sr = Math.abs((e.x - v.x) * 0.5 * W);
    return { x, y, r: sr, visible: v.z < 1 };
  }

  function burst(p, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const d = tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const sp = speed * (0.5 + Math.random());
      emit(p.pos.x + d.x * p.look.radius, p.pos.y + d.y * p.look.radius, p.pos.z + d.z * p.look.radius, d.x * sp, d.y * sp, d.z * sp, color, 4 + Math.random() * 5, 0.8 + Math.random() * 0.9);
    }
  }

  return {
    addPlanet,
    removePlanet(id) {
      const p = planets[id];
      if (!p) return;
      for (const obj of [p.group, p.hit, p.trail, p.orbitLine]) {
        obj.parent?.remove(obj);
        obj.traverse((o) => { o.geometry?.dispose(); if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); });
      }
      delete planets[id];
      if (selected === id) setSelected(null);
    },
    setTopDown(on) { topDown = on; if (!selected) setSelected(null); },
    setEco(on) { ecoMode = on; bloom.enabled = !on && bloomOn; eventsOn = !on; resize(); },
    setSelected,
    setInsets(l, r) {
      insets.left = l;
      insets.right = r;
      applyView();
      if (!selected) setSelected(null);
    },
    /**
     * Everything an agent is doing, as numbers:
     * { busy, thinking, awaiting, mode, ctx 0..1, limit 0..1, cache 0..1, tps,
     *   moons:[class], subagents:[status], tools:{total,byClass}, plan:[state], mcp:[status] }
     */
    setStatus(id, s) {
      const p = planets[id];
      if (!p) return;
      p.busy = !!s.busy;
      p.thinking = !!s.thinking;
      p.awaiting = s.awaiting || 0;
      p.tps = s.tps || 0;
      p.heatTarget = s.busy ? 1 : s.awaiting ? 0.55 : s.thinking ? 0.7 : 0.06;
      p.tCtx = Math.max(0, Math.min(1, s.ctx || 0));
      p.tLim = Math.max(0, Math.min(1, s.limit || 0));
      p.cache = Math.max(0, Math.min(1, s.cache || 0));
      p.moonCls = (s.moons || []).slice(0, 10);
      p.subStates = (s.subagents || []).slice(0, 4);
      p.planStates = (s.plan || []).slice(0, 10);
      p.mcpStates = (s.mcp || []).slice(0, 8);
      if (s.mode !== p.mode) {
        p.mode = s.mode;
        const [hex, op] = SHIELD[s.mode] || SHIELD.ask;
        p.shieldMat.color.set(hex);
        p.shieldTarget = op;
      }
      const total = Math.min(BELT_N, s.tools?.total || 0);
      const sig = total + JSON.stringify(s.tools?.byClass || {});
      if (sig !== p.beltSig) {
        p.beltSig = sig;
        const by = s.tools?.byClass || {};
        const keys = Object.keys(by).filter((k) => by[k] > 0);
        const sum = keys.reduce((a, k) => a + by[k], 0) || 1;
        const col = p.beltGeo.attributes.color;
        const c = new THREE.Color();
        for (let i = 0; i < total; i++) {
          let x = p.beltSeed[i] * sum;
          let cls = keys[keys.length - 1] || 'other';
          for (const k of keys) {
            x -= by[k];
            if (x <= 0) {
              cls = k;
              break;
            }
          }
          c.set(CLASS_COLORS[cls] || CLASS_COLORS.other).multiplyScalar(1.4);
          col.setXYZ(i, c.r, c.g, c.b);
        }
        col.needsUpdate = true;
        p.beltGeo.setDrawRange(0, total);
      }
    },
    /** Transient effects: error / deny / compact. */
    fx(id, name) {
      const p = planets[id];
      if (!p) return;
      if (name === 'error') {
        p.alert = 1;
        burst(p, new THREE.Color('#ff5a4a'), 36, 46);
        wave(p, '#ff5a4a', 3.2, 1.1, 0.8);
      } else if (name === 'deny') {
        burst(p, new THREE.Color('#ffd27a'), 18, 30);
      } else if (name === 'compact') {
        wave(p, '#ffffff', 5, 1.6, 0.9);
        burst(p, new THREE.Color('#bfe9ff'), 40, 38);
      }
    },
    /** Light travels from a planet into the star: work landed in the codebase. */
    workPacket(id) {
      const p = planets[id];
      if (!p) return;
      const k = sendPacket(p.pos, new THREE.Vector3(0, 0, 0), p.color, { dur: 1.25, size: 6.5, lift: 0.2 });
      k.onDone = () => {
        pulse = Math.min(1.6, pulse + 0.9);
        for (let i = 0; i < 26; i++) {
          const d = tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
          const sp = 30 + Math.random() * 40;
          emit(d.x * SUN_RADIUS, d.y * SUN_RADIUS, d.z * SUN_RADIUS, d.x * sp, d.y * sp, d.z * sp, p.color, 5 + Math.random() * 5, 0.8 + Math.random() * 0.6);
        }
      };
    },
    handoff(from, to) {
      const a = planets[from];
      const b = planets[to];
      if (!a || !b) return;
      sendPacket(a.pos, b, a.color, { dur: 1.6, size: 10, lift: 0.5 }).onDone = () => {
        b.heat = Math.max(b.heat, 0.8);
        burst(b, a.color, 18, 24);
      };
    },
    flashSun(n = 0.6) {
      pulse = Math.min(1.6, pulse + n);
    },
    /** Trigger a sky event on demand: 'ship' | 'meteor' | 'comet' | 'asteroid'. */
    sky(kind) {
      SPAWN[kind]?.();
    },
    setSkyEvents(on) {
      eventsOn = on;
    },
    screen,
    onPick(fn) {
      pickCb = fn;
    },
    onHover(fn) {
      hoverCb = fn;
    },
    onFrame(fn) {
      hooks.add(fn);
    },
    get selected() {
      return selected;
    },
    get quality() {
      return quality;
    },
  };
}
