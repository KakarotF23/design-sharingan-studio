import { afterEach, expect, it, vi } from "vitest";

const { loadContext } = vi.hoisted(() => ({ loadContext: vi.fn() }));
vi.mock("./mangekyo-server", () => ({ loadMangekyoContext: loadContext }));
vi.mock("../projects/project-access", () => ({ resolveProjectRequest: async () => ({ id: "project-1" }) }));
import { GET } from "../../app/projects/[projectId]/execute/mangekyo/data/route";

const read = () => GET(new Request("http://localhost/projects/project-1/execute/mangekyo/data"), { params: Promise.resolve({ projectId: "project-1" }) });
afterEach(() => vi.resetAllMocks());

// Production break caught: a session/claim or worker-lease transition returns a terminal 404 and strands a newly loaded Stop view instead of allowing its bounded authenticated read retry.
it.each([
  "Mangekyo active-loop claim is missing, stale, or ambiguous",
  "A live durable Mangekyo worker lease is not owned by this server process",
])("allows a bounded context retry for the exact transition diagnostic: %s", async (diagnostic) => {
  loadContext.mockRejectedValueOnce(new Error(diagnostic)).mockResolvedValueOnce({ references: [] });
  const duringTransition = await read();
  expect(duringTransition.status).toBe(409);
  expect(await duringTransition.json()).toEqual({ error: "Mangekyō evidence is being committed; retry shortly." });
  const afterTransition = await read();
  expect(afterTransition.status).toBe(200);
  expect(await afterTransition.json()).toEqual({ references: [] });
});

// Production break caught: broad retry classification could conceal permanently invalid evidence as harmless publication progress.
it("keeps invalid authenticated evidence unavailable rather than returning a session or a retry classification", async () => {
  loadContext.mockRejectedValue(new Error("Mangekyo loop session evidence is invalid"));
  const response = await read();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Mangekyō evidence is unavailable or ambiguous." });
});
