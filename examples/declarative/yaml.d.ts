// Bun loads YAML modules; keep parsed content unknown until the compiler checks it.
declare module "*.yaml" {
  const document: unknown;
  export default document;
}
