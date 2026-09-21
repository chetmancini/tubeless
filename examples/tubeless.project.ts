import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "./validated-boundaries.js";

// A project is enough for CLI and Studio discovery. Because this pipeline owns
// a Standard JSON Schema input, its --source flag and form field are inferred.
// It has no checkpoint-aware adapter, so CLI help and Studio omit --resume.
export default defineProject("tubeless-examples", [ValidatedPipeline], {
  name: "Tubeless examples",
  description: "Import rows with schema-derived CLI flags and Studio forms.",
});
