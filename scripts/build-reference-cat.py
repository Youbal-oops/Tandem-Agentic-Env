"""Build the supplied illustration as an editable, rigged 3D black cat.

Run with Blender --background --factory-startup --python scripts/build-reference-cat.py
Optional flags after --: --adult-only, --no-render. Outputs replace public/models.
This starts a fresh scene. Save any open Blender work before running interactively.
The drawing is interpreted as volumes; its paper grain is not a texture dependency.
"""
import math
import os
import sys
import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'models')
CLIPS = {'Idle': 96, 'Walk': 32, 'Sleep': 96, 'Think': 72,
         'Knead': 48, 'Play': 48, 'Snuggle': 72}


def material(name, color, roughness=.85):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    return mat


def build(kitten=False):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    mats = {name: material(name, color, rough) for name, color, rough in [
        ('Coat', (.012, .011, .009), .95),
        ('Accent', (.006, .005, .004), .9),
        ('Pink', (.30, .042, .040), .9),
        ('EyeWhite', (.86, .82, .66), .65),
        ('Eyes', (.0015, .0012, .001), .32),
        ('Glint', (1, .98, .87), .3),
        ('Whiskers', (.51, .49, .41), .85),
        ('FurInk', (.055, .052, .043), .95),
    ]}
    meshes = []

    def finish(obj, name, mat, bone=None):
        obj.name = name
        obj.data.materials.append(mats[mat])
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        for poly in obj.data.polygons:
            poly.use_smooth = True
        if bone:
            obj.vertex_groups.new(name=bone).add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
        meshes.append(obj)
        return obj

    def ball(name, at, size, mat='Coat', bone=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, location=at)
        obj = bpy.context.object
        obj.scale = size
        return finish(obj, name, mat, bone)

    def stroke(name, points, radius, mat, bone, taper=False):
        curve = bpy.data.curves.new(name, 'CURVE')
        curve.dimensions = '3D'
        curve.bevel_depth = radius
        curve.bevel_resolution = 2
        curve.resolution_u = 12
        spline = curve.splines.new('BEZIER')
        spline.bezier_points.add(len(points)-1)
        for i, (bp, point) in enumerate(zip(spline.bezier_points, points)):
            bp.co = point
            bp.handle_left_type = bp.handle_right_type = 'AUTO'
            if taper:
                bp.radius = 1 - .94 * i / (len(points)-1)
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target='MESH')
        return finish(bpy.context.object, name, mat, bone)

    # Model directly in the seated pose, avoiding folded shoulder geometry.
    hz = 2.12 if not kitten else 1.96
    hw = .455 if not kitten else .49
    ball('Pear shaped trunk', (0, .075, .83), (.365, .29, .72))
    ball('Long chest', (0, .005, 1.42), (.275, .245, .55))
    ball('Neck', (0, -.015, 1.75), (.26, .235, .38))
    ball('Round head', (0, -.025, hz), (hw, .29, .365))
    for s in [-1, 1]:
        ball('Seated haunch', (s*.325, .10, .39), (.285, .30, .365))
        leg = ball('Long front leg', (s*.14, -.205, .64), (.113, .135, .60))
        ball('Front paw', (s*.135, -.255, .087), (.13, .17, .087))
        ball('Hind paw', (s*.40, -.025, .095), (.17, .23, .095))
    anatomy = list(meshes)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in anatomy:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = anatomy[0]
    bpy.ops.object.join()
    skin = bpy.context.object
    meshes[:] = [skin]
    remesh = skin.modifiers.new('Continuous sculpt', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = .016
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = skin.modifiers.new('Soft silhouette', 'SMOOTH')
    smooth.factor = 1.0
    smooth.iterations = 5
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    decimate = skin.modifiers.new('Runtime mesh', 'DECIMATE')
    decimate.ratio = .38
    bpy.ops.object.modifier_apply(modifier=decimate.name)

    arm = bpy.data.armatures.new('CatSkeleton')
    rig = bpy.data.objects.new('KittenRig' if kitten else 'CatRig', arm)
    bpy.context.collection.objects.link(rig)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')

    def bone(name, point, parent=None):
        b = arm.edit_bones.new(name)
        b.head = point
        b.tail = Vector(point) + Vector((0, 0, .12))
        if parent:
            b.parent = arm.edit_bones[parent]

    bone('Root', (0, 0, 0))
    bone('Body', (0, 0, .85), 'Root')
    bone('Neck', (0, 0, 1.65), 'Body')
    bone('Head', (0, 0, hz-.15), 'Neck')
    for side, s in [('L', -1), ('R', 1)]:
        bone('Ear'+side, (s*.30, 0, hz+.22), 'Head')
        bone('Eye'+side, (s*.205, -.29, hz+.045), 'Head')
        for prefix, x, y, z in [('F', s*.14, -.20, 1.12), ('B', s*.36, .10, .48)]:
            name = prefix+side
            bone('Leg'+name, (x, y, z), 'Body')
            bone('Hock'+name, (x, y, .30), 'Leg'+name)
            bone('Paw'+name, (x, y-.05, .09), 'Hock'+name)
    tail = [(-.36, .18, .24), (-.61, .12, .13), (-.72, -.13, .085),
            (-.63, -.38, .075), (-.46, -.40, .075)]
    for i, point in enumerate(tail):
        bone('Tail'+str(i), point, 'Root' if i == 0 else 'Tail'+str(i-1))
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.show_in_front = True

    def ease(t):
        t = max(0, min(1, t))
        return t*t*(3-2*t)

    groups = {b.name: skin.vertex_groups.new(name=b.name) for b in arm.bones}
    for v in skin.data.vertices:
        x, y, z = v.co
        head = ease((z-1.73)/.26)
        neck = ease((z-1.40)/.30)*(1-head)
        weights = {'Head': head, 'Neck': neck, 'Body': 1-head-neck}
        if z < 1.15:
            side = 'L' if x < 0 else 'R'
            front = ease((-y-.10)/.13)*ease((1.16-z)/.36)
            hind = (1-front)*ease((abs(x)-.25)/.15)*ease((.56-z)/.30)
            weights['Body'] = 1-front-hind
            for prefix, amount in [('F', front), ('B', hind)]:
                paw = 1-ease((z-.14)/.12)
                upper = ease((z-.30)/.35)
                weights['Leg'+prefix+side] = amount*upper
                weights['Hock'+prefix+side] = amount*(1-upper)*(1-paw)
                weights['Paw'+prefix+side] = amount*(1-upper)*paw
        for name, weight in weights.items():
            if weight > 0:
                groups[name].add([v.index], weight, 'REPLACE')

    # Rounded triangular ear cups, with red insets on the forward-facing side.
    for side, s in [('L', -1), ('R', 1)]:
        for inner in [False, True]:
            verts, faces = [], []
            rows, cols = 18, 14
            for k in range(rows):
                t = k/(rows-1)
                zt = .10 + .80*t if inner else t
                width = .182*(1-zt)**.72 + .004
                for j in range(cols):
                    u = 2*j/(cols-1)-1
                    verts.append((s*(.292+.105*zt)+u*width*(.79 if inner else 1),
                                  -.04+.042*(1-u*u)-(.018 if inner else 0),
                                  hz+.19+.47*zt))
            for k in range(rows-1):
                for j in range(cols-1):
                    a = k*cols+j
                    faces.append((a, a+1, a+cols+1, a+cols))
            mesh = bpy.data.meshes.new('Ear cup')
            mesh.from_pydata(verts, [], faces)
            obj = bpy.data.objects.new('Ear', mesh)
            bpy.context.collection.objects.link(obj)
            bpy.context.view_layer.objects.active = obj
            solid = obj.modifiers.new('Ear thickness', 'SOLIDIFY')
            solid.thickness = .012 if inner else .025
            bpy.ops.object.modifier_apply(modifier=solid.name)
            finish(obj, ('Red inner ear ' if inner else 'Black ear ')+side,
                   'Pink' if inner else 'Coat', 'Ear'+side)
        ex, ey, ez = s*.205, -.283, hz+.045
        ball('Eye rim '+side, (ex, ey, ez), (.126, .045, .148), 'Accent', 'Eye'+side)
        ball('Ivory eye '+side, (ex, ey-.025, ez), (.112, .036, .132), 'EyeWhite', 'Eye'+side)
        ball('Wide pupil '+side, (ex, ey-.055, ez+.021), (.079, .019, .092), 'Eyes', 'Eye'+side)
        ball('Catchlight '+side, (ex-.027, ey-.074, ez+.065), (.021, .006, .022), 'Glint', 'Eye'+side)
        for j in range(5):
            stroke('Whisker '+side+str(j), [(s*.15, -.302, hz-.13-j*.016),
                   (s*.46, -.35, hz-.13-j*.055),
                   (s*(.83-.03*j), -.31, hz-.10-j*.10)], .0025, 'Whiskers', 'Head', True)
        # Fine silhouette tufts stay geometry in the exported GLB.
        for j in range(12):
            z = hz+.06-j*.028
            x = hw*math.sqrt(max(.1, 1-((z-hz)/.365)**2))
            stroke('Cheek tuft', [(s*(x-.022), -.02, z+.025),
                   (s*(x+.02), -.02, z-.020), (s*(x+.032), -.01, z-.033)],
                   .010, 'Coat', 'Head', True)
        for j in range(3):
            stroke('Ear tip', [(s*(.386+j*.009), -.02, hz+.62),
                   (s*(.398+j*.013), -.018, hz+.69-j*.012)], .008, 'Coat', 'Ear'+side, True)
        for j in range(3):
            x = s*.135+(j-1)*.050
            stroke('Toe line', [(x, -.408, .035), (x, -.416, .078), (x, -.365, .137)],
                   .0018, 'FurInk', 'PawF'+side)
        for j in range(9):
            z = .60+j*.12
            width = .345 if z < 1.1 else .27
            stroke('Side fur', [(s*(width-.012), .025, z+.035),
                   (s*(width+.015), .025, z-.018), (s*(width+.027), .03, z-.035)],
                   .009, 'Coat', 'Body' if z < 1.45 else 'Neck', True)

    ball('Nose', (0, -.320, hz-.095), (.046, .025, .028), 'Eyes', 'Head')
    stroke('Nose glint', [(-.025, -.341, hz-.089), (-.008, -.345, hz-.080)], .003, 'Whiskers', 'Head')
    stroke('Split lip', [(0, -.318, hz-.111), (0, -.321, hz-.170)], .0035, 'Eyes', 'Head')
    stroke('Quiet mouth', [(-.10, -.294, hz-.211), (-.055, -.316, hz-.207),
           (0, -.324, hz-.170), (.055, -.316, hz-.207), (.10, -.294, hz-.211)], .0035, 'Eyes', 'Head')
    tail_obj = stroke('Curled tail', tail, .076, 'Coat', None, True)
    tg = [tail_obj.vertex_groups.new(name='Tail'+str(i)) for i in range(5)]
    for v in tail_obj.data.vertices:
        distances = [(v.co-Vector(p)).length for p in tail]
        near = sorted(range(5), key=lambda i: distances[i])[:2]
        values = [1/max(.001, distances[i])**3 for i in near]
        for i, w in zip(near, values):
            tg[i].add([v.index], w/sum(values), 'REPLACE')

    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = skin
    bpy.ops.object.join()
    skin.name = 'Kitten' if kitten else 'AdultCat'
    for p in skin.data.polygons:
        p.use_smooth = True
    skin.parent = rig
    mod = skin.modifiers.new('Cat skin', 'ARMATURE')
    mod.object = rig
    skin.shape_key_add(name='Basis')
    rest = skin.shape_key_add(name='RestingPose')
    for v in rest.data:
        v.co.z = .10+(v.co.z-.10)*.76 if v.co.z > .10 else v.co.z
    keys = skin.data.shape_keys
    keys.animation_data_create()
    rig.animation_data_create()
    for pb in rig.pose.bones:
        pb.rotation_mode = 'XYZ'
    actions = {}
    for clip, length in CLIPS.items():
        keys.animation_data.action = bpy.data.actions.new('Pose_'+clip)
        rest.value = int(clip in ['Sleep', 'Snuggle'])
        for frame in [0, length]:
            rest.keyframe_insert('value', frame=frame)
        pose = keys.animation_data.action
        pose.use_fake_user = True
        track = keys.animation_data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip, 0, pose)
        track.mute = True
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        rig.animation_data.action = action
        for frame in range(0, length+1, 4):
            t = frame/length
            wave = math.sin(math.tau*t)
            for pb in rig.pose.bones:
                pb.location = (0, 0, 0)
                pb.rotation_euler = (0, 0, 0)
                pb.scale = (1, 1, 1)
            rig.pose.bones['Body'].scale = (1+.004*wave, 1+.003*wave, 1+.004*wave)
            rig.pose.bones['Head'].rotation_euler.y = .018*wave
            for side, sign in [('L', -1), ('R', 1)]:
                blink = max(.035, 1-.965*math.exp(-((t-.70)/.036)**2))
                rig.pose.bones['Eye'+side].scale.y = .04 if clip in ['Sleep', 'Snuggle'] else blink
                rig.pose.bones['Ear'+side].rotation_euler.z = sign*.018*wave
            for i in range(1, 5):
                rig.pose.bones['Tail'+str(i)].rotation_euler.z = .025*wave
            if clip == 'Think':
                rig.pose.bones['Head'].rotation_euler.z = .10+.06*wave
            if clip == 'Snuggle':
                rig.pose.bones['Head'].rotation_euler.z = .08+.018*wave
            if clip in ['Walk', 'Knead']:
                # A seated stepping gesture; this illustration rig is not a quadruped gait.
                for side, phase in [('L', 0), ('R', math.pi)]:
                    step = max(0, math.sin(math.tau*t*2+phase))
                    rig.pose.bones['LegF'+side].location.y = .045*step
                    rig.pose.bones['PawF'+side].rotation_euler.x = -.10*step
            if clip == 'Play':
                rig.pose.bones['LegFL'].rotation_euler.x = -.28-.15*wave
                rig.pose.bones['HockFL'].rotation_euler.x = -.20
            bpy.context.view_layer.update()
            evaluated = skin.evaluated_get(bpy.context.evaluated_depsgraph_get())
            evaluated_mesh = evaluated.to_mesh()
            minz = min(v.co.z for v in evaluated_mesh.vertices)
            evaluated.to_mesh_clear()
            rig.pose.bones['Root'].location.y = max(0, -minz)+.008
            for pb in rig.pose.bones:
                for channel in ['location', 'rotation_euler', 'scale']:
                    pb.keyframe_insert(channel, frame=frame, group=pb.name)
        track = rig.animation_data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip, 0, action)
        track.mute = True
        actions[clip] = action
    if kitten:
        rig.scale = (.64,)*3
    rig['asset'] = 'Black cat inspired by the supplied seated-cat illustration'
    rig['walk_note'] = 'Walk is a seated stepping gesture, not a quadruped locomotion cycle.'
    bpy.context.scene.render.fps = 24
    bpy.context.scene.frame_end = 96
    rig.animation_data.action = actions['Idle']
    keys.animation_data.action = bpy.data.actions['Pose_Idle']
    bpy.context.scene.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    skin.select_set(True)
    bpy.context.view_layer.objects.active = rig
    keys.animation_data.action = None
    filename = 'kitten' if kitten else 'cat'
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, filename+'.glb'),
        export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
        export_force_sampling=True, export_def_bones=True, export_extras=True,
        export_lights=False, export_cameras=False, export_anim_slide_to_zero=True)
    keys.animation_data.action = bpy.data.actions['Pose_Idle']
    return rig, skin, actions


