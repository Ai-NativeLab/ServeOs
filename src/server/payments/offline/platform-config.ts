/** ServeOS's own pay-to details for subscription collection (Surface B). Env-backed. */
export function platformPayTo(): { label: string; detail: string }[] {
  const raw = process.env.SERVEOS_PAYTO ?? ""; // "InstaPay:serveos@instapay,Vodafone Cash:0100..."
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [label, detail] = pair.split(":");
      return { label: (label ?? "").trim(), detail: (detail ?? "").trim() };
    });
}
