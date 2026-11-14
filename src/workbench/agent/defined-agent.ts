import { createChatAgentSession } from "../../agent/chat-session.js";
import { pipelineForCommand } from "../../utilities/pipeline-command-marker.js";
import { resolveWorkbenchRegistration } from "../workbench-project-loader.js";
import {
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

/** Reuse ordinary ID/file/export resolution without deriving or invoking a command adapter. */
export async function loadDefinedAgent(
  target: string,
  exportName: string | undefined,
  project: string | undefined,
  io: WorkbenchCliIo,
  usage: string
) {
  const registration = await resolveWorkbenchRegistration(target, exportName, project, io, usage);
  if ("exitCode" in registration) return registration;
  const loaded = await registration.loadPlan(io);
  if ("exitCode" in loaded) return loaded;
  try {
    const pipeline = pipelineForCommand(loaded.view) ?? loaded.view;
    return {
      chat: { id: loaded.view.id, session: createChatAgentSession(pipeline) },
      cwd: registration.cwd,
      tracing: registration.tracing,
    };
  } catch (error) {
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return { exitCode: TUBELESS_WORKBENCH_EXIT_CODE.load };
  }
}
