import { beforeAll, describe, expect, it } from "vitest";
import {
  createAccessAuthenticator,
  parseAccessConfig,
  type AccessConfig,
} from "./cloudflare-access.js";

const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const config = parseAccessConfig("https://team.cloudflareaccess.com/", AUD) as AccessConfig;
let keys: CryptoKeyPair;
let jwk: JsonWebKey;
const NOW = 1_800_000_000_000;

const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

async function token(claims: Record<string, unknown>, kid = "k1", key = keys.privateKey) {
  const head = encode({ alg: "RS256", kid, typ: "JWT" });
  const body = encode({ iss: config.issuer, aud: [AUD], exp: NOW / 1000 + 300, ...claims });
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`))
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${head}.${body}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

const request = (jwt?: string, path = "/api/snapshot") =>
  new Request(
    `https://studio.example${path}`,
    jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : {}
  );

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" } as JsonWebKey;
});

function authenticator(fetchCount = { value: 0 }) {
  return createAccessAuthenticator(config, {
    now: () => NOW,
    fetchJson: async (url) => {
      expect(url).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
      fetchCount.value += 1;
      return { keys: [jwk] };
    },
  });
}

describe("Access configuration", () => {
  it("normalizes the team domain and rejects partial or foreign config", () => {
    expect(config).toEqual({
      issuer: "https://team.cloudflareaccess.com",
      certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      audience: AUD,
    });
    expect(parseAccessConfig(undefined, undefined)).toBeUndefined();
    expect(parseAccessConfig("", "")).toBeUndefined();
    expect(() => parseAccessConfig("team.cloudflareaccess.com", undefined)).toThrow(/both/);
    expect(() => parseAccessConfig("evil.example.com", AUD)).toThrow(/cloudflareaccess\.com/);
  });
});

describe("Access authenticator", () => {
  it("accepts a valid token with an array or string audience", async () => {
    expect(await authenticator()(request(await token({})))).toBeUndefined();
    expect(await authenticator()(request(await token({ aud: AUD })))).toBeUndefined();
  });

  it("tolerates 60 seconds of skew and no more", async () => {
    expect(await authenticator()(request(await token({ exp: NOW / 1000 - 59 })))).toBeUndefined();
    expect((await authenticator()(request(await token({ exp: NOW / 1000 - 61 }))))?.status).toBe(
      401
    );
    expect((await authenticator()(request(await token({ nbf: NOW / 1000 + 61 }))))?.status).toBe(
      401
    );
  });

  it("returns 401 for missing, malformed and forged tokens", async () => {
    const auth = authenticator();
    expect(await (await auth(request()))!.json()).toMatchObject({ code: "access_required" });
    expect((await auth(request("a.b")))?.status).toBe(401);
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    expect((await auth(request(await token({}, "k1", other.privateKey))))?.status).toBe(401);
    expect(
      (await auth(request(`${encode({ alg: "none", kid: "k1" })}.${encode({})}.`)))?.status
    ).toBe(401);
  });

  it("returns 403 for a foreign issuer or audience", async () => {
    expect((await authenticator()(request(await token({ aud: ["other"] }))))?.status).toBe(403);
    expect(
      (await authenticator()(request(await token({ iss: "https://evil.cloudflareaccess.com" }))))
        ?.status
    ).toBe(403);
  });

  it("answers page requests with plain text", async () => {
    const response = await authenticator()(request(undefined, "/"));
    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("caches keys and rate-limits refetches for unknown key ids", async () => {
    const count = { value: 0 };
    const auth = authenticator(count);
    await auth(request(await token({})));
    await auth(request(await token({})));
    expect(count.value).toBe(1);
    expect((await auth(request(await token({}, "unknown"))))?.status).toBe(401);
    expect((await auth(request(await token({}, "unknown"))))?.status).toBe(401);
    expect(count.value).toBe(1);
  });
});
