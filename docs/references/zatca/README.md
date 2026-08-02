# ZATCA e-invoicing — primary source documents

Official ZATCA specifications underpinning **[PRD-003 — ZATCA E-Invoicing Compliance](../../prds/prd-high-zatca-einvoicing.md)**, captured **2026-07-28**.

These are kept in-repo deliberately. ZATCA supersedes its documents (the Detailed Technical Guidelines is already at Version 2) and re-publishes at the same URLs, so "the version we designed against" is not otherwise recoverable. Every claim marked ⭐ in PRD-003 traces to one of these files.

## Contents

| File | Source document | Used for |
|---|---|---|
| `tech-guidelines.txt` | E-invoicing **Detailed Technical Guidelines**, Version 2 (Nov 2022) | Onboarding (§3), **deployment scenarios (§3.5)**, reporting & clearance (§4), signing (§5), QR/TLV (§6), business FAQ (§7) |
| `xml-standard.txt` · `xml-standard.pdf` | **XML Implementation Standard** v1.2 (19 May 2023), 72pp | Invoice type codes & subtypes (§11.2.1), VAT category codes (§11.2.4), calculation (§9), rounding (§10) |
| `data-dictionary.tsv` · `data-dictionary.xlsx` | **Electronic Invoice Data Dictionary** (19 May 2023) | 150 business terms with per-document-type Mandatory/Conditional/Optional status and exact UBL paths |

The `.txt` and `.tsv` files are extracted derivatives — diffable, greppable, and what the analysis actually used. The `.pdf`/`.xlsx` are the originals as downloaded.

## The two things these documents corrected

Both were wrong in every third-party integration guide consulted, and both would have caused a failed build:

1. **`383` is a debit note, not a simplified invoice.** Standard and simplified are *both* type code `388`; the distinction is the subtype in `InvoiceTypeCode/@name` (`01` standard, `02` simplified). — *XML Implementation Standard §11.2.1*
2. **The CSID does not have to sit on each till.** For a centralised cloud server it is one per taxpayer plus one per document sequence, and dumb terminals need none provided the server stamps and applies the QR before the receipt reaches the customer. — *Detailed Technical Guidelines §3.5.1, §3.5.4*

## Reproducing the extracts

Requires `poppler` (`brew install poppler`).

```bash
# Detailed Technical Guidelines
curl -sL -o tech-guidelines.pdf \
  "https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf"
pdftotext -layout tech-guidelines.pdf tech-guidelines.txt

# XML Implementation Standard
curl -sL -o xml-standard.pdf \
  "https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf"
pdftotext -layout xml-standard.pdf xml-standard.txt

# Data Dictionary — sheet 2 ("Data dictionary") to TSV
curl -sL -o data-dictionary.xlsx \
  "https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_EInvoice_Data_Dictionary%20vF.xlsx"
python3 - <<'PY' > data-dictionary.tsv
import zipfile, xml.etree.ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z=zipfile.ZipFile("data-dictionary.xlsx")
ss=["".join(t.text or "" for t in si.iter(NS+'t'))
    for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS+'si')]
for row in ET.fromstring(z.read("xl/worksheets/sheet2.xml")).iter(NS+'row'):
    vals=[]
    for c in row.findall(NS+'c'):
        v=c.find(NS+'v')
        vals.append("" if v is None else (ss[int(v.text)] if c.get('t')=='s' else (v.text or "")))
    print("\t".join(x.replace("\n"," ").strip() for x in vals))
PY
```

Useful column indices in `data-dictionary.tsv`: `1` business term · `8` UBL tag · `15` standard tax invoice status · `18` **simplified invoice status** · `M`/`C`/`O`/`NA`.

```bash
# e.g. the 50 fields mandatory on a simplified invoice
awk -F'\t' 'NR>3 && $18=="M" {print $1"\t"$8}' data-dictionary.tsv
```

## Still not retrieved

PRD-003's remaining ○-marked claims — **prohibited functions, archiving/retention, and penalties** — live in the **E-Invoicing Regulation** and the **Controls, Requirements, Technical Specifications and Procedural Rules** (the Resolution). Neither is here. See PRD-003 Appendix D.

Also not retrieved: the **Security Features Implementation Standards** (19 May 2023), which holds cryptographic detail beyond what the Technical Guidelines cover.

## Not legal advice

Engineering research from public documents. PRD-003 requires review by a qualified Saudi tax adviser before any commercial commitment.
