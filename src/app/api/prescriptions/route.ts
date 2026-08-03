import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getCapabilities, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { currentCustomer } from "@/server/customers/require-customer";
import { uploadPrescriptionImage } from "@/server/prescriptions/storage";
import { submitPrescription } from "@/server/prescriptions/service";

/**
 * Customer-facing prescription upload.
 *
 * Deliberately NOT /api/media-upload: that route demands a staff dashboard
 * session (a customer has none) and returns a public object URL. A script is
 * medical data, so this one authenticates the CUSTOMER session, writes to a
 * private bucket, and returns only the prescription id — never a URL.
 */
export async function POST(req: NextRequest) {
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (h.get("x-surface") !== "storefront" || !slug) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only a vertical that actually reviews scripts accepts them.
  const caps = getCapabilities(selectStorefrontTemplate(tenant.vertical as VerticalId));
  if (!caps.prescriptionUpload) return NextResponse.json({ error: "Not available" }, { status: 404 });

  const customer = await currentCustomer(tenant.id);
  if (!customer) return NextResponse.json({ error: "Please sign in to upload a prescription" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const uploaded = await uploadPrescriptionImage(tenant.id, customer.id, file);
  if ("error" in uploaded) {
    return NextResponse.json({ error: uploaded.error }, { status: uploaded.status });
  }

  const rx = await submitPrescription(tenant.id, customer.id, uploaded.path);
  return NextResponse.json({ id: rx.id, status: rx.status });
}
