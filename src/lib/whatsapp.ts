export type WhatsappOrderSummary = {
  orderNumber: number;
  fulfillmentType: "pickup" | "delivery";
  items: { quantity: number; nameEn: string }[];
  total: string;
};

const MAX_ITEMS = 8;

export function buildOrderWhatsappMessage(order: WhatsappOrderSummary): string {
  const lines = order.items.slice(0, MAX_ITEMS).map((i) => `${i.quantity}x ${i.nameEn}`);
  const remaining = order.items.length - MAX_ITEMS;
  return [
    `Order #${order.orderNumber}`,
    order.fulfillmentType === "delivery" ? "Delivery" : "Pickup",
    ...lines,
    ...(remaining > 0 ? [`+${remaining} more item(s)`] : []),
    `Total: ${order.total}`,
  ].join("\n");
}

export function whatsappChatLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`;
}
