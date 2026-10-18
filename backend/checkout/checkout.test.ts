import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { PaymentMethod, Recheck } from "@/backend/contracts";
import { cartOf, CartCurrencyError, CartProductError } from "@/backend/checkout/cart";
import { checkoutBlockers, freshRecheck, RECHECK_FRESH_MS } from "@/backend/checkout/policy";
import { observeProductPage } from "@/backend/checkout/observation";
import { demoPlan } from "@/backend/fixtures/demo-room";

const clone = () => structuredClone(demoPlan);
const activeProduct = () => demoPlan.products.find((product) => product.id === demoPlan.items.find((item) => item.origin === "proposed_purchase")!.productId)!;
const offer = (values: Record<string, unknown>) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", ...values } })}</script>`;
const page = () => ({ price: activeProduct().price!.amountMinor / 100, priceCurrency: "USD", availability: "https://schema.org/InStock" });
const card: PaymentMethod = { id: "pm_fixture", provider: "stripe_test", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
const now = Date.parse("2026-10-18T12:00:00Z");
const recheck = (plan = demoPlan): Recheck => ({
  projectId: plan.projectId, cartDigest: cartOf(plan).digest, allOk: true,
  checkedAt: new Date(now).toISOString(), lines: cartOf(plan).merchants.flatMap((merchant) => merchant.lines.map((line) => ({ productId: line.productId, label: line.label, status: "ok" as const, catalogPrice: line.observedPrice, observedPrice: line.observedPrice, note: null }))),
});

test("checkout mirrors quantities, excludes owned and stored items, and fingerprints merchant changes", () => {
  const plan = clone();
  const original = cartOf(plan);
  plan.items.push({ ...plan.items.find((item) => item.origin === "proposed_purchase")!, id: "extra_purchase" });
  const duplicate = cartOf(plan);
  assert.notEqual(duplicate.digest, original.digest);
  assert.equal(duplicate.merchants[0].lines.find((line) => line.productId === activeProduct().id)!.quantity, 2);
  plan.items[plan.items.length - 1].stored = true;
  assert.equal(cartOf(plan).digest, original.digest);
  plan.products.find((product) => product.id === activeProduct().id)!.merchant = "Another retailer";
  assert.notEqual(cartOf(plan).digest, original.digest);
});

test("checkout refuses mixed currencies and never silently adds incompatible amounts", () => {
  const plan = clone();
  plan.products.find((product) => product.id === activeProduct().id)!.price!.currency = "EUR";
  assert.throws(() => cartOf(plan), CartCurrencyError);
  const onlyEur = clone();
  onlyEur.items = onlyEur.items.filter((item) => item.origin === "existing_owned" || item.productId === activeProduct().id);
  onlyEur.products.find((product) => product.id === activeProduct().id)!.price!.currency = "EUR";
  assert.throws(() => cartOf(onlyEur), /requires prices in USD/);
});

test("unknown proposed product and invalid numeric prices cannot disappear from checkout", () => {
  const plan = clone();
  plan.items.find((item) => item.origin === "proposed_purchase")!.productId = "unknown";
  assert.throws(() => cartOf(plan), CartProductError);
  const malformed = clone();
  malformed.products.find((product) => product.id === activeProduct().id)!.price!.amountMinor = NaN;
  assert.throws(() => cartOf(malformed), /invalid price/);
});

test("missing stock blocks a live observation even when its price changed", () => {
  const values = page();
  delete (values as Partial<typeof values>).availability;
  values.price += 10;
  const observed = observeProductPage(activeProduct(), offer(values), now);
  assert.equal(observed.status, "unverified");
  assert.equal(observed.observed?.availability, "unknown");
  assert.match(observed.note!, /stock not stated/);
});

test("unknown currency, invalid prices and ambiguous variants cannot verify checkout", () => {
  for (const values of [{ ...page(), priceCurrency: undefined }, { ...page(), price: "garbage" }, { ...page(), price: -2 }]) assert.equal(observeProductPage(activeProduct(), offer(values), now).status, "unverified");
  assert.equal(observeProductPage(activeProduct(), `${offer(page())}${offer({ ...page(), price: 10 })}`, now).status, "unverified");
  assert.equal(observeProductPage(activeProduct(), "<html>no offer</html>", now).status, "unverified");
});

test("live observation distinguishes available, changed and unavailable exact offers", () => {
  assert.equal(observeProductPage(activeProduct(), offer(page()), now).status, "ok");
  assert.equal(observeProductPage(activeProduct(), offer({ ...page(), price: page().price + 10 }), now).status, "price_changed");
  assert.equal(observeProductPage(activeProduct(), offer({ ...page(), availability: "https://schema.org/OutOfStock" }), now).status, "unavailable");
  assert.equal(observeProductPage(activeProduct(), offer({ ...page(), availability: "LimitedAvailability" }), now).status, "ok");
});

test("approval and execution require a fresh complete observation for the exact cart", () => {
  const cart = cartOf(demoPlan), current = recheck();
  assert.deepEqual(checkoutBlockers(cart, current, [card], [], now), []);
  assert.equal(freshRecheck(current, cart.digest, now + RECHECK_FRESH_MS), true);
  for (const invalid of [{ ...current, checkedAt: "invalid" }, { ...current, checkedAt: new Date(now + 1).toISOString() }, { ...current, cartDigest: "another cart" }, { ...current, allOk: false }, { ...current, lines: [] }]) assert.equal(freshRecheck(invalid, cart.digest, now), false);
  assert.equal(freshRecheck(current, cart.digest, now + RECHECK_FRESH_MS + 1), false);
  assert.ok(checkoutBlockers(cart, { ...current, lines: current.lines.slice(1) }, [card], [], now).some((blocker) => blocker.includes("every cart item")));
  assert.ok(checkoutBlockers(cart, null, [], [], now).some((blocker) => blocker.includes("no card")));
});

test("server execution refuses expired stock checks and fixture products without touching Stripe", () => {
  // server-only imports use their documented React server condition in an isolated key-free process.
  const source = `
    import assert from 'node:assert/strict';
    import { getCheckout, approve, execute } from './backend/checkout/service.ts';
    import { projectKv, getPlan } from './backend/plan/store.ts';
    import { cartOf } from './backend/checkout/cart.ts';
    const id='proj_test_checkoutguards123';
    const plan=await getPlan(id), cart=cartOf(plan);
    const card=${JSON.stringify(card)};
    await projectKv.set(id,'wallet',{customerId:'cus_not_real',methods:[card]});
    const rc={projectId:id,cartDigest:cart.digest,allOk:true,checkedAt:new Date(Date.now()-16*60*1000).toISOString(),lines:cart.merchants.flatMap(g=>g.lines.map(l=>({productId:l.productId,label:l.label,status:'ok',catalogPrice:l.observedPrice,observedPrice:l.observedPrice,note:null})))};
    await projectKv.set(id,'recheck',rc);
    const mandate={id:'mdt_guard',projectId:id,cartDigest:cart.digest,maxAmount:cart.subtotal,merchants:cart.merchants.map(g=>g.merchant),paymentMethodId:card.id,approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),status:'active'};
    await projectKv.set(id,'mandate',mandate);
    await assert.rejects(execute(id),/recheck/);
    assert.equal((await projectKv.get(id,'mandate')).status,'active');
    assert.equal((await getCheckout(id)).orders.length,0);
    await projectKv.set(id,'recheck',{...rc,checkedAt:new Date().toISOString()});
    const globalStore=globalThis.__tadaimaStore;
    const fixturePlan=structuredClone(plan);
    fixturePlan.products.find(p=>p.id===cart.merchants[0].lines[0].productId).fixture=true;
    globalStore.set('plan:'+id,fixturePlan);
    await assert.rejects(approve(id,cart.digest,card.id),/demo-only products/);
    await assert.rejects(execute(id),/demo-only products/);
    console.log('checkout guards verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", STRIPE_SECRET_KEY: "", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /checkout guards verified/);
});

test("simultaneous execution consumes one mandate and charges an exact cart once with a stubbed Stripe resource", () => {
  const source = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import https from 'node:https';
    import http from 'node:http';
    import {createRequire} from 'node:module';
    const Stripe=createRequire(import.meta.url)('stripe');
    mock.method(http,'request',()=>{throw Error('unexpected network request')});
    mock.method(https,'request',()=>{throw Error('unexpected network request')});
    let charges=0, seenAmount=null;
    mock.method(Stripe.resources.PaymentIntents.prototype,'create',async (body,options)=>{charges++;seenAmount=body.amount;assert.equal(options.idempotencyKey,'mandate_mdt_once');await new Promise(r=>setTimeout(r,15));return{id:'pi_stubbed_only',status:'succeeded'}});
    const {getCheckout,approve,execute}=await import('./backend/checkout/service.ts');
    const {projectKv,getPlan}=await import('./backend/plan/store.ts');
    const {cartOf}=await import('./backend/checkout/cart.ts');
    const id='proj_test_checkoutconcurrent';
    const plan=await getPlan(id),cart=cartOf(plan),card=${JSON.stringify(card)};
    await projectKv.set(id,'wallet',{customerId:'cus_stubbed',methods:[card]});
    await projectKv.set(id,'recheck',{projectId:id,cartDigest:cart.digest,allOk:true,checkedAt:new Date().toISOString(),lines:cart.merchants.flatMap(g=>g.lines.map(l=>({productId:l.productId,label:l.label,status:'ok',catalogPrice:l.observedPrice,observedPrice:l.observedPrice,note:null})))});
    await projectKv.set(id,'mandate',{id:'mdt_once',projectId:id,cartDigest:cart.digest,maxAmount:cart.subtotal,merchants:cart.merchants.map(g=>g.merchant),paymentMethodId:card.id,approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),status:'active'});
    const results=await Promise.allSettled([execute(id),execute(id)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,results.map(r=>r.status==='rejected'?String(r.reason):r.value.id).join('; '));
    assert.equal(charges,1);
    assert.equal(seenAmount,cart.subtotal.amountMinor);
    const view=await getCheckout(id);
    assert.equal(view.orders.length,1);
    assert.ok(view.orders[0].merchantOrders.every(o=>o.status==='simulated'));
    await assert.rejects(approve(id,cart.digest,card.id),/already paid/);
    await assert.rejects(execute(id),/approv/);
    assert.equal(charges,1);
    console.log('single exact test charge verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_stubbed_no_network", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /single exact test charge verified/);
});

test("a declined test payment needs new approval; an uncertain result stays blocked from duplicate payment", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import {createRequire} from 'node:module';
    import https from 'node:https';
    import http from 'node:http';
    const Stripe=createRequire(import.meta.url)('stripe');
    mock.method(http,'request',()=>{throw Error('unexpected network request')});
    mock.method(https,'request',()=>{throw Error('unexpected network request')});
    let state='declined',charges=0;
    mock.method(Stripe.resources.PaymentIntents.prototype,'create',async()=>{charges++;if(state==='uncertain')throw Error('lost test response');return{id:'pi_declined_stub',status:'requires_payment_method'}});
    const {getCheckout,approve,execute}=await import('./backend/checkout/service.ts');
    const {projectKv,getPlan}=await import('./backend/plan/store.ts');
    const {cartOf}=await import('./backend/checkout/cart.ts');
    const id='proj_test_checkoutfailed123',plan=await getPlan(id),cart=cartOf(plan),card=${JSON.stringify(card)};
    await projectKv.set(id,'wallet',{customerId:'cus_stubbed',methods:[card]});
    await projectKv.set(id,'recheck',{projectId:id,cartDigest:cart.digest,allOk:true,checkedAt:new Date().toISOString(),lines:cart.merchants.flatMap(g=>g.lines.map(l=>({productId:l.productId,label:l.label,status:'ok',catalogPrice:l.observedPrice,observedPrice:l.observedPrice,note:null})))});
    await approve(id,cart.digest,card.id);
    await assert.rejects(execute(id),/declined/);
    await assert.rejects(execute(id),/approv/);
    assert.equal(charges,1);
    assert.deepEqual((await getCheckout(id)).blockers,[]);
    await approve(id,cart.digest,card.id);
    state='uncertain';
    await assert.rejects(execute(id),/could not be confirmed/);
    assert.equal(charges,2);
    assert.ok((await getCheckout(id)).blockers.some(b=>b.includes('reconciliation')));
    await assert.rejects(approve(id,cart.digest,card.id),/reconciliation/);
    assert.equal((await getCheckout(id)).orders.length,0);
    assert.equal(charges,2);
    console.log('payment failure recovery guards verified');
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", source], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", STRIPE_SECRET_KEY: "sk_test_stubbed_no_network", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /payment failure recovery guards verified/);
});
