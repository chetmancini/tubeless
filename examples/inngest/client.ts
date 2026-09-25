import { Inngest } from "inngest";

// INNGEST_DEV=1 selects the local Dev Server. Production keys belong in the environment.
export const inngest = new Inngest({ id: "tubeless-example" });
