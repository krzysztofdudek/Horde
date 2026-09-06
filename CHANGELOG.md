# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- On a repository whose architecture graph Yggdrasil holds, the merge checklist now runs `yg check` on the branch itself, whatever else the gate runs. A graph that refuses the change refuses the merge. Starting a horde on such a repository says so.

## [0.1.0] - 2026-09-04

### Added
- First version. A prototype, expect rough edges.

[0.1.0]: https://github.com/krzysztofdudek/Horde/releases/tag/v0.1.0
