import { ExecuteWorkspace } from "../../../../features/execute/execute-workspace";
import { FindingExecutionEntry } from "../../../../features/execute/finding-execution-entry";

export default async function ExecutePage({ searchParams }: { searchParams: Promise<{ finding?: string }> }) {
  const { finding } = await searchParams;
  if (finding !== undefined) return <FindingExecutionEntry findingKey={finding} />;
  return <ExecuteWorkspace />;
}
