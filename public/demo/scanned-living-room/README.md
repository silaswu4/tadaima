# Shared scanned living room

Published at the room owner's explicit request on October 18, 2026. Open `/rooms/scanned-living-room`, or choose **Scanned living room** in `/rooms`. Teammates get the reconstruction from a normal checkout/deployment; no private capture token or browser import is needed.

- `scene.json`: sanitized reconstruction input, 28 detected furniture items, 12 walls and 4 openings. Original metric geometry, object IDs, poses, dimensions, locks and evidence claims are retained. Private asset references were removed.
- `scene.glb`: the current polished room, including embedded baked indirect lighting and procedural photo-informed finishes. Approximately 8.16 MiB. Geometry and compressed image pixel payloads match the private original; four EXIF chunks were removed from generated PNGs. Source binding metadata points to the sanitized JSON.
- `manifest.json`: byte counts, source/model hashes and unchanged geometry/image pixel payload hashes. The original source/model hashes document derivation without exposing credentials or source files.

This is a real iPhone RoomPlan layout with photo-informed parametric furniture and materials. Furniture detail and finishes are estimates based on photos, not an exact textured LiDAR mesh or a calibrated photogrammetry reconstruction. Sensor geometry is not survey accuracy. Existing overlaps or missing detail may remain. The model's review-required annotations remain intact.

Raw photos, photo ZIPs, native USDZ, Blender source, private filesystem paths and development tokens are not included. PNGs embedded in the GLB are generated lightmaps/material maps, not the original camera images. The earlier private `local-scan-80d62…` room and its edits stay separate. Published-room changes are saved as a per-browser catalog draft, through the same server-owned shopping session and revision checks as other rooms. Baskets start empty; captured furniture retains its source locks until the shopper explicitly changes them.
