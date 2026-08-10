import type { Localized } from "./types";

export type DemoContent = {
  eyebrow: string;
  heading: string;
  body: string;
  openStorefront: string;
  openDashboard: string;
  resetNote: string;
};

export const DEMO: Localized<DemoContent> = {
  ar: {
    eyebrow: "جرّب بنفسك",
    heading: "ادخل على حساب شغّال، مش صور.",
    body: "أربع تجارب حية، واحدة لكل نشاط، متملية ببيانات حقيقية الشكل. افتح المتجر زي أي زبون، أو ادخل لوحة التحكم زي صاحب المحل.",
    openStorefront: "افتح المتجر",
    openDashboard: "ادخل لوحة التحكم",
    resetNote: "تجربة مشتركة — البيانات بترجع لأصلها كل يوم.",
  },
  en: {
    eyebrow: "Try it yourself",
    heading: "Open a working account, not a screenshot.",
    body: "Four live demos, one per trade, filled with realistic data. Open the storefront like a customer, or sign into the dashboard like the owner.",
    openStorefront: "Open the storefront",
    openDashboard: "Open the dashboard",
    resetNote: "Shared demo — data resets to its original state daily.",
  },
};
