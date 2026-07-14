"use client";
import { useRef, useState } from "react";
import { Upload, X, ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type UploadType = "product" | "category" | "banner" | "logo" | "cover";

const MAX_BYTES = 5 * 1024 * 1024; // keep in sync with the /api/media-upload route
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function ImageInput({
  name,
  type,
  defaultValue,
  aspect = "square",
  required = false,
}: {
  name: string;
  type: UploadType;
  defaultValue?: string | null;
  aspect?: "square" | "wide";
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Unsupported image format (use JPG, PNG, WebP, or GIF)");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Image is too large (max 5 MB). Please compress or resize it first.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("type", type);
      form.set("file", file);
      const res = await fetch("/api/media-upload", { method: "POST", body: form });

      // The server returns JSON, but proxies/limits can return plain text (e.g. a 413),
      // so parse defensively rather than assuming JSON.
      const raw = await res.text();
      let data: { url?: string; error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { error: res.status === 413 ? "Image is too large to upload" : `Upload failed (${res.status})` };
      }

      if (!res.ok || !data.url) throw new Error(data.error ?? `Upload failed (${res.status})`);
      setValue(data.url);
      toast.success("Image uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const previewClass = aspect === "wide" ? "aspect-[3/1]" : "size-24";

  return (
    <div className="grid gap-2">
      {/* Submitted with the form */}
      <input type="hidden" name={name} value={value} />

      {/* flex-wrap (here and on the buttons row): the nowrap thumb+buttons row's
          min-content (~347px) otherwise blows out the parent form's grid track at
          360px viewports, dragging every input past the card edge. */}
      <div className="flex flex-wrap items-start gap-3">
        <div className={cn("shrink-0 overflow-hidden rounded-lg border border-input bg-secondary", previewClass)}>
          {value ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={value} alt="" className="size-full object-cover" />
          ) : (
            <span className="grid size-full place-items-center">
              <ImageIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />
            </span>
          )}
        </div>

        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {uploading ? "Uploading…" : "Upload image"}
            </Button>
            {value && !uploading && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue("")}>
                <X className="size-4" />Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">JPG, PNG, WebP or GIF · up to 5 MB</p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">Or paste an image URL</span>
        <Input
          type="url"
          inputMode="url"
          placeholder="https://…"
          required={required}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </div>
  );
}
