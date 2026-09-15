import { chromium } from "@playwright/test";
import type { BrowserVerificationChecks } from "@design-sharingan/project-adapters";
import { normalizeGovernanceRoute } from "@design-sharingan/core";
import { assertLoopbackBaseUrl } from "./readiness";

/** Conservative, read-only browser smoke checks. Never exercises form submissions or mutating controls. */
export async function inspectBrowserChecks(input: { baseUrl: string; route: string; state: string }): Promise<BrowserVerificationChecks> {
  const base = assertLoopbackBaseUrl(input.baseUrl);
  const route = normalizeGovernanceRoute(input.route);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route("**/*", (request) => new URL(request.request().url()).origin === base.origin ? request.continue() : request.abort());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", () => { if (errors.length < 8) errors.push("Browser runtime error"); });
    const response = await page.goto(new URL(route, base).href, { waitUntil: "networkidle", timeout: 20_000 });
    const snapshot = await page.evaluate(() => {
      const visible = (element: Element) => element.getClientRects().length > 0;
      const nativeControls = "button,input:not([type=hidden]),select,textarea";
      const interactiveRoles = new Set(["button", "checkbox", "combobox", "grid", "gridcell", "link", "listbox", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "radiogroup", "scrollbar", "searchbox", "slider", "spinbutton", "switch", "tab", "tablist", "textbox", "tree", "treegrid", "treeitem"]);
      // Inventory only: role tokens and custom focus/edit targets are not proof their behavior works.
      const controls = [...document.querySelectorAll(`${nativeControls},[role],[tabindex],[contenteditable]`)].filter(visible).filter((element) =>
        element.matches(nativeControls) || element.getAttribute("role")?.split(/\s+/).some((role) => interactiveRoles.has(role)) ||
        element.hasAttribute("tabindex") || element instanceof HTMLElement && element.isContentEditable
      );
      const named = (element: Element) => Boolean(element.getAttribute("aria-label")?.trim() || element.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim()) || element.textContent?.trim() || (element instanceof HTMLInputElement && ([...(element.labels ?? [])].some((label) => label.textContent?.trim()) || ["submit", "button"].includes(element.type) && element.value.trim())));
      const distinctLinks = [...new Set([...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(visible).map((element) => element.href).filter((href) => href.startsWith(location.origin) && !href.includes("#")))];
      return { title: document.title.trim(), lang: document.documentElement.lang.trim(), main: [...document.querySelectorAll("main,[role=main]")].filter(visible).some((element) => element.textContent!.trim().length > 0), heading: [...document.querySelectorAll("h1")].filter(visible).length === 1, controls: controls.length, unnamed: controls.filter((element) => !named(element)).length, missingAlt: [...document.images].filter((element) => visible(element) && !element.hasAttribute("alt")).length, unnamedLinks: [...document.querySelectorAll("a[href]")].filter(visible).filter((element) => !named(element)).length, state: document.querySelector("[data-design-state]")?.getAttribute("data-design-state"), links: distinctLinks.slice(0, 8), distinctLinkCount: distinctLinks.length };
    });
    if (input.state !== "default" && snapshot.state !== input.state) throw new Error("Requested state is not explicitly rendered by the application");
    let navigation = response?.ok() === true && new URL(page.url()).pathname === route;
    const linkTargets = snapshot.links;
    for (const target of linkTargets) { const result = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 10_000 }); navigation = navigation && result?.ok() === true && new URL(page.url()).origin === base.origin; }
    const accessible = snapshot.lang.length > 0 && snapshot.title.length > 0 && snapshot.main && snapshot.heading && snapshot.unnamed === 0 && snapshot.missingAlt === 0 && snapshot.unnamedLinks === 0;
    return { navigation: snapshot.distinctLinkCount > linkTargets.length ? "NOT_VERIFIED" : navigation ? "PASS" : "FAIL", accessibility: accessible ? "PASS" : "FAIL", functionalVerification: errors.length > 0 || !snapshot.main || !response?.ok() ? "FAIL" : snapshot.controls > 0 ? "NOT_VERIFIED" : "PASS", evidence: [`Observed ${route}#${input.state}: HTTP ${response?.status() ?? "unavailable"}; exact route and ${linkTargets.length} of ${snapshot.distinctLinkCount} distinct local navigation targets checked.`, `Structural accessibility smoke: language, title, one H1, main landmark, control/link names and image alternatives ${accessible ? "passed" : "failed"}. Visual accessibility is assessed separately.`, `Read-only content smoke: main content ${snapshot.main ? "present" : "missing"}; ${errors.length} runtime errors; ${snapshot.controls} interactive controls. Interactive workflows are not exercised or claimed.`, ...errors] };
  } finally { await browser.close(); }
}
