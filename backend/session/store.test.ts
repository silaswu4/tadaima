import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("room registration, plan revisions and checkout claims compare atomically in development storage", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {createPlan,getPlan,savePlan,projectKv} from './backend/plan/store.ts';
    import {demoPlan} from './backend/fixtures/demo-room.ts';
    import {registerRoomSession,authorizeRoomProject,assertSameOrigin} from './backend/session/service.ts';
    import {readRoomBody} from './backend/session/body.ts';
    const id='proj_room_00000000000000000000000000000099';
    const plan={...structuredClone(demoPlan),projectId:id};
    assert.equal((await Promise.all([createPlan(plan),createPlan({...plan,revision:99})])).filter(Boolean).length,1);
    const initial=await getPlan(id);
    assert.equal(initial.revision,plan.revision);
    initial.geometry.rooms[0].height=99;
    assert.notEqual((await getPlan(id)).geometry.rooms[0].height,99);
    const outcomes=await Promise.all([savePlan(id,plan.revision,plan),savePlan(id,plan.revision,plan)]);
    assert.equal(outcomes.filter(result=>result.ok).length,1);
    const mandate={id:'one',status:'active'};
    await projectKv.set(id,'mandate-test',mandate);
    const claims=await Promise.all([projectKv.compareAndSet(id,'mandate-test',mandate,{...mandate,status:'used'}),projectKv.compareAndSet(id,'mandate-test',mandate,{...mandate,status:'used'})]);
    assert.equal(claims.filter(Boolean).length,1);
    assert.equal((await Promise.all([projectKv.claim(id,'one-claim',true),projectKv.claim(id,'one-claim',true)])).filter(Boolean).length,1);
    const realNow=Date.now; let now=realNow();Date.now=()=>now;
    await projectKv.claim(id,'expiry',true,1);now+=1001;
    assert.equal(await projectKv.claim(id,'expiry',true,1),true);Date.now=realNow;
    const headers={Origin:'http://127.0.0.1:3017',Host:'127.0.0.1:3017'};
    // Mimic Next's dev URL normalization while retaining the actual browser Host.
    const request=new Request('http://localhost:3017/api/room-sessions',{method:'POST',headers});
    const session=await registerRoomSession(request,'private-unit-test',plan);
    assert.equal(session.payload.plan.revision,plan.revision+1);
    const cookie=session.cookie.split(';')[0];
    const ownRequest=new Request('http://localhost:3017/api/projects/'+session.payload.plan.projectId,{headers:{Cookie:cookie}});
    await authorizeRoomProject(ownRequest,session.payload.plan.projectId);
    await assert.rejects(authorizeRoomProject(new Request(ownRequest.url),session.payload.plan.projectId),/no room session/);
    assert.throws(()=>assertSameOrigin(new Request(request.url,{method:'POST',headers:{...headers,Origin:'https://foreign.example'}})),/this website/);
    const body=new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"valid":true}'});
    assert.deepEqual(await readRoomBody(body),{valid:true});
    await assert.rejects(readRoomBody(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'["large"]'}),3),/too large/);
    console.log('atomic session store verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", KV_REST_API_URL: "", KV_REST_API_TOKEN: "", STRIPE_SECRET_KEY: "", BROWSER_USE_API_KEY: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /atomic session store verified/);
});

test("private direct edits and saved proposals preserve owned source furniture; fixture behavior stays unchanged", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {createPlan,getPlan,saveProposal} from './backend/plan/store.ts';
    import {applyPlanChanges,applyProposal} from './backend/plan/operations.ts';
    import {demoPlan} from './backend/fixtures/demo-room.ts';
    const projectId='proj_room_00000000000000000000000000000098';
    const initial=structuredClone(demoPlan); initial.projectId=projectId;
    initial.constraints.minimumSeats=null; initial.items.forEach(item=>item.locked=false);
    await createPlan(initial);
    const owned=initial.items.find(item=>item.origin==='existing_owned');
    const product=initial.products.find(product=>product.category==='chair');
    for (const changes of [
      [{kind:'remove',itemId:owned.id}],
      [{kind:'replace',itemId:owned.id,productId:product.id}],
      [{kind:'store',itemId:owned.id},{kind:'remove',itemId:owned.id}],
      [{kind:'add',item:{...owned,id:'forged_owned'}}]
    ]) {
      const result=await applyPlanChanges(projectId,initial.revision,changes);
      assert.equal(result.ok,false); assert.equal(result.reason,'validation_failed');
      assert.match(result.validations[0].message,/source identity/);
      assert.equal((await getPlan(projectId)).revision,initial.revision);
    }
    const proposal={id:'proposal_preserve_source',projectId,baseRevision:initial.revision,changes:[{kind:'remove',itemId:owned.id}]};
    await saveProposal(proposal);
    const applied=await applyProposal(projectId,proposal.id,initial.revision);
    assert.equal(applied.ok,false);assert.match(applied.validations[0].message,/source identity/);
    const stored=await applyPlanChanges(projectId,initial.revision,[{kind:'store',itemId:owned.id}]);
    assert.equal(stored.ok,true);assert.equal(stored.plan.items.find(item=>item.id===owned.id).stored,true);
    const fixtureId='proj_test_sourcesafety';
    const fixture=await getPlan(fixtureId);
    const fixtureOwned=fixture.items.find(item=>item.origin==='existing_owned');
    const removed=await applyPlanChanges(fixtureId,fixture.revision,[{kind:'lock',itemId:fixtureOwned.id,locked:false},{kind:'remove',itemId:fixtureOwned.id},{kind:'set_constraints',constraints:{minimumSeats:0}}]);
    assert.equal(removed.ok,true);
    console.log('source ownership operation boundary verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", KV_REST_API_URL: "", KV_REST_API_TOKEN: "", STRIPE_SECRET_KEY: "", BROWSER_USE_API_KEY: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /source ownership operation boundary verified/);
});

test("placement refuses unknown stock, fixture observations, unpriced, unsized and foreign-currency offers before committing", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {createPlan,getPlan} from './backend/plan/store.ts';
    import {placeProduct} from './backend/shopping/shop.ts';
    import {demoPlan} from './backend/fixtures/demo-room.ts';
    const real=demoPlan.products.find(product=>product.category==='chair'&&product.dimensions&&product.price&&product.availability==='available');
    const cases=[{...real,availability:'unknown'},{...real,fixture:true},{...real,price:null},{...real,dimensions:null},{...real,price:{amountMinor:100,currency:'EUR'}},{...real,price:{amountMinor:NaN,currency:'USD'}}];
    for (let index=0;index<cases.length;index++) {
      const projectId='proj_room_'+String(80+index).padStart(32,'0');
      const plan={...structuredClone(demoPlan),projectId,items:[],products:[cases[index]],constraints:{budget:null,minimumSeats:null,clearance:0.1}};
      await createPlan(plan);
      const result=await placeProduct(projectId,{productId:real.id,spot:{position:[2,0,2]},expectedRevision:plan.revision});
      assert.equal(result.ok,false);assert.equal(result.reason,cases[index].dimensions===null?'no_fit':'validation_failed');
      const canonical=await getPlan(projectId);assert.equal(canonical.revision,plan.revision);assert.equal(canonical.items.length,0);
    }
    console.log('unknown offers cannot commit verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", KV_REST_API_URL: "", KV_REST_API_TOKEN: "", STRIPE_SECRET_KEY: "", BROWSER_USE_API_KEY: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /unknown offers cannot commit verified/);
});
