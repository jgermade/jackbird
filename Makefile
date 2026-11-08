# Shortcuts over the npm scripts in package.json, which stay the source of truth.
# Each target installs the dependencies first when they are missing or out of date.

.DEFAULT_GOAL := help
.PHONY: help up test test-crates build desktop desktop-build desktop-test service

help:
	@echo "make up     The app in development mode, on http://localhost:8666"
	@echo "make test   Every check (npm test)"
	@echo "make build  The production build, into dist/"
	@echo "make test-crates  The Rust crates and the desktop app: format, lints and tests"
	@echo "make desktop  The desktop app in development mode (Tauri; on Linux it needs WebKitGTK)"
	@echo "make desktop-build  The desktop app's bundles, into target/release/bundle/"
	@echo "make desktop-test  The desktop app's lints and tests"
	@echo "make service  The service (web build embedded), on http://localhost:4646"
	@echo "Every target needs Rust with the wasm32-unknown-unknown target: the tag engine is built into the app."

up: node_modules/.package-lock.json
	npm run dev

test: node_modules/.package-lock.json
	npm test

# The desktop app (package `jackbird`) needs WebKitGTK on Linux: make desktop-test checks it.
test-crates:
	cargo fmt --all --check
	cargo clippy --workspace --exclude jackbird --all-targets --locked -- -D warnings
	cargo test --workspace --exclude jackbird --locked

service: node_modules/.package-lock.json
	npm run service

desktop-test:
	cargo clippy -p jackbird --all-targets --locked -- -D warnings
	cargo test -p jackbird --locked

build: node_modules/.package-lock.json
	npm run build

desktop: node_modules/.package-lock.json
	npm run desktop

desktop-build: node_modules/.package-lock.json
	npm run desktop:build

# npm writes node_modules/.package-lock.json on every install.
node_modules/.package-lock.json: package-lock.json
	npm ci
