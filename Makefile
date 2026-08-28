.DEFAULT_GOAL := help

.PHONY: help verify inspect plan graph run ui require-file install build lint format \
	format-check typecheck test docs-check api-check api-generate eval-verify pack \
	pack-verify tubeless check release release-notes

export_arg = $(if $(strip $(EXPORT)),--export "$(EXPORT)",)
store_arg = $(if $(strip $(STORE)),--store "$(STORE)",)
port_arg = $(if $(strip $(PORT)),--port "$(PORT)",)
ui_command_arg = $(if $(strip $(COMMAND)),--command "$(COMMAND)",)
studio_arg = $(if $(strip $(STUDIO)),"$(STUDIO)",)
# `make tubeless ui` expresses `ui` as a second make goal. Forward that goal to
# the raw workbench target, then make the later named target a no-op.
tubeless_command = $(if $(filter tubeless,$(firstword $(MAKECMDGOALS))),$(word 2,$(MAKECMDGOALS)),)

help:
	@echo "tubeless"
	@echo
	@echo "Pipeline tools"
	@echo "  make verify FILE=path/to/pipeline.ts [EXPORT=Name]"
	@echo "      Load and verify a pipeline module; alias: make inspect"
	@echo "  make plan FILE=path/to/pipeline.ts ARGS=\"--target publish --explain\""
	@echo "      Preview selected work without executing steps"
	@echo "  make graph FILE=path/to/pipeline.ts ARGS=\"--markdown\""
	@echo "      Generate the pipeline's Mermaid graph"
	@echo "  make run FILE=path/to/command.ts ARGS=\"--source input.json\""
	@echo "      Run an exported definePipelineCommand"
	@echo "  make ui [STUDIO=path/to/tubeless.studio.ts] [COMMAND=path/to/command.ts]"
	@echo "      Open the local run studio; a manifest or COMMAND enables browser launches"
	@echo
	@echo "Developing tubeless"
	@echo "  make install       Install exact dependencies from bun.lock"
	@echo "  make check         Run the complete package quality gate"
	@echo "  make format        Format package sources and documentation"
	@echo "  make api-generate  Regenerate checked public API documentation"
	@echo "  make pack          Inspect and verify the publishable artifact"
	@echo "  make release-notes Print generated notes for package.json version"
	@echo "  make release       Tag and push; edit generated notes first (EDIT=0 to skip)"

require-file:
	@if [ -z "$(FILE)" ]; then \
		echo "FILE is required (for example: make verify FILE=./examples/typed-import.ts)" >&2; \
		exit 2; \
	fi

verify: inspect

inspect: require-file
	bun run tubeless -- inspect $(export_arg) $(ARGS) "$(FILE)"

plan: require-file
	bun run tubeless -- plan $(export_arg) $(ARGS) "$(FILE)"

graph: require-file
	bun run tubeless -- graph $(export_arg) $(ARGS) "$(FILE)"

run: require-file
	bun run tubeless -- run $(export_arg) $(store_arg) "$(FILE)" -- $(ARGS)

ui:
	$(if $(filter ui,$(tubeless_command)),@:,bun run tubeless -- ui $(ui_command_arg) $(export_arg) $(store_arg) $(port_arg) $(ARGS) $(studio_arg))

install:
	bun ci

build:
	bun run --silent build

lint:
	bun run lint

format:
	bun run format

format-check:
	bun run format:check

typecheck:
	bun run typecheck

test:
	bun run test

docs-check:
	bun run docs:check

api-check:
	bun run --silent build
	bun run api:check

api-generate:
	bun run api:generate

eval-verify:
	bun run --silent build
	bun run eval:verify

pack:
	bun run --silent build
	bun run api:check
	bun run pack:dry-run
	bun run pack:verify

pack-verify:
	bun run --silent build
	bun run pack:verify

# Raw workbench escape hatch; prefer the named pipeline targets above.
tubeless:
	bun run tubeless -- $(tubeless_command) $(if $(filter ui,$(tubeless_command)),$(ui_command_arg) $(export_arg) $(store_arg) $(port_arg),) $(ARGS) $(if $(filter ui,$(tubeless_command)),$(studio_arg),)

check:
	bun run check

release-notes:
	@bash scripts/generate-release-notes.sh

release:
	@NOTES="$(NOTES)" NOTES_FILE="$(NOTES_FILE)" DRY="$(DRY)" PUSH="$(PUSH)" \
		WATCH="$(WATCH)" SKIP_CHECK="$(SKIP_CHECK)" EDIT="$(EDIT)" \
		bash scripts/cut-release.sh
