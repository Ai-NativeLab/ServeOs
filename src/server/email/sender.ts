/**
 * The sender for every outbound email.
 *
 * The fallback must be a domain the provider can verify. It was previously
 * `no-reply@mail.serveos.com`, which is not ours — the mail domain is
 * serveos.tech, and serveos.com is only a redirect. An unverifiable fallback
 * means a missing EMAIL_FROM turns every send into a provider rejection rather
 * than anything that looks like a configuration error.
 *
 * Lives beside the providers rather than inside the outbox worker: the
 * marketing enquiry path needs it too, and importing it from there dragged the
 * whole outbox module — db, schemas, notify() — into a public marketing form.
 */
export function defaultSender(): string {
  return process.env.EMAIL_FROM ?? "no-reply@serveos.tech";
}
