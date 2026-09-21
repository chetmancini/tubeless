import { defineProject } from "tubeless/project";
import { ValidatedPipeline } from "./validated-boundaries.js";

// A project is enough for CLI and Studio discovery. Because this pipeline owns
// a Standard JSON Schema input, its --source flag and form field are inferred.
export default defineProject("tubeless-examples", [ValidatedPipeline]);
