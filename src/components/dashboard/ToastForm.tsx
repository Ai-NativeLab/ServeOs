"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { toastMessageFor } from "@/lib/errors-client";

export function ToastForm({
  action, successMessage, className, children,
}: {
  action: (formData: FormData) => Promise<void>;
  successMessage: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form
      className={className}
      action={async (formData) => {
        try {
          await action(formData);
          toast.success(successMessage);
        } catch (err) {
          toast.error(toastMessageFor(err));
        }
      }}
    >
      {children}
    </form>
  );
}
