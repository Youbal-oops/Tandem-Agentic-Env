import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AnimationMixer, Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const expected = ['Idle', 'Walk', 'Sleep', 'Think', 'Knead', 'Play', 'Snuggle'];
for (const name of ['cat', 'kitten']) {
  const bytes = await fs.readFile(new URL(`../public/models/${name}.glb`, import.meta.url));
  const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  assert.deepEqual(asset.animations.map(c => c.name).sort(), [...expected].sort());
  const model = clone(asset.scene);
  const skins = []; model.traverse(o => { if (o.isSkinnedMesh) skins.push(o); });
  assert.ok(skins.length);
  for (const skin of skins) {
    assert.equal(skin.skeleton.bones.length, 25);
    assert.ok(skin.morphTargetDictionary?.RestingPose !== undefined);
    const weights = skin.geometry.attributes.skinWeight;
    for (let i = 0; i < weights.count; i++) {
      const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
      assert.ok(Math.abs(sum - 1) < .001, `${name}: invalid weight at ${i}`);
    }
  }
  const mixer = new AnimationMixer(model);
  const measurements = [];
  for (const clip of asset.animations) {
    mixer.stopAllAction(); const action = mixer.clipAction(clip).play();
    let minY = Infinity; let maxExtent = 0;
    for (let i = 0; i <= 16; i++) {
      mixer.setTime(clip.duration * i / 16); model.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(model, true);
      const size = bounds.getSize(new Vector3());
      assert.ok([...size].every(Number.isFinite));
      assert.ok(size.length() > .1 && size.length() < 5, `${name}/${clip.name}: exploded rig`);
      assert.ok(bounds.min.y >= -.005, `${name}/${clip.name}: geometry penetrates the floor`);
      minY = Math.min(minY, bounds.min.y); maxExtent = Math.max(maxExtent, size.length());
    }
    measurements.push({ clip: clip.name, seconds: clip.duration, minY: +minY.toFixed(3), extent: +maxExtent.toFixed(3) });
    const restIndex = skins[0].morphTargetDictionary.RestingPose;
    assert.equal(skins[0].morphTargetInfluences[restIndex], ['Sleep','Snuggle'].includes(clip.name) ? 1 : 0);
    action.stop();
  }
  console.log(JSON.stringify({ asset: name, bytes: bytes.length, meshes: skins.length, bones: skins[0].skeleton.bones.length, measurements }, null, 2));
}
