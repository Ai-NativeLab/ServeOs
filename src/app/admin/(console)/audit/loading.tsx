import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <>
      <div className="mb-6 space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-16" />
      </div>
      <Card>
        <CardContent className="pt-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
