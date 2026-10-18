import type { Cart, Mandate, Order, PaymentMethod, Recheck } from "@/backend/contracts";

/** Browser-safe checkout response. Payment credentials never enter this contract. */
export interface CheckoutView {
  cart: Cart;
  recheck: Recheck | null;
  paymentMethods: PaymentMethod[];
  mandate: Mandate | null;
  staleMandate: Mandate | null;
  orders: Order[];
  blockers: string[];
  stripePublishableKey: string | null;
  testPaymentsAvailable?: boolean;
}
