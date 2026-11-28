# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (`+wit/common/conventions/changelog.md`); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1](https://github.com/ManfredWisniewski/einring/compare/einring-v0.2.0...einring-v0.2.1) (2026-11-28)


### Bug Fixes

* add per-user module visibility checks and hide aufmass when no tables are readable; support reusable whitelabel APK builds with repo icons and configurable icon backgrounds, and document customer variants ([c9604e6](https://github.com/ManfredWisniewski/einring/commit/c9604e6eeb3b3490a44ed630d622ef0c93618eb5))

## [Unreleased]

### Added

- Android MDM managed configuration: `einring_api_url` restriction schema (`res/xml/app_restrictions.xml` + `APP_RESTRICTIONS` manifest hook) and an `AppConfig` Capacitor plugin; a value pushed by the MDM overrides the baked `VITE_API_URL` at startup, unset keeps the build default — verified target is Samsung Knox Manage (spec `+wit/specs/common/android-appconfig/`, A50).

## [<version>] - <YYYY-MM-DD>

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security
