import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Fetch pairing is one-use, room-scoped, revocable, expires, and cannot approve edits or expose source media", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {registerRoomSession} from './backend/session/service.ts';
    import {createFetchPairing,redeemFetchPairing,authorizeFetchProject,revokeFetchPairing,requireFetchAccess,recordFetchResult,fetchPairingStatus,redactFetchMedia} from './backend/session/fetch.ts';
    import {saveProposal} from './backend/plan/store.ts';
    import {demoPlan} from './backend/fixtures/demo-room.ts';
    const origin='http://127.0.0.1:3017';
    const request=(path,method='GET',cookie='',token='')=>new Request(origin+path,{method,headers:{Origin:origin,Host:'127.0.0.1:3017',Cookie:cookie,...(token?{Authorization:'Bearer '+token}:{})}});
    const session=await registerRoomSession(request('/api/room-sessions','POST'),'fetch-unit',demoPlan);
    const projectId=session.payload.plan.projectId,cookie=session.cookie.split(';')[0],path='/api/projects/'+projectId;
    const owner=(method)=>request('/api/room-sessions/'+projectId+'/fetch',method,cookie);
    await assert.rejects(createFetchPairing(owner('POST'),projectId.replace(/.$/,'z')),/no room session/);
    await assert.rejects(createFetchPairing(request('/','POST'),projectId),/no room session/);
    const pending=await createFetchPairing(owner('POST'),projectId);
    assert.match(pending.code,/^[a-f0-9]{32}$/);
    const redeemed=await Promise.allSettled([redeemFetchPairing(pending.code,'sender_A'),redeemFetchPairing(pending.code,'sender_B')]);
    assert.equal(redeemed.filter(result=>result.status==='fulfilled').length,1);
    const connection=redeemed.find(result=>result.status==='fulfilled').value;
    assert.equal(connection.projectId,projectId);
    const access=await authorizeFetchProject(request(path,'GET','',connection.token),projectId);
    assert.equal(access.projectId,projectId);
    for (const [method,suffix] of [['GET','/checkout'],['POST','/changes'],['POST','/place'],['POST','/reset'],['POST','/items/chair/store'],['POST','/items/chair/move-to'],['POST','/proposals/id/apply'],['POST','/checkout/approve'],['POST','/checkout/execute']]) {
      await assert.rejects(authorizeFetchProject(request(path+suffix,method,'',connection.token),projectId),/confirm this action/);
    }
    await assert.rejects(authorizeFetchProject(request(path,'GET','',connection.token),'proj_room_'+'0'.repeat(32)),/no room session/);
    await assert.rejects(authorizeFetchProject(request(path,'GET','','wrong'),projectId),/pairing required/);
    assert.equal(await authorizeFetchProject(request(path),projectId),null);
    const proposal={id:'fetch_test_proposal',projectId,baseRevision:session.payload.plan.revision};
    await saveProposal(proposal);
    await recordFetchResult(request(path+'/proposals','POST','',connection.token),access,proposal);
    const status=await fetchPairingStatus(owner('GET'),projectId);
    assert.equal(status.status,'connected'); assert.equal(status.proposal.id,proposal.id);
    assert.ok(!JSON.stringify(status).includes(connection.token));
    const replacement=await createFetchPairing(owner('POST'),projectId);
    await assert.rejects(requireFetchAccess(request(path,'GET','',connection.token)),/expired or disconnected/);
    await assert.rejects(redeemFetchPairing(pending.code,'sender_C'),/expired or already used/);
    const newConnection=await redeemFetchPairing(replacement.code,'sender_A');
    await revokeFetchPairing(owner('DELETE'),projectId);
    await assert.rejects(requireFetchAccess(request(path,'GET','',newConnection.token)),/expired or disconnected/);
    // Work completing after disconnect must not resurrect the connection or its inbox.
    await recordFetchResult(request(path+'/proposals','POST'),access,proposal);
    assert.equal((await fetchPairingStatus(owner('GET'),projectId)).status,'disconnected');
    const realNow=Date.now; let now=realNow(); Date.now=()=>now;
    const expiredCode=await createFetchPairing(owner('POST'),projectId); now+=600001;
    await assert.rejects(redeemFetchPairing(expiredCode.code,'sender_A'),/expired or already used/);
    const activeCode=await createFetchPairing(owner('POST'),projectId);
    const activeConnection=await redeemFetchPairing(activeCode.code,'sender_A'); now+=3600001;
    await assert.rejects(requireFetchAccess(request(path,'GET','',activeConnection.token)),/expired or disconnected/);
    Date.now=realNow;
    const privatePlan=structuredClone(session.payload.plan);
    privatePlan.appearance={notes:['PRIVATE_PHOTO_URL']}; privatePlan.evidence=[{sourceUrl:'PRIVATE_PHOTO_URL',privateAssetId:'PRIVATE_ASSET'}];
    privatePlan.items[0].assetUrl='PRIVATE_GLB_URL';
    const redacted=redactFetchMedia({plan:privatePlan,result:privatePlan});
    assert.ok(!JSON.stringify(redacted).includes('PRIVATE_'));
    assert.deepEqual(redacted.plan.geometry,privatePlan.geometry);
    assert.equal(redacted.plan.items.length,privatePlan.items.length);
    assert.equal(redacted.plan.products.length,privatePlan.products.length);
    console.log('scoped Fetch pairing verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }, timeout: 20_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /scoped Fetch pairing verified/);
});
