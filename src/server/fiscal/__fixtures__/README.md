# ETA canonical-serialization golden vector

Both files are **verbatim public artifacts** published by the Egyptian Tax Authority as the worked example for
their document serialization algorithm. Do not edit them — they are the ground truth `serialize.test.ts`
asserts against, and any local change would silently weaken the check.

| File | Source |
|---|---|
| `one-doc.json` | https://sdk.invoicing.eta.gov.eg/files/one-doc.json |
| `one-doc-serialized.json.txt` | https://sdk.invoicing.eta.gov.eg/files/one-doc-serialized.json.txt |

Linked from [Receipt Batch Signature Creation](https://sdk.invoicing.eta.gov.eg/receipt-batch-signature-creation/),
which describes the pipeline they demonstrate: build the document JSON → produce its canonical version
(the algorithm in [Document Serialization Approach](https://sdk.invoicing.eta.gov.eg/document-serialization-approach/))
→ SHA-256 the UTF-8 bytes → sign.

The example is an e-invoice rather than an e-receipt, which does not matter here: the serialization algorithm
is document-type agnostic, and this is the only input/output pair ETA publishes. It exercises every rule the
receipt mapping depends on — recursion, culture-invariant uppercasing, arrays (name emitted once as a prefix
and again before each element), empty-string values, and decimal literals reproduced verbatim (`10.50` stays
`10.50`, never `10.5`).

`serialize.test.ts` reads `one-doc.json` while preserving each number's exact source text — a plain
`JSON.parse` would turn `10.50` into `10.5` and break the very property under test.
