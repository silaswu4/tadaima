# Blender lighting in the web room

The main room viewer combines offline Cycles diffuse lighting with dynamic PBR reflections, furniture edits and cached contact shadows. This preserves soft area-light falloff and bounced illumination without running a path tracer inside Quest Browser.

## Produce a derived model

Use Blender 4.5 LTS and fresh output directories. The scripts never overwrite the source `.blend`, request JSON or original GLB.

```bash
"$BLENDER_BIN" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python reconstruction/bake_indirect.py -- \
  --input-blend /private/room/scene.blend --output /private/room/baked \
  --size 2048 --samples 64 --full-diffuse --closed-ceiling --smooth-radius 0

"$BLENDER_BIN" --background --factory-startup --disable-autoexec --python-exit-code 1 \
  --python reconstruction/denoise_lightmap.py -- \
  --input /private/room/baked --output /private/room/denoised --gutter 2
```

The bake restores architectural walls hidden for the isometric preview, excludes the presentation ground and can add a temporary inferred ceiling for illumination. That ceiling is removed before export. Geometry, dimensions, entity transforms, original material images, base UVs and the source JSON hash are preserved. The second UV set packs the irradiance atlas.

Static architecture is baked with movable furniture hidden. Furniture is baked separately at its source pose. The architectural lightmap therefore contains no fixed furniture silhouettes when pieces are moved or stored. Furniture-to-furniture occlusion within the source-pose bake remains an approximation when neighboring items are rearranged.

Use the OIDN stage on raw Cycles output before inspecting the result. It runs Blender's actual CPU OpenImageDenoise compositor in linear HDR, verifies its EXR dimensions, then writes an explicit sRGB PNG and repacks the GLB. Optional masked smoothing (`--smooth-radius 2`, `4`, `6` or `8`) can reduce broad residual mottling in an existing prefiltered atlas. Gutters extend edge colors into unused padding. Inspect small furniture details after stronger smoothing; it trades fine shading detail for a smoother result.

Both stages emit reports with source hashes, actual pass configuration, timings, normalized radiance scale and artifact hashes. The denoiser checks the input artifact hashes before processing. A raw low-sample bake can be visibly noisy even if the GLB validates; binary validation alone is not visual acceptance.

## Runtime contract

- `cycles-diffuse-indirect-v1`: indirect diffuse only; runtime direct light remains active.
- `cycles-diffuse-full-v1`: direct and indirect diffuse; shader replaces runtime diffuse once to avoid double lighting. Live specular and contact shading remain active.
- The tagged emissive texture is transport only. The viewer moves it to `lightMap`, zeros emission and applies `Math.PI * tadaimaIndirectScale` to restore Blender's irradiance scale.
- The atlas uses UV channel 1; base color and normal textures keep their original UVs. Invalid profiles, scales or UVs are refused before saving a model.
- Optional AO in atlas alpha modulates indirect illumination. It is not used in the current full diffuse model, which already includes occlusion.
- Bilinear atlas sampling avoids global mipmaps mixing unrelated islands with black padding. One 2048px RGBA8 atlas costs about 16 MiB of GPU storage without mipmaps; original material textures and render targets are additional.
- Captured furniture owns its material instances while sharing atlas texture storage. Moving one chair cannot change every chair's lightmap intensity. Its source-pose bake is disabled while moved/rotated/exploded and restored when it returns.
- Verified window panes keep a separate clear alpha PBR material. They do not inherit the opaque lighting atlas; blinds, frames and measured openings are preserved. No captured exterior is implied. In the first-person shopping view, a small procedural daylight sky replaces the blank presentation background behind verified windows. Blinds start raised; the **Blinds raised / Raise blinds** toggle restores the source fabric. This changes presentation only, not the saved plan or source GLB. The sky is synthetic; the real exterior has not been captured. Its 512 × 256 RGBA8 source uses 0.5 MiB before the renderer’s small cubemap conversion, with no refraction pass. Dollhouse mode keeps its original presentation background. Raising the fabric does not rebake the static indoor illumination.

The inferred runtime ceiling uses a broad bounce approximation because it is absent from the measured exported shell. Color management and dynamic contacts approximate the offline render rather than reproducing every Cycles ray.

## Apply to a saved room

In **Your rooms → Open scan**, select the same reconstruction JSON and the derived GLB, then enable **Update the model for an existing scan**. The verified asset replacement preserves the original source, accepted furniture edits, basket, revision and room identity. Ordinary reimport keeps the existing model unless this option is selected.

The authenticated development capture bridge also refreshes an existing scan's validated model when a new local preview is opened, preserving its edits. Set the ignored `TADAIMA_LOCAL_CAPTURE_DIR` to the derived output directory before using `npm run quest:open`. Keep the bridge token private. This bridge is unavailable in production.

## Quest and verification

The existing immersive profile retains one cached 1024px PCF shadow map, 0.85 framebuffer scale and 0.6 foveation. Baked lighting requires no full-screen postprocessing or point-light shadow cubes. Physical Quest frame rate and comfort still need headset testing.

Run `npm run test:spatial`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `python3 -m unittest reconstruction.tests.test_indirect_bake -v`. Image filter tests need NumPy (bundled with Blender); an unavailable NumPy is reported as skipped rather than passed. Check the actual imported room in first person, including furniture edits, window transparency, reload and mobile rendering. Validate the generated GLB with Khronos glTF Validator separately.

References: [Blender Cycles baking](https://docs.blender.org/manual/en/4.4/render/cycles/baking.html), [Three.js PBR lightmaps](https://threejs.org/docs/pages/MeshStandardMaterial.html).
