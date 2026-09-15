import type {
  Project,
  ProjectCapability,
} from "@design-sharingan/core";

export type SupportedFramework = "nextjs" | "vite" | "react";
export type SupportedPackageManager = "pnpm" | "yarn" | "npm";

export interface ProjectDetection {
  rootPath: string;
  name?: string;
  framework?: SupportedFramework;
  packageManager?: SupportedPackageManager;
  devCommand?: string;
  renderTarget?: string;
  scripts: Readonly<Record<string, string>>;
  routes: readonly string[];
  componentDirectories: readonly string[];
  designDocuments: readonly string[];
  hasGit: boolean;
  capabilities: ProjectCapability;
}

export interface ProjectWorkspace extends Project {
  framework?: SupportedFramework;
  packageManager?: SupportedPackageManager;
  renderTarget?: string;
  scripts: Readonly<Record<string, string>>;
  routes: readonly string[];
  componentDirectories: readonly string[];
  designDocuments: readonly string[];
  hasGit: boolean;
  capabilities: ProjectCapability;
}

export interface AdapterRuntime {
  createId(): string;
  now(): Date;
}
