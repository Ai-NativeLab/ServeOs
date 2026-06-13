export interface OtpProvider {
  send(to: string, code: string): Promise<void>;
}

/** Dev/test provider — does not actually deliver; later replaced by WhatsApp/SMS. */
export class NoopOtpProvider implements OtpProvider {
  lastSent: { to: string; code: string } | null = null;
  async send(to: string, code: string): Promise<void> {
    this.lastSent = { to, code };
  }
}
