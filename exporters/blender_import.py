"""
HandCam -> Blender importer (Phase 4).

Usage (from the unzipped "Blender" export folder, or with paths):
    blender --background --python import.py -- take.json scene.json [handcam.blend]
    blender --background --python exporters/blender_import.py -- take.json scene.json [out.blend]
Without Blender, `python3 blender_import.py` runs the axis self-test.

Files next to take.json, all optional (the desk's Blender export writes them):
  export.json  {fps, frame, width, height, smoothing}
  camera.json  {smoothing, samples}: a smoothed COPY of the camera, used instead of take.json's samples
  motion.json  {fps, frames, objects: {id: [[x, y, z, yaw, pose], ...]}}: the set's own motion, baked
               by the desk from public/shared/motion.js (the same numbers the phone showed)
  figures.json {POSES, BONES, HEAD_RADIUS}: stick-figure joints from public/shared/stickfigure.js

Design rules (see docs/DECISIONS.md):
  * One camera keyframe per sample, linear between them. Never easing, never smoothing here.
  * three_to_blender() is the ONLY place axes are converted anywhere in the project.
  * Lens: full-frame, the frame's long side is 36 mm (sensor_fit AUTO), like shared/frames.js.
"""
import json
import math
import sys

# ---------------------------------------------------------------------------
# Axis conversion: three.js (Y up, right-handed, camera looks -Z)
#               -> Blender  (Z up, right-handed, camera looks -Z local)
# Position: (x, y, z)_three -> (x, -z, y)_blender
# Rotation: pre-multiply by a +90deg rotation about X (as a quaternion).
# ---------------------------------------------------------------------------

