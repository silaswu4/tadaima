import { handle } from "@/backend/http";
import { fetchCart } from "@/backend/session/fetch";
export async function GET(req: Request) { return handle(() => fetchCart(req)); }
