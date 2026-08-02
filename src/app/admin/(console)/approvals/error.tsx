"use client";
import { AdminError } from "@/components/admin/AdminError";

export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <AdminError error={error} retry={unstable_retry} />;
}
