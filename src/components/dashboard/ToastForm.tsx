"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { toastMessageFor } from "@/lib/errors-client";

export function ToastForm({
  action, successMessage, className, children, onSuccess,
}: {
  /**
   * A thrown DomainError does not survive the RSC boundary (the class is lost,
   * and production redacts the message entirely), so actions that want their
   * domain message shown must RETURN `{ error }` instead of throwing — see
   * domainErrorValue(). The catch below only backstops unexpected failures.
   */
  action: (formData: FormData) => Promise<void | { error: string }>;
  successMessage: string;
  className?: string;
  children: ReactNode;
  /** Runs only after the action resolves — lets a caller close its dialog on success but keep it open on failure, so the error is still readable. */
  onSuccess?: () => void;
}) {
  return (
    <form
      className={className}
      action={async (formData) => {
        try {
          const result = await action(formData);
          if (result?.error) {
            toast.error(result.error);
            return;
          }
          toast.success(successMessage);
          onSuccess?.();
        } catch (err) {
          toast.error(toastMessageFor(err));
        }
      }}
    >
      {children}
    </form>
  );
}
