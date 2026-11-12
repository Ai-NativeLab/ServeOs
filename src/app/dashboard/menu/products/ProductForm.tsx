"use client";
import { startTransition, useActionState, type ReactNode } from "react";
import { FormPendingProvider } from "@/components/dashboard/SubmitButton";
import type { ProductFormState } from "./actions";

/**
 * The product create/edit form. The action returns `{ error }` instead of
 * redirecting when the input is invalid, and the error is shown here.
 *
 * Submitted through onSubmit + a transition rather than <form action>: React
 * resets a form's uncontrolled fields after a form action completes, which
 * would wipe everything the merchant typed exactly when we ask them to fix
 * one field.
 */
export function ProductForm({
  action,
  className,
  children,
}: {
  action: (prev: ProductFormState, formData: FormData) => Promise<ProductFormState>;
  className?: string;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, undefined);
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => dispatch(formData));
      }}
    >
      {state?.error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {state.error}
        </p>
      )}
      <FormPendingProvider pending={pending}>{children}</FormPendingProvider>
    </form>
  );
}
