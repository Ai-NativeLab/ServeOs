export type OnboardingStep = { key: string; label: string; href: string; done: boolean };

export type OnboardingInput = {
  branchCount: number;
  publishedProductCount: number;
  hasOpeningHours: boolean;
  acceptingOrders: boolean;
};

export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
  return [
    { key: "branch", label: "Add a branch", href: "/dashboard/branches", done: input.branchCount > 0 },
    { key: "menu", label: "Publish menu items", href: "/dashboard/menu", done: input.publishedProductCount > 0 },
    { key: "hours", label: "Set opening hours", href: "/dashboard/fulfillment", done: input.hasOpeningHours },
    { key: "live", label: "Start accepting orders", href: "/dashboard/fulfillment", done: input.acceptingOrders },
  ];
}
