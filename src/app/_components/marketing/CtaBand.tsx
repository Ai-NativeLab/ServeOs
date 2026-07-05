import Link from "next/link";
import { Button } from "@/components/ui/button";

export function MarketingCtaBand() {
  return (
    <section className="bg-primary/5 px-6 py-20 text-center">
      <h2 className="font-display text-3xl font-bold text-ink sm:text-4xl">
        Get your menu online today.
      </h2>
      <Button asChild size="lg" className="mt-8">
        <Link href="/register">Get Started</Link>
      </Button>
    </section>
  );
}
