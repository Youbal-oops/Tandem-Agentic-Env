"""Run in Blender's Scripting workspace (Alt-P), or blender -b --python remake_cat.py.
Creates a NEW scene, preserving your existing scene. Blender 4.2+ / 5.x.
An original, shallow 2.5D interpretation of the supplied ink cat, designed for
front-facing website animation, not a full anatomical 360-degree character.
No image textures, add-ons, external assets, or pip packages required.
"""
import bpy
import math
import random
from pathlib import Path
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

# Change OUTPUT_DIR if desired. Re-running replaces these generated output files.
SOURCE_DIR = Path(__file__).resolve().parent if '__file__' in globals() else Path(bpy.path.abspath('//'))
OUTPUT_DIR = SOURCE_DIR.parent / 'public' / 'models' if (SOURCE_DIR.parent / 'package.json').exists() else SOURCE_DIR
RENDER_PREVIEW = True
SEED = 27
FPS = 24
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
rng = random.Random(SEED)
scene = bpy.data.scenes.new('Tandem Ink Cat')
bpy.context.window.scene = scene
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 1, 97
parts = []

def material(name, hex_value):
    rgb = tuple(int(hex_value[i:i+2], 16)/255 for i in (0, 2, 4))
    linear = tuple(v/12.92 if v < .04045 else ((v+.055)/1.055)**2.4 for v in rgb)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*linear, 1)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*linear, 1)
    m.node_tree.links.new(emit.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = False
    return m

ink = material('01 warm charcoal', '24221D')
edge = material('02 black ink', '100F0C')
paper = material('03 warm ivory', 'F4EFDD')
scratch = material('04 faded engraving', '8C887B')
ear_red = material('05 muted red ears', '923F37')
ear_light = material('06 ear scratches', 'B36454')

def weights(v, bone):
    if bone == 'body':
        t = max(0., min(1., (v.z-1.4)/3.0))
        return {'pelvis': 1-t, 'chest': t}
    return {bone: 1.}

def register(obj, mat, bone):
    obj.data.materials.append(mat)
    groups = {}
    for v in obj.data.vertices:
        for name, w in weights(v.co, bone).items():
            if w <= 0: continue
            if name not in groups: groups[name] = obj.vertex_groups.new(name=name)
            groups[name].add([v.index], w, 'REPLACE')
    parts.append(obj)
    return obj

def mesh(name, vertices, faces, mat, bone):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    return register(obj, mat, bone)

def smooth(points, steps=7, closed=True):
    p = [Vector(v) for v in points]
    result = []
    count = len(p) if closed else len(p)-1
    for i in range(count):
        a = p[(i-1)%len(p)] if closed or i else p[0]
        b, c = p[i], p[(i+1)%len(p)]
        d = p[(i+2)%len(p)] if closed or i+2 < len(p) else p[-1]
        for j in range(steps):
            t = j/steps
            result.append(tuple(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)))
    if not closed: result.append(tuple(p[-1]))
    return result

def shape(name, pts, depth, mat, bone, soften=True):
    pts = smooth(pts) if soften else pts
    verts = [Vector((x, depth, z)) for x, z in pts]
    triangles = tessellate_polygon([verts])
    index = {tuple(v): i for i,v in enumerate(verts)}
    faces = [tuple(v if isinstance(v, int) else index[tuple(v)] for v in tri) for tri in triangles]
    return mesh(name, verts, faces, mat, bone)

def stroke(name, pts, depth, width, mat=scratch, bone='head', soften=True):
    pts = smooth(pts, 6, False) if soften and len(pts)>2 else pts
    vertices, faces = [], []
    for i, (x,z) in enumerate(pts):
        prev, nxt = Vector(pts[max(0,i-1)]), Vector(pts[min(len(pts)-1,i+1)])
        delta = nxt-prev
        normal = Vector((-delta.y, delta.x)).normalized()
        taper = .3 + .7*math.sin(math.pi*(i+.4)/(len(pts)-.2)) if len(pts)>2 else 1
        for sign in [-1,1]:
            vertices.append((x+sign*normal.x*width*taper, depth, z+sign*normal.y*width*taper))
        if i: faces.append((2*i-2,2*i-1,2*i+1,2*i))
    return mesh(name,vertices,faces,mat,bone)

