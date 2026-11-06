import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeHtml } from "./html.mjs";

it("matches title text and metadata despite their different HTML escaping", () => {
  const text = "An agent&#39;s &lt;workflow&gt; &amp; results &quot;today&quot;";
  const attribute = "An agent's <workflow> &amp; results &quot;today&quot;";
  assert.equal(decodeHtml(text), 'An agent\'s <workflow> & results "today"');
  assert.equal(decodeHtml(attribute), decodeHtml(text));
});

it("decodes common named entities and decimal or hexadecimal character references", () => {
  assert.equal(decodeHtml("&apos;&nbsp;&AMP;&LT;&GT;&QUOT;"), "'\u00a0&<>\"");
  assert.equal(decodeHtml("&#39;&#x27;&#X1F680;&#128640;"), "''🚀🚀");
});

it("decodes each reference once, preserving literal entity text and unknown names", () => {
  assert.equal(decodeHtml("&amp;lt; &amp;#39; &unknown; &Amp;"), "&lt; &#39; &unknown; &Amp;");
});

it("replaces character references that cannot represent Unicode text", () => {
  assert.equal(decodeHtml("&#0;&#xD800;&#x110000;"), "���");
});
