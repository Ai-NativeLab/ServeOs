import QRCode from "qrcode";
import { requireMenuPermission } from "../menu-permission";
import { getTenantById } from "@/server/tenancy";
import { getEnv } from "@/env";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { CopyLinkButton } from "@/components/dashboard/CopyLinkButton";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, Download } from "lucide-react";

export default async function PublishMenuPage() {
  const { tenantId } = await requireMenuPermission();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

  const rootDomain = getEnv().ROOT_DOMAIN;
  const protocol = rootDomain.includes("localhost") ? "http" : "https";
  const storefrontUrl = `${protocol}://${tenant.slug}.${rootDomain}`;

  const qrDataUrl = await QRCode.toDataURL(storefrontUrl, { width: 512, margin: 1 });

  return (
    <>
      <PageHeader
        title="Publish your menu"
        description="Share this link or QR code with customers to take them straight to your live menu."
      />

      <Card className="p-5 max-w-xl mb-6">
        <h2 className="eyebrow text-primary mb-3">Storefront link</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm break-all">{storefrontUrl}</span>
          <CopyLinkButton value={storefrontUrl} />
          <Button asChild variant="outline" size="sm">
            <a href={storefrontUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              Visit storefront
            </a>
          </Button>
        </div>
      </Card>

      <Card className="p-5 max-w-xl">
        <h2 className="eyebrow text-primary mb-3">QR code</h2>
        <img
          src={qrDataUrl}
          alt="QR code linking to your storefront"
          width={240}
          height={240}
        />
        <div className="mt-4">
          <Button asChild variant="outline" size="sm">
            <a href={qrDataUrl} download="serveos-menu-qr.png">
              <Download className="size-4" />
              Download QR code
            </a>
          </Button>
        </div>
      </Card>
    </>
  );
}
