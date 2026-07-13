"use client";
import { createContext, useContext, useState } from "react";
import { useLang } from "./LangProvider";
import { verticals, SHARED, type VerticalDef, type VerticalId } from "./verticals";

type VerticalContextValue = {
  id: VerticalId;
  setVertical: (id: VerticalId) => void;
  /** The active vertical, resolved to the current locale. */
  v: VerticalDef["copy"][keyof VerticalDef["copy"]];
  accent: string;
  shared: (typeof SHARED)[keyof typeof SHARED];
};

const VerticalContext = createContext<VerticalContextValue | null>(null);

export function VerticalProvider({ children }: { children: React.ReactNode }) {
  const { locale } = useLang();
  const [id, setVertical] = useState<VerticalId>("restaurant");
  const def = verticals[id];

  return (
    <VerticalContext.Provider
      value={{ id, setVertical, v: def.copy[locale], accent: def.accent, shared: SHARED[locale] }}
    >
      {children}
    </VerticalContext.Provider>
  );
}

export function useVertical(): VerticalContextValue {
  const ctx = useContext(VerticalContext);
  if (!ctx) throw new Error("useVertical must be used within VerticalProvider");
  return ctx;
}
