# AWS Resource Checker
#
# Usage:
#   make install                          install dependencies + Chrome for PDF output
#   make run                              run from TS source (default creds / AWS_PROFILE)
#   make run PROFILE=your-sso-profile     run with a named AWS profile
#   make run PROFILE=your-sso-profile REGION=us-east-1
#   make sso PROFILE=your-sso-profile     aws sso login, then run
#   make build                            compile to dist/
#   make start PROFILE=your-sso-profile   run compiled build
#   make typecheck                        tsc --noEmit
#   make clean                            remove dist/
#
# Recipes avoid shell-specific syntax so they work whether make uses sh or cmd.

PROFILE ?=
REGION  ?= ap-southeast-2

ARGS := --region $(REGION)
ifneq ($(strip $(PROFILE)),)
ARGS += --profile $(PROFILE)
endif

ENTRY := src/application/app.ts
DIST  := dist/application/app.js

.DEFAULT_GOAL := help
.PHONY: help install run sso sso-login build start typecheck clean

help:
	@echo Targets: install run sso sso-login build start typecheck clean
	@echo Variables: PROFILE=name  REGION=name, default ap-southeast-2
	@echo Example: make sso PROFILE=your-sso-profile REGION=us-east-1

install:
	npm ci
	npx puppeteer browsers install chrome

run:
	npx ts-node $(ENTRY) $(ARGS)

sso-login:
	$(if $(strip $(PROFILE)),,$(error PROFILE is required, e.g. make sso PROFILE=your-sso-profile))
	aws sso login --profile $(PROFILE)

sso: sso-login run

build:
	npx tsc

start: build
	node $(DIST) $(ARGS)

typecheck:
	npx tsc --noEmit

clean:
	node -e "require('fs').rmSync('dist', { recursive: true, force: true })"
