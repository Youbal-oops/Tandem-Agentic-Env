import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createInkCatBrain, agentIsActive } from './tandem-cat-behavior.js';

// Illustrated, transparent layer. Families map agent ids to adults and child ids
// to kitten instances, each with its own skeleton, mixer, and activity state.
export function createTandemCatStage(host, {
  assetUrl = './tandem_cat.glb', autoRender = true, fit = 'contain',
  baseline = 145, scale = 65, positions = [800], worldWidth = 1600, worldHeight = 1000,
  onPick = () => {}, onHover = () => {},
} = {}) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  renderer.domElement.setAttribute('aria-hidden', 'true'); host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1600, 1000, 0, .1, 5000);
  camera.position.set(0, 0, 2000); camera.lookAt(0, 0, 0);
  const families = new Map(), selectable = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let asset = null, disposed = false, selected = null, last = 0, raf = 0, eco = false;
  const durations = {};
  let width = 1, height = 1;
  const ready = new GLTFLoader().loadAsync(assetUrl).then(value => {
    if (disposed) return;
    asset = value;
    for (const clip of asset.animations) durations[clip.name] = clip.duration;
    for (const family of families.values()) instantiate(family);
    render();
  }).catch(error => {
    if (!disposed) console.error('Tandem ink cat could not load:', error);
    throw error;
  });
  // Consumers can await ready; this handler prevents a background overlay's
  // failed asset load from becoming an unhandled promise rejection.
  ready.catch(() => {});

  function character(kitten = false) {
    const root = clone(asset.scene), mixer = new THREE.AnimationMixer(root);
    root.scale.setScalar(kitten ? .43 : 1);
    root.traverse(obj => {
      if (obj.isMesh) {
        // Morph poses extend past the rest bounds; do not cull a sleeping kitten.
        obj.frustumCulled = false;
        for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) mat.toneMapped = false;
      }
    });
    const brain = createInkCatBrain({ kitten, durations });
    const actions = new Map(asset.animations.map(clip => [clip.name, mixer.clipAction(clip)]));
    let current = null;
    function play(name, immediate = false) {
      const next = actions.get(name);
      if (!next) return;
      let curl=0;
      root.traverse(obj=>{const i=obj.morphTargetDictionary?.SleepCurl;if(i!==undefined)curl=obj.morphTargetInfluences[i];});
      // Reset residual fades so rapid busy/idle changes cannot leave ghost poses.
      for (const action of actions.values()) if (action !== current && action !== next) action.stop();
      next.stopFading().reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
      const loop = ['Idle', 'Sleep', 'Snuggle'].includes(name);
      next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop; next.play();
      if (name === 'WakeStretch' || name === 'SettleSleep') {
        // Resume a reversed transition from its current curl rather than snap
        // to the fully upright/sleeping endpoint on a rapid status change.
        const target=name==='WakeStretch' ? 1-curl : curl;
        let lo=0,hi=1;
        for(let i=0;i<16;i++){const t=(lo+hi)/2; if(t*t*(3-2*t)<target)lo=t;else hi=t;}
        next.time=(lo+hi)/2*next.getClip().duration*(name==='WakeStretch'?.54:1);
      }
      if (current && current !== next && !immediate) next.crossFadeFrom(current, .32, false);
      else if (current && current !== next) current.stop();
      current = next; root.userData.catClip = name;
    }
    play(brain.clip, true); mixer.update(0); root.updateMatrixWorld(true);
    return { root, mixer, brain, play,
      update(dt) {
        const changed = brain.update(dt, { reducedMotion: reduced.matches });
        if (changed) play(changed, reduced.matches);
        if (!reduced.matches) mixer.update(dt);
        else { if (current) current.time = 0; mixer.update(0); }
      },
      dispose() { mixer.stopAllAction(); mixer.uncacheRoot(root); root.removeFromParent(); },
    };
  }

  function instantiate(family) {
    if (!asset || family.adult) return;
    family.adult = character(); family.group.add(family.adult.root);
    syncCharacters(family);
  }

  function syncCharacters(family) {
    if (!family.adult) return;
    family.adult.brain.setActive(agentIsActive(family.state));
    const kids = (family.state.kittens || []).filter(child => child?.id);
    const seen = new Set();
    for (const [i, child] of kids.entries()) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      let kitten = family.kittens.get(child.id);
      if (!kitten) {
        kitten = character(true); kitten.root.position.set((i % 2 ? 1 : -1) * (2.8 + Math.floor(i/2)*1.0), 0, .6 + i * .02);
        family.kittens.set(child.id, kitten); family.group.add(kitten.root);
      }
      kitten.target = (i % 2 ? 1 : -1) * (2.15 + Math.floor(i/2)*.98);
      kitten.brain.setActive(agentIsActive(child));
      kitten.root.userData.agentId = family.id; kitten.root.userData.childId = child.id;
    }
    for (const [id, kitten] of family.kittens) if (!seen.has(id)) { kitten.dispose(); family.kittens.delete(id); }
    family.button.setAttribute('aria-label', `${family.label}: ${family.adult.brain.label}; ${seen.size} kitten${seen.size === 1 ? '' : 's'}`);
  }

  function syncAgent(id, state = {}, label = id) {
    let family = families.get(id);
    if (!family) {
      const group = new THREE.Group(); scene.add(group); group.scale.setScalar(scale);
      const index = families.size;
      const button = document.createElement('button'); button.type = 'button';
      button.style.cssText = 'position:absolute;pointer-events:auto;border:0;background:transparent;color:inherit;cursor:pointer;min-width:44px;min-height:44px;padding:0;border-radius:18px';
      button.addEventListener('click', () => onPick(id));
      button.addEventListener('mouseenter', () => onHover(id)); button.addEventListener('mouseleave', () => onHover(null));
      button.addEventListener('focus', () => onHover(id)); button.addEventListener('blur', () => onHover(null));
      host.append(button);
      family = { id, label, group, button, state, adult: null, kittens: new Map(), baseX: positions[index] ?? 350 + index * 380, offset: 0, offsetTarget: 0 };
      family.group.position.set(family.baseX, baseline, 0);
      families.set(id, family); selectable.set(id, button); instantiate(family);
    }
    family.state = state; family.label = label; syncCharacters(family);
  }

  function screen(id) {
    const family = families.get(id);
    if (!family?.adult) return { x: 0, y: 0, r: 0, visible: false };
    const awake = !['Sleep', 'Snuggle'].includes(family.adult.brain.clip);
    const center = new THREE.Vector3(family.group.position.x, baseline + scale * (awake ? 3.3 : .9), 0).project(camera);
    const x=(center.x+1)*width/2, y=(1-center.y)*height/2;
    const zoom=width/(camera.right-camera.left);
    return { x, y, r: scale * (awake ? 3.45 : 1.4) * zoom, visible: x>=0 && x<=width && y>=0 && y<=height };
  }

  function resize() {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    const zoom = (fit === 'cover' ? Math.max : Math.min)(width/worldWidth, height/worldHeight);
    const vw=width/zoom, vh=height/zoom;
    camera.left=(worldWidth-vw)/2; camera.right=camera.left+vw;
    camera.bottom=(worldHeight-vh)/2; camera.top=camera.bottom+vh; camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  function update(dt) {
    dt = Math.max(0, Math.min(.1, dt));
    for (const family of families.values()) {
      if (!family.adult) continue;
      family.adult.update(dt);
      if (!family.adult.brain.active) family.offsetTarget=0;
      if (reduced.matches) family.offset=family.offsetTarget;
      else family.offset += Math.sign(family.offsetTarget-family.offset)*Math.min(Math.abs(family.offsetTarget-family.offset),dt*.65);
      family.group.position.x = family.baseX + family.offset*scale;
      for (const kitten of family.kittens.values()) {
        kitten.update(dt);
        const target = kitten.target + (kitten.brain.active ? .5*Math.sign(kitten.target) : 0);
        kitten.root.position.x += reduced.matches ? target-kitten.root.position.x : Math.sign(target-kitten.root.position.x)*Math.min(Math.abs(target-kitten.root.position.x),dt*.6);
      }
      family.button.setAttribute('aria-label', `${family.label}: ${family.adult.brain.label}; ${family.kittens.size} kittens`);
      family.button.dataset.activity=family.adult.brain.clip;
      family.button.title=`${family.label} · ${family.adult.brain.label}`;
    }
  }
  function render() {
    if (disposed) return;
    scene.updateMatrixWorld(true);
    for (const family of families.values()) {
      const p=screen(family.id); const zoom=width/(camera.right-camera.left);
      const awake=family.adult && !['Sleep','Snuggle'].includes(family.adult.brain.clip);
      const bw=scale*5.0*zoom, bh=scale*(awake ? 7.5 : 2.6)*zoom;
      const b=family.button; b.style.left=`${p.x-bw/2}px`; b.style.top=`${p.y-bh/2}px`; b.style.width=`${bw}px`;b.style.height=`${bh}px`;
      b.style.display=p.visible?'block':'none'; b.style.outline=selected===family.id?'1px solid #b6a58a':'none';
    }
    renderer.render(scene,camera);
  }
  function frame(now) {
    if (disposed) return;
    raf=requestAnimationFrame(frame);
    const interval=eco ? 1000/18 : 1000/30;
    if (last && now-last<interval) return;
    const dt=last ? Math.min(.1,(now-last)/1000) : 0;last=now;
    if (!document.hidden) { update(dt);render(); }
  }
  if (autoRender) raf=requestAnimationFrame(frame);
  return {
    ready, syncAgent, screen, update, render,
    getState(id) { const f=families.get(id);return f?.adult ? { clip:f.adult.brain.clip, active:f.adult.brain.active, kittens:[...f.kittens].map(([id,k])=>({ id,clip:k.brain.clip,active:k.brain.active })) } : null; },
    react(id, name='Curious') { families.get(id)?.adult?.brain.request(name); },
    reposition(id) { const f=families.get(id);if(f?.adult?.brain.active) { f.offsetTarget=f.offsetTarget ? 0 : .70;f.adult.brain.request('Reposition'); } },
    setSelected(id) { selected=id; },
    setEco(on) { eco=Boolean(on);renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,eco?1:2));resize(); },
    removeAgent(id) { const f=families.get(id);if(!f)return;f.adult?.dispose();for(const k of f.kittens.values())k.dispose();f.group.removeFromParent();f.button.remove();families.delete(id);selectable.delete(id); },
    dispose() {
      disposed=true;cancelAnimationFrame(raf);observer.disconnect();
      for(const id of [...families.keys()]) this.removeAgent(id);
      const geometry=new Set(),materials=new Set();
      asset?.scene.traverse(o=>{if(o.geometry)geometry.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));});
      geometry.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());renderer.dispose();renderer.domElement.remove();
    },
  };
}