def ellipse(name,x,z,rx,rz,depth,mat,bone):
    return shape(name,[(x+rx*math.cos(t*math.tau/72),z+rz*math.sin(t*math.tau/72)) for t in range(72)],depth,mat,bone,False)

# Coordinates: X horizontal, Z up, camera looks along +Y. Total height 7.5.
# Overlapping filled silhouettes avoid ball-shaped seams and preserve the print style.
body = [(-.42,.24),(-1.23,.23),(-1.55,.50),(-1.60,1.17),(-1.47,1.68),(-1.10,2.15),(-.99,2.93),(-.91,3.71),(-.74,4.50),(-.72,5.18),(.71,5.18),(.77,4.48),(.93,3.69),(1.04,2.93),(1.13,2.17),(1.51,1.69),(1.66,1.04),(1.48,.40),(.98,.22),(.39,.22)]
shape('Seated silhouette',body,.08,ink,'body')
stroke('Left flank', [(-1.1,2.12),(-1.43,1.61),(-1.47,.85),(-1.28,.33)],-.03,.014)
parts[-1].vertex_groups.clear()
g=parts[-1].vertex_groups.new(name='pelvis');g.add(list(range(len(parts[-1].data.vertices))),1,'REPLACE')

tailpoints=[(-1.17,.62),(-1.77,.47),(-1.99,.18),(-1.76,.045),(-1.39,.07)]
# A ribbon with smoothly varying skin weights along three tail segments.
tail = stroke('Curled tail',tailpoints,.16,.18,ink,'tail_01')
tail.vertex_groups.clear()
for v in tail.data.vertices:
    t=v.index/max(1,len(tail.data.vertices)-1)*2
    low=min(1,int(t)); frac=t-low
    for name,w in [(f'tail_{low+1:02d}',1-frac),(f'tail_{low+2:02d}',frac)]:
        group=tail.vertex_groups.get(name) or tail.vertex_groups.new(name=name)
        if w>0: group.add([v.index],w,'REPLACE')

for s,side in [(-1,'L'),(1,'R')]:
    ear=[(s*.47,6.38),(s*.78,6.83),(s*1.14,7.20),(s*1.34,7.39),(s*1.47,7.31),(s*1.47,6.68),(s*1.30,6.16)]
    shape('Ear '+side,ear,-.02,edge,'ear_'+side)
    inner=[(s*.70,6.44),(s*.93,6.86),(s*1.31,7.27),(s*1.39,7.22),(s*1.36,6.62),(s*1.23,6.29)]
    shape('Red inner ear '+side,inner,-.05,ear_red,'ear_'+side)
    stroke('Ear rim '+side,[(s*.64,6.46),(s*.95,6.97),(s*1.35,7.32)],-.07,.014,scratch,'ear_'+side)
    for i in range(16):
        z=6.35+i*.037
        stroke('Ear engraved fan',[(s*1.26,z),(s*1.12,z+.09),(s*(.84+.01*i),z+.11)],-.08,.006,edge,'ear_'+side)
    for i in range(7):
        stroke('Ear tip fur',[(s*(1.25+i*.026),7.30),(s*(1.25+i*.019),7.43+rng.uniform(0,.055))],-.04,.006,ink,'ear_'+side,False)