def stage(rig, skin, actions, kitten):
    scene = bpy.context.scene
    scale = .64 if kitten else 1
    floor = material('Warm paper', (.88, .83, .69), .95)
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(floor)
    world = bpy.data.worlds.new('Paper studio')
    world.use_nodes = True
    scene.world = world
    world.node_tree.nodes['Background'].inputs[0].default_value = (.88, .83, .72, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .6
    for at, power, size in [((-3, -4, 6), 420, 5), ((4, -2, 4), 180, 4), ((0, 3, 5), 300, 3)]:
        bpy.ops.object.light_add(type='AREA', location=at)
        light = bpy.context.object
        light.data.energy = power
        light.data.shape = 'DISK'
        light.data.size = size
        light.rotation_euler = (Vector((0, 0, 1.2))-light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.camera_add(location=(0, -8*scale, 1.48*scale))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, 1.41*scale))-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 3.16*scale
    scene.camera = camera
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 768
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'AgX'
    filename = 'kitten' if kitten else 'cat'
    for clip in ([] if '--no-render' in sys.argv else ['Idle', 'Sleep', 'Knead']):
        rig.animation_data.action = actions[clip]
        skin.data.shape_keys.animation_data.action = bpy.data.actions['Pose_'+clip]
        scene.frame_set(0 if clip == 'Idle' else 8)
        scene.render.filepath = os.path.join(OUT, filename+'-'+clip.lower()+'.png')
        bpy.ops.render.render(write_still=True)
    rig.animation_data.action = actions['Idle']
    skin.data.shape_keys.animation_data.action = bpy.data.actions['Pose_Idle']
    scene.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    skin.select_set(True)
    bpy.context.view_layer.objects.active = rig
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_distance = 4.2*scale
                area.spaces.active.region_3d.view_location = Vector((0, 0, 1.4*scale))
                area.spaces.active.region_3d.view_rotation = camera.rotation_euler.to_quaternion()
                area.spaces.active.shading.color_type = 'MATERIAL'
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, filename+'.blend'))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for kitten in ([False] if '--adult-only' in sys.argv else [False, True]):
        rig, skin, actions = build(kitten)
        stage(rig, skin, actions, kitten)
    print('REFERENCE_CAT_COMPLETE', OUT)
