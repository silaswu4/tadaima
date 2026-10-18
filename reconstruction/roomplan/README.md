# Native RoomPlan Import

This adapter imports a normalized native iPhone RoomPlan packet into the existing deterministic Blender pipeline. It does not require tape measurements or a vision-model API key. A native iPhone companion performs the sensor capture; an ordinary mobile web page cannot invoke RoomPlan.

The supported outcome is **one review-required room** with editable floors, walls and opening markers, real aperture cutouts, and optional separately editable detected-furniture size proxies. A successful import does not certify survey accuracy, furniture clearance, delivery fit, or physical device testing.

## Run

From the repository root, using Python 3.11 or newer:

```bash
python3 -m reconstruction.roomplan \
  --input /private/path/scan.json \
  --output reconstruction/output/native-job \
  --expected-project project-id \
  --expected-job job-id \
  --expected-revision 0
```

Add `--render --blender /path/to/Blender` to produce the editable scene and viewer asset. `BLENDER_BIN` is also supported. `--preview` additionally renders a CPU preview when `--render` is enabled. Blender 4.5 LTS or newer is required for generation; input validation and compilation require only Python's standard library.

Choose a fresh output directory for each run. Outputs are private local files:

| Path | Meaning |
| --- | --- |
| `scan.input.json` | Exact original bytes, retained with a SHA-256 digest |
| `roomplan.dossier.json` | Review state, modeling policy, warnings, and bounded corrections |
| `reconstruction.request.json` | Canonical validated request for the existing worker |
| `draft/scene.blend` | Named, independently editable scene objects when rendered |
| `draft/scene.glb` | Y-up runtime asset when rendered |
| `draft/manifest.json` | Existing artifact manifest with native-import warnings |

Files use mode `0600` inside a `0700` output directory. A supported packet that fails geometry compilation retains its original source and failed dossier; it does not generate a fallback bounding-box room. Invalid JSON, oversized input, or mismatched authorized identity fails before publication.

## Native wire format

Legacy `roomplan-scan/1.0` contains exactly:

- `schemaVersion`, `projectId`, `jobId`, `inputRevision`, `capturedAt`, `roomId`, and `roomLabel`.
- `device: { model, systemVersion }`.
- `surfaces`, each containing `id`, `category`, `dimensions`, `transform`, `confidence`, `parentId`, `polygonCorners`, and `isCurved`.

`category` is `wall`, `door`, `window`, or `opening`. Dimensions are `[width, height, depth]` in meters. The 16-element transform is **column-major**, right-handed, and Y-up: local X gives width, local Y gives height, and indices 12–14 give world translation. Reflected, scaled, sheared, inverted, or significantly sloped matrices are rejected.

`polygonCorners` are local surface-plane coordinates, normally with Z near zero. Empty corners mean the rectangular bounding dimensions are used. Nonempty corners must describe that same rectangle; arbitrary cut polygons and curved surfaces are declined. Native `parentIdentifier` should become `parentId`; do not manufacture a nearest-wall relationship in the exporter.

Input is bounded to 2 MiB, 64 walls, and 128 other surfaces. IDs accept up to 64 ASCII letters, digits, underscores, or hyphens, including ordinary UUID strings.

## Geometry and uncertainty policy

The importer recovers one closed, unbranched wall loop from surface endpoints and supporting-line intersections. Each repaired endpoint must move no more than **0.10 m**. It supports rotated and concave loops and rejects self-intersections, missing boundaries, disconnected rooms, ambiguous junctions, and collapsed segments. It does not complete an incomplete scan by inventing walls.

Wall bottoms and tops must each support a flat level within **0.08 m**. Floor Y is normalized to zero and the original world-to-room translation is recorded. Source confidence remains in evidence and low/unknown confidence produces warnings.

RoomPlan provides planar surfaces without an interior/exterior designation or physical wall thickness. The adapter therefore makes an explicit **inside-face assumption** and adds a **0.12 m inferred thickness**, offsetting centerlines outward by 0.06 m. Under that modeling assumption, the observed wall planes remain the interior faces. Actual clearance still requires review: the source API does not establish that those planes are physically surveyed interior finishes.

Openings use an explicit parent when supplied, then independently check orientation, coplanarity, and extent. A missing parent is accepted only when exactly one wall fits. Small discrepancies may be corrected within **0.05 m**, with distances recorded. Generic openings become door-shaped apertures only when floor-aligned; elevated generic openings are declined rather than relabeled as windows. Glass, leaves, and frames are not generated.

Native dimensions use `source_dimension` evidence to distinguish a sensor source from an arbitrary visual estimate. Inferred thickness and layout corrections remain `inferred`. No evidence is marked as user-confirmed by this importer.

## Verify

```bash
python3 -m unittest discover -s reconstruction/tests -p 'test_roomplan.py' -v
```

Set `BLENDER_BIN` to enable the actual Blender integration case. The fixtures are synthetic transforms and do not replace an iPhone 14 Pro capture test. The suite covers clear-face modeling, rotations, reversed axes, concavity, incomplete loops, reflected matrices, malformed surfaces, opening parents, source provenance, private output, and an actual `.blend`/GLB generation gate.

References: Apple's [surface transforms](https://developer.apple.com/documentation/roomplan/capturedroom/surface/transform), [local polygon corners](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners), and [parent identifiers](https://developer.apple.com/documentation/roomplan/capturedroom/surface/parentidentifier). An [Apple DTS explanation of wall planes and thickness](https://developer.apple.com/forums/thread/837547) supports treating thickness and face interpretation as modeling conventions.

## Existing objects (v1.1)

The companion now exports `roomplan-scan/1.1`, adding required `objects` with native IDs, categories, confidence, dimensions and object-center transforms. The importer preserves supported detections as evidence-linked existing-owned items with bottom-center placement, yaw and inferred planning locks. It does not turn detections into merchant products or exact textured meshes. Old v1.0 input remains supported. Valid tilted objects are explicitly omitted with reasons because the application currently supports yaw only. See [existing furniture contracts, real recovery and verification](../../docs/existing-furniture.md).
