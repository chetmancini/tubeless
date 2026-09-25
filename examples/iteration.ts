import { createSteps, definePipeline, type IterationDecision } from "tubeless";

interface PageOptions {
  rows: readonly string[];
  offset: number;
}

const { step } = createSteps<PageOptions>();
const page = step("page", {
  description: "Read and normalize one page of two rows.",
  run: (_inputs, { options }) => {
    const nextOffset = options.offset + 2;
    return {
      rows: options.rows.slice(options.offset, nextOffset).map((row) => row.trim()),
      nextOffset,
      done: nextOffset >= options.rows.length,
    };
  },
});
const PagePipeline = definePipeline({ id: "read-page", steps: [page], finalize: page });

interface PageState {
  offset: number;
  rows: readonly string[];
}

const { iteratePipeline } = createSteps<{ rows: readonly string[] }>();
const pages = iteratePipeline("pages", {
  pipeline: PagePipeline,
  description: "Read pages until exhausted, with a limit of 100 child runs.",
  maxIterations: 100,
  initialState: (): PageState => ({ offset: 0, rows: [] }),
  mapOptions: (state, _inputs, context) => ({ rows: context.options.rows, offset: state.offset }),
  transition: (page, state): IterationDecision<PageState, readonly string[]> => {
    const rows = [...state.rows, ...page.rows];
    return page.done
      ? { kind: "finish", result: rows }
      : { kind: "next", state: { offset: page.nextOffset, rows } };
  },
});

export const PaginatedPipeline = definePipeline({
  id: "paginated-rows",
  steps: [pages],
  finalize: pages,
});

export function runIterationExample() {
  return PaginatedPipeline.runOrThrow({
    rows: [" Alpha ", "Beta", " Gamma ", "Delta", "Epsilon "],
  });
}
