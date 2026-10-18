# Geometry-to-Blender research and technical decisions

Research checked October 17, 2026. This document explains the technical basis for the reconstruction worker. Run commands and current verification results belong in [README.md](README.md); source documentation does not establish that a test has passed locally.

## Scope and approach

The first useful pipeline accepts confirmed `RoomGeometry`, builds a clean architectural shell, saves an editable `.blend`, and exports a standalone GLB for the existing Three.js viewer. This deliberately establishes the reliable geometry-to-artifact stage before adding address extraction, photographs, or neural reconstruction. Those upstream systems must produce the same validated geometry rather than maintain separate scene formats.

The implementation basis is Blender 4.5 LTS, its Python API, and the bundled glTF exporter. Blender runs as a server-side process; it is not a browser dependency. The worker should record the exact Blender version and generator version in its manifest. A different Blender release needs compatibility verification rather than an assumption that every export option behaves identically.

The canonical application contract remains [`backend/contracts.ts`](../backend/contracts.ts). Its units are meters, its coordinate system is right-handed with +Y up, and its geometry defines room polygons, wall segments, and wall-relative openings. Reconstruction must not silently expand that contract with a second geometry model.

## Coordinates: one explicit conversion in each direction

[glTF 2.0 defines a right-handed, +Y-up coordinate system with distances in meters and angles in radians](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc#coordinate-system-and-units). That already matches the application contract. Blender's ordinary architectural scene uses +Z up.

Use this conversion when constructing Blender vertices:

```text
Application [x, y, z] → Blender [x, -z, y]
Blender [bx, by, bz] → glTF [bx, bz, -by]
```

The second conversion is performed by the exporter with `export_yup=True`. Its implementation is directly visible in the [Blender 4.5 exporter node transform code](https://github.com/KhronosGroup/glTF-Blender-IO/blob/blender-v4.5-release/addons/io_scene_gltf2/blender/exp/nodes.py). Composing the two conversions restores the original application position exactly, apart from floating-point representation. Both transformations are rotations rather than reflections; they preserve handedness.

For a floor vertex `[x, z]`, Blender receives `[x, -z, 0]`. An application's vertical wall height becomes Blender Z. Do not export an already Y-up Blender mesh with another manual Y-up conversion, negate a viewer axis afterward, or scale meters by 100. Set the Blender scene to metric units with `scale_length = 1.0`, and keep numerical coordinates in meters.

An asymmetric fixture is essential: a square alone can hide a mirrored or transposed export. Verify a known wall length, height, door position, window sill, and a nonzero floor coordinate after loading the GLB. Compare world-space coordinates after node transforms, not just raw accessor values.

## Construct meshes from validated geometry

[`Mesh.from_pydata`](https://docs.blender.org/api/4.5/bpy.types.Mesh.html#bpy.types.Mesh.from_pydata) constructs mesh data directly from vertices, edges, and faces. This avoids dependence on selection state or an interactive editor area when creating the shell. Blender's API specifically warns that invalid mesh inputs are not prevented automatically. Validate the request before mesh creation, then use mesh validation as an additional check; silently repaired topology should not make an invalid room request successful.

Recommended geometry rules for this stage:

- Reject nonfinite coordinates, zero-length walls, nonpositive dimensions, unknown wall/evidence references, and duplicate identifiers.
- Require simple, nondegenerate floor polygons. Reject crossing edges and repeated vertices; triangulate concave floors correctly rather than using a convex-only triangle fan.
- Define each wall's input segment as its centerline. Wall thickness extends half to either side. This convention makes dimension checks reproducible and must be shared with the viewer.
- Interpret opening offset along the parent wall from `start` toward `end`; interpret `sillHeight` above the floor. Changing wall direction changes that offset's physical meaning.
- Reject openings outside their wall's horizontal or vertical extent, overlapping openings, and doors with an unsupported nonzero sill instead of clipping them silently.
- Form wall sections around each opening so the aperture is an actual absence of wall geometry. A named door marker laid in front of a closed wall is not a door opening.

These rules are application decisions derived from our contract, not claims that Blender automatically understands floor plans. Separate room-floor objects and wall objects remain individually editable. Opening metadata can be represented by named empty objects, while the corresponding wall mesh contains the cutout. This first stage does not need a visible door leaf, glass pane, frame, or swing animation to prove that an aperture exists.

Direct wall section generation avoids a dependency on context-sensitive Boolean operations and avoids leaving live cutting objects in the runtime scene. The implementation additionally uses conservative miter caps at simple equal-profile corners, falling back to butt caps at ambiguous or unsafe junctions. Independently editable walls do not make a single fused construction model or BIM asset. Multi-room elevation, curved walls, structural engineering, and a delivery-clearance solver require additional contracts.

## Preserve editability and semantic identity

The `.blend` is the editable source artifact. The GLB is a runtime derivative. [Blender's glTF documentation](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html) describes a rendering interchange format; it should not replace the Blender authoring file or the original geometry JSON.

Use stable IDs as metadata and readable object names for editing. Keep individual floors, walls, and opening metadata separate. Store only the identifiers and dimensional metadata needed by the viewer. Retain full source evidence in private application storage, not as exact addresses, photo URLs, or sensitive claims embedded into a publicly served model.

The exporter supports custom properties through `export_extras=True`; the corresponding [4.5 exporter option definitions](https://github.com/KhronosGroup/glTF-Blender-IO/blob/blender-v4.5-release/addons/io_scene_gltf2/__init__.py) show that this option is **off by default**. The Blender manual confirms these values are stored in glTF `extras`. Use JSON-compatible values and test their actual exported shape. Do not assume a Blender collection becomes a semantically equivalent glTF collection or that a human-readable mesh name is an immutable identifier.

[Three.js GLTFLoader copies object-valued `extras` into `userData`](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/GLTFLoader.js). This provides the bridge for source geometry IDs, roles, and evidence ID references. Silas can select a loaded node using its explicit identity rather than parsing a Blender name. Empty metadata nodes and mesh nodes should both be covered by compatibility checks.

## Keep material and export requirements small

Use node-based Principled BSDF materials with explicit base color, roughness, metallic and tangent-space normal inputs. The [Blender glTF material documentation](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html#materials) explains the supported export model. Arbitrary Blender procedural shaders are not guaranteed to reproduce in a browser. The current `pbr-daylight-v1` profile uses committed CC0 photographic texture maps and exports embedded PNGs; it does not rely on exporting arbitrary node graphs or baked room lighting.

The shell embeds its material textures and excludes cameras, animation, and punctual lights. Viewer lighting stays under the spatial frontend's control. Relevant exporter options verified in the 4.5 source are:

| Option | Intended value | Reason |
| --- | --- | --- |
| `export_format` | `"GLB"` | One binary runtime model |
| `export_yup` | `True` | Restore the application's Y-up convention |
| `export_extras` | `True` | Preserve semantic custom properties |
| `export_materials` | `"EXPORT"` | Retain basic materials |
| `export_normals` | `True` | Predictable shaded surfaces |
| `export_texcoords` | `True` | Preserve metric UVs for PBR textures |
| `export_tangents` | `True` | Tangent frames for normal maps |
| `export_cameras` | `False` | Viewer owns its camera |
| `export_lights` | `False` | Viewer owns lighting |
| `export_animations` | `False` | Static architectural shell |
| `export_draco_mesh_compression_enable` | `False` | No decoder setup for the first lightweight shell |

`use_selection`, `use_visible`, `use_renderable`, and collection filtering are separate exporter controls. Choose one deliberate inclusion policy after starting from an empty scene; do not accidentally export the default cube or omit metadata empties because only meshes were selected. Directly generated final meshes do not require `export_apply=True` to resolve an unapplied Boolean workflow.

Blender's exporter triangulates meshes for glTF. Runtime vertex counts may increase because glTF separates combinations of normals and UVs. A correct result therefore need not have exactly the same vertex count as its editable source. Check geometry, dimensions, roles, and expected topology rather than asserting byte-for-byte identical files across Blender versions.

## Controlled headless execution

The [Blender 4.5 command-line reference](https://docs.blender.org/manual/en/4.5/advanced/command_line/arguments.html) documents background operation, factory startup, explicit Python scripts, and Python exception exit codes. It also warns that argument order changes behavior. A trusted worker invocation follows this shape:

```bash
blender --background --factory-startup --disable-autoexec \
  --python-exit-code 1 --python /trusted/path/generate_scene.py -- \
  --input /private/job/request.json --output-dir /private/job/artifacts
```

The `--` separator reserves following arguments for the script. `--python-exit-code 1` must be in effect before executing the script so an uncaught exception produces a failed process result. `--disable-autoexec` restricts automatic scripts/drivers; it does not sandbox an explicitly supplied Python script. Run only the repository's trusted script, never a user-generated Python file or arbitrary uploaded `.blend`.

Use a subprocess argument array rather than shell interpolation. Add a timeout and private per-job output directory; validate input and output locations. A production worker still needs operating-system isolation and resource limits. A process exit code alone is insufficient: require the expected files, a complete manifest, artifact hashes, and identity matching the submitted project/job/revision.

Save `.blend` before GLB export and publish the completed artifact set only after both succeed. Failure during export must not return a successful reconstruction response merely because an intermediate Blender file exists. The JSON request and manifest remain necessary for reproducibility, evidence linkage, and stale-revision detection.

## Verification that demonstrates the result

These are acceptance criteria, not a record of completed checks:

1. Validate a deliberately asymmetric synthetic request; label it synthetic and never describe it as a scanned or measured real home.
2. Exercise invalid geometry, reversed polygon winding, concave floors, multiple openings, failed worker execution, and stale/partial output behavior.
3. Run Blender headlessly to produce `.blend`, GLB, and a manifest; inspect their actual sizes and hashes.
4. Reopen the saved `.blend` in a fresh Blender process. Check named editable objects, object roles, metric dimensions, and the real wall apertures.
5. Run the [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) against the GLB. Require zero validation errors and inspect warnings. This checks format and data consistency; it cannot establish that a door is in the correct room or that an inferred measurement is true.
6. Parse the artifact with the repository's actual Three.js GLTFLoader. Check loaded meshes, source IDs in `userData`, expected bounds, meter scale, and orientation. A successful parse is separate from a visual browser rendering check.
7. Render in the ordinary web viewer and inspect the doors/windows from useful viewpoints. Quest 3S hardware, Safari, and mobile performance are separate device checks and must not be inferred from a desktop loader test.

## What remains upstream or outside this stage

This pipeline converts supplied geometry into editable/renderable artifacts. It does not discover an address's exact floor plan, recover guaranteed metric scale from photographs, obtain iPhone LiDAR data through Safari, or prove that a proposed room is accurate. Those tasks need source evidence and human dimension confirmation as described in [capture and reconstruction](../docs/capture-and-reconstruction.md).

The baseline does not reconstruct existing furniture, bake reference photos into walls, auto-generate product assets, upload private files, authorize backend jobs, or deploy a GPU worker. Matthew owns the authorized backend integration and artifact storage. Angelina owns capture/confirmation UI. Silas owns viewer interaction and WebXR. Keeping those boundaries explicit lets each area consume a verified artifact without claiming the entire capture-to-shopping workflow is already live.

## Primary references

- [Blender 4.5 command-line arguments](https://docs.blender.org/manual/en/4.5/advanced/command_line/arguments.html): headless flags, exception handling, and execution order.
- [Blender 4.5 Mesh API](https://docs.blender.org/api/4.5/bpy.types.Mesh.html): direct mesh construction and mesh validation.
- [Blender 4.5 glTF manual](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html): export capabilities, materials, extras, and triangulation.
- [glTF-Blender-IO 4.5 release options](https://github.com/KhronosGroup/glTF-Blender-IO/blob/blender-v4.5-release/addons/io_scene_gltf2/__init__.py): exact operator property names and defaults.
- [glTF-Blender-IO 4.5 node transforms](https://github.com/KhronosGroup/glTF-Blender-IO/blob/blender-v4.5-release/addons/io_scene_gltf2/blender/exp/nodes.py): Blender-to-glTF axis conversion.
- [glTF 2.0 specification](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc): coordinates, units, and runtime interchange requirements.
- [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator): structural validation and its implemented checks.
- [Three.js GLTFLoader source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/GLTFLoader.js): loader behavior and extras-to-userData mapping; the project must still test its installed Three.js version.

The web search gateway returned access errors for the Blender pages during this research. The cited primary pages and exporter repositories were read directly over HTTPS; no result from a failed search was treated as evidence.