head=[(-.61,6.77),(-1.06,6.60),(-1.30,6.19),(-1.43,5.78),(-1.37,5.38),(-1.05,5.08),(-.69,4.94),(0,4.98),(.69,4.94),(1.05,5.08),(1.38,5.39),(1.43,5.81),(1.26,6.23),(1.05,6.59),(.61,6.77),(0,6.74)]
shape('Large rounded head',head,-.12,ink,'head')
for s,side in [(-1,'L'),(1,'R')]:
    x=s*.64
    ellipse('Eye black contour '+side,x,6.08,.345,.405,-.19,edge,'eye_'+side)
    ellipse('Ivory eye '+side,x,6.08,.291,.347,-.21,paper,'eye_'+side)
    ellipse('Huge pupil '+side,x+s*.007,6.145,.231,.279,-.23,edge,'eye_'+side)
    ellipse('Catchlight '+side,x-.074,6.25,.066,.065,-.25,paper,'eye_'+side)
    stroke('Upper eye hatch',[(x-.26,6.30),(x-.09,6.46),(x+.15,6.42),(x+.29,6.24)],-.24,.009,scratch,'eye_'+side)
    # stipple in lower ivory crescents
    for i in range(75):
        dx=rng.uniform(-.28,.28); dz=rng.uniform(-.34,.34)
        if (dx/.283)**2+(dz/.338)**2<1 and ((dx-s*.007)/.239)**2+((dz-.065)/.287)**2>1:
            ellipse('Eye print speck',x+dx,6.08+dz,.004,.006,-.245,scratch,'eye_'+side)
    stroke('Cheek smile',[(s*.02,5.53),(s*.23,5.34),(s*.43,5.33),(s*.59,5.39)],-.23,.012,edge,'head')
    for i in range(6):
        stroke('Whisker '+side,[(s*.49,5.61-i*.063),(s*(1.03+i*.018),5.65-i*.12),(s*(2.54-i*.15),5.51-i*.154)],-.28,.0045,paper,'whisker_'+side)
    for i in range(3):
        stroke('Under eye scratches',[(s*(.33+i*.02),5.84-i*.033),(s*(.43+i*.03),5.79-i*.032)],-.24,.005,scratch,'head',False)

shape('Little triangular nose',[(-.17,5.78),(-.10,5.83),(0,5.79),(.13,5.82),(.17,5.76),(0,5.66)],-.27,edge,'head')
stroke('Nose glint',[(-.14,5.78),(-.085,5.80),(-.035,5.78)],-.29,.015,paper,'head')
stroke('Nose philtrum',[(0,5.70),(0,5.52)],-.25,.012,edge,'head',False)

for s,side in [(-1,'L'),(1,'R')]:
    leg=[(s*.34,3.43),(s*.91,3.18),(s*.89,2.19),(s*.64,1.19),(s*.51,.43),(s*.57,.17),(s*.39,.06),(s*.05,.08),(s*.025,.31),(s*.12,.91),(s*.13,2.04)]
    shape('Long front leg '+side,leg,-.135,ink,'paw_'+side)
    stroke('Front leg outer engraving',[(s*.93,3.30),(s*.86,2.33),(s*.64,1.35),(s*.45,.42)],-.155,.013,scratch,'paw_'+side)
    stroke('Fine central leg seam',[(s*.20,1.96),(s*.13,1.21),(s*.12,.49),(s*.045,.27)],-.16,.009,scratch,'paw_'+side)
    for i in range(3):
        x=s*(.16+i*.13)
        stroke('Toe',[(x,.10),(x+s*.02,.23),(x-s*.026,.34)],-.18,.01,scratch,'paw_'+side)

def inside(x,z,poly):
    yes=False
    for i in range(len(poly)):
        a,b=poly[i-1],poly[i]
        if (a[1]>z)!=(b[1]>z) and x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]: yes=not yes
    return yes

# Sparse warm scratches, not a shader: these survive glTF and follow the skeleton.
for i in range(205):
    x,z=rng.uniform(-1.55,1.55),rng.uniform(.42,4.91)
    length=rng.uniform(.035,.19)
    dx=-math.copysign(rng.uniform(.008,.05),x)
    if inside(x,z,body) and inside(x+dx,z+length,body):
        bone='body'
        if abs(x)<.65 and z<3.1: bone='paw_L' if x<0 else 'paw_R'
        stroke('Fur engraving',[(x,z),(x+dx*.5,z+length*.5),(x+dx,z+length)],-.18,.0045,scratch,bone)

