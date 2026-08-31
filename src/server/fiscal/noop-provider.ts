import type {
  FiscalProvider,
  FiscalSaleInput,
  FiscalRefundInput,
  FiscalDocument,
  FinalizedFiscalDocument,
  FiscalSubmitResult,
  EtaConfig,
} from "./provider";

/**
 * The fiscal provider for every non-EG tenant. ETA e-receipts/e-invoices are
 * an Egypt-specific obligation — `resolveFiscalProvider` only ever routes an
 * EG tenant to `EtaFiscalProvider`, so `buildReceipt`/`buildReturnReceipt`
 * here should never actually be called. They throw rather than silently
 * fabricate a fiscal document nobody asked for, so a caller that mistakenly
 * reaches this provider fails loudly instead of shipping a bogus document.
 *
 * `submit`/`poll` are different: they're safe to call unconditionally (e.g.
 * a worker that doesn't branch on provider identity first) and just report
 * "skipped", writing nothing.
 */
export class NoopFiscalProvider implements FiscalProvider {
  readonly name = "noop";

  buildReceipt(_input: FiscalSaleInput): FiscalDocument {
    throw new Error("NoopFiscalProvider.buildReceipt: non-EG tenants never build fiscal documents");
  }

  buildReturnReceipt(_input: FiscalRefundInput): FiscalDocument {
    throw new Error("NoopFiscalProvider.buildReturnReceipt: non-EG tenants never build fiscal documents");
  }

  async submit(_finalized: FinalizedFiscalDocument, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    return { status: "skipped", responseJson: {} };
  }

  async poll(_submissionUuid: string, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    return { status: "skipped", responseJson: {} };
  }
}
