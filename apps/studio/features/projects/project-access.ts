import type { Project } from "@design-sharingan/core";
import { cookies } from "next/headers";
import {
  PROJECT_LOCATOR_COOKIE,
  resolveProjectLocator,
} from "./project-locator";

export function validProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(projectId);
}

export async function resolveProjectRequest(
  projectId: string,
): Promise<Project> {
  if (!validProjectId(projectId)) {
    throw new Error("Project request is invalid");
  }
  const locator = (await cookies()).get(PROJECT_LOCATOR_COOKIE)?.value;
  if (locator === undefined) {
    throw new Error("Project locator is unavailable");
  }
  return resolveProjectLocator(locator, projectId);
}