# Irregular fine silhouette tufts, concentrated on cheeks and shoulders.
for s in [-1,1]:
    for i in range(49):
        z=5.14+i*.027
        x=1.42-.32*((z-5.80)/.70)**2
        stroke('Cheek fur',[(s*(x-.05),z+.04),(s*(x+rng.uniform(.015,.075)),z-.02)],-.14,.006,ink,'head',False)
    for i in range(80):
        z=.5+i*.056
        # Find outer body edge at this height.
        crossings=[]
        for a,b in zip(body,body[1:]+body[:1]):
            if (a[1]>z)!=(b[1]>z): crossings.append(a[0]+(b[0]-a[0])*(z-a[1])/(b[1]-a[1]))
        if crossings:
            x=max(crossings) if s>0 else min(crossings)
            stroke('Body fur',[(x-s*.035,z+.05),(x+s*rng.uniform(.025,.095),z-.05)],.04,.007,ink,'body',False)
for i in range(43):
    x=-.66+i*.031
    stroke('Crown fur',[(x,6.70),(x-.025,6.80+rng.uniform(-.02,.035))],-.14,.006,ink,'head',False)

# Hidden behind the face at rest; the Groom morph brings it forward for a lick.
tongue = ellipse('Small grooming tongue',.50,5.46,.065,.12,.01,ear_red,'head')
tag = tongue.vertex_groups.new(name='_tongue_detail')
tag.add(list(range(len(tongue.data.vertices))),1,'REPLACE')

# One skinned mesh with a modest material palette, no hundreds of draw calls.
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active=parts[0]
bpy.ops.object.join()
cat=bpy.context.object
cat.name='InkCat_Mesh'
armdata=bpy.data.armatures.new('InkCat_Skeleton')
rig=bpy.data.objects.new('InkCat_Rig',armdata)
scene.collection.objects.link(rig)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True); bpy.context.view_layer.objects.active=rig
bpy.ops.object.mode_set(mode='EDIT')
bone_defs=[('root',(0,0,0),None),('pelvis',(0,0,.8),'root'),('chest',(0,0,3.7),'pelvis'),('head',(0,0,5.08),'chest'),('ear_L',(-1.02,0,6.36),'head'),('ear_R',(1.02,0,6.36),'head'),('eye_L',(-.64,0,6.08),'head'),('eye_R',(.64,0,6.08),'head'),('whisker_L',(-.49,0,5.48),'head'),('whisker_R',(.49,0,5.48),'head'),('paw_L',(-.48,0,3.35),'chest'),('paw_R',(.48,0,3.35),'chest'),('tail_01',(-1.17,0,.62),'pelvis'),('tail_02',(-1.78,0,.37),'tail_01'),('tail_03',(-1.92,0,.14),'tail_02')]
for name,pos,parent in bone_defs:
    b=armdata.edit_bones.new(name);b.head=pos;b.tail=Vector(pos)+Vector((0,0,.3))
    if parent:b.parent=armdata.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
for b in rig.pose.bones:b.rotation_mode='XYZ'
mod=cat.modifiers.new('Website skin','ARMATURE');mod.object=rig
cat.parent=rig
rig.show_in_front=True
rig['description']='Front-facing ink cat. Eye bones local Y scale controls blink; local Z rotation tilts features in the drawing plane.'

# Authored poses keep the engraving and silhouette in the same illustration style.
# Sleep folds the ears, closes the eyes, tucks the paws, lowers the head, and makes
# the trunk a broad curled shape. This is deliberately a 2D paper-puppet rig.
cat.shape_key_add(name='Basis')
sleep = cat.shape_key_add(name='SleepCurl')
groom = cat.shape_key_add(name='GroomPaw')
head_names = {'head','eye_L','eye_R','ear_L','ear_R','whisker_L','whisker_R'}

