import { createServer } from "node:http";
import { serve } from "inngest/node";
import { inngest } from "./client.js";
import { normalizeFunction } from "./functions.js";

const handler = serve({ client: inngest, functions: [normalizeFunction] });
const server = createServer((request, response) => {
  if (request.url?.split("?")[0] === "/api/inngest") {
    return handler(request, response);
  }
  response.writeHead(404).end();
});
server.listen(3000, "127.0.0.1", () => {
  console.log("Inngest endpoint: http://127.0.0.1:3000/api/inngest");
});
