"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { toastMessageFor } from "@/lib/errors-client";

export function ToastForm({
  action, successMessage, className, children, onSuccess,
}: {
  action: (formData: FormData) => Promise<void>;
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
          await action(formData);
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
