export function App() {
  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="font-bold text-3xl">ServeOS POS</h1>
        <p className="text-sm text-muted-foreground mt-2">bridge: {window.pos?.ping?.() ?? "n/a"}</p>
      </div>
    </div>
  );
}
