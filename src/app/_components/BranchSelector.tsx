"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Branch = { id: string; name: string };
const ALL = "__all__";

function BranchSelectorInner({
  branches,
  currentBranchId,
}: {
  branches: Branch[];
  currentBranchId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value !== ALL) {
      params.set("branch", value);
    } else {
      params.delete("branch");
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <Select value={currentBranchId ?? ALL} onValueChange={handleChange}>
      <SelectTrigger className="w-full sm:w-64">
        <SelectValue placeholder="Choose a branch" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All branches</SelectItem>
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BranchSelector(props: { branches: Branch[]; currentBranchId?: string }) {
  return (
    <Suspense fallback={<div className="h-9 w-full max-w-64 animate-pulse rounded-md bg-muted sm:w-64" />}>
      <BranchSelectorInner {...props} />
    </Suspense>
  );
}
