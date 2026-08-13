import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { createInterface } from "node:readline/promises";
import { and, eq } from "drizzle-orm";

/**
 * Walk the real WhatsApp ordering flow in your terminal.
 *
 *   ENV_FILE=.env.test npx tsx scripts/whatsapp-sandbox.ts
 *   npx tsx scripts/whatsapp-sandbox.ts --slug roma
 *
 * This drives the SAME reducer, runner and database writes that a real Meta
 * webhook drives — the only substitution is the provider, which prints messages
 * instead of sending them. A confirmed pickup order lands in the orders table
 * for real, on the `whatsapp` channel, exactly as it would in production.
 *
 * Nothing here is a mock of the conversation: taps carry the real stateVersion,
 * the advisory lock is taken, and replays are rejected. If it works here, it
 * works on a phone.
 */

type Row = { id: string; title: string; description?: string };

function render(msg: Record<string, unknown>): Row[] {
  const kind = msg.kind as string;

  if (kind === "text") {
    console.log(`\n  ${msg.body as string}`);
    return [];
  }

  if (kind === "buttons") {
    console.log(`\n  ${msg.body as string}`);
    const buttons = msg.buttons as Row[];
    buttons.forEach((b, i) => console.log(`    [${i + 1}] ${b.title}`));
    return buttons;
  }

  if (kind === "list") {
    console.log(`\n  ${msg.body as string}`);
    const rows = msg.rows as Row[];
    rows.forEach((r, i) =>
      console.log(`    [${i + 1}] ${r.title}${r.description ? `  — ${r.description}` : ""}`),
    );
    return rows;
  }

  console.log(`\n  (unrendered ${kind})`);
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  // Defaults to a real seeded tenant so the walk runs against a real catalog.
  // `--fresh` seeds a throwaway one instead (single-use: its slug counter
  // resets per process, so a second run in the same database collides).
  const slug = args.includes("--fresh")
    ? null
    : args.includes("--slug")
      ? args[args.indexOf("--slug") + 1]
      : "roma";

  const { db } = await import("../src/db/client");
  const { withTenant } = await import("../src/db/with-tenant");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { whatsappAccounts, whatsappConversations } = await import("../src/server/whatsapp/schema");
  const { FakeWhatsAppProvider } = await import("../src/server/whatsapp/fake-provider");
  const { handleInbound } = await import("../src/server/whatsapp/runner");
  const { seedWhatsappContext } = await import("../src/server/whatsapp/test-helpers");

  let account;
  let tenantId: string;

  if (slug) {
    const [t] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (!t) {
      console.error(`No tenant '${slug}'. Run 'npm run db:seed' first, or omit --slug for a throwaway one.`);
      process.exit(1);
    }
    tenantId = t.id;
    const [existing] = await db.select().from(whatsappAccounts)
      .where(eq(whatsappAccounts.tenantId, t.id)).limit(1);
    if (existing) {
      account = existing;
    } else {
      // A local stand-in so an unlinked tenant can still be walked. It is never
      // used to reach Meta — the fake provider prints instead of sending.
      [account] = await db.insert(whatsappAccounts).values({
        tenantId: t.id, wabaId: "sandbox", phoneNumberId: `sandbox-${t.id.slice(0, 8)}`,
        displayPhoneNumber: "+20100000000", tokenRef: "env://SANDBOX", status: "active",
      }).returning();
      console.log(`Linked a sandbox WhatsApp account to '${slug}'.`);
    }
    console.log(`\nTenant: ${t.name} (${slug})`);
  } else {
    const ctx = await seedWhatsappContext();
    account = ctx.account;
    tenantId = ctx.tenantId;
    console.log("\nSeeded a throwaway tenant with one branch and one published product.");
  }

  const WA = "201111111111";
  const provider = new FakeWhatsAppProvider();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Fresh conversation each run, so the walk always starts from idle.
  await withTenant(tenantId, (tx) =>
    tx.delete(whatsappConversations).where(
      and(eq(whatsappConversations.tenantId, tenantId), eq(whatsappConversations.waId, WA)),
    ),
  );

  const { inboundText, inboundTap } = await import("../src/server/whatsapp/test-helpers");

  // Scripted mode: --say "menu,hello,pizza" replays a fixed sequence and exits.
  // Piping into the interactive prompt does not work — a pipe that has already
  // ended closes readline before the first question resolves.
  const sayIdx = args.indexOf("--say");
  const scripted = sayIdx >= 0 ? args[sayIdx + 1].split(",").map((s) => s.trim()) : null;

  console.log("\n─────────────────────────────────────────────");
  console.log(" WhatsApp sandbox — you are the customer.");
  console.log(" Type a number to tap, or free text to send a message.");
  console.log(" Ctrl-C to leave.");
  console.log("─────────────────────────────────────────────");

  let sentCount = 0;
  let rows: Row[] = [];

  async function drain() {
    for (const { msg } of provider.sent.slice(sentCount)) {
      rows = render(msg as unknown as Record<string, unknown>);
    }
    sentCount = provider.sent.length;
  }

  await handleInbound(account, inboundText("menu"), provider);
  await drain();

  if (scripted) {
    for (const line of scripted) {
      console.log(`\n  you> ${line}`);
      const n = Number(line);
      if (Number.isInteger(n) && n >= 1 && n <= rows.length) {
        const [action, , payload] = rows[n - 1].id.split(":");
        await handleInbound(account, await inboundTap(tenantId, WA, action, payload), provider);
      } else {
        await handleInbound(account, inboundText(line), provider);
      }
      await drain();
    }
    rl.close();
    process.exit(0);
  }

  for (;;) {
    let answer: string;
    try {
      answer = (await rl.question("\n  you> ")).trim();
    } catch {
      // stdin closed — happens when the walk is piped in for a scripted run.
      break;
    }
    if (!answer) continue;

    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) {
      // Row ids encode action:version:payload — the runner re-checks the version,
      // so a stale tap is rejected here exactly as it would be from a phone.
      const [action, , payload] = rows[n - 1].id.split(":");
      await handleInbound(account, await inboundTap(tenantId, WA, action, payload), provider);
    } else {
      await handleInbound(account, inboundText(answer), provider);
    }
    await drain();

    const [conv] = await withTenant(tenantId, (tx) =>
      tx.select().from(whatsappConversations).where(
        and(eq(whatsappConversations.tenantId, tenantId), eq(whatsappConversations.waId, WA)),
      ).limit(1),
    );
    if (conv?.state === "placed") {
      console.log("\n  ✓ Order placed — it is in the orders table on the whatsapp channel.");
      console.log("    Open /dashboard/orders to see it.\n");
      break;
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
