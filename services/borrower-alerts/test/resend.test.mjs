import { test } from "node:test";
import assert from "node:assert/strict";
import { sendEmail, emailSubject } from "../src/resend.mjs";

test("Resend uses a private sending key, verified-domain sender and stable idempotency key", async () => {
  let request;
  await sendEmail({ key: "test-fixture-key", to: "test@example.com", text: "Turret: Your position is critically close to liquidation.", id: "retry-stable-id", fetcher: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => ({ id: "accepted-test-id" }) }; } });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.headers.authorization, "Bearer test-fixture-key");
  assert.equal(request.headers["idempotency-key"], "retry-stable-id");
  const body = JSON.parse(request.body);
  assert.equal(body.from, "Turret <alerts@turret.capital>");
  assert.deepEqual(body.to, ["test@example.com"]);
  assert.equal(body.subject, "Urgent: your Turret loan is close to liquidation");
});
test("email subjects distinguish confirmation, warning, outage, liquidation and recovery", () => {
  assert.equal(emailSubject("Confirm Turret alerts"), "Confirm your Turret email alerts");
  assert.equal(emailSubject("Confirm Dockyard alerts"), "Confirm your Turret email alerts");
  assert.equal(emailSubject("Turret: Your position is approaching liquidation."), "Warning: your Turret loan is approaching liquidation");
  assert.equal(emailSubject("Turret: Risk data unavailable."), "Turret: position risk data unavailable");
  assert.equal(emailSubject("Turret: liquidation confirmed."), "Turret liquidation confirmed");
  assert.equal(emailSubject("Turret: Your position is back below the warning range."), "Turret: position risk update");
});
test("provider rejection or unconfirmed response remains retryable without exposing details", async () => {
  const options = { key: "secret-fixture", to: "test@example.com", text: "Private alert", id: "id" };
  for (const fetcher of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({}) }), async () => { throw new Error("secret-fixture"); }]) {
    await assert.rejects(sendEmail({ ...options, fetcher }), error => error.message === "Email provider did not confirm acceptance");
  }
});

test("NFT confirmations and deadlines have accurate subjects",()=>{
 assert.equal(emailSubject("Confirm Turret NFT P2P alerts for wallet 0x1"),"Confirm your Turret NFT loan alerts");
 assert.equal(emailSubject("Turret NFT P2P: Final repayment deadline within one hour.\nNFT loan #1"),"Turret NFT P2P: Final repayment deadline within one hour.");
});
