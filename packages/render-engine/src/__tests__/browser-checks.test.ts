import { createServer } from "node:http";
import { expect, it } from "vitest";
import * as render from "../index";
// Production break: Release has no observed navigation, accessibility, or functional checks and can only report NOT_VERIFIED.
it("collects real bounded browser smoke evidence and does not pass unexercised interactive behavior", async () => {
  expect(render).toHaveProperty("inspectBrowserChecks");
  const server = createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end(`<!doctype html><html lang="en"><title>Check fixture</title><main><h1>Evidence</h1><p>Actual served content.</p>${request.url === "/interactive" ? "<button>Save data</button>" : ""}</main></html>`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    expect(await render.inspectBrowserChecks({ baseUrl, route: "/", state: "default" })).toMatchObject({ navigation: "PASS", accessibility: "PASS", functionalVerification: "PASS" });
    expect(await render.inspectBrowserChecks({ baseUrl, route: "/interactive", state: "default" })).toMatchObject({ functionalVerification: "NOT_VERIFIED" });
    await expect(render.inspectBrowserChecks({ baseUrl, route: "/", state: "loading" })).rejects.toThrow(/state/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
