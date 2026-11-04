# Shortcuts over the npm scripts in package.json, which stay the source of truth.
# Each target installs the dependencies first when they are missing or out of date.

.DEFAULT_GOAL := help
.PHONY: help up test build

help:
	@echo "make up     The app in development mode, on http://localhost:8666"
	@echo "make test   Every check (npm test)"
	@echo "make build  The production build, into dist/"

up: node_modules/.package-lock.json
	npm run dev

test: node_modules/.package-lock.json
	npm test

build: node_modules/.package-lock.json
	npm run build

# npm writes node_modules/.package-lock.json on every install.
node_modules/.package-lock.json: package-lock.json
	npm ci
