import type {
  FiscalProvider,
  FiscalSaleInput,
  FiscalRefundInput,
  FiscalDocument,
  FiscalSubmitResult,
  EtaConfig,
} from "./provider";

/**
 * MINIMAL STUB (Task 2). Exists only so `resolveFiscalProvider` (./index.ts)
 * has a real "eta" implementation to compile and type-check against; every
 * method throws until Task 3 replaces this with the real ETA document
 * builder plus the signed OAuth2 submit/poll HTTP calls.
 */
export class EtaFiscalProvider implements FiscalProvider {
  readonly name = "eta";

  buildReceipt(_input: FiscalSaleInput): FiscalDocument {
    throw new Error("not implemented");
  }

  buildReturnReceipt(_input: FiscalRefundInput): FiscalDocument {
    throw new Error("not implemented");
  }

  async submit(_doc: FiscalDocument, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    throw new Error("not implemented");
  }

  async poll(_submissionUuid: string, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    throw new Error("not implemented");
  }
}
