import "server-only";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import type { RoomPlan } from "../contracts";

/**
 * Room approval receipt: a devnet Memo transaction recording a SHA-256 of exactly what the
 * shopper approved (room revision and every basket line with its observed price). Anyone can
 * recompute the hash from the plan and compare it with the onchain memo; a later edit cannot
 * pretend to be the approved basket. Devnet only: no funds move and nothing is purchased.
 */
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export class ReceiptUnavailable extends Error {}

export function approvalDigest(plan: RoomPlan) {
  const lines = plan.items.filter((item) => item.origin === "proposed_purchase" && !item.stored).map((item) => {
    const price = plan.products.find((product) => product.id === item.productId)?.price ?? null;
    return { item: item.id, product: item.productId, label: item.label, priceMinor: price?.amountMinor ?? null, currency: price?.currency ?? null };
  }).sort((a, b) => a.item.localeCompare(b.item));
  const totalMinor = lines.reduce((sum, line) => sum + (line.priceMinor ?? 0), 0);
  const canonical = JSON.stringify({ projectId: plan.projectId, revision: plan.revision, lines });
  return { lines, totalMinor, sha256: createHash("sha256").update(canonical).digest("hex") };
}

function signer(): Keypair {
  const raw = process.env.SOLANA_RECEIPT_SECRET;
  if (!raw) throw new ReceiptUnavailable("Solana receipts are not configured on this server.");
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])); }
  catch { throw new ReceiptUnavailable("The Solana receipt key is invalid."); }
}

export async function recordApproval(plan: RoomPlan) {
  const digest = approvalDigest(plan);
  if (!digest.lines.length) throw new ReceiptUnavailable("Add something to the basket before approving it.");
  const payer = signer(), connection = new Connection(RPC, "confirmed");
  if (await connection.getBalance(payer.publicKey) < 10_000) throw new ReceiptUnavailable(`The receipt key ${payer.publicKey.toBase58()} has no devnet SOL yet.`);
  const memo = `tadaima approval v1 ${plan.projectId} r${plan.revision} ${digest.lines.length} items ${digest.totalMinor} sha256:${digest.sha256}`;
  const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo, "utf8") }));
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  return { signature, memo, sha256: digest.sha256, revision: plan.revision, items: digest.lines.length, totalMinor: digest.totalMinor,
    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
}
