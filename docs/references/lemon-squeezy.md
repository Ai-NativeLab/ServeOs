# Lemon Squeezy — Team Reference

**Prepared:** 2026-07-14 · **Purpose:** evaluate Lemon Squeezy (LS) for ServeOS payments.
**Sourcing note:** LS's official docs blocked automated fetching, so figures below come from
LS blog posts, docs excerpts, and third-party reviews via search. **Reconfirm any number
against the official docs before committing** — especially Egypt/MENA eligibility and the
post-Stripe signup status, which are the two facts most likely to have moved.

---

## TL;DR for ServeOS

- **Lemon Squeezy is a Merchant of Record (MoR) for _digital products and SaaS only_.** It is
  explicitly **not for physical goods**, and it **prohibits drugs, alcohol, tobacco, and
  "services of any kind."**
- **For ServeOS _order payments_ (customer → merchant): categorically NOT applicable.** Every
  ServeOS vertical sells physical/fulfilled goods — restaurant food, retail merchandise,
  **pharmacy medicines (explicitly prohibited)**, timber. LS also collects centrally (MoR) and
  can't settle direct-to-each-merchant, which contradicts our chosen money-flow model. This is a
  hard "no," not a preference.
- **For ServeOS's _own SaaS subscription billing_ (merchant → ServeOS): plausible fit**, since
  that *is* a SaaS product. But weigh it against (a) the Stripe-acquisition continuity risk
  below, and (b) unconfirmed Egyptian seller/payout eligibility.
- **Platform risk:** Stripe acquired LS and, in Feb 2026, launched **Stripe Managed Payments**, a
  competing MoR built into Stripe. LS says it keeps operating "with no changes," but the parent
  is clearly steering new MoR business to the successor. Treat LS as a product whose long-term
  investment is uncertain.

---

## 1. What Lemon Squeezy is

