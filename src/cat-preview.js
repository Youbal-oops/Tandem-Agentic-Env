import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const host = document.querySelector('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
host.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#39251f');
scene.fog = new THREE.Fog('#39251f', 9, 24);
const camera = new THREE.PerspectiveCamera(36, 1, .1, 50); camera.position.set(3.6, 2.4, 5.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, .7, 0); controls.enableDamping = true; controls.minDistance = 3; controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * .48;
scene.add(new THREE.HemisphereLight('#ffe4bd', '#596b86', 2.2));
function light(color, intensity, x, y, z) {
  const l = new THREE.DirectionalLight(color, intensity); l.position.set(x, y, z); scene.add(l); return l;
}
const sun = light('#ffd3a1', 3.2, -3, 6, 4); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4; sun.shadow.normalBias = .035;
light('#8cb5e0', 1.5, 4, 3, 1); light('#ffaf67', 2, 0, 4, -4);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#95512e', roughness: .95 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = -.015; scene.add(floor);
const loader = new GLTFLoader(); const models = []; let clipName = 'Idle';
let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = document.querySelector('#pause');
function updatePause() { pause.textContent = paused ? 'Play' : 'Pause'; pause.setAttribute('aria-pressed', String(paused)); }
pause.onclick = () => { paused = !paused; updatePause(); }; updatePause();
function play(name) {
  clipName = name;
  for (const m of models) {
    const next = m.mixer.clipAction(m.clips.find(c => c.name === name));
    next.reset().play();
    if (m.action && m.action !== next) { m.action.fadeOut(.35); next.fadeIn(.35); }
    m.action = next;
  }
  for (const b of document.querySelectorAll('[data-clip]')) b.setAttribute('aria-pressed', String(b.dataset.clip === name));
}
function coat() {
  const choice = document.querySelector('#coat').value;
  const blue = choice === 'blue';
  const black = choice === 'black';
  for (const m of models) m.root.traverse(o => {
    if (!o.isMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (/^Coat(?:\.\d+)?$/.test(mat.name)) mat.color.setRGB(...(black ? [.012,.011,.009] : blue ? [.30,.43,.56] : [.87,.72,.49]));
      if (/^Accent(?:\.\d+)?$/.test(mat.name)) mat.color.setRGB(...(black ? [.006,.005,.004] : blue ? [.12,.22,.32] : [.68,.31,.12]));
    }
  });
}
document.querySelector('#coat').onchange = coat;
try {
  const assets = await Promise.all(['cat','kitten'].map(name => loader.loadAsync(`/models/${name}.glb`)));
  assets.forEach((asset, i) => {
    const root = asset.scene; root.position.x = i ? .75 : -.65;
    root.rotation.y = i ? -.22 : .1;
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(root); models.push({ root, clips: asset.animations, mixer: new THREE.AnimationMixer(root), action: null });
  });
  for (const name of ['Idle','Walk','Sleep','Think','Knead','Play','Snuggle']) {
    const b = document.createElement('button'); b.textContent = name; b.dataset.clip = name;
    b.style.margin = '3px'; b.onclick = () => play(name); document.querySelector('#clips').append(b);
  }
  coat(); play(clipName);
  for (const m of models) m.mixer.update(.001);
  document.querySelector('#message').textContent = 'Two skinned models · Seven clips each';
} catch (error) { document.querySelector('#message').textContent = `Could not load cats: ${error.message}`; }
function resize() {
  const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();
let last = 0;
renderer.setAnimationLoop(now => {
  const dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
  if (document.hidden) return;
  if (!paused) for (const m of models) m.mixer.update(dt);
  controls.update(); renderer.render(scene, camera);
});
document.addEventListener('visibilitychange', () => { last = 0; });
