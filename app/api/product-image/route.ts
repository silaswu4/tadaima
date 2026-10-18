import { productImageResponse } from "@/backend/shopping/product-image";

export async function GET(request: Request) { return productImageResponse(request); }