A **Merchant of Record** platform: LS becomes the legal seller of your product, so it collects
payment, then **handles global sales tax / VAT / GST remittance for you**, and pays you out. It
targets software companies selling **digital downloads and SaaS subscriptions**, with extras like
**license-key generation**, a hosted storefront/checkout, affiliate tools, and email.
([What is MoR](https://www.lemonsqueezy.com/blog/merchant-of-record) ·
[home](https://www.lemonsqueezy.com/))

MoR is the key concept: money flows **customer → Lemon Squeezy → you** (one consolidated payout),
*not* customer → your bank directly. That's what makes the tax handling possible, and also what
makes it unsuitable for paying third-party merchants.

## 2. The 2026 Stripe situation (continuity risk)

- **Stripe acquired Lemon Squeezy**
  ([announcement](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy)).
- **Feb 2026: Stripe launched "Stripe Managed Payments"** — Stripe's own MoR, with Stripe as legal
  seller handling VAT/GST/sales tax + fraud + order management, priced the **same 5% + $0.50**.
  Some LS-specific features (affiliate tools, digital-download delivery, storefront builder) are
  **not** part of Stripe Managed Payments.
  ([2026 update](https://www.lemonsqueezy.com/blog/2026-update))
- **LS itself keeps operating** "with no changes or action needed" per LS — but strategically,
  new merchant-of-record demand is being routed to the Stripe-native product.
- **Implication for us:** building on LS now means building on a product whose parent has shipped
  a successor. If we ever want MoR for ServeOS subscriptions, **evaluate Stripe Managed Payments
  head-to-head with LS** rather than defaulting to LS.

## 3. What you can and cannot sell (hard limits)

**Allowed:** digital goods fulfillable through LS's website (software, SaaS, e-books, templates,
digital art, courses). ([prohibited-products doc](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products))

**Prohibited (non-exhaustive):**
- **Physical goods** — LS is "strictly for digital assets, not suitable for businesses selling
  physical goods."
- **Drugs & paraphernalia, alcohol, tobacco, vaping** — illegal/age-restricted categories.
- **Services of any kind** (marketing, design, dev, consulting, etc.).
- **Donations/charity** where no product exists or price exceeds product value.
- **Products you don't hold IP/license rights to**, incl. **PLR / Master Resell Rights** products.

**Enforcement:** violations can put your store **"in review" or suspended without notice** — funds
and selling capability can be frozen during review.

> **ServeOS impact:** four of our verticals sell physical goods; pharmacy sells medicines
> (double-prohibited). None of ServeOS's *order* commerce can run through LS.

## 4. Fees & economics

- **Platform fee: 5% + $0.50 per transaction** (the MoR premium; ~2% above raw Stripe, buying tax
  compliance). ([fees](https://getstacksmart.com/blog/lemon-squeezy-merchant-of-record-fees-2026))
- **Refunds:** the refunded amount **minus the platform fee** is deducted from your next payout
  (i.e., LS's fee on a refunded sale is generally not returned to you).
- **Chargebacks/disputes:** LS typically refunds on your behalf and deducts the refunded amount
  (minus platform fee) **plus a ~$15 dispute fee** from your next payout.
  ([refunds & chargebacks](https://docs.lemonsqueezy.com/help/payments/refunds-chargebacks))
- **Currency conversion:** buyers charged in their currency, converted to USD at mid-market rate
  with no *extra* conversion fee for processing; but **a small processing/conversion fee may be
  deducted from payouts** depending on payout method/region/settlement currency.
  ([currencies](https://docs.lemonsqueezy.com/help/payments/currencies))

## 5. Getting paid (payouts)

- **Payout rails:** **79 countries via bank transfer**, **200+ via PayPal** (≈279 total "get paid"
  countries). ([bank payouts expansion](https://www.lemonsqueezy.com/blog/new-bank-payouts) ·
  [getting paid](https://docs.lemonsqueezy.com/help/getting-started/getting-paid))
- **Eligibility rule:** you can sell only if you can receive payout into a **bank or PayPal account
  in a supported country**. If your country isn't on the bank list or PayPal's list, you can't use
  LS as a merchant.
- **Minimum payout:** **$50** — below that, the payout rolls to the next cycle.
- **Schedule:** periodic (LS's standard payout cycle; affiliate commissions specifically are held
  30 days then paid on the 14th/28th — merchant payout cadence is similar/periodic).
- **⚠️ MENA/Egypt:** **not confirmed.** Egypt is unlikely to be in the 79 bank-payout countries,
  and **PayPal in Egypt generally cannot receive/withdraw funds** — so Egyptian seller onboarding
  is doubtful. Saudi Arabia/UAE need direct confirmation. **This alone may disqualify LS for a
  MENA-based ServeOS entity even for subscriptions.** Verify on the official supported-countries
  page before any decision.

## 6. Buyer-side payment methods

- **20+ payment methods**, buyers in **135+ countries** out of the box (cards, and various local/
  wallet methods depending on region). Hosted checkout; no PCI burden on you.
  ([home](https://www.lemonsqueezy.com/))
- **No cash-on-delivery, no direct mobile-wallet-to-merchant (e.g. Vodafone Cash) settlement** —
  it's a card-first global digital checkout, not a MENA fulfillment-payments tool.

## 7. Developer / integration surface

- **REST API + official SDKs**, **webhooks** for order/subscription/license events, **custom data
  pass-through** at checkout (e.g. link a subscription to your internal user id).
  ([webhooks](https://docs.lemonsqueezy.com/help/webhooks) ·
  [custom data](https://docs.lemonsqueezy.com/help/checkout/passing-custom-data))
- **Subscriptions:** full lifecycle (create/upgrade/downgrade/cancel/expire) via API + webhooks.
- **License keys:** issue/validate/limit-activations/expire via API — relevant to software, not to
  ServeOS.
- **Checkout:** hosted (LS-branded/customizable) or overlay; **not** a drop-in gateway you embed
  into your own multi-tenant checkout the way a direct gateway (Paymob/Stripe) is.

## 8. Applicability to ServeOS — the two surfaces

| Surface | Fits LS? | Why |
|---|---|---|
| **Order payments** (customer → merchant, all 4 verticals) | ❌ **No** | Physical goods excluded; pharmacy = prohibited drugs; MoR collects centrally (can't do direct-to-merchant); no COD/wallet; not an embeddable multi-tenant gateway. Use a **direct MENA gateway (Paymob)** — see the P1 payments spec. |
| **ServeOS SaaS subscription billing** (merchant → ServeOS) | ⚠️ **Maybe** | It *is* SaaS, and LS slots into our existing `BillingProvider` interface. But: (1) Egyptian seller/payout eligibility unconfirmed and likely problematic; (2) Stripe-acquisition continuity risk; (3) 5%+$0.50 + $15 dispute fee vs a local gateway. Evaluate vs **Stripe Managed Payments** and a local EG/KSA option before adopting. |

## 9. Limitations & risks — quick list

1. **Digital/SaaS only** — no physical goods, no services, no regulated goods (drugs/alcohol/tobacco).
2. **MoR = central collection** — can't pay third-party merchants; not a marketplace/connect tool.
3. **MENA payout eligibility doubtful** (Egypt especially) — possibly a blocker even for subscriptions.
4. **Parent pushing a successor** (Stripe Managed Payments) — long-term product investment uncertain.
5. **Fees:** 5% + $0.50; platform fee generally not refunded on refunds; ~$15/dispute; possible
   payout FX deductions; $50 payout minimum.
6. **Store review/suspension without notice** on policy violation — funds can be held.
7. **Hosted checkout**, not an embeddable gateway for our own multi-tenant storefronts.

## 10. Open questions to confirm directly with Lemon Squeezy / official docs

- Is **Egypt** (and KSA/UAE) a supported **seller/payout** country today?
- Are **new LS merchant signups** still open, or is Stripe steering them to Stripe Managed Payments?
- Exact **merchant payout schedule** and any **rolling reserve/hold** for new accounts.
- Whether a **MENA-based legal entity** can be the LS account holder, or if a foreign entity is needed.
- For subscriptions specifically: supported **settlement currencies** for our payout (EGP/SAR/USD).

## 11. Recommendation

- **Order payments (P1): do not use Lemon Squeezy.** Proceed with **Paymob** (direct-to-merchant,
  card + wallet, EG-first) behind our `PaymentProvider` abstraction — as designed.
- **Subscription billing: keep Lemon Squeezy on the "future candidate" list**, but before adopting,
  (1) confirm Egyptian seller eligibility, and (2) run a three-way comparison — **Lemon Squeezy vs
  Stripe Managed Payments vs a local gateway** — since the Stripe-native MoR is the more strategic
  bet now and a local gateway may be simpler for EGP/SAR billing.

## Sources

- [Merchant of Record — what it is](https://www.lemonsqueezy.com/blog/merchant-of-record)
- [2026 update: LS + Stripe Managed Payments](https://www.lemonsqueezy.com/blog/2026-update)
- [Stripe acquires Lemon Squeezy](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy)
- [Prohibited products](https://docs.lemonsqueezy.com/help/getting-started/prohibited-products)
- [Refunds & chargebacks](https://docs.lemonsqueezy.com/help/payments/refunds-chargebacks)
- [Getting paid](https://docs.lemonsqueezy.com/help/getting-started/getting-paid) ·
  [Bank payouts expansion](https://www.lemonsqueezy.com/blog/new-bank-payouts) ·
  [Supported countries](https://docs.lemonsqueezy.com/help/getting-started/supported-countries)
- [Fees (5% + $0.50)](https://getstacksmart.com/blog/lemon-squeezy-merchant-of-record-fees-2026) ·
  [Currencies](https://docs.lemonsqueezy.com/help/payments/currencies)
- [Webhooks](https://docs.lemonsqueezy.com/help/webhooks) ·
  [Passing custom data](https://docs.lemonsqueezy.com/help/checkout/passing-custom-data) ·
  [Licensing](https://docs.lemonsqueezy.com/help/licensing)
- Third-party reviews: [Tiny Tool](https://tiny-tool.com/lemon-squeezy-review/) ·
  [Dodo Payments](https://dodopayments.com/blogs/lemonsqueezy-review) ·
  [Swell pricing](https://www.swell.is/content/lemon-squeezy-pricing)
