"use client";
import { useState, type CSSProperties } from "react";
import { registerAction } from "./actions";
import { VERTICAL_IDS, VERTICAL_ACCENTS, type VerticalId } from "@/server/tenancy/verticals";

const NAME_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant name",
  retail: "Shop name",
  pharmacy: "Pharmacy name",
  timber: "Yard name",
};
const CARD_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant",
  retail: "Retail",
  pharmacy: "Pharmacy",
  timber: "Timber",
};

const inputStyle: CSSProperties = {
  background: "#0f172a", border: "1px solid #334155", borderRadius: 6,
  padding: "10px 12px", color: "#f1f5f9", fontSize: 14, width: "100%", boxSizing: "border-box",
};
const labelStyle: CSSProperties = { color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 };

export function RegisterForm() {
  const [vertical, setVertical] = useState<VerticalId>("restaurant");
  const accent = VERTICAL_ACCENTS[vertical];
  return (
    <form action={registerAction} style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {VERTICAL_IDS.map((v) => {
          const active = v === vertical;
          return (
            <button
              type="button"
              key={v}
              onClick={() => setVertical(v)}
              style={{
                padding: "10px 12px", borderRadius: 8,
                border: `1px solid ${active ? accent : "#334155"}`,
                background: active ? `${accent}1A` : "transparent",
                color: active ? accent : "#94a3b8", fontWeight: 600, cursor: "pointer", fontSize: 13,
              }}
            >
              {CARD_LABEL[v]}
            </button>
          );
        })}
      </div>
      <input type="hidden" name="vertical" value={vertical} />

      <label style={{ display: "grid" }}>
        <span style={labelStyle}>{NAME_LABEL[vertical]}</span>
        <input name="restaurantName" placeholder="Roma Ristorante" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Subdomain</span>
        <input name="slug" placeholder="roma" required style={inputStyle} />
        <span style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
          Your storefront will be at roma.serveos.com
        </span>
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Country</span>
        <select
          name="country"
          defaultValue="EG"
          style={{ ...inputStyle, appearance: "auto" as CSSProperties["appearance"] }}
        >
          <option value="EG">Egypt</option>
          <option value="SA">Saudi Arabia</option>
        </select>
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Your name</span>
        <input name="ownerName" placeholder="Ahmed Hassan" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Email</span>
        <input name="email" type="email" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Password</span>
        <input name="password" type="password" placeholder="Min. 8 characters" required style={inputStyle} />
      </label>
      <button
        type="submit"
        style={{
          marginTop: 8, background: accent, color: "#14120F", fontSize: 14, fontWeight: 600,
          padding: 11, borderRadius: 6, border: "none", cursor: "pointer", width: "100%",
        }}
      >
        Start free trial
      </button>
    </form>
  );
}
