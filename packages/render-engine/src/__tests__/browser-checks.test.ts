import { createServer } from "node:http";
import { expect, it } from "vitest";
import * as render from "../index";

async function withBrowserFixture(body: string, inspect: (baseUrl: string, requests: string[]) => Promise<void>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.statusCode = request.url === "/broken" ? 404 : 200;
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html lang="en"><title>Check fixture</title><main><h1>Evidence</h1><p>Actual served content.</p>${body}</main></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await inspect(`http://127.0.0.1:${address.port}`, requests);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

// Production break caught: slicing raw anchors before deduplication lets nine /ok duplicates conceal the later distinct /broken target and incorrectly certify navigation PASS.
it("checks a distinct broken target after nine duplicate successful links", async () => {
  await withBrowserFixture(`${'<a href="/ok">OK</a>'.repeat(9)}<a href="/broken">Broken destination</a>`, async (baseUrl, requests) => {
    const checks = await render.inspectBrowserChecks({ baseUrl, route: "/", state: "default" });
    expect(checks.navigation).toBe("FAIL");
    expect(requests).toContain("/broken");
    expect(requests.filter((path) => path === "/ok")).toHaveLength(1);
  });
});

// Production break caught: incomplete distinct-target coverage is mislabeled as a verified navigation outcome instead of remaining NOT_VERIFIED at the eight-target bound.
it("keeps navigation NOT_VERIFIED when distinct targets exceed its bounded coverage", async () => {
  const links = Array.from({ length: 9 }, (_, index) => `<a href="/target-${index}">Destination ${index}</a>`).join("");
  await withBrowserFixture(links, async (baseUrl, requests) => {
    const checks = await render.inspectBrowserChecks({ baseUrl, route: "/", state: "default" });
    expect(checks.navigation).toBe("NOT_VERIFIED");
    expect(requests.filter((path) => path.startsWith("/target-"))).toHaveLength(8);
    expect(requests).not.toContain("/target-8");
  });
});

// Production break caught: a visible, focusable ARIA switch is omitted from the native-control inventory and receives a false functional PASS; inspecting it must never activate or focus it.
it("keeps an unexercised ARIA switch NOT_VERIFIED without activating or focusing it", async () => {
  await withBrowserFixture(`<div role="switch" tabindex="0" aria-checked="false" onclick="fetch('/activated')" onkeydown="fetch('/activated')" onfocus="fetch('/activated')">Enable feature</div>`, async (baseUrl, requests) => {
    const checks = await render.inspectBrowserChecks({ baseUrl, route: "/", state: "default" });
    expect(checks).toMatchObject({ navigation: "PASS", accessibility: "PASS", functionalVerification: "NOT_VERIFIED" });
    expect(requests).not.toContain("/activated");
  });
});

// Production break caught: non-button ARIA widgets and custom focusable/editable controls evade the inventory, so their unexercised behavior is incorrectly certified as functional PASS.
it.each([
  ["ARIA checkbox without an explicit tab stop", '<div role="checkbox" aria-checked="false">Enable option</div>'],
  ["ARIA composite listbox", '<div role="listbox" aria-label="Choose an option"><div role="option" aria-selected="false">First option</div></div>'],
  ["ARIA role-token fallback", '<div role="unsupported-widget slider" aria-label="Volume" aria-valuenow="50" aria-valuemin="0" aria-valuemax="100"></div>'],
  ["unknown focusable widget", '<div role="custom-widget" tabindex="0">Custom action</div>'],
  ["programmatically focusable widget", '<div tabindex="-1">Custom action</div>'],
  ["editable widget", '<div contenteditable="true" aria-label="Draft">Editable content</div>'],
])("keeps unexercised %s NOT_VERIFIED", async (_description, body) => {
  await withBrowserFixture(body, async (baseUrl) => {
    const checks = await render.inspectBrowserChecks({ baseUrl, route: "/", state: "default" });
    expect(checks.functionalVerification).toBe("NOT_VERIFIED");
  });
});

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
