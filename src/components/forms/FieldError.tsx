/**
 * The message for one field, from a server action's `fieldErrors`.
 *
 * Not a client component: it renders no interactivity, so it works inside
 * either graph and costs nothing in a server-rendered form.
 */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span role="alert" className="text-[11px] text-destructive">
      {message}
    </span>
  );
}

/** The whole-form message, for the failure that belongs to no single field. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      {message}
    </p>
  );
}
