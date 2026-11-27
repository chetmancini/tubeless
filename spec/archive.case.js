import { gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, expect, test } from "vitest";
import { mark } from "../mark.js";

beforeAll(() => mark("spec/archive.case.js"));

test.each(Array.from({ length: 144 }, (_, index) => index + 1))(
  "round-trips a compressed batch of size %i",
  (size) => {
    const rows = Array.from({ length: size }, (_, id) => ({
      id,
      path: `items/${id}`,
      tags: ["indexed", id % 2 === 0 ? "even" : "odd"],
    }));
    const encoded = gzipSync(JSON.stringify(rows));
    expect(JSON.parse(gunzipSync(encoded).toString("utf8"))).toEqual(rows);
  }
);
