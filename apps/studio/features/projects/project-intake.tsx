"use client";

import { FormEvent, useState } from "react";
import { ProjectDetectionCard } from "./project-detection-card";
import type { IntakeSource, StudioProjectState } from "./project-state";

interface IntakeResponse {
  project?: StudioProjectState;
  error?: string;
}

async function submitIntake(
  endpoint: string,
  body: Record<string, string>,
): Promise<StudioProjectState> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as IntakeResponse;
  if (!response.ok || result.project === undefined) {
    throw new Error(
      result.error ?? "Project intake failed. Review the values and try again.",
    );
  }
  return result.project;
}

export function ProjectIntake({
  initialSource,
}: {
  initialSource: IntakeSource;
}) {
  const [source, setSource] = useState<IntakeSource>(initialSource);
  const [project, setProject] = useState<StudioProjectState>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const chooseSource = (nextSource: IntakeSource) => {
    setSource(nextSource);
    setProject(undefined);
    setError(undefined);
    window.history.replaceState(null, "", `/projects?source=${nextSource}`);
  };

  const handleLocal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setProject(undefined);
    const form = new FormData(event.currentTarget);

    try {
      setProject(
        await submitIntake("/api/projects/local", {
          rootPath: String(form.get("rootPath") ?? ""),
        }),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Project intake failed. Review the folder path and try again.",
      );
    } finally {
      setPending(false);
    }
  };

  const handleGitHub = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setProject(undefined);
    const intakeForm = event.currentTarget;
    const form = new FormData(intakeForm);

    try {
      setProject(
        await submitIntake("/api/projects/github", {
          repositoryUrl: String(form.get("repositoryUrl") ?? ""),
          branch: String(form.get("branch") ?? ""),
          token: String(form.get("token") ?? ""),
        }),
      );
      intakeForm.reset();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "GitHub import failed. Review the repository details and try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <div className="source-switcher" role="tablist" aria-label="Project source">
        <button
          type="button"
          role="tab"
          aria-selected={source === "local"}
          onClick={() => chooseSource("local")}
        >
          Local folder
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === "github"}
          onClick={() => chooseSource("github")}
        >
          GitHub repository
        </button>
      </div>

      {source === "local" ? (
        <form className="intake-form" onSubmit={handleLocal}>
          <p className="utility-label">LOCAL / SELECT → SCAN → REVIEW</p>
          <h2>Connect a local project</h2>
          <p className="intake-form__intro">
            Paste the absolute path to a web project on this machine. Studio
            reads its configuration and creates machine state inside that folder.
          </p>
          <div className="form-field">
            <label htmlFor="local-root">Project folder path</label>
            <input
              id="local-root"
              name="rootPath"
              type="text"
              inputMode="text"
              placeholder="/Users/you/Projects/product"
              required
            />
            <small>The browser sends this path only to the local Studio server.</small>
          </div>
          <button className="primary-action" type="submit" disabled={pending}>
            <span>{pending ? "Scanning project" : "Scan project"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>
      ) : (
        <form className="intake-form" onSubmit={handleGitHub}>
          <p className="utility-label">GITHUB / CLONE → SCAN → REVIEW</p>
          <h2>Import a GitHub repository</h2>
          <p className="intake-form__intro">
            Clone an HTTPS repository into an isolated local workspace, then
            review the detected runtime before opening Studio.
          </p>
          <div className="form-field">
            <label htmlFor="github-url">Repository URL</label>
            <input
              id="github-url"
              name="repositoryUrl"
              type="url"
              placeholder="https://github.com/owner/repository.git"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="github-branch">Branch</label>
            <input id="github-branch" name="branch" defaultValue="main" required />
          </div>
          <div className="form-field">
            <label htmlFor="github-token">Personal access token (optional)</label>
            <input
              id="github-token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
            <small>Used only for this clone and never returned to the browser.</small>
          </div>
          <button className="primary-action" type="submit" disabled={pending}>
            <span>{pending ? "Importing repository" : "Import repository"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>
      )}

      {error === undefined ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {project === undefined ? null : <ProjectDetectionCard project={project} />}
    </div>
  );
}
