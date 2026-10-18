import { connectScans } from "@/reconstruction/scans.server";

/** The /rooms inbox exchanges the scan key for an HttpOnly cookie on deployed sites. */
export async function POST(request: Request) {
  return connectScans(request);
}
