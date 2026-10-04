"""Reference-inspired Tandem cats: tall ears, expressive eyes, and a seated silhouette."""
import bpy, math, os, sys
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'models')
os.makedirs(OUT, exist_ok=True)
FPS = 24
CLIPS = {'Idle':96, 'Walk':32, 'Sleep':96, 'Think':72, 'Knead':48, 'Play':48, 'Snuggle':72}

def material(name, color, rough=.72):
    m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    return m

def build(kitten=False):
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    for a in list(bpy.data.actions): bpy.data.actions.remove(a)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)
    mats = {
        'Coat':material('Coat', (.78,.69,.47), .9),
        'Accent':material('Accent', (.32,.085,.035), .86),
        'Cream':material('Cream', (.87,.78,.55), .9),
        'Pink':material('Pink', (.38,.095,.075), .86),
        'Eyes':material('Eyes', (.006,.009,.008), .25),
        'EyeWhite':material('EyeWhite', (.9,.86,.67), .48),
        'Iris':material('Iris', (.052,.073,.05), .32),
        'Glint':material('Glint', (1,.98,.89), .18),
    }
    arm = bpy.data.armatures.new('CatSkeleton')
    rig = bpy.data.objects.new('KittenRig' if kitten else 'CatRig', arm)
    bpy.context.collection.objects.link(rig); bpy.context.view_layer.objects.active = rig
    rig.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
    # Bones point up: local rotations correspond to familiar world axes.
    bones = {}
    def bone(name, at, parent=None, length=.18):
        b = arm.edit_bones.new(name); b.head=at; b.tail=Vector(at)+Vector((0,0,length))
        if parent: b.parent=bones[parent]
        bones[name]=b
    bodyz = .77 if kitten else .92
    headz = 1.13 if kitten else 1.35
    heady = -.60 if kitten else -.79
    headwidth = .435 if kitten else .415
    fronty = -.40 if kitten else -.53
    backy = .36 if kitten else .51
    bone('Root',(0,0,0)); bone('Body',(0,0,bodyz),'Root')
    bone('Neck',(0,fronty,bodyz+.13),'Body')
    bone('Head',(0,heady,headz),'Neck')
    for side,x in [('L',-.22),('R',.22)]:
        bone('Ear'+side,(x,heady,headz+.23),'Head')
        bone('Eye'+side,(x*.88,heady-.286,headz+.035),'Head',.06)
    legs=[('FL',-.235,fronty),('FR',.235,fronty),('BL',-.245,backy),('BR',.245,backy)]
    for name,x,y in legs:
        bone('Leg'+name,(x,y,bodyz-.03),'Body',.20)
        bone('Hock'+name,(x,y,.40),'Leg'+name,.15)
        bone('Paw'+name,(x,y-.035,.10),'Hock'+name,.1)
    tailbase=.59 if kitten else .72
    tailpts=[(0,tailbase,bodyz+.04),(0,tailbase+.28,bodyz+.07),(0,tailbase+.56,bodyz+.20),(0,tailbase+.74,bodyz+.43),(0,tailbase+.78,bodyz+.66)]
    for i,p in enumerate(tailpts): bone('Tail'+str(i),p,'Body' if i==0 else 'Tail'+str(i-1))
    bpy.ops.object.mode_set(mode='OBJECT'); rig.show_in_front=True
    meshes=[]
    def finish(obj,name,mat,weights):
        obj.name=name; obj.data.materials.append(mats[mat])
        bpy.context.view_layer.objects.active=obj
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        for poly in obj.data.polygons: poly.use_smooth=True
        for bn,ids in weights.items(): obj.vertex_groups.new(name=bn).add(ids,1,'REPLACE')
        mod=obj.modifiers.new('Cat skin','ARMATURE'); mod.object=rig
        obj.parent=rig; meshes.append(obj); return obj
    def ball(name,at,size,mat,bn,segments=20,rings=12):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,location=at)
        obj=bpy.context.object; obj.scale=size
        return finish(obj,name,mat,{bn:list(range(len(obj.data.vertices)))})
    def stroke(name,pts,radius,mat,bn):
        curve=bpy.data.curves.new(name,'CURVE'); curve.dimensions='3D'; curve.bevel_depth=radius
        curve.bevel_resolution=2; curve.resolution_u=12
        sp=curve.splines.new('BEZIER'); sp.bezier_points.add(len(pts)-1)
        for bp,p in zip(sp.bezier_points,pts): bp.co=p; bp.handle_left_type='AUTO'; bp.handle_right_type='AUTO'
        obj=bpy.data.objects.new(name,curve); bpy.context.collection.objects.link(obj)
        bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active=obj
        bpy.ops.object.convert(target='MESH')
        return finish(bpy.context.object,name,mat,{bn:list(range(len(bpy.context.object.data.vertices)))})
    ball('Long torso',(0,.04,bodyz),(.315,.75 if not kitten else .59,.32),'Coat','Body',32,20)
    ball('Shoulders',(0,fronty,bodyz+.035),(.285,.28,.35),'Coat','Body')
    ball('Soft haunches',(0,backy,bodyz-.015),(.33,.30,.34),'Coat','Body')
    ball('Neck',(0,fronty-.075,bodyz+.21),(.225,.25,.32),'Coat','Neck')
    # Fuse torso volumes into one smooth surface, retaining Body weights.
    torso=[o for o in meshes if o.name in ['Long torso','Shoulders','Soft haunches']]
    bpy.ops.object.select_all(action='DESELECT')
    for o in torso: o.select_set(True)
    bpy.context.view_layer.objects.active=torso[0]; bpy.ops.object.join()
    torso_obj=bpy.context.object
    for o in torso[1:]: meshes.remove(o)
    remesh=torso_obj.modifiers.new('Continuous torso','REMESH'); remesh.mode='VOXEL'; remesh.voxel_size=.028
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth=torso_obj.modifiers.new('Soft silhouette','SMOOTH'); smooth.factor=1.2; smooth.iterations=5
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    dec=torso_obj.modifiers.new('Lightweight torso','DECIMATE'); dec.ratio=.5
    bpy.ops.object.modifier_apply(modifier=dec.name)
    torso_obj.vertex_groups.clear(); torso_obj.vertex_groups.new(name='Body').add(list(range(len(torso_obj.data.vertices))),1,'REPLACE')
    for p in torso_obj.data.polygons: p.use_smooth=True
    ball('Feline head',(0,heady,headz),(headwidth,.325,.34),'Coat','Head',40,24)
    def tuft(name, start, end, radius, bn, mat='Coat'):
        # Short tapered fur geometry survives GLB export without particle hair.
        a,b=Vector(start),Vector(end); tangent=(b-a).normalized()
        u=tangent.cross(Vector((0,1,0))).normalized(); v=tangent.cross(u).normalized()
        verts=[]; faces=[]
        for k in range(4):
            t=k/3; p=a.lerp(b,t); r=radius*(1-t)**1.3+.0007
            for j in range(6): verts.append(p+r*(u*math.cos(j*math.tau/6)+v*math.sin(j*math.tau/6)))
        for k in range(3):
            for j in range(6): faces.append((k*6+j,k*6+(j+1)%6,(k+1)*6+(j+1)%6,(k+1)*6+j))
        me=bpy.data.meshes.new(name); me.from_pydata(verts,[],faces)
        obj=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(obj)
        finish(obj,name,mat,{bn:list(range(len(verts)))})
    for side,x in [('L',-.22),('R',.22)]:
        sign=-1 if x<0 else 1
        # Curved, thin ear cups with rounded tips and a recessed inner surface.
        for inner in [False,True]:
            verts=[]; faces=[]; rows=14; cols=12
            for k in range(rows):
                t=k/(rows-1); zt=.10+t*.79 if inner else t
                width=.177*(1-zt)**.65+.003
                for j in range(cols):
                    w=(j/(cols-1)*2-1)*(.77 if inner else 1)
                    verts.append((sign*(.238+.103*zt)+w*width,
                        heady-.067+.054*(1-w*w)+.08*zt-(.009 if inner else 0),
                        headz+.21+.59*zt))
            for k in range(rows-1):
                for j in range(cols-1):
                    a=k*cols+j; faces.append((a,a+1,a+1+cols,a+cols))
            me=bpy.data.meshes.new('Ear cup'); me.from_pydata(verts,[],faces)
            obj=bpy.data.objects.new('Ear inset' if inner else 'Ear shell',me); bpy.context.collection.objects.link(obj)
            bpy.context.view_layer.objects.active=obj
            if not inner:
                solid=obj.modifiers.new('Ear thickness','SOLIDIFY'); solid.thickness=.028
                bpy.ops.object.modifier_apply(modifier=solid.name)
            finish(obj,('Inner ear ' if inner else 'Tall ear ')+side,'Pink' if inner else 'Accent',{'Ear'+side:list(range(len(obj.data.vertices)))})
        for j in range(3):
            tuft('Ear tip fur', (sign*(.34+j*.009),heady+.011,headz+.775-j*.012),
                 (sign*(.35+j*.015),heady+.016,headz+.84-j*.017),.012,'Ear'+side,'Accent')
        ex=x*.88; eyez=headz+.035; eyey=heady-.278
        ball('Soft eye socket '+side,(ex,eyey,eyez),(.147,.049,.164),'Accent','Head',32,20)
        ball('Eye outline '+side,(ex,eyey-.014,eyez),(.134,.043,.150),'Eyes','Eye'+side,32,20)
        ball('Ivory eye '+side,(ex,eyey-.030,eyez),(.123,.040,.139),'EyeWhite','Eye'+side,32,20)
        ball('Deep iris '+side,(ex,eyey-.063,eyez+.011),(.093,.015,.106),'Iris','Eye'+side,32,20)
        ball('Round pupil '+side,(ex,eyey-.075,eyez+.013),(.077,.012,.091),'Eyes','Eye'+side,32,20)
        ball('Eye sparkle '+side,(ex-.032,eyey-.087,eyez+.061),(.023,.007,.025),'Glint','Eye'+side,16,12)
        ball('Small eye sparkle '+side,(ex+.029,eyey-.086,eyez-.039),(.007,.003,.008),'Glint','Eye'+side,12,8)
        ball('Muzzle '+side,(x*.30,heady-.291,headz-.153),(.102,.067,.077),'Coat','Head')
        for j in range(4):
            stroke('Whisker '+side+str(j),[(x*.53,heady-.35,headz-.13-j*.020),
                (sign*.40,heady-.39,headz-.10-j*.045),(sign*(.65+j*.035),heady-.34,headz-.055-j*.07)],.0018,'EyeWhite','Head')
        for j in range(7):
            z=headz+.05-j*.038
            tuft('Cheek fur', (sign*(.385-j*.003),heady-.07,z),
                 (sign*(.44-j*.003),heady-.055,z-.06),.026,'Head')
    # Soft inverted triangular nose and feline split lip.
    me=bpy.data.meshes.new('Nose'); me.from_pydata([(-.04,heady-.368,headz-.09),(.04,heady-.368,headz-.09),(0,heady-.38,headz-.13)],[],[(0,2,1)])
    obj=bpy.data.objects.new('Nose',me); bpy.context.collection.objects.link(obj); finish(obj,'Nose','Eyes',{'Head':[0,1,2]})
    stroke('Split lip',[(0,heady-.36,headz-.13),(0,heady-.36,headz-.17)],.004,'Eyes','Head')
    stroke('Feline mouth',[(-.055,heady-.343,headz-.18),(-.027,heady-.358,headz-.19),(0,heady-.36,headz-.17),(.027,heady-.358,headz-.19),(.055,heady-.343,headz-.18)],.004,'Eyes','Head')
    for name,x,y in legs:
        hind=name[0]=='B'
        levels=[bodyz+.075,bodyz-.08,.59 if not kitten else .51,.40,.25,.12]
        radii=[.16,.15,.115,.077,.058,.058] if hind else [.115,.11,.085,.068,.056,.058]
        verts=[]; faces=[]
        for k,(z,r) in enumerate(zip(levels,radii)):
            yy=y+([0,.015,.07,.085,.05,-.035][k] if hind else -.005*k)
            for j in range(16): verts.append((x+r*math.cos(j*math.tau/16),yy+r*math.sin(j*math.tau/16),z))
        for k in range(len(levels)-1):
            for j in range(16): faces.append((k*16+j,k*16+(j+1)%16,(k+1)*16+(j+1)%16,(k+1)*16+j))
        faces += [tuple(range(16)),tuple(reversed(range(80,96)))]
        me=bpy.data.meshes.new('Continuous leg'); me.from_pydata(verts,[],faces)
        obj=bpy.data.objects.new('Leg '+name,me); bpy.context.collection.objects.link(obj)
        finish(obj,'Continuous leg '+name,'Coat',{})
        upper=obj.vertex_groups.new(name='Leg'+name); lower=obj.vertex_groups.new(name='Hock'+name)
        for k,z in enumerate(levels):
            weight=max(0,min(1,(z-.34)/.18)); ids=list(range(k*16,(k+1)*16))
            if weight: upper.add(ids,weight,'REPLACE')
            if weight<1: lower.add(ids,1-weight,'REPLACE')
        ball('Small paw '+name,(x,y-.065,.095),(.105,.15,.095),'Coat','Paw'+name)
        for dx in [-.031,.031]:
            stroke('Toe '+name+str(dx),[(x+dx,y-.205,.08),(x+dx,y-.19,.12)],.003,'Accent','Paw'+name)
    # A continuous skin-weighted tail: rings blend between adjacent chain bones.
    centers=[]
    for i in range(len(tailpts)-1):
        p0=Vector(tailpts[max(0,i-1)]); p1=Vector(tailpts[i]); p2=Vector(tailpts[i+1]); p3=Vector(tailpts[min(4,i+2)])
        for j in range(8):
            t=j/8
            p=.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
            centers.append((p,i,t))
    centers.append((Vector(tailpts[-1]),4,0))
    verts=[]; faces=[]
    for k,(p,i,t) in enumerate(centers):
        tangent=(centers[min(k+1,len(centers)-1)][0]-centers[max(0,k-1)][0]).normalized()
        across=Vector((1,0,0)); other=tangent.cross(across).normalized()
        radius=.075*(1-.45*k/(len(centers)-1))
        if k==len(centers)-1: radius=.015
        for j in range(12): verts.append(p+radius*(math.cos(j*math.tau/12)*across+math.sin(j*math.tau/12)*other))
    for k in range(len(centers)-1):
        for j in range(12): faces.append((k*12+j,k*12+(j+1)%12,(k+1)*12+(j+1)%12,(k+1)*12+j))
    faces += [tuple(reversed(range(12))),tuple(range((len(centers)-1)*12,len(centers)*12))]
    me=bpy.data.meshes.new('Tail skin'); me.from_pydata(verts,[],faces)
    obj=bpy.data.objects.new('Marshmallow tail',me); bpy.context.collection.objects.link(obj)
    finish(obj,'Marshmallow tail','Accent',{})
    groups=[obj.vertex_groups.new(name='Tail'+str(i)) for i in range(5)]
    for k,(p,i,t) in enumerate(centers):
        ids=list(range(k*12,(k+1)*12)); groups[i].add(ids,1-t,'REPLACE')
        if t: groups[i+1].add(ids,t,'REPLACE')
    for side in [-1,1]:
        for j in range(8):
            tuft('Chest fur', (side*(.13+j*.008),fronty-.20,bodyz+.22-j*.026),
                 (side*(.19+j*.006),fronty-.21,bodyz+.14-j*.027),.021,'Neck')
    # Fuse the anatomy so shoulders, hips and neck have no visible primitive seams.
    anatomy=[o for o in meshes if o.name in ['Long torso','Neck','Feline head'] or o.name.startswith('Continuous leg ')]
    bpy.ops.object.select_all(action='DESELECT')
    for o in anatomy: o.select_set(True)
    bpy.context.view_layer.objects.active=anatomy[0]; bpy.ops.object.join()
    base=bpy.context.object
    for o in anatomy[1:]: meshes.remove(o)
    reference=base.copy(); reference.data=base.data.copy(); reference.name='SkinWeightReference'
    bpy.context.collection.objects.link(reference)
    for mod in list(reference.modifiers): reference.modifiers.remove(mod)
    remesh=base.modifiers.new('Seamless feline silhouette','REMESH'); remesh.mode='VOXEL'; remesh.voxel_size=.022
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth=base.modifiers.new('Smooth anatomy','SMOOTH'); smooth.factor=1; smooth.iterations=5
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    dec=base.modifiers.new('Lightweight anatomy','DECIMATE'); dec.ratio=.48
    bpy.ops.object.modifier_apply(modifier=dec.name)
    transfer=base.modifiers.new('Restore skin weights','DATA_TRANSFER'); transfer.object=reference
    transfer.use_vert_data=True; transfer.data_types_verts={'VGROUP_WEIGHTS'}
    transfer.vert_mapping='POLYINTERP_NEAREST'; transfer.layers_vgroup_select_src='ALL'; transfer.layers_vgroup_select_dst='NAME'
    bpy.ops.object.modifier_apply(modifier=transfer.name)
    bpy.data.objects.remove(reference,do_unlink=True)
    # Blend the limb roots through the shoulders/hips rather than transferring
    # rigid boundaries from the construction pieces.
    def smoothstep(v):
        v=max(0,min(1,v)); return v*v*(3-2*v)
    for v in base.data.vertices:
        x,y,z=v.co
        if z>bodyz+.10: continue
        name,lx,ly=min(legs,key=lambda leg:(x-leg[1])**2+(y-leg[2])**2)
        distance=math.hypot(x-lx,y-ly)
        if distance>.23: continue
        limb=smoothstep((bodyz+.08-z)/.30)*smoothstep((abs(x)-.07)/.12)
        if limb<=0: continue
        for g in base.vertex_groups: g.remove([v.index])
        base.vertex_groups['Body'].add([v.index],1-limb,'REPLACE')
        upper=smoothstep((z-.30)/.24)
        base.vertex_groups['Leg'+name].add([v.index],limb*upper,'REPLACE')
        base.vertex_groups['Hock'+name].add([v.index],limb*(1-upper),'REPLACE')
    for p in base.data.polygons: p.use_smooth=True
    # Join mesh pieces into one skinned mesh to keep runtime draw calls small.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes: obj.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]; bpy.ops.object.join()
    skin=bpy.context.object; skin.name='Kitten' if kitten else 'AdultCat'
    # A corrective resting shape keeps the seamless shoulders and hips smooth
    # in the low pose, avoiding the pinching caused by folding a simple rig.
    skin.shape_key_add(name='Basis')
    rest=skin.shape_key_add(name='RestingPose')
    drop=.43 if kitten else .50
    for vi,v in enumerate(rest.data):
        tailweights=[(int(skin.vertex_groups[g.group].name[4:]),g.weight)
                     for g in skin.data.vertices[vi].groups
                     if skin.vertex_groups[g.group].name.startswith('Tail')]
        if tailweights:
            for i,weight in tailweights:
                t=i/4
                target=Vector((.42*math.sin(math.pi*t),tailbase+.35*math.sin(math.pi*t)-.75*t,
                               (bodyz+.04)*(1-t)+(drop+.09)*t))
                v.co+=(target-Vector(tailpts[i]))*weight
            continue
        z=v.co.z
        if z<.75: v.co.z+=drop*min(1,(.75-z)/(.75-.18))
    # Author a sitting silhouette and move its joints with it. The corrective
    # shape removes the skinning offset, so gestures pivot at the seated head,
    # shoulders and paws instead of rotating around the standing skeleton.
    sitting=skin.shape_key_add(name='SittingPose')
    def sit_target(name, co):
        p=Vector(co); x,y,z=p
        if name=='Root': return p
        if name.startswith(('Head','Ear','Eye')):
            return p+Vector((0,.38,.37 if not kitten else .31))
        if name=='Neck': return p+Vector((0,.20,.20))
        if name.startswith('Tail'):
            i=int(name[4:]); t=i/4
            goal=Vector((-.52*math.sin(t*math.pi*.8),tailbase*.60+.12-.91*t,
                         .58*(1-t)**2+.085))
            return p+(goal-Vector(tailpts[i]))
        if name.startswith(('LegF','HockF','PawF')):
            lift=.24*max(0,min(1,(z-.10)/(bodyz-.13)))
            return Vector((x*.84,y+.24,z+lift))
        if name.startswith(('LegB','HockB','PawB')):
            return Vector((x*1.32,.13+y*.55,.10+(z-.10)*.49))
        return Vector((x*1.03,.13+y*.60,z-.62*y))
    rig.animation_data_create()
    for pb in rig.pose.bones: pb.rotation_mode='XYZ'
    joint_offsets={name:sit_target(name,b.head_local)-b.head_local for name,b in arm.bones.items()}
    # Every bone keeps its rest orientation; local translations account for
    # parent movement. Retain those locations for all seated animation clips.
    for pb in rig.pose.bones:
        pb.matrix=Matrix.Translation(joint_offsets[pb.name]) @ pb.bone.matrix_local
        bpy.context.view_layer.update()
    seated_locations={pb.name:pb.location.copy() for pb in rig.pose.bones}
    for vi,v in enumerate(sitting.data):
        original=skin.data.vertices[vi].co
        target=Vector(); offset=Vector(); total=0
        for g in skin.data.vertices[vi].groups:
            name=skin.vertex_groups[g.group].name
            target+=sit_target(name,original)*g.weight
            offset+=joint_offsets[name]*g.weight; total+=g.weight
        if total: v.co=target/total-offset/total
    for pb in rig.pose.bones: pb.location=(0,0,0)
    shape_keys=skin.data.shape_keys; shape_keys.animation_data_create()
    for clip,length in CLIPS.items():
        shape_keys.animation_data.action=bpy.data.actions.new('Pose_'+clip)
        rest.value=1 if clip in ['Sleep','Snuggle'] else 0
        rest.keyframe_insert('value',frame=0); rest.keyframe_insert('value',frame=length)
        sitting.value=1 if clip in ['Idle','Think','Knead','Play'] else 0
        sitting.keyframe_insert('value',frame=0); sitting.keyframe_insert('value',frame=length)
        action=shape_keys.animation_data.action; action.use_fake_user=True
        track=shape_keys.animation_data.nla_tracks.new(); track.name=clip
        track.strips.new(clip,0,action); track.mute=True
    shape_keys.animation_data.action=bpy.data.actions['Pose_Idle']; rest.value=0; sitting.value=1
    # Blender join retains only the active mesh's armature modifier.
    rig.animation_data_create()
    for pb in rig.pose.bones: pb.rotation_mode='XYZ'
    def animate(clip,length):
        shape_keys.animation_data.action=bpy.data.actions['Pose_'+clip]
        rest.value=1 if clip in ['Sleep','Snuggle'] else 0
        is_seated=clip in ['Idle','Think','Knead','Play']
        sitting.value=1 if is_seated else 0
        rig.animation_data.action=None
        for pb in rig.pose.bones: pb.location=(0,0,0); pb.rotation_euler=(0,0,0); pb.scale=(1,1,1)
        action=bpy.data.actions.new(clip); action.use_fake_user=True; rig.animation_data.action=action
        for f in range(0,length+1,4):
            t=f/length; s=math.sin(math.tau*t); c=math.cos(math.tau*t)
            for pb in rig.pose.bones: pb.location=(0,0,0); pb.rotation_euler=(0,0,0); pb.scale=(1,1,1)
            if is_seated:
                for name,location in seated_locations.items(): rig.pose.bones[name].location=location
            body=rig.pose.bones['Body']; head=rig.pose.bones['Head']
            # Local Y is vertical for these bones.
            body.location.y+=.007*s; body.scale=(1+.004*s,1+.006*s,1+.004*s)
            head.rotation_euler.y=.045*s
            for i in range(5): rig.pose.bones['Tail'+str(i)].rotation_euler.x=.08*s/(i+1)
            blink=max(.035,1- math.exp(-((t-.70)/.035)**2)*.965)
            for side in ['L','R']:
                rig.pose.bones['Eye'+side].scale.y=blink
                rig.pose.bones['Ear'+side].rotation_euler.z=.025*s*(1 if side=='L' else -1)
            if clip=='Walk':
                body.location.y=.018*math.cos(math.tau*t*2)
                for name,phase in [('FL',0),('FR',math.pi),('BL',math.pi/2),('BR',math.pi*1.5)]:
                    wave=math.sin(math.tau*t+phase)
                    rig.pose.bones['Leg'+name].rotation_euler.x=.28*wave
                    rig.pose.bones['Hock'+name].rotation_euler.x=-.35*max(0,wave)
                    rig.pose.bones['Paw'+name].rotation_euler.x=-.28*wave+.35*max(0,wave)
            elif clip in ['Sleep','Snuggle']:
                body.location.y=-drop+.005*s
                head.rotation_euler.x=.025; head.rotation_euler.y=.015*s
                for side in ['L','R']: rig.pose.bones['Eye'+side].scale.y=.045
                for i in range(5): rig.pose.bones['Tail'+str(i)].rotation_euler.x=.012*s
                if clip=='Snuggle': head.rotation_euler.z=.055+.015*s; head.rotation_euler.y=-.035
            elif clip=='Think':
                head.rotation_euler.z=.16+.10*s; head.rotation_euler.y=.13*s
                rig.pose.bones['EarR'].rotation_euler.z=-.20
            elif clip=='Knead':
                head.rotation_euler.x=.15
                for name,phase in [('FL',0),('FR',math.pi)]:
                    wave=math.sin(math.tau*t*2+phase)
                    rig.pose.bones['Leg'+name].rotation_euler.x=-.12+.10*wave
                    rig.pose.bones['Hock'+name].rotation_euler.x=.12-.10*wave
                    rig.pose.bones['Paw'+name].rotation_euler.x=.08*wave
                body.rotation_euler.x=.025*math.sin(math.tau*t*2)
            elif clip=='Play':
                head.rotation_euler.z=.12*s
                rig.pose.bones['LegFL'].rotation_euler.x=-.72-.35*s
                rig.pose.bones['PawFL'].rotation_euler.z=.23*s
                for i in range(5): rig.pose.bones['Tail'+str(i)].rotation_euler.x=.15*s
            # Bake a vertical correction so paws never penetrate the bench.
            bpy.context.view_layer.update()
            deps=bpy.context.evaluated_depsgraph_get(); evaluated=skin.evaluated_get(deps)
            mesh=evaluated.to_mesh()
            minz=min((skin.matrix_world @ v.co).z for v in mesh.vertices)
            evaluated.to_mesh_clear()
            rig.pose.bones['Root'].location.y=max(0,-minz)+.014
            for pb in rig.pose.bones:
                pb.keyframe_insert('location',frame=f,group=pb.name)
                pb.keyframe_insert('rotation_euler',frame=f,group=pb.name)
                pb.keyframe_insert('scale',frame=f,group=pb.name)
        track=rig.animation_data.nla_tracks.new(); track.name=clip
        strip=track.strips.new(clip,0,action); strip.action_frame_start=0; strip.action_frame_end=length
        track.mute=True
        return action
    actions={name:animate(name,n) for name,n in CLIPS.items()}
    rig.animation_data.action=actions['Idle']; shape_keys.animation_data.action=bpy.data.actions['Pose_Idle']; bpy.context.scene.frame_set(0)
    rig['asset']='Original Tandem reference cat: expressive eyes and seated silhouette'; rig['clips']=list(CLIPS)
    if kitten: rig.scale=(.64,.64,.64)
    bpy.context.scene.render.fps=FPS
    bpy.context.scene.frame_end=96
    bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True); skin.select_set(True)
    bpy.context.view_layer.objects.active=rig
    filename='kitten' if kitten else 'cat'
    # The NLA exporter clears object actions but leaves a shape-key action active;
    # clear it explicitly so Pose_Idle cannot override Sleep/Snuggle tracks.
    shape_keys.animation_data.action=None
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,filename+'.glb'),export_format='GLB',use_selection=True,
        export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_def_bones=True,
        export_extras=True,export_lights=False,export_cameras=False,export_anim_slide_to_zero=True)
    shape_keys.animation_data.action=bpy.data.actions['Pose_Idle']
    # Save an editable native source with all actions preserved.
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,filename+'.blend'))
    return rig,skin,actions,mats

