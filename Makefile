.PHONY: install test test-fast lint build dist-macos dist-linux clean

install:  ## install dependencies across all packages
	bun install

test:  ## full gate — tsc + guardrail grep + bun test (incl. e2e)
	cd packages/contracts && bun test
	cd packages/llm-clients && bunx tsc --noEmit && bun test
	cd packages/harness && bunx tsc --noEmit && bun scripts/guard.ts && bun test
	cd packages/blueprint && bunx tsc --noEmit && bun ../harness/scripts/guard.ts --dir src && bun test
	cd packages/controller && bunx tsc --noEmit && bun ../harness/scripts/guard.ts --dir src && bun test

test-fast:  ## deliberate skip of e2e (visible choice, not silent)
	cd packages/contracts && bun test
	cd packages/llm-clients && bunx tsc --noEmit && bun test
	cd packages/harness && bunx tsc --noEmit && bun scripts/guard.ts && bun test --exclude tests/e2e
	cd packages/blueprint && bunx tsc --noEmit && bun ../harness/scripts/guard.ts --dir src && bun test
	cd packages/controller && bunx tsc --noEmit && bun ../harness/scripts/guard.ts --dir src && bun test --exclude tests/e2e

lint:  ## run typecheck across all packages
	cd packages/contracts && bunx tsc --noEmit
	cd packages/llm-clients && bunx tsc --noEmit
	cd packages/harness && bunx tsc --noEmit
	cd packages/blueprint && bunx tsc --noEmit
	cd packages/controller && bunx tsc --noEmit
	cd packages/crunch && bunx tsc --noEmit
	cd packages/analyzer && bunx tsc --noEmit

build:  ## compile TypeScript for production (outputs to dist/)
	bun build packages/harness/src/index.ts --outdir dist/harness --target bun
	bun build packages/controller/src/index.ts --outdir dist/controller --target bun
	bun build packages/blueprint/src/index.ts --outdir dist/blueprint --target bun

dist-macos: build  ## create macOS distribution artifact (tar.gz)
	mkdir -p dist/zao-macos
	cp -r dist/harness dist/zao-macos/
	cp -r dist/controller dist/zao-macos/
	cp -r dist/blueprint dist/zao-macos/
	cp -r packages/blueprint/defaults dist/zao-macos/
	cp README.md dist/zao-macos/
	cp packages/harness/package.json dist/zao-macos/
	cd dist && tar -czf zao-macos.tar.gz zao-macos
	@echo "macOS artifact: dist/zao-macos.tar.gz"

dist-linux: build  ## create Linux distribution artifact (tar.gz)
	mkdir -p dist/zao-linux
	cp -r dist/harness dist/zao-linux/
	cp -r dist/controller dist/zao-linux/
	cp -r dist/blueprint dist/zao-linux/
	cp -r packages/blueprint/defaults dist/zao-linux/
	cp README.md dist/zao-linux/
	cp packages/harness/package.json dist/zao-linux/
	cd dist && tar -czf zao-linux.tar.gz zao-linux
	@echo "Linux artifact: dist/zao-linux.tar.gz"

clean:  ## remove build artifacts and dist directory
	rm -rf dist/
	@echo "Build artifacts cleaned."
