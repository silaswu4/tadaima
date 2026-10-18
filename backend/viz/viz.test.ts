import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { vizPath, vizSig, vizSigOk } from "@/backend/viz/sign";

test("viz signatures are 22 chars of base64url HMAC and match the Python helper's vector", () => {
  // same vector is asserted in backend/fetch/viz.py
  assert.equal(vizSig("test-secret", "proj_demo/r1.png"), "1RGH4ibpeHLCWKXQwfq-ry");
  assert.ok(vizSigOk("proj_demo/r1.png", "1RGH4ibpeHLCWKXQwfq-ry", "test-secret", "production"));
  assert.equal(vizSigOk("proj_demo/r2.png", "1RGH4ibpeHLCWKXQwfq-ry", "test-secret", "production"), false);
  assert.equal(vizSigOk("proj_demo/r1.png", "1RGH4ibpeHLCWKXQwfq-r", "test-secret", "production"), false);
  assert.equal(vizSigOk("proj_demo/r1.png", null, "test-secret", "development"), false);
  // unsigned only in dev without a secret
  assert.ok(vizSigOk("proj_demo/r1.png", null, undefined, "development"));
  assert.equal(vizSigOk("proj_demo/r1.png", null, undefined, "production"), false);
  assert.equal(vizPath("proj_demo", "r1.png", "test-secret"), "/api/viz/proj_demo/r1.png?s=1RGH4ibpeHLCWKXQwfq-ry");
});

test("viz route renders signed revision and proposal PNGs from snapshots and 404s bad signatures", () => {
  // server-only imports need the react-server condition, so this runs in its own process
  const source = `
    import assert from 'node:assert/strict';
    import {getPlan,savePlan,saveProposal,getPlanRevision} from './backend/plan/store.ts';
    import {renderPlanPng} from './backend/viz/render.tsx';
    import {demoPlan} from './backend/fixtures/demo-room.ts';
    import {vizSig} from './backend/viz/sign.ts';
    import {GET} from './app/api/viz/[projectId]/[file]/route.ts';
    const PNG=[0x89,0x50,0x4e,0x47];
    const isPng=async r=>{const b=new Uint8Array(await r.arrayBuffer());return b.length>10000&&PNG.every((v,i)=>b[i]===v)};
    assert.ok(await isPng(await renderPlanPng(demoPlan)));
    const id='proj_test_vizroute01';
    const get=(file,s=vizSig('viz-test',id+'/'+file))=>GET(new Request('http://x/api/viz/'+id+'/'+file+'?s='+s),{params:Promise.resolve({projectId:id,file})});
    const v1=await getPlan(id);
    const next=structuredClone(v1);
    next.items=next.items.map(it=>it.id==='item_coffee_table'?{...it,stored:true}:it);
    assert.ok((await savePlan(id,v1.revision,next)).ok);
    assert.equal((await getPlanRevision(id,1)).items.some(it=>it.stored),false);
    assert.equal((await getPlanRevision(id,2)).items.find(it=>it.id==='item_coffee_table').stored,true);
    assert.equal(await getPlanRevision(id,3),null);
    const r1=await get('r1.png');
    assert.equal(r1.status,200);
    assert.equal(r1.headers.get('content-type'),'image/png');
    assert.match(r1.headers.get('cache-control'),/immutable/);
    assert.ok(await isPng(r1));
    assert.ok(await isPng(await get('r2.png')));
    assert.equal((await get('r3.png')).status,404);
    assert.equal((await get('r1.png','nope')).status,404);
    assert.equal((await get('r1.png',vizSig('viz-test',id+'/r2.png'))).status,404);
    assert.equal((await get('x1.png')).status,404);
    await saveProposal({id:'prop_viz1',projectId:id,baseRevision:1,intent:'put the table away',changes:[],result:next,validations:[],costBefore:null,costAfter:null,summary:'',createdAt:new Date().toISOString()});
    assert.ok(await isPng(await get('pprop_viz1.png')));
    assert.equal((await get('pprop_missing.png')).status,404);
    console.log('viz route verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", VIZ_SECRET: "viz-test", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }, timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /viz route verified/);
});
