import { listScans, uploadScan } from "@/reconstruction/scans.server";

/** Phone upload of a TadaimaScan export (JSON or scan + photos ZIP). */
export async function POST(request: Request) {
  return uploadScan(request);
}

/** Recent scans for the /rooms phone inbox. */
export async function GET(request: Request) {
  return listScans(request);
}
