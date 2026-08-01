"use client";

import { AdminError } from "@/components/admin/AdminError";

export default function AdminRootError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <AdminError reset={reset} />;
}
