"use client";
import { AdminError } from "@/components/admin/AdminError";

export default function RouteError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <AdminError reset={reset} />;
}
