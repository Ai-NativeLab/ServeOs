"use client";
import { useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function ConfirmActionButton({
  action, label, title, description, confirmLabel, variant = "destructive", successMessage, size,
}: {
  action: () => Promise<void>;
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  successMessage?: string;
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={pending}>{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              startTransition(async () => {
                try {
                  await action();
                  if (successMessage) toast.success(successMessage);
                } catch (err) {
                  unstable_rethrow(err);
                  toast.error("Something went wrong. Please try again.");
                }
              })
            }
          >
            {confirmLabel ?? label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