def sleep_point(co, name):
    x,y,z = co
    if name in head_names:
        if name.startswith('eye_'):
            z=6.08+(z-6.08)*.025
        if name.startswith('ear_'):
            s=-1 if name.endswith('L') else 1
            dz=max(0,z-6.36)
            x+=s*dz*.12
            z=6.36+dz*.34
        dx,dz=x*.64,(z-5.92)*.64
        angle=-.46
        return Vector((.74+dx*math.cos(angle)-dz*math.sin(angle), y-.11,
                       1.10+dx*math.sin(angle)+dz*math.cos(angle)))
    if name.startswith('paw_'):
        return Vector((x*.82+.19,y-.12,.11+max(0,z)*.10))
    if name.startswith('tail_'):
        return Vector((x*1.05,y,.08+z*.8))
    return Vector((x*1.12-.16,y+.12,.12+z*.25+.13*max(0,1-(x/1.8)**2)))

for vertex in cat.data.vertices:
    memberships={cat.vertex_groups[g.group].name:g.weight for g in vertex.groups}
    weighted=[(name,w) for name,w in memberships.items() if name in armdata.bones]
    total=sum(w for _,w in weighted)
    assert total>.99
    sleep.data[vertex.index].co=sum((sleep_point(vertex.co,name)*w for name,w in weighted),Vector())/total
    groom.data[vertex.index].co=vertex.co
    if memberships.get('paw_R',0)>.99:
        x,y,z=vertex.co
        # Fold the right foreleg so its paw rests next to the muzzle.
        groom.data[vertex.index].co=(.58+(x-.38)*.66+.12*z,y-.18,5.47-z*.40)
    if '_tongue_detail' in memberships:
        groom.data[vertex.index].co.y=-.40

keys=cat.data.shape_keys
keys.animation_data_create()

def reset():
    for b in rig.pose.bones:
        b.location=(0,0,0);b.rotation_euler=(0,0,0);b.scale=(1,1,1)

def animate(name,frames,fn,bones,pose=lambda t:(0.,0.)):
    reset()
    rig.animation_data_create()
    action=bpy.data.actions.new(name);rig.animation_data.action=action
    pose_action=bpy.data.actions.new('Pose_'+name)
    keys.animation_data.action=pose_action
    for f in frames:
        reset();t=(f-1)/(frames[-1]-1);fn(t)
        sleep.value,groom.value=pose(t)
        sleep.keyframe_insert('value',frame=f)
        groom.keyframe_insert('value',frame=f)
        for name_b in bones:
            b=rig.pose.bones[name_b]
            for prop in ['location','rotation_euler','scale']:b.keyframe_insert(prop,frame=f,group=name_b)
    action.use_fake_user=True
    track=rig.animation_data.nla_tracks.new();track.name=name
    strip=track.strips.new(name,1,action);strip.extrapolation='NOTHING'
    rig.animation_data.action=None
    track.mute=True
    pose_action.use_fake_user=True
    pose_track=keys.animation_data.nla_tracks.new();pose_track.name=name
    pose_track.strips.new(name,1,pose_action);pose_track.mute=True
    keys.animation_data.action=None
    return action

pb=rig.pose.bones
def idle(t):
    wave=math.sin(t*math.tau)
    pb['chest'].location.y=.027*wave
    pb['head'].rotation_euler.z=.021*wave
    pb['ear_L'].rotation_euler.z=.025*math.sin(t*math.tau)
    pb['ear_R'].rotation_euler.z=-.02*math.sin(t*math.tau)

def blink(t):
    amount=1-.965*math.sin(math.pi*t)**4
    for name in ['eye_L','eye_R']:pb[name].scale.y=amount

def swish(t):
    for i in range(1,4):pb[f'tail_{i:02d}'].rotation_euler.z=.16*math.sin(math.tau*t)*i/3

def curious(t):
    v=math.sin(math.pi*t)**2
    pb['head'].rotation_euler.z=.115*v
    pb['ear_L'].rotation_euler.z=-.13*v
    pb['ear_R'].rotation_euler.z=.10*v
    pb['whisker_L'].rotation_euler.z=.045*v

def ease(t):
    t=max(0,min(1,t));return t*t*(3-2*t)

def awake(t):
    idle(t)
    # Brief embedded blink, leaving the main pose channel available to transitions.
    amount=1-.965*math.exp(-((t-.72)/.04)**2)
    for name in ['eye_L','eye_R']:pb[name].scale.y=amount
    swish(t)

