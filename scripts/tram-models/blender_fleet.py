"""Photo-referenced Prague fleet, authored from an empty Blender scene.

Run: Blender --background --factory-startup --python blender_fleet.py -- [ids]
     append --render to also make review images and editable .blend scenes.
All geometry below uses glTF coordinates: X across, Y up, front -Z, metres.
The only coordinate conversion is at mesh creation. No old meshes/builders are
imported. References and modelling decisions: docs/model-references/README.md.
"""
import bpy
import math
import sys
import json
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/models'
REVIEW = ROOT / 'docs/model-previews'
SOURCE = ROOT / 'assets/model-source'

PALETTE = {
    'red': ('C9252C', .38, .08), 'cream': ('EAE0C7', .48, .03),
    'white': ('DFE3E2', .42, .08), 'silver': ('AAB4BB', .38, .30),
    'roof': ('747F84', .66, .10), 'rubber': ('24282A', .85, .0),
    'black': ('121B20', .55, .05), 'glass': ('28454E', .23, .12),
    'glint': ('435C62', .25, .10), 'chrome': ('BCC4C7', .26, .35),
    'yellow': ('D8A528', .43, .15), 'light': ('FFF0C8', .3, .0),
    'amber': ('F5A337', .35, .0), 'tail': ('BC1826', .4, .0),
    'interior': ('706857', .8, .0),
}
MATS = {}
def linear(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4

def materials():
    for name, (hexcode, rough, metal) in PALETTE.items():
        color = tuple(linear(int(hexcode[i:i+2], 16)/255) for i in (0, 2, 4)) + (1,)
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = color
        p.inputs['Roughness'].default_value = rough
        p.inputs['Metallic'].default_value = metal
        if name in ('light', 'amber', 'tail'):
            p.inputs['Emission Color'].default_value = color
            p.inputs['Emission Strength'].default_value = .28
        m.diffuse_color = color
        m.use_backface_culling = True
        MATS[name] = m

class Mesh:
    def __init__(self):
        self.v, self.f, self.mat, self.smooth = [], [], [], []
        self.n = []
        self.parts=[]

    def part(self,mesh,name,pivot=(0,0,0),**extras):
        self.parts.append((mesh,name,pivot,extras))

    def merged(self):
        mesh=Mesh();mesh.v=list(self.v);mesh.n=list(self.n);mesh.f=list(self.f);mesh.mat=list(self.mat);mesh.smooth=list(self.smooth)
        for child,_,_,_ in self.parts:
            sub=child.merged();offset=len(mesh.v)
            mesh.v.extend(sub.v);mesh.f.extend(tuple(i+offset for i in f) for f in sub.f)
            mesh.n.extend(sub.n)
            mesh.mat.extend(sub.mat);mesh.smooth.extend(sub.smooth)
        return mesh

    def face(self, mat, points, normal=None, smooth=False, shading=None):
        pts=[]
        for p in points:
            v=Vector(p)
            if not pts or (pts[-1]-v).length>1e-8:pts.append(v)
        if len(pts)>1 and (pts[-1]-pts[0]).length<1e-8:pts.pop()
        if len(pts)<3:return
        if normal is not None:
            # Clipping can leave the first three polygon vertices collinear.
            # Sum the entire boundary area so those patches still face outward
            # instead of becoming invisible with single-sided materials.
            area=sum(((pts[j]-pts[0]).cross(pts[j+1]-pts[0]) for j in range(1,len(pts)-1)),Vector((0,0,0)))
            if area.dot(Vector(normal)) < 0:pts.reverse()
        i = len(self.v)
        self.v.extend(tuple(p) for p in pts)
        self.n.extend(tuple(shading(p)) if shading else None for p in pts)
        self.f.append(tuple(range(i, i+len(pts))))
        self.mat.append(mat)
        self.smooth.append(smooth)

    def box(self, mat, x, y, z, w, h, d):
        a,b=x-w/2,x+w/2; c,e=y-h/2,y+h/2; f,g=z-d/2,z+d/2
        for pts,n in [([(a,c,f),(b,c,f),(b,e,f),(a,e,f)],(0,0,-1)),
                      ([(a,c,g),(b,c,g),(b,e,g),(a,e,g)],(0,0,1)),
                      ([(a,c,f),(a,c,g),(a,e,g),(a,e,f)],(-1,0,0)),
                      ([(b,c,f),(b,c,g),(b,e,g),(b,e,f)],(1,0,0)),
                      ([(a,e,f),(b,e,f),(b,e,g),(a,e,g)],(0,1,0)),
                      ([(a,c,f),(b,c,f),(b,c,g),(a,c,g)],(0,-1,0))]:
            self.face(mat,pts,n)

    def beam(self, mat, a, b, radius=.025, sides=4):
        a,b=Vector(a),Vector(b); axis=(b-a).normalized()
        u=axis.cross(Vector((0,1,0)) if abs(axis.y)<.9 else Vector((1,0,0))).normalized()
        v=axis.cross(u)
        rings=[[p+radius*(u*math.cos(i*math.tau/sides)+v*math.sin(i*math.tau/sides)) for i in range(sides)] for p in (a,b)]
        for i in range(sides):
            j=(i+1)%sides
            self.face(mat,[rings[0][i],rings[0][j],rings[1][j],rings[1][i]],rings[0][i]+rings[0][j]-a*2,True)
        self.face(mat,rings[0],-axis); self.face(mat,rings[1],axis)

    def cylinder(self,mat,x,y,z,r,d,axis='x',n=12):
        dv={'x':Vector((d/2,0,0)),'y':Vector((0,d/2,0)),'z':Vector((0,0,d/2))}[axis]
        c=Vector((x,y,z));self.beam(mat,c-dv,c+dv,r,n)

    def object(self,name,movable=False,pivot=(0,0,0)):
        if self.parts and not movable:return self.merged().object(name)
        mesh=bpy.data.meshes.new(name)
        px,py,pz=pivot
        mesh.from_pydata([(x-px,-z+pz,y-py) for x,y,z in self.v],[],self.f)
        names=list(dict.fromkeys(self.mat))
        for k in names:mesh.materials.append(MATS[k])
        for p,m,s in zip(mesh.polygons,self.mat,self.smooth):
            p.material_index=names.index(m);p.use_smooth=s
        # Weld shared vertices so curved panels have continuous vertex normals.
        obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active=obj;obj.select_set(True)
        mod=obj.modifiers.new('Weld authored seams','WELD');mod.merge_threshold=.00005
        bpy.ops.object.modifier_apply(modifier=mod.name)
        # Glass/paint patches have clipped topology. Recomputing their normals
        # independently made strips and triangular dents on an otherwise smooth
        # cab. Transfer the parent surface's shading, including patch boundaries.
        authored={tuple(round(q,6) for q in (x-px,-z+pz,y-py)):(n[0],-n[2],n[1])
                  for (x,y,z),n in zip(self.v,self.n) if n is not None}
        if authored:
            corner_normals=[(0,0,0)]*len(obj.data.loops)
            for polygon in obj.data.polygons:
                if not polygon.use_smooth:continue
                for j in polygon.loop_indices:
                    v=obj.data.vertices[obj.data.loops[j].vertex_index]
                    corner_normals[j]=authored.get(tuple(round(q,6) for q in v.co),(0,0,0))
            obj.data.normals_split_custom_set(corner_normals)
            for polygon in obj.data.polygons:
                if polygon.use_smooth and any(polygon.normal.dot(obj.data.corner_normals[j].vector)<-.05
                                              for j in polygon.loop_indices):
                    raise ValueError(f'{name}: shading normal faces inside surface at {tuple(polygon.center)}')
        obj.select_set(False)
        obj.location=(px,-pz,py)
        if movable:
            for child,label,origin,extras in self.parts:
                part=child.object(name+'-'+label,True,origin);part.parent=obj
                for key,value in extras.items():part[key]=value
        return obj

# Small geometry-only markings. One material batch, no textures or text engines
# on device. The front displays are representative, not live line numbers.
FONT={
'0':['111','101','101','101','111'],'1':['010','110','010','010','111'],
'2':['111','001','111','100','111'],'3':['111','001','111','001','111'],
'4':['101','101','111','001','001'],'5':['111','100','111','001','111'],
'6':['111','100','111','101','111'],'7':['111','001','010','010','010'],
'8':['111','101','111','101','111'],'9':['111','101','111','001','111'],
'A':['010','101','111','101','101'],'B':['110','101','110','101','110'],
'C':['111','100','100','100','111'],'D':['110','101','101','101','110'],
'E':['111','100','110','100','111'],'F':['111','100','110','100','100'],
'G':['111','100','101','101','111'],'H':['101','101','111','101','101'],
'I':['111','010','010','010','111'],'J':['001','001','001','101','111'],
'K':['101','101','110','101','101'],'L':['100','100','100','100','111'],
'M':['101','111','111','101','101'],'N':['101','111','111','111','101'],
'O':['111','101','101','101','111'],'P':['111','101','111','100','100'],
'R':['110','101','110','101','101'],'S':['111','100','111','001','111'],
'T':['111','010','010','010','010'],'U':['101','101','101','101','111'],
'V':['101','101','101','101','010'],'Y':['101','101','010','010','010'],
'Z':['111','001','010','100','111'],' ':['000']*5,
}
def text(m,word,x,y,z,height=.16,mat='amber',side=None,sign=-1,surf=None):
    p=height/5; width=(len(word)*4-1)*p;start=x-width/2
    for c,ch in enumerate(word):
        for r,row in enumerate(FONT.get(ch,FONT[' '])):
            col=0
            while col<len(row):
                if row[col]!='1':
                    col+=1
                    continue
                run=1
                while col+run<len(row) and row[col+run]=='1':run+=1
                xx=start+(c*4+col)*p; yy=y+height/2-r*p
                end=xx+p*(run-.18)
                pts=[(-xx,yy,z),(-end,yy,z),(-end,yy-p*.82,z),(-xx,yy-p*.82,z)]
                if sign==1:pts=[(-a,b,c) for a,b,c in pts]
                if side:
                    pts=[(side[0],v[1],side[1]+v[0]*(1 if side[0]>0 else -1)) for v in pts]
                if surf and not side:surface_patch(m,surf,[(a,b) for a,b,_ in pts],sign,.035,mat)
                else:m.face(mat,pts,(side[0],0,0) if side else (0,0,sign))
                col+=run

LABEL_CACHE={}
def label(m,word,x,y,z,height=.16,mat='yellow',sign=-1,surf=None):
    """Vector lettering for painted fleet numbers; LED text stays pixel based."""
    if word not in LABEL_CACHE:
        curve=bpy.data.curves.new('Temporary lettering','FONT');curve.body=word
        curve.align_x='CENTER';curve.align_y='CENTER';curve.resolution_u=3
        obj=bpy.data.objects.new('Temporary lettering',curve);bpy.context.collection.objects.link(obj)
        evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        LABEL_CACHE[word]=[[tuple(mesh.vertices[i].co) for i in tri.vertices] for tri in mesh.loop_triangles]
        evaluated.to_mesh_clear();bpy.data.objects.remove(obj,do_unlink=True);bpy.data.curves.remove(curve)
    for tri in LABEL_CACHE[word]:
        pts=[]
        for a,b,_ in tri:
            xx=x+sign*a*height*1.4;yy=y+b*height*1.4
            pts.append((xx,yy,z))
        if surf:surface_patch(m,surf,[(a,b) for a,b,_ in pts],sign,.024,mat)
        else:m.face(mat,pts,(0,0,sign))

def cab_beam(m,surf,a,b,sign,radius=.012,mat='black'):
    pts=[]
    for j in range(9):
        t=j/8;x=a[0]+t*(b[0]-a[0]);y=a[1]+t*(b[1]-a[1])
        pts.append((x,y,surf(x,y)+sign*.027))
    for p,q in zip(pts,pts[1:]):m.beam(mat,p,q,radius)

def mirrors(m,id,tip,w,sign=-1):
    """Cab mirrors from operator photographs; not part of body-width specs."""
    for side in [-1,1]:
        x=side*(w/2+.12)
        z=tip-sign*(.46 if id=='14t' else .57)
        y=2.53 if id=='14t' else 2.61 if id in ['15t','52t'] else 2.58 if id=='kt8d5' else 2.05
        if id=='14t' and side==1:
            arm=[(side*(w/2-.06),3.18,tip-sign*.82),
                 (x,3.15,z+sign*.08),(x,y+.16,z)]
        else:
            arm=[(side*(w/2-.035),y+.24,z-sign*.18),
                 (x,y+.23,z),(x,y+.12,z)]
        for a,b in zip(arm,arm[1:]):m.beam('black',a,b,.018,6)
        # Rounded vertical housing, with reflective face looking aft.
        hw=.078;hh=.18 if id in ['14t','15t','52t'] else .13;r=.035
        ring=[(-hw+r,-hh),(hw-r,-hh),(hw,-hh+r),(hw,hh-r),
              (hw-r,hh),(-hw+r,hh),(-hw,hh-r),(-hw,-hh+r)]
        front=[(x+a,y+b,z+sign*.055) for a,b in ring]
        back=[(x+a,y+b,z-sign*.055) for a,b in ring]
        m.face('black',front,(0,0,sign));m.face('black',back,(0,0,-sign))
        for j in range(8):m.face('black',[front[j],back[j],back[(j+1)%8],front[(j+1)%8]],smooth=True)
        m.face('chrome',[(x+a*.79,y+b*.89,z-sign*.057) for a,b in ring],(0,0,-sign))

def window(m,side,z0,z1,y0,y1,w,frame='rubber',split=False,lower_radius=None):
    # Octagonal recessed rubber seal and inset blue-grey opaque glazing.
    x=side*(w/2+.008);b=.065
    def poly(a,c,d,e,r,inset=0):
        if lower_radius is None:return [(a+r,d),(c-r,d),(c,d+r),(c,e-r),(c-r,e),(a+r,e),(a,e-r),(a,d+r)]
        # PLF's three dropped center lights have broad rounded lower corners,
        # unlike the narrow chamfers of its conventional upper side windows.
        low=min(lower_radius-inset,(c-a)/2,(e-d)/2);points=[]
        for cx,cy,rr,angle,steps in [(c-low,d+low,low,-math.pi/2,3),(c-r,e-r,r,0,1),
                                   (a+r,e-r,r,math.pi/2,1),(a+low,d+low,low,math.pi,3)]:
            for k in range(steps+1):
                t=angle+k*math.pi/(2*steps);points.append((cx+rr*math.cos(t),cy+rr*math.sin(t)))
        return points
    outer=poly(z0,z1,y0,y1,b);inner=poly(z0+.032,z1-.032,y0+.032,y1-.032,b*.6,.032)
    for i in range(len(outer)):
        j=(i+1)%len(outer)
        m.face(frame,[(x,y,z) for z,y in [outer[i],outer[j],inner[j],inner[i]]],(side,0,0))
    m.face('glass',[(x+side*.002,y,z) for z,y in inner],(side,0,0))
    # restrained sky reflection, clipped within the glazing
    m.face('glint',[(x+side*.003,y1-.06,z0+.09),(x+side*.003,y1-.06,z1-.08),
                    (x+side*.003,y1-.20,z1-.08),(x+side*.003,y1-.13,z0+.09)],(side,0,0))
    if split:m.box('chrome',x+side*.005,y1-.29,(z0+z1)/2,.018,.025,z1-z0-.06)

def wheels(m,zs,w,wheelbase=1.9,r=.35,half=None,independent=False):
    for z in zs:
        m.box('black',0,r+.09,z if half is None else z+half*.72,1.72,.25,2.5 if half is None else 1.15)
        for dz in [-wheelbase/2,wheelbase/2] if half is None else [half*wheelbase/2]:
            if not independent:m.cylinder('roof',0,r,z+dz,.085,1.55,'x',8)
            for s in [-1,1]:
                # Tread centres align with Prague's 1,435 mm track gauge.
                m.cylinder('rubber',s*.765,r,z+dz,r,.16,'x',12)
                m.cylinder('chrome',s*.855,r,z+dz,r*.74,.025,'x',12)
                m.cylinder('roof',s*.878,r,z+dz,.10,.03,'x',8)
        for s in [-1,1]:
            m.box('roof',s*.77,r+.11,z if half is None else z+half*.72,.12,.17,1.4 if half is None else .9)
            for dz in [-.45,.45]:
                if half is not None and dz*half<0:continue
                m.box('black',s*.78,.51,z+dz,.18,.15,.18)

def pantograph(m,z,y,classic=False,historic=False):
    mat='red' if historic else 'yellow';rise=1.35
    m.box('roof',0,y+.04,z,1.35,.08,1.65)
    for x in [-.49,.49]:
        for dz in [-.6,.6]:m.cylinder('cream',x,y+.14,z+dz,.09,.18,'y',8)
    if classic:
        for x in [-.44,.44]:
            for d in [-1,1]:
                a=(x,y+.25,z);b=(x,y+.85,z+d*.85);c=(x,y+rise+.25,z)
                m.beam(mat,a,b,.035);m.beam(mat,b,c,.028)
            m.beam(mat,(x,y+.25,z-.16),(-x,y+.85,z+.85),.012)
    else:
        a=(0,y+.24,z-.65);b=(0,y+.85,z+.7);c=(0,y+rise+.25,z-.4)
        m.beam(mat,a,b,.055)
        for x in [-.35,.35]:
            m.beam(mat,(x*.25,b[1],b[2]),(x,c[1],c[2]),.027)
        z-=.4
    m.beam('black',(-.78,y+rise+.28,z),(.78,y+rise+.28,z),.035,8)
    m.beam('chrome',(-.89,y+rise+.19,z),(-.78,y+rise+.28,z),.021)
    m.beam('chrome',(.89,y+rise+.19,z),(.78,y+rise+.28,z),.021)

def roofbox(m,z,y,length,width=1.75):
    m.box('roof',0,y+.10,z,width,.20,length)
    m.box('silver',0,y+.22,z,width-.10,.04,length-.10)
    for s in [-1,1]:
        for j in range(max(3,int(length/.16))):
            zz=z-length/2+.12+j*.16
            x=s*(width/2+.003)
            m.face('black',[(x,y+.07,zz-.018),(x,y+.15,zz-.018),(x,y+.15,zz+.018),(x,y+.07,zz+.018)],(s,0,0))

def kt8_collector(m,z,y,direction,raised):
    # DPP RN2P photographs: single-arm collector, mirrored on the other cab.
    # Only the leading collector is raised in this representative running state.
    def p(x,height,distance):return (x,y+height,z+direction*distance)
    m.box('roof',0,y+.04,z,1.28,.08,1.48)
    for x in [-.45,.45]:
        for dz in [-.52,.52]:m.cylinder('cream',x,y+.14,z+dz,.075,.18,'y',8)
    base=.25;elbow=.98 if raised else .32;head=1.94 if raised else .40
    for x in [-.13,.13]:m.beam('yellow',p(x,base,-.53),p(x,elbow,.70),.038,8)
    m.beam('roof',p(-.21,elbow,.70),p(.21,elbow,.70),.055,8)
    for x in [-.39,.39]:
        m.beam('yellow',p(x*.28,elbow,.70),p(x,head,-.63),.024,8)
        m.beam('roof',p(x*.24,base,-.48),p(x,head-.05,-.58),.010,6)
    for dz in [-.13,.13]:
        m.beam('black',p(-.76,head+.07,-.63+dz),p(.76,head+.07,-.63+dz),.023,8)
        for side in [-1,1]:
            m.beam('chrome',p(side*.76,head+.07,-.63+dz),p(side*.94,head-.06,-.63+dz),.016,6)
    for x in [-.42,.42]:m.beam('roof',p(x,head,-.83),p(x,head,-.43),.022,6)

def kt8_low_window(m,side,start,end,w):
    # ML8LF replacement section has dropped, diagonal-bottom glazing. The
    # white waist follows that glass; it is not a stripe laid across a flat wall.
    for direction in [-1,1]:
        lo=.77;hi=(end if direction>0 else -start)-.14
        def face(mat,points,depth):
            m.face(mat,[(side*(w/2+depth),yy,direction*zz) for zz,yy in points],(side,0,0))
        contour=[(lo,1.03),(lo+.34,1.03),(hi,1.72)]
        face('white',contour+[(hi,2.93),(lo,2.93)],.002)
        face('white',[(.65,1.03),(lo,1.03),(lo,2.93),(.65,2.93)],.002)
        face('white',[(hi,1.72),(hi+.14,1.75),(hi+.14,2.93),(hi,2.93)],.002)
        outer=[(lo,1.21),(lo+.34,1.21),(hi-.05,1.89),(hi,1.94),
               (hi,2.71),(hi-.06,2.77),(lo+.06,2.77),(lo,2.71)]
        inner=[(lo+.035,1.25),(lo+.33,1.25),(hi-.08,1.92),(hi-.035,1.96),
               (hi-.035,2.69),(hi-.08,2.735),(lo+.08,2.735),(lo+.035,2.69)]
        for j in range(len(outer)):
            face('rubber',[outer[j],outer[(j+1)%8],inner[(j+1)%8],inner[j]],.010)
        face('glass',inner,.012)
        face('glint',[(lo+.08,2.65),(hi-.08,2.65),(hi-.08,2.57),(lo+.08,2.60)],.013)
        m.box('chrome',side*(w/2+.015),2.40,direction*(lo+hi)/2,.012,.022,hi-lo-.07)

def bellows(m,z,w,h,length=.20):
    # Corrugated membrane with a rounded upper cross-section. The former flat
    # box buried its own ribs and read as a rigid spacer between tram sections.
    rings=[]
    for k in range(11):
        inset=.09 if k%2==0 else .035
        x=w/2-inset;top=h-inset+.035;bottom=.42+inset*.35
        cross=[(-x,bottom),(x,bottom),(x,top-.15),(x-.12,top),
               (-x+.12,top),(-x,top-.15)]
        rings.append([(a,b,z-length/2+k*length/10) for a,b in cross])
    for a,b in zip(rings,rings[1:]):
        for j in range(6):
            q=(j+1)%6
            m.face('rubber',[a[j],a[q],b[q],b[j]],
                   (a[j][0]+a[q][0],(a[j][1]+a[q][1])/2-(h+.42)/2,0))
    for ring,direction in [(rings[0],-1),(rings[-1],1)]:m.face('rubber',ring,(0,0,direction))

def door(m,side,z,width,w,base,top,opened,classic=False,color='black',animatable=True):
    x=side*(w/2+.012)
    m.box('rubber',x,(base+top)/2,z,.04,top-base,width)
    m.box('chrome',x+side*.013,base-.025,z,.10,.05,width)
    if opened:
        # Recessed sealed vestibule; leaves folded/slid into the two pockets.
        m.box('interior',x+side*.025,(base+top)/2,z,.01,top-base-.08,width-.12)
        m.box('yellow',x+side*.025,base+.045,z,.07,.025,width-.13)
        for dz in [-width*.40,width*.40]:
            m.box(color,x+side*.07,(base+top)/2,z+dz,.10,top-base-.06,width*.15)
            window(m,side,z+dz-width*.065,z+dz+width*.065,base+.45,top-.11,w+.15)
        m.box('black',x+side*.003,base+.20,z,.012,.03,width*.72)
    else:
        # A closed model includes the vestibule, revealed by articulated leaves
        # in the separate viewer GLBs. Map GLBs bake the same geometry together.
        m.box('interior',x-side*.025,(base+top)/2,z,.01,top-base-.08,width-.12)
        m.box('yellow',x-side*.013,base+.045,z,.02,.025,width-.13)
        leaves=4 if classic and width>1 else 2
        for k in range(leaves):
            zz=z-width/2+(k+.5)*width/leaves;dw=width/leaves-.025
            leaf=Mesh()
            leaf.box(color,x+side*.025,(base+top)/2,zz,.025,top-base-.06,dw)
            if classic:
                # Each folding leaf has two separately sealed lights, not a
                # floor-to-ceiling slit. The waist rail is conspicuous on Tatra.
                for low,high in [(base+.24,1.43),(1.52,top-.12)]:
                    window(leaf,side,zz-dw/2+.028,zz+dw/2-.028,low,high,w+.095)
            else:
                window(leaf,side,zz-dw/2+.028,zz+dw/2-.028,base+.20,top-.12,w+.095)
            if not classic:leaf.box('yellow',x+side*.07,base+.98,zz,.014,.055,.065)
            direction=-1 if k<leaves/2 else 1
            hinge=zz+direction*dw/2 if classic else zz
            motion=dict(doorOpenTranslation=[-side*.10 if classic else side*.12,0,direction*width*(.12 if leaves==2 else .13 if k in [0,3] else .36) if classic else direction*width*.48],
                        doorOpenRotationY=side*(1 if k%2==0 else -1)*1.42 if classic else 0) if animatable else {}
            m.part(leaf,f'door-{side}-{z:.3f}-{k}',(x,(base+top)/2,hinge),**motion)
    if not classic:
        m.box('yellow',x+side*.022,base+1.05,z+width/2+.10,.012,.10,.07)

def sidewall(m,side,start,end,w,levels,doors,opened,classic=False,bogies=(),window_sill=1.55,window_top=2.62,window_counts=None,folding=False):
    # Build actual openings. No full solid hull hiding an open door.
    cursor=start
    intervals=[]
    for z,dw,base in sorted(doors):
        intervals.append((cursor,z-dw/2));cursor=z+dw/2
        door(m,side,z,dw,w,base,window_top+.10,opened,classic or folding,'cream' if classic else 'black')
        # An opening ends at its lintel. Previously the entire vertical strip
        # up to the roof was removed, leaving daylight above modern tram doors.
        for i,(y,mat) in enumerate(levels[:-1]):
            low=max(y,window_top+.10);high=levels[i+1][0]
            if high>low:
                m.face(mat,[(side*w/2,low,z-dw/2),(side*w/2,low,z+dw/2),
                            (side*w/2,high,z+dw/2),(side*w/2,high,z-dw/2)],(side,0,0))
    intervals.append((cursor,end))
    for interval,(lo,hi) in enumerate(intervals):
        if hi-lo<.03:continue
        for i,(y,mat) in enumerate(levels[:-1]):
            y1=levels[i+1][0]
            m.face(mat,[(side*w/2,y,lo),(side*w/2,y,hi),(side*w/2,y1,hi),(side*w/2,y1,lo)],(side,0,0))
        count=window_counts[interval] if window_counts is not None else max(1,round((hi-lo)/1.42))
        for j in range(count):
            a=lo+(hi-lo)*j/count+.07;b=lo+(hi-lo)*(j+1)/count-.07
            sill=window_sill((a+b)/2) if callable(window_sill) else window_sill
            if b-a>.25:window(m,side,a,b,sill,window_top,w,split=classic,
                              lower_radius=.20 if classic and sill<1.3 else None)
        # lower equipment seams, kept subtle and in the existing material batch
        for z in [lo+.09,hi-.09]:m.box('roof',side*(w/2+.002),.73,z,.009,.28,.008)
    if classic:
        # Deep rolled apron, with local bogie apertures and door cutouts. The
        # previous thin straight strip made the whole car appear to stand on
        # exposed toy wheels and omitted nearly half of the cream lower body.
        for lo,hi in intervals:
            if hi-lo<.03:continue
            cuts=sorted(set([lo,hi]+[max(lo,min(hi,z+d)) for z in bogies
                                    for d in [-1.45,-1.18,1.18,1.45]]))
            def lower(z):
                distance=min((abs(z-b) for b in bogies),default=10)
                return .30+.34*max(0,min(1,(1.45-distance)/.27))
            for a,b in zip(cuts,cuts[1:]):
                if b-a<1e-6:continue
                ya,yb=lower(a),lower(b)
                m.face('cream',[(side*(w/2-.055),ya,a),(side*(w/2-.055),yb,b),
                                (side*w/2,.78,b),(side*w/2,.78,a)],(side,0,0),True)
                m.face('cream',[(side*(w/2-.12),ya+.025,a),(side*(w/2-.12),yb+.025,b),
                                (side*(w/2-.055),yb,b),(side*(w/2-.055),ya,a)],(side,-1,0))
        return
    # Visible bogie cut-outs interrupt the low skirt rather than burying wheels.
    cut=[start,end]
    for z,dw,_ in doors:cut.extend([z-dw/2,z+dw/2])
    for z in bogies:cut.extend([max(start,z-1.32),min(end,z+1.32)])
    cut=sorted(set(cut))
    for a,b in zip(cut,cut[1:]):
        if b<=a or any(abs((a+b)/2-z)<1.32 for z in bogies):continue
        if any(a<dz+dw/2 and b>dz-dw/2 for dz,dw,_ in doors):continue
        m.box('cream' if classic else levels[0][1],side*(w/2-.02),.44,(a+b)/2,.04,.28,b-a)

def dome(m,z0,z1,w,y,h,mat):
    pts=[(-w/2,y),(-w*.48,y+h*.42),(-w*.40,y+h*.8),(-w*.23,y+h*.98),(0,y+h),
         (w*.23,y+h*.98),(w*.40,y+h*.8),(w*.48,y+h*.42),(w/2,y)]
    for a,b in zip(pts,pts[1:]):
        m.face(mat,[(a[0],a[1],z0),(a[0],a[1],z1),(b[0],b[1],z1),(b[0],b[1],z0)],(a[0]+b[0],1,0),True)
    for z,n in [(z0,-1),(z1,1)]:m.face(mat,[(x,yy,z) for x,yy in pts],(0,0,n))

def rounded_end(m,end,depth,w,levels,mats,sign=-1,power=.45,flat=None):
    """Loft a multi-level cab. Returns exact surface sampler for lamps/decals."""
    join=end-sign*depth
    def curve(u):
        if flat is not None:return 1 if abs(u)<=flat else max(0,(1-abs(u))/(1-flat))
        return max(0,1-u*u)**power
    rings=[]
    for y,d,hw in levels:
        us=sorted(set([-1,-flat,0,flat,1])) if flat is not None else [math.sin(-math.pi/2+i*math.pi/16) for i in range(17)]
        rings.append([tuple(Vector((hw*u,y,join+sign*d*curve(u)))) for u in us])
    normals={}
    for k,ring in enumerate(rings):
        for j,p in enumerate(ring):
            tx=Vector(ring[min(j+1,len(ring)-1)])-Vector(ring[max(0,j-1)])
            ty=Vector(rings[min(k+1,len(rings)-1)][j])-Vector(rings[max(0,k-1)][j])
            n=tx.cross(ty)
            if k==len(rings)-1:n=Vector((0,1,0))
            elif n.z*sign < -1e-8 or (abs(n.z)<1e-8 and n.y<0):n=-n
            normals[p]=n.normalized() if n.length>1e-8 else Vector((0,1,0))
    triangles=[]
    for k in range(len(rings)-1):
        band=[]
        for j in range(len(rings[k])-1):
            a,b=rings[k][j],rings[k][j+1];c,d=rings[k+1][j+1],rings[k+1][j]
            for tri in [(a,b,c),(a,c,d)]:
                m.face(mats[k],tri,(a[0]+b[0],0,sign),flat is None,
                       (lambda p:normals[tuple(p)]) if flat is None else None);band.append(tri)
        triangles.append(band)
    for k,n in [(0,(0,-1,0)),(-1,(0,1,0))]:m.face(mats[0 if k==0 else -1],rings[k],n)
    def sample(x,y,normal=False):
        # Evaluate the actual authored triangles, not the ideal curved loft.
        # Attachments therefore share its exact depth even at profile breaks.
        for k,((y0,_,_),(y1,_,_)) in enumerate(zip(levels,levels[1:])):
            if y0-1e-6<=y<=y1+1e-6:
                for a,b,c in triangles[k]:
                    det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
                    if abs(det)<1e-12:continue
                    u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/det
                    v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/det
                    if min(u,v,1-u-v)>=-1e-7:
                        if normal:
                            if flat is not None:
                                n=(Vector(b)-Vector(a)).cross(Vector(c)-Vector(a))
                                return (n if n.z*sign>=0 else -n).normalized()
                            return (u*normals[a]+v*normals[b]+(1-u-v)*normals[c]).normalized()
                        return u*a[2]+v*b[2]+(1-u-v)*c[2]
        return Vector((0,0,sign)) if normal else end
    def surface(x,y):return sample(x,y)
    surface.normal=lambda x,y:sample(x,y,True)
    surface.rings=rings
    surface.triangles=[tri for band in triangles for tri in band]
    return surface

def lamp(m,x,y,z,r=.11,sign=-1,mat='light',surface=None):
    # Two visible bezel rings and one lens. Hidden cylinder end caps used to
    # consume hundreds of triangles for each tiny lamp without changing it.
    n=20 if r>=.08 else 12
    rings=[]
    for rr,depth in [(r+.025,0),(r+.010,.018),(r,.026)]:
        ring=[]
        for j in range(n):
            xx=x+rr*math.cos(j*math.tau/n);yy=y+rr*math.sin(j*math.tau/n)
            zz=surface(xx,yy)+z-surface(x,y) if surface else z
            ring.append((xx,yy,zz+sign*depth))
        rings.append(ring)
    for k,material in enumerate(['black','chrome']):
        for j in range(n):
            q=(j+1)%n;m.face(material,[rings[k][j],rings[k][q],rings[k+1][q],rings[k+1][j]],(0,0,sign),True)
    if mat=='amber':
        lens=Mesh()
        if surface:surface_patch(lens,surface,[(xx,yy) for xx,yy,_ in rings[-1]],sign,sign*(z-surface(x,y))+.026,mat)
        else:lens.face(mat,rings[-1],(0,0,sign))
        m.part(lens,f'indicator-{x:.3f}-{z:.3f}',indicatorSide='right' if x>0 else 'left')
    else:
        if surface:surface_patch(m,surface,[(xx,yy) for xx,yy,_ in rings[-1]],sign,sign*(z-surface(x,y))+.026,mat)
        else:m.face(mat,rings[-1],(0,0,sign))

def surface_patch(m,surf,boundary,sign,offset,mat):
    if sum(boundary[i][0]*boundary[(i+1)%len(boundary)][1]-boundary[(i+1)%len(boundary)][0]*boundary[i][1] for i in range(len(boundary)))<0:boundary=list(reversed(boundary))
    a=min(p[0] for p in boundary);b=max(p[0] for p in boundary)
    c=min(p[1] for p in boundary);d=max(p[1] for p in boundary)
    def cross(a,b,p):return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
    for tri in surf.triangles:
        if max(p[0] for p in tri)<a or min(p[0] for p in tri)>b or max(p[1] for p in tri)<c or min(p[1] for p in tri)>d:continue
        poly=[(p[0],p[1],p[2]) for p in tri]
        for edge0,edge1 in zip(boundary,boundary[1:]+boundary[:1]):
            if not poly:break
            clipped=[];prev=poly[-1];dp=cross(edge0,edge1,prev)
            for point in poly:
                dc=cross(edge0,edge1,point)
                if (dc>=0)!=(dp>=0):
                    f=dp/(dp-dc);clipped.append(tuple(prev[k]+f*(point[k]-prev[k]) for k in range(3)))
                if dc>=0:clipped.append(point)
                prev,dp=point,dc
            poly=clipped
        if len(poly)>=3:m.face(mat,[(x,y,z+sign*offset) for x,y,z in poly],(0,0,sign),True,
                              lambda p:surf.normal(p.x,p.y))

def cab_window(m,surf,x0,x1,y0,y1,sign,frame='rubber',radius=.09,fill='glass',border=.035,taper=0,layer=0):
    """Rounded window panels tessellated onto the cab, with real body pillars.

    A full-width glass loft erases those pillars and makes every vehicle look
    like the same panoramic oval. The inset panels preserve the drawn outline.
    """
    def patch(mat,a,b,c,d,r,offset):
        # Clip the actual hull triangles against a sampled rounded rectangle.
        # Every resulting face stays on exactly the same plane as its hull
        # triangle; changing curvature/profile cannot bury glass or markings.
        r=min(r,(b-a)/2,(d-c)/2)
        boundary=[]
        for cx,cy,angle in [(b-r,c+r,-math.pi/2),(b-r,d-r,0),(a+r,d-r,math.pi/2),(a+r,c+r,math.pi)]:
            for j in range(6):
                t=angle+j*math.pi/10;boundary.append((cx+r*math.cos(t),cy+r*math.sin(t)))
        if taper:
            center=(x0+x1)/2
            boundary=[(center+(x-center)*(1-taper*(y-y0)/(y1-y0)),y) for x,y in boundary]
        surface_patch(m,surf,boundary,sign,offset,mat)
    patch(frame,x0,x1,y0,y1,radius,.010+layer)
    patch(fill,x0+border,x1-border,y0+border,y1-border,max(.008,radius-border),.014+layer)

def t3(id,opened):
    m=Mesh();lf=id=='t3rplf';historic=id=='t3';L=15.1 if lf else 14.0;w=2.48 if lf else 2.5
    depth=.92;front=-L/2;back=L/2;start=front+depth;end=back-depth;h=3.06 if not lf else 3.185
    bogies=[-3.75,3.75] if lf else [-3.2,3.2]
    m.box('black',0,.48,0,2.12,.22,end-start);wheels(m,bogies,w)
    doorzs=[(start+.76,1.25,.52),(.12,1.3,.35 if lf else .52),(end-.71,1.25,.52)]
    levels=[(.80,'red'),(1.55,'cream'),(2.77,'cream')]
    for side in [-1,1]:
        sill=(lambda z: 1.08 if abs(z)<2.1 else 1.61) if lf else 1.61
        sidewall(m,side,start,end,w,levels,doorzs if side==1 else [],opened,True,bogies,sill,2.65,
                 ([0,3,3,0] if lf else [0,3,2,0]) if side==1 else [9 if lf else 8])
        m.box('chrome',side*(w/2+.015),.79,0,.028,.04,end-start)
        m.box('chrome',side*(w/2+.012),2.76,0,.025,.025,end-start)
        if side==-1:
            m.box('red',side*(w/2+.024),1.02,end-1.1,.025,.48,.90)
            for j in range(8):m.box('roof',side*(w/2+.04),.85+j*.045,end-1.1,.01,.010,.73)
        text(m,'6102' if historic else '8284' if lf else '8442',0,1.33,0,.14,'yellow',(side*(w/2+.026),start+2.9))
    dome(m,start,end,w,2.77,h-2.77,'cream')
    for sign,tip in [(-1,front),(1,back)]:
        lv=[(.29,.71,w*.47),(.76,.90,w/2),(.82,.92,w/2),(1.35,.92,w/2),
            (1.53,.90,w/2),(2.57,.72,w/2),(2.61,.75,w/2),(2.77,.75,w/2),
            (2.88,.66,w*.48),(h-.08,.50,w*.39),(h-.015,.33,w*.23),(h,.20,.04)]
        colors=['cream','chrome','red','cream','cream','cream','cream','cream','cream','cream','cream']
        if lf and sign==-1:colors[3]='red'
        if sign==1:
            colors[3]='red';lv=[(y,.90 if 1.53<=y<=2.61 else d,hw) for y,d,hw in lv]
        surf=rounded_end(m,tip,depth,w,lv,colors,sign,.43)
        if lf and sign==-1:
            # PLF has a central cream point with curved rising shoulders, visible
            # in DPP's 8284 front-assembly photograph; not a straight triangle.
            for j in range(12):
                a=-1.20+j*.20;b=a+.20
                surface_patch(m,surf,[(a,1.20+.33*(abs(a)/1.2)**.55),(b,1.20+.33*(abs(b)/1.2)**.55),(b,1.56),(a,1.56)],sign,.019,'cream')
        if sign==-1:
            cab_window(m,surf,-1.215,1.215,1.53,2.60,sign,radius=.16)
            for x in [-.96,.96]:cab_beam(m,surf,(x,1.58),(x,2.56),sign,.009,'chrome')
        else:
            for a,b in [(-1.18,-.81),(-.765,.765),(.81,1.18)]:cab_window(m,surf,a,b,1.60,2.58,sign,radius=.10)
            if lf:cab_beam(m,surf,(0,2.60),(.48,1.92),sign)
        for x in [-.64,.64]:
            if sign==1 and lf:
                cab_window(m,surf,x-.10,x+.10,.80,.96,sign,radius=.03,fill='tail',border=.025)
            else:lamp(m,x,1.10 if sign==-1 else .98,surf(x,1.10 if sign==-1 else .98)+sign*.02,.12 if sign==-1 else .075,sign,'light' if sign==-1 else 'tail',surface=surf)
        for x in [-.94,.94]:lamp(m,x,1.35,surf(x,1.35)+sign*.015,.045,sign,'amber',surface=surf)
        if sign==-1:
            if historic:
                for x in [-1.09,1.09]:
                    top=(x,1.93,surf(x,1.93)-.13)
                    m.beam('cream',(x*.97,1.46,surf(x*.97,1.46)-.04),top,.013,6)
                    m.cylinder('cream',*top,.083,.035,'z',16)
            else:mirrors(m,id,tip,w,sign)
            if historic:
                cab_window(m,surf,-.67,.67,2.64,2.86,sign,frame='chrome',radius=.095,fill='black',border=.025)
                label(m,'OKRUZNI JIZDA',0,2.75,0,.09,'cream',sign,surf)
            else:
                # Retrofitted rectangular LED housing, not 6102's curved pill.
                # PLF 8284 has the wider case just beneath the roof edge.
                half=.86 if lf else .70;cy=2.81 if lf else 2.76;dy=.14 if lf else .12
                facez=min(surf(0,cy+v*dy) for v in [-1,0,1])-.026;case_depth=.24
                m.box('chrome',0,cy,facez+case_depth/2,half*2,dy*2,case_depth)
                a=half-.025;c=dy-.025;r=.012
                ring=[(-a+r,-c),(a-r,-c),(a,-c+r),(a,c-r),(a-r,c),(-a+r,c),(-a,c-r),(-a,-c+r)]
                m.face('black',[(xx,cy+yy,facez-.003) for xx,yy in ring],(0,0,-1))
                text(m,'7 LEHOVEC',0,cy,facez-.007,.135 if lf else .115)
            label(m,'6102' if historic else '8284' if lf else '8442',0,1.10,0,.18,'black' if historic else 'yellow',sign,surf)
            if historic:
                # 6102's linked central wiper assembly, visible in DPP t3-01.
                cab_beam(m,surf,(0,1.59),(.10,2.57),sign,.012,'chrome')
                for x in [-.43,.43]:cab_beam(m,surf,(x,1.58),(.06,1.98),sign,.013,'chrome')
            else:
                for x in [-.44,.44]:cab_beam(m,surf,(x,1.54),(x*1.82,2.36),sign)
        # Body dimensions exclude the actual exposed coupler. The paired-car
        # registry spaces standard T3 centers15.104m andPLF centers16.2m.
        if lf:
            # PLF retains a closed cream front panel around the narrow shaft.
            cab_window(m,surf,-.13,.13,.30,.61,sign,radius=.025,fill='black',border=.012)
            for xx in [-.50,.50]:
                surface_patch(m,surf,[(xx-.002,.31),(xx+.002,.31),(xx+.002,.74),(xx-.002,.74)],sign,.009,'roof')
        else:cab_window(m,surf,-.55,.55,.30,.76,sign,radius=.035,fill='black',border=.02)
        extension=.55 if lf else .552
        m.box('roof',0,.40,tip+sign*(extension-.40),.10,.08,.80)
        m.cylinder('black',0,.40,tip+sign*(extension-.04),.115,.08,'z',16)
    pantograph(m,-3.55,h,True,historic)
    if lf:
        roofbox(m,.9,h,4.3,1.85)
        m.box('red',0,h+.035,front+.72,1.00,.07,.49)
        m.box('cream',0,h+.155,front+.72,.93,.17,.42)
        for yy in [h+.12,h+.18]:
            for xx in [-.235,.235]:m.box('black',xx,yy,front+.505,.35,.024,.013)
    elif not historic:
        for z in [-.4,2.0,4.3]:m.box('cream',0,h+.025,z,.85,.05,.46)
    return m,L,w

SPECS={
 'kt8d5':([10.9,6.5,10.9],2.48,3.145,1.0),
 '14t':([6.265,5.48,3.38,5.48,6.265],2.46,3.37,.845),
 '15t':([10.4,8.6,10.4],2.46,3.45,1.0),
 '52t':([9,3.5,3.79,3.5,9],2.5,3.35,.8),
}

def modern_end(m,id,tip,w,h,sign=-1,rear=False):
    if id=='kt8d5':
        depth=.43
        levels=[(.31,.31,w*.46),(.62,.42,w*.49),(1.23,.43,w/2),(1.44,.41,w/2),
                (2.79,.22,w*.46),(3.04,.17,w*.46),(3.145,.12,w*.44)]
        colors=['white','red','white','white','black','silver']
    elif id=='14t':
        depth=1.55
        levels=[(.30,1.22,w*.43),(.59,1.49,w*.48),(1.30,1.55,w*.48),(1.53,1.40,w*.47),
                (2.95,.60,w*.40),(3.20,.42,w*.42),(h,.12,w*.39)]
        colors=['silver','silver','silver','silver','silver','silver']
    elif id=='15t':
        depth=1.30
        levels=[(.29,1.20,w*.48),(.68,1.28,w*.495),(.94,1.30,w/2),(1.10,1.28,w*.49),
                (2.97,.69,w*.45),(3.20,.48,w*.44),(h,.10,w*.41)]
        colors=['red','white','black','black','black','red']
    else:
        depth=1.45
        levels=[(.28,1.33,w*.46),(.74,1.45,w*.49),(1.02,1.45,w*.495),(1.15,1.43,w*.493),
                (2.98,.78,w*.47),(3.22,.57,w*.44),(h,.10,w*.39)]
        colors=['white','white','black','black','black','black']
    if rear and id!='kt8d5':
        # Rear glazing and marker lights follow the same family mask, without
        # pretending that one-direction Škodas have a second driving cab.
        colors=list(colors)
    roofbase={'kt8d5':3.02,'14t':3.11,'15t':3.22,'52t':3.21}[id]
    levels=[(y,d,w/2 if .59<=y<=roofbase else hw) for y,d,hw in levels]
    roofdepth=.1
    for (ya,da,_),(yb,db,_) in zip(levels,levels[1:]):
        if ya<=roofbase<=yb:roofdepth=da+(db-da)*(roofbase-ya)/(yb-ya)
    core=[row for row in levels if row[0]<roofbase]
    roofmat={'kt8d5':'silver','14t':'silver','15t':'red','52t':'black'}[id]
    colors=colors[:len(core)]+[roofmat]*4
    levels=core+[(roofbase,roofdepth,w/2)]+[(roofbase+(h-roofbase)*fy,roofdepth*fd,w*fw) for fy,fd,fw in [(.42,.85,.48),(.80,.60,.40),(.98,.25,.23),(1,.1,0)]]
    surf=rounded_end(m,tip,depth,w,levels,colors,sign,.25,flat=.84 if id=='kt8d5' else None)
    if id=='kt8d5':
        cab_window(m,surf,-1.21,1.21,1.49,3.00,sign,radius=.05,fill='black',border=.02)
        cab_window(m,surf,-1.015,1.015,1.55,2.78,sign,radius=.035,layer=.008)
        for a,b in [(-1.20,-1.055),(1.055,1.20)]:cab_window(m,surf,a,b,1.61,2.83,sign,radius=.025,layer=.008)
    elif id=='14t':
        # The tall screen occupies almost the full front, with slender pillars.
        # The old 1.88m /16% taper made a small trapezoid in a broad silver face.
        cab_window(m,surf,-1.10,1.10,1.53,3.10,sign,radius=.12,taper=.065,border=.020)
        for a,b in [(-1.222,-1.145),(1.145,1.222)]:cab_window(m,surf,a,b,1.71,2.88,sign,radius=.030,border=.012)
    else:
        cab_window(m,surf,-1.16,1.16,1.18 if id=='15t' else 1.35,
                   3.14 if id=='15t' and not rear else 2.91 if not rear else 2.70,sign,radius=.13,border=.022)
    if id=='52t':
        surface_patch(m,surf,[(-.74,.29),(-.26,.29),(-.26,1.01),(-.74,1.01)],sign,.016,'red')
    if id=='15t':
        cab_window(m,surf,-1.18,1.18,.45,.57,sign,radius=.022,fill='black',border=.008)
    lampy={'kt8d5':1.02,'14t':1.03,'15t':.80,'52t':1.08}[id]
    for x in [-.84,.84]:
        if id=='14t':
            cab_window(m,surf,x-.10,x+.10,.77,1.29,sign,frame='roof',radius=.03,fill='silver',border=.009)
            for dy in [-.17,0,.17]:lamp(m,x,lampy+dy,surf(x,lampy+dy)+sign*.025,.057,sign,'tail' if rear else 'light',surface=surf)
        elif id=='15t':
            # DPP 9229 close frontal photograph resolves the original 15T:
            # three similarly sized marker lenses in a shallow rising recess;
            # driving lamps are below, in the continuous black bumper strip.
            s=-1 if x<0 else 1
            pocket=[(.65,.71),(.65,.865),(1.16,.925),(1.18,.705)]
            surface_patch(m,surf,[(s*xx,yy) for xx,yy in pocket],sign,.012,'rubber')
            for pos in [.76,.90,1.05]:
                xx=s*pos;yy=.795+(pos-.76)*.10
                material='amber' if pos==.90 else 'tail' if rear else 'chrome'
                lamp(m,xx,yy,surf(xx,yy)+sign*.014,.034 if pos==.90 else .041,sign,material,surface=surf)
            xx=s*.81
            lamp(m,xx,.51,surf(xx,.51)+sign*.033,.045,sign,'tail' if rear else 'light',surface=surf)
            cab_window(m,surf,min(s*.97,s*1.09),max(s*.97,s*1.09),.483,.535,sign,
                       radius=.025,fill='tail' if rear else 'light',frame='chrome',border=.008,layer=.025)
        elif id=='52t':
            s=-1 if x<0 else 1
            cab_window(m,surf,min(s*.66,s*1.16),max(s*.66,s*1.16),lampy-.115,lampy+.115,sign,radius=.065,fill='black',border=.025)
            for pos,r in [(1.04,.052),(.82,.022)]:
                xx=s*pos;lamp(m,xx,lampy,surf(xx,lampy)+sign*.023,r,sign,'tail' if rear else 'light',surface=surf)
            if not rear:
                for pos in [.83,.89,.95]:
                    xx=s*pos
                    m.box('light',xx,lampy,surf(xx,lampy)+sign*.058,.018,.07,.012)
        else:
            lamp(m,x,lampy,surf(x,lampy)+sign*.02,.095,sign,'light',surface=surf)
            xx=x*.68;lamp(m,xx,lampy,surf(xx,lampy)+sign*.02,.06,sign,'light',surface=surf)
        # The actual indicator lenses are independently switchable in viewer.
        xx=(-1 if x<0 else 1)*(1.10 if id=='kt8d5' else 1.13)
        iy=1.39 if id=='kt8d5' else .67 if id=='14t' else lampy+.10
        if id!='15t':lamp(m,xx,iy,surf(xx,iy)+sign*.02,.032,sign,'amber',surface=surf)
    # Equipment cover seams and the circular maker badge give close-up scale.
    badgey=.72 if id=='15t' else 1.13 if id=='52t' else 1.22
    m.cylinder('chrome',0,badgey,surf(0,badgey)+sign*.03,.046,.01,'z',16)
    m.cylinder('black',0,badgey,surf(0,badgey)+sign*.037,.031,.008,'z',12)
    for xx in [-.58,.58]:
        lo=.32;hi=.62 if id=='52t' else 1.25
        for a,b in [(lo+(hi-lo)*j/4,lo+(hi-lo)*(j+1)/4) for j in range(4)]:
            m.beam('roof',(xx,a,surf(xx,a)+sign*.008),(xx,b,surf(xx,b)+sign*.008),.004)
    if rear and id!='kt8d5':
        y=2.96 if id=='52t' else 3.04 if id=='15t' else 2.96
        # The board follows the same curved roof face as its LED lettering.
        # A flat box here intersected the upper digits on the 52T rear dome.
        cab_window(m,surf,-.22,.22,y-.14,y+.14,sign,radius=.012,fill='black',border=.01,layer=.016)
        text(m,'12' if id=='52t' else '20' if id=='15t' else '1',0,y,surf(0,y)+sign*.045,.18,sign=sign,surf=surf)
        label(m,{'14t':'9148','15t':'9286','52t':'9501'}[id],-.47 if id=='52t' else 0,.80 if id=='52t' else 1.01,0,.12,'white' if id in ['52t','15t'] else 'black',sign,surf)
        if id=='15t':
            cab_beam(m,surf,(0,1.29),(.68,2.40),sign,.014)
    if sign==-1 or id=='kt8d5':
        mirrors(m,id,tip,w,sign)
        displayy={'kt8d5':2.91,'14t':2.99,'15t':3.06,'52t':3.05}[id]
        # The board overlays glass (and on KT8 a second mask layer). Give it
        # its own depth so native depth buffers cannot fight over coplanar faces.
        boardhalf=.82 if id=='14t' else .94 if id in ['15t','52t'] else .71
        cab_window(m,surf,-boardhalf,boardhalf,displayy-.10,displayy+.10,sign,frame='glass' if id=='15t' else 'rubber',radius=.04,fill='black',border=.005 if id=='15t' else .01,layer=.016)
        text(m,{'kt8d5':'16 KOTLARKA','14t':'1 PETRINY','15t':'20 DIVOKA SARKA','52t':'12 BARRANDOV'}[id],0,displayy,surf(0,displayy)+sign*.043,.14 if id=='15t' else .115,sign=sign,surf=surf)
        num={'kt8d5':'9102','14t':'9148','15t':'9286','52t':'9501'}[id]
        y=1.02 if id=='15t' else .64 if id=='52t' else 1.05
        label(m,num,-.47 if id=='52t' else 0,y,0,.13,'white' if id in ['15t','52t'] else 'yellow' if id=='kt8d5' else 'black',sign,surf)
        a=(-.64,1.43 if id=='14t' else 1.22);b=(.22,2.42)
        if id=='15t':
            # Parallel drive linkage and vertical blade, as on the original cab.
            for d in [-.017,.017]:cab_beam(m,surf,(.20+d,1.12),(-.84+d,1.90),sign,.009)
            cab_beam(m,surf,(-.84,1.44),(-.84,2.27),sign,.012)
            cab_beam(m,surf,(-1.05,2.89),(1.05,2.89),sign,.007,'chrome')
        else:cab_beam(m,surf,a,b,sign,.014)
    if id=='14t':cab_beam(m,surf,(-1.08,.73),(1.08,.73),sign,.008,'roof')
    if id=='kt8d5':
        # Original type drawing:525mm coupling axis,470mm projection at EACH
        # end (30.300m body /31.240m overcouplers). Both cabs carry the gear.
        cab_window(m,surf,-.28,.28,.35,.70,sign,radius=.025,fill='black',border=.015)
        m.box('roof',0,.525,tip+sign*.17,.12,.13,.60)
        m.box('black',0,.525,tip+sign*.40,.29,.22,.14)
        m.cylinder('roof',0,.525,tip+sign*.438,.085,.064,'z',12)
        m.beam('black',(-.39,.31,tip+sign*.22),(.39,.31,tip+sign*.22),.035,6)
    return depth

def modern(id,i,opened):
    lens,w,h,gap=SPECS[id];L=lens[i];last=len(lens)-1;m=Mesh()
    front=i==0;back=i==last;cabdepth={'kt8d5':.43,'14t':1.55,'15t':1.30,'52t':1.45}[id]
    offset=sum(lens[:i])+gap*i
    def local(distance):return distance-offset-L/2
    start=-L/2+(cabdepth if front else 0);end=L/2-(cabdepth if back else 0)
    # Keep the rectangular chassis behind the shaped cab. Extending it almost
    # to the tip exposed square black wedges through both rounded lower corners.
    m.box('black',0,.43,(start+end)/2,w-.2,.24,end-start)
    shared=[]
    if id=='kt8d5':
        bogies=[-L/2+3.9] if front else [L/2-3.9] if back else []
        if not front:shared.append((-L/2-gap/2,1))
        if not back:shared.append((L/2+gap/2,-1))
        doors=[(start+.72,.95,.54),(end-2.30,1.30,.54)] if front else [(start+2.30,1.30,.54),(end-.72,.95,.54)] if back else [(0,1.30,.35)]
        levels=[(.60,'white'),(.89,'red'),(1.55,'white'),(2.93,'silver'),(3.02,'silver')] if i!=1 else [(.60,'white'),(.89,'red'),(2.80,'white'),(2.93,'silver'),(3.02,'silver')]
        sill,top=1.60,2.77
    elif id=='14t':
        bogies=[local([4.55,15.125,25.70][i//2])] if i%2==0 else []
        centers=[[],[8.22,11.52],[],[18.77,22.10],[27.86]][i]
        doors=[(local(z),.70 if back else 1.30,.35) for z in centers]
        levels=[(.59,'red'),(1.15,'red'),(2.90,'red'),(3.11,'silver')]
        sill,top=1.39,2.80
    elif id=='15t':
        # Manufacturer drawing: outer bogie wheel centers .9/2.8m from
        # each tip; its eccentric body pivot is2.2m fromtip (600mm from
        # inner axle). The two Jacobs pivots are10.9m/20.5m fromfront.
        bogies=[-L/2+1.85] if front else [L/2-1.85] if back else []
        if not front:shared.append((-L/2-gap/2,1))
        if not back:shared.append((L/2+gap/2,-1))
        centers=[[3.90,7.10],[13.55,16.75],[23.65,26.95]][i]
        doors=[(local(z),1.30,.35) for z in centers]
        levels=[(.59,'red'),(.84,'white'),(1.22,'black'),(3.10,'silver'),(3.22,'silver')]
        sill,top=1.30,2.90
    else:
        bogies=[local(z) for z in [2.30,11.56,20.43,29.69] if offset<z<offset+L]
        centers=[[4.85,7.86],[],[15.28],[],[24.08,27.12]][i]
        doors=[(local(z),1.30,.35) for z in centers]
        levels=[(.59,'white'),(1.20,'black'),(3.06,'red' if i%2==0 else 'white'),(3.21,'white')]
        sill,top=1.30,2.84
    radius={'kt8d5':.35,'14t':.305,'15t':.33,'52t':.32}[id]
    wheels(m,bogies,w,1.88 if id=='14t' else 1.80 if id=='52t' else 1.9,radius,independent=id=='15t')
    for z,half in shared:wheels(m,[z],w,1.9,radius,half,id=='15t')
    for side in [-1,1]:
        ds=doors if side==1 or id=='kt8d5' else []
        counts=None
        if id=='14t':counts=([3] if i==0 else [0,1,0] if i in [1,3] else [2] if i==2 else [2,0]) if side==1 else [3 if i%2==0 and i!=2 else 2]
        if id=='52t':counts=([2,1,0] if front else [0,1,2] if back else [1,0] if i==2 else [2]) if side==1 else [5 if i in [0,4] else 2]
        if id=='kt8d5':counts=[0,2,1] if front else [1,2,0] if back else [0,0]
        sidewall(m,side,start,end,w,levels,ds,opened if side==1 else False,False,bogies+[z for z,_ in shared],sill,top,counts,folding=id=='kt8d5')
        if id=='52t' and i%2==0:
            # PID lower panels follow the red roof bands. Clip them around
            # real door openings, keeping the leading/trailing cab area white.
            redlo=start+2.70 if front else start
            redhi=end-2.70 if back else end
            cursor=redlo
            cuts=[]
            for dz,dw,_ in sorted(ds):
                if dz+dw/2<=redlo or dz-dw/2>=redhi:continue
                cuts.append((cursor,max(cursor,dz-dw/2)));cursor=max(cursor,dz+dw/2)
            cuts.append((cursor,redhi))
            for lo,hi in cuts:
                if hi>lo:m.box('red',side*(w/2+.017),.90,(lo+hi)/2,.022,.60,hi-lo)
        if id=='14t' and front:
            m.box('silver',side*(w/2+.012),1.80,start+.60,.02,2.45,1.12)
            window(m,side,start+.14,start+1.03,1.67,2.77,w+.04)
            if side==1:door(m,side,local(2.36),.70,w,.54,2.84,False,animatable=False)
        if id=='52t' and front and side==1:door(m,side,local(1.94),.65,w,.50,2.87,False,animatable=False)
        if id=='kt8d5' and i==1:
            kt8_low_window(m,side,start,end,w)
    dome(m,start,end,w,levels[-1][0],h-levels[-1][0], 'silver' if id!='52t' else 'white')
    if front:modern_end(m,id,-L/2,w,h)
    else:bellows(m,-L/2-gap/4,w,h-.06,gap/2)
    if back:modern_end(m,id,L/2,w,h,1,True)
    else:bellows(m,L/2+gap/4,w,h-.06,gap/2)
    if id=='kt8d5':
        if i!=1:kt8_collector(m,-L/2+3.9 if front else L/2-3.9,h,1 if front else -1,front)
        roofbox(m,0,h,.7,1.1)
    elif id=='14t':
        if i==0:pantograph(m,.55,h)
        elif i%2==0:roofbox(m,.3,h,2.9)
    elif id=='15t':
        roofbox(m,1.35 if i==0 else 0,h,2.8 if i==0 else 3.8)
        if i==0:pantograph(m,-2.4,h)
    else:
        if i==0:pantograph(m,.3,h)
        elif i in [1,3]:roofbox(m,0,h,2.9)
        else:roofbox(m,0,h,2.0)
    if id=='15t':
        # The upper shell narrows towards the roof (Prague clearance profile).
        def taper(mesh):
            for j,(x,y,z) in enumerate(mesh.v):
                f=1-.08*max(0,min(1,(y-1.2)/2));df=-.04 if 1.2<y<3.2 else 0
                n=mesh.n[j]
                if n is not None:mesh.n[j]=tuple(Vector((n[0]/f,n[1]-x*df*n[0]/f,n[2])).normalized())
                mesh.v[j]=(x*f,y,z)
            for child,_,_,_ in mesh.parts:taper(child)
        taper(m)
    return m,L,w

IDS=['t3','t3rp','t3rplf','kt8d5','14t','15t','52t']
NO_OPEN={'14t-a','14t-c','52t-b','52t-d'}
def build(id,i=0,opened=False):return t3(id,opened) if id.startswith('t3') else modern(id,i,opened)
def keys(id):return [id] if id.startswith('t3') else [f'{id}-{chr(97+i)}' for i in range(len(SPECS[id][0]))]

def scene_clear():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def export(id):
    rows=[]
    for i,key in enumerate(keys(id)):
        for opened in [False,True] if key not in NO_OPEN else [False]:
            scene_clear();m,L,w=build(id,i,opened);name=key+('-open' if opened else '')
            obj=m.object(name);obj.select_set(True);bpy.context.view_layer.objects.active=obj
            path=OUT/(name+'.glb')
            bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
                export_yup=True,export_texcoords=False,export_normals=True,export_materials='EXPORT',
                export_cameras=False,export_lights=False,export_animations=False,export_extras=False)
            obj.data.calc_loop_triangles();tris=len(obj.data.loop_triangles)
            rows.append({'key':name,'length':L,'width':w,'triangles':tris,'bytes':path.stat().st_size})
        # Movable parts are a viewer-only asset. They never increase the map's
        # object/material batches or require intermediate door-state GLBs.
        scene_clear();m,_,_=build(id,i,False);obj=m.object(key,True)
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.export_scene.gltf(filepath=str(OUT/(key+'-viewer.glb')),export_format='GLB',use_selection=True,
            export_yup=True,export_texcoords=False,export_normals=True,export_materials='EXPORT',
            export_cameras=False,export_lights=False,export_animations=False,export_extras=True)
    return rows

def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
def render(id):
    scene_clear();cursor=0;objects=[]
    for i,key in enumerate(keys(id)):
        m,L,w=build(id,i);o=m.object(key,True);o.location.y=-(cursor+L/2);objects.append(o)
        cursor+=L+(0 if id.startswith('t3') else SPECS[id][3])
    length=cursor-(0 if id.startswith('t3') else SPECS[id][3])
    sc=bpy.context.scene;sc.render.engine='CYCLES';sc.cycles.samples=24
    sc.cycles.use_denoising=True;sc.render.threads_mode='FIXED';sc.render.threads=4
    sc.world.color=(.45,.45,.45);sc.render.film_transparent=True
    sc.view_settings.view_transform='AgX'
    for name,pos,power,size in [('Key',(7,5,13),2100,9),('Fill',(-8,0,7),1600,11),('Rim',(4,-length,10),2500,10)]:
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
        ob=bpy.data.objects.new(name,data);sc.collection.objects.link(ob);ob.location=pos;aim(ob,(0,-length/2,1.5))
    camd=bpy.data.cameras.new('Review camera');cam=bpy.data.objects.new('Review camera',camd);sc.collection.objects.link(cam);sc.camera=cam
    camd.type='ORTHO';sc.render.image_settings.file_format='PNG';sc.render.image_settings.color_mode='RGBA'
    views=[('front',(length*.64,length*.68, length*.32),(0,-length/2,2),length*.78,1100,650),
           ('side',(length*1.4,-length/2,1.8),(0,-length/2,1.8),length*1.08,1500,550),
           ('rear',(-length*.6,-length*1.65,length*.30),(0,-length/2,2),length*.80,1100,650),
           ('detail',(6,9,4.5),(0,-1.6,2),7.5,900,750),
           ('head-on',(0,8,2.5),(0,0,2.5),5.5,700,900),
           ('tail-on',(0,-length-8,2.5),(0,-length,2.5),5.5,700,900),
           ('thumb',(-length*.7,length*.80,length*.32),(0,-length/2,2),length*.80,700,450)]
    for name,pos,target,scale,rw,rh in views:
        cam.location=pos;aim(cam,target);camd.ortho_scale=scale
        sc.render.resolution_x=rw;sc.render.resolution_y=rh;sc.render.resolution_percentage=100
        path=ROOT/'assets/images/trams'/f'{id}.png' if name=='thumb' else REVIEW/f'{id}-{name}.png'
        sc.render.filepath=str(path);bpy.ops.render.render(write_still=True)
    cam.location=views[0][1];aim(cam,views[0][2]);camd.ortho_scale=views[0][3]
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/f'{id}.blend'))

if __name__=='__main__':
    # Generated sources are versioned by Git; do not accumulate .blend1 files.
    bpy.context.preferences.filepaths.save_version=0
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    selected=[a for a in args if not a.startswith('--')] or IDS
    if any(id not in IDS for id in selected):raise ValueError('Unknown model id')
    for p in [OUT,REVIEW,SOURCE]:p.mkdir(parents=True,exist_ok=True)
    scene_clear();materials();rows=[]
    for id in selected:
        if '--render-only' not in args:rows.extend(export(id))
        if '--render' in args or '--render-only' in args:render(id)
    if rows:
        print('FLEET_BUILD_REPORT='+json.dumps(rows))
        (REVIEW/'build-report.json').write_text(json.dumps(rows,indent=2)+'\n')
