# Tandem cats

Original Blender models created for Tandem's painted sunset train theme. Natural
quadruped proportions, smooth simplified anatomy, small paws, triangular ears,
green slit-pupil eyes, and matte coats. No third-party model or texture assets.

## Files

- `cat.glb`: adult, self-contained skinned glTF 2.0.
- `kitten.glb`: a separately proportioned kitten, exported at 64% scale.
- `cat.blend` / `kitten.blend`: editable geometry, armatures, actions and NLA tracks.
- `*-idle.png`, `*-sleep.png`, `*-knead.png`: warm studio pose previews.

Each model has 25 deform bones: Root, Body, Neck, Head, two ears, two eye/blink
controls, four upper legs, four hocks, four paws, and a five-bone tail chain.
The resting clips include a corrective `RestingPose` morph target for smooth
shoulders and hips; the morph track is already included in those named clips.
In Blender, pair the rig's action with `Pose_<clip>` on the mesh's shape keys,
or enable the same named NLA track on both. The saved sources open in Idle with
a camera and studio lighting; the studio objects are excluded from GLB export.
Animations are sampled at 24 fps, with named clips:

| Clip | Duration | Motion |
| --- | --- | --- |
| Idle | 4 s | Breathing, blinking, subtle ear and tail movement |
| Walk | 1.33 s | Four-beat in-place walk |
| Sleep | 4 s | Low settled pose, closed eyes, quiet breathing |
| Think | 3 s | Head tilt, looking around, attentive ear |
| Knead | 2 s | Alternating front paws |
| Play | 2 s | Raised paw and batting gesture |
| Snuggle | 3 s | Low pose with a gentle sideways head lean |

Walk is in-place: move the instance in your scene. Snuggle is a solo clip:
position the kitten beside its parent. Crossfade state changes over ~0.35 s.

GLB coordinates are Y-up, with feet near Y=0 and the face toward +Z. The editable
Blender scene is Z-up with the face toward -Y. The kitten's scale is already
included; do not apply 0.64 a second time.

Materials `Coat` and `Accent` may be recolored in Three.js (linear RGB), while
`Cream`, `Pink`, `Iris`, `Eyes`, and `Glint` preserve facial detail. Clone the
materials when recoloring independently. Suggested colors:

- Claude: Coat `[.87,.72,.49]`, Accent `[.68,.31,.12]`.
- Codex: Coat `[.30,.43,.56]`, Accent `[.12,.22,.32]`.
- Give a kitten the same Coat and Accent as its parent.

The assets have no external textures, cameras, or lights. Use a warm key light,
cool fill, and soft contact shadows. Use `SkeletonUtils.clone()` when making
independent skinned instances and a separate `AnimationMixer` for each cat.

## Preview / regenerate / validate

Run `npm.cmd run dev`, then open `http://127.0.0.1:5173/cats.html`. The studio
offers both models, all seven clips, coat switching, pause, and orbit controls.
It respects reduced motion and suspends animation updates in hidden tabs.
The train scene integration is a separate step; this preview does not replace it.

Regenerate with installed Blender:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.0\blender.exe' --background --factory-startup --python scripts/build-cats.py
node scripts/validate-cats.mjs
```

The validation loads both exports through Three.js, clones their skeletons,
checks clip names and normalized weights, and samples every animation for finite
bounds and stable deformation. Pose previews are rendered in Blender.
