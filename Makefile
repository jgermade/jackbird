# Shortcuts over the npm scripts in package.json, which stay the source of truth.
# Each target installs the dependencies first when they are missing or out of date.

.DEFAULT_GOAL := help
.PHONY: help up test test-crates build

help:
	@echo "make up     The app in development mode, on http://localhost:8666"
	@echo "make test   Every check (npm test)"
	@echo "make build  The production build, into dist/"
	@echo "make test-crates  The Rust tag crates: format, lints and tests"
	@echo "Every target needs Rust with the wasm32-unknown-unknown target: the tag engine is built into the app."

up: node_modules/.package-lock.json
	npm run dev

test: node_modules/.package-lock.json
	npm test

test-crates:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo test --workspace --locked

build: node_modules/.package-lock.json
	npm run build

# npm writes node_modules/.package-lock.json on every install.
node_modules/.package-lock.json: package-lock.json
	npm ci