def stage(rig,skin,actions,mats,kitten=False):
    scene=bpy.context.scene
    rig.animation_data.action=actions['Idle']; scene.frame_set(8)
    if kitten:
        mats['Coat'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.019,.022,.019,1)
        mats['Accent'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.009,.011,.010,1)
        mats['Cream'].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.025,.028,.024,1)
    floor=material('Preview warm paper',(.49,.46,.37))
    bpy.ops.mesh.primitive_plane_add(size=200); bpy.context.object.data.materials.append(floor)
    world=bpy.data.worlds.new('Warm studio'); world.use_nodes=True; scene.world=world
    world.node_tree.nodes['Background'].inputs[0].default_value=(.28,.22,.18,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.5
    def area(name,at,power,color,size):
        bpy.ops.object.light_add(type='AREA',location=at); light=bpy.context.object; light.name=name
        light.data.energy=power; light.data.color=color; light.data.shape='DISK'; light.data.size=size
        light.rotation_euler=(Vector((0,0,.7))-light.location).to_track_quat('-Z','Y').to_euler()
    area('Warm window',(-3,-4,6),350,(1,.86,.68),5)
    area('Cool fill',(4,-2,3),180,(.72,.83,1),4)
    area('Rim',(0,4,5),450,(1,.78,.51),3)
    scale=.64 if kitten else 1
    bpy.ops.object.camera_add(location=(2.4*scale,-7*scale,2.8*scale))
    cam=bpy.context.object; cam.rotation_euler=(Vector((0,0,1.18*scale))-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type='ORTHO'; cam.data.ortho_scale=3.15*scale; scene.camera=cam
    scene.render.engine='CYCLES'; scene.cycles.samples=32; scene.cycles.use_denoising=True
    scene.render.resolution_x=900; scene.render.resolution_y=900; scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    for clip in ([] if '--no-render' in sys.argv else ['Idle','Sleep','Knead']):
        rig.animation_data.action=actions[clip]; skin.data.shape_keys.animation_data.action=bpy.data.actions['Pose_'+clip]; scene.frame_set(8)
        scene.render.filepath=os.path.join(OUT,('kitten' if kitten else 'cat')+'-'+clip.lower()+'.png')
        bpy.ops.render.render(write_still=True)
    rig.animation_data.action=actions['Idle']; skin.data.shape_keys.animation_data.action=bpy.data.actions['Pose_Idle']; scene.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True); skin.select_set(True)
    bpy.context.view_layer.objects.active=rig
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.region_3d.view_distance=3.7*scale
                area.spaces.active.region_3d.view_location=Vector((0,0,.85*scale))
                area.spaces.active.region_3d.view_rotation=cam.rotation_euler.to_quaternion()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,('kitten' if kitten else 'cat')+'.blend'))

for kitten in ([False] if '--adult-only' in sys.argv else [False,True]):
    rig,skin,actions,mats=build(kitten)
    stage(rig,skin,actions,mats,kitten)
print('CAT_ASSETS_COMPLETE',OUT)
