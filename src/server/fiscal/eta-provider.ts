import type {
  FiscalProvider,
  FiscalSaleInput,
  FiscalRefundInput,
  FiscalDocument,
  FiscalSubmitResult,
  EtaConfig,
} from "./provider";
import { buildReceipt, buildReturnReceipt } from "./build-document";

/**
 * The ETA provider. `build*` delegate to the pure mappers in
 * `./build-document`; `./eta-wire` + `./serialize` turn the result into
 * receipt v1.2 JSON with its self-computed uuid and QR url.
 *
 * `submit`/`poll` are the signed OAuth2 HTTP calls and still throw — Task 3b
 * wires them, together with the config resolution that supplies the
 * `WireContext` those calls need.
 */
export class EtaFiscalProvider implements FiscalProvider {
  readonly name = "eta";

  buildReceipt(input: FiscalSaleInput): FiscalDocument {
    return buildReceipt(input);
  }

  buildReturnReceipt(input: FiscalRefundInput): FiscalDocument {
    return buildReturnReceipt(input);
  }

  async submit(_doc: FiscalDocument, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    throw new Error("not implemented");
  }

  async poll(_submissionUuid: string, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    throw new Error("not implemented");
  }
}
