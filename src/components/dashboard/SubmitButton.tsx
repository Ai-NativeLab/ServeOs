"use client";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** For forms submitted through a transition rather than <form action> (where
 *  useFormStatus never reports pending), the form provides its own flag. */
const FormPendingContext = createContext(false);

export function FormPendingProvider({ pending, children }: { pending: boolean; children: ReactNode }) {
  return <FormPendingContext.Provider value={pending}>{children}</FormPendingContext.Provider>;
}

export function SubmitButton({ children, ...props }: ComponentProps<typeof Button>) {
  const status = useFormStatus();
  const providedPending = useContext(FormPendingContext);
  const pending = status.pending || providedPending;
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}
