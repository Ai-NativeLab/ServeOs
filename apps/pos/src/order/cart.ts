export type CartLine = {
  productId: string;
  name: string;
  quantity: number;
  selectedOptionIds: string[];
  unitPrice: number;
};

export function lineKey(l: { productId: string; selectedOptionIds: string[] }): string {
  return l.productId + "|" + [...l.selectedOptionIds].sort().join(",");
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  const idx = lines.findIndex((l) => lineKey(l) === key);
  if (idx >= 0) {
    return lines.map((l, i) => (i === idx ? { ...l, quantity: l.quantity + line.quantity } : l));
  }
  return [...lines, line];
}

export function removeLine(lines: CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

export function changeQty(lines: CartLine[], index: number, quantity: number): CartLine[] {
  if (quantity <= 0) return removeLine(lines, index);
  return lines.map((l, i) => (i === index ? { ...l, quantity } : l));
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}
