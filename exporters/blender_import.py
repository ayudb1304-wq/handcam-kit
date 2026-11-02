"""
HandCam -> Blender importer (Phase 4 target; this is the skeleton + the axis conversion with its self-test).

Usage:
    blender --background --python exporters/blender_import.py -- take.json scene.json out.blend

Design rules (see docs/DECISIONS.md):
  * One keyframe per sample. No smoothing here; smoothing happens on export in the desk UI, into a copy.
  * three_to_blender() is the ONLY place axes are converted anywhere in the project.
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
# Blender part. Only runs inside Blender. Phase 4 completes build_scene() to mirror shared/scene-render.js.
# ---------------------------------------------------------------------------

def run_in_blender(take_path, scene_path, out_path):
    import bpy  # noqa: F401  (import here so the self-test runs outside Blender)
    from mathutils import Quaternion

    with open(take_path) as f:
        take = json.load(f)
    with open(scene_path) as f:
        scene = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bscene = bpy.context.scene
    fps = int(take.get("fps_hint", 60))
    bscene.render.fps = fps

    build_scene(bpy, scene)

    cam_data = bpy.data.cameras.new("HandCam")
    cam_data.lens = 24
    cam = bpy.data.objects.new("HandCam", cam_data)
    bpy.context.collection.objects.link(cam)
    bscene.camera = cam
    cam.rotation_mode = "QUATERNION"

    samples = take["samples"]
    for s in samples:
        frame = 1 + s["ts"] / 1000.0 * fps  # subframe keys are fine in Blender
        loc, q = three_to_blender(s["p"], s["q"])
        cam.location = loc
        cam.rotation_quaternion = Quaternion(q)
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_quaternion", frame=frame)

    # Linear interpolation between raw samples: we never invent easing.
    if cam.animation_data and cam.animation_data.action:
        for fc in cam.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"

    bscene.frame_start = 1
    bscene.frame_end = int(1 + samples[-1]["ts"] / 1000.0 * fps) + 1
    bpy.ops.wm.save_as_mainfile(filepath=out_path)
    print(f"saved {out_path} with {len(samples)} camera keys")


def build_scene(bpy, scene):
    """Phase 4: mirror public/shared/scene-render.js. Skeleton handles plane/box/cylinder/sphere; stickfigure TODO."""
    for o in scene.get("objects", []):
        t = o.get("type")
        p = o.get("p", [0, 0, 0])
        loc, _ = three_to_blender(p, [0, 0, 0, 1])
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
            bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc)
            ob = bpy.context.object
        elif t == "sphere":
            r = (o.get("size") or [0.5])[0]
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc)
            ob = bpy.context.object
        elif t == "stickfigure":
            # TODO Phase 4: replicate shared/stickfigure.js poses. Placeholder: a 1.75m cylinder.
            h = o.get("height", 1.75)
            bpy.ops.mesh.primitive_cylinder_add(radius=0.17, depth=h, location=(loc[0], loc[1], loc[2] + h / 2))
            ob = bpy.context.object
        else:
            continue
        ob.name = o.get("id", t)
        rx, ry, rz = (o.get("rot") or [0, 0, 0])[:3]
        # three euler XYZ (Y up) -> blender: yaw about Y_three is yaw about Z_blender
        ob.rotation_euler = (rx, -rz, ry)


if __name__ == "__main__":
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1:]
        if len(args) < 3:
            print(__doc__); sys.exit(1)
        run_in_blender(*args[:3])
    else:
        _self_test()