def sleeping(t):
    pb['root'].scale.y=1+.013*math.sin(t*math.tau)

def stretch(t):
    phase=max(0,math.sin(math.pi*max(0,(t-.45)/.55)))
    pb['chest'].scale.y=1+.065*phase
    pb['head'].rotation_euler.z=-.075*phase
    pb['ear_L'].rotation_euler.z=-.085*phase
    pb['ear_R'].rotation_euler.z=.085*phase
    for name in ['eye_L','eye_R']:pb[name].scale.y=1-.88*phase

def grooming(t):
    amount=ease(min(t/.18,(1-t)/.18))
    pb['head'].rotation_euler.z=-.10*amount
    pb['head'].rotation_euler.x=.02*math.sin(t*math.tau*4)*amount
    for name in ['eye_L','eye_R']:pb[name].scale.y=1-.72*amount

def reposition(t):
    pb['root'].location.y=.05*math.sin(t*math.tau*3)**2
    pb['paw_L'].rotation_euler.z=.04*math.sin(t*math.tau*3)
    pb['paw_R'].rotation_euler.z=-.04*math.sin(t*math.tau*3)

all_bones=[b.name for b in pb]
animate('Idle',list(range(1,98,4)),awake,all_bones)
animate('Blink',[1,3,5,7,9],blink,all_bones)
animate('TailSwish',list(range(1,50,2)),swish,all_bones)
animate('Curious',list(range(1,74,3)),curious,all_bones)
animate('Sleep',list(range(1,98,4)),sleeping,all_bones,lambda t:(1,0))
animate('WakeStretch',list(range(1,98,4)),stretch,all_bones,lambda t:(1-ease(t/.54),0))
animate('SettleSleep',list(range(1,74,3)),lambda t:None,all_bones,lambda t:(ease(t),0))
animate('Groom',list(range(1,74,3)),grooming,all_bones,lambda t:(0,ease(min(t/.18,(1-t)/.18))*(.98+.02*math.sin(t*math.tau*4))))
animate('Snuggle',list(range(1,98,4)),sleeping,all_bones,lambda t:(1,0))
animate('Reposition',list(range(1,50,2)),reposition,all_bones)
reset();scene.frame_set(1)
sleep.value=1;groom.value=0

camdata=bpy.data.cameras.new('Portrait camera');cam=bpy.data.objects.new('Portrait camera',camdata)
scene.collection.objects.link(cam);cam.location=(0,-16,3.75)
cam.rotation_euler=(Vector((0,0,3.75))-cam.location).to_track_quat('-Z','Y').to_euler()
camdata.type='ORTHO';camdata.ortho_scale=8.0;scene.camera=cam
scene.render.engine='BLENDER_EEVEE'
scene.render.resolution_x=800;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=True
scene.view_settings.view_transform='Standard'
scene.world=bpy.data.worlds.new('InkCat World');scene.world.color=(.8,.8,.8)

# ACTIONS exports the stored clips independently, with skinning and unlit materials.
bpy.ops.object.select_all(action='DESELECT');cat.select_set(True);rig.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(OUTPUT_DIR/'tandem_cat.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_skins=True,export_extras=True)
rig.animation_data.action=bpy.data.actions.get('Sleep')
keys.animation_data.action=bpy.data.actions.get('Pose_Sleep')
scene.frame_set(1)
# Save a separate editable copy without changing your existing file's save path.
bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT_DIR/'tandem_cat.blend'),copy=True)
if RENDER_PREVIEW:
    for clip,frame in [('Sleep',1),('Idle',1),('Groom',37),('WakeStretch',65)]:
        rig.animation_data.action=bpy.data.actions.get(clip)
        keys.animation_data.action=bpy.data.actions.get('Pose_'+clip)
        scene.frame_set(frame)
        scene.render.filepath=str(OUTPUT_DIR/('tandem_cat_'+clip.lower()+'.png'))
        bpy.ops.render.render(write_still=True)
print('TANDEM INK CAT READY:',OUTPUT_DIR)
