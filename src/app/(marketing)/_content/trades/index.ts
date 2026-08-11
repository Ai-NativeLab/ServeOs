import type { LucideIcon } from "lucide-react";
import type { VerticalId } from "@/server/verticals";
import type { Localized } from "../types";
import { restaurant } from "./restaurant";
import { retail } from "./retail";
import { pharmacy } from "./pharmacy";
import { timber } from "./timber";

/** `roadmap` marks a feature the product does not ship yet; the card renders a
 *  "Soon" chip. Do not clear a flag until the domain exists in src/server. */
export type TradeFeature = { icon: LucideIcon; title: string; description: string; roadmap?: boolean };
export type TicketLine = { qty: string; name: string; meta: string; amount: string };

export type TradeContent = {
  label: string;
  badge: string;
  headlineLead: string;
  subhead: string;
  photoCaption: string;
  features: TradeFeature[];
  steps: { title: string; description: string }[];
  ticket: { ref: string; channel: string; lines: TicketLine[]; status: string; total: string };
};

/** Identical across all four trades by design — the promise does not change with the shop. */
export const HEADLINE_HIGHLIGHT: Localized<string> = {
  ar: "أنشئ موقعك في دقيقة واحدة.",
  en: "Create your own in 1 minute.",
};

export const SOON: Localized<string> = { ar: "قريبًا", en: "Soon" };

export const TRADE_CONTENT: Record<VerticalId, Localized<TradeContent>> = {
  restaurant,
  retail,
  pharmacy,
  timber,
};
