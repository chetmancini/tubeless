The source-map verifier and MIT license come from evanw/esbuild commit
cd832972927f1f67b6d2cc895c06a8759c1cf309 (v0.27.2). The verifier uses the
matching native binary from npm in place of building esbuild with Go.
The four original newline/minification combinations run in batches so
at most one combination's scenarios are active. The Vitest wrapper
records the upstream suite's exit and success marker as one bounded test.
