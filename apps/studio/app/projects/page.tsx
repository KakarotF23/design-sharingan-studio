import { ProjectIntake } from "../../features/projects/project-intake";
import type { IntakeSource } from "../../features/projects/project-state";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const source = (await searchParams).source;
  const initialSource: IntakeSource = source === "github" ? "github" : "local";

  return (
    <main className="project-intake">
      <header className="project-intake__header">
        <a className="project-intake__back" href="/">
          ← RETURN TO LANDING
        </a>
        <p className="utility-label">TRUSTED INTAKE BOUNDARY</p>
        <h1>One project.<br />One Studio.</h1>
        <p>
          Local and GitHub sources converge on the same detection review. No
          code change begins here.
        </p>
      </header>
      <section className="project-intake__workspace">
        <ProjectIntake initialSource={initialSource} />
      </section>
    </main>
  );
}
