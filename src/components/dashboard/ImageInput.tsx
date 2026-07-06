"use client";
import { useRef, useState } from "react";
import { Upload, X, ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type UploadType = "product" | "category" | "banner" | "logo" | "cover";

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
    setUploading(true);
    try {
      const form = new FormData();
      form.set("type", type);
      form.set("file", file);
      const res = await fetch("/api/media-upload", { method: "POST", body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed");
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

      <div className="flex items-start gap-3">
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
          <div className="flex gap-2">
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