def q_mul(a, b):
    """Hamilton product, quaternions as (w, x, y, z)."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    )

_R_X90 = (math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0)  # +90deg about X, (w,x,y,z)


def three_to_blender(p_xyz, q_xyzw):
    """Convert a three.js position [x,y,z] and quaternion [x,y,z,w] to Blender (location tuple, rotation_quaternion (w,x,y,z))."""
    x, y, z = p_xyz
    loc = (x, -z, y)
    qx, qy, qz, qw = q_xyzw
    q_three_wxyz = (qw, qx, qy, qz)
    # Both engines use "camera looks down its local -Z". The world basis differs by R = +90deg about X
    # (the same map as the position conversion). So world_forward_b = R * (q_t * -Z)  =>  q_b = R * q_t.
    # NOT R*q*R^-1: that would re-express q in the new basis but keep Blender's local frame un-rotated.
    q_b = q_mul(_R_X90, q_three_wxyz)
    return loc, q_b


def rotate_vec(q_wxyz, v):
    w, x, y, z = q_wxyz
    qv = (0.0, *v)
    qc = (w, -x, -y, -z)
    return q_mul(q_mul(q_wxyz, qv), qc)[1:]


def _self_test():
    # Identity: camera at (0,1.6,6) looking -Z (toward origin) in three
    #   -> Blender (0,-6,1.6) looking +Y (toward origin). Up stays up (+Y three -> +Z blender).
    loc, q = three_to_blender([0, 1.6, 6], [0, 0, 0, 1])
    assert tuple(round(v, 6) for v in loc) == (0, -6, 1.6), loc
    fwd_b = rotate_vec(q, (0, 0, -1))  # Blender camera local forward is -Z
    assert tuple(round(v, 6) + 0.0 for v in fwd_b) == (0, 1, 0), fwd_b
    up_b = rotate_vec(q, (0, 1, 0))    # camera local up is +Y in both
    assert tuple(round(v, 6) + 0.0 for v in up_b) == (0, 0, 1), up_b
    # Pan right by 90deg in three.js = rotate -90deg about Y. Camera should then look +X in both worlds.
    s = math.sin(-math.pi / 4); c = math.cos(-math.pi / 4)
    _, q2 = three_to_blender([0, 0, 0], [0, s, 0, c])
    fwd2 = rotate_vec(q2, (0, 0, -1))
    assert tuple(round(v, 6) + 0.0 for v in fwd2) == (1, 0, 0), fwd2  # pan right stays pan right
    # Tilt down 90deg (rotate -90 about X in three): camera looks straight down in both worlds.
    _, q3 = three_to_blender([0, 0, 0], [s, 0, 0, c])
    fwd3 = rotate_vec(q3, (0, 0, -1))
    assert tuple(round(v, 6) + 0.0 for v in fwd3) == (0, 0, -1), fwd3
    print("three_to_blender self-test OK")


# ---------------------------------------------------------------------------
# Blender part. Only runs inside Blender.
# ---------------------------------------------------------------------------

def _load(path, default=None):
    import os
    if not path or not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def lens_from_fov(fov_deg, aspect):
    """Inverse of shared/frames.js fovFromLens: long side of the frame = 36 mm."""
    height_mm = 36.0 / aspect if aspect >= 1 else 36.0
    return height_mm / (2 * math.tan(math.radians(fov_deg) / 2))


def hex_rgba(h, default="#8a8f99"):
    h = (h or default).lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)


def run_in_blender(take_path, scene_path, out_path=None):
    import os
    import bpy
    from mathutils import Quaternion

    here = os.path.dirname(os.path.abspath(take_path))
    take = _load(take_path)
    scene = _load(scene_path)
    export = _load(os.path.join(here, "export.json"), {})
    camera_copy = _load(os.path.join(here, "camera.json"))
    motion = _load(os.path.join(here, "motion.json"))
    figures = _load(os.path.join(here, "figures.json"))
    out_path = out_path or os.path.join(here, "handcam.blend")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bscene = bpy.context.scene
    fps = int(export.get("fps", 24))
    bscene.render.fps = fps
    if export.get("width"):
        bscene.render.resolution_x, bscene.render.resolution_y = int(export["width"]), int(export["height"])

    objects = build_scene(bpy, scene, figures)

    # --- camera: one key per sample, lens per sample ------------------------------------------
    aspect = (take.get("view") or {}).get("aspect") or (16 / 9)
    fov = (take.get("view") or {}).get("fov") or 60
    cam_data = bpy.data.cameras.new("HandCam")
    cam_data.sensor_width = 36.0
    cam_data.sensor_fit = "AUTO"  # 36 mm across the long side of the frame
    cam_data.lens = lens_from_fov(fov, aspect)
    cam = bpy.data.objects.new("HandCam", cam_data)
    bpy.context.collection.objects.link(cam)
    bscene.camera = cam
    cam.rotation_mode = "QUATERNION"

    samples = (camera_copy or {}).get("samples") or take["samples"]
    for s in samples:
        frame = 1 + s["ts"] / 1000.0 * fps  # subframe keys: exactly when the sample was taken
        loc, q = three_to_blender(s["p"], s["q"])
        cam.location = loc
        cam.rotation_quaternion = Quaternion(q)
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_quaternion", frame=frame)
        if s.get("f"):
            cam_data.lens = s["f"]
            cam_data.keyframe_insert("lens", frame=frame)
    _linear(cam)
    _linear(cam_data)

    # --- the set's own motion, baked by the desk ------------------------------------------------
    if motion:
        mfps = motion.get("fps", fps)
        for oid, track in (motion.get("objects") or {}).items():
            ob = objects.get(oid)
            if not ob:
                continue
            ob.rotation_mode = "XYZ"
            bx, by, _ = ob.rotation_euler  # keep any tilt; the motion only turns it (yaw about Blender Z)
            for k, (x, y, z, yaw, pose) in enumerate(track):
                frame = 1 + k * fps / mfps
                loc, _ = three_to_blender([x, y, z], [0, 0, 0, 1])
                ob.location = loc
                ob.rotation_euler = (bx, by, yaw)
                ob.keyframe_insert("location", frame=frame)
                ob.keyframe_insert("rotation_euler", frame=frame)
                _show_pose(ob, pose, frame)
            _linear(ob)

    end = samples[-1]["ts"] / 1000.0
    if motion:
        end = max(end, motion.get("frames", 0) / motion.get("fps", fps))
    bscene.frame_start = 1
    bscene.frame_end = int(1 + end * fps) + 1
    bpy.ops.wm.save_as_mainfile(filepath=out_path)
    print(f"saved {out_path}: {len(samples)} camera keys, {len(objects)} set objects")


def _linear(idblock):
    ad = getattr(idblock, "animation_data", None)
    if ad and ad.action:
        for fc in ad.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"  # straight between recorded samples: we never invent easing


def _show_pose(ob, pose, frame):
    """A stick figure has one child group per pose it uses; key which one is visible (pose changes are instant)."""
    for child in ob.children:
        want = child.get("handcam_pose")
        if want is None:
            continue
        hidden = want != pose
        for target in [child] + list(child.children_recursive):
            target.hide_render = hidden
            target.hide_viewport = hidden
            target.keyframe_insert("hide_render", frame=frame)
            target.keyframe_insert("hide_viewport", frame=frame)


def _material(bpy, color):
    m = bpy.data.materials.new(color or "grey")
    m.diffuse_color = hex_rgba(color)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = hex_rgba(color)
        bsdf.inputs["Roughness"].default_value = 0.9
    return m


def _figure(bpy, o, figures, pose, parent, mat):
    """One pose of a stick figure as a group of cylinders + a head, mirroring shared/stickfigure.js."""
    from mathutils import Vector
    h = o.get("height", 1.75)
    joints = (figures or {}).get("POSES", {}).get(pose) or (figures or {}).get("POSES", {}).get("standing")
    group = bpy.data.objects.new(f"{o['id']}-{pose}", None)
    bpy.context.collection.objects.link(group)
    group.parent = parent
    group["handcam_pose"] = pose
    if not joints:  # no figures.json: a plain 0.35 m-wide cylinder the height of the figure
        bpy.ops.mesh.primitive_cylinder_add(radius=0.17, depth=h, location=(0, 0, h / 2))
        ob = bpy.context.object; ob.parent = group; ob.data.materials.append(mat)
        return group
    j = lambda name: Vector((joints[name][0] * h, -joints[name][2] * h, joints[name][1] * h))  # three local -> blender local
    bpy.ops.mesh.primitive_uv_sphere_add(radius=figures["HEAD_RADIUS"] * h, location=j("head"), segments=14, ring_count=10)
    head = bpy.context.object; head.parent = group; head.data.materials.append(mat)
    for a, b, r in figures["BONES"]:
        va, vb = j(a), j(b)
        d = vb - va
        bpy.ops.mesh.primitive_cylinder_add(radius=r * h, depth=d.length, vertices=8, location=(va + vb) / 2)
        limb = bpy.context.object
        limb.rotation_mode = "QUATERNION"
        limb.rotation_quaternion = d.to_track_quat("Z", "Y")
        limb.parent = group
        limb.data.materials.append(mat)
    return group


def build_scene(bpy, scene, figures=None):
    """Mirror public/shared/scene-render.js. Returns {id: blender object} for the motion bake."""
    out = {}
    for o in scene.get("objects", []):
        t = o.get("type")
        loc, _ = three_to_blender(o.get("p", [0, 0, 0]), [0, 0, 0, 1])
        mat = _material(bpy, o.get("color") or ("#e0a040" if t == "stickfigure" else None))
        if t == "plane":
            w, d = (o.get("size") or [20, 20])[:2]
            bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
            ob = bpy.context.object; ob.scale = (w, d, 1)
        elif t == "box":
            w, h, d = (o.get("size") or [1, 1, 1])[:3]
            bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
            ob = bpy.context.object; ob.scale = (w, d, h)  # three (w,h,d) -> blender (x=w, y=d, z=h)
        elif t == "cylinder":
            r, h = (o.get("size") or [0.5, 1])[:2]
            bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, vertices=16)
            ob = bpy.context.object
        elif t == "sphere":
            r = (o.get("size") or [0.5])[0]
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc)
            ob = bpy.context.object
        elif t == "stickfigure":
            ob = bpy.data.objects.new(o.get("id", "figure"), None)  # an empty at the feet; poses are children
            bpy.context.collection.objects.link(ob)
            ob.location = loc
            poses = [o.get("pose", "standing")] + [m["pose"] for m in o.get("moves", []) if m.get("do") == "pose"]
            for i, pose in enumerate(dict.fromkeys(poses)):
                g = _figure(bpy, o, figures, pose, ob, mat)
                if i:  # only the starting pose shows until a pose change is keyed
                    for target in [g] + list(g.children_recursive):
                        target.hide_render = target.hide_viewport = True
        else:
            continue
        if t != "stickfigure":
            ob.data.materials.append(mat)
        ob.name = o.get("id", t)
        rx, ry, rz = (o.get("rot") or [0, 0, 0])[:3]
        # three euler XYZ (Y up) -> blender: yaw about Y_three is yaw about Z_blender
        ob.rotation_euler = (rx, -rz, ry)
        out[o.get("id")] = ob
    return out


if __name__ == "__main__":
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1:]
        if len(args) < 2:
            print(__doc__); sys.exit(1)
        run_in_blender(*args[:3])
    else:
        _self_test()
        assert abs(lens_from_fov(2 * math.degrees(math.atan(20.25 / 48)), 16 / 9) - 24) < 1e-9
        print("lens_from_fov OK")
