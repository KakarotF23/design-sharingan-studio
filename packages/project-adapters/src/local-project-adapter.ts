import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Project } from "@design-sharingan/core";
import { detectProject } from "./detect-project";
import { saveProjectMetadata } from "./workspace-store";
import type { AdapterRuntime, ProjectWorkspace } from "./types";

const defaultRuntime: AdapterRuntime = {
  createId: randomUUID,
  now: () => new Date(),
};

export class LocalProjectAdapter {
  constructor(private readonly runtime: AdapterRuntime = defaultRuntime) {}

  async open(rootPath: string): Promise<ProjectWorkspace> {
    const detection = await detectProject(rootPath);
    const timestamp = this.runtime.now().toISOString();
    const project: Project = {
      id: this.runtime.createId(),
      name: detection.name ?? basename(detection.rootPath),
      sourceType: "LOCAL",
      rootPath: detection.rootPath,
      framework: detection.framework,
      packageManager: detection.packageManager,
      devCommand: detection.devCommand,
      status:
        detection.devCommand !== undefined && detection.renderTarget !== undefined
          ? "READY"
          : "NEEDS_CONFIGURATION",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await saveProjectMetadata(project);

    return {
      ...detection,
      ...project,
      framework: detection.framework,
      packageManager: detection.packageManager,
    };
  }
}
