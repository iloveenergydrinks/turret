export default function NotFound() {
  return (
    <main style={{ maxWidth: 640, margin: "15vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 36, fontWeight: 650, marginBottom: 16 }}>Page not found</h1>
      <p style={{ marginBottom: 24 }}>This address does not point to a Turret page.</p>
      <a href="/" style={{ textDecoration: "underline" }}>Return home</a>
    </main>
  );
}
