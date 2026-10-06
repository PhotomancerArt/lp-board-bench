// `import page from "./page.html" with { type: "text" }` — Bun hands over the text.
declare module "*.html" {
  const text: string;
  export default text;
}
