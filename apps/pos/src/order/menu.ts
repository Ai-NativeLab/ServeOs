export type MenuOption = {
  id: string;
  nameEn: string;
  nameAr: string;
  priceDelta: string;
  isDefault: boolean;
};

export type MenuModifierGroup = {
  id: string;
  nameEn: string;
  nameAr: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: MenuOption[];
};

export type MenuProduct = {
  id: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  effectivePrice: number;
  imageUrl: string | null;
  modifierGroups: MenuModifierGroup[];
};

export type MenuCategory = {
  id: string;
  nameEn: string;
  nameAr: string;
  imageUrl: string | null;
  products: MenuProduct[];
};

export type Menu = {
  categories: MenuCategory[];
};

export function parseMenu(json: string): Menu {
  return JSON.parse(json) as Menu;
}

export function listCategories(menu: Menu): MenuCategory[] {
  return menu.categories;
}

export function findProduct(menu: Menu, productId: string): MenuProduct | undefined {
  for (const c of menu.categories) {
    const p = c.products.find((p) => p.id === productId);
    if (p) return p;
  }
  return undefined;
}

export function optionDeltaSum(product: MenuProduct, selectedOptionIds: string[]): number {
  const ids = new Set(selectedOptionIds);
  let sum = 0;
  for (const g of product.modifierGroups) {
    for (const o of g.options) {
      if (ids.has(o.id)) sum += Number(o.priceDelta);
    }
  }
  return sum;
}
