import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AnimationMixer, Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createInkCatBrain, agentIsActive } from '../src/tandem-cat-behavior.js';

const tick=(brain,seconds)=>{for(let t=0;t<seconds;t+=.05)brain.update(.05);};
test('agents default to curled sleep, wake and stretch once, then sit upright',()=>{
 const brain=createInkCatBrain({random:()=>.5});assert.equal(brain.clip,'Sleep');
 tick(brain,30);assert.equal(brain.clip,'Sleep');
 brain.setActive(true);assert.equal(brain.update(.01),'WakeStretch');
 tick(brain,4.1);assert.equal(brain.clip,'Idle');
 brain.setActive(false);assert.equal(brain.update(.01),'SettleSleep');
 tick(brain,3.1);assert.equal(brain.clip,'Sleep');
});
test('active cats groom occasionally and inactive cats never initiate idle gestures',()=>{
 const brain=createInkCatBrain({random:()=>0});brain.setActive(true);brain.update(0);
 tick(brain,4.1);tick(brain,8.1);assert.equal(brain.clip,'Groom');
 brain.setActive(false);brain.update(0);tick(brain,100);assert.equal(brain.clip,'Sleep');
});
test('kitten activity is independent and finished kittens return to snuggling',()=>{
 const parent=createInkCatBrain(),child=createInkCatBrain({kitten:true});
 assert.equal(child.clip,'Snuggle');child.setActive(true);child.update(0);
 assert.equal(child.clip,'WakeStretch');assert.equal(parent.clip,'Sleep');
 child.setActive(false);child.update(0);tick(child,3.1);assert.equal(child.clip,'Snuggle');
});
test('rapid activity changes reverse the transition and reduced motion selects a static pose',()=>{
 const brain=createInkCatBrain();brain.setActive(true);brain.update(0);brain.setActive(false);brain.update(0);
 assert.equal(brain.clip,'SettleSleep');brain.setActive(true);brain.update(0);assert.equal(brain.clip,'WakeStretch');
 brain.update(0,{reducedMotion:true});assert.equal(brain.clip,'Idle');
 brain.setActive(false);brain.update(0,{reducedMotion:true});assert.equal(brain.clip,'Sleep');
});
test('agent status recognizes tools, approval and subagent running states',()=>{
 for(const state of [{busy:true},{thinking:true},{awaiting:1},{status:'running'},{moons:['edit']},{tools:{running:['read']}}])assert.equal(agentIsActive(state),true);
 for(const state of [{},{status:'completed'},{status:'failed'},{busy:false}])assert.equal(agentIsActive(state),false);
});
test('ink GLB has all behaviors, valid skinning, distinct sleep and intact exported morph animation',async()=>{
 const bytes=await fs.readFile(new URL('../public/models/tandem_cat.glb',import.meta.url));
 const asset=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const names=['Idle','Blink','TailSwish','Curious','Sleep','WakeStretch','SettleSleep','Groom','Snuggle','Reposition'];
 assert.deepEqual(asset.animations.map(c=>c.name).sort(),names.sort());
 const a=clone(asset.scene),b=clone(asset.scene);
 let skinA,skinB;a.traverse(o=>{if(o.isSkinnedMesh)skinA=o;});b.traverse(o=>{if(o.isSkinnedMesh)skinB=o;});
 assert.ok(skinA&&skinB);assert.notEqual(skinA.skeleton,skinB.skeleton);
 assert.notEqual(skinA.morphTargetInfluences,skinB.morphTargetInfluences);
 const weights=skinA.geometry.attributes.skinWeight;
 for(let i=0;i<weights.count;i++)assert.ok(Math.abs(weights.getX(i)+weights.getY(i)+weights.getZ(i)+weights.getW(i)-1)<.001);
 const mixer=new AnimationMixer(a),heights={};
 for(const clip of asset.animations){
  mixer.stopAllAction();mixer.clipAction(clip).play();
  assert.ok(clip.tracks.some(t=>t.name.includes('morphTargetInfluences')),clip.name+' has no exported pose');
  for(let i=0;i<=12;i++){
   mixer.setTime(clip.duration*i/13);a.updateMatrixWorld(true);
   const bounds=new Box3().setFromObject(a,true),size=bounds.getSize(new Vector3());
   assert.ok([...size].every(Number.isFinite));assert.ok(size.length()>1&&size.length()<11,clip.name+' rig exploded');
   assert.ok(bounds.min.y>-.25,clip.name+' moved beneath the floor');
   if(i===0)heights[clip.name]=size.y;
  }
 }
 assert.ok(heights.Sleep<heights.Idle*.38,'Sleep should be curled on the ground, not compressed sitting');
 console.log('Ink cat verified:',bytes.length,'bytes; upright/sleep heights:',heights.Idle.toFixed(2),heights.Sleep.toFixed(2));
});
